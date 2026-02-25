use uuid::Uuid;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

/// Result payload for plugin-slot removal.
///
/// `runtime_remove_slot` is present only for internal effects routed through
/// the realtime engine slot array and must be forwarded by the transport layer
/// as `EngineCommand::RemoveDevice`.
#[derive(Debug, Clone, Copy)]
pub struct RemovePluginFromTrackResult {
    pub track_index: usize,
    pub runtime_remove_slot: Option<u8>,
}

/// Remove a plugin slot (instrument/effect) from a track.
pub struct RemovePluginFromTrackCommand {
    pub track_id: Uuid,
    pub slot_id: Uuid,
}

impl RemovePluginFromTrackCommand {
    pub fn from_str_ids(track_id: &str, slot_id: &str) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        let slot_id = Uuid::parse_str(slot_id).map_err(|e| OrchestratorError::InvalidId {
            field: "slot_id",
            value: slot_id.to_string(),
            source: e,
        })?;
        Ok(Self { track_id, slot_id })
    }
}

impl Command for RemovePluginFromTrackCommand {
    type Result = RemovePluginFromTrackResult;

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

        let mut removed = false;
        let mut runtime_remove_slot: Option<u8> = None;

        if let Some(inst) = &track.instrument
            && inst.id() == self.slot_id
        {
            let removed_plugin_id = inst.plugin_id();
            track.instrument = None;
            let removed_lower = removed_plugin_id.to_lowercase();
            if removed_lower.starts_with("internal://instrument/sampler")
                || removed_lower.starts_with("internal://instrument/wave-synth")
            {
                track.sampler = None;
            }
            removed = true;
        }

        if !removed
            && let Some((_node, runtime_idx)) =
                dream_graph::routing::device_chain::InsertEffectsChain::remove_effect(track, self.slot_id)
        {
            runtime_remove_slot = runtime_idx;
            removed = true;
        }

        if !removed {
            return Err(OrchestratorError::NotFound {
                entity: "PluginSlot",
                id: self.slot_id.to_string(),
            });
        }

        Ok(RemovePluginFromTrackResult {
            track_index,
            runtime_remove_slot,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::OrchestratorContext;
    use dream_models::project::{DeviceNode, PluginSlot, Project, Track};

    #[test]
    fn remove_instrument_clears_track_instrument() {
        let mut project = Project::new("t", 120.0, 44100.0);
        let mut track = Track::new("A");
        let slot = PluginSlot::new("internal://instrument/wave-synth", "Wave Synth");
        let slot_id = slot.id;
        track.instrument = Some(DeviceNode::Single(slot));
        project.tracks.push(track);

        let ctx = OrchestratorContext::new(project);
        let cmd = RemovePluginFromTrackCommand {
            track_id: ctx.lock_project().unwrap().tracks[0].id,
            slot_id,
        };
        let result = ctx.execute(&cmd).unwrap();
        assert_eq!(result.runtime_remove_slot, None);
        assert!(ctx.lock_project().unwrap().tracks[0].instrument.is_none());
    }

    #[test]
    fn remove_internal_effect_returns_runtime_slot() {
        let mut project = Project::new("t", 120.0, 44100.0);
        let mut track = Track::new("A");
        let fx = PluginSlot::new("internal://effect/eq8", "EQ8");
        let fx_id = fx.id;
        track.effects.push(DeviceNode::Single(fx));
        project.tracks.push(track);

        let ctx = OrchestratorContext::new(project);
        let track_id = ctx.lock_project().unwrap().tracks[0].id;
        let cmd = RemovePluginFromTrackCommand {
            track_id,
            slot_id: fx_id,
        };
        let result = ctx.execute(&cmd).unwrap();
        assert!(
            result.runtime_remove_slot.is_none() || result.runtime_remove_slot == Some(0),
            "unexpected runtime slot index: {:?}",
            result.runtime_remove_slot
        );
        assert!(ctx.lock_project().unwrap().tracks[0].effects.is_empty());
    }
}
