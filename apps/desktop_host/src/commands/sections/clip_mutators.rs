// ═══════════════════════════════════════════════════════════════════════

/// Response type for the split_clip command.
#[derive(Debug, Serialize, Deserialize)]
struct SplitClipResponse {
    left_id: String,
    right_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SplitClipWithDeltasResponse {
    left_id: String,
    right_id: String,
    deltas: Vec<dream_models::delta::ProjectDelta>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DuplicateClipWithDeltasResponse {
    new_id: String,
    deltas: Vec<dream_models::delta::ProjectDelta>,
}

#[derive(Debug, Serialize, Deserialize)]
struct MergeClipsWithDeltasResponse {
    new_id: String,
    deltas: Vec<dream_models::delta::ProjectDelta>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DuplicateClipResponse {
    new_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct MergeClipsResponse {
    new_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BounceSelectionPayload {
    #[serde(default)]
    clip_ids: Vec<String>,
    range_start_frames: Option<i64>,
    range_end_frames: Option<i64>,
    start_track_index: Option<usize>,
    end_track_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplitTrackToStemsPayload {
    track_id: String,
}

#[path = "clip_mutators/helpers.rs"]
mod helpers;
use helpers::{
    build_local_pool_for_project, find_audio_clip_delta_state, find_clip_position_frames,
    find_clip_track_index, place_bounced_file_on_new_track, place_stem_files_on_new_tracks,
};

#[path = "clip_mutators/jobs.rs"]
mod jobs;
use jobs::{
    background_jobs, emit_job_update, finish_job, prune_finished_jobs_locked, set_job_progress,
    start_job, BackgroundJobSnapshot,
};

#[tauri::command]
async fn move_clip_cmd(
    clip_id: String,
    new_track_index: usize,
    new_position_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    push_undo_coalesced(&project_state)?;

    let cmd = dream_orchestrator::commands::MoveClipCommand::from_str_id(
        &clip_id,
        new_track_index,
        new_position_frames,
    )
    .map_err(|e| e.to_string())?;

    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        let result_project = ctx.lock_project().map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? = result_project.clone();
    }

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_clips_only(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(())
}

#[tauri::command]
async fn move_clip_with_deltas_cmd(
    clip_id: String,
    new_track_index: usize,
    new_position_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    push_undo_coalesced(&project_state)?;

    let clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let old_track_index = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        find_clip_track_index(&project, clip_uuid)
    };

    let cmd = dream_orchestrator::commands::MoveClipCommand::from_str_id(
        &clip_id,
        new_track_index,
        new_position_frames,
    )
    .map_err(|e| e.to_string())?;

    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        let result_project = ctx.lock_project().map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? = result_project.clone();
    }

    let Some(old_track_index) = old_track_index else { return Err(format!("Delta invariant violated: source track not found for clip {clip_uuid} in move_clip_with_deltas_cmd")); };
    let deltas = vec![dream_models::delta::ProjectDelta::ClipMoved {
        clip_id: clip_uuid,
        old_track_index,
        new_track_index,
        new_position: new_position_frames,
    }];

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_clips_only(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(DeltaMutationResponse { deltas })
}

/// Resizes a clip to a new position and duration.
#[tauri::command]
async fn resize_clip_cmd(
    clip_id: String,
    new_position_frames: i64,
    new_duration_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // CQRS: coalesced undo + delegate to orchestrator + snapshot rebuild
    push_undo_coalesced(&project_state)?;

    let cmd = dream_orchestrator::commands::ResizeClipCommand::from_str_id(
        &clip_id,
        new_position_frames,
        new_duration_frames,
    )
    .map_err(|e| e.to_string())?;

    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
    }

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_clips_only(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(())
}

#[tauri::command]
async fn resize_clip_with_deltas_cmd(
    clip_id: String,
    new_position_frames: i64,
    new_duration_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    push_undo_coalesced(&project_state)?;

    let clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let cmd = dream_orchestrator::commands::ResizeClipCommand::from_str_id(
        &clip_id,
        new_position_frames,
        new_duration_frames,
    )
    .map_err(|e| e.to_string())?;

    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
    }

    let deltas = vec![dream_models::delta::ProjectDelta::ClipResized {
        clip_id: clip_uuid,
        new_position: new_position_frames,
        new_duration: new_duration_frames,
    }];

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_clips_only(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

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
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<SplitClipResponse, String> {
    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::SplitClipCommand::from_str_id(&clip_id, split_frame)
        .map_err(|e| e.to_string())?;

    let result = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let r = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
        r
    };

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_clips_only(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(SplitClipResponse {
        left_id: result.left_id.to_string(),
        right_id: result.right_id.to_string(),
    })
}

#[tauri::command]
async fn split_clip_with_deltas_cmd(
    clip_id: String,
    split_frame: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<SplitClipWithDeltasResponse, String> {
    push_undo(&project_state)?;

    let clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let cmd = dream_orchestrator::commands::SplitClipCommand::from_str_id(&clip_id, split_frame)
        .map_err(|e| e.to_string())?;

    let result = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let r = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
        r
    };

    let deltas = vec![dream_models::delta::ProjectDelta::ClipSplit {
        original_clip_id: clip_uuid,
        left_id: result.left_id,
        right_id: result.right_id,
        split_frame,
    }];

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_clips_only(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

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
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::DeleteClipCommand::from_str_id(&clip_id)
        .map_err(|e| e.to_string())?;

    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
    }

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_clips_only(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    clip_pool_state.evict_unused_clips(&project_state);

    Ok(())
}

#[tauri::command]
async fn delete_clip_with_deltas_cmd(
    clip_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    push_undo(&project_state)?;

    let clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let track_index_before = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        find_clip_track_index(&project, clip_uuid)
    };

    let cmd = dream_orchestrator::commands::DeleteClipCommand::from_str_id(&clip_id)
        .map_err(|e| e.to_string())?;

    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
    }

    let Some(track_index) = track_index_before else { return Err(format!("Delta invariant violated: source track not found for clip {clip_uuid} in delete_clip_with_deltas_cmd")); };
    let deltas = vec![dream_models::delta::ProjectDelta::ClipDeleted {
        clip_id: clip_uuid,
        track_index,
    }];

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_clips_only(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    clip_pool_state.evict_unused_clips(&project_state);

    Ok(DeltaMutationResponse { deltas })
}

/// Duplicate a clip, optionally at a specific destination position.
#[tauri::command]
async fn duplicate_clip_cmd(
    clip_id: String,
    new_position_frames: Option<i64>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DuplicateClipResponse, String> {
    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::DuplicateClipCommand::from_str_id(
        &clip_id,
        new_position_frames,
    )
    .map_err(|e| e.to_string())?;

    let result = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let r = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
        r
    };

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_clips_only(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(DuplicateClipResponse {
        new_id: result.new_id.to_string(),
    })
}

#[tauri::command]
async fn duplicate_clip_with_deltas_cmd(
    clip_id: String,
    new_position_frames: Option<i64>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DuplicateClipWithDeltasResponse, String> {
    push_undo(&project_state)?;

    let source_clip_uuid =
        Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let cmd = dream_orchestrator::commands::DuplicateClipCommand::from_str_id(
        &clip_id,
        new_position_frames,
    )
    .map_err(|e| e.to_string())?;

    let result = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let r = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
        r
    };

    let deltas = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let Some(new_position) = find_clip_position_frames(&project, result.new_id) else { return Err(format!("Delta invariant violated: duplicated clip {} not found after duplicate_clip_with_deltas_cmd", result.new_id)); };
        vec![dream_models::delta::ProjectDelta::ClipDuplicated {
            source_clip_id: source_clip_uuid,
            new_clip_id: result.new_id,
            new_position,
        }]
    };

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_clips_only(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(DuplicateClipWithDeltasResponse {
        new_id: result.new_id.to_string(),
        deltas,
    })
}

/// Merge selected clips into one clip on the same track.
#[tauri::command]
async fn merge_clips_cmd(
    clip_ids: Vec<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<MergeClipsResponse, String> {
    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::MergeClipsCommand::from_str_ids(&clip_ids)
        .map_err(|e| e.to_string())?;

    let result = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let r = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
        r
    };

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(MergeClipsResponse {
        new_id: result.new_id.to_string(),
    })
}

#[tauri::command]
async fn merge_clips_with_deltas_cmd(
    clip_ids: Vec<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<MergeClipsWithDeltasResponse, String> {
    push_undo(&project_state)?;

    let source_ids: Vec<Uuid> = clip_ids
        .iter()
        .filter_map(|id| Uuid::parse_str(id).ok())
        .collect();

    let cmd = dream_orchestrator::commands::MergeClipsCommand::from_str_ids(&clip_ids)
        .map_err(|e| e.to_string())?;

    let result = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let r = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
        r
    };

    let deltas = vec![dream_models::delta::ProjectDelta::ClipsMerged {
        source_clip_ids: source_ids,
        new_clip_id: result.new_id,
    }];

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(MergeClipsWithDeltasResponse {
        new_id: result.new_id.to_string(),
        deltas,
    })
}

/// Update a clip's source offset (slip editing).
#[tauri::command]
async fn set_clip_source_offset_cmd(
    clip_id: String,
    source_offset_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::SetClipSourceOffsetCommand::from_str_id(
        &clip_id,
        source_offset_frames,
    )
    .map_err(|e| e.to_string())?;

    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
    }

    // BUG-AUD-1 FIX: Post-orchestrator source_offset clamping.
    // The orchestrator uses NoopClipPoolAccess (max_offset=i64::MAX).
    // Clamp against the REAL clip pool to prevent reading past the decoded buffer.
    {
        let clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
        let clip_file_path = {
            let project = project_state.project.lock().map_err(|e| e.to_string())?;
            project
                .tracks
                .iter()
                .flat_map(|t| t.clips.iter())
                .find(|c| c.id == clip_uuid)
                .map(|c| c.file_path.clone())
                .ok_or_else(|| format!("Audio clip not found: {clip_id}"))?
        };
        let pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        if let Some(audio) = pool.get(&clip_file_path) {
            let max_offset = (audio.num_frames as i64).saturating_sub(1).max(0);
            let clamp_cmd = dream_orchestrator::commands::ClampClipSourceOffsetCommand::from_str_id(
                &clip_id, max_offset,
            )
            .map_err(|e| e.to_string())?;
            let ctx = dream_orchestrator::OrchestratorContext::new(
                project_state
                    .project
                    .lock()
                    .map_err(|e| e.to_string())?
                    .clone(),
            );
            let changed = ctx.execute(&clamp_cmd).map_err(|e| e.to_string())?;
            if changed {
                *project_state.project.lock().map_err(|e| e.to_string())? =
                    ctx.lock_project().map_err(|e| e.to_string())?.clone();
            }
        }
    }

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_clips_only(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

#[tauri::command]
async fn set_clip_source_offset_with_deltas_cmd(
    clip_id: String,
    source_offset_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let before_state = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        find_audio_clip_delta_state(&project, clip_uuid)
            .ok_or_else(|| format!("Audio clip not found: {clip_id}"))?
    };

    set_clip_source_offset_cmd(
        clip_id,
        source_offset_frames,
        project_state.clone(),
        clip_pool_state,
        app,
    )
    .await?;

    let after_state = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        find_audio_clip_delta_state(&project, clip_uuid)
            .ok_or_else(|| format!("Audio clip not found after source-offset update: {clip_uuid}"))?
    };

    let mut deltas = Vec::new();
    if before_state.source_offset != after_state.source_offset {
        deltas.push(dream_models::delta::ProjectDelta::ClipSourceOffsetChanged {
            clip_id: clip_uuid,
            source_offset: after_state.source_offset,
        });
    }
    Ok(DeltaMutationResponse { deltas })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetClipWarpPayload {
    clip_id: String,
    is_warped: bool,
    warp_mode: Option<i32>,
    warp_base_bpm: Option<f64>,
}

#[derive(serde::Deserialize)]
struct SetClipPitchPayload {
    clip_id: String,
    pitch_shift_semitones: f64,
}

/// Set clip pitch shift semitones.
#[tauri::command]
async fn set_clip_pitch_cmd(
    payload: SetClipPitchPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::SetClipPitchCommand::from_str_id(
        &payload.clip_id,
        payload.pitch_shift_semitones,
    )
    .map_err(|e| e.to_string())?;

    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
    }

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_clips_only(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

/// Set clip warp state/mode/base BPM and recalculate timeline duration.
#[tauri::command]
async fn set_clip_warp_cmd(
    payload: SetClipWarpPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::SetClipWarpCommand::from_str_id(
        &payload.clip_id,
        payload.is_warped,
        payload.warp_mode,
        payload.warp_base_bpm,
    )
    .map_err(|e| e.to_string())?;

    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
    }

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_clips_only(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

#[tauri::command]
async fn set_clip_warp_with_deltas_cmd(
    payload: SetClipWarpPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let clip_uuid =
        Uuid::parse_str(&payload.clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let before_state = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        find_audio_clip_delta_state(&project, clip_uuid)
            .ok_or_else(|| format!("Audio clip not found: {}", payload.clip_id))?
    };

    set_clip_warp_cmd(
        payload,
        project_state.clone(),
        clip_pool_state,
        app,
    )
    .await?;

    let after_state = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        find_audio_clip_delta_state(&project, clip_uuid)
            .ok_or_else(|| format!("Audio clip not found after warp update: {clip_uuid}"))?
    };

    let mut deltas = Vec::new();
    if before_state.is_warped != after_state.is_warped
        || before_state.warp_mode != after_state.warp_mode
        || (before_state.warp_base_bpm - after_state.warp_base_bpm).abs() > f64::EPSILON
    {
        deltas.push(dream_models::delta::ProjectDelta::ClipWarpChanged {
            clip_id: clip_uuid,
            is_warped: after_state.is_warped,
            warp_mode: after_state.warp_mode,
            warp_base_bpm: after_state.warp_base_bpm,
        });
    }
    Ok(DeltaMutationResponse { deltas })
}

/// Set clip fades. Current engine applies always-on micro-fades; this command is
/// accepted for IPC compatibility with interactive UI fade handles.
#[tauri::command]
async fn set_clip_fades_cmd(
    clip_id: String,
    fade_in_frames: i64,
    fade_out_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::SetClipFadesCommand::from_str_id(
        &clip_id,
        fade_in_frames,
        fade_out_frames,
    )
    .map_err(|e| e.to_string())?;

    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
    }

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_clips_only(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

#[tauri::command]
async fn set_clip_fades_with_deltas_cmd(
    clip_id: String,
    fade_in_frames: i64,
    fade_out_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let before_state = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        find_audio_clip_delta_state(&project, clip_uuid)
            .ok_or_else(|| format!("Audio clip not found: {clip_id}"))?
    };

    set_clip_fades_cmd(
        clip_id,
        fade_in_frames,
        fade_out_frames,
        project_state.clone(),
        clip_pool_state,
        handle,
        app,
    )
    .await?;

    let after_state = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        find_audio_clip_delta_state(&project, clip_uuid)
            .ok_or_else(|| format!("Audio clip not found after fades update: {clip_uuid}"))?
    };

    let mut deltas = Vec::new();
    if before_state.fade_in_frames != after_state.fade_in_frames
        || before_state.fade_out_frames != after_state.fade_out_frames
    {
        deltas.push(dream_models::delta::ProjectDelta::ClipFadesChanged {
            clip_id: clip_uuid,
            fade_in_frames: after_state.fade_in_frames,
            fade_out_frames: after_state.fade_out_frames,
        });
    }
    Ok(DeltaMutationResponse { deltas })
}

/// Toggle mute state on a clip (audio or MIDI).
///
/// Muted clips remain on the timeline but are skipped during playback.
/// The visual renderer draws them with a dark overlay.
#[tauri::command]
async fn set_clip_muted_cmd(
    clip_id: String,
    muted: bool,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::MuteClipCommand::from_str_id(&clip_id, muted)
        .map_err(|e| e.to_string())?;

    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
    }

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_clips_only(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::info!("[IPC] set_clip_muted_cmd clip={} muted={}", clip_id, muted);
    Ok(())
}

#[tauri::command]
async fn set_clip_muted_with_deltas_cmd(
    clip_id: String,
    muted: bool,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    push_undo(&project_state)?;

    let clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let cmd = dream_orchestrator::commands::MuteClipCommand::from_str_id(&clip_id, muted)
        .map_err(|e| e.to_string())?;

    let changed = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let r = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
        r
    };

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_clips_only(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    let mut deltas = Vec::new();
    if changed {
        deltas.push(dream_models::delta::ProjectDelta::ClipMuteChanged {
            clip_id: clip_uuid,
            muted,
        });
    }
    Ok(DeltaMutationResponse { deltas })
}

/// Set mute state on multiple clips in one operation.
///
/// This creates a single undo step for the whole batch and avoids undo spam.
#[tauri::command]
async fn set_clips_muted_cmd(
    clip_ids: Vec<String>,
    muted: bool,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    if clip_ids.is_empty() {
        return Ok(0);
    }

    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::MuteClipsBatchCommand::from_str_ids(&clip_ids, muted)
        .map_err(|e| e.to_string())?;

    let applied = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let r = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
        r
    };

    if applied > 0 {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let project_name = project.name.clone();
        clip_pool_state.rebuild_clips_only(&project);
        rebuild_midi_snapshot_from_project(&project, &handle);
        drop(project);
        project_state.mark_dirty(&project_name, Some(&app))?;
    }

    log::info!(
        "[IPC] set_clips_muted_cmd clips={} muted={} applied={}",
        clip_ids.len(),
        muted,
        applied
    );

    Ok(applied)
}

#[tauri::command]
async fn set_clips_muted_with_deltas_cmd(
    clip_ids: Vec<String>,
    muted: bool,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    if clip_ids.is_empty() {
        return Ok(DeltaMutationResponse { deltas: Vec::new() });
    }

    push_undo(&project_state)?;

    let parsed_ids: Vec<Uuid> = clip_ids
        .iter()
        .filter_map(|id| Uuid::parse_str(id).ok())
        .collect();

    let cmd = dream_orchestrator::commands::MuteClipsBatchCommand::from_str_ids(&clip_ids, muted)
        .map_err(|e| e.to_string())?;

    let applied = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let r = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
        r
    };

    if applied > 0 {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let project_name = project.name.clone();
        clip_pool_state.rebuild_clips_only(&project);
        rebuild_midi_snapshot_from_project(&project, &handle);
        drop(project);
        project_state.mark_dirty(&project_name, Some(&app))?;
    }

    let deltas = parsed_ids
        .into_iter()
        .map(|clip_id| dream_models::delta::ProjectDelta::ClipMuteChanged { clip_id, muted })
        .collect();
    Ok(DeltaMutationResponse { deltas })
}

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

    let changed = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let changed = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        if changed {
            let result_project = ctx.lock_project().map_err(|e| e.to_string())?;
            *project_state.project.lock().map_err(|e| e.to_string())? = result_project.clone();
        }
        changed
    };

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

    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
    }

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
    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();

        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let project_name = project.name.clone();
        rebuild_automation_snapshot_from_project(&project, &automation_runtime);
        drop(project);
        project_state.mark_dirty(&project_name, Some(&app))?;
    }

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

    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
    }
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
    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
    }
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(())
}

/// Offline bounce/export command.
#[tauri::command]
async fn export_mix_cmd(
    settings: ExportSettingsPayload,
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<String, String> {
    let project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();

    let export_range = settings.range.trim().to_ascii_lowercase();
    if !["full", "loop", "selected"].contains(&export_range.as_str()) {
        return Err(format!(
            "Unsupported export range '{}'. Use 'full', 'loop', or 'selected'.",
            settings.range
        ));
    }
    let export_format = settings.format.trim().to_ascii_lowercase();
    if export_format != "wav" && export_format != "mp3" {
        return Err(format!(
            "Unsupported export format '{}'. Use 'wav' or 'mp3'.",
            settings.format
        ));
    }

    let project_end_frame = project
        .tracks
        .iter()
        .map(|t| {
            let audio_end = t
                .clips
                .iter()
                .map(|c| c.position.sample_frame + c.duration.sample_frame)
                .max()
                .unwrap_or(0);
            let midi_end = t
                .midi_clips
                .iter()
                .map(|c| c.position.sample_frame + c.duration.sample_frame)
                .max()
                .unwrap_or(0);
            audio_end.max(midi_end)
        })
        .max()
        .unwrap_or(0)
        .max(1);

    let (start_frame, end_frame) = if export_range == "selected" {
        match (settings.start_frame, settings.end_frame) {
            (Some(s), Some(e)) if e > s => (s, e),
            _ => return Err("Selected range requires valid start_frame and end_frame".to_string()),
        }
    } else if export_range == "loop" {
        let state = handle.playback_state.lock().map_err(|e| e.to_string())?;
        if state.loop_enabled && state.loop_end > state.loop_start {
            (state.loop_start, state.loop_end)
        } else {
            (0, project_end_frame)
        }
    } else {
        (0, project_end_frame)
    };

    let local_pool = build_local_pool_for_project(&project, &clip_pool_state)?;

    let export_bpm = handle.playback_state.lock().map_err(|e| e.to_string())?.bpm;
    let cfg = BounceConfig {
        output_path: settings.output_path.clone(),
        sample_rate: settings.sample_rate,
        bit_depth: settings.bit_depth,
        start_frame,
        end_frame,
        normalize: settings.normalize,
        tail_frames: ((settings.tail_ms as f64 / 1000.0) * settings.sample_rate as f64) as i64,
        format: export_format,
        project_sample_rate: project.sample_rate.max(1.0),
        bpm: export_bpm,
    };

    // ── VST3 instrument pre-render: clone host + slot map for spawn_blocking ──
    let plugin_host_arc = std::sync::Arc::clone(&plugin_host_state.host);
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    // NOTE: VST3 FX are NOT passed to bounce() — PluginInstanceArc is shared
    // with the RT audio thread, and calling process() from the offline thread
    // corrupts plugin state (rapid spurious audio, missing tracks).
    // VST3 MIDI instrument tracks are pre-rendered above via plugin_host_arc.
    // Audio track VST3 FX are applied via the pre-render FX loop (lines 2006+).
    // Only native device_chain FX are processed inside bounce().

    let (job_id, job_cancel) = start_job(&app, "export_mix", true)?;

    // Reset cancel flag and execute export as detached background worker.
    handle
        .export_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);
    let app_for_progress = app.clone();
    let app_for_finish = app.clone();
    let job_id_for_progress = job_id.clone();
    let job_id_for_finish = job_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let export_sample_rate = cfg.sample_rate;
        let mut bouncer = OfflineBouncer::new(cfg);
        bouncer.cancel_flag = std::sync::Arc::clone(&cancel_flag);
        let mut project = project;
        let mut local_pool = local_pool;

        // ── CRITICAL: Pre-render VST3 instrument MIDI tracks ──────────
        // Tracks with MIDI clips but NO sampler config are VST3 instrument
        // tracks (e.g. Serum). The built-in OfflineBouncer::pre_render_midi_tracks()
        // only handles sampler-based instruments. We must pre-render VST3
        // instrument tracks HERE where we have access to the PluginHost.
        {
            let sample_rate = export_sample_rate;
            let total_frames = (end_frame - start_frame).max(0) as usize;
            const CHUNK_FRAMES: usize = 4096;

            if total_frames > 0 {
                let mut vst3_rendered = 0usize;

                for track_idx in 0..project.tracks.len() {
                    let track = &project.tracks[track_idx];

                    // Skip tracks without MIDI clips.
                    if track.midi_clips.is_empty() {
                        continue;
                    }

                    // FIX-1: Skip tracks WITH a sampler config ONLY if they
                    // do NOT also have a VST3 instrument (e.g. Serum). ALS imports
                    // may populate both fields — prefer VST3 instrument when present.
                    if track.sampler.is_some() && track.instrument.is_none() {
                        continue;
                    }

                    // ── Find VST3 instrument instance for this track ──
                    let instrument_slot_id = match &track.instrument {
                        Some(DeviceNode::Single(slot)) => Some(slot.id),
                        Some(DeviceNode::Rack(rack)) => {
                            // For instrument racks, find the first plugin slot
                            rack.chains
                                .iter()
                                .flat_map(|chain| chain.devices.iter())
                                .find_map(|dev| match dev {
                                    DeviceNode::Single(slot) => Some(slot.id),
                                    _ => None,
                                })
                        }
                        None => None,
                    };

                    let Some(slot_id) = instrument_slot_id else {
                        log::warn!(
                            "[Export/VST3-MIDI] Track '{}' has {} MIDI clips but no instrument — skipping",
                            track.name,
                            track.midi_clips.len()
                        );
                        continue;
                    };

                    let Some(instance_id) = slot_instance_map.get(&slot_id).copied() else {
                        log::warn!(
                            "[Export/VST3-MIDI] Track '{}': instrument slot {} not bound to any instance — skipping",
                            track.name,
                            slot_id
                        );
                        continue;
                    };

                    log::info!(
                        "[Export/VST3-MIDI] Pre-rendering track '{}': {} clips, instance={}, {} frames",
                        track.name,
                        track.midi_clips.len(),
                        instance_id,
                        total_frames
                    );

                    // ── Pre-render buffer by buffer ───────────────
                    let midi_clips = track.midi_clips.clone();
                    let track_name = track.name.clone();

                    let mut out_left = vec![0.0f32; total_frames];
                    let mut out_right = vec![0.0f32; total_frames];

                    let mut schedule_scratch: Vec<
                        dream_clip_engine::midi_scheduler::ScheduledNote,
                    > = Vec::new();
                    let mut frames_done = 0usize;
                    let mut playhead = start_frame;

                    while frames_done < total_frames {
                        let remaining = total_frames - frames_done;
                        let chunk_frames = remaining.min(CHUNK_FRAMES);

                        // Schedule MIDI events for this buffer window.
                        MidiScheduler::fill_active(
                            &midi_clips,
                            playhead,
                            chunk_frames,
                            &mut schedule_scratch,
                        );

                        // Convert to VST3 MidiEvent format.
                        let mut midi_events: Vec<PluginMidiEvent> = Vec::new();
                        for event in &schedule_scratch {
                            if event.is_note_off {
                                midi_events.push(PluginMidiEvent::note_off(
                                    event.buffer_offset_end.min(chunk_frames) as i32,
                                    0,
                                    event.pitch,
                                    0,
                                ));
                            }
                            if event.is_note_on {
                                midi_events.push(PluginMidiEvent::note_on(
                                    event.buffer_onset.min(chunk_frames) as i32,
                                    0,
                                    event.pitch,
                                    event.velocity,
                                ));
                            }
                        }

                        // Sort: by sample_offset, then note-off before note-on at same offset
                        midi_events.sort_by(|a, b| {
                            a.sample_offset
                                .cmp(&b.sample_offset)
                                .then_with(|| a.data[0].cmp(&b.data[0]))
                        });

                        // ── Process through VST3 plugin ──────────
                        let mut chunk_left = vec![0.0f32; chunk_frames];
                        let mut chunk_right = vec![0.0f32; chunk_frames];

                        // Lock plugin host, process one chunk, release immediately.
                        {
                            let silence_l = vec![0.0f32; chunk_frames];
                            let silence_r = vec![0.0f32; chunk_frames];
                            let inputs: [&[f32]; 2] = [&silence_l, &silence_r];
                            let mut outputs: [&mut [f32]; 2] = [&mut chunk_left, &mut chunk_right];

                            match plugin_host_arc.lock() {
                                Ok(mut host) => {
                                    if let Err(e) = host.process_with_sidechain(
                                        instance_id,
                                        &inputs,
                                        None,
                                        &mut outputs,
                                        chunk_frames,
                                        &midi_events,
                                    ) {
                                        log::warn!(
                                            "[Export/VST3-MIDI] process_with_sidechain failed for '{}': {}",
                                            track_name,
                                            e
                                        );
                                    }
                                }
                                Err(e) => {
                                    log::error!(
                                        "[Export/VST3-MIDI] PluginHost lock poisoned: {}",
                                        e
                                    );
                                    break;
                                }
                            }
                        }

                        // Copy chunk into output buffers.
                        out_left[frames_done..frames_done + chunk_frames]
                            .copy_from_slice(&chunk_left[..chunk_frames]);
                        out_right[frames_done..frames_done + chunk_frames]
                            .copy_from_slice(&chunk_right[..chunk_frames]);

                        frames_done += chunk_frames;
                        playhead += chunk_frames as i64;
                    }

                    // ── FIX-2: Apply track insert FX chain to pre-rendered audio ──
                    // The instrument pre-render above produced raw Serum output.
                    // Now run it through all non-bypassed insert FX slots so
                    // reverb/EQ/compressor etc. appear in the export, matching
                    // what the user hears from the master in real-time.
                    {
                        let track_effects = project.tracks[track_idx].effects.clone();
                        let fx_slots: Vec<_> = track_effects
                            .iter()
                            .flat_map(|node| node.collect_plugin_slots())
                            .filter(|slot| !slot.is_bypassed)
                            .collect();

                        // BUG-E4 FIX: Pad output buffers for FX tail (reverb/delay).
                        // Without this, tails from MIDI instrument FX chains are cut off
                        // at the exact end of the last MIDI note. Mirrors BUG-E3 for audio.
                        const MIDI_FX_TAIL_FRAMES: usize = 44100 * 4; // 4 seconds
                        let has_vst3_fx = fx_slots
                            .iter()
                            .any(|s| slot_instance_map.contains_key(&s.id));
                        let padded_total = if has_vst3_fx {
                            total_frames + MIDI_FX_TAIL_FRAMES
                        } else {
                            total_frames
                        };
                        out_left.resize(padded_total, 0.0);
                        out_right.resize(padded_total, 0.0);

                        for fx_slot in &fx_slots {
                            let Some(fx_instance_id) = slot_instance_map.get(&fx_slot.id).copied()
                            else {
                                log::debug!(
                                    "[Export/VST3-FX] Track '{}': FX slot '{}' ({}) not bound — skipping",
                                    track_name,
                                    fx_slot.name,
                                    fx_slot.id
                                );
                                continue;
                            };

                            log::info!(
                                "[Export/VST3-FX] Track '{}': applying FX '{}' (instance={})",
                                track_name,
                                fx_slot.name,
                                fx_instance_id
                            );

                            // Process the entire pre-rendered buffer through this FX in chunks.
                            let mut fx_offset = 0usize;
                            while fx_offset < padded_total {
                                let remaining = padded_total - fx_offset;
                                let chunk = remaining.min(CHUNK_FRAMES);

                                let mut fx_out_l = vec![0.0f32; chunk];
                                let mut fx_out_r = vec![0.0f32; chunk];

                                let in_l = &out_left[fx_offset..fx_offset + chunk];
                                let in_r = &out_right[fx_offset..fx_offset + chunk];
                                let inputs: [&[f32]; 2] = [in_l, in_r];
                                let mut outputs: [&mut [f32]; 2] = [&mut fx_out_l, &mut fx_out_r];

                                match plugin_host_arc.lock() {
                                    Ok(mut host) => {
                                        let empty_midi: Vec<PluginMidiEvent> = Vec::new();
                                        if let Err(e) = host.process_with_sidechain(
                                            fx_instance_id,
                                            &inputs,
                                            None,
                                            &mut outputs,
                                            chunk,
                                            &empty_midi,
                                        ) {
                                            log::warn!(
                                                "[Export/VST3-FX] FX '{}' process failed: {}",
                                                fx_slot.name,
                                                e
                                            );
                                        }
                                    }
                                    Err(e) => {
                                        log::error!(
                                            "[Export/VST3-FX] PluginHost lock poisoned: {}",
                                            e
                                        );
                                        break;
                                    }
                                }

                                // Write FX output back into the pre-render buffers.
                                out_left[fx_offset..fx_offset + chunk].copy_from_slice(&fx_out_l);
                                out_right[fx_offset..fx_offset + chunk].copy_from_slice(&fx_out_r);
                                fx_offset += chunk;
                            }
                        }

                        if !fx_slots.is_empty() {
                            log::info!(
                                "[Export/VST3-FX] Track '{}': applied {} insert FX slot(s)",
                                track_name,
                                fx_slots.len()
                            );
                        }
                    }

                    // ── Check if anything was rendered ──────────
                    let peak = out_left
                        .iter()
                        .chain(out_right.iter())
                        .fold(0.0f32, |acc, &s| acc.max(s.abs()));

                    if peak < 1e-7 {
                        log::warn!(
                            "[Export/VST3-MIDI] Track '{}': pre-render produced silence (peak={:.2e})",
                            track_name,
                            peak
                        );
                        // Still add the clip — silence is valid (e.g. if all notes are outside range)
                    } else {
                        log::info!(
                            "[Export/VST3-MIDI] Track '{}': pre-render complete, peak={:.4}, {} frames",
                            track_name,
                            peak,
                            total_frames
                        );
                    }

                    // ── Create synthetic ClipAudio + AudioClip ──
                    let synth_path = format!("__vst3_midi_prerender__/track_{}", track_idx);
                    // BUG-E4: Capture actual buffer length (includes FX tail padding)
                    // BEFORE out_left is moved into ClipAudio.
                    let rendered_frames = out_left.len();
                    let clip_audio =
                        ClipAudio::new(synth_path.clone(), vec![out_left, out_right], sample_rate);
                    let _ = local_pool.insert(clip_audio);

                    let synth_clip = AudioClip::new(
                        format!("{} (VST3 Pre-render)", track_name),
                        synth_path,
                        AbsoluteTime::new(start_frame),
                        AbsoluteTime::new(rendered_frames as i64),
                    );
                    project.tracks[track_idx].clips.push(synth_clip);
                    vst3_rendered += 1;
                }

                if vst3_rendered > 0 {
                    log::info!(
                        "[Export/VST3-MIDI] Pre-rendered {} VST3 instrument track(s)",
                        vst3_rendered
                    );
                }
            }
        }

        // ── EXPORT-FIX-01: Pre-render audio tracks through VST3 FX chain ──
        // The bounce engine only applies native device_chain FX. Any VST3 insert
        // FX on audio tracks (reverb, EQ, compressor plugins etc.) would be
        // completely missing from the export. Pre-render each audio track's clips
        // through its VST3 FX chain here, then replace the clip audio in the pool
        // with the processed version.
        //
        // BUG-E10 FIX: Use per-track synthetic keys to prevent cross-track
        // contamination when multiple tracks reference the same audio file.
        {
            const FX_CHUNK_FRAMES: usize = 4096;
            let mut vst3_fx_rendered = 0usize;
            for track_idx in 0..project.tracks.len() {
                let track = &project.tracks[track_idx];

                // Skip tracks without audio clips.
                if track.clips.is_empty() {
                    continue;
                }

                // Collect VST3 FX slots for this track's insert chain.
                let fx_slots: Vec<_> = track
                    .effects
                    .iter()
                    .flat_map(|node| node.collect_plugin_slots())
                    .filter(|slot| !slot.is_bypassed)
                    .collect();

                // Find VST3 FX slots that have bound instances.
                let vst3_fx: Vec<_> = fx_slots
                    .iter()
                    .filter_map(|slot| {
                        slot_instance_map
                            .get(&slot.id)
                            .map(|&iid| (slot.name.clone(), iid))
                    })
                    .collect();

                if vst3_fx.is_empty() {
                    continue;
                }

                log::info!(
                    "[Export/AudioFX] Track '{}': {} audio clips, {} VST3 FX to pre-render",
                    track.name,
                    track.clips.len(),
                    vst3_fx.len()
                );

                // For each audio clip on this track, read its raw audio from the pool,
                // process through VST3 FX chain, and write to a NEW per-track key.
                // BUG-E2 FIX: Deduplicate by file_path to prevent double-processing.
                // BUG-E10 FIX: Use per-track synthetic keys instead of overwriting
                // the original pool entry, so other tracks sharing the same file
                // read the unprocessed original.
                let mut already_processed: std::collections::HashSet<String> =
                    std::collections::HashSet::new();
                for clip_idx in 0..project.tracks[track_idx].clips.len() {
                    let original_path = project.tracks[track_idx].clips[clip_idx].file_path.clone();
                    if original_path.is_empty() {
                        continue;
                    }
                    if !already_processed.insert(original_path.clone()) {
                        // Already processed this file for this track — just update the clip ref.
                        let fx_key =
                            format!("__fx_processed__/track_{}/{}", track_idx, original_path);
                        project.tracks[track_idx].clips[clip_idx].file_path = fx_key;
                        continue;
                    }

                    let clip_audio = match local_pool.get(&original_path) {
                        Some(ca) => ca,
                        None => {
                            log::warn!(
                                "[Export/AudioFX] Track '{}': clip '{}' not in pool — skipping",
                                project.tracks[track_idx].name,
                                original_path
                            );
                            continue;
                        }
                    };

                    let num_channels = clip_audio.channels.len();
                    if num_channels == 0 {
                        continue;
                    }

                    let total_clip_frames = clip_audio.num_frames;
                    if total_clip_frames == 0 {
                        continue;
                    }

                    // Create writable copies of L/R channels.
                    let mut buf_l: Vec<f32> = clip_audio.channels[0].clone();
                    let mut buf_r: Vec<f32> = if num_channels > 1 {
                        clip_audio.channels[1].clone()
                    } else {
                        clip_audio.channels[0].clone() // Mono → duplicate to R
                    };

                    // BUG-E3 FIX: Allow FX tail to ring out beyond clip boundary.
                    // Reverb/delay tails extend past the source audio duration.
                    // Pad buffers with 4 seconds of silence so tails are captured.
                    const FX_TAIL_FRAMES: usize = 44100 * 4;
                    let padded_frames = total_clip_frames + FX_TAIL_FRAMES;
                    buf_l.resize(padded_frames, 0.0);
                    buf_r.resize(padded_frames, 0.0);

                    // Process through each VST3 FX plugin in chain order.
                    for (fx_name, fx_instance_id) in &vst3_fx {
                        let mut fx_offset = 0usize;
                        while fx_offset < padded_frames {
                            let remaining = padded_frames - fx_offset;
                            let chunk = remaining.min(FX_CHUNK_FRAMES);

                            let mut fx_out_l = vec![0.0f32; chunk];
                            let mut fx_out_r = vec![0.0f32; chunk];

                            let in_l = &buf_l[fx_offset..fx_offset + chunk];
                            let in_r = &buf_r[fx_offset..fx_offset + chunk];
                            let inputs: [&[f32]; 2] = [in_l, in_r];
                            let mut outputs: [&mut [f32]; 2] = [&mut fx_out_l, &mut fx_out_r];

                            match plugin_host_arc.lock() {
                                Ok(mut host) => {
                                    let empty_midi: Vec<PluginMidiEvent> = Vec::new();
                                    if let Err(e) = host.process_with_sidechain(
                                        *fx_instance_id,
                                        &inputs,
                                        None,
                                        &mut outputs,
                                        chunk,
                                        &empty_midi,
                                    ) {
                                        log::warn!(
                                            "[Export/AudioFX] FX '{}' process failed: {}",
                                            fx_name,
                                            e
                                        );
                                    }
                                }
                                Err(e) => {
                                    log::error!("[Export/AudioFX] PluginHost lock poisoned: {}", e);
                                    break;
                                }
                            }

                            buf_l[fx_offset..fx_offset + chunk].copy_from_slice(&fx_out_l);
                            buf_r[fx_offset..fx_offset + chunk].copy_from_slice(&fx_out_r);
                            fx_offset += chunk;
                        }
                    }

                    // BUG-E1 FIX: VST3 FX produce stereo output even for mono input.
                    // Always save both channels after FX processing to preserve stereo image.
                    // BUG-E10 FIX: Write to per-track synthetic key, NOT the original path.
                    let fx_key = format!("__fx_processed__/track_{}/{}", track_idx, original_path);
                    let processed_channels = vec![buf_l, buf_r];
                    let processed_clip =
                        ClipAudio::new(fx_key.clone(), processed_channels, clip_audio.sample_rate);
                    let _ = local_pool.insert(processed_clip);
                    // Update the clip's file_path to point to the FX-processed version.
                    project.tracks[track_idx].clips[clip_idx].file_path = fx_key;
                }

                vst3_fx_rendered += 1;
                log::info!(
                    "[Export/AudioFX] Track '{}': VST3 FX pre-render complete ({} FX applied)",
                    project.tracks[track_idx].name,
                    vst3_fx.len()
                );
            }

            if vst3_fx_rendered > 0 {
                log::info!(
                    "[Export/AudioFX] Pre-rendered {} audio track(s) through VST3 FX chains",
                    vst3_fx_rendered
                );
            }
        }

        // Pass empty plugin maps: VST3 FX are now pre-rendered above, native FX
        // are handled by device_chain inside render_routing_aware.
        let no_plugins: std::collections::HashMap<
            uuid::Uuid,
            dream_engine::driver::PluginInstanceArc,
        > = std::collections::HashMap::new();
        let no_fx: Vec<Vec<dream_engine::driver::ExternalFxRuntimeSlot>> = Vec::new();
        let result = bouncer
            .bounce(
                &mut project,
                &mut local_pool,
                None,
                &no_plugins,
                &no_fx,
                move |progress| {
                    let payload = serde_json::json!({
                        "jobId": &job_id_for_progress,
                        "progress": (progress * 100.0).clamp(0.0, 100.0),
                        "phase": "Rendering"
                    });
                    let _ = app_for_progress.emit("bounce_progress", payload);
                    let _ = set_job_progress(
                        &app_for_progress,
                        &job_id_for_progress,
                        (progress * 100.0).clamp(0.0, 100.0),
                        "Rendering",
                    );
                },
            )
            .map_err(|e| e.to_string());

        match result {
            Ok(_) => {
                let cancelled = cancel_flag.load(std::sync::atomic::Ordering::SeqCst);
                let _ = finish_job(
                    &app_for_finish,
                    &job_id_for_finish,
                    !cancelled,
                    cancelled,
                    if cancelled {
                        Some("Export cancelled".to_string())
                    } else {
                        None
                    },
                );
            }
            Err(err) => {
                let cancelled = cancel_flag.load(std::sync::atomic::Ordering::SeqCst);
                let _ = finish_job(
                    &app_for_finish,
                    &job_id_for_finish,
                    false,
                    cancelled,
                    Some(err),
                );
            }
        }
    });
    Ok(job_id)
}

/// Cancel an in-progress export/bounce operation.
#[tauri::command]
async fn cancel_export_cmd(
    app: tauri::AppHandle,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    handle
        .export_cancel
        .store(true, std::sync::atomic::Ordering::SeqCst);
    if let Ok(mut jobs) = background_jobs().lock() {
        for job in jobs.values_mut() {
            if job.snapshot.status == "running" && job.snapshot.cancellable {
                job.cancel_flag
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                job.snapshot.status = "cancelling".to_string();
                job.snapshot.phase = "Cancelling...".to_string();
                emit_job_update(&app, &job.snapshot);
                let _ = app.emit(
                    "bounce_progress",
                    serde_json::json!({
                        "jobId": &job.snapshot.id,
                        "progress": job.snapshot.progress,
                        "phase": job.snapshot.phase,
                        "status": job.snapshot.status,
                    }),
                );
            }
        }
    }
    log::info!("[Export] Cancel requested");
    Ok(())
}

#[tauri::command]
async fn list_background_jobs_cmd() -> Result<Vec<BackgroundJobSnapshot>, String> {
    let mut jobs = background_jobs().lock().map_err(|e| e.to_string())?;
    prune_finished_jobs_locked(&mut jobs);
    let mut out: Vec<BackgroundJobSnapshot> = jobs.values().map(|j| j.snapshot.clone()).collect();
    out.sort_by_key(|j| j.started_at_ms);
    Ok(out)
}

#[tauri::command]
async fn cancel_background_job_cmd(job_id: String, app: tauri::AppHandle) -> Result<(), String> {
    let mut jobs = background_jobs().lock().map_err(|e| e.to_string())?;
    let Some(job) = jobs.get_mut(&job_id) else {
        return Err("Job not found".to_string());
    };
    if !job.snapshot.cancellable {
        return Err("Job is not cancellable".to_string());
    }
    job.cancel_flag
        .store(true, std::sync::atomic::Ordering::SeqCst);
    if job.snapshot.status == "running" {
        job.snapshot.status = "cancelling".to_string();
        job.snapshot.phase = "Cancelling...".to_string();
        emit_job_update(&app, &job.snapshot);
        let _ = app.emit(
            "bounce_progress",
            serde_json::json!({
                "jobId": &job.snapshot.id,
                "progress": job.snapshot.progress,
                "phase": job.snapshot.phase,
                "status": job.snapshot.status,
            }),
        );
    }
    Ok(())
}

#[tauri::command]
async fn clear_finished_background_jobs_cmd() -> Result<usize, String> {
    let mut jobs = background_jobs().lock().map_err(|e| e.to_string())?;
    let before = jobs.len();
    jobs.retain(|_, job| job.snapshot.status == "running");
    Ok(before.saturating_sub(jobs.len()))
}

/// Bounce selected clips or selected time range to a new audio track.
#[tauri::command]
async fn bounce_selection_to_track_cmd(
    payload: BounceSelectionPayload,
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let mut bounce_project = project.clone();
    let mut bounce_track_name = "Bounce".to_string();
    let insert_after_track_index: Option<usize>;

    let clip_ids: std::collections::HashSet<Uuid> = payload
        .clip_ids
        .iter()
        .filter_map(|id| Uuid::parse_str(id).ok())
        .collect();

    let (start_frame, end_frame) = if !clip_ids.is_empty() {
        for track in &mut bounce_project.tracks {
            track.clips.retain(|c| clip_ids.contains(&c.id));
            track.midi_clips.retain(|c| clip_ids.contains(&c.id));
        }

        let selected_track_indices: Vec<usize> = project
            .tracks
            .iter()
            .enumerate()
            .filter_map(|(idx, track)| {
                let has_selected_audio = track.clips.iter().any(|c| clip_ids.contains(&c.id));
                let has_selected_midi = track.midi_clips.iter().any(|c| clip_ids.contains(&c.id));
                if has_selected_audio || has_selected_midi {
                    Some(idx)
                } else {
                    None
                }
            })
            .collect();
        if selected_track_indices.len() == 1
            && let Some(track) = project.tracks.get(selected_track_indices[0])
        {
            bounce_track_name = format!("{} Bounce", track.name);
        }
        // Insert the bounced track right after the last selected track.
        insert_after_track_index = selected_track_indices.last().copied();

        let selected_audio = project
            .tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .filter(|c| clip_ids.contains(&c.id));
        let selected_midi = project
            .tracks
            .iter()
            .flat_map(|t| t.midi_clips.iter())
            .filter(|c| clip_ids.contains(&c.id));
        let mut start = i64::MAX;
        let mut end = i64::MIN;
        for c in selected_audio {
            start = start.min(c.position.sample_frame);
            end = end.max(c.position.sample_frame + c.duration.sample_frame);
        }
        for c in selected_midi {
            start = start.min(c.position.sample_frame);
            end = end.max(c.position.sample_frame + c.duration.sample_frame);
        }
        if start == i64::MAX || end == i64::MIN || end <= start {
            return Err("Nothing selected to bounce".to_string());
        }
        (start, end)
    } else if let (Some(range_start), Some(range_end), Some(start_track), Some(end_track)) = (
        payload.range_start_frames,
        payload.range_end_frames,
        payload.start_track_index,
        payload.end_track_index,
    ) {
        if range_end <= range_start {
            return Err("Invalid bounce range: end must be greater than start".to_string());
        }
        let lo = start_track.min(end_track);
        let hi = start_track.max(end_track);
        if lo == hi
            && let Some(track) = project.tracks.get(lo)
        {
            bounce_track_name = format!("{} Bounce", track.name);
        }
        insert_after_track_index = Some(hi);
        for (idx, track) in bounce_project.tracks.iter_mut().enumerate() {
            if idx < lo || idx > hi {
                track.clips.clear();
                track.midi_clips.clear();
            }
        }
        (range_start, range_end)
    } else {
        return Err("Bounce requires selected clips or a selected time range".to_string());
    };

    let local_pool = build_local_pool_for_project(&bounce_project, &clip_pool_state)?;
    let output_path = dream_importers::stem_separation::make_bounce_output_path("selection_bounce")?;
    let cfg = BounceConfig {
        output_path: output_path.clone(),
        sample_rate: project.sample_rate.max(1.0).round() as u32,
        bit_depth: 32,
        start_frame,
        end_frame,
        normalize: false,
        tail_frames: 0,
        format: "wav".to_string(),
        project_sample_rate: project.sample_rate.max(1.0),
        bpm: handle.playback_state.lock().map_err(|e| e.to_string())?.bpm,
    };

    let (job_id, job_cancel) = start_job(&app, "bounce_selection", true)?;

    handle
        .export_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);
    let app_for_progress = app.clone();
    let job_id_for_progress = job_id.clone();
    let bounce_res = tauri::async_runtime::spawn_blocking(move || {
        let mut bouncer = OfflineBouncer::new(cfg);
        bouncer.cancel_flag = cancel_flag;
        let mut bounce_project = bounce_project;
        let mut local_pool = local_pool;
        let no_plugins: std::collections::HashMap<
            uuid::Uuid,
            dream_engine::driver::PluginInstanceArc,
        > = std::collections::HashMap::new();
        let no_fx: Vec<Vec<dream_engine::driver::ExternalFxRuntimeSlot>> = Vec::new();
        bouncer
            .bounce(
                &mut bounce_project,
                &mut local_pool,
                None,
                &no_plugins,
                &no_fx,
                move |progress| {
                    let _ = set_job_progress(
                        &app_for_progress,
                        &job_id_for_progress,
                        (progress * 100.0).clamp(0.0, 100.0),
                        "Rendering",
                    );
                },
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Bounce worker failed: {e}"))?;

    if let Err(e) = bounce_res {
        let cancelled = job_cancel.load(std::sync::atomic::Ordering::SeqCst);
        let _ = finish_job(&app, &job_id, false, cancelled, Some(e.clone()));
        return Err(e);
    }

    if job_cancel.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = finish_job(
            &app,
            &job_id,
            false,
            true,
            Some("Bounce cancelled".to_string()),
        );
        return Err("Bounce cancelled".to_string());
    }

    let place_result = place_bounced_file_on_new_track(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        &output_path,
        &bounce_track_name,
        start_frame,
        &bounce_track_name,
        insert_after_track_index,
    );
    if let Err(err) = &place_result {
        let _ = finish_job(&app, &job_id, false, false, Some(err.clone()));
    }
    place_result?;
    let _ = finish_job(&app, &job_id, true, false, None);
    Ok(())
}

/// Bounce an entire track to a new audio track.
#[tauri::command]
async fn bounce_track_cmd(
    track_id: String,
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let track_uuid = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track ID: {e}"))?;
    let source_index = project
        .tracks
        .iter()
        .position(|t| t.id == track_uuid)
        .ok_or_else(|| "Track not found".to_string())?;
    let source_track = &project.tracks[source_index];

    let mut start_frame = i64::MAX;
    let mut end_frame = i64::MIN;
    for c in &source_track.clips {
        start_frame = start_frame.min(c.position.sample_frame);
        end_frame = end_frame.max(c.position.sample_frame + c.duration.sample_frame);
    }
    for c in &source_track.midi_clips {
        start_frame = start_frame.min(c.position.sample_frame);
        end_frame = end_frame.max(c.position.sample_frame + c.duration.sample_frame);
    }
    if start_frame == i64::MAX || end_frame == i64::MIN || end_frame <= start_frame {
        return Err("Track has no content to bounce".to_string());
    }

    let mut bounce_project = project.clone();
    for (idx, track) in bounce_project.tracks.iter_mut().enumerate() {
        if idx != source_index {
            track.clips.clear();
            track.midi_clips.clear();
        }
    }

    let local_pool = build_local_pool_for_project(&bounce_project, &clip_pool_state)?;
    let output_path = dream_importers::stem_separation::make_bounce_output_path("track_bounce")?;
    let cfg = BounceConfig {
        output_path: output_path.clone(),
        sample_rate: project.sample_rate.max(1.0).round() as u32,
        bit_depth: 32,
        start_frame,
        end_frame,
        normalize: false,
        tail_frames: 0,
        format: "wav".to_string(),
        project_sample_rate: project.sample_rate.max(1.0),
        bpm: handle.playback_state.lock().map_err(|e| e.to_string())?.bpm,
    };

    let (job_id, job_cancel) = start_job(&app, "bounce_track", true)?;

    handle
        .export_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);
    let app_for_progress = app.clone();
    let job_id_for_progress = job_id.clone();
    let bounce_res = tauri::async_runtime::spawn_blocking(move || {
        let mut bouncer = OfflineBouncer::new(cfg);
        bouncer.cancel_flag = cancel_flag;
        let mut bounce_project = bounce_project;
        let mut local_pool = local_pool;
        bouncer
            .bounce(
                &mut bounce_project,
                &mut local_pool,
                None,
                &std::collections::HashMap::new(),
                &[],
                move |progress| {
                    let _ = set_job_progress(
                        &app_for_progress,
                        &job_id_for_progress,
                        (progress * 100.0).clamp(0.0, 100.0),
                        "Rendering",
                    );
                },
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Bounce worker failed: {e}"))?;

    if let Err(e) = bounce_res {
        let cancelled = job_cancel.load(std::sync::atomic::Ordering::SeqCst);
        let _ = finish_job(&app, &job_id, false, cancelled, Some(e.clone()));
        return Err(e);
    }

    if job_cancel.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = finish_job(
            &app,
            &job_id,
            false,
            true,
            Some("Bounce cancelled".to_string()),
        );
        return Err("Bounce cancelled".to_string());
    }

    let place_result = place_bounced_file_on_new_track(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        &output_path,
        &format!("{} Bounce", source_track.name),
        start_frame,
        &format!("{} Bounce", source_track.name),
        Some(source_index),
    );
    if let Err(err) = &place_result {
        let _ = finish_job(&app, &job_id, false, false, Some(err.clone()));
    }
    place_result?;
    let _ = finish_job(&app, &job_id, true, false, None);
    Ok(())
}

/// Bounce an entire track to a new audio track and return deltas for frontend sync.
#[tauri::command]
async fn bounce_track_with_deltas_cmd(
    track_id: String,
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<DeltaMutationResponse, String> {
    let project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let track_uuid = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track ID: {e}"))?;
    let source_index = project
        .tracks
        .iter()
        .position(|t| t.id == track_uuid)
        .ok_or_else(|| "Track not found".to_string())?;
    let source_track = &project.tracks[source_index];

    let mut start_frame = i64::MAX;
    let mut end_frame = i64::MIN;
    for c in &source_track.clips {
        start_frame = start_frame.min(c.position.sample_frame);
        end_frame = end_frame.max(c.position.sample_frame + c.duration.sample_frame);
    }
    for c in &source_track.midi_clips {
        start_frame = start_frame.min(c.position.sample_frame);
        end_frame = end_frame.max(c.position.sample_frame + c.duration.sample_frame);
    }
    if start_frame == i64::MAX || end_frame == i64::MIN || end_frame <= start_frame {
        return Err("Track has no content to bounce".to_string());
    }

    let mut bounce_project = project.clone();
    for (idx, track) in bounce_project.tracks.iter_mut().enumerate() {
        if idx != source_index {
            track.clips.clear();
            track.midi_clips.clear();
        }
    }

    let local_pool = build_local_pool_for_project(&bounce_project, &clip_pool_state)?;
    let output_path = dream_importers::stem_separation::make_bounce_output_path("track_bounce")?;
    let cfg = BounceConfig {
        output_path: output_path.clone(),
        sample_rate: project.sample_rate.max(1.0).round() as u32,
        bit_depth: 32,
        start_frame,
        end_frame,
        normalize: false,
        tail_frames: 0,
        format: "wav".to_string(),
        project_sample_rate: project.sample_rate.max(1.0),
        bpm: handle.playback_state.lock().map_err(|e| e.to_string())?.bpm,
    };

    let (job_id, job_cancel) = start_job(&app, "bounce_track", true)?;

    handle
        .export_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);
    let app_for_progress = app.clone();
    let job_id_for_progress = job_id.clone();
    let bounce_res = tauri::async_runtime::spawn_blocking(move || {
        let mut bouncer = OfflineBouncer::new(cfg);
        bouncer.cancel_flag = cancel_flag;
        let mut bounce_project = bounce_project;
        let mut local_pool = local_pool;
        bouncer
            .bounce(
                &mut bounce_project,
                &mut local_pool,
                None,
                &std::collections::HashMap::new(),
                &[],
                move |progress| {
                    let _ = set_job_progress(
                        &app_for_progress,
                        &job_id_for_progress,
                        (progress * 100.0).clamp(0.0, 100.0),
                        "Rendering",
                    );
                },
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Bounce worker failed: {e}"))?;

    if let Err(e) = bounce_res {
        let cancelled = job_cancel.load(std::sync::atomic::Ordering::SeqCst);
        let _ = finish_job(&app, &job_id, false, cancelled, Some(e.clone()));
        return Err(e);
    }

    if job_cancel.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = finish_job(
            &app,
            &job_id,
            false,
            true,
            Some("Bounce cancelled".to_string()),
        );
        return Err("Bounce cancelled".to_string());
    }

    let placement = place_bounced_file_on_new_track(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        &output_path,
        &format!("{} Bounce", source_track.name),
        start_frame,
        &format!("{} Bounce", source_track.name),
        Some(source_index),
    );
    if let Err(err) = &placement {
        let _ = finish_job(&app, &job_id, false, false, Some(err.clone()));
    }
    let placement = placement?;
    let _ = finish_job(&app, &job_id, true, false, None);

    Ok(DeltaMutationResponse {
        deltas: vec![
            dream_models::delta::ProjectDelta::TrackAdded {
                track_index: placement.track_index,
                track_id: placement.track_id,
                name: placement.track_name,
                track_type: "audio".to_string(),
            },
            dream_models::delta::ProjectDelta::ClipAdded {
                clip_id: placement.clip_id,
                track_index: placement.track_index,
                name: placement.clip_name,
                clip_type: "audio".to_string(),
                file_path: Some(output_path),
                position: placement.clip_position,
                duration: placement.clip_duration,
            },
        ],
    })
}

/// Bounce a group track (group + all descendant tracks) to a new audio track.
#[tauri::command]
async fn bounce_group_cmd(
    group_track_id: String,
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let group_uuid =
        Uuid::parse_str(&group_track_id).map_err(|e| format!("Invalid group track ID: {e}"))?;
    let group_track = project
        .tracks
        .iter()
        .find(|t| t.id == group_uuid)
        .ok_or_else(|| "Group track not found".to_string())?;
    if group_track.track_type != TrackType::Group {
        return Err("bounce_group_cmd requires a Group track".to_string());
    }

    let mut included_ids: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
    included_ids.insert(group_uuid);
    loop {
        let mut changed = false;
        for track in &project.tracks {
            if let Some(parent_id) = track.parent_track_id
                && included_ids.contains(&parent_id)
                && included_ids.insert(track.id)
            {
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    let mut start_frame = i64::MAX;
    let mut end_frame = i64::MIN;
    for track in &project.tracks {
        if !included_ids.contains(&track.id) {
            continue;
        }
        for c in &track.clips {
            start_frame = start_frame.min(c.position.sample_frame);
            end_frame = end_frame.max(c.position.sample_frame + c.duration.sample_frame);
        }
        for c in &track.midi_clips {
            start_frame = start_frame.min(c.position.sample_frame);
            end_frame = end_frame.max(c.position.sample_frame + c.duration.sample_frame);
        }
    }
    if start_frame == i64::MAX || end_frame == i64::MIN || end_frame <= start_frame {
        return Err("Group has no content to bounce".to_string());
    }

    let mut bounce_project = project.clone();
    for track in &mut bounce_project.tracks {
        if !included_ids.contains(&track.id) {
            track.clips.clear();
            track.midi_clips.clear();
        }
    }

    let local_pool = build_local_pool_for_project(&bounce_project, &clip_pool_state)?;
    let output_path = dream_importers::stem_separation::make_bounce_output_path("group_bounce")?;
    let cfg = BounceConfig {
        output_path: output_path.clone(),
        sample_rate: project.sample_rate.max(1.0).round() as u32,
        bit_depth: 32,
        start_frame,
        end_frame,
        normalize: false,
        tail_frames: 0,
        format: "wav".to_string(),
        project_sample_rate: project.sample_rate.max(1.0),
        bpm: handle.playback_state.lock().map_err(|e| e.to_string())?.bpm,
    };

    let (job_id, job_cancel) = start_job(&app, "bounce_group", true)?;

    handle
        .export_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);
    let app_for_progress = app.clone();
    let job_id_for_progress = job_id.clone();
    let bounce_res = tauri::async_runtime::spawn_blocking(move || {
        let mut bouncer = OfflineBouncer::new(cfg);
        bouncer.cancel_flag = cancel_flag;
        let mut bounce_project = bounce_project;
        let mut local_pool = local_pool;
        bouncer
            .bounce(
                &mut bounce_project,
                &mut local_pool,
                None,
                &std::collections::HashMap::new(),
                &[],
                move |progress| {
                    let _ = set_job_progress(
                        &app_for_progress,
                        &job_id_for_progress,
                        (progress * 100.0).clamp(0.0, 100.0),
                        "Rendering",
                    );
                },
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Bounce worker failed: {e}"))?;

    if let Err(e) = bounce_res {
        let cancelled = job_cancel.load(std::sync::atomic::Ordering::SeqCst);
        let _ = finish_job(&app, &job_id, false, cancelled, Some(e.clone()));
        return Err(e);
    }

    if job_cancel.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = finish_job(
            &app,
            &job_id,
            false,
            true,
            Some("Bounce cancelled".to_string()),
        );
        return Err("Bounce cancelled".to_string());
    }

    let group_index = project.tracks.iter().position(|t| t.id == group_uuid);
    let place_result = place_bounced_file_on_new_track(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        &output_path,
        &format!("{} Bounce", group_track.name),
        start_frame,
        &format!("{} Bounce", group_track.name),
        group_index,
    );
    if let Err(err) = &place_result {
        let _ = finish_job(&app, &job_id, false, false, Some(err.clone()));
    }
    place_result?;
    let _ = finish_job(&app, &job_id, true, false, None);
    Ok(())
}

/// Split a track into 4 stems (drums, bass, other, vocals) and place each stem on a new track.
#[tauri::command]
async fn split_track_to_stems_cmd(
    payload: SplitTrackToStemsPayload,
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let track_uuid =
        Uuid::parse_str(&payload.track_id).map_err(|e| format!("Invalid track ID: {e}"))?;
    let source_index = project
        .tracks
        .iter()
        .position(|t| t.id == track_uuid)
        .ok_or_else(|| "Track not found".to_string())?;
    let source_track = &project.tracks[source_index];

    let mut included_ids: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
    included_ids.insert(source_track.id);
    if source_track.track_type == TrackType::Group {
        loop {
            let mut changed = false;
            for track in &project.tracks {
                if let Some(parent_id) = track.parent_track_id
                    && included_ids.contains(&parent_id)
                    && included_ids.insert(track.id)
                {
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
    }

    let mut start_frame = i64::MAX;
    let mut end_frame = i64::MIN;
    for track in &project.tracks {
        if !included_ids.contains(&track.id) {
            continue;
        }
        for c in &track.clips {
            start_frame = start_frame.min(c.position.sample_frame);
            end_frame = end_frame.max(c.position.sample_frame + c.duration.sample_frame);
        }
        for c in &track.midi_clips {
            start_frame = start_frame.min(c.position.sample_frame);
            end_frame = end_frame.max(c.position.sample_frame + c.duration.sample_frame);
        }
    }
    if start_frame == i64::MAX || end_frame == i64::MIN || end_frame <= start_frame {
        return Err("Track has no content to split into stems".to_string());
    }

    let mut bounce_project = project.clone();
    for track in &mut bounce_project.tracks {
        if !included_ids.contains(&track.id) {
            track.clips.clear();
            track.midi_clips.clear();
        }
    }

    let local_pool = build_local_pool_for_project(&bounce_project, &clip_pool_state)?;
    let source_mix_path = dream_importers::stem_separation::make_bounce_output_path("stems_source")?;
    let cfg = BounceConfig {
        output_path: source_mix_path.clone(),
        sample_rate: project.sample_rate.max(1.0).round() as u32,
        bit_depth: 32,
        start_frame,
        end_frame,
        normalize: false,
        tail_frames: 0,
        format: "wav".to_string(),
        project_sample_rate: project.sample_rate.max(1.0),
        bpm: handle.playback_state.lock().map_err(|e| e.to_string())?.bpm,
    };

    let (job_id, job_cancel) = start_job(&app, "split_to_stems", true)?;
    let _ = app.emit(
        "bounce_progress",
        serde_json::json!({ "jobId": &job_id, "progress": 5.0, "phase": "Preparing stem split" }),
    );
    let _ = set_job_progress(&app, &job_id, 5.0, "Preparing stem split");

    handle
        .export_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);
    let app_for_progress = app.clone();
    let job_id_for_progress = job_id.clone();
    let bounce_res = tauri::async_runtime::spawn_blocking(move || {
        let mut bouncer = OfflineBouncer::new(cfg);
        bouncer.cancel_flag = cancel_flag;
        let mut bounce_project = bounce_project;
        let mut local_pool = local_pool;
        bouncer
            .bounce(
                &mut bounce_project,
                &mut local_pool,
                None,
                &std::collections::HashMap::new(),
                &[],
                move |progress| {
                    let p = (progress * 45.0).clamp(0.0, 45.0);
                    let _ = set_job_progress(
                        &app_for_progress,
                        &job_id_for_progress,
                        p,
                        "Rendering source mix",
                    );
                },
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Stem bounce worker failed: {e}"))?;

    if let Err(e) = bounce_res {
        let cancelled = job_cancel.load(std::sync::atomic::Ordering::SeqCst);
        let _ = finish_job(&app, &job_id, false, cancelled, Some(e.clone()));
        return Err(e);
    }

    let _ = app.emit(
        "bounce_progress",
        serde_json::json!({ "jobId": &job_id, "progress": 45.0, "phase": "Separating stems (AI)" }),
    );
    let _ = set_job_progress(&app, &job_id, 45.0, "Separating stems (AI)");

    let source_mix_path_for_stems = source_mix_path.clone();
    let stem_files = tauri::async_runtime::spawn_blocking(move || {
        dream_importers::stem_separation::get_cached_or_build_stems(PathBuf::from(&source_mix_path_for_stems).as_path())
    })
    .await
    .map_err(|e| format!("Stem separation worker failed: {e}"))?
    .map_err(|e| {
        let _ = finish_job(&app, &job_id, false, false, Some(e.clone()));
        e
    })?;

    if job_cancel.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = finish_job(
            &app,
            &job_id,
            false,
            true,
            Some("Stem split cancelled".to_string()),
        );
        return Err("Stem split cancelled".to_string());
    }

    let order = ["drums", "bass", "other", "vocals"];
    let mut stem_tracks: Vec<(String, String)> = Vec::new();
    for stem in order {
        if let Some(path) = stem_files.get(stem) {
            let label = match stem {
                "drums" => "Drums",
                "bass" => "Bass",
                "other" => "Other",
                "vocals" => "Vocals",
                _ => stem,
            };
            stem_tracks.push((path.clone(), format!("{} {}", source_track.name, label)));
        }
    }

    let result = place_stem_files_on_new_tracks(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        &stem_tracks,
        start_frame,
    );

    if result.is_ok() {
        if job_cancel.load(std::sync::atomic::Ordering::SeqCst) {
            let _ = finish_job(
                &app,
                &job_id,
                false,
                true,
                Some("Stem split cancelled".to_string()),
            );
            return Err("Stem split cancelled".to_string());
        }
        let _ = set_job_progress(&app, &job_id, 100.0, "Stem split complete");
        let _ = app.emit(
            "bounce_progress",
            serde_json::json!({ "jobId": &job_id, "progress": 100.0, "phase": "Stem split complete" }),
        );
        let _ = finish_job(&app, &job_id, true, false, None);
    } else if let Err(err) = &result {
        let _ = finish_job(&app, &job_id, false, false, Some(err.clone()));
    }

    result
}
