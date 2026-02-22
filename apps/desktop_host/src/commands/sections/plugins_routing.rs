// ═══════════════════════════════════════════════════════════════════════
// Pure slot-lookup and diagnostic functions extracted to:
// core/dream_importers/src/routing_helpers.rs
// ═══════════════════════════════════════════════════════════════════════
use dream_importers::routing_helpers::{
    find_project_plugin_slot,
    find_project_plugin_slot_by_slot_id,
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

    execute_orchestrator_command(&project_state, &cmd)?;

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

/// Replace a missing plugin slot and return snapshot delta for frontend sync.
#[tauri::command]
fn replace_missing_plugin_slot_with_deltas_cmd(
    payload: ReplaceMissingPluginPayload,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
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

    execute_orchestrator_command(&project_state, &cmd)?;

    let _ = plugin_host_state.unload_slot_instance(slot_uuid);
    if let Err(err) = plugin_host_state.ensure_loaded_instance_for_slot(slot_uuid, &replacement_plugin_id) {
        log::warn!(
            "[IPC] replace_missing_plugin_slot_with_deltas_cmd runtime init failed (slot={}, plugin={}): {}",
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
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
            project: Box::new(project.clone()),
        }],
    })
}

/// Close plugin native GUI window.
///
/// BUG-8 FIX: Only closes the editor window — does NOT destroy the plugin
/// instance. Instance lifetime is managed by `unload_plugin_slot_cmd` or
/// project close. Destroying the instance here would cause data loss and
/// silent audio dropouts when multiple slots share the same plugin_id.
#[tauri::command]

include!("plugins_routing/window_param_commands.rs");
include!("plugins_routing/mutation_commands_a.rs");
include!("plugins_routing/mutation_commands_b.rs");
