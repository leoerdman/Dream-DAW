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

    execute_orchestrator_command(&project_state, &cmd)?;

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

    execute_orchestrator_command(&project_state, &cmd)?;

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

    execute_orchestrator_command(&project_state, &cmd)?;

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

    execute_orchestrator_command(&project_state, &cmd)?;

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

    let result = execute_orchestrator_command(&project_state, &cmd)?;

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

    let result = execute_orchestrator_command(&project_state, &cmd)?;

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

    execute_orchestrator_command(&project_state, &cmd)?;

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

    execute_orchestrator_command(&project_state, &cmd)?;

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

    let result = execute_orchestrator_command(&project_state, &cmd)?;

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

    let result = execute_orchestrator_command(&project_state, &cmd)?;

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

    let result = execute_orchestrator_command(&project_state, &cmd)?;

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

    let result = execute_orchestrator_command(&project_state, &cmd)?;

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

    execute_orchestrator_command(&project_state, &cmd)?;

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
            let changed = execute_orchestrator_command(&project_state, &clamp_cmd)?;
            if !changed {
                log::trace!("ClampClipSourceOffsetCommand produced no changes for clip {}", clip_id);
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

    execute_orchestrator_command(&project_state, &cmd)?;

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

    execute_orchestrator_command(&project_state, &cmd)?;

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

    execute_orchestrator_command(&project_state, &cmd)?;

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

    execute_orchestrator_command(&project_state, &cmd)?;

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

    let changed = execute_orchestrator_command(&project_state, &cmd)?;

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

    let applied = execute_orchestrator_command(&project_state, &cmd)?;

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

    let applied = execute_orchestrator_command(&project_state, &cmd)?;

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

include!("clip_mutators/recording_commands.rs");

include!("clip_mutators/export_commands.rs");
include!("clip_mutators/bounce_commands.rs");
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

#[tauri::command]
async fn split_track_to_stems_with_deltas_cmd(
    payload: SplitTrackToStemsPayload,
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<DeltaMutationResponse, String> {
    split_track_to_stems_cmd(
        payload,
        app,
        project_state.clone(),
        clip_pool_state,
        handle,
    )
    .await?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();
    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
            project: Box::new(project),
        }],
    })
}
