#[tauri::command]
async fn set_track_group_cmd(
    track_id: String,
    group_id: Option<String>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetTrackGroupCommand::from_str_ids(
        &track_id,
        group_id.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    execute_orchestrator_command(&project_state, &cmd)?;

    let mut project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
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
async fn set_track_group_with_deltas_cmd(
    track_id: String,
    group_id: Option<String>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::SetTrackGroupCommand::from_str_ids(
        &track_id,
        group_id.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    execute_orchestrator_command(&project_state, &cmd)?;

    let mut project = project_state.project.lock().map_err(|_| "Mutex poisoned".to_string())?;
    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackParentChanged {
            track_id: cmd.track_id,
            parent_track_id: cmd.target_group_id,
        }],
    })
}

#[tauri::command]
async fn ungroup_track_cmd(
    group_id: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let cmd = dream_orchestrator::commands::UngroupTrackCommand::from_str_group_id(&group_id)
        .map_err(|e| e.to_string())?;

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
        "[IPC] ungroup_track_cmd({group_id}, removed_index={}, reassigned_children={})",
        result.removed_index,
        result.reassigned_children
    );
    Ok(())
}

#[tauri::command]
async fn ungroup_track_with_deltas_cmd(
    group_id: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let group_uuid = Uuid::parse_str(&group_id).map_err(|e| format!("Invalid group_id: {e}"))?;
    let cmd = dream_orchestrator::commands::UngroupTrackCommand::from_str_group_id(&group_id)
        .map_err(|e| e.to_string())?;
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
    let mut deltas = vec![dream_models::delta::ProjectDelta::TrackRemoved {
        track_id: group_uuid,
        track_index: result.removed_index,
    }];
    for child_id in result.reparented_child_ids {
        deltas.push(dream_models::delta::ProjectDelta::TrackParentChanged {
            track_id: child_id,
            parent_track_id: result.parent_of_group_before,
        });
    }
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(DeltaMutationResponse {
        deltas,
    })
}
