#[tauri::command]
fn close_plugin_window_cmd(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let slot_states = resolve_plugin_slot_states_by_plugin_id(&project_state, &plugin_id)?;
    let Some(slot) = slot_states.first() else {
        log::info!("[IPC] close_plugin_window({plugin_id}) -> no matched slots");
        return Ok(());
    };
    if slot_states.len() > 1 {
        log::warn!(
            "[IPC] close_plugin_window({}) matched {} slots; closing slot {} only",
            plugin_id,
            slot_states.len(),
            slot.slot_id
        );
    }
    let maybe_instance = plugin_host_state
        .slot_instance_snapshot()
        .get(&slot.slot_id)
        .copied();
    if let Some(instance_id) = maybe_instance {
        // CRITICAL: close_editor performs AppKit calls (NSWindow close, NSView
        // removed/release) that MUST happen on the main thread.
        let host_arc = std::sync::Arc::clone(&plugin_host_state.host);
        let plugin_id_clone = plugin_id.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        app.run_on_main_thread(move || {
            let result = (|| {
                let mut host = host_arc.lock();
                host.close_editor(instance_id).map_err(|e| e.to_string())
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| format!("Failed to schedule editor close on main thread: {e}"))?;
        if let Err(err) = rx
            .recv()
            .map_err(|e| format!("Failed to receive editor close result: {e}"))?
        {
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;

    // Resolve slot data through orchestrator query to keep transport thin.
    let slot_state = execute_orchestrator_query(
        project_state,
        &dream_orchestrator::queries::ResolvePluginSlotStateQuery {
            track_id: track_uuid,
            slot_id: slot_uuid,
        },
    )?;
    if slot_state.plugin_id.starts_with("internal://") {
        return Ok(());
    }
    let stored_blob = slot_state.external_state_blob;

    // Close editor on main thread (AppKit requirement)
    let instance_id_opt = plugin_host_state.slot_instance_snapshot().get(&slot_uuid).copied();
    if let Some(instance_id) = instance_id_opt {
        let host_arc = std::sync::Arc::clone(&plugin_host_state.host);
        let track_id_log = track_id.clone();
        let slot_id_log = slot_id.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        app.run_on_main_thread(move || {
            let result = (|| {
                let mut host = host_arc.lock();
                host.close_editor(instance_id).map_err(|e| e.to_string())
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| format!("Failed to schedule editor close on main thread: {e}"))?;
        if let Err(err) = rx
            .recv()
            .map_err(|e| format!("Failed to receive editor close result: {e}"))?
        {
            log::warn!(
                "[IPC] close_plugin_window_for_slot(track={}, slot={}) failed to close in-process editor for {}: {}",
                track_id_log,
                slot_id_log,
                instance_id,
                err
            );
        }

        // State comparison: detect silent preset changes.
        {
            let host = plugin_host_state.host.lock();
            if let Some(live_bytes) = host.save_instance_state(instance_id) {
                use base64::Engine;
                let live_b64 = base64::engine::general_purpose::STANDARD.encode(&live_bytes);
                let state_changed = stored_blob.as_deref() != Some(&live_b64);
                if state_changed {
                    log::info!(
                        "[IPC] close_plugin_window_for_slot: plugin state changed (slot={}), marking dirty",
                        slot_id
                    );
                    // Release PluginHost lock before project lock.
                    drop(host);
                    let cmd = dream_orchestrator::commands::UpdatePluginExternalStateBlobCommand {
                        track_id: track_uuid,
                        slot_id: slot_uuid,
                        external_state_blob: Some(live_b64),
                        external_state_blob_kind: Some("ProcessorState".to_string()),
                    };
                    if execute_orchestrator_command(&project_state, &cmd).unwrap_or(false) {
                        let _ = project_state.mark_dirty_current(Some(&app));
                    }
                }
            }
        }
    }

    // Also ask sandbox supervisor to close editor for this exact slot instance.
    if let Some(instance_id) = instance_id_opt {
        let mut supervisor = plugin_host_state
            .sandbox_supervisor
            .lock();
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
