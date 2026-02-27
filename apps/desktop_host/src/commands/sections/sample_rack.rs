
#[derive(Debug, Serialize, Deserialize)]
struct SampleRackDeltaResponse {
    deltas: Vec<dream_models::delta::ProjectDelta>,
}


/// Sets the volume of a specific pad in a track's Sample Rack.
#[tauri::command]
fn set_sample_rack_pad_volume_cmd(
    track_id: String,
    pad_index: u8,
    volume: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetSampleRackPadVolumeCommand::from_str_track_id(
        &track_id,
        pad_index,
        volume,
    )
    .map_err(|e| e.to_string())?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    push_command(
        &handle,
        EngineCommand::SetSampleRackPadVolume {
            track_index: result.track_index,
            pad_index: result.pad_index,
            volume: result.volume,
        },
    )?;

    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::debug!(
        "[IPC] set_sample_rack_pad_volume_cmd(track={}, pad={}, vol={})",
        track_id,
        pad_index,
        result.volume
    );
    Ok(())
}

#[tauri::command]
fn set_sample_rack_pad_volume_with_deltas_cmd(
    track_id: String,
    pad_index: u8,
    volume: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<SampleRackDeltaResponse, String> {
    let track_uuid = Uuid::parse_str(&track_id)
        .map_err(|_| format!("Invalid track_id: {}", track_id))?;
    let clamped_vol = volume.clamp(0.0, 2.0);
    set_sample_rack_pad_volume_cmd(track_id, pad_index, volume, handle, project_registry, app)?;
    Ok(SampleRackDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::SampleRackPadVolumeChanged {
            track_id: track_uuid,
            pad_index,
            volume: clamped_vol,
        }],
    })
}

/// Sets the mute state of a specific pad in a track's Sample Rack.
#[tauri::command]
fn set_sample_rack_pad_mute_cmd(
    track_id: String,
    pad_index: u8,
    muted: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetSampleRackPadMuteCommand::from_str_track_id(
        &track_id,
        pad_index,
        muted,
    )
    .map_err(|e| e.to_string())?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    // Engine doesn't have a distinct mute state per pad, so we sync volume = 0 if muted.
    push_command(
        &handle,
        EngineCommand::SetSampleRackPadVolume {
            track_index: result.track_index,
            pad_index: result.pad_index,
            volume: result.effective_volume,
        },
    )?;

    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::debug!(
        "[IPC] set_sample_rack_pad_mute_cmd(track={}, pad={}, muted={})",
        track_id,
        pad_index,
        muted
    );
    Ok(())
}

#[tauri::command]
fn set_sample_rack_pad_mute_with_deltas_cmd(
    track_id: String,
    pad_index: u8,
    muted: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<SampleRackDeltaResponse, String> {
    let track_uuid = Uuid::parse_str(&track_id)
        .map_err(|_| format!("Invalid track_id: {}", track_id))?;
    set_sample_rack_pad_mute_cmd(track_id, pad_index, muted, handle, project_registry, app)?;
    Ok(SampleRackDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::SampleRackPadMuteChanged {
            track_id: track_uuid,
            pad_index,
            muted,
        }],
    })
}

/// Sets the solo state of a specific pad in a track's Sample Rack.
#[tauri::command]
fn set_sample_rack_pad_solo_cmd(
    track_id: String,
    pad_index: u8,
    soloed: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetSampleRackPadSoloCommand::from_str_track_id(
        &track_id,
        pad_index,
        soloed,
    )
    .map_err(|e| e.to_string())?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    for (i, vol_for_engine) in result.effective_pad_volumes.iter().enumerate() {
        push_command(
            &handle,
            EngineCommand::SetSampleRackPadVolume {
                track_index: result.track_index,
                pad_index: i as u8,
                volume: *vol_for_engine,
            },
        )
        .unwrap_or_else(|e| log::error!("Failed sending pad volume cmd: {}", e));
    }

    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::debug!(
        "[IPC] set_sample_rack_pad_solo_cmd(track={}, pad={}, soloed={})",
        track_id,
        pad_index,
        soloed
    );
    Ok(())
}

#[tauri::command]
fn set_sample_rack_pad_solo_with_deltas_cmd(
    track_id: String,
    pad_index: u8,
    soloed: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<SampleRackDeltaResponse, String> {
    let track_uuid = Uuid::parse_str(&track_id)
        .map_err(|_| format!("Invalid track_id: {}", track_id))?;
    set_sample_rack_pad_solo_cmd(track_id, pad_index, soloed, handle, project_registry, app)?;
    Ok(SampleRackDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::SampleRackPadSoloChanged {
            track_id: track_uuid,
            pad_index,
            soloed,
        }],
    })
}

/// Sets the ADSR envelope for a specific pad in a track's Sample Rack.
#[tauri::command]
fn set_sample_rack_pad_adsr_cmd(
    track_id: String,
    pad_index: u8,
    attack: f32,
    decay: f32,
    sustain: f32,
    release: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetSampleRackPadAdsrCommand::from_str_track_id(
        &track_id,
        pad_index,
        attack,
        decay,
        sustain,
        release,
    )
    .map_err(|e| e.to_string())?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    push_command(
        &handle,
        EngineCommand::SetSampleRackPadAdsr {
            track_index: result.track_index,
            pad_index: result.pad_index,
            attack: result.attack,
            decay: result.decay,
            sustain: result.sustain,
            release: result.release,
        },
    )?;

    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::debug!(
        "[IPC] set_sample_rack_pad_adsr_cmd(track={}, pad={}, a={}, d={}, s={}, r={})",
        track_id,
        pad_index,
        result.attack,
        result.decay,
        result.sustain,
        result.release
    );
    Ok(())
}

#[tauri::command]
fn set_sample_rack_pad_adsr_with_deltas_cmd(
    track_id: String,
    pad_index: u8,
    attack: f32,
    decay: f32,
    sustain: f32,
    release: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<SampleRackDeltaResponse, String> {
    let track_uuid = Uuid::parse_str(&track_id)
        .map_err(|_| format!("Invalid track_id: {}", track_id))?;
    let clamped_attack = attack.clamp(0.001, 10.0);
    let clamped_decay = decay.clamp(0.001, 10.0);
    let clamped_sustain = sustain.clamp(0.0, 1.0);
    let clamped_release = release.clamp(0.001, 20.0);
    set_sample_rack_pad_adsr_cmd(
        track_id,
        pad_index,
        attack,
        decay,
        sustain,
        release,
        handle,
        project_registry,
        app,
    )?;
    Ok(SampleRackDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::SampleRackPadAdsrChanged {
            track_id: track_uuid,
            pad_index,
            attack: clamped_attack,
            decay: clamped_decay,
            sustain: clamped_sustain,
            release: clamped_release,
        }],
    })
}

/// Sets the filter cutoff for a specific pad in a track's Sample Rack.
#[tauri::command]
fn set_sample_rack_pad_filter_cutoff_cmd(
    track_id: String,
    pad_index: u8,
    cutoff: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetSampleRackPadFilterCutoffCommand::from_str_track_id(
        &track_id,
        pad_index,
        cutoff,
    )
    .map_err(|e| e.to_string())?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    push_command(
        &handle,
        EngineCommand::SetSampleRackPadFilterCutoff {
            track_index: result.track_index,
            pad_index: result.pad_index,
            cutoff: result.cutoff,
        },
    )?;

    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::debug!(
        "[IPC] set_sample_rack_pad_filter_cutoff_cmd(track={}, pad={}, cutoff={})",
        track_id,
        pad_index,
        result.cutoff
    );
    Ok(())
}

#[tauri::command]
fn set_sample_rack_pad_filter_cutoff_with_deltas_cmd(
    track_id: String,
    pad_index: u8,
    cutoff: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<SampleRackDeltaResponse, String> {
    let track_uuid = Uuid::parse_str(&track_id)
        .map_err(|_| format!("Invalid track_id: {}", track_id))?;
    let clamped_cutoff = cutoff.clamp(20.0, 20000.0);
    set_sample_rack_pad_filter_cutoff_cmd(track_id, pad_index, cutoff, handle, project_registry, app)?;
    Ok(SampleRackDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::SampleRackPadFilterCutoffChanged {
            track_id: track_uuid,
            pad_index,
            cutoff: clamped_cutoff,
        }],
    })
}

/// Assigns a sample file to a specific pad in a track's Sample Rack and streams it to the audio engine.
#[tauri::command]
fn set_sample_rack_pad_sample_cmd(
    track_id: String,
    pad_index: u8,
    sample_path: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let sample_arc = if !sample_path.trim().is_empty() {
        if !PathBuf::from(&sample_path).exists() {
            return Err(format!("Sample path does not exist: {}", sample_path));
        }

        let decoded = AudioReader::read(PathBuf::from(&sample_path))
            .map_err(|e| format!("Failed to decode sample: {e}"))?;
        let clip_audio = ClipAudio::new(sample_path.clone(), decoded.channels, decoded.sample_rate);

        let arc = {
            let mut pool = clip_pool_state.pool.lock().map_err(|_| "Mutex poisoned".to_string())?;
            if let Err(e) = pool.insert(clip_audio) { log::error!("ClipPool: {}", e); }
            pool.get(&sample_path)
                .ok_or_else(|| "Failed to cache decoded sample for rack".to_string())?
        };
        clip_pool_state.sync_pool_to_arc();
        Some(arc)
    } else {
        None
    };

    push_undo(&project_state)?;
    let cmd = dream_orchestrator::commands::SetSampleRackPadSamplePathCommand::from_str_track_id(
        &track_id,
        pad_index,
        sample_path.clone(),
    )
    .map_err(|e| e.to_string())?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    let track_index = result.track_index as usize;

    // Now update the lock-free data structure for the audio thread.
    let current_samples = handle.sample_rack_samples.load();
    let mut new_samples = (**current_samples).clone();
    
    // Ensure capacity
    while new_samples.len() <= track_index {
        new_samples.push(Default::default());
    }
    new_samples[track_index][pad_index as usize] = sample_arc;
    
    handle.sample_rack_samples.swap(new_samples);

    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::info!(
        "[IPC] set_sample_rack_pad_sample_cmd(track={}, pad={}, path={})",
        track_id, pad_index, sample_path
    );
    Ok(())
}

#[tauri::command]
fn set_sample_rack_pad_sample_with_deltas_cmd(
    track_id: String,
    pad_index: u8,
    sample_path: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<SampleRackDeltaResponse, String> {
    let track_uuid = Uuid::parse_str(&track_id)
        .map_err(|_| format!("Invalid track_id: {}", track_id))?;
    set_sample_rack_pad_sample_cmd(
        track_id,
        pad_index,
        sample_path.clone(),
        project_registry,
        clip_pool_state,
        handle,
        app,
    )?;
    Ok(SampleRackDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::SampleRackPadSampleChanged {
            track_id: track_uuid,
            pad_index,
            sample_path,
        }],
    })
}
