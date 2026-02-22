// ═══════════════════════════════════════════════════════════════════════════
// SplitClipCommand — Split a clip at a given frame position
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use dream_models::mutators;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

/// Result of a split operation.
pub struct SplitClipResult {
    pub left_id: Uuid,
    pub right_id: Uuid,
}

/// Split a clip (audio or MIDI) at the given sample frame position.
///
/// Tries audio clip split first, falls back to MIDI clip split.
/// Both halves preserve correct `source_offset` for seamless playback.
pub struct SplitClipCommand {
    pub clip_id: Uuid,
    pub split_frame: i64,
}

impl SplitClipCommand {
    pub fn from_str_id(clip_id: &str, split_frame: i64) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            clip_id: uuid,
            split_frame,
        })
    }
}

impl Command for SplitClipCommand {
    type Result = SplitClipResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<SplitClipResult> {
        let mut project = ctx.lock_project()?;

        let result = match mutators::split_clip(&mut project, self.clip_id, self.split_frame) {
            Ok(r) => r,
            Err(_audio_err) => {
                mutators::split_midi_clip(&mut project, self.clip_id, self.split_frame)?
            }
        };

        Ok(SplitClipResult {
            left_id: result.left_id,
            right_id: result.right_id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dream_models::project::{AudioClip, Project, Track};
    use dream_models::time::AbsoluteTime;

    #[test]
    fn split_clip_produces_two_halves() {
        let ctx = OrchestratorContext::new(Project::new("test", 120.0, 44_100.0));

        let clip_id;
        {
            let mut project = ctx.lock_project().unwrap();
            let mut track = Track::new("Split Test");
            let clip = AudioClip::new(
                "clip",
                "/tmp/test.wav",
                AbsoluteTime::new(0),
                AbsoluteTime::new(1000),
            );
            clip_id = clip.id;
            track.clips.push(clip);
            project.tracks.push(track);
        }

        let cmd = SplitClipCommand {
            clip_id,
            split_frame: 500,
        };
        let result = ctx.execute(&cmd).unwrap();

        assert_eq!(result.left_id, clip_id);
        assert_ne!(result.right_id, clip_id);

        // Verify project now has 2 clips
        let project = ctx.lock_project().unwrap();
        assert_eq!(project.tracks[0].clips.len(), 2);
    }

    #[test]
    fn split_invalid_id_returns_error() {
        let result = SplitClipCommand::from_str_id("not-a-uuid", 500);
        assert!(result.is_err());
    }
}
