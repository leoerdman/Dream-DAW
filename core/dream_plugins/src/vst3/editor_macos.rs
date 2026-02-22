use std::ffi::c_void;
use std::ptr;
use std::sync::Once;

use cocoa::appkit::NSWindow;
use cocoa::base::id;
use cocoa::foundation::{NSPoint, NSRect, NSSize};
use log::info;

use crate::vst3::com_abi::{
    IID_FUNKNOWN, IID_IPLUG_FRAME, IPlugView, K_NO_INTERFACE, K_RESULT_FALSE, K_RESULT_OK, Tresult,
    Tuid, ViewRect, tuid_eq,
};

#[inline]
fn tuid_matches(iid: *const Tuid, expected: &Tuid) -> bool {
    // SAFETY: `iid` comes from VST3 ABI callbacks and may be null.
    // `tuid_eq` handles null safely and returns false.
    unsafe { tuid_eq(iid, expected) }
}

thread_local! {
    static EDITOR_IN_ATTACHED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub(crate) fn set_editor_in_attached(value: bool) {
    EDITOR_IN_ATTACHED.with(|cell| cell.set(value));
}

#[repr(C)]
struct IPlugFrameVtbl {
    query_interface: unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    resize_view: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut ViewRect) -> Tresult,
}

#[repr(C)]
pub(crate) struct HostPlugFrame {
    vtbl: *const IPlugFrameVtbl,
    ref_count: u32,
    /// NSWindow pointer (stored as usize to keep Send safety).
    window_ptr: usize,
}

unsafe impl Send for HostPlugFrame {}

impl HostPlugFrame {
    pub(crate) fn new(window_ptr: usize) -> Box<Self> {
        Box::new(Self {
            vtbl: &HOST_PLUG_FRAME_VTBL,
            ref_count: 1,
            window_ptr,
        })
    }

    pub(crate) fn vtable_ptr(&self) -> *const c_void {
        self.vtbl.cast::<c_void>()
    }
}

unsafe extern "C" fn plug_frame_query_interface(
    this: *mut c_void,
    iid: *const Tuid,
    obj: *mut *mut c_void,
) -> Tresult {
    if this.is_null() || iid.is_null() || obj.is_null() {
        return K_NO_INTERFACE;
    }
    if tuid_matches(iid, &IID_IPLUG_FRAME) || tuid_matches(iid, &IID_FUNKNOWN) {
        // SAFETY: `obj` is validated non-null above and receives current COM object pointer.
        unsafe {
            *obj = this;
            plug_frame_add_ref(this);
        }
        return K_RESULT_OK;
    }
    // SAFETY: `obj` is validated non-null above and points to caller out-param storage.
    unsafe {
        *obj = ptr::null_mut();
    }
    K_NO_INTERFACE
}

unsafe extern "C" fn plug_frame_add_ref(this: *mut c_void) -> u32 {
    if this.is_null() {
        return 0;
    }
    // SAFETY: `this` is non-null and points to `HostPlugFrame` for this vtable callback.
    let frame = unsafe { &mut *(this as *mut HostPlugFrame) };
    frame.ref_count = frame.ref_count.saturating_add(1);
    frame.ref_count
}

unsafe extern "C" fn plug_frame_release(this: *mut c_void) -> u32 {
    if this.is_null() {
        return 0;
    }
    // SAFETY: `this` is non-null and points to `HostPlugFrame` for this vtable callback.
    let frame = unsafe { &mut *(this as *mut HostPlugFrame) };
    frame.ref_count = frame.ref_count.saturating_sub(1);
    frame.ref_count
}

unsafe extern "C" fn plug_frame_resize_view(
    this: *mut c_void,
    view: *mut c_void,
    new_rect: *mut ViewRect,
) -> Tresult {
    use std::cell::Cell;
    thread_local! {
        static IN_RESIZE: Cell<bool> = const { Cell::new(false) };
    }

    if IN_RESIZE.with(|c| c.get()) {
        return K_RESULT_OK;
    }
    if this.is_null() || new_rect.is_null() {
        return K_RESULT_FALSE;
    }

    // SAFETY: `this` is non-null and points to `HostPlugFrame` for this vtable callback.
    let frame = unsafe { &*(this as *const HostPlugFrame) };
    if frame.window_ptr == 0 {
        return K_RESULT_FALSE;
    }

    // SAFETY: `new_rect` is validated non-null above and points to plugin-provided view rect.
    let rect = unsafe { &*new_rect };
    let width = (rect.right - rect.left).max(100) as f64;
    let height = (rect.bottom - rect.top).max(100) as f64;
    let window = frame.window_ptr as id;

    // SAFETY: `window` is an NSWindow id provided by our host; AppKit methods are called on main thread.
    unsafe {
        let current_frame = NSWindow::frame(window);
        window.setContentSize_(NSSize::new(width, height));
        let frame_after = NSWindow::frame(window);
        let y_adjustment = current_frame.size.height - frame_after.size.height;
        if y_adjustment.abs() > 0.001 {
            let adjusted_frame = NSRect::new(
                NSPoint::new(frame_after.origin.x, frame_after.origin.y + y_adjustment),
                frame_after.size,
            );
            window.setFrame_display_(adjusted_frame, true);
        }
    }

    let in_attached = EDITOR_IN_ATTACHED.with(|c| c.get());
    if !view.is_null() && !in_attached {
        IN_RESIZE.with(|c| c.set(true));
        let plug_view = view as *mut IPlugView;
        // SAFETY: `plug_view` comes from plugin callback and is valid during resize handshake.
        unsafe {
            let _ = ((*(*plug_view).vtbl).on_size)(plug_view, new_rect);
        }
        IN_RESIZE.with(|c| c.set(false));
    }

    K_RESULT_OK
}

static HOST_PLUG_FRAME_VTBL: IPlugFrameVtbl = IPlugFrameVtbl {
    query_interface: plug_frame_query_interface,
    add_ref: plug_frame_add_ref,
    release: plug_frame_release,
    resize_view: plug_frame_resize_view,
};

static DELEGATE_CLASS_INIT: Once = Once::new();

unsafe extern "C" {
    fn objc_allocateClassPair(
        superclass: *const std::os::raw::c_void,
        name: *const std::os::raw::c_char,
        extra_bytes: usize,
    ) -> *mut std::os::raw::c_void;
    fn objc_registerClassPair(cls: *mut std::os::raw::c_void);
    fn objc_getClass(name: *const std::os::raw::c_char) -> *const std::os::raw::c_void;
    fn class_addIvar(
        cls: *mut std::os::raw::c_void,
        name: *const std::os::raw::c_char,
        size: usize,
        alignment: u8,
        types: *const std::os::raw::c_char,
    ) -> bool;
    fn class_addMethod(
        cls: *mut std::os::raw::c_void,
        sel: *mut std::os::raw::c_void,
        imp: *const std::os::raw::c_void,
        types: *const std::os::raw::c_char,
    ) -> bool;
    fn object_getInstanceVariable(
        obj: id,
        name: *const std::os::raw::c_char,
        out_value: *mut *mut std::os::raw::c_void,
    ) -> *mut std::os::raw::c_void;
    fn object_setInstanceVariable(
        obj: id,
        name: *const std::os::raw::c_char,
        value: *mut std::os::raw::c_void,
    ) -> *mut std::os::raw::c_void;
}

extern "C" fn plugin_window_will_close(this: id, _cmd: *mut c_void, _notification: id) {
    // SAFETY: called by ObjC runtime with valid delegate object; ivar access and VST3 cleanup are guarded.
    unsafe {
        let mut plug_view_raw: *mut c_void = std::ptr::null_mut();
        object_getInstanceVariable(this, c"_plugView".as_ptr() as _, &mut plug_view_raw);

        let mut cleaned_raw: *mut c_void = std::ptr::null_mut();
        object_getInstanceVariable(this, c"_cleaned".as_ptr() as _, &mut cleaned_raw);
        let already_cleaned = cleaned_raw as usize != 0;

        if already_cleaned || plug_view_raw.is_null() {
            return;
        }

        let plug_view = plug_view_raw as *mut IPlugView;
        if (*plug_view).vtbl.is_null() {
            info!("[VST3-Delegate] windowWillClose: plug_view vtbl is null, skipping cleanup");
            object_setInstanceVariable(
                this,
                c"_cleaned".as_ptr() as _,
                std::ptr::dangling_mut::<c_void>(),
            );
            return;
        }

        info!(
            "[VST3-Delegate] windowWillClose: performing VST3 cleanup for plug_view={:p}",
            plug_view
        );

        let _ = ((*(*plug_view).vtbl).set_frame)(plug_view, std::ptr::null_mut());
        let _ = ((*(*plug_view).vtbl).removed)(plug_view);
        let _ = ((*(*plug_view).vtbl).release)(plug_view);

        object_setInstanceVariable(
            this,
            c"_cleaned".as_ptr() as _,
            std::ptr::dangling_mut::<c_void>(),
        );
    }
}

pub(crate) fn install_plugin_window_delegate(window: id, plug_view: *mut IPlugView) {
    use std::os::raw::c_char;

    let class_name = c"DreamDAWPluginWindowDelegate".as_ptr() as *const c_char;

    DELEGATE_CLASS_INIT.call_once(|| {
        // SAFETY: Objective-C runtime functions are called with static class names and validated handles.
        let ns_object_class = unsafe { objc_getClass(c"NSObject".as_ptr() as _) };
        if ns_object_class.is_null() {
            log::error!("[VST3-Delegate] objc_getClass('NSObject') returned null");
            return;
        }
        // SAFETY: superclass handle above is valid for dynamic subclass creation.
        let new_class = unsafe { objc_allocateClassPair(ns_object_class, class_name, 0) };
        if new_class.is_null() {
            log::error!("[VST3-Delegate] objc_allocateClassPair failed");
            return;
        }

        // SAFETY: ivar declarations use stable C layouts/types and newly-created class handle.
        unsafe {
            class_addIvar(
                new_class,
                c"_plugView".as_ptr() as _,
                std::mem::size_of::<*mut c_void>(),
                std::mem::align_of::<*mut c_void>() as u8,
                c"^v".as_ptr() as _,
            );
            class_addIvar(
                new_class,
                c"_cleaned".as_ptr() as _,
                std::mem::size_of::<usize>(),
                std::mem::align_of::<usize>() as u8,
                c"Q".as_ptr() as _,
            );
        }

        unsafe extern "C" {
            fn sel_registerName(name: *const c_char) -> *mut c_void;
        }
        // SAFETY: selector name is a static C string and runtime returns canonical SEL.
        let sel = unsafe { sel_registerName(c"windowWillClose:".as_ptr() as _) };
        // SAFETY: method signature matches callback ABI and class handle is valid.
        unsafe {
            class_addMethod(
                new_class,
                sel,
                plugin_window_will_close as *const c_void,
                c"v@:@".as_ptr() as _,
            );
            objc_registerClassPair(new_class);
        }
    });

    unsafe extern "C" {
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend() -> id;
    }
    type MsgSendAlloc = unsafe extern "C" fn(*const c_void, *mut c_void) -> id;
    type MsgSendInit = unsafe extern "C" fn(id, *mut c_void) -> id;
    type MsgSendSetDelegate = unsafe extern "C" fn(id, *mut c_void, id);

    // SAFETY: class was registered above during `call_once`; lookup by same static name is valid.
    let delegate_class = unsafe { objc_getClass(class_name) };
    if delegate_class.is_null() {
        log::error!("[VST3-Delegate] delegate class lookup failed");
        return;
    }
    // SAFETY: selector names are static C strings and runtime returns canonical SEL values.
    let sel_alloc = unsafe { sel_registerName(c"alloc".as_ptr() as _) };
    // SAFETY: selector names are static C strings and runtime returns canonical SEL values.
    let sel_init = unsafe { sel_registerName(c"init".as_ptr() as _) };
    // SAFETY: selector names are static C strings and runtime returns canonical SEL values.
    let sel_set_delegate = unsafe { sel_registerName(c"setDelegate:".as_ptr() as _) };

    // SAFETY: `objc_msgSend` is cast to signatures matching corresponding Objective-C selectors.
    let send_alloc: MsgSendAlloc = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    // SAFETY: `objc_msgSend` is cast to signatures matching corresponding Objective-C selectors.
    let send_init: MsgSendInit = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    let send_set_delegate: MsgSendSetDelegate =
        // SAFETY: `objc_msgSend` is cast to signatures matching corresponding Objective-C selectors.
        unsafe { std::mem::transmute(objc_msgSend as *const ()) };

    // SAFETY: calling alloc/init on valid delegate class produced above.
    let delegate = unsafe { send_alloc(delegate_class, sel_alloc) };
    // SAFETY: object from alloc is valid receiver for init.
    let delegate = unsafe { send_init(delegate, sel_init) };

    // SAFETY: ivar names and delegate/window ids are valid in this setup code path.
    unsafe {
        object_setInstanceVariable(
            delegate,
            c"_plugView".as_ptr() as _,
            plug_view as *mut c_void,
        );
        object_setInstanceVariable(
            delegate,
            c"_cleaned".as_ptr() as _,
            std::ptr::null_mut::<c_void>(),
        );
        send_set_delegate(window, sel_set_delegate, delegate);
    }

    info!(
        "[VST3-Delegate] Installed window delegate {:p} with plug_view={:p}",
        delegate, plug_view
    );
}

pub(crate) fn plugin_window_delegate_already_cleaned(window: id) -> bool {
    unsafe extern "C" {
        fn sel_registerName(name: *const std::os::raw::c_char) -> *mut c_void;
        fn objc_msgSend() -> id;
    }
    type MsgSendGetDelegate = unsafe extern "C" fn(id, *mut c_void) -> id;

    // SAFETY: selector name is static and runtime returns canonical SEL value.
    let sel_delegate = unsafe { sel_registerName(c"delegate".as_ptr() as _) };
    let send_delegate: MsgSendGetDelegate =
        // SAFETY: signature matches `-delegate` Objective-C selector.
        unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    // SAFETY: `window` is valid NSWindow id and selector matches getter method.
    let delegate = unsafe { send_delegate(window, sel_delegate) };

    if delegate.is_null() {
        return false;
    }

    let mut cleaned_raw: *mut c_void = std::ptr::null_mut();
    // SAFETY: delegate object exists and `_cleaned` ivar is installed in class setup.
    unsafe {
        object_getInstanceVariable(delegate, c"_cleaned".as_ptr() as _, &mut cleaned_raw);
    }
    cleaned_raw as usize != 0
}

pub(crate) fn mark_delegate_cleaned(window: id) {
    unsafe extern "C" {
        fn sel_registerName(name: *const std::os::raw::c_char) -> *mut c_void;
        fn objc_msgSend() -> id;
    }
    type MsgSendGetDelegate = unsafe extern "C" fn(id, *mut c_void) -> id;

    // SAFETY: selector name is static and runtime returns canonical SEL value.
    let sel_delegate = unsafe { sel_registerName(c"delegate".as_ptr() as _) };
    let send_delegate: MsgSendGetDelegate =
        // SAFETY: signature matches `-delegate` Objective-C selector.
        unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    // SAFETY: `window` is valid NSWindow id and selector matches getter method.
    let delegate = unsafe { send_delegate(window, sel_delegate) };

    if delegate.is_null() {
        return;
    }

    // SAFETY: delegate object exists and ivars were declared during class initialization.
    unsafe {
        object_setInstanceVariable(
            delegate,
            c"_cleaned".as_ptr() as _,
            std::ptr::dangling_mut::<c_void>(),
        );
        object_setInstanceVariable(delegate, c"_plugView".as_ptr() as _, std::ptr::null_mut());
    }
}
