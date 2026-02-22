// ═══════════════════════════════════════════════════════════════════════════
// DeleteClipCommand — Delete a clip from the project
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use dream_models::mutators;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

/// Delete a clip (audio or MIDI) from the project by UUID.
pub struct DeleteClipCommand {
    pub clip_id: Uuid,
}

/// Result of clip deletion.
pub struct DeleteClipResult {
    pub track_index: usize,
}

impl DeleteClipCommand {
    pub fn from_str_id(clip_id: &str) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;
        Ok(Self { clip_id: uuid })
    }
}

impl Command for DeleteClipCommand {
    type Result = DeleteClipResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<DeleteClipResult> {
        let mut project = ctx.lock_project()?;
        let track_index = project
            .tracks
            .iter()
            .position(|track| {
                track.clips.iter().any(|clip| clip.id == self.clip_id)
                    || track.midi_clips.iter().any(|clip| clip.id == self.clip_id)
            })
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "Clip",
                id: self.clip_id.to_string(),
            })?;

        if let Err(audio_err) = mutators::delete_clip(&mut project, self.clip_id) {
            // Fall back to MIDI clip
            if mutators::delete_midi_clip(&mut project, self.clip_id).is_err() {
                return Err(OrchestratorError::MutatorFailed(audio_err));
            }
        }

        Ok(DeleteClipResult { track_index })
    }
}
