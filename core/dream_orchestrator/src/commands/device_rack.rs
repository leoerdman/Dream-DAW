use std::collections::HashSet;

use crate::context::Command;
use crate::error::{OrchestratorError, OrchestratorResult};
use dream_models::project::{DeviceNode, DeviceRack, PluginSlot, RackChain, RackType};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct CreateRackFromDevicesResult {
    pub rack_id: Uuid,
}

pub struct CreateRackFromDevicesCommand {
    pub track_id: String,
    pub device_ids: Vec<String>,
    pub rack_name: Option<String>,
    pub rack_type: Option<String>,
}

impl Command for CreateRackFromDevicesCommand {
    type Result = CreateRackFromDevicesResult;

    fn execute(
        &self,
        ctx: &crate::context::OrchestratorContext,
    ) -> OrchestratorResult<Self::Result> {
        let track_id = parse_uuid("track_id", &self.track_id)?;
        let device_ids = parse_uuid_vec("device_id", &self.device_ids)?;
        if device_ids.is_empty() {
            return Err(OrchestratorError::Other(
                "At least one device must be selected to create a rack".to_string(),
            ));
        }
        let selected_ids: HashSet<Uuid> = device_ids.into_iter().collect();

        let mut project = ctx.lock_project()?;
        let track = project
            .tracks
            .iter_mut()
            .find(|t| t.id == track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "track",
                id: self.track_id.clone(),
            })?;

        let mut first_index: Option<usize> = None;
        let mut indices_to_remove: Vec<usize> = Vec::new();
        let mut extracted: Vec<DeviceNode> = Vec::new();

        for (idx, device) in track.effects.iter().enumerate() {
            if selected_ids.contains(&device.id()) {
                if first_index.is_none() {
                    first_index = Some(idx);
                }
                indices_to_remove.push(idx);
                extracted.push(device.clone());
            }
        }

        if indices_to_remove.is_empty() {
            return Err(OrchestratorError::Other(
                "None of the selected devices exist on the target track".to_string(),
            ));
        }

        for &idx in indices_to_remove.iter().rev() {
            track.effects.remove(idx);
        }

        let insert_pos = first_index.unwrap_or(track.effects.len());
        let rack_name = self
            .rack_name
            .clone()
            .unwrap_or_else(|| "Effect Rack".to_string());
        let rack_type = parse_rack_type(self.rack_type.as_deref());
        let mut rack = DeviceRack::new(rack_name, rack_type);
        if let Some(chain) = rack.chains.first_mut() {
            chain.devices = extracted;
        }

        let rack_id = rack.id;
        track.effects.insert(insert_pos, DeviceNode::Rack(rack));
        Ok(CreateRackFromDevicesResult { rack_id })
    }
}

#[derive(Debug, Clone)]
pub struct AddChainToRackResult {
    pub chain_id: Uuid,
}

pub struct AddChainToRackCommand {
    pub track_id: String,
    pub rack_id: String,
    pub chain_name: Option<String>,
}

impl Command for AddChainToRackCommand {
    type Result = AddChainToRackResult;

    fn execute(
        &self,
        ctx: &crate::context::OrchestratorContext,
    ) -> OrchestratorResult<Self::Result> {
        let track_id = parse_uuid("track_id", &self.track_id)?;
        let rack_id = parse_uuid("rack_id", &self.rack_id)?;

        let mut project = ctx.lock_project()?;
        let track = project
            .tracks
            .iter_mut()
            .find(|t| t.id == track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "track",
                id: self.track_id.clone(),
            })?;

        let rack = find_rack_mut(&mut track.effects, rack_id).ok_or_else(|| {
            OrchestratorError::NotFound {
                entity: "rack",
                id: self.rack_id.clone(),
            }
        })?;

        let chain_name = self.chain_name.clone().unwrap_or_else(|| {
            let letter = (b'A' + rack.chains.len().min(25) as u8) as char;
            format!("Chain {letter}")
        });
        let chain = RackChain::new(chain_name);
        let chain_id = chain.id;
        rack.chains.push(chain);

        Ok(AddChainToRackResult { chain_id })
    }
}

#[derive(Debug, Clone)]
pub struct AddDeviceToRackChainResult {
    pub device_id: Uuid,
}

pub struct AddDeviceToRackChainCommand {
    pub track_id: String,
    pub rack_id: String,
    pub chain_id: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub insert_index: Option<usize>,
}

impl Command for AddDeviceToRackChainCommand {
    type Result = AddDeviceToRackChainResult;

    fn execute(
        &self,
        ctx: &crate::context::OrchestratorContext,
    ) -> OrchestratorResult<Self::Result> {
        let track_id = parse_uuid("track_id", &self.track_id)?;
        let rack_id = parse_uuid("rack_id", &self.rack_id)?;
        let chain_id = parse_uuid("chain_id", &self.chain_id)?;

        let mut project = ctx.lock_project()?;
        let track = project
            .tracks
            .iter_mut()
            .find(|t| t.id == track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "track",
                id: self.track_id.clone(),
            })?;

        let rack = find_rack_mut(&mut track.effects, rack_id).ok_or_else(|| {
            OrchestratorError::NotFound {
                entity: "rack",
                id: self.rack_id.clone(),
            }
        })?;
        let chain = rack
            .chains
            .iter_mut()
            .find(|c| c.id == chain_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "rack chain",
                id: self.chain_id.clone(),
            })?;

        let plugin_slot = PluginSlot::new(&self.plugin_name, &self.plugin_id);
        let device_id = plugin_slot.id;
        let insert_pos = self
            .insert_index
            .unwrap_or(chain.devices.len())
            .min(chain.devices.len());
        chain
            .devices
            .insert(insert_pos, DeviceNode::Single(plugin_slot));

        Ok(AddDeviceToRackChainResult { device_id })
    }
}

pub struct RemoveDeviceFromRackCommand {
    pub track_id: String,
    pub rack_id: String,
    pub device_id: String,
    pub auto_dissolve: bool,
}

impl Command for RemoveDeviceFromRackCommand {
    type Result = ();

    fn execute(
        &self,
        ctx: &crate::context::OrchestratorContext,
    ) -> OrchestratorResult<Self::Result> {
        let track_id = parse_uuid("track_id", &self.track_id)?;
        let rack_id = parse_uuid("rack_id", &self.rack_id)?;
        let device_id = parse_uuid("device_id", &self.device_id)?;

        let mut project = ctx.lock_project()?;
        let track = project
            .tracks
            .iter_mut()
            .find(|t| t.id == track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "track",
                id: self.track_id.clone(),
            })?;

        let rack = find_rack_mut(&mut track.effects, rack_id).ok_or_else(|| {
            OrchestratorError::NotFound {
                entity: "rack",
                id: self.rack_id.clone(),
            }
        })?;

        let mut removed = false;
        for chain in &mut rack.chains {
            if let Some(pos) = chain.devices.iter().position(|d| d.id() == device_id) {
                chain.devices.remove(pos);
                removed = true;
                break;
            }
        }
        if !removed {
            return Err(OrchestratorError::NotFound {
                entity: "device in rack",
                id: self.device_id.clone(),
            });
        }

        if self.auto_dissolve {
            let all_empty = rack.chains.iter().all(|c| c.devices.is_empty());
            if all_empty
                && let Some(rack_pos) = track.effects.iter().position(|d| d.id() == rack_id)
            {
                track.effects.remove(rack_pos);
            }
        }

        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct InsertDeviceNodeIntoTrackResult {
    pub device_id: Uuid,
}

pub struct InsertDeviceNodeIntoTrackCommand {
    pub track_id: String,
    pub device: DeviceNode,
    pub insert_index: Option<usize>,
}

impl Command for InsertDeviceNodeIntoTrackCommand {
    type Result = InsertDeviceNodeIntoTrackResult;

    fn execute(
        &self,
        ctx: &crate::context::OrchestratorContext,
    ) -> OrchestratorResult<Self::Result> {
        let track_id = parse_uuid("track_id", &self.track_id)?;

        let mut project = ctx.lock_project()?;
        let track = project
            .tracks
            .iter_mut()
            .find(|t| t.id == track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "track",
                id: self.track_id.clone(),
            })?;

        let device = self.device.clone();
        let device_id = device.id();
        let insert_pos = self
            .insert_index
            .unwrap_or(track.effects.len())
            .min(track.effects.len());
        track.effects.insert(insert_pos, device);
        Ok(InsertDeviceNodeIntoTrackResult { device_id })
    }
}

fn parse_uuid(field: &'static str, raw: &str) -> OrchestratorResult<Uuid> {
    Uuid::parse_str(raw).map_err(|source| OrchestratorError::InvalidId {
        field,
        value: raw.to_string(),
        source,
    })
}

fn parse_uuid_vec(field: &'static str, raw: &[String]) -> OrchestratorResult<Vec<Uuid>> {
    raw.iter().map(|value| parse_uuid(field, value)).collect()
}

fn parse_rack_type(raw: Option<&str>) -> RackType {
    match raw {
        Some("instrument") => RackType::Instrument,
        Some("drum") => RackType::DrumRack,
        Some("midi_effect") => RackType::MidiEffect,
        _ => RackType::AudioEffect,
    }
}

fn find_rack_mut(devices: &mut [DeviceNode], rack_id: Uuid) -> Option<&mut DeviceRack> {
    for device in devices.iter_mut() {
        if let DeviceNode::Rack(rack) = device {
            if rack.id == rack_id {
                return Some(rack);
            }
            for chain in &mut rack.chains {
                if let Some(found) = find_rack_mut(&mut chain.devices, rack_id) {
                    return Some(found);
                }
            }
        }
    }
    None
}
