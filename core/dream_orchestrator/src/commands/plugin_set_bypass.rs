use uuid::Uuid;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

#[derive(Debug, Clone)]
pub struct SetPluginSlotBypassResult {
    pub track_index: usize,
    pub is_instrument: bool,
    pub plugin_id: String,
}

pub struct SetPluginSlotBypassCommand {
    pub track_id: Uuid,
    pub slot_id: Uuid,
    pub bypassed: bool,
}

impl Command for SetPluginSlotBypassCommand {
    type Result = SetPluginSlotBypassResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let track_index = project
            .tracks
            .iter()
            .position(|t| t.id == self.track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "Track",
                id: self.track_id.to_string(),
            })?;

        let track = &mut project.tracks[track_index];

        if let Some(instrument) = track.instrument.as_mut() {
            for slot in instrument.collect_plugin_slots_mut() {
                if slot.id == self.slot_id {
                    slot.is_bypassed = self.bypassed;
                    return Ok(SetPluginSlotBypassResult {
                        track_index,
                        is_instrument: true,
                        plugin_id: slot.plugin_id.clone(),
                    });
                }
            }
        }

        for effect in &mut track.effects {
            for slot in effect.collect_plugin_slots_mut() {
                if slot.id == self.slot_id {
                    slot.is_bypassed = self.bypassed;
                    return Ok(SetPluginSlotBypassResult {
                        track_index,
                        is_instrument: false,
                        plugin_id: slot.plugin_id.clone(),
                    });
                }
            }
        }

        Err(OrchestratorError::NotFound {
            entity: "PluginSlot",
            id: self.slot_id.to_string(),
        })
    }
}
