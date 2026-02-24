// ═══════════════════════════════════════════════════════════════════════════
// SetClipFadesCommand — Set fade-in/out durations on a clip
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

/// Set fade-in and fade-out frame counts on an audio or MIDI clip.
///
/// Fade values are clamped to [0, clip_duration/2] to prevent
/// overlapping fades.
pub struct SetClipFadesCommand {
    pub clip_id: Uuid,
    pub fade_in_frames: i64,
    pub fade_out_frames: i64,
}

impl SetClipFadesCommand {
    pub fn from_str_id(
        clip_id: &str,
        fade_in_frames: i64,
        fade_out_frames: i64,
    ) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            clip_id: uuid,
            fade_in_frames,
            fade_out_frames,
        })
    }
}

impl Command for SetClipFadesCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        let mut project = ctx.lock_project()?;
        let mut updated = false;

        // Try audio clips first
        for track in &mut project.tracks {
            if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
                let clip_len = clip.duration.sample_frame.max(1);
                let max_fade = (clip_len / 2).max(0);
                let mut fade_in = self.fade_in_frames.max(0).min(max_fade);
                let mut fade_out = self.fade_out_frames.max(0).min(max_fade);
                // BUG-016 FIX: Guard combined overlap. If fade_in + fade_out
                // exceeds clip length, proportionally shrink both fades.
                let total = fade_in + fade_out;
                if total > clip_len && total > 0 {
                    let scale = clip_len as f64 / total as f64;
                    fade_in = (fade_in as f64 * scale) as i64;
                    fade_out = clip_len - fade_in; // give remainder to fade_out
                }
                clip.fade_in_frames = fade_in;
                clip.fade_out_frames = fade_out;
                updated = true;
                break;
            }
        }

        // Fall back to MIDI clips
        if !updated {
            for track in &mut project.tracks {
                if let Some(clip) = track.midi_clips.iter_mut().find(|c| c.id == self.clip_id) {
                    let clip_len = clip.duration.sample_frame.max(1);
                    let max_fade = (clip_len / 2).max(0);
                    let mut fade_in = self.fade_in_frames.max(0).min(max_fade);
                    let mut fade_out = self.fade_out_frames.max(0).min(max_fade);
                    // BUG-016 FIX: Same combined overlap guard as audio clips.
                    let total = fade_in + fade_out;
                    if total > clip_len && total > 0 {
                        let scale = clip_len as f64 / total as f64;
                        fade_in = (fade_in as f64 * scale) as i64;
                        fade_out = clip_len - fade_in;
                    }
                    clip.fade_in_frames = fade_in;
                    clip.fade_out_frames = fade_out;
                    updated = true;
                    break;
                }
            }
        }

        if !updated {
            return Err(OrchestratorError::NotFound {
                entity: "clip",
                id: self.clip_id.to_string(),
            });
        }

        log::info!(
            "[Orchestrator] set_clip_fades clip={} fade_in={} fade_out={}",
            self.clip_id,
            self.fade_in_frames.max(0),
            self.fade_out_frames.max(0)
        );
        Ok(())
    }
}
