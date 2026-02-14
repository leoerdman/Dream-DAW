use super::*;


/// Sets a track's volume (linear gain 0.0–2.0).
#[tauri::command]
fn set_track_volume(
    track_index: u16,
    volume: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let clamped = volume.clamp(0.0, 2.0);
    push_command(&handle, EngineCommand::SetTrackVolume {
        track_index,
        volume: clamped,
    })?;
    log::debug!("[IPC] set_track_volume(track={track_index}, vol={clamped})");
    Ok(())
}

/// Sets a track's pan position (-1.0 to 1.0).
#[tauri::command]
fn set_track_pan(
    track_index: u16,
    pan: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let clamped = pan.clamp(-1.0, 1.0);
    push_command(&handle, EngineCommand::SetTrackPan {
        track_index,
        pan: clamped,
    })?;
    log::debug!("[IPC] set_track_pan(track={track_index}, pan={clamped})");
    Ok(())
}

/// Sets master output volume (linear gain 0.0–2.0).
#[tauri::command]
fn set_master_volume(
    volume: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let clamped = volume.clamp(0.0, 2.0);
    push_command(&handle, EngineCommand::SetMasterVolume { volume: clamped })?;
    log::debug!("[IPC] set_master_volume(vol={clamped})");
    Ok(())
}

/// Mutes or unmutes a track.
#[tauri::command]
fn set_track_mute(
    track_index: u16,
    muted: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(&handle, EngineCommand::SetTrackMute {
        track_index,
        muted,
    })?;
    log::info!("[IPC] set_track_mute(track={track_index}, muted={muted})");
    Ok(())
}

/// Solos or unsolos a track.
#[tauri::command]
fn set_track_solo(
    track_index: u16,
    soloed: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(&handle, EngineCommand::SetTrackSolo {
        track_index,
        soloed,
    })?;
    log::info!("[IPC] set_track_solo(track={track_index}, soloed={soloed})");
    Ok(())
}

