///! Standalone VST3 editor test harness — loads Serum2 and opens its editor
///! without Tauri/WebKit. Run with:
///!   cargo run -p dream_plugins --example test_serum2
use std::ffi::{c_char, c_void};
use std::os::raw::c_int;
use std::ptr;

// ── Minimal ObjC/AppKit bindings ──
const RTLD_NOW: c_int = 0x2;
const RTLD_LOCAL: c_int = 0x4;

#[link(name = "AppKit", kind = "framework")]
#[link(name = "Foundation", kind = "framework")]
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn objc_msgSend();
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, returnAfterSourceHandled: u8) -> i32;
    fn dlopen(filename: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn dlerror() -> *const c_char;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRunLoopRun();
    static kCFRunLoopDefaultMode: *const c_void;
}

type Id = *mut c_void;
type Sel = *mut c_void;
const NIL: Id = std::ptr::null_mut();

macro_rules! sel {
    ($name:expr) => {
        unsafe { sel_registerName(concat!($name, "\0").as_ptr() as *const c_char) }
    };
}

macro_rules! cls {
    ($name:expr) => {
        unsafe { objc_getClass(concat!($name, "\0").as_ptr() as *const c_char) }
    };
}

macro_rules! msg {
    ($obj:expr, $sel:expr $(,)?) => {{
        type F = unsafe extern "C" fn(Id, Sel) -> Id;
        let f: F = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { f($obj, $sel) }
    }};
    ($obj:expr, $sel:expr, bool: $v:expr) => {{
        type F = unsafe extern "C" fn(Id, Sel, i8);
        let f: F = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { f($obj, $sel, if $v { 1 } else { 0 }) }
    }};
    ($obj:expr, $sel:expr, id: $v:expr) => {{
        type F = unsafe extern "C" fn(Id, Sel, Id) -> Id;
        let f: F = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { f($obj, $sel, $v) }
    }};
    ($obj:expr, $sel:expr, rect: $r:expr) => {{
        type F = unsafe extern "C" fn(Id, Sel, NSRect) -> Id;
        let f: F = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { f($obj, $sel, $r) }
    }};
    ($obj:expr, $sel:expr, u64: $v:expr) => {{
        type F = unsafe extern "C" fn(Id, Sel, u64) -> Id;
        let f: F = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { f($obj, $sel, $v) }
    }};
    ($obj:expr, $sel:expr, f64f64: $a:expr, $b:expr) => {{
        type F = unsafe extern "C" fn(Id, Sel, f64, f64) -> Id;
        let f: F = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { f($obj, $sel, $a, $b) }
    }};
}

#[repr(C)]
#[derive(Copy, Clone)]
struct NSRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl NSRect {
    fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }
}

// ── VST3 types ──
type Tresult = i32;
type Tuid = [u8; 16];
const K_RESULT_OK: Tresult = 0;

#[repr(C)]
struct ViewRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

// Minimal vtable layouts
#[repr(C)]
struct FUnknownVtbl {
    query_interface: unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
}

#[repr(C)]
struct IPluginFactoryVtbl {
    // FUnknown
    query_interface: unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    // IPluginFactory
    get_factory_info: unsafe extern "C" fn(*mut c_void, *mut c_void) -> Tresult,
    count_classes: unsafe extern "C" fn(*mut c_void) -> i32,
    get_class_info: unsafe extern "C" fn(*mut c_void, i32, *mut c_void) -> Tresult,
    create_instance: unsafe extern "C" fn(*mut c_void, *const Tuid, *const Tuid, *mut *mut c_void) -> Tresult,
}

#[repr(C)]
struct IComponentVtbl {
    // FUnknown (3)
    query_interface: unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    // IPluginBase (2)
    initialize: unsafe extern "C" fn(*mut c_void, *mut c_void) -> Tresult,
    terminate: unsafe extern "C" fn(*mut c_void) -> Tresult,
    // IComponent (6)
    get_controller_class_id: unsafe extern "C" fn(*mut c_void, *mut Tuid) -> Tresult,
    set_io_mode: unsafe extern "C" fn(*mut c_void, i32) -> Tresult,
    get_bus_count: unsafe extern "C" fn(*mut c_void, i32, i32) -> i32,
    get_bus_info: unsafe extern "C" fn(*mut c_void, i32, i32, i32, *mut c_void) -> Tresult,
    get_routing_info: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> Tresult,
    activate_bus: unsafe extern "C" fn(*mut c_void, i32, i32, i32, i32) -> Tresult,
    set_active: unsafe extern "C" fn(*mut c_void, i32) -> Tresult,
    set_state: unsafe extern "C" fn(*mut c_void, *mut c_void) -> Tresult,
    get_state: unsafe extern "C" fn(*mut c_void, *mut c_void) -> Tresult,
}

#[repr(C)]
struct IEditControllerVtbl {
    // FUnknown (3)
    query_interface: unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    // IPluginBase (2)
    initialize: unsafe extern "C" fn(*mut c_void, *mut c_void) -> Tresult,
    terminate: unsafe extern "C" fn(*mut c_void) -> Tresult,
    // IEditController (7 + setComponentState)
    set_component_state: unsafe extern "C" fn(*mut c_void, *mut c_void) -> Tresult,
    set_state: unsafe extern "C" fn(*mut c_void, *mut c_void) -> Tresult,
    get_state: unsafe extern "C" fn(*mut c_void, *mut c_void) -> Tresult,
    get_parameter_count: unsafe extern "C" fn(*mut c_void) -> i32,
    get_parameter_info: unsafe extern "C" fn(*mut c_void, i32, *mut c_void) -> Tresult,
    get_param_string_by_value: unsafe extern "C" fn(*mut c_void, u32, f64, *mut c_void) -> Tresult,
    get_param_value_by_string: unsafe extern "C" fn(*mut c_void, u32, *const u16, *mut f64) -> Tresult,
    normalized_param_to_plain: unsafe extern "C" fn(*mut c_void, u32, f64) -> f64,
    plain_param_to_normalized: unsafe extern "C" fn(*mut c_void, u32, f64) -> f64,
    get_param_normalized: unsafe extern "C" fn(*mut c_void, u32) -> f64,
    set_param_normalized: unsafe extern "C" fn(*mut c_void, u32, f64) -> Tresult,
    set_component_handler: unsafe extern "C" fn(*mut c_void, *mut c_void) -> Tresult,
    create_view: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void,
}

#[repr(C)]
struct IPlugViewVtbl {
    // FUnknown (3)
    query_interface: unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    // IPlugView (10)
    is_platform_type_supported: unsafe extern "C" fn(*mut c_void, *const c_char) -> Tresult,
    attached: unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> Tresult,
    removed: unsafe extern "C" fn(*mut c_void) -> Tresult,
    on_wheel: unsafe extern "C" fn(*mut c_void, f32) -> Tresult,
    on_key_down: unsafe extern "C" fn(*mut c_void, u16, i16, i16) -> Tresult,
    on_key_up: unsafe extern "C" fn(*mut c_void, u16, i16, i16) -> Tresult,
    get_size: unsafe extern "C" fn(*mut c_void, *mut ViewRect) -> Tresult,
    on_size: unsafe extern "C" fn(*mut c_void, *mut ViewRect) -> Tresult,
    on_focus: unsafe extern "C" fn(*mut c_void, u8) -> Tresult,
    set_frame: unsafe extern "C" fn(*mut c_void, *mut c_void) -> Tresult,
    can_resize: unsafe extern "C" fn(*mut c_void) -> Tresult,
    check_size_constraint: unsafe extern "C" fn(*mut c_void, *mut ViewRect) -> Tresult,
}

// ── Minimal IPlugFrame ──
#[repr(C)]
struct TestPlugFrameVtbl {
    query_interface: unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    resize_view: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut ViewRect) -> Tresult,
}

#[repr(C)]
struct TestPlugFrame {
    vtbl: *const TestPlugFrameVtbl,
    ref_count: u32,
}

static TEST_PLUG_FRAME_VTBL: TestPlugFrameVtbl = TestPlugFrameVtbl {
    query_interface: test_frame_qi,
    add_ref: test_frame_add_ref,
    release: test_frame_release,
    resize_view: test_frame_resize_view,
};

unsafe extern "C" fn test_frame_qi(
    _this: *mut c_void,
    iid: *const Tuid,
    obj: *mut *mut c_void,
) -> Tresult {
    if !obj.is_null() {
        unsafe { *obj = ptr::null_mut(); }
    }
    let iid_bytes = unsafe { &*iid };
    println!("[test_frame_qi] iid={:02x?}", iid_bytes);
    -1 // kNoInterface
}

unsafe extern "C" fn test_frame_add_ref(this: *mut c_void) -> u32 {
    println!("[test_frame_addRef]");
    if this.is_null() { return 0; }
    let f = unsafe { &mut *(this as *mut TestPlugFrame) };
    f.ref_count += 1;
    f.ref_count
}

unsafe extern "C" fn test_frame_release(this: *mut c_void) -> u32 {
    println!("[test_frame_release]");
    if this.is_null() { return 0; }
    let f = unsafe { &mut *(this as *mut TestPlugFrame) };
    f.ref_count = f.ref_count.saturating_sub(1);
    f.ref_count
}

unsafe extern "C" fn test_frame_resize_view(
    _this: *mut c_void,
    _view: *mut c_void,
    rect: *mut ViewRect,
) -> Tresult {
    if !rect.is_null() {
        let r = unsafe { &*rect };
        println!("[test_frame_resizeView] {}x{}", r.right - r.left, r.bottom - r.top);
    }
    0 // kResultOk
}

// ── Minimal IComponentHandler ──
#[repr(C)]
struct TestHandlerVtbl {
    query_interface: unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    begin_edit: unsafe extern "C" fn(*mut c_void, u32) -> Tresult,
    perform_edit: unsafe extern "C" fn(*mut c_void, u32, f64) -> Tresult,
    end_edit: unsafe extern "C" fn(*mut c_void, u32) -> Tresult,
    restart_component: unsafe extern "C" fn(*mut c_void, i32) -> Tresult,
}

#[repr(C)]
struct TestHandler {
    vtbl: *const TestHandlerVtbl,
    ref_count: u32,
}

unsafe extern "C" fn handler_qi(_this: *mut c_void, _iid: *const Tuid, obj: *mut *mut c_void) -> Tresult {
    if !obj.is_null() { unsafe { *obj = ptr::null_mut(); } }
    -1
}
unsafe extern "C" fn handler_add_ref(this: *mut c_void) -> u32 {
    if this.is_null() { return 0; }
    let h = unsafe { &mut *(this as *mut TestHandler) };
    h.ref_count += 1;
    h.ref_count
}
unsafe extern "C" fn handler_release(this: *mut c_void) -> u32 {
    if this.is_null() { return 0; }
    let h = unsafe { &mut *(this as *mut TestHandler) };
    h.ref_count = h.ref_count.saturating_sub(1);
    h.ref_count
}
unsafe extern "C" fn handler_begin_edit(_: *mut c_void, _id: u32) -> Tresult { 0 }
unsafe extern "C" fn handler_perform_edit(_: *mut c_void, _id: u32, _val: f64) -> Tresult { 0 }
unsafe extern "C" fn handler_end_edit(_: *mut c_void, _id: u32) -> Tresult { 0 }
unsafe extern "C" fn handler_restart(_: *mut c_void, flags: i32) -> Tresult {
    println!("[handler_restart] flags={}", flags);
    0
}

static TEST_HANDLER_VTBL: TestHandlerVtbl = TestHandlerVtbl {
    query_interface: handler_qi,
    add_ref: handler_add_ref,
    release: handler_release,
    begin_edit: handler_begin_edit,
    perform_edit: handler_perform_edit,
    end_edit: handler_end_edit,
    restart_component: handler_restart,
};

// ── Minimal IHostApplication ──
#[repr(C)]
struct TestHostAppVtbl {
    query_interface: unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    get_name: unsafe extern "C" fn(*mut c_void, *mut [u16; 128]) -> Tresult,
    create_instance: unsafe extern "C" fn(*mut c_void, *const Tuid, *const Tuid, *mut *mut c_void) -> Tresult,
}

#[repr(C)]
struct TestHostApp {
    vtbl: *const TestHostAppVtbl,
    ref_count: u32,
}

unsafe extern "C" fn host_qi(this: *mut c_void, iid: *const Tuid, obj: *mut *mut c_void) -> Tresult {
    if !obj.is_null() { unsafe { *obj = ptr::null_mut(); } }
    // Check if querying for IHostApplication itself
    let iid_bytes = unsafe { &*iid };
    let ihost_iid: Tuid = [0x58, 0xE5, 0x95, 0xCC, 0xDB, 0x2D, 0x43, 0x69, 0xA2, 0xBF, 0x1A, 0x26, 0x32, 0x00, 0x97, 0x8B];
    if *iid_bytes == ihost_iid {
        if !obj.is_null() {
            unsafe { *obj = this; }
            unsafe { host_add_ref(this); }
            return 0;
        }
    }
    -1
}
unsafe extern "C" fn host_add_ref(this: *mut c_void) -> u32 {
    if this.is_null() { return 0; }
    let h = unsafe { &mut *(this as *mut TestHostApp) };
    h.ref_count += 1;
    h.ref_count
}
unsafe extern "C" fn host_release(this: *mut c_void) -> u32 {
    if this.is_null() { return 0; }
    let h = unsafe { &mut *(this as *mut TestHostApp) };
    h.ref_count = h.ref_count.saturating_sub(1);
    h.ref_count
}
unsafe extern "C" fn host_get_name(_: *mut c_void, name: *mut [u16; 128]) -> Tresult {
    let n = unsafe { &mut *name };
    let text = "Dream DAW Test";
    for (i, ch) in text.encode_utf16().enumerate() {
        if i >= 127 { break; }
        n[i] = ch;
    }
    n[text.len().min(127)] = 0;
    0
}
unsafe extern "C" fn host_create_instance(_: *mut c_void, _: *const Tuid, _: *const Tuid, obj: *mut *mut c_void) -> Tresult {
    if !obj.is_null() { unsafe { *obj = ptr::null_mut(); } }
    -1
}

static TEST_HOST_APP_VTBL: TestHostAppVtbl = TestHostAppVtbl {
    query_interface: host_qi,
    add_ref: host_add_ref,
    release: host_release,
    get_name: host_get_name,
    create_instance: host_create_instance,
};

// ── IComponent IID ──
const ICOMPONENT_IID: Tuid = [
    0xE8, 0x31, 0xFF, 0x31, 0xF2, 0xD5, 0x4E, 0x01,
    0x92, 0x8E, 0xB2, 0x68, 0x7F, 0xAD, 0xB6, 0xAE,
];
const IEDIT_CONTROLLER_IID: Tuid = [
    0xDC, 0xD7, 0xBB, 0xE3, 0x78, 0x42, 0x48, 0xDB,
    0xA1, 0xFC, 0x27, 0x63, 0x22, 0xE5, 0xA1, 0x17,
];

fn main() {
    println!("=== Serum2 VST3 Standalone Test ===\n");

    // 1. Initialize NSApplication (required for AppKit)
    let ns_app = cls!("NSApplication");
    let app = msg!(ns_app, sel!("sharedApplication"));
    println!("[1] NSApplication: {:p}", app);

    // Set activation policy to regular (so windows can appear)
    {
        type F = unsafe extern "C" fn(Id, Sel, i64) -> i8;
        let f: F = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { f(app, sel!("setActivationPolicy:"), 0) }; // NSApplicationActivationPolicyRegular
    }

    // 2. Load Serum2 dylib
    let bundle_path = "/Library/Audio/Plug-Ins/VST3/Serum2.vst3";
    println!("[2] Loading bundle: {}", bundle_path);

    let ns_string = cls!("NSString");
    let path_str = {
        type F = unsafe extern "C" fn(Id, Sel, *const c_char) -> Id;
        let f: F = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { f(ns_string, sel!("stringWithUTF8String:"), b"/Library/Audio/Plug-Ins/VST3/Serum2.vst3\0".as_ptr() as *const c_char) }
    };

    let ns_bundle = cls!("NSBundle");
    let bundle = msg!(ns_bundle, sel!("bundleWithPath:"), id: path_str);
    if bundle.is_null() {
        eprintln!("ERROR: Failed to create NSBundle");
        return;
    }

    let loaded: Id = msg!(bundle, sel!("load"));
    println!("[2] Bundle loaded: {:p}", loaded);

    // Get the executable path and dlopen
    let exec_url = msg!(bundle, sel!("executableURL"));
    let exec_path: Id = msg!(exec_url, sel!("path"));
    let exec_cstr: *const c_char = {
        type F = unsafe extern "C" fn(Id, Sel) -> *const c_char;
        let f: F = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { f(exec_path, sel!("UTF8String")) }
    };
    let exec_str = unsafe { std::ffi::CStr::from_ptr(exec_cstr) };
    println!("[2] Executable: {}", exec_str.to_str().unwrap());

    // dlopen the binary
    let handle = unsafe {
        dlopen(exec_cstr, RTLD_NOW | RTLD_LOCAL)
    };
    if handle.is_null() {
        let err = unsafe { std::ffi::CStr::from_ptr(dlerror()) };
        eprintln!("ERROR: dlopen failed: {}", err.to_str().unwrap());
        return;
    }
    println!("[2] dlopen OK: {:p}", handle);

    // 3. Get factory
    let get_factory_sym = unsafe {
        dlsym(handle, b"GetPluginFactory\0".as_ptr() as *const c_char)
    };
    if get_factory_sym.is_null() {
        eprintln!("ERROR: GetPluginFactory not found");
        return;
    }
    type GetFactoryFn = unsafe extern "C" fn() -> *mut c_void;
    let get_factory: GetFactoryFn = unsafe { std::mem::transmute(get_factory_sym) };
    let factory = unsafe { get_factory() };
    println!("[3] Factory: {:p}", factory);

    let factory_vtbl = unsafe { *(factory as *const *const IPluginFactoryVtbl) };

    // Enumerate all classes
    let count = unsafe { ((*factory_vtbl).count_classes)(factory) };
    println!("[4] Class count: {}", count);
    let mut processor_cid: Option<Tuid> = None;
    #[repr(C)]
    struct PClassInfo {
        cid: Tuid,
        cardinality: i32,
        category: [u8; 32],
        name: [u8; 64],
    }
    for i in 0..count {
        let mut class_info: PClassInfo = unsafe { std::mem::zeroed() };
        unsafe { ((*factory_vtbl).get_class_info)(factory, i, &mut class_info as *mut _ as *mut c_void) };
        let class_name = String::from_utf8_lossy(&class_info.name).trim_end_matches('\0').to_string();
        let class_cat = String::from_utf8_lossy(&class_info.category).trim_end_matches('\0').to_string();
        let cid_hex: String = class_info.cid.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join("");
        println!("[4] Class {}: name='{}' category='{}' cid={}", i, class_name, class_cat, cid_hex);
        
        // The Audio Module Class is the processor
        if class_cat.starts_with("Audio Module") {
            processor_cid = Some(class_info.cid);
        }
    }

    let cid = processor_cid.expect("ERROR: No Audio Module Class found");
    println!("[4] Using processor CID: {:02X?}", cid);

    // 5. Create component instance
    let mut component_raw: *mut c_void = ptr::null_mut();
    let cr = unsafe {
        ((*factory_vtbl).create_instance)(factory, &cid, &ICOMPONENT_IID, &mut component_raw)
    };
    println!("[5] createInstance(IComponent): result={}, ptr={:p}", cr, component_raw);
    if cr != 0 || component_raw.is_null() {
        // Try with FUnknown IID
        let funknown_iid: Tuid = [
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
        ];
        let cr2 = unsafe {
            ((*factory_vtbl).create_instance)(factory, &cid, &funknown_iid, &mut component_raw)
        };
        println!("[5] createInstance(FUnknown): result={}, ptr={:p}", cr2, component_raw);
        if cr2 != 0 || component_raw.is_null() {
            eprintln!("ERROR: createInstance failed with both IIDs");
            return;
        }
    }

    let comp_vtbl = unsafe { *(component_raw as *const *const IComponentVtbl) };

    // 6. Create host app and initialize component
    let mut host_app = TestHostApp {
        vtbl: &TEST_HOST_APP_VTBL,
        ref_count: 1,
    };
    let host_ptr = &mut host_app as *mut TestHostApp as *mut c_void;

    let init_res = unsafe { ((*comp_vtbl).initialize)(component_raw, host_ptr) };
    println!("[6] IComponent::initialize: {}", init_res);

    // 7. QI for IEditController (single-component pattern)
    let mut controller_raw: *mut c_void = ptr::null_mut();
    let qi_res = unsafe {
        ((*comp_vtbl).query_interface)(component_raw, &IEDIT_CONTROLLER_IID, &mut controller_raw)
    };
    println!("[7] QI(IEditController): result={}, ptr={:p}", qi_res, controller_raw);
    if qi_res != 0 || controller_raw.is_null() {
        eprintln!("ERROR: QI for IEditController failed");
        return;
    }

    let ctrl_vtbl = unsafe { *(controller_raw as *const *const IEditControllerVtbl) };

    // 8. Set component handler
    let mut handler = TestHandler {
        vtbl: &TEST_HANDLER_VTBL,
        ref_count: 1,
    };
    let handler_ptr = &mut handler as *mut TestHandler as *mut c_void;
    let sch_res = unsafe { ((*ctrl_vtbl).set_component_handler)(controller_raw, handler_ptr) };
    println!("[8] setComponentHandler: {}", sch_res);

    // 9. Create editor view
    println!("[9] createView('editor')...");
    let plug_view = unsafe { ((*ctrl_vtbl).create_view)(controller_raw, b"editor\0".as_ptr() as *const c_char) };
    println!("[9] createView: {:p}", plug_view);
    if plug_view.is_null() {
        eprintln!("ERROR: createView returned null");
        return;
    }

    let view_vtbl = unsafe { *(plug_view as *const *const IPlugViewVtbl) };

    // 10. Get size
    let mut rect = ViewRect { left: 0, top: 0, right: 0, bottom: 0 };
    let gs = unsafe { ((*view_vtbl).get_size)(plug_view, &mut rect) };
    let w = (rect.right - rect.left) as f64;
    let h = (rect.bottom - rect.top) as f64;
    println!("[10] getSize: {}x{} (result={})", w, h, gs);

    // 11. Create NSWindow
    println!("[11] Creating NSWindow...");
    let ns_window = cls!("NSWindow");
    let window = {
        let frame = NSRect::new(100.0, 100.0, w, h);
        type F = unsafe extern "C" fn(Id, Sel, NSRect, u64, u64, i8) -> Id;
        let f: F = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        let titled_closable = 1u64 | 2u64; // NSTitledWindowMask | NSClosableWindowMask
        unsafe { f(
            msg!(ns_window, sel!("alloc")),
            sel!("initWithContentRect:styleMask:backing:defer:"),
            frame,
            titled_closable,
            2u64, // NSBackingStoreBuffered
            0i8,  // defer = NO
        ) }
    };
    println!("[11] NSWindow: {:p}", window);

    // Set title
    {
        let title_str = {
            type F = unsafe extern "C" fn(Id, Sel, *const c_char) -> Id;
            let f: F = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
            unsafe { f(ns_string, sel!("stringWithUTF8String:"), b"Serum2 Test\0".as_ptr() as *const c_char) }
        };
        msg!(window, sel!("setTitle:"), id: title_str);
    }

    let content_view = msg!(window, sel!("contentView"));
    println!("[11] contentView: {:p}", content_view);

    // setWantsLayer on contentView
    msg!(content_view, sel!("setWantsLayer:"), bool: true);

    // 12. Create child view for plugin
    println!("[12] Creating plugin host view...");
    let plugin_host_view = {
        let nsview_cls = cls!("NSView");
        let v = msg!(nsview_cls, sel!("alloc"));
        let frame = NSRect::new(0.0, 0.0, w, h);
        let v = msg!(v, sel!("initWithFrame:"), rect: frame);
        v
    };
    msg!(plugin_host_view, sel!("setWantsLayer:"), bool: true);
    msg!(content_view, sel!("addSubview:"), id: plugin_host_view);
    println!("[12] pluginHostView: {:p}", plugin_host_view);

    // 13. Make window visible BEFORE attached()
    msg!(window, sel!("center"));
    msg!(window, sel!("makeKeyAndOrderFront:"), id: NIL);
    println!("[13] Window visible");

    // Pump the run loop briefly to let AppKit process the window
    unsafe {
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, 0);
    }
    println!("[13] Run loop pumped");

    // 14. setFrame
    let mut frame = TestPlugFrame {
        vtbl: &TEST_PLUG_FRAME_VTBL,
        ref_count: 1,
    };
    let frame_ptr = &mut frame as *mut TestPlugFrame as *mut c_void;
    println!("[14] setFrame({:p})...", frame_ptr);
    let sf = unsafe { ((*view_vtbl).set_frame)(plug_view, frame_ptr) };
    println!("[14] setFrame: {}", sf);

    // 15. attached!
    println!("\n[15] === CALLING attached() ===");
    println!("[15] parent={:p}, type='NSView'", plugin_host_view);
    let att = unsafe {
        ((*view_vtbl).attached)(
            plug_view,
            plugin_host_view as *mut c_void,
            b"NSView\0".as_ptr() as *const c_char,
        )
    };
    println!("[15] attached returned: {}", att);

    // 16. Run the event loop
    println!("\n[16] Running event loop... (Ctrl+C to exit)");
    unsafe {
        let app = msg!(cls!("NSApplication"), sel!("sharedApplication"));
        msg!(app, sel!("activateIgnoringOtherApps:"), bool: true);

        // Run the main loop
        loop {
            let result = CFRunLoopRunInMode(kCFRunLoopDefaultMode, 1.0, 0);
            // Just keep running
        }
    }
}
