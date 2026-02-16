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

// ── Engine Commands ─────────────────────────────────────────────────────

/// Commands dispatched from the non-real-time UI thread to the audio callback.
///
/// # Safety Contract
/// - All variants are `Copy` — no heap data ever crosses the RT boundary.
/// - The audio callback processes these in O(1) with zero allocations.
/// - Queue capacity (1024) guarantees no backpressure under normal use.
#[derive(Debug, Clone, Copy)]
pub enum EngineCommand {
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

    // ── Track Control ────────────────────────────────────────────────
    /// Set a track's volume (linear gain, 0.0–2.0). `track_index` is 0-based.
    SetTrackVolume { track_index: u16, volume: f32 },

    /// Set a track's pan position (-1.0 = hard left, 0.0 = center, 1.0 = hard right).
    SetTrackPan { track_index: u16, pan: f32 },

    /// Set master output volume (linear gain, 0.0–2.0).
    SetMasterVolume { volume: f32 },

    /// Mute or unmute a track.
    SetTrackMute { track_index: u16, muted: bool },

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

    /// Enable oscillator mode for the sampler engine and set waveform.
    /// `waveform`: 0=sine, 1=triangle, 2=saw, 3=square.
    SetSamplerWaveform { track_index: u16, waveform: u8 },

    /// Set oscillator 2 waveform (0=sine, 1=triangle, 2=saw, 3=square).
    SetSamplerOsc2Waveform { track_index: u16, waveform: u8 },

    /// Set blend between oscillator 1 and 2 (0.0..1.0).
    SetSamplerOscMix { track_index: u16, mix: f32 },

    /// Set oscillator 2 detune in cents (-50..+50).
    SetSamplerDetuneCents { track_index: u16, cents: f32 },

    /// Set sub oscillator level (0.0..1.0), one octave below osc1.
    SetSamplerSubLevel { track_index: u16, level: f32 },

    /// Set synth voice filter cutoff frequency in Hz (20..20000).
    SetSamplerFilterCutoff { track_index: u16, cutoff: f32 },

    /// Set synth voice filter resonance (0.0..0.99).
    SetSamplerFilterResonance { track_index: u16, resonance: f32 },

    /// Set synth voice filter type (0=LP, 1=HP, 2=BP, 3=Notch).
    SetSamplerFilterType { track_index: u16, filter_type: u8 },

    /// Set LFO modulation rate in Hz (0.01–20.0).
    SetSamplerLfoRate { track_index: u16, rate: f32 },

    /// Set LFO modulation depth (0.0–1.0).
    SetSamplerLfoDepth { track_index: u16, depth: f32 },

    /// Set LFO modulation target (0=Filter, 1=Pitch, 2=Volume).
    SetSamplerLfoTarget { track_index: u16, target: u8 },

    /// Set square wave pulse width (0.05–0.95).
    SetSamplerPulseWidth { track_index: u16, width: f32 },

    /// Turn off all active notes on a track's sampler.
    SamplerAllNotesOff { track_index: u16 },

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
    /// Request the engine to stop and clean up all resources.
    Shutdown,
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
/// 1024 slots per callback cycle is more than sufficient.
pub const COMMAND_QUEUE_CAPACITY: usize = 1024;

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
