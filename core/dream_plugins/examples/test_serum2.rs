///! Standalone VST3 editor test harness — loads Serum2 and opens its editor
///! without Tauri/WebKit. Run with:
///!   cargo run -p dream_plugins --example test_serum2
use std::ffi::{c_char, c_void};
use std::os::raw::c_int;
use std::ptr;

// ── Signal handler for crash diagnosis ──
unsafe extern "C" {
    fn signal(sig: c_int, handler: unsafe extern "C" fn(c_int)) -> *mut c_void;
    fn backtrace(buffer: *mut *mut c_void, size: c_int) -> c_int;
    fn backtrace_symbols(buffer: *const *mut c_void, size: c_int) -> *mut *mut c_char;
}

#[repr(C)]
struct DlInfo {
    dli_fname: *const c_char,
    dli_fbase: *mut c_void,
    dli_sname: *const c_char,
    dli_saddr: *mut c_void,
}

unsafe extern "C" {
    fn dladdr(addr: *const c_void, info: *mut DlInfo) -> c_int;
}

unsafe extern "C" fn crash_handler(sig: c_int) {
    let sig_name = if sig == 11 {
        "SIGSEGV"
    } else if sig == 10 {
        "SIGBUS"
    } else {
        "UNKNOWN"
    };
    // Write directly to stderr via write() to be signal-safe
    let header = format!("\n\n=== CRASH: {} (signal {}) ===\n", sig_name, sig);
    unsafe {
        libc_write(2, header.as_ptr() as *const c_void, header.len());
    }

    let mut addrs: [*mut c_void; 64] = [ptr::null_mut(); 64];
    let count = unsafe { backtrace(addrs.as_mut_ptr(), 64) };
    let syms = unsafe { backtrace_symbols(addrs.as_ptr(), count) };

    for i in 0..count as usize {
        let mut info: DlInfo = DlInfo {
            dli_fname: ptr::null(),
            dli_fbase: ptr::null_mut(),
            dli_sname: ptr::null(),
            dli_saddr: ptr::null_mut(),
        };
        let has_info = unsafe { dladdr(addrs[i], &mut info) };

        let frame_str = if has_info != 0 && !info.dli_fname.is_null() {
            let fname = unsafe { std::ffi::CStr::from_ptr(info.dli_fname) }
                .to_str()
                .unwrap_or("?");
            // Get just the filename
            let short = fname.rsplit('/').next().unwrap_or(fname);
            let offset = (addrs[i] as usize).wrapping_sub(info.dli_fbase as usize);
            if !info.dli_sname.is_null() {
                let sname = unsafe { std::ffi::CStr::from_ptr(info.dli_sname) }
                    .to_str()
                    .unwrap_or("?");
                format!(
                    "  #{}: {} `{}` + {}\n",
                    i,
                    short,
                    sname,
                    (addrs[i] as usize).wrapping_sub(info.dli_saddr as usize)
                )
            } else {
                format!("  #{}: {} + 0x{:x}\n", i, short, offset)
            }
        } else {
            format!("  #{}: 0x{:x}\n", i, addrs[i] as usize)
        };
        unsafe {
            libc_write(2, frame_str.as_ptr() as *const c_void, frame_str.len());
        }
    }

    let footer = "=== END CRASH ===\n";
    unsafe {
        libc_write(2, footer.as_ptr() as *const c_void, footer.len());
    }
    // Re-raise to get the default behavior (core dump)
    unsafe {
        signal(sig, std::mem::transmute(0usize));
    }
    std::process::exit(128 + sig);
}

unsafe extern "C" {
    fn write(fd: c_int, buf: *const c_void, count: usize) -> isize;
}
// Rename to avoid conflict with the regular write
unsafe fn libc_write(fd: c_int, buf: *const c_void, count: usize) -> isize {
    unsafe { write(fd, buf, count) }
}

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
    create_instance:
        unsafe extern "C" fn(*mut c_void, *const Tuid, *const Tuid, *mut *mut c_void) -> Tresult,
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
    get_param_value_by_string:
        unsafe extern "C" fn(*mut c_void, u32, *const u16, *mut f64) -> Tresult,
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

// Thread-local window pointer for resizeView callback
std::thread_local! {
    static GLOBAL_WINDOW: std::cell::Cell<*mut c_void> = const { std::cell::Cell::new(std::ptr::null_mut()) };
}

static TEST_PLUG_FRAME_VTBL: TestPlugFrameVtbl = TestPlugFrameVtbl {
    query_interface: test_frame_qi,
    add_ref: test_frame_add_ref,
    release: test_frame_release,
    resize_view: test_frame_resize_view,
};

unsafe extern "C" fn test_frame_qi(
    this: *mut c_void,
    iid: *const Tuid,
    obj: *mut *mut c_void,
) -> Tresult {
    if !obj.is_null() {
        unsafe {
            *obj = ptr::null_mut();
        }
    }
    let iid_bytes = unsafe { &*iid };
    // IPlugFrame IID: {367FAF01-AFA9-4693-8D4D-A2A0ED0882A3}
    let iplug_frame_iid: Tuid = [
        0x36, 0x7F, 0xAF, 0x01, 0xAF, 0xA9, 0x46, 0x93, 0x8D, 0x4D, 0xA2, 0xA0, 0xED, 0x08, 0x82,
        0xA3,
    ];
    if *iid_bytes == FUNKNOWN_IID || *iid_bytes == iplug_frame_iid {
        if !obj.is_null() && !this.is_null() {
            unsafe {
                *obj = this;
            }
            unsafe {
                test_frame_add_ref(this);
            }
            println!("[test_frame_qi] MATCHED, returning this={:p}", this);
            return 0;
        }
    }
    let iid_hex: String = iid_bytes
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join("");
    println!("[test_frame_qi] NOT MATCHED iid={}", iid_hex);
    -1 // kNoInterface
}

unsafe extern "C" fn test_frame_add_ref(this: *mut c_void) -> u32 {
    println!("[test_frame_addRef]");
    if this.is_null() {
        return 0;
    }
    let f = unsafe { &mut *(this as *mut TestPlugFrame) };
    f.ref_count += 1;
    f.ref_count
}

unsafe extern "C" fn test_frame_release(this: *mut c_void) -> u32 {
    println!("[test_frame_release]");
    if this.is_null() {
        return 0;
    }
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
        let w = (r.right - r.left).max(100) as f64;
        let h = (r.bottom - r.top).max(100) as f64;
        println!("[test_frame_resizeView] {}x{}", w as i32, h as i32);

        // Actually resize the NSWindow like the main host does
        let window = GLOBAL_WINDOW.with(|c| c.get());
        if !window.is_null() {
            unsafe {
                // Get current window frame
                type FrameFn = unsafe extern "C" fn(Id, Sel) -> NSRect;
                let get_frame: FrameFn = std::mem::transmute(objc_msgSend as *const ());
                let current = get_frame(window, sel!("frame"));

                // Keep top-left fixed
                let new_y = current.y + current.h - h;
                let new_frame = NSRect::new(current.x, new_y, w, h);

                // setFrame:display:
                type SetFrameFn = unsafe extern "C" fn(Id, Sel, NSRect, u8);
                let set_frame: SetFrameFn = std::mem::transmute(objc_msgSend as *const ());
                set_frame(window, sel!("setFrame:display:"), new_frame, 1u8);
            }
        }
    }
    0 // kResultOk
}

// ── Minimal IBStream for state synchronization ──
#[repr(C)]
struct IBStreamVtbl {
    query_interface: unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    read: unsafe extern "C" fn(*mut c_void, *mut c_void, i32, *mut i32) -> Tresult,
    write: unsafe extern "C" fn(*mut c_void, *mut c_void, i32, *mut i32) -> Tresult,
    seek: unsafe extern "C" fn(*mut c_void, i64, i32, *mut i64) -> Tresult,
    tell: unsafe extern "C" fn(*mut c_void, *mut i64) -> Tresult,
}

const K_SEEK_SET: i32 = 0;
const K_SEEK_CUR: i32 = 1;
const K_SEEK_END: i32 = 2;

// Write stream — collects plugin state
#[repr(C)]
struct WriteStream {
    vtbl: *const IBStreamVtbl,
    data: Vec<u8>,
    pos: usize,
}

impl WriteStream {
    fn new() -> Self {
        Self {
            vtbl: &WRITE_STREAM_VTBL,
            data: Vec::with_capacity(4096),
            pos: 0,
        }
    }
}

unsafe extern "C" fn ws_qi(_: *mut c_void, _: *const Tuid, obj: *mut *mut c_void) -> Tresult {
    if !obj.is_null() {
        *obj = ptr::null_mut();
    }
    -1
}
unsafe extern "C" fn ws_add_ref(_: *mut c_void) -> u32 {
    1
}
unsafe extern "C" fn ws_release(_: *mut c_void) -> u32 {
    1
}
unsafe extern "C" fn ws_read(_: *mut c_void, _: *mut c_void, _: i32, nbr: *mut i32) -> Tresult {
    if !nbr.is_null() {
        unsafe {
            *nbr = 0;
        }
    }
    -1
}
unsafe extern "C" fn ws_write(
    this: *mut c_void,
    buffer: *mut c_void,
    num: i32,
    nbw: *mut i32,
) -> Tresult {
    if this.is_null() || buffer.is_null() || num <= 0 {
        if !nbw.is_null() {
            unsafe {
                *nbw = 0;
            }
        }
        return -1;
    }
    let s = unsafe { &mut *(this as *mut WriteStream) };
    let count = num as usize;
    let src = unsafe { std::slice::from_raw_parts(buffer as *const u8, count) };
    if s.pos < s.data.len() {
        let end = (s.pos + count).min(s.data.len());
        let oc = end - s.pos;
        s.data[s.pos..end].copy_from_slice(&src[..oc]);
        if count > oc {
            s.data.extend_from_slice(&src[oc..]);
        }
    } else {
        if s.pos > s.data.len() {
            s.data.resize(s.pos, 0);
        }
        s.data.extend_from_slice(src);
    }
    s.pos += count;
    if !nbw.is_null() {
        unsafe {
            *nbw = num;
        }
    }
    0
}
unsafe extern "C" fn ws_seek(this: *mut c_void, pos: i64, mode: i32, result: *mut i64) -> Tresult {
    let s = unsafe { &mut *(this as *mut WriteStream) };
    let np = match mode {
        K_SEEK_SET => pos,
        K_SEEK_CUR => s.pos as i64 + pos,
        K_SEEK_END => s.data.len() as i64 + pos,
        _ => return -1,
    };
    if np < 0 {
        return -1;
    }
    s.pos = np as usize;
    if !result.is_null() {
        unsafe {
            *result = s.pos as i64;
        }
    }
    0
}
unsafe extern "C" fn ws_tell(this: *mut c_void, result: *mut i64) -> Tresult {
    let s = unsafe { &*(this as *const WriteStream) };
    if !result.is_null() {
        unsafe {
            *result = s.pos as i64;
        }
    }
    0
}

static WRITE_STREAM_VTBL: IBStreamVtbl = IBStreamVtbl {
    query_interface: ws_qi,
    add_ref: ws_add_ref,
    release: ws_release,
    read: ws_read,
    write: ws_write,
    seek: ws_seek,
    tell: ws_tell,
};

// Read stream — feeds saved state back
#[repr(C)]
struct ReadStream {
    vtbl: *const IBStreamVtbl,
    data: Vec<u8>,
    pos: usize,
}

impl ReadStream {
    fn new(data: Vec<u8>) -> Self {
        Self {
            vtbl: &READ_STREAM_VTBL,
            data,
            pos: 0,
        }
    }
}

unsafe extern "C" fn rs_qi(_: *mut c_void, _: *const Tuid, obj: *mut *mut c_void) -> Tresult {
    if !obj.is_null() {
        *obj = ptr::null_mut();
    }
    -1
}
unsafe extern "C" fn rs_add_ref(_: *mut c_void) -> u32 {
    1
}
unsafe extern "C" fn rs_release(_: *mut c_void) -> u32 {
    1
}
unsafe extern "C" fn rs_read(
    this: *mut c_void,
    buffer: *mut c_void,
    num: i32,
    nbr: *mut i32,
) -> Tresult {
    if this.is_null() || buffer.is_null() || num <= 0 {
        if !nbr.is_null() {
            unsafe {
                *nbr = 0;
            }
        }
        return -1;
    }
    let s = unsafe { &mut *(this as *mut ReadStream) };
    let avail = s.data.len().saturating_sub(s.pos);
    let to_read = (num as usize).min(avail);
    if to_read > 0 {
        unsafe {
            std::ptr::copy_nonoverlapping(s.data[s.pos..].as_ptr(), buffer as *mut u8, to_read);
        }
        s.pos += to_read;
    }
    if !nbr.is_null() {
        unsafe {
            *nbr = to_read as i32;
        }
    }
    0
}
unsafe extern "C" fn rs_write(_: *mut c_void, _: *mut c_void, _: i32, nbw: *mut i32) -> Tresult {
    if !nbw.is_null() {
        unsafe {
            *nbw = 0;
        }
    }
    -1
}
unsafe extern "C" fn rs_seek(this: *mut c_void, pos: i64, mode: i32, result: *mut i64) -> Tresult {
    let s = unsafe { &mut *(this as *mut ReadStream) };
    let np = match mode {
        K_SEEK_SET => pos,
        K_SEEK_CUR => s.pos as i64 + pos,
        K_SEEK_END => s.data.len() as i64 + pos,
        _ => return -1,
    };
    if np < 0 {
        return -1;
    }
    s.pos = np as usize;
    if !result.is_null() {
        unsafe {
            *result = s.pos as i64;
        }
    }
    0
}
unsafe extern "C" fn rs_tell(this: *mut c_void, result: *mut i64) -> Tresult {
    let s = unsafe { &*(this as *const ReadStream) };
    if !result.is_null() {
        unsafe {
            *result = s.pos as i64;
        }
    }
    0
}

static READ_STREAM_VTBL: IBStreamVtbl = IBStreamVtbl {
    query_interface: rs_qi,
    add_ref: rs_add_ref,
    release: rs_release,
    read: rs_read,
    write: rs_write,
    seek: rs_seek,
    tell: rs_tell,
};

// ── Minimal IComponentHandler + IComponentHandler2 ──
// COM dual-vtable layout: IComponentHandler2 QI returns &self.vtbl2

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

// IComponentHandler2 vtable
#[repr(C)]
struct TestHandler2Vtbl {
    query_interface: unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    set_dirty: unsafe extern "C" fn(*mut c_void, u8) -> Tresult,
    request_open_editor: unsafe extern "C" fn(*mut c_void, *const c_char) -> Tresult,
    start_group_edit: unsafe extern "C" fn(*mut c_void) -> Tresult,
    finish_group_edit: unsafe extern "C" fn(*mut c_void) -> Tresult,
}

#[repr(C)]
struct TestHandler {
    vtbl: *const TestHandlerVtbl,
    vtbl2: *const TestHandler2Vtbl, // IComponentHandler2 — at offset 8
    ref_count: u32,
}

// IComponentHandler2 IID: {F040B4B3-A360-45EC-ABCD-C045B4D5A2CC}
const ICOMPONENT_HANDLER_2_IID: Tuid = [
    0xF0, 0x40, 0xB4, 0xB3, 0xA3, 0x60, 0x45, 0xEC, 0xAB, 0xCD, 0xC0, 0x45, 0xB4, 0xD5, 0xA2, 0xCC,
];

unsafe extern "C" fn handler_qi(
    this: *mut c_void,
    iid: *const Tuid,
    obj: *mut *mut c_void,
) -> Tresult {
    if !obj.is_null() {
        unsafe {
            *obj = ptr::null_mut();
        }
    }
    let iid_bytes = unsafe { &*iid };
    let iid_hex: String = iid_bytes
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join("");
    // IComponentHandler IID: {93A0BEA3-0BD0-45DB-8E89-0B0CC1E46AC6}
    let icomponent_handler_iid: Tuid = [
        0x93, 0xA0, 0xBE, 0xA3, 0x0B, 0xD0, 0x45, 0xDB, 0x8E, 0x89, 0x0B, 0x0C, 0xC1, 0xE4, 0x6A,
        0xC6,
    ];
    if *iid_bytes == FUNKNOWN_IID || *iid_bytes == icomponent_handler_iid {
        if !obj.is_null() && !this.is_null() {
            unsafe {
                *obj = this;
            }
            unsafe {
                handler_add_ref(this);
            }
            println!("[handler_qi] MATCHED IComponentHandler iid={}", iid_hex);
            return 0;
        }
    }
    if *iid_bytes == ICOMPONENT_HANDLER_2_IID {
        if !obj.is_null() && !this.is_null() {
            // Return pointer to the second vtable (offset 8 from this)
            let handler = this as *mut TestHandler;
            let vtbl2_ptr = unsafe { &(*handler).vtbl2 as *const _ as *mut c_void };
            unsafe {
                *obj = vtbl2_ptr;
            }
            unsafe {
                handler_add_ref(this);
            }
            println!("[handler_qi] MATCHED IComponentHandler2 iid={}", iid_hex);
            return 0;
        }
    }
    println!("[handler_qi] NOT MATCHED iid={}", iid_hex);
    -1
}
unsafe extern "C" fn handler_add_ref(this: *mut c_void) -> u32 {
    if this.is_null() {
        return 0;
    }
    let h = unsafe { &mut *(this as *mut TestHandler) };
    h.ref_count += 1;
    h.ref_count
}
unsafe extern "C" fn handler_release(this: *mut c_void) -> u32 {
    if this.is_null() {
        return 0;
    }
    let h = unsafe { &mut *(this as *mut TestHandler) };
    h.ref_count = h.ref_count.saturating_sub(1);
    h.ref_count
}
unsafe extern "C" fn handler_begin_edit(_: *mut c_void, _id: u32) -> Tresult {
    0
}
unsafe extern "C" fn handler_perform_edit(_: *mut c_void, _id: u32, _val: f64) -> Tresult {
    0
}
unsafe extern "C" fn handler_end_edit(_: *mut c_void, _id: u32) -> Tresult {
    0
}
unsafe extern "C" fn handler_restart(_: *mut c_void, flags: i32) -> Tresult {
    println!("[handler_restart] flags={}", flags);
    0
}

// IComponentHandler2 methods (called via vtbl2)
unsafe extern "C" fn handler2_qi(
    this: *mut c_void,
    iid: *const Tuid,
    obj: *mut *mut c_void,
) -> Tresult {
    // Navigate back from vtbl2 ptr to the base TestHandler
    let base = (this as *mut u8).sub(8) as *mut c_void;
    handler_qi(base, iid, obj)
}
unsafe extern "C" fn handler2_add_ref(this: *mut c_void) -> u32 {
    let base = unsafe { (this as *mut u8).sub(8) as *mut c_void };
    handler_add_ref(base)
}
unsafe extern "C" fn handler2_release(this: *mut c_void) -> u32 {
    let base = unsafe { (this as *mut u8).sub(8) as *mut c_void };
    handler_release(base)
}
unsafe extern "C" fn handler2_set_dirty(_: *mut c_void, _state: u8) -> Tresult {
    0
}
unsafe extern "C" fn handler2_request_open_editor(_: *mut c_void, _name: *const c_char) -> Tresult {
    0
}
unsafe extern "C" fn handler2_start_group_edit(_: *mut c_void) -> Tresult {
    0
}
unsafe extern "C" fn handler2_finish_group_edit(_: *mut c_void) -> Tresult {
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

static TEST_HANDLER2_VTBL: TestHandler2Vtbl = TestHandler2Vtbl {
    query_interface: handler2_qi,
    add_ref: handler2_add_ref,
    release: handler2_release,
    set_dirty: handler2_set_dirty,
    request_open_editor: handler2_request_open_editor,
    start_group_edit: handler2_start_group_edit,
    finish_group_edit: handler2_finish_group_edit,
};

// ── Minimal IHostApplication + IPlugInterfaceSupport ──
// IPlugInterfaceSupport IID: {A3B8C6C5-C095-4688-B091-6F0BB697AA44}
const IPLUG_INTERFACE_SUPPORT_IID: Tuid = [
    0xA3, 0xB8, 0xC6, 0xC5, 0xC0, 0x95, 0x46, 0x88, 0xB0, 0x91, 0x6F, 0x0B, 0xB6, 0x97, 0xAA, 0x44,
];

#[repr(C)]
struct TestHostAppVtbl {
    query_interface: unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    get_name: unsafe extern "C" fn(*mut c_void, *mut [u16; 128]) -> Tresult,
    create_instance:
        unsafe extern "C" fn(*mut c_void, *const Tuid, *const Tuid, *mut *mut c_void) -> Tresult,
}

// IPlugInterfaceSupport vtable
#[repr(C)]
struct TestPlugIfaceSupportVtbl {
    query_interface: unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    is_plug_interface_supported: unsafe extern "C" fn(*mut c_void, *const Tuid) -> Tresult,
}

#[repr(C)]
struct TestHostApp {
    vtbl: *const TestHostAppVtbl,
    vtbl_iface_support: *const TestPlugIfaceSupportVtbl, // at offset 8
    ref_count: u32,
}

unsafe extern "C" fn host_qi(
    this: *mut c_void,
    iid: *const Tuid,
    obj: *mut *mut c_void,
) -> Tresult {
    if !obj.is_null() {
        unsafe {
            *obj = ptr::null_mut();
        }
    }
    let iid_bytes = unsafe { &*iid };
    let iid_hex: String = iid_bytes
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join("");
    println!("[host_qi] iid={}", iid_hex);
    // IHostApplication IID: {58E595CC-DB2D-4969-8B6A-AF8C36A664E5}
    let ihost_iid: Tuid = [
        0x58, 0xE5, 0x95, 0xCC, 0xDB, 0x2D, 0x49, 0x69, 0x8B, 0x6A, 0xAF, 0x8C, 0x36, 0xA6, 0x64,
        0xE5,
    ];
    if *iid_bytes == ihost_iid || *iid_bytes == FUNKNOWN_IID {
        if !obj.is_null() {
            unsafe {
                *obj = this;
            }
            unsafe {
                host_add_ref(this);
            }
            println!(
                "[host_qi] MATCHED (IHostApplication), returning this={:p}",
                this
            );
            return 0;
        }
    }
    // IPlugInterfaceSupport
    if *iid_bytes == IPLUG_INTERFACE_SUPPORT_IID {
        if !obj.is_null() && !this.is_null() {
            let host = this as *mut TestHostApp;
            let iface_ptr = unsafe { &(*host).vtbl_iface_support as *const _ as *mut c_void };
            unsafe {
                *obj = iface_ptr;
            }
            unsafe {
                host_add_ref(this);
            }
            println!(
                "[host_qi] MATCHED (IPlugInterfaceSupport), returning {:p}",
                iface_ptr
            );
            return 0;
        }
    }
    println!("[host_qi] NOT MATCHED, returning -1");
    -1
}

// IPlugInterfaceSupport methods
unsafe extern "C" fn host_iface_qi(
    this: *mut c_void,
    iid: *const Tuid,
    obj: *mut *mut c_void,
) -> Tresult {
    let base = (this as *mut u8).sub(8) as *mut c_void;
    host_qi(base, iid, obj)
}
unsafe extern "C" fn host_iface_add_ref(this: *mut c_void) -> u32 {
    let base = unsafe { (this as *mut u8).sub(8) as *mut c_void };
    host_add_ref(base)
}
unsafe extern "C" fn host_iface_release(this: *mut c_void) -> u32 {
    let base = unsafe { (this as *mut u8).sub(8) as *mut c_void };
    host_release(base)
}
unsafe extern "C" fn host_is_plug_interface_supported(
    _this: *mut c_void,
    iid: *const Tuid,
) -> Tresult {
    let iid_bytes = unsafe { &*iid };
    let iid_hex: String = iid_bytes
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join("");
    println!(
        "[isPlugInterfaceSupported] iid={} → returning kResultOk",
        iid_hex
    );
    0 // kResultOk = "yes, we support this"
}

static TEST_PLUG_IFACE_SUPPORT_VTBL: TestPlugIfaceSupportVtbl = TestPlugIfaceSupportVtbl {
    query_interface: host_iface_qi,
    add_ref: host_iface_add_ref,
    release: host_iface_release,
    is_plug_interface_supported: host_is_plug_interface_supported,
};
unsafe extern "C" fn host_add_ref(this: *mut c_void) -> u32 {
    if this.is_null() {
        return 0;
    }
    let h = unsafe { &mut *(this as *mut TestHostApp) };
    h.ref_count += 1;
    h.ref_count
}
unsafe extern "C" fn host_release(this: *mut c_void) -> u32 {
    if this.is_null() {
        return 0;
    }
    let h = unsafe { &mut *(this as *mut TestHostApp) };
    h.ref_count = h.ref_count.saturating_sub(1);
    h.ref_count
}
unsafe extern "C" fn host_get_name(_: *mut c_void, name: *mut [u16; 128]) -> Tresult {
    let n = unsafe { &mut *name };
    let text = "Dream DAW Test";
    for (i, ch) in text.encode_utf16().enumerate() {
        if i >= 127 {
            break;
        }
        n[i] = ch;
    }
    n[text.len().min(127)] = 0;
    0
}
// ── IMessage CID/IID: {936F033B-C6C0-47DB-BB08-82F813C1E613}
const IMESSAGE_IID: Tuid = [
    0x93, 0x6F, 0x03, 0x3B, 0xC6, 0xC0, 0x47, 0xDB, 0xBB, 0x08, 0x82, 0xF8, 0x13, 0xC1, 0xE6, 0x13,
];

// ── IAttributeList IID: {1E5F0AEB-CC7F-4533-A254-401138AD5EE4}
const IATTRIBUTE_LIST_IID: Tuid = [
    0x1E, 0x5F, 0x0A, 0xEB, 0xCC, 0x7F, 0x45, 0x33, 0xA2, 0x54, 0x40, 0x11, 0x38, 0xAD, 0x5E, 0xE4,
];

// ── Real IAttributeList — stores data in Vec<(String, AttrValue)> ──
#[repr(C)]
struct MsgAttrListVtbl {
    query_interface: unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    set_int: unsafe extern "C" fn(*mut c_void, *const c_char, i64) -> Tresult,
    get_int: unsafe extern "C" fn(*mut c_void, *const c_char, *mut i64) -> Tresult,
    set_float: unsafe extern "C" fn(*mut c_void, *const c_char, f64) -> Tresult,
    get_float: unsafe extern "C" fn(*mut c_void, *const c_char, *mut f64) -> Tresult,
    set_string: unsafe extern "C" fn(*mut c_void, *const c_char, *const u16) -> Tresult,
    get_string: unsafe extern "C" fn(*mut c_void, *const c_char, *mut u16, u32) -> Tresult,
    set_binary: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_void, u32) -> Tresult,
    get_binary:
        unsafe extern "C" fn(*mut c_void, *const c_char, *mut *const c_void, *mut u32) -> Tresult,
}

enum AttrValue {
    Int(i64),
    Float(f64),
    String(Vec<u16>), // UTF-16 string (with null terminator)
    Binary(Vec<u8>),  // raw bytes
}

#[repr(C)]
struct MsgAttrList {
    vtbl: *const MsgAttrListVtbl,
    ref_count: u32,
    attrs: Vec<(String, AttrValue)>,
}

impl MsgAttrList {
    fn find(&self, key: &str) -> Option<&AttrValue> {
        self.attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    fn set(&mut self, key: String, val: AttrValue) {
        if let Some(entry) = self.attrs.iter_mut().find(|(k, _)| *k == key) {
            entry.1 = val;
        } else {
            self.attrs.push((key, val));
        }
    }
}

fn cstr_to_string(p: *const c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    unsafe { std::ffi::CStr::from_ptr(p) }
        .to_str()
        .unwrap_or("")
        .to_string()
}

unsafe extern "C" fn attr_qi(
    this: *mut c_void,
    iid: *const Tuid,
    obj: *mut *mut c_void,
) -> Tresult {
    if !obj.is_null() {
        unsafe {
            *obj = ptr::null_mut();
        }
    }
    let iid_bytes = unsafe { &*iid };
    if *iid_bytes == FUNKNOWN_IID || *iid_bytes == IATTRIBUTE_LIST_IID {
        unsafe {
            *obj = this;
        }
        attr_add_ref(this);
        return 0;
    }
    -1
}
unsafe extern "C" fn attr_add_ref(this: *mut c_void) -> u32 {
    if this.is_null() {
        return 0;
    }
    let a = unsafe { &mut *(this as *mut MsgAttrList) };
    a.ref_count += 1;
    a.ref_count
}
unsafe extern "C" fn attr_release(this: *mut c_void) -> u32 {
    if this.is_null() {
        return 0;
    }
    let a = unsafe { &mut *(this as *mut MsgAttrList) };
    a.ref_count = a.ref_count.saturating_sub(1);
    let rc = a.ref_count;
    if rc == 0 {
        unsafe {
            let _ = Box::from_raw(this as *mut MsgAttrList);
        }
    }
    rc
}
unsafe extern "C" fn attr_set_int(this: *mut c_void, key: *const c_char, val: i64) -> Tresult {
    if this.is_null() {
        return -1;
    }
    let a = unsafe { &mut *(this as *mut MsgAttrList) };
    a.set(cstr_to_string(key), AttrValue::Int(val));
    0
}
unsafe extern "C" fn attr_get_int(this: *mut c_void, key: *const c_char, out: *mut i64) -> Tresult {
    if this.is_null() || out.is_null() {
        return -1;
    }
    let a = unsafe { &*(this as *const MsgAttrList) };
    match a.find(&cstr_to_string(key)) {
        Some(AttrValue::Int(v)) => {
            unsafe {
                *out = *v;
            }
            0
        }
        _ => -1,
    }
}
unsafe extern "C" fn attr_set_float(this: *mut c_void, key: *const c_char, val: f64) -> Tresult {
    if this.is_null() {
        return -1;
    }
    let a = unsafe { &mut *(this as *mut MsgAttrList) };
    a.set(cstr_to_string(key), AttrValue::Float(val));
    0
}
unsafe extern "C" fn attr_get_float(
    this: *mut c_void,
    key: *const c_char,
    out: *mut f64,
) -> Tresult {
    if this.is_null() || out.is_null() {
        return -1;
    }
    let a = unsafe { &*(this as *const MsgAttrList) };
    match a.find(&cstr_to_string(key)) {
        Some(AttrValue::Float(v)) => {
            unsafe {
                *out = *v;
            }
            0
        }
        _ => -1,
    }
}
unsafe extern "C" fn attr_set_string(
    this: *mut c_void,
    key: *const c_char,
    val: *const u16,
) -> Tresult {
    if this.is_null() || val.is_null() {
        return -1;
    }
    let a = unsafe { &mut *(this as *mut MsgAttrList) };
    // Copy the UTF-16 string until null terminator
    let mut buf = Vec::new();
    let mut i = 0;
    loop {
        let ch = unsafe { *val.add(i) };
        buf.push(ch);
        if ch == 0 {
            break;
        }
        i += 1;
        if i > 10000 {
            buf.push(0);
            break;
        } // safety limit
    }
    a.set(cstr_to_string(key), AttrValue::String(buf));
    0
}
unsafe extern "C" fn attr_get_string(
    this: *mut c_void,
    key: *const c_char,
    out: *mut u16,
    size: u32,
) -> Tresult {
    if this.is_null() || out.is_null() {
        return -1;
    }
    let a = unsafe { &*(this as *const MsgAttrList) };
    match a.find(&cstr_to_string(key)) {
        Some(AttrValue::String(v)) => {
            let copy_len = v.len().min(size as usize);
            unsafe {
                ptr::copy_nonoverlapping(v.as_ptr(), out, copy_len);
            }
            0
        }
        _ => -1,
    }
}
unsafe extern "C" fn attr_set_binary(
    this: *mut c_void,
    key: *const c_char,
    data: *const c_void,
    size: u32,
) -> Tresult {
    if this.is_null() || data.is_null() {
        return -1;
    }
    let a = unsafe { &mut *(this as *mut MsgAttrList) };
    let slice = unsafe { std::slice::from_raw_parts(data as *const u8, size as usize) };
    a.set(cstr_to_string(key), AttrValue::Binary(slice.to_vec()));
    0
}
unsafe extern "C" fn attr_get_binary(
    this: *mut c_void,
    key: *const c_char,
    out: *mut *const c_void,
    size: *mut u32,
) -> Tresult {
    if this.is_null() || out.is_null() || size.is_null() {
        return -1;
    }
    let a = unsafe { &*(this as *const MsgAttrList) };
    match a.find(&cstr_to_string(key)) {
        Some(AttrValue::Binary(v)) => {
            // Return a pointer to the internal data — valid as long as the MsgAttrList is alive
            unsafe {
                *out = v.as_ptr() as *const c_void;
            }
            unsafe {
                *size = v.len() as u32;
            }
            0
        }
        _ => -1,
    }
}

static MSG_ATTR_LIST_VTBL: MsgAttrListVtbl = MsgAttrListVtbl {
    query_interface: attr_qi,
    add_ref: attr_add_ref,
    release: attr_release,
    set_int: attr_set_int,
    get_int: attr_get_int,
    set_float: attr_set_float,
    get_float: attr_get_float,
    set_string: attr_set_string,
    get_string: attr_get_string,
    set_binary: attr_set_binary,
    get_binary: attr_get_binary,
};

// ── Minimal IMessage ──
#[repr(C)]
struct MsgVtbl {
    query_interface: unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    get_message_id: unsafe extern "C" fn(*mut c_void) -> *const c_char,
    set_message_id: unsafe extern "C" fn(*mut c_void, *const c_char),
    get_attributes: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
}

#[repr(C)]
struct Msg {
    vtbl: *const MsgVtbl,
    ref_count: u32,
    message_id: [u8; 256],
    attr_list: *mut MsgAttrList,
}

unsafe extern "C" fn msg_qi(this: *mut c_void, iid: *const Tuid, obj: *mut *mut c_void) -> Tresult {
    if !obj.is_null() {
        unsafe {
            *obj = ptr::null_mut();
        }
    }
    let iid_bytes = unsafe { &*iid };
    if *iid_bytes == FUNKNOWN_IID || *iid_bytes == IMESSAGE_IID {
        unsafe {
            *obj = this;
        }
        msg_add_ref(this);
        return 0;
    }
    -1
}
unsafe extern "C" fn msg_add_ref(this: *mut c_void) -> u32 {
    if this.is_null() {
        return 0;
    }
    let m = unsafe { &mut *(this as *mut Msg) };
    m.ref_count += 1;
    m.ref_count
}
unsafe extern "C" fn msg_release(this: *mut c_void) -> u32 {
    if this.is_null() {
        return 0;
    }
    let m = unsafe { &mut *(this as *mut Msg) };
    m.ref_count = m.ref_count.saturating_sub(1);
    let rc = m.ref_count;
    if rc == 0 {
        // Release the attribute list
        if !m.attr_list.is_null() {
            attr_release(m.attr_list as *mut c_void);
        }
        unsafe {
            let _ = Box::from_raw(this as *mut Msg);
        }
    }
    rc
}
unsafe extern "C" fn msg_get_message_id(this: *mut c_void) -> *const c_char {
    let m = unsafe { &*(this as *const Msg) };
    m.message_id.as_ptr() as *const c_char
}
unsafe extern "C" fn msg_set_message_id(this: *mut c_void, id: *const c_char) {
    let m = unsafe { &mut *(this as *mut Msg) };
    if !id.is_null() {
        // Manual copy without CStr
        let mut i = 0;
        loop {
            let b = unsafe { *id.add(i) } as u8;
            if b == 0 || i >= 255 {
                break;
            }
            m.message_id[i] = b;
            i += 1;
        }
        m.message_id[i] = 0;
    }
}
unsafe extern "C" fn msg_get_attributes(this: *mut c_void) -> *mut c_void {
    let m = unsafe { &*(this as *const Msg) };
    m.attr_list as *mut c_void
}

static MSG_VTBL: MsgVtbl = MsgVtbl {
    query_interface: msg_qi,
    add_ref: msg_add_ref,
    release: msg_release,
    get_message_id: msg_get_message_id,
    set_message_id: msg_set_message_id,
    get_attributes: msg_get_attributes,
};

fn create_message() -> *mut c_void {
    let attr_list = Box::into_raw(Box::new(MsgAttrList {
        vtbl: &MSG_ATTR_LIST_VTBL,
        ref_count: 1,
        attrs: Vec::new(),
    }));
    let msg = Box::into_raw(Box::new(Msg {
        vtbl: &MSG_VTBL,
        ref_count: 1,
        message_id: [0u8; 256],
        attr_list,
    }));
    msg as *mut c_void
}

unsafe extern "C" fn host_create_instance(
    _: *mut c_void,
    cid: *const Tuid,
    iid: *const Tuid,
    obj: *mut *mut c_void,
) -> Tresult {
    if !obj.is_null() {
        unsafe {
            *obj = ptr::null_mut();
        }
    }
    let cid_bytes = unsafe { &*cid };
    let iid_bytes = unsafe { &*iid };
    let cid_hex: String = cid_bytes
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join("");
    let iid_hex: String = iid_bytes
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join("");
    println!("[host_createInstance] cid={}, iid={}", cid_hex, iid_hex);

    // ── Handle IMessage creation ──
    if *cid_bytes == IMESSAGE_IID || *iid_bytes == IMESSAGE_IID {
        let msg_ptr = create_message();
        if !obj.is_null() {
            unsafe {
                *obj = msg_ptr;
            }
        }
        println!("[host_createInstance] → Created IMessage at {:p}", msg_ptr);
        return 0;
    }

    -1 // kNoInterface for everything else
}

static TEST_HOST_APP_VTBL: TestHostAppVtbl = TestHostAppVtbl {
    query_interface: host_qi,
    add_ref: host_add_ref,
    release: host_release,
    get_name: host_get_name,
    create_instance: host_create_instance,
};

// ── VST3 SDK Official IIDs (from ivstcomponent.h / ivsteditcontroller.h) ──
// DECLARE_CLASS_IID (IComponent, 0xE831FF31, 0xF2D54301, 0x928EBBEE, 0x25697802)
const ICOMPONENT_IID: Tuid = [
    0xE8, 0x31, 0xFF, 0x31, 0xF2, 0xD5, 0x43, 0x01, 0x92, 0x8E, 0xBB, 0xEE, 0x25, 0x69, 0x78, 0x02,
];

// DECLARE_CLASS_IID (IEditController, 0xDCD7BBE3, 0x7742448D, 0xA874AACC, 0x979C759E)
const IEDIT_CONTROLLER_IID: Tuid = [
    0xDC, 0xD7, 0xBB, 0xE3, 0x77, 0x42, 0x44, 0x8D, 0xA8, 0x74, 0xAA, 0xCC, 0x97, 0x9C, 0x75, 0x9E,
];

// FUnknown IID: {00000000-0000-0000-C000-000000000046}
const FUNKNOWN_IID: Tuid = [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
];

fn main() {
    // Install crash handler for backtrace
    unsafe {
        signal(11, crash_handler); // SIGSEGV
        signal(10, crash_handler); // SIGBUS
    }
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

    // 2. Load VST3 plugin
    let bundle_path = std::env::var("VST3_BUNDLE_PATH")
        .unwrap_or_else(|_| "/Library/Audio/Plug-Ins/VST3/Serum2.vst3".to_string());
    println!("[2] Loading bundle: {}", bundle_path);

    let ns_string = cls!("NSString");
    let path_str = {
        type F = unsafe extern "C" fn(Id, Sel, *const c_char) -> Id;
        let f: F = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        {
            let path_c = std::ffi::CString::new(bundle_path.as_str()).unwrap();
            unsafe { f(ns_string, sel!("stringWithUTF8String:"), path_c.as_ptr()) }
        }
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
    let handle = unsafe { dlopen(exec_cstr, RTLD_NOW | RTLD_LOCAL) };
    if handle.is_null() {
        let err = unsafe { std::ffi::CStr::from_ptr(dlerror()) };
        eprintln!("ERROR: dlopen failed: {}", err.to_str().unwrap());
        return;
    }
    println!("[2] dlopen OK: {:p}", handle);

    // 2b. Call bundleEntry(CFBundleRef)
    // CRITICAL: VST3 modules on macOS expect bundleEntry() after dlopen.
    // VSTGUI-based plugins (Serum2, etc.) use CFBundleCopyResourceURL()
    // to locate GUI skins/bitmaps. Without a real CFBundleRef, resources
    // are not found → crash in createView/attached.
    let bundle_entry_sym = unsafe { dlsym(handle, b"bundleEntry\0".as_ptr() as *const c_char) };
    if !bundle_entry_sym.is_null() {
        // Create CFBundleRef from the .vst3 bundle path
        unsafe extern "C" {
            fn CFURLCreateFromFileSystemRepresentation(
                allocator: *const c_void,
                path: *const u8,
                path_len: i64,
                is_directory: u8,
            ) -> *mut c_void;
            fn CFBundleCreate(allocator: *const c_void, bundle_url: *mut c_void) -> *mut c_void;
            fn CFRelease(obj: *mut c_void);
            static kCFAllocatorDefault: *const c_void;
        }

        let bundle_path_bytes = bundle_path.as_bytes();
        let cf_url = unsafe {
            CFURLCreateFromFileSystemRepresentation(
                kCFAllocatorDefault,
                bundle_path_bytes.as_ptr(),
                bundle_path_bytes.len() as i64,
                1,
            )
        };
        let cf_bundle = if !cf_url.is_null() {
            let b = unsafe { CFBundleCreate(kCFAllocatorDefault, cf_url) };
            unsafe {
                CFRelease(cf_url);
            }
            b
        } else {
            ptr::null_mut()
        };
        println!("[2b] CFBundleRef: {:p}", cf_bundle);

        type BundleEntryFn = unsafe extern "C" fn(*mut c_void) -> bool;
        let bundle_entry: BundleEntryFn = unsafe { std::mem::transmute(bundle_entry_sym) };
        let entry_result = unsafe { bundle_entry(cf_bundle) };
        println!("[2b] bundleEntry: {}", entry_result);
        // NOTE: CFBundleRef must stay alive for entire plugin lifetime.
        // Don't release it — it's leaked intentionally for this test.
    } else {
        println!("[2b] No bundleEntry symbol found (OK for some plugins)");
    }

    // 3. Get factory
    let get_factory_sym = unsafe { dlsym(handle, b"GetPluginFactory\0".as_ptr() as *const c_char) };
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
        unsafe {
            ((*factory_vtbl).get_class_info)(factory, i, &mut class_info as *mut _ as *mut c_void)
        };
        let class_name = String::from_utf8_lossy(&class_info.name)
            .trim_end_matches('\0')
            .to_string();
        let class_cat = String::from_utf8_lossy(&class_info.category)
            .trim_end_matches('\0')
            .to_string();
        let cid_hex: String = class_info
            .cid
            .iter()
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<_>>()
            .join("");
        println!(
            "[4] Class {}: name='{}' category='{}' cid={}",
            i, class_name, class_cat, cid_hex
        );

        // The Audio Module Class is the processor — take FIRST match
        if class_cat.starts_with("Audio Module") && processor_cid.is_none() {
            processor_cid = Some(class_info.cid);
        }
    }

    let cid = processor_cid.expect("ERROR: No Audio Module Class found");
    println!("[4] Using processor CID: {:02X?}", cid);

    // 5. Create component instance via factory
    let mut component_raw: *mut c_void = ptr::null_mut();
    let cr = unsafe {
        ((*factory_vtbl).create_instance)(factory, &cid, &ICOMPONENT_IID, &mut component_raw)
    };
    println!(
        "[5] createInstance(IComponent): result={}, ptr={:p}",
        cr, component_raw
    );

    if cr != 0 || component_raw.is_null() {
        // Fallback: create via FUnknown, then QI
        let mut funknown_raw: *mut c_void = ptr::null_mut();
        let cr_fu = unsafe {
            ((*factory_vtbl).create_instance)(factory, &cid, &FUNKNOWN_IID, &mut funknown_raw)
        };
        println!(
            "[5] createInstance(FUnknown): result={}, ptr={:p}",
            cr_fu, funknown_raw
        );
        if cr_fu != 0 || funknown_raw.is_null() {
            eprintln!("ERROR: createInstance failed completely");
            return;
        }

        // QI from FUnknown → IComponent
        let funknown_vtbl = unsafe { *(funknown_raw as *const *const FUnknownVtbl) };
        let qi_comp = unsafe {
            ((*funknown_vtbl).query_interface)(funknown_raw, &ICOMPONENT_IID, &mut component_raw)
        };
        println!(
            "[5] QI(IComponent): result={}, ptr={:p}",
            qi_comp, component_raw
        );
        if qi_comp != 0 || component_raw.is_null() {
            println!("[5] QI failed — using raw FUnknown ptr as IComponent");
            component_raw = funknown_raw;
        }
    }

    let comp_vtbl = unsafe { *(component_raw as *const *const IComponentVtbl) };

    // 6. Create host app and initialize component
    let mut host_app = TestHostApp {
        vtbl: &TEST_HOST_APP_VTBL,
        vtbl_iface_support: &TEST_PLUG_IFACE_SUPPORT_VTBL,
        ref_count: 1,
    };
    let host_ptr = &mut host_app as *mut TestHostApp as *mut c_void;

    println!("[6] Calling IComponent::initialize...");
    let init_res = unsafe { ((*comp_vtbl).initialize)(component_raw, host_ptr) };
    println!(
        "[6] IComponent::initialize: {} (0x{:X})",
        init_res, init_res as u32
    );
    if init_res != 0 {
        println!("[6] WARNING: initialize returned non-zero.");
    }

    // 7. QI for IEditController (try single-component pattern first)
    let mut controller_raw: *mut c_void = ptr::null_mut();
    let qi_res = unsafe {
        ((*comp_vtbl).query_interface)(component_raw, &IEDIT_CONTROLLER_IID, &mut controller_raw)
    };
    println!(
        "[7] QI(IEditController): result={}, ptr={:p}",
        qi_res, controller_raw
    );

    if qi_res != 0 || controller_raw.is_null() {
        // Try separate controller: getControllerClassId, then createInstance + initialize
        let mut ctrl_cid: Tuid = [0u8; 16];
        let gc_res =
            unsafe { ((*comp_vtbl).get_controller_class_id)(component_raw, &mut ctrl_cid) };
        let cid_hex: String = ctrl_cid
            .iter()
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<_>>()
            .join("");
        println!(
            "[7] getControllerClassId: result={}, cid={}",
            gc_res, cid_hex
        );
        if gc_res == 0 && ctrl_cid != [0u8; 16] {
            let mut ctrl_raw: *mut c_void = ptr::null_mut();
            let cr_ctrl = unsafe {
                ((*factory_vtbl).create_instance)(
                    factory,
                    &ctrl_cid,
                    &IEDIT_CONTROLLER_IID,
                    &mut ctrl_raw,
                )
            };
            println!(
                "[7] createInstance(controller): result={}, ptr={:p}",
                cr_ctrl, ctrl_raw
            );
            if cr_ctrl == 0 && !ctrl_raw.is_null() {
                controller_raw = ctrl_raw;
            } else {
                // Try FUnknown
                let cr_ctrl2 = unsafe {
                    ((*factory_vtbl).create_instance)(
                        factory,
                        &ctrl_cid,
                        &FUNKNOWN_IID,
                        &mut ctrl_raw,
                    )
                };
                println!(
                    "[7] createInstance(controller FUnknown): result={}, ptr={:p}",
                    cr_ctrl2, ctrl_raw
                );
                if cr_ctrl2 == 0 && !ctrl_raw.is_null() {
                    controller_raw = ctrl_raw;
                }
            }
            if !controller_raw.is_null() {
                // Initialize the separate controller
                let ctrl_vtbl_tmp =
                    unsafe { *(controller_raw as *const *const IEditControllerVtbl) };
                let init2 = unsafe { ((*ctrl_vtbl_tmp).initialize)(controller_raw, host_ptr) };
                println!("[7] IEditController::initialize: {}", init2);
            }
        }
    }

    if controller_raw.is_null() {
        eprintln!("ERROR: Could not get IEditController");
        return;
    }

    let ctrl_vtbl = unsafe { *(controller_raw as *const *const IEditControllerVtbl) };

    // 8. Set component handler
    let mut handler = TestHandler {
        vtbl: &TEST_HANDLER_VTBL,
        vtbl2: &TEST_HANDLER2_VTBL,
        ref_count: 1,
    };
    let handler_ptr = &mut handler as *mut TestHandler as *mut c_void;
    let sch_res = unsafe { ((*ctrl_vtbl).set_component_handler)(controller_raw, handler_ptr) };
    println!("[8] setComponentHandler: {}", sch_res);

    // 8b. Wire IConnectionPoint between component and controller
    // CRITICAL: For plugins with separate component/controller (like Serum2),
    // the host MUST connect them via IConnectionPoint so they can exchange messages.
    // Without this, createView() will crash because the controller cannot
    // communicate with the component.
    let iconnection_point_iid: Tuid = [
        0x70, 0xA4, 0x15, 0x6F, 0x6E, 0x6E, 0x40, 0x26, 0x98, 0x91, 0x48, 0xBF, 0xAA, 0x60, 0xD8,
        0xD1,
    ];
    let mut cp_comp_raw: *mut c_void = ptr::null_mut();
    let mut cp_ctrl_raw: *mut c_void = ptr::null_mut();
    let qi_cp1 = unsafe {
        ((*comp_vtbl).query_interface)(component_raw, &iconnection_point_iid, &mut cp_comp_raw)
    };
    let qi_cp2 = unsafe {
        ((*ctrl_vtbl).query_interface)(controller_raw, &iconnection_point_iid, &mut cp_ctrl_raw)
    };
    println!(
        "[8b] QI(IConnectionPoint comp): result={}, ptr={:p}",
        qi_cp1, cp_comp_raw
    );
    println!(
        "[8b] QI(IConnectionPoint ctrl): result={}, ptr={:p}",
        qi_cp2, cp_ctrl_raw
    );
    if qi_cp1 == 0 && qi_cp2 == 0 && !cp_comp_raw.is_null() && !cp_ctrl_raw.is_null() {
        // IConnectionPoint vtable: [0]=qi, [1]=addRef, [2]=release, [3]=connect, [4]=disconnect
        #[repr(C)]
        struct IConnectionPointVtbl {
            query_interface:
                unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
            add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
            release: unsafe extern "C" fn(*mut c_void) -> u32,
            connect: unsafe extern "C" fn(*mut c_void, *mut c_void) -> Tresult,
            disconnect: unsafe extern "C" fn(*mut c_void, *mut c_void) -> Tresult,
        }
        let cp_comp_vtbl = unsafe { *(cp_comp_raw as *const *const IConnectionPointVtbl) };
        let cp_ctrl_vtbl = unsafe { *(cp_ctrl_raw as *const *const IConnectionPointVtbl) };
        // Re-enabled: Serum2 needs IConnectionPoint wiring for message delivery
        let c1 = unsafe { ((*cp_comp_vtbl).connect)(cp_comp_raw, cp_ctrl_raw) };
        let c2 = unsafe { ((*cp_ctrl_vtbl).connect)(cp_ctrl_raw, cp_comp_raw) };
        println!(
            "[8b] IConnectionPoint wired: comp→ctrl={}, ctrl→comp={}",
            c1, c2
        );
    } else {
        println!("[8b] IConnectionPoint not available (optional for single-component plugins)");
    }

    // 8c. Synchronize component state to controller
    // CRITICAL: The host must call IComponent::getState() and then
    // IEditController::setComponentState() so the controller's internal state
    // (UI data, preset pointers, etc.) is initialized.
    // Without this, Serum2 crashes in createView() because internal state pointers remain NULL.
    {
        let mut wstream = WriteStream::new();
        let wstream_ptr = &mut wstream as *mut WriteStream as *mut c_void;
        let gs = unsafe { ((*comp_vtbl).get_state)(component_raw, wstream_ptr) };
        println!(
            "[8c] IComponent::getState: result={}, bytes={}",
            gs,
            wstream.data.len()
        );
        if gs == 0 && !wstream.data.is_empty() {
            let state_bytes = wstream.data;
            let mut rstream = ReadStream::new(state_bytes);
            let rstream_ptr = &mut rstream as *mut ReadStream as *mut c_void;
            let scs = unsafe { ((*ctrl_vtbl).set_component_state)(controller_raw, rstream_ptr) };
            println!("[8c] IEditController::setComponentState: result={}", scs);
        } else if gs == 0 {
            println!("[8c] getState succeeded but returned empty state");
        }
    }

    // 8d. Setup audio processor
    // The main vst3_host.rs does setupProcessing + setProcessing(true) before
    // opening the editor. Serum2 may access audio buffers during rendering.
    {
        let iaudio_processor_iid: Tuid = [
            0x42, 0x04, 0x3F, 0x99, 0xB7, 0xDA, 0x45, 0x3C, 0xA5, 0x69, 0xE7, 0x9D, 0x9A, 0xAE,
            0xC3, 0x3D,
        ];
        let mut processor_raw: *mut c_void = ptr::null_mut();
        let qi_proc = unsafe {
            ((*comp_vtbl).query_interface)(component_raw, &iaudio_processor_iid, &mut processor_raw)
        };
        println!(
            "[8d] QI(IAudioProcessor): result={}, ptr={:p}",
            qi_proc, processor_raw
        );
        if qi_proc == 0 && !processor_raw.is_null() {
            // IAudioProcessor vtable layout:
            // [0] qi, [1] addRef, [2] release
            // [3] setBusArrangements, [4] getBusArrangement
            // [5] canProcessSampleSize, [6] getLatencySamples
            // [7] setupProcessing, [8] setProcessing
            // [9] process, [10] getTailSamples
            #[repr(C)]
            struct ProcessSetup {
                process_mode: i32,
                symbolic_sample_size: i32,
                max_samples_per_block: i32,
                sample_rate: f64,
            }
            #[repr(C)]
            struct IAudioProcessorVtbl {
                query_interface:
                    unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
                add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
                release: unsafe extern "C" fn(*mut c_void) -> u32,
                set_bus_arrangements: unsafe extern "C" fn(
                    *mut c_void,
                    *mut c_void,
                    i32,
                    *mut c_void,
                    i32,
                ) -> Tresult,
                get_bus_arrangement:
                    unsafe extern "C" fn(*mut c_void, i32, i32, *mut c_void) -> Tresult,
                can_process_sample_size: unsafe extern "C" fn(*mut c_void, i32) -> Tresult,
                get_latency_samples: unsafe extern "C" fn(*mut c_void) -> u32,
                setup_processing: unsafe extern "C" fn(*mut c_void, *const ProcessSetup) -> Tresult,
                set_processing: unsafe extern "C" fn(*mut c_void, i8) -> Tresult,
                process: unsafe extern "C" fn(*mut c_void, *mut c_void) -> Tresult,
                get_tail_samples: unsafe extern "C" fn(*mut c_void) -> u32,
            }

            let proc_vtbl = unsafe { *(processor_raw as *const *const IAudioProcessorVtbl) };
            let setup = ProcessSetup {
                process_mode: 0,         // kRealtime
                symbolic_sample_size: 0, // kSample32
                max_samples_per_block: 1024,
                sample_rate: 44100.0,
            };
            let sp_res = unsafe { ((*proc_vtbl).setup_processing)(processor_raw, &setup) };
            println!("[8d] setupProcessing: {}", sp_res);
            if sp_res == 0 {
                let proc_res = unsafe { ((*proc_vtbl).set_processing)(processor_raw, 1) };
                println!("[8d] setProcessing(true): {}", proc_res);
            }
        }
    }

    // 8e. Set component active
    let set_active_res = unsafe { ((*comp_vtbl).set_active)(component_raw, 1) };
    println!("[8e] setActive(true): {}", set_active_res);

    // 9. Create editor view
    println!("[9] createView('editor')...");
    println!(
        "[9] controller_raw={:p}, ctrl_vtbl={:p}",
        controller_raw, ctrl_vtbl as *const _
    );
    unsafe {
        println!(
            "[9] createView fn ptr={:p}",
            (*ctrl_vtbl).create_view as *const ()
        );
    }
    let plug_view = unsafe {
        ((*ctrl_vtbl).create_view)(controller_raw, b"editor\0".as_ptr() as *const c_char)
    };
    println!("[9] createView: {:p}", plug_view);
    if plug_view.is_null() {
        eprintln!("ERROR: createView returned null");
        return;
    }

    let view_vtbl = unsafe { *(plug_view as *const *const IPlugViewVtbl) };

    // 10. Get size
    let mut rect = ViewRect {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
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
        unsafe {
            f(
                msg!(ns_window, sel!("alloc")),
                sel!("initWithContentRect:styleMask:backing:defer:"),
                frame,
                titled_closable,
                2u64, // NSBackingStoreBuffered
                0i8,  // defer = NO
            )
        }
    };
    println!("[11] NSWindow: {:p}", window);

    // Set title
    {
        let title_str = {
            type F = unsafe extern "C" fn(Id, Sel, *const c_char) -> Id;
            let f: F = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
            unsafe {
                f(
                    ns_string,
                    sel!("stringWithUTF8String:"),
                    b"Serum2 Test\0".as_ptr() as *const c_char,
                )
            }
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
    // Match main host: set autoresizing mask (width + height sizable = 18)
    {
        type F = unsafe extern "C" fn(Id, Sel, u64);
        let f: F = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { f(plugin_host_view, sel!("setAutoresizingMask:"), 18) };
    }
    msg!(content_view, sel!("addSubview:"), id: plugin_host_view);
    println!("[12] pluginHostView: {:p}", plugin_host_view);

    // 13. Make window visible BEFORE attached()
    // CRITICAL: VSTGUI's CFrame depends on the NSView being in a displayable
    // window with a valid backing store. If the window isn't fully on-screen,
    // the platform frame pointer is NULL → offset 0x60 SIGSEGV.
    msg!(window, sel!("center"));
    msg!(window, sel!("makeKeyAndOrderFront:"), id: NIL);
    // Force the window to display immediately (initialize backing store)
    msg!(window, sel!("display"));
    msg!(plugin_host_view, sel!("setNeedsDisplay:"), bool: true);
    println!("[13] Window visible");

    // ── CRITICAL: Force the CALayer to be lazily created ──
    // When wantsLayer=YES is set, AppKit creates the backing CALayer lazily on
    // first access. VSTGUI's NSViewFrame accesses [view layer] during
    // CFrame::open(). If the layer hasn't been created yet, it can be NULL.
    // Force it by explicitly calling [plugin_host_view layer].
    {
        let layer: Id = msg!(plugin_host_view, sel!("layer"));
        println!("[13] pluginHostView.layer = {:p}", layer);
        if layer == NIL {
            println!("[13] WARNING: layer is NULL! Forcing layer creation...");
            // Explicitly set a new CALayer
            let ca_layer_cls = cls!("CALayer");
            let new_layer: Id = msg!(ca_layer_cls, sel!("layer"));
            msg!(plugin_host_view, sel!("setLayer:"), id: new_layer);
            let layer2: Id = msg!(plugin_host_view, sel!("layer"));
            println!("[13] After setLayer: layer = {:p}", layer2);
        }
        // Also force contentView layer
        let cv_layer: Id = msg!(content_view, sel!("layer"));
        println!("[13] contentView.layer = {:p}", cv_layer);
    }

    // NOTE: Removed the 0.5s CFRunLoopRunInMode pump. It triggered
    // IConnectionPoint message processing that crashes Serum2.
    // The window should already be visible from makeKeyAndOrderFront.
    println!("[13] Run loop pump SKIPPED (was causing crash)");

    // Force another display pass after run loop pump to ensure backing store
    msg!(window, sel!("display"));
    msg!(plugin_host_view, sel!("display"));

    // Set global window pointer so resizeView can resize it
    GLOBAL_WINDOW.with(|c| c.set(window));

    // 14. setFrame
    let mut frame = TestPlugFrame {
        vtbl: &TEST_PLUG_FRAME_VTBL,
        ref_count: 1,
    };
    let frame_ptr = &mut frame as *mut TestPlugFrame as *mut c_void;
    println!("[14] setFrame({:p})...", frame_ptr);
    let sf = unsafe { ((*view_vtbl).set_frame)(plug_view, frame_ptr) };
    println!("[14] setFrame: {}", sf);

    // 14b. IPlugViewContentScaleSupport::setContentScaleFactor
    // Per VST3 SDK: "The host calls setContentScaleFactor directly before or
    // after the plug-in view is attached." On macOS Retina, scale_factor = 2.0.
    // Without this, VSTGUI may use wrong scale for resource/texture loading,
    // leaving internal bitmap pointers NULL → SIGSEGV at offset 0x60.
    {
        let scale_support_iid: Tuid = [
            0x65, 0xED, 0x96, 0x90, 0x8A, 0xC4, 0x45, 0x25, 0x8A, 0xAD, 0xEF, 0x7A, 0x72, 0xEA,
            0x70, 0x3F,
        ];
        let mut scale_ptr: *mut c_void = ptr::null_mut();
        let qi_scale = unsafe {
            ((*view_vtbl).query_interface)(plug_view, &scale_support_iid, &mut scale_ptr)
        };
        println!(
            "[14b] QI(IPlugViewContentScaleSupport): result={}, ptr={:p}",
            qi_scale, scale_ptr
        );
        if qi_scale == 0 && !scale_ptr.is_null() {
            // IPlugViewContentScaleSupport vtable: [0]=qi, [1]=addRef, [2]=release, [3]=setContentScaleFactor
            #[repr(C)]
            struct IScaleSupportVtbl {
                query_interface:
                    unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
                add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
                release: unsafe extern "C" fn(*mut c_void) -> u32,
                set_content_scale_factor: unsafe extern "C" fn(*mut c_void, f32) -> Tresult,
            }
            let scale_vtbl = unsafe { *(scale_ptr as *const *const IScaleSupportVtbl) };

            // Detect actual backing scale factor from NSScreen
            let screen_scale: f64 = unsafe {
                let main_screen: Id = msg!(cls!("NSScreen"), sel!("mainScreen"));
                if !main_screen.is_null() {
                    type MsgSendF64 = unsafe extern "C" fn(Id, *mut c_void) -> f64;
                    let send: MsgSendF64 = std::mem::transmute(objc_msgSend as *const ());
                    send(main_screen, sel!("backingScaleFactor"))
                } else {
                    2.0 // Retina default
                }
            };
            println!("[14b] backingScaleFactor = {}", screen_scale);

            let scale_result =
                unsafe { ((*scale_vtbl).set_content_scale_factor)(scale_ptr, screen_scale as f32) };
            println!(
                "[14b] setContentScaleFactor({}): result={}",
                screen_scale, scale_result
            );

            // Release the QI'd interface
            unsafe {
                ((*scale_vtbl).release)(scale_ptr);
            }
        } else {
            println!("[14b] Plugin does not support IPlugViewContentScaleSupport (OK)");
        }
    }
    // 15. attached!
    println!("\n[15] === CALLING attached() ===");
    println!("[15] parent={:p}, type='NSView'", plugin_host_view);
    // Verify the view hierarchy is ready
    {
        let sv: Id = msg!(plugin_host_view, sel!("superview"));
        let win: Id = msg!(plugin_host_view, sel!("window"));
        let hidden: Id = msg!(plugin_host_view, sel!("isHidden"));
        let layer: Id = msg!(plugin_host_view, sel!("layer"));
        println!(
            "[15] superview={:p}, window={:p}, hidden={:p}, layer={:p}",
            sv, win, hidden, layer
        );
    }
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
