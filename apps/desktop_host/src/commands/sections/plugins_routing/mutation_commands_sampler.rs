/// Assign sample file to a track sampler and stream it to the realtime engine.
#[tauri::command]
fn set_sampler_sample_cmd(
    payload: SetSamplerSamplePayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let sample_path = payload.sample_path.clone();
    if !PathBuf::from(&sample_path).exists() {
        return Err(format!("Sample path does not exist: {}", sample_path));
    }

    let decoded = AudioReader::read(PathBuf::from(&sample_path))
        .map_err(|e| format!("Failed to decode sample: {e}"))?;
    let clip_audio = ClipAudio::new(sample_path.clone(), decoded.channels, decoded.sample_rate);

    let sample_arc = {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        if let Err(e) = pool.insert(clip_audio) {
            log::error!("ClipPool: {}", e);
        }
        pool.get(&sample_path)
            .ok_or_else(|| "Failed to cache decoded sampler sample".to_string())?
    };
    clip_pool_state.sync_pool_to_arc();

    push_undo(&project_state)?;
    let cmd = dream_orchestrator::commands::SetSamplerSampleCommand::from_str_track_id(
        &payload.track_id,
        sample_path.clone(),
        payload.root_note,
    )
    .map_err(|e| e.to_string())?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    let (track_index, sampler_cfg) = (result.track_index, result.sampler_cfg);

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    handle
        .sampler_samples
        .set_track_sample(track_index, Some(sample_arc));

    let idx = track_index as u16;
    push_command(
        &handle,
        EngineCommand::SetSamplerRootNote {
            track_index: idx,
            root_note: sampler_cfg.root_note,
        },
    )?;
    push_command(
        &handle,
        EngineCommand::SetSamplerVolume {
            track_index: idx,
            volume: sampler_cfg.volume as f32,
        },
    )?;
    push_command(
        &handle,
        EngineCommand::SetSamplerAdsr {
            track_index: idx,
            attack: sampler_cfg.attack as f32,
            decay: sampler_cfg.decay as f32,
            sustain: sampler_cfg.sustain as f32,
            release: sampler_cfg.release as f32,
        },
    )?;
    push_command(
        &handle,
        EngineCommand::SetSamplerOsc2Waveform {
            track_index: idx,
            waveform: sampler_cfg.osc2_waveform.min(3),
        },
    )?;
    push_command(
        &handle,
        EngineCommand::SetSamplerOscMix {
            track_index: idx,
            mix: sampler_cfg.osc_mix.clamp(0.0, 1.0) as f32,
        },
    )?;
    push_command(
        &handle,
        EngineCommand::SetSamplerDetuneCents {
            track_index: idx,
            cents: sampler_cfg.detune_cents.clamp(-50.0, 50.0) as f32,
        },
    )?;
    push_command(
        &handle,
        EngineCommand::SetSamplerSubLevel {
            track_index: idx,
            level: sampler_cfg.sub_level.clamp(0.0, 1.0) as f32,
        },
    )?;
    push_command(
        &handle,
        EngineCommand::SetSamplerFilterCutoff {
            track_index: idx,
            cutoff: sampler_cfg.filter_cutoff.clamp(20.0, 20000.0) as f32,
        },
    )?;
    push_command(
        &handle,
        EngineCommand::SetSamplerFilterResonance {
            track_index: idx,
            resonance: sampler_cfg.filter_resonance.clamp(0.0, 0.99) as f32,
        },
    )?;
    push_command(
        &handle,
        EngineCommand::SetSamplerFilterType {
            track_index: idx,
            filter_type: sampler_cfg.filter_type.min(3),
        },
    )?;

    log::info!(
        "[IPC] set_sampler_sample_cmd(track={}, path={})",
        payload.track_id,
        sample_path
    );
    Ok(())
}
