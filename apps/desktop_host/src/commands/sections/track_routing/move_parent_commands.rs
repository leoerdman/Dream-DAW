#[tauri::command]
async fn move_track_to_index_cmd(
    track_id: String,
    target_index: usize,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::MoveTrackToIndexCommand::from_str_track_id(
        &track_id,
        target_index,
    )
    .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    if !result.changed {
        return Ok(());
    }
    let mut project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] move_track_to_index_cmd({track_id}: {} -> {})",
        result.old_index,
        result.new_index
    );
    Ok(())
}

#[tauri::command]
async fn move_track_to_index_with_deltas_cmd(
    track_id: String,
    target_index: usize,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<TrackManagementDeltaResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::MoveTrackToIndexCommand::from_str_track_id(
        &track_id,
        target_index,
    )
    .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    if !result.changed {
        return Ok(TrackManagementDeltaResponse { deltas: vec![] });
    }
    let moving_id = cmd.track_id;
    let mut project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] move_track_to_index_with_deltas_cmd({track_id}: {} -> {})",
        result.old_index,
        result.new_index
    );
    // SSOT FIX: Append full snapshot — track reordering changes all indices.
    let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    Ok(TrackManagementDeltaResponse {
        deltas: vec![
            dream_models::delta::ProjectDelta::TrackMoved {
                track_id: moving_id,
                old_index: result.old_index,
                new_index: result.new_index,
            },
            dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
                project: Box::new(project.clone()),
            },
        ],
    })
}

#[tauri::command]
async fn move_track_with_parent_cmd(
    track_id: String,
    target_index: usize,
    target_parent_group_id: Option<String>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::MoveTrackWithParentCommand::from_str_ids(
        &track_id,
        target_index,
        target_parent_group_id.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    let mut project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] move_track_with_parent_cmd({track_id}: {} -> {}, parent={:?})",
        result.old_index,
        result.new_index,
        cmd.target_parent_group_id
    );
    Ok(())
}

#[tauri::command]
async fn move_track_with_parent_with_deltas_cmd(
    track_id: String,
    target_index: usize,
    target_parent_group_id: Option<String>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::MoveTrackWithParentCommand::from_str_ids(
        &track_id,
        target_index,
        target_parent_group_id.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    let mut project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    // SSOT FIX: Append full snapshot — parent+index changes affect routing topology.
    let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    Ok(DeltaMutationResponse {
        deltas: vec![
            dream_models::delta::ProjectDelta::TrackMoved {
                track_id: cmd.track_id,
                old_index: result.old_index,
                new_index: result.new_index,
            },
            dream_models::delta::ProjectDelta::TrackParentChanged {
                track_id: cmd.track_id,
                parent_track_id: cmd.target_parent_group_id,
            },
            dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
                project: Box::new(project.clone()),
            },
        ],
    })
}
