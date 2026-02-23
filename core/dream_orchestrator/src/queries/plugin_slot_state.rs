use uuid::Uuid;

use crate::context::{OrchestratorContext, Query};
use crate::error::{OrchestratorError, OrchestratorResult};

#[derive(Debug, Clone, Copy)]
pub struct ResolvePluginSlotStateQuery {
    pub track_id: Uuid,
    pub slot_id: Uuid,
}

#[derive(Debug, Clone)]
pub struct PluginSlotState {
    pub slot_id: Uuid,
    pub name: String,
    pub plugin_id: String,
    pub supports_sidechain_input: Option<bool>,
    pub external_parameter_count: Option<i32>,
    pub external_state_blob: Option<String>,
    pub external_state_blob_kind: Option<String>,
    pub external_preset_blob: Option<String>,
    pub external_preset_blob_kind: Option<String>,
}

impl PluginSlotState {
    pub fn from_project_slot(slot: dream_models::project::PluginSlot) -> Self {
        Self {
            slot_id: slot.id,
            name: slot.name,
            plugin_id: slot.plugin_id,
            supports_sidechain_input: slot.supports_sidechain_input,
            external_parameter_count: slot.external_parameter_count,
            external_state_blob: slot.external_state_blob,
            external_state_blob_kind: slot.external_state_blob_kind,
            external_preset_blob: slot.external_preset_blob,
            external_preset_blob_kind: slot.external_preset_blob_kind,
        }
    }
}

impl Query for ResolvePluginSlotStateQuery {
    type Result = PluginSlotState;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let project = ctx.lock_project()?;
        let slot = dream_importers::routing_helpers::find_slot_on_track(
            &project,
            self.track_id,
            self.slot_id,
        )
        .or_else(|| {
            // UI can transiently hold a stale track_id during fast slot reorders.
            // Fall back to global slot-id lookup to keep runtime activation/status robust.
            dream_importers::routing_helpers::find_project_plugin_slot_by_slot_id(
                &project,
                self.slot_id,
            )
        })
        .ok_or_else(|| OrchestratorError::NotFound {
            entity: "PluginSlot",
            id: self.slot_id.to_string(),
        })?;

        Ok(PluginSlotState::from_project_slot(slot))
    }
}
