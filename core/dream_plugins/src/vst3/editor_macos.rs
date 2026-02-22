use std::ffi::c_void;
use std::ptr;

use cocoa::appkit::NSWindow;
use cocoa::base::id;
use cocoa::foundation::{NSPoint, NSRect, NSSize};

use crate::vst3::com_abi::{
    IPlugView, IID_FUNKNOWN, IID_IPLUG_FRAME, K_NO_INTERFACE, K_RESULT_FALSE, K_RESULT_OK,
    Tresult, Tuid, ViewRect, tuid_eq,
};

thread_local! {
    static EDITOR_IN_ATTACHED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub(crate) fn set_editor_in_attached(value: bool) {
    EDITOR_IN_ATTACHED.with(|cell| cell.set(value));
}

#[repr(C)]
struct IPlugFrameVtbl {
    query_interface:
        unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    resize_view:
        unsafe extern "C" fn(*mut c_void, *mut c_void, *mut ViewRect) -> Tresult,
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
    if tuid_eq(iid, &IID_IPLUG_FRAME) || tuid_eq(iid, &IID_FUNKNOWN) {
        unsafe {
            *obj = this;
            plug_frame_add_ref(this);
        }
        return K_RESULT_OK;
    }
    unsafe {
        *obj = ptr::null_mut();
    }
    K_NO_INTERFACE
}

unsafe extern "C" fn plug_frame_add_ref(this: *mut c_void) -> u32 {
    if this.is_null() {
        return 0;
    }
    let frame = unsafe { &mut *(this as *mut HostPlugFrame) };
    frame.ref_count = frame.ref_count.saturating_add(1);
    frame.ref_count
}

unsafe extern "C" fn plug_frame_release(this: *mut c_void) -> u32 {
    if this.is_null() {
        return 0;
    }
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

    let frame = unsafe { &*(this as *const HostPlugFrame) };
    if frame.window_ptr == 0 {
        return K_RESULT_FALSE;
    }

    let rect = unsafe { &*new_rect };
    let width = (rect.right - rect.left).max(100) as f64;
    let height = (rect.bottom - rect.top).max(100) as f64;
    let window = frame.window_ptr as id;

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
