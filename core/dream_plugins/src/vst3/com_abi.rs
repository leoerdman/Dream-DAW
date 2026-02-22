use core::ffi::{c_char, c_void};

pub type Tuid = [u8; 16];
pub type Tresult = i32;

pub const K_RESULT_OK: Tresult = 0;
#[allow(dead_code)]
pub const K_RESULT_NOT_IMPLEMENTED: Tresult = -2147467263;
pub const K_RESULT_FALSE: Tresult = 1;
pub const K_SAMPLE32: i32 = 0;
pub const K_REALTIME: i32 = 0;
pub const K_NO_INTERFACE: Tresult = -1;
pub const K_SEEK_SET: i32 = 0;
pub const K_SEEK_CUR: i32 = 1;
pub const K_SEEK_END: i32 = 2;

// ── IIDs (Interface Identifiers) ───────────────────────────────────────────

pub const IID_IAUDIO_PROCESSOR: Tuid = [
    0x42, 0x04, 0x3F, 0x99, 0xB7, 0xDA, 0x45, 0x3C, 0xA5, 0x69, 0xE7, 0x9D, 0x9A, 0xAE, 0xC3, 0x3D,
];
pub const IID_ICOMPONENT: Tuid = [
    0xE8, 0x31, 0xFF, 0x31, 0xF2, 0xD5, 0x43, 0x01, 0x92, 0x8E, 0xBB, 0xEE, 0x25, 0x69, 0x78, 0x02,
];
pub const IID_IEDIT_CONTROLLER: Tuid = [
    0xDC, 0xD7, 0xBB, 0xE3, 0x77, 0x42, 0x44, 0x8D, 0xA8, 0x74, 0xAA, 0xCC, 0x97, 0x9C, 0x75, 0x9E,
];
pub const IID_IHOST_APPLICATION: Tuid = [
    0x58, 0xE5, 0x95, 0xCC, 0xDB, 0x2D, 0x49, 0x69, 0x8B, 0x6A, 0xAF, 0x8C, 0x36, 0xA6, 0x64, 0xE5,
];
pub const IID_IPLUG_FRAME: Tuid = [
    0x36, 0x7F, 0xAF, 0x01, 0xAF, 0xA9, 0x46, 0x93, 0x8D, 0x4D, 0xA2, 0xA0, 0xED, 0x08, 0x82, 0xA3,
];
pub const IID_FUNKNOWN: Tuid = [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
];
pub const IID_ICOMPONENT_HANDLER: Tuid = [
    0x93, 0xA0, 0xBE, 0xA3, 0x0B, 0xD0, 0x45, 0xDB, 0x8E, 0x89, 0x0B, 0x0C, 0xC1, 0xE4, 0x6A, 0xC6,
];
pub const IID_ICONNECTION_POINT: Tuid = [
    0x70, 0xA4, 0x15, 0x6F, 0x6E, 0x6E, 0x40, 0x26, 0x98, 0x91, 0x48, 0xBF, 0xAA, 0x60, 0xD8, 0xD1,
];
pub const IID_IMESSAGE: Tuid = [
    0x93, 0x6F, 0x03, 0x3B, 0xC6, 0xC0, 0x47, 0xDB, 0xBB, 0x08, 0x82, 0xF8, 0x13, 0xC1, 0xE6, 0x13,
];
pub const IID_IATTRIBUTE_LIST: Tuid = [
    0x1E, 0x5F, 0x0A, 0xEB, 0xCC, 0x7F, 0x45, 0x33, 0xA2, 0x54, 0x40, 0x11, 0x38, 0xAD, 0x5E, 0xE4,
];
pub const IID_IPLUG_INTERFACE_SUPPORT: Tuid = [
    0xA3, 0xB8, 0xC6, 0xC5, 0xC0, 0x95, 0x46, 0x88, 0xB0, 0x91, 0x6F, 0x0B, 0xB6, 0x97, 0xAA, 0x44,
];
pub const IID_ICOMPONENT_HANDLER_2: Tuid = [
    0xF0, 0x40, 0xB4, 0xB3, 0xA3, 0x60, 0x45, 0xEC, 0xAB, 0xCD, 0xDE, 0x7E, 0x3F, 0xBC, 0xA9, 0xED,
];

// ── ProcessContext state flags ─────────────────────────────────────────────

pub const K_PLAYING: u32 = 1 << 1;
pub const K_RECORDING: u32 = 1 << 3;
pub const K_TEMPO_VALID: u32 = 1 << 10;
pub const K_TIME_SIG_VALID: u32 = 1 << 13;
pub const K_PROJECT_TIME_VALID: u32 = 1 << 9;
pub const K_BAR_POSITION_VALID: u32 = 1 << 11;
pub const K_CONT_TIME_VALID: u32 = 1 << 17;

// ── IComponentHandler restart flags ────────────────────────────────────────

pub const K_RESTART_LATENCY_CHANGED: i32 = 0x01;
pub const K_RESTART_PARAM_VALUES_CHANGED: i32 = 0x02;
pub const K_RESTART_IO_CHANGED: i32 = 0x04;
pub const K_RESTART_PARAM_TITLES_CHANGED: i32 = 0x08;

// ── VST3 Event type IDs ───────────────────────────────────────────────────

pub const K_NOTE_ON_EVENT: u16 = 0;
pub const K_NOTE_OFF_EVENT: u16 = 1;
pub const K_LEGACY_MIDI_CC_OUT_EVENT: u16 = 65535;

// ── Automation & events max sizes ──────────────────────────────────────────

pub const MAX_HOST_PARAM_CHANGES: usize = 256;
pub const MAX_POINTS_PER_QUEUE: usize = 16;
pub const MAX_INPUT_EVENTS: usize = 512;

// ── Helper ─────────────────────────────────────────────────────────────────

/// Compares a raw VST3 TUID pointer with a concrete TUID value.
///
/// # Safety
/// `a` must either be null or point to a valid, readable `Tuid`.
pub unsafe fn tuid_eq(a: *const Tuid, b: &Tuid) -> bool {
    if a.is_null() {
        return false;
    }
    unsafe { *a == *b }
}
#[repr(C)]
#[derive(Clone)]
pub struct Vst3ProcessContext {
    pub state: u32,
    pub sample_rate: f64,
    pub project_time_samples: i64,
    pub system_time: i64,
    pub continuous_time_samples: i64,
    pub project_time_music: f64,
    pub bar_position_music: f64,
    pub cycle_start_music: f64,
    pub cycle_end_music: f64,
    pub tempo: f64,
    pub time_sig_numerator: i32,
    pub time_sig_denominator: i32,
    pub chord: Vst3Chord,
    pub smpte_offset_subframes: i32,
    pub frame_rate: Vst3FrameRate,
    pub samples_to_next_clock: i32,
}

const _: () = assert!(
    std::mem::size_of::<Vst3ProcessContext>() == 112,
    "Vst3ProcessContext size mismatch: must be exactly 112 bytes to match VST3 SDK"
);

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Vst3Chord {
    pub key_note: u8,
    pub root_note: u8,
    pub chord_mask: i16,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Vst3FrameRate {
    pub frames_per_second: u32,
    pub flags: u32,
}

#[repr(C)]
pub struct PClassInfo {
    pub cid: Tuid,
    pub cardinality: i32,
    pub category: [c_char; 32],
    pub name: [c_char; 64],
}

#[repr(C)]
pub struct IPluginFactory {
    pub vtbl: *const IPluginFactoryVtbl,
}

#[repr(C)]
pub struct IPluginFactoryVtbl {
    pub query_interface:
        unsafe extern "C" fn(*mut IPluginFactory, *const c_char, *mut *mut c_void) -> Tresult,
    pub add_ref: unsafe extern "C" fn(*mut IPluginFactory) -> u32,
    pub release: unsafe extern "C" fn(*mut IPluginFactory) -> u32,
    pub get_factory_info: unsafe extern "C" fn(*mut IPluginFactory, *mut c_void) -> Tresult,
    pub count_classes: unsafe extern "C" fn(*mut IPluginFactory) -> i32,
    pub get_class_info: unsafe extern "C" fn(*mut IPluginFactory, i32, *mut PClassInfo) -> Tresult,
    pub create_instance: unsafe extern "C" fn(
        *mut IPluginFactory,
        *const Tuid,
        *const c_char,
        *mut *mut c_void,
    ) -> Tresult,
}

#[repr(C)]
#[allow(dead_code)]
pub struct FUnknown {
    pub vtbl: *const FUnknownVtbl,
}

#[repr(C)]
#[allow(dead_code)]
pub struct FUnknownVtbl {
    pub query_interface:
        unsafe extern "C" fn(*mut FUnknown, *const c_char, *mut *mut c_void) -> Tresult,
    pub add_ref: unsafe extern "C" fn(*mut FUnknown) -> u32,
    pub release: unsafe extern "C" fn(*mut FUnknown) -> u32,
}

#[repr(C)]
pub struct IComponent {
    pub vtbl: *const IComponentVtbl,
}

#[repr(C)]
pub struct IComponentVtbl {
    pub query_interface:
        unsafe extern "C" fn(*mut IComponent, *const c_char, *mut *mut c_void) -> Tresult,
    pub add_ref: unsafe extern "C" fn(*mut IComponent) -> u32,
    pub release: unsafe extern "C" fn(*mut IComponent) -> u32,
    pub initialize: unsafe extern "C" fn(*mut IComponent, *mut c_void) -> Tresult,
    pub terminate: unsafe extern "C" fn(*mut IComponent) -> Tresult,
    pub get_controller_class_id: unsafe extern "C" fn(*mut IComponent, *mut Tuid) -> Tresult,
    pub set_io_mode: unsafe extern "C" fn(*mut IComponent, i32) -> Tresult,
    pub get_bus_count: unsafe extern "C" fn(*mut IComponent, i32, i32) -> i32,
    pub get_bus_info: unsafe extern "C" fn(*mut IComponent, i32, i32, *mut c_void) -> Tresult,
    pub get_routing_info:
        unsafe extern "C" fn(*mut IComponent, *mut c_void, *mut c_void) -> Tresult,
    pub activate_bus: unsafe extern "C" fn(*mut IComponent, i32, i32, i32, i32) -> Tresult,
    pub set_active: unsafe extern "C" fn(*mut IComponent, i8) -> Tresult,
    pub set_state: unsafe extern "C" fn(*mut IComponent, *mut c_void) -> Tresult,
    pub get_state: unsafe extern "C" fn(*mut IComponent, *mut c_void) -> Tresult,
}

#[repr(C)]
pub struct IEditController {
    pub vtbl: *const IEditControllerVtbl,
}

#[repr(C)]
pub struct IEditControllerVtbl {
    pub query_interface:
        unsafe extern "C" fn(*mut IEditController, *const c_char, *mut *mut c_void) -> Tresult,
    pub add_ref: unsafe extern "C" fn(*mut IEditController) -> u32,
    pub release: unsafe extern "C" fn(*mut IEditController) -> u32,
    pub initialize: unsafe extern "C" fn(*mut IEditController, *mut c_void) -> Tresult,
    pub terminate: unsafe extern "C" fn(*mut IEditController) -> Tresult,
    pub set_component_state: unsafe extern "C" fn(*mut IEditController, *mut c_void) -> Tresult,
    pub set_state: unsafe extern "C" fn(*mut IEditController, *mut c_void) -> Tresult,
    pub get_state: unsafe extern "C" fn(*mut IEditController, *mut c_void) -> Tresult,
    pub get_parameter_count: unsafe extern "C" fn(*mut IEditController) -> i32,
    pub get_parameter_info: unsafe extern "C" fn(*mut IEditController, i32, *mut c_void) -> Tresult,
    pub get_param_string_by_value:
        unsafe extern "C" fn(*mut IEditController, u32, f64, *mut u16) -> Tresult,
    pub get_param_value_by_string:
        unsafe extern "C" fn(*mut IEditController, u32, *const u16, *mut f64) -> Tresult,
    pub normalized_param_to_plain: unsafe extern "C" fn(*mut IEditController, u32, f64) -> f64,
    pub plain_param_to_normalized: unsafe extern "C" fn(*mut IEditController, u32, f64) -> f64,
    pub get_param_normalized: unsafe extern "C" fn(*mut IEditController, u32) -> f64,
    pub set_param_normalized: unsafe extern "C" fn(*mut IEditController, u32, f64) -> Tresult,
    pub set_component_handler: unsafe extern "C" fn(*mut IEditController, *mut c_void) -> Tresult,
    pub create_view: unsafe extern "C" fn(*mut IEditController, *const c_char) -> *mut c_void,
}

#[repr(C)]
pub struct IConnectionPoint {
    pub vtbl: *const IConnectionPointVtbl,
}

#[repr(C)]
pub struct IConnectionPointVtbl {
    pub query_interface:
        unsafe extern "C" fn(*mut IConnectionPoint, *const c_char, *mut *mut c_void) -> Tresult,
    pub add_ref: unsafe extern "C" fn(*mut IConnectionPoint) -> u32,
    pub release: unsafe extern "C" fn(*mut IConnectionPoint) -> u32,
    pub connect: unsafe extern "C" fn(*mut IConnectionPoint, *mut IConnectionPoint) -> Tresult,
    pub disconnect: unsafe extern "C" fn(*mut IConnectionPoint, *mut IConnectionPoint) -> Tresult,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct ViewRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[repr(C)]
pub struct IPlugView {
    pub vtbl: *const IPlugViewVtbl,
}

#[repr(C)]
pub struct IPlugViewVtbl {
    pub query_interface:
        unsafe extern "C" fn(*mut IPlugView, *const Tuid, *mut *mut c_void) -> Tresult,
    pub add_ref: unsafe extern "C" fn(*mut IPlugView) -> u32,
    pub release: unsafe extern "C" fn(*mut IPlugView) -> u32,
    pub is_platform_type_supported: unsafe extern "C" fn(*mut IPlugView, *const c_char) -> Tresult,
    pub attached: unsafe extern "C" fn(*mut IPlugView, *mut c_void, *const c_char) -> Tresult,
    pub removed: unsafe extern "C" fn(*mut IPlugView) -> Tresult,
    pub on_wheel: unsafe extern "C" fn(*mut IPlugView, f32) -> Tresult,
    pub on_key_down: unsafe extern "C" fn(*mut IPlugView, i16, i16, i16) -> Tresult,
    pub on_key_up: unsafe extern "C" fn(*mut IPlugView, i16, i16, i16) -> Tresult,
    pub get_size: unsafe extern "C" fn(*mut IPlugView, *mut ViewRect) -> Tresult,
    pub on_size: unsafe extern "C" fn(*mut IPlugView, *mut ViewRect) -> Tresult,
    pub on_focus: unsafe extern "C" fn(*mut IPlugView, i8) -> Tresult,
    pub set_frame: unsafe extern "C" fn(*mut IPlugView, *mut c_void) -> Tresult,
    pub can_resize: unsafe extern "C" fn(*mut IPlugView) -> Tresult,
    pub check_size_constraint: unsafe extern "C" fn(*mut IPlugView, *mut ViewRect) -> Tresult,
}

#[repr(C)]
pub struct ProcessSetup {
    pub process_mode: i32,
    pub symbolic_sample_size: i32,
    pub max_samples_per_block: i32,
    pub sample_rate: f64,
}

#[repr(C)]
pub struct AudioBusBuffers {
    pub num_channels: i32,
    pub silence_flags: u64,
    pub channel_buffers32: *mut *mut f32,
}

#[repr(C)]
pub struct ProcessData {
    pub process_mode: i32,
    pub symbolic_sample_size: i32,
    pub num_samples: i32,
    pub num_inputs: i32,
    pub num_outputs: i32,
    pub inputs: *mut AudioBusBuffers,
    pub outputs: *mut AudioBusBuffers,
    pub input_parameter_changes: *mut c_void,
    pub output_parameter_changes: *mut c_void,
    pub input_events: *mut c_void,
    pub output_events: *mut c_void,
    pub process_context: *mut c_void,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct IAudioProcessor {
    pub vtbl: *const IAudioProcessorVtbl,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct IAudioProcessorVtbl {
    pub query_interface:
        unsafe extern "C" fn(*mut IAudioProcessor, *const c_char, *mut *mut c_void) -> Tresult,
    pub add_ref: unsafe extern "C" fn(*mut IAudioProcessor) -> u32,
    pub release: unsafe extern "C" fn(*mut IAudioProcessor) -> u32,
    pub set_bus_arrangements:
        unsafe extern "C" fn(*mut IAudioProcessor, *mut c_void, i32, *mut c_void, i32) -> Tresult,
    pub get_bus_arrangement:
        unsafe extern "C" fn(*mut IAudioProcessor, i32, i32, *mut c_void) -> Tresult,
    pub can_process_sample_size: unsafe extern "C" fn(*mut IAudioProcessor, i32) -> Tresult,
    pub get_latency_samples: unsafe extern "C" fn(*mut IAudioProcessor) -> u32,
    pub setup_processing:
        unsafe extern "C" fn(*mut IAudioProcessor, *const ProcessSetup) -> Tresult,
    pub set_processing: unsafe extern "C" fn(*mut IAudioProcessor, i8) -> Tresult,
    pub process: unsafe extern "C" fn(*mut IAudioProcessor, *mut ProcessData) -> Tresult,
    pub get_tail_samples: unsafe extern "C" fn(*mut IAudioProcessor) -> u32,
}

#[repr(C)]
pub struct IBStream {
    pub vtbl: *const IBStreamVtbl,
}

#[repr(C)]
pub struct IBStreamVtbl {
    pub query_interface:
        unsafe extern "C" fn(*mut IBStream, *const c_char, *mut *mut c_void) -> Tresult,
    pub add_ref: unsafe extern "C" fn(*mut IBStream) -> u32,
    pub release: unsafe extern "C" fn(*mut IBStream) -> u32,
    pub read: unsafe extern "C" fn(*mut IBStream, *mut c_void, i32, *mut i32) -> Tresult,
    pub write: unsafe extern "C" fn(*mut IBStream, *mut c_void, i32, *mut i32) -> Tresult,
    pub seek: unsafe extern "C" fn(*mut IBStream, i64, i32, *mut i64) -> Tresult,
    pub tell: unsafe extern "C" fn(*mut IBStream, *mut i64) -> Tresult,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct IParamValueQueue {
    pub vtbl: *const IParamValueQueueVtbl,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct IParamValueQueueVtbl {
    pub query_interface:
        unsafe extern "C" fn(*mut IParamValueQueue, *const c_char, *mut *mut c_void) -> Tresult,
    pub add_ref: unsafe extern "C" fn(*mut IParamValueQueue) -> u32,
    pub release: unsafe extern "C" fn(*mut IParamValueQueue) -> u32,
    pub get_parameter_id: unsafe extern "C" fn(*mut IParamValueQueue) -> u32,
    pub get_point_count: unsafe extern "C" fn(*mut IParamValueQueue) -> i32,
    pub get_point: unsafe extern "C" fn(*mut IParamValueQueue, i32, *mut i32, *mut f64) -> Tresult,
    pub add_point: unsafe extern "C" fn(*mut IParamValueQueue, i32, f64, *mut i32) -> Tresult,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct IParameterChanges {
    pub vtbl: *const IParameterChangesVtbl,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct IParameterChangesVtbl {
    pub query_interface:
        unsafe extern "C" fn(*mut IParameterChanges, *const c_char, *mut *mut c_void) -> Tresult,
    pub add_ref: unsafe extern "C" fn(*mut IParameterChanges) -> u32,
    pub release: unsafe extern "C" fn(*mut IParameterChanges) -> u32,
    pub get_parameter_count: unsafe extern "C" fn(*mut IParameterChanges) -> i32,
    pub get_parameter_data:
        unsafe extern "C" fn(*mut IParameterChanges, i32) -> *mut IParamValueQueue,
    pub add_parameter_data:
        unsafe extern "C" fn(*mut IParameterChanges, *mut u32, *mut i32) -> *mut IParamValueQueue,
}
