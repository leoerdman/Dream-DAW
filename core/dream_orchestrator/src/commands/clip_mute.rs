// ═══════════════════════════════════════════════════════════════════════════
// MuteClipCommand — Toggle clip mute, single or batch
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use dream_mutators::clip::apply_clip_mute;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

/// Mute or unmute a single clip.
pub struct MuteClipCommand {
    pub clip_id: Uuid,
    pub muted: bool,
}

impl MuteClipCommand {
    pub fn from_str_id(clip_id: &str, muted: bool) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            clip_id: uuid,
            muted,
        })
    }
}

impl Command for MuteClipCommand {
    type Result = bool; // true if state actually changed

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<bool> {
        let mut project = ctx.lock_project()?;
        let (found, changed) = apply_clip_mute(&mut project, self.clip_id, self.muted);

        if !found {
            return Err(OrchestratorError::NotFound {
                entity: "clip",
                id: self.clip_id.to_string(),
            });
        }

        Ok(changed)
    }
}

/// Batch mute/unmute multiple clips. Creates a single undo step.
pub struct MuteClipsBatchCommand {
    pub clip_ids: Vec<Uuid>,
    pub muted: bool,
}

impl MuteClipsBatchCommand {
    pub fn from_str_ids(clip_ids: &[String], muted: bool) -> OrchestratorResult<Self> {
        let uuids: Result<Vec<Uuid>, _> = clip_ids
            .iter()
            .map(|id| {
                Uuid::parse_str(id).map_err(|e| OrchestratorError::InvalidId {
                    field: "clip_id",
                    value: id.clone(),
                    source: e,
                })
            })
            .collect();
        Ok(Self {
            clip_ids: uuids?,
            muted,
        })
    }
}

impl Command for MuteClipsBatchCommand {
    type Result = usize; // number of clips actually changed

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<usize> {
        let mut project = ctx.lock_project()?;
        let mut changed_count = 0;

        for &clip_id in &self.clip_ids {
            let (found, changed) = apply_clip_mute(&mut project, clip_id, self.muted);
            if found && changed {
                changed_count += 1;
            }
        }

        Ok(changed_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dream_models::project::{AudioClip, Project, Track};
    use dream_models::time::AbsoluteTime;

    fn test_project() -> (OrchestratorContext, Uuid) {
        let ctx = OrchestratorContext::new(Project::new("test", 120.0, 44_100.0));
        let clip_id;
        {
            let mut project = ctx.lock_project().unwrap();
            let mut track = Track::new("MuteTest");
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
        (ctx, clip_id)
    }

    #[test]
    fn mute_single_clip() {
        let (ctx, clip_id) = test_project();
        let cmd = MuteClipCommand {
            clip_id,
            muted: true,
        };
        let changed = ctx.execute(&cmd).unwrap();
        assert!(changed);

        // Muting again should report no change
        let changed = ctx.execute(&cmd).unwrap();
        assert!(!changed);
    }

    #[test]
    fn mute_batch() {
        let (ctx, clip_id) = test_project();
        let cmd = MuteClipsBatchCommand {
            clip_ids: vec![clip_id],
            muted: true,
        };
        let count = ctx.execute(&cmd).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn mute_missing_clip_returns_error() {
        let (ctx, _) = test_project();
        let cmd = MuteClipCommand {
            clip_id: Uuid::new_v4(),
            muted: true,
        };
        assert!(ctx.execute(&cmd).is_err());
    }
}
