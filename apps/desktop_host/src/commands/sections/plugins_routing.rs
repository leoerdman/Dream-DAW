// ═══════════════════════════════════════════════════════════════════════
// Pure slot-lookup and diagnostic functions extracted to:
// core/dream_importers/src/routing_helpers.rs
// ═══════════════════════════════════════════════════════════════════════
use dream_importers::routing_helpers::{
    diagnose_external_plugin_reference,
};
use dream_models::project::builtin_effect_type_from_plugin_id;
mod plugins_routing_helpers;
use plugins_routing_helpers::{
    apply_imported_external_state_blob,
    finalize_external_param_update,
    finalize_internal_param_update,
    load_external_slot_best_effort,
    load_external_slots_best_effort,
    sync_external_fx_snapshot_from_state,
    sync_routing_and_mark_dirty,
    sync_plugin_runtime_single_track_and_mark_dirty,
    sync_bypass_only_and_mark_dirty,
};

#[tauri::command]
fn get_plugin_slot_runtime_status_cmd(
    track_id: String,
    slot_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<PluginSlotRuntimeStatus, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let slot = execute_orchestrator_query(
        project_state,
        &dream_orchestrator::queries::ResolvePluginSlotStateQuery {
            track_id: track_uuid,
            slot_id: slot_uuid,
        },
    )?;

    if slot.plugin_id.starts_with("internal://") {
        return Ok(PluginSlotRuntimeStatus {
            loaded: true,
            editor_supported: false,
            runtime: "internal".to_string(),
            sidechain_ready: slot.supports_sidechain_input.unwrap_or(false)
                || slot.plugin_id.contains("compressor")
                || slot.plugin_id.contains("gate")
                || slot.plugin_id.contains("shaper"),
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
    if descriptor.format == PluginFormat::CLAP {
        return Ok(PluginSlotRuntimeStatus {
            loaded: false,
            editor_supported: false,
            runtime: "unsupported".to_string(),
            sidechain_ready: false,
            latency_frames: None,
            message: Some(format!(
                "{} is detected but runtime currently supports VST2/VST3/AU.",
                descriptor.format
            )),
        });
    }

    let slot_map = plugin_host_state.slot_instance_snapshot();
    let runtime_instance = slot_map.get(&slot.slot_id).copied();
    let (sandbox_loaded, sandbox_instance_for_key, sandbox_instance_ids) = {
        let sandbox_map = plugin_host_state
            .loaded_sandbox_by_key
            .lock();
        (
            sandbox_map.contains_key(&slot.plugin_id),
            sandbox_map.get(&slot.plugin_id).copied(),
            sandbox_map.values().copied().collect::<std::collections::HashSet<_>>(),
        )
    };

    if let Some(instance_id) = runtime_instance {
        let runtime_is_sandbox = sandbox_instance_for_key == Some(instance_id)
            || sandbox_instance_ids.contains(&instance_id);
        if runtime_is_sandbox {
            return Ok(PluginSlotRuntimeStatus {
                loaded: true,
                editor_supported: true,
                runtime: "sandbox".to_string(),
                sidechain_ready: slot
                    .supports_sidechain_input
                    .unwrap_or(!slot.plugin_id.starts_with("internal://")),
                latency_frames: Some(0),
                message: None,
            });
        }

        // RT-SAFETY FIX: Use try_lock() to avoid blocking the audio thread.
        // This command fires on every track selection, competing for the host
        // mutex with the audio callback. If we can't lock, return safe defaults
        // — the slot map confirms the instance is bound.
        let (loaded, editor_supported, latency_frames) = match plugin_host_state.host.try_lock() {
            Some(mut host) => {
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
                (loaded, editor_supported, latency_frames)
            }
            None => {
                // Host mutex is held — assume loaded since slot binding exists.
                (true, true, Some(0))
            }
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
        editor_supported: sandbox_loaded,
        runtime: if sandbox_loaded {
            "sandbox".to_string()
        } else {
            "unloaded".to_string()
        },
        sidechain_ready: slot.supports_sidechain_input.unwrap_or(!slot.plugin_id.starts_with("internal://")),
        latency_frames: None,
        message: if sandbox_loaded {
            None
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let slot = execute_orchestrator_query(
        project_state,
        &dream_orchestrator::queries::ResolvePluginSlotStateQuery {
            track_id: track_uuid,
            slot_id: slot_uuid,
        },
    )?;
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
    if descriptor.format == PluginFormat::CLAP {
        return Err(format!(
            "Unsupported plugin runtime format: {}. Dream DAW runtime currently supports VST2/VST3/AU.",
            descriptor.format
        ));
    }

    let instance_id =
        plugin_host_state.ensure_loaded_instance_for_slot(slot.slot_id, &slot.plugin_id)?;
    plugin_host_state.bind_slot_instance(slot.slot_id, instance_id);

    // Restore per-slot saved state (preset, knob positions, EQ, etc.)
    // Without this, plugins activated for audio processing after project
    // reload would lose their saved settings (e.g., ShaperBox3 EQ points).
    if slot.external_state_blob.is_some() || slot.external_preset_blob.is_some() {
        {
            let mut host = plugin_host_state.host.lock();
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
                    "[IPC] ensure_plugin_slot_active_cmd: state restore failed for '{}': {}",
                    slot.name, err
                );
            } else {
                log::info!(
                    "[IPC] ensure_plugin_slot_active_cmd: restored state for '{}' (slot {})",
                    slot.name, slot.slot_id
                );
            }
        }
    }

    sync_external_fx_snapshot_from_state(project_state, &clip_pool_state, &plugin_host_state)?;
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let slot = execute_orchestrator_query(
        project_state,
        &dream_orchestrator::queries::ResolvePluginSlotStateQuery {
            track_id: track_uuid,
            slot_id: slot_uuid,
        },
    )?;

    if slot.plugin_id.starts_with("internal://") {
        return Ok(());
    }

    plugin_host_state.unload_slot_instance(slot.slot_id)?;
    sync_external_fx_snapshot_from_state(project_state, &clip_pool_state, &plugin_host_state)?;
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

fn replace_missing_plugin_slot_impl(
    payload: ReplaceMissingPluginPayload,
    plugin_host_state: &tauri::State<'_, PluginHostState>,
    project_registry: &tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: &tauri::State<'_, ClipPoolState>,
    handle: &tauri::State<'_, AudioEngineHandle>,
    app: &tauri::AppHandle,
) -> Result<dream_orchestrator::commands::ReplaceMissingPluginSlotResult, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
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
    if descriptor.format == PluginFormat::CLAP {
        return Err(format!(
            "Replacement plugin format '{}' is not supported in runtime. Use VST2, VST3, or AU.",
            descriptor.format
        ));
    }

    push_undo(project_state)?;
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
        supports_sidechain_input: Some(descriptor.audio_inputs > 2),
        external_format: Some(descriptor.format.to_string().to_lowercase()),
        external_uid: descriptor.unique_id.clone(),
        external_plugin_version: descriptor.version.clone(),
    };

    let cmd_result = execute_orchestrator_command(project_state, &cmd)?;

    let _ = plugin_host_state.unload_slot_instance(slot_uuid);
    if let Err(err) =
        plugin_host_state.ensure_loaded_instance_for_slot(slot_uuid, &replacement_plugin_id)
    {
        log::warn!(
            "[IPC] replace_missing_plugin_slot runtime init failed (slot={}, plugin={}): {}",
            slot_uuid,
            replacement_plugin_id,
            err
        );
    } else if let Ok(slot_state) = execute_orchestrator_query(
        project_state,
        &dream_orchestrator::queries::ResolvePluginSlotStateQuery {
            track_id: track_uuid,
            slot_id: slot_uuid,
        },
    ) && (slot_state.external_state_blob.is_some() || slot_state.external_preset_blob.is_some())
    {
        if let Some(instance_id) = plugin_host_state.slot_instance_snapshot().get(&slot_uuid).copied()
        {
            let mut host = plugin_host_state.host.lock();
            let mut slot_restore = dream_models::project::PluginSlot::new(
                slot_state.name.clone(),
                slot_state.plugin_id.clone(),
            );
            slot_restore.id = slot_state.slot_id;
            slot_restore.supports_sidechain_input = slot_state.supports_sidechain_input;
            slot_restore.external_parameter_count = slot_state.external_parameter_count;
            slot_restore.external_state_blob = slot_state.external_state_blob.clone();
            slot_restore.external_state_blob_kind = slot_state.external_state_blob_kind.clone();
            slot_restore.external_preset_blob = slot_state.external_preset_blob.clone();
            slot_restore.external_preset_blob_kind = slot_state.external_preset_blob_kind.clone();
            if let Err(err) = apply_imported_external_state_blob(&mut host, instance_id, &slot_restore) {
                log::warn!(
                    "[IPC] replace_missing_plugin_slot: state restore failed (slot={}, plugin={}): {}",
                    slot_uuid,
                    replacement_plugin_id,
                    err
                );
            } else {
                log::info!(
                    "[IPC] replace_missing_plugin_slot: restored imported plugin state for slot {}",
                    slot_uuid
                );
            }
        }
    }

    // Resolve track index from UUID for per-track rebuild
    let replace_track_index = {
        let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        project.tracks.iter().position(|t| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found for replace_missing_plugin: {}", track_uuid))?
    };

    // ENTERPRISE: Per-track rebuild — only clears/rebuilds this track's device
    // chain, preserving all other tracks' effect tails (reverb, delay, etc.).
    sync_plugin_runtime_single_track_and_mark_dirty(
        project_state,
        clip_pool_state,
        plugin_host_state,
        handle,
        app,
        replace_track_index,
    )?;

    Ok(cmd_result)
}

/// Replace a missing external plugin placeholder with a real plugin on the same slot.
#[tauri::command]
fn replace_missing_plugin_slot_cmd(
    payload: ReplaceMissingPluginPayload,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let _ = replace_missing_plugin_slot_impl(
        payload,
        &plugin_host_state,
        &project_registry,
        &clip_pool_state,
        &handle,
        &app,
    )?;
    Ok(())
}

/// Replace a missing plugin slot and return snapshot delta for frontend sync.
#[tauri::command]
fn replace_missing_plugin_slot_with_deltas_cmd(
    payload: ReplaceMissingPluginPayload,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let track_id_raw = payload.track_id.clone();
    let track_id = Uuid::parse_str(&track_id_raw)
        .map_err(|_| format!("Invalid track_id: {}", track_id_raw))?;
    let cmd_result = replace_missing_plugin_slot_impl(
        payload,
        &plugin_host_state,
        &project_registry,
        &clip_pool_state,
        &handle,
        &app,
    )?;

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::PluginAdded {
            track_id,
            slot_id: cmd_result.slot_id,
            slot_index: cmd_result.slot_index,
            is_instrument: cmd_result.is_instrument,
            plugin_name: cmd_result.plugin_name,
            plugin_uid: cmd_result.plugin_uid,
        }],
    })
}

include!("plugins_routing/window_open_commands.rs");
include!("plugins_routing/window_open_capability_commands.rs");
include!("plugins_routing/window_param_close_commands.rs");
include!("plugins_routing/window_param_set_commands.rs");
include!("plugins_routing/window_param_query_commands.rs");
include!("plugins_routing/mutation_commands_a.rs");
include!("plugins_routing/mutation_commands_b.rs");
