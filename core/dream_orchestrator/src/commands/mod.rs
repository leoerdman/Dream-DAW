// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Orchestrator Commands
// ═══════════════════════════════════════════════════════════════════════════

pub mod clip_split;
pub mod clip_move;
pub mod clip_delete;
pub mod clip_duplicate;
pub mod clip_mute;

// Re-export all command structs for convenience
pub use clip_split::SplitClipCommand;
pub use clip_move::MoveClipCommand;
pub use clip_delete::DeleteClipCommand;
pub use clip_duplicate::DuplicateClipCommand;
pub use clip_mute::{MuteClipCommand, MuteClipsBatchCommand};
