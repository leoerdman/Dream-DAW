use uuid::Uuid;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};
use dream_models::project::TrackType;

#[derive(Debug, Clone, Copy)]
pub struct MoveTrackWithParentResult {
    pub old_index: usize,
    pub new_index: usize,
}

pub struct MoveTrackWithParentCommand {
    pub track_id: Uuid,
    pub target_index: usize,
    pub target_parent_group_id: Option<Uuid>,
}

pub struct SetTrackGroupCommand {
    pub track_id: Uuid,
    pub target_group_id: Option<Uuid>,
}

impl MoveTrackWithParentCommand {
    pub fn from_str_ids(
        track_id: &str,
        target_index: usize,
        target_parent_group_id: Option<&str>,
    ) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;

        let target_parent_group_id = match target_parent_group_id {
            Some(raw) if raw == "none" || raw == "master" || raw.trim().is_empty() => None,
            Some(raw) => Some(
                Uuid::parse_str(raw).map_err(|e| OrchestratorError::InvalidId {
                    field: "target_parent_group_id",
                    value: raw.to_string(),
                    source: e,
                })?,
            ),
            None => None,
        };

        Ok(Self {
            track_id,
            target_index,
            target_parent_group_id,
        })
    }
}

impl SetTrackGroupCommand {
    pub fn from_str_ids(track_id: &str, target_group_id: Option<&str>) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;

        let target_group_id = match target_group_id {
            Some(raw) if raw == "none" || raw == "master" || raw.trim().is_empty() => None,
            Some(raw) => Some(
                Uuid::parse_str(raw).map_err(|e| OrchestratorError::InvalidId {
                    field: "group_id",
                    value: raw.to_string(),
                    source: e,
                })?,
            ),
            None => None,
        };

        Ok(Self {
            track_id,
            target_group_id,
        })
    }
}

impl Command for MoveTrackWithParentCommand {
    type Result = MoveTrackWithParentResult;

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

        if let Some(parent_id) = self.target_parent_group_id {
            let parent_track = project
                .tracks
                .iter()
                .find(|t| t.id == parent_id)
                .ok_or_else(|| OrchestratorError::NotFound {
                    entity: "TargetGroup",
                    id: parent_id.to_string(),
                })?;
            if parent_track.track_type != TrackType::Group {
                return Err(OrchestratorError::Other(
                    "Target parent must be a group track".to_string(),
                ));
            }
            if self.track_id == parent_id {
                return Err(OrchestratorError::Other(
                    "Track cannot be grouped into itself".to_string(),
                ));
            }
            if track_is_descendant_of(&project, parent_id, self.track_id) {
                return Err(OrchestratorError::Other(
                    "Cannot move track into its own descendant".to_string(),
                ));
            }
        }

        let mut moving_track = project.tracks.remove(from_index);
        moving_track.parent_track_id = self.target_parent_group_id;
        moving_track.output_destination_id = self.target_parent_group_id;

        if let Some(parent_id) = self.target_parent_group_id
            && let Some(parent_track) = project.tracks.iter_mut().find(|t| t.id == parent_id)
        {
            parent_track.output_destination_id = parent_track.parent_track_id;
        }

        let max_insert = project.tracks.len();
        let mut insert_index = self.target_index.min(max_insert);
        if from_index < insert_index {
            insert_index = insert_index.saturating_sub(1);
        }
        project.tracks.insert(insert_index, moving_track);

        Ok(MoveTrackWithParentResult {
            old_index: from_index,
            new_index: insert_index,
        })
    }
}

impl Command for SetTrackGroupCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        let mut project = ctx.lock_project()?;

        if let Some(group_uuid) = self.target_group_id {
            let group_track = project
                .tracks
                .iter()
                .find(|t| t.id == group_uuid)
                .ok_or_else(|| OrchestratorError::NotFound {
                    entity: "Group",
                    id: group_uuid.to_string(),
                })?;
            if group_track.track_type != TrackType::Group {
                return Err(OrchestratorError::Other(
                    "Target track is not a group".to_string(),
                ));
            }
            if group_uuid == self.track_id {
                return Err(OrchestratorError::Other(
                    "Track cannot be grouped into itself".to_string(),
                ));
            }
            if track_is_descendant_of(&project, group_uuid, self.track_id) {
                return Err(OrchestratorError::Other(
                    "Cannot group into descendant track".to_string(),
                ));
            }
        }

        let track = project
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "Track",
                id: self.track_id.to_string(),
            })?;
        track.parent_track_id = self.target_group_id;
        track.output_destination_id = self.target_group_id;

        if let Some(group_uuid) = self.target_group_id
            && let Some(group_track) = project.tracks.iter_mut().find(|t| t.id == group_uuid)
        {
            group_track.output_destination_id = group_track.parent_track_id;
        }

        Ok(())
    }
}

fn track_is_descendant_of(
    project: &dream_models::project::Project,
    track_id: Uuid,
    possible_ancestor: Uuid,
) -> bool {
    let mut current = project
        .tracks
        .iter()
        .find(|t| t.id == track_id)
        .and_then(|t| t.parent_track_id);

    while let Some(parent_id) = current {
        if parent_id == possible_ancestor {
            return true;
        }
        current = project
            .tracks
            .iter()
            .find(|t| t.id == parent_id)
            .and_then(|t| t.parent_track_id);
    }
    false
}
