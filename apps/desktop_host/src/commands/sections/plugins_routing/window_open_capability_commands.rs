#[tauri::command]
fn can_open_plugin_editor(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<PluginEditorCapability, String> {
    if plugin_host_state
        .loaded_sandbox_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&plugin_id)
    {
        return Ok(PluginEditorCapability {
            supported: true,
            reason: None,
        });
    }

    if let Some(instance_id) = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .get(&plugin_id)
        .copied()
    {
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

    let descriptor = plugin_host_state.resolve_descriptor(&plugin_id)?;
    if descriptor.format == PluginFormat::CLAP {
        let reason = match descriptor.format {
            PluginFormat::VST2 | PluginFormat::VST3 => None,
            PluginFormat::CLAP => {
                Some("CLAP plugin editor is not supported by this host build.".to_string())
            }
            PluginFormat::AudioUnit => None,
        };
        return Ok(PluginEditorCapability {
            supported: false,
            reason,
        });
    }

    Ok(PluginEditorCapability {
        // Enterprise hardening: never instantiate an unloaded third-party plugin
        // just to probe editor capability. Some plugins crash during activation,
        // which can take down the whole DAW process.
        //
        // We only do exact capability checks on already-loaded instances above.
        // For unloaded VST3 descriptors, report optimistic support and defer the
        // real result to open_plugin_window (where failures are surfaced safely).
        supported: true,
        reason: None,
    })
}

#[tauri::command]
fn can_open_plugin_editor_for_slot(
    track_id: String,
    slot_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<PluginEditorCapability, String> {
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

    let instance_id =
        match plugin_host_state.ensure_loaded_instance_for_slot(slot.slot_id, &slot.plugin_id) {
            Ok(id) => id,
            Err(err) => {
                return Ok(PluginEditorCapability {
                    supported: false,
                    reason: Some(format!("Plugin runtime load failed: {err}")),
                });
            }
        };

    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let supported = host.supports_editor(instance_id).unwrap_or(false);
    Ok(PluginEditorCapability {
        supported,
        reason: if supported {
            None
        } else {
            Some(
                "Native plugin editor host bridge is unavailable for this runtime instance; inline controls are available."
                    .to_string(),
            )
        },
    })
}
