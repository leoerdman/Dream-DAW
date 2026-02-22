use std::ffi::c_void;

/// The magic value in `AEffect.magic` (ASCII "VstP" reversed).
pub const K_EFFECT_MAGIC: i32 = 0x56737450u32 as i32;

/// Pointer-sized integer type for VST2 ABI.
pub type VstIntPtr = isize;

// Dispatcher opcodes.
pub const EFF_OPEN: i32 = 0;
pub const EFF_CLOSE: i32 = 1;
pub const EFF_SET_PROGRAM: i32 = 2;
pub const EFF_GET_PROGRAM: i32 = 3;
pub const EFF_SET_PROGRAM_NAME: i32 = 4;
pub const EFF_GET_PROGRAM_NAME: i32 = 5;
pub const EFF_GET_PARAM_LABEL: i32 = 6;
pub const EFF_GET_PARAM_DISPLAY: i32 = 7;
pub const EFF_GET_PARAM_NAME: i32 = 8;
pub const EFF_SET_SAMPLE_RATE: i32 = 10;
pub const EFF_SET_BLOCK_SIZE: i32 = 11;
pub const EFF_MAINS_CHANGED: i32 = 12;
pub const EFF_EDIT_GET_RECT: i32 = 13;
pub const EFF_EDIT_OPEN: i32 = 14;
pub const EFF_EDIT_CLOSE: i32 = 15;
pub const EFF_GET_CHUNK: i32 = 23;
pub const EFF_SET_CHUNK: i32 = 24;
pub const EFF_PROCESS_EVENTS: i32 = 25;
pub const EFF_CAN_BE_AUTOMATED: i32 = 26;
pub const EFF_GET_VENDOR_STRING: i32 = 47;
pub const EFF_GET_PRODUCT_STRING: i32 = 48;
pub const EFF_GET_VENDOR_VERSION: i32 = 49;
pub const EFF_CAN_DO: i32 = 51;
pub const EFF_GET_TAIL_SIZE: i32 = 52;
pub const EFF_BEGIN_SET_PROGRAM: i32 = 67;
pub const EFF_END_SET_PROGRAM: i32 = 68;
pub const EFF_START_PROCESS: i32 = 71;
pub const EFF_STOP_PROCESS: i32 = 72;

// Host callback opcodes.
pub const AUDIO_MASTER_VERSION: i32 = 1;
pub const AUDIO_MASTER_CURRENT_ID: i32 = 2;
pub const AUDIO_MASTER_IDLE: i32 = 3;
pub const AUDIO_MASTER_PIN_CONNECTED: i32 = 4;
pub const AUDIO_MASTER_AUTOMATE: i32 = 0;
pub const AUDIO_MASTER_GET_SAMPLE_RATE: i32 = 16;
pub const AUDIO_MASTER_GET_BLOCK_SIZE: i32 = 17;
pub const AUDIO_MASTER_GET_INPUT_LATENCY: i32 = 18;
pub const AUDIO_MASTER_GET_OUTPUT_LATENCY: i32 = 19;
pub const AUDIO_MASTER_GET_CURRENT_PROCESS_LEVEL: i32 = 23;
pub const AUDIO_MASTER_GET_AUTOMATION_STATE: i32 = 24;
pub const AUDIO_MASTER_GET_VENDOR_STRING: i32 = 32;
pub const AUDIO_MASTER_GET_PRODUCT_STRING: i32 = 33;
pub const AUDIO_MASTER_GET_VENDOR_VERSION: i32 = 34;
pub const AUDIO_MASTER_CAN_DO: i32 = 37;
pub const AUDIO_MASTER_GET_LANGUAGE: i32 = 38;
pub const AUDIO_MASTER_GET_TIME: i32 = 7;
pub const AUDIO_MASTER_BEGIN_EDIT: i32 = 43;
pub const AUDIO_MASTER_END_EDIT: i32 = 44;
pub const AUDIO_MASTER_IO_CHANGED: i32 = 13;
pub const AUDIO_MASTER_SIZE_WINDOW: i32 = 15;
pub const AUDIO_MASTER_UPDATE_DISPLAY: i32 = 42;

// AEffect flags.
pub const EFF_FLAGS_CAN_REPLACING: i32 = 1 << 4;
pub const EFF_FLAGS_CAN_DOUBLE_REPLACING: i32 = 1 << 12;
pub const EFF_FLAGS_HAS_EDITOR: i32 = 1;
pub const EFF_FLAGS_IS_SYNTH: i32 = 1 << 8;
pub const EFF_FLAGS_PROGRAM_CHUNKS: i32 = 1 << 5;

// MIDI event type.
pub const K_VST_MIDI_TYPE: i32 = 1;

// VstTimeInfo flags.
pub const K_VST_TRANSPORT_PLAYING: i32 = 1 << 1;
pub const K_VST_TRANSPORT_RECORDING: i32 = 1 << 3;
pub const K_VST_TEMPO_VALID: i32 = 1 << 10;
pub const K_VST_TIME_SIG_VALID: i32 = 1 << 13;
pub const K_VST_NANOSEC_VALID: i32 = 1 << 8;
pub const K_VST_PPQ_POS_VALID: i32 = 1 << 9;
pub const K_VST_BARS_VALID: i32 = 1 << 11;

#[repr(C)]
pub struct AEffect {
    pub magic: i32,
    pub dispatcher: Option<
        unsafe extern "C" fn(
            effect: *mut AEffect,
            opcode: i32,
            index: i32,
            value: VstIntPtr,
            ptr: *mut c_void,
            opt: f32,
        ) -> VstIntPtr,
    >,
    pub _process: Option<
        unsafe extern "C" fn(
            effect: *mut AEffect,
            inputs: *const *const f32,
            outputs: *mut *mut f32,
            sample_frames: i32,
        ),
    >,
    pub set_parameter: Option<unsafe extern "C" fn(effect: *mut AEffect, index: i32, value: f32)>,
    pub get_parameter: Option<unsafe extern "C" fn(effect: *mut AEffect, index: i32) -> f32>,
    pub num_programs: i32,
    pub num_params: i32,
    pub num_inputs: i32,
    pub num_outputs: i32,
    pub flags: i32,
    pub reserved1: VstIntPtr,
    pub reserved2: VstIntPtr,
    pub initial_delay: i32,
    pub _real_qualities: i32,
    pub _off_qualities: i32,
    pub _io_ratio: f32,
    pub object: *mut c_void,
    pub user: *mut c_void,
    pub unique_id: i32,
    pub version: i32,
    pub process_replacing: Option<
        unsafe extern "C" fn(
            effect: *mut AEffect,
            inputs: *const *const f32,
            outputs: *mut *mut f32,
            sample_frames: i32,
        ),
    >,
    pub process_double_replacing: Option<
        unsafe extern "C" fn(
            effect: *mut AEffect,
            inputs: *const *const f64,
            outputs: *mut *mut f64,
            sample_frames: i32,
        ),
    >,
    pub _future: [u8; 56],
}

#[repr(C)]
#[derive(Clone)]
pub struct VstMidiEvent {
    pub event_type: i32,
    pub byte_size: i32,
    pub delta_frames: i32,
    pub flags: i32,
    pub note_length: i32,
    pub note_offset: i32,
    pub midi_data: [u8; 4],
    pub detune: i8,
    pub note_off_velocity: u8,
    pub _reserved1: u8,
    pub _reserved2: u8,
}

#[repr(C)]
pub struct VstEvents {
    pub num_events: i32,
    pub reserved: VstIntPtr,
    pub events: [*mut c_void; 2],
}

#[repr(C)]
#[derive(Clone)]
pub struct VstTimeInfo {
    pub sample_pos: f64,
    pub sample_rate: f64,
    pub nano_seconds: f64,
    pub ppq_pos: f64,
    pub tempo: f64,
    pub bar_start_pos: f64,
    pub cycle_start_pos: f64,
    pub cycle_end_pos: f64,
    pub time_sig_numerator: i32,
    pub time_sig_denominator: i32,
    pub smpte_offset: i32,
    pub smpte_frame_rate: i32,
    pub samples_to_next_clock: i32,
    pub flags: i32,
}

pub type VstPluginMainFn = unsafe extern "C" fn(
    callback: unsafe extern "C" fn(
        effect: *mut AEffect,
        opcode: i32,
        index: i32,
        value: VstIntPtr,
        ptr: *mut c_void,
        opt: f32,
    ) -> VstIntPtr,
) -> *mut AEffect;
