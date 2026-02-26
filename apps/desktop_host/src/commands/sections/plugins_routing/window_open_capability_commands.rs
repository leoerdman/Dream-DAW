#[tauri::command]
fn can_open_plugin_editor(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<PluginEditorCapability, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string());
    };
    let project_state_guard = active_project_arc.read().unwrap();
    let project_state: &crate::state_managers::ProjectState = &*project_state_guard;
    let slot_states = resolve_plugin_slot_states_by_plugin_id(&project_state, &plugin_id)?;
    let instance_id = slot_states
        .first()
        .and_then(|slot| plugin_host_state.slot_instance_snapshot().get(&slot.slot_id).copied());
    if slot_states.len() > 1 {
        log::warn!(
            "[IPC] can_open_plugin_editor({}) matched {} slots; probing slot {} only",
            plugin_id,
            slot_states.len(),
            slot_states[0].slot_id
        );
    }
    if let Some(instance_id) = instance_id {
        let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
        let supported = host
            .supports_editor(instance_id)
            .map_err(|e| format!("Failed to check editor capability: {e}"))?;
        return Ok(PluginEditorCapability {
            supported,
            reason: if supported {
                None
            } else {
                Some(
                    "Native plugin editor host bridge is not implemented yet for this instance."
                        .to_string(),
                )
            },
        });
    }

    let _ = plugin_host_state.resolve_descriptor(&plugin_id)?;

    Ok(PluginEditorCapability {
        // Enterprise hardening: never instantiate an unloaded third-party plugin
        // just to probe editor capability. Some plugins crash during activation,
        // which can take down the whole DAW process.
        //
        // We only do exact capability checks on already-loaded instances above.
        // For unloaded external descriptors, report optimistic support and defer the
        // real result to open_plugin_window (where failures are surfaced safely).
        supported: true,
        reason: None,
    })
}

#[tauri::command]
fn can_open_plugin_editor_for_slot(
    track_id: String,
    slot_id: String,
    _plugin_host_state: tauri::State<'_, PluginHostState>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<PluginEditorCapability, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string());
    };
    let project_state_guard = active_project_arc.read().unwrap();
    let project_state: &crate::state_managers::ProjectState = &*project_state_guard;
    let track_uuid =
        Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid =
        Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let slot = execute_orchestrator_query(
        &project_state,
        &dream_orchestrator::queries::ResolvePluginSlotStateQuery {
            track_id: track_uuid,
            slot_id: slot_uuid,
        },
    )?;

    if slot.plugin_id.starts_with("internal://") {
        return Ok(PluginEditorCapability {
            supported: false,
            reason: Some("Internal device does not expose a native external editor.".to_string()),
        });
    }

    Ok(PluginEditorCapability {
        // Never block editor-open attempts from the probe path.
        // Real capability is established in open_plugin_window_for_slot(), which
        // already contains sandbox fallback + error reporting.
        supported: true,
        reason: None,
    })
}
