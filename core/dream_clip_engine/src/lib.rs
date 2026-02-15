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

pub mod disk_streamer;
pub mod midi_scheduler;
pub mod pool;
pub mod reader;
pub mod scheduler;

pub use disk_streamer::{
    CHUNK_FRAMES, DiskStreamerHandle, LOOK_AHEAD_CHUNKS, RAM_THRESHOLD_BYTES, StreamChunk,
    StreamingWindow, should_stream,
};
pub use midi_scheduler::MidiScheduler;
pub use pool::ClipPool;
pub use reader::ClipReader;
pub use scheduler::{ClipScheduler, LoopRegion};
