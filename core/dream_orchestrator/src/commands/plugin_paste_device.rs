use uuid::Uuid;

use dream_models::midi::SamplerConfig;
use dream_models::project::{
    DeviceNode, PluginSlot, TrackType, builtin_effect_type_from_plugin_id,
};

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

#[derive(Debug, Clone, Copy)]
pub struct RuntimeAddDevice {
    pub track_id: Uuid,
    pub slot_index: u8,
    pub effect_type: u8,
}

#[derive(Debug, Clone)]
pub struct PasteDeviceToTrackResult {
    pub use_instrument: bool,
    pub new_slots: Vec<PluginSlot>,
    pub runtime_add: Option<RuntimeAddDevice>,
}

pub struct PasteDeviceToTrackCommand {
    pub track_id: Uuid,
    pub slot_hint: Option<String>,
    pub pasted_node: DeviceNode,
}

impl Command for PasteDeviceToTrackCommand {
    type Result = PasteDeviceToTrackResult;

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

        let hint = self.slot_hint.as_deref().unwrap_or("auto").to_lowercase();
        let plugin_id = self.pasted_node.plugin_id();
        let is_instrument_plugin = plugin_id.contains("instrument/");
        let use_instrument = match hint.as_str() {
            "instrument" => track.track_type == TrackType::Midi,
            "effect" => false,
            _ => {
                if track.track_type != TrackType::Midi {
                    false
                } else {
                    is_instrument_plugin
                }
            }
        };

        let new_slots: Vec<PluginSlot> = self
            .pasted_node
            .collect_plugin_slots()
            .into_iter()
            .cloned()
            .collect();

        let mut runtime_add: Option<RuntimeAddDevice> = None;
        if use_instrument {
            let pid_lower = plugin_id.to_lowercase();
            if (pid_lower.contains("sampler") || pid_lower.contains("wave-synth"))
                && track.sampler.is_none()
            {
                track.sampler = Some(SamplerConfig::default());
            }
            track.instrument = Some(self.pasted_node.clone());
        } else {
            let opt_internal_idx = dream_graph::routing::device_chain::DeviceChain::insert_effect(
                track,
                self.pasted_node.clone(),
                None,
            );

            if let DeviceNode::Single(slot) = &self.pasted_node
                && slot.plugin_id.starts_with("internal://effect/")
                && let Some(effect_type) = builtin_effect_type_from_plugin_id(&slot.plugin_id)
                && let Some(internal_slot_index) = opt_internal_idx
            {
                runtime_add = Some(RuntimeAddDevice {
                    track_id: track.id,
                    slot_index: internal_slot_index,
                    effect_type,
                });
            }
        }

        Ok(PasteDeviceToTrackResult {
            use_instrument,
            new_slots,
            runtime_add,
        })
    }
}
