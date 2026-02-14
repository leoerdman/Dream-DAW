// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Clip Playback Engine
// ═══════════════════════════════════════════════════════════════════════════
//
// Determines which audio clips are active at the current playhead
// position and reads their sample data for mixing.
//
// Architecture:
//   ClipScheduler → determines which clips overlap the current buffer
//   ClipReader → reads sample frames from a pre-loaded audio source
//   ClipPool → manages pre-loaded audio data in RAM
//   DiskStreamer → streams large files from disk (OOM prevention)
//
// All reading is REAL-TIME SAFE — pre-loaded or pre-streamed data only.
//
// ═══════════════════════════════════════════════════════════════════════════

pub mod scheduler;
pub mod reader;
pub mod pool;
pub mod midi_scheduler;
pub mod disk_streamer;

pub use scheduler::{ClipScheduler, LoopRegion};
pub use reader::ClipReader;
pub use pool::ClipPool;
pub use midi_scheduler::MidiScheduler;
pub use disk_streamer::{
    DiskStreamerHandle, StreamingWindow, StreamChunk,
    should_stream, CHUNK_FRAMES, LOOK_AHEAD_CHUNKS, RAM_THRESHOLD_BYTES,
};
