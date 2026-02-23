#[derive(Debug, Clone)]
struct AddedPluginOutcome {
    track_id: Uuid,
    slot_id: Uuid,
    slot_index: usize,
    is_instrument: bool,
    plugin_name: String,
    plugin_uid: String,
}

fn add_plugin_to_track_impl(
    payload: AddPluginToTrackPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<AddedPluginOutcome, String> {
    let track_id = Uuid::parse_str(&payload.track_id)
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
    let mut external_plugin_format: Option<PluginFormat> = None;
    if !effective_plugin_id.starts_with("internal://")
        && let Ok(desc) = plugin_host_state.resolve_descriptor(&effective_plugin_id)
    {
        external_plugin_format = Some(desc.format);
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
    let track_index = cmd_result.track_index as u16;
    let slot_index = if use_instrument {
        0
    } else {
        usize::from(cmd_result.runtime_effect_slot_index.unwrap_or(0))
    };

    let mut runtime_add: Option<(u16, u8, u8)> = None;
    if effective_plugin_id.starts_with("internal://")
        && let Some(effect_type) = builtin_effect_type_from_plugin_id(&effective_plugin_id)
        && let Some(internal_slot_index) = cmd_result.runtime_effect_slot_index
    {
        runtime_add = Some((track_index, internal_slot_index, effect_type));
    }
    let runtime_waveform = cmd_result
        .runtime_waveform_code
        .map(|waveform| (track_index, waveform));

    let plugin_load_error = load_external_slot_best_effort(
        new_slot_id,
        &effective_plugin_id,
        &effective_plugin_name,
        &plugin_host_state,
        "add_plugin_to_track_cmd",
    );
    
    if let Some((runtime_track_index, runtime_slot_index, effect_type)) = runtime_add {
        push_command(&handle, EngineCommand::AddDevice {
            track_index: runtime_track_index,
            slot_index: runtime_slot_index,
            effect_type,
        })?;
    }
    
    if let Some((runtime_track_index, waveform)) = runtime_waveform {
        push_command(&handle, EngineCommand::SetSamplerWaveform {
            track_index: runtime_track_index,
            waveform,
        })?;
    }
    
    log::info!(
        "[IPC] add_plugin_to_track_cmd(track={}, plugin='{}', slot={})",
        payload.track_id,
        effective_plugin_name,
        if use_instrument { "instrument" } else { "effect" }
    );
    sync_plugin_runtime_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &plugin_host_state,
        &app,
        true,
    )?;
    
    if let Some(err_msg) = plugin_load_error {
        // AU/CLAP/VST2 descriptors are still allowed to be inserted into the
        // project graph even when runtime loading is unavailable in this build.
        // This prevents DnD from silently failing and keeps the device chain
        // state visible/editable instead of rolling back the mutation.
        let runtime_unsupported = matches!(
            external_plugin_format,
            Some(PluginFormat::AudioUnit | PluginFormat::CLAP | PluginFormat::VST2)
        );
        if runtime_unsupported {
            log::warn!(
                "[IPC] add_plugin_to_track_cmd: inserted unsupported runtime plugin '{}' (id='{}'): {}",
                effective_plugin_name,
                effective_plugin_id,
                err_msg
            );
        } else {
            return Err(err_msg);
        }
    }

    Ok(AddedPluginOutcome {
        track_id,
        slot_id: new_slot_id,
        slot_index,
        is_instrument: use_instrument,
        plugin_name: effective_plugin_name,
        plugin_uid: effective_plugin_id,
    })
}

#[derive(Debug, Serialize, Deserialize)]
struct PluginMutationDeltaResponse {
    deltas: Vec<dream_models::delta::ProjectDelta>,
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
    let _ = add_plugin_to_track_impl(
        payload,
        project_state,
        clip_pool_state,
        handle,
        plugin_host_state,
        app,
    )?;
    Ok(())
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
    let result = add_plugin_to_track_impl(
        payload,
        project_state,
        clip_pool_state,
        handle,
        plugin_host_state,
        app,
    )?;

    Ok(PluginMutationDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::PluginAdded {
            track_id: result.track_id,
            slot_id: result.slot_id,
            slot_index: result.slot_index,
            is_instrument: result.is_instrument,
            plugin_name: result.plugin_name,
            plugin_uid: result.plugin_uid,
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
    let slot_uuid = Uuid::parse_str(&payload.slot_id)
        .map_err(|_| format!("Invalid slot_id: {}", payload.slot_id))?;

    push_undo(&project_state)?;
    let cmd = dream_orchestrator::commands::RemovePluginFromTrackCommand::from_str_ids(
        &payload.track_id,
        &payload.slot_id,
    )
    .map_err(|e| e.to_string())?;
    let cmd_result = execute_orchestrator_command(&project_state, &cmd)?;
    let runtime_remove_slot = cmd_result.runtime_remove_slot;
    let runtime_track_index = cmd_result.track_index as u16;
    let _ = plugin_host_state.unload_slot_instance(slot_uuid);
    
    if let Some(slot_index) = runtime_remove_slot {
        push_command(&handle, EngineCommand::RemoveDevice {
            track_index: runtime_track_index,
            slot_index,
        })?;
    }
    
    log::info!(
        "[IPC] remove_plugin_from_track_cmd(track={}, slot={})",
        payload.track_id,
        payload.slot_id
    );
    sync_plugin_runtime_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &plugin_host_state,
        &app,
        true,
    )?;
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

    finalize_internal_param_update(
        &project_state,
        &clip_pool_state,
        &automation_runtime,
        &handle,
        &app,
        should_commit_snapshot,
    )?;

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
    let slot_uuid = Uuid::parse_str(&payload.slot_id).ok();
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

    let deltas = if let Some(slot_id) = slot_uuid {
        vec![dream_models::delta::ProjectDelta::InternalPluginParamChanged {
            track_id: track_uuid,
            slot_id,
            param_id,
            value,
        }]
    } else {
        Vec::new()
    };

    Ok(PluginMutationDeltaResponse { deltas })
}
