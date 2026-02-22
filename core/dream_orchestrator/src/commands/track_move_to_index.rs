use uuid::Uuid;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

#[derive(Debug, Clone, Copy)]
pub struct MoveTrackToIndexResult {
    pub old_index: usize,
    pub new_index: usize,
    pub changed: bool,
}

pub struct MoveTrackToIndexCommand {
    pub track_id: Uuid,
    pub target_index: usize,
}

impl MoveTrackToIndexCommand {
    pub fn from_str_track_id(track_id: &str, target_index: usize) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            track_id,
            target_index,
        })
    }
}

impl Command for MoveTrackToIndexCommand {
    type Result = MoveTrackToIndexResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;

        let from_index = project
            .tracks
            .iter()
            .position(|t| t.id == self.track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "Track",
                id: self.track_id.to_string(),
            })?;

        if project.tracks.len() <= 1 {
            return Ok(MoveTrackToIndexResult {
                old_index: from_index,
                new_index: from_index,
                changed: false,
            });
        }

        let max_index = project.tracks.len().saturating_sub(1);
        let to_index = self.target_index.min(max_index);
        if from_index == to_index {
            return Ok(MoveTrackToIndexResult {
                old_index: from_index,
                new_index: to_index,
                changed: false,
            });
        }

        project.move_track(from_index, to_index);

        Ok(MoveTrackToIndexResult {
            old_index: from_index,
            new_index: to_index,
            changed: true,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::OrchestratorContext;
    use dream_models::project::{Project, Track};

    #[test]
    fn move_track_to_index_reorders_tracks() {
        let mut project = Project::new("t", 120.0, 44100.0);
        let t1 = Track::new("T1");
        let t2 = Track::new("T2");
        let t3 = Track::new("T3");
        let t1_id = t1.id;
        let t2_id = t2.id;
        let t3_id = t3.id;
        project.tracks = vec![t1, t2, t3];

        let ctx = OrchestratorContext::new(project);
        let cmd = MoveTrackToIndexCommand {
            track_id: t1_id,
            target_index: 2,
        };

        let result = ctx.execute(&cmd).expect("execute");
        assert!(result.changed);
        assert_eq!(result.old_index, 0);
        assert_eq!(result.new_index, 2);

        let project = ctx.lock_project().expect("lock");
        let ids: Vec<_> = project.tracks.iter().map(|t| t.id).collect();
        assert_eq!(ids, vec![t2_id, t3_id, t1_id]);
    }

    #[test]
    fn move_track_to_index_noop_when_target_is_same() {
        let mut project = Project::new("t", 120.0, 44100.0);
        let t1 = Track::new("T1");
        let t1_id = t1.id;
        project.tracks.push(t1);

        let ctx = OrchestratorContext::new(project);
        let cmd = MoveTrackToIndexCommand {
            track_id: t1_id,
            target_index: 0,
        };

        let result = ctx.execute(&cmd).expect("execute");
        assert!(!result.changed);
        assert_eq!(result.old_index, 0);
        assert_eq!(result.new_index, 0);
    }
}
