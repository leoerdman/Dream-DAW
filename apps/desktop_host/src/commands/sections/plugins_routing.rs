// ═══════════════════════════════════════════════════════════════════════
// Pure slot-lookup and diagnostic functions extracted to:
// core/dream_importers/src/routing_helpers.rs
// ═══════════════════════════════════════════════════════════════════════
use dream_importers::routing_helpers::{
    find_project_plugin_slot,
    find_project_plugin_slot_by_slot_id,
    find_slot_in_node_by_id,
    find_slot_on_track_mut,
    find_slot_on_track,
    diagnose_external_plugin_reference,
    normalize_plugin_key_local,
    lane_param_name_hints,
    find_device_node_on_track,
};
mod plugins_routing_helpers;
use plugins_routing_helpers::{
    apply_imported_external_state_blob,
    bind_runtime_instance_for_plugin_slots,
};

#[tauri::command]
fn open_plugin_window(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    plugin_host_state.try_enable_sandbox_if_available();
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
        if let Ok(project) = project_state.project.lock() {
            bind_runtime_instance_for_plugin_slots(&project, &plugin_id, instance_id, &plugin_host_state);
        }
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
        // MEGA-07 FIX: Do not hold the `host` lock while attempting to acquire the `project` lock.
        // Doing so causes a deadly embrace deadlock with commands that hold `project` while
        // acquiring `host` (like `replace_missing_plugin_slot_cmd`), entirely freezing the DAW.
        // Fetch the plugin slot clone first under a brief isolated project lock.
        let slot_clone = {
            if let Ok(project) = project_state.project.lock() {
                find_project_plugin_slot(&project, &plugin_id)
            } else {
                None
            }
        };

        let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
        let loaded = host
            .load_vst3(descriptor.clone())
            .map_err(|e| format!("Failed to load plugin '{}': {e}", descriptor.name))?;
        
        if let Some(slot) = slot_clone {
            if let Err(err) = apply_imported_external_state_blob(&mut host, loaded, &slot) {
                log::warn!(
                    "[PluginState] Could not restore imported state for '{}': {}",
                    slot.name,
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
        if let Ok(project) = project_state.project.lock() {
            bind_runtime_instance_for_plugin_slots(&project, &plugin_id, loaded, &plugin_host_state);
        }

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

    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();
    let slot = find_slot_on_track(&project, track_uuid, slot_uuid)
        .ok_or_else(|| format!("Plugin slot not found on track {}: {}", track_id, slot_id))?;

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

    let instance_id = plugin_host_state.ensure_loaded_instance_for_slot(slot.id, &slot.plugin_id)?;
    plugin_host_state.bind_slot_instance(slot.id, instance_id);

    // Restore per-slot saved state (preset, knob positions, etc.)
    if slot.external_state_blob.is_some() || slot.external_preset_blob.is_some() {
        if let Ok(mut host) = plugin_host_state.host.lock() {
            if let Err(err) = apply_imported_external_state_blob(&mut host, instance_id, &slot) {
                log::warn!(
                    "[IPC] open_plugin_window_for_slot: state restore failed for '{}': {}",
                    slot.name, err
                );
            } else {
                log::info!(
                    "[IPC] open_plugin_window_for_slot: restored state for '{}' (slot {})",
                    slot.name, slot.id
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
                            plugin_host_state.bind_slot_instance(slot.id, sandbox_instance_id);
                            clip_pool_state.rebuild_external_fx_snapshot(
                                &project,
                                plugin_host_state.slot_instance_snapshot().as_ref(),
                            );
                            plugin_host_state.publish_registry();
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
        plugin_host_state.unbind_slot_instance(slot.id);

        // Load the plugin in-process — this runs init_vst3_com which
        // acquires the real COM pointers (IComponent, IAudioProcessor,
        // IEditController) needed for the native editor.
        let descriptor = plugin_host_state.resolve_descriptor(&slot.plugin_id)?;
        let recovered_instance = {
            let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
            host.load_vst3(descriptor)
                .map_err(|e| format!("In-process reload failed for '{}': {e}", slot.plugin_id))?
        };
        plugin_host_state.bind_slot_instance(slot.id, recovered_instance);
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

    clip_pool_state.rebuild_external_fx_snapshot(&project, plugin_host_state.slot_instance_snapshot().as_ref());
    plugin_host_state.publish_registry();

    // Mark project dirty — plugin editor opening implies parameters may be
    // changed via the native GUI (which doesn't notify our project model).
    if let Ok(project) = project_state.project.lock() {
        let _ = project_state.mark_dirty(&project.name, Some(&app));
    }

    log::info!(
        "[IPC] open_plugin_window_for_slot(track={}, slot={}) -> instance {}",
        track_id,
        slot_id,
        instance_id
    );
    Ok(())
}

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
                Some("Native plugin editor host bridge is not implemented yet for this instance.".to_string())
            },
        });
    }

    let descriptor = plugin_host_state.resolve_descriptor(&plugin_id)?;
    if descriptor.format != PluginFormat::VST3 && descriptor.format != PluginFormat::VST2 {
        let reason = match descriptor.format {
            PluginFormat::VST2 | PluginFormat::VST3 => None,
            PluginFormat::CLAP => Some("CLAP plugin editor is not supported by this host build.".to_string()),
            PluginFormat::AudioUnit => Some("AudioUnit editor is not supported by this host build.".to_string()),
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
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let slot = find_slot_on_track(&project, track_uuid, slot_uuid)
        .ok_or_else(|| format!("Plugin slot not found on track {}: {}", track_id, slot_id))?;

    if slot.plugin_id.starts_with("internal://") {
        return Ok(PluginEditorCapability {
            supported: false,
            reason: Some("Internal device does not expose a native external editor.".to_string()),
        });
    }

    let instance_id = match plugin_host_state.ensure_loaded_instance_for_slot(slot.id, &slot.plugin_id) {
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
            Some("Native plugin editor host bridge is unavailable for this runtime instance; inline controls are available.".to_string())
        },
    })
}

#[tauri::command]
fn get_plugin_slot_runtime_status_cmd(
    track_id: String,
    slot_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<PluginSlotRuntimeStatus, String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let slot = find_slot_on_track(&project, track_uuid, slot_uuid)
        .ok_or_else(|| format!("Plugin slot not found on track {}: {}", track_id, slot_id))?;

    if slot.plugin_id.starts_with("internal://") {
        return Ok(PluginSlotRuntimeStatus {
            loaded: true,
            editor_supported: false,
            runtime: "internal".to_string(),
            sidechain_ready: slot.supports_sidechain_input.unwrap_or(false) || slot.plugin_id.contains("compressor") || slot.plugin_id.contains("gate") || slot.plugin_id.contains("shaper"),
            latency_frames: Some(0),
            message: None,
        });
    }

    let descriptor = match plugin_host_state.resolve_descriptor(&slot.plugin_id) {
        Ok(d) => d,
        Err(err) => {
            return Ok(PluginSlotRuntimeStatus {
                loaded: false,
                editor_supported: false,
                runtime: "unloaded".to_string(),
                sidechain_ready: false,
                latency_frames: None,
                message: Some(
                    diagnose_external_plugin_reference(&slot.plugin_id)
                        .map(|diag| format!("{err}. {diag}"))
                        .unwrap_or(err),
                ),
            });
        }
    };
    if descriptor.format != PluginFormat::VST3 && descriptor.format != PluginFormat::VST2 {
        return Ok(PluginSlotRuntimeStatus {
            loaded: false,
            editor_supported: false,
            runtime: "unsupported".to_string(),
            sidechain_ready: false,
            latency_frames: None,
            message: Some(format!(
                "{} is detected but runtime currently supports VST2/VST3 only.",
                descriptor.format
            )),
        });
    }

    let slot_map = plugin_host_state.slot_instance_snapshot();
    let runtime_instance = slot_map.get(&slot.id).copied();
    let sandbox_loaded = plugin_host_state
        .loaded_sandbox_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&slot.plugin_id);

    if let Some(instance_id) = runtime_instance {
        let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
        let loaded = host.get_mut(instance_id).is_some();
        let editor_supported = if loaded {
            host.supports_editor(instance_id).unwrap_or(false)
        } else {
            false
        };
        let latency_frames = if loaded {
            host.latency_samples(instance_id).ok()
        } else {
            None
        };
        return Ok(PluginSlotRuntimeStatus {
            loaded,
            editor_supported,
            runtime: "in-process".to_string(),
            // For external (VST3/VST2) plugins, allow sidechain routing by default
            // since the scanner cannot determine bus layout without instantiation.
            // The runtime handles sidechain bus activation dynamically.
            sidechain_ready: slot.supports_sidechain_input.unwrap_or(!slot.plugin_id.starts_with("internal://")),
            latency_frames,
            message: if loaded {
                None
            } else {
                Some("Plugin instance missing in host runtime".to_string())
            },
        });
    }

    Ok(PluginSlotRuntimeStatus {
        loaded: sandbox_loaded,
        editor_supported: false,
        runtime: if sandbox_loaded {
            "sandbox".to_string()
        } else {
            "unloaded".to_string()
        },
        sidechain_ready: slot.supports_sidechain_input.unwrap_or(!slot.plugin_id.starts_with("internal://")),
        latency_frames: None,
        message: if sandbox_loaded {
            Some("Sandbox runtime active. Native plugin editor window is not available in this host path yet; use inline controls.".to_string())
        } else {
            Some("Plugin not activated yet".to_string())
        },
    })
}

#[tauri::command]
fn ensure_plugin_slot_active_cmd(
    track_id: String,
    slot_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();
    let slot = find_slot_on_track(&project, track_uuid, slot_uuid)
        .ok_or_else(|| format!("Plugin slot not found on track {}: {}", track_id, slot_id))?;
    if slot.plugin_id.starts_with("internal://") {
        return Ok(());
    }

    let descriptor = plugin_host_state
        .resolve_descriptor(&slot.plugin_id)
        .map_err(|err| {
            diagnose_external_plugin_reference(&slot.plugin_id)
                .map(|diag| format!("{err}. {diag}"))
                .unwrap_or(err)
        })?;
    if descriptor.format != PluginFormat::VST3 && descriptor.format != PluginFormat::VST2 {
        return Err(format!(
            "Unsupported plugin runtime format: {}. Dream DAW runtime currently supports VST2/VST3 only.",
            descriptor.format
        ));
    }

    let instance_id = plugin_host_state.ensure_loaded_instance_for_slot(slot.id, &slot.plugin_id)?;
    plugin_host_state.bind_slot_instance(slot.id, instance_id);

    // Restore per-slot saved state (preset, knob positions, EQ, etc.)
    // Without this, plugins activated for audio processing after project
    // reload would lose their saved settings (e.g., ShaperBox3 EQ points).
    if slot.external_state_blob.is_some() || slot.external_preset_blob.is_some() {
        if let Ok(mut host) = plugin_host_state.host.lock() {
            if let Err(err) = apply_imported_external_state_blob(&mut host, instance_id, &slot) {
                log::warn!(
                    "[IPC] ensure_plugin_slot_active_cmd: state restore failed for '{}': {}",
                    slot.name, err
                );
            } else {
                log::info!(
                    "[IPC] ensure_plugin_slot_active_cmd: restored state for '{}' (slot {})",
                    slot.name, slot.id
                );
            }
        }
    }

    clip_pool_state.rebuild_external_fx_snapshot(&project, plugin_host_state.slot_instance_snapshot().as_ref());
    plugin_host_state.publish_registry();
    log::info!(
        "[IPC] ensure_plugin_slot_active_cmd(track={}, slot={}) -> instance {}",
        track_id,
        slot_id,
        instance_id
    );
    Ok(())
}

/// Unload an external plugin slot instance from runtime (slot-scoped).
#[tauri::command]
fn unload_plugin_slot_cmd(
    track_id: String,
    slot_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();
    let slot = find_slot_on_track(&project, track_uuid, slot_uuid)
        .ok_or_else(|| format!("Plugin slot not found on track {}: {}", track_id, slot_id))?;

    if slot.plugin_id.starts_with("internal://") {
        return Ok(());
    }

    plugin_host_state.unload_slot_instance(slot.id)?;
    clip_pool_state.rebuild_external_fx_snapshot(&project, plugin_host_state.slot_instance_snapshot().as_ref());
    plugin_host_state.publish_registry();
    log::info!(
        "[IPC] unload_plugin_slot_cmd(track={}, slot={})",
        track_id,
        slot_id
    );
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplaceMissingPluginPayload {
    track_id: String,
    slot_id: String,
    replacement_plugin_id: String,
    replacement_plugin_name: Option<String>,
}

/// Replace a missing external plugin placeholder with a real plugin on the same slot.
#[tauri::command]
fn replace_missing_plugin_slot_cmd(
    payload: ReplaceMissingPluginPayload,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let slot_uuid = Uuid::parse_str(&payload.slot_id)
        .map_err(|_| format!("Invalid slot_id: {}", payload.slot_id))?;

    let replacement_plugin_id = payload.replacement_plugin_id.trim().to_string();
    if replacement_plugin_id.is_empty() {
        return Err("Replacement plugin path cannot be empty".to_string());
    }
    if replacement_plugin_id.starts_with("internal://") {
        return Err("Missing external plugin replacement expects an external plugin bundle path".to_string());
    }

    let descriptor = plugin_host_state.resolve_descriptor(&replacement_plugin_id)?;
    if descriptor.format != PluginFormat::VST3 && descriptor.format != PluginFormat::VST2 {
        return Err(format!(
            "Replacement plugin format '{}' is not supported in runtime. Use VST2 or VST3.",
            descriptor.format
        ));
    }

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let slot = find_slot_on_track_mut(&mut project, track_uuid, slot_uuid).ok_or_else(|| {
        format!(
            "Plugin slot not found on track {}: {}",
            payload.track_id, payload.slot_id
        )
    })?;

    if !slot.plugin_id.starts_with("missing://") {
        return Err("Slot is not a missing plugin placeholder".to_string());
    }

    slot.plugin_id = replacement_plugin_id.clone();
    slot.name = payload
        .replacement_plugin_name
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .unwrap_or_else(|| descriptor.name.clone());
    slot.external_audio_inputs = Some(descriptor.audio_inputs);
    // VST3 scanner does NOT populate audio_inputs (it's always 0).
    // Sidechain bus presence is only known after IComponent::get_bus_count()
    // at activation time. Leave as None for VST3 to indicate "unknown".
    if descriptor.format != PluginFormat::VST3 {
        slot.supports_sidechain_input = Some(descriptor.audio_inputs > 2);
    }
    slot.external_format = Some(descriptor.format.to_string().to_lowercase());
    slot.external_uid = descriptor.unique_id.clone();
    slot.external_plugin_version = descriptor.version.clone();
    slot.is_bypassed = false;

    let _ = plugin_host_state.unload_slot_instance(slot_uuid);
    if let Err(err) = plugin_host_state.ensure_loaded_instance_for_slot(slot_uuid, &replacement_plugin_id) {
        log::warn!(
            "[IPC] replace_missing_plugin_slot_cmd runtime init failed (slot={}, plugin={}): {}",
            slot_uuid,
            replacement_plugin_id,
            err
        );
    }

    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

/// Close plugin native GUI window.
///
/// BUG-8 FIX: Only closes the editor window — does NOT destroy the plugin
/// instance. Instance lifetime is managed by `unload_plugin_slot_cmd` or
/// project close. Destroying the instance here would cause data loss and
/// silent audio dropouts when multiple slots share the same plugin_id.
#[tauri::command]
fn close_plugin_window(
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
                    if let Ok(mut project) = project_state.project.lock() {
                        if let Some(slot_ref) = find_slot_on_track_mut(&mut project, track_uuid, slot_uuid) {
                            slot_ref.external_state_blob = Some(live_b64);
                            slot_ref.external_state_blob_kind = Some("ProcessorState".to_string());
                        }
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

    {
        let mut project_mut = project_state.project.lock().map_err(|e| e.to_string())?;
        if let Some(track_mut) = project_mut.tracks.iter_mut().find(|t| t.id == track_uuid) {
            let lane_param_id = format!("ext:{}:{}", resolved_slot_id, param_index);
            let legacy_param_id = format!("slot:{}:ext_param_{}", resolved_slot_id, param_index);
            let point = dream_models::project::AutomationPoint {
                beat: 0.0,
                value: normalized,
                curve_type: "linear".to_string(),
                tension: None,
                bezier_cp1x: None,
                bezier_cp1y: None,
                bezier_cp2x: None,
                bezier_cp2y: None,
            };
            track_mut
                .automation_lanes
                .retain(|lane| !lane.param_id.eq_ignore_ascii_case(&legacy_param_id));

            if let Some(existing_lane) = track_mut
                .automation_lanes
                .iter_mut()
                .find(|lane| lane.param_id.eq_ignore_ascii_case(&lane_param_id))
            {
                existing_lane.param_id = lane_param_id;
                existing_lane.points = vec![point];
            } else {
                track_mut.automation_lanes.push(dream_models::project::AutomationLane {
                    param_id: lane_param_id,
                    points: vec![point],
                });
            }
        }
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

/// Snapshot plugin sandbox runtime (supervisor + instance statuses).
#[tauri::command]
fn get_plugin_sandbox_runtime(
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<PluginSandboxSnapshot, String> {
    plugin_host_state.sandbox_snapshot()
}

/// Enable/disable out-of-process plugin sandbox mode.
///
/// When disabled, plugin windows are loaded in-process (legacy path).
#[tauri::command]
fn set_plugin_sandbox_enabled(
    enabled: bool,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<PluginSandboxSnapshot, String> {
    plugin_host_state.set_sandbox_enabled(enabled)
}

/// Run one watchdog tick for sandboxed plugin host processes.
#[tauri::command]
fn tick_plugin_sandbox_watchdog(
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<PluginSandboxSnapshot, String> {
    plugin_host_state.tick_sandbox_watchdog()
}

/// Manually restart a sandboxed plugin host process and clear forced bypass.
#[tauri::command]
fn reload_plugin_sandbox_instance(
    instance_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<PluginSandboxSnapshot, String> {
    let instance_uuid =
        Uuid::parse_str(&instance_id).map_err(|_| format!("Invalid instance_id: {instance_id}"))?;
    let slot_ids = plugin_host_state.manual_restart_sandbox_instance(instance_uuid)?;

    if !slot_ids.is_empty() {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        let changed = set_plugin_slots_bypass_in_project(&mut project, &slot_ids, false);
        if changed > 0 {
            clip_pool_state.rebuild_routing_only(&project);
            let slot_instance_map = plugin_host_state.slot_instance_snapshot();
            clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
            let _ = project_state.mark_dirty(&project.name, Some(&app));
        }
        let _ = app.emit(
            "plugin_sandbox_reloaded",
            serde_json::json!({
                "instanceId": instance_id,
                "slotIds": slot_ids.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                "changedSlots": changed,
            }),
        );
    }

    plugin_host_state.sandbox_snapshot()
}

/// Unified frontend error logger (ErrorBoundary -> backend log).
#[tauri::command]
fn log_frontend_error(module: String, error: String, stack: Option<String>) -> Result<(), String> {
    if let Some(stack_trace) = stack {
        log::error!("[FrontendError] module={} error={} stack={}", module, error, stack_trace);
    } else {
        log::error!("[FrontendError] module={} error={}", module, error);
    }
    Ok(())
}

/// Return valid routing targets for a track.
#[tauri::command]
fn get_routing_targets(
    track_id: String,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<Vec<RoutingTarget>, String> {
    let source_id = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?;

    let mut targets = Vec::new();
    for t in &project.tracks {
        if t.id == source_id {
            continue;
        }
        targets.push(RoutingTarget {
            track_id: t.id.to_string(),
            track_name: t.name.clone(),
            track_type: format!("{:?}", t.track_type),
        });
    }
    Ok(targets)
}

/// Set output routing destination for a track.
///
/// `target_id` can be another track UUID or "master" to route directly
/// to the master bus. The project model is updated atomically.
#[tauri::command]
fn set_track_routing_cmd(
    track_id: String,
    target_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let source_id = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let destination = if target_id == "master" {
        None
    } else {
        Some(Uuid::parse_str(&target_id).map_err(|_| format!("Invalid target_id: {target_id}"))?)
    };

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    if let Some(dest_id) = destination {
        let dest_exists = project.tracks.iter().any(|t| t.id == dest_id);
        if !dest_exists {
            return Err(format!("Routing target not found: {target_id}"));
        }
    }

    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == source_id)
        .ok_or_else(|| format!("Track not found: {track_id}"))?;
    track.output_destination_id = destination;

    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!("[IPC] set_track_routing_cmd({track_id} -> {target_id})");
    Ok(())
}

/// Set track audio input source (placeholder hook for sidechain/input matrix).
#[tauri::command]
fn set_track_input_cmd(
    track_id: String,
    input_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let source_id = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == source_id)
        .ok_or_else(|| format!("Track not found: {track_id}"))?;

    let normalized = input_id.trim();
    track.input_source_id = if normalized.is_empty()
        || normalized.eq_ignore_ascii_case("none")
        || normalized.eq_ignore_ascii_case("no input")
        || normalized.eq_ignore_ascii_case("no_input")
    {
        None
    } else {
        Some(normalized.to_string())
    };

    let effective_input = track.input_source_id.clone();
    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] set_track_input_cmd({track_id} <- {})",
        effective_input.as_deref().unwrap_or("none")
    );
    Ok(())
}

/// Set sidechain source track for a specific plugin slot on a track.
#[tauri::command]
fn set_plugin_sidechain_source_cmd(
    track_id: String,
    slot_id: String,
    source_track_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    let source_normalized = source_track_id.trim();
    let source_value = if source_normalized.is_empty() || source_normalized.eq_ignore_ascii_case("none") {
        None
    } else {
        Some(source_normalized.to_string())
    };

    if let Some(source_id) = &source_value {
        let source_exists = project
            .tracks
            .iter()
            .any(|t| t.id.to_string() == *source_id);
        if !source_exists {
            return Err(format!("Source track not found: {source_id}"));
        }
        if source_id == &track_id {
            return Err("Sidechain source cannot be the same track".to_string());
        }
    }

    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {track_id}"))?;

    let mut updated = false;
    if let Some(inst) = track.instrument.as_mut()
        && let Some(slot) = inst.as_single_mut()
        && slot.id == slot_uuid
    {
        if slot.supports_sidechain_input == Some(false) && slot.plugin_id.starts_with("internal://") {
            return Err("Plugin does not expose sidechain input".to_string());
        }
        slot.sidechain_source_track_id = source_value.clone();
        updated = true;
    }
    if !updated {
        // Recursively search for the slot in effects (including inside Rack chains).
        fn find_and_set_sidechain(
            nodes: &mut [DeviceNode],
            slot_uuid: Uuid,
            source_value: &Option<String>,
        ) -> Result<bool, String> {
            for node in nodes.iter_mut() {
                match node {
                    DeviceNode::Single(slot) if slot.id == slot_uuid => {
                        if slot.supports_sidechain_input == Some(false) && slot.plugin_id.starts_with("internal://") {
                            return Err("Plugin does not expose sidechain input".to_string());
                        }
                        slot.sidechain_source_track_id = source_value.clone();
                        return Ok(true);
                    }
                    DeviceNode::Rack(rack) => {
                        for chain in &mut rack.chains {
                            if find_and_set_sidechain(&mut chain.devices, slot_uuid, source_value)? {
                                return Ok(true);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(false)
        }
        match find_and_set_sidechain(&mut track.effects, slot_uuid, &source_value) {
            Ok(true) => updated = true,
            Err(e) => return Err(e),
            _ => {}
        }
    }

    if !updated {
        // Diagnostic: dump all slot IDs on this track for debugging.
        let mut all_ids: Vec<String> = Vec::new();
        if let Some(inst) = track.instrument.as_ref() {
            all_ids.push(format!("instrument:{}", inst.id()));
        }
        fn collect_effect_ids(nodes: &[DeviceNode], out: &mut Vec<String>) {
            for node in nodes {
                match node {
                    DeviceNode::Single(s) => out.push(format!("effect:{}", s.id)),
                    DeviceNode::Rack(r) => {
                        out.push(format!("rack:{}", r.id));
                        for chain in &r.chains {
                            collect_effect_ids(&chain.devices, out);
                        }
                    }
                }
            }
        }
        collect_effect_ids(&track.effects, &mut all_ids);
        log::warn!(
            "[IPC] set_plugin_sidechain_source_cmd: slot {} NOT FOUND on track {}. Available slots: {:?}",
            slot_id, track_id, all_ids
        );
        return Err(format!("Plugin slot not found on track {}: {}", track_id, slot_id));
    }

    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] set_plugin_sidechain_source_cmd(track={} slot={} source={})",
        track_id,
        slot_id,
        source_value.as_deref().unwrap_or("none")
    );
    Ok(())
}

/// Add a plugin slot to a track (instrument/effect) from frontend DnD.
#[tauri::command]
fn add_plugin_to_track_cmd(
    payload: AddPluginToTrackPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    fn canonical_internal_plugin(plugin_id: &str, plugin_name: &str) -> Option<(&'static str, &'static str, &'static str)> {
        let merged = format!("{} {}", plugin_id, plugin_name).to_lowercase();
        let compact = merged.replace(|c: char| !c.is_ascii_alphanumeric(), "");

        // Instruments
        if merged.contains("operator")
            || merged.contains("analog")
            || merged.contains("wavetable")
            || compact.contains("simplesinesynth")
            || merged.contains("wave synth")
            || compact.contains("wavesynth")
            || compact.contains("drift")
            || compact.contains("instrumentvector")
            || compact.contains("stringstudio")
            || compact.contains("instrumentmeld")
            || compact.contains("mxdeviceinstrument")
            || compact.contains("loungelizard")
        {
            return Some(("internal://instrument/wave-synth", "Essence", "instrument"));
        }
        if merged.contains("sampler") || merged.contains("simpler") || compact.contains("multisampler") || compact.contains("drumcell") {
            return Some(("internal://instrument/sampler", "Sampler", "instrument"));
        }

        // Effects
        if merged.contains("eq eight") || merged.contains("eq8") {
            return Some(("internal://effect/eq-eight", "EQ", "effect"));
        }
        if merged.contains("eq three") || merged.contains("band eq") || merged.contains("eq3") {
            return Some(("internal://effect/eq-three", "Band EQ", "effect"));
        }
        if merged.contains("channel eq") {
            return Some(("internal://effect/channel-eq", "Channel EQ", "effect"));
        }
        if merged.contains("multiband dynamics") {
            return Some(("internal://effect/multiband-dynamics", "Multiband Dynamics", "effect"));
        }
        if merged.contains("glue compressor") {
            return Some(("internal://effect/compressor", "Compressor", "effect"));
        }
        if merged.contains("simple delay") || merged.contains("ping pong delay") || merged.contains("echo") {
            return Some(("internal://effect/delay", "Delay", "effect"));
        }
        if merged.contains("beat repeat") || merged.contains("filter delay") || merged.contains("grain delay") || merged.contains("looper") {
            return Some(("internal://effect/delay", "Delay", "effect"));
        }
        if merged.contains("hybrid reverb") {
            return Some(("internal://effect/reverb", "Reverb", "effect"));
        }
        if merged.contains("corpus") || merged.contains("resonators") || merged.contains("spectral resonator") {
            return Some(("internal://effect/reverb", "Reverb", "effect"));
        }
        if merged.contains("chorus-ensemble") || merged.contains("chorus ensemble") {
            return Some(("internal://effect/chorus", "Chorus", "effect"));
        }
        if merged.contains("drum buss") || merged.contains("dynamic tube") {
            return Some(("internal://effect/saturator", "Saturator", "effect"));
        }
        if merged.contains("transient shaper") {
            return Some(("internal://effect/compressor", "Compressor", "effect"));
        }
        if merged.contains("vocoder") {
            return Some(("internal://effect/vocoder", "Vocoder", "effect"));
        }
        if merged.contains("spectral time") {
            return Some(("internal://effect/delay", "Delay", "effect"));
        }
        if merged.contains("roar") {
            return Some(("internal://effect/distortion", "Distortion", "effect"));
        }
        if merged.contains("auto filter") || merged.contains("autofilter") {
            return Some(("internal://effect/auto-filter", "Auto Filter", "effect"));
        }
        if merged.contains("auto pan") || merged.contains("autopan") {
            return Some(("internal://effect/auto-pan", "Auto Pan", "effect"));
        }
        if merged.contains("midipitcher") || merged.contains("midi pitch") {
            return Some(("internal://midi-fx/pitch", "MIDI Pitch", "effect"));
        }
        if merged.contains("mxdevicescale") || merged.contains("midi scale") {
            return Some(("internal://midi-fx/scale", "MIDI Scale", "effect"));
        }
        if merged.contains("mxdevicevelocity") || merged.contains("midi velocity") {
            return Some(("internal://midi-fx/velocity", "MIDI Velocity", "effect"));
        }
        if compact.contains("midivelocity") {
            return Some(("internal://midi-fx/velocity", "MIDI Velocity", "effect"));
        }
        if compact.contains("midichord") {
            return Some(("internal://midi-fx/chord", "Chord", "effect"));
        }
        if merged.contains("mxdevicerandom") || merged.contains("midi random") {
            return Some(("internal://midi-fx/random", "MIDI Random", "effect"));
        }
        if merged.contains("arpeggiator") {
            return Some(("internal://midi-fx/arpeggiator", "Arpeggiator", "effect"));
        }
        if merged.contains("cc control") || merged.contains("expression control") {
            return Some(("internal://midi-fx/velocity", "MIDI Velocity", "effect"));
        }
        if compact.contains("midiarpeggiator") {
            return Some(("internal://midi-fx/arpeggiator", "Arpeggiator", "effect"));
        }
        if merged.contains("midi note length") || compact.contains("midinotelength") {
            return Some(("internal://midi-fx/note-length", "Note Length", "effect"));
        }
        if merged.contains("spectrum") || compact.contains("spectrumanalyzer") {
            return Some(("internal://effect/analyzer", "Analyzer", "effect"));
        }
        if merged.contains("analyzer") || compact.contains("analyzer") {
            return Some(("internal://effect/analyzer", "Analyzer", "effect"));
        }
        if merged.contains("tuner") {
            return Some(("internal://effect/tuner", "Tuner", "effect"));
        }
        if compact.contains("mxdeviceaudioeffect") {
            return Some(("internal://effect/external-audio-effect", "External Audio Effect", "effect"));
        }
        if compact.contains("mxdevicemidieffect") {
            return Some(("internal://effect/utility", "Utility", "effect"));
        }
        if compact.contains("autoshift") {
            return Some(("internal://effect/auto-shift", "Auto Shift", "effect"));
        }
        if compact.contains("shifter") || compact.contains("frequencyshifter") {
            return Some(("internal://effect/shifter", "Shifter", "effect"));
        }
        if merged.contains("phaser-flanger") || merged.contains("phaser flanger") {
            return Some(("internal://effect/phaser", "Phaser", "effect"));
        }
        if merged.contains("redux") {
            return Some(("internal://effect/bitcrusher", "Bitcrusher", "effect"));
        }
        {
            let pid = plugin_id.to_lowercase();
            let pname = plugin_name.to_lowercase();
            if merged.contains("overdrive")
                || pid == "pedal" || pname == "pedal"
                || pid == "cabinet" || pname == "cabinet"
                || pid == "amp" || pname == "amp"
            {
                return Some(("internal://effect/distortion", "Distortion", "effect"));
            }
        }

        None
    }

    fn waveform_code_from_token(token: &str) -> u8 {
        let normalized = token.trim().to_lowercase();
        if normalized.contains("triangle") || normalized.ends_with("/tri") {
            return 1;
        }
        if normalized.contains("saw") {
            return 2;
        }
        if normalized.contains("square") || normalized.ends_with("/pulse") {
            return 3;
        }
        0
    }

    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

    let slot = payload.slot.to_lowercase();
    // BUG-5 FIX: Only apply internal-plugin fuzzy mapping when the plugin_id
    // looks like an ALS migration tag or an internal convention. External
    // plugins (VST3, AU, VST2) have IDs containing path separators or known
    // prefixes. Applying the fuzzy matcher to external VST3 names like
    // "Operator" or "Sampler Pro" would silently replace them with built-in
    // instruments, corrupting the project on save/reload.
    let is_external_plugin = !payload.plugin_id.starts_with("internal://")
        && (payload.plugin_id.contains('/')
            || payload.plugin_id.contains('\\')
            || payload.plugin_id.ends_with(".vst3")
            || payload.plugin_id.ends_with(".vst")
            || payload.plugin_id.ends_with(".component")
            || payload.plugin_id.starts_with("com.")
            || payload.plugin_id.starts_with("vst3:")
            || payload.plugin_id.starts_with("au:")
            || payload.plugin_id.starts_with("vst2:"));
    let canonical = if is_external_plugin {
        None
    } else {
        canonical_internal_plugin(&payload.plugin_id, &payload.plugin_name)
    };
    let effective_plugin_id = canonical.map(|v| v.0.to_string()).unwrap_or_else(|| payload.plugin_id.clone());
    let effective_plugin_name = canonical
        .map(|v| {
            if payload.plugin_name.trim().is_empty() {
                v.1.to_string()
            } else {
                payload.plugin_name.clone()
            }
        })
        .unwrap_or_else(|| payload.plugin_name.clone());
    let canonical_slot_hint = canonical.map(|v| v.2);
    // Only MIDI tracks can host instrument slots. Audio/Group/Master tracks
    // always route plugin additions to the effects chain to avoid corrupting
    // the audio bus (groups receive summed child audio, not MIDI).
    let use_instrument = if track.track_type != TrackType::Midi {
        false
    } else {
        match slot.as_str() {
            "instrument" => true,
            "effect" => false,
            "auto" => canonical_slot_hint == Some("instrument")
                || track.instrument.is_none(),
            _ => track.instrument.is_none(),
        }
    };

    let plugin_id_lower = effective_plugin_id.to_lowercase();
    let is_sampler_instrument = plugin_id_lower.starts_with("internal://instrument/sampler");
    let is_wave_synth_instrument = plugin_id_lower.starts_with("internal://instrument/wave-synth")
        || plugin_id_lower.starts_with("internal://instrument/simple-sine-synth");
    let mut slot_data = PluginSlot::new(effective_plugin_name.clone(), effective_plugin_id.clone());
    let new_slot_id = slot_data.id;
    if !effective_plugin_id.starts_with("internal://")
        && let Ok(desc) = plugin_host_state.resolve_descriptor(&effective_plugin_id)
    {
        slot_data.external_audio_inputs = Some(desc.audio_inputs);
        // VST3 scanner cannot determine bus layout without loading the plugin.
        // Leave supports_sidechain_input as None (unknown) for VST3.
        // Sidechain bus detection happens at runtime via IComponent::get_bus_count().
        if desc.format != PluginFormat::VST3 {
            slot_data.supports_sidechain_input = Some(desc.audio_inputs > 2);
        }
    }
    let plugin_slot = DeviceNode::Single(slot_data);
    let mut runtime_add: Option<(Uuid, u8, u8)> = None;
    let mut runtime_waveform: Option<(Uuid, u8)> = None;
    if use_instrument {
        track.instrument = Some(plugin_slot);
        if (is_sampler_instrument || is_wave_synth_instrument) && track.sampler.is_none() {
            track.sampler = Some(SamplerConfig::default());
        }
        if is_wave_synth_instrument {
            let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
            if cfg.sample_path.trim().is_empty() {
                cfg.sample_path = "internal://waveform/sine".to_string();
            }
            runtime_waveform = Some((track.id, waveform_code_from_token(&cfg.sample_path)));
        }
    } else {
        track.effects.push(plugin_slot);
        if effective_plugin_id.starts_with("internal://")
            && let Some(effect_type) = builtin_effect_type_from_plugin_id(&effective_plugin_id)
        {
            // Count only preceding INTERNAL effects — device_chain on the engine
            // side only holds internal processors, so the slot_index must match
            // the internal-only ordering, not the full effects list position.
            let internal_slot_index = track.effects.iter()
                .filter_map(|node| node.as_single())
                .filter(|slot| slot.plugin_id.starts_with("internal://effect/"))
                .count()
                .saturating_sub(1) // -1 because we just pushed the new one
                .min(u8::MAX as usize) as u8;
            runtime_add = Some((track.id, internal_slot_index, effect_type));
        }
    }

    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    // CRITICAL: Plugin loading failure must NOT abort this function.
    // The project model has already been mutated above (track.effects.push / track.instrument = ...),
    // so we MUST continue to rebuild_external_fx_snapshot and mark_dirty to keep
    // the audio engine consistent. Otherwise the clip snapshot sees the plugin but the
    // FX snapshot doesn't, causing total sound loss on the track.
    let mut plugin_load_error: Option<String> = None;
    if !effective_plugin_id.starts_with("internal://") {
        if let Err(err) = plugin_host_state.ensure_loaded_instance_for_slot(new_slot_id, &effective_plugin_id) {
            log::warn!(
                "[IPC] add_plugin_to_track_cmd: plugin '{}' failed to load (slot={}): {}. \
                 The plugin slot will exist but be inactive until reloaded.",
                effective_plugin_id,
                new_slot_id,
                err
            );
            plugin_load_error = Some(format!("Plugin '{}' failed to load: {}", effective_plugin_name, err));
        }
    }
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();
    if let Some((track_id, slot_index, effect_type)) = runtime_add {
        // Map project UUID track ordering to runtime track index.
        if let Some(runtime_track_index) = project.tracks.iter().position(|t| t.id == track_id) {
            push_command(&handle, EngineCommand::AddDevice {
                track_index: runtime_track_index as u16,
                slot_index,
                effect_type,
            })?;
        }
    }
    if let Some((track_id, waveform)) = runtime_waveform {
        if let Some(runtime_track_index) = project.tracks.iter().position(|t| t.id == track_id) {
            push_command(&handle, EngineCommand::SetSamplerWaveform {
                track_index: runtime_track_index as u16,
                waveform,
            })?;
        }
    }
    log::info!(
        "[IPC] add_plugin_to_track_cmd(track={}, plugin='{}', slot={})",
        payload.track_id,
        effective_plugin_name,
        if use_instrument { "instrument" } else { "effect" }
    );
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    // Return any plugin loading error AFTER all state has been fully reconciled.
    if let Some(err_msg) = plugin_load_error {
        return Err(err_msg);
    }
    Ok(())
}

/// Remove a plugin slot from a track (instrument/effect) by slot UUID.
#[tauri::command]
fn remove_plugin_from_track_cmd(
    payload: RemovePluginFromTrackPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let slot_uuid = Uuid::parse_str(&payload.slot_id)
        .map_err(|_| format!("Invalid slot_id: {}", payload.slot_id))?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

    let mut removed = false;
    let mut runtime_remove_slot: Option<u8> = None;
    if let Some(inst) = &track.instrument
        && inst.id() == slot_uuid
    {
        let removed_plugin_id = inst.plugin_id();
        track.instrument = None;
        let removed_lower = removed_plugin_id.to_lowercase();
        if removed_lower.starts_with("internal://instrument/sampler")
            || removed_lower.starts_with("internal://instrument/wave-synth")
            || removed_lower.starts_with("internal://instrument/simple-sine-synth")
        {
            track.sampler = None;
        }
        removed = true;
    }

    if !removed {
        if let Some(effect_idx) = track.effects.iter().position(|node| node.id() == slot_uuid) {
            // Determine if this is an internal effect — only internal effects
            // exist in the engine's device_chain and need a RemoveDevice command.
            let is_internal_effect = track.effects.get(effect_idx)
                .and_then(|node| node.as_single())
                .map(|slot| slot.plugin_id.starts_with("internal://effect/"))
                .unwrap_or(false);

            if is_internal_effect {
                // Compute the internal-only slot index: count how many internal
                // effects appear BEFORE this one in the effects list.
                let internal_idx = track.effects[..effect_idx].iter()
                    .filter_map(|node| node.as_single())
                    .filter(|slot| slot.plugin_id.starts_with("internal://effect/"))
                    .count();
                runtime_remove_slot = Some(internal_idx.min(u8::MAX as usize) as u8);
            }
            // External VSTs don't live in device_chain — no RemoveDevice needed.

            track.effects.remove(effect_idx);
            removed = true;
        }
    }

    if !removed {
        return Err(format!(
            "Plugin slot not found on track {}: {}",
            payload.track_id, payload.slot_id
        ));
    }

    let project_name = project.name.clone();
    let _ = plugin_host_state.unload_slot_instance(slot_uuid);
    clip_pool_state.rebuild_routing_only(&project);
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();
    if let Some(slot_index) = runtime_remove_slot
        && let Some(runtime_track_index) = project.tracks.iter().position(|t| t.id == track_uuid)
    {
        push_command(&handle, EngineCommand::RemoveDevice {
            track_index: runtime_track_index as u16,
            slot_index,
        })?;
    }
    log::info!(
        "[IPC] remove_plugin_from_track_cmd(track={}, slot={})",
        payload.track_id,
        payload.slot_id
    );
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

/// Delegate: updates or creates a static automation lane on a track.
/// Uses canonical implementation from `dream_models::mutators::upsert_static_automation_lane`.
fn upsert_static_automation_lane(track: &mut Track, param_id: &str, value: f64) {
    mutators::upsert_static_automation_lane(track, param_id, value);
}

/// Set internal plugin parameter value and route to engine state/snapshots.
#[tauri::command]
fn set_internal_plugin_param_cmd(
    payload: InternalPluginParamPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    fn waveform_token_and_code(value: f64) -> (&'static str, u8) {
        let idx = value.round().clamp(0.0, 3.0) as u8;
        match idx {
            1 => ("internal://waveform/triangle", 1),
            2 => ("internal://waveform/saw", 2),
            3 => ("internal://waveform/square", 3),
            _ => ("internal://waveform/sine", 0),
        }
    }

    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let should_commit_snapshot = payload.push_undo_step.unwrap_or(true);
    if should_commit_snapshot {
        push_undo(&project_state)?;
    }
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let raw_key = payload.param_id.to_lowercase();
    let key = if raw_key.starts_with("slot:") {
        raw_key
            .splitn(3, ':')
            .nth(2)
            .unwrap_or(raw_key.as_str())
            .to_string()
    } else {
        raw_key.clone()
    };
    let lane_param_id = |fallback: &str| -> String {
        if raw_key.starts_with("slot:") {
            payload.param_id.clone()
        } else {
            fallback.to_string()
        }
    };
    let mut sampler_command_needed = false;
    let mut sampler_waveform: Option<u8> = None;
    let mut sampler_waveform2: Option<u8> = None;
    let mut sampler_osc_mix: Option<f32> = None;
    let mut sampler_detune_cents: Option<f32> = None;
    let mut sampler_sub_level: Option<f32> = None;
    let mut sampler_filter_cutoff: Option<f32> = None;
    let mut sampler_filter_resonance: Option<f32> = None;
    let mut sampler_filter_type: Option<u8> = None;
    let mut sampler_lfo_rate: Option<f32> = None;
    let mut sampler_lfo_depth: Option<f32> = None;
    let mut sampler_lfo_target: Option<u8> = None;
    let mut sampler_pulse_width: Option<f32> = None;
    let (track_index, sampler_cfg_for_rt) = {
        let (idx, track) = project
            .tracks
            .iter_mut()
            .enumerate()
            .find(|(_, t)| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

        match key.as_str() {
            // Utility gain in dB => plugin.gain in linear 0..2
            "gain" | "utility.gain" | "plugin.gain" => {
                let linear = 10.0_f64.powf(payload.value.clamp(-60.0, 12.0) / 20.0).clamp(0.0, 2.0);
                upsert_static_automation_lane(track, &lane_param_id("plugin.gain"), linear);
            }
            // Utility pan in -100..100 or -1..1 => plugin.pan in -1..1
            "pan" | "utility.pan" | "plugin.pan" => {
                let pan = if payload.value.abs() > 1.0 {
                    (payload.value / 100.0).clamp(-1.0, 1.0)
                } else {
                    payload.value.clamp(-1.0, 1.0)
                };
                upsert_static_automation_lane(track, &lane_param_id("plugin.pan"), pan);
            }
            "width" | "utility.width" | "plugin.width" => {
                upsert_static_automation_lane(track, &lane_param_id("plugin.width"), payload.value.clamp(0.0, 200.0));
            }
            "mono" | "utility.mono" | "plugin.mono" => {
                upsert_static_automation_lane(
                    track,
                    &lane_param_id("plugin.mono"),
                    if payload.value >= 0.5 { 1.0 } else { 0.0 },
                );
            }
            // Sampler parameters
            "sampler.volume" | "volume" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.volume = payload.value.clamp(0.0, 2.0);
                sampler_command_needed = true;
            }
            "sampler.attack" | "attack" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.attack = payload.value.clamp(0.001, 10.0);
                sampler_command_needed = true;
            }
            "sampler.decay" | "decay" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.decay = payload.value.clamp(0.001, 10.0);
                sampler_command_needed = true;
            }
            "sampler.sustain" | "sustain" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.sustain = payload.value.clamp(0.0, 1.0);
                sampler_command_needed = true;
            }
            "sampler.release" | "release" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.release = payload.value.clamp(0.001, 20.0);
                sampler_command_needed = true;
            }
            "sampler.rootnote" | "rootnote" | "sampler.root_note" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.root_note = payload.value.round().clamp(0.0, 127.0) as u8;
                sampler_command_needed = true;
            }
            "synth.waveform" | "waveform" | "sampler.waveform" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let (token, code) = waveform_token_and_code(payload.value);
                cfg.sample_path = token.to_string();
                sampler_waveform = Some(code);
            }
            "synth.osc1.waveform" | "synth.osc1.wave" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let (token, code) = waveform_token_and_code(payload.value);
                cfg.sample_path = token.to_string();
                sampler_waveform = Some(code);
            }
            "synth.osc2.waveform" | "synth.osc2.wave" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let (_, code) = waveform_token_and_code(payload.value);
                cfg.osc2_waveform = code;
                sampler_waveform2 = Some(code);
            }
            "synth.osc.mix" | "synth.oscmix" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let mix = payload.value.clamp(0.0, 1.0) as f32;
                cfg.osc_mix = mix as f64;
                sampler_osc_mix = Some(mix);
            }
            "synth.detune" | "synth.detunecents" | "synth.osc2.detune" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let cents = payload.value.clamp(-50.0, 50.0) as f32;
                cfg.detune_cents = cents as f64;
                sampler_detune_cents = Some(cents);
            }
            "synth.sub" | "synth.sublevel" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let level = payload.value.clamp(0.0, 1.0) as f32;
                cfg.sub_level = level as f64;
                sampler_sub_level = Some(level);
            }
            "synth.filter.cutoff" | "synth.filtercutoff" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let cutoff = payload.value.clamp(20.0, 20000.0) as f32;
                cfg.filter_cutoff = cutoff as f64;
                sampler_filter_cutoff = Some(cutoff);
            }
            "synth.filter.resonance" | "synth.filterresonance" | "synth.filter.res" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let res = payload.value.clamp(0.0, 0.99) as f32;
                cfg.filter_resonance = res as f64;
                sampler_filter_resonance = Some(res);
            }
            "synth.filter.type" | "synth.filtertype" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let ft = payload.value.round().clamp(0.0, 3.0) as u8;
                cfg.filter_type = ft;
                sampler_filter_type = Some(ft);
            }
            "synth.lfo.rate" | "synth.lforate" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let rate = payload.value.clamp(0.01, 20.0) as f32;
                cfg.lfo_rate = rate as f64;
                sampler_lfo_rate = Some(rate);
            }
            "synth.lfo.depth" | "synth.lfodepth" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let depth = payload.value.clamp(0.0, 1.0) as f32;
                cfg.lfo_depth = depth as f64;
                sampler_lfo_depth = Some(depth);
            }
            "synth.lfo.target" | "synth.lfotarget" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let target = payload.value.round().clamp(0.0, 2.0) as u8;
                cfg.lfo_target = target;
                sampler_lfo_target = Some(target);
            }
            "synth.pulse_width" | "synth.pulsewidth" | "synth.pw" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let pw = payload.value.clamp(0.05, 0.95) as f32;
                cfg.pulse_width = pw as f64;
                sampler_pulse_width = Some(pw);
            }
            _ => {
                // Keep unknown params round-trippable in automation lanes.
                upsert_static_automation_lane(track, &payload.param_id, payload.value);
            }
        }

        if sampler_command_needed {
            (idx, track.sampler.clone())
        } else {
            (idx, None)
        }
    };

    let project_name = project.name.clone();
    if should_commit_snapshot {
        // Expensive cold-path rebuilds are deferred during live gestures.
        // Real-time audio updates are already applied via EngineCommand path below.
        clip_pool_state.rebuild_routing_only(&project);
        rebuild_automation_snapshot_from_project(&project, &automation_runtime);
        rebuild_sampler_snapshot_from_project(&project, &clip_pool_state, &handle);
        drop(project);
        project_state.mark_dirty(&project_name, Some(&app))?;
    } else {
        *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    }

    if sampler_command_needed
        && let Some(cfg) = &sampler_cfg_for_rt
    {
        let idx = track_index as u16;
        push_command(&handle, EngineCommand::SetSamplerRootNote {
            track_index: idx,
            root_note: cfg.root_note,
        })?;
        push_command(&handle, EngineCommand::SetSamplerVolume {
            track_index: idx,
            volume: cfg.volume as f32,
        })?;
        push_command(&handle, EngineCommand::SetSamplerAdsr {
            track_index: idx,
            attack: cfg.attack as f32,
            decay: cfg.decay as f32,
            sustain: cfg.sustain as f32,
            release: cfg.release as f32,
        })?;
    }
    if let Some(waveform) = sampler_waveform {
        push_command(&handle, EngineCommand::SetSamplerWaveform {
            track_index: track_index as u16,
            waveform,
        })?;
    }
    if let Some(waveform) = sampler_waveform2 {
        push_command(&handle, EngineCommand::SetSamplerOsc2Waveform {
            track_index: track_index as u16,
            waveform,
        })?;
    }
    if let Some(mix) = sampler_osc_mix {
        push_command(&handle, EngineCommand::SetSamplerOscMix {
            track_index: track_index as u16,
            mix,
        })?;
    }
    if let Some(cents) = sampler_detune_cents {
        push_command(&handle, EngineCommand::SetSamplerDetuneCents {
            track_index: track_index as u16,
            cents,
        })?;
    }
    if let Some(level) = sampler_sub_level {
        push_command(&handle, EngineCommand::SetSamplerSubLevel {
            track_index: track_index as u16,
            level,
        })?;
    }
    if let Some(cutoff) = sampler_filter_cutoff {
        push_command(&handle, EngineCommand::SetSamplerFilterCutoff {
            track_index: track_index as u16,
            cutoff,
        })?;
    }
    if let Some(resonance) = sampler_filter_resonance {
        push_command(&handle, EngineCommand::SetSamplerFilterResonance {
            track_index: track_index as u16,
            resonance,
        })?;
    }
    if let Some(filter_type) = sampler_filter_type {
        push_command(&handle, EngineCommand::SetSamplerFilterType {
            track_index: track_index as u16,
            filter_type,
        })?;
    }
    if let Some(rate) = sampler_lfo_rate {
        push_command(&handle, EngineCommand::SetSamplerLfoRate {
            track_index: track_index as u16,
            rate,
        })?;
    }
    if let Some(depth) = sampler_lfo_depth {
        push_command(&handle, EngineCommand::SetSamplerLfoDepth {
            track_index: track_index as u16,
            depth,
        })?;
    }
    if let Some(target) = sampler_lfo_target {
        push_command(&handle, EngineCommand::SetSamplerLfoTarget {
            track_index: track_index as u16,
            target,
        })?;
    }
    if let Some(width) = sampler_pulse_width {
        push_command(&handle, EngineCommand::SetSamplerPulseWidth {
            track_index: track_index as u16,
            width,
        })?;
    }

    log::debug!(
        "[IPC] set_internal_plugin_param_cmd(track={}, slot={}, param={} value={})",
        payload.track_id,
        payload.slot_id,
        payload.param_id,
        payload.value
    );
    Ok(())
}

/// Assign sample file to a track sampler and stream it to the realtime engine.
#[tauri::command]
fn set_sampler_sample_cmd(
    payload: SetSamplerSamplePayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let sample_path = payload.sample_path.clone();
    if !PathBuf::from(&sample_path).exists() {
        return Err(format!("Sample path does not exist: {}", sample_path));
    }

    let decoded = AudioReader::read(PathBuf::from(&sample_path))
        .map_err(|e| format!("Failed to decode sample: {e}"))?;
    let clip_audio = ClipAudio::new(sample_path.clone(), decoded.channels, decoded.sample_rate);

    let sample_arc = {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        if let Err(e) = pool.insert(clip_audio) { log::error!("ClipPool: {}", e); }
        pool.get(&sample_path)
            .ok_or_else(|| "Failed to cache decoded sampler sample".to_string())?
    };
    clip_pool_state.sync_pool_to_arc();

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let (track_index, sampler_cfg) = {
        let (idx, track) = project
            .tracks
            .iter_mut()
            .enumerate()
            .find(|(_, t)| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

        let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
        cfg.sample_path = sample_path.clone();
        if let Some(root) = payload.root_note {
            cfg.root_note = root.min(127);
        }
        (idx, cfg.clone())
    };

    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    handle
        .sampler_samples
        .set_track_sample(track_index, Some(sample_arc));

    let idx = track_index as u16;
    push_command(&handle, EngineCommand::SetSamplerRootNote {
        track_index: idx,
        root_note: sampler_cfg.root_note,
    })?;
    push_command(&handle, EngineCommand::SetSamplerVolume {
        track_index: idx,
        volume: sampler_cfg.volume as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerAdsr {
        track_index: idx,
        attack: sampler_cfg.attack as f32,
        decay: sampler_cfg.decay as f32,
        sustain: sampler_cfg.sustain as f32,
        release: sampler_cfg.release as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerOsc2Waveform {
        track_index: idx,
        waveform: sampler_cfg.osc2_waveform.min(3),
    })?;
    push_command(&handle, EngineCommand::SetSamplerOscMix {
        track_index: idx,
        mix: sampler_cfg.osc_mix.clamp(0.0, 1.0) as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerDetuneCents {
        track_index: idx,
        cents: sampler_cfg.detune_cents.clamp(-50.0, 50.0) as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerSubLevel {
        track_index: idx,
        level: sampler_cfg.sub_level.clamp(0.0, 1.0) as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerFilterCutoff {
        track_index: idx,
        cutoff: sampler_cfg.filter_cutoff.clamp(20.0, 20000.0) as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerFilterResonance {
        track_index: idx,
        resonance: sampler_cfg.filter_resonance.clamp(0.0, 0.99) as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerFilterType {
        track_index: idx,
        filter_type: sampler_cfg.filter_type.min(3),
    })?;

    log::info!(
        "[IPC] set_sampler_sample_cmd(track={}, path={})",
        payload.track_id,
        sample_path
    );
    Ok(())
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

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    // Find the track index for engine commands (0-based).
    let track_index = project
        .tracks
        .iter()
        .position(|t| t.id == track_uuid);

    // Check whether this slot is the track's instrument (not an effect).
    let is_instrument = if let Some(ti) = track_index {
        project.tracks[ti]
            .instrument
            .as_ref()
            .and_then(|inst| find_slot_in_node_by_id(inst, slot_uuid))
            .is_some()
    } else {
        false
    };

    let slot = find_slot_on_track_mut(&mut project, track_uuid, slot_uuid).ok_or_else(|| {
        format!("Plugin slot not found: track={track_id}, slot={slot_id}")
    })?;

    slot.is_bypassed = bypassed;
    log::info!(
        "[IPC] set_slot_bypass_cmd(track={}, slot={}, bypassed={}, is_instrument={}) plugin={}",
        track_id, slot_id, bypassed, is_instrument, slot.plugin_id
    );

    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    // For instrument slots, send BypassInstrument to the real-time audio thread
    // so the internal sampler stops producing audio immediately.
    if is_instrument {
        if let Some(ti) = track_index {
            if let Err(e) = push_command(
                &handle,
                EngineCommand::BypassInstrument {
                    track_index: ti as u16,
                    bypassed,
                },
            ) {
                log::error!("[IPC] Failed to push BypassInstrument command for track {}: {}", ti, e);
            }
        }
    }

    Ok(())
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
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    // Find the effects vec to operate on (regular track or master)
    let effects: &mut Vec<DeviceNode> = if track_id == "master" || project.master_track.id == track_uuid {
        &mut project.master_track.effects
    } else {
        let track = project
            .tracks
            .iter_mut()
            .find(|t| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found: {track_id}"))?;
        &mut track.effects
    };

    // Find the slot's current position
    let from_index = effects
        .iter()
        .position(|node| node.id() == slot_uuid)
        .ok_or_else(|| format!("Effect slot not found: {slot_id}"))?;

    if from_index == target_index {
        return Ok(());
    }

    let clamped_target = target_index.min(effects.len().saturating_sub(1));

    // Remove from current position and insert at target
    let node = effects.remove(from_index);
    effects.insert(clamped_target, node);

    // Rebuild FX snapshot so the audio engine picks up the new order
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();

    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] move_effect_slot_cmd(track={track_id}, slot={slot_id}, {from_index} → {clamped_target})"
    );
    Ok(())
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
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {track_id}"))?;

    // Determine placement: instrument slot vs effects chain.
    let hint = slot_hint.as_deref().unwrap_or("auto").to_lowercase();
    let plugin_id = pasted_node.plugin_id();
    let is_instrument_plugin = plugin_id.contains("instrument/");
    let use_instrument = match hint.as_str() {
        "instrument" => track.track_type == TrackType::Midi,
        "effect" => false,
        _ => { // "auto"
            if track.track_type != TrackType::Midi {
                false
            } else {
                is_instrument_plugin
            }
        }
    };

    // Collect all new slot IDs for plugin host loading.
    let new_slots: Vec<PluginSlot> = pasted_node.collect_plugin_slots().into_iter().cloned().collect();

    let mut runtime_add: Option<(Uuid, u8, u8)> = None;
    if use_instrument {
        // Set up sampler config if pasting a sampler/wave-synth instrument.
        let pid_lower = plugin_id.to_lowercase();
        if (pid_lower.contains("sampler") || pid_lower.contains("wave-synth"))
            && track.sampler.is_none()
        {
            track.sampler = Some(SamplerConfig::default());
        }
        track.instrument = Some(pasted_node);
    } else {
        // Compute AddDevice info for internal effects.
        if let DeviceNode::Single(slot) = &pasted_node {
            if slot.plugin_id.starts_with("internal://effect/") {
                if let Some(effect_type) = builtin_effect_type_from_plugin_id(&slot.plugin_id) {
                    let internal_slot_index = track.effects.iter()
                        .filter_map(|node| node.as_single())
                        .filter(|s| s.plugin_id.starts_with("internal://effect/"))
                        .count()
                        .min(u8::MAX as usize) as u8;
                    runtime_add = Some((track.id, internal_slot_index, effect_type));
                }
            }
        }
        track.effects.push(pasted_node);
    }

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
    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();

    // Send AddDevice engine command for internal effects.
    if let Some((tid, slot_index, effect_type)) = runtime_add {
        if let Some(runtime_track_index) = project.tracks.iter().position(|t| t.id == tid) {
            if let Err(e) = push_command(&handle, EngineCommand::AddDevice {
                track_index: runtime_track_index as u16,
                slot_index,
                effect_type,
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
