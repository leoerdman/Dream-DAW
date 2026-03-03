#[derive(Debug, Clone)]
struct AddedPluginOutcome {
    track_id: Uuid,
    slot_id: Uuid,
    slot_index: usize,
    is_instrument: bool,
    plugin_name: String,
    plugin_uid: String,
}

fn is_runtime_unsupported_external_id(plugin_id: &str) -> bool {
    let trimmed = plugin_id.trim().trim_end_matches(['/', '\\']);
    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("vst2:")
        || lower.ends_with(".vst")
        || lower.starts_with("clap:")
        || lower.ends_with(".clap")
}

fn add_plugin_to_track_impl(
    payload: AddPluginToTrackPayload,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<AddedPluginOutcome, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let track_id = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;

    push_undo(&project_state)?;

    let slot = payload.slot.to_lowercase();
    let normalized_target = dream_orchestrator::commands::normalize_plugin_target_for_add(
        &payload.plugin_id,
        &payload.plugin_name,
    );
    let mut effective_plugin_id = normalized_target.plugin_id;
    let mut effective_plugin_name = normalized_target.plugin_name;
    let canonical_slot_hint = normalized_target.canonical_slot_hint;
    
    let mut external_audio_inputs = None;
    let mut external_supports_sidechain_input = None;
    let mut external_plugin_format: Option<PluginFormat> = None;
    if !effective_plugin_id.starts_with("internal://") {
        if let Ok(desc) = plugin_host_state.resolve_descriptor(&effective_plugin_id) {
            // Canonicalize to runtime-resolved descriptor path. This allows
            // AU/alias/plugin-name inputs to settle onto a concrete VST runtime ID.
            effective_plugin_id = desc.path.to_string_lossy().to_string();
            effective_plugin_name = desc.name.clone();
            external_plugin_format = Some(desc.format);
            external_audio_inputs = Some(desc.audio_inputs);
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
    .map_err(|e| e.to_string())?
    .with_insert_index(payload.insert_index);
    let cmd_result = execute_orchestrator_command(&project_state, &cmd)?;
    let new_slot_id = cmd_result.slot_id;
    let use_instrument = cmd_result.placed_as_instrument;
    let track_index = cmd_result.track_index as u16;
    // BUG-1 FIX: slot_index for PluginAdded delta must be the FLAT effect
    // array position (including both internal and external plugins), NOT the
    // runtime-internal-only index. The frontend uses this index to splice into
    // track.effects[] which is a flat array of all effect slots.
    let slot_index = if use_instrument {
        0
    } else {
        // Find the flat position of the newly inserted slot by scanning the
        // post-mutation project effects array.
        let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        project
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .and_then(|t| {
                t.effects
                    .iter()
                    .position(|node| node.id() == new_slot_id)
            })
            .unwrap_or(0)
    };

    let mut runtime_add: Option<(u16, u8, u8)> = None;
    if effective_plugin_id.starts_with("internal://")
        && let Some(effect_type) = builtin_effect_type_from_plugin_id(&effective_plugin_id)
        && let Some(internal_slot_index) = cmd_result.runtime_effect_slot_index
    {
        runtime_add = Some((track_index, internal_slot_index, effect_type));
    }
    let _runtime_waveform = cmd_result
        .runtime_waveform_code
        .map(|waveform| (track_index, waveform));

    let plugin_load_error = load_external_slot_best_effort(
        new_slot_id,
        &effective_plugin_id,
        &effective_plugin_name,
        None, // Newly added plugin — no imported state blob to restore
        &plugin_host_state,
        "add_plugin_to_track_cmd",
    );
    
    if let Some((runtime_track_index, runtime_slot_index, effect_type)) = runtime_add {
        push_prealloc_device(&handle, runtime_track_index, runtime_slot_index, effect_type)?;
    }
    

    
    log::info!(
        "[IPC] add_plugin_to_track_cmd(track={}, plugin='{}', slot={})",
        payload.track_id,
        effective_plugin_name,
        if use_instrument { "instrument" } else { "effect" }
    );
    sync_plugin_runtime_and_mark_dirty(
        project_state,
        &clip_pool_state,
        &plugin_host_state,
        &handle,
        &app,
        true,
    )?;
    
    if let Some(err_msg) = plugin_load_error {
        // CLAP descriptors are still allowed to be inserted into the
        // project graph even when runtime loading is unavailable in this build.
        // This prevents DnD from silently failing and keeps the device chain
        // state visible/editable instead of rolling back the mutation.
        let runtime_unsupported = matches!(
            external_plugin_format,
            Some(PluginFormat::CLAP)
        ) || (external_plugin_format.is_none()
            && is_runtime_unsupported_external_id(&effective_plugin_id));
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

fn normalize_scoped_internal_param_id(slot_id: Uuid, param_id: &str) -> Result<String, String> {
    let trimmed = param_id.trim();
    if trimmed.is_empty() {
        return Err("param_id cannot be empty".to_string());
    }

    let mut parts = trimmed.splitn(3, ':');
    let first = parts.next().unwrap_or_default();
    let second = parts.next().unwrap_or_default();
    let third = parts.next().unwrap_or_default();

    if first.eq_ignore_ascii_case("slot") {
        let scoped_slot = Uuid::parse_str(second)
            .map_err(|_| format!("Invalid scoped slot in param_id: {param_id}"))?;
        if scoped_slot != slot_id {
            return Err(format!(
                "Scoped param_id slot mismatch: payload slot={} param slot={}",
                slot_id, scoped_slot
            ));
        }
        if third.trim().is_empty() {
            return Err(format!("Invalid scoped param_id (missing parameter key): {param_id}"));
        }
        return Ok(format!("slot:{slot_id}:{}", third.trim()));
    }

    Ok(format!("slot:{slot_id}:{trimmed}"))
}

/// Add a plugin slot to a track (instrument/effect) from frontend DnD.
#[tauri::command]
fn add_plugin_to_track_cmd(
    payload: AddPluginToTrackPayload,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let _ = add_plugin_to_track_impl(
        payload,
        project_registry.clone(),
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<PluginMutationDeltaResponse, String> {
    let result = add_plugin_to_track_impl(
        payload,
        project_registry.clone(),
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
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
        project_registry.clone(),
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
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
        project_state,
        &clip_pool_state,
        &plugin_host_state,
        &handle,
        &app,
        true,
    )?;
    Ok(())
}

/// Set internal plugin parameter value and route to engine state/snapshots.
#[tauri::command]
fn set_internal_plugin_param_cmd(
    payload: InternalPluginParamPayload,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let slot_uuid = Uuid::parse_str(&payload.slot_id)
        .map_err(|_| format!("Invalid slot_id: {}", payload.slot_id))?;
    let slot_state = execute_orchestrator_query(
        project_state,
        &dream_orchestrator::queries::ResolvePluginSlotStateQuery {
            track_id: track_uuid,
            slot_id: slot_uuid,
        },
    )?;
    if !slot_state.plugin_id.starts_with("internal://") {
        return Err(format!(
            "set_internal_plugin_param_cmd expects internal plugin slot, got '{}'",
            slot_state.plugin_id
        ));
    }
    let scoped_param_id = normalize_scoped_internal_param_id(slot_uuid, &payload.param_id)?;
    let should_commit_snapshot = payload.push_undo_step.unwrap_or(true);
    if should_commit_snapshot {
        push_undo(&project_state)?;
    }
    let cmd = dream_orchestrator::commands::SetInternalPluginParamCommand::from_str_track_id(
        &payload.track_id,
        scoped_param_id.clone(),
        payload.value,
    )
    .map_err(|e| e.to_string())?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    let track_index = result.track_index;
    let sampler_command_needed = result.sampler_command_needed;
    let sampler_cfg_for_rt = result.sampler_cfg_for_rt;

    finalize_internal_param_update(
        project_state,
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

    // ── Essence Synth param dispatch ──────────────────────────────────
    // Map orchestrator result fields to standalone SetEssence* commands.
    let eidx = track_index as u16;
    if let Some(wf) = result.sampler_waveform {
        push_command(&handle, EngineCommand::SetEssenceWaveform1 { track_index: eidx, waveform: wf })?;
    }
    if let Some(wf2) = result.sampler_waveform2 {
        push_command(&handle, EngineCommand::SetEssenceWaveform2 { track_index: eidx, waveform: wf2 })?;
    }
    if let Some(vol) = result.sampler_osc1_volume {
        push_command(&handle, EngineCommand::SetEssenceOsc1Volume { track_index: eidx, volume: vol })?;
    }
    if let Some(vol) = result.sampler_osc2_volume {
        push_command(&handle, EngineCommand::SetEssenceOsc2Volume { track_index: eidx, volume: vol })?;
    }
    if let Some(enabled) = result.sampler_osc1_enabled {
        push_command(&handle, EngineCommand::SetEssenceOsc1Enabled { track_index: eidx, enabled })?;
    }
    if let Some(enabled) = result.sampler_osc2_enabled {
        push_command(&handle, EngineCommand::SetEssenceOsc2Enabled { track_index: eidx, enabled })?;
    }
    if let Some(cents) = result.sampler_detune_cents {
        push_command(&handle, EngineCommand::SetEssenceDetuneCents { track_index: eidx, cents })?;
    }
    if let Some(level) = result.sampler_sub_level {
        push_command(&handle, EngineCommand::SetEssenceSubLevel { track_index: eidx, level })?;
    }
    if let Some(pw) = result.sampler_pulse_width {
        push_command(&handle, EngineCommand::SetEssencePulseWidth { track_index: eidx, width: pw })?;
    }
    if let Some(cutoff) = result.sampler_filter_cutoff {
        push_command(&handle, EngineCommand::SetEssenceFilterCutoff { track_index: eidx, cutoff })?;
    }
    if let Some(res) = result.sampler_filter_resonance {
        push_command(&handle, EngineCommand::SetEssenceFilterResonance { track_index: eidx, resonance: res })?;
    }
    if let Some(ft) = result.sampler_filter_type {
        push_command(&handle, EngineCommand::SetEssenceFilterType { track_index: eidx, filter_type: ft })?;
    }
    if let Some(rate) = result.sampler_lfo_rate {
        push_command(&handle, EngineCommand::SetEssenceLfoRate { track_index: eidx, rate })?;
    }
    if let Some(depth) = result.sampler_lfo_depth {
        push_command(&handle, EngineCommand::SetEssenceLfoDepth { track_index: eidx, depth })?;
    }
    if let Some(target) = result.sampler_lfo_target {
        push_command(&handle, EngineCommand::SetEssenceLfoTarget { track_index: eidx, target })?;
    }
    // Essence ADSR: also set via the synth.attack/decay/sustain/release keys
    // which are handled by sampler_command_needed (above). Forward to Essence too.
    if sampler_command_needed
        && let Some(cfg) = &sampler_cfg_for_rt
    {
        push_command(&handle, EngineCommand::SetEssenceAdsr {
            track_index: eidx,
            attack: cfg.attack as f32,
            decay: cfg.decay as f32,
            sustain: cfg.sustain as f32,
            release: cfg.release as f32,
        })?;
        push_command(&handle, EngineCommand::SetEssenceVolume {
            track_index: eidx,
            volume: cfg.volume as f32,
        })?;
    }

    log::debug!(
        "[IPC] set_internal_plugin_param_cmd(track={}, slot={}, param={} value={})",
        payload.track_id,
        payload.slot_id,
        scoped_param_id,
        payload.value
    );
    Ok(())
}

#[tauri::command]
fn set_internal_plugin_param_with_deltas_cmd(
    payload: InternalPluginParamPayload,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<PluginMutationDeltaResponse, String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let slot_uuid = Uuid::parse_str(&payload.slot_id)
        .map_err(|_| format!("Invalid slot_id: {}", payload.slot_id))?;
    let scoped_param_id = normalize_scoped_internal_param_id(slot_uuid, &payload.param_id)?;
    let param_id = scoped_param_id.clone();
    let value = payload.value;

    set_internal_plugin_param_cmd(
        InternalPluginParamPayload {
            param_id: scoped_param_id,
            ..payload
        },
        project_registry.clone(),
        clip_pool_state,
        automation_runtime,
        handle,
        app,
    )?;

    let deltas = vec![dream_models::delta::ProjectDelta::InternalPluginParamChanged {
        track_id: track_uuid,
        slot_id: slot_uuid,
        param_id,
        value,
    }];

    Ok(PluginMutationDeltaResponse { deltas })
}

#[tauri::command]
fn set_internal_plugin_param_batch_with_deltas_cmd(
    payload: crate::commands::payloads::InternalPluginParamBatchPayload,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<PluginMutationDeltaResponse, String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let slot_uuid = Uuid::parse_str(&payload.slot_id)
        .map_err(|_| format!("Invalid slot_id: {}", payload.slot_id))?;

    let mut deltas = Vec::new();
    let should_commit = payload.push_undo_step.unwrap_or(true);
    let mut is_first = true;

    for update in payload.updates {
        let scoped_param_id = normalize_scoped_internal_param_id(slot_uuid, &update.param_id)?;
        let param_id = scoped_param_id.clone();
        let value = update.value;

        set_internal_plugin_param_cmd(
            InternalPluginParamPayload {
                track_id: payload.track_id.clone(),
                slot_id: payload.slot_id.clone(),
                param_id: scoped_param_id,
                value,
                push_undo_step: Some(is_first && should_commit),
            },
            project_registry.clone(),
            clip_pool_state.clone(),
            automation_runtime.clone(),
            handle.clone(),
            app.clone(),
        )?;

        is_first = false;

        deltas.push(dream_models::delta::ProjectDelta::InternalPluginParamChanged {
            track_id: track_uuid,
            slot_id: slot_uuid,
            param_id,
            value,
        });
    }

    Ok(PluginMutationDeltaResponse { deltas })
}
