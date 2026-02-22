/// Clear clip color overrides on a track so all clips inherit track color.
#[tauri::command]
async fn paint_track_clips_with_track_color_cmd(
    track_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::PaintTrackClipsWithTrackColorCommand::from_str_id(&track_id)
        .map_err(|e| e.to_string())?;

    let changed = execute_orchestrator_command(&project_state, &cmd)?;

    if changed {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        clip_pool_state.rebuild_clips_only(&project);
        rebuild_midi_snapshot_from_project(&project, &handle);
        let project_name = project.name.clone();
        drop(project);
        project_state.mark_dirty(&project_name, Some(&app))?;
    }

    Ok(())
}

#[tauri::command]
async fn paint_track_clips_with_track_color_with_deltas_cmd(
    track_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    paint_track_clips_with_track_color_cmd(
        track_id,
        project_state.clone(),
        clip_pool_state,
        handle,
        app,
    )
    .await?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();
    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
            project: Box::new(project),
        }],
    })
}

/// Resolve offline media path for an existing clip.
#[tauri::command]
async fn resolve_missing_file_cmd(
    clip_id: String,
    new_path: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if !PathBuf::from(&new_path).exists() {
        return Err(format!("Resolved file does not exist: {new_path}"));
    }

    push_undo(&project_state)?;

    let cmd =
        dream_orchestrator::commands::ResolveMissingClipFileCommand::from_str_id(&clip_id, &new_path)
            .map_err(|e| e.to_string())?;

    execute_orchestrator_command(&project_state, &cmd)?;

    // Load resolved media into clip pool so playback recovers immediately.
    let decoded = AudioReader::read(PathBuf::from(&new_path))
        .map_err(|e| format!("Failed to decode resolved audio: {e}"))?;
    {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        let _ = pool.insert(ClipAudio {
            source_path: new_path.clone(),
            channels: decoded.channels,
            sample_rate: decoded.sample_rate,
            num_frames: decoded.num_frames,
        });
    }

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

/// Resolve offline media path and return snapshot delta for frontend sync.
#[tauri::command]
async fn resolve_missing_file_with_deltas_cmd(
    clip_id: String,
    new_path: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    if !PathBuf::from(&new_path).exists() {
        return Err(format!("Resolved file does not exist: {new_path}"));
    }

    push_undo(&project_state)?;

    let cmd =
        dream_orchestrator::commands::ResolveMissingClipFileCommand::from_str_id(&clip_id, &new_path)
            .map_err(|e| e.to_string())?;

    execute_orchestrator_command(&project_state, &cmd)?;

    let decoded = AudioReader::read(PathBuf::from(&new_path))
        .map_err(|e| format!("Failed to decode resolved audio: {e}"))?;
    {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        let _ = pool.insert(ClipAudio {
            source_path: new_path.clone(),
            channels: decoded.channels,
            sample_rate: decoded.sample_rate,
            num_frames: decoded.num_frames,
        });
    }

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
            project: Box::new(project.clone()),
        }],
    })
}

/// Accept automation points from frontend (throttled there to 16ms).
#[tauri::command]
async fn set_automation_points_cmd(
    track_id: String,
    param_id: String,
    points: Vec<AutomationPointPayload>,
    project_state: tauri::State<'_, ProjectState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let persistent_points = points
        .iter()
        .map(|p| dream_models::project::AutomationPoint {
            beat: p.beat,
            value: p.value,
            curve_type: p.curve_type.clone(),
            tension: p.tension,
            bezier_cp1x: None,
            bezier_cp1y: None,
            bezier_cp2x: None,
            bezier_cp2y: None,
        })
        .collect::<Vec<_>>();

    let cmd = dream_orchestrator::commands::SetTrackAutomationPointsCommand::from_str_id(
        &track_id,
        &param_id,
        persistent_points,
    )
    .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    execute_orchestrator_command(&project_state, &cmd)?;

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    rebuild_automation_snapshot_from_project(&project, &automation_runtime);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::debug!(
        "[IPC] set_automation_points_cmd track={} param={} points={}",
        track_id,
        param_id,
        points.len()
    );
    Ok(())
}

#[tauri::command]
async fn set_automation_points_with_deltas_cmd(
    track_id: String,
    param_id: String,
    points: Vec<AutomationPointPayload>,
    project_state: tauri::State<'_, ProjectState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track ID: {e}"))?;
    let normalized_param_id = param_id.trim().to_string();

    set_automation_points_cmd(
        track_id,
        param_id,
        points.clone(),
        project_state,
        automation_runtime,
        app,
    )
    .await?;

    let mut normalized_points: Vec<dream_models::delta::AutomationPointDelta> = points
        .into_iter()
        .map(|point| dream_models::delta::AutomationPointDelta {
            beat: point.beat.max(0.0),
            value: point.value,
            curve_type: point.curve_type,
            tension: point.tension,
        })
        .collect();
    normalized_points.sort_by(|a, b| a.beat.total_cmp(&b.beat));

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::AutomationPointsChanged {
            track_id: track_uuid,
            param_id: normalized_param_id,
            points: normalized_points,
        }],
    })
}

/// Arm/disarm a track for recording.
#[tauri::command]
async fn arm_track_cmd(
    track_index: usize,
    armed: bool,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let cmd = dream_orchestrator::commands::SetTrackArmedCommand { track_index, armed };

    execute_orchestrator_command(&project_state, &cmd)?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

#[tauri::command]
async fn arm_track_with_deltas_cmd(
    track_index: usize,
    armed: bool,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    arm_track_cmd(track_index, armed, project_state, app).await?;

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackArmChanged { track_index, armed }],
    })
}
