use dream_models::project::DeviceNode;
use uuid::Uuid;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

pub struct ReplaceMissingPluginSlotCommand {
    pub track_id: Uuid,
    pub slot_id: Uuid,
    pub replacement_plugin_id: String,
    pub replacement_plugin_name: String,
    pub external_audio_inputs: Option<u32>,
    pub supports_sidechain_input: Option<bool>,
    pub external_format: Option<String>,
    pub external_uid: Option<String>,
    pub external_plugin_version: Option<String>,
}

pub struct ReplaceMissingPluginSlotResult {
    pub slot_id: Uuid,
    pub slot_index: usize,
    pub is_instrument: bool,
    pub plugin_name: String,
    pub plugin_uid: String,
}

impl Command for ReplaceMissingPluginSlotCommand {
    type Result = ReplaceMissingPluginSlotResult;

    fn execute(
        &self,
        ctx: &OrchestratorContext,
    ) -> OrchestratorResult<ReplaceMissingPluginSlotResult> {
        let mut project = ctx.lock_project()?;
        let track = project
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "Track",
                id: self.track_id.to_string(),
            })?;
        let (is_instrument, slot_index) =
            if track.instrument.as_ref().map(DeviceNode::id) == Some(self.slot_id) {
                (true, 0usize)
            } else {
                (
                    false,
                    track
                        .effects
                        .iter()
                        .position(|fx| fx.id() == self.slot_id)
                        .ok_or_else(|| OrchestratorError::NotFound {
                            entity: "PluginSlot",
                            id: self.slot_id.to_string(),
                        })?,
                )
            };

        let mut found = false;
        if let Some(slot) = track
            .instrument
            .as_mut()
            .into_iter()
            .flat_map(|node| node.collect_plugin_slots_mut())
            .chain(
                track
                    .effects
                    .iter_mut()
                    .flat_map(|node| node.collect_plugin_slots_mut()),
            )
            .find(|slot| slot.id == self.slot_id)
        {
            found = true;
            if !slot.plugin_id.starts_with("missing://") {
                return Err(OrchestratorError::Other(
                    "Slot is not a missing plugin placeholder".to_string(),
                ));
            }

            slot.plugin_id = self.replacement_plugin_id.clone();
            slot.name = self.replacement_plugin_name.clone();
            slot.external_audio_inputs = self.external_audio_inputs;
            slot.supports_sidechain_input = self.supports_sidechain_input;
            slot.external_format = self.external_format.clone();
            slot.external_uid = self.external_uid.clone();
            slot.external_plugin_version = self.external_plugin_version.clone();
            slot.is_bypassed = false;
        }

        if !found {
            return Err(OrchestratorError::NotFound {
                entity: "PluginSlot",
                id: self.slot_id.to_string(),
            });
        }

        Ok(ReplaceMissingPluginSlotResult {
            slot_id: self.slot_id,
            slot_index,
            is_instrument,
            plugin_name: self.replacement_plugin_name.clone(),
            plugin_uid: self.replacement_plugin_id.clone(),
        })
    }
}
