use super::*;
use dream_models::project::Project;

pub(super) enum ClipRebuildMode {
    ClipsOnly,
    FullSnapshot,
}

pub(super) fn rebuild_clip_views_and_mark_dirty(
    project_state: &crate::state_managers::ProjectState,
    clip_pool_state: &tauri::State<'_, ClipPoolState>,
    handle: &tauri::State<'_, AudioEngineHandle>,
    app: &tauri::AppHandle,
    mode: ClipRebuildMode,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| format!("Project lock poisoned: {e}"))?;
    match mode {
        ClipRebuildMode::ClipsOnly => clip_pool_state.rebuild_clips_only(&project),
        ClipRebuildMode::FullSnapshot => clip_pool_state.rebuild_snapshot(&project),
    }
    rebuild_midi_snapshot_from_project(&project, handle);
    drop(project);
    project_state.mark_dirty_current(Some(app))?;
    Ok(())
}

pub(super) fn rebuild_clips_only_and_mark_dirty(
    project_state: &crate::state_managers::ProjectState,
    clip_pool_state: &tauri::State<'_, ClipPoolState>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| format!("Project lock poisoned: {e}"))?;
    clip_pool_state.rebuild_clips_only(&project);
    drop(project);
    project_state.mark_dirty_current(Some(app))?;
    Ok(())
}

pub(super) fn rebuild_clip_snapshot_and_mark_dirty(
    project_state: &crate::state_managers::ProjectState,
    clip_pool_state: &tauri::State<'_, ClipPoolState>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| format!("Project lock poisoned: {e}"))?;
    clip_pool_state.rebuild_snapshot(&project);
    drop(project);
    project_state.mark_dirty_current(Some(app))?;
    Ok(())
}

pub(super) fn rebuild_automation_and_mark_dirty(
    project_state: &crate::state_managers::ProjectState,
    automation_runtime: &tauri::State<'_, AutomationRuntime>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| format!("Project lock poisoned: {e}"))?;
    rebuild_automation_snapshot_from_project(&project, automation_runtime);
    drop(project);
    project_state.mark_dirty_current(Some(app))?;
    Ok(())
}

pub(super) fn build_local_pool_for_project(
    project: &Project,
    clip_pool_state: &tauri::State<'_, ClipPoolState>,
) -> Result<ClipPool, String> {
    let mut local_pool = clip_pool_state
        .pool
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    for track in &project.tracks {
        for clip in &track.clips {
            if clip.file_path.is_empty() {
                continue;
            }
            if local_pool.get(&clip.file_path).is_some() {
                continue;
            }
            if !PathBuf::from(&clip.file_path).exists() {
                continue;
            }
            if let Ok(decoded) = AudioReader::read(PathBuf::from(&clip.file_path)) {
                let _ = local_pool.insert(ClipAudio {
                    source_path: clip.file_path.clone(),
                    channels: decoded.channels,
                    sample_rate: decoded.sample_rate,
                    num_frames: decoded.num_frames,
                });
            }
        }

        // Load sampler samples for MIDI tracks (needed for offline MIDI pre-rendering).
        if let Some(ref sampler_cfg) = track.sampler {
            if !sampler_cfg.sample_path.is_empty()
                && local_pool.get(&sampler_cfg.sample_path).is_none()
            {
                let path = PathBuf::from(&sampler_cfg.sample_path);
                if path.exists() {
                    if let Ok(decoded) = AudioReader::read(path) {
                        let _ = local_pool.insert(ClipAudio {
                            source_path: sampler_cfg.sample_path.clone(),
                            channels: decoded.channels,
                            sample_rate: decoded.sample_rate,
                            num_frames: decoded.num_frames,
                        });
                        log::info!(
                            "[ExportPool] Loaded sampler sample '{}' for track '{}'",
                            sampler_cfg.sample_path,
                            track.name
                        );
                    }
                }
            }
        }
    }
    Ok(local_pool)
}

pub(super) fn place_bounced_file_on_new_track(
    project_state: &crate::state_managers::ProjectState,
    clip_pool_state: &tauri::State<'_, ClipPoolState>,
    handle: &tauri::State<'_, AudioEngineHandle>,
    app: &tauri::AppHandle,
    bounced_file_path: &str,
    clip_name: &str,
    clip_start_frame: i64,
    new_track_name: &str,
    insert_after_index: Option<usize>,
) -> Result<dream_orchestrator::commands::clip_bounce::InsertBouncedClipResult, String> {
    let decoded = AudioReader::read(PathBuf::from(bounced_file_path))
        .map_err(|e| format!("Failed to decode bounced file: {e}"))?;
    push_undo(project_state)?;

    {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        let _ = pool.insert(ClipAudio {
            source_path: bounced_file_path.to_string(),
            channels: decoded.channels,
            sample_rate: decoded.sample_rate,
            num_frames: decoded.num_frames,
        });
    }

    let project_sr = execute_orchestrator_query(
        project_state,
        &dream_orchestrator::queries::ResolveProjectSampleRateQuery,
    )?
    .max(1.0);

    let source_sr = decoded.sample_rate.max(1) as f64;
    let timeline_frames = ((decoded.num_frames as f64) * (project_sr / source_sr)).round() as i64;
    
    let cmd = dream_orchestrator::commands::InsertBouncedClipCommand {
        file_path: bounced_file_path.to_string(),
        clip_name: clip_name.to_string(),
        start_frame: clip_start_frame,
        timeline_duration_frames: timeline_frames,
        source_duration_frames: decoded.num_frames as i64,
        new_track_name: new_track_name.to_string(),
        insert_after_index,
    };

    let insert_result = execute_orchestrator_command(project_state, &cmd)?;

    rebuild_clip_views_and_mark_dirty(
        project_state,
        clip_pool_state,
        handle,
        app,
        ClipRebuildMode::FullSnapshot,
    )?;
    Ok(insert_result)
}

pub(super) fn place_stem_files_on_new_tracks(
    project_state: &crate::state_managers::ProjectState,
    clip_pool_state: &tauri::State<'_, ClipPoolState>,
    handle: &tauri::State<'_, AudioEngineHandle>,
    app: &tauri::AppHandle,
    stems: &[(String, String)],
    clip_start_frame: i64,
) -> Result<(), String> {

    struct StemMeta {
        path: String,
        track_name: String,
        channels_data: Vec<Vec<f32>>,
        num_frames: usize,
        sample_rate: u32,
    }

    let mut metas: Vec<StemMeta> = Vec::with_capacity(stems.len());
    for (stem_path, stem_track_name) in stems {
        let decoded = AudioReader::read(PathBuf::from(stem_path))
            .map_err(|e| format!("Failed to decode stem '{}': {e}", stem_path))?;
        metas.push(StemMeta {
            path: stem_path.clone(),
            track_name: stem_track_name.clone(),
            channels_data: decoded.channels,
            num_frames: decoded.num_frames,
            sample_rate: decoded.sample_rate,
        });
    }

    push_undo(project_state)?;

    {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        for stem in &metas {
            let _ = pool.insert(ClipAudio {
                source_path: stem.path.clone(),
                channels: stem.channels_data.clone(),
                sample_rate: stem.sample_rate,
                num_frames: stem.num_frames,
            });
        }
    }

    let project_sr = execute_orchestrator_query(
        project_state,
        &dream_orchestrator::queries::ResolveProjectSampleRateQuery,
    )?
    .max(1.0);

    let mut stems_input = Vec::new();
    for stem in metas {
        let source_sr = stem.sample_rate.max(1) as f64;
        let timeline_frames = ((stem.num_frames as f64) * (project_sr / source_sr)).round() as i64;
        stems_input.push(dream_orchestrator::commands::StemMetaInput {
            file_path: stem.path,
            track_name: stem.track_name,
            timeline_duration_frames: timeline_frames,
            source_duration_frames: stem.num_frames as i64,
        });
    }

    let cmd = dream_orchestrator::commands::InsertStemClipsCommand {
        start_frame: clip_start_frame,
        stems: stems_input,
    };

    execute_orchestrator_command(project_state, &cmd)?;

    rebuild_clip_views_and_mark_dirty(
        project_state,
        clip_pool_state,
        handle,
        app,
        ClipRebuildMode::FullSnapshot,
    )?;
    Ok(())
}

pub(super) fn collect_added_track_and_clip_deltas(
    before: &Project,
    after: &Project,
) -> Vec<dream_models::delta::ProjectDelta> {
    let mut deltas = Vec::new();
    let before_track_ids: std::collections::HashSet<Uuid> =
        before.tracks.iter().map(|t| t.id).collect();
    let before_clip_ids: std::collections::HashSet<Uuid> = before
        .tracks
        .iter()
        .flat_map(|t| t.clips.iter().map(|c| c.id))
        .collect();

    for (track_index, track) in after.tracks.iter().enumerate() {
        if !before_track_ids.contains(&track.id) {
            deltas.push(dream_models::delta::ProjectDelta::TrackAdded {
                track_index,
                track_id: track.id,
                name: track.name.clone(),
                track_type: format!("{:?}", track.track_type),
            });
        }

        for clip in &track.clips {
            if before_clip_ids.contains(&clip.id) {
                continue;
            }
            deltas.push(dream_models::delta::ProjectDelta::ClipAdded {
                clip_id: clip.id,
                track_index,
                name: clip.name.clone(),
                clip_type: "audio".to_string(),
                file_path: Some(clip.file_path.clone()),
                position: clip.position.sample_frame,
                duration: clip.duration.sample_frame,
            });
        }

        // BUG-007 FIX: Also collect MIDI clips — previously only audio clips
        // were collected, so new MIDI clips never appeared until a full reload.
        for clip in &track.midi_clips {
            if before_clip_ids.contains(&clip.id) {
                continue;
            }
            deltas.push(dream_models::delta::ProjectDelta::ClipAdded {
                clip_id: clip.id,
                track_index,
                name: clip.name.clone(),
                clip_type: "midi".to_string(),
                file_path: None,
                position: clip.position.sample_frame,
                duration: clip.duration.sample_frame,
            });
        }

    }

    deltas
}
