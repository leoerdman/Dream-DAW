
#[inline]
fn beat_to_engine_frames(beat: f64, pulse_map: Option<&dream_models::pulse_map::PulseMap>, fallback_bpm: f64, sample_rate: f64) -> i64 {
    if !beat.is_finite() {
        return 0;
    }
    if let Some(pm) = pulse_map {
        return pm.sample_frame(beat.max(0.0)).max(0);
    }
    let bpm = if fallback_bpm.is_finite() && fallback_bpm > 0.0 {
        fallback_bpm
    } else {
        120.0
    };
    let sr = if sample_rate.is_finite() && sample_rate > 0.0 {
        sample_rate
    } else {
        44_100.0
    };
    ((beat.max(0.0) * 60.0 / bpm) * sr).round() as i64
}

#[tauri::command]
fn play(handle: tauri::State<'_, AudioEngineHandle>) -> Result<(), String> {
    // BUG-011 FIX: Single lock scope instead of double-lock.
    let mut state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    push_command(&handle, EngineCommand::SetTimelineSampleRate(state.sample_rate))?;
    push_command(&handle, EngineCommand::SetPlay(true))?;
    state.is_playing = true;
    drop(state);

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
    // BUG-013 FIX: Keep lock across read+write+command push to prevent TOCTOU race.
    let mut state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;

    let new_state = !state.is_playing;
    let timeline_sample_rate = state.sample_rate;

    if new_state {
        push_command(
            &handle,
            EngineCommand::SetTimelineSampleRate(timeline_sample_rate),
        )?;
    }
    push_command(&handle, EngineCommand::SetPlay(new_state))?;
    state.is_playing = new_state;
    drop(state);

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
    // BUG-016 FIX: Validate non-negative seconds at the API boundary.
    let safe_seconds = seconds.max(0.0);
    let state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    let sample_rate = state.sample_rate;
    drop(state);

    let frames = (safe_seconds * sample_rate).round() as i64;
    push_command(&handle, EngineCommand::Seek(frames))?;
    log::info!("[IPC] seek_seconds({safe_seconds}s → {frames} frames)");
    Ok(())
}

/// Seeks to a specific position in beats (uses current BPM + sample rate).
#[tauri::command]
fn seek_to_beat(
    beat: f64,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<(), String> {
    // BUG-017 FIX: Validate non-negative beat at the API boundary.
    let safe_beat = beat.max(0.0);
    let state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    let bpm = state.bpm;
    let sample_rate = state.sample_rate;
    drop(state);

    let frames = if let Ok(project) = project_state.project.lock() {
        beat_to_engine_frames(safe_beat, Some(&project.pulse_map), bpm, sample_rate)
    } else {
        beat_to_engine_frames(safe_beat, None, bpm, sample_rate)
    };
    push_command(&handle, EngineCommand::Seek(frames))?;
    log::info!("[IPC] seek_to_beat({safe_beat:.4} beat → {frames} frames)");
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
    app: tauri::AppHandle,
) -> Result<(), String> {
    if !(20.0..=999.0).contains(&bpm) {
        return Err(format!("BPM {bpm} out of range (20–999)"));
    }

    // BPM map is fully computed below before pushing to the audio thread.

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
            if !clip.is_warped {
                continue;
            }
            if clip.warp_source_duration_frames <= 0 {
                // Look up the real file duration from the clip pool so we
                // never accidentally capture an already-warped timeline length.
                if let Ok(pool) = clip_pool_state.pool.lock() {
                    if let Some(audio) = pool.get(&clip.file_path) {
                        clip.warp_source_duration_frames = audio.num_frames.max(1) as i64;
                    } else {
                        clip.warp_source_duration_frames = clip.duration.sample_frame.max(1);
                    }
                } else {
                    clip.warp_source_duration_frames = clip.duration.sample_frame.max(1);
                }
            }
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

    let project_name = project.name.clone();
    project_state.mark_dirty(&project_name, Some(&app))?;
    clip_pool_state.rebuild_routing_only(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    rebuild_automation_snapshot_from_project(&project, &automation_runtime);

    // Re-anchor realtime transport to the same musical beat after tempo change.
    push_command(&handle, EngineCommand::Seek(remapped_engine_frame))?;
    let loop_region_opt = if let (Some(start), Some(end)) = (project.loop_start_frames, project.loop_end_frames)
        && end > start
    {
        Some((start, end))
    } else {
        None
    };

    // BUG-014 FIX: Atomic composite command so the audio thread doesn't read the new BPM
    // while still referencing the old loop region frame numbers for a buffer cycle.
    push_command(
        &handle,
        EngineCommand::SetBpmAndLoop {
            bpm,
            loop_enabled: project.is_looping,
            loop_region: loop_region_opt,
        },
    )?;

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

#[derive(Debug, Serialize, Deserialize)]
struct TransportDeltaResponse {
    deltas: Vec<dream_models::delta::ProjectDelta>,
}

#[tauri::command]
fn set_bpm_with_deltas(
    bpm: f64,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    app: tauri::AppHandle,
) -> Result<TransportDeltaResponse, String> {
    set_bpm(
        bpm,
        handle,
        project_state,
        clip_pool_state,
        automation_runtime,
        app,
    )?;
    Ok(TransportDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TempoChanged { bpm }],
    })
}

#[tauri::command]
fn set_time_signature(
    numerator: u32,
    denominator: u32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<(), String> {
    let numerator_u8 = (numerator.clamp(1, 32)) as u8;
    let denominator_u8 = (denominator.clamp(1, 32)) as u8;

    push_undo(&project_state)?;
    {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        project.time_signature = dream_models::project::TimeSignature::new(numerator_u8, denominator_u8);
        let project_name = project.name.clone();
        drop(project);
        let _ = project_state.mark_dirty(&project_name, None);
    }

    push_command(
        &handle,
        EngineCommand::SetTimeSignature {
            numerator: numerator_u8,
            denominator: denominator_u8,
        },
    )?;

    log::info!("[IPC] set_time_signature({numerator_u8}/{denominator_u8})");
    Ok(())
}

#[tauri::command]
fn set_time_signature_with_deltas(
    numerator: u32,
    denominator: u32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<TransportDeltaResponse, String> {
    set_time_signature(numerator, denominator, handle, project_state)?;
    Ok(TransportDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TimeSignatureChanged {
            numerator: numerator.clamp(1, 32),
            denominator: denominator.clamp(1, 32),
        }],
    })
}

/// Sets the loop region and enables/disables looping.
#[tauri::command]
fn set_loop(
    enabled: bool,
    start_frames: i64,
    end_frames: i64,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<(), String> {
    let (beats_per_bar, sample_rate, bpm) = {
        let project = project_state
            .project
            .lock()
            .map_err(|e| format!("Lock poisoned: {e}"))?;
        (
            project.time_signature.numerator.max(1) as f64,
            project.sample_rate.max(1.0),
            project.pulse_map.initial_bpm().max(1.0),
        )
    };

    let min_gap: i64 = ((beats_per_bar * 60.0 / bpm) * sample_rate).round() as i64;
    // BUG-012 FIX: Validate start_frames >= 0 to prevent unexpected behavior
    // from negative frame positions in the gap calculation.
    let has_valid_range = start_frames >= 0
        && end_frames > start_frames
        && (end_frames - start_frames) >= min_gap;

    // Update shared playback_state FIRST so telemetry reads correct values immediately
    {
        let mut state = handle
            .playback_state
            .lock()
            .map_err(|e| format!("Lock poisoned: {e}"))?;

        if enabled && has_valid_range {
            state.loop_enabled = true;
            state.loop_start = start_frames;
            state.loop_end = end_frames;
        } else {
            state.loop_enabled = false;
        }
    }

    // Push commands to the realtime audio thread
    if enabled && has_valid_range {
        push_command(&handle, EngineCommand::SetLoopRegion {
            start: start_frames,
            end: end_frames,
        })?;
        push_command(&handle, EngineCommand::SetLoopEnabled(true))?;

        // BUG-061 FIX: Auto-seek to loop start when enabled during playback outside the region.
        let is_playing = {
            let state = handle.playback_state.lock().map_err(|e| e.to_string())?;
            state.is_playing
        };
        let pos = handle.master_clock.position();
        if is_playing && (pos < start_frames || pos >= end_frames) {
            push_command(&handle, EngineCommand::Seek(start_frames))?;
        }
    } else {
        push_command(&handle, EngineCommand::SetLoopEnabled(false))?;
    }

    // Persist loop region to project model so it survives save/load.
    {
        let mut project = project_state
            .project
            .lock()
            .map_err(|e| format!("Lock poisoned: {e}"))?;
        if enabled && has_valid_range {
            project.is_looping = true;
            project.loop_start_frames = Some(start_frames);
            project.loop_end_frames = Some(end_frames);
        } else {
            project.is_looping = false;
        }
        let project_name = project.name.clone();
        drop(project);
        let _ = project_state.mark_dirty(&project_name, None);
    }

    log::info!("[IPC] set_loop(enabled={enabled}, {start_frames}–{end_frames})");
    Ok(())
}

#[tauri::command]
fn set_loop_with_deltas(
    enabled: bool,
    start_frames: i64,
    end_frames: i64,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<TransportDeltaResponse, String> {
    set_loop(
        enabled,
        start_frames,
        end_frames,
        handle,
        project_state,
    )?;

    let effective_enabled = enabled && end_frames > start_frames;
    Ok(TransportDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::LoopRegionChanged {
            start: start_frames,
            end: end_frames,
            enabled: effective_enabled,
        }],
    })
}

#[cfg(test)]
mod tests {
    use super::beat_to_engine_frames;
    use dream_models::pulse_map::PulseMap;

    #[test]
    fn beat_to_engine_frames_prefers_project_pulse_map_over_fallback_bpm() {
        let pm = PulseMap::new(174.0, 44_100.0);
        // 33 bars at 4/4 => 132 beats.
        let beat = 132.0;
        let expected = pm.sample_frame(beat);
        // Deliberately mismatched fallback BPM to verify pulse map is authoritative.
        let got = beat_to_engine_frames(beat, Some(&pm), 120.0, 44_100.0);
        assert_eq!(got, expected);
    }

    #[test]
    fn beat_to_engine_frames_falls_back_to_bpm_when_no_pulse_map() {
        let beat = 16.0;
        let got = beat_to_engine_frames(beat, None, 120.0, 44_100.0);
        // 16 beats at 120 BPM => 8 seconds => 352800 frames @ 44.1kHz.
        assert_eq!(got, 352_800);
    }
}
