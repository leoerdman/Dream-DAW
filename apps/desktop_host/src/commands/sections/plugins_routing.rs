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
    sync_plugin_runtime_and_mark_dirty,
};

#[tauri::command]
fn get_plugin_slot_runtime_status_cmd(
    track_id: String,
    slot_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<PluginSlotRuntimeStatus, String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let slot = execute_orchestrator_query(
        &project_state,
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
    let runtime_instance = slot_map.get(&slot.slot_id).copied();
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
    let slot = execute_orchestrator_query(
        &project_state,
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
    if descriptor.format != PluginFormat::VST3 && descriptor.format != PluginFormat::VST2 {
        return Err(format!(
            "Unsupported plugin runtime format: {}. Dream DAW runtime currently supports VST2/VST3 only.",
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

    sync_external_fx_snapshot_from_state(&project_state, &clip_pool_state, &plugin_host_state)?;
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
    let slot = execute_orchestrator_query(
        &project_state,
        &dream_orchestrator::queries::ResolvePluginSlotStateQuery {
            track_id: track_uuid,
            slot_id: slot_uuid,
        },
    )?;

    if slot.plugin_id.starts_with("internal://") {
        return Ok(());
    }

    plugin_host_state.unload_slot_instance(slot.slot_id)?;
    sync_external_fx_snapshot_from_state(&project_state, &clip_pool_state, &plugin_host_state)?;
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
    project_state: &tauri::State<'_, ProjectState>,
    clip_pool_state: &tauri::State<'_, ClipPoolState>,
    app: &tauri::AppHandle,
) -> Result<dream_orchestrator::commands::ReplaceMissingPluginSlotResult, String> {
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
        supports_sidechain_input: if descriptor.format != PluginFormat::VST3 {
            Some(descriptor.audio_inputs > 2)
        } else {
            None
        },
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
    }

    sync_plugin_runtime_and_mark_dirty(
        project_state,
        clip_pool_state,
        plugin_host_state,
        app,
        true,
    )?;

    Ok(cmd_result)
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
    let _ = replace_missing_plugin_slot_impl(
        payload,
        &plugin_host_state,
        &project_state,
        &clip_pool_state,
        &app,
    )?;
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
    let cmd_result = replace_missing_plugin_slot_impl(
        payload,
        &plugin_host_state,
        &project_state,
        &clip_pool_state,
        &app,
    )?;

    // Replace is represented as remove+add to keep reducer semantics simple and
    // avoid full project snapshot refreshes for a single-slot mutation.
    let deltas = vec![
        dream_models::delta::ProjectDelta::PluginRemoved {
            track_id: track_uuid,
            slot_id: cmd_result.slot_id,
        },
        dream_models::delta::ProjectDelta::PluginAdded {
            track_id: track_uuid,
            slot_id: cmd_result.slot_id,
            slot_index: cmd_result.slot_index,
            is_instrument: cmd_result.is_instrument,
            plugin_name: cmd_result.plugin_name,
            plugin_uid: cmd_result.plugin_uid,
        },
    ];

    Ok(DeltaMutationResponse {
        deltas,
    })
}

include!("plugins_routing/window_open_commands.rs");
include!("plugins_routing/window_param_commands.rs");
include!("plugins_routing/mutation_commands_a.rs");
include!("plugins_routing/mutation_commands_b.rs");
