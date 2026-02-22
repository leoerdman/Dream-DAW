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
use dream_models::project::builtin_effect_type_from_plugin_id;
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
    let replacement_name = payload
        .replacement_plugin_name
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .unwrap_or_else(|| descriptor.name.clone());

    let cmd = dream_orchestrator::commands::ReplaceMissingPluginSlotCommand {
        track_id: track_uuid,
        slot_id: slot_uuid,
        replacement_plugin_id: replacement_plugin_id.clone(),
        replacement_plugin_name: replacement_name,
        external_audio_inputs: Some(descriptor.audio_inputs),
        supports_sidechain_input: if descriptor.format != PluginFormat::VST3 {
            Some(descriptor.audio_inputs > 2)
        } else {
            None
        },
        external_format: Some(descriptor.format.to_string().to_lowercase()),
        external_uid: descriptor.unique_id.clone(),
        external_plugin_version: descriptor.version.clone(),
    };

    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
    }

    let _ = plugin_host_state.unload_slot_instance(slot_uuid);
    if let Err(err) = plugin_host_state.ensure_loaded_instance_for_slot(slot_uuid, &replacement_plugin_id) {
        log::warn!(
            "[IPC] replace_missing_plugin_slot_cmd runtime init failed (slot={}, plugin={}): {}",
            slot_uuid,
            replacement_plugin_id,
            err
        );
    }

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
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

    let lane_cmd = dream_orchestrator::commands::SetExternalPluginParamLaneCommand::from_str_ids(
        &track_id,
        &resolved_slot_id.to_string(),
        param_index,
        normalized,
    )
    .map_err(|e| e.to_string())?;
    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&lane_cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
    }

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
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;

    push_undo(&project_state)?;

    let slot = payload.slot.to_lowercase();
    
    // BUG-5 FIX: Only apply internal-plugin fuzzy mapping when the plugin_id
    // looks like an ALS migration tag or an internal convention.
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
        dream_importers::ableton::normalization::canonical_internal_plugin_for_import(&payload.plugin_id, &payload.plugin_name)
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
    
    let mut external_audio_inputs = None;
    let mut external_supports_sidechain_input = None;
    if !effective_plugin_id.starts_with("internal://")
        && let Ok(desc) = plugin_host_state.resolve_descriptor(&effective_plugin_id)
    {
        external_audio_inputs = Some(desc.audio_inputs);
        if desc.format != PluginFormat::VST3 {
            external_supports_sidechain_input = Some(desc.audio_inputs > 2);
        }
    }

    let cmd = dream_orchestrator::commands::AddPluginToTrackCommand::from_str_track_id(
        &payload.track_id,
        effective_plugin_id.clone(),
        effective_plugin_name.clone(),
        &slot,
        canonical_slot_hint,
        external_audio_inputs,
        external_supports_sidechain_input,
    )
    .map_err(|e| e.to_string())?;
    let cmd_result = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let result = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
        result
    };
    let new_slot_id = cmd_result.slot_id;
    let use_instrument = cmd_result.placed_as_instrument;

    let mut runtime_add: Option<(Uuid, u8, u8)> = None;
    if effective_plugin_id.starts_with("internal://")
        && let Some(effect_type) = builtin_effect_type_from_plugin_id(&effective_plugin_id)
        && let Some(internal_slot_index) = cmd_result.runtime_effect_slot_index
    {
        runtime_add = Some((track_uuid, internal_slot_index, effect_type));
    }
    let runtime_waveform = cmd_result
        .runtime_waveform_code
        .map(|waveform| (track_uuid, waveform));

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    
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
    
    if let Some(err_msg) = plugin_load_error {
        return Err(err_msg);
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
struct PluginMutationDeltaResponse {
    deltas: Vec<dream_models::delta::ProjectDelta>,
}

#[tauri::command]
fn add_plugin_to_track_with_deltas_cmd(
    payload: AddPluginToTrackPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<PluginMutationDeltaResponse, String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;

    let (before_instrument_id, before_effect_ids): (Option<Uuid>, std::collections::HashSet<Uuid>) = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let track = project
            .tracks
            .iter()
            .find(|t| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;
        (
            track.instrument.as_ref().map(DeviceNode::id),
            track.effects.iter().map(DeviceNode::id).collect(),
        )
    };

    add_plugin_to_track_cmd(
        payload,
        project_state.clone(),
        clip_pool_state.clone(),
        handle.clone(),
        plugin_host_state.clone(),
        app,
    )?;

    let (slot_id, slot_index, is_instrument, plugin_name, plugin_uid) = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let track = project
            .tracks
            .iter()
            .find(|t| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found after add: {track_uuid}"))?;

        if let Some(inst) = &track.instrument {
            let inst_id = inst.id();
            if before_instrument_id != Some(inst_id) {
                (inst_id, 0usize, true, inst.name().to_owned(), inst.plugin_id().to_owned())
            } else {
                let (idx, node) = track
                    .effects
                    .iter()
                    .enumerate()
                    .find(|(_, node)| !before_effect_ids.contains(&node.id()))
                    .ok_or_else(|| "Delta invariant violated: added slot not found".to_string())?;
                (node.id(), idx, false, node.name().to_owned(), node.plugin_id().to_owned())
            }
        } else {
            let (idx, node) = track
                .effects
                .iter()
                .enumerate()
                .find(|(_, node)| !before_effect_ids.contains(&node.id()))
                .ok_or_else(|| "Delta invariant violated: added slot not found".to_string())?;
            (node.id(), idx, false, node.name().to_owned(), node.plugin_id().to_owned())
        }
    };

    Ok(PluginMutationDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::PluginAdded {
            track_id: track_uuid,
            slot_id,
            slot_index,
            is_instrument,
            plugin_name,
            plugin_uid,
        }],
    })
}

#[tauri::command]
fn remove_plugin_from_track_with_deltas_cmd(
    payload: RemovePluginFromTrackPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<PluginMutationDeltaResponse, String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let slot_uuid = Uuid::parse_str(&payload.slot_id)
        .map_err(|_| format!("Invalid slot_id: {}", payload.slot_id))?;

    remove_plugin_from_track_cmd(
        payload,
        project_state,
        clip_pool_state,
        handle,
        plugin_host_state,
        app,
    )?;

    Ok(PluginMutationDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::PluginRemoved {
            track_id: track_uuid,
            slot_id: slot_uuid,
        }],
    })
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
    let cmd = dream_orchestrator::commands::RemovePluginFromTrackCommand::from_str_ids(
        &payload.track_id,
        &payload.slot_id,
    )
    .map_err(|e| e.to_string())?;
    let runtime_remove_slot = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let result = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
        result.runtime_remove_slot
    };
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
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
    let should_commit_snapshot = payload.push_undo_step.unwrap_or(true);
    if should_commit_snapshot {
        push_undo(&project_state)?;
    }
    let cmd = dream_orchestrator::commands::SetInternalPluginParamCommand::from_str_track_id(
        &payload.track_id,
        payload.param_id.clone(),
        payload.value,
    )
    .map_err(|e| e.to_string())?;
    let result = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let result = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
        result
    };
    let track_index = result.track_index;
    let sampler_command_needed = result.sampler_command_needed;
    let sampler_cfg_for_rt = result.sampler_cfg_for_rt;
    let sampler_waveform = result.sampler_waveform;
    let sampler_waveform2 = result.sampler_waveform2;
    let sampler_osc_mix = result.sampler_osc_mix;
    let sampler_detune_cents = result.sampler_detune_cents;
    let sampler_sub_level = result.sampler_sub_level;
    let sampler_filter_cutoff = result.sampler_filter_cutoff;
    let sampler_filter_resonance = result.sampler_filter_resonance;
    let sampler_filter_type = result.sampler_filter_type;
    let sampler_lfo_rate = result.sampler_lfo_rate;
    let sampler_lfo_depth = result.sampler_lfo_depth;
    let sampler_lfo_target = result.sampler_lfo_target;
    let sampler_pulse_width = result.sampler_pulse_width;

    let project = project_state.project.lock().map_err(|e| e.to_string())?;

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
    let cmd = dream_orchestrator::commands::SetSamplerSampleCommand::from_str_track_id(
        &payload.track_id,
        sample_path.clone(),
        payload.root_note,
    )
    .map_err(|e| e.to_string())?;
    let (track_index, sampler_cfg) = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let result = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
        (result.track_index, result.sampler_cfg)
    };

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
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
    let result = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let result = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
        result
    };

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
    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
    }

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
    let result = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let result = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
        result
    };

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
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
            track_id: match target {
                dream_orchestrator::commands::EffectTrackTarget::Master => project.master_track.id,
                dream_orchestrator::commands::EffectTrackTarget::Track(id) => id,
            },
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
        let opt_internal_idx = dream_graph::routing::device_chain::DeviceChain::insert_effect(track, pasted_node.clone(), None);

        // Compute AddDevice info for internal effects.
        if let DeviceNode::Single(slot) = &pasted_node {
            if slot.plugin_id.starts_with("internal://effect/") {
                if let Some(effect_type) = builtin_effect_type_from_plugin_id(&slot.plugin_id) {
                    if let Some(internal_slot_index) = opt_internal_idx {
                        runtime_add = Some((track.id, internal_slot_index, effect_type));
                    }
                }
            }
        }
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
