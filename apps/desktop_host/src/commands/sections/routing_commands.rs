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
    let source_id =
        Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let destination = if target_id == "master" {
        None
    } else {
        Some(Uuid::parse_str(&target_id).map_err(|_| format!("Invalid target_id: {target_id}"))?)
    };

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    if let Some(dest_id) = destination {
        if !project.tracks.iter().any(|t| t.id == dest_id) {
            return Err(format!("Destination track not found: {dest_id}"));
        }
        if dest_id == source_id {
            return Err("Track cannot route to itself".to_string());
        }
    }

    if let Some(track) = project.tracks.iter_mut().find(|t| t.id == source_id) {
        track.output_destination_id = destination;
    } else {
        return Err(format!("Track not found: {track_id}"));
    }

    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

/// Set input source for a track.
#[tauri::command]
fn set_track_input_cmd(
    track_id: String,
    input_id: String,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let source_id =
        Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let input = if input_id == "none" {
        None
    } else {
        Some(input_id.clone())
    };

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    if let Some(track) = project.tracks.iter_mut().find(|t| t.id == source_id) {
        track.input_source_id = input;
    } else {
        return Err(format!("Track not found: {track_id}"));
    }
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
    let track_uuid =
        Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    let source_normalized = source_track_id.trim();
    let source_value = if source_normalized.is_empty() || source_normalized.eq_ignore_ascii_case("none")
    {
        None
    } else {
        Some(source_normalized.to_string())
    };

    if let Some(source_id) = &source_value {
        let source_exists = project.tracks.iter().any(|t| t.id.to_string() == *source_id);
        if !source_exists {
            return Err(format!("Source track not found: {source_id}"));
        }
        if source_id == &track_id {
            return Err("Sidechain source cannot be the same track".to_string());
        }
    }

    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {track_id}"))?;

    let mut updated = false;
    if let Some(inst) = track.instrument.as_mut()
        && let Some(slot) = inst.as_single_mut()
        && slot.id == slot_uuid
    {
        if slot.supports_sidechain_input == Some(false) && slot.plugin_id.starts_with("internal://")
        {
            return Err("Plugin does not expose sidechain input".to_string());
        }
        slot.sidechain_source_track_id = source_value.clone();
        updated = true;
    }
    if !updated {
        fn find_and_set_sidechain(
            nodes: &mut [DeviceNode],
            slot_uuid: Uuid,
            source_value: &Option<String>,
        ) -> Result<bool, String> {
            for node in nodes.iter_mut() {
                match node {
                    DeviceNode::Single(slot) if slot.id == slot_uuid => {
                        if slot.supports_sidechain_input == Some(false)
                            && slot.plugin_id.starts_with("internal://")
                        {
                            return Err("Plugin does not expose sidechain input".to_string());
                        }
                        slot.sidechain_source_track_id = source_value.clone();
                        return Ok(true);
                    }
                    DeviceNode::Rack(rack) => {
                        for chain in &mut rack.chains {
                            if find_and_set_sidechain(&mut chain.devices, slot_uuid, source_value)? {
                                return Ok(true);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(false)
        }
        match find_and_set_sidechain(&mut track.effects, slot_uuid, &source_value) {
            Ok(true) => updated = true,
            Err(e) => return Err(e),
            _ => {}
        }
    }

    if !updated {
        let mut all_ids: Vec<String> = Vec::new();
        if let Some(inst) = track.instrument.as_ref() {
            all_ids.push(format!("instrument:{}", inst.id()));
        }
        fn collect_effect_ids(nodes: &[DeviceNode], out: &mut Vec<String>) {
            for node in nodes {
                match node {
                    DeviceNode::Single(s) => out.push(format!("effect:{}", s.id)),
                    DeviceNode::Rack(r) => {
                        out.push(format!("rack:{}", r.id));
                        for chain in &r.chains {
                            collect_effect_ids(&chain.devices, out);
                        }
                    }
                }
            }
        }
        collect_effect_ids(&track.effects, &mut all_ids);
        log::warn!(
            "[IPC] set_plugin_sidechain_source_cmd: slot {} NOT FOUND on track {}. Available slots: {:?}",
            slot_id,
            track_id,
            all_ids
        );
        return Err(format!("Plugin slot not found on track {}: {}", track_id, slot_id));
    }

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
