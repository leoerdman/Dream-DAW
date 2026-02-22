use uuid::Uuid;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

#[derive(Debug, Clone)]
pub struct UpdatePluginExternalStateBlobCommand {
    pub track_id: Uuid,
    pub slot_id: Uuid,
    pub external_state_blob: Option<String>,
    pub external_state_blob_kind: Option<String>,
}

impl Command for UpdatePluginExternalStateBlobCommand {
    type Result = bool;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let slot = dream_importers::routing_helpers::find_slot_on_track_mut(
            &mut project,
            self.track_id,
            self.slot_id,
        )
        .ok_or_else(|| OrchestratorError::NotFound {
            entity: "PluginSlot",
            id: self.slot_id.to_string(),
        })?;

        let changed = slot.external_state_blob != self.external_state_blob
            || slot.external_state_blob_kind != self.external_state_blob_kind;
        if changed {
            slot.external_state_blob = self.external_state_blob.clone();
            slot.external_state_blob_kind = self.external_state_blob_kind.clone();
        }
        Ok(changed)
    }
}
