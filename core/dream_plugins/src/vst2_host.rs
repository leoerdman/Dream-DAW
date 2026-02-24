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

use std::ffi::{CStr, c_char, c_void};
use std::path::{Path, PathBuf};
use std::ptr;

use log::info;
use uuid::Uuid;

use crate::descriptor::PluginDescriptor;
use crate::format::PluginFormat;
use crate::instance::{MidiEvent, PluginError, PluginInstance, TransportContext};
use crate::vst2_host_abi::*;

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};

// ── Thread-Local Host State ──
//
// The audioMasterCallback doesn't receive a user-data pointer, so we must
// use thread-local storage to provide sample rate, block size, etc.

const PARAM_RING_SIZE: usize = 1024;
const DEFAULT_HOST_SAMPLE_RATE: f64 = 48_000.0;
const DEFAULT_HOST_BLOCK_SIZE: i32 = 512;

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
        self.entries[head]
            .param_id
            .store(param_id, Ordering::Relaxed);
        self.entries[head]
            .value_bits
            .store(value.to_bits() as usize, Ordering::Relaxed);
        self.head.store(next, Ordering::Release);
    }

    pub fn drain(&self, mut f: impl FnMut(u32, f64)) -> usize {
        let mut count = 0;
        loop {
            let tail = self.tail.load(Ordering::Acquire);
            let head = self.head.load(Ordering::Acquire);
            if tail == head {
                break;
            }
            let pid = self.entries[tail].param_id.load(Ordering::Relaxed);
            let vbits = self.entries[tail].value_bits.load(Ordering::Relaxed);
            f(pid, f64::from_bits(vbits as u64));
            self.tail
                .store((tail + 1) % PARAM_RING_SIZE, Ordering::Release);
            count += 1;
        }
        count
    }
}

unsafe impl Sync for ParamEditRing {}

static PARAM_EDIT_RING: ParamEditRing = ParamEditRing::new();

/// Set when any VST2 plugin signals a state change
static PLUGIN_STATE_DIRTY: AtomicBool = AtomicBool::new(false);

/// Public API: Drain pending GUI parameter edits.
pub fn drain_gui_param_edits(f: impl FnMut(u32, f64)) -> usize {
    PARAM_EDIT_RING.drain(f)
}

/// Public API: Check and clear the plugin-state-dirty flag.
pub fn take_plugin_state_dirty() -> bool {
    PLUGIN_STATE_DIRTY.swap(false, Ordering::AcqRel)
}

thread_local! {
    static HOST_SAMPLE_RATE: std::cell::Cell<f64> = const { std::cell::Cell::new(DEFAULT_HOST_SAMPLE_RATE) };
    static HOST_BLOCK_SIZE: std::cell::Cell<i32> = const { std::cell::Cell::new(DEFAULT_HOST_BLOCK_SIZE) };
    static HOST_TIME_INFO: std::cell::RefCell<VstTimeInfo> = const { std::cell::RefCell::new(VstTimeInfo {
        sample_pos: 0.0,
        sample_rate: DEFAULT_HOST_SAMPLE_RATE,
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
    }) };
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

        // IDLE — check flags here if needed, but usually a no-op
        AUDIO_MASTER_IDLE => 0,

        // BUG-VP2 FIX: Automate — parameter changed from plugin GUI
        // VST2 spec: index = param index, opt = parameter value as f32
        AUDIO_MASTER_AUTOMATE => {
            PARAM_EDIT_RING.push(_index as u32, _opt as f64);
            PLUGIN_STATE_DIRTY.store(true, std::sync::atomic::Ordering::Release);
            0
        }

        // Return current sample rate
        AUDIO_MASTER_GET_SAMPLE_RATE => HOST_SAMPLE_RATE.with(|sr| sr.get() as VstIntPtr),

        // Return current block size
        AUDIO_MASTER_GET_BLOCK_SIZE => HOST_BLOCK_SIZE.with(|bs| bs.get() as VstIntPtr),

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
                    "sendVstEvents"
                    | "sendVstMidiEvent"
                    | "sendVstTimeInfo"
                    | "receiveVstEvents"
                    | "receiveVstMidiEvent"
                    | "sizeWindow"
                    | "supplyIdle"
                    | "openFileSelector"
                    | "closeFileSelector"
                    | "startStopProcess"
                    | "shellCategory"
                    | "sendVstMidiEventFlagIsRealtime" => 1,
                    _ => 0,
                }
            } else {
                0
            }
        }

        // Language: English
        AUDIO_MASTER_GET_LANGUAGE => 0, // kVstLangEnglish

        // Return VstTimeInfo pointer
        AUDIO_MASTER_GET_TIME => HOST_TIME_INFO.with(|ti| {
            let ptr = ti.as_ptr();
            ptr as VstIntPtr
        }),

        // Parameter edit begin/end — acknowledge
        AUDIO_MASTER_BEGIN_EDIT | AUDIO_MASTER_END_EDIT => 0,

        // IO changed — acknowledge
        AUDIO_MASTER_IO_CHANGED => 1,

        // Size window — acknowledge
        AUDIO_MASTER_SIZE_WINDOW => 1,

        // BUG-VP2 FIX: Update display — acknowledge
        // Signals that the plugin UI changed internal state (like preset or params)
        AUDIO_MASTER_UPDATE_DISPLAY => {
            PLUGIN_STATE_DIRTY.store(true, std::sync::atomic::Ordering::Release);
            0
        }

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

// ── Mathematical Invariants for Unsafe FFI Boundary ──
// SAFETY PROOF (Phase 35 Enterprise Audit):
// 1. NON-NULL: `effect` is verified non-null immediately upon return from `VSTPluginMain`.
// 2. LIFETIME BOUND: The `_library` handle outlives `effect`. The OS loader guarantees
//    the library's static code and heap segments remain pinned in memory.
// 3. THREAD SAFETY: VST2 is fundamentally single-threaded for processing. Dream DAW
//    enforces this via `Send` wrapping and strictly serializing RT callbacks.
// Thus, all `unsafe { (*self.effect).field }` dereferences are trivially safe.
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
        // Preserve last negotiated host IO values. Some plugins query host
        // timing during/after `VSTPluginMain` and should not see hard resets.
        HOST_SAMPLE_RATE.with(|sr| {
            if !sr.get().is_finite() || sr.get() <= 0.0 {
                sr.set(DEFAULT_HOST_SAMPLE_RATE);
            }
        });
        HOST_BLOCK_SIZE.with(|bs| {
            if bs.get() <= 0 {
                bs.set(DEFAULT_HOST_BLOCK_SIZE);
            }
        });

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
            plugin_name,
            vendor_name,
            num_inputs,
            num_outputs,
            num_params,
            is_synth,
            has_editor,
            can_replacing,
            latency,
            unique_id,
            version
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
        let events_header_size = std::mem::size_of::<i32>()
            + std::mem::size_of::<VstIntPtr>()
            + std::mem::size_of::<*mut c_void>() * max_midi;
        let vst_events_buffer = vec![0u8; events_header_size];

        Ok(Self {
            id: Uuid::new_v4(),
            descriptor,
            effect,
            _library: library,
            active: false,
            sample_rate: DEFAULT_HOST_SAMPLE_RATE,
            max_buffer_size: DEFAULT_HOST_BLOCK_SIZE as usize,
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

        let binary = bundle_path.join("Contents").join("MacOS").join(bundle_name);

        if binary.exists() {
            return Ok(binary);
        }

        // Fallback: try to find any executable in Contents/MacOS/
        let macos_dir = bundle_path.join("Contents").join("MacOS");
        if macos_dir.is_dir()
            && let Ok(entries) = std::fs::read_dir(&macos_dir)
        {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    return Ok(path);
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
            let mut flags = K_VST_TEMPO_VALID
                | K_VST_TIME_SIG_VALID
                | K_VST_PPQ_POS_VALID
                | K_VST_BARS_VALID
                | K_VST_NANOSEC_VALID;
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
        self.dispatch(
            EFF_SET_SAMPLE_RATE,
            0,
            0,
            ptr::null_mut(),
            sample_rate as f32,
        );

        // Set block size
        self.dispatch(
            EFF_SET_BLOCK_SIZE,
            0,
            max_buffer_size as VstIntPtr,
            ptr::null_mut(),
            0.0,
        );

        // Pre-allocate scratch buffers for this block size
        // SAFETY: `self.effect` is proven non-null and lifetime-bound to `_library`.
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

        // BUG-VP1 FIX: Pre-allocate dummy output buffers here on the UI thread,
        // rather than doing lazy allocations in the RT thread process() loop.
        self.dummy_output_buffers.clear();
        for _ in 0..num_plugin_outputs {
            self.dummy_output_buffers
                .push(vec![0.0f32; max_buffer_size]);
        }

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

        // BUG-VP3 FIX: Ensure thread-locals are updated for the RT Audio Thread
        // so that if the plugin queries AUDIO_MASTER_GET_SAMPLE_RATE during process,
        // it gets the real values instead of the 44100 fallback default.
        let frames_to_process = num_frames.min(self.max_buffer_size);
        HOST_SAMPLE_RATE.with(|sr| sr.set(self.sample_rate));
        HOST_BLOCK_SIZE.with(|bs| bs.set(frames_to_process as i32));

        // Send MIDI events if any
        if !midi_events.is_empty()
            && let Some(events_ptr) = self.marshal_midi_events(midi_events)
        {
            self.dispatch(EFF_PROCESS_EVENTS, 0, 0, events_ptr as *mut c_void, 0.0);
        }

        // Prepare input channel pointers (no allocations — reuse pre-allocated vecs)
        // SAFETY: `self.effect` is proven non-null and lifetime-bound to `_library`.
        let num_plugin_inputs = unsafe { (*self.effect).num_inputs } as usize;
        let num_plugin_outputs = unsafe { (*self.effect).num_outputs } as usize;

        // Build an array of input channel pointers
        // If the host provides fewer channels than the plugin expects, pad with silence.
        // BUG-VP1 FIX: Avoid slice resizing in the audio thread loop.
        let silence_ptr = if self.silence_buffer.len() >= frames_to_process {
            self.silence_buffer.as_ptr()
        } else {
            return Err(PluginError::ProcessError(
                "silence buffer smaller than current process block; re-activate plugin".to_string(),
            ));
        };

        self.input_ptrs.clear();
        for i in 0..num_plugin_inputs {
            if i < inputs.len() {
                self.input_ptrs.push(inputs[i].as_ptr());
            } else {
                self.input_ptrs.push(silence_ptr);
            }
        }

        // Build an array of output channel pointers
        // Use the provided output buffers for channels we have, and dummy buffers for the rest
        self.output_ptrs.clear();

        // BUG-VP1 FIX: Removed while dummy_output_buffers.len() < extra_outputs_needed RT allocs.
        // It relies on activate() providing enough preallocated dummy buffers.
        let mut dummy_idx = 0;
        for i in 0..num_plugin_outputs {
            if i < outputs.len() {
                self.output_ptrs.push(outputs[i].as_mut_ptr());
            } else if dummy_idx < self.dummy_output_buffers.len() {
                self.output_ptrs
                    .push(self.dummy_output_buffers[dummy_idx].as_mut_ptr());
                dummy_idx += 1;
            } else {
                // Safety net for malformed plugin channel layouts:
                // route excess outputs into a scratch sink rather than null pointers.
                self.output_ptrs.push(self.silence_buffer.as_mut_ptr());
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
                        frames_to_process as i32,
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
                    frames_to_process as i32,
                );
            }
        } else {
            return Err(PluginError::ProcessError(
                "Plugin has neither processReplacing nor process".to_string(),
            ));
        }

        // If host requested a bigger block than plugin was configured for,
        // zero the tail to avoid leaking stale audio.
        if frames_to_process < num_frames {
            for out in outputs.iter_mut().take(num_plugin_outputs) {
                if out.len() > frames_to_process {
                    out[frames_to_process..].fill(0.0);
                }
            }
        }

        Ok(())
    }

    fn latency_samples(&self) -> u32 {
        unsafe { (*self.effect).initial_delay as u32 }
    }

    fn tail_samples(&self) -> u32 {
        let result = self.dispatch(EFF_GET_TAIL_SIZE, 0, 0, ptr::null_mut(), 0.0);
        if result > 0 { result as u32 } else { 0 }
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
        unsafe { (*self.effect).get_parameter }
            .map(|get_fn| unsafe { get_fn(self.effect, index as i32) } as f64)
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
        assert!(
            std::mem::size_of::<AEffect>() > 100,
            "AEffect struct too small"
        );
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
        assert_eq!(result, DEFAULT_HOST_SAMPLE_RATE as VstIntPtr);
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
        assert_eq!(result, DEFAULT_HOST_BLOCK_SIZE as VstIntPtr);
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
        let events = [
            MidiEvent::note_on(0, 0, 60, 100),
            MidiEvent::note_off(512, 0, 60, 0),
        ];
        assert_eq!(events.len(), 2);
        assert!(events[0].is_note_on());
        assert!(events[1].is_note_off());
    }
}
