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
    .map_err(|e| e.to_string())?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    let (track_index, sampler_cfg) = (result.track_index, result.sampler_cfg);

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
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
    push_command(
        &handle,
        EngineCommand::SetSamplerOsc2Waveform {
            track_index: idx,
            waveform: sampler_cfg.osc2_waveform.min(3),
        },
    )?;
    push_command(
        &handle,
        EngineCommand::SetSamplerOscMix {
            track_index: idx,
            mix: sampler_cfg.osc_mix.clamp(0.0, 1.0) as f32,
        },
    )?;
    push_command(
        &handle,
        EngineCommand::SetSamplerDetuneCents {
            track_index: idx,
            cents: sampler_cfg.detune_cents.clamp(-50.0, 50.0) as f32,
        },
    )?;
    push_command(
        &handle,
        EngineCommand::SetSamplerSubLevel {
            track_index: idx,
            level: sampler_cfg.sub_level.clamp(0.0, 1.0) as f32,
        },
    )?;
    push_command(
        &handle,
        EngineCommand::SetSamplerFilterCutoff {
            track_index: idx,
            cutoff: sampler_cfg.filter_cutoff.clamp(20.0, 20000.0) as f32,
        },
    )?;
    push_command(
        &handle,
        EngineCommand::SetSamplerFilterResonance {
            track_index: idx,
            resonance: sampler_cfg.filter_resonance.clamp(0.0, 0.99) as f32,
        },
    )?;
    push_command(
        &handle,
        EngineCommand::SetSamplerFilterType {
            track_index: idx,
            filter_type: sampler_cfg.filter_type.min(3),
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
    let external_slots = collect_external_slot_refs(&project);

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

    sync_external_fx_snapshot(&project, &clip_pool_state, &plugin_host_state);

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
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    log::info!(
        "[IPC] set_slot_bypass_cmd(track={}, slot={}, bypassed={}, is_instrument={}) plugin={}",
        track_id, slot_id, bypassed, result.is_instrument, result.plugin_id
    );

    sync_plugin_runtime_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &plugin_host_state,
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
    execute_orchestrator_command(&project_state, &cmd)?;

    // Rebuild FX snapshot so the audio engine picks up the new order
    sync_plugin_runtime_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &plugin_host_state,
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
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    sync_plugin_runtime_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &plugin_host_state,
        &app,
        false,
    )?;
    log::info!("[IPC] move_effect_slot_with_deltas_cmd(track={track_id}, slot={slot_id} → {target_index})");

    let _ = handle;

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
