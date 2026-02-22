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
    let normalized_target = dream_orchestrator::commands::normalize_plugin_target_for_add(
        &payload.plugin_id,
        &payload.plugin_name,
    );
    let effective_plugin_id = normalized_target.plugin_id;
    let effective_plugin_name = normalized_target.plugin_name;
    let canonical_slot_hint = normalized_target.canonical_slot_hint;
    
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
        canonical_slot_hint.as_deref(),
        external_audio_inputs,
        external_supports_sidechain_input,
    )
    .map_err(|e| e.to_string())?;
    let cmd_result = execute_orchestrator_command(&project_state, &cmd)?;
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
    
    let plugin_load_error = load_external_slot_best_effort(
        new_slot_id,
        &effective_plugin_id,
        &effective_plugin_name,
        &plugin_host_state,
        "add_plugin_to_track_cmd",
    );
    
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
    let runtime_remove_slot =
        execute_orchestrator_command(&project_state, &cmd)?.runtime_remove_slot;
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
    let result = execute_orchestrator_command(&project_state, &cmd)?;
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

#[tauri::command]
fn set_internal_plugin_param_with_deltas_cmd(
    payload: InternalPluginParamPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<PluginMutationDeltaResponse, String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let slot_uuid = Uuid::parse_str(&payload.slot_id)
        .map_err(|_| format!("Invalid slot_id: {}", payload.slot_id))?;
    let param_id = payload.param_id.clone();
    let value = payload.value;

    set_internal_plugin_param_cmd(
        payload,
        project_state,
        clip_pool_state,
        automation_runtime,
        handle,
        app,
    )?;

    Ok(PluginMutationDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::InternalPluginParamChanged {
            track_id: track_uuid,
            slot_id: slot_uuid,
            param_id,
            value,
        }],
    })
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
