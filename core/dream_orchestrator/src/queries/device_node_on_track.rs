use uuid::Uuid;

use crate::context::{OrchestratorContext, Query};
use crate::error::{OrchestratorError, OrchestratorResult};

#[derive(Debug, Clone, Copy)]
pub struct ResolveDeviceNodeOnTrackQuery {
    pub track_id: Uuid,
    pub device_id: Uuid,
}

impl Query for ResolveDeviceNodeOnTrackQuery {
    type Result = dream_models::project::DeviceNode;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let project = ctx.lock_project()?;
        dream_importers::routing_helpers::find_device_node_on_track(
            &project,
            self.track_id,
            self.device_id,
        )
        .ok_or_else(|| OrchestratorError::NotFound {
            entity: "DeviceNode",
            id: self.device_id.to_string(),
        })
    }
}
