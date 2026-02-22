// ═══════════════════════════════════════════════════════════════════════════
// DuplicateClipCommand — Duplicate a clip at optional position
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use dream_models::mutators;
use dream_models::time::AbsoluteTime;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

/// Result of a duplicate operation.
pub struct DuplicateClipResult {
    pub new_id: Uuid,
}

/// Duplicate a clip (audio or MIDI), optionally at a specific position.
pub struct DuplicateClipCommand {
    pub clip_id: Uuid,
    pub new_position_frames: Option<i64>,
}

impl DuplicateClipCommand {
    pub fn from_str_id(
        clip_id: &str,
        new_position_frames: Option<i64>,
    ) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            clip_id: uuid,
            new_position_frames,
        })
    }
}

impl Command for DuplicateClipCommand {
    type Result = DuplicateClipResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<DuplicateClipResult> {
        let mut project = ctx.lock_project()?;
        let target_pos = self.new_position_frames.map(AbsoluteTime::new);

        let new_id = match mutators::duplicate_clip(&mut project, self.clip_id, target_pos) {
            Ok(dup) => dup.id,
            Err(_) => mutators::duplicate_midi_clip(&mut project, self.clip_id, target_pos)?.id,
        };

        Ok(DuplicateClipResult { new_id })
    }
}
