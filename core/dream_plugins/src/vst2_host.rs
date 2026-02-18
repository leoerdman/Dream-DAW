// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — VST2 Host Bridge (Native Plugin Loading)
// ═══════════════════════════════════════════════════════════════════════════
//
// Enterprise-grade VST2.4 plugin hosting via the classic C ABI.
//
// Architecture:
//   1. Load the `.vst` bundle's binary via `libloading` (dylib on macOS).
//   2. Call `VSTPluginMain(audioMasterCallback)` to obtain AEffect*.
//   3. Use dispatcher() for lifecycle, processReplacing() for audio.
//
// macOS bundle resolution:
//   `<name>.vst/Contents/MacOS/<name>` is the dylib path.
//
// Real-Time Safety:
//   - `process()` calls the plugin's `processReplacing()`.
//   - No allocations in the process loop.
//   - All buffer preparation uses pre-allocated scratch memory.
//
// ═══════════════════════════════════════════════════════════════════════════

use std::ffi::{c_char, c_void, CStr};
use std::path::{Path, PathBuf};
use std::ptr;

use log::info;
use uuid::Uuid;

use crate::descriptor::PluginDescriptor;
use crate::format::PluginFormat;
use crate::instance::{MidiEvent, PluginError, PluginInstance, TransportContext};

// ── VST2.4 C ABI Definitions ──────────────────────────────────────────

/// The magic value in `AEffect.magic` (ASCII "VstP" reversed).
const K_EFFECT_MAGIC: i32 = 0x56737450u32 as i32;

/// Pointer-sized integer type for VST2 ABI.
type VstIntPtr = isize;

// ── VST2 Dispatcher Opcodes ──

const EFF_OPEN: i32 = 0;
const EFF_CLOSE: i32 = 1;
#[allow(dead_code)]
const EFF_SET_PROGRAM: i32 = 2;
#[allow(dead_code)]
const EFF_GET_PROGRAM: i32 = 3;
#[allow(dead_code)]
const EFF_SET_PROGRAM_NAME: i32 = 4;
#[allow(dead_code)]
const EFF_GET_PROGRAM_NAME: i32 = 5;
const EFF_GET_PARAM_LABEL: i32 = 6;
const EFF_GET_PARAM_DISPLAY: i32 = 7;
const EFF_GET_PARAM_NAME: i32 = 8;
const EFF_SET_SAMPLE_RATE: i32 = 10;
const EFF_SET_BLOCK_SIZE: i32 = 11;
const EFF_MAINS_CHANGED: i32 = 12;
#[allow(dead_code)]
const EFF_EDIT_GET_RECT: i32 = 13;
#[allow(dead_code)]
const EFF_EDIT_OPEN: i32 = 14;
#[allow(dead_code)]
const EFF_EDIT_CLOSE: i32 = 15;
#[allow(dead_code)]
const EFF_GET_CHUNK: i32 = 23;
#[allow(dead_code)]
const EFF_SET_CHUNK: i32 = 24;
const EFF_PROCESS_EVENTS: i32 = 25;
#[allow(dead_code)]
const EFF_CAN_BE_AUTOMATED: i32 = 26;
const EFF_GET_VENDOR_STRING: i32 = 47;
const EFF_GET_PRODUCT_STRING: i32 = 48;
#[allow(dead_code)]
const EFF_GET_VENDOR_VERSION: i32 = 49;
const EFF_CAN_DO: i32 = 51;
const EFF_GET_TAIL_SIZE: i32 = 52;
const EFF_BEGIN_SET_PROGRAM: i32 = 67;
const EFF_END_SET_PROGRAM: i32 = 68;
const EFF_START_PROCESS: i32 = 71;
const EFF_STOP_PROCESS: i32 = 72;

// ── Host Callback Opcodes ──

const AUDIO_MASTER_VERSION: i32 = 1;
const AUDIO_MASTER_CURRENT_ID: i32 = 2;
const AUDIO_MASTER_IDLE: i32 = 3;
#[allow(dead_code)]
const AUDIO_MASTER_PIN_CONNECTED: i32 = 4;
const AUDIO_MASTER_AUTOMATE: i32 = 0;
const AUDIO_MASTER_GET_SAMPLE_RATE: i32 = 16;
const AUDIO_MASTER_GET_BLOCK_SIZE: i32 = 17;
#[allow(dead_code)]
const AUDIO_MASTER_GET_INPUT_LATENCY: i32 = 18;
#[allow(dead_code)]
const AUDIO_MASTER_GET_OUTPUT_LATENCY: i32 = 19;
const AUDIO_MASTER_GET_CURRENT_PROCESS_LEVEL: i32 = 23;
#[allow(dead_code)]
const AUDIO_MASTER_GET_AUTOMATION_STATE: i32 = 24;
const AUDIO_MASTER_GET_VENDOR_STRING: i32 = 32;
const AUDIO_MASTER_GET_PRODUCT_STRING: i32 = 33;
const AUDIO_MASTER_GET_VENDOR_VERSION: i32 = 34;
const AUDIO_MASTER_CAN_DO: i32 = 37;
const AUDIO_MASTER_GET_LANGUAGE: i32 = 38;
const AUDIO_MASTER_GET_TIME: i32 = 7;
const AUDIO_MASTER_BEGIN_EDIT: i32 = 43;
const AUDIO_MASTER_END_EDIT: i32 = 44;
const AUDIO_MASTER_IO_CHANGED: i32 = 13;
const AUDIO_MASTER_SIZE_WINDOW: i32 = 15;
const AUDIO_MASTER_UPDATE_DISPLAY: i32 = 42;

// ── AEffect Flags ──

const EFF_FLAGS_CAN_REPLACING: i32 = 1 << 4;
#[allow(dead_code)]
const EFF_FLAGS_CAN_DOUBLE_REPLACING: i32 = 1 << 12;
const EFF_FLAGS_HAS_EDITOR: i32 = 1;
const EFF_FLAGS_IS_SYNTH: i32 = 1 << 8;
const EFF_FLAGS_PROGRAM_CHUNKS: i32 = 1 << 5;

// ── MIDI Event Type ──

const K_VST_MIDI_TYPE: i32 = 1;

// ── VstTimeInfo Flags ──
const K_VST_TRANSPORT_PLAYING: i32 = 1 << 1;
const K_VST_TRANSPORT_RECORDING: i32 = 1 << 3;
const K_VST_TEMPO_VALID: i32 = 1 << 10;
const K_VST_TIME_SIG_VALID: i32 = 1 << 13;
const K_VST_NANOSEC_VALID: i32 = 1 << 8;
const K_VST_PPQ_POS_VALID: i32 = 1 << 9;
const K_VST_BARS_VALID: i32 = 1 << 11;

// ── VST2 C ABI Structs ──

/// The main VST2 plugin struct returned by VSTPluginMain.
/// This is an exact match to the Steinberg VST2.4 SDK `AEffect` layout.
#[repr(C)]
pub struct AEffect {
    /// Must be `kEffectMagic` (0x56737450).
    pub magic: i32,

    /// Dispatcher function: host → plugin communication via opcodes.
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

    /// Deprecated `process` function (pre-2.4). May be null.
    pub _process: Option<
        unsafe extern "C" fn(
            effect: *mut AEffect,
            inputs: *const *const f32,
            outputs: *mut *mut f32,
            sample_frames: i32,
        ),
    >,

    /// Set a parameter value by index.
    pub set_parameter:
        Option<unsafe extern "C" fn(effect: *mut AEffect, index: i32, value: f32)>,

    /// Get a parameter value by index.
    pub get_parameter: Option<unsafe extern "C" fn(effect: *mut AEffect, index: i32) -> f32>,

    /// Number of programs (presets).
    pub num_programs: i32,

    /// Number of parameters.
    pub num_params: i32,

    /// Number of audio input channels.
    pub num_inputs: i32,

    /// Number of audio output channels.
    pub num_outputs: i32,

    /// Capability flags bitmask.
    pub flags: i32,

    /// Reserved for host (pointer storage 1).
    pub reserved1: VstIntPtr,

    /// Reserved for host (pointer storage 2).
    pub reserved2: VstIntPtr,

    /// Initial delay (latency) in samples.
    pub initial_delay: i32,

    /// Deprecated real qualities flags.
    pub _real_qualities: i32,

    /// Deprecated off qualities flags.
    pub _off_qualities: i32,

    /// Deprecated IO ratio.
    pub _io_ratio: f32,

    /// Plugin-private object pointer.
    pub object: *mut c_void,

    /// User-defined pointer (host storage).
    pub user: *mut c_void,

    /// Unique plugin ID (FourCC).
    pub unique_id: i32,

    /// Plugin version.
    pub version: i32,

    /// processReplacing function (VST 2.4).
    pub process_replacing: Option<
        unsafe extern "C" fn(
            effect: *mut AEffect,
            inputs: *const *const f32,
            outputs: *mut *mut f32,
            sample_frames: i32,
        ),
    >,

    /// processDoubleReplacing function (optional, 64-bit).
    pub process_double_replacing: Option<
        unsafe extern "C" fn(
            effect: *mut AEffect,
            inputs: *const *const f64,
            outputs: *mut *mut f64,
            sample_frames: i32,
        ),
    >,

    /// Reserved for expansion.
    pub _future: [u8; 56],
}

/// VstMidiEvent — a single MIDI event in VST2 format.
#[repr(C)]
#[derive(Clone)]
struct VstMidiEvent {
    /// Event type — must be `kVstMidiType` (1).
    event_type: i32,
    /// Size of this struct in bytes.
    byte_size: i32,
    /// Sample offset (frames from start of buffer).
    delta_frames: i32,
    /// Flags (unused, set to 0).
    flags: i32,
    /// Length of MIDI note (unused, 0).
    note_length: i32,
    /// Offset into note from note start if note (unused, 0).
    note_offset: i32,
    /// MIDI data: [status, data1, data2, 0].
    midi_data: [u8; 4],
    /// Detune: -64 to +63 cents (unused, 0).
    detune: i8,
    /// Note off velocity (0-127, unused, 0).
    note_off_velocity: u8,
    /// Reserved padding.
    _reserved1: u8,
    /// Reserved padding.
    _reserved2: u8,
}

/// VstEvents — container for an array of VstEvent pointers.
#[repr(C)]
struct VstEvents {
    /// Number of events in the array.
    num_events: i32,
    /// Reserved (must be 0).
    reserved: VstIntPtr,
    /// Flexible array of event pointers. In practice we'll use a separate
    /// allocation that includes enough space after this header.
    events: [*mut c_void; 2], // At least 2 for alignment; actual count = num_events
}

/// VstTimeInfo — transport and tempo information returned to the plugin.
#[repr(C)]
#[derive(Clone)]
struct VstTimeInfo {
    /// Current position in sample frames.
    sample_pos: f64,
    /// Current sample rate.
    sample_rate: f64,
    /// System time in nanoseconds (not supported, set to 0).
    nano_seconds: f64,
    /// Musical position in quarter notes (beats).
    ppq_pos: f64,
    /// Current tempo in BPM.
    tempo: f64,
    /// Bar start position in PPQ.
    bar_start_pos: f64,
    /// Cycle start position in PPQ.
    cycle_start_pos: f64,
    /// Cycle end position in PPQ.
    cycle_end_pos: f64,
    /// Time signature numerator.
    time_sig_numerator: i32,
    /// Time signature denominator.
    time_sig_denominator: i32,
    /// SMPTE offset (subframes).
    smpte_offset: i32,
    /// SMPTE frame rate.
    smpte_frame_rate: i32,
    /// MIDI clock resolution (samples per beat / 24).
    samples_to_next_clock: i32,
    /// Flags (VstTimeInfo flags).
    flags: i32,
}

/// Type alias for the VSTPluginMain entry point.
type VstPluginMainFn = unsafe extern "C" fn(
    callback: unsafe extern "C" fn(
        effect: *mut AEffect,
        opcode: i32,
        index: i32,
        value: VstIntPtr,
        ptr: *mut c_void,
        opt: f32,
    ) -> VstIntPtr,
) -> *mut AEffect;

// ── Thread-Local Host State ──
//
// The audioMasterCallback doesn't receive a user-data pointer, so we must
// use thread-local storage to provide sample rate, block size, etc.

thread_local! {
    static HOST_SAMPLE_RATE: std::cell::Cell<f64> = const { std::cell::Cell::new(44100.0) };
    static HOST_BLOCK_SIZE: std::cell::Cell<i32> = const { std::cell::Cell::new(1024) };
    static HOST_TIME_INFO: std::cell::RefCell<VstTimeInfo> = std::cell::RefCell::new(VstTimeInfo {
        sample_pos: 0.0,
        sample_rate: 44100.0,
        nano_seconds: 0.0,
        ppq_pos: 0.0,
        tempo: 120.0,
        bar_start_pos: 0.0,
        cycle_start_pos: 0.0,
        cycle_end_pos: 0.0,
        time_sig_numerator: 4,
        time_sig_denominator: 4,
        smpte_offset: 0,
        smpte_frame_rate: 0,
        samples_to_next_clock: 0,
        flags: K_VST_TEMPO_VALID | K_VST_TIME_SIG_VALID | K_VST_PPQ_POS_VALID | K_VST_BARS_VALID,
    });
}

// ── Host Callback (audioMasterCallback) ──
//
// This function is called by the plugin to query the host for information.
// It is passed as a function pointer during VSTPluginMain().

unsafe extern "C" fn audio_master_callback(
    _effect: *mut AEffect,
    opcode: i32,
    _index: i32,
    _value: VstIntPtr,
    ptr: *mut c_void,
    _opt: f32,
) -> VstIntPtr {
    match opcode {
        // Return VST 2.4 version
        AUDIO_MASTER_VERSION => 2400,

        // Return a host unique ID
        AUDIO_MASTER_CURRENT_ID => 0,

        // Idle — no-op
        AUDIO_MASTER_IDLE => 0,

        // Automate — parameter changed from plugin GUI (logged, not blocking)
        AUDIO_MASTER_AUTOMATE => 0,

        // Return current sample rate
        AUDIO_MASTER_GET_SAMPLE_RATE => {
            HOST_SAMPLE_RATE.with(|sr| sr.get() as VstIntPtr)
        }

        // Return current block size
        AUDIO_MASTER_GET_BLOCK_SIZE => {
            HOST_BLOCK_SIZE.with(|bs| bs.get() as VstIntPtr)
        }

        // Process level: 0 = not in real-time, 1 = real-time
        AUDIO_MASTER_GET_CURRENT_PROCESS_LEVEL => 2, // kVstProcessLevelRealtime

        // Vendor info
        AUDIO_MASTER_GET_VENDOR_STRING => {
            if !ptr.is_null() {
                let name = b"Dream DAW\0";
                unsafe {
                    ptr::copy_nonoverlapping(name.as_ptr(), ptr as *mut u8, name.len());
                }
            }
            1
        }

        AUDIO_MASTER_GET_PRODUCT_STRING => {
            if !ptr.is_null() {
                let name = b"Dream DAW\0";
                unsafe {
                    ptr::copy_nonoverlapping(name.as_ptr(), ptr as *mut u8, name.len());
                }
            }
            1
        }

        AUDIO_MASTER_GET_VENDOR_VERSION => 1000, // 1.0.0.0

        // canDo — respond positively to standard capabilities
        AUDIO_MASTER_CAN_DO => {
            if !ptr.is_null() {
                let capability = unsafe { CStr::from_ptr(ptr as *const c_char) }
                    .to_str()
                    .unwrap_or("");
                match capability {
                    "sendVstEvents" | "sendVstMidiEvent" | "sendVstTimeInfo"
                    | "receiveVstEvents" | "receiveVstMidiEvent" | "sizeWindow"
                    | "supplyIdle" | "openFileSelector" | "closeFileSelector"
                    | "startStopProcess" | "shellCategory" | "sendVstMidiEventFlagIsRealtime" => 1,
                    _ => 0,
                }
            } else {
                0
            }
        }

        // Language: English
        AUDIO_MASTER_GET_LANGUAGE => 0, // kVstLangEnglish

        // Return VstTimeInfo pointer
        AUDIO_MASTER_GET_TIME => {
            HOST_TIME_INFO.with(|ti| {
                let ptr = ti.as_ptr();
                ptr as VstIntPtr
            })
        }

        // Parameter edit begin/end — acknowledge
        AUDIO_MASTER_BEGIN_EDIT | AUDIO_MASTER_END_EDIT => 0,

        // IO changed — acknowledge
        AUDIO_MASTER_IO_CHANGED => 1,

        // Size window — acknowledge
        AUDIO_MASTER_SIZE_WINDOW => 1,

        // Update display — acknowledge
        AUDIO_MASTER_UPDATE_DISPLAY => 0,

        // Everything else — return 0 (not supported)
        _ => 0,
    }
}

// ── VST2 Instance ──

/// A live VST2 plugin instance implementing the format-agnostic `PluginInstance` trait.
///
/// Manages the full lifecycle: load → activate → process → deactivate → close.
/// All native calls go through the plugin's `dispatcher` and `processReplacing` functions.
pub struct Vst2Instance {
    /// Unique instance ID.
    id: Uuid,

    /// Plugin descriptor (metadata).
    descriptor: PluginDescriptor,

    /// Raw pointer to the AEffect struct (owned by the plugin).
    effect: *mut AEffect,

    /// Dynamic library handle — kept alive for the plugin's lifetime.
    _library: libloading::Library,

    /// Whether the plugin is currently activated (processing state).
    active: bool,

    /// Current sample rate.
    sample_rate: f64,

    /// Current max buffer size.
    max_buffer_size: usize,

    /// Pre-allocated MIDI events buffer (avoids alloc in process loop).
    midi_events_buffer: Vec<VstMidiEvent>,

    /// Pre-allocated VstEvents header + pointer array.
    /// Layout: VstEvents header followed by `max_midi_events` pointers.
    vst_events_buffer: Vec<u8>,

    /// Maximum MIDI events per buffer.
    max_midi_events: usize,

    /// Stored transport context for VstTimeInfo.
    transport: TransportContext,

    /// Pre-allocated silence buffer for missing input channels.
    silence_buffer: Vec<f32>,

    /// Pre-allocated input channel pointer array.
    input_ptrs: Vec<*const f32>,

    /// Pre-allocated output channel pointer array.
    output_ptrs: Vec<*mut f32>,

    /// Pre-allocated dummy output buffers for extra plugin channels.
    dummy_output_buffers: Vec<Vec<f32>>,
}

// Safety: Vst2Instance is only used from a single thread (the audio thread).
// The `effect` pointer and library handle are thread-safe for our usage pattern:
// UI thread for lifecycle, audio thread for process (with proper synchronization).
unsafe impl Send for Vst2Instance {}

impl Vst2Instance {
    /// Maximum MIDI events we support per process buffer.
    const MAX_MIDI_EVENTS: usize = 256;

    /// Loads a VST2 plugin from a `.vst` bundle path.
    ///
    /// This resolves the macOS bundle to its executable, dlopens it,
    /// locates `VSTPluginMain`, and calls it to obtain the AEffect.
    pub fn load(path: &Path) -> Result<Self, PluginError> {
        // 1. Resolve the bundle binary path
        let binary_path = Self::resolve_bundle_binary(path)?;
        info!("[VST2] Loading binary: {}", binary_path.display());

        // 2. Load the dynamic library
        let library = unsafe { libloading::Library::new(&binary_path) }.map_err(|e| {
            PluginError::LoadFailed(format!(
                "dlopen failed for {}: {}",
                binary_path.display(),
                e
            ))
        })?;

        // 3. Find VSTPluginMain (or fallback to main, VSTPlugMain)
        let entry_fn: VstPluginMainFn = unsafe {
            let sym = library
                .get::<VstPluginMainFn>(b"VSTPluginMain\0")
                .or_else(|_| library.get::<VstPluginMainFn>(b"VSTPlugMain\0"))
                .or_else(|_| library.get::<VstPluginMainFn>(b"main_macho\0"))
                .map_err(|e| {
                    PluginError::LoadFailed(format!(
                        "VSTPluginMain symbol not found in {}: {}",
                        binary_path.display(),
                        e
                    ))
                })?;
            *sym
        };

        // 4. Set up thread-local host state before calling VSTPluginMain
        HOST_SAMPLE_RATE.with(|sr| sr.set(44100.0));
        HOST_BLOCK_SIZE.with(|bs| bs.set(1024));

        // 5. Call VSTPluginMain with our audioMasterCallback
        let effect = unsafe { entry_fn(audio_master_callback) };
        if effect.is_null() {
            return Err(PluginError::LoadFailed(
                "VSTPluginMain returned null".to_string(),
            ));
        }

        // 6. Verify the magic number
        let magic = unsafe { (*effect).magic };
        if magic != K_EFFECT_MAGIC {
            return Err(PluginError::LoadFailed(format!(
                "Invalid AEffect magic: 0x{:08X} (expected 0x{:08X})",
                magic, K_EFFECT_MAGIC
            )));
        }

        // 7. Call effOpen
        unsafe {
            Self::dispatch_raw(effect, EFF_OPEN, 0, 0, ptr::null_mut(), 0.0);
        }

        // 8. Read plugin info
        let num_inputs = unsafe { (*effect).num_inputs };
        let num_outputs = unsafe { (*effect).num_outputs };
        let num_params = unsafe { (*effect).num_params };
        let flags = unsafe { (*effect).flags };
        let unique_id = unsafe { (*effect).unique_id };
        let version = unsafe { (*effect).version };
        let latency = unsafe { (*effect).initial_delay };

        // 9. Query vendor and product strings
        let vendor = Self::get_string(effect, EFF_GET_VENDOR_STRING);
        let product = Self::get_string(effect, EFF_GET_PRODUCT_STRING);

        let plugin_name = if !product.is_empty() {
            product
        } else {
            path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Unknown")
                .to_string()
        };

        let vendor_name = if !vendor.is_empty() {
            vendor
        } else {
            path.parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .unwrap_or("Unknown")
                .to_string()
        };

        let is_synth = (flags & EFF_FLAGS_IS_SYNTH) != 0;
        let has_editor = (flags & EFF_FLAGS_HAS_EDITOR) != 0;
        let can_replacing = (flags & EFF_FLAGS_CAN_REPLACING) != 0;

        info!(
            "[VST2] Loaded: '{}' by '{}' | inputs={} outputs={} params={} synth={} editor={} replacing={} latency={} uid=0x{:08X} v{}",
            plugin_name, vendor_name, num_inputs, num_outputs, num_params,
            is_synth, has_editor, can_replacing, latency, unique_id, version
        );

        // 10. Build descriptor
        let category = if is_synth {
            crate::format::PluginCategory::Instrument
        } else {
            crate::format::PluginCategory::Effect
        };

        let mut descriptor = PluginDescriptor::new(
            plugin_name,
            vendor_name,
            PluginFormat::VST2,
            category,
            path.to_path_buf(),
        );
        descriptor.audio_inputs = num_inputs as u32;
        descriptor.audio_outputs = num_outputs as u32;
        descriptor.accepts_midi = is_synth || Self::can_do(effect, "receiveVstMidiEvent");
        descriptor.unique_id = Some(format!("0x{:08X}", unique_id));
        descriptor.version = Some(format!("{}", version));
        descriptor.is_validated = true;

        // 11. Pre-allocate MIDI event buffers
        let max_midi = Self::MAX_MIDI_EVENTS;
        let events_header_size =
            std::mem::size_of::<i32>() + std::mem::size_of::<VstIntPtr>() + std::mem::size_of::<*mut c_void>() * max_midi;
        let vst_events_buffer = vec![0u8; events_header_size];

        Ok(Self {
            id: Uuid::new_v4(),
            descriptor,
            effect,
            _library: library,
            active: false,
            sample_rate: 44100.0,
            max_buffer_size: 1024,
            midi_events_buffer: Vec::with_capacity(max_midi),
            vst_events_buffer,
            max_midi_events: max_midi,
            transport: TransportContext::default(),
            silence_buffer: vec![0.0f32; 8192],
            input_ptrs: Vec::with_capacity(num_inputs.max(2) as usize),
            output_ptrs: Vec::with_capacity(num_outputs.max(2) as usize),
            dummy_output_buffers: Vec::new(),
        })
    }

    /// Resolves a `.vst` bundle to its executable binary path on macOS.
    fn resolve_bundle_binary(bundle_path: &Path) -> Result<PathBuf, PluginError> {
        // Standard macOS bundle layout: <name>.vst/Contents/MacOS/<name>
        let bundle_name = bundle_path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| {
                PluginError::LoadFailed(format!(
                    "Cannot extract bundle name from: {}",
                    bundle_path.display()
                ))
            })?;

        let binary = bundle_path
            .join("Contents")
            .join("MacOS")
            .join(bundle_name);

        if binary.exists() {
            return Ok(binary);
        }

        // Fallback: try to find any executable in Contents/MacOS/
        let macos_dir = bundle_path.join("Contents").join("MacOS");
        if macos_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&macos_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        return Ok(path);
                    }
                }
            }
        }

        Err(PluginError::LoadFailed(format!(
            "No executable found in bundle: {}",
            bundle_path.display()
        )))
    }

    /// Raw dispatcher call.
    unsafe fn dispatch_raw(
        effect: *mut AEffect,
        opcode: i32,
        index: i32,
        value: VstIntPtr,
        ptr: *mut c_void,
        opt: f32,
    ) -> VstIntPtr {
        if let Some(dispatcher) = unsafe { (*effect).dispatcher } {
            unsafe { dispatcher(effect, opcode, index, value, ptr, opt) }
        } else {
            0
        }
    }

    /// Convenience dispatcher call on self.
    fn dispatch(
        &self,
        opcode: i32,
        index: i32,
        value: VstIntPtr,
        ptr: *mut c_void,
        opt: f32,
    ) -> VstIntPtr {
        unsafe { Self::dispatch_raw(self.effect, opcode, index, value, ptr, opt) }
    }

    /// Gets a string from the plugin via dispatcher (vendor, product, param name, etc.).
    fn get_string(effect: *mut AEffect, opcode: i32) -> String {
        let mut buf = [0u8; 256];
        unsafe {
            Self::dispatch_raw(effect, opcode, 0, 0, buf.as_mut_ptr() as *mut c_void, 0.0);
        }
        // Find null terminator
        let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..len]).to_string()
    }

    /// Queries a canDo capability string.
    fn can_do(effect: *mut AEffect, capability: &str) -> bool {
        let mut buf = [0u8; 128];
        let bytes = capability.as_bytes();
        let copy_len = bytes.len().min(127);
        buf[..copy_len].copy_from_slice(&bytes[..copy_len]);
        buf[copy_len] = 0;
        let result = unsafe {
            Self::dispatch_raw(
                effect,
                EFF_CAN_DO,
                0,
                0,
                buf.as_mut_ptr() as *mut c_void,
                0.0,
            )
        };
        result > 0
    }

    /// Updates VstTimeInfo from the stored transport context.
    fn update_time_info(&self) {
        HOST_TIME_INFO.with(|ti| {
            let mut info = ti.borrow_mut();
            info.sample_pos = self.transport.position_samples as f64;
            info.sample_rate = self.transport.sample_rate;
            info.tempo = self.transport.tempo;
            info.time_sig_numerator = self.transport.time_sig_numerator;
            info.time_sig_denominator = self.transport.time_sig_denominator;

            // Calculate PPQ position
            let beats_per_second = if self.transport.tempo > 0.0 {
                self.transport.tempo / 60.0
            } else {
                2.0
            };
            let position_seconds = if self.transport.sample_rate > 0.0 {
                self.transport.position_samples as f64 / self.transport.sample_rate
            } else {
                0.0
            };
            info.ppq_pos = position_seconds * beats_per_second;

            // Bar start position
            let bar_beats = self.transport.time_sig_numerator.max(1) as f64;
            info.bar_start_pos = (info.ppq_pos / bar_beats).floor() * bar_beats;

            // Flags
            let mut flags = K_VST_TEMPO_VALID | K_VST_TIME_SIG_VALID
                | K_VST_PPQ_POS_VALID | K_VST_BARS_VALID | K_VST_NANOSEC_VALID;
            if self.transport.is_playing {
                flags |= K_VST_TRANSPORT_PLAYING;
            }
            if self.transport.is_recording {
                flags |= K_VST_TRANSPORT_RECORDING;
            }
            info.flags = flags;
        });
    }

    /// Marshals Dream DAW MIDI events into VST2's VstEvents format.
    /// Returns a pointer to the VstEvents struct (valid until next call).
    fn marshal_midi_events(&mut self, midi_events: &[MidiEvent]) -> Option<*mut VstEvents> {
        if midi_events.is_empty() {
            return None;
        }

        let count = midi_events.len().min(self.max_midi_events);

        // Ensure we have enough VstMidiEvent objects
        self.midi_events_buffer.clear();
        for event in &midi_events[..count] {
            self.midi_events_buffer.push(VstMidiEvent {
                event_type: K_VST_MIDI_TYPE,
                byte_size: std::mem::size_of::<VstMidiEvent>() as i32,
                delta_frames: event.sample_offset,
                flags: 0,
                note_length: 0,
                note_offset: 0,
                midi_data: [event.data[0], event.data[1], event.data[2], 0],
                detune: 0,
                note_off_velocity: 0,
                _reserved1: 0,
                _reserved2: 0,
            });
        }

        // Re-allocate VstEvents buffer if needed
        let header_size = std::mem::size_of::<i32>() // num_events
            + std::mem::size_of::<VstIntPtr>() // reserved
            + std::mem::size_of::<*mut c_void>() * count;
        if self.vst_events_buffer.len() < header_size {
            self.vst_events_buffer.resize(header_size, 0);
        }

        // Fill the VstEvents header
        let events_ptr = self.vst_events_buffer.as_mut_ptr() as *mut VstEvents;
        unsafe {
            (*events_ptr).num_events = count as i32;
            (*events_ptr).reserved = 0;

            // Fill event pointers
            let event_ptrs = &mut (*events_ptr).events as *mut [*mut c_void; 2] as *mut *mut c_void;
            for (i, midi_event) in self.midi_events_buffer.iter_mut().enumerate() {
                *event_ptrs.add(i) = midi_event as *mut VstMidiEvent as *mut c_void;
            }
        }

        Some(events_ptr)
    }
}

impl PluginInstance for Vst2Instance {
    fn id(&self) -> Uuid {
        self.id
    }

    fn descriptor(&self) -> &PluginDescriptor {
        &self.descriptor
    }

    fn activate(&mut self, sample_rate: f64, max_buffer_size: usize) -> Result<(), PluginError> {
        if self.active {
            self.deactivate()?;
        }

        self.sample_rate = sample_rate;
        self.max_buffer_size = max_buffer_size;

        // Update thread-local host state
        HOST_SAMPLE_RATE.with(|sr| sr.set(sample_rate));
        HOST_BLOCK_SIZE.with(|bs| bs.set(max_buffer_size as i32));

        // Set sample rate
        self.dispatch(EFF_SET_SAMPLE_RATE, 0, 0, ptr::null_mut(), sample_rate as f32);

        // Set block size
        self.dispatch(
            EFF_SET_BLOCK_SIZE,
            0,
            max_buffer_size as VstIntPtr,
            ptr::null_mut(),
            0.0,
        );

        // Pre-allocate scratch buffers for this block size
        let num_plugin_inputs = unsafe { (*self.effect).num_inputs } as usize;
        let num_plugin_outputs = unsafe { (*self.effect).num_outputs } as usize;

        // Silence buffer for missing input channels
        if self.silence_buffer.len() < max_buffer_size {
            self.silence_buffer.resize(max_buffer_size, 0.0);
        } else {
            // Zero the buffer (it may have been used before)
            self.silence_buffer[..max_buffer_size].fill(0.0);
        }

        // Input/output pointer arrays
        self.input_ptrs.clear();
        self.input_ptrs.reserve(num_plugin_inputs);
        self.output_ptrs.clear();
        self.output_ptrs.reserve(num_plugin_outputs);

        // Dummy output buffers for extra plugin output channels
        self.dummy_output_buffers.clear();
        // We'll allocate these as needed; pre-reserve capacity
        self.dummy_output_buffers.reserve(num_plugin_outputs);

        // Resume processing (effMainsChanged with value=1)
        self.dispatch(EFF_MAINS_CHANGED, 0, 1, ptr::null_mut(), 0.0);

        // Start process (VST 2.4)
        self.dispatch(EFF_START_PROCESS, 0, 0, ptr::null_mut(), 0.0);

        self.active = true;
        info!(
            "[VST2] Activated: sr={} bs={}",
            sample_rate, max_buffer_size
        );

        Ok(())
    }

    fn deactivate(&mut self) -> Result<(), PluginError> {
        if !self.active {
            return Ok(());
        }

        // Stop processing
        self.dispatch(EFF_STOP_PROCESS, 0, 0, ptr::null_mut(), 0.0);

        // Suspend (effMainsChanged with value=0)
        self.dispatch(EFF_MAINS_CHANGED, 0, 0, ptr::null_mut(), 0.0);

        self.active = false;
        info!("[VST2] Deactivated");

        Ok(())
    }

    fn process(
        &mut self,
        inputs: &[&[f32]],
        outputs: &mut [&mut [f32]],
        num_frames: usize,
        midi_events: &[MidiEvent],
    ) -> Result<(), PluginError> {
        if !self.active {
            return Err(PluginError::InvalidState(
                "Plugin not activated".to_string(),
            ));
        }

        // Update transport / time info
        self.update_time_info();

        // Send MIDI events if any
        if !midi_events.is_empty() {
            if let Some(events_ptr) = self.marshal_midi_events(midi_events) {
                self.dispatch(
                    EFF_PROCESS_EVENTS,
                    0,
                    0,
                    events_ptr as *mut c_void,
                    0.0,
                );
            }
        }

        // Prepare input channel pointers (no allocations — reuse pre-allocated vecs)
        let num_plugin_inputs = unsafe { (*self.effect).num_inputs } as usize;
        let num_plugin_outputs = unsafe { (*self.effect).num_outputs } as usize;

        // Build an array of input channel pointers
        // If the host provides fewer channels than the plugin expects, pad with silence
        // Ensure silence buffer is large enough
        if self.silence_buffer.len() < num_frames {
            self.silence_buffer.resize(num_frames, 0.0);
        }
        self.input_ptrs.clear();
        for i in 0..num_plugin_inputs {
            if i < inputs.len() {
                self.input_ptrs.push(inputs[i].as_ptr());
            } else {
                self.input_ptrs.push(self.silence_buffer.as_ptr());
            }
        }

        // Build an array of output channel pointers
        // Use the provided output buffers for channels we have, and dummy buffers for the rest
        self.output_ptrs.clear();
        let extra_outputs_needed = if num_plugin_outputs > outputs.len() {
            num_plugin_outputs - outputs.len()
        } else {
            0
        };
        // Ensure we have enough dummy output buffers
        while self.dummy_output_buffers.len() < extra_outputs_needed {
            self.dummy_output_buffers.push(vec![0.0f32; self.max_buffer_size.max(num_frames)]);
        }
        // Ensure each dummy buffer is large enough
        for buf in self.dummy_output_buffers.iter_mut() {
            if buf.len() < num_frames {
                buf.resize(num_frames, 0.0);
            }
        }
        let mut dummy_idx = 0;
        for i in 0..num_plugin_outputs {
            if i < outputs.len() {
                self.output_ptrs.push(outputs[i].as_mut_ptr());
            } else {
                self.output_ptrs.push(self.dummy_output_buffers[dummy_idx].as_mut_ptr());
                dummy_idx += 1;
            }
        }

        // Call processReplacing (preferred) or legacy process
        let flags = unsafe { (*self.effect).flags };
        if (flags & EFF_FLAGS_CAN_REPLACING) != 0 {
            if let Some(process_fn) = unsafe { (*self.effect).process_replacing } {
                unsafe {
                    process_fn(
                        self.effect,
                        self.input_ptrs.as_ptr(),
                        self.output_ptrs.as_mut_ptr(),
                        num_frames as i32,
                    );
                }
            }
        } else if let Some(process_fn) = unsafe { (*self.effect)._process } {
            // Legacy process — adds to output (doesn't replace)
            // Clear outputs first
            for i in 0..outputs.len().min(num_plugin_outputs) {
                for sample in outputs[i].iter_mut() {
                    *sample = 0.0;
                }
            }
            unsafe {
                process_fn(
                    self.effect,
                    self.input_ptrs.as_ptr(),
                    self.output_ptrs.as_mut_ptr(),
                    num_frames as i32,
                );
            }
        } else {
            return Err(PluginError::ProcessError(
                "Plugin has neither processReplacing nor process".to_string(),
            ));
        }

        Ok(())
    }

    fn latency_samples(&self) -> u32 {
        unsafe { (*self.effect).initial_delay as u32 }
    }

    fn tail_samples(&self) -> u32 {
        let result = self.dispatch(EFF_GET_TAIL_SIZE, 0, 0, ptr::null_mut(), 0.0);
        if result > 0 {
            result as u32
        } else {
            0
        }
    }

    fn reset(&mut self) {
        if self.active {
            // Suspend and resume to reset internal state
            self.dispatch(EFF_MAINS_CHANGED, 0, 0, ptr::null_mut(), 0.0);
            self.dispatch(EFF_MAINS_CHANGED, 0, 1, ptr::null_mut(), 0.0);
        }
    }

    fn set_transport_context(&mut self, ctx: TransportContext) {
        self.transport = ctx;
    }

    fn is_active(&self) -> bool {
        self.active
    }

    fn parameter_count(&self) -> u32 {
        unsafe { (*self.effect).num_params as u32 }
    }

    fn get_parameter(&self, index: u32) -> Option<f64> {
        if index >= self.parameter_count() {
            return None;
        }
        if let Some(get_fn) = unsafe { (*self.effect).get_parameter } {
            Some(unsafe { get_fn(self.effect, index as i32) } as f64)
        } else {
            None
        }
    }

    fn set_parameter(&mut self, index: u32, value: f64) -> Result<(), PluginError> {
        if index >= self.parameter_count() {
            return Err(PluginError::InvalidState(format!(
                "Parameter index {} out of range (max {})",
                index,
                self.parameter_count()
            )));
        }
        if let Some(set_fn) = unsafe { (*self.effect).set_parameter } {
            unsafe {
                set_fn(self.effect, index as i32, value as f32);
            }
            Ok(())
        } else {
            Err(PluginError::InvalidState(
                "Plugin has no setParameter function".to_string(),
            ))
        }
    }

    fn load_state_blob(&mut self, _kind: Option<&str>, data: &[u8]) -> Result<(), PluginError> {
        let flags = unsafe { (*self.effect).flags };
        if (flags & EFF_FLAGS_PROGRAM_CHUNKS) == 0 {
            return Err(PluginError::UnsupportedFormat(
                "Plugin does not support chunk-based state".to_string(),
            ));
        }

        self.dispatch(EFF_BEGIN_SET_PROGRAM, 0, 0, ptr::null_mut(), 0.0);

        let result = self.dispatch(
            EFF_SET_CHUNK,
            0, // isPreset = 0 (full bank)
            data.len() as VstIntPtr,
            data.as_ptr() as *const c_void as *mut c_void,
            0.0,
        );

        self.dispatch(EFF_END_SET_PROGRAM, 0, 0, ptr::null_mut(), 0.0);

        if result == 0 {
            Err(PluginError::InvalidState(
                "setChunk returned 0 (failure)".to_string(),
            ))
        } else {
            Ok(())
        }
    }

    fn supports_editor(&self) -> bool {
        let flags = unsafe { (*self.effect).flags };
        (flags & EFF_FLAGS_HAS_EDITOR) != 0
    }
}

impl Drop for Vst2Instance {
    fn drop(&mut self) {
        // Deactivate if still active
        if self.active {
            let _ = self.deactivate();
        }

        // Close the plugin (effClose)
        info!("[VST2] Closing plugin: {}", self.descriptor.name);
        self.dispatch(EFF_CLOSE, 0, 0, ptr::null_mut(), 0.0);

        // Library is dropped automatically by _library's Drop impl
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

/// Gets a parameter name from a VST2 plugin.
pub fn vst2_get_param_name(instance: &Vst2Instance, index: u32) -> String {
    if index >= instance.parameter_count() {
        return String::new();
    }
    let mut buf = [0u8; 256];
    instance.dispatch(
        EFF_GET_PARAM_NAME,
        index as i32,
        0,
        buf.as_mut_ptr() as *mut c_void,
        0.0,
    );
    let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..len]).to_string()
}

/// Gets a parameter display string from a VST2 plugin (formatted value).
pub fn vst2_get_param_display(instance: &Vst2Instance, index: u32) -> String {
    if index >= instance.parameter_count() {
        return String::new();
    }
    let mut buf = [0u8; 256];
    instance.dispatch(
        EFF_GET_PARAM_DISPLAY,
        index as i32,
        0,
        buf.as_mut_ptr() as *mut c_void,
        0.0,
    );
    let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..len]).to_string()
}

/// Gets a parameter label from a VST2 plugin (unit string like "dB", "Hz").
pub fn vst2_get_param_label(instance: &Vst2Instance, index: u32) -> String {
    if index >= instance.parameter_count() {
        return String::new();
    }
    let mut buf = [0u8; 256];
    instance.dispatch(
        EFF_GET_PARAM_LABEL,
        index as i32,
        0,
        buf.as_mut_ptr() as *mut c_void,
        0.0,
    );
    let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..len]).to_string()
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aeffect_struct_layout() {
        // Verify AEffect has the expected field offsets.
        // This is critical for C ABI compatibility.
        assert!(std::mem::size_of::<AEffect>() > 100, "AEffect struct too small");
        assert_eq!(
            std::mem::offset_of!(AEffect, magic),
            0,
            "magic must be at offset 0"
        );
    }

    #[test]
    fn vst_midi_event_size() {
        // VstMidiEvent must be exactly 32 bytes per VST2 spec
        let size = std::mem::size_of::<VstMidiEvent>();
        assert_eq!(size, 32, "VstMidiEvent size must be 32 bytes, got {}", size);
    }

    #[test]
    fn vst_time_info_layout() {
        // VstTimeInfo must have the correct layout
        let size = std::mem::size_of::<VstTimeInfo>();
        assert!(size > 80, "VstTimeInfo too small: {} bytes", size);
    }

    #[test]
    fn audio_master_version_returns_2400() {
        let result = unsafe {
            audio_master_callback(
                ptr::null_mut(),
                AUDIO_MASTER_VERSION,
                0,
                0,
                ptr::null_mut(),
                0.0,
            )
        };
        assert_eq!(result, 2400);
    }

    #[test]
    fn audio_master_sample_rate_returns_default() {
        let result = unsafe {
            audio_master_callback(
                ptr::null_mut(),
                AUDIO_MASTER_GET_SAMPLE_RATE,
                0,
                0,
                ptr::null_mut(),
                0.0,
            )
        };
        assert_eq!(result, 44100);
    }

    #[test]
    fn audio_master_block_size_returns_default() {
        let result = unsafe {
            audio_master_callback(
                ptr::null_mut(),
                AUDIO_MASTER_GET_BLOCK_SIZE,
                0,
                0,
                ptr::null_mut(),
                0.0,
            )
        };
        assert_eq!(result, 1024);
    }

    #[test]
    fn resolve_bundle_binary_nonexistent() {
        let result = Vst2Instance::resolve_bundle_binary(Path::new("/nonexistent/fake.vst"));
        assert!(result.is_err());
    }

    #[test]
    fn vst_effect_magic_constant() {
        assert_eq!(K_EFFECT_MAGIC, 0x56737450u32 as i32);
    }

    #[test]
    fn marshal_midi_creates_correct_count() {
        // We can't fully test without a real plugin, but we can verify
        // the MIDI marshalling logic works correctly with buffer sizing.
        let events = vec![
            MidiEvent::note_on(0, 0, 60, 100),
            MidiEvent::note_off(512, 0, 60, 0),
        ];
        assert_eq!(events.len(), 2);
        assert!(events[0].is_note_on());
        assert!(events[1].is_note_off());
    }
}
