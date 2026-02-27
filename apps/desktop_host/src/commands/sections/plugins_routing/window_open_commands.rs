/// Load a plugin instance in-process by dispatching on its format.
///
/// This is the hard-recovery path used when a sandboxed plugin crashes.
/// It mirrors the same format-dispatched loading as
/// `PluginHostState::ensure_loaded_instance_for_slot`.
fn load_descriptor_in_process(
    host: &mut dream_plugins::PluginHost,
    descriptor: &dream_plugins::PluginDescriptor,
) -> Result<uuid::Uuid, String> {
    match descriptor.format {
        dream_plugins::format::PluginFormat::VST3 => host
            .load_vst3(descriptor.clone())
            .map_err(|e| format!("In-process VST3 reload failed for '{}': {e}", descriptor.name)),
        dream_plugins::format::PluginFormat::VST2 => host
            .load_vst2(descriptor.clone())
            .map_err(|e| format!("In-process VST2 reload failed for '{}': {e}", descriptor.name)),
        dream_plugins::format::PluginFormat::AudioUnit => host
            .load_au(descriptor.clone())
            .map_err(|e| format!("In-process AU reload failed for '{}': {e}", descriptor.name)),
        other => Err(format!(
            "Unsupported plugin format '{}' for in-process loading of '{}'",
            other, descriptor.name
        )),
    }
}

fn resolve_plugin_slot_states_by_plugin_id(
    project_state: &crate::state_managers::ProjectState,
    plugin_id: &str,
) -> Result<Vec<dream_orchestrator::queries::PluginSlotState>, String> {
    execute_orchestrator_query(
        project_state,
        &dream_orchestrator::queries::ResolvePluginSlotsByPluginIdQuery {
            plugin_id: plugin_id.to_string(),
        },
    )
}

#[tauri::command]
fn open_plugin_window(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    plugin_host_state.try_enable_sandbox_if_available();
    let slot_states = resolve_plugin_slot_states_by_plugin_id(&project_state, &plugin_id)?;
    let Some(slot) = slot_states.first().cloned() else {
        return Err(format!("No plugin slots found for plugin_id: {plugin_id}"));
    };
    if slot_states.len() > 1 {
        log::warn!(
            "[IPC] open_plugin_window({}) matched {} slots; opening slot {} only to preserve per-slot instance isolation",
            plugin_id,
            slot_states.len(),
            slot.slot_id
        );
    }

    let instance_id =
        plugin_host_state.ensure_loaded_instance_for_slot(slot.slot_id, &slot.plugin_id)?;
    plugin_host_state.bind_slot_instance(slot.slot_id, instance_id);
    sync_external_fx_snapshot_from_state(project_state, &clip_pool_state, &plugin_host_state)?;

    let host_arc = std::sync::Arc::clone(&plugin_host_state.host);
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
    app.run_on_main_thread(move || {
        let result = (|| {
            let mut host = host_arc.lock().map_err(|e| e.to_string())?;
            host.open_editor(instance_id)
                .map_err(|e| format!("Failed to open plugin editor: {e}"))
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| format!("Failed to schedule GUI open on main thread: {e}"))?;

    rx.recv()
        .map_err(|e| format!("Failed to receive GUI open result: {e}"))??;
    log::info!(
        "[IPC] open_plugin_window({plugin_id}) -> opened slot {} instance {}",
        slot.slot_id,
        instance_id,
    );
    Ok(())
}

#[tauri::command]
fn open_plugin_window_for_slot(
    track_id: String,
    slot_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;

    log::info!(
        "[IPC] open_plugin_window_for_slot START track={} slot={}",
        track_id,
        slot_id
    );

    let slot = execute_orchestrator_query(
        project_state,
        &dream_orchestrator::queries::ResolvePluginSlotStateQuery {
            track_id: track_uuid,
            slot_id: slot_uuid,
        },
    )?;

    log::info!(
        "[IPC] open_plugin_window_for_slot plugin_id='{}' source='{}'",
        slot.plugin_id,
        if slot.plugin_id.starts_with("internal://") { "internal" } else { "external" }
    );

    if slot.plugin_id.starts_with("internal://") {
        return Err("Internal device has no native external editor".to_string());
    }

    // Slot-scoped sandbox open: never route by plugin_id, otherwise identical
    // plugins on different slots can open the wrong instance editor.
    if let Some(bound_instance) = plugin_host_state
        .slot_instance_snapshot()
        .get(&slot.slot_id)
        .copied()
    {
        let sandbox_result = plugin_host_state
            .sandbox_supervisor
            .lock()
            .map_err(|e| e.to_string())?
            .send_open_editor(bound_instance)
            .is_ok();
        log::info!(
            "[IPC] open_plugin_window_for_slot slot-scoped sandbox open (slot={}, instance={}) => {}",
            slot.slot_id,
            bound_instance,
            sandbox_result
        );
        if sandbox_result {
            return Ok(());
        }
    }

    let instance_id =
        plugin_host_state.ensure_loaded_instance_for_slot(slot.slot_id, &slot.plugin_id)?;
    plugin_host_state.bind_slot_instance(slot.slot_id, instance_id);
    plugin_host_state.publish_registry();
    let sandbox_result = plugin_host_state
        .sandbox_supervisor
        .lock()
        .map_err(|e| e.to_string())?
        .send_open_editor(instance_id)
        .is_ok();
    if sandbox_result {
        log::info!(
            "[IPC] open_plugin_window_for_slot(track={}, slot={}) -> sandbox editor open (instance={})",
            track_id,
            slot_id,
            instance_id
        );
        return Ok(());
    }

    // Restore per-slot saved state (preset, knob positions, etc.)
    if slot.external_state_blob.is_some() || slot.external_preset_blob.is_some() {
        if let Ok(mut host) = plugin_host_state.host.lock() {
            let mut slot_restore =
                dream_models::project::PluginSlot::new(slot.name.clone(), slot.plugin_id.clone());
            slot_restore.id = slot.slot_id;
            slot_restore.supports_sidechain_input = slot.supports_sidechain_input;
            slot_restore.external_parameter_count = slot.external_parameter_count;
            slot_restore.external_state_blob = slot.external_state_blob.clone();
            slot_restore.external_state_blob_kind = slot.external_state_blob_kind.clone();
            slot_restore.external_preset_blob = slot.external_preset_blob.clone();
            slot_restore.external_preset_blob_kind = slot.external_preset_blob_kind.clone();
            if let Err(err) =
                apply_imported_external_state_blob(&mut host, instance_id, &slot_restore)
            {
                log::warn!(
                    "[IPC] open_plugin_window_for_slot: state restore failed for '{}': {}",
                    slot.name, err
                );
            } else {
                log::info!(
                    "[IPC] open_plugin_window_for_slot: restored state for '{}' (slot {})",
                    slot.name, slot.slot_id
                );
            }
        }
    }

    let mut first_open_err: Option<String> = None;
    {
        let host_arc = std::sync::Arc::clone(&plugin_host_state.host);
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        app.run_on_main_thread(move || {
            let result = (|| {
                let mut host = host_arc.lock().map_err(|e| e.to_string())?;
                host.open_editor(instance_id)
                    .map_err(|e| e.to_string())
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| format!("Failed to schedule GUI open on main thread: {e}"))?;
        if let Err(err) = rx
            .recv()
            .map_err(|e| format!("Failed to receive GUI open result: {e}"))?
        {
            first_open_err = Some(err);
        }
    }

    if let Some(first_err) = first_open_err {
        log::warn!(
            "[IPC] open_plugin_window_for_slot first open failed (track={}, slot={}, instance={}): {}",
            track_id,
            slot_id,
            instance_id,
            first_err
        );

        // If in-process editor bridge is unavailable, try sandbox-hosted editor
        // as a compatibility fallback (many plugins expose UI there reliably).
        let editor_bridge_missing = first_err.to_ascii_lowercase().contains("editor bridge symbol")
            || first_err.to_ascii_lowercase().contains("editor is not supported")
            || first_err.to_ascii_lowercase().contains("native plugin editor bridge");
        let descriptor = plugin_host_state.resolve_descriptor(&slot.plugin_id)?;
        let sandbox_eligible = descriptor.format == PluginFormat::VST3;
        if editor_bridge_missing && sandbox_eligible && plugin_host_state.sandbox_enabled().unwrap_or(false) {
            match plugin_host_state.open_in_sandbox(&slot.plugin_id, descriptor.clone()) {
                Ok(sandbox_instance_id) => {
                    plugin_host_state.bind_slot_instance(slot.slot_id, sandbox_instance_id);
                    sync_external_fx_snapshot_from_state(
                        &project_state,
                        &clip_pool_state,
                        &plugin_host_state,
                    )?;
                    log::info!(
                        "[IPC] open_plugin_window_for_slot(track={}, slot={}) -> sandbox fallback instance {}",
                        track_id,
                        slot_id,
                        sandbox_instance_id
                    );
                    return Ok(());
                }
                Err(sandbox_err) => {
                    log::warn!(
                        "[IPC] open_plugin_window_for_slot sandbox fallback failed (track={}, slot={}): {}",
                        track_id,
                        slot_id,
                        sandbox_err
                    );
                }
            }
        }

        // Hard recovery path: drop stale instance, reload FRESH in-process
        // (bypassing sandbox entirely — if the sandbox was healthy we would
        // not be here), then retry the editor open once.
        {
            let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
            let _ = host.remove(instance_id);
        }
        plugin_host_state.unbind_slot_instance(slot.slot_id);

        // Load the plugin in-process using the resolved format loader.
        let descriptor = plugin_host_state.resolve_descriptor(&slot.plugin_id)?;
        let recovered_instance = {
            let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
            load_descriptor_in_process(&mut host, &descriptor)?
        };
        plugin_host_state.bind_slot_instance(slot.slot_id, recovered_instance);
        plugin_host_state
            .loaded_by_key
            .lock()
            .map_err(|e| e.to_string())?
            .insert(slot.plugin_id.clone(), recovered_instance);

        {
            let host_arc = std::sync::Arc::clone(&plugin_host_state.host);
            let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
            app.run_on_main_thread(move || {
                let result = (|| {
                    let mut host = host_arc.lock().map_err(|e| e.to_string())?;
                    host.open_editor(recovered_instance)
                        .map_err(|e| e.to_string())
                })();
                let _ = tx.send(result);
            })
            .map_err(|e| format!("Failed to schedule GUI open retry on main thread: {e}"))?;
            rx.recv()
                .map_err(|e| format!("Failed to receive GUI open retry result: {e}"))?
                .map_err(|e| {
                    format!(
                        "Failed to open plugin editor (retry after reload). First error: {}. Retry error: {}",
                        first_err,
                        e
                    )
                })?;
        }
    }

    sync_external_fx_snapshot_from_state(project_state, &clip_pool_state, &plugin_host_state)?;

    // Mark project dirty — plugin editor opening implies parameters may be
    // changed via the native GUI (which doesn't notify our project model).
    let _ = project_state.mark_dirty_current(Some(&app));

    log::info!(
        "[IPC] open_plugin_window_for_slot(track={}, slot={}) -> instance {}",
        track_id,
        slot_id,
        instance_id
    );
    Ok(())
}
