#[derive(Debug, Serialize, Deserialize)]
struct TrackDeltaResponse {
    deltas: Vec<dream_models::delta::ProjectDelta>,
}

/// Sets a track's volume (linear gain 0.0–2.0).
#[tauri::command]
fn set_track_volume(
    track_index: u16,
    volume: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let clamped = volume.clamp(0.0, 2.0);
    push_command(
        &handle,
        EngineCommand::SetTrackVolume {
            track_index,
            volume: clamped,
        },
    )?;

    let project_name = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        let idx = track_index as usize;
        let track = project
            .tracks
            .get_mut(idx)
            .ok_or_else(|| format!("Track index out of range: {track_index}"))?;
        track.volume = clamped as f64;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::debug!("[IPC] set_track_volume(track={track_index}, vol={clamped})");
    Ok(())
}

#[tauri::command]
fn set_track_volume_with_deltas(
    track_index: u16,
    volume: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<TrackDeltaResponse, String> {
    let clamped = volume.clamp(0.0, 2.0);
    push_command(
        &handle,
        EngineCommand::SetTrackVolume {
            track_index,
            volume: clamped,
        },
    )?;

    let (project_name, track_id) = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        let idx = track_index as usize;
        let track_id = {
            let track = project
                .tracks
                .get_mut(idx)
                .ok_or_else(|| format!("Track index out of range: {track_index}"))?;
            track.volume = clamped as f64;
            track.id
        };
        (project.name.clone(), track_id)
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(TrackDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackVolumeChanged {
            track_id,
            volume: clamped,
        }],
    })
}

/// Sets a track's pan position (-1.0 to 1.0).
#[tauri::command]
fn set_track_pan(
    track_index: u16,
    pan: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let clamped = pan.clamp(-1.0, 1.0);
    push_command(
        &handle,
        EngineCommand::SetTrackPan {
            track_index,
            pan: clamped,
        },
    )?;

    let project_name = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        let idx = track_index as usize;
        let track = project
            .tracks
            .get_mut(idx)
            .ok_or_else(|| format!("Track index out of range: {track_index}"))?;
        track.pan = clamped as f64;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::debug!("[IPC] set_track_pan(track={track_index}, pan={clamped})");
    Ok(())
}

#[tauri::command]
fn set_track_pan_with_deltas(
    track_index: u16,
    pan: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<TrackDeltaResponse, String> {
    let clamped = pan.clamp(-1.0, 1.0);
    push_command(
        &handle,
        EngineCommand::SetTrackPan {
            track_index,
            pan: clamped,
        },
    )?;

    let (project_name, track_id) = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        let idx = track_index as usize;
        let track_id = {
            let track = project
                .tracks
                .get_mut(idx)
                .ok_or_else(|| format!("Track index out of range: {track_index}"))?;
            track.pan = clamped as f64;
            track.id
        };
        (project.name.clone(), track_id)
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(TrackDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackPanChanged {
            track_id,
            pan: clamped,
        }],
    })
}

/// Sets master output volume (linear gain 0.0–2.0).
#[tauri::command]
fn set_master_volume(
    volume: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let clamped = volume.clamp(0.0, 2.0);
    push_command(&handle, EngineCommand::SetMasterVolume { volume: clamped })?;

    let project_name = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        project.master_track.volume = clamped as f64;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::debug!("[IPC] set_master_volume(vol={clamped})");
    Ok(())
}

/// Mutes or unmutes a track.
#[tauri::command]
fn set_track_mute(
    track_index: u16,
    muted: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    push_command(&handle, EngineCommand::SetTrackMute { track_index, muted })?;

    let project_name = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        let idx = track_index as usize;
        let track = project
            .tracks
            .get_mut(idx)
            .ok_or_else(|| format!("Track index out of range: {track_index}"))?;
        track.is_mute = muted;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::info!("[IPC] set_track_mute(track={track_index}, muted={muted})");
    Ok(())
}

#[tauri::command]
fn set_track_mute_with_deltas(
    track_index: u16,
    muted: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<TrackDeltaResponse, String> {
    push_command(&handle, EngineCommand::SetTrackMute { track_index, muted })?;

    let (project_name, track_id) = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        let idx = track_index as usize;
        let track_id = {
            let track = project
                .tracks
                .get_mut(idx)
                .ok_or_else(|| format!("Track index out of range: {track_index}"))?;
            track.is_mute = muted;
            track.id
        };
        (project.name.clone(), track_id)
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(TrackDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackMuteChanged {
            track_id,
            muted,
        }],
    })
}

/// Solos or unsolos a track.
#[tauri::command]
fn set_track_solo(
    track_index: u16,
    soloed: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    push_command(
        &handle,
        EngineCommand::SetTrackSolo {
            track_index,
            soloed,
        },
    )?;

    let project_name = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        let idx = track_index as usize;
        let track = project
            .tracks
            .get_mut(idx)
            .ok_or_else(|| format!("Track index out of range: {track_index}"))?;
        track.is_solo = soloed;
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
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<TrackDeltaResponse, String> {
    push_command(
        &handle,
        EngineCommand::SetTrackSolo {
            track_index,
            soloed,
        },
    )?;

    let (project_name, track_id) = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        let idx = track_index as usize;
        let track_id = {
            let track = project
                .tracks
                .get_mut(idx)
                .ok_or_else(|| format!("Track index out of range: {track_index}"))?;
            track.is_solo = soloed;
            track.id
        };
        (project.name.clone(), track_id)
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(TrackDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackSoloChanged {
            track_id,
            soloed,
        }],
    })
}

/// Trigger a sampler note-on for live audition from Piano Roll.
#[tauri::command]
fn preview_sampler_note_on_cmd(
    track_index: u16,
    pitch: u8,
    velocity: u8,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(
        &handle,
        EngineCommand::SamplerNoteOn {
            track_index,
            pitch,
            velocity,
        },
    )?;
    Ok(())
}

/// Trigger a sampler note-off for live audition from Piano Roll.
#[tauri::command]
fn preview_sampler_note_off_cmd(
    track_index: u16,
    pitch: u8,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(
        &handle,
        EngineCommand::SamplerNoteOff { track_index, pitch },
    )?;
    Ok(())
}
