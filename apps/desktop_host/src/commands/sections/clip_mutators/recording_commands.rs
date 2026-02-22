/// Start live recording on the first armed track.
#[tauri::command]
async fn start_recording_cmd(
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    recording_runtime: tauri::State<'_, RecordingRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    if recording_runtime
        .session
        .lock()
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Err("Recording already in progress".to_string());
    }

    let armed_track_index = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        project
            .tracks
            .iter()
            .position(|t| t.is_armed)
            .ok_or_else(|| "No armed tracks".to_string())?
    };

    let output_dir = std::env::temp_dir().join("dream_daw_recordings");
    let start_frame = handle.master_clock.position();
    let file_name = format!(
        "recording_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs()
    );

    let session = RecordingSession::start(&output_dir, &file_name, start_frame)
        .map_err(|e| format!("start_recording failed: {e}"))?;

    let is_recording = Arc::clone(&session.state().is_recording);
    let peak_left = Arc::clone(&session.state().peak_left);
    let peak_right = Arc::clone(&session.state().peak_right);
    let app_for_peaks = app.clone();
    std::thread::spawn(move || {
        while is_recording.load(Ordering::Relaxed) {
            let left = f32::from_bits(peak_left.load(Ordering::Relaxed));
            let right = f32::from_bits(peak_right.load(Ordering::Relaxed));
            let payload = serde_json::json!({
                "track_index": armed_track_index,
                "peak": left.abs().max(right.abs()),
                "peaks": [left, right]
            });
            let _ = app_for_peaks.emit("live_audio_peaks", payload);
            std::thread::sleep(Duration::from_millis(16));
        }
    });

    *recording_runtime
        .session
        .lock()
        .map_err(|e| e.to_string())? = Some(session);
    *recording_runtime
        .armed_track_index
        .lock()
        .map_err(|e| e.to_string())? = Some(armed_track_index);

    Ok(())
}

/// Stop recording, finalize file, and place resulting clip on armed track.
#[tauri::command]
async fn stop_recording_cmd(
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    recording_runtime: tauri::State<'_, RecordingRuntime>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let session = recording_runtime
        .session
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or_else(|| "No active recording session".to_string())?;

    let armed_idx = recording_runtime
        .armed_track_index
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or_else(|| "Missing armed track index".to_string())?;

    let result = session
        .stop()
        .map_err(|e| format!("stop_recording failed: {e}"))?;
    let path = result.file_path.display().to_string();

    let decoded = AudioReader::read(&result.file_path)
        .map_err(|e| format!("Failed to decode recorded file: {e}"))?;
    {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        let _ = pool.insert(ClipAudio {
            source_path: path.clone(),
            channels: decoded.channels,
            sample_rate: decoded.sample_rate,
            num_frames: decoded.num_frames,
        });
    }

    push_undo(&project_state)?;
    let cmd = dream_orchestrator::commands::InsertRecordedClipCommand {
        track_index: armed_idx,
        clip_name: "Recording".to_string(),
        file_path: path.clone(),
        start_frame: result.start_frame,
        source_total_frames: result.total_frames as i64,
        source_sample_rate: decoded.sample_rate,
    };
    execute_orchestrator_command(&project_state, &cmd)?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(())
}

