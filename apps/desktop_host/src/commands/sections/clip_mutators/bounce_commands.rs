/// Bounce selected clips or selected time range to a new audio track.
#[tauri::command]
async fn bounce_selection_to_track_cmd(
    payload: BounceSelectionPayload,
    app: tauri::AppHandle,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
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

    crate::commands::plugins_routing_helpers::ensure_external_plugins_prepared_for_offline_render(
        &bounce_project,
        &clip_pool_state,
        &plugin_host_state,
        project.sample_rate,
        "Bounce",
    )?;

    let (job_id, job_cancel) = start_job(&app, "bounce_selection", true)?;
    let plugin_registry_snapshot = (*handle.plugin_registry.load()).clone();
    let external_fx_snapshot = (*handle.external_fx_snapshot.load()).clone();

    handle
        .export_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);
    let app_for_progress = app.clone();
    let job_id_for_progress = job_id.clone();
    let bounce_res = tauri::async_runtime::spawn_blocking(move || {
        let mut bouncer = OfflineRenderer::new(cfg);
        bouncer.cancel_flag = cancel_flag;
        let mut bounce_project = bounce_project;
        let mut local_pool = local_pool;
        let plugin_registry_snapshot = plugin_registry_snapshot;
        let external_fx_snapshot = external_fx_snapshot;
        bouncer
            .bounce(
                &mut bounce_project,
                &mut local_pool,
                None,
                &plugin_registry_snapshot,
                &external_fx_snapshot,
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
        project_state,
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

#[tauri::command]
async fn bounce_selection_to_track_with_deltas_cmd(
    payload: BounceSelectionPayload,
    app: tauri::AppHandle,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<DeltaMutationResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let before_project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    bounce_selection_to_track_cmd(
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
    let deltas = collect_added_track_and_clip_deltas(&before_project, &after_project);
    Ok(DeltaMutationResponse {
        deltas,
    })
}

/// Bounce an entire track to a new audio track.
#[tauri::command]
async fn bounce_track_cmd(
    track_id: String,
    app: tauri::AppHandle,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
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

    crate::commands::plugins_routing_helpers::ensure_external_plugins_prepared_for_offline_render(
        &bounce_project,
        &clip_pool_state,
        &plugin_host_state,
        project.sample_rate,
        "Bounce",
    )?;

    let (job_id, job_cancel) = start_job(&app, "bounce_track", true)?;
    let plugin_registry_snapshot = (*handle.plugin_registry.load()).clone();
    let external_fx_snapshot = (*handle.external_fx_snapshot.load()).clone();

    handle
        .export_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);
    let app_for_progress = app.clone();
    let job_id_for_progress = job_id.clone();
    let bounce_res = tauri::async_runtime::spawn_blocking(move || {
        let mut bouncer = OfflineRenderer::new(cfg);
        bouncer.cancel_flag = cancel_flag;
        let mut bounce_project = bounce_project;
        let mut local_pool = local_pool;
        let plugin_registry_snapshot = plugin_registry_snapshot;
        let external_fx_snapshot = external_fx_snapshot;
        bouncer
            .bounce(
                &mut bounce_project,
                &mut local_pool,
                None,
                &plugin_registry_snapshot,
                &external_fx_snapshot,
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
        project_state,
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<DeltaMutationResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
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

    bounce_track_cmd(
        track_id,
        app.clone(),
        project_registry.clone(),
        clip_pool_state.clone(),
        handle.clone(),
        plugin_host_state,
    )
    .await?;

    let placement_project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let maybe_new_track = placement_project
        .tracks
        .iter()
        .enumerate()
        .rev()
        .find(|(_, t)| t.name == format!("{} Bounce", source_track.name))
        .map(|(idx, t)| (idx, t.id, t.name.clone()));
    let Some((track_index, track_id_new, track_name_new)) = maybe_new_track else {
        return Err("Bounce succeeded but bounced track was not found".to_string());
    };
    let Some(new_clip) = placement_project
        .tracks
        .get(track_index)
        .and_then(|t| t.clips.last())
    else {
        return Err("Bounce succeeded but bounced clip was not found".to_string());
    };

    Ok(DeltaMutationResponse {
        deltas: vec![
            dream_models::delta::ProjectDelta::TrackAdded {
                track_index,
                track_id: track_id_new,
                name: track_name_new,
                track_type: "audio".to_string(),
            },
            dream_models::delta::ProjectDelta::ClipAdded {
                clip_id: new_clip.id,
                track_index,
                name: new_clip.name.clone(),
                clip_type: "audio".to_string(),
                file_path: Some(new_clip.file_path.clone()),
                position: new_clip.position.sample_frame,
                duration: new_clip.duration.sample_frame,
            },
        ],
    })
}

/// Bounce a group track (group + all descendant tracks) to a new audio track.
#[tauri::command]
async fn bounce_group_cmd(
    group_track_id: String,
    app: tauri::AppHandle,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
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

    crate::commands::plugins_routing_helpers::ensure_external_plugins_prepared_for_offline_render(
        &bounce_project,
        &clip_pool_state,
        &plugin_host_state,
        project.sample_rate,
        "Bounce",
    )?;

    let (job_id, job_cancel) = start_job(&app, "bounce_group", true)?;
    let plugin_registry_snapshot = (*handle.plugin_registry.load()).clone();
    let external_fx_snapshot = (*handle.external_fx_snapshot.load()).clone();

    handle
        .export_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);
    let app_for_progress = app.clone();
    let job_id_for_progress = job_id.clone();
    let bounce_res = tauri::async_runtime::spawn_blocking(move || {
        let mut bouncer = OfflineRenderer::new(cfg);
        bouncer.cancel_flag = cancel_flag;
        let mut bounce_project = bounce_project;
        let mut local_pool = local_pool;
        let plugin_registry_snapshot = plugin_registry_snapshot;
        let external_fx_snapshot = external_fx_snapshot;
        bouncer
            .bounce(
                &mut bounce_project,
                &mut local_pool,
                None,
                &plugin_registry_snapshot,
                &external_fx_snapshot,
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
        project_state,
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

#[tauri::command]
async fn bounce_group_with_deltas_cmd(
    group_track_id: String,
    app: tauri::AppHandle,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<DeltaMutationResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let before_project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    bounce_group_cmd(
        group_track_id,
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
    let deltas = collect_added_track_and_clip_deltas(&before_project, &after_project);
    Ok(DeltaMutationResponse {
        deltas,
    })
}
