// ═══════════════════════════════════════════════════════════════════════════
// Pre-Allocation Queue — RT-Safe Device Transfer
// ═══════════════════════════════════════════════════════════════════════════
//
// Enterprise DAWs never call `malloc()` on the audio thread.
// This module provides a lock-free SPSC (single-producer, single-consumer)
// queue for transferring pre-constructed DSP processors from the IPC/UI
// thread to the audio thread.
//
// The IPC thread pushes `PrebuiltDevice` structs containing a fully
// constructed `Box<dyn DeviceProcessor>`. The audio thread pops them
// at the start of each callback — zero allocations, zero locks.
//
// ═══════════════════════════════════════════════════════════════════════════

use dream_dsp::device_slot::DeviceProcessor;

/// A pre-constructed DSP device ready for insertion into a track's device chain.
///
/// Created on the IPC/UI thread (where `malloc` is safe), then transferred
/// to the audio thread via the lock-free SPSC queue.
pub struct PrebuiltDevice {
    /// Target track index (0-based).
    pub track_index: u16,
    /// Target slot index within the track's device chain.
    pub slot_index: u8,
    /// Fully constructed processor — ready to process audio immediately.
    pub device: Box<dyn DeviceProcessor>,
}

// SAFETY: DeviceProcessor requires Send, and all fields are owned.
// The PrebuiltDevice is created on the IPC thread and consumed on the audio thread.
unsafe impl Send for PrebuiltDevice {}

/// Capacity of the pre-allocation queue.
///
/// 64 slots is more than sufficient for burst device additions:
/// - Normal operation: 1-2 devices added at a time
/// - Project load: rebuilds are batched, not sent individually
/// - Undo/redo: rebatch sends at most MAX_DEVICE_SLOTS × MAX_TRACKS
///
/// If the queue is full, the IPC thread logs a warning and falls back
/// to the legacy `EngineCommand::AddDevice` path (which allocates on RT thread).
const PREALLOC_QUEUE_CAPACITY: usize = 1024;

/// Creates a new pre-allocation queue pair.
///
/// Returns `(producer, consumer)`:
/// - `producer`: held by `AudioEngineHandle` on the IPC/UI thread
/// - `consumer`: passed to `start_audio_thread_on_device_impl` for the audio thread
pub fn new_prealloc_queue() -> (rtrb::Producer<PrebuiltDevice>, rtrb::Consumer<PrebuiltDevice>) {
    rtrb::RingBuffer::new(PREALLOC_QUEUE_CAPACITY)
}
