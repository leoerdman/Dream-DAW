// ═══════════════════════════════════════════════════════════════════════


/// Adds a built-in DSP device to a track's insert chain.
#[tauri::command]
fn add_device_cmd(
    track_index: u16,
    slot_index: u8,
    effect_type: u8,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(
        &handle,
        EngineCommand::AddDevice {
            track_index,
            slot_index,
            effect_type,
        },
    )?;
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
#[tauri::command]
fn bypass_device_cmd(
    track_index: u16,
    slot_index: u8,
    bypassed: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
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
        push_command(
            &handle,
            EngineCommand::BypassDevice {
                track_index,
                slot_index: resolved_slot,
                bypassed,
            },
        )?;
        log::debug!("[IPC] bypass_device(track={track_index}, raw_slot={slot_index}, engine_slot={resolved_slot}, bypassed={bypassed})");
    } else {
        log::debug!("[IPC] bypass_device(track={track_index}, slot={slot_index}) — skipped (not an internal effect)");
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
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
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

/// Batch update a track's state (volume, pan, mute, solo).
#[tauri::command]
fn update_track(
    update: TrackStateUpdate,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
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

    if let Some(muted) = update.muted {
        let result = execute_orchestrator_command(
            &project_state,
            &dream_orchestrator::commands::SetTrackMuteByIndexCommand {
                track_index: update.track_index,
                muted,
            },
        )?;
        if let Err(e) = push_command(
            &handle,
            EngineCommand::SetTrackMute {
                track_index: update.track_index,
                muted: result.muted,
            },
        ) {
            log::error!("[update_track] SetTrackMute dropped: {e}");
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
