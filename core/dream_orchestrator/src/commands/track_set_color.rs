use uuid::Uuid;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

#[derive(Debug, Clone, Copy)]
pub struct SetTrackColorResult {
    pub changed: bool,
}

pub struct SetTrackColorCommand {
    pub track_id: Uuid,
    pub color_hex: String,
}

impl SetTrackColorCommand {
    pub fn from_str_track_id(track_id: &str, color_hex: String) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            track_id,
            color_hex,
        })
    }
}

impl Command for SetTrackColorCommand {
    type Result = SetTrackColorResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let track = project
            .tracks
            .iter_mut()
            .find(|track| track.id == self.track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "Track",
                id: self.track_id.to_string(),
            })?;

        if track.color_hex.as_deref() == Some(self.color_hex.as_str()) {
            return Ok(SetTrackColorResult { changed: false });
        }
        track.color_hex = Some(self.color_hex.clone());
        Ok(SetTrackColorResult { changed: true })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::OrchestratorContext;
    use dream_models::project::{Project, Track};

    #[test]
    fn set_track_color_updates_track() {
        let mut project = Project::new("t", 120.0, 44100.0);
        let track = Track::new("A");
        let track_id = track.id;
        project.tracks.push(track);

        let ctx = OrchestratorContext::new(project);
        let cmd = SetTrackColorCommand {
            track_id,
            color_hex: "#AABBCC".to_string(),
        };
        let result = ctx.execute(&cmd).expect("execute");
        assert!(result.changed);

        let project = ctx.lock_project().expect("lock");
        assert_eq!(project.tracks[0].color_hex.as_deref(), Some("#AABBCC"));
    }
}
