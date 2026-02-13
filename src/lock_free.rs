// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Lock-Free Communication Layer
// ═══════════════════════════════════════════════════════════════════════════
//
// This module defines the ONLY permitted communication channel between the
// non-real-time world (UI/Tauri thread) and the real-time world (cpal audio
// callback). All data crosses this boundary via lock-free, wait-free SPSC
// ring buffers. NO mutexes, NO allocations, NO syscalls on the hot path.
//
// Architecture:
//   UI Thread ──[rtrb::Producer]──▶ Audio Callback ──[rtrb::Consumer]──▶
//
// ═══════════════════════════════════════════════════════════════════════════

use std::sync::atomic::{AtomicI64, Ordering};

// ── Engine Commands ─────────────────────────────────────────────────────

/// Commands dispatched from the non-real-time thread to the audio callback.
///
/// # Safety Contract
/// - All variants are `Copy` — no heap data ever crosses the RT boundary.
/// - The audio callback processes these in O(1) with zero allocations.
/// - Command queue capacity (1024) guarantees no backpressure under normal use.
#[derive(Debug, Clone, Copy)]
pub enum EngineCommand {
    /// Start audio playback from the current position.
    Play,

    /// Stop playback. Resets the phase accumulator to zero.
    Stop,

    /// Smoothly transition the test tone to a new frequency (Hz).
    /// The audio callback applies exponential smoothing per-sample
    /// to eliminate discontinuity clicks during frequency changes.
    SetTestToneFrequency(f32),
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
        self.frames_rendered.fetch_add(frame_count, Ordering::Relaxed);
    }

    /// Returns the current frame position. Called from the UI thread.
    #[inline]
    pub fn position(&self) -> i64 {
        self.frames_rendered.load(Ordering::Relaxed)
    }

    /// Resets the clock to zero. Called from the UI thread only
    /// (e.g., on project load or transport reset).
    #[allow(dead_code)]
    pub fn reset(&self) {
        self.frames_rendered.store(0, Ordering::Relaxed);
    }
}

// ── Audio Bridge ────────────────────────────────────────────────────────

/// The split communication channel between UI and audio worlds.
///
/// Created once at engine startup, then split:
/// - `producer` stays on the UI/Tauri thread (sends commands).
/// - `consumer` moves into the cpal audio callback (receives commands).
/// - `clock` is shared via `Arc` between both worlds.
pub struct AudioBridge {
    pub producer: rtrb::Producer<EngineCommand>,
    pub consumer: rtrb::Consumer<EngineCommand>,
    pub clock: MasterClock,
}

impl AudioBridge {
    /// Creates a new bridge with the specified command queue capacity.
    ///
    /// # Capacity Sizing
    /// At 48kHz / 512-sample buffers, the callback fires ~94 times/sec.
    /// At 144fps UI with 10 commands/frame = 1440 commands/sec.
    /// Capacity of 1024 per callback cycle is more than sufficient.
    pub fn new(capacity: usize) -> Self {
        let (producer, consumer) = rtrb::RingBuffer::new(capacity);
        Self {
            producer,
            consumer,
            clock: MasterClock::new(),
        }
    }
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
        let bridge = AudioBridge::new(64);
        let mut producer = bridge.producer;
        let mut consumer = bridge.consumer;

        // Push 3 commands
        assert!(producer.push(EngineCommand::Play).is_ok());
        assert!(producer.push(EngineCommand::SetTestToneFrequency(880.0)).is_ok());
        assert!(producer.push(EngineCommand::Stop).is_ok());

        // Verify FIFO order
        match consumer.pop() {
            Ok(EngineCommand::Play) => {}
            other => panic!("Expected Play, got {:?}", other),
        }
        match consumer.pop() {
            Ok(EngineCommand::SetTestToneFrequency(f)) => {
                assert!((f - 880.0).abs() < f32::EPSILON);
            }
            other => panic!("Expected SetTestToneFrequency(880.0), got {:?}", other),
        }
        match consumer.pop() {
            Ok(EngineCommand::Stop) => {}
            other => panic!("Expected Stop, got {:?}", other),
        }

        // Queue should be empty now
        assert!(consumer.pop().is_err());
    }

    #[test]
    fn command_queue_handles_capacity() {
        let bridge = AudioBridge::new(4);
        let mut producer = bridge.producer;

        // Fill the queue
        for _ in 0..4 {
            assert!(producer.push(EngineCommand::Play).is_ok());
        }

        // Next push should fail (queue full) — no panic, no block
        assert!(producer.push(EngineCommand::Play).is_err());
    }
}
