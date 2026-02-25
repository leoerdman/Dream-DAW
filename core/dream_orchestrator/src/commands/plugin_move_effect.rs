use uuid::Uuid;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectTrackTarget {
    Master,
    Track(Uuid),
}

impl EffectTrackTarget {
    pub fn from_track_id(track_id: &str) -> OrchestratorResult<Self> {
        if track_id.eq_ignore_ascii_case("master") {
            return Ok(Self::Master);
        }
        let track_uuid = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        Ok(Self::Track(track_uuid))
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MoveEffectSlotResult {
    pub track_id: Uuid,
    pub old_slot_index: usize,
    pub new_slot_index: usize,
    pub changed: bool,
}

pub struct MoveEffectSlotCommand {
    pub target: EffectTrackTarget,
    pub slot_id: Uuid,
    pub target_index: usize,
}

impl Command for MoveEffectSlotCommand {
    type Result = MoveEffectSlotResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;

        let (track_id, track) = match self.target {
            EffectTrackTarget::Master => {
                let track_id = project.master_track.id;
                (track_id, &mut project.master_track)
            }
            EffectTrackTarget::Track(track_id) => {
                let track = project
                    .tracks
                    .iter_mut()
                    .find(|t| t.id == track_id)
                    .ok_or_else(|| OrchestratorError::NotFound {
                        entity: "Track",
                        id: track_id.to_string(),
                    })?;
                (track_id, track)
            }
        };

        let old_slot_index = track
            .effects
            .iter()
            .position(|node| node.id() == self.slot_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "EffectSlot",
                id: self.slot_id.to_string(),
            })?;

        dream_graph::routing::device_chain::DeviceChainOps::move_effect(
            track,
            self.slot_id,
            self.target_index,
        )
        .map_err(|e| OrchestratorError::Other(e.to_string()))?;

        let new_slot_index = track
            .effects
            .iter()
            .position(|node| node.id() == self.slot_id)
            .ok_or_else(|| {
                OrchestratorError::Other(format!(
                    "Moved effect slot not found after move: {}",
                    self.slot_id
                ))
            })?;

        Ok(MoveEffectSlotResult {
            track_id,
            old_slot_index,
            new_slot_index,
            changed: old_slot_index != new_slot_index,
        })
    }
}
