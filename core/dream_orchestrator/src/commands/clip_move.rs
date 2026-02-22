// ═══════════════════════════════════════════════════════════════════════════
// MoveClipCommand — Move a clip to a new track and/or position
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use dream_models::mutators;
use dream_models::time::AbsoluteTime;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

/// Move a clip (audio or MIDI) to a new track and/or position.
///
/// Tries audio clip move first, falls back to MIDI clip move.
pub struct MoveClipCommand {
    pub clip_id: Uuid,
    pub new_track_index: usize,
    pub new_position_frames: i64,
}

impl MoveClipCommand {
    pub fn from_str_id(
        clip_id: &str,
        new_track_index: usize,
        new_position_frames: i64,
    ) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            clip_id: uuid,
            new_track_index,
            new_position_frames,
        })
    }
}

impl Command for MoveClipCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        let mut project = ctx.lock_project()?;

        if self.new_track_index >= project.tracks.len() {
            return Err(OrchestratorError::TrackOutOfRange {
                requested: self.new_track_index,
                total: project.tracks.len(),
            });
        }

        let new_position = AbsoluteTime::new(self.new_position_frames);

        if let Err(audio_err) = mutators::move_clip(
            &mut project,
            self.clip_id,
            self.new_track_index,
            new_position,
        ) {
            // Fall back to MIDI clip move
            if mutators::move_midi_clip(
                &mut project,
                self.clip_id,
                self.new_track_index,
                new_position,
            )
            .is_err()
            {
                return Err(OrchestratorError::MutatorFailed(audio_err));
            }
        }

        Ok(())
    }
}
