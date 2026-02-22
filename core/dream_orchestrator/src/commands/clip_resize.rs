// ═══════════════════════════════════════════════════════════════════════════
// ResizeClipCommand — Resize a clip to a new position and duration
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use dream_models::mutators;
use dream_models::time::AbsoluteTime;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

/// Resize a clip (audio or MIDI) to a new position and duration.
pub struct ResizeClipCommand {
    pub clip_id: Uuid,
    pub new_position_frames: i64,
    pub new_duration_frames: i64,
}

impl ResizeClipCommand {
    pub fn from_str_id(
        clip_id: &str,
        new_position_frames: i64,
        new_duration_frames: i64,
    ) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            clip_id: uuid,
            new_position_frames,
            new_duration_frames,
        })
    }
}

impl Command for ResizeClipCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        let mut project = ctx.lock_project()?;

        let new_position = AbsoluteTime::new(self.new_position_frames);
        let new_duration = AbsoluteTime::new(self.new_duration_frames);

        if let Err(audio_err) = mutators::resize_clip(
            &mut project,
            self.clip_id,
            new_position,
            new_duration,
        ) {
            // Fall back to MIDI clip resize
            if mutators::resize_midi_clip(
                &mut project,
                self.clip_id,
                new_position,
                new_duration,
            )
            .is_err()
            {
                return Err(OrchestratorError::MutatorFailed(audio_err));
            }
        }

        Ok(())
    }
}
