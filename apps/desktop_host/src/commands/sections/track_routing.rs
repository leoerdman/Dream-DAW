#[tauri::command]
async fn move_track_to_index_cmd(
    track_id: String,
    target_index: usize,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
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
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
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
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<TrackManagementDeltaResponse, String> {
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
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] move_track_to_index_with_deltas_cmd({track_id}: {} -> {})",
        result.old_index,
        result.new_index
    );
    Ok(TrackManagementDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackMoved {
            track_id: moving_id,
            old_index: result.old_index,
            new_index: result.new_index,
        }],
    })
}

#[tauri::command]
async fn move_track_with_parent_cmd(
    track_id: String,
    target_index: usize,
    target_parent_group_id: Option<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let cmd = dream_orchestrator::commands::MoveTrackWithParentCommand::from_str_ids(
        &track_id,
        target_index,
        target_parent_group_id.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
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
async fn set_track_group_cmd(
    track_id: String,
    group_id: Option<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let cmd = dream_orchestrator::commands::SetTrackGroupCommand::from_str_ids(
        &track_id,
        group_id.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    execute_orchestrator_command(&project_state, &cmd)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] set_track_group_cmd({track_id} -> {:?})",
        cmd.target_group_id
    );
    Ok(())
}

#[tauri::command]
async fn ungroup_track_cmd(
    group_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let cmd = dream_orchestrator::commands::UngroupTrackCommand::from_str_group_id(&group_id)
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
        "[IPC] ungroup_track_cmd({group_id}, removed_index={}, reassigned_children={})",
        result.removed_index,
        result.reassigned_children
    );
    Ok(())
}

#[tauri::command]
async fn move_track_block_to_index_cmd(
    root_track_id: String,
    target_index: usize,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let cmd = dream_orchestrator::commands::MoveTrackBlockToIndexCommand::from_str_root_track_id(
        &root_track_id,
        target_index,
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
        "[IPC] move_track_block_to_index_cmd({root_track_id}: {} -> {}, len={})",
        result.old_first_index,
        result.new_first_index,
        result.block_len
    );
    Ok(())
}

#[tauri::command]
async fn duplicate_tracks_cmd(
    track_ids: Vec<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let cmd = dream_orchestrator::commands::DuplicateTracksCommand::from_str_track_ids(&track_ids)
        .map_err(|e| e.to_string())?;
    if cmd.track_ids.is_empty() {
        return Ok(());
    }

    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    if result.added_tracks.is_empty() {
        return Ok(());
    }

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
    log::info!("[IPC] duplicate_tracks_cmd(count={})", result.added_tracks.len());
    Ok(())
}

#[tauri::command]
async fn duplicate_tracks_with_deltas_cmd(
    track_ids: Vec<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<TrackManagementDeltaResponse, String> {
    let cmd = dream_orchestrator::commands::DuplicateTracksCommand::from_str_track_ids(&track_ids)
        .map_err(|e| e.to_string())?;
    if cmd.track_ids.is_empty() {
        return Ok(TrackManagementDeltaResponse { deltas: vec![] });
    }

    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    if result.added_tracks.is_empty() {
        return Ok(TrackManagementDeltaResponse { deltas: vec![] });
    }

    let mut deltas = Vec::with_capacity(result.added_tracks.len());
    for added in &result.added_tracks {
        deltas.push(dream_models::delta::ProjectDelta::TrackAdded {
            track_index: added.inserted_index,
            track_id: added.track_id,
            name: added.name.clone(),
            track_type: format!("{:?}", added.track_type),
        });
    }

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
        "[IPC] duplicate_tracks_with_deltas_cmd(count={})",
        result.added_tracks.len()
    );
    Ok(TrackManagementDeltaResponse { deltas })
}
