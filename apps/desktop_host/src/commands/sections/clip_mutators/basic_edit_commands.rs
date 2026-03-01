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
    .map_err(|e| e.to_string())?;

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

    // Capture the clip's original track index for the ClipMoved delta.
    let old_track_index = {
        let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        project.tracks.iter().position(|track| {
            track.clips.iter().any(|c| c.id == clip_uuid)
                || track.midi_clips.iter().any(|c| c.id == clip_uuid)
        }).unwrap_or(0)
    };

    let cmd = dream_orchestrator::commands::MoveClipCommand::from_str_id(
        &clip_id,
        new_track_index,
        new_position_frames,
    )
    .map_err(|e| e.to_string())?;

    let _ = execute_orchestrator_command(&project_state, &cmd)?;

    rebuild_clip_views_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;

    let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    let deltas = vec![
        dream_models::delta::ProjectDelta::ClipMoved {
            clip_id: clip_uuid,
            old_track_index,
            new_track_index,
            new_position: new_position_frames,
        },
        dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
            project: Box::new(project.clone()),
        },
    ];

    Ok(DeltaMutationResponse { deltas })
}

#[derive(serde::Deserialize)]
pub struct MoveClipRequestPayload {
    pub id: String,
    pub new_track_index: usize,
    pub new_position_frames: i64,
}

#[tauri::command]
async fn move_multiple_clips_with_deltas_cmd(
    requests: Vec<MoveClipRequestPayload>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    push_undo_coalesced(&project_state)?;

    // Capture original track indices for ClipMoved deltas.
    let mut valid_clips = Vec::with_capacity(requests.len());
    let mut old_track_indices: Vec<(Uuid, usize)> = Vec::with_capacity(requests.len());
    {
        let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        for req in &requests {
            if let Ok(uid) = Uuid::parse_str(&req.id) {
                let old_idx = project.tracks.iter().position(|track| {
                    track.clips.iter().any(|c| c.id == uid)
                        || track.midi_clips.iter().any(|c| c.id == uid)
                }).unwrap_or(0);
                old_track_indices.push((uid, old_idx));
                valid_clips.push((uid, req.new_track_index, req.new_position_frames));
            }
        }
    }

    let cmd = dream_orchestrator::commands::MoveMultipleClipsCommand { clips: valid_clips };
    let _ = execute_orchestrator_command(&project_state, &cmd)?;

    rebuild_clip_views_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;

    let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    let mut deltas: Vec<dream_models::delta::ProjectDelta> = Vec::with_capacity(old_track_indices.len() + 1);
    for ((uid, old_idx), req) in old_track_indices.iter().zip(requests.iter()) {
        deltas.push(dream_models::delta::ProjectDelta::ClipMoved {
            clip_id: *uid,
            old_track_index: *old_idx,
            new_track_index: req.new_track_index,
            new_position: req.new_position_frames,
        });
    }
    deltas.push(dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
        project: Box::new(project.clone()),
    });

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
    .map_err(|e| e.to_string())?;

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
        let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
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
    .map_err(|e| e.to_string())?;

    execute_orchestrator_command(&project_state, &cmd)?;

    let after_audio_state = {
        let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
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

    // OVERLAP FIX: Include full project snapshot so frontend sees
    // clips that were trimmed/split/deleted by handle_overlaps().
    // Same pattern as move_clip_with_deltas_cmd and duplicate_clip_with_deltas_cmd.
    {
        let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        deltas.push(dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
            project: Box::new(project.clone()),
        });
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
        .map_err(|e| e.to_string())?;

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
        .map_err(|e| e.to_string())?;

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
        .map_err(|e| e.to_string())?;

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
        .map_err(|e| e.to_string())?;

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
    target_track_index: Option<usize>,
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
        target_track_index,
    )
    .map_err(|e| e.to_string())?;

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
    target_track_index: Option<usize>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DuplicateClipWithDeltasResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    push_undo(&project_state)?;

    let source_clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;

    let cmd = dream_orchestrator::commands::DuplicateClipCommand::from_str_id(
        &clip_id,
        new_position_frames,
        target_track_index,
    )
    .map_err(|e| e.to_string())?;

    let result = execute_orchestrator_command(&project_state, &cmd)?;

    rebuild_clip_views_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;

    let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    // SSOT FIX: Emit ClipDuplicated delta so frontend can extract new clip ID
    // for auto-selection. ProjectSnapshotReplaced handles full state rebuild.
    let deltas = vec![
        dream_models::delta::ProjectDelta::ClipDuplicated {
            source_clip_id: source_clip_uuid,
            new_clip_id: result.new_id,
            new_position: result.new_position_frames,
            new_track_index: result.track_index,
            new_duration: result.new_duration_frames,
        },
        dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
            project: Box::new(project.clone()),
        },
    ];

    Ok(DuplicateClipWithDeltasResponse {
        new_id: result.new_id.to_string(),
        deltas,
    })
}

#[derive(serde::Deserialize)]
pub struct DuplicateClipRequestPayload {
    pub id: String,
    pub new_position_frames: Option<i64>,
    pub target_track_index: Option<usize>,
}

#[tauri::command]
async fn duplicate_multiple_clips_with_deltas_cmd(
    requests: Vec<DuplicateClipRequestPayload>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DuplicateClipWithDeltasResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    push_undo(&project_state)?;

    let mut valid_clips = Vec::with_capacity(requests.len());
    let mut source_ids: Vec<Uuid> = Vec::with_capacity(requests.len());
    for req in &requests {
        if let Ok(uid) = Uuid::parse_str(&req.id) {
            source_ids.push(uid);
            valid_clips.push((uid, req.new_position_frames, req.target_track_index));
        }
    }

    let cmd = dream_orchestrator::commands::DuplicateMultipleClipsCommand { clips: valid_clips };
    let results = execute_orchestrator_command(&project_state, &cmd)?;

    // SSOT FIX: Collect ALL new IDs and emit ClipDuplicated deltas for each.
    // This enables the frontend to auto-select all duplicated clips.
    let mut first_new_id = String::new();
    let mut clip_duplicated_deltas: Vec<dream_models::delta::ProjectDelta> = Vec::with_capacity(results.len());
    for (idx, res) in results.iter().enumerate() {
        if first_new_id.is_empty() {
            first_new_id = res.new_id.to_string();
        }
        let source_id = source_ids.get(idx).copied().unwrap_or(res.new_id);
        clip_duplicated_deltas.push(dream_models::delta::ProjectDelta::ClipDuplicated {
            source_clip_id: source_id,
            new_clip_id: res.new_id,
            new_position: res.new_position_frames,
            new_track_index: res.track_index,
            new_duration: res.new_duration_frames,
        });
    }

    rebuild_clip_views_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;

    let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    let mut deltas = clip_duplicated_deltas;
    deltas.push(dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
        project: Box::new(project.clone()),
    });

    Ok(DuplicateClipWithDeltasResponse {
        new_id: first_new_id,
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
        .map_err(|e| e.to_string())?;

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
        .map_err(|e| e.to_string())?;

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
