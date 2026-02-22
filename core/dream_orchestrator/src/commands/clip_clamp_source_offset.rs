use uuid::Uuid;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};
use dream_models::time::AbsoluteTime;

pub struct ClampClipSourceOffsetCommand {
    pub clip_id: Uuid,
    pub max_offset_frames: i64,
}

impl ClampClipSourceOffsetCommand {
    pub fn from_str_id(clip_id: &str, max_offset_frames: i64) -> OrchestratorResult<Self> {
        let clip_id = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            clip_id,
            max_offset_frames,
        })
    }
}

impl Command for ClampClipSourceOffsetCommand {
    type Result = bool;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<bool> {
        let mut project = ctx.lock_project()?;

        for track in &mut project.tracks {
            if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
                if clip.source_offset.sample_frame > self.max_offset_frames {
                    clip.source_offset = AbsoluteTime::new(self.max_offset_frames.max(0));
                    return Ok(true);
                }
                return Ok(false);
            }
        }

        Err(OrchestratorError::NotFound {
            entity: "clip",
            id: self.clip_id.to_string(),
        })
    }
}
