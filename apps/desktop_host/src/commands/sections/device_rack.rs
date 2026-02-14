// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Device Rack IPC Commands
// ═══════════════════════════════════════════════════════════════════════════
//
// Six enterprise-grade commands for the Ableton-style device rack system:
//   1. create_rack_from_devices_cmd    — group selected devices into a rack
//   2. add_chain_to_rack_cmd           — add a new parallel chain to a rack
//   3. add_device_to_rack_chain_cmd    — add a plugin to a chain inside a rack
//   4. remove_device_from_rack_cmd     — remove a device from inside a rack
//   5. save_device_preset_cmd          — serialize device node → .dpreset file
//   6. load_device_preset_cmd          — deserialize .dpreset → insert into track
//
// ═══════════════════════════════════════════════════════════════════════════

use dream_models::project::{DeviceNode, DeviceRack, RackChain, RackType};
use dream_models::preset::DevicePreset;

// ── 1. Create Rack from Devices ────────────────────────────────────────

/// Groups selected devices on a track into a new DeviceRack.
///
/// The selected devices are removed from the flat effect chain and
/// placed into the rack's first chain. The rack replaces them at
/// the position of the first selected device.
#[tauri::command]
fn create_rack_from_devices_cmd(
    payload: CreateRackPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<String, String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;

    let device_uuids: Vec<Uuid> = payload
        .device_ids
        .iter()
        .map(|id| Uuid::parse_str(id).map_err(|_| format!("Invalid device_id: {id}")))
        .collect::<Result<Vec<_>, _>>()?;

    if device_uuids.is_empty() {
        return Err("At least one device must be selected to create a rack".into());
    }

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

    // Extract matching devices from the flat chain, preserving order.
    let mut extracted: Vec<DeviceNode> = Vec::new();
    let mut first_index: Option<usize> = None;

    // Build list of indices to remove (in reverse order for safe removal).
    let mut indices_to_remove: Vec<usize> = Vec::new();
    for (idx, device) in track.effects.iter().enumerate() {
        if device_uuids.contains(&device.id()) {
            if first_index.is_none() {
                first_index = Some(idx);
            }
            indices_to_remove.push(idx);
        }
    }

    // Extract devices in order.
    for &idx in &indices_to_remove {
        extracted.push(track.effects[idx].clone());
    }

    // Remove devices in reverse order to not invalidate indices.
    for &idx in indices_to_remove.iter().rev() {
        track.effects.remove(idx);
    }

    let insert_pos = first_index.unwrap_or(track.effects.len());

    // Build the rack.
    let rack_name = payload.rack_name.unwrap_or_else(|| "Effect Rack".to_string());
    let rack_type = match payload.rack_type.as_deref() {
        Some("instrument") => RackType::Instrument,
        Some("drum") => RackType::DrumRack,
        Some("midi_effect") => RackType::MidiEffect,
        _ => RackType::AudioEffect,
    };

    let mut rack = DeviceRack::new(rack_name, rack_type);
    // Place extracted devices into the first chain.
    if let Some(chain) = rack.chains.first_mut() {
        chain.devices = extracted;
    }

    let rack_id = rack.id.to_string();
    track.effects.insert(insert_pos, DeviceNode::Rack(rack));

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    log::info!(
        "[IPC] create_rack_from_devices_cmd(track={}, devices={}, rack={})",
        payload.track_id,
        payload.device_ids.len(),
        rack_id
    );
    Ok(rack_id)
}

// ── 2. Add Chain to Rack ───────────────────────────────────────────────

/// Adds a new empty parallel chain to an existing rack.
#[tauri::command]
fn add_chain_to_rack_cmd(
    payload: AddChainToRackPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<String, String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let rack_uuid = Uuid::parse_str(&payload.rack_id)
        .map_err(|_| format!("Invalid rack_id: {}", payload.rack_id))?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

    // Find the rack recursively in the device chain.
    let rack = find_rack_mut(&mut track.effects, rack_uuid)
        .ok_or_else(|| format!("Rack not found: {}", payload.rack_id))?;

    let chain_name = payload
        .chain_name
        .unwrap_or_else(|| {
            let letter = (b'A' + rack.chains.len().min(25) as u8) as char;
            format!("Chain {letter}")
        });

    let chain = RackChain::new(chain_name);
    let chain_id = chain.id.to_string();
    rack.chains.push(chain);

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    log::info!(
        "[IPC] add_chain_to_rack_cmd(track={}, rack={}, chain={})",
        payload.track_id,
        payload.rack_id,
        chain_id
    );
    Ok(chain_id)
}

// ── 3. Add Device to Rack Chain ────────────────────────────────────────

/// Adds a plugin device to a specific chain inside a rack.
#[tauri::command]
fn add_device_to_rack_chain_cmd(
    payload: AddDeviceToRackChainPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<String, String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let rack_uuid = Uuid::parse_str(&payload.rack_id)
        .map_err(|_| format!("Invalid rack_id: {}", payload.rack_id))?;
    let chain_uuid = Uuid::parse_str(&payload.chain_id)
        .map_err(|_| format!("Invalid chain_id: {}", payload.chain_id))?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

    let rack = find_rack_mut(&mut track.effects, rack_uuid)
        .ok_or_else(|| format!("Rack not found: {}", payload.rack_id))?;

    let chain = rack
        .chains
        .iter_mut()
        .find(|c| c.id == chain_uuid)
        .ok_or_else(|| format!("Chain not found: {}", payload.chain_id))?;

    let plugin_slot = PluginSlot::new(&payload.plugin_name, &payload.plugin_id);
    let device_id = plugin_slot.id.to_string();

    // Insert at specified position or append.
    let insert_index = payload.insert_index.unwrap_or(chain.devices.len());
    let insert_pos = insert_index.min(chain.devices.len());
    chain.devices.insert(insert_pos, DeviceNode::Single(plugin_slot));

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    log::info!(
        "[IPC] add_device_to_rack_chain_cmd(track={}, rack={}, chain={}, device={})",
        payload.track_id,
        payload.rack_id,
        payload.chain_id,
        device_id
    );
    Ok(device_id)
}

// ── 4. Remove Device from Rack ─────────────────────────────────────────

/// Removes a device from inside a rack (by device ID).
///
/// Searches all chains within the specified rack for the device.
/// If the rack becomes empty (all chains have zero devices), the rack
/// itself is removed from the track.
#[tauri::command]
fn remove_device_from_rack_cmd(
    payload: RemoveDeviceFromRackPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let device_uuid = Uuid::parse_str(&payload.device_id)
        .map_err(|_| format!("Invalid device_id: {}", payload.device_id))?;
    let rack_uuid = Uuid::parse_str(&payload.rack_id)
        .map_err(|_| format!("Invalid rack_id: {}", payload.rack_id))?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

    let rack = find_rack_mut(&mut track.effects, rack_uuid)
        .ok_or_else(|| format!("Rack not found: {}", payload.rack_id))?;

    let mut removed = false;
    for chain in rack.chains.iter_mut() {
        if let Some(pos) = chain.devices.iter().position(|d| d.id() == device_uuid) {
            chain.devices.remove(pos);
            removed = true;
            break;
        }
    }

    if !removed {
        return Err(format!(
            "Device {} not found in rack {}",
            payload.device_id, payload.rack_id
        ));
    }

    // Auto-dissolve rack if all chains are empty.
    if payload.auto_dissolve.unwrap_or(false) {
        let all_empty = rack.chains.iter().all(|c| c.devices.is_empty());
        if all_empty {
            if let Some(rack_pos) = track.effects.iter().position(|d| d.id() == rack_uuid) {
                track.effects.remove(rack_pos);
                log::info!("[IPC] auto-dissolved empty rack {}", payload.rack_id);
            }
        }
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    log::info!(
        "[IPC] remove_device_from_rack_cmd(track={}, rack={}, device={})",
        payload.track_id,
        payload.rack_id,
        payload.device_id
    );
    Ok(())
}

// ── 5. Save Device Preset ──────────────────────────────────────────────

/// Serializes a DeviceNode (single device or rack) to a .dpreset JSON file.
#[tauri::command]
fn save_device_preset_cmd(
    payload: SaveDevicePresetPayload,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<String, String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let device_uuid = Uuid::parse_str(&payload.device_id)
        .map_err(|_| format!("Invalid device_id: {}", payload.device_id))?;

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

    // Find the device node anywhere in the effects chain.
    let device_node = find_device_node(&track.effects, device_uuid)
        .ok_or_else(|| format!("Device not found: {}", payload.device_id))?;

    let preset_name = payload
        .preset_name
        .unwrap_or_else(|| device_node.name().to_string());

    let mut preset = DevicePreset::new(preset_name, device_node.clone());
    if let Some(tags) = payload.tags {
        preset.tags = tags;
    }
    if let Some(desc) = payload.description {
        preset.description = desc;
    }

    let json = serde_json::to_string_pretty(&preset)
        .map_err(|e| format!("Serialization failed: {e}"))?;

    // Write to file.
    let output_path = std::path::Path::new(&payload.output_path);
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create preset directory: {e}"))?;
    }
    std::fs::write(output_path, &json)
        .map_err(|e| format!("Failed to write preset file: {e}"))?;

    log::info!(
        "[IPC] save_device_preset_cmd(device={}, path={})",
        payload.device_id,
        payload.output_path
    );
    Ok(payload.output_path)
}

// ── 6. Load Device Preset ──────────────────────────────────────────────

/// Deserializes a .dpreset file and inserts the device node into a track.
#[tauri::command]
fn load_device_preset_cmd(
    payload: LoadDevicePresetPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<String, String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;

    // Read and deserialize preset file.
    let json = std::fs::read_to_string(&payload.preset_path)
        .map_err(|e| format!("Failed to read preset file: {e}"))?;
    let preset: DevicePreset = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse preset: {e}"))?;

    // Regenerate all IDs to avoid collisions.
    let device = regenerate_ids(preset.device);
    let device_id = device.id().to_string();

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

    // Insert at specified position or append.
    let insert_index = payload.insert_index.unwrap_or(track.effects.len());
    let insert_pos = insert_index.min(track.effects.len());
    track.effects.insert(insert_pos, device);

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    log::info!(
        "[IPC] load_device_preset_cmd(track={}, preset='{}', device={})",
        payload.track_id,
        payload.preset_path,
        device_id
    );
    Ok(device_id)
}

// ── Helpers ────────────────────────────────────────────────────────────

/// Recursively finds a mutable reference to a rack in the device chain.
fn find_rack_mut(devices: &mut [DeviceNode], rack_id: Uuid) -> Option<&mut DeviceRack> {
    for device in devices.iter_mut() {
        match device {
            DeviceNode::Rack(rack) => {
                if rack.id == rack_id {
                    return Some(rack);
                }
                // Search nested racks.
                for chain in rack.chains.iter_mut() {
                    if let Some(found) = find_rack_mut(&mut chain.devices, rack_id) {
                        return Some(found);
                    }
                }
            }
            _ => {}
        }
    }
    None
}

/// Recursively finds a device node by ID (immutable).
fn find_device_node(devices: &[DeviceNode], device_id: Uuid) -> Option<&DeviceNode> {
    for device in devices.iter() {
        if device.id() == device_id {
            return Some(device);
        }
        if let DeviceNode::Rack(rack) = device {
            for chain in &rack.chains {
                if let Some(found) = find_device_node(&chain.devices, device_id) {
                    return Some(found);
                }
            }
        }
    }
    None
}

/// Regenerates all UUIDs in a DeviceNode tree to prevent ID collisions
/// when loading the same preset multiple times.
fn regenerate_ids(node: DeviceNode) -> DeviceNode {
    match node {
        DeviceNode::Single(mut slot) => {
            slot.id = Uuid::new_v4();
            DeviceNode::Single(slot)
        }
        DeviceNode::Rack(mut rack) => {
            rack.id = Uuid::new_v4();
            rack.chains = rack
                .chains
                .into_iter()
                .map(|mut chain| {
                    chain.id = Uuid::new_v4();
                    chain.devices = chain
                        .devices
                        .into_iter()
                        .map(regenerate_ids)
                        .collect();
                    chain
                })
                .collect();
            DeviceNode::Rack(rack)
        }
    }
}
