/// Set a normalized parameter on an external plugin instance.
///
/// `value` is expected in the plugin-native normalized range [0..1].
#[tauri::command]
fn set_external_plugin_param_cmd(
    plugin_id: String,
    param_index: u32,
    value: f64,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let normalized = value.clamp(0.0, 1.0);
    let slot_states = resolve_plugin_slot_states_by_plugin_id(&project_state, &plugin_id)?;
    let Some(slot) = slot_states.first() else {
        log::debug!(
            "[IPC] set_external_plugin_param_cmd(plugin={}, idx={}, value={:.4}) skipped: plugin not active",
            plugin_id,
            param_index,
            normalized
        );
        return Ok(());
    };
    if slot_states.len() > 1 {
        log::warn!(
            "[IPC] set_external_plugin_param_cmd({}) matched {} slots; applying to slot {} only",
            plugin_id,
            slot_states.len(),
            slot.slot_id
        );
    }

    let instance_id =
        plugin_host_state.ensure_loaded_instance_for_slot(slot.slot_id, &slot.plugin_id)?;
    plugin_host_state.bind_slot_instance(slot.slot_id, instance_id);

    let mut host = plugin_host_state.host.lock().map_err(|_| "Mutex poisoned".to_string())?;
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let should_commit_snapshot = push_undo_step.unwrap_or(true);
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;

    let resolved = execute_orchestrator_query(
        project_state,
        &dream_orchestrator::queries::ResolveExternalPluginParamTargetQuery {
            track_id: track_uuid,
            slot_id: slot_uuid,
        },
    )?;
    let resolved_slot_id = resolved.slot_id;
    let resolved_plugin_id = resolved.plugin_id;

    if should_commit_snapshot {
        push_undo(&project_state)?;
    }

    let normalized = value.clamp(0.0, 1.0);
    let instance_id =
        plugin_host_state.ensure_loaded_instance_for_slot(resolved_slot_id, &resolved_plugin_id)?;
    plugin_host_state.bind_slot_instance(resolved_slot_id, instance_id);

    let mut host = plugin_host_state.host.lock().map_err(|_| "Mutex poisoned".to_string())?;
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
    .map_err(|_| "Mutex poisoned".to_string())?;
    execute_orchestrator_command(&project_state, &lane_cmd)?;

    finalize_external_param_update(
        project_state,
        &clip_pool_state,
        &plugin_host_state,
        &automation_runtime,
        &app,
        should_commit_snapshot,
    )?;

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

/// Runtime-only parameter update for external plugin slot.
///
/// Uses slot binding directly and avoids project mutation / undo / dirty marking.
/// Intended for high-frequency UI gestures.
#[tauri::command]
fn set_external_plugin_param_for_slot_runtime_cmd(
    slot_id: String,
    plugin_id: String,
    param_index: u32,
    value: f64,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<(), String> {
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let normalized = value.clamp(0.0, 1.0);

    let instance_id = plugin_host_state.ensure_loaded_instance_for_slot(slot_uuid, &plugin_id)?;
    plugin_host_state.bind_slot_instance(slot_uuid, instance_id);

    let mut host = plugin_host_state.host.lock().map_err(|_| "Mutex poisoned".to_string())?;
    let instance = host
        .get_mut(instance_id)
        .ok_or_else(|| format!("Plugin instance not found: {instance_id}"))?;
    instance
        .lock()
        .set_parameter(param_index, normalized)
        .map_err(|e| format!("Failed to set external plugin parameter {param_index}: {e}"))?;
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
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
        project_registry.clone(),
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
