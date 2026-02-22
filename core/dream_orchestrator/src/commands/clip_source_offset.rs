// ═══════════════════════════════════════════════════════════════════════════
// SetClipSourceOffsetCommand — Slip edit (source offset) on an audio clip
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use dream_models::time::AbsoluteTime;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

/// Update a clip's source offset for slip editing.
///
/// The offset is clamped to `[0, source_file_length - 1]` so at least
/// one frame remains visible.
pub struct SetClipSourceOffsetCommand {
    pub clip_id: Uuid,
    pub source_offset_frames: i64,
}

impl SetClipSourceOffsetCommand {
    pub fn from_str_id(clip_id: &str, source_offset_frames: i64) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            clip_id: uuid,
            source_offset_frames,
        })
    }
}

impl Command for SetClipSourceOffsetCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        // Check clip exists BEFORE any mutation
        {
            let project = ctx.lock_project()?;
            let found = project
                .tracks
                .iter()
                .any(|t| t.clips.iter().any(|c| c.id == self.clip_id));
            if !found {
                return Err(OrchestratorError::NotFound {
                    entity: "clip",
                    id: self.clip_id.to_string(),
                });
            }
        }

        let mut project = ctx.lock_project()?;
        for track in &mut project.tracks {
            if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
                // Clamp source_offset to [0, max_offset] where
                // max_offset = source_file_length - 1
                let max_offset = ctx
                    .clip_pool
                    .get_clip_audio(&clip.file_path)
                    .map(|audio| (audio.num_frames as i64).saturating_sub(1).max(0))
                    .unwrap_or(i64::MAX);
                clip.source_offset = AbsoluteTime::new(
                    self.source_offset_frames.max(0).min(max_offset),
                );
                break;
            }
        }

        Ok(())
    }
}
