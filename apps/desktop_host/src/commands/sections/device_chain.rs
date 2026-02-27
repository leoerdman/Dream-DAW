// ═══════════════════════════════════════════════════════════════════════
const MASTER_TRACK_INDEX: u16 = u16::MAX;

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeParamUpdate {
    param_index: u8,
    value: f32,
}

fn selected_runtime_chain(
    rack: &dream_models::project::DeviceRack,
) -> Option<&dream_models::project::RackChain> {
    let has_solo = rack.chains.iter().any(|c| c.is_solo);
    if has_solo {
        rack.chains.iter().find(|c| c.is_solo && !c.is_disabled)
    } else {
        rack.chains.iter().find(|c| !c.is_disabled)
    }
}

fn count_runtime_internal_effects(node: &DeviceNode) -> usize {
    match node {
        DeviceNode::Single(slot) => usize::from(
            dream_models::project::builtin_effect_type_from_plugin_id(&slot.plugin_id).is_some(),
        ),
        DeviceNode::Rack(rack) => selected_runtime_chain(rack)
            .map(|chain| chain.devices.iter().map(count_runtime_internal_effects).sum())
            .unwrap_or(0),
    }
}

fn raw_slot_to_internal_device_index_track(
    track: &dream_models::project::Track,
    raw_slot_index: u8,
) -> Option<u8> {
    let raw = raw_slot_index as usize;
    let target = track.effects.get(raw)?;
    let preceding_internal = track.effects[..raw]
        .iter()
        .map(count_runtime_internal_effects)
        .sum::<usize>();
    match target {
        DeviceNode::Single(slot)
            if dream_models::project::builtin_effect_type_from_plugin_id(&slot.plugin_id)
                .is_some() =>
        {
            Some(preceding_internal as u8)
        }
        _ => None,
    }
}

fn raw_slot_to_internal_device_index_master(
    master_track: &dream_models::project::Track,
    raw_slot_index: u8,
) -> Option<u8> {
    let raw = raw_slot_index as usize;
    let target = master_track.effects.get(raw)?;
    let preceding_internal = master_track.effects[..raw]
        .iter()
        .map(count_runtime_internal_effects)
        .sum::<usize>();
    match target {
        DeviceNode::Single(slot)
            if dream_models::project::builtin_effect_type_from_plugin_id(&slot.plugin_id)
                .is_some() =>
        {
            Some(preceding_internal as u8)
        }
        _ => None,
    }
}

fn resolve_internal_runtime_slot(
    project: &dream_models::project::Project,
    track_index: u16,
    slot_index: u8,
) -> Option<u8> {
    if track_index == MASTER_TRACK_INDEX {
        raw_slot_to_internal_device_index_master(&project.master_track, slot_index)
    } else {
        project
            .tracks
            .get(track_index as usize)
            .and_then(|track| raw_slot_to_internal_device_index_track(track, slot_index))
    }
}


/// Adds a built-in DSP device to a track's insert chain.
///
/// **RT-Safe**: The processor is pre-constructed on this (IPC) thread and
/// transferred to the audio thread via the lock-free SPSC prealloc queue.
/// The audio thread never calls `malloc()` for device construction.
#[tauri::command]
fn add_device_cmd(
    track_index: u16,
    slot_index: u8,
    effect_type: u8,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    use dream_dsp::dsp_processor::BuiltinEffectType;
    use dream_dsp::device_slot::InternalDeviceSlot;
    use dream_ipc::prealloc_queue::PrebuiltDevice;

    let etype = BuiltinEffectType::from_u8(effect_type)
        .ok_or_else(|| format!("Invalid effect_type: {effect_type}"))?;

    // Get sample rate from playback state for processor construction.
    let sample_rate = handle
        .playback_state
        .lock()
        .map(|s| s.sample_rate as f32)
        .unwrap_or(44_100.0);

    // Pre-construct as InternalDeviceSlot (wraps DspProcessor → DeviceProcessor).
    let device = InternalDeviceSlot::new(etype, sample_rate);

    // Push via the lock-free prealloc queue (zero-alloc on the audio thread).
    let prebuilt = PrebuiltDevice {
        track_index,
        slot_index,
        device: Box::new(device),
    };
    let mut producer = handle
        .prealloc_producer
        .lock()
        .map_err(|e| format!("prealloc lock poisoned: {e}"))?;
    if let Err(_) = producer.push(prebuilt) {
        // Queue full — fall back to legacy path (allocates on RT thread).
        drop(producer);
        log::warn!(
            "[IPC] prealloc queue full, falling back to legacy AddDevice (RT allocation!)"
        );
        push_command(
            &handle,
            EngineCommand::AddDevice {
                track_index,
                slot_index,
                effect_type,
            },
        )?;
    }

    log::info!("[IPC] add_device(track={track_index}, slot={slot_index}, type={effect_type})");
    Ok(())
}

/// Removes a device from a track's insert chain.
#[tauri::command]
fn remove_device_cmd(
    track_index: u16,
    slot_index: u8,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(
        &handle,
        EngineCommand::RemoveDevice {
            track_index,
            slot_index,
        },
    )?;
    log::info!("[IPC] remove_device(track={track_index}, slot={slot_index})");
    Ok(())
}

/// Bypasses or enables a device in a track's insert chain.
///
/// BUG-027 FIX: Persists bypass to project model.
/// BUG-ROUTING FIX: Converts raw slot_index to internal-only device_chain index.
/// BUG-R3 FIX: Handles master track (MASTER_TRACK_INDEX=65535) via project.master_track.
/// BUG-BYPASS-INST FIX: Routes instrument bypass (slot 255) to BypassInstrument command
///     instead of BypassDevice, which silently failed because DeviceChain max = 16 slots.
#[tauri::command]
fn bypass_device_cmd(
    track_index: u16,
    slot_index: u8,
    bypassed: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    const INSTRUMENT_SLOT_INDEX: u8 = 255;

    let cmd = dream_orchestrator::commands::SetInternalDeviceBypassByTrackIndexCommand {
        track_index,
        slot_index,
        bypassed,
    };
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    let project_name = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .name
        .clone();
    project_state.mark_dirty(&project_name, Some(&app))?;

    if let Some(resolved_slot) = result.engine_slot_index {
        // BUG-BYPASS-INST FIX: Instrument slot (255) must be routed to BypassInstrument,
        // NOT BypassDevice — DeviceChain has max 16 slots so set_bypass(255, ...) is a no-op.
        if resolved_slot == INSTRUMENT_SLOT_INDEX && track_index != MASTER_TRACK_INDEX {
            push_command(
                &handle,
                EngineCommand::BypassInstrument {
                    track_index,
                    bypassed,
                },
            )?;
            log::info!("[IPC] bypass_instrument(track={track_index}, bypassed={bypassed})");
        } else {
            push_command(
                &handle,
                EngineCommand::BypassDevice {
                    track_index,
                    slot_index: resolved_slot,
                    bypassed,
                },
            )?;
            log::debug!("[IPC] bypass_device(track={track_index}, raw_slot={slot_index}, engine_slot={resolved_slot}, bypassed={bypassed})");
        }
    } else {
        log::debug!("[IPC] bypass_device(track={track_index}, slot={slot_index}) — skipped engine cmd (external plugin, bypass persisted to project)");
    }
    Ok(())
}

/// Sets a parameter on a device in a track's insert chain.
///
/// BUG-070 FIX: Persists params to project model.
/// BUG-ROUTING FIX: Converts raw slot_index to internal-only device_chain index.
/// BUG-R2 FIX: Handles master track (MASTER_TRACK_INDEX=65535) via project.master_track.
#[tauri::command]
fn set_device_param_cmd(
    track_index: u16,
    slot_index: u8,
    param_index: u8,
    value: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let cmd = dream_orchestrator::commands::SetInternalDeviceParamByTrackIndexCommand {
        track_index,
        slot_index,
        param_index,
        value,
    };
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    let project_name = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .name
        .clone();

    project_state.mark_dirty(&project_name, Some(&app))?;

    if let Some(resolved_slot) = result.engine_slot_index {
        push_command(
            &handle,
            EngineCommand::SetDeviceParam {
                track_index,
                slot_index: resolved_slot,
                param_index,
                value: result.value,
            },
        )?;
        log::debug!("[IPC] set_device_param(track={track_index}, raw_slot={slot_index}, engine_slot={resolved_slot}, param={param_index}, val={})", result.value);
    } else {
        log::debug!("[IPC] set_device_param(track={track_index}, slot={slot_index}) — skipped (not an internal effect)");
    }
    Ok(())
}

/// Sets a device parameter for realtime monitoring only (no project mutation).
///
/// This command is used during high-frequency UI gestures (e.g. EQ drag) to
/// avoid project lock/dirty churn per mouse event. Persistence/undo is handled
/// separately by with_deltas commit commands at gesture end.
#[tauri::command]
fn set_device_param_runtime_cmd(
    track_index: u16,
    slot_index: u8,
    param_index: u8,
    value: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let resolved_slot = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        resolve_internal_runtime_slot(&project, track_index, slot_index)
    };

    if let Some(resolved_slot) = resolved_slot {
        push_command(
            &handle,
            EngineCommand::SetDeviceParam {
                track_index,
                slot_index: resolved_slot,
                param_index,
                value,
            },
        )?;
    }
    Ok(())
}

/// Sets multiple device parameters for realtime monitoring only (no project mutation).
///
/// Batched variant of `set_device_param_runtime_cmd` used to coalesce frequent
/// UI gesture updates (e.g. EQ Freq+Q drag) into a single IPC round-trip.
#[tauri::command]
fn set_device_params_runtime_cmd(
    track_index: u16,
    slot_index: u8,
    updates: Vec<RuntimeParamUpdate>,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    if updates.is_empty() {
        return Ok(());
    }
    let resolved_slot = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        resolve_internal_runtime_slot(&project, track_index, slot_index)
    };
    if let Some(resolved_slot) = resolved_slot {
        for update in updates {
            push_command(
                &handle,
                EngineCommand::SetDeviceParam {
                    track_index,
                    slot_index: resolved_slot,
                    param_index: update.param_index,
                    value: update.value,
                },
            )?;
        }
    }
    Ok(())
}

/// Batch update a track's state (volume, pan, mute, solo).
#[tauri::command]
fn update_track(
    update: TrackStateUpdate,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    if let Some(vol) = update.volume {
        let result = execute_orchestrator_command(
            &project_state,
            &dream_orchestrator::commands::SetTrackVolumeByIndexCommand {
                track_index: update.track_index,
                volume: vol,
            },
        )?;
        if let Err(e) = push_command(
            &handle,
            EngineCommand::SetTrackVolume {
                track_index: update.track_index,
                volume: result.volume,
            },
        ) {
            log::error!("[update_track] SetTrackVolume dropped: {e}");
        }
    }

    if let Some(pan) = update.pan {
        let result = execute_orchestrator_command(
            &project_state,
            &dream_orchestrator::commands::SetTrackPanByIndexCommand {
                track_index: update.track_index,
                pan,
            },
        )?;
        if let Err(e) = push_command(
            &handle,
            EngineCommand::SetTrackPan {
                track_index: update.track_index,
                pan: result.pan,
            },
        ) {
            log::error!("[update_track] SetTrackPan dropped: {e}");
        }
    }

    if let Some(disabled) = update.disabled {
        let result = execute_orchestrator_command(
            &project_state,
            &dream_orchestrator::commands::SetTrackDisabledByIndexCommand {
                track_index: update.track_index,
                disabled,
            },
        )?;
        if let Err(e) = push_command(
            &handle,
            EngineCommand::SetTrackDisabled {
                track_index: update.track_index,
                disabled: result.disabled,
            },
        ) {
            log::error!("[update_track] SetTrackDisabled dropped: {e}");
        }
    }

    if let Some(soloed) = update.soloed {
        let result = execute_orchestrator_command(
            &project_state,
            &dream_orchestrator::commands::SetTrackSoloByIndexCommand {
                track_index: update.track_index,
                soloed,
            },
        )?;
        if let Err(e) = push_command(
            &handle,
            EngineCommand::SetTrackSolo {
                track_index: update.track_index,
                soloed: result.soloed,
            },
        ) {
            log::error!("[update_track] SetTrackSolo dropped: {e}");
        }
    }

    let project_name = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        project.name.clone()
    };

    project_state.mark_dirty(&project_name, Some(&app))?;
    log::debug!("[IPC] update_track(track={})", update.track_index);
    Ok(())
}
