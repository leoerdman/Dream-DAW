use super::*;

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

pub(super) fn find_clip_track_index(project: &Project, clip_id: Uuid) -> Option<usize> {
    project.tracks.iter().position(|track| {
        track.clips.iter().any(|clip| clip.id == clip_id)
            || track.midi_clips.iter().any(|clip| clip.id == clip_id)
    })
}

pub(super) fn find_clip_position_frames(project: &Project, clip_id: Uuid) -> Option<i64> {
    for track in &project.tracks {
        if let Some(clip) = track.clips.iter().find(|clip| clip.id == clip_id) {
            return Some(clip.position.sample_frame);
        }
        if let Some(clip) = track.midi_clips.iter().find(|clip| clip.id == clip_id) {
            return Some(clip.position.sample_frame);
        }
    }
    None
}

#[derive(Debug, Clone, Copy)]
pub(super) struct AudioClipDeltaState {
    pub(super) source_offset: i64,
    pub(super) fade_in_frames: i64,
    pub(super) fade_out_frames: i64,
    pub(super) is_warped: bool,
    pub(super) warp_mode: Option<i32>,
    pub(super) warp_base_bpm: f64,
}

pub(super) fn find_audio_clip_delta_state(
    project: &Project,
    clip_id: Uuid,
) -> Option<AudioClipDeltaState> {
    for track in &project.tracks {
        if let Some(clip) = track.clips.iter().find(|clip| clip.id == clip_id) {
            return Some(AudioClipDeltaState {
                source_offset: clip.source_offset.sample_frame,
                fade_in_frames: clip.fade_in_frames,
                fade_out_frames: clip.fade_out_frames,
                is_warped: clip.is_warped,
                warp_mode: clip.warp_mode,
                warp_base_bpm: clip.warp_base_bpm,
            });
        }
    }
    None
}

pub(super) fn place_bounced_file_on_new_track(
    project_state: &tauri::State<'_, ProjectState>,
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

    let (project_sr, project_name) = {
        let p = project_state.project.lock().map_err(|e| e.to_string())?;
        (p.sample_rate.max(1.0), p.name.clone())
    };

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

    let insert_result = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let result = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        let result_project = ctx.lock_project().map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? = result_project.clone();
        result
    };

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(app))?;
    Ok(insert_result)
}

pub(super) fn place_stem_files_on_new_tracks(
    project_state: &tauri::State<'_, ProjectState>,
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

    let (project_sr, project_name) = {
        let p = project_state.project.lock().map_err(|e| e.to_string())?;
        (p.sample_rate.max(1.0), p.name.clone())
    };

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
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(app))?;
    Ok(())
}
