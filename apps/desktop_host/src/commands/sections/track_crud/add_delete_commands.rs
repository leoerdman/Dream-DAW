/// Adds a new audio track to the project.
///
/// If `name` is `None`, auto-generates a name ("Audio N").
/// The track is auto-assigned a color from the 16-color palette.
#[tauri::command]
async fn add_track_cmd(
    name: Option<String>,
    track_type: Option<String>,
    insert_after_index: Option<usize>,
    inherit_from_track_id: Option<String>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    push_undo(&project_state)?;
    let cmd = dream_orchestrator::commands::AddTrackCommand {
        name: name.clone(),
        track_type: track_type.clone(),
        insert_after_index,
        inherit_from_track_id: inherit_from_track_id.clone(),
    };
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    let mut project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
    let project_name = project.name.clone();
    let track_count = project.tracks.len();
    refresh_runtime_after_track_topology_change(
        &mut project,
        &clip_pool_state,
        &plugin_host_state,
        &handle,
    )?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] add_track_cmd: '{}' type={:?} after={:?} inserted_at={} (now {} tracks)",
        result.name,
        result.track_type,
        insert_after_index,
        result.track_index,
        track_count
    );
    Ok(())
}

#[tauri::command]
async fn add_track_with_deltas_cmd(
    name: Option<String>,
    track_type: Option<String>,
    insert_after_index: Option<usize>,
    inherit_from_track_id: Option<String>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<TrackManagementDeltaResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    push_undo(&project_state)?;
    let cmd = dream_orchestrator::commands::AddTrackCommand {
        name: name.clone(),
        track_type: track_type.clone(),
        insert_after_index,
        inherit_from_track_id: inherit_from_track_id.clone(),
    };
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    let track_type_string = match result.track_type {
        TrackType::Audio => "audio",
        TrackType::Midi => "midi",
        TrackType::Group => "group",
        TrackType::Master => "master",
    }
    .to_string();

    let mut project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
    let project_name = project.name.clone();
    let inserted_track = project
        .tracks
        .iter()
        .find(|t| t.id == result.track_id)
        .map(|t| (t.color_hex.clone(), t.color.hex().to_string(), t.parent_track_id));
    refresh_runtime_after_track_topology_change(
        &mut project,
        &clip_pool_state,
        &plugin_host_state,
        &handle,
    )?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    let mut deltas = vec![dream_models::delta::ProjectDelta::TrackAdded {
            track_index: result.track_index,
            track_id: result.track_id,
            name: result.name,
            track_type: track_type_string,
    }];
    if let Some((color_hex, color_fallback_hex, parent_track_id)) = inserted_track {
        deltas.push(dream_models::delta::ProjectDelta::TrackColorChanged {
            track_id: result.track_id,
            color: color_hex.unwrap_or(color_fallback_hex),
        });
        deltas.push(dream_models::delta::ProjectDelta::TrackParentChanged {
            track_id: result.track_id,
            parent_track_id,
        });
    }

    Ok(TrackManagementDeltaResponse { deltas })
}

/// Deletes a track by index. Pushes undo snapshot before mutation.
#[tauri::command]
async fn delete_track_cmd(
    index: usize,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    push_undo(&project_state)?;
    let cmd = dream_orchestrator::commands::DeleteTrackByIndexCommand { index };
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    let mut project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
    let project_name = project.name.clone();
    let track_count = project.tracks.len();
    refresh_runtime_after_track_topology_change(
        &mut project,
        &clip_pool_state,
        &plugin_host_state,
        &handle,
    )?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    clip_pool_state.evict_unused_clips(&project_state);
    log::info!(
        "[IPC] delete_track_cmd: index={} name='{}' (now {} tracks)",
        result.removed_index,
        result.removed_track_name,
        track_count
    );
    Ok(())
}

#[tauri::command]
async fn delete_track_with_deltas_cmd(
    index: usize,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<TrackManagementDeltaResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    push_undo(&project_state)?;
    let cmd = dream_orchestrator::commands::DeleteTrackByIndexCommand { index };
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    let mut project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(
        &mut project,
        &clip_pool_state,
        &plugin_host_state,
        &handle,
    )?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    clip_pool_state.evict_unused_clips(&project_state);

    Ok(TrackManagementDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackRemoved {
            track_id: result.removed_track_id,
            track_index: result.removed_index,
        }],
    })
}

#[tauri::command]
async fn delete_tracks_cmd(
    track_ids: Vec<String>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    if track_ids.is_empty() {
        return Ok(());
    }
    push_undo(&project_state)?;
    let cmd = dream_orchestrator::commands::DeleteTracksByIdsCommand::from_str_track_ids(&track_ids)
        .map_err(|e| e.to_string())?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    if result.removed_track_ids.is_empty() {
        return Ok(());
    }

    let mut project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(
        &mut project,
        &clip_pool_state,
        &plugin_host_state,
        &handle,
    )?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    // BUG-046 FIX: Evict unused clips after bulk deletion — previously only
    // single delete_track_cmd had this, causing memory leaks on bulk delete.
    clip_pool_state.evict_unused_clips(&project_state);
    log::info!("[IPC] delete_tracks_cmd(count={})", result.removed_track_ids.len());
    Ok(())
}
