fn normalize_track_color_hex(color_hex: &str) -> Result<String, String> {
    let mut normalized = color_hex.trim().to_string();
    if normalized.is_empty() {
        return Err("Color cannot be empty".to_string());
    }
    if !normalized.starts_with('#') {
        normalized = format!("#{normalized}");
    }
    if normalized.len() != 7 {
        return Err(format!("Invalid color format: {color_hex}"));
    }
    Ok(normalized.to_ascii_uppercase())
}

#[tauri::command]
async fn set_track_color_cmd(
    track_id: String,
    color_hex: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string());
    };
    let project_state_guard = active_project_arc.read().unwrap();
    let project_state: &crate::state_managers::ProjectState = &*project_state_guard;
    let normalized = normalize_track_color_hex(&color_hex)?;
    let track_uuid = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track id: {e}"))?;

    // No-op guard before undo snapshot.
    {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let track = project
            .tracks
            .iter()
            .find(|t| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found: {track_id}"))?;
        if track.color_hex.as_deref() == Some(normalized.as_str()) {
            return Ok(());
        }
    }

    push_undo(&project_state)?;
    let cmd = dream_orchestrator::commands::SetTrackColorCommand::from_str_track_id(
        &track_id,
        normalized,
    )
    .map_err(|e| e.to_string())?;
    execute_orchestrator_command(&project_state, &cmd)?;
    let project_name = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .name
        .clone();
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

#[tauri::command]
async fn set_track_color_with_deltas_cmd(
    track_id: String,
    color_hex: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string());
    };
    let project_state_guard = active_project_arc.read().unwrap();
    let project_state: &crate::state_managers::ProjectState = &*project_state_guard;
    let parsed_id = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track id: {e}"))?;
    let normalized = normalize_track_color_hex(&color_hex)?;

    // Keep no-op responses empty so frontend never needs fallback refresh.
    {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let track = project
            .tracks
            .iter()
            .find(|t| t.id == parsed_id)
            .ok_or_else(|| format!("Track not found: {track_id}"))?;
        if track.color_hex.as_deref() == Some(normalized.as_str()) {
            return Ok(DeltaMutationResponse { deltas: Vec::new() });
        }
    }

    set_track_color_cmd(track_id, normalized.clone(), project_state.clone(), app).await?;

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackColorChanged {
            track_id: parsed_id,
            color: normalized,
        }],
    })
}

fn rebuild_group_children(project: &mut dream_models::project::Project) {
    for track in &mut project.tracks {
        track.child_track_ids.clear();
    }
    let parent_pairs: Vec<(Uuid, Uuid)> = project
        .tracks
        .iter()
        .filter_map(|t| t.parent_track_id.map(|parent| (t.id, parent)))
        .collect();
    for (child_id, parent_id) in parent_pairs {
        if let Some(parent_track) = project.tracks.iter_mut().find(|t| t.id == parent_id) {
            parent_track.child_track_ids.push(child_id);
        }
    }
}

fn refresh_runtime_after_track_topology_change(
    project: &mut dream_models::project::Project,
    clip_pool_state: &ClipPoolState,
    plugin_host_state: &PluginHostState,
    handle: &AudioEngineHandle,
) -> Result<(), String> {
    rebuild_group_children(project);
    clip_pool_state.rebuild_snapshot(project);
    rebuild_midi_snapshot_from_project(project, handle);
    rebuild_sampler_snapshot_from_project(project, clip_pool_state, handle);
    // RT-SYNC FIX: Queue device chain Remove+Add commands FIRST,
    // then publish the external_fx_snapshot. If the snapshot is published
    // before device chains are rebuilt, process_slot_with_sidechain_ctx()
    // references stale/missing slots → silent FX.
    rebuild_runtime_device_chains_from_project(project, handle)?;
    // Publish external FX snapshot AFTER device chain commands are queued.
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(project, slot_instance_map.as_ref());
    // After topology changes track indices shift — resync volume/pan/mute/solo
    // to the engine so existing tracks don't silently lose audio.
    sync_track_mix_state_from_project(project, handle)
}

#[tauri::command]
async fn create_group_cmd(
    track_ids: Vec<String>,
    group_name: Option<String>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<String, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string());
    };
    let project_state_guard = active_project_arc.read().unwrap();
    let project_state: &crate::state_managers::ProjectState = &*project_state_guard;
    let cmd = dream_orchestrator::commands::CreateGroupCommand::from_str_track_ids(
        &track_ids,
        group_name,
    )
    .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(
        &mut project,
        &clip_pool_state,
        &plugin_host_state,
        &handle,
    )?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] create_group_cmd: created group {} with {} children",
        result.group_id,
        result.child_track_ids.len()
    );
    Ok(result.group_id.to_string())
}

#[derive(Debug, Serialize, Deserialize)]
struct CreateGroupWithDeltasResponse {
    group_id: String,
    deltas: Vec<dream_models::delta::ProjectDelta>,
}

#[tauri::command]
async fn create_group_with_deltas_cmd(
    track_ids: Vec<String>,
    group_name: Option<String>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<CreateGroupWithDeltasResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string());
    };
    let project_state_guard = active_project_arc.read().unwrap();
    let project_state: &crate::state_managers::ProjectState = &*project_state_guard;
    let cmd = dream_orchestrator::commands::CreateGroupCommand::from_str_track_ids(
        &track_ids,
        group_name,
    )
    .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(
        &mut project,
        &clip_pool_state,
        &plugin_host_state,
        &handle,
    )?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    let mut deltas = vec![dream_models::delta::ProjectDelta::TrackAdded {
        track_index: result.group_index,
        track_id: result.group_id,
        name: result.group_name.clone(),
        track_type: "group".to_string(),
    }];

    deltas.extend(
        result
            .reparented_tracks
            .into_iter()
            .map(|(track_id, parent_track_id)| {
                dream_models::delta::ProjectDelta::TrackParentChanged {
                    track_id,
                    parent_track_id,
                }
            }),
    );

    deltas.extend(
        result
            .moved_tracks
            .into_iter()
            .map(|(track_id, old_index, new_index)| dream_models::delta::ProjectDelta::TrackMoved {
                track_id,
                old_index,
                new_index,
            }),
    );

    Ok(CreateGroupWithDeltasResponse {
        group_id: result.group_id.to_string(),
        deltas,
    })
}

#[tauri::command]
async fn set_group_expanded_cmd(
    group_id: String,
    expanded: bool,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string());
    };
    let project_state_guard = active_project_arc.read().unwrap();
    let project_state: &crate::state_managers::ProjectState = &*project_state_guard;
    let cmd = dream_orchestrator::commands::SetGroupExpandedCommand::from_str_group_id(
        &group_id, expanded,
    )
    .map_err(|e| e.to_string())?;
    execute_orchestrator_command(&project_state, &cmd)?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!("[IPC] set_group_expanded_cmd({group_id} -> {expanded})");
    Ok(())
}

#[tauri::command]
async fn set_group_expanded_with_deltas_cmd(
    group_id: String,
    expanded: bool,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string());
    };
    let project_state_guard = active_project_arc.read().unwrap();
    let project_state: &crate::state_managers::ProjectState = &*project_state_guard;
    let track_uuid =
        Uuid::parse_str(&group_id).map_err(|e| format!("Invalid group id: {e}"))?;
    set_group_expanded_cmd(group_id, expanded, project_state, app).await?;
    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackGroupExpandedChanged {
            track_id: track_uuid,
            expanded,
        }],
    })
}
