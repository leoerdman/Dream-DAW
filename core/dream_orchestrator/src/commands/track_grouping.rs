use std::collections::HashMap;

use uuid::Uuid;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};
use dream_models::project::{Project, Track, TrackColor, TrackType};

#[derive(Debug, Clone)]
pub struct CreateGroupResult {
    pub group_id: Uuid,
    pub group_name: String,
    pub child_track_ids: Vec<Uuid>,
}

pub struct CreateGroupCommand {
    pub track_ids: Vec<Uuid>,
    pub group_name: Option<String>,
}

pub struct SetGroupExpandedCommand {
    pub group_id: Uuid,
    pub expanded: bool,
}

impl CreateGroupCommand {
    pub fn from_str_track_ids(
        track_ids: &[String],
        group_name: Option<String>,
    ) -> OrchestratorResult<Self> {
        if track_ids.is_empty() {
            return Err(OrchestratorError::Other(
                "No tracks selected for grouping".to_string(),
            ));
        }
        let track_ids = track_ids
            .iter()
            .map(|id| {
                Uuid::parse_str(id).map_err(|e| OrchestratorError::InvalidId {
                    field: "track_id",
                    value: id.clone(),
                    source: e,
                })
            })
            .collect::<OrchestratorResult<Vec<_>>>()?;
        Ok(Self {
            track_ids,
            group_name,
        })
    }
}

impl SetGroupExpandedCommand {
    pub fn from_str_group_id(group_id: &str, expanded: bool) -> OrchestratorResult<Self> {
        let group_id = Uuid::parse_str(group_id).map_err(|e| OrchestratorError::InvalidId {
            field: "group_id",
            value: group_id.to_string(),
            source: e,
        })?;
        Ok(Self { group_id, expanded })
    }
}

impl Command for CreateGroupCommand {
    type Result = CreateGroupResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;

        let mut selected: Vec<(usize, Uuid)> = project
            .tracks
            .iter()
            .enumerate()
            .filter_map(|(idx, track)| {
                if self.track_ids.contains(&track.id) && track.track_type != TrackType::Master {
                    Some((idx, track.id))
                } else {
                    None
                }
            })
            .collect();

        if selected.is_empty() {
            return Err(OrchestratorError::Other(
                "No valid tracks found for grouping".to_string(),
            ));
        }

        selected.sort_by_key(|(idx, _)| *idx);
        let first_index = selected[0].0;
        let selected_ids_in_order: Vec<Uuid> = selected.iter().map(|(_, id)| *id).collect();

        let (group_color, group_color_hex) = selected
            .first()
            .and_then(|(_, id)| {
                project
                    .tracks
                    .iter()
                    .find(|track| track.id == *id)
                    .map(|track| (track.color, track.color_hex.clone()))
            })
            .unwrap_or_else(|| (TrackColor::for_index(first_index), None));

        let group_num = project
            .tracks
            .iter()
            .filter(|track| track.track_type == TrackType::Group)
            .count()
            + 1;

        let mut group_track = Track::with_type(
            self.group_name
                .clone()
                .unwrap_or_else(|| format!("Group {}", group_num)),
            TrackType::Group,
            first_index,
        );
        group_track.parent_track_id = None;
        group_track.output_destination_id = None;
        group_track.is_expanded = true;
        group_track.child_track_ids.clear();
        group_track.color = group_color;
        group_track.color_hex = group_color_hex;
        let group_id = group_track.id;
        let group_name = group_track.name.clone();

        project.tracks.insert(first_index, group_track);

        let mut child_tracks: Vec<Track> = Vec::with_capacity(selected_ids_in_order.len());
        for child_id in &selected_ids_in_order {
            if let Some(current_index) = project
                .tracks
                .iter()
                .position(|track| track.id == *child_id)
            {
                let mut child = project.tracks.remove(current_index);
                child.parent_track_id = Some(group_id);
                child.output_destination_id = Some(group_id);
                child_tracks.push(child);
            }
        }

        for (offset, child) in child_tracks.into_iter().enumerate() {
            project.tracks.insert(first_index + 1 + offset, child);
        }

        Ok(CreateGroupResult {
            group_id,
            group_name,
            child_track_ids: selected_ids_in_order,
        })
    }
}

impl Command for SetGroupExpandedCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let group_track = project
            .tracks
            .iter_mut()
            .find(|track| track.id == self.group_id && track.track_type == TrackType::Group)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "GroupTrack",
                id: self.group_id.to_string(),
            })?;
        group_track.is_expanded = self.expanded;
        Ok(())
    }
}

pub fn snapshot_track_order_and_parent(
    project: &Project,
) -> (Vec<Uuid>, HashMap<Uuid, Option<Uuid>>) {
    (
        project.tracks.iter().map(|track| track.id).collect(),
        project
            .tracks
            .iter()
            .map(|track| (track.id, track.parent_track_id))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::OrchestratorContext;

    #[test]
    fn create_group_adds_group_and_reparents_children() {
        let mut project = Project::new("t", 120.0, 44100.0);
        let t1 = Track::new("A");
        let t2 = Track::new("B");
        let t1_id = t1.id;
        let t2_id = t2.id;
        project.tracks = vec![t1, t2];

        let ctx = OrchestratorContext::new(project);
        let cmd = CreateGroupCommand {
            track_ids: vec![t1_id, t2_id],
            group_name: Some("Drums".to_string()),
        };
        let result = ctx.execute(&cmd).expect("execute");

        assert_eq!(result.group_name, "Drums");
        assert_eq!(result.child_track_ids, vec![t1_id, t2_id]);

        let project = ctx.lock_project().expect("lock");
        assert_eq!(project.tracks.len(), 3);
        assert_eq!(project.tracks[0].id, result.group_id);
        assert_eq!(project.tracks[0].track_type, TrackType::Group);
        assert_eq!(project.tracks[1].parent_track_id, Some(result.group_id));
        assert_eq!(project.tracks[2].parent_track_id, Some(result.group_id));
    }

    #[test]
    fn set_group_expanded_updates_flag() {
        let mut project = Project::new("t", 120.0, 44100.0);
        let group = Track::with_type("G", TrackType::Group, 0);
        let group_id = group.id;
        project.tracks.push(group);
        let ctx = OrchestratorContext::new(project);

        let cmd = SetGroupExpandedCommand {
            group_id,
            expanded: false,
        };
        ctx.execute(&cmd).expect("execute");

        let project = ctx.lock_project().expect("lock");
        assert!(!project.tracks[0].is_expanded);
    }
}
