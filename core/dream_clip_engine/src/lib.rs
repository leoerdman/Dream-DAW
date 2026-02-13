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

pub use scheduler::ClipScheduler;
pub use reader::ClipReader;
pub use pool::ClipPool;
