fn resolve_flow_track_index(project: &dream_models::project::Project, requested: u16) -> Result<u16, String> {
    let track_count = project.tracks.len();
    if (requested as usize) >= track_count {
        return Err(format!("Track index {} is out of bounds (total {}).", requested, track_count));
    }
    Ok(requested)
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
        resolve_flow_track_index(&project, track_index)?
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
        resolve_flow_track_index(&project, track_index)?
    };

    let mut mapped_nodes = Vec::with_capacity(nodes.len());
    for (id, ty_str, params) in nodes {
        let node_type = dream_ipc::FlowNodeType::from_str(&ty_str);
        let mut mapped_params = Vec::with_capacity(params.len());
        for (k_str, v_str) in params {
            let key = dream_ipc::FlowParamKey::from_str(&k_str);
            let value = dream_ipc::parse_flow_param_value(key, &v_str);
            mapped_params.push((key, value));
        }
        mapped_nodes.push((id, node_type, mapped_params));
    }

    // ENTERPRISE: Execute topological sorting on the non-real-time layer
    // to prevent HashMap allocation and O(N) operations inside the audio callback.
    let mut index_by_id = std::collections::HashMap::with_capacity(mapped_nodes.len());
    for (idx, (id, _, _)) in mapped_nodes.iter().enumerate() {
        index_by_id.insert(*id, idx);
    }
    let mut indegree: std::collections::HashMap<u64, usize> = std::collections::HashMap::with_capacity(mapped_nodes.len());
    let mut outgoing: std::collections::HashMap<u64, Vec<u64>> = std::collections::HashMap::with_capacity(mapped_nodes.len());
    for (id, _, _) in &mapped_nodes {
        indegree.insert(*id, 0);
        outgoing.insert(*id, Vec::new());
    }
    // BUG-003/009 FIX: Validate connections — check bounds and dedup input ports.
    // Step 1: Build a map of node_id → (input_port_count, output_port_count) from node types.
    let mut node_port_counts: std::collections::HashMap<u64, (usize, usize)> =
        std::collections::HashMap::with_capacity(mapped_nodes.len());
    for (id, node_type, _) in &mapped_nodes {
        let (in_count, out_count) = dream_ipc::flow_port_counts(*node_type);
        node_port_counts.insert(*id, (in_count, out_count));
    }

    // Step 2: Filter invalid connections, validate port indices, dedup input ports (last wins).
    let mut seen_inputs: std::collections::HashMap<(u64, usize), usize> =
        std::collections::HashMap::with_capacity(connections.len());
    let mut valid_connections: Vec<(u64, usize, u64, usize)> = Vec::with_capacity(connections.len());

    for (idx, (from_id, from_port, to_id, to_port)) in connections.iter().enumerate() {
        // Skip self-loops
        if from_id == to_id { continue; }
        // Skip if either node doesn't exist
        if !index_by_id.contains_key(from_id) || !index_by_id.contains_key(to_id) { continue; }
        // BUG-003: Validate port index bounds
        if let Some(&(_, out_count)) = node_port_counts.get(from_id) {
            if *from_port >= out_count { continue; }
        }
        if let Some(&(in_count, _)) = node_port_counts.get(to_id) {
            if *to_port >= in_count { continue; }
        }
        // BUG-009: Track last connection to each input port — last wins
        seen_inputs.insert((*to_id, *to_port), idx);
        valid_connections.push((*from_id, *from_port, *to_id, *to_port));
    }
    // Remove earlier duplicates — only keep the last connection to each input
    if seen_inputs.len() < valid_connections.len() {
        valid_connections.retain(|conn| {
            // Check if this is the latest connection to its input port
            seen_inputs.get(&(conn.2, conn.3)).copied()
                .map(|last_idx| connections.iter().position(|c| c == conn).map(|pos| pos == last_idx).unwrap_or(true))
                .unwrap_or(true)
        });
    }
    let connections = valid_connections;

    for (from_id, _, to_id, _) in &connections {
        if let Some(v) = outgoing.get_mut(from_id) { v.push(*to_id); }
        if let Some(d) = indegree.get_mut(to_id) { *d += 1; }
    }
    let mut ready: std::collections::VecDeque<u64> = indegree
        .iter()
        .filter_map(|(id, &d)| if d == 0 { Some(*id) } else { None })
        .collect();
    let mut ready_vec: Vec<u64> = ready.drain(..).collect();
    ready_vec.sort_by_key(|id| index_by_id.get(id).copied().unwrap_or(usize::MAX));
    ready = ready_vec.into();
    
    let mut ordered_ids = Vec::with_capacity(mapped_nodes.len());
    while let Some(id) = ready.pop_front() {
        ordered_ids.push(id);
        if let Some(neighbors) = outgoing.get(&id) {
            let mut new_ready = Vec::new();
            for &n in neighbors {
                if let Some(d) = indegree.get_mut(&n) {
                    *d = d.saturating_sub(1);
                    if *d == 0 { new_ready.push(n); }
                }
            }
            new_ready.sort_by_key(|nid| index_by_id.get(nid).copied().unwrap_or(usize::MAX));
            ready.extend(new_ready);
        }
    }
    if ordered_ids.len() < mapped_nodes.len() {
        for (id, _, _) in &mapped_nodes {
            if !ordered_ids.iter().any(|v| v == id) {
                ordered_ids.push(*id);
            }
        }
    }
    let mut by_id: std::collections::HashMap<u64, (dream_ipc::FlowNodeType, Vec<(dream_ipc::FlowParamKey, f32)>)> = std::collections::HashMap::with_capacity(mapped_nodes.len());
    for (id, node_type, params) in mapped_nodes {
        by_id.insert(id, (node_type, params));
    }
    let final_nodes: Vec<dream_ipc::FlowNodeDescriptor> = ordered_ids
        .into_iter()
        .filter_map(|id| by_id.remove(&id).map(|(node_type, params)| (id, node_type, params)))
        .collect();

    push_command(
        &handle,
        EngineCommand::SyncFlowGraph {
            track_index: resolved_track_index,
            nodes: std::sync::Arc::new(final_nodes),
            connections: std::sync::Arc::new(connections),
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
        resolve_flow_track_index(&project, track_index)?
    };

    let parsed_key = dream_ipc::FlowParamKey::from_str(&key);
    let parsed_value = dream_ipc::parse_flow_param_value(parsed_key, &value);

    push_command(
        &handle,
        EngineCommand::UpdateFlowNodeParam {
            track_index: resolved_track_index,
            node_id,
            key: parsed_key,
            value: parsed_value,
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
fn get_flow_presets_dir_cmd(app: tauri::AppHandle) -> Result<String, String> {
    let dir = flow_presets_dir(&app)?;
    Ok(dir.to_string_lossy().into_owned())
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

