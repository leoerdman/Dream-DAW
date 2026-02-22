use uuid::Uuid;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};
use dream_models::project::{DeviceNode, Project, Track, TrackType};

#[derive(Debug, Clone, Copy)]
pub struct UngroupTrackResult {
    pub removed_index: usize,
    pub reassigned_children: usize,
}

pub struct UngroupTrackCommand {
    pub group_id: Uuid,
}

#[derive(Debug, Clone, Copy)]
pub struct MoveTrackBlockToIndexResult {
    pub old_first_index: usize,
    pub new_first_index: usize,
    pub block_len: usize,
}

pub struct MoveTrackBlockToIndexCommand {
    pub root_track_id: Uuid,
    pub target_index: usize,
}

#[derive(Debug, Clone)]
pub struct AddedTrack {
    pub track_id: Uuid,
    pub name: String,
    pub track_type: TrackType,
    pub inserted_index: usize,
}

#[derive(Debug, Clone, Default)]
pub struct DuplicateTracksResult {
    pub added_tracks: Vec<AddedTrack>,
}

pub struct DuplicateTracksCommand {
    pub track_ids: Vec<Uuid>,
}

impl UngroupTrackCommand {
    pub fn from_str_group_id(group_id: &str) -> OrchestratorResult<Self> {
        let group_id = Uuid::parse_str(group_id).map_err(|e| OrchestratorError::InvalidId {
            field: "group_id",
            value: group_id.to_string(),
            source: e,
        })?;
        Ok(Self { group_id })
    }
}

impl MoveTrackBlockToIndexCommand {
    pub fn from_str_root_track_id(
        root_track_id: &str,
        target_index: usize,
    ) -> OrchestratorResult<Self> {
        let root_track_id =
            Uuid::parse_str(root_track_id).map_err(|e| OrchestratorError::InvalidId {
                field: "root_track_id",
                value: root_track_id.to_string(),
                source: e,
            })?;
        Ok(Self {
            root_track_id,
            target_index,
        })
    }
}

impl DuplicateTracksCommand {
    pub fn from_str_track_ids(track_ids: &[String]) -> OrchestratorResult<Self> {
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
        Ok(Self { track_ids })
    }
}

impl Command for UngroupTrackCommand {
    type Result = UngroupTrackResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let group_index = project
            .tracks
            .iter()
            .position(|t| t.id == self.group_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "GroupTrack",
                id: self.group_id.to_string(),
            })?;

        let parent_of_group = project.tracks[group_index].parent_track_id;
        if project.tracks[group_index].track_type != TrackType::Group {
            return Err(OrchestratorError::Other(
                "Selected track is not a group".to_string(),
            ));
        }

        let mut reassigned_children = 0usize;
        for track in &mut project.tracks {
            if track.parent_track_id == Some(self.group_id) {
                track.parent_track_id = parent_of_group;
                track.output_destination_id = parent_of_group;
                reassigned_children += 1;
            }
        }

        project.tracks.remove(group_index);

        Ok(UngroupTrackResult {
            removed_index: group_index,
            reassigned_children,
        })
    }
}

impl Command for MoveTrackBlockToIndexCommand {
    type Result = MoveTrackBlockToIndexResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let block_ids = collect_block_track_ids(&project, self.root_track_id);
        if block_ids.is_empty() {
            return Err(OrchestratorError::NotFound {
                entity: "Track",
                id: self.root_track_id.to_string(),
            });
        }

        let mut block_indices: Vec<usize> = project
            .tracks
            .iter()
            .enumerate()
            .filter_map(|(idx, t)| {
                if block_ids.contains(&t.id) {
                    Some(idx)
                } else {
                    None
                }
            })
            .collect();
        block_indices.sort_unstable();

        let old_first_index = block_indices[0];
        let block_len = block_indices.len();

        let mut block_tracks: Vec<Track> = Vec::with_capacity(block_len);
        for idx in block_indices.iter().rev() {
            block_tracks.push(project.tracks.remove(*idx));
        }
        block_tracks.reverse();

        let removed_before_target = block_indices
            .iter()
            .filter(|idx| **idx < self.target_index)
            .count();
        let mut adjusted_target = self.target_index.saturating_sub(removed_before_target);
        if adjusted_target > project.tracks.len() {
            adjusted_target = project.tracks.len();
        }

        for (offset, track) in block_tracks.into_iter().enumerate() {
            project.tracks.insert(adjusted_target + offset, track);
        }

        Ok(MoveTrackBlockToIndexResult {
            old_first_index,
            new_first_index: adjusted_target,
            block_len,
        })
    }
}

impl Command for DuplicateTracksCommand {
    type Result = DuplicateTracksResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        if self.track_ids.is_empty() {
            return Ok(DuplicateTracksResult::default());
        }

        let mut project = ctx.lock_project()?;
        let selected_indices: Vec<usize> = project
            .tracks
            .iter()
            .enumerate()
            .filter_map(|(idx, track)| {
                if self.track_ids.contains(&track.id) {
                    Some(idx)
                } else {
                    None
                }
            })
            .collect();

        if selected_indices.is_empty() {
            return Ok(DuplicateTracksResult::default());
        }

        let mut parent_id_map: std::collections::HashMap<Uuid, Option<Uuid>> =
            std::collections::HashMap::new();
        let mut originals: Vec<Track> = Vec::with_capacity(selected_indices.len());
        for idx in &selected_indices {
            originals.push(project.tracks[*idx].clone());
        }

        let mut duplicates: Vec<Track> = Vec::with_capacity(originals.len());
        for source in &originals {
            let duplicate = duplicate_track_with_new_ids(source);
            parent_id_map.insert(source.id, source.parent_track_id);
            duplicates.push(duplicate);
        }

        let old_to_new: std::collections::HashMap<Uuid, Uuid> = originals
            .iter()
            .zip(duplicates.iter())
            .map(|(old_track, new_track)| (old_track.id, new_track.id))
            .collect();

        for duplicate in &mut duplicates {
            let source_parent = parent_id_map
                .iter()
                .find_map(|(old_id, parent)| {
                    if old_to_new.get(old_id) == Some(&duplicate.id) {
                        Some(*parent)
                    } else {
                        None
                    }
                })
                .flatten();
            duplicate.parent_track_id = source_parent
                .and_then(|parent_id| old_to_new.get(&parent_id).copied())
                .or(source_parent);
            duplicate.output_destination_id = duplicate.parent_track_id;
        }

        let mut insert_at = selected_indices.iter().max().copied().unwrap_or(0) + 1;
        let mut added_tracks = Vec::with_capacity(duplicates.len());
        for duplicate in duplicates {
            if insert_at > project.tracks.len() {
                insert_at = project.tracks.len();
            }
            let inserted_index = insert_at;
            added_tracks.push(AddedTrack {
                track_id: duplicate.id,
                name: duplicate.name.clone(),
                track_type: duplicate.track_type,
                inserted_index,
            });
            project.tracks.insert(inserted_index, duplicate);
            insert_at += 1;
        }

        Ok(DuplicateTracksResult { added_tracks })
    }
}

fn collect_block_track_ids(project: &Project, root_id: Uuid) -> Vec<Uuid> {
    use std::collections::HashMap;

    let parent_map: HashMap<Uuid, Option<Uuid>> = project
        .tracks
        .iter()
        .map(|t| (t.id, t.parent_track_id))
        .collect();

    let mut descendants = Vec::new();
    let max_depth = project.tracks.len();

    for track in &project.tracks {
        if track.id == root_id {
            descendants.push(track.id);
            continue;
        }

        let mut depth = 0usize;
        let mut current = track.parent_track_id;
        while let Some(parent_id) = current {
            if parent_id == root_id {
                descendants.push(track.id);
                break;
            }
            depth += 1;
            if depth > max_depth {
                break;
            }
            current = parent_map.get(&parent_id).and_then(|&p| p);
        }
    }

    descendants
}

fn duplicate_track_with_new_ids(source: &Track) -> Track {
    let mut cloned = source.clone();
    cloned.id = Uuid::new_v4();
    cloned.child_track_ids.clear();

    if let Some(ref mut instrument) = cloned.instrument {
        regenerate_device_node_ids(instrument);
    }
    for fx in &mut cloned.effects {
        regenerate_device_node_ids(fx);
    }

    for clip in &mut cloned.clips {
        clip.id = Uuid::new_v4();
    }
    for midi_clip in &mut cloned.midi_clips {
        midi_clip.id = Uuid::new_v4();
    }

    cloned
}

fn regenerate_device_node_ids(node: &mut DeviceNode) {
    match node {
        DeviceNode::Single(slot) => {
            slot.id = Uuid::new_v4();
        }
        DeviceNode::Rack(rack) => {
            rack.id = Uuid::new_v4();
            for chain in &mut rack.chains {
                chain.id = Uuid::new_v4();
                for device in &mut chain.devices {
                    regenerate_device_node_ids(device);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::OrchestratorContext;
    use dream_models::project::Track;

    #[test]
    fn ungroup_track_reparents_children_and_removes_group() {
        let mut project = Project::new("t", 120.0, 44100.0);
        let mut group = Track::with_type("Group", TrackType::Group, 0);
        let group_id = group.id;
        let mut child = Track::new("Child");
        child.parent_track_id = Some(group_id);
        child.output_destination_id = Some(group_id);
        let child_id = child.id;
        group.child_track_ids.push(child_id);
        let sibling = Track::new("Sibling");

        project.tracks = vec![group, child, sibling];

        let ctx = OrchestratorContext::new(project);
        let cmd = UngroupTrackCommand { group_id };
        let result = ctx.execute(&cmd).expect("execute");
        assert_eq!(result.removed_index, 0);
        assert_eq!(result.reassigned_children, 1);

        let project = ctx.lock_project().expect("lock");
        assert_eq!(project.tracks.len(), 2);
        assert!(project.tracks.iter().all(|t| t.id != group_id));
        let child_track = project
            .tracks
            .iter()
            .find(|t| t.id == child_id)
            .expect("child exists");
        assert_eq!(child_track.parent_track_id, None);
        assert_eq!(child_track.output_destination_id, None);
    }

    #[test]
    fn move_track_block_to_index_moves_group_and_descendants_together() {
        let mut project = Project::new("t", 120.0, 44100.0);
        let group = Track::with_type("Group", TrackType::Group, 0);
        let group_id = group.id;
        let mut child = Track::new("Child");
        child.parent_track_id = Some(group_id);
        let child_id = child.id;
        let outsider1 = Track::new("A");
        let outsider2 = Track::new("B");
        let outsider1_id = outsider1.id;
        let outsider2_id = outsider2.id;

        project.tracks = vec![group, child, outsider1, outsider2];
        let ctx = OrchestratorContext::new(project);
        let cmd = MoveTrackBlockToIndexCommand {
            root_track_id: group_id,
            target_index: 4,
        };

        let result = ctx.execute(&cmd).expect("execute");
        assert_eq!(result.old_first_index, 0);
        assert_eq!(result.new_first_index, 2);
        assert_eq!(result.block_len, 2);

        let project = ctx.lock_project().expect("lock");
        let order: Vec<Uuid> = project.tracks.iter().map(|t| t.id).collect();
        assert_eq!(order, vec![outsider1_id, outsider2_id, group_id, child_id]);
    }

    #[test]
    fn duplicate_tracks_creates_new_track_and_clip_ids() {
        let mut project = Project::new("t", 120.0, 44100.0);
        let mut source = Track::new("Source");
        let source_id = source.id;
        source.clips.push(dream_models::project::AudioClip::new(
            "a.wav".to_string(),
            "a.wav".to_string(),
            dream_models::time::AbsoluteTime::new(0),
            dream_models::time::AbsoluteTime::new(128),
        ));
        let source_clip_id = source.clips[0].id;

        project.tracks.push(source);

        let ctx = OrchestratorContext::new(project);
        let cmd = DuplicateTracksCommand {
            track_ids: vec![source_id],
        };
        let result = ctx.execute(&cmd).expect("execute");
        assert_eq!(result.added_tracks.len(), 1);
        assert_eq!(result.added_tracks[0].inserted_index, 1);
        assert_ne!(result.added_tracks[0].track_id, source_id);

        let project = ctx.lock_project().expect("lock");
        assert_eq!(project.tracks.len(), 2);
        let duplicated = &project.tracks[1];
        assert_ne!(duplicated.id, source_id);
        assert_eq!(duplicated.name, "Source");
        assert_eq!(duplicated.clips.len(), 1);
        assert_ne!(duplicated.clips[0].id, source_clip_id);
    }
}
