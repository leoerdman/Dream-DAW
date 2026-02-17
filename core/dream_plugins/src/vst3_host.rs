// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — VST3 Host Bridge (Native Plugin Loading)
// ═══════════════════════════════════════════════════════════════════════════
//
// Enterprise-grade VST3 plugin hosting via the VST3 COM interface.
//
// Architecture:
//   1. Load the `.vst3` bundle's binary via `libloading` (dylib on macOS).
//   2. Call `GetPluginFactory()` to obtain the `IPluginFactory` COM interface.
//   3. Create `IComponent` and `IAudioProcessor` instances.
//   4. Marshal audio buffers through the VST3 `ProcessData` struct.
//
// macOS bundle resolution:
//   `<name>.vst3/Contents/MacOS/<name>` is the dylib path.
//
// Real-Time Safety:
//   - `process()` calls into the plugin's `IAudioProcessor::process()`.
//   - No allocations in the process loop.
//   - All buffer preparation uses pre-allocated scratch memory.
//
// ═══════════════════════════════════════════════════════════════════════════

use std::collections::HashMap;
use std::ffi::{c_char, c_void};
use std::path::{Path, PathBuf};
use std::ptr;

use log::info;
use uuid::Uuid;

use crate::descriptor::PluginDescriptor;
use crate::format::PluginFormat;
use crate::instance::{MidiEvent, PluginError, PluginInstance, TransportContext};
use crate::sandbox_instance::SandboxedPluginInstance;

#[cfg(target_os = "macos")]
use cocoa::appkit::{
    NSApp, NSApplication, NSApplicationActivationPolicyRegular, NSBackingStoreType, NSWindow,
    NSWindowStyleMask,
};
#[cfg(target_os = "macos")]
use cocoa::base::{id, nil, NO};
#[cfg(target_os = "macos")]
use cocoa::foundation::{NSPoint, NSRect, NSSize};

type DreamDawProcessF32Fn = unsafe extern "C" fn(
    inputs: *const *const f32,
    outputs: *mut *mut f32,
    num_inputs: u32,
    num_outputs: u32,
    num_frames: u32,
    sample_rate: f64,
) -> i32;

type DreamDawOpenEditorFn = unsafe extern "C" fn() -> i32;
type DreamDawSetParameterFn = unsafe extern "C" fn(index: u32, value: f64) -> i32;

// ── Minimal VST3 ABI (COM) ─────────────────────────────────────────────

type Tuid = [u8; 16];
type Tresult = i32;

const K_RESULT_OK: Tresult = 0;
#[allow(dead_code)]
const K_RESULT_NOT_IMPLEMENTED: Tresult = -2147467263;
const K_RESULT_FALSE: Tresult = 1;
const K_SAMPLE32: i32 = 0;
const K_REALTIME: i32 = 0;
const K_NO_INTERFACE: Tresult = -1; // E_NOINTERFACE
const K_SEEK_SET: i32 = 0;
const K_SEEK_CUR: i32 = 1;
const K_SEEK_END: i32 = 2;

// ── VST3 ProcessContext C-ABI (matches Steinberg::Vst::ProcessContext) ──
//
// This struct MUST match the exact binary layout of the VST3 SDK's ProcessContext.
// Fields that we don't populate are zeroed — plugins must check the `state` flags
// before reading optional fields.
//
// Reference: vst3sdk/pluginterfaces/vst/ivstprocesscontext.h

/// State bit flags for ProcessContext.
const K_PLAYING: u32 = 1 << 1;
const K_RECORDING: u32 = 1 << 3;
const K_TEMPO_VALID: u32 = 1 << 10;
const K_TIME_SIG_VALID: u32 = 1 << 13;
const K_PROJECT_TIME_VALID: u32 = 1 << 9;

/// C-ABI struct matching `Steinberg::Vst::ProcessContext`.
/// Must be #[repr(C)] with exact field order from the SDK.
#[repr(C)]
#[derive(Clone)]
struct Vst3ProcessContext {
    /// Bit combination of ProcessContext state flags.
    state: u32,
    /// Current sample rate in Hz.
    sample_rate: f64,
    /// Project time in samples (absolute position).
    project_time_samples: i64,

    /// System time in nanoseconds (not used — set to 0).
    system_time: i64,
    /// Musical position in quarter notes (beats).
    project_time_music: f64,
    /// Last bar start position in quarter notes.
    bar_position_music: f64,
    /// Cycle start position in quarter notes.
    cycle_start_music: f64,
    /// Cycle end position in quarter notes.
    cycle_end_music: f64,

    /// Tempo in BPM.
    tempo: f64,
    /// Time signature numerator.
    time_sig_numerator: i32,
    /// Time signature denominator.
    time_sig_denominator: i32,

    /// MIDI clock position (not used).
    chord: i32,
    /// SMPTE offset (not used).
    smpte_offset_subframes: i32,
    /// SMPTE frame rate (not used).
    sampler_offset: i32,
    /// Timecode frame rate.
    smpte_frame_rate: i32,
    /// Clock offset.
    clock_offset: i32,
    /// Flags.
    flags: u32,
}

impl Vst3ProcessContext {
    /// Creates a ProcessContext from the stored transport state.
    fn from_transport(ctx: &TransportContext) -> Self {
        let mut state: u32 = K_TEMPO_VALID | K_TIME_SIG_VALID | K_PROJECT_TIME_VALID;
        if ctx.is_playing {
            state |= K_PLAYING;
        }
        if ctx.is_recording {
            state |= K_RECORDING;
        }

        // Convert position in samples to beats:
        // beats = samples / (sample_rate * 60 / bpm)
        let beats_per_second = ctx.tempo / 60.0;
        let position_seconds = ctx.position_samples as f64 / ctx.sample_rate;
        let position_beats = position_seconds * beats_per_second;

        Self {
            state,
            sample_rate: ctx.sample_rate,
            project_time_samples: ctx.position_samples,
            system_time: 0,
            project_time_music: position_beats,
            bar_position_music: 0.0,
            cycle_start_music: 0.0,
            cycle_end_music: 0.0,
            tempo: ctx.tempo,
            time_sig_numerator: 4,
            time_sig_denominator: 4,
            chord: 0,
            smpte_offset_subframes: 0,
            sampler_offset: 0,
            smpte_frame_rate: 0,
            clock_offset: 0,
            flags: 0,
        }
    }
}

const IID_IAUDIO_PROCESSOR: Tuid = [
    0x42, 0x04, 0x3F, 0x99, 0xB7, 0xDA, 0x45, 0x3C, 0xA5, 0x69, 0xE7, 0x9D, 0x9A, 0xAE, 0xC3, 0x3D,
];
const IID_ICOMPONENT: Tuid = [
    0xE8, 0x31, 0xFF, 0x31, 0xF2, 0xD5, 0x43, 0x01, 0x92, 0x8E, 0xBB, 0xEE, 0x25, 0x69, 0x78, 0x02,
];
const IID_IEDIT_CONTROLLER: Tuid = [
    0xDC, 0xD7, 0xBB, 0xE3, 0x77, 0x42, 0x44, 0x8D, 0xA8, 0x74, 0xAA, 0xCC, 0x97, 0x9C, 0x75, 0x9E,
];

// IHostApplication IID: {58E595CC-DB2D-4969-8B6A-AF8C36A664E5}
const IID_IHOST_APPLICATION: Tuid = [
    0x58, 0xE5, 0x95, 0xCC, 0xDB, 0x2D, 0x49, 0x69, 0x8B, 0x6A, 0xAF, 0x8C, 0x36, 0xA6, 0x64, 0xE5,
];

// IPlugFrame IID: {367FAF01-AFA9-4693-8D4D-A2A0ED0882A3}
const IID_IPLUG_FRAME: Tuid = [
    0x36, 0x7F, 0xAF, 0x01, 0xAF, 0xA9, 0x46, 0x93, 0x8D, 0x4D, 0xA2, 0xA0, 0xED, 0x08, 0x82, 0xA3,
];

// FUnknown IID: {00000000-0000-0000-C000-000000000046}
const IID_FUNKNOWN: Tuid = [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
];

// ── Minimal IHostApplication (COM singleton) ───────────────────────────
//
// VST3 plugins expect a valid IHostApplication* passed to IComponent::initialize().
// Passing NULL causes immediate segfault in FabFilter, Serum, Kontakt, etc.
//
// This is a static singleton — zero allocations at runtime.
// The COM vtable lives in static memory. RefCount is permanent.

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

/// The singleton IHostApplication object.
/// Contains only a vtable pointer — minimal COM object.
#[repr(C)]
struct HostApplicationInstance {
    vtbl: *const IHostApplicationVtbl,
}

// Safety: HostApplicationInstance is a read-only singleton with no mutable state.
unsafe impl Sync for HostApplicationInstance {}
unsafe impl Send for HostApplicationInstance {}

fn tuid_eq(a: *const Tuid, b: &Tuid) -> bool {
    if a.is_null() {
        return false;
    }
    unsafe { *a == *b }
}

unsafe extern "system" fn host_query_interface(
    this: *mut c_void,
    iid: *const Tuid,
    obj: *mut *mut c_void,
) -> Tresult {
    if obj.is_null() {
        return K_NO_INTERFACE;
    }
    // We respond to FUnknown and IHostApplication queries
    if tuid_eq(iid, &IID_FUNKNOWN) || tuid_eq(iid, &IID_IHOST_APPLICATION) {
        unsafe {
            *obj = this;
        }
        K_RESULT_OK
    } else {
        unsafe {
            *obj = ptr::null_mut();
        }
        K_NO_INTERFACE
    }
}

unsafe extern "system" fn host_add_ref(_this: *mut c_void) -> u32 {
    // Static singleton — never freed, refcount is meaningless.
    1
}

unsafe extern "system" fn host_release(_this: *mut c_void) -> u32 {
    // Static singleton — never freed.
    1
}

unsafe extern "system" fn host_get_name(_this: *mut c_void, name: *mut u16) -> Tresult {
    if name.is_null() {
        return K_NO_INTERFACE;
    }
    // Write "Dream DAW" as UTF-16LE (VST3 uses Steinberg::String128 = wchar_t[128])
    let text: &[u16] = &[
        b'D' as u16,
        b'r' as u16,
        b'e' as u16,
        b'a' as u16,
        b'm' as u16,
        b' ' as u16,
        b'D' as u16,
        b'A' as u16,
        b'W' as u16,
        0, // null terminator
    ];
    unsafe {
        ptr::copy_nonoverlapping(text.as_ptr(), name, text.len());
    }
    K_RESULT_OK
}

unsafe extern "system" fn host_create_instance(
    _this: *mut c_void,
    _cid: *const Tuid,
    _iid: *const Tuid,
    _obj: *mut *mut c_void,
) -> Tresult {
    // We don't provide any additional host services (e.g. IMessage).
    // This is valid — most plugins handle this gracefully.
    if !_obj.is_null() {
        unsafe {
            *_obj = ptr::null_mut();
        }
    }
    K_NO_INTERFACE
}

/// Static vtable for IHostApplication — lives forever in .rodata.
static HOST_APP_VTBL: IHostApplicationVtbl = IHostApplicationVtbl {
    query_interface: host_query_interface,
    add_ref: host_add_ref,
    release: host_release,
    get_name: host_get_name,
    create_instance: host_create_instance,
};

/// Static singleton IHostApplication instance.
static HOST_APP_INSTANCE: HostApplicationInstance = HostApplicationInstance {
    vtbl: &HOST_APP_VTBL as *const IHostApplicationVtbl,
};

/// Returns a pointer to the static IHostApplication singleton.
/// This pointer is valid for the entire lifetime of the process.
/// It is safe to pass to VST3 IComponent::initialize().
fn host_application_ptr() -> *mut c_void {
    &HOST_APP_INSTANCE as *const HostApplicationInstance as *mut c_void
}

#[repr(C)]
#[allow(dead_code)]
struct FUnknown {
    vtbl: *const FUnknownVtbl,
}

#[repr(C)]
#[allow(dead_code)]
struct FUnknownVtbl {
    query_interface:
        unsafe extern "C" fn(*mut FUnknown, *const c_char, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut FUnknown) -> u32,
    release: unsafe extern "C" fn(*mut FUnknown) -> u32,
}

#[repr(C)]
struct PClassInfo {
    cid: Tuid,
    cardinality: i32,
    category: [c_char; 32],
    name: [c_char; 64],
}

#[repr(C)]
struct IPluginFactory {
    vtbl: *const IPluginFactoryVtbl,
}

#[repr(C)]
struct IPluginFactoryVtbl {
    query_interface:
        unsafe extern "C" fn(*mut IPluginFactory, *const c_char, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut IPluginFactory) -> u32,
    release: unsafe extern "C" fn(*mut IPluginFactory) -> u32,
    get_factory_info: unsafe extern "C" fn(*mut IPluginFactory, *mut c_void) -> Tresult,
    count_classes: unsafe extern "C" fn(*mut IPluginFactory) -> i32,
    get_class_info: unsafe extern "C" fn(*mut IPluginFactory, i32, *mut PClassInfo) -> Tresult,
    create_instance: unsafe extern "C" fn(
        *mut IPluginFactory,
        *const Tuid,
        *const c_char,
        *mut *mut c_void,
    ) -> Tresult,
}

#[repr(C)]
struct IComponent {
    vtbl: *const IComponentVtbl,
}

#[repr(C)]
struct IComponentVtbl {
    query_interface:
        unsafe extern "C" fn(*mut IComponent, *const c_char, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut IComponent) -> u32,
    release: unsafe extern "C" fn(*mut IComponent) -> u32,
    initialize: unsafe extern "C" fn(*mut IComponent, *mut c_void) -> Tresult,
    terminate: unsafe extern "C" fn(*mut IComponent) -> Tresult,
    get_controller_class_id: unsafe extern "C" fn(*mut IComponent, *mut Tuid) -> Tresult,
    set_io_mode: unsafe extern "C" fn(*mut IComponent, i32) -> Tresult,
    get_bus_count: unsafe extern "C" fn(*mut IComponent, i32, i32) -> i32,
    get_bus_info: unsafe extern "C" fn(*mut IComponent, i32, i32, *mut c_void) -> Tresult,
    get_routing_info: unsafe extern "C" fn(*mut IComponent, *mut c_void, *mut c_void) -> Tresult,
    activate_bus: unsafe extern "C" fn(*mut IComponent, i32, i32, i32, i32) -> Tresult,
    set_active: unsafe extern "C" fn(*mut IComponent, i8) -> Tresult,
    set_state: unsafe extern "C" fn(*mut IComponent, *mut c_void) -> Tresult,
    get_state: unsafe extern "C" fn(*mut IComponent, *mut c_void) -> Tresult,
}

#[repr(C)]
struct IEditController {
    vtbl: *const IEditControllerVtbl,
}

#[repr(C)]
struct IEditControllerVtbl {
    query_interface:
        unsafe extern "C" fn(*mut IEditController, *const c_char, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut IEditController) -> u32,
    release: unsafe extern "C" fn(*mut IEditController) -> u32,
    initialize: unsafe extern "C" fn(*mut IEditController, *mut c_void) -> Tresult,
    terminate: unsafe extern "C" fn(*mut IEditController) -> Tresult,
    set_component_state: unsafe extern "C" fn(*mut IEditController, *mut c_void) -> Tresult,
    set_state: unsafe extern "C" fn(*mut IEditController, *mut c_void) -> Tresult,
    get_state: unsafe extern "C" fn(*mut IEditController, *mut c_void) -> Tresult,
    get_parameter_count: unsafe extern "C" fn(*mut IEditController) -> i32,
    get_parameter_info: unsafe extern "C" fn(*mut IEditController, i32, *mut c_void) -> Tresult,
    get_param_string_by_value:
        unsafe extern "C" fn(*mut IEditController, u32, f64, *mut u16) -> Tresult,
    get_param_value_by_string:
        unsafe extern "C" fn(*mut IEditController, u32, *const u16, *mut f64) -> Tresult,
    normalized_param_to_plain: unsafe extern "C" fn(*mut IEditController, u32, f64) -> f64,
    plain_param_to_normalized: unsafe extern "C" fn(*mut IEditController, u32, f64) -> f64,
    get_param_normalized: unsafe extern "C" fn(*mut IEditController, u32) -> f64,
    set_param_normalized: unsafe extern "C" fn(*mut IEditController, u32, f64) -> Tresult,
    set_component_handler: unsafe extern "C" fn(*mut IEditController, *mut c_void) -> Tresult,
    create_view: unsafe extern "C" fn(*mut IEditController, *const c_char) -> *mut c_void,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct ViewRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
struct IPlugView {
    vtbl: *const IPlugViewVtbl,
}

#[repr(C)]
struct IPlugViewVtbl {
    query_interface:
        unsafe extern "C" fn(*mut IPlugView, *const c_char, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut IPlugView) -> u32,
    release: unsafe extern "C" fn(*mut IPlugView) -> u32,
    is_platform_type_supported: unsafe extern "C" fn(*mut IPlugView, *const c_char) -> Tresult,
    attached: unsafe extern "C" fn(*mut IPlugView, *mut c_void, *const c_char) -> Tresult,
    removed: unsafe extern "C" fn(*mut IPlugView) -> Tresult,
    on_wheel: unsafe extern "C" fn(*mut IPlugView, f32) -> Tresult,
    on_key_down: unsafe extern "C" fn(*mut IPlugView, i16, i16, i16) -> Tresult,
    on_key_up: unsafe extern "C" fn(*mut IPlugView, i16, i16, i16) -> Tresult,
    get_size: unsafe extern "C" fn(*mut IPlugView, *mut ViewRect) -> Tresult,
    on_size: unsafe extern "C" fn(*mut IPlugView, *mut ViewRect) -> Tresult,
    on_focus: unsafe extern "C" fn(*mut IPlugView, i8) -> Tresult,
    set_frame: unsafe extern "C" fn(*mut IPlugView, *mut c_void) -> Tresult,
    can_resize: unsafe extern "C" fn(*mut IPlugView) -> Tresult,
    check_size_constraint: unsafe extern "C" fn(*mut IPlugView, *mut ViewRect) -> Tresult,
}

#[repr(C)]
struct ProcessSetup {
    process_mode: i32,
    symbolic_sample_size: i32,
    max_samples_per_block: i32,
    sample_rate: f64,
}

#[repr(C)]
struct AudioBusBuffers {
    num_channels: i32,
    silence_flags: u64,
    channel_buffers32: *mut *mut f32,
    channel_buffers64: *mut *mut f64,
}

#[repr(C)]
struct ProcessData {
    process_mode: i32,
    symbolic_sample_size: i32,
    num_samples: i32,
    num_inputs: i32,
    num_outputs: i32,
    inputs: *mut AudioBusBuffers,
    outputs: *mut AudioBusBuffers,
    input_parameter_changes: *mut c_void,
    output_parameter_changes: *mut c_void,
    input_events: *mut c_void,
    output_events: *mut c_void,
    process_context: *mut c_void,
}

const MAX_HOST_PARAM_CHANGES: usize = 256;

#[repr(C)]
#[derive(Clone, Copy)]
struct IParamValueQueue {
    vtbl: *const IParamValueQueueVtbl,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct IParamValueQueueVtbl {
    query_interface:
        unsafe extern "C" fn(*mut IParamValueQueue, *const c_char, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut IParamValueQueue) -> u32,
    release: unsafe extern "C" fn(*mut IParamValueQueue) -> u32,
    get_parameter_id: unsafe extern "C" fn(*mut IParamValueQueue) -> u32,
    get_point_count: unsafe extern "C" fn(*mut IParamValueQueue) -> i32,
    get_point: unsafe extern "C" fn(*mut IParamValueQueue, i32, *mut i32, *mut f64) -> Tresult,
    add_point: unsafe extern "C" fn(*mut IParamValueQueue, i32, f64, *mut i32) -> Tresult,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct IParameterChanges {
    vtbl: *const IParameterChangesVtbl,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct IParameterChangesVtbl {
    query_interface:
        unsafe extern "C" fn(*mut IParameterChanges, *const c_char, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut IParameterChanges) -> u32,
    release: unsafe extern "C" fn(*mut IParameterChanges) -> u32,
    get_parameter_count: unsafe extern "C" fn(*mut IParameterChanges) -> i32,
    get_parameter_data: unsafe extern "C" fn(*mut IParameterChanges, i32) -> *mut IParamValueQueue,
    add_parameter_data:
        unsafe extern "C" fn(*mut IParameterChanges, *mut u32, *mut i32) -> *mut IParamValueQueue,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct HostParamValueQueue {
    vtbl: *const IParamValueQueueVtbl,
    ref_count: u32,
    param_id: u32,
    sample_offset: i32,
    value: f64,
    has_point: i32,
}

impl HostParamValueQueue {
    const fn empty() -> Self {
        Self {
            vtbl: &HOST_PARAM_VALUE_QUEUE_VTBL,
            ref_count: 1,
            param_id: 0,
            sample_offset: 0,
            value: 0.0,
            has_point: 0,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct HostParameterChanges {
    vtbl: *const IParameterChangesVtbl,
    ref_count: u32,
    queue_count: i32,
    queues: [HostParamValueQueue; MAX_HOST_PARAM_CHANGES],
}

impl HostParameterChanges {
    fn from_pending(changes: &[(u32, f64)]) -> Self {
        let mut this = Self {
            vtbl: &HOST_PARAMETER_CHANGES_VTBL,
            ref_count: 1,
            queue_count: 0,
            queues: [HostParamValueQueue::empty(); MAX_HOST_PARAM_CHANGES],
        };
        for (slot, (param_id, value)) in changes.iter().take(MAX_HOST_PARAM_CHANGES).enumerate() {
            this.queues[slot].param_id = *param_id;
            this.queues[slot].sample_offset = 0;
            this.queues[slot].value = value.clamp(0.0, 1.0);
            this.queues[slot].has_point = 1;
            this.queue_count += 1;
        }
        this
    }
}

unsafe extern "C" fn host_param_queue_query_interface(
    _this: *mut IParamValueQueue,
    _iid: *const c_char,
    obj: *mut *mut c_void,
) -> Tresult {
    if !obj.is_null() {
        unsafe {
            *obj = ptr::null_mut();
        }
    }
    K_NO_INTERFACE
}

unsafe extern "C" fn host_param_queue_add_ref(this: *mut IParamValueQueue) -> u32 {
    if this.is_null() {
        return 1;
    }
    let queue = unsafe { &mut *(this as *mut HostParamValueQueue) };
    queue.ref_count = queue.ref_count.saturating_add(1);
    queue.ref_count
}

unsafe extern "C" fn host_param_queue_release(this: *mut IParamValueQueue) -> u32 {
    if this.is_null() {
        return 1;
    }
    let queue = unsafe { &mut *(this as *mut HostParamValueQueue) };
    queue.ref_count = queue.ref_count.saturating_sub(1);
    queue.ref_count
}

unsafe extern "C" fn host_param_queue_get_parameter_id(this: *mut IParamValueQueue) -> u32 {
    if this.is_null() {
        return 0;
    }
    let queue = unsafe { &*(this as *mut HostParamValueQueue) };
    queue.param_id
}

unsafe extern "C" fn host_param_queue_get_point_count(this: *mut IParamValueQueue) -> i32 {
    if this.is_null() {
        return 0;
    }
    let queue = unsafe { &*(this as *mut HostParamValueQueue) };
    queue.has_point
}

unsafe extern "C" fn host_param_queue_get_point(
    this: *mut IParamValueQueue,
    index: i32,
    sample_offset: *mut i32,
    value: *mut f64,
) -> Tresult {
    if this.is_null() || sample_offset.is_null() || value.is_null() || index != 0 {
        return K_RESULT_FALSE;
    }
    let queue = unsafe { &*(this as *mut HostParamValueQueue) };
    if queue.has_point <= 0 {
        return K_RESULT_FALSE;
    }
    unsafe {
        *sample_offset = queue.sample_offset;
        *value = queue.value;
    }
    K_RESULT_OK
}

unsafe extern "C" fn host_param_queue_add_point(
    this: *mut IParamValueQueue,
    sample_offset: i32,
    value: f64,
    index: *mut i32,
) -> Tresult {
    if this.is_null() {
        return K_RESULT_FALSE;
    }
    let queue = unsafe { &mut *(this as *mut HostParamValueQueue) };
    queue.sample_offset = sample_offset;
    queue.value = value.clamp(0.0, 1.0);
    queue.has_point = 1;
    if !index.is_null() {
        unsafe {
            *index = 0;
        }
    }
    K_RESULT_OK
}

unsafe extern "C" fn host_param_changes_query_interface(
    _this: *mut IParameterChanges,
    _iid: *const c_char,
    obj: *mut *mut c_void,
) -> Tresult {
    if !obj.is_null() {
        unsafe {
            *obj = ptr::null_mut();
        }
    }
    K_NO_INTERFACE
}

unsafe extern "C" fn host_param_changes_add_ref(this: *mut IParameterChanges) -> u32 {
    if this.is_null() {
        return 1;
    }
    let changes = unsafe { &mut *(this as *mut HostParameterChanges) };
    changes.ref_count = changes.ref_count.saturating_add(1);
    changes.ref_count
}

unsafe extern "C" fn host_param_changes_release(this: *mut IParameterChanges) -> u32 {
    if this.is_null() {
        return 1;
    }
    let changes = unsafe { &mut *(this as *mut HostParameterChanges) };
    changes.ref_count = changes.ref_count.saturating_sub(1);
    changes.ref_count
}

unsafe extern "C" fn host_param_changes_get_parameter_count(this: *mut IParameterChanges) -> i32 {
    if this.is_null() {
        return 0;
    }
    let changes = unsafe { &*(this as *mut HostParameterChanges) };
    changes.queue_count
}

unsafe extern "C" fn host_param_changes_get_parameter_data(
    this: *mut IParameterChanges,
    index: i32,
) -> *mut IParamValueQueue {
    if this.is_null() || index < 0 {
        return ptr::null_mut();
    }
    let changes = unsafe { &mut *(this as *mut HostParameterChanges) };
    let idx = index as usize;
    if idx >= changes.queue_count as usize || idx >= MAX_HOST_PARAM_CHANGES {
        return ptr::null_mut();
    }
    (&mut changes.queues[idx] as *mut HostParamValueQueue).cast::<IParamValueQueue>()
}

unsafe extern "C" fn host_param_changes_add_parameter_data(
    this: *mut IParameterChanges,
    id: *mut u32,
    index: *mut i32,
) -> *mut IParamValueQueue {
    if this.is_null() {
        return ptr::null_mut();
    }
    let changes = unsafe { &mut *(this as *mut HostParameterChanges) };
    if changes.queue_count as usize >= MAX_HOST_PARAM_CHANGES {
        if !index.is_null() {
            unsafe {
                *index = -1;
            }
        }
        return ptr::null_mut();
    }
    let slot = changes.queue_count as usize;
    changes.queue_count += 1;
    let param_id = if id.is_null() { 0 } else { unsafe { *id } };
    changes.queues[slot].param_id = param_id;
    changes.queues[slot].sample_offset = 0;
    changes.queues[slot].value = 0.0;
    changes.queues[slot].has_point = 0;
    if !index.is_null() {
        unsafe {
            *index = slot as i32;
        }
    }
    (&mut changes.queues[slot] as *mut HostParamValueQueue).cast::<IParamValueQueue>()
}

static HOST_PARAM_VALUE_QUEUE_VTBL: IParamValueQueueVtbl = IParamValueQueueVtbl {
    query_interface: host_param_queue_query_interface,
    add_ref: host_param_queue_add_ref,
    release: host_param_queue_release,
    get_parameter_id: host_param_queue_get_parameter_id,
    get_point_count: host_param_queue_get_point_count,
    get_point: host_param_queue_get_point,
    add_point: host_param_queue_add_point,
};

static HOST_PARAMETER_CHANGES_VTBL: IParameterChangesVtbl = IParameterChangesVtbl {
    query_interface: host_param_changes_query_interface,
    add_ref: host_param_changes_add_ref,
    release: host_param_changes_release,
    get_parameter_count: host_param_changes_get_parameter_count,
    get_parameter_data: host_param_changes_get_parameter_data,
    add_parameter_data: host_param_changes_add_parameter_data,
};

// ── VST3 IEventList (MIDI Event Delivery) ──────────────────────────────
//
// Pre-allocated COM object that delivers MIDI events to the plugin via
// ProcessData::inputEvents. Zero-allocation on the audio thread.
//
// VST3 event types: NoteOn (0), NoteOff (1), Data (2), PolyPressure (3),
// NoteExpressionValue (4), NoteExpressionText (5), Chord (6), Scale (7),
// LegacyMIDICCOut (65535).

/// Maximum MIDI events per process() call.
const MAX_INPUT_EVENTS: usize = 512;

/// VST3 Event type IDs.
const K_NOTE_ON_EVENT: u16 = 0;
const K_NOTE_OFF_EVENT: u16 = 1;


/// C-ABI struct matching `Steinberg::Vst::Event`.
///
/// Layout must match the SDK exactly:
///   - bus_index (i32)
///   - sample_offset (i32)
///   - ppq_position (f64)
///   - flags (u16)
///   - type (u16)
///   - union payload (variable, but we use EVENT_UNION_SIZE bytes)
#[repr(C)]
#[derive(Clone, Copy)]
struct Vst3Event {
    bus_index: i32,
    sample_offset: i32,
    ppq_position: f64,
    flags: u16,
    event_type: u16,
    /// Union payload — covers NoteOnEvent, NoteOffEvent, etc.
    /// NoteOnEvent layout: channel(i16) + pitch(i16) + tuning(f32) + velocity(f32) + length(i32) + noteId(i32) = 20 bytes
    /// We use 20 bytes to cover NoteOn (the largest common event).
    event_data: [u8; 20],
}

impl Vst3Event {
    const fn zeroed() -> Self {
        Self {
            bus_index: 0,
            sample_offset: 0,
            ppq_position: 0.0,
            flags: 0,
            event_type: 0,
            event_data: [0; 20],
        }
    }

    /// Creates a VST3 NoteOn event from a MidiEvent.
    fn from_note_on(midi: &crate::instance::MidiEvent) -> Self {
        let mut ev = Self::zeroed();
        ev.sample_offset = midi.sample_offset;
        ev.event_type = K_NOTE_ON_EVENT;
        ev.flags = 1; // kIsLive

        // NoteOnEvent layout: channel(i16), pitch(i16), tuning(f32), velocity(f32), length(i32), noteId(i32)
        let channel = (midi.channel & 0x0F) as i16;
        let pitch = midi.data[1] as i16;
        let velocity = midi.data[2] as f32 / 127.0;

        // Write fields into event_data as little-endian bytes
        ev.event_data[0..2].copy_from_slice(&channel.to_ne_bytes());
        ev.event_data[2..4].copy_from_slice(&pitch.to_ne_bytes());
        ev.event_data[4..8].copy_from_slice(&0.0_f32.to_ne_bytes()); // tuning
        ev.event_data[8..12].copy_from_slice(&velocity.to_ne_bytes());
        ev.event_data[12..16].copy_from_slice(&0_i32.to_ne_bytes()); // length
        ev.event_data[16..20].copy_from_slice(&(-1_i32).to_ne_bytes()); // noteId = -1 (unassigned)

        ev
    }

    /// Creates a VST3 NoteOff event from a MidiEvent.
    fn from_note_off(midi: &crate::instance::MidiEvent) -> Self {
        let mut ev = Self::zeroed();
        ev.sample_offset = midi.sample_offset;
        ev.event_type = K_NOTE_OFF_EVENT;
        ev.flags = 1; // kIsLive

        // NoteOffEvent layout: channel(i16), pitch(i16), tuning(f32), velocity(f32), noteId(i32)
        let channel = (midi.channel & 0x0F) as i16;
        let pitch = midi.data[1] as i16;
        let velocity = midi.data[2] as f32 / 127.0;

        ev.event_data[0..2].copy_from_slice(&channel.to_ne_bytes());
        ev.event_data[2..4].copy_from_slice(&pitch.to_ne_bytes());
        ev.event_data[4..8].copy_from_slice(&0.0_f32.to_ne_bytes()); // tuning
        ev.event_data[8..12].copy_from_slice(&velocity.to_ne_bytes());
        ev.event_data[12..16].copy_from_slice(&(-1_i32).to_ne_bytes()); // noteId = -1

        ev
    }

    /// Converts a format-agnostic MidiEvent into a VST3 Event.
    /// Returns `None` for unsupported MIDI message types (CC, pitch bend, etc.
    /// will be handled in future phases via LegacyMIDICCOut).
    fn from_midi_event(midi: &crate::instance::MidiEvent) -> Option<Self> {
        let status = midi.data[0] & 0xF0;
        match status {
            0x90 if midi.data[2] > 0 => Some(Self::from_note_on(midi)),
            0x90 => Some(Self::from_note_off(midi)), // velocity 0 = note off
            0x80 => Some(Self::from_note_off(midi)),
            // CC, pitch bend, aftertouch will be added as LegacyMIDICCOut events
            // in a future iteration. For now, only note events are critical.
            _ => None,
        }
    }
}

/// COM vtable for IEventList.
#[repr(C)]
struct IEventListVtbl {
    query_interface:
        unsafe extern "C" fn(*mut HostEventList, *const c_char, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut HostEventList) -> u32,
    release: unsafe extern "C" fn(*mut HostEventList) -> u32,
    get_event_count: unsafe extern "C" fn(*mut HostEventList) -> i32,
    get_event: unsafe extern "C" fn(*mut HostEventList, i32, *mut Vst3Event) -> Tresult,
    add_event: unsafe extern "C" fn(*mut HostEventList, *const Vst3Event) -> Tresult,
}

/// Pre-allocated IEventList implementation.
///
/// Holds up to `MAX_INPUT_EVENTS` events in a stack-allocated array.
/// Zero heap allocation on the audio thread.
#[repr(C)]
struct HostEventList {
    vtbl: *const IEventListVtbl,
    ref_count: u32,
    count: i32,
    events: [Vst3Event; MAX_INPUT_EVENTS],
}

impl HostEventList {
    /// Creates an empty event list.
    fn empty() -> Self {
        Self {
            vtbl: &HOST_EVENT_LIST_VTBL,
            ref_count: 1,
            count: 0,
            events: [Vst3Event::zeroed(); MAX_INPUT_EVENTS],
        }
    }

    /// Populates the event list from a slice of format-agnostic MidiEvents.
    ///
    /// Events that cannot be converted to VST3 format are silently skipped.
    /// The list is capped at `MAX_INPUT_EVENTS`.
    fn from_midi_events(midi_events: &[crate::instance::MidiEvent]) -> Self {
        let mut list = Self::empty();
        for midi in midi_events {
            if list.count as usize >= MAX_INPUT_EVENTS {
                break;
            }
            if let Some(vst3_event) = Vst3Event::from_midi_event(midi) {
                list.events[list.count as usize] = vst3_event;
                list.count += 1;
            }
        }
        list
    }
}

unsafe extern "C" fn host_event_list_query_interface(
    _this: *mut HostEventList,
    _iid: *const c_char,
    obj: *mut *mut c_void,
) -> Tresult {
    if !obj.is_null() {
        unsafe {
            *obj = ptr::null_mut();
        }
    }
    K_NO_INTERFACE
}

unsafe extern "C" fn host_event_list_add_ref(this: *mut HostEventList) -> u32 {
    if this.is_null() {
        return 1;
    }
    let list = unsafe { &mut *this };
    list.ref_count = list.ref_count.saturating_add(1);
    list.ref_count
}

unsafe extern "C" fn host_event_list_release(this: *mut HostEventList) -> u32 {
    if this.is_null() {
        return 1;
    }
    let list = unsafe { &mut *this };
    list.ref_count = list.ref_count.saturating_sub(1);
    list.ref_count
}

unsafe extern "C" fn host_event_list_get_event_count(this: *mut HostEventList) -> i32 {
    if this.is_null() {
        return 0;
    }
    let list = unsafe { &*this };
    list.count
}

unsafe extern "C" fn host_event_list_get_event(
    this: *mut HostEventList,
    index: i32,
    event: *mut Vst3Event,
) -> Tresult {
    if this.is_null() || event.is_null() || index < 0 {
        return K_RESULT_FALSE;
    }
    let list = unsafe { &*this };
    if index >= list.count {
        return K_RESULT_FALSE;
    }
    unsafe {
        *event = list.events[index as usize];
    }
    K_RESULT_OK
}

unsafe extern "C" fn host_event_list_add_event(
    this: *mut HostEventList,
    event: *const Vst3Event,
) -> Tresult {
    if this.is_null() || event.is_null() {
        return K_RESULT_FALSE;
    }
    let list = unsafe { &mut *this };
    if list.count as usize >= MAX_INPUT_EVENTS {
        return K_RESULT_FALSE;
    }
    list.events[list.count as usize] = unsafe { *event };
    list.count += 1;
    K_RESULT_OK
}

static HOST_EVENT_LIST_VTBL: IEventListVtbl = IEventListVtbl {
    query_interface: host_event_list_query_interface,
    add_ref: host_event_list_add_ref,
    release: host_event_list_release,
    get_event_count: host_event_list_get_event_count,
    get_event: host_event_list_get_event,
    add_event: host_event_list_add_event,
};

#[repr(C)]
struct IAudioProcessor {
    vtbl: *const IAudioProcessorVtbl,
}

#[repr(C)]
struct IAudioProcessorVtbl {
    query_interface:
        unsafe extern "C" fn(*mut IAudioProcessor, *const c_char, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut IAudioProcessor) -> u32,
    release: unsafe extern "C" fn(*mut IAudioProcessor) -> u32,
    set_bus_arrangements:
        unsafe extern "C" fn(*mut IAudioProcessor, *mut c_void, i32, *mut c_void, i32) -> Tresult,
    get_bus_arrangement:
        unsafe extern "C" fn(*mut IAudioProcessor, i32, i32, *mut c_void) -> Tresult,
    can_process_sample_size: unsafe extern "C" fn(*mut IAudioProcessor, i32) -> Tresult,
    get_latency_samples: unsafe extern "C" fn(*mut IAudioProcessor) -> u32,
    setup_processing: unsafe extern "C" fn(*mut IAudioProcessor, *const ProcessSetup) -> Tresult,
    set_processing: unsafe extern "C" fn(*mut IAudioProcessor, i8) -> Tresult,
    process: unsafe extern "C" fn(*mut IAudioProcessor, *mut ProcessData) -> Tresult,
    get_tail_samples: unsafe extern "C" fn(*mut IAudioProcessor) -> u32,
}

#[repr(C)]
struct IBStream {
    vtbl: *const IBStreamVtbl,
}

#[repr(C)]
struct IBStreamVtbl {
    query_interface:
        unsafe extern "C" fn(*mut IBStream, *const c_char, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut IBStream) -> u32,
    release: unsafe extern "C" fn(*mut IBStream) -> u32,
    read: unsafe extern "C" fn(*mut IBStream, *mut c_void, i32, *mut i32) -> Tresult,
    write: unsafe extern "C" fn(*mut IBStream, *mut c_void, i32, *mut i32) -> Tresult,
    seek: unsafe extern "C" fn(*mut IBStream, i64, i32, *mut i64) -> Tresult,
    tell: unsafe extern "C" fn(*mut IBStream, *mut i64) -> Tresult,
}

#[repr(C)]
struct HostReadStream {
    vtbl: *const IBStreamVtbl,
    ref_count: u32,
    data: Vec<u8>,
    pos: usize,
}

impl HostReadStream {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            vtbl: &HOST_READ_STREAM_VTBL,
            ref_count: 1,
            data: bytes,
            pos: 0,
        }
    }
}

unsafe extern "C" fn stream_query_interface(
    _this: *mut IBStream,
    _iid: *const c_char,
    _obj: *mut *mut c_void,
) -> Tresult {
    K_NO_INTERFACE
}

unsafe extern "C" fn stream_add_ref(this: *mut IBStream) -> u32 {
    let stream = unsafe { &mut *(this as *mut HostReadStream) };
    stream.ref_count = stream.ref_count.saturating_add(1);
    stream.ref_count
}

unsafe extern "C" fn stream_release(this: *mut IBStream) -> u32 {
    let stream = unsafe { &mut *(this as *mut HostReadStream) };
    stream.ref_count = stream.ref_count.saturating_sub(1);
    stream.ref_count
}

unsafe extern "C" fn stream_read(
    this: *mut IBStream,
    buffer: *mut c_void,
    num_bytes: i32,
    num_bytes_read: *mut i32,
) -> Tresult {
    if this.is_null() || buffer.is_null() || num_bytes < 0 {
        return K_RESULT_FALSE;
    }
    let stream = unsafe { &mut *(this as *mut HostReadStream) };
    let requested = num_bytes as usize;
    let remaining = stream.data.len().saturating_sub(stream.pos);
    let to_copy = requested.min(remaining);
    if to_copy > 0 {
        unsafe {
            ptr::copy_nonoverlapping(
                stream.data.as_ptr().add(stream.pos),
                buffer as *mut u8,
                to_copy,
            );
        }
        stream.pos = stream.pos.saturating_add(to_copy);
    }
    if !num_bytes_read.is_null() {
        unsafe {
            *num_bytes_read = to_copy as i32;
        }
    }
    if to_copy == requested {
        K_RESULT_OK
    } else {
        K_RESULT_FALSE
    }
}

unsafe extern "C" fn stream_write(
    _this: *mut IBStream,
    _buffer: *mut c_void,
    _num_bytes: i32,
    num_bytes_written: *mut i32,
) -> Tresult {
    if !num_bytes_written.is_null() {
        unsafe {
            *num_bytes_written = 0;
        }
    }
    K_RESULT_FALSE
}

unsafe extern "C" fn stream_seek(
    this: *mut IBStream,
    pos: i64,
    mode: i32,
    result: *mut i64,
) -> Tresult {
    if this.is_null() {
        return K_RESULT_FALSE;
    }
    let stream = unsafe { &mut *(this as *mut HostReadStream) };
    let len = stream.data.len() as i64;
    let base = match mode {
        K_SEEK_SET => 0_i64,
        K_SEEK_CUR => stream.pos as i64,
        K_SEEK_END => len,
        _ => return K_RESULT_FALSE,
    };
    let mut next = base.saturating_add(pos);
    if next < 0 {
        next = 0;
    }
    if next > len {
        next = len;
    }
    stream.pos = next as usize;
    if !result.is_null() {
        unsafe {
            *result = next;
        }
    }
    K_RESULT_OK
}

unsafe extern "C" fn stream_tell(this: *mut IBStream, result: *mut i64) -> Tresult {
    if this.is_null() || result.is_null() {
        return K_RESULT_FALSE;
    }
    let stream = unsafe { &*(this as *mut HostReadStream) };
    unsafe {
        *result = stream.pos as i64;
    }
    K_RESULT_OK
}

static HOST_READ_STREAM_VTBL: IBStreamVtbl = IBStreamVtbl {
    query_interface: stream_query_interface,
    add_ref: stream_add_ref,
    release: stream_release,
    read: stream_read,
    write: stream_write,
    seek: stream_seek,
    tell: stream_tell,
};

// ── HostWriteStream (IBStream for getState) ────────────────────────────
//
// Writable IBStream that collects plugin state into a `Vec<u8>`. Used by
// `IComponent::getState` and `IEditController::getState` to serialize
// plugin parameters and internal state for session save/restore.

/// Writable IBStream that appends into a `Vec<u8>` buffer.
#[repr(C)]
struct HostWriteStream {
    vtbl: *const IBStreamVtbl,
    ref_count: u32,
    data: Vec<u8>,
    pos: usize,
}

impl HostWriteStream {
    fn new() -> Self {
        Self {
            vtbl: &HOST_WRITE_STREAM_VTBL,
            ref_count: 1,
            data: Vec::with_capacity(8192),
            pos: 0,
        }
    }

    fn into_bytes(self) -> Vec<u8> {
        self.data
    }
}

unsafe extern "C" fn write_stream_query_interface(
    _this: *mut IBStream,
    _iid: *const c_char,
    _obj: *mut *mut c_void,
) -> Tresult {
    K_NO_INTERFACE
}

unsafe extern "C" fn write_stream_add_ref(this: *mut IBStream) -> u32 {
    if this.is_null() { return 0; }
    let stream = unsafe { &mut *(this as *mut HostWriteStream) };
    stream.ref_count += 1;
    stream.ref_count
}

unsafe extern "C" fn write_stream_release(this: *mut IBStream) -> u32 {
    if this.is_null() { return 0; }
    let stream = unsafe { &mut *(this as *mut HostWriteStream) };
    stream.ref_count = stream.ref_count.saturating_sub(1);
    stream.ref_count
}

unsafe extern "C" fn write_stream_read(
    _this: *mut IBStream,
    _buffer: *mut c_void,
    _num_bytes: i32,
    num_bytes_read: *mut i32,
) -> Tresult {
    // Write-only stream — reads are not supported.
    if !num_bytes_read.is_null() {
        unsafe { *num_bytes_read = 0; }
    }
    K_RESULT_NOT_IMPLEMENTED
}

unsafe extern "C" fn write_stream_write(
    this: *mut IBStream,
    buffer: *mut c_void,
    num_bytes: i32,
    num_bytes_written: *mut i32,
) -> Tresult {
    if this.is_null() || buffer.is_null() || num_bytes <= 0 {
        if !num_bytes_written.is_null() {
            unsafe { *num_bytes_written = 0; }
        }
        return K_RESULT_FALSE;
    }
    let stream = unsafe { &mut *(this as *mut HostWriteStream) };
    let count = num_bytes as usize;
    let src = unsafe { std::slice::from_raw_parts(buffer as *const u8, count) };

    // If writing at pos < data.len(), overwrite in place; otherwise extend.
    if stream.pos < stream.data.len() {
        let overwrite_end = (stream.pos + count).min(stream.data.len());
        let overwrite_count = overwrite_end - stream.pos;
        stream.data[stream.pos..overwrite_end].copy_from_slice(&src[..overwrite_count]);
        if count > overwrite_count {
            stream.data.extend_from_slice(&src[overwrite_count..]);
        }
    } else {
        // Pad with zeros if seeking past end
        if stream.pos > stream.data.len() {
            stream.data.resize(stream.pos, 0);
        }
        stream.data.extend_from_slice(src);
    }
    stream.pos += count;

    if !num_bytes_written.is_null() {
        unsafe { *num_bytes_written = num_bytes; }
    }
    K_RESULT_OK
}

unsafe extern "C" fn write_stream_seek(
    this: *mut IBStream,
    pos: i64,
    mode: i32,
    result: *mut i64,
) -> Tresult {
    if this.is_null() {
        return K_RESULT_FALSE;
    }
    let stream = unsafe { &mut *(this as *mut HostWriteStream) };
    let new_pos: i64 = match mode {
        K_SEEK_SET => pos,
        K_SEEK_CUR => stream.pos as i64 + pos,
        K_SEEK_END => stream.data.len() as i64 + pos,
        _ => return K_RESULT_FALSE,
    };
    if new_pos < 0 {
        return K_RESULT_FALSE;
    }
    stream.pos = new_pos as usize;
    if !result.is_null() {
        unsafe { *result = stream.pos as i64; }
    }
    K_RESULT_OK
}

unsafe extern "C" fn write_stream_tell(this: *mut IBStream, result: *mut i64) -> Tresult {
    if this.is_null() || result.is_null() {
        return K_RESULT_FALSE;
    }
    let stream = unsafe { &*(this as *const HostWriteStream) };
    unsafe { *result = stream.pos as i64; }
    K_RESULT_OK
}

static HOST_WRITE_STREAM_VTBL: IBStreamVtbl = IBStreamVtbl {
    query_interface: write_stream_query_interface,
    add_ref: write_stream_add_ref,
    release: write_stream_release,
    read: write_stream_read,
    write: write_stream_write,
    seek: write_stream_seek,
    tell: write_stream_tell,
};

// ── IPlugFrame (Editor Resize Notification) ────────────────────────────
//
// VST3 plugins call IPlugFrame::resizeView when their editor wants to
// change size. We implement this so the host NSWindow resizes accordingly.
// Without this, plugins that dynamically resize (FabFilter, iZotope)
// will have clipped or corrupted GUIs.

/// COM vtable for IPlugFrame.
/// Layout: FUnknown (query_interface, addRef, release) + resizeView.
#[repr(C)]
struct IPlugFrameVtbl {
    query_interface:
        unsafe extern "C" fn(*mut c_void, *const Tuid, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    release: unsafe extern "C" fn(*mut c_void) -> u32,
    resize_view:
        unsafe extern "C" fn(*mut c_void, *mut c_void, *mut ViewRect) -> Tresult,
}

/// Heap-allocated IPlugFrame instance. One per editor window.
/// Stores the NSWindow pointer so `resizeView` can resize it.
#[repr(C)]
struct HostPlugFrame {
    vtbl: *const IPlugFrameVtbl,
    ref_count: u32,
    /// NSWindow pointer (as usize for Send safety; 0 = unset).
    #[cfg(target_os = "macos")]
    window_ptr: usize,
}

// Safety: The `vtbl` field points to a `static` vtable in constant memory.
// The `window_ptr` is stored as `usize` (not a raw pointer), which is already Send.
// HostPlugFrame is only accessed from the UI thread under normal operation.
unsafe impl Send for HostPlugFrame {}

#[cfg(target_os = "macos")]
impl HostPlugFrame {
    fn new(window_ptr: usize) -> Box<Self> {
        Box::new(Self {
            vtbl: &HOST_PLUG_FRAME_VTBL,
            ref_count: 1,
            window_ptr,
        })
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
        }
        return K_RESULT_OK;
    }
    K_NO_INTERFACE
}

unsafe extern "C" fn plug_frame_add_ref(this: *mut c_void) -> u32 {
    if this.is_null() { return 0; }
    let frame = unsafe { &mut *(this as *mut HostPlugFrame) };
    frame.ref_count += 1;
    frame.ref_count
}

unsafe extern "C" fn plug_frame_release(this: *mut c_void) -> u32 {
    if this.is_null() { return 0; }
    let frame = unsafe { &mut *(this as *mut HostPlugFrame) };
    frame.ref_count = frame.ref_count.saturating_sub(1);
    frame.ref_count
}

/// Called by the plugin when it wants to resize its editor view.
/// We resize the host NSWindow to match the requested size.
#[cfg(target_os = "macos")]
unsafe extern "C" fn plug_frame_resize_view(
    this: *mut c_void,
    _view: *mut c_void,
    new_rect: *mut ViewRect,
) -> Tresult {
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
        let current_frame = window.frame();
        // Keep the top-left corner fixed by adjusting origin.y
        let new_origin_y = current_frame.origin.y
            + current_frame.size.height
            - height;
        let new_frame = NSRect::new(
            NSPoint::new(current_frame.origin.x, new_origin_y),
            NSSize::new(width, height),
        );
        window.setFrame_display_(new_frame, true);
    }
    K_RESULT_OK
}

#[cfg(not(target_os = "macos"))]
unsafe extern "C" fn plug_frame_resize_view(
    _this: *mut c_void,
    _view: *mut c_void,
    _new_rect: *mut ViewRect,
) -> Tresult {
    K_RESULT_NOT_IMPLEMENTED
}

static HOST_PLUG_FRAME_VTBL: IPlugFrameVtbl = IPlugFrameVtbl {
    query_interface: plug_frame_query_interface,
    add_ref: plug_frame_add_ref,
    release: plug_frame_release,
    resize_view: plug_frame_resize_view,
};

// ═══════════════════════════════════════════════════════════════════════════
// IComponentHandler — enables plugins to notify host about param changes
// ═══════════════════════════════════════════════════════════════════════════

/// IComponentHandler IID: {93A0BEA3-0BD0-11D5-BF49-00108B531DC3}
const IID_ICOMPONENT_HANDLER: Tuid = [
    0x93, 0xA0, 0xBE, 0xA3, 0x0B, 0xD0, 0x11, 0xD5, 0xBF, 0x49, 0x00, 0x10, 0x8B, 0x53, 0x1D,
    0xC3,
];

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
struct HostComponentHandler {
    vtbl: *const IComponentHandlerVtbl,
}

// Safety: vtbl points to a static constant vtable. Singleton is immutable.
unsafe impl Sync for HostComponentHandler {}

unsafe extern "C" fn comp_handler_query_interface(
    this: *mut c_void,
    iid: *const Tuid,
    obj: *mut *mut c_void,
) -> Tresult {
    if this.is_null() || iid.is_null() || obj.is_null() {
        return K_NO_INTERFACE;
    }
    if tuid_eq(iid, &IID_ICOMPONENT_HANDLER) || tuid_eq(iid, &IID_FUNKNOWN) {
        unsafe { *obj = this; }
        return K_RESULT_OK;
    }
    K_NO_INTERFACE
}

unsafe extern "C" fn comp_handler_add_ref(_this: *mut c_void) -> u32 {
    1 // Singleton — never freed
}

unsafe extern "C" fn comp_handler_release(_this: *mut c_void) -> u32 {
    1 // Singleton — never freed
}

/// Called by plugin when user starts editing a parameter (e.g., mouse down on knob).
unsafe extern "C" fn comp_handler_begin_edit(_this: *mut c_void, id: u32) -> Tresult {
    log::debug!("[IComponentHandler] beginEdit param_id={}", id);
    K_RESULT_OK
}

/// Called by plugin when a parameter value changes during editing.
unsafe extern "C" fn comp_handler_perform_edit(_this: *mut c_void, id: u32, value: f64) -> Tresult {
    log::debug!(
        "[IComponentHandler] performEdit param_id={} value={:.4}",
        id, value
    );
    K_RESULT_OK
}

/// Called by plugin when user finishes editing a parameter (e.g., mouse up).
unsafe extern "C" fn comp_handler_end_edit(_this: *mut c_void, id: u32) -> Tresult {
    log::debug!("[IComponentHandler] endEdit param_id={}", id);
    K_RESULT_OK
}

/// Called by plugin to request host restart (e.g., latency changed, I/O changed).
unsafe extern "C" fn comp_handler_restart_component(_this: *mut c_void, flags: i32) -> Tresult {
    info!(
        "[IComponentHandler] restartComponent flags=0x{:08x}",
        flags
    );
    K_RESULT_OK
}

static HOST_COMPONENT_HANDLER_VTBL: IComponentHandlerVtbl = IComponentHandlerVtbl {
    query_interface: comp_handler_query_interface,
    add_ref: comp_handler_add_ref,
    release: comp_handler_release,
    begin_edit: comp_handler_begin_edit,
    perform_edit: comp_handler_perform_edit,
    end_edit: comp_handler_end_edit,
    restart_component: comp_handler_restart_component,
};

static HOST_COMPONENT_HANDLER: HostComponentHandler = HostComponentHandler {
    vtbl: &HOST_COMPONENT_HANDLER_VTBL,
};

/// Returns a raw pointer to the singleton IComponentHandler.
fn component_handler_ptr() -> *mut c_void {
    &HOST_COMPONENT_HANDLER as *const HostComponentHandler as *mut c_void
}

/// VST3 bus media type constants.
const K_AUDIO: i32 = 0;
/// VST3 bus direction constants.
const K_INPUT: i32 = 0;
#[allow(dead_code)]
const K_OUTPUT: i32 = 1;

/// VST3 speaker arrangement: stereo = L | R.
const K_SPEAKER_STEREO: u64 = 0x03; // kSpeakerL | kSpeakerR

// ── VST3 Bundle Resolution ────────────────────────────────────────────

/// Resolves the native binary path inside a VST3 bundle.
///
/// VST3 bundles on macOS are structured as:
/// ```text
/// MyPlugin.vst3/
/// └── Contents/
///     ├── Info.plist
///     ├── MacOS/
///     │   └── MyPlugin       ← native dylib
///     └── Resources/
///         └── moduleinfo.json
/// ```
///
/// On Linux, the structure uses `x86_64-linux/` subdirectory.
fn resolve_vst3_binary(bundle_path: &Path) -> Option<PathBuf> {
    let stem = bundle_path.file_stem()?.to_str()?;

    // macOS: Contents/MacOS/<stem>
    #[cfg(target_os = "macos")]
    {
        let binary = bundle_path.join("Contents").join("MacOS").join(stem);
        if binary.exists() {
            return Some(binary);
        }

        // Fallback: some vendors ship a different executable name than bundle stem.
        // Prefer likely matches by stem, then any executable file.
        let macos_dir = bundle_path.join("Contents").join("MacOS");
        if let Ok(entries) = std::fs::read_dir(&macos_dir) {
            let mut files: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .collect();
            files.sort();

            let stem_lower = stem.to_ascii_lowercase();
            if let Some(p) = files.iter().find(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.eq_ignore_ascii_case(stem))
                    .unwrap_or(false)
            }) {
                return Some(p.clone());
            }
            if let Some(p) = files.iter().find(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.to_ascii_lowercase().starts_with(&stem_lower))
                    .unwrap_or(false)
            }) {
                return Some(p.clone());
            }

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(p) = files.iter().find(|p| {
                    std::fs::metadata(p)
                        .map(|m| (m.permissions().mode() & 0o111) != 0)
                        .unwrap_or(false)
                }) {
                    return Some(p.clone());
                }
            }

            if let Some(p) = files.first() {
                return Some(p.clone());
            }
        }
    }

    // Linux: Contents/x86_64-linux/<stem>.so
    #[cfg(target_os = "linux")]
    {
        let binary = bundle_path
            .join("Contents")
            .join("x86_64-linux")
            .join(format!("{stem}.so"));
        if binary.exists() {
            return Some(binary);
        }
    }

    // Windows: Contents/x86_64-win/<stem>.vst3
    #[cfg(target_os = "windows")]
    {
        let binary = bundle_path
            .join("Contents")
            .join("x86_64-win")
            .join(format!("{stem}.vst3"));
        if binary.exists() {
            return Some(binary);
        }
    }

    None
}

// ── VST3 Instance ─────────────────────────────────────────────────────

/// A loaded VST3 plugin instance.
///
/// Wraps the native library handle and manages the lifecycle of:
///   - `IPluginFactory` (COM factory for creating components)
///   - `IComponent` (the plugin's main component)
///   - `IAudioProcessor` (the audio processing interface)
///
/// # Safety
/// The native library must remain loaded for the entire lifetime of
/// the instance. Drop order is critical: interfaces first, then library.
pub struct Vst3Instance {
    /// Unique instance ID.
    id: Uuid,

    /// Plugin descriptor (static metadata).
    descriptor: PluginDescriptor,

    /// Handle to the loaded native library.
    /// Kept alive to prevent the dylib from being unloaded.
    _library: Option<libloading::Library>,

    /// Whether the plugin has been activated.
    is_active: bool,

    /// Current sample rate (set during activation).
    sample_rate: f64,

    /// Maximum buffer size (set during activation).
    max_buffer_size: usize,

    /// Plugin's reported processing latency in samples.
    latency: u32,

    /// Whether the plugin editor window is currently open.
    editor_open: bool,

    /// Pre-allocated scratch buffer for VST3 interleaved→planar conversion.
    scratch_left: Vec<f32>,
    scratch_right: Vec<f32>,
    scratch_sidechain_left: Vec<f32>,
    scratch_sidechain_right: Vec<f32>,

    /// Optional native DSP bridge symbol for block processing.
    process_fn: Option<DreamDawProcessF32Fn>,

    /// Optional native editor bridge symbol.
    open_editor_fn: Option<DreamDawOpenEditorFn>,

    /// Optional native bridge symbol for parameter writes.
    set_parameter_fn: Option<DreamDawSetParameterFn>,

    /// Raw COM pointers (stored as address to keep struct `Send`).
    factory_ptr: usize,
    component_ptr: usize,
    processor_ptr: usize,
    controller_ptr: usize,
    com_initialized: bool,

    #[cfg(target_os = "macos")]
    editor_window: Option<MacEditorWindow>,

    /// Heap-allocated IPlugFrame for editor resize notifications.
    /// Kept alive while the editor window is open.
    #[cfg(target_os = "macos")]
    plug_frame: Option<Box<HostPlugFrame>>,

    /// Number of audio input buses detected from the plugin's IComponent.
    audio_input_bus_count: i32,
    /// Number of audio output buses detected from the plugin's IComponent.
    audio_output_bus_count: i32,

    /// Cached transport context (set before each process() call).
    /// Updated via set_transport_context() — zero-alloc Copy struct.
    transport_ctx: TransportContext,

    /// Pending normalized parameter writes (param_id/index, value 0..1).
    pending_param_changes: Vec<(u32, f64)>,

    /// Best-known normalized parameter values for UI readback.
    parameter_values: HashMap<u32, f64>,

    /// Best-known external parameter count hint.
    parameter_count_hint: u32,
}

#[cfg(target_os = "macos")]
struct MacEditorWindow {
    window: usize,
    _content_view: usize,
    plug_view: usize,
}

impl Drop for Vst3Instance {
    fn drop(&mut self) {
        let _ = self.close_editor();

        if self.processor_ptr != 0 {
            let processor = self.processor_ptr as *mut IAudioProcessor;
            unsafe {
                ((*(*processor).vtbl).set_processing)(processor, 0);
                ((*(*processor).vtbl).release)(processor);
            }
            self.processor_ptr = 0;
        }

        if self.component_ptr != 0 {
            let component = self.component_ptr as *mut IComponent;
            unsafe {
                ((*(*component).vtbl).set_active)(component, 0);
                ((*(*component).vtbl).terminate)(component);
                ((*(*component).vtbl).release)(component);
            }
            self.component_ptr = 0;
        }

        if self.controller_ptr != 0 {
            let controller = self.controller_ptr as *mut IEditController;
            unsafe {
                let _ = ((*(*controller).vtbl).terminate)(controller);
                ((*(*controller).vtbl).release)(controller);
            }
            self.controller_ptr = 0;
        }

        if self.factory_ptr != 0 {
            let factory = self.factory_ptr as *mut IPluginFactory;
            unsafe {
                ((*(*factory).vtbl).release)(factory);
            }
            self.factory_ptr = 0;
        }
    }
}

impl Vst3Instance {
    fn init_vst3_com(
        library: &libloading::Library,
    ) -> Result<(usize, usize, usize, usize), PluginError> {
        let get_factory: libloading::Symbol<unsafe extern "C" fn() -> *mut c_void> = unsafe {
            library.get(b"GetPluginFactory\0").map_err(|e| {
                PluginError::LoadFailed(format!("GetPluginFactory symbol lookup failed: {e}"))
            })?
        };

        let factory = unsafe { get_factory() as *mut IPluginFactory };
        if factory.is_null() {
            return Err(PluginError::LoadFailed(
                "GetPluginFactory returned null".to_string(),
            ));
        }

        let mut processor_ptr: *mut c_void = ptr::null_mut();
        let mut component_ptr: *mut c_void = ptr::null_mut();

        let count = unsafe { ((*(*factory).vtbl).count_classes)(factory) }.max(0);
        for idx in 0..count {
            let mut cls = PClassInfo {
                cid: [0; 16],
                cardinality: 0,
                category: [0; 32],
                name: [0; 64],
            };
            let class_ok = unsafe { ((*(*factory).vtbl).get_class_info)(factory, idx, &mut cls) }
                == K_RESULT_OK;
            if !class_ok {
                continue;
            }

            let proc_ok = unsafe {
                ((*(*factory).vtbl).create_instance)(
                    factory,
                    &cls.cid,
                    IID_IAUDIO_PROCESSOR.as_ptr() as *const c_char,
                    &mut processor_ptr,
                )
            } == K_RESULT_OK
                && !processor_ptr.is_null();
            if !proc_ok {
                continue;
            }

            let comp_ok = unsafe {
                ((*(*factory).vtbl).create_instance)(
                    factory,
                    &cls.cid,
                    IID_ICOMPONENT.as_ptr() as *const c_char,
                    &mut component_ptr,
                )
            } == K_RESULT_OK
                && !component_ptr.is_null();

            if !comp_ok {
                component_ptr = ptr::null_mut();
            }
            break;
        }

        if processor_ptr.is_null() {
            unsafe {
                ((*(*factory).vtbl).release)(factory);
            }
            return Err(PluginError::LoadFailed(
                "Failed to instantiate VST3 IAudioProcessor".to_string(),
            ));
        }

        let mut controller_ptr: *mut c_void = ptr::null_mut();
        if !component_ptr.is_null() {
            let component = component_ptr as *mut IComponent;

            // VST3 spec: IComponent::initialize() MUST be called before
            // getControllerClassId(). Without this, many plugins (Serum2,
            // FabFilter, Kontakt, etc.) return kNotImplemented because
            // their internal state is not yet configured.
            unsafe {
                let _ = ((*(*component).vtbl).initialize)(component, host_application_ptr());
            }

            let mut controller_cid: Tuid = [0; 16];
            let cid_ok = unsafe {
                ((*(*component).vtbl).get_controller_class_id)(component, &mut controller_cid)
            } == K_RESULT_OK;
            if cid_ok {
                let _ = unsafe {
                    ((*(*factory).vtbl).create_instance)(
                        factory,
                        &controller_cid,
                        IID_IEDIT_CONTROLLER.as_ptr() as *const c_char,
                        &mut controller_ptr,
                    )
                };
            }

            // Single-component fallback: many VST3 plugins implement both
            // IComponent and IEditController in the same class. If we
            // couldn't create a separate controller, query the component
            // itself for the IEditController interface.
            if controller_ptr.is_null() {
                let _ = unsafe {
                    ((*(*component).vtbl).query_interface)(
                        component,
                        IID_IEDIT_CONTROLLER.as_ptr() as *const c_char,
                        &mut controller_ptr,
                    )
                };
            }
        }

        Ok((
            factory as usize,
            component_ptr as usize,
            processor_ptr as usize,
            controller_ptr as usize,
        ))
    }

    #[cfg(target_os = "macos")]
    fn open_editor_macos(&mut self) -> Result<(), PluginError> {
        if self.editor_window.is_some() {
            return Ok(());
        }
        if self.controller_ptr == 0 {
            return Err(PluginError::UnsupportedFormat(
                "VST3 edit controller is unavailable for this plugin".to_string(),
            ));
        }

        let controller = self.controller_ptr as *mut IEditController;
        let view_raw = unsafe {
            ((*(*controller).vtbl).create_view)(controller, b"editor\0".as_ptr() as *const c_char)
        };
        if view_raw.is_null() {
            return Err(PluginError::UnsupportedFormat(
                "Plugin did not provide an editor view".to_string(),
            ));
        }
        let plug_view = view_raw as *mut IPlugView;

        let nsview_supported = unsafe {
            ((*(*plug_view).vtbl).is_platform_type_supported)(
                plug_view,
                b"NSView\0".as_ptr() as *const c_char,
            )
        } == K_RESULT_OK;
        if !nsview_supported {
            unsafe {
                let _ = ((*(*plug_view).vtbl).release)(plug_view);
            }
            return Err(PluginError::UnsupportedFormat(
                "Plugin editor does not support NSView embedding on macOS".to_string(),
            ));
        }

        unsafe {
            let app = NSApp();
            app.setActivationPolicy_(NSApplicationActivationPolicyRegular);

            let mut rect = ViewRect {
                left: 0,
                top: 0,
                right: 920,
                bottom: 640,
            };
            let _ = ((*(*plug_view).vtbl).get_size)(plug_view, &mut rect);
            let width = (rect.right - rect.left).max(420) as f64;
            let height = (rect.bottom - rect.top).max(300) as f64;

            let frame = NSRect::new(NSPoint::new(180.0, 180.0), NSSize::new(width, height));
            let style = NSWindowStyleMask::NSTitledWindowMask
                | NSWindowStyleMask::NSClosableWindowMask
                | NSWindowStyleMask::NSMiniaturizableWindowMask
                | NSWindowStyleMask::NSResizableWindowMask;

            let window = NSWindow::alloc(nil).initWithContentRect_styleMask_backing_defer_(
                frame,
                style,
                NSBackingStoreType::NSBackingStoreBuffered,
                NO,
            );
            if window == nil {
                let _ = ((*(*plug_view).vtbl).release)(plug_view);
                return Err(PluginError::InvalidState(
                    "Failed to allocate macOS editor window".to_string(),
                ));
            }

            let content_view = window.contentView();
            if content_view == nil {
                let _ = ((*(*plug_view).vtbl).release)(plug_view);
                window.close();
                return Err(PluginError::InvalidState(
                    "Failed to acquire editor content view".to_string(),
                ));
            }

            let attached = ((*(*plug_view).vtbl).attached)(
                plug_view,
                content_view as *mut c_void,
                b"NSView\0".as_ptr() as *const c_char,
            );
            if attached != K_RESULT_OK {
                let _ = ((*(*plug_view).vtbl).release)(plug_view);
                window.close();
                return Err(PluginError::ProcessError(format!(
                    "Plugin editor attach failed with code {attached}"
                )));
            }

            // ── Wire IPlugFrame for editor resize notifications ──
            let mut frame_box = HostPlugFrame::new(window as usize);
            let frame_ptr = (&mut *frame_box as *mut HostPlugFrame).cast::<c_void>();
            let _ = ((*(*plug_view).vtbl).set_frame)(plug_view, frame_ptr);
            self.plug_frame = Some(frame_box);

            window.makeKeyAndOrderFront_(nil);
            app.activateIgnoringOtherApps_(true);

            self.editor_window = Some(MacEditorWindow {
                window: window as usize,
                _content_view: content_view as usize,
                plug_view: plug_view as usize,
            });
        }

        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn close_editor_macos(&mut self) -> Result<(), PluginError> {
        let Some(window_state) = self.editor_window.take() else {
            return Ok(());
        };
        // Release IPlugFrame before detaching the view
        self.plug_frame.take();
        let window = window_state.window as id;
        let plug_view = window_state.plug_view as *mut IPlugView;
        unsafe {
            let _ = ((*(*plug_view).vtbl).removed)(plug_view);
            let _ = ((*(*plug_view).vtbl).release)(plug_view);
            window.close();
        }
        Ok(())
    }

    /// Loads a VST3 plugin from a bundle path.
    ///
    /// This performs:
    /// 1. Bundle resolution (finds the native binary).
    /// 2. Dynamic library loading via `libloading`.
    /// 3. Factory symbol lookup (`GetPluginFactory`).
    /// 4. Component instantiation via COM.
    ///
    /// # Errors
    /// Returns `PluginError::LoadFailed` if:
    /// - The bundle path doesn't contain a valid binary.
    /// - The dylib cannot be loaded.
    /// - The factory symbol is not found.
    pub fn load(descriptor: PluginDescriptor) -> Result<Self, PluginError> {
        if descriptor.format != PluginFormat::VST3 {
            return Err(PluginError::UnsupportedFormat(format!(
                "Expected VST3, got {}",
                descriptor.format
            )));
        }

        let bundle_path = &descriptor.path;
        let binary_path = resolve_vst3_binary(bundle_path).ok_or_else(|| {
            PluginError::LoadFailed(format!(
                "Cannot find native binary in VST3 bundle: {}",
                bundle_path.display()
            ))
        })?;

        info!(
            "[VST3] Loading binary: {} for plugin: {}",
            binary_path.display(),
            descriptor.name
        );

        // Load the native dynamic library
        let library = unsafe {
            libloading::Library::new(&binary_path).map_err(|e| {
                PluginError::LoadFailed(format!("Failed to load {}: {e}", binary_path.display()))
            })?
        };

        // Attempt real VST3 COM bootstrap.
        let (factory_ptr, component_ptr, processor_ptr, controller_ptr) =
            match Self::init_vst3_com(&library) {
                Ok(ptrs) => ptrs,
                Err(err) => {
                    info!(
                        "[VST3] COM bootstrap failed for '{}': {}. Using bridge/fallback path.",
                        descriptor.name, err
                    );
                    (0, 0, 0, 0)
                }
            };

        let process_fn = unsafe {
            library
                .get::<DreamDawProcessF32Fn>(b"dream_daw_process_f32\0")
                .ok()
                .map(|f| *f)
        };
        let open_editor_fn = unsafe {
            library
                .get::<DreamDawOpenEditorFn>(b"dream_daw_open_editor\0")
                .ok()
                .map(|f| *f)
        };
        let set_parameter_fn = unsafe {
            library
                .get::<DreamDawSetParameterFn>(b"dream_daw_set_parameter\0")
                .ok()
                .map(|f| *f)
        };

        info!(
            "[VST3] Successfully loaded: {} ({})",
            descriptor.name, descriptor.vendor
        );
        if process_fn.is_none() {
            info!(
                "[VST3] '{}' loaded without dream_daw_process_f32 symbol (pass-through fallback)",
                descriptor.name
            );
        }

        Ok(Self {
            id: Uuid::new_v4(),
            descriptor,
            _library: Some(library),
            is_active: false,
            sample_rate: 44100.0,
            max_buffer_size: 0,
            latency: 0,
            editor_open: false,
            scratch_left: Vec::new(),
            scratch_right: Vec::new(),
            scratch_sidechain_left: Vec::new(),
            scratch_sidechain_right: Vec::new(),
            process_fn,
            open_editor_fn,
            set_parameter_fn,
            factory_ptr,
            component_ptr,
            processor_ptr,
            controller_ptr,
            com_initialized: false,
            #[cfg(target_os = "macos")]
            editor_window: None,
            #[cfg(target_os = "macos")]
            plug_frame: None,
            audio_input_bus_count: 0,
            audio_output_bus_count: 0,
            transport_ctx: TransportContext::default(),
            pending_param_changes: Vec::new(),
            parameter_values: HashMap::new(),
            parameter_count_hint: 0,
        })
    }

    /// Creates a stub instance for testing (no real plugin loaded).
    #[cfg(test)]
    pub fn stub(descriptor: PluginDescriptor, latency: u32) -> Self {
        Self {
            id: Uuid::new_v4(),
            descriptor,
            _library: None,
            is_active: false,
            sample_rate: 44100.0,
            max_buffer_size: 0,
            latency,
            editor_open: false,
            scratch_left: Vec::new(),
            scratch_right: Vec::new(),
            scratch_sidechain_left: Vec::new(),
            scratch_sidechain_right: Vec::new(),
            process_fn: None,
            open_editor_fn: None,
            set_parameter_fn: None,
            factory_ptr: 0,
            component_ptr: 0,
            processor_ptr: 0,
            controller_ptr: 0,
            com_initialized: false,
            #[cfg(target_os = "macos")]
            editor_window: None,
            #[cfg(target_os = "macos")]
            plug_frame: None,
            audio_input_bus_count: 0,
            audio_output_bus_count: 0,
            transport_ctx: TransportContext::default(),
            pending_param_changes: Vec::new(),
            parameter_values: HashMap::new(),
            parameter_count_hint: 0,
        }
    }
}

#[inline]
fn passthrough(inputs: &[&[f32]], outputs: &mut [&mut [f32]], num_frames: usize) {
    let channels = inputs.len().min(outputs.len());
    for ch in 0..channels {
        let n = num_frames.min(inputs[ch].len()).min(outputs[ch].len());
        outputs[ch][..n].copy_from_slice(&inputs[ch][..n]);
        if n < outputs[ch].len() {
            outputs[ch][n..].fill(0.0);
        }
    }
    for out in outputs.iter_mut().skip(channels) {
        out.fill(0.0);
    }
}

impl PluginInstance for Vst3Instance {
    fn id(&self) -> Uuid {
        self.id
    }

    fn descriptor(&self) -> &PluginDescriptor {
        &self.descriptor
    }

    fn activate(&mut self, sample_rate: f64, max_buffer_size: usize) -> Result<(), PluginError> {
        self.sample_rate = sample_rate;
        self.max_buffer_size = max_buffer_size;

        // Pre-allocate scratch buffers
        self.scratch_left = vec![0.0; max_buffer_size];
        self.scratch_right = vec![0.0; max_buffer_size];
        self.scratch_sidechain_left = vec![0.0; max_buffer_size];
        self.scratch_sidechain_right = vec![0.0; max_buffer_size];
        if self.processor_ptr != 0 {
            let processor = self.processor_ptr as *mut IAudioProcessor;
            if self.component_ptr != 0 {
                let component = self.component_ptr as *mut IComponent;
                unsafe {
                    // AVANGARD FIX: Pass real IHostApplication instead of NULL.
                    // NULL causes segfault in FabFilter, Serum, Kontakt, etc.
                    let _ = ((*(*component).vtbl).initialize)(component, host_application_ptr());

                    // ── Query bus counts for proper bus arrangement ──
                    self.audio_input_bus_count =
                        ((*(*component).vtbl).get_bus_count)(component, K_AUDIO, K_INPUT).max(0);
                    self.audio_output_bus_count =
                        ((*(*component).vtbl).get_bus_count)(component, K_AUDIO, K_OUTPUT).max(0);

                    // Activate main input bus (bus 0)
                    if self.audio_input_bus_count > 0 {
                        let _ = ((*(*component).vtbl).activate_bus)(
                            component, K_AUDIO, K_INPUT, 0, 1,
                        );
                    }
                    // Activate sidechain input bus (bus 1) if present
                    if self.audio_input_bus_count > 1 {
                        let _ = ((*(*component).vtbl).activate_bus)(
                            component, K_AUDIO, K_INPUT, 1, 1,
                        );
                    }
                    // Activate main output bus (bus 0)
                    if self.audio_output_bus_count > 0 {
                        let _ = ((*(*component).vtbl).activate_bus)(
                            component, K_AUDIO, K_OUTPUT, 0, 1,
                        );
                    }

                    let _ = ((*(*component).vtbl).set_active)(component, 1);
                }
            }
            if self.controller_ptr != 0 {
                let controller = self.controller_ptr as *mut IEditController;
                unsafe {
                    let _ = ((*(*controller).vtbl).initialize)(controller, host_application_ptr());
                    // Bug 15: Register IComponentHandler so plugins can notify
                    // host about parameter edits (beginEdit/endEdit/performEdit).
                    let _ = ((*(*controller).vtbl).set_component_handler)(
                        controller,
                        component_handler_ptr(),
                    );
                }
            }

            // ── Set bus arrangements (stereo main + optional stereo sidechain) ──
            {
                let in_bus_count = self.audio_input_bus_count.max(1);
                let out_bus_count = self.audio_output_bus_count.max(1);
                let mut in_arrangements = vec![K_SPEAKER_STEREO; in_bus_count as usize];
                let mut out_arrangements = vec![K_SPEAKER_STEREO; out_bus_count as usize];
                let _ = unsafe {
                    ((*(*processor).vtbl).set_bus_arrangements)(
                        processor,
                        in_arrangements.as_mut_ptr() as *mut c_void,
                        in_bus_count,
                        out_arrangements.as_mut_ptr() as *mut c_void,
                        out_bus_count,
                    )
                };
            }

            let setup = ProcessSetup {
                process_mode: K_REALTIME,
                symbolic_sample_size: K_SAMPLE32,
                max_samples_per_block: max_buffer_size as i32,
                sample_rate,
            };
            let setup_res = unsafe { ((*(*processor).vtbl).setup_processing)(processor, &setup) };
            if setup_res == K_RESULT_OK {
                let _ = unsafe { ((*(*processor).vtbl).set_processing)(processor, 1) };
                self.com_initialized = true;
                self.latency = unsafe { ((*(*processor).vtbl).get_latency_samples)(processor) };
            } else {
                self.com_initialized = false;
            }
        }
        self.is_active = true;

        info!(
            "[VST3] Activated: {} @ {}Hz, {} frames",
            self.descriptor.name, sample_rate, max_buffer_size
        );

        Ok(())
    }

    fn deactivate(&mut self) -> Result<(), PluginError> {
        if self.processor_ptr != 0 {
            let processor = self.processor_ptr as *mut IAudioProcessor;
            unsafe {
                let _ = ((*(*processor).vtbl).set_processing)(processor, 0);
            }
        }
        if self.component_ptr != 0 {
            let component = self.component_ptr as *mut IComponent;
            unsafe {
                let _ = ((*(*component).vtbl).set_active)(component, 0);
            }
        }
        if self.controller_ptr != 0 {
            let controller = self.controller_ptr as *mut IEditController;
            unsafe {
                let _ = ((*(*controller).vtbl).terminate)(controller);
            }
        }
        self.com_initialized = false;
        self.is_active = false;
        info!("[VST3] Deactivated: {}", self.descriptor.name);
        Ok(())
    }

    fn process(
        &mut self,
        inputs: &[&[f32]],
        outputs: &mut [&mut [f32]],
        num_frames: usize,
        midi_events: &[MidiEvent],
    ) -> Result<(), PluginError> {
        if !self.is_active {
            return Err(PluginError::InvalidState("Plugin not active".to_string()));
        }

        if self.com_initialized && self.processor_ptr != 0 {
            let main_channels = outputs.len().min(2);
            if main_channels == 0 {
                return Ok(());
            }
            if num_frames > self.max_buffer_size {
                passthrough(inputs, outputs, num_frames);
                return Ok(());
            }

            let supports_sidechain_bus = self.descriptor.audio_inputs > 2;
            let has_sidechain_signal = supports_sidechain_bus && inputs.len() > 2;

            // Main bus input copy (L/R)
            for ch in 0..main_channels {
                let src = inputs.get(ch).copied().unwrap_or(&[][..]);
                let n = num_frames.min(src.len());
                if ch == 0 {
                    self.scratch_left[..n].copy_from_slice(&src[..n]);
                    if n < num_frames {
                        self.scratch_left[n..num_frames].fill(0.0);
                    }
                } else {
                    self.scratch_right[..n].copy_from_slice(&src[..n]);
                    if n < num_frames {
                        self.scratch_right[n..num_frames].fill(0.0);
                    }
                }
            }
            if main_channels == 1 {
                self.scratch_right[..num_frames].copy_from_slice(&self.scratch_left[..num_frames]);
            }

            // Sidechain bus copy (optional L/R)
            if has_sidechain_signal {
                for sc_ch in 0..2usize {
                    let src = inputs.get(2 + sc_ch).copied().unwrap_or_else(|| {
                        if sc_ch == 1 {
                            inputs.get(2).copied().unwrap_or(&[][..])
                        } else {
                            &[][..]
                        }
                    });
                    let n = num_frames.min(src.len());
                    if sc_ch == 0 {
                        self.scratch_sidechain_left[..n].copy_from_slice(&src[..n]);
                        if n < num_frames {
                            self.scratch_sidechain_left[n..num_frames].fill(0.0);
                        }
                    } else {
                        self.scratch_sidechain_right[..n].copy_from_slice(&src[..n]);
                        if n < num_frames {
                            self.scratch_sidechain_right[n..num_frames].fill(0.0);
                        }
                    }
                }
            } else {
                self.scratch_sidechain_left[..num_frames].fill(0.0);
                self.scratch_sidechain_right[..num_frames].fill(0.0);
            }

            let mut in_ptrs = [
                self.scratch_left.as_mut_ptr(),
                self.scratch_right.as_mut_ptr(),
                self.scratch_sidechain_left.as_mut_ptr(),
                self.scratch_sidechain_right.as_mut_ptr(),
            ];
            let mut out_ptrs = [ptr::null_mut::<f32>(), ptr::null_mut::<f32>()];
            for ch in 0..main_channels {
                out_ptrs[ch] = outputs[ch].as_mut_ptr();
            }
            if main_channels == 1 {
                out_ptrs[1] = out_ptrs[0];
            }

            let input_bus_count = if supports_sidechain_bus { 2 } else { 1 };
            let main_bus_channels = if supports_sidechain_bus {
                2
            } else {
                main_channels as i32
            };

            let in_main_bus = AudioBusBuffers {
                num_channels: main_bus_channels,
                silence_flags: 0,
                channel_buffers32: in_ptrs.as_mut_ptr(),
                channel_buffers64: ptr::null_mut(),
            };
            let in_sidechain_bus = AudioBusBuffers {
                num_channels: 2,
                silence_flags: if has_sidechain_signal { 0 } else { u64::MAX },
                channel_buffers32: unsafe { in_ptrs.as_mut_ptr().add(2) },
                channel_buffers64: ptr::null_mut(),
            };
            let mut out_bus = AudioBusBuffers {
                num_channels: main_channels as i32,
                silence_flags: 0,
                channel_buffers32: out_ptrs.as_mut_ptr(),
                channel_buffers64: ptr::null_mut(),
            };

            let mut input_buses = [in_main_bus, in_sidechain_bus];

            let mut in_param_changes =
                HostParameterChanges::from_pending(&self.pending_param_changes);
            self.pending_param_changes.clear();
            let input_param_ptr = if in_param_changes.queue_count > 0 {
                (&mut in_param_changes as *mut HostParameterChanges).cast::<c_void>()
            } else {
                ptr::null_mut()
            };
            let mut process_ctx = Vst3ProcessContext::from_transport(&self.transport_ctx);
            // ── Build IEventList from MIDI events ──
            let mut host_events = HostEventList::from_midi_events(midi_events);
            let input_events_ptr = if host_events.count > 0 {
                (&mut host_events as *mut HostEventList).cast::<c_void>()
            } else {
                ptr::null_mut()
            };

            let mut data = ProcessData {
                process_mode: K_REALTIME,
                symbolic_sample_size: K_SAMPLE32,
                num_samples: num_frames as i32,
                num_inputs: input_bus_count,
                num_outputs: 1,
                inputs: input_buses.as_mut_ptr(),
                outputs: &mut out_bus,
                input_parameter_changes: input_param_ptr,
                output_parameter_changes: ptr::null_mut(),
                input_events: input_events_ptr,
                output_events: ptr::null_mut(),
                // AVANGARD FIX: Provide real ProcessContext instead of NULL.
                // NULL causes segfault in FabFilter, Serum, etc. when querying tempo.
                process_context: &mut process_ctx as *mut Vst3ProcessContext as *mut c_void,
            };

            let processor = self.processor_ptr as *mut IAudioProcessor;
            let status = unsafe { ((*(*processor).vtbl).process)(processor, &mut data) };
            if status != K_RESULT_OK {
                passthrough(inputs, outputs, num_frames);
            } else {
                for out in outputs.iter_mut().skip(main_channels) {
                    out.fill(0.0);
                }
            }
        } else if let Some(process_fn) = self.process_fn {
            const MAX_BRIDGE_CHANNELS: usize = 32;
            if inputs.len() > MAX_BRIDGE_CHANNELS || outputs.len() > MAX_BRIDGE_CHANNELS {
                return Err(PluginError::ProcessError(format!(
                    "Channel count exceeds pre-allocated bridge capacity (in={}, out={}, cap_in={}, cap_out={})",
                    inputs.len(),
                    outputs.len(),
                    MAX_BRIDGE_CHANNELS,
                    MAX_BRIDGE_CHANNELS
                )));
            }

            let mut input_ptrs = [ptr::null(); MAX_BRIDGE_CHANNELS];
            let mut output_ptrs = [ptr::null_mut(); MAX_BRIDGE_CHANNELS];
            for (idx, input) in inputs.iter().enumerate() {
                input_ptrs[idx] = input.as_ptr();
            }
            for (idx, output) in outputs.iter_mut().enumerate() {
                output_ptrs[idx] = output.as_mut_ptr();
            }

            let status = unsafe {
                process_fn(
                    input_ptrs.as_ptr(),
                    output_ptrs.as_mut_ptr(),
                    inputs.len() as u32,
                    outputs.len() as u32,
                    num_frames as u32,
                    self.sample_rate,
                )
            };
            if status != 0 {
                return Err(PluginError::ProcessError(format!(
                    "Native VST bridge returned non-zero status: {status}"
                )));
            }
        } else {
            passthrough(inputs, outputs, num_frames);
        }

        Ok(())
    }

    fn process_with_sidechain(
        &mut self,
        main_inputs: &[&[f32]],
        sidechain_inputs: Option<&[&[f32]]>,
        outputs: &mut [&mut [f32]],
        num_frames: usize,
        midi_events: &[MidiEvent],
    ) -> Result<(), PluginError> {
        let mut merged: [&[f32]; 4] = [&[][..], &[][..], &[][..], &[][..]];

        if let Some(ch) = main_inputs.first() {
            merged[0] = ch;
        }
        if let Some(ch) = main_inputs.get(1) {
            merged[1] = ch;
        }

        if let Some(sc) = sidechain_inputs {
            if let Some(ch) = sc.first() {
                merged[2] = ch;
            }
            if let Some(ch) = sc.get(1) {
                merged[3] = ch;
            }
        }

        let merged_len = if sidechain_inputs.is_some() { 4 } else { 2 };
        self.process(&merged[..merged_len], outputs, num_frames, midi_events)
    }

    fn latency_samples(&self) -> u32 {
        self.latency
    }

    fn tail_samples(&self) -> u32 {
        0
    }

    fn reset(&mut self) {
        // Clear scratch buffers
        self.scratch_left.fill(0.0);
        self.scratch_right.fill(0.0);
        self.scratch_sidechain_left.fill(0.0);
        self.scratch_sidechain_right.fill(0.0);
    }

    fn set_transport_context(&mut self, ctx: TransportContext) {
        self.transport_ctx = ctx;
    }

    fn is_active(&self) -> bool {
        self.is_active
    }

    fn parameter_count(&self) -> u32 {
        let inferred = self
            .parameter_values
            .keys()
            .copied()
            .max()
            .map(|v| v.saturating_add(1))
            .unwrap_or(0);
        self.parameter_count_hint.max(inferred)
    }

    fn get_parameter(&self, index: u32) -> Option<f64> {
        self.parameter_values.get(&index).copied()
    }

    fn set_parameter(&mut self, index: u32, value: f64) -> Result<(), PluginError> {
        if !self.is_active {
            return Err(PluginError::InvalidState(
                "Cannot set parameter: plugin is not active".to_string(),
            ));
        }
        let normalized = value.clamp(0.0, 1.0);
        self.parameter_values.insert(index, normalized);
        self.parameter_count_hint = self.parameter_count_hint.max(index.saturating_add(1));

        if let Some(set_parameter) = self.set_parameter_fn {
            let status = unsafe { set_parameter(index, normalized) };
            if status == 0 {
                return Ok(());
            }
            return Err(PluginError::ProcessError(format!(
                "Native parameter bridge returned non-zero status: {status}"
            )));
        }

        if self.com_initialized && self.processor_ptr != 0 {
            if let Some((_, existing)) = self
                .pending_param_changes
                .iter_mut()
                .find(|(param_id, _)| *param_id == index)
            {
                *existing = normalized;
            } else {
                if self.pending_param_changes.len() >= MAX_HOST_PARAM_CHANGES {
                    let _ = self.pending_param_changes.remove(0);
                }
                self.pending_param_changes.push((index, normalized));
            }
            return Ok(());
        }

        Err(PluginError::InvalidState(
            "Parameters are unavailable for this plugin instance".to_string(),
        ))
    }

    fn open_editor(&mut self) -> Result<(), PluginError> {
        if !self.is_active {
            return Err(PluginError::InvalidState(
                "Cannot open editor: plugin is not active".to_string(),
            ));
        }
        if self.editor_open {
            return Ok(());
        }

        #[cfg(target_os = "macos")]
        {
            if self.controller_ptr != 0 {
                self.open_editor_macos()?;
                self.editor_open = true;
                return Ok(());
            }
        }

        let open = self.open_editor_fn.ok_or_else(|| {
            PluginError::UnsupportedFormat(
                "Native plugin editor bridge symbol is unavailable".to_string(),
            )
        })?;
        let status = unsafe { open() };
        if status != 0 {
            return Err(PluginError::ProcessError(format!(
                "Native editor bridge returned non-zero status: {status}"
            )));
        }
        self.editor_open = true;
        Ok(())
    }

    fn close_editor(&mut self) -> Result<(), PluginError> {
        if !self.editor_open {
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        {
            if self.editor_window.is_some() {
                self.close_editor_macos()?;
            }
        }
        self.editor_open = false;
        Ok(())
    }

    fn supports_editor(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            return self.controller_ptr != 0 || self.open_editor_fn.is_some();
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.open_editor_fn.is_some()
        }
    }

    fn load_state_blob(&mut self, kind: Option<&str>, data: &[u8]) -> Result<(), PluginError> {
        if data.is_empty() {
            return Ok(());
        }
        if self.component_ptr == 0 {
            return Err(PluginError::InvalidState(
                "Cannot restore state: VST3 component pointer is null".to_string(),
            ));
        }
        let mut stream = HostReadStream::new(data.to_vec());
        let component = self.component_ptr as *mut IComponent;
        let status = unsafe {
            ((*(*component).vtbl).set_state)(
                component,
                (&mut stream as *mut HostReadStream).cast::<c_void>(),
            )
        };
        if status != K_RESULT_OK {
            return Err(PluginError::ProcessError(format!(
                "set_state failed for '{}' (kind={}, status={status})",
                self.descriptor.name,
                kind.unwrap_or("unknown")
            )));
        }
        // Per VST3 spec: after IComponent::setState, call
        // IEditController::setComponentState so the editor reflects the loaded state.
        if self.controller_ptr != 0 {
            let controller = self.controller_ptr as *mut IEditController;
            let mut controller_stream = HostReadStream::new(data.to_vec());
            let _ = unsafe {
                ((*(*controller).vtbl).set_component_state)(
                    controller,
                    (&mut controller_stream as *mut HostReadStream).cast::<c_void>(),
                )
            };
        }

        info!(
            "[VST3] Applied state blob for '{}' (kind={}, bytes={})",
            self.descriptor.name,
            kind.unwrap_or("unknown"),
            data.len()
        );
        Ok(())
    }
}

impl Vst3Instance {
    /// Serializes the plugin's current state (component + controller).
    ///
    /// Returns a byte blob suitable for `load_state_blob` or session persistence.
    /// Calls `IComponent::getState` to capture the processor state.
    pub fn save_state(&self) -> Result<Vec<u8>, PluginError> {
        if self.component_ptr == 0 {
            return Err(PluginError::InvalidState(
                "Cannot save state: VST3 component pointer is null".to_string(),
            ));
        }
        let component = self.component_ptr as *mut IComponent;
        let mut stream = HostWriteStream::new();
        let status = unsafe {
            ((*(*component).vtbl).get_state)(
                component,
                (&mut stream as *mut HostWriteStream).cast::<c_void>(),
            )
        };
        if status != K_RESULT_OK {
            return Err(PluginError::ProcessError(format!(
                "getState failed for '{}' (status={status})",
                self.descriptor.name
            )));
        }
        let bytes = stream.into_bytes();
        info!(
            "[VST3] Saved state for '{}' ({} bytes)",
            self.descriptor.name,
            bytes.len()
        );
        Ok(bytes)
    }
}

// ── Plugin Host (Instance Registry) ───────────────────────────────────

/// Manages all loaded plugin instances.
///
/// The host owns all active plugin instances and provides methods to:
///   - Load and activate new instances.
///   - Access instances by ID for processing.
///   - Deactivate and unload instances.
///
/// This is NOT `Send` — it lives on the UI thread.
/// The audio thread accesses a snapshot via the execution plan.
pub struct PluginHost {
    /// All active plugin instances, keyed by their unique ID.
    instances: Vec<Box<dyn PluginInstance>>,
    instance_index: HashMap<Uuid, usize>,

    /// Current audio configuration.
    sample_rate: f64,
    buffer_size: usize,
}

impl PluginHost {
    /// Creates a new empty plugin host.
    pub fn new(sample_rate: f64, buffer_size: usize) -> Self {
        Self {
            instances: Vec::new(),
            instance_index: HashMap::new(),
            sample_rate,
            buffer_size,
        }
    }

    /// Loads, activates, and registers a VST3 plugin.
    pub fn load_vst3(&mut self, descriptor: PluginDescriptor) -> Result<Uuid, PluginError> {
        let mut instance = Vst3Instance::load(descriptor)?;
        instance.activate(self.sample_rate, self.buffer_size)?;

        let id = instance.id();
        info!("[PluginHost] Registered instance: {}", id);

        self.instances.push(Box::new(instance));
        self.instance_index.insert(id, self.instances.len() - 1);
        Ok(id)
    }

    /// Reactivates all loaded plugin instances with a new sample rate
    /// and/or buffer size. This is necessary when the audio device
    /// configuration changes at runtime (e.g., user switches interface).
    ///
    /// Each instance is deactivated, then reactivated with the new config.
    /// Errors are logged but do not halt processing of remaining instances.
    pub fn reactivate_all(&mut self, sample_rate: f64, buffer_size: usize) {
        info!(
            "[PluginHost] Reactivating {} instances @ {}Hz, {} frames",
            self.instances.len(), sample_rate, buffer_size
        );
        self.sample_rate = sample_rate;
        self.buffer_size = buffer_size;

        for instance in self.instances.iter_mut() {
            if let Err(e) = instance.deactivate() {
                info!(
                    "[PluginHost] Deactivation warning for {}: {}",
                    instance.id(), e
                );
            }
            if let Err(e) = instance.activate(sample_rate, buffer_size) {
                info!(
                    "[PluginHost] Reactivation failed for {}: {}",
                    instance.id(), e
                );
            }
        }
    }

    /// Registers an out-of-process sandboxed plugin instance.
    ///
    /// The external daemon is expected to own the actual plugin runtime;
    /// this instance provides a shared-memory bridge under the same
    /// `PluginInstance` trait contract.
    pub fn load_vst3_sandboxed(
        &mut self,
        instance_id: Uuid,
        descriptor: PluginDescriptor,
        shared_region_path: std::path::PathBuf,
        num_inputs: u16,
        num_outputs: u16,
        max_frames: u32,
    ) -> Result<Uuid, PluginError> {
        let mut instance = SandboxedPluginInstance::create(
            instance_id,
            descriptor,
            shared_region_path,
            num_inputs,
            num_outputs,
            max_frames,
        )?;
        instance.activate(self.sample_rate, self.buffer_size)?;
        let id = instance.id();
        info!("[PluginHost] Registered sandboxed instance: {}", id);
        self.instances.push(Box::new(instance));
        self.instance_index.insert(id, self.instances.len() - 1);
        Ok(id)
    }

    /// Returns a mutable reference to a plugin instance by its ID.
    pub fn get_mut(&mut self, id: Uuid) -> Option<&mut Box<dyn PluginInstance>> {
        let idx = *self.instance_index.get(&id)?;
        self.instances.get_mut(idx)
    }

    /// Sets transport context for an instance (RT-safe call-through).
    pub fn set_transport_context(
        &mut self,
        id: Uuid,
        ctx: TransportContext,
    ) -> Result<(), PluginError> {
        let instance = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        instance.set_transport_context(ctx);
        Ok(())
    }

    /// Queues a parameter change for a specific plugin instance.
    pub fn set_parameter(&mut self, id: Uuid, index: u32, value: f64) -> Result<(), PluginError> {
        let instance = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        instance.set_parameter(index, value)
    }

    /// Processes one plugin instance with optional sidechain bus and MIDI events.
    pub fn process_with_sidechain(
        &mut self,
        id: Uuid,
        main_inputs: &[&[f32]],
        sidechain_inputs: Option<&[&[f32]]>,
        outputs: &mut [&mut [f32]],
        num_frames: usize,
        midi_events: &[MidiEvent],
    ) -> Result<(), PluginError> {
        let instance = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        instance.process_with_sidechain(main_inputs, sidechain_inputs, outputs, num_frames, midi_events)
    }

    /// Removes and deactivates a plugin instance by its ID.
    pub fn remove(&mut self, id: Uuid) -> Result<(), PluginError> {
        let Some(pos) = self.instance_index.remove(&id) else {
            return Err(PluginError::InvalidState(format!(
                "Instance {} not found",
                id
            )));
        };

        let mut instance = self.instances.swap_remove(pos);
        let _ = instance.close_editor();
        instance.deactivate()?;

        if pos < self.instances.len() {
            let swapped_id = self.instances[pos].id();
            self.instance_index.insert(swapped_id, pos);
        }

        info!("[PluginHost] Removed instance: {}", id);
        Ok(())
    }

    /// Returns the number of active instances.
    pub fn instance_count(&self) -> usize {
        self.instances.len()
    }

    /// Updates the audio configuration for all instances.
    pub fn set_audio_config(
        &mut self,
        sample_rate: f64,
        buffer_size: usize,
    ) -> Result<(), PluginError> {
        self.sample_rate = sample_rate;
        self.buffer_size = buffer_size;

        for instance in &mut self.instances {
            instance.deactivate()?;
            instance.activate(sample_rate, buffer_size)?;
        }

        info!(
            "[PluginHost] Audio config updated: {}Hz, {} frames, {} instances",
            sample_rate,
            buffer_size,
            self.instances.len()
        );

        Ok(())
    }

    /// Opens native editor for a specific plugin instance.
    pub fn open_editor(&mut self, id: Uuid) -> Result<(), PluginError> {
        let instance = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        instance.open_editor()
    }

    /// Closes native editor for a specific plugin instance.
    pub fn close_editor(&mut self, id: Uuid) -> Result<(), PluginError> {
        let instance = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        instance.close_editor()
    }

    /// Returns whether a plugin instance supports opening a native editor.
    pub fn supports_editor(&mut self, id: Uuid) -> Result<bool, PluginError> {
        let instance = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        Ok(instance.supports_editor())
    }

    /// Returns plugin reported processing latency in samples.
    pub fn latency_samples(&mut self, id: Uuid) -> Result<u32, PluginError> {
        let instance = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        Ok(instance.latency_samples())
    }

    /// Applies serialized state data to a loaded plugin instance.
    pub fn load_state_blob(
        &mut self,
        id: Uuid,
        kind: Option<&str>,
        data: &[u8],
    ) -> Result<(), PluginError> {
        let instance = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        instance.load_state_blob(kind, data)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::PluginCategory;

    fn make_test_descriptor() -> PluginDescriptor {
        PluginDescriptor::new(
            "TestSynth",
            "TestVendor",
            PluginFormat::VST3,
            PluginCategory::Instrument,
            PathBuf::from("/tmp/test.vst3"),
        )
    }

    #[test]
    fn vst3_bundle_resolution_nonexistent() {
        let path = PathBuf::from("/nonexistent/plugin.vst3");
        assert!(resolve_vst3_binary(&path).is_none());
    }

    #[test]
    fn vst3_instance_wrong_format_rejected() {
        let mut desc = make_test_descriptor();
        desc.format = PluginFormat::CLAP;
        let result = Vst3Instance::load(desc);
        assert!(matches!(result, Err(PluginError::UnsupportedFormat(_))));
    }

    #[test]
    fn vst3_stub_lifecycle() {
        let desc = make_test_descriptor();
        let mut stub = Vst3Instance::stub(desc, 256);

        assert!(!stub.is_active());
        assert_eq!(stub.latency_samples(), 256);

        stub.activate(48000.0, 512).unwrap();
        assert!(stub.is_active());

        // Process some audio
        let input_l = vec![1.0f32; 128];
        let input_r = vec![0.5f32; 128];
        let mut output_l = vec![0.0f32; 128];
        let mut output_r = vec![0.0f32; 128];

        stub.process(
            &[&input_l, &input_r],
            &mut [&mut output_l, &mut output_r],
            128,
            &[],
        )
        .unwrap();

        assert_eq!(output_l[0], 1.0);
        assert_eq!(output_r[0], 0.5);

        stub.deactivate().unwrap();
        assert!(!stub.is_active());
    }

    #[test]
    fn vst3_stub_accepts_sidechain_channel_layout() {
        let mut desc = make_test_descriptor();
        desc.audio_inputs = 4;
        let mut stub = Vst3Instance::stub(desc, 0);
        stub.activate(48000.0, 64).unwrap();

        let main_l = vec![0.25f32; 64];
        let main_r = vec![0.5f32; 64];
        let sc_l = vec![1.0f32; 64];
        let sc_r = vec![1.0f32; 64];
        let mut out_l = vec![0.0f32; 64];
        let mut out_r = vec![0.0f32; 64];

        stub.process(
            &[&main_l, &main_r, &sc_l, &sc_r],
            &mut [&mut out_l, &mut out_r],
            64,
            &[],
        )
        .unwrap();

        // Stub/fallback path remains transparent for main bus.
        assert_eq!(out_l[0], 0.25);
        assert_eq!(out_r[0], 0.5);
    }

    #[test]
    fn plugin_host_creation() {
        let host = PluginHost::new(44100.0, 256);
        assert_eq!(host.instance_count(), 0);
    }

    #[test]
    fn vst3_process_without_activation_fails() {
        let desc = make_test_descriptor();
        let mut stub = Vst3Instance::stub(desc, 0);

        let input = vec![0.0f32; 64];
        let mut output = vec![0.0f32; 64];

        let result = stub.process(&[&input], &mut [&mut output], 64, &[]);
        assert!(matches!(result, Err(PluginError::InvalidState(_))));
    }

    #[test]
    fn editor_capability_defaults_to_false() {
        let desc = make_test_descriptor();
        let stub = Vst3Instance::stub(desc, 0);
        assert!(!stub.supports_editor());
    }

    #[test]
    fn editor_open_requires_activation() {
        let desc = make_test_descriptor();
        let mut stub = Vst3Instance::stub(desc, 0);
        let result = stub.open_editor();
        assert!(matches!(result, Err(PluginError::InvalidState(_))));
    }

    #[test]
    fn editor_open_reports_unimplemented_after_activation() {
        let desc = make_test_descriptor();
        let mut stub = Vst3Instance::stub(desc, 0);
        stub.activate(44100.0, 128).unwrap();
        let result = stub.open_editor();
        assert!(matches!(result, Err(PluginError::UnsupportedFormat(_))));
    }

    #[test]
    fn host_read_stream_read_and_seek() {
        let mut stream = HostReadStream::new(vec![10, 20, 30, 40, 50]);
        let mut out = [0u8; 3];
        let mut read = 0i32;
        let status = unsafe {
            stream_read(
                (&mut stream as *mut HostReadStream).cast::<IBStream>(),
                out.as_mut_ptr().cast::<c_void>(),
                3,
                &mut read,
            )
        };
        assert_eq!(status, K_RESULT_OK);
        assert_eq!(read, 3);
        assert_eq!(out, [10, 20, 30]);

        let mut pos = -1i64;
        let seek_status = unsafe {
            stream_seek(
                (&mut stream as *mut HostReadStream).cast::<IBStream>(),
                -1,
                K_SEEK_END,
                &mut pos,
            )
        };
        assert_eq!(seek_status, K_RESULT_OK);
        assert_eq!(pos, 4);

        let mut b = [0u8; 1];
        let mut read2 = 0i32;
        let status2 = unsafe {
            stream_read(
                (&mut stream as *mut HostReadStream).cast::<IBStream>(),
                b.as_mut_ptr().cast::<c_void>(),
                1,
                &mut read2,
            )
        };
        assert_eq!(status2, K_RESULT_OK);
        assert_eq!(read2, 1);
        assert_eq!(b[0], 50);
    }
}
