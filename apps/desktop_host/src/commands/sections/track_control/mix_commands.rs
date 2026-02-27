#[derive(Debug, Serialize, Deserialize)]
struct TrackDeltaResponse {
    deltas: Vec<dream_models::delta::ProjectDelta>,
}

/// Sets a track's volume (linear gain 0.0–12.0, SSOT with ChannelStrip MAX_VOLUME).
#[tauri::command]
fn set_track_volume(
    track_index: u16,
    volume: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetTrackVolumeByIndexCommand { track_index, volume };
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    push_command(
        &handle,
        EngineCommand::SetTrackVolume {
            track_index,
            volume: result.volume,
        },
    )?;

    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::debug!(
        "[IPC] set_track_volume(track={track_index}, vol={})",
        result.volume
    );
    Ok(())
}

#[tauri::command]
fn set_track_volume_with_deltas(
    track_index: u16,
    volume: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<TrackDeltaResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetTrackVolumeByIndexCommand { track_index, volume };
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    push_command(
        &handle,
        EngineCommand::SetTrackVolume {
            track_index,
            volume: result.volume,
        },
    )?;

    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(TrackDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackVolumeChanged {
            track_id: result.track_id,
            volume: result.volume,
        }],
    })
}

/// Sets a track's pan position (-1.0 to 1.0).
#[tauri::command]
fn set_track_pan(
    track_index: u16,
    pan: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetTrackPanByIndexCommand { track_index, pan };
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    push_command(
        &handle,
        EngineCommand::SetTrackPan {
            track_index,
            pan: result.pan,
        },
    )?;

    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::debug!(
        "[IPC] set_track_pan(track={track_index}, pan={})",
        result.pan
    );
    Ok(())
}

#[tauri::command]
fn set_track_pan_with_deltas(
    track_index: u16,
    pan: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<TrackDeltaResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetTrackPanByIndexCommand { track_index, pan };
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    push_command(
        &handle,
        EngineCommand::SetTrackPan {
            track_index,
            pan: result.pan,
        },
    )?;

    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(TrackDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackPanChanged {
            track_id: result.track_id,
            pan: result.pan,
        }],
    })
}

/// Sets master output volume (linear gain 0.0–2.0).
#[tauri::command]
fn set_master_volume(
    volume: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetMasterVolumeCommand { volume };
    let clamped = execute_orchestrator_command(&project_state, &cmd)?;

    push_command(&handle, EngineCommand::SetMasterVolume { volume: clamped })?;

    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::debug!("[IPC] set_master_volume(vol={clamped})");
    Ok(())
}

/// Enables or disables a track.
#[tauri::command]
fn set_track_disabled(
    track_index: u16,
    disabled: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetTrackDisabledByIndexCommand { track_index, disabled };
    let _ = execute_orchestrator_command(&project_state, &cmd)?;

    push_command(&handle, EngineCommand::SetTrackDisabled { track_index, disabled })?;

    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::info!("[IPC] set_track_disabled(track={track_index}, disabled={disabled})");
    Ok(())
}

#[tauri::command]
fn set_track_disabled_with_deltas(
    track_index: u16,
    disabled: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<TrackDeltaResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetTrackDisabledByIndexCommand { track_index, disabled };
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    push_command(&handle, EngineCommand::SetTrackDisabled { track_index, disabled })?;

    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(TrackDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackDisabledChanged {
            track_id: result.track_id,
            disabled: result.disabled,
        }],
    })
}

/// Solos or unsolos a track.
#[tauri::command]
fn set_track_solo(
    track_index: u16,
    soloed: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetTrackSoloByIndexCommand { track_index, soloed };
    let _ = execute_orchestrator_command(&project_state, &cmd)?;

    push_command(
        &handle,
        EngineCommand::SetTrackSolo {
            track_index,
            soloed,
        },
    )?;

    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::info!("[IPC] set_track_solo(track={track_index}, soloed={soloed})");
    Ok(())
}

#[tauri::command]
fn set_track_solo_with_deltas(
    track_index: u16,
    soloed: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<TrackDeltaResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetTrackSoloByIndexCommand { track_index, soloed };
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    push_command(
        &handle,
        EngineCommand::SetTrackSolo {
            track_index,
            soloed,
        },
    )?;

    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(TrackDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackSoloChanged {
            track_id: result.track_id,
            soloed: result.soloed,
        }],
    })
}

/// Sets a track send level (A/B) as normalized value 0.0..1.0.
#[tauri::command]
fn set_track_send_level(
    track_index: u16,
    send: String,
    value: f32,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetTrackSendLevelByIndexCommand {
        track_index,
        send,
        value,
    };
    let _ = execute_orchestrator_command(&project_state, &cmd)?;
    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

#[tauri::command]
fn set_track_send_level_with_deltas(
    track_index: u16,
    send: String,
    value: f32,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<TrackDeltaResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetTrackSendLevelByIndexCommand {
        track_index,
        send,
        value,
    };
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(TrackDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::AutomationPointsChanged {
            track_id: result.track_id,
            param_id: result.param_id,
            points: vec![dream_models::delta::AutomationPointDelta {
                beat: 0.0,
                value: result.value as f64,
                curve_type: "linear".to_string(),
                tension: None,
            }],
        }],
    })
}
