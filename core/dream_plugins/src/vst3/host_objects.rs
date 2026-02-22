// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — VST3 Host COM Objects (Singletons & Factories)
// ═══════════════════════════════════════════════════════════════════════════
//
// Static COM singletons required by the VST3 plugin lifecycle:
//   - IHostApplication  (provides plugin name + IMessage factory)
//   - IComponentHandler (receives GUI parameter edits, restart signals)
//   - IPlugInterfaceSupport (reports supported interfaces)
//
// Also contains:
//   - HostAttrList / HostMsg — heap-allocated IMessage + IAttributeList
//   - ParamEditRing — lock-free ring buffer for audio→UI param sync

use std::ffi::{c_char, c_void};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};

use log::info;

use crate::vst3::com_abi::{
    Tresult, Tuid, tuid_eq,
    IID_FUNKNOWN, IID_IHOST_APPLICATION, IID_IPLUG_INTERFACE_SUPPORT,
    IID_IATTRIBUTE_LIST, IID_IMESSAGE,
    IID_ICOMPONENT_HANDLER, IID_ICOMPONENT_HANDLER_2,
    K_NO_INTERFACE, K_RESULT_FALSE, K_RESULT_OK,
    K_RESTART_LATENCY_CHANGED, K_RESTART_PARAM_VALUES_CHANGED,
    K_RESTART_IO_CHANGED, K_RESTART_PARAM_TITLES_CHANGED,
};

// ═══════════════════════════════════════════════════════════════════════════
// IHostApplication (COM singleton)
// ═══════════════════════════════════════════════════════════════════════════

/// COM vtable for IHostApplication.
/// Layout: FUnknown (query_interface, addRef, release) + getName + createInstance.
#[repr(C)]
struct IHostApplicationVtbl {
    query_interface:
        unsafe extern "system" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    get_name: unsafe extern "system" fn(*mut c_void, *mut u16) -> Tresult,
    create_instance: unsafe extern "system" fn(
        *mut c_void,
        *const Tuid,
        *const Tuid,
        *mut *mut c_void,
    ) -> Tresult,
}

unsafe extern "system" fn host_query_interface(
    this: *mut c_void,
    iid: *const Tuid,
    obj: *mut *mut c_void,
) -> Tresult {
    if obj.is_null() {
        return K_NO_INTERFACE;
    }
    if tuid_eq(iid, &IID_FUNKNOWN) || tuid_eq(iid, &IID_IHOST_APPLICATION) {
        unsafe { *obj = this; }
        K_RESULT_OK
    } else if tuid_eq(iid, &IID_IPLUG_INTERFACE_SUPPORT) {
        unsafe {
            *obj = (this as *mut u8).add(std::mem::size_of::<*const c_void>()) as *mut c_void;
        }
        K_RESULT_OK
    } else {
        unsafe { *obj = ptr::null_mut(); }
        K_NO_INTERFACE
    }
}

unsafe extern "system" fn host_add_ref(_this: *mut c_void) -> u32 { 1 }
unsafe extern "system" fn host_release(_this: *mut c_void) -> u32 { 1 }

unsafe extern "system" fn host_get_name(_this: *mut c_void, name: *mut u16) -> Tresult {
    if name.is_null() {
        return K_NO_INTERFACE;
    }
    let text: &[u16] = &[
        b'D' as u16, b'r' as u16, b'e' as u16, b'a' as u16, b'm' as u16,
        b' ' as u16, b'D' as u16, b'A' as u16, b'W' as u16, 0,
    ];
    unsafe { ptr::copy_nonoverlapping(text.as_ptr(), name, text.len()); }
    K_RESULT_OK
}

// ═══════════════════════════════════════════════════════════════════════════
// IAttributeList (heap-allocated, Vec-backed)
// ═══════════════════════════════════════════════════════════════════════════

enum HostAttrValue {
    Int(i64),
    Float(f64),
    String(Vec<u16>),
    Binary(Vec<u8>),
}

#[repr(C)]
struct HostAttrListVtbl {
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
    get_binary: unsafe extern "C" fn(*mut c_void, *const c_char, *mut *const c_void, *mut u32) -> Tresult,
}

#[repr(C)]
struct HostAttrList {
    vtbl: *const HostAttrListVtbl,
    ref_count: u32,
    attrs: Vec<(String, HostAttrValue)>,
}

impl HostAttrList {
    fn find(&self, key: &str) -> Option<&HostAttrValue> {
        self.attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    fn set(&mut self, key: String, val: HostAttrValue) {
        if let Some(entry) = self.attrs.iter_mut().find(|(k, _)| *k == key) {
            entry.1 = val;
        } else {
            self.attrs.push((key, val));
        }
    }
}

fn cstr_to_string_safe(p: *const c_char) -> String {
    if p.is_null() { return String::new(); }
    unsafe { std::ffi::CStr::from_ptr(p) }.to_str().unwrap_or("").to_string()
}

unsafe extern "C" fn host_attr_qi(this: *mut c_void, iid: *const Tuid, obj: *mut *mut c_void) -> Tresult {
    if !obj.is_null() { unsafe { *obj = ptr::null_mut(); } }
    if tuid_eq(iid, &IID_FUNKNOWN) || tuid_eq(iid, &IID_IATTRIBUTE_LIST) {
        unsafe { *obj = this; }
        unsafe { host_attr_add_ref(this); }
        return K_RESULT_OK;
    }
    K_NO_INTERFACE
}
unsafe extern "C" fn host_attr_add_ref(this: *mut c_void) -> u32 {
    if this.is_null() { return 0; }
    let a = unsafe { &mut *(this as *mut HostAttrList) };
    a.ref_count += 1;
    a.ref_count
}
unsafe extern "C" fn host_attr_release(this: *mut c_void) -> u32 {
    if this.is_null() { return 0; }
    let a = unsafe { &mut *(this as *mut HostAttrList) };
    a.ref_count = a.ref_count.saturating_sub(1);
    let rc = a.ref_count;
    if rc == 0 { unsafe { let _ = Box::from_raw(this as *mut HostAttrList); } }
    rc
}
unsafe extern "C" fn host_attr_set_int(this: *mut c_void, key: *const c_char, val: i64) -> Tresult {
    if this.is_null() { return K_RESULT_FALSE; }
    let a = unsafe { &mut *(this as *mut HostAttrList) };
    a.set(cstr_to_string_safe(key), HostAttrValue::Int(val));
    K_RESULT_OK
}
unsafe extern "C" fn host_attr_get_int(this: *mut c_void, key: *const c_char, out: *mut i64) -> Tresult {
    if this.is_null() || out.is_null() { return K_RESULT_FALSE; }
    let a = unsafe { &*(this as *const HostAttrList) };
    match a.find(&cstr_to_string_safe(key)) {
        Some(HostAttrValue::Int(v)) => { unsafe { *out = *v; } K_RESULT_OK }
        _ => K_RESULT_FALSE
    }
}
unsafe extern "C" fn host_attr_set_float(this: *mut c_void, key: *const c_char, val: f64) -> Tresult {
    if this.is_null() { return K_RESULT_FALSE; }
    let a = unsafe { &mut *(this as *mut HostAttrList) };
    a.set(cstr_to_string_safe(key), HostAttrValue::Float(val));
    K_RESULT_OK
}
unsafe extern "C" fn host_attr_get_float(this: *mut c_void, key: *const c_char, out: *mut f64) -> Tresult {
    if this.is_null() || out.is_null() { return K_RESULT_FALSE; }
    let a = unsafe { &*(this as *const HostAttrList) };
    match a.find(&cstr_to_string_safe(key)) {
        Some(HostAttrValue::Float(v)) => { unsafe { *out = *v; } K_RESULT_OK }
        _ => K_RESULT_FALSE
    }
}
unsafe extern "C" fn host_attr_set_string(this: *mut c_void, key: *const c_char, val: *const u16) -> Tresult {
    if this.is_null() || val.is_null() { return K_RESULT_FALSE; }
    let a = unsafe { &mut *(this as *mut HostAttrList) };
    let mut buf = Vec::new();
    let mut i = 0;
    loop {
        let ch = unsafe { *val.add(i) };
        buf.push(ch);
        if ch == 0 { break; }
        i += 1;
        if i > 10000 { buf.push(0); break; }
    }
    a.set(cstr_to_string_safe(key), HostAttrValue::String(buf));
    K_RESULT_OK
}
unsafe extern "C" fn host_attr_get_string(this: *mut c_void, key: *const c_char, out: *mut u16, size: u32) -> Tresult {
    if this.is_null() || out.is_null() { return K_RESULT_FALSE; }
    let a = unsafe { &*(this as *const HostAttrList) };
    match a.find(&cstr_to_string_safe(key)) {
        Some(HostAttrValue::String(v)) => {
            let copy_len = v.len().min(size as usize);
            unsafe { ptr::copy_nonoverlapping(v.as_ptr(), out, copy_len); }
            K_RESULT_OK
        }
        _ => K_RESULT_FALSE
    }
}
unsafe extern "C" fn host_attr_set_binary(this: *mut c_void, key: *const c_char, data: *const c_void, size: u32) -> Tresult {
    if this.is_null() || data.is_null() { return K_RESULT_FALSE; }
    let a = unsafe { &mut *(this as *mut HostAttrList) };
    let slice = unsafe { std::slice::from_raw_parts(data as *const u8, size as usize) };
    a.set(cstr_to_string_safe(key), HostAttrValue::Binary(slice.to_vec()));
    K_RESULT_OK
}
unsafe extern "C" fn host_attr_get_binary(this: *mut c_void, key: *const c_char, out: *mut *const c_void, size: *mut u32) -> Tresult {
    if this.is_null() || out.is_null() || size.is_null() { return K_RESULT_FALSE; }
    let a = unsafe { &*(this as *const HostAttrList) };
    match a.find(&cstr_to_string_safe(key)) {
        Some(HostAttrValue::Binary(v)) => {
            unsafe { *out = v.as_ptr() as *const c_void; }
            unsafe { *size = v.len() as u32; }
            K_RESULT_OK
        }
        _ => K_RESULT_FALSE
    }
}

static HOST_ATTR_LIST_VTBL: HostAttrListVtbl = HostAttrListVtbl {
    query_interface: host_attr_qi, add_ref: host_attr_add_ref, release: host_attr_release,
    set_int: host_attr_set_int, get_int: host_attr_get_int,
    set_float: host_attr_set_float, get_float: host_attr_get_float,
    set_string: host_attr_set_string, get_string: host_attr_get_string,
    set_binary: host_attr_set_binary, get_binary: host_attr_get_binary,
};

// ═══════════════════════════════════════════════════════════════════════════
// IMessage (heap-allocated, with embedded IAttributeList)
// ═══════════════════════════════════════════════════════════════════════════

#[repr(C)]
struct HostMsgVtbl {
    query_interface: unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    get_message_id: unsafe extern "C" fn(*mut c_void) -> *const c_char,
    set_message_id: unsafe extern "C" fn(*mut c_void, *const c_char),
    get_attributes: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
}

#[repr(C)]
struct HostMsg {
    vtbl: *const HostMsgVtbl,
    ref_count: u32,
    message_id: [u8; 256],
    attr_list: *mut HostAttrList,
}

unsafe extern "C" fn host_msg_qi(this: *mut c_void, iid: *const Tuid, obj: *mut *mut c_void) -> Tresult {
    if !obj.is_null() { unsafe { *obj = ptr::null_mut(); } }
    if tuid_eq(iid, &IID_FUNKNOWN) || tuid_eq(iid, &IID_IMESSAGE) {
        unsafe { *obj = this; }
        unsafe { host_msg_add_ref(this); }
        return K_RESULT_OK;
    }
    K_NO_INTERFACE
}
unsafe extern "C" fn host_msg_add_ref(this: *mut c_void) -> u32 {
    if this.is_null() { return 0; }
    let m = unsafe { &mut *(this as *mut HostMsg) };
    m.ref_count += 1;
    m.ref_count
}
unsafe extern "C" fn host_msg_release(this: *mut c_void) -> u32 {
    if this.is_null() { return 0; }
    let m = unsafe { &mut *(this as *mut HostMsg) };
    m.ref_count = m.ref_count.saturating_sub(1);
    let rc = m.ref_count;
    if rc == 0 {
        if !m.attr_list.is_null() {
            unsafe { host_attr_release(m.attr_list as *mut c_void); }
        }
        unsafe { let _ = Box::from_raw(this as *mut HostMsg); }
    }
    rc
}
unsafe extern "C" fn host_msg_get_id(this: *mut c_void) -> *const c_char {
    let m = unsafe { &*(this as *const HostMsg) };
    m.message_id.as_ptr() as *const c_char
}
unsafe extern "C" fn host_msg_set_id(this: *mut c_void, id: *const c_char) {
    let m = unsafe { &mut *(this as *mut HostMsg) };
    if !id.is_null() {
        let mut i = 0;
        loop {
            let b = unsafe { *id.add(i) } as u8;
            if b == 0 || i >= 255 { break; }
            m.message_id[i] = b;
            i += 1;
        }
        m.message_id[i] = 0;
    }
}
unsafe extern "C" fn host_msg_get_attrs(this: *mut c_void) -> *mut c_void {
    let m = unsafe { &*(this as *const HostMsg) };
    m.attr_list as *mut c_void
}

static HOST_MSG_VTBL: HostMsgVtbl = HostMsgVtbl {
    query_interface: host_msg_qi,
    add_ref: host_msg_add_ref,
    release: host_msg_release,
    get_message_id: host_msg_get_id,
    set_message_id: host_msg_set_id,
    get_attributes: host_msg_get_attrs,
};

fn host_create_message() -> *mut c_void {
    let attr_list = Box::into_raw(Box::new(HostAttrList {
        vtbl: &HOST_ATTR_LIST_VTBL,
        ref_count: 1,
        attrs: Vec::new(),
    }));
    let msg = Box::into_raw(Box::new(HostMsg {
        vtbl: &HOST_MSG_VTBL,
        ref_count: 1,
        message_id: [0u8; 256],
        attr_list,
    }));
    msg as *mut c_void
}

// ═══════════════════════════════════════════════════════════════════════════
// IPlugInterfaceSupport
// ═══════════════════════════════════════════════════════════════════════════

#[repr(C)]
struct IPlugInterfaceSupportVtbl {
    query_interface: unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    is_plug_interface_supported: unsafe extern "C" fn(*mut c_void, *const Tuid) -> Tresult,
}

unsafe extern "C" fn host_iface_support_qi(this: *mut c_void, iid: *const Tuid, obj: *mut *mut c_void) -> Tresult {
    if !obj.is_null() { unsafe { *obj = ptr::null_mut(); } }
    if tuid_eq(iid, &IID_FUNKNOWN) || tuid_eq(iid, &IID_IPLUG_INTERFACE_SUPPORT) {
        unsafe { *obj = this; }
        return K_RESULT_OK;
    }
    K_NO_INTERFACE
}
unsafe extern "C" fn host_iface_support_add_ref(_: *mut c_void) -> u32 { 1 }
unsafe extern "C" fn host_iface_support_release(_: *mut c_void) -> u32 { 1 }
unsafe extern "C" fn host_is_plug_interface_supported(_: *mut c_void, _iid: *const Tuid) -> Tresult {
    K_RESULT_OK
}

static HOST_IFACE_SUPPORT_VTBL: IPlugInterfaceSupportVtbl = IPlugInterfaceSupportVtbl {
    query_interface: host_iface_support_qi,
    add_ref: host_iface_support_add_ref,
    release: host_iface_support_release,
    is_plug_interface_supported: host_is_plug_interface_supported,
};

// ── Host create_instance ───────────────────────────────────────────────

unsafe extern "system" fn host_create_instance(
    _this: *mut c_void,
    cid: *const Tuid,
    iid: *const Tuid,
    obj: *mut *mut c_void,
) -> Tresult {
    if obj.is_null() {
        return K_RESULT_FALSE;
    }
    unsafe { *obj = ptr::null_mut(); }
    if tuid_eq(cid, &IID_IMESSAGE) && tuid_eq(iid, &IID_IMESSAGE) {
        unsafe { *obj = host_create_message(); }
        return K_RESULT_OK;
    }
    K_NO_INTERFACE
}

// ── HostApplicationInstance (dual-vtable singleton) ─────────────────────

static HOST_APP_VTBL: IHostApplicationVtbl = IHostApplicationVtbl {
    query_interface: host_query_interface,
    add_ref: host_add_ref,
    release: host_release,
    get_name: host_get_name,
    create_instance: host_create_instance,
};

#[repr(C)]
struct HostApplicationInstance {
    vtbl: *const IHostApplicationVtbl,
    vtbl_iface_support: *const IPlugInterfaceSupportVtbl,
}

unsafe impl Sync for HostApplicationInstance {}
unsafe impl Send for HostApplicationInstance {}

static HOST_APP_INSTANCE: HostApplicationInstance = HostApplicationInstance {
    vtbl: &HOST_APP_VTBL as *const IHostApplicationVtbl,
    vtbl_iface_support: &HOST_IFACE_SUPPORT_VTBL as *const IPlugInterfaceSupportVtbl,
};

pub(crate) fn host_application_ptr() -> *mut c_void {
    &HOST_APP_INSTANCE as *const HostApplicationInstance as *mut c_void
}

// ═══════════════════════════════════════════════════════════════════════════
// ParamEditRing (lock-free ring buffer)
// ═══════════════════════════════════════════════════════════════════════════

const PARAM_RING_SIZE: usize = 1024;

struct ParamEditEntry {
    param_id: AtomicU32,
    value_bits: AtomicUsize,
}

impl ParamEditEntry {
    const fn new() -> Self {
        Self {
            param_id: AtomicU32::new(0),
            value_bits: AtomicUsize::new(0),
        }
    }
}

struct ParamEditRing {
    entries: [ParamEditEntry; PARAM_RING_SIZE],
    head: AtomicUsize,
    tail: AtomicUsize,
}

impl ParamEditRing {
    const fn new() -> Self {
        #[allow(clippy::declare_interior_mutable_const)]
        const ENTRY: ParamEditEntry = ParamEditEntry::new();
        Self {
            entries: [ENTRY; PARAM_RING_SIZE],
            head: AtomicUsize::new(0),
            tail: AtomicUsize::new(0),
        }
    }

    fn push(&self, param_id: u32, value: f64) {
        let head = self.head.load(Ordering::Relaxed);
        let next = (head + 1) % PARAM_RING_SIZE;
        self.entries[head].param_id.store(param_id, Ordering::Relaxed);
        self.entries[head].value_bits.store(value.to_bits() as usize, Ordering::Relaxed);
        self.head.store(next, Ordering::Release);
    }

    pub fn drain(&self, mut f: impl FnMut(u32, f64)) -> usize {
        let mut count = 0;
        loop {
            let tail = self.tail.load(Ordering::Acquire);
            let head = self.head.load(Ordering::Acquire);
            if tail == head { break; }
            let pid = self.entries[tail].param_id.load(Ordering::Relaxed);
            let vbits = self.entries[tail].value_bits.load(Ordering::Relaxed);
            f(pid, f64::from_bits(vbits as u64));
            self.tail.store((tail + 1) % PARAM_RING_SIZE, Ordering::Release);
            count += 1;
        }
        count
    }
}

unsafe impl Sync for ParamEditRing {}

static PARAM_EDIT_RING: ParamEditRing = ParamEditRing::new();

static LATENCY_CHANGED: AtomicBool = AtomicBool::new(false);
static PARAM_VALUES_CHANGED: AtomicBool = AtomicBool::new(false);
static PLUGIN_STATE_DIRTY: AtomicBool = AtomicBool::new(false);

// ═══════════════════════════════════════════════════════════════════════════
// IComponentHandler + IComponentHandler2 (dual-vtable COM singleton)
// ═══════════════════════════════════════════════════════════════════════════

#[repr(C)]
struct IComponentHandlerVtbl {
    query_interface:
        unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    begin_edit: unsafe extern "C" fn(*mut c_void, u32) -> Tresult,
    perform_edit: unsafe extern "C" fn(*mut c_void, u32, f64) -> Tresult,
    end_edit: unsafe extern "C" fn(*mut c_void, u32) -> Tresult,
    restart_component: unsafe extern "C" fn(*mut c_void, i32) -> Tresult,
}

#[repr(C)]
struct IComponentHandler2Vtbl {
    query_interface:
        unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    set_dirty: unsafe extern "C" fn(*mut c_void, i8) -> Tresult,
    request_open_editor: unsafe extern "C" fn(*mut c_void, *const c_char) -> Tresult,
    start_group_edit: unsafe extern "C" fn(*mut c_void) -> Tresult,
    finish_group_edit: unsafe extern "C" fn(*mut c_void) -> Tresult,
}

#[repr(C)]
struct ComponentHandlerInstance {
    vtbl: *const IComponentHandlerVtbl,
    vtbl2: *const IComponentHandler2Vtbl,
}

unsafe impl Sync for ComponentHandlerInstance {}
unsafe impl Send for ComponentHandlerInstance {}

unsafe extern "C" fn handler_query_interface(
    this: *mut c_void,
    iid: *const Tuid,
    obj: *mut *mut c_void,
) -> Tresult {
    if obj.is_null() { return K_NO_INTERFACE; }
    if tuid_eq(iid, &IID_FUNKNOWN) || tuid_eq(iid, &IID_ICOMPONENT_HANDLER) {
        unsafe { handler_add_ref(this); }
        unsafe { *obj = this; }
        K_RESULT_OK
    } else if tuid_eq(iid, &IID_ICOMPONENT_HANDLER_2) {
        unsafe { handler_add_ref(this); }
        let inst = this as *const ComponentHandlerInstance;
        unsafe { *obj = &(*inst).vtbl2 as *const _ as *mut c_void; }
        K_RESULT_OK
    } else {
        unsafe { *obj = ptr::null_mut(); }
        K_NO_INTERFACE
    }
}

unsafe extern "C" fn handler_add_ref(_this: *mut c_void) -> u32 { 1 }
unsafe extern "C" fn handler_release(_this: *mut c_void) -> u32 { 1 }

unsafe extern "C" fn handler_begin_edit(_this: *mut c_void, id: u32) -> Tresult {
    info!("[VST3-Handler] beginEdit(paramId={})", id);
    K_RESULT_OK
}

unsafe extern "C" fn handler_perform_edit(_this: *mut c_void, id: u32, value: f64) -> Tresult {
    PARAM_EDIT_RING.push(id, value);
    PLUGIN_STATE_DIRTY.store(true, Ordering::Release);
    K_RESULT_OK
}

unsafe extern "C" fn handler_end_edit(_this: *mut c_void, id: u32) -> Tresult {
    info!("[VST3-Handler] endEdit(paramId={})", id);
    K_RESULT_OK
}

unsafe extern "C" fn handler_restart_component(_this: *mut c_void, flags: i32) -> Tresult {
    info!("[VST3-Handler] restartComponent(flags=0x{:04X})", flags);
    if flags & K_RESTART_LATENCY_CHANGED != 0 {
        info!("[VST3-Handler]   → kLatencyChanged — host should re-query getLatencySamples()");
        LATENCY_CHANGED.store(true, Ordering::Release);
    }
    if flags & K_RESTART_PARAM_VALUES_CHANGED != 0 {
        info!("[VST3-Handler]   → kParamValuesChanged — host should re-read all parameters");
        PARAM_VALUES_CHANGED.store(true, Ordering::Release);
        PLUGIN_STATE_DIRTY.store(true, Ordering::Release);
    }
    if flags & K_RESTART_IO_CHANGED != 0 {
        info!("[VST3-Handler]   → kIoChanged — bus layout may have changed");
    }
    if flags & K_RESTART_PARAM_TITLES_CHANGED != 0 {
        info!("[VST3-Handler]   → kParamTitlesChanged — parameter names updated");
    }
    K_RESULT_OK
}

// ── IComponentHandler2 stubs ──

unsafe extern "C" fn handler2_qi(
    this: *mut c_void,
    iid: *const Tuid,
    obj: *mut *mut c_void,
) -> Tresult {
    let base = unsafe {
        (this as *const u8).sub(std::mem::size_of::<*const IComponentHandlerVtbl>()) as *mut c_void
    };
    unsafe { handler_query_interface(base, iid, obj) }
}

unsafe extern "C" fn handler2_add_ref(_this: *mut c_void) -> u32 { 1 }
unsafe extern "C" fn handler2_release(_this: *mut c_void) -> u32 { 1 }

unsafe extern "C" fn handler2_set_dirty(_this: *mut c_void, state: i8) -> Tresult {
    if state != 0 { PLUGIN_STATE_DIRTY.store(true, Ordering::Release); }
    K_RESULT_OK
}

unsafe extern "C" fn handler2_request_open_editor(_this: *mut c_void, _name: *const c_char) -> Tresult {
    K_RESULT_OK
}

unsafe extern "C" fn handler2_start_group_edit(_this: *mut c_void) -> Tresult { K_RESULT_OK }
unsafe extern "C" fn handler2_finish_group_edit(_this: *mut c_void) -> Tresult { K_RESULT_OK }

static COMPONENT_HANDLER_VTBL: IComponentHandlerVtbl = IComponentHandlerVtbl {
    query_interface: handler_query_interface,
    add_ref: handler_add_ref,
    release: handler_release,
    begin_edit: handler_begin_edit,
    perform_edit: handler_perform_edit,
    end_edit: handler_end_edit,
    restart_component: handler_restart_component,
};

static COMPONENT_HANDLER2_VTBL: IComponentHandler2Vtbl = IComponentHandler2Vtbl {
    query_interface: handler2_qi,
    add_ref: handler2_add_ref,
    release: handler2_release,
    set_dirty: handler2_set_dirty,
    request_open_editor: handler2_request_open_editor,
    start_group_edit: handler2_start_group_edit,
    finish_group_edit: handler2_finish_group_edit,
};

static COMPONENT_HANDLER_INSTANCE: ComponentHandlerInstance = ComponentHandlerInstance {
    vtbl: &COMPONENT_HANDLER_VTBL as *const IComponentHandlerVtbl,
    vtbl2: &COMPONENT_HANDLER2_VTBL as *const IComponentHandler2Vtbl,
};

pub(crate) fn component_handler_ptr() -> *mut c_void {
    &COMPONENT_HANDLER_INSTANCE as *const ComponentHandlerInstance as *mut c_void
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

pub fn drain_gui_param_edits(f: impl FnMut(u32, f64)) -> usize {
    PARAM_EDIT_RING.drain(f)
}

pub fn take_latency_changed() -> bool {
    LATENCY_CHANGED.swap(false, Ordering::AcqRel)
}

pub fn take_param_values_changed() -> bool {
    PARAM_VALUES_CHANGED.swap(false, Ordering::AcqRel)
}

pub fn take_plugin_state_dirty() -> bool {
    PLUGIN_STATE_DIRTY.swap(false, Ordering::AcqRel)
}
