use crate::context::{OrchestratorContext, Query};
use crate::error::OrchestratorResult;
use crate::queries::PluginSlotState;

#[derive(Debug, Clone)]
pub struct ResolvePluginSlotsByPluginIdQuery {
    pub plugin_id: String,
}

impl Query for ResolvePluginSlotsByPluginIdQuery {
    type Result = Vec<PluginSlotState>;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let project = ctx.lock_project()?;
        let plugin_key =
            dream_importers::routing_helpers::normalize_plugin_key_local(&self.plugin_id);
        let mut out: Vec<PluginSlotState> = Vec::new();

        fn collect_matching(
            node: &dream_models::project::DeviceNode,
            plugin_key: &str,
            out: &mut Vec<PluginSlotState>,
        ) {
            match node {
                dream_models::project::DeviceNode::Single(slot) => {
                    if dream_importers::routing_helpers::normalize_plugin_key_local(&slot.plugin_id)
                        == plugin_key
                    {
                        out.push(PluginSlotState::from_project_slot(slot.clone()));
                    }
                }
                dream_models::project::DeviceNode::Rack(rack) => {
                    for chain in &rack.chains {
                        for child in &chain.devices {
                            collect_matching(child, plugin_key, out);
                        }
                    }
                }
            }
        }

        for track in &project.tracks {
            if let Some(instrument) = &track.instrument {
                collect_matching(instrument, &plugin_key, &mut out);
            }
            for fx in &track.effects {
                collect_matching(fx, &plugin_key, &mut out);
            }
        }
        for fx in &project.master_track.effects {
            collect_matching(fx, &plugin_key, &mut out);
        }

        out.sort_by_key(|slot| slot.slot_id);
        out.dedup_by_key(|slot| slot.slot_id);

        Ok(out)
    }
}
