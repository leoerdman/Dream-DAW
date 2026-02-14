use super::*;

// ═══════════════════════════════════════════════════════════════════════

/// Adds a built-in DSP device to a track's insert chain.
#[tauri::command]
fn add_device_cmd(
    track_index: u16,
    slot_index: u8,
    effect_type: u8,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(&handle, EngineCommand::AddDevice {
        track_index,
        slot_index,
        effect_type,
    })?;
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
    push_command(&handle, EngineCommand::RemoveDevice {
        track_index,
        slot_index,
    })?;
    log::info!("[IPC] remove_device(track={track_index}, slot={slot_index})");
    Ok(())
}

/// Bypasses or enables a device in a track's insert chain.
#[tauri::command]
fn bypass_device_cmd(
    track_index: u16,
    slot_index: u8,
    bypassed: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(&handle, EngineCommand::BypassDevice {
        track_index,
        slot_index,
        bypassed,
    })?;
    log::debug!("[IPC] bypass_device(track={track_index}, slot={slot_index}, bypassed={bypassed})");
    Ok(())
}

/// Sets a parameter on a device in a track's insert chain.
#[tauri::command]
fn set_device_param_cmd(
    track_index: u16,
    slot_index: u8,
    param_index: u8,
    value: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(&handle, EngineCommand::SetDeviceParam {
        track_index,
        slot_index,
        param_index,
        value,
    })?;
    log::debug!("[IPC] set_device_param(track={track_index}, slot={slot_index}, param={param_index}, val={value})");
    Ok(())
}

/// Batch update a track's state (volume, pan, mute, solo).
#[tauri::command]
fn update_track(
    update: TrackStateUpdate,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    if let Some(vol) = update.volume {
        push_command(&handle, EngineCommand::SetTrackVolume {
            track_index: update.track_index,
            volume: vol.clamp(0.0, 2.0),
        })?;
    }
    if let Some(pan) = update.pan {
        push_command(&handle, EngineCommand::SetTrackPan {
            track_index: update.track_index,
            pan: pan.clamp(-1.0, 1.0),
        })?;
    }
    if let Some(muted) = update.muted {
        push_command(&handle, EngineCommand::SetTrackMute {
            track_index: update.track_index,
            muted,
        })?;
    }
    if let Some(soloed) = update.soloed {
        push_command(&handle, EngineCommand::SetTrackSolo {
            track_index: update.track_index,
            soloed,
        })?;
    }
    log::debug!("[IPC] update_track(track={})", update.track_index);
    Ok(())
}

