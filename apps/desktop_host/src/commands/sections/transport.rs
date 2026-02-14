
#[tauri::command]
fn play(handle: tauri::State<'_, AudioEngineHandle>) -> Result<(), String> {
    push_command(&handle, EngineCommand::SetPlay(true))?;

    let mut state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    state.is_playing = true;

    log::info!("[IPC] play()");
    Ok(())
}

/// Stops audio playback.
#[tauri::command]
fn stop(handle: tauri::State<'_, AudioEngineHandle>) -> Result<(), String> {
    push_command(&handle, EngineCommand::SetPlay(false))?;

    let mut state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    state.is_playing = false;

    log::info!("[IPC] stop()");
    Ok(())
}

/// Toggle play/stop.
#[tauri::command]
fn toggle_playback(handle: tauri::State<'_, AudioEngineHandle>) -> Result<bool, String> {
    let mut state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;

    let new_state = !state.is_playing;
    state.is_playing = new_state;
    drop(state);

    push_command(&handle, EngineCommand::SetPlay(new_state))?;

    log::info!("[IPC] toggle_playback → {}", if new_state { "play" } else { "stop" });
    Ok(new_state)
}

/// Seeks to a specific position in sample frames.
#[tauri::command]
fn seek(position_frames: i64, handle: tauri::State<'_, AudioEngineHandle>) -> Result<(), String> {
    push_command(&handle, EngineCommand::Seek(position_frames))?;
    log::info!("[IPC] seek({position_frames})");
    Ok(())
}

/// Seeks to a specific position in seconds.
#[tauri::command]
fn seek_seconds(
    seconds: f64,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    let sample_rate = state.sample_rate;
    drop(state);

    let frames = (seconds * sample_rate) as i64;
    push_command(&handle, EngineCommand::Seek(frames))?;
    log::info!("[IPC] seek_seconds({seconds}s → {frames} frames)");
    Ok(())
}

/// Seeks to a specific position in beats (uses current BPM + sample rate).
#[tauri::command]
fn seek_to_beat(
    beat: f64,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    let bpm = state.bpm;
    let sample_rate = state.sample_rate;
    drop(state);

    let seconds = beat * 60.0 / bpm;
    let frames = (seconds * sample_rate) as i64;
    push_command(&handle, EngineCommand::Seek(frames))?;
    log::info!("[IPC] seek_to_beat({beat:.4} beat → {frames} frames)");
    Ok(())
}

/// Sets the project tempo (BPM).
#[tauri::command]
fn set_bpm(
    bpm: f64,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
) -> Result<(), String> {
    if !(20.0..=999.0).contains(&bpm) {
        return Err(format!("BPM {bpm} out of range (20–999)"));
    }

    // Runtime transport BPM update for the audio thread.
    push_command(&handle, EngineCommand::SetBpm(bpm))?;

    // Snapshot undo BEFORE project mutation.
    push_undo(&project_state)?;

    // Persisted project retime: keep musical beat positions/durations invariant
    // while converting all sample-frame fields to the new tempo map.
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let old_pulse_map = project.pulse_map.clone();
    let mut new_pulse_map = old_pulse_map.clone();
    new_pulse_map.set_constant_tempo(bpm);
    let current_engine_frame = handle.master_clock.position().max(0);
    let current_engine_beat = old_pulse_map.beats(current_engine_frame);
    let remapped_engine_frame = new_pulse_map.sample_frame(current_engine_beat).max(0);

    let remap_frame = |frame: i64| -> i64 {
        let beat = old_pulse_map.beats(frame.max(0));
        new_pulse_map.sample_frame(beat).max(0)
    };

    for track in &mut project.tracks {
        for clip in &mut track.clips {
            let old_start = clip.position.sample_frame.max(0);
            let old_end = (old_start + clip.duration.sample_frame.max(1)).max(old_start + 1);
            let new_start = remap_frame(old_start);
            let new_end = remap_frame(old_end).max(new_start + 1);
            clip.position = AbsoluteTime::new(new_start);
            clip.duration = AbsoluteTime::new((new_end - new_start).max(1));
        }

        for clip in &mut track.midi_clips {
            let old_clip_start = clip.position.sample_frame.max(0);
            let old_clip_end = (old_clip_start + clip.duration.sample_frame.max(1)).max(old_clip_start + 1);
            let new_clip_start = remap_frame(old_clip_start);
            let new_clip_end = remap_frame(old_clip_end).max(new_clip_start + 1);
            let new_clip_duration = (new_clip_end - new_clip_start).max(1);

            for note in &mut clip.notes {
                let old_abs_start = (old_clip_start + note.start_frame.max(0)).max(old_clip_start);
                let old_abs_end = (old_abs_start + note.duration_frames.max(1)).max(old_abs_start + 1);
                let new_abs_start = remap_frame(old_abs_start);
                let new_abs_end = remap_frame(old_abs_end).max(new_abs_start + 1);

                let rel_start = (new_abs_start - new_clip_start).clamp(0, new_clip_duration - 1);
                let rel_end = (new_abs_end - new_clip_start).clamp(rel_start + 1, new_clip_duration);
                note.start_frame = rel_start;
                note.duration_frames = (rel_end - rel_start).max(1);
            }
            clip.notes.sort_by_key(|n| n.start_frame);
            clip.position = AbsoluteTime::new(new_clip_start);
            clip.duration = AbsoluteTime::new(new_clip_duration);
        }
    }

    // Persist transport/loop points in project domain.
    project.playhead_position_frames = remapped_engine_frame;
    let remapped_loop_start = project.loop_start_frames.map(remap_frame);
    let remapped_loop_end = project.loop_end_frames.map(remap_frame);
    match (remapped_loop_start, remapped_loop_end) {
        (Some(start), Some(end)) if end > start => {
            project.loop_start_frames = Some(start);
            project.loop_end_frames = Some(end);
        }
        _ => {
            project.loop_start_frames = remapped_loop_start;
            project.loop_end_frames = remapped_loop_end;
        }
    }

    project.pulse_map = new_pulse_map;

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    rebuild_automation_snapshot_from_project(&project, &automation_runtime);

    // Re-anchor realtime transport to the same musical beat after tempo change.
    push_command(&handle, EngineCommand::Seek(remapped_engine_frame))?;
    if let (Some(start), Some(end)) = (project.loop_start_frames, project.loop_end_frames)
        && end > start
    {
        push_command(&handle, EngineCommand::SetLoopRegion { start, end })?;
    }
    push_command(&handle, EngineCommand::SetLoopEnabled(project.is_looping))?;

    let mut state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    state.bpm = bpm;
    if let (Some(start), Some(end)) = (project.loop_start_frames, project.loop_end_frames)
        && end > start
    {
        state.loop_start = start;
        state.loop_end = end;
        state.loop_enabled = project.is_looping;
    }
    log::info!("[IPC] set_bpm({bpm})");
    Ok(())
}

/// Sets the loop region and enables/disables looping.
#[tauri::command]
fn set_loop(
    enabled: bool,
    start_frames: i64,
    end_frames: i64,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    if end_frames <= start_frames {
        return Err("Loop end must be after loop start".to_string());
    }
    push_command(&handle, EngineCommand::SetLoopRegion {
        start: start_frames,
        end: end_frames,
    })?;
    push_command(&handle, EngineCommand::SetLoopEnabled(enabled))?;

    log::info!("[IPC] set_loop(enabled={enabled}, {start_frames}–{end_frames})");
    Ok(())
}
