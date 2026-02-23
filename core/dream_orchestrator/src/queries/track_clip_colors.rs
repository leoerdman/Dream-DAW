use std::collections::HashMap;

use uuid::Uuid;

use crate::context::{OrchestratorContext, Query};
use crate::error::{OrchestratorError, OrchestratorResult};

#[derive(Debug, Clone, Copy)]
pub struct ResolveTrackClipColorsQuery {
    pub track_id: Uuid,
}

impl Query for ResolveTrackClipColorsQuery {
    type Result = HashMap<Uuid, Option<String>>;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let project = ctx.lock_project()?;
        let track = project
            .tracks
            .iter()
            .find(|track| track.id == self.track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "Track",
                id: self.track_id.to_string(),
            })?;

        let mut map = HashMap::new();
        for clip in &track.clips {
            map.insert(clip.id, clip.color_hex.clone());
        }
        for clip in &track.midi_clips {
            map.insert(clip.id, clip.color_hex.clone());
        }
        Ok(map)
    }
}
