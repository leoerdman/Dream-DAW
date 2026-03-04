use crate::context::Command;
use crate::error::{OrchestratorError, OrchestratorResult};
use dream_models::project::{DeviceNode, DeviceRack, PluginSlot, Project, RackChain};

const MASTER_TRACK_INDEX: u16 = u16::MAX;
const INSTRUMENT_SLOT_INDEX: u8 = 255;

fn selected_runtime_chain(rack: &DeviceRack) -> Option<&RackChain> {
    let has_solo = rack.chains.iter().any(|c| c.is_solo);
    if has_solo {
        rack.chains.iter().find(|c| c.is_solo && !c.is_disabled)
    } else {
        rack.chains.iter().find(|c| !c.is_disabled)
    }
}

fn count_runtime_internal_effects(node: &DeviceNode) -> usize {
    match node {
        DeviceNode::Single(slot) => usize::from(
            dream_models::project::builtin_effect_type_from_plugin_id(&slot.plugin_id).is_some(),
        ),
        DeviceNode::Rack(rack) => {
            // ENTERPRISE SSOT FIX: Must iterate ALL applicable chains to match
            // the engine's device chain layout built by runtime_device_chains.rs.
            let has_solo = rack.chains.iter().any(|c| c.is_solo);
            rack.chains.iter()
                .filter(|c| !c.is_disabled && (!has_solo || c.is_solo))
                .flat_map(|chain| chain.devices.iter())
                .map(count_runtime_internal_effects)
                .sum()
        }
    }
}

fn raw_slot_to_internal_device_index(
    project: &Project,
    track_index: u16,
    raw_slot_index: u8,
) -> Option<u8> {
    let track = project.tracks.get(track_index as usize)?;
    let raw = raw_slot_index as usize;
    let target = track.effects.get(raw)?;
    let preceding_internal = track.effects[..raw]
        .iter()
        .map(count_runtime_internal_effects)
        .sum::<usize>();
    match target {
        DeviceNode::Single(slot)
            if dream_models::project::builtin_effect_type_from_plugin_id(&slot.plugin_id)
                .is_some() =>
        {
            Some(preceding_internal as u8)
        }
        _ => None,
    }
}

fn raw_slot_to_internal_device_index_master(project: &Project, raw_slot_index: u8) -> Option<u8> {
    let raw = raw_slot_index as usize;
    let target = project.master_track.effects.get(raw)?;
    let preceding_internal = project.master_track.effects[..raw]
        .iter()
        .map(count_runtime_internal_effects)
        .sum::<usize>();
    match target {
        DeviceNode::Single(slot)
            if dream_models::project::builtin_effect_type_from_plugin_id(&slot.plugin_id)
                .is_some() =>
        {
            Some(preceding_internal as u8)
        }
        _ => None,
    }
}

fn persist_param_to_slot(slot: &mut PluginSlot, param_index: u32, value: f32) {
    if slot.params.is_none() {
        slot.params = Some(vec![0.0; 32]);
    }
    if let Some(params) = &mut slot.params {
        let p_idx = param_index as usize;
        if p_idx < params.len() {
            params[p_idx] = value;
        } else if p_idx < 128 {
            params.resize(p_idx + 1, 0.0);
            params[p_idx] = value;
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SetInternalDeviceBypassResult {
    pub engine_slot_index: Option<u8>,
}

pub struct SetInternalDeviceBypassByTrackIndexCommand {
    pub track_index: u16,
    pub slot_index: u8,
    pub bypassed: bool,
}

impl Command for SetInternalDeviceBypassByTrackIndexCommand {
    type Result = SetInternalDeviceBypassResult;

    fn execute(
        &self,
        ctx: &crate::context::OrchestratorContext,
    ) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;

        if self.track_index == MASTER_TRACK_INDEX {
            let effects = &mut project.master_track.effects;
            if let Some(slot) = effects
                .get_mut(self.slot_index as usize)
                .and_then(|n| n.as_single_mut())
            {
                slot.is_bypassed = self.bypassed;
            }
            let engine_slot_index =
                raw_slot_to_internal_device_index_master(&project, self.slot_index);
            return Ok(SetInternalDeviceBypassResult { engine_slot_index });
        }

        let idx = self.track_index as usize;
        let total = project.tracks.len();
        let track = project
            .tracks
            .get_mut(idx)
            .ok_or(OrchestratorError::TrackOutOfRange {
                requested: idx,
                total,
            })?;

        if self.slot_index == INSTRUMENT_SLOT_INDEX {
            if let Some(slot) = track.instrument.as_mut().and_then(|n| n.as_single_mut()) {
                slot.is_bypassed = self.bypassed;
            }
            return Ok(SetInternalDeviceBypassResult {
                engine_slot_index: Some(INSTRUMENT_SLOT_INDEX),
            });
        }

        if let Some(slot) = track
            .effects
            .get_mut(self.slot_index as usize)
            .and_then(|n| n.as_single_mut())
        {
            slot.is_bypassed = self.bypassed;
        }

        let engine_slot_index =
            raw_slot_to_internal_device_index(&project, self.track_index, self.slot_index);
        Ok(SetInternalDeviceBypassResult { engine_slot_index })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SetInternalDeviceParamResult {
    pub value: f32,
    pub engine_slot_index: Option<u8>,
}

pub struct SetInternalDeviceParamByTrackIndexCommand {
    pub track_index: u16,
    pub slot_index: u8,
    pub param_index: u32,
    pub value: f32,
}

impl Command for SetInternalDeviceParamByTrackIndexCommand {
    type Result = SetInternalDeviceParamResult;

    fn execute(
        &self,
        ctx: &crate::context::OrchestratorContext,
    ) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;

        if self.track_index == MASTER_TRACK_INDEX {
            let effects = &mut project.master_track.effects;
            if let Some(slot) = effects
                .get_mut(self.slot_index as usize)
                .and_then(|n| n.as_single_mut())
            {
                persist_param_to_slot(slot, self.param_index, self.value);
            }
            let engine_slot_index =
                raw_slot_to_internal_device_index_master(&project, self.slot_index);
            return Ok(SetInternalDeviceParamResult {
                value: self.value,
                engine_slot_index,
            });
        }

        let idx = self.track_index as usize;
        let total = project.tracks.len();
        let track = project
            .tracks
            .get_mut(idx)
            .ok_or(OrchestratorError::TrackOutOfRange {
                requested: idx,
                total,
            })?;

        if self.slot_index == INSTRUMENT_SLOT_INDEX {
            if let Some(slot) = track.instrument.as_mut().and_then(|n| n.as_single_mut()) {
                persist_param_to_slot(slot, self.param_index, self.value);
            }
            return Ok(SetInternalDeviceParamResult {
                value: self.value,
                engine_slot_index: Some(INSTRUMENT_SLOT_INDEX),
            });
        }

        if let Some(slot) = track
            .effects
            .get_mut(self.slot_index as usize)
            .and_then(|n| n.as_single_mut())
        {
            persist_param_to_slot(slot, self.param_index, self.value);
        }

        let engine_slot_index =
            raw_slot_to_internal_device_index(&project, self.track_index, self.slot_index);
        Ok(SetInternalDeviceParamResult {
            value: self.value,
            engine_slot_index,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dream_models::project::{PluginSlot, Track};

    #[test]
    fn raw_slot_index_maps_internal_eq_alias() {
        let mut project = Project::new("T", 120.0, 44100.0);
        let mut track = Track::new("Track 1");
        track.effects.push(DeviceNode::Single(PluginSlot::new(
            "Ext",
            "com.vendor.plugin",
        )));
        track.effects.push(DeviceNode::Single(PluginSlot::new(
            "EQ",
            "internal://effect/eq8",
        )));
        track.effects.push(DeviceNode::Single(PluginSlot::new(
            "Comp",
            "internal://effect/compressor",
        )));
        project.add_track(track);

        assert_eq!(raw_slot_to_internal_device_index(&project, 0, 1), Some(0));
        assert_eq!(raw_slot_to_internal_device_index(&project, 0, 2), Some(1));
    }

    #[test]
    fn raw_slot_index_skips_unknown_internal_effect_ids() {
        let mut project = Project::new("T", 120.0, 44100.0);
        let mut track = Track::new("Track 1");
        track.effects.push(DeviceNode::Single(PluginSlot::new(
            "Unknown",
            "internal://effect/custom-unknown",
        )));
        track.effects.push(DeviceNode::Single(PluginSlot::new(
            "EQ",
            "internal://effect/eq-eight",
        )));
        project.add_track(track);

        assert_eq!(raw_slot_to_internal_device_index(&project, 0, 0), None);
        assert_eq!(raw_slot_to_internal_device_index(&project, 0, 1), Some(0));
    }
}
