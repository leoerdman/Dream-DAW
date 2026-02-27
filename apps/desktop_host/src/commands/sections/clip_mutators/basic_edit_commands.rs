#[tauri::command]
async fn move_clip_cmd(
    clip_id: String,
    new_track_index: usize,
    new_position_frames: i64,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    push_undo_coalesced(&project_state)?;

    let cmd = dream_orchestrator::commands::MoveClipCommand::from_str_id(
        &clip_id,
        new_track_index,
        new_position_frames,
    )
    .map_err(|_| "Mutex poisoned".to_string())?;

    execute_orchestrator_command(&project_state, &cmd)?;

    rebuild_clip_views_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;

    Ok(())
}

#[tauri::command]
async fn move_clip_with_deltas_cmd(
    clip_id: String,
    new_track_index: usize,
    new_position_frames: i64,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    push_undo_coalesced(&project_state)?;

    let clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;

    let cmd = dream_orchestrator::commands::MoveClipCommand::from_str_id(
        &clip_id,
        new_track_index,
        new_position_frames,
    )
    .map_err(|_| "Mutex poisoned".to_string())?;

    let result = execute_orchestrator_command(&project_state, &cmd)?;
    let deltas = vec![dream_models::delta::ProjectDelta::ClipMoved {
        clip_id: clip_uuid,
        old_track_index: result.old_track_index,
        new_track_index,
        new_position: new_position_frames,
    }];

    rebuild_clip_views_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;

    Ok(DeltaMutationResponse { deltas })
}

/// Resizes a clip to a new position and duration.
#[tauri::command]
async fn resize_clip_cmd(
    clip_id: String,
    new_position_frames: i64,
    new_duration_frames: i64,
    allow_stretch: Option<bool>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    // CQRS: coalesced undo + delegate to orchestrator + snapshot rebuild
    push_undo_coalesced(&project_state)?;

    let cmd = dream_orchestrator::commands::ResizeClipCommand::from_str_id(
        &clip_id,
        new_position_frames,
        new_duration_frames,
        allow_stretch.unwrap_or(false),
    )
    .map_err(|_| "Mutex poisoned".to_string())?;

    execute_orchestrator_command(&project_state, &cmd)?;

    rebuild_clip_views_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;

    Ok(())
}

#[tauri::command]
async fn resize_clip_with_deltas_cmd(
    clip_id: String,
    new_position_frames: i64,
    new_duration_frames: i64,
    allow_stretch: Option<bool>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    push_undo_coalesced(&project_state)?;

    let clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let before_audio_state = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project
            .tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .find(|c| c.id == clip_uuid)
            .map(|clip| {
                (
                    clip.position.sample_frame,
                    clip.duration.sample_frame,
                    clip.source_offset.sample_frame,
                    clip.is_warped,
                    clip.warp_mode,
                    clip.warp_base_bpm,
                    clip.warp_source_duration_frames,
                )
            })
    };
    let cmd = dream_orchestrator::commands::ResizeClipCommand::from_str_id(
        &clip_id,
        new_position_frames,
        new_duration_frames,
        allow_stretch.unwrap_or(false),
    )
    .map_err(|_| "Mutex poisoned".to_string())?;

    execute_orchestrator_command(&project_state, &cmd)?;

    let after_audio_state = {
        let project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
        project
            .tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .find(|c| c.id == clip_uuid)
            .map(|clip| {
                (
                    clip.position.sample_frame,
                    clip.duration.sample_frame,
                    clip.source_offset.sample_frame,
                    clip.is_warped,
                    clip.warp_mode,
                    clip.warp_base_bpm,
                    clip.warp_source_duration_frames,
                )
            })
    };

    let (actual_position, actual_duration) = after_audio_state
        .map(|a| (a.0, a.1))
        .unwrap_or((new_position_frames, new_duration_frames));
    let mut deltas = vec![dream_models::delta::ProjectDelta::ClipResized {
        clip_id: clip_uuid,
        new_position: actual_position,
        new_duration: actual_duration,
    }];

    if let (Some(before), Some(after)) = (before_audio_state, after_audio_state) {
        if before.2 != after.2 {
            deltas.push(dream_models::delta::ProjectDelta::ClipSourceOffsetChanged {
                clip_id: clip_uuid,
                source_offset: after.2,
            });
        }
        if before.3 != after.3
            || before.4 != after.4
            || (before.5 - after.5).abs() > f64::EPSILON
            || before.6 != after.6
        {
            deltas.push(dream_models::delta::ProjectDelta::ClipWarpChanged {
                clip_id: clip_uuid,
                is_warped: after.3,
                warp_mode: after.4,
                warp_base_bpm: after.5,
                warp_source_duration_frames: after.6,
            });
        }
    }

    rebuild_clip_views_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;

    Ok(DeltaMutationResponse { deltas })
}

/// Splits a clip at the given sample frame position.
///
/// Returns the UUIDs of the two resulting clips (left keeps original UUID).
/// Both halves preserve correct source_offset for seamless playback.
/// Handles both audio and MIDI clips — tries audio first, falls back to MIDI.
#[tauri::command]
async fn split_clip_cmd(
    clip_id: String,
    split_frame: i64,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<SplitClipResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::SplitClipCommand::from_str_id(&clip_id, split_frame)
        .map_err(|_| "Mutex poisoned".to_string())?;

    let result = execute_orchestrator_command(&project_state, &cmd)?;

    rebuild_clip_views_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;

    Ok(SplitClipResponse {
        left_id: result.left_id.to_string(),
        right_id: result.right_id.to_string(),
    })
}

#[tauri::command]
async fn split_clip_with_deltas_cmd(
    clip_id: String,
    split_frame: i64,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<SplitClipWithDeltasResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    push_undo(&project_state)?;

    let clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let cmd = dream_orchestrator::commands::SplitClipCommand::from_str_id(&clip_id, split_frame)
        .map_err(|_| "Mutex poisoned".to_string())?;

    let result = execute_orchestrator_command(&project_state, &cmd)?;

    let deltas = vec![dream_models::delta::ProjectDelta::ClipSplit {
        original_clip_id: clip_uuid,
        left_id: result.left_id,
        right_id: result.right_id,
        split_frame,
    }];

    rebuild_clip_views_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;

    Ok(SplitClipWithDeltasResponse {
        left_id: result.left_id.to_string(),
        right_id: result.right_id.to_string(),
        deltas,
    })
}

/// Deletes a clip from the project by UUID.
///
/// The removed clip data is returned for potential client-side undo.
#[tauri::command]
async fn delete_clip_cmd(
    clip_id: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::DeleteClipCommand::from_str_id(&clip_id)
        .map_err(|_| "Mutex poisoned".to_string())?;

    execute_orchestrator_command(&project_state, &cmd)?;

    rebuild_clip_views_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;

    clip_pool_state.evict_unused_clips(&project_state);

    Ok(())
}

#[tauri::command]
async fn delete_clip_with_deltas_cmd(
    clip_id: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    push_undo(&project_state)?;

    let clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;

    let cmd = dream_orchestrator::commands::DeleteClipCommand::from_str_id(&clip_id)
        .map_err(|_| "Mutex poisoned".to_string())?;

    let result = execute_orchestrator_command(&project_state, &cmd)?;

    let deltas = vec![dream_models::delta::ProjectDelta::ClipDeleted {
        clip_id: clip_uuid,
        track_index: result.track_index,
    }];

    rebuild_clip_views_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;
    clip_pool_state.evict_unused_clips(&project_state);

    Ok(DeltaMutationResponse { deltas })
}

/// Duplicate a clip, optionally at a specific destination position.
#[tauri::command]
async fn duplicate_clip_cmd(
    clip_id: String,
    new_position_frames: Option<i64>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DuplicateClipResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::DuplicateClipCommand::from_str_id(
        &clip_id,
        new_position_frames,
    )
    .map_err(|_| "Mutex poisoned".to_string())?;

    let result = execute_orchestrator_command(&project_state, &cmd)?;

    rebuild_clip_views_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;

    Ok(DuplicateClipResponse {
        new_id: result.new_id.to_string(),
    })
}

#[tauri::command]
async fn duplicate_clip_with_deltas_cmd(
    clip_id: String,
    new_position_frames: Option<i64>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DuplicateClipWithDeltasResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    push_undo(&project_state)?;

    let source_clip_uuid =
        Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let cmd = dream_orchestrator::commands::DuplicateClipCommand::from_str_id(
        &clip_id,
        new_position_frames,
    )
    .map_err(|_| "Mutex poisoned".to_string())?;

    let result = execute_orchestrator_command(&project_state, &cmd)?;

    let deltas = vec![dream_models::delta::ProjectDelta::ClipDuplicated {
        source_clip_id: source_clip_uuid,
        new_clip_id: result.new_id,
        new_position: result.new_position_frames,
    }];

    rebuild_clip_views_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;

    Ok(DuplicateClipWithDeltasResponse {
        new_id: result.new_id.to_string(),
        deltas,
    })
}

/// Merge selected clips into one clip on the same track.
#[tauri::command]
async fn merge_clips_cmd(
    clip_ids: Vec<String>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<MergeClipsResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::MergeClipsCommand::from_str_ids(&clip_ids)
        .map_err(|_| "Mutex poisoned".to_string())?;

    let result = execute_orchestrator_command(&project_state, &cmd)?;

    rebuild_clip_views_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::FullSnapshot,
    )?;

    Ok(MergeClipsResponse {
        new_id: result.new_id.to_string(),
    })
}

#[tauri::command]
async fn merge_clips_with_deltas_cmd(
    clip_ids: Vec<String>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<MergeClipsWithDeltasResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    push_undo(&project_state)?;

    let source_ids: Vec<Uuid> = clip_ids
        .iter()
        .filter_map(|id| Uuid::parse_str(id).ok())
        .collect();

    let cmd = dream_orchestrator::commands::MergeClipsCommand::from_str_ids(&clip_ids)
        .map_err(|_| "Mutex poisoned".to_string())?;

    let result = execute_orchestrator_command(&project_state, &cmd)?;

    let deltas = vec![dream_models::delta::ProjectDelta::ClipsMerged {
        source_clip_ids: source_ids,
        new_clip_id: result.new_id,
    }];

    rebuild_clip_views_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::FullSnapshot,
    )?;

    Ok(MergeClipsWithDeltasResponse {
        new_id: result.new_id.to_string(),
        deltas,
    })
}
