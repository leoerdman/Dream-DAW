use uuid::Uuid;
use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

// ═══════════════════════════════════════════════════════════════════════════
// PaintTrackClipsWithTrackColorCommand
// ═══════════════════════════════════════════════════════════════════════════

pub struct PaintTrackClipsWithTrackColorCommand {
    pub track_id: Uuid,
}

impl PaintTrackClipsWithTrackColorCommand {
    pub fn from_str_id(track_id: &str) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        Ok(Self { track_id: uuid })
    }
}

impl Command for PaintTrackClipsWithTrackColorCommand {
    type Result = bool;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<bool> {
        let mut project = ctx.lock_project()?;
        
        let track = project
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "Track",
                id: self.track_id.to_string(),
            })?;

        let mut changed = false;
        let target_color = track.color.clone();
        let target_color_hex = track.color_hex.clone();

        for clip in &mut track.clips {
            if clip.color_override.as_ref() != Some(&target_color) || clip.color_hex != target_color_hex {
                changed = true;
            }
            clip.color_override = Some(target_color.clone());
            clip.color_hex = target_color_hex.clone();
        }

        for clip in &mut track.midi_clips {
            if clip.color_override.as_ref() != Some(&target_color) || clip.color_hex != target_color_hex {
                changed = true;
            }
            clip.color_override = Some(target_color.clone());
            clip.color_hex = target_color_hex.clone();
        }

        Ok(changed)
    }
}
