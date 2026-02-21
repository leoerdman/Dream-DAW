

/// Sets the volume of a specific pad in a track's Sample Rack.
#[tauri::command]
fn set_sample_rack_pad_volume_cmd(
    track_id: String,
    pad_index: u8,
    volume: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id)
        .map_err(|_| format!("Invalid track_id: {}", track_id))?;
    
    let clamped_vol = volume.clamp(0.0, 2.0);

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    
    let (track_index, _) = project
        .tracks
        .iter_mut()
        .enumerate()
        .find(|(_, t)| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", track_id))?;

    let rack = project.tracks[track_index].sample_rack.get_or_insert_with(SampleRackConfig::default);
    if pad_index < 16 {
        rack.pads[pad_index as usize].volume = clamped_vol as f64;
    }

    push_command(
        &handle,
        EngineCommand::SetSampleRackPadVolume {
            track_index: track_index as u16,
            pad_index,
            volume: clamped_vol,
        },
    )?;

    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::debug!("[IPC] set_sample_rack_pad_volume_cmd(track={}, pad={}, vol={})", track_id, pad_index, clamped_vol);
    Ok(())
}

/// Sets the mute state of a specific pad in a track's Sample Rack.
#[tauri::command]
fn set_sample_rack_pad_mute_cmd(
    track_id: String,
    pad_index: u8,
    muted: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id)
        .map_err(|_| format!("Invalid track_id: {}", track_id))?;
    
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    
    let (track_index, _) = project
        .tracks
        .iter_mut()
        .enumerate()
        .find(|(_, t)| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", track_id))?;

    let rack = project.tracks[track_index].sample_rack.get_or_insert_with(SampleRackConfig::default);
    let mut vol_for_engine = 1.0;
    if pad_index < 16 {
        rack.pads[pad_index as usize].is_muted = muted;
        vol_for_engine = if muted { 0.0 } else { rack.pads[pad_index as usize].volume as f32 };
    }

    // Engine doesn't have a distinct mute state per pad, so we sync volume = 0 if muted.
    push_command(
        &handle,
        EngineCommand::SetSampleRackPadVolume {
            track_index: track_index as u16,
            pad_index,
            volume: vol_for_engine,
        },
    )?;

    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::debug!("[IPC] set_sample_rack_pad_mute_cmd(track={}, pad={}, muted={})", track_id, pad_index, muted);
    Ok(())
}

/// Sets the solo state of a specific pad in a track's Sample Rack.
#[tauri::command]
fn set_sample_rack_pad_solo_cmd(
    track_id: String,
    pad_index: u8,
    soloed: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id)
        .map_err(|_| format!("Invalid track_id: {}", track_id))?;
    
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    
    let (track_index, _) = project
        .tracks
        .iter_mut()
        .enumerate()
        .find(|(_, t)| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", track_id))?;

    let rack = project.tracks[track_index].sample_rack.get_or_insert_with(SampleRackConfig::default);
    if pad_index < 16 {
        rack.pads[pad_index as usize].is_soloed = soloed;
    }

    let any_soloed = rack.pads.iter().any(|p| p.is_soloed);

    for (i, pad) in rack.pads.iter().enumerate() {
        let vol_for_engine = if any_soloed && !pad.is_soloed {
            0.0
        } else if pad.is_muted {
            0.0
        } else {
            pad.volume as f32
        };

        push_command(
            &handle,
            EngineCommand::SetSampleRackPadVolume {
                track_index: track_index as u16,
                pad_index: i as u8,
                volume: vol_for_engine,
            },
        ).unwrap_or_else(|e| log::error!("Failed sending pad volume cmd: {}", e));
    }

    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::debug!("[IPC] set_sample_rack_pad_solo_cmd(track={}, pad={}, soloed={})", track_id, pad_index, soloed);
    Ok(())
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
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id)
        .map_err(|_| format!("Invalid track_id: {}", track_id))?;
        
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    
    let (track_index, _) = project
        .tracks
        .iter_mut()
        .enumerate()
        .find(|(_, t)| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", track_id))?;

    let rack = project.tracks[track_index].sample_rack.get_or_insert_with(SampleRackConfig::default);
    if pad_index < 16 {
        let pad = &mut rack.pads[pad_index as usize];
        pad.attack = attack.clamp(0.001, 10.0) as f64;
        pad.decay = decay.clamp(0.001, 10.0) as f64;
        pad.sustain = sustain.clamp(0.0, 1.0) as f64;
        pad.release = release.clamp(0.001, 20.0) as f64;
    }

    push_command(
        &handle,
        EngineCommand::SetSampleRackPadAdsr {
            track_index: track_index as u16,
            pad_index,
            attack,
            decay,
            sustain,
            release,
        },
    )?;

    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::debug!("[IPC] set_sample_rack_pad_adsr_cmd(track={}, pad={}, a={}, d={}, s={}, r={})", track_id, pad_index, attack, decay, sustain, release);
    Ok(())
}

/// Sets the filter cutoff for a specific pad in a track's Sample Rack.
#[tauri::command]
fn set_sample_rack_pad_filter_cutoff_cmd(
    track_id: String,
    pad_index: u8,
    cutoff: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id)
        .map_err(|_| format!("Invalid track_id: {}", track_id))?;
        
    let clamped_cutoff = cutoff.clamp(20.0, 20000.0);

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    
    let (track_index, _) = project
        .tracks
        .iter_mut()
        .enumerate()
        .find(|(_, t)| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", track_id))?;

    let rack = project.tracks[track_index].sample_rack.get_or_insert_with(SampleRackConfig::default);
    if pad_index < 16 {
        rack.pads[pad_index as usize].filter_cutoff = clamped_cutoff as f64;
    }

    push_command(
        &handle,
        EngineCommand::SetSampleRackPadFilterCutoff {
            track_index: track_index as u16,
            pad_index,
            cutoff: clamped_cutoff,
        },
    )?;

    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::debug!("[IPC] set_sample_rack_pad_filter_cutoff_cmd(track={}, pad={}, cutoff={})", track_id, pad_index, clamped_cutoff);
    Ok(())
}

/// Assigns a sample file to a specific pad in a track's Sample Rack and streams it to the audio engine.
#[tauri::command]
fn set_sample_rack_pad_sample_cmd(
    track_id: String,
    pad_index: u8,
    sample_path: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if pad_index >= 16 {
        return Err("Pad index out of bounds".into());
    }

    let track_uuid = Uuid::parse_str(&track_id)
        .map_err(|_| format!("Invalid track_id: {}", track_id))?;
        
    let sample_arc = if !sample_path.trim().is_empty() {
        if !PathBuf::from(&sample_path).exists() {
            return Err(format!("Sample path does not exist: {}", sample_path));
        }

        let decoded = AudioReader::read(PathBuf::from(&sample_path))
            .map_err(|e| format!("Failed to decode sample: {e}"))?;
        let clip_audio = ClipAudio::new(sample_path.clone(), decoded.channels, decoded.sample_rate);

        let arc = {
            let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
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
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    
    let (track_index, _) = project
        .tracks
        .iter_mut()
        .enumerate()
        .find(|(_, t)| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", track_id))?;

    let rack = project.tracks[track_index].sample_rack.get_or_insert_with(SampleRackConfig::default);
    rack.pads[pad_index as usize].sample_path = sample_path.clone();

    // Now update the lock-free data structure for the audio thread.
    let current_samples = handle.sample_rack_samples.load();
    let mut new_samples = (**current_samples).clone();
    
    // Ensure capacity
    while new_samples.len() <= track_index {
        new_samples.push(Default::default());
    }
    new_samples[track_index][pad_index as usize] = sample_arc;
    
    handle.sample_rack_samples.swap(new_samples);

    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::info!(
        "[IPC] set_sample_rack_pad_sample_cmd(track={}, pad={}, path={})",
        track_id, pad_index, sample_path
    );
    Ok(())
}
