/// Clear clip color overrides on a track so all clips inherit track color.
#[tauri::command]
async fn paint_track_clips_with_track_color_cmd(
    track_id: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::PaintTrackClipsWithTrackColorCommand::from_str_id(&track_id)
        .map_err(|e| e.to_string())?;

    let changed = execute_orchestrator_command(&project_state, &cmd)?;

    if changed {
        rebuild_clip_views_and_mark_dirty(
            project_state,
            &clip_pool_state,
            &handle,
            &app,
            ClipRebuildMode::ClipsOnly,
        )?;
    }

    Ok(())
}

#[tauri::command]
async fn paint_track_clips_with_track_color_with_deltas_cmd(
    track_id: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let track_uuid =
        Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track_id: {e}"))?;
    let before_colors = execute_orchestrator_query(
        &project_state,
        &dream_orchestrator::queries::ResolveTrackClipColorsQuery {
            track_id: track_uuid,
        },
    )?;

    paint_track_clips_with_track_color_cmd(
        track_id,
        project_registry.clone(),
        clip_pool_state,
        handle,
        app,
    )
    .await?;

    let after_colors = execute_orchestrator_query(
        &project_state,
        &dream_orchestrator::queries::ResolveTrackClipColorsQuery {
            track_id: track_uuid,
        },
    )?;

    let deltas = after_colors
        .into_iter()
        .filter_map(|(clip_id, color)| {
            if before_colors.get(&clip_id) == Some(&color) {
                return None;
            }
            Some(dream_models::delta::ProjectDelta::ClipColorChanged {
                clip_id,
                color,
            })
        })
        .collect();

    Ok(DeltaMutationResponse {
        deltas,
    })
}

/// Resolve offline media path for an existing clip.
#[tauri::command]
async fn resolve_missing_file_cmd(
    clip_id: String,
    new_path: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
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

    rebuild_clip_snapshot_and_mark_dirty(project_state, &clip_pool_state, &app)?;
    Ok(())
}

/// Resolve offline media path and return snapshot delta for frontend sync.
#[tauri::command]
async fn resolve_missing_file_with_deltas_cmd(
    clip_id: String,
    new_path: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
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

    let clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let updated_clip = execute_orchestrator_query(
        &project_state,
        &dream_orchestrator::queries::ResolveAudioClipStateQuery { clip_id: clip_uuid },
    )?;
    rebuild_clip_snapshot_and_mark_dirty(project_state, &clip_pool_state, &app)?;

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::ClipFilePathChanged {
            clip_id: clip_uuid,
            file_path: updated_clip.file_path,
            is_offline: updated_clip.is_offline,
        }],
    })
}

/// Accept automation points from frontend (throttled there to 16ms).
#[tauri::command]
async fn set_automation_points_cmd(
    track_id: String,
    param_id: String,
    points: Vec<AutomationPointPayload>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    app: tauri::AppHandle,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
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
    rebuild_automation_and_mark_dirty(project_state, &automation_runtime, &app)?;

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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let cmd = dream_orchestrator::commands::SetTrackArmedCommand { track_index, armed };

    execute_orchestrator_command(&project_state, &cmd)?;
    project_state.mark_dirty_current(Some(&app))?;
    Ok(())
}

#[tauri::command]
async fn arm_track_with_deltas_cmd(
    track_index: usize,
    armed: bool,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    arm_track_cmd(track_index, armed, project_registry, app).await?;

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackArmChanged { track_index, armed }],
    })
}
