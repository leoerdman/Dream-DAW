fn normalize_track_color_hex(color_hex: &str) -> Result<String, String> {
    let mut normalized = color_hex.trim().to_string();
    if normalized.is_empty() {
        return Err("Color cannot be empty".to_string());
    }
    if !normalized.starts_with('#') {
        normalized = format!("#{normalized}");
    }
    if normalized.len() != 7 {
        return Err(format!("Invalid color format: {color_hex}"));
    }
    Ok(normalized.to_ascii_uppercase())
}

#[tauri::command]
async fn set_track_color_cmd(
    track_id: String,
    color_hex: String,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let parsed_id = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track id: {e}"))?;
    let normalized = normalize_track_color_hex(&color_hex)?;

    // Check if mutation is a no-op BEFORE taking undo snapshot
    {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let track = project
            .tracks
            .iter()
            .find(|t| t.id == parsed_id)
            .ok_or_else(|| format!("Track not found: {track_id}"))?;
        if track.color_hex.as_deref() == Some(normalized.as_str()) {
            return Ok(());
        }
    }

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == parsed_id)
        .ok_or_else(|| format!("Track not found: {track_id}"))?;
    track.color_hex = Some(normalized);
    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

#[tauri::command]
async fn set_track_color_with_deltas_cmd(
    track_id: String,
    color_hex: String,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let parsed_id = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track id: {e}"))?;
    let normalized = normalize_track_color_hex(&color_hex)?;

    // Keep no-op responses empty so frontend never needs fallback refresh.
    {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let track = project
            .tracks
            .iter()
            .find(|t| t.id == parsed_id)
            .ok_or_else(|| format!("Track not found: {track_id}"))?;
        if track.color_hex.as_deref() == Some(normalized.as_str()) {
            return Ok(DeltaMutationResponse { deltas: Vec::new() });
        }
    }

    set_track_color_cmd(track_id, normalized.clone(), project_state.clone(), app).await?;

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackColorChanged {
            track_id: parsed_id,
            color: normalized,
        }],
    })
}

fn rebuild_group_children(project: &mut Project) {
    for track in &mut project.tracks {
        track.child_track_ids.clear();
    }
    let parent_pairs: Vec<(Uuid, Uuid)> = project
        .tracks
        .iter()
        .filter_map(|t| t.parent_track_id.map(|parent| (t.id, parent)))
        .collect();
    for (child_id, parent_id) in parent_pairs {
        if let Some(parent_track) = project.tracks.iter_mut().find(|t| t.id == parent_id) {
            parent_track.child_track_ids.push(child_id);
        }
    }
}

fn refresh_runtime_after_track_topology_change(
    project: &mut Project,
    clip_pool_state: &ClipPoolState,
    plugin_host_state: &PluginHostState,
    handle: &AudioEngineHandle,
) -> Result<(), String> {
    rebuild_group_children(project);
    clip_pool_state.rebuild_snapshot(project);
    // Rebuild external FX snapshot so plugin-to-track index mappings stay correct
    // after topology changes (add, delete, move, group, ungroup, duplicate).
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(project, slot_instance_map.as_ref());
    rebuild_midi_snapshot_from_project(project, handle);
    rebuild_sampler_snapshot_from_project(project, clip_pool_state, handle);
    rebuild_runtime_device_chains_from_project(project, handle)?;
    // After topology changes track indices shift — resync volume/pan/mute/solo
    // to the engine so existing tracks don't silently lose audio.
    sync_track_mix_state_from_project(project, handle)
}

fn duplicate_track_with_new_ids(source: &Track) -> Track {
    let mut cloned = source.clone();
    cloned.id = Uuid::new_v4();
    cloned.child_track_ids.clear();
    // Regenerate plugin slot IDs so duplicated track gets independent
    // plugin instances instead of sharing the original's runtime state.
    if let Some(ref mut instrument) = cloned.instrument {
        regenerate_device_node_ids(instrument);
    }
    for fx in &mut cloned.effects {
        regenerate_device_node_ids(fx);
    }
    for clip in &mut cloned.clips {
        clip.id = Uuid::new_v4();
    }
    for midi_clip in &mut cloned.midi_clips {
        midi_clip.id = Uuid::new_v4();
    }
    cloned
}

/// Recursively regenerate all UUIDs within a DeviceNode tree,
/// ensuring duplicated tracks get independent plugin instances.
fn regenerate_device_node_ids(node: &mut DeviceNode) {
    match node {
        DeviceNode::Single(slot) => {
            slot.id = Uuid::new_v4();
        }
        DeviceNode::Rack(rack) => {
            rack.id = Uuid::new_v4();
            for chain in &mut rack.chains {
                chain.id = Uuid::new_v4();
                for device in &mut chain.devices {
                    regenerate_device_node_ids(device);
                }
            }
        }
    }
}

#[tauri::command]
async fn create_group_cmd(
    track_ids: Vec<String>,
    group_name: Option<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    if track_ids.is_empty() {
        return Err("No tracks selected for grouping".to_string());
    }

    let parsed_ids: Vec<Uuid> = track_ids
        .iter()
        .map(|id| Uuid::parse_str(id).map_err(|_| format!("Invalid track id: {id}")))
        .collect::<Result<_, _>>()?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    let mut selected: Vec<(usize, Uuid)> = project
        .tracks
        .iter()
        .enumerate()
        .filter_map(|(idx, t)| {
            if parsed_ids.contains(&t.id) && t.track_type != TrackType::Master {
                Some((idx, t.id))
            } else {
                None
            }
        })
        .collect();

    if selected.is_empty() {
        return Err("No valid tracks found for grouping".to_string());
    }

    selected.sort_by_key(|(idx, _)| *idx);
    let first_index = selected[0].0;

    let (group_color, group_color_hex) = selected
        .first()
        .and_then(|(_, id)| project.tracks.iter().find(|t| t.id == *id).map(|t| (t.color, t.color_hex.clone())))
        .unwrap_or_else(|| (TrackColor::for_index(first_index), None));

    let group_num = project
        .tracks
        .iter()
        .filter(|t| t.track_type == TrackType::Group)
        .count()
        + 1;
    let mut group_track = Track::with_type(
        group_name.unwrap_or_else(|| format!("Group {}", group_num)),
        TrackType::Group,
        first_index,
    );
    group_track.parent_track_id = None;
    group_track.output_destination_id = None;
    group_track.is_expanded = true;
    group_track.child_track_ids.clear();
    group_track.color = group_color;
    group_track.color_hex = group_color_hex;
    let group_id = group_track.id;

    project.tracks.insert(first_index, group_track);

    let selected_ids_in_order: Vec<Uuid> = selected.into_iter().map(|(_, id)| id).collect();
    let mut child_tracks: Vec<Track> = Vec::with_capacity(selected_ids_in_order.len());
    for child_id in &selected_ids_in_order {
        if let Some(current_index) = project.tracks.iter().position(|t| t.id == *child_id) {
            let mut child = project.tracks.remove(current_index);
            child.parent_track_id = Some(group_id);
            child.output_destination_id = Some(group_id);
            child_tracks.push(child);
        }
    }

    for (offset, child) in child_tracks.into_iter().enumerate() {
        project.tracks.insert(first_index + 1 + offset, child);
    }

    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] create_group_cmd: created group {} with {} children",
        group_id,
        selected_ids_in_order.len()
    );
    Ok(group_id.to_string())
}

#[derive(Debug, Serialize, Deserialize)]
struct CreateGroupWithDeltasResponse {
    group_id: String,
    deltas: Vec<dream_models::delta::ProjectDelta>,
}

#[tauri::command]
async fn create_group_with_deltas_cmd(
    track_ids: Vec<String>,
    group_name: Option<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<CreateGroupWithDeltasResponse, String> {
    let (before_order, before_parent): (Vec<Uuid>, std::collections::HashMap<Uuid, Option<Uuid>>) = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        (
            project.tracks.iter().map(|t| t.id).collect(),
            project
                .tracks
                .iter()
                .map(|t| (t.id, t.parent_track_id))
                .collect(),
        )
    };

    let group_id = create_group_cmd(
        track_ids,
        group_name,
        project_state.clone(),
        clip_pool_state,
        plugin_host_state,
        handle,
        app,
    )
    .await?;
    let group_uuid = Uuid::parse_str(&group_id).map_err(|_| format!("Invalid group id after create: {group_id}"))?;

    let (after_order, after_parent, group_name_out): (
        Vec<Uuid>,
        std::collections::HashMap<Uuid, Option<Uuid>>,
        String,
    ) = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let group_track = project
            .tracks
            .iter()
            .find(|t| t.id == group_uuid)
            .ok_or_else(|| format!("Group track not found after create: {group_uuid}"))?;
        (
            project.tracks.iter().map(|t| t.id).collect(),
            project
                .tracks
                .iter()
                .map(|t| (t.id, t.parent_track_id))
                .collect(),
            group_track.name.clone(),
        )
    };

    let mut deltas = Vec::new();

    if let Some(group_index) = after_order.iter().position(|id| *id == group_uuid) {
        deltas.push(dream_models::delta::ProjectDelta::TrackAdded {
            track_index: group_index,
            track_id: group_uuid,
            name: group_name_out,
            track_type: "group".to_string(),
        });
    }

    let before_index_map: std::collections::HashMap<Uuid, usize> = before_order
        .iter()
        .enumerate()
        .map(|(idx, id)| (*id, idx))
        .collect();
    let after_index_map: std::collections::HashMap<Uuid, usize> = after_order
        .iter()
        .enumerate()
        .map(|(idx, id)| (*id, idx))
        .collect();

    for (track_id, old_parent) in &before_parent {
        if let Some(new_parent) = after_parent.get(track_id)
            && new_parent != old_parent
        {
            deltas.push(dream_models::delta::ProjectDelta::TrackParentChanged {
                track_id: *track_id,
                parent_track_id: *new_parent,
            });
        }
    }

    for (track_id, old_index) in &before_index_map {
        if let Some(new_index) = after_index_map.get(track_id)
            && new_index != old_index
        {
            deltas.push(dream_models::delta::ProjectDelta::TrackMoved {
                track_id: *track_id,
                old_index: *old_index,
                new_index: *new_index,
            });
        }
    }

    Ok(CreateGroupWithDeltasResponse { group_id, deltas })
}

#[tauri::command]
async fn set_group_expanded_cmd(
    group_id: String,
    expanded: bool,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let gid = Uuid::parse_str(&group_id).map_err(|_| format!("Invalid group_id: {group_id}"))?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let group_track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == gid && t.track_type == TrackType::Group)
        .ok_or_else(|| format!("Group track not found: {group_id}"))?;
    group_track.is_expanded = expanded;
    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!("[IPC] set_group_expanded_cmd({group_id} -> {expanded})");
    Ok(())
}
