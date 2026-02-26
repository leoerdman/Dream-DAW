/// Renames a track by index.
#[tauri::command]
async fn rename_track_cmd(
    index: usize,
    name: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    push_undo(&project_state)?;
    let old_name = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        if index >= project.tracks.len() {
            return Err(format!("Track index {} out of range ({})", index, project.tracks.len()));
        }
        project.tracks[index].name.clone()
    };
    let cmd = dream_orchestrator::commands::RenameTrackByIndexCommand { index, name };
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    if !result.changed {
        return Ok(());
    }
    let sanitized = result.new_name;
    let project_name = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] rename_track_cmd: index={} '{}' → '{}'",
        index,
        old_name,
        sanitized
    );
    Ok(())
}

#[tauri::command]
async fn rename_track_with_deltas_cmd(
    index: usize,
    name: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<TrackManagementDeltaResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    push_undo(&project_state)?;
    let cmd = dream_orchestrator::commands::RenameTrackByIndexCommand { index, name };
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    if !result.changed {
        return Ok(TrackManagementDeltaResponse { deltas: Vec::new() });
    }
    let project_name = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(TrackManagementDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackRenamed {
            track_id: result.track_id,
            new_name: result.new_name,
        }],
    })
}

#[tauri::command]
async fn set_track_height_cmd(
    track_id: String,
    height: f64,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let cmd = dream_orchestrator::commands::SetTrackHeightCommand::from_str_track_id(&track_id, height)
        .map_err(|e| e.to_string())?;
    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    if !result.changed {
        return Ok(());
    }
    let project_name = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

#[tauri::command]
async fn set_track_height_with_deltas_cmd(
    track_id: String,
    height: f64,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<TrackManagementDeltaResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let cmd = dream_orchestrator::commands::SetTrackHeightCommand::from_str_track_id(&track_id, height)
        .map_err(|e| e.to_string())?;
    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    if !result.changed {
        return Ok(TrackManagementDeltaResponse { deltas: Vec::new() });
    }
    let parsed_id = cmd.track_id;
    let project_name = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(TrackManagementDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackHeightChanged {
            track_id: parsed_id,
            height: result.height,
        }],
    })
}
