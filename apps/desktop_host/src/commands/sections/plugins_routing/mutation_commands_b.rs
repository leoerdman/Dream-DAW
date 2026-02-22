#[tauri::command]
fn set_sampler_sample_with_deltas_cmd(
    payload: SetSamplerSamplePayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<PluginMutationDeltaResponse, String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let sample_path = payload.sample_path.clone();
    set_sampler_sample_cmd(payload, project_state, clip_pool_state, handle, app)?;
    Ok(PluginMutationDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackSamplerSampleChanged {
            track_id: track_uuid,
            sample_path,
        }],
    })
}

// ── STUB-10 FIX: Eager external plugin activation at project load ─────────
//
// During ALS import, resolved external plugins have their state blobs stored
// on PluginSlot.external_state_blob / external_preset_blob. However, the
// plugins only get instantiated lazily (when user opens the editor).
//
// This command eagerly activates ALL resolved external plugins in the project,
// so their stored state is applied immediately and they are ready for playback.

#[tauri::command]
fn eager_activate_external_plugins(
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<serde_json::Value, String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();

    fn collect_external_slots_from_node(node: &DeviceNode, out: &mut Vec<(Uuid, String)>) {
        match node {
            DeviceNode::Single(slot) => {
                if !slot.plugin_id.starts_with("internal://") && !slot.plugin_id.is_empty() {
                    out.push((slot.id, slot.plugin_id.clone()));
                }
            }
            DeviceNode::Rack(rack) => {
                for chain in &rack.chains {
                    for child in &chain.devices {
                        collect_external_slots_from_node(child, out);
                    }
                }
            }
        }
    }

    let mut external_slots: Vec<(Uuid, String)> = Vec::new();
    for track in &project.tracks {
        if let Some(inst) = &track.instrument {
            collect_external_slots_from_node(inst, &mut external_slots);
        }
        for fx in &track.effects {
            collect_external_slots_from_node(fx, &mut external_slots);
        }
    }
    for fx in &project.master_track.effects {
        collect_external_slots_from_node(fx, &mut external_slots);
    }

    let total = external_slots.len();
    let mut loaded = 0u32;
    let mut failed = 0u32;
    let skipped = 0u32;

    for (slot_id, plugin_id) in &external_slots {
        match plugin_host_state.ensure_loaded_instance_for_slot(*slot_id, plugin_id) {
            Ok(instance_id) => {
                loaded += 1;
                log::info!(
                    "[EagerActivate] Slot {} plugin '{}' active as instance {} ({}/{})",
                    slot_id,
                    plugin_id,
                    instance_id,
                    loaded,
                    total
                );

                // Restore the per-slot saved state (preset, knob positions, etc.)
                // Uses slot UUID lookup to ensure multi-instance plugins each get
                // their own unique state blob (not the first match by plugin_id).
                if let Some(slot) = find_project_plugin_slot_by_slot_id(&project, *slot_id) {
                    if slot.external_state_blob.is_some() || slot.external_preset_blob.is_some() {
                        let mut host = match plugin_host_state.host.lock() {
                            Ok(h) => h,
                            Err(e) => {
                                log::warn!(
                                    "[EagerActivate] Host lock failed for state restore of '{}': {}",
                                    plugin_id, e
                                );
                                continue;
                            }
                        };
                        if let Err(err) = apply_imported_external_state_blob(&mut host, instance_id, &slot) {
                            log::warn!(
                                "[EagerActivate] State restore failed for '{}' (slot {}): {}",
                                slot.name, slot_id, err
                            );
                        } else {
                            log::info!(
                                "[EagerActivate] Restored state for '{}' (slot {})",
                                slot.name, slot_id
                            );
                        }
                    }
                }
            }
            Err(err) => {
                // Don't fail the whole operation for one bad plugin
                failed += 1;
                log::warn!(
                    "[EagerActivate] Failed to activate '{}': {}",
                    plugin_id,
                    err
                );
            }
        }
    }

    log::info!(
        "[EagerActivate] Done: {} external plugin slots found, {} loaded, {} failed",
        total,
        loaded,
        failed
    );

    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();

    Ok(serde_json::json!({
        "total": total,
        "loaded": loaded,
        "failed": failed,
        "skipped": skipped,
    }))
}

/// Set the bypass state for any plugin slot (instrument or effect) on a track.
/// Updates the project model `is_bypassed` flag and rebuilds the external FX
/// snapshot so bypassed plugins are excluded from the audio processing pipeline.
/// For instrument slots, also sends a `BypassInstrument` engine command so the
/// internal sampler on the real-time thread stops producing audio immediately.
#[tauri::command]
fn set_slot_bypass_cmd(
    track_id: String,
    slot_id: String,
    bypassed: bool,
    project_state: tauri::State<'_, ProjectState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track id: {e}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|e| format!("Invalid slot id: {e}"))?;

    let cmd = dream_orchestrator::commands::SetPluginSlotBypassCommand {
        track_id: track_uuid,
        slot_id: slot_uuid,
        bypassed,
    };
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    log::info!(
        "[IPC] set_slot_bypass_cmd(track={}, slot={}, bypassed={}, is_instrument={}) plugin={}",
        track_id, slot_id, bypassed, result.is_instrument, result.plugin_id
    );

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    // For instrument slots, send BypassInstrument to the real-time audio thread
    // so the internal sampler stops producing audio immediately.
    if result.is_instrument {
        if let Err(e) = push_command(
            &handle,
            EngineCommand::BypassInstrument {
                track_index: result.track_index as u16,
                bypassed,
            },
        ) {
            log::error!(
                "[IPC] Failed to push BypassInstrument command for track {}: {}",
                result.track_index,
                e
            );
        }
    }

    Ok(())
}

#[tauri::command]
fn set_slot_bypass_with_deltas_cmd(
    track_id: String,
    slot_id: String,
    bypassed: bool,
    project_state: tauri::State<'_, ProjectState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<PluginMutationDeltaResponse, String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track id: {e}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|e| format!("Invalid slot id: {e}"))?;

    set_slot_bypass_cmd(
        track_id,
        slot_id,
        bypassed,
        project_state,
        plugin_host_state,
        clip_pool_state,
        handle,
        app,
    )?;

    Ok(PluginMutationDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::PluginBypassChanged {
            track_id: track_uuid,
            slot_id: slot_uuid,
            bypassed,
        }],
    })
}

/// Move an effect slot to a new position within the same track's FX chain.
#[tauri::command]
async fn move_effect_slot_cmd(
    track_id: String,
    slot_id: String,
    target_index: usize,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    _handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let target = dream_orchestrator::commands::EffectTrackTarget::from_track_id(&track_id)
        .map_err(|e| e.to_string())?;
    let cmd = dream_orchestrator::commands::MoveEffectSlotCommand {
        target,
        slot_id: slot_uuid,
        target_index,
    };

    push_undo(&project_state)?;
    execute_orchestrator_command(&project_state, &cmd)?;

    // Rebuild FX snapshot so the audio engine picks up the new order
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();

    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] move_effect_slot_cmd(track={track_id}, slot={slot_id} → {target_index})"
    );
    Ok(())
}

#[tauri::command]
async fn move_effect_slot_with_deltas_cmd(
    track_id: String,
    slot_id: String,
    target_index: usize,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<PluginMutationDeltaResponse, String> {
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let target = dream_orchestrator::commands::EffectTrackTarget::from_track_id(&track_id)
        .map_err(|e| e.to_string())?;
    let cmd = dream_orchestrator::commands::MoveEffectSlotCommand {
        target,
        slot_id: slot_uuid,
        target_index,
    };

    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let delta_track_id = match target {
        dream_orchestrator::commands::EffectTrackTarget::Master => project.master_track.id,
        dream_orchestrator::commands::EffectTrackTarget::Track(id) => id,
    };
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();
    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!("[IPC] move_effect_slot_with_deltas_cmd(track={track_id}, slot={slot_id} → {target_index})");

    let _ = handle;

    Ok(PluginMutationDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::PluginMoved {
            track_id: delta_track_id,
            slot_id: slot_uuid,
            old_slot_index: result.old_slot_index,
            new_slot_index: result.new_slot_index,
        }],
    })
}

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

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let device_node = find_device_node_on_track(&project, track_uuid, device_uuid)
        .ok_or_else(|| format!("Device not found on track {track_id}: {device_id}"))?;

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
    // Read clipboard (don't consume it — allow multiple pastes).
    let clipboard = project_state.device_clipboard.lock().map_err(|e| e.to_string())?;
    let Some(ref source_node) = *clipboard else {
        return Err("Device clipboard is empty".to_string());
    };
    let mut pasted_node = source_node.clone();
    drop(clipboard); // Release clipboard lock before taking project lock.

    // Regenerate all UUIDs to make the pasted device independent.
    pasted_node.regenerate_ids();

    let track_uuid = Uuid::parse_str(&track_id)
        .map_err(|_| format!("Invalid track_id: {track_id}"))?;

    push_undo(&project_state)?;
    let cmd = dream_orchestrator::commands::PasteDeviceToTrackCommand {
        track_id: track_uuid,
        slot_hint: slot_hint.clone(),
        pasted_node,
    };
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    let use_instrument = result.use_instrument;
    let new_slots = result.new_slots;
    let runtime_add = result.runtime_add;

    // Load external plugins for all slots in the pasted device.
    let mut plugin_load_error: Option<String> = None;
    for slot in &new_slots {
        if !slot.plugin_id.starts_with("internal://") {
            if let Err(err) = plugin_host_state.ensure_loaded_instance_for_slot(slot.id, &slot.plugin_id) {
                log::warn!(
                    "[IPC] paste_device_to_track_cmd: plugin '{}' failed to load (slot={}): {}",
                    slot.plugin_id, slot.id, err
                );
                plugin_load_error = Some(format!("Plugin '{}' failed to load: {}", slot.name, err));
            }
        }
    }

    // Rebuild engine state.
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();

    // Send AddDevice engine command for internal effects.
    if let Some(runtime_add) = runtime_add {
        if let Some(runtime_track_index) = project
            .tracks
            .iter()
            .position(|t| t.id == runtime_add.track_id)
        {
            if let Err(e) = push_command(&handle, EngineCommand::AddDevice {
                track_index: runtime_track_index as u16,
                slot_index: runtime_add.slot_index,
                effect_type: runtime_add.effect_type,
            }) {
                log::error!("[IPC] Failed to push AddDevice command for track {}: {}", runtime_track_index, e);
            }
        }
    }

    log::info!(
        "[IPC] paste_device_to_track_cmd(track={track_id}, slot={})",
        if use_instrument { "instrument" } else { "effect" }
    );
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

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
    let track_uuid = Uuid::parse_str(&track_id)
        .map_err(|_| format!("Invalid track_id: {track_id}"))?;

    let (before_instrument_id, before_effect_ids): (Option<Uuid>, std::collections::HashSet<Uuid>) = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let track = project
            .tracks
            .iter()
            .find(|t| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found: {track_id}"))?;
        (
            track.instrument.as_ref().map(DeviceNode::id),
            track.effects.iter().map(DeviceNode::id).collect(),
        )
    };

    paste_device_to_track_cmd(
        track_id,
        slot_hint,
        project_state.clone(),
        clip_pool_state,
        handle,
        plugin_host_state,
        app,
    )?;

    let mut deltas = Vec::new();
    {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let track = project
            .tracks
            .iter()
            .find(|t| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found after paste: {track_uuid}"))?;

        if let Some(inst) = &track.instrument {
            let inst_id = inst.id();
            if before_instrument_id != Some(inst_id) {
                if let Some(old_inst_id) = before_instrument_id {
                    deltas.push(dream_models::delta::ProjectDelta::PluginRemoved {
                        track_id: track_uuid,
                        slot_id: old_inst_id,
                    });
                }
                deltas.push(dream_models::delta::ProjectDelta::PluginAdded {
                    track_id: track_uuid,
                    slot_id: inst_id,
                    slot_index: 0,
                    is_instrument: true,
                    plugin_name: inst.name().to_owned(),
                    plugin_uid: inst.plugin_id().to_owned(),
                });
            }
        }

        for (idx, node) in track.effects.iter().enumerate() {
            if before_effect_ids.contains(&node.id()) {
                continue;
            }
            deltas.push(dream_models::delta::ProjectDelta::PluginAdded {
                track_id: track_uuid,
                slot_id: node.id(),
                slot_index: idx,
                is_instrument: false,
                plugin_name: node.name().to_owned(),
                plugin_uid: node.plugin_id().to_owned(),
            });
        }
    }

    Ok(PluginMutationDeltaResponse { deltas })
}
