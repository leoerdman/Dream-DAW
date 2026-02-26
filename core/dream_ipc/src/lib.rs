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

// ── Engine Commands ─────────────────────────────────────────────────────

/// Commands dispatched from the non-real-time UI thread to the audio callback.
///
/// # Safety Contract
/// - All variants are `Copy` — no heap data ever crosses the RT boundary.
/// - The audio callback processes these in O(1) with zero allocations.
/// - Queue capacity (1024) guarantees no backpressure under normal use.
#[derive(Debug, Clone, Copy)]
pub enum EngineCommand {
    // ── Topology (atomic) ────────────────────────────────────────────
    /// Atomically clears ALL device chains on ALL tracks (and master).
    /// Replaces 16×N individual RemoveDevice commands with a single O(N) operation,
    /// preventing command budget exhaustion and deferred topology queue overflow.
    ClearAllDeviceChains,

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
    SetDeviceParam {
        track_index: u16,
        slot_index: u8,
        param_index: u8,
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
