#[tauri::command]
fn close_plugin_window_cmd(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    plugin_host_state.close_in_sandbox(&plugin_id)?;

    let maybe_instance = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .get(&plugin_id)
        .copied();

    if let Some(instance_id) = maybe_instance {
        // CRITICAL: close_editor performs AppKit calls (NSWindow close, NSView
        // removed/release) that MUST happen on the main thread.
        let host_arc = std::sync::Arc::clone(&plugin_host_state.host);
        let plugin_id_clone = plugin_id.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        app.run_on_main_thread(move || {
            let result = (|| {
                let mut host = host_arc.lock().map_err(|e| e.to_string())?;
                host.close_editor(instance_id)
                    .map_err(|e| e.to_string())
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| format!("Failed to schedule editor close on main thread: {e}"))?;
        if let Err(err) = rx.recv().map_err(|e| format!("Failed to receive editor close result: {e}"))? {
            log::warn!(
                "[IPC] close_plugin_window({plugin_id_clone}) editor close failed for {instance_id}: {err}"
            );
        }
        log::info!(
            "[IPC] close_plugin_window({plugin_id}) -> closed editor for instance {instance_id}"
        );
    } else {
        log::info!("[IPC] close_plugin_window({plugin_id}) -> no loaded instance");
    }
    Ok(())
}

/// Close native editor for a specific plugin slot without unloading processing state.
///
/// After closing the editor, captures the live plugin state and compares it
/// with the project's stored blob. If different (e.g. preset change in Serum
/// that doesn't fire IComponentHandler callbacks), the project is marked
/// dirty and the blob is updated immediately.
#[tauri::command]
fn close_plugin_window_for_slot(
    track_id: String,
    slot_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;

    // Extract slot info while holding the project lock, then release it
    // before the main-thread dispatch to avoid holding the lock during
    // a blocking channel wait.
    let (plugin_id, stored_blob) = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let slot = find_slot_on_track(&project, track_uuid, slot_uuid)
            .ok_or_else(|| format!("Plugin slot not found on track {}: {}", track_id, slot_id))?;
        if slot.plugin_id.starts_with("internal://") {
            return Ok(());
        }
        (slot.plugin_id.clone(), slot.external_state_blob.clone())
    };

    // Close editor on main thread (AppKit requirement)
    let instance_id_opt = plugin_host_state.slot_instance_snapshot().get(&slot_uuid).copied();
    if let Some(instance_id) = instance_id_opt {
        let host_arc = std::sync::Arc::clone(&plugin_host_state.host);
        let track_id_log = track_id.clone();
        let slot_id_log = slot_id.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        app.run_on_main_thread(move || {
            let result = (|| {
                let mut host = host_arc.lock().map_err(|e| e.to_string())?;
                host.close_editor(instance_id)
                    .map_err(|e| e.to_string())
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| format!("Failed to schedule editor close on main thread: {e}"))?;
        if let Err(err) = rx.recv().map_err(|e| format!("Failed to receive editor close result: {e}"))? {
            log::warn!(
                "[IPC] close_plugin_window_for_slot(track={}, slot={}) failed to close in-process editor for {}: {}",
                track_id_log,
                slot_id_log,
                instance_id,
                err
            );
        }

        // ── State comparison: detect silent preset changes ──────────
        // Plugins like Serum don't fire IComponentHandler callbacks when
        // switching presets via their internal browser. Capture the live
        // state and compare with the stored blob to detect changes.
        if let Ok(host) = plugin_host_state.host.lock() {
            if let Some(live_bytes) = host.save_instance_state(instance_id) {
                use base64::Engine;
                let live_b64 = base64::engine::general_purpose::STANDARD.encode(&live_bytes);
                let state_changed = stored_blob.as_deref() != Some(&live_b64);
                if state_changed {
                    log::info!(
                        "[IPC] close_plugin_window_for_slot: plugin state changed (slot={}), marking dirty",
                        slot_id
                    );
                    // Update the project's stored blob immediately so the
                    // next Cmd+S captures the correct state.
                    drop(host); // release PluginHost lock before acquiring project lock
                    let cmd =
                        dream_orchestrator::commands::UpdatePluginExternalStateBlobCommand {
                            track_id: track_uuid,
                            slot_id: slot_uuid,
                            external_state_blob: Some(live_b64),
                            external_state_blob_kind: Some("ProcessorState".to_string()),
                        };
                    if execute_orchestrator_command(&project_state, &cmd).unwrap_or(false)
                        && let Ok(project) = project_state.project.lock()
                    {
                        let _ = project_state.mark_dirty(&project.name, Some(&app));
                    }
                }
            }
        }
    }

    // Also close sandbox-hosted editor if applicable
    if let Some(instance_id) = plugin_host_state
        .loaded_sandbox_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .get(&plugin_id)
        .copied()
    {
        let mut supervisor = plugin_host_state
            .sandbox_supervisor
            .lock()
            .map_err(|e| e.to_string())?;
        if let Err(err) = supervisor.send_close_editor(instance_id) {
            log::warn!(
                "[IPC] close_plugin_window_for_slot(track={}, slot={}) failed to close sandbox editor for {}: {}",
                track_id,
                slot_id,
                instance_id,
                err
            );
        }
    }

    Ok(())
}

/// Set a normalized parameter on an external plugin instance.
///
/// `value` is expected in the plugin-native normalized range [0..1].
#[tauri::command]
fn set_external_plugin_param_cmd(
    plugin_id: String,
    param_index: u32,
    value: f64,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    _project_state: tauri::State<'_, ProjectState>,
) -> Result<(), String> {
    if plugin_host_state.set_sandbox_parameter(&plugin_id, param_index, value)? {
        return Ok(());
    }

    let normalized = value.clamp(0.0, 1.0);
    let maybe_instance_id = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .get(&plugin_id)
        .copied();
    let Some(instance_id) = maybe_instance_id else {
        log::debug!(
            "[IPC] set_external_plugin_param_cmd(plugin={}, idx={}, value={:.4}) skipped: plugin not active",
            plugin_id,
            param_index,
            normalized
        );
        return Ok(());
    };
    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let instance = host
        .get_mut(instance_id)
        .ok_or_else(|| format!("Plugin instance not found: {instance_id}"))?;
    instance
        .lock()
        .set_parameter(param_index, normalized)
        .map_err(|e| format!("Failed to set external plugin parameter {param_index}: {e}"))?;

    log::debug!(
        "[IPC] set_external_plugin_param_cmd(plugin={}, idx={}, value={:.4})",
        plugin_id,
        param_index,
        normalized
    );
    Ok(())
}

#[tauri::command]
fn set_external_plugin_param_for_slot_cmd(
    track_id: String,
    slot_id: String,
    param_index: u32,
    value: f64,
    push_undo_step: Option<bool>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let should_commit_snapshot = push_undo_step.unwrap_or(true);
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;

    let (resolved_slot_id, resolved_plugin_id) = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let slot = find_slot_on_track(&project, track_uuid, slot_uuid)
            .ok_or_else(|| format!("Plugin slot not found on track {}: {}", track_id, slot_id))?;
        (slot.id, slot.plugin_id.clone())
    };
    if resolved_plugin_id.starts_with("internal://") {
        return Err("Internal plugin slot does not support external parameter API".to_string());
    }

    if should_commit_snapshot {
        push_undo(&project_state)?;
    }

    let normalized = value.clamp(0.0, 1.0);
    let instance_id = plugin_host_state.ensure_loaded_instance_for_slot(resolved_slot_id, &resolved_plugin_id)?;
    plugin_host_state.bind_slot_instance(resolved_slot_id, instance_id);

    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let instance = host
        .get_mut(instance_id)
        .ok_or_else(|| format!("Plugin instance not found: {instance_id}"))?;
    instance
        .lock()
        .set_parameter(param_index, normalized)
        .map_err(|e| format!("Failed to set external plugin parameter {param_index}: {e}"))?;
    drop(host);

    let lane_cmd = dream_orchestrator::commands::SetExternalPluginParamLaneCommand::from_str_ids(
        &track_id,
        &resolved_slot_id.to_string(),
        param_index,
        normalized,
    )
    .map_err(|e| e.to_string())?;
    execute_orchestrator_command(&project_state, &lane_cmd)?;

    let project_mut = project_state.project.lock().map_err(|e| e.to_string())?;
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    if should_commit_snapshot {
        // Expensive snapshot rebuilds are deferred during live gestures.
        rebuild_automation_snapshot_from_project(&project_mut, &automation_runtime);
        clip_pool_state.rebuild_external_fx_snapshot(
            &project_mut,
            plugin_host_state.slot_instance_snapshot().as_ref(),
        );
        plugin_host_state.publish_registry();
        let project_name = project_mut.name.clone();
        drop(project_mut);
        project_state.mark_dirty(&project_name, Some(&app))?;
    }

    log::debug!(
        "[IPC] set_external_plugin_param_for_slot_cmd(track={}, slot={}, idx={}, value={:.4}, commit={})",
        track_id,
        slot_id,
        param_index,
        normalized,
        should_commit_snapshot
    );
    Ok(())
}

#[tauri::command]
fn set_external_plugin_param_for_slot_with_deltas_cmd(
    track_id: String,
    slot_id: String,
    param_index: u32,
    value: f64,
    push_undo_step: Option<bool>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let normalized = value.clamp(0.0, 1.0);

    set_external_plugin_param_for_slot_cmd(
        track_id,
        slot_id,
        param_index,
        value,
        push_undo_step,
        plugin_host_state,
        project_state,
        clip_pool_state,
        automation_runtime,
        app,
    )?;

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::ExternalPluginParamChanged {
            track_id: track_uuid,
            slot_id: slot_uuid,
            param_index,
            value: normalized,
        }],
    })
}

/// Returns externally controllable plugin params for inline UI.
#[tauri::command]
fn get_external_plugin_params(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<Vec<ExternalPluginParamInfo>, String> {
    fn fallback_param_block(metadata_count: usize) -> Vec<ExternalPluginParamInfo> {
        let count = if metadata_count > 0 { metadata_count } else { 16 }.min(128);
        let mut out = Vec::with_capacity(count);
        for idx in 0..count {
            out.push(ExternalPluginParamInfo {
                index: idx as u32,
                name: format!("Param {}", idx + 1),
                min: 0.0,
                max: 1.0,
                step: 0.001,
                value: 0.5,
            });
        }
        out
    }

    let plugin_key = normalize_plugin_key_local(&plugin_id);
    if plugin_host_state
        .loaded_sandbox_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&plugin_id)
    {
        return Ok(vec![ExternalPluginParamInfo {
            index: 0,
            name: "Gain".to_string(),
            min: 0.0,
            max: 2.0,
            step: 0.001,
            value: 1.0,
        }]);
    }

    let (metadata_count, lane_name_hints) = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let count = find_project_plugin_slot(&project, &plugin_id)
            .and_then(|slot| slot.external_parameter_count)
            .unwrap_or(0)
            .max(0) as usize;
        let hints = lane_param_name_hints(&project, &plugin_key);
        (count, hints)
    };

    let Some(instance_id) = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .get(&plugin_id)
        .copied()
    else {
        return Ok(fallback_param_block(metadata_count));
    };

    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let Some(instance) = host.get_mut(instance_id) else {
        log::warn!(
            "[PluginParams] Missing instance for active plugin key '{}'; using fallback params",
            plugin_id
        );
        return Ok(fallback_param_block(metadata_count));
    };

    let host_count = instance.lock().parameter_count() as usize;
    let count = if host_count > 0 {
        host_count
    } else if metadata_count > 0 {
        metadata_count
    } else {
        16
    }
    .min(128);

    let mut out = Vec::with_capacity(count);
    for idx in 0..count {
        let value = instance
            .lock()
            .get_parameter(idx as u32)
            .unwrap_or(0.5)
            .clamp(0.0, 1.0);
        let fallback_name = format!("Param {}", idx + 1);
        let name = lane_name_hints
            .get(&(idx as u32))
            .cloned()
            .unwrap_or(fallback_name);
        out.push(ExternalPluginParamInfo {
            index: idx as u32,
            name,
            min: 0.0,
            max: 1.0,
            step: 0.001,
            value,
        });
    }
    Ok(out)
}

#[tauri::command]
fn get_external_plugin_params_for_slot(
    track_id: String,
    slot_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<Vec<ExternalPluginParamInfo>, String> {
    fn fallback_param_block(metadata_count: usize) -> Vec<ExternalPluginParamInfo> {
        let count = if metadata_count > 0 { metadata_count } else { 16 }.min(128);
        (0..count)
            .map(|idx| ExternalPluginParamInfo {
                index: idx as u32,
                name: format!("Param {}", idx + 1),
                min: 0.0,
                max: 1.0,
                step: 0.001,
                value: 0.5,
            })
            .collect()
    }

    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();
    let slot = find_slot_on_track(&project, track_uuid, slot_uuid)
        .ok_or_else(|| format!("Plugin slot not found on track {}: {}", track_id, slot_id))?;

    if slot.plugin_id.starts_with("internal://") {
        return Ok(Vec::new());
    }

    let metadata_count = slot.external_parameter_count.unwrap_or(0).max(0) as usize;
    let instance_id = plugin_host_state.ensure_loaded_instance_for_slot(slot.id, &slot.plugin_id)?;
    plugin_host_state.bind_slot_instance(slot.id, instance_id);

    // Restore saved state before reading parameters so we report the
    // actual preset values instead of plugin defaults.
    if slot.external_state_blob.is_some() || slot.external_preset_blob.is_some() {
        if let Ok(mut host) = plugin_host_state.host.lock() {
            let _ = apply_imported_external_state_blob(&mut host, instance_id, &slot);
        }
    }

    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let Some(instance) = host.get_mut(instance_id) else {
        return Ok(fallback_param_block(metadata_count));
    };
    let count_hint = instance.lock().parameter_count().max(metadata_count as u32);
    let count = (if count_hint > 0 { count_hint } else { 16 }).min(128);

    let mut params = Vec::with_capacity(count as usize);
    for idx in 0..count {
        params.push(ExternalPluginParamInfo {
            index: idx,
            name: format!("Param {}", idx + 1),
            min: 0.0,
            max: 1.0,
            step: 0.001,
            value: instance.lock().get_parameter(idx).unwrap_or(0.5),
        });
    }
    drop(host);

    clip_pool_state.rebuild_external_fx_snapshot(&project, plugin_host_state.slot_instance_snapshot().as_ref());
    plugin_host_state.publish_registry();
    Ok(params)
}
