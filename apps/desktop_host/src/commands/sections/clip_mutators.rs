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
    build_local_pool_for_project, collect_added_track_and_clip_deltas, find_audio_clip_delta_state,
    find_clip_position_frames, find_clip_track_index, place_bounced_file_on_new_track,
    place_stem_files_on_new_tracks,
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

#[tauri::command]
async fn set_clip_pitch_with_deltas_cmd(
    payload: SetClipPitchPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let clip_uuid =
        Uuid::parse_str(&payload.clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let pitch = payload.pitch_shift_semitones;
    set_clip_pitch_cmd(payload, project_state, clip_pool_state, app).await?;
    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::ClipPitchChanged {
            clip_id: clip_uuid,
            pitch_shift_semitones: pitch,
        }],
    })
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


include!("clip_mutators/advanced_commands.rs");

include!("clip_mutators/recording_commands.rs");

include!("clip_mutators/export_commands.rs");
include!("clip_mutators/bounce_commands.rs");
include!("clip_mutators/split_stems_commands.rs");
