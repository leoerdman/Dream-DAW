use super::*;

#[derive(Clone, Copy)]
pub(super) struct AuEditorWindow {
    pub(super) window: usize,
}

pub(super) fn is_main_thread() -> bool {
    // SAFETY: pure query function from libpthread.
    unsafe { pthread_main_np() != 0 }
}

unsafe fn objc_msg_send_id_1_id(obj: id, selector: *mut c_void, arg: id) -> id {
    type Fn = unsafe extern "C" fn(id, *mut c_void, id) -> id;
    let f: Fn = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { f(obj, selector, arg) }
}

unsafe fn objc_msg_send_id_0(obj: id, selector: *mut c_void) -> id {
    type Fn = unsafe extern "C" fn(id, *mut c_void) -> id;
    let f: Fn = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { f(obj, selector) }
}

unsafe fn objc_msg_send_bool_0(obj: id, selector: *mut c_void) -> bool {
    type Fn = unsafe extern "C" fn(id, *mut c_void) -> bool;
    let f: Fn = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { f(obj, selector) }
}

unsafe fn objc_msg_send_bool_1_sel(obj: id, selector: *mut c_void, arg: *mut c_void) -> bool {
    type Fn = unsafe extern "C" fn(id, *mut c_void, *mut c_void) -> bool;
    let f: Fn = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { f(obj, selector, arg) }
}

unsafe fn objc_msg_send_id_2(obj: id, selector: *mut c_void, arg1: AudioUnit, arg2: NSSize) -> id {
    type Fn = unsafe extern "C" fn(id, *mut c_void, AudioUnit, NSSize) -> id;
    let f: Fn = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { f(obj, selector, arg1, arg2) }
}

unsafe fn objc_msg_send_rect_0(obj: id, selector: *mut c_void) -> NSRect {
    type Fn = unsafe extern "C" fn(id, *mut c_void) -> NSRect;
    let f: Fn = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { f(obj, selector) }
}

unsafe fn objc_msg_send_void_rect(obj: id, selector: *mut c_void, arg: NSRect) {
    type Fn = unsafe extern "C" fn(id, *mut c_void, NSRect);
    let f: Fn = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { f(obj, selector, arg) }
}

unsafe fn objc_msg_send_void_usize(obj: id, selector: *mut c_void, arg: usize) {
    type Fn = unsafe extern "C" fn(id, *mut c_void, usize);
    let f: Fn = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { f(obj, selector, arg) }
}

pub(super) fn has_cocoa_ui_property(unit: AudioUnit) -> bool {
    let mut data_size: u32 = 0;
    let mut writable: u8 = 0;
    let status = unsafe {
        AudioUnitGetPropertyInfo(
            unit,
            K_AUDIO_UNIT_PROPERTY_COCOA_UI,
            K_AUDIO_UNIT_SCOPE_GLOBAL,
            0,
            &mut data_size,
            &mut writable,
        )
    };
    status == NO_ERR && data_size as usize >= size_of::<AudioUnitCocoaViewInfo>()
}

pub(super) fn create_cocoa_view_for_unit(unit: AudioUnit) -> Result<id, PluginError> {
    let mut data_size: u32 = 0;
    let mut writable: u8 = 0;
    let info_status = unsafe {
        AudioUnitGetPropertyInfo(
            unit,
            K_AUDIO_UNIT_PROPERTY_COCOA_UI,
            K_AUDIO_UNIT_SCOPE_GLOBAL,
            0,
            &mut data_size,
            &mut writable,
        )
    };
    if info_status != NO_ERR {
        return Err(PluginError::UnsupportedFormat(format!(
            "AudioUnit Cocoa UI property is unavailable (OSStatus {info_status})"
        )));
    }
    if data_size as usize <= size_of::<*const c_void>() {
        return Err(PluginError::UnsupportedFormat(
            "AudioUnit Cocoa UI metadata is empty".to_string(),
        ));
    }

    let mut bytes = vec![0u8; data_size as usize];
    let mut io_size = data_size;
    let get_status = unsafe {
        AudioUnitGetProperty(
            unit,
            K_AUDIO_UNIT_PROPERTY_COCOA_UI,
            K_AUDIO_UNIT_SCOPE_GLOBAL,
            0,
            bytes.as_mut_ptr().cast(),
            &mut io_size,
        )
    };
    if get_status != NO_ERR {
        return Err(PluginError::UnsupportedFormat(format!(
            "Failed to read AudioUnit Cocoa UI metadata (OSStatus {get_status})"
        )));
    }
    if (io_size as usize) < size_of::<AudioUnitCocoaViewInfo>() {
        return Err(PluginError::UnsupportedFormat(
            "AudioUnit Cocoa UI metadata is incomplete".to_string(),
        ));
    }

    let info = unsafe { &*(bytes.as_ptr() as *const AudioUnitCocoaViewInfo) };
    let class_count = (io_size as usize - size_of::<*const c_void>()) / size_of::<*const c_void>();
    if class_count == 0 {
        return Err(PluginError::UnsupportedFormat(
            "AudioUnit Cocoa UI did not provide view classes".to_string(),
        ));
    }

    let bundle_url = info.m_cocoa_au_view_bundle_location as id;
    if bundle_url == nil {
        return Err(PluginError::UnsupportedFormat(
            "AudioUnit Cocoa UI bundle URL is missing".to_string(),
        ));
    }

    let nsbundle_cls = unsafe { objc_getClass(c"NSBundle".as_ptr()) } as id;
    if nsbundle_cls == nil {
        return Err(PluginError::UnsupportedFormat(
            "Objective-C runtime class NSBundle is unavailable".to_string(),
        ));
    }
    let sel_bundle_with_url = unsafe { sel_registerName(c"bundleWithURL:".as_ptr()) };
    let bundle: id = unsafe { objc_msg_send_id_1_id(nsbundle_cls, sel_bundle_with_url, bundle_url) };
    if bundle == nil {
        return Err(PluginError::UnsupportedFormat(
            "Failed to open AudioUnit Cocoa UI bundle".to_string(),
        ));
    }

    let sel_load = unsafe { sel_registerName(c"load".as_ptr()) };
    let _loaded: bool = unsafe { objc_msg_send_bool_0(bundle, sel_load) };

    let class_ptr = unsafe {
        bytes.as_ptr()
            .add(size_of::<*const c_void>())
            .cast::<*const c_void>()
    };
    for idx in 0..class_count {
        let class_cf = unsafe { *class_ptr.add(idx) };
        if class_cf.is_null() {
            continue;
        }
        let Some(class_name) = cfstring_to_rust(class_cf) else {
            continue;
        };
        let ns_name = unsafe { NSString::alloc(nil).init_str(&class_name) };
        let sel_class_named = unsafe { sel_registerName(c"classNamed:".as_ptr()) };
        let view_class: id = unsafe { objc_msg_send_id_1_id(bundle, sel_class_named, ns_name) };
        if view_class == nil {
            continue;
        }
        let sel_alloc = unsafe { sel_registerName(c"alloc".as_ptr()) };
        let factory_alloc: id = unsafe { objc_msg_send_id_0(view_class, sel_alloc) };
        if factory_alloc == nil {
            continue;
        }
        let sel_init = unsafe { sel_registerName(c"init".as_ptr()) };
        let factory: id = unsafe { objc_msg_send_id_0(factory_alloc, sel_init) };
        if factory == nil {
            continue;
        }
        let sel_responds = unsafe { sel_registerName(c"respondsToSelector:".as_ptr()) };
        let sel_ui_view = unsafe { sel_registerName(c"uiViewForAudioUnit:withSize:".as_ptr()) };
        let supports_selector: bool = unsafe {
            objc_msg_send_bool_1_sel(factory, sel_responds, sel_ui_view)
        };
        if !supports_selector {
            continue;
        }
        let view: id = unsafe { objc_msg_send_id_2(factory, sel_ui_view, unit, NSSize::new(960.0, 640.0)) };
        if view != nil {
            return Ok(view);
        }
    }

    Err(PluginError::UnsupportedFormat(
        "AudioUnit Cocoa UI factory did not return a native view".to_string(),
    ))
}

pub(super) unsafe fn cocoa_view_frame(view: id) -> NSRect {
    let sel_frame = unsafe { sel_registerName(c"frame".as_ptr()) };
    unsafe { objc_msg_send_rect_0(view, sel_frame) }
}

pub(super) unsafe fn content_view_bounds(content_view: id) -> NSRect {
    let sel_bounds = unsafe { sel_registerName(c"bounds".as_ptr()) };
    unsafe { objc_msg_send_rect_0(content_view, sel_bounds) }
}

pub(super) unsafe fn set_view_frame(view: id, frame: NSRect) {
    let sel_set_frame = unsafe { sel_registerName(c"setFrame:".as_ptr()) };
    unsafe { objc_msg_send_void_rect(view, sel_set_frame, frame) };
}

pub(super) unsafe fn set_view_autoresize_mask(view: id, mask: usize) {
    let sel_set_autoresize = unsafe { sel_registerName(c"setAutoresizingMask:".as_ptr()) };
    unsafe { objc_msg_send_void_usize(view, sel_set_autoresize, mask) };
}

pub(super) unsafe fn add_subview(content_view: id, child: id) {
    let sel_add_subview = unsafe { sel_registerName(c"addSubview:".as_ptr()) };
    let _ = unsafe { objc_msg_send_id_1_id(content_view, sel_add_subview, child) };
}
