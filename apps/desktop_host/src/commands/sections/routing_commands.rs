/// Return valid routing targets for a track.
#[tauri::command]
fn get_routing_targets(
    track_id: String,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<Vec<RoutingTarget>, String> {
    let source_id =
        Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?;

    let mut targets = Vec::new();
    for t in &project.tracks {
        if t.id == source_id {
            continue;
        }
        targets.push(RoutingTarget {
            track_id: t.id.to_string(),
            track_name: t.name.clone(),
            track_type: format!("{:?}", t.track_type),
        });
    }
    Ok(targets)
}

/// Set output routing destination for a track.
///
/// `target_id` can be another track UUID or "master" to route directly
/// to the master bus. The project model is updated atomically.
#[tauri::command]
fn set_track_routing_cmd(
    track_id: String,
    target_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let cmd = dream_orchestrator::commands::SetTrackRoutingCommand::from_str_ids(
        &track_id, &target_id,
    )
    .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    if !result.changed {
        return Ok(());
    }

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

#[tauri::command]
fn set_track_routing_with_deltas_cmd(
    track_id: String,
    target_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<RoutingDeltaResponse, String> {
    let track_uuid =
        Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let output_destination_id = if target_id == "master" {
        None
    } else {
        Some(Uuid::parse_str(&target_id).map_err(|_| format!("Invalid target_id: {target_id}"))?)
    };

    set_track_routing_cmd(track_id, target_id, project_state, clip_pool_state, app)?;

    Ok(RoutingDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackRoutingChanged {
            track_id: track_uuid,
            output_destination_id,
        }],
    })
}

/// Set input source for a track.
#[tauri::command]
fn set_track_input_cmd(
    track_id: String,
    input_id: String,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let cmd =
        dream_orchestrator::commands::SetTrackInputCommand::from_str_ids(&track_id, &input_id)
            .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    if !result.changed {
        return Ok(());
    }
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

/// Set sidechain source track for a plugin slot on a track.
#[tauri::command]
fn set_plugin_sidechain_source_cmd(
    track_id: String,
    slot_id: String,
    source_track_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let cmd = dream_orchestrator::commands::SetPluginSidechainSourceCommand::from_str_ids(
        &track_id,
        &slot_id,
        &source_track_id,
    )
    .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    let result = execute_orchestrator_command(&project_state, &cmd)?;

    if !result.changed {
        return Ok(());
    }

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let source_value = cmd.source_track_id.map(|id| id.to_string());
    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] set_plugin_sidechain_source_cmd(track={} slot={} source={})",
        track_id,
        slot_id,
        source_value.as_deref().unwrap_or("none")
    );
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
struct RoutingDeltaResponse {
    deltas: Vec<dream_models::delta::ProjectDelta>,
}

#[tauri::command]
fn set_plugin_sidechain_source_with_deltas_cmd(
    track_id: String,
    slot_id: String,
    source_track_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<RoutingDeltaResponse, String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let source_uuid = {
        let normalized = source_track_id.trim();
        if normalized.is_empty() || normalized.eq_ignore_ascii_case("none") {
            None
        } else {
            Some(Uuid::parse_str(normalized).map_err(|_| format!("Invalid source_track_id: {normalized}"))?)
        }
    };

    set_plugin_sidechain_source_cmd(
        track_id,
        slot_id,
        source_track_id,
        project_state,
        clip_pool_state,
        plugin_host_state,
        app,
    )?;

    Ok(RoutingDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::PluginSidechainChanged {
            track_id: track_uuid,
            slot_id: slot_uuid,
            source_track_id: source_uuid,
        }],
    })
}
