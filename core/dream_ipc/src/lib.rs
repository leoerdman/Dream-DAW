// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Lock-Free Inter-Thread Communication
// ═══════════════════════════════════════════════════════════════════════════
//
// This crate is the ONLY bridge between the non-real-time world (UI/Tauri)
// and the real-time world (cpal audio callback). Every byte of data that
// crosses this boundary does so via lock-free, wait-free SPSC ring buffers.
//
// Architecture:
//   UI Thread ──[rtrb::Producer]──▶ Audio Callback ──[rtrb::Consumer]──▶
//
// Forbidden on the audio side: Mutex, RwLock, condvar, malloc, syscalls.
//
// ═══════════════════════════════════════════════════════════════════════════

use std::sync::atomic::{AtomicI64, Ordering};

// ── Re-export rtrb types for consumers of this crate ────────────────────
pub use rtrb;

pub mod metering;
pub mod prealloc_queue;

// ── Flow Synth Graph Descriptors ────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FlowNodeType {
    Oscillator, Filter, Envelope, Eq, AutoFilter, Reverse, Output, MidiIn, Lfo, Noise, 
    Delay, Mixer, Multiply, Vca, Utility, Add, SampleHold, AudioIn, Pitch, Distortion, Vst3, Unknown
}

impl FlowNodeType {
    pub fn from_str(s: &str) -> Self {
        match s {
            "oscillator" => Self::Oscillator,
            "filter" => Self::Filter,
            "envelope" => Self::Envelope,
            "eq" => Self::Eq,
            "autofilter" => Self::AutoFilter,
            "reverse" => Self::Reverse,
            "output" => Self::Output,
            "midiIn" | "midi_in" => Self::MidiIn,
            "lfo" => Self::Lfo,
            "noise" => Self::Noise,
            "delay" => Self::Delay,
            "mixer" => Self::Mixer,
            "multiply" => Self::Multiply,
            "vca" => Self::Vca,
            "utility" => Self::Utility,
            "add" => Self::Add,
            "sampleHold" | "sample_hold" => Self::SampleHold,
            "audioIn" | "audio_in" => Self::AudioIn,
            "pitch" => Self::Pitch,
            "distortion" => Self::Distortion,
            "vst3" => Self::Vst3,
            _ => Self::Unknown,
        }
    }
}

/// BUG-003 FIX: Returns (input_port_count, output_port_count) for a given FlowNodeType.
/// SSOT mirror of frontend PORT_REGISTRY — used for server-side validation of port indices
/// before dispatching connections to the audio thread.
pub fn flow_port_counts(node_type: FlowNodeType) -> (usize, usize) {
    match node_type {
        FlowNodeType::MidiIn      => (0, 3), // → freq, velocity, gate
        FlowNodeType::Oscillator  => (4, 1), // freq, pw, fm, pm → audio
        FlowNodeType::Filter      => (3, 1), // audio, cutoff, resonance → audio
        FlowNodeType::Envelope    => (5, 1), // gate, attack, decay, sustain, release → cv
        FlowNodeType::Eq          => (4, 1), // audio, low, mid, high → audio
        FlowNodeType::AutoFilter  => (6, 1), // audio, cutoff, resonance, rate, depth, env → audio
        FlowNodeType::Reverse     => (1, 1), // audio → audio
        FlowNodeType::AudioIn     => (0, 1), // → audio
        FlowNodeType::Output      => (1, 0), // audio →
        FlowNodeType::Lfo         => (2, 2), // rate_mod, reset → signal, phase
        FlowNodeType::Noise       => (0, 1), // → audio
        FlowNodeType::Add         => (2, 1), // a, b → sum
        FlowNodeType::Multiply    => (2, 1), // a, b → product
        FlowNodeType::SampleHold  => (2, 1), // signal, trigger → held
        FlowNodeType::Delay       => (3, 1), // audio, time, feedback → audio
        FlowNodeType::Mixer       => (4, 1), // ch1..ch4 → audio
        FlowNodeType::Vca         => (2, 1), // audio, cv → audio
        FlowNodeType::Pitch       => (2, 1), // freq, octave → freq_out
        FlowNodeType::Utility     => (3, 1), // audio, gain, pan → audio
        FlowNodeType::Distortion  => (3, 1), // audio, drive, mix → audio
        FlowNodeType::Vst3        => (2, 1), // audio, midi → audio
        FlowNodeType::Unknown     => (8, 8), // generous fallback — never blocks valid data
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FlowParamKey {
    Waveform, Frequency, PulseWidth, FilterType, Cutoff, Resonance, EqLow, EqMid, EqHigh,
    Rate, Depth, EnvDepth, WindowMs, Feedback, Mix, Attack, Decay, Sustain, Release,
    Gain, Muted, Shape, Bipolar, PhaseOffset, Color, Level, Scale, TimeMs,
    Gain1, Gain2, Gain3, Gain4, Bias, OctaveOffset, Transpose, Pan, PhaseInvert, Drive, Mode, Custom(u32),
}

impl FlowParamKey {
    pub fn from_str(key: &str) -> Self {
        match key {
            "waveform" => Self::Waveform,
            "frequency" => Self::Frequency,
            "pulseWidth" | "pulse_width" => Self::PulseWidth,
            "filterType" | "filter_type" => Self::FilterType,
            "cutoff" => Self::Cutoff,
            "resonance" => Self::Resonance,
            "eqLow" | "eq_low" => Self::EqLow,
            "eqMid" | "eq_mid" => Self::EqMid,
            "eqHigh" | "eq_high" => Self::EqHigh,
            "rate" => Self::Rate,
            "depth" => Self::Depth,
            "envDepth" | "envFollow" | "env_depth" | "env_follow" => Self::EnvDepth,
            "windowMs" | "window_ms" => Self::WindowMs,
            "feedback" => Self::Feedback,
            "mix" => Self::Mix,
            "attack" => Self::Attack,
            "decay" => Self::Decay,
            "sustain" => Self::Sustain,
            "release" => Self::Release,
            "gain" => Self::Gain,
            "muted" => Self::Muted,
            "shape" => Self::Shape,
            "bipolar" => Self::Bipolar,
            "phaseOffset" | "phase_offset" => Self::PhaseOffset,
            "color" => Self::Color,
            "level" => Self::Level,
            "scale" => Self::Scale,
            "time" | "timeMs" | "time_ms" => Self::TimeMs,
            "gain1" | "gain_1" => Self::Gain1,
            "gain2" | "gain_2" => Self::Gain2,
            "gain3" | "gain_3" => Self::Gain3,
            "gain4" | "gain_4" => Self::Gain4,
            "bias" => Self::Bias,
            "octaveOffset" | "octave_offset" => Self::OctaveOffset,
            "transpose" => Self::Transpose,
            "pan" => Self::Pan,
            "phaseInvert" | "phase_invert" => Self::PhaseInvert,
            "drive" => Self::Drive,
            "mode" => Self::Mode,
            _ => {
                let hash = key.bytes().fold(0u32, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u32));
                Self::Custom(hash)
            }
        }
    }
}

pub fn parse_flow_param_value(key: FlowParamKey, val_str: &str) -> f32 {
    match key {
        FlowParamKey::Waveform => {
            match val_str {
                "saw" => 1.0,
                "square" => 2.0,
                "triangle" => 3.0,
                _ => 0.0,
            }
        }
        FlowParamKey::FilterType => {
            match val_str {
                "highpass" => 1.0,
                "bandpass" => 2.0,
                "notch" => 3.0,
                _ => 0.0,
            }
        }
        FlowParamKey::Shape => {
            match val_str {
                "triangle" => 1.0,
                "square" => 2.0,
                "sawUp" | "saw_up" => 3.0,
                "sawDown" | "saw_down" => 4.0,
                "random" => 5.0,
                _ => 0.0,
            }
        }
        FlowParamKey::Color => {
            match val_str {
                "pink" => 1.0,
                "brown" => 2.0,
                _ => 0.0,
            }
        }
        FlowParamKey::Mode => {
            match val_str {
                "softclip" | "soft" => 0.0,
                "hardclip" | "hard" => 1.0,
                "foldback" | "fold" => 2.0,
                "bitcrush" | "crush" => 3.0,
                "asymmetric" | "asym" | "tube" => 4.0,
                _ => 0.0,
            }
        }
        _ => {
            if val_str == "true" { 1.0 } else if val_str == "false" { 0.0 } else { val_str.parse::<f32>().unwrap_or(0.0) }
        }
    }
}

/// A single Flow Synth node: `(node_id, node_type, params[(key, value)])`.
pub type FlowNodeDescriptor = (u64, FlowNodeType, Vec<(FlowParamKey, f32)>);

/// A single Flow Synth connection: `(from_node_id, from_port, to_node_id, to_port)`.
pub type FlowConnectionDescriptor = (u64, usize, u64, usize);

// ── Engine Commands ─────────────────────────────────────────────────────

/// Commands dispatched from the non-real-time UI thread to the audio callback.
///
/// # Safety Contract
/// - The audio callback processes these in O(1) with zero allocations
///   for simple variants. `SyncFlowGraph` is an O(N) batch command.
/// - Queue capacity (1024) guarantees no backpressure under normal use.
#[derive(Debug, Clone)]
pub enum EngineCommand {
    // ── Topology (atomic) ────────────────────────────────────────────
    /// Atomically clears ALL device chains on ALL tracks (and master).
    /// Replaces 16×N individual RemoveDevice commands with a single O(N) operation,
    /// preventing command budget exhaustion and deferred topology queue overflow.
    ClearAllDeviceChains,

    /// Clears the device chain for a SINGLE track, leaving all other tracks
    /// (and master) untouched. Used for per-track plugin mutations (add, remove,
    /// move, paste, replace) to avoid destroying reverb/delay tails on
    /// unrelated tracks.
    ClearTrackDeviceChain { track_index: u16 },

    // ── Transport ────────────────────────────────────────────────────
    /// Start or stop playback. `true` = play, `false` = stop.
    SetPlay(bool),

    /// Seek to a specific sample frame position.
    Seek(i64),

    /// Change the engine's BPM (affects tempo-synced processing).
    SetBpm(f64),

    /// Set timeline sample-rate domain used for transport frame math.
    ///
    /// Device stream SR can differ from project/timeline SR. The audio callback
    /// uses this value to advance playhead/master clock in project-frame domain.
    SetTimelineSampleRate(f64),

    /// Enable or disable loop mode.
    SetLoopEnabled(bool),

    /// Set the loop region (start_sample, end_sample).
    SetLoopRegion { start: i64, end: i64 },

    /// Atomically set BPM and Loop region to prevent desync (BUG-014).
    SetBpmAndLoop {
        bpm: f64,
        loop_enabled: bool,
        loop_region: Option<(i64, i64)>,
    },

    /// Set project transport time signature used for plugin transport context.
    SetTimeSignature { numerator: u8, denominator: u8 },

    // ── Track Control ────────────────────────────────────────────────
    /// Set a track's volume (linear gain, 0.0–2.0). `track_index` is 0-based.
    SetTrackVolume { track_index: u16, volume: f32 },

    /// Set a track's pan position (-1.0 = hard left, 0.0 = center, 1.0 = hard right).
    SetTrackPan { track_index: u16, pan: f32 },

    /// Set master output volume (linear gain, 0.0–2.0).
    SetMasterVolume { volume: f32 },

    /// Enable or disable a track.
    SetTrackDisabled { track_index: u16, disabled: bool },

    /// Solo or unsolo a track.
    SetTrackSolo { track_index: u16, soloed: bool },

    // ── Sampler / MIDI Control ────────────────────────────────────────
    /// Trigger a note on the sampler for a specific track.
    /// `velocity` 0–127.
    SamplerNoteOn {
        track_index: u16,
        pitch: u8,
        velocity: u8,
    },

    /// Release a note on the sampler for a specific track.
    SamplerNoteOff { track_index: u16, pitch: u8 },

    /// Set the root note (pitch) for a track's sampler.
    SetSamplerRootNote { track_index: u16, root_note: u8 },

    /// Set the volume for a track's sampler (linear gain, 0.0–2.0).
    SetSamplerVolume { track_index: u16, volume: f32 },

    /// Set the ADSR envelope for a track's sampler.
    /// All times in seconds (attack, decay, release). Sustain is 0.0–1.0.
    SetSamplerAdsr {
        track_index: u16,
        attack: f32,
        decay: f32,
        sustain: f32,
        release: f32,
    },


    /// Turn off all active notes on a track's sampler.
    SamplerAllNotesOff { track_index: u16 },

    /// Bypass or un-bypass the instrument (sampler) on a track.
    /// When bypassed, MIDI is still received but the sampler produces silence.
    BypassInstrument { track_index: u16, bypassed: bool },

    // ── Sample Rack Control ──────────────────────────────────────────
    /// Set the volume for a pad within a track's sample rack (linear gain, 0.0–2.0).
    SetSampleRackPadVolume {
        track_index: u16,
        pad_index: u8,
        volume: f32,
    },

    /// Set mute state for a pad.
    SetSampleRackPadMute {
        track_index: u16,
        pad_index: u8,
        muted: bool,
    },

    /// Set solo state for a pad.
    SetSampleRackPadSolo {
        track_index: u16,
        pad_index: u8,
        soloed: bool,
    },

    /// Set the ADSR envelope for a pad.
    SetSampleRackPadAdsr {
        track_index: u16,
        pad_index: u8,
        attack: f32,
        decay: f32,
        sustain: f32,
        release: f32,
    },

    /// Set synth voice filter cutoff frequency for a pad in Hz (20..20000).
    SetSampleRackPadFilterCutoff {
        track_index: u16,
        pad_index: u8,
        cutoff: f32,
    },

    // ── Essence Synth (Wave Synth) Control ───────────────────────────
    // Dedicated commands for the standalone EssenceSynthEngine.
    // Completely independent from SamplerEngine.

    /// Explicitly enable or disable the Essence synth on a track.
    /// Must be called when the user assigns or removes the Essence instrument.
    SetEssenceEnabled { track_index: u16, enabled: bool },

    /// Set Essence OSC 1 waveform (0=Sine, 1=Triangle, 2=Saw, 3=Square).
    SetEssenceWaveform1 { track_index: u16, waveform: u8 },
    /// Set Essence OSC 2 waveform.
    SetEssenceWaveform2 { track_index: u16, waveform: u8 },
    /// Set Essence OSC 1 volume (0.0–1.0).
    SetEssenceOsc1Volume { track_index: u16, volume: f32 },
    /// Set Essence OSC 2 volume (0.0–1.0).
    SetEssenceOsc2Volume { track_index: u16, volume: f32 },
    /// Enable/disable Essence OSC 1.
    SetEssenceOsc1Enabled { track_index: u16, enabled: bool },
    /// Enable/disable Essence OSC 2.
    SetEssenceOsc2Enabled { track_index: u16, enabled: bool },
    /// Set Essence detune between OSC 1 and OSC 2 in cents.
    SetEssenceDetuneCents { track_index: u16, cents: f32 },
    /// Set Essence sub oscillator level (0.0–1.0).
    SetEssenceSubLevel { track_index: u16, level: f32 },
    /// Set Essence pulse width (0.05–0.95).
    SetEssencePulseWidth { track_index: u16, width: f32 },
    /// Set Essence filter cutoff in Hz (20–20000).
    SetEssenceFilterCutoff { track_index: u16, cutoff: f32 },
    /// Set Essence filter resonance (0.0–0.99).
    SetEssenceFilterResonance { track_index: u16, resonance: f32 },
    /// Set Essence filter type (0=LP, 1=HP, 2=BP, 3=Notch).
    SetEssenceFilterType { track_index: u16, filter_type: u8 },
    /// Set Essence LFO rate in Hz.
    SetEssenceLfoRate { track_index: u16, rate: f32 },
    /// Set Essence LFO depth (0.0–1.0).
    SetEssenceLfoDepth { track_index: u16, depth: f32 },
    /// Set Essence LFO target (0=FilterCutoff, 1=Pitch, 2=Volume).
    SetEssenceLfoTarget { track_index: u16, target: u8 },
    /// Set Essence ADSR envelope.
    SetEssenceAdsr {
        track_index: u16,
        attack: f32,
        decay: f32,
        sustain: f32,
        release: f32,
    },
    /// Set Essence master volume (0.0–2.0).
    SetEssenceVolume { track_index: u16, volume: f32 },

    // ── Flow Synth (Modular Synth) Control ─────────────────────────
    /// Explicitly enable or disable the Flow synth on a track.
    SetFlowEnabled { track_index: u16, enabled: bool },

    /// Synchronize the entire Flow synth node graph for a track.
    /// This is an O(N) operation on the audio thread, use sparingly.
    SyncFlowGraph {
        track_index: u16,
        nodes: std::sync::Arc<Vec<FlowNodeDescriptor>>,
        connections: std::sync::Arc<Vec<FlowConnectionDescriptor>>,
    },

    /// Update a single parameter on a specific node in the Flow Synth graph.
    /// This is an O(1) atomic operation that bypasses full graph rebuilds.
    UpdateFlowNodeParam {
        track_index: u16,
        node_id: u64,
        key: FlowParamKey,
        value: f32,
    },

    // ── Test / Legacy ────────────────────────────────────────────────
    /// Smoothly transition the test tone to a new frequency (Hz).
    /// The audio callback applies per-sample exponential smoothing
    /// to eliminate discontinuity clicks during frequency changes.
    SetFreq(f32),

    // ── Device Chain ─────────────────────────────────────────────────
    /// Add a built-in DSP device to a track's insert chain.
    /// `effect_type` maps to `BuiltinEffectType` (0=eq..6=saturator).
    AddDevice {
        track_index: u16,
        slot_index: u8,
        effect_type: u8,
    },

    /// Remove a device from a track's insert chain.
    RemoveDevice { track_index: u16, slot_index: u8 },

    /// Reorder a device within a track's insert chain (drag-and-drop).
    /// Atomic move: no audible gap caused by separate Remove + Add.
    ReorderDevice {
        track_index: u16,
        from_slot: u8,
        to_slot: u8,
    },

    /// Bypass or un-bypass a device slot.
    BypassDevice {
        track_index: u16,
        slot_index: u8,
        bypassed: bool,
    },

    /// Set a parameter on a device in a track's insert chain.
    ///
    /// `param_index` is u32 to support VST3 plugins with 1000+ parameters.
    /// The DeviceChain layer already uses u32 — this removes the IPC bottleneck
    /// that previously truncated indices above 255.
    SetDeviceParam {
        track_index: u16,
        slot_index: u8,
        param_index: u32,
        value: f32,
    },

    // ── Engine Lifecycle ─────────────────────────────────────────────
    /// Signal that an offline export is active. While `true`, the RT audio
    /// callback MUST skip all external VST plugin `try_lock()` calls to
    /// prevent concurrent state mutation (crackling/corruption in export).
    SetExportActive(bool),

    /// Request the engine to stop and clean up all resources.
    Shutdown,
    // ── Streaming Window Management ──────────────────────────────────
    // Register a new streaming window for a file path.
    // Used for large files that don't fit in the RAM pool.
    // The window itself is created on the UI thread and passed via pointer
    // (wrapped in a variant that handles the move properly is complex,
    // but we'll use a unique identifier for now or a deferred command).
    //
    // NOTE: To keep EngineCommand Copy, we can't pass the Window directly.
    // We'll use a separate bridge or make Window handleable via ID.
    // Actually, let's keep it simple: the audio thread polls for NEW
    // windows via a separate wait-free queue if needed, but for now
    // we'll just fix the RT-safe capacity issues as they are the immediate bug.
}

// ── Master Clock ────────────────────────────────────────────────────────

/// Atomic sample-frame counter — the Single Source of Truth for time.
///
/// This is the Rust port of the Swift `AbsoluteTime` concept.
/// A monotonically increasing i64 counter that never wraps:
/// at 192kHz, overflow occurs after ~1.5 billion years.
///
/// # Thread Safety
/// - **Writer**: Audio callback exclusively (via `advance`) — `Relaxed` ordering.
/// - **Reader**: UI thread for display (via `position`) — `Relaxed` ordering.
///   Eventual consistency is acceptable: we display at 60-144fps,
///   audio advances at 44100-192000fps. The UI is always "close enough."
pub struct MasterClock {
    frames_rendered: AtomicI64,
}

impl Default for MasterClock {
    fn default() -> Self {
        Self::new()
    }
}

impl MasterClock {
    /// Creates a new clock at frame zero.
    pub const fn new() -> Self {
        Self {
            frames_rendered: AtomicI64::new(0),
        }
    }

    /// Advances the clock by `frame_count` samples.
    ///
    /// # Real-Time Safety
    /// Single `fetch_add` — one atomic CPU instruction, zero allocations.
    #[inline(always)]
    pub fn advance(&self, frame_count: i64) {
        self.frames_rendered
            .fetch_add(frame_count, Ordering::Relaxed);
    }

    /// Returns the current frame position. Called from the UI thread.
    #[inline]
    pub fn position(&self) -> i64 {
        self.frames_rendered.load(Ordering::Relaxed)
    }

    /// Resets the clock to zero. Non-RT only (project load, transport reset).
    pub fn reset(&self) {
        self.frames_rendered.store(0, Ordering::Relaxed);
    }

    /// Sets absolute frame position atomically.
    #[inline]
    pub fn set_position(&self, frame: i64) {
        self.frames_rendered.store(frame.max(0), Ordering::Relaxed);
    }
}

// ── Command Queue Factory ───────────────────────────────────────────────

/// Default command queue capacity.
///
/// At 48kHz / 512-sample buffers, callback fires ~94 times/sec.
/// At 144fps UI with 10 commands/frame = 1440 commands/sec.
// MEGA-08 FIX: Increased from 1024 to 8192 to accommodate O(N) burst IPC
// syncing logic, such as `sync_track_mix_state_from_project` which instantly
// fires 4 * N commands when adding/deleting/moving a track.
pub const COMMAND_QUEUE_CAPACITY: usize = 8192;

/// Creates a new lock-free command queue, returning the split halves.
///
/// - `Producer` stays on the UI/Tauri thread (sends commands).
/// - `Consumer` moves into the cpal audio callback (receives commands).
pub fn create_command_queue() -> (rtrb::Producer<EngineCommand>, rtrb::Consumer<EngineCommand>) {
    rtrb::RingBuffer::new(COMMAND_QUEUE_CAPACITY)
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn master_clock_advances_correctly() {
        let clock = MasterClock::new();
        assert_eq!(clock.position(), 0);

        clock.advance(512);
        assert_eq!(clock.position(), 512);

        clock.advance(512);
        assert_eq!(clock.position(), 1024);
    }

    #[test]
    fn master_clock_resets_to_zero() {
        let clock = MasterClock::new();
        clock.advance(44100);
        assert_eq!(clock.position(), 44100);

        clock.reset();
        assert_eq!(clock.position(), 0);
    }

    #[test]
    fn command_queue_fifo_ordering() {
        let (mut producer, mut consumer) = create_command_queue();

        assert!(producer.push(EngineCommand::SetPlay(true)).is_ok());
        assert!(producer.push(EngineCommand::SetFreq(880.0)).is_ok());
        assert!(producer.push(EngineCommand::SetPlay(false)).is_ok());

        match consumer.pop() {
            Ok(EngineCommand::SetPlay(true)) => {}
            other => panic!("Expected SetPlay(true), got {:?}", other),
        }
        match consumer.pop() {
            Ok(EngineCommand::SetFreq(f)) => {
                assert!((f - 880.0).abs() < f32::EPSILON);
            }
            other => panic!("Expected SetFreq(880.0), got {:?}", other),
        }
        match consumer.pop() {
            Ok(EngineCommand::SetPlay(false)) => {}
            other => panic!("Expected SetPlay(false), got {:?}", other),
        }

        // Queue empty
        assert!(consumer.pop().is_err());
    }

    #[test]
    fn command_queue_handles_full_capacity() {
        let (mut producer, _consumer) = rtrb::RingBuffer::<EngineCommand>::new(4);

        for _ in 0..4 {
            assert!(producer.push(EngineCommand::SetPlay(true)).is_ok());
        }
        // Next push should fail — no panic, no block
        assert!(producer.push(EngineCommand::SetPlay(true)).is_err());
    }
}
