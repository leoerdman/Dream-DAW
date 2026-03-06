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

#[derive(serde::Serialize)]
struct FlowSynthDeltaResponse {
    deltas: Vec<dream_models::delta::ProjectDelta>,
}

#[tauri::command]
fn save_flow_synth_config_cmd(
    track_index: u16,
    config_json: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<FlowSynthDeltaResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    
    push_undo(&project_state)?;
    
    let config: dream_models::project::FlowSynthConfig = serde_json::from_str(&config_json)
        .map_err(|e| format!("Invalid FlowSynthConfig JSON: {}", e))?;
        
    let cmd = dream_orchestrator::commands::UpdateTrackFlowSynthConfigCommand {
        track_index,
        config: Some(config),
    };
    
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    let project_name = {
        let project = project_state.project.lock().map_err(|_| "Application state error.".to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&project_name, Some(&app))?;
    
    Ok(FlowSynthDeltaResponse { 
        deltas: vec![dream_models::delta::ProjectDelta::TrackFlowSynthConfigChanged {
            track_id: result.track_id,
            config: result.config,
        }]
    })
}

#[tauri::command]
fn update_flow_node_param_cmd(
    track_index: u16,
    node_id: u64,
    key: String,
    value: String,
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
        EngineCommand::UpdateFlowNodeParam {
            track_index: resolved_track_index,
            node_id,
            key,
            value,
        },
    )?;
    Ok(())
}

// ── User Preset Storage ────────────────────────────────────────────────

/// Returns the path to the user preset directory for Flow Synth.
/// Creates the directory if it does not exist.
fn flow_presets_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data directory: {e}"))?;
    let presets_dir = app_data.join("DreamPresets").join("Flow");
    std::fs::create_dir_all(&presets_dir)
        .map_err(|e| format!("Cannot create presets directory: {e}"))?;
    Ok(presets_dir)
}

#[tauri::command]
fn list_flow_user_presets(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = flow_presets_dir(&app)?;
    let mut names: Vec<String> = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Cannot read presets dir: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                names.push(stem.to_string());
            }
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
fn save_flow_user_preset(
    app: tauri::AppHandle,
    name: String,
    preset_json: String,
) -> Result<(), String> {
    if name.is_empty() || name.len() > 128 {
        return Err("Preset name must be 1-128 characters.".to_string());
    }
    // Sanitize filename: only allow alphanumeric, space, dash, underscore
    let safe_name: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
        .collect();
    if safe_name.is_empty() {
        return Err("Preset name contains no valid characters.".to_string());
    }
    // Validate JSON structure before writing
    let _: serde_json::Value =
        serde_json::from_str(&preset_json).map_err(|e| format!("Invalid preset JSON: {e}"))?;

    let dir = flow_presets_dir(&app)?;
    let path = dir.join(format!("{safe_name}.json"));
    std::fs::write(&path, preset_json.as_bytes())
        .map_err(|e| format!("Cannot save preset: {e}"))?;
    Ok(())
}

#[tauri::command]
fn load_flow_user_preset(
    app: tauri::AppHandle,
    name: String,
) -> Result<String, String> {
    // ENTERPRISE GUARD: Sanitize filename to prevent path traversal attacks
    let safe_name: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
        .collect();
    if safe_name.is_empty() {
        return Err("Preset name contains no valid characters.".to_string());
    }
    let dir = flow_presets_dir(&app)?;
    let path = dir.join(format!("{safe_name}.json"));
    if !path.exists() {
        return Err(format!("Preset '{safe_name}' not found."));
    }
    std::fs::read_to_string(&path).map_err(|e| format!("Cannot read preset: {e}"))
}

#[tauri::command]
fn delete_flow_user_preset(
    app: tauri::AppHandle,
    name: String,
) -> Result<(), String> {
    // ENTERPRISE GUARD: Sanitize filename to prevent path traversal attacks
    let safe_name: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
        .collect();
    if safe_name.is_empty() {
        return Err("Preset name contains no valid characters.".to_string());
    }
    let dir = flow_presets_dir(&app)?;
    let path = dir.join(format!("{safe_name}.json"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Cannot delete preset: {e}"))?;
    }
    Ok(())
}

