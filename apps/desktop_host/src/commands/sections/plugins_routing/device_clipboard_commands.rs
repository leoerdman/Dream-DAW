// ── Device Copy / Paste ────────────────────────────────────────────────

// `find_device_node_on_track` and `find_device_node_recursive` are now
// imported from `dream_importers::routing_helpers` (see imports at top).

/// Copy a device (instrument, effect, VST, rack) to the clipboard.
///
/// The device is deep-cloned from the source track — the original remains untouched.
/// The clipboard stores the full DeviceNode with all parameters, state blobs, etc.
#[tauri::command]
fn copy_device_from_track_cmd(
    track_id: String,
    device_id: String,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<String, String> {
    let track_uuid = Uuid::parse_str(&track_id)
        .map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let device_uuid = Uuid::parse_str(&device_id)
        .map_err(|_| format!("Invalid device_id: {device_id}"))?;

    let device_node = execute_orchestrator_query(
        &project_state,
        &dream_orchestrator::queries::ResolveDeviceNodeOnTrackQuery {
            track_id: track_uuid,
            device_id: device_uuid,
        },
    )?;

    let device_name = device_node.name().to_owned();
    let mut clipboard = project_state.device_clipboard.lock().map_err(|e| e.to_string())?;
    *clipboard = Some(device_node);

    log::info!("[IPC] copy_device_from_track_cmd(track={track_id}, device={device_id}, name='{device_name}')");
    Ok(device_name)
}

/// Paste the copied device to a target track.
///
/// Creates a fresh copy with regenerated UUIDs so it's fully independent.
/// For instrument devices on MIDI tracks, replaces the instrument slot;
/// for effects, appends to the effects chain.
/// Handles external plugin loading and engine device chain updates.
fn paste_device_to_track_impl(
    track_id: &str,
    slot_hint: Option<String>,
    project_state: &tauri::State<'_, ProjectState>,
    clip_pool_state: &tauri::State<'_, ClipPoolState>,
    handle: &tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: &tauri::State<'_, PluginHostState>,
    app: &tauri::AppHandle,
) -> Result<(dream_orchestrator::commands::PasteDeviceToTrackResult, Option<String>), String> {
    // Read clipboard (don't consume it — allow multiple pastes).
    let clipboard = project_state.device_clipboard.lock().map_err(|e| e.to_string())?;
    let Some(ref source_node) = *clipboard else {
        return Err("Device clipboard is empty".to_string());
    };
    let mut pasted_node = source_node.clone();
    drop(clipboard); // Release clipboard lock before taking project lock.

    // Regenerate all UUIDs to make the pasted device independent.
    pasted_node.regenerate_ids();

    let track_uuid = Uuid::parse_str(track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;

    push_undo(project_state)?;
    let cmd = dream_orchestrator::commands::PasteDeviceToTrackCommand {
        track_id: track_uuid,
        slot_hint: slot_hint.clone(),
        pasted_node,
    };
    let result = execute_orchestrator_command(project_state, &cmd)?;
    let use_instrument = result.use_instrument;
    let new_slots = result.new_slots.clone();
    let runtime_add = result.runtime_add;

    // Load external plugins for all slots in the pasted device.
    let plugin_load_error = load_external_slots_best_effort(
        &new_slots,
        plugin_host_state,
        "paste_device_to_track_cmd",
    );

    // Send AddDevice engine command for internal effects (RT-safe via prealloc queue).
    if let Some(runtime_add) = runtime_add
        && let Err(e) = push_prealloc_device(
            handle,
            runtime_add.track_index,
            runtime_add.slot_index,
            runtime_add.effect_type,
        )
    {
        log::error!(
            "[IPC] Failed to push AddDevice command for track {}: {}",
            runtime_add.track_index,
            e
        );
    }

    log::info!(
        "[IPC] paste_device_to_track_cmd(track={track_id}, slot={})",
        if use_instrument { "instrument" } else { "effect" }
    );
    sync_plugin_runtime_and_mark_dirty(
        project_state,
        clip_pool_state,
        plugin_host_state,
        handle,
        app,
        true,
    )?;

    Ok((result, plugin_load_error))
}

#[tauri::command]
fn paste_device_to_track_cmd(
    track_id: String,
    slot_hint: Option<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let (_result, plugin_load_error) = paste_device_to_track_impl(
        &track_id,
        slot_hint,
        &project_state,
        &clip_pool_state,
        &handle,
        &plugin_host_state,
        &app,
    )?;

    if let Some(err_msg) = plugin_load_error {
        return Err(err_msg);
    }
    Ok(())
}

#[tauri::command]
fn paste_device_to_track_with_deltas_cmd(
    track_id: String,
    slot_hint: Option<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<PluginMutationDeltaResponse, String> {
    let (result, plugin_load_error) = paste_device_to_track_impl(
        &track_id,
        slot_hint,
        &project_state,
        &clip_pool_state,
        &handle,
        &plugin_host_state,
        &app,
    )?;

    if let Some(err_msg) = plugin_load_error {
        return Err(err_msg);
    }

    let mut deltas = Vec::new();
    if let Some(old_inst_id) = result.replaced_instrument_slot_id {
        deltas.push(dream_models::delta::ProjectDelta::PluginRemoved {
            track_id: result.track_id,
            slot_id: old_inst_id,
        });
    }
    for slot in result.added_slot_deltas {
        deltas.push(dream_models::delta::ProjectDelta::PluginAdded {
            track_id: result.track_id,
            slot_id: slot.slot_id,
            slot_index: slot.slot_index,
            is_instrument: slot.is_instrument,
            plugin_name: slot.plugin_name,
            plugin_uid: slot.plugin_uid,
        });
    }
    Ok(PluginMutationDeltaResponse { deltas })
}
