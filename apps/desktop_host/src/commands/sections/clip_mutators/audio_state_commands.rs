fn resolve_audio_clip_state(
    project_state: &crate::state_managers::ProjectState,
    clip_id: Uuid,
) -> Result<dream_orchestrator::queries::AudioClipState, String> {
    execute_orchestrator_query(
        project_state,
        &dream_orchestrator::queries::ResolveAudioClipStateQuery { clip_id },
    )
}

fn resolve_audio_clip_timeline_bounds(
    project_state: &crate::state_managers::ProjectState,
    clip_id: Uuid,
) -> Result<(i64, i64), String> {
    let project = project_state.project.lock().map_err(|_| "failed to lock".to_string())?;
    let clip = project
        .tracks
        .iter()
        .flat_map(|t| t.clips.iter())
        .find(|c| c.id == clip_id)
        .ok_or_else(|| format!("Audio clip not found: {clip_id}"))?;
    Ok((clip.position.sample_frame, clip.duration.sample_frame))
}

/// Update a clip's source offset (slip editing).
#[tauri::command]
async fn set_clip_source_offset_cmd(
    clip_id: String,
    source_offset_frames: i64,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
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
        let clip_file_path = resolve_audio_clip_state(&project_state, clip_uuid)?.file_path;
        let pool = clip_pool_state.pool.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
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

    rebuild_clips_only_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &app,
    )?;
    Ok(())
}

#[tauri::command]
async fn set_clip_source_offset_with_deltas_cmd(
    clip_id: String,
    source_offset_frames: i64,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let before_state = resolve_audio_clip_state(&project_state, clip_uuid)?;

    set_clip_source_offset_cmd(
        clip_id,
        source_offset_frames,
        project_registry.clone(),
        clip_pool_state,
        app,
    )
    .await?;

    let after_state = resolve_audio_clip_state(&project_state, clip_uuid)?;

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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetClipPitchPayload {
    clip_id: String,
    #[serde(alias = "pitch_shift_semitones")]
    pitch_shift_semitones: f64,
}

/// Set clip pitch shift semitones.
#[tauri::command]
async fn set_clip_pitch_cmd(
    payload: SetClipPitchPayload,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::SetClipPitchCommand::from_str_id(
        &payload.clip_id,
        payload.pitch_shift_semitones,
    )
    .map_err(|e| e.to_string())?;

    execute_orchestrator_command(&project_state, &cmd)?;

    rebuild_clips_only_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &app,
    )?;
    Ok(())
}

#[tauri::command]
async fn set_clip_pitch_with_deltas_cmd(
    payload: SetClipPitchPayload,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let clip_uuid =
        Uuid::parse_str(&payload.clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let pitch = payload.pitch_shift_semitones;
    let (before_pos, before_dur) = resolve_audio_clip_timeline_bounds(&project_state, clip_uuid)?;
    set_clip_pitch_cmd(
        payload,
        project_registry.clone(),
        clip_pool_state,
        app,
    )
    .await?;
    let (after_pos, after_dur) = resolve_audio_clip_timeline_bounds(&project_state, clip_uuid)?;
    let mut deltas = vec![dream_models::delta::ProjectDelta::ClipPitchChanged {
        clip_id: clip_uuid,
        pitch_shift_semitones: pitch,
    }];
    if before_pos != after_pos || before_dur != after_dur {
        deltas.push(dream_models::delta::ProjectDelta::ClipResized {
            clip_id: clip_uuid,
            new_position: after_pos,
            new_duration: after_dur,
        });
    }
    Ok(DeltaMutationResponse {
        deltas,
    })
}

/// Set clip warp state/mode/base BPM and recalculate timeline duration.
#[tauri::command]
async fn set_clip_warp_cmd(
    payload: SetClipWarpPayload,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
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

    rebuild_clips_only_and_mark_dirty(
        &project_state,
        &clip_pool_state,
        &app,
    )?;
    Ok(())
}

#[tauri::command]
async fn set_clip_warp_with_deltas_cmd(
    payload: SetClipWarpPayload,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let clip_uuid =
        Uuid::parse_str(&payload.clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let (before_pos, before_dur) = resolve_audio_clip_timeline_bounds(&project_state, clip_uuid)?;
    let before_state = resolve_audio_clip_state(&project_state, clip_uuid)?;

    set_clip_warp_cmd(
        payload,
        project_registry.clone(),
        clip_pool_state,
        app,
    )
    .await?;

    let after_state = resolve_audio_clip_state(&project_state, clip_uuid)?;
    let (after_pos, after_dur) = resolve_audio_clip_timeline_bounds(&project_state, clip_uuid)?;

    let mut deltas = Vec::new();
    if before_pos != after_pos || before_dur != after_dur {
        deltas.push(dream_models::delta::ProjectDelta::ClipResized {
            clip_id: clip_uuid,
            new_position: after_pos,
            new_duration: after_dur,
        });
    }
    if before_state.is_warped != after_state.is_warped
        || before_state.warp_mode != after_state.warp_mode
        || (before_state.warp_base_bpm - after_state.warp_base_bpm).abs() > f64::EPSILON
        || before_state.warp_source_duration_frames != after_state.warp_source_duration_frames
    {
        deltas.push(dream_models::delta::ProjectDelta::ClipWarpChanged {
            clip_id: clip_uuid,
            is_warped: after_state.is_warped,
            warp_mode: after_state.warp_mode,
            warp_base_bpm: after_state.warp_base_bpm,
            warp_source_duration_frames: after_state.warp_source_duration_frames,
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(i64, i64), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::SetClipFadesCommand::from_str_id(
        &clip_id,
        fade_in_frames,
        fade_out_frames,
    )
    .map_err(|e| e.to_string())?;

    let fades = execute_orchestrator_command(&project_state, &cmd)?;

    rebuild_clip_views_and_mark_dirty(
        project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;
    Ok(fades)
}

#[tauri::command]
async fn set_clip_fades_with_deltas_cmd(
    clip_id: String,
    fade_in_frames: i64,
    fade_out_frames: i64,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;

    let (actual_fade_in, actual_fade_out) = set_clip_fades_cmd(
        clip_id,
        fade_in_frames,
        fade_out_frames,
        project_registry.clone(),
        clip_pool_state,
        handle,
        app,
    )
    .await?;

    let deltas = vec![dream_models::delta::ProjectDelta::ClipFadesChanged {
        clip_id: clip_uuid,
        fade_in_frames: actual_fade_in,
        fade_out_frames: actual_fade_out,
    }];
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::MuteClipCommand::from_str_id(&clip_id, muted)
        .map_err(|e| e.to_string())?;

    execute_orchestrator_command(&project_state, &cmd)?;

    rebuild_clip_views_and_mark_dirty(
        project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;

    log::info!("[IPC] set_clip_muted_cmd clip={} muted={}", clip_id, muted);
    Ok(())
}

#[tauri::command]
async fn set_clip_muted_with_deltas_cmd(
    clip_id: String,
    muted: bool,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    push_undo(&project_state)?;

    let clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip id: {e}"))?;
    let cmd = dream_orchestrator::commands::MuteClipCommand::from_str_id(&clip_id, muted)
        .map_err(|e| e.to_string())?;

    let changed = execute_orchestrator_command(&project_state, &cmd)?;

    rebuild_clip_views_and_mark_dirty(
        project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;

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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    if clip_ids.is_empty() {
        return Ok(0);
    }

    // CQRS: undo + delegate to orchestrator + snapshot rebuild
    push_undo(&project_state)?;

    let cmd = dream_orchestrator::commands::MuteClipsBatchCommand::from_str_ids(&clip_ids, muted)
        .map_err(|e| e.to_string())?;

    let applied = execute_orchestrator_command(&project_state, &cmd)?;

    if applied > 0 {
        rebuild_clip_views_and_mark_dirty(
        project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
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
        rebuild_clip_views_and_mark_dirty(
        project_state,
        &clip_pool_state,
        &handle,
        &app,
        ClipRebuildMode::ClipsOnly,
    )?;
    }

    let deltas = parsed_ids
        .into_iter()
        .map(|clip_id| dream_models::delta::ProjectDelta::ClipMuteChanged { clip_id, muted })
        .collect();
    Ok(DeltaMutationResponse { deltas })
}
