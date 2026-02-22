use uuid::Uuid;

use crate::context::{OrchestratorContext, Query};
use crate::error::{OrchestratorError, OrchestratorResult};

#[derive(Debug, Clone, Copy)]
pub struct ResolveExternalPluginParamTargetQuery {
    pub track_id: Uuid,
    pub slot_id: Uuid,
}

#[derive(Debug, Clone)]
pub struct ExternalPluginParamTarget {
    pub slot_id: Uuid,
    pub plugin_id: String,
}

impl Query for ResolveExternalPluginParamTargetQuery {
    type Result = ExternalPluginParamTarget;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let project = ctx.lock_project()?;
        let slot = dream_importers::routing_helpers::find_slot_on_track(
            &project,
            self.track_id,
            self.slot_id,
        )
        .ok_or_else(|| OrchestratorError::NotFound {
            entity: "PluginSlot",
            id: self.slot_id.to_string(),
        })?;
        if slot.plugin_id.starts_with("internal://") {
            return Err(OrchestratorError::Other(
                "Internal plugin slot does not support external parameter API".to_string(),
            ));
        }

        Ok(ExternalPluginParamTarget {
            slot_id: slot.id,
            plugin_id: slot.plugin_id,
        })
    }
}
