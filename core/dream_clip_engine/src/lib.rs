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
//
// All reading is REAL-TIME SAFE — pre-loaded data only, no disk I/O.
//
// ═══════════════════════════════════════════════════════════════════════════

pub mod scheduler;
pub mod reader;
pub mod pool;
pub mod midi_scheduler;

pub use scheduler::{ClipScheduler, LoopRegion};
pub use reader::ClipReader;
pub use pool::ClipPool;
pub use midi_scheduler::MidiScheduler;

