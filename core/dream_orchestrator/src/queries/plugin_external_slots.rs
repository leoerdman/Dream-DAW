use crate::context::{OrchestratorContext, Query};
use crate::error::OrchestratorResult;
use crate::queries::PluginSlotState;

#[derive(Debug, Clone, Copy)]
pub struct ListExternalPluginSlotsQuery;

impl Query for ListExternalPluginSlotsQuery {
    type Result = Vec<PluginSlotState>;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let project = ctx.lock_project()?;
        let mut out: Vec<PluginSlotState> = Vec::new();

        fn collect_external(
            node: &dream_models::project::DeviceNode,
            out: &mut Vec<PluginSlotState>,
        ) {
            match node {
                dream_models::project::DeviceNode::Single(slot) => {
                    if slot.plugin_id.is_empty() || slot.plugin_id.starts_with("internal://") {
                        return;
                    }
                    out.push(PluginSlotState::from_project_slot(slot.clone()));
                }
                dream_models::project::DeviceNode::Rack(rack) => {
                    for chain in &rack.chains {
                        for child in &chain.devices {
                            collect_external(child, out);
                        }
                    }
                }
            }
        }

        for track in &project.tracks {
            if let Some(instrument) = &track.instrument {
                collect_external(instrument, &mut out);
            }
            for fx in &track.effects {
                collect_external(fx, &mut out);
            }
        }
        for fx in &project.master_track.effects {
            collect_external(fx, &mut out);
        }

        out.sort_by_key(|slot| slot.slot_id);
        out.dedup_by_key(|slot| slot.slot_id);
        Ok(out)
    }
}
