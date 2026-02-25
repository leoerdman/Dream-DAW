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
    pub new_position_frames: i64,
    pub track_index: usize,
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

        // DUP-03 FIX: Determine clip type explicitly instead of error-swallowing fallback.
        let is_audio_clip = project.tracks[track_index]
            .clips
            .iter()
            .any(|c| c.id == self.clip_id);

        let (new_id, new_position_frames) = if is_audio_clip {
            let dup = mutators::duplicate_clip(&mut project, self.clip_id, target_pos)?;
            (dup.id, dup.position.sample_frame)
        } else {
            let dup = mutators::duplicate_midi_clip(&mut project, self.clip_id, target_pos)?;
            (dup.id, dup.position.sample_frame)
        };

        Ok(DuplicateClipResult {
            new_id,
            new_position_frames,
            track_index,
        })
    }
}
