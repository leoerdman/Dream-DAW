fn resolve_plugin_slot_states_by_plugin_id(
    project_state: &tauri::State<'_, ProjectState>,
    plugin_id: &str,
) -> Result<Vec<dream_orchestrator::queries::PluginSlotState>, String> {
    execute_orchestrator_query(
        project_state,
        &dream_orchestrator::queries::ResolvePluginSlotsByPluginIdQuery {
            plugin_id: plugin_id.to_string(),
        },
    )
}

fn bind_instance_to_slot_states(
    slot_states: &[dream_orchestrator::queries::PluginSlotState],
    instance_id: Uuid,
    plugin_host_state: &tauri::State<'_, PluginHostState>,
) {
    let bound = plugin_host_state.slot_instance_snapshot();
    for slot in slot_states {
        if bound.contains_key(&slot.slot_id) {
            continue;
        }
        plugin_host_state.bind_slot_instance(slot.slot_id, instance_id);
    }
}

#[tauri::command]
fn open_plugin_window(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    plugin_host_state.try_enable_sandbox_if_available();
    let slot_states = resolve_plugin_slot_states_by_plugin_id(&project_state, &plugin_id)?;

    if plugin_host_state.open_sandbox_editor(&plugin_id)? {
        log::info!("[IPC] open_plugin_window({plugin_id}) -> already managed by sandbox host");
        return Ok(());
    }

    if let Some(instance_id) = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .get(&plugin_id)
        .copied()
    {
        bind_instance_to_slot_states(&slot_states, instance_id, &plugin_host_state);
        let host_arc = std::sync::Arc::clone(&plugin_host_state.host);
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        app.run_on_main_thread(move || {
            let result = (|| {
                let mut host = host_arc.lock().map_err(|e| e.to_string())?;
                host.open_editor(instance_id)
                    .map_err(|e| format!("Failed to open existing plugin editor: {e}"))
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| format!("Failed to schedule GUI open on main thread: {e}"))?;
        rx.recv()
            .map_err(|e| format!("Failed to receive GUI open result: {e}"))??;
        log::info!("[IPC] open_plugin_window({plugin_id}) -> reuse instance {instance_id}");
        return Ok(());
    }

    let descriptor = plugin_host_state.resolve_descriptor(&plugin_id)?;

    if plugin_host_state.sandbox_enabled().unwrap_or(false) {
        match plugin_host_state.open_in_sandbox(&plugin_id, descriptor.clone()) {
            Ok(instance_id) => {
                log::info!(
                    "[IPC] open_plugin_window({plugin_id}) -> sandbox instance {} ({})",
                    instance_id,
                    descriptor.path.display()
                );
                return Ok(());
            }
            Err(err) => {
                if !PluginHostState::allow_unsandboxed_vst3() {
                    return Err(format!(
                        "Plugin sandbox failed for '{}': {}. In-process fallback is disabled (DREAM_DAW_FORCE_SANDBOX_ONLY is active).",
                        descriptor.name,
                        err
                    ));
                }
                log::warn!(
                    "[PluginSandbox] open_plugin_window({plugin_id}) sandbox failed: {}. Falling back to in-process host.",
                    err
                );
            }
        }
    } else if !PluginHostState::allow_unsandboxed_vst3() {
        return Err(format!(
            "Plugin sandbox is unavailable for '{}'. In-process fallback is disabled (DREAM_DAW_FORCE_SANDBOX_ONLY is active).",
            descriptor.name
        ));
    }

    // BUG-11 FIX: Reuse the descriptor from the first resolve call above.
    // Previously there was a second `resolve_descriptor` call here, which
    // wasted I/O and introduced a TOCTOU race if the bundle was modified.
    let instance_id = if let Some(existing) = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .get(&plugin_id)
        .copied()
    {
        existing
    } else {
        let slot_clone = slot_states.first().cloned();

        let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
        let loaded = host
            .load_vst3(descriptor.clone())
            .map_err(|e| format!("Failed to load plugin '{}': {e}", descriptor.name))?;
        
        if let Some(slot) = slot_clone {
            let mut slot_restore =
                dream_models::project::PluginSlot::new(slot.name.clone(), slot.plugin_id.clone());
            slot_restore.id = slot.slot_id;
            slot_restore.supports_sidechain_input = slot.supports_sidechain_input;
            slot_restore.external_parameter_count = slot.external_parameter_count;
            slot_restore.external_state_blob = slot.external_state_blob.clone();
            slot_restore.external_state_blob_kind = slot.external_state_blob_kind.clone();
            slot_restore.external_preset_blob = slot.external_preset_blob.clone();
            slot_restore.external_preset_blob_kind = slot.external_preset_blob_kind.clone();
            if let Err(err) = apply_imported_external_state_blob(&mut host, loaded, &slot_restore) {
                log::warn!(
                    "[PluginState] Could not restore imported state for '{}': {}",
                    slot_restore.name,
                    err
                );
            }
        }
        drop(host);

        // BUG-12 FIX: Insert into loaded_by_key BEFORE scheduling the editor
        // open. This prevents a second concurrent IPC call from loading a
        // duplicate instance during the race window between load_vst3() and
        // the original map insertion (which was after editor open).
        plugin_host_state
            .loaded_by_key
            .lock()
            .map_err(|e| e.to_string())?
            .insert(plugin_id.clone(), loaded);
        bind_instance_to_slot_states(&slot_states, loaded, &plugin_host_state);

        loaded
    };
    let host_arc = std::sync::Arc::clone(&plugin_host_state.host);
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
    app.run_on_main_thread(move || {
        let result = (|| {
            let mut host = host_arc.lock().map_err(|e| e.to_string())?;
            host.open_editor(instance_id)
                .map_err(|e| format!("Plugin loaded but editor failed to open: {e}"))
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| format!("Failed to schedule GUI open on main thread: {e}"))?;

    let editor_result = rx.recv()
        .map_err(|e| format!("Failed to receive GUI open result: {e}"))?;

    // BUG-12 FIX: If editor open fails, clean up the loaded_by_key entry
    // and unload the instance. This prevents phantom entries that block
    // future load attempts.
    if let Err(ref err) = editor_result {
        log::warn!(
            "[IPC] open_plugin_window({plugin_id}) editor open failed, cleaning up: {err}"
        );
        if let Ok(mut map) = plugin_host_state.loaded_by_key.lock() {
            map.remove(&plugin_id);
        }
        if let Ok(mut host) = plugin_host_state.host.lock() {
            let _ = host.remove(instance_id);
        }
    }
    editor_result?;
    log::info!(
        "[IPC] open_plugin_window({plugin_id}) -> loaded VST instance {} ({})",
        instance_id,
        descriptor.path.display()
    );
    Ok(())
}

#[tauri::command]
fn open_plugin_window_for_slot(
    track_id: String,
    slot_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;

    log::info!(
        "[IPC] open_plugin_window_for_slot START track={} slot={}",
        track_id,
        slot_id
    );

    let slot = execute_orchestrator_query(
        &project_state,
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

    // If this plugin is currently hosted in sandbox, route editor open to the
    // sandbox daemon first. This is the only path that opens the real native
    // GUI for sandboxed instances.
    let sandbox_result = plugin_host_state.open_sandbox_editor(&slot.plugin_id)?;
    log::info!(
        "[IPC] open_plugin_window_for_slot sandbox_editor_result={}",
        sandbox_result
    );
    if sandbox_result {
        log::info!(
            "[IPC] open_plugin_window_for_slot(track={}, slot={}) -> sandbox editor open",
            track_id,
            slot_id
        );
        return Ok(());
    }

    let instance_id =
        plugin_host_state.ensure_loaded_instance_for_slot(slot.slot_id, &slot.plugin_id)?;
    plugin_host_state.bind_slot_instance(slot.slot_id, instance_id);

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
        if editor_bridge_missing && plugin_host_state.sandbox_enabled().unwrap_or(false) {
            match plugin_host_state.resolve_descriptor(&slot.plugin_id) {
                Ok(descriptor) => {
                            match plugin_host_state.open_in_sandbox(&slot.plugin_id, descriptor) {
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
                Err(resolve_err) => {
                    log::warn!(
                        "[IPC] open_plugin_window_for_slot sandbox fallback descriptor resolve failed (track={}, slot={}): {}",
                        track_id,
                        slot_id,
                        resolve_err
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

        // Load the plugin in-process — this runs init_vst3_com which
        // acquires the real COM pointers (IComponent, IAudioProcessor,
        // IEditController) needed for the native editor.
        let descriptor = plugin_host_state.resolve_descriptor(&slot.plugin_id)?;
        let recovered_instance = {
            let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
            host.load_vst3(descriptor)
                .map_err(|e| format!("In-process reload failed for '{}': {e}", slot.plugin_id))?
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

    sync_external_fx_snapshot_from_state(&project_state, &clip_pool_state, &plugin_host_state)?;

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
