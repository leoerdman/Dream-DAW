/// Split a track into 4 stems (drums, bass, other, vocals) and place each stem on a new track.
#[tauri::command]
async fn split_track_to_stems_cmd(
    payload: SplitTrackToStemsPayload,
    app: tauri::AppHandle,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let track_uuid =
        Uuid::parse_str(&payload.track_id).map_err(|e| format!("Invalid track ID: {e}"))?;
    let split_plan = execute_orchestrator_query(
        &project_state,
        &dream_orchestrator::queries::PrepareStemSplitQuery { track_id: track_uuid },
    )?;
    let included_ids: std::collections::HashSet<Uuid> =
        split_plan.included_track_ids.iter().copied().collect();
    let start_frame = split_plan.start_frame;
    let end_frame = split_plan.end_frame;

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
        bpm: handle.playback_state.lock().map_err(|_| "Mutex poisoned".to_string())?.bpm,
    };

    crate::commands::plugins_routing_helpers::ensure_external_plugins_prepared_for_offline_render(
        &bounce_project,
        &clip_pool_state,
        &plugin_host_state,
        project.sample_rate,
        "Stem split",
    )?;

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
    let plugin_registry_snapshot = (*handle.plugin_registry.load()).clone();
    let external_fx_snapshot = (*handle.external_fx_snapshot.load()).clone();
    let bounce_res = tauri::async_runtime::spawn_blocking(move || {
        let mut bouncer = OfflineRenderer::new(cfg);
        bouncer.cancel_flag = cancel_flag;
        let mut bounce_project = bounce_project;
        let mut local_pool = local_pool;
        bouncer
            .bounce(
                &mut bounce_project,
                &mut local_pool,
                None,
                &plugin_registry_snapshot,
                &external_fx_snapshot,
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
    .inspect_err(|e| {
        let _ = finish_job(&app, &job_id, false, false, Some(e.clone()));
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
            stem_tracks.push((
                path.clone(),
                format!("{} {}", split_plan.source_track_name, label),
            ));
        }
    }

    let result = place_stem_files_on_new_tracks(
        project_state,
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let before_project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    split_track_to_stems_cmd(
        payload,
        app,
        project_registry.clone(),
        clip_pool_state,
        handle,
        plugin_host_state,
    )
    .await?;
    let after_project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    Ok(DeltaMutationResponse {
        deltas: collect_added_track_and_clip_deltas(&before_project, &after_project),
    })
}
