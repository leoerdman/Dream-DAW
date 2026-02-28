fn resolve_flow_track_index(project: &dream_models::project::Project, requested: u16) -> u16 {
    let track_count = project.tracks.len();
    if track_count == 0 {
        return 0;
    }
    (requested as usize).min(track_count.saturating_sub(1)) as u16
}

#[tauri::command]
fn set_flow_enabled_cmd(
    track_index: u16,
    enabled: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let resolved_track_index = {
        let project = project_state
            .project
            .lock()
            .map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        resolve_flow_track_index(&project, track_index)
    };

    push_command(
        &handle,
        EngineCommand::SetFlowEnabled {
            track_index: resolved_track_index,
            enabled,
        },
    )?;
    Ok(())
}

#[tauri::command]
fn sync_flow_graph_cmd(
    track_index: u16,
    nodes: Vec<(u64, String, Vec<(String, String)>)>,
    connections: Vec<(u64, usize, u64, usize)>,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<(), String> {
    // Hard caps to avoid pathological payloads from UI.
    if nodes.len() > 256 {
        return Err("Flow graph has too many nodes (max 256).".to_string());
    }
    if connections.len() > 1024 {
        return Err("Flow graph has too many connections (max 1024).".to_string());
    }

    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let resolved_track_index = {
        let project = project_state
            .project
            .lock()
            .map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        resolve_flow_track_index(&project, track_index)
    };

    push_command(
        &handle,
        EngineCommand::SyncFlowGraph {
            track_index: resolved_track_index,
            nodes,
            connections,
        },
    )?;
    Ok(())
}
