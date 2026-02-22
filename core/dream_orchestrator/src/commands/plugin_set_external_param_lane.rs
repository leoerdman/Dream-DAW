use uuid::Uuid;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

#[derive(Debug, Clone)]
pub struct SetExternalPluginParamLaneCommand {
    pub track_id: Uuid,
    pub slot_id: Uuid,
    pub param_index: u32,
    pub normalized_value: f64,
}

impl SetExternalPluginParamLaneCommand {
    pub fn from_str_ids(
        track_id: &str,
        slot_id: &str,
        param_index: u32,
        normalized_value: f64,
    ) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        let slot_id = Uuid::parse_str(slot_id).map_err(|e| OrchestratorError::InvalidId {
            field: "slot_id",
            value: slot_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            track_id,
            slot_id,
            param_index,
            normalized_value: normalized_value.clamp(0.0, 1.0),
        })
    }
}

impl Command for SetExternalPluginParamLaneCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let track = project
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "Track",
                id: self.track_id.to_string(),
            })?;

        let lane_param_id = format!("ext:{}:{}", self.slot_id, self.param_index);
        let legacy_param_id = format!("slot:{}:ext_param_{}", self.slot_id, self.param_index);
        let point = dream_models::project::AutomationPoint {
            beat: 0.0,
            value: self.normalized_value,
            curve_type: "linear".to_string(),
            tension: None,
            bezier_cp1x: None,
            bezier_cp1y: None,
            bezier_cp2x: None,
            bezier_cp2y: None,
        };

        track
            .automation_lanes
            .retain(|lane| !lane.param_id.eq_ignore_ascii_case(&legacy_param_id));

        if let Some(existing_lane) = track
            .automation_lanes
            .iter_mut()
            .find(|lane| lane.param_id.eq_ignore_ascii_case(&lane_param_id))
        {
            existing_lane.param_id = lane_param_id;
            existing_lane.points = vec![point];
        } else {
            track
                .automation_lanes
                .push(dream_models::project::AutomationLane {
                    param_id: lane_param_id,
                    points: vec![point],
                });
        }

        Ok(())
    }
}
