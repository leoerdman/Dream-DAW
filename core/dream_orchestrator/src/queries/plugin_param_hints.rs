use std::collections::HashMap;

use crate::context::{OrchestratorContext, Query};
use crate::error::OrchestratorResult;

#[derive(Debug, Clone)]
pub struct ResolvePluginParamHintsQuery {
    pub plugin_id: String,
}

#[derive(Debug, Clone)]
pub struct PluginParamHints {
    pub metadata_count: usize,
    pub lane_name_hints: HashMap<u32, String>,
}

impl Query for ResolvePluginParamHintsQuery {
    type Result = PluginParamHints;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let project = ctx.lock_project()?;
        let plugin_key =
            dream_importers::routing_helpers::normalize_plugin_key_local(&self.plugin_id);
        let metadata_count =
            dream_importers::routing_helpers::find_project_plugin_slot(&project, &self.plugin_id)
                .and_then(|slot| slot.external_parameter_count)
                .unwrap_or(0)
                .max(0) as usize;
        let lane_name_hints =
            dream_importers::routing_helpers::lane_param_name_hints(&project, &plugin_key);

        Ok(PluginParamHints {
            metadata_count,
            lane_name_hints,
        })
    }
}
