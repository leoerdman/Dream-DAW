/// Assign sample file to a track sampler and stream it to the realtime engine.
#[tauri::command]
fn set_sampler_sample_cmd(
    payload: SetSamplerSamplePayload,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let sample_path = payload.sample_path.clone();
    if !PathBuf::from(&sample_path).exists() {
        return Err(format!("Sample path does not exist: {}", sample_path));
    }

    let decoded = AudioReader::read(PathBuf::from(&sample_path))
        .map_err(|e| format!("Failed to decode sample: {e}"))?;
    let clip_audio = ClipAudio::new(sample_path.clone(), decoded.channels, decoded.sample_rate);

    let sample_arc = {
        let mut pool = clip_pool_state.pool.lock().map_err(|_| "Mutex poisoned".to_string())?;
        if let Err(e) = pool.insert(clip_audio) {
            log::error!("ClipPool: {}", e);
        }
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
    .map_err(|_| "Mutex poisoned".to_string())?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    let (track_index, sampler_cfg) = (result.track_index, result.sampler_cfg);

    sync_routing_and_mark_dirty(project_state, &clip_pool_state, &app)?;
    handle
        .sampler_samples
        .set_track_sample(track_index, Some(sample_arc));

    let idx = track_index as u16;
    push_command(
        &handle,
        EngineCommand::SetSamplerRootNote {
            track_index: idx,
            root_note: sampler_cfg.root_note,
        },
    )?;
    push_command(
        &handle,
        EngineCommand::SetSamplerVolume {
            track_index: idx,
            volume: sampler_cfg.volume as f32,
        },
    )?;
    push_command(
        &handle,
        EngineCommand::SetSamplerAdsr {
            track_index: idx,
            attack: sampler_cfg.attack as f32,
            decay: sampler_cfg.decay as f32,
            sustain: sampler_cfg.sustain as f32,
            release: sampler_cfg.release as f32,
        },
    )?;



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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<PluginMutationDeltaResponse, String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let sample_path = payload.sample_path.clone();
    set_sampler_sample_cmd(payload, project_registry, clip_pool_state, handle, app)?;
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<serde_json::Value, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let external_slots = execute_orchestrator_query(
        project_state,
        &dream_orchestrator::queries::ListExternalPluginSlotsQuery,
    )?;

    let total = external_slots.len();
    let mut loaded = 0u32;
    let mut failed = 0u32;
    let skipped = 0u32;

    for slot in &external_slots {
        match plugin_host_state.ensure_loaded_instance_for_slot(slot.slot_id, &slot.plugin_id) {
            Ok(instance_id) => {
                loaded += 1;
                log::info!(
                    "[EagerActivate] Slot {} plugin '{}' active as instance {} ({}/{})",
                    slot.slot_id,
                    slot.plugin_id,
                    instance_id,
                    loaded,
                    total
                );

                // Restore the per-slot saved state (preset, knob positions, etc.)
                if slot.external_state_blob.is_some() || slot.external_preset_blob.is_some() {
                    let mut host = match plugin_host_state.host.lock() {
                        Ok(h) => h,
                        Err(e) => {
                            log::warn!(
                                "[EagerActivate] Host lock failed for state restore of '{}': {}",
                                slot.plugin_id, e
                            );
                            continue;
                        }
                    };
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
                            "[EagerActivate] State restore failed for '{}' (slot {}): {}",
                            slot_restore.name, slot.slot_id, err
                        );
                    } else {
                        log::info!(
                            "[EagerActivate] Restored state for '{}' (slot {})",
                            slot_restore.name, slot.slot_id
                        );
                    }
                }
            }
            Err(err) => {
                // Don't fail the whole operation for one bad plugin
                failed += 1;
                log::warn!(
                    "[EagerActivate] Failed to activate '{}': {}",
                    slot.plugin_id,
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

    sync_external_fx_snapshot_from_state(project_state, &clip_pool_state, &plugin_host_state)?;

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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let track_uuid = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track id: {e}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|e| format!("Invalid slot id: {e}"))?;

    let cmd = dream_orchestrator::commands::SetPluginSlotBypassCommand {
        track_id: track_uuid,
        slot_id: slot_uuid,
        bypassed,
    };
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    log::info!(
        "[IPC] set_slot_bypass_cmd(track={}, slot={}, bypassed={}, is_instrument={}) plugin={}",
        track_id, slot_id, bypassed, result.is_instrument, result.plugin_id
    );

    sync_plugin_runtime_and_mark_dirty(
        project_state,
        &clip_pool_state,
        &plugin_host_state,
        &handle,
        &app,
        true,
    )?;

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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
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
        project_registry.clone(),
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let target = dream_orchestrator::commands::EffectTrackTarget::from_track_id(&track_id)
        .map_err(|_| "Mutex poisoned".to_string())?;
    let cmd = dream_orchestrator::commands::MoveEffectSlotCommand {
        target,
        slot_id: slot_uuid,
        target_index,
    };

    let preview_result = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|_| "Mutex poisoned".to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|_| "Mutex poisoned".to_string())?
    };
    if !preview_result.changed {
        return Ok(());
    }

    push_undo(&project_state)?;
    execute_orchestrator_command(&project_state, &cmd)?;

    // Rebuild FX snapshot so the audio engine picks up the new order
    sync_plugin_runtime_and_mark_dirty(
        project_state,
        &clip_pool_state,
        &plugin_host_state,
        &handle,
        &app,
        false,
    )?;
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<PluginMutationDeltaResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let target = dream_orchestrator::commands::EffectTrackTarget::from_track_id(&track_id)
        .map_err(|_| "Mutex poisoned".to_string())?;
    let cmd = dream_orchestrator::commands::MoveEffectSlotCommand {
        target,
        slot_id: slot_uuid,
        target_index,
    };

    let preview_result = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|_| "Mutex poisoned".to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|_| "Mutex poisoned".to_string())?
    };
    if !preview_result.changed {
        return Ok(PluginMutationDeltaResponse { deltas: Vec::new() });
    }

    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    sync_plugin_runtime_and_mark_dirty(
        project_state,
        &clip_pool_state,
        &plugin_host_state,
        &handle,
        &app,
        false,
    )?;
    log::info!("[IPC] move_effect_slot_with_deltas_cmd(track={track_id}, slot={slot_id} → {target_index})");

    Ok(PluginMutationDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::PluginMoved {
            track_id: result.track_id,
            slot_id: slot_uuid,
            old_slot_index: result.old_slot_index,
            new_slot_index: result.new_slot_index,
        }],
    })
}


include!("device_clipboard_commands.rs");
