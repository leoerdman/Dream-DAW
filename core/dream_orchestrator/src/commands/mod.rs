// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Orchestrator Commands (CQRS Command Side)
// ═══════════════════════════════════════════════════════════════════════════

// ── Clip Commands ───────────────────────────────────────────────────────
pub mod clip_bounce;
pub mod clip_color;
pub mod clip_delete;
pub mod clip_duplicate;
pub mod clip_fades;
pub mod clip_merge;
pub mod clip_midi_update;
pub mod clip_move;
pub mod clip_mute;
pub mod clip_pitch;
pub mod clip_resize;
pub mod clip_source_offset;
pub mod clip_split;
pub mod clip_warp;

// Re-export all command structs for convenience
pub use clip_bounce::{InsertBouncedClipCommand, InsertStemClipsCommand, StemMetaInput};
pub use clip_color::PaintTrackClipsWithTrackColorCommand;
pub use clip_delete::DeleteClipCommand;
pub use clip_duplicate::DuplicateClipCommand;
pub use clip_fades::SetClipFadesCommand;
pub use clip_merge::MergeClipsCommand;
pub use clip_midi_update::{SetMidiClipEnvelopesCommand, UpdateMidiClipCommand};
pub use clip_move::MoveClipCommand;
pub use clip_mute::{MuteClipCommand, MuteClipsBatchCommand};
pub use clip_pitch::SetClipPitchCommand;
pub use clip_resize::ResizeClipCommand;
pub use clip_source_offset::SetClipSourceOffsetCommand;
pub use clip_split::SplitClipCommand;
pub use clip_warp::SetClipWarpCommand;
