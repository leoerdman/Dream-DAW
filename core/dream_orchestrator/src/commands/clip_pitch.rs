// ═══════════════════════════════════════════════════════════════════════════
// SetClipPitchCommand — Set clip pitch shift in semitones
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use dream_models::time::AbsoluteTime;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

/// Set pitch shift on an audio clip in semitones.
///
/// When the clip is NOT warped, pitch shifting also changes the duration
/// (like vinyl speed change). When warped, duration is BPM-locked.
pub struct SetClipPitchCommand {
    pub clip_id: Uuid,
    pub pitch_shift_semitones: f64,
}

impl SetClipPitchCommand {
    pub fn from_str_id(clip_id: &str, pitch_shift_semitones: f64) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            clip_id: uuid,
            pitch_shift_semitones,
        })
    }
}

impl Command for SetClipPitchCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        let mut project = ctx.lock_project()?;
        let mut updated = false;

        for track in &mut project.tracks {
            if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
                clip.pitch_shift_semitones = self.pitch_shift_semitones.clamp(-48.0, 48.0);

                // When not warped, pitch shift changes duration (vinyl speed effect)
                if !clip.is_warped {
                    let pitch_multiplier = 2.0_f64.powf(clip.pitch_shift_semitones / 12.0);
                    let new_frames = (clip.warp_source_duration_frames.max(1) as f64
                        / pitch_multiplier)
                        .round() as i64;
                    clip.duration = AbsoluteTime::new(new_frames.max(1));
                }

                updated = true;
                break;
            }
        }

        if !updated {
            return Err(OrchestratorError::NotFound {
                entity: "clip",
                id: self.clip_id.to_string(),
            });
        }

        Ok(())
    }
}
