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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    push_undo(&project_state)?;
    let cmd = dream_orchestrator::commands::CreateRackFromDevicesCommand {
        track_id: payload.track_id.clone(),
        device_ids: payload.device_ids.clone(),
        rack_name: payload.rack_name.clone(),
        rack_type: payload.rack_type.clone(),
    };
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    let rack_id = result.rack_id.to_string();

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    push_undo(&project_state)?;
    let cmd = dream_orchestrator::commands::AddChainToRackCommand {
        track_id: payload.track_id.clone(),
        rack_id: payload.rack_id.clone(),
        chain_name: payload.chain_name.clone(),
    };
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    let chain_id = result.chain_id.to_string();

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    push_undo(&project_state)?;
    let cmd = dream_orchestrator::commands::AddDeviceToRackChainCommand {
        track_id: payload.track_id.clone(),
        rack_id: payload.rack_id.clone(),
        chain_id: payload.chain_id.clone(),
        plugin_id: payload.plugin_id.clone(),
        plugin_name: payload.plugin_name.clone(),
        insert_index: payload.insert_index,
    };
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    let device_id = result.device_id.to_string();

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    push_undo(&project_state)?;
    let cmd = dream_orchestrator::commands::RemoveDeviceFromRackCommand {
        track_id: payload.track_id.clone(),
        rack_id: payload.rack_id.clone(),
        device_id: payload.device_id.clone(),
        auto_dissolve: payload.auto_dissolve.unwrap_or(false),
    };
    execute_orchestrator_command(&project_state, &cmd)?;

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<String, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    // Read and deserialize preset file.
    let json = std::fs::read_to_string(&payload.preset_path)
        .map_err(|e| format!("Failed to read preset file: {e}"))?;
    let preset: DevicePreset = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse preset: {e}"))?;

    // Regenerate all IDs to avoid collisions.
    let device = regenerate_ids(preset.device);
    push_undo(&project_state)?;
    let cmd = dream_orchestrator::commands::InsertDeviceNodeIntoTrackCommand {
        track_id: payload.track_id.clone(),
        device,
        insert_index: payload.insert_index,
    };
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    let device_id = result.device_id.to_string();

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] load_device_preset_cmd(track={}, preset='{}', device={})",
        payload.track_id,
        payload.preset_path,
        device_id
    );
    Ok(device_id)
}

// ── Helpers ────────────────────────────────────────────────────────────

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
