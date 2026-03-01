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
    pub allow_stretch: bool,
}

impl ResizeClipCommand {
    pub fn from_str_id(
        clip_id: &str,
        new_position_frames: i64,
        new_duration_frames: i64,
        allow_stretch: bool,
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
            allow_stretch,
        })
    }
}

impl Command for ResizeClipCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        // BUG-038 FIX: Validate inputs before mutating.
        if self.new_duration_frames <= 0 {
            return Err(OrchestratorError::Other(format!(
                "Clip duration must be positive, got {}",
                self.new_duration_frames
            )));
        }
        if self.new_position_frames < 0 {
            return Err(OrchestratorError::Other(format!(
                "Clip position must be non-negative, got {}",
                self.new_position_frames
            )));
        }

        let mut project = ctx.lock_project()?;

        let new_position = AbsoluteTime::new(self.new_position_frames);
        let new_duration = AbsoluteTime::new(self.new_duration_frames);

        if let Err(_audio_err) = mutators::resize_clip(
            &mut project,
            self.clip_id,
            new_position,
            new_duration,
            self.allow_stretch,
            None,
        ) {
            // BUG-017 FIX: Return the MIDI error (not audio error) when both fail.
            if let Err(midi_err) =
                mutators::resize_midi_clip(&mut project, self.clip_id, new_position, new_duration, None)
            {
                return Err(OrchestratorError::MutatorFailed(midi_err));
            }
        }

        Ok(())
    }
}
