use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};
use dream_models::project::TrackType;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct DeleteTrackByIndexResult {
    pub removed_track_id: Uuid,
    pub removed_track_name: String,
    pub removed_index: usize,
}

pub struct DeleteTrackByIndexCommand {
    pub index: usize,
}

#[derive(Debug, Clone, Default)]
pub struct DeleteTracksByIdsResult {
    pub removed_track_ids: Vec<Uuid>,
}

pub struct DeleteTracksByIdsCommand {
    pub track_ids: Vec<Uuid>,
}

impl DeleteTracksByIdsCommand {
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

impl Command for DeleteTrackByIndexCommand {
    type Result = DeleteTrackByIndexResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        if self.index >= project.tracks.len() {
            return Err(OrchestratorError::TrackOutOfRange {
                requested: self.index,
                total: project.tracks.len(),
            });
        }

        let removed_track = project.tracks.remove(self.index);
        let removed_track_id = removed_track.id;
        let removed_track_name = removed_track.name;
        detach_removed_track_references(&mut project, removed_track_id);

        Ok(DeleteTrackByIndexResult {
            removed_track_id,
            removed_track_name,
            removed_index: self.index,
        })
    }
}

impl Command for DeleteTracksByIdsCommand {
    type Result = DeleteTracksByIdsResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        if self.track_ids.is_empty() {
            return Ok(DeleteTracksByIdsResult::default());
        }

        let mut project = ctx.lock_project()?;
        let mut selected_indices: Vec<usize> = project
            .tracks
            .iter()
            .enumerate()
            .filter_map(|(idx, t)| {
                if self.track_ids.contains(&t.id) && t.track_type != TrackType::Master {
                    Some(idx)
                } else {
                    None
                }
            })
            .collect();

        if selected_indices.is_empty() {
            return Ok(DeleteTracksByIdsResult::default());
        }

        selected_indices.sort_unstable_by(|a, b| b.cmp(a));
        let mut removed_track_ids = Vec::with_capacity(selected_indices.len());
        for idx in selected_indices {
            if idx >= project.tracks.len() {
                continue;
            }
            let removed_track = project.tracks.remove(idx);
            let removed_id = removed_track.id;
            removed_track_ids.push(removed_id);
            detach_removed_track_references(&mut project, removed_id);
        }

        Ok(DeleteTracksByIdsResult { removed_track_ids })
    }
}

pub(crate) fn detach_removed_track_references(project: &mut dream_models::project::Project, removed_id: Uuid) {
    let removed_id_str = removed_id.to_string();

    // Helper: clear sidechain_source_track_id on all PluginSlots within a DeviceNode tree.
    fn clear_sidechain_refs_in_node(node: &mut dream_models::project::DeviceNode, removed_id_str: &str) {
        match node {
            dream_models::project::DeviceNode::Single(slot) => {
                if slot.sidechain_source_track_id.as_deref() == Some(removed_id_str) {
                    slot.sidechain_source_track_id = None;
                }
            }
            dream_models::project::DeviceNode::Rack(rack) => {
                for chain in &mut rack.chains {
                    for child in &mut chain.devices {
                        clear_sidechain_refs_in_node(child, removed_id_str);
                    }
                }
            }
        }
    }

    for track in &mut project.tracks {
        if track.parent_track_id == Some(removed_id) {
            track.parent_track_id = None;
        }
        if track.output_destination_id == Some(removed_id) {
            track.output_destination_id = track.parent_track_id;
        }
        track
            .child_track_ids
            .retain(|child_id| *child_id != removed_id);

        // SIDECHAIN-CLEANUP: Clear dangling sidechain_source_track_id refs
        // on ALL plugins (instrument + effects, including nested racks).
        // Previously these zombie refs persisted, causing:
        //  - Silent sidechain dropout (source track no longer exists)
        //  - Stale UI showing dead sidechain assignment
        //  - DAG edges resolving to None on next rebuild (safe but wrong)
        if let Some(inst) = &mut track.instrument {
            clear_sidechain_refs_in_node(inst, &removed_id_str);
        }
        for effect in &mut track.effects {
            clear_sidechain_refs_in_node(effect, &removed_id_str);
        }
    }

    // Also clean master track sidechain refs (master can have SC plugins too).
    if let Some(inst) = &mut project.master_track.instrument {
        clear_sidechain_refs_in_node(inst, &removed_id_str);
    }
    for effect in &mut project.master_track.effects {
        clear_sidechain_refs_in_node(effect, &removed_id_str);
    }
}
