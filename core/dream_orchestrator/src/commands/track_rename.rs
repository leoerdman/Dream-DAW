use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct RenameTrackResult {
    pub track_id: Uuid,
    pub new_name: String,
    pub changed: bool,
}

pub struct RenameTrackByIndexCommand {
    pub index: usize,
    pub name: String,
}

impl Command for RenameTrackByIndexCommand {
    type Result = RenameTrackResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        if self.index >= project.tracks.len() {
            return Err(OrchestratorError::TrackOutOfRange {
                requested: self.index,
                total: project.tracks.len(),
            });
        }

        let sanitized: String = self
            .name
            .chars()
            .filter(|c| !c.is_control())
            .take(256)
            .collect();
        if sanitized.is_empty() {
            return Err(OrchestratorError::Other(
                "Track name cannot be empty".to_string(),
            ));
        }

        let track = &mut project.tracks[self.index];
        if track.name == sanitized {
            return Ok(RenameTrackResult {
                track_id: track.id,
                new_name: sanitized,
                changed: false,
            });
        }
        track.name = sanitized.clone();
        Ok(RenameTrackResult {
            track_id: track.id,
            new_name: sanitized,
            changed: true,
        })
    }
}
