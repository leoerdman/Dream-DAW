#[tauri::command]
async fn move_track_block_to_index_cmd(
    root_track_id: String,
    target_index: usize,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::MoveTrackBlockToIndexCommand::from_str_root_track_id(
        &root_track_id,
        target_index,
    )
    .map_err(|_| "Mutex poisoned".to_string())?;

    push_undo(&project_state)?;
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
    log::info!(
        "[IPC] move_track_block_to_index_cmd({root_track_id}: {} -> {}, len={})",
        result.old_first_index,
        result.new_first_index,
        result.block_len
    );
    Ok(())
}

#[tauri::command]
async fn move_track_block_to_index_with_deltas_cmd(
    root_track_id: String,
    target_index: usize,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::MoveTrackBlockToIndexCommand::from_str_root_track_id(
        &root_track_id,
        target_index,
    )
    .map_err(|_| "Mutex poisoned".to_string())?;
    push_undo(&project_state)?;
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

    let deltas = result
        .moved_tracks
        .into_iter()
        .map(|moved| dream_models::delta::ProjectDelta::TrackMoved {
            track_id: moved.track_id,
            old_index: moved.old_index,
            new_index: moved.new_index,
        })
        .collect::<Vec<_>>();
    Ok(DeltaMutationResponse {
        deltas,
    })
}

#[tauri::command]
async fn duplicate_tracks_cmd(
    track_ids: Vec<String>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::DuplicateTracksCommand::from_str_track_ids(&track_ids)
        .map_err(|_| "Mutex poisoned".to_string())?;
    if cmd.track_ids.is_empty() {
        return Ok(());
    }

    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    if result.added_tracks.is_empty() {
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
    log::info!("[IPC] duplicate_tracks_cmd(count={})", result.added_tracks.len());
    Ok(())
}

#[tauri::command]
async fn duplicate_tracks_with_deltas_cmd(
    track_ids: Vec<String>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::DuplicateTracksCommand::from_str_track_ids(&track_ids)
        .map_err(|_| "Mutex poisoned".to_string())?;
    if cmd.track_ids.is_empty() {
        return Ok(DeltaMutationResponse { deltas: vec![] });
    }

    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    if result.added_tracks.is_empty() {
        return Ok(DeltaMutationResponse { deltas: vec![] });
    }

    let mut project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(
        &mut project,
        &clip_pool_state,
        &plugin_host_state,
        &handle,
    )?;

    // ENTERPRISE FIX: Send ProjectSnapshotReplaced instead of minimal TrackAdded deltas.
    // TrackAdded only carries 4 fields (name, type, index, id), causing the frontend
    // to create an empty track shell without clips, effects, instruments, automation,
    // or colors. ProjectSnapshotReplaced sends the full project state, ensuring the
    // frontend receives all deeply-cloned track data — same pattern as undo/redo.
    let snapshot_clone = project.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] duplicate_tracks_with_deltas_cmd(count={})",
        result.added_tracks.len()
    );
    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
            project: Box::new(snapshot_clone),
        }],
    })
}
