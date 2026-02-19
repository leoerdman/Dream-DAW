// ═══════════════════════════════════════════════════════════════════════

/// Adds a new audio track to the project.
///
/// If `name` is `None`, auto-generates a name ("Audio N").
/// The track is auto-assigned a color from the 16-color palette.
#[tauri::command]
async fn add_track_cmd(
    name: Option<String>,
    track_type: Option<String>,
    insert_after_index: Option<usize>,
    inherit_from_track_id: Option<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    // BUG-46 FIX: Enforce MAX_TRACKS limit to prevent silent audio failures.
    // The render engine pre-allocates buffers for MAX_TRACKS (256).
    if project.tracks.len() >= 256 {
        return Err("Maximum track count (256) reached. Remove existing tracks to add more.".to_string());
    }

    // Snapshot for undo BEFORE mutation
    drop(project);
    push_undo(&project_state)?;
    project = project_state.project.lock().map_err(|e| e.to_string())?;

    let normalized_type = track_type.unwrap_or_else(|| "audio".to_string()).to_ascii_lowercase();
    let resolved_type = match normalized_type.as_str() {
        "audio" => TrackType::Audio,
        "midi" => TrackType::Midi,
        "group" => TrackType::Group,
        other => return Err(format!("Unsupported track type: {other}")),
    };

    let track_num = match resolved_type {
        TrackType::Audio => {
            project.tracks.iter().filter(|t| t.track_type == TrackType::Audio).count() + 1
        }
        TrackType::Midi => {
            project.tracks.iter().filter(|t| t.track_type == TrackType::Midi).count() + 1
        }
        TrackType::Group => {
            project.tracks.iter().filter(|t| t.track_type == TrackType::Group).count() + 1
        }
        TrackType::Master => project.tracks.len() + 1,
    };
    let default_prefix = match resolved_type {
        TrackType::Audio => "Audio",
        TrackType::Midi => "MIDI",
        TrackType::Group => "Group",
        TrackType::Master => "Track",
    };
    let track_name = name.unwrap_or_else(|| format!("{default_prefix} {track_num}"));

    let inherited_track_id = inherit_from_track_id
        .as_deref()
        .filter(|raw| !raw.trim().is_empty() && *raw != "master")
        .map(|raw| Uuid::parse_str(raw).map_err(|_| format!("Invalid inherit_from_track_id: {raw}")))
        .transpose()?;

    let inherited_parent_group = inherited_track_id
        .and_then(|inherited_id| {
            project.tracks.iter().find(|t| t.id == inherited_id).map(|t| {
                if t.track_type == TrackType::Group {
                    Some(t.id)
                } else {
                    t.parent_track_id
                }
            })
        })
        .flatten();

    let inherited_group_color = inherited_parent_group
        .and_then(|gid| project.tracks.iter().find(|t| t.id == gid).map(|t| (t.color, t.color_hex.clone())));

    let insert_index = insert_after_index
        .map(|idx| idx.saturating_add(1))
        .unwrap_or(project.tracks.len())
        .min(project.tracks.len());

    let mut track = Track::with_type(
        &track_name,
        resolved_type,
        insert_index,
    );
    track.parent_track_id = inherited_parent_group;
    track.output_destination_id = inherited_parent_group;
    // Keep deterministic colors by visual order after insert unless inheriting group color.
    match inherited_group_color {
        Some((color_enum, color_hex)) => {
            track.color = color_enum;
            track.color_hex = color_hex;
        }
        None => {
            track.color = TrackColor::for_index(insert_index);
        }
    }
    project.tracks.insert(insert_index, track);

    let project_name = project.name.clone();
    let track_count = project.tracks.len();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] add_track_cmd: '{}' type={:?} after={:?} inserted_at={} (now {} tracks)",
        track_name,
        resolved_type,
        insert_after_index,
        insert_index,
        track_count
    );
    Ok(())
}

/// Deletes a track by index. Pushes undo snapshot before mutation.
#[tauri::command]
async fn delete_track_cmd(
    index: usize,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    if index >= project.tracks.len() {
        return Err(format!("Track index {} out of range ({})", index, project.tracks.len()));
    }

    // Snapshot for undo BEFORE mutation
    drop(project);
    push_undo(&project_state)?;
    project = project_state.project.lock().map_err(|e| e.to_string())?;

    let removed_track = project.tracks.remove(index);
    let removed_id = removed_track.id;
    let removed_name = removed_track.name;

    for track in &mut project.tracks {
        if track.parent_track_id == Some(removed_id) {
            track.parent_track_id = None;
        }
        if track.output_destination_id == Some(removed_id) {
            track.output_destination_id = track.parent_track_id;
        }
        track.child_track_ids.retain(|child_id| *child_id != removed_id);
    }

    let project_name = project.name.clone();
    let track_count = project.tracks.len();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!("[IPC] delete_track_cmd: index={} name='{}' (now {} tracks)", index, removed_name, track_count);
    Ok(())
}

#[tauri::command]
async fn delete_tracks_cmd(
    track_ids: Vec<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if track_ids.is_empty() {
        return Ok(());
    }

    let parsed_ids: Vec<Uuid> = track_ids
        .iter()
        .map(|id| Uuid::parse_str(id).map_err(|_| format!("Invalid track id: {id}")))
        .collect::<Result<_, _>>()?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    let mut selected_indices: Vec<usize> = project
        .tracks
        .iter()
        .enumerate()
        .filter_map(|(idx, t)| {
            if parsed_ids.contains(&t.id) && t.track_type != TrackType::Master {
                Some(idx)
            } else {
                None
            }
        })
        .collect();

    if selected_indices.is_empty() {
        return Ok(());
    }

    selected_indices.sort_unstable_by(|a, b| b.cmp(a));

    for idx in selected_indices {
        if idx >= project.tracks.len() {
            continue;
        }
        let removed_track = project.tracks.remove(idx);
        let removed_id = removed_track.id;

        for track in &mut project.tracks {
            if track.parent_track_id == Some(removed_id) {
                track.parent_track_id = None;
            }
            if track.output_destination_id == Some(removed_id) {
                track.output_destination_id = track.parent_track_id;
            }
            track.child_track_ids.retain(|child_id| *child_id != removed_id);
        }
    }

    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!("[IPC] delete_tracks_cmd(count={})", track_ids.len());
    Ok(())
}

/// Renames a track by index.
#[tauri::command]
async fn rename_track_cmd(
    index: usize,
    name: String,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    if index >= project.tracks.len() {
        return Err(format!("Track index {} out of range ({})", index, project.tracks.len()));
    }
    let old_name = project.tracks[index].name.clone();
    // BUG-48 FIX: Sanitize track name — strip control chars, truncate at 256.
    let sanitized: String = name.chars()
        .filter(|c| !c.is_control())
        .take(256)
        .collect();
    if sanitized.is_empty() {
        return Err("Track name cannot be empty".to_string());
    }
    project.tracks[index].name = sanitized.clone();
    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!("[IPC] rename_track_cmd: index={} '{}' → '{}'", index, old_name, name);
    Ok(())
}

#[tauri::command]
async fn set_track_height_cmd(
    track_id: String,
    height: f64,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let parsed_id = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track id: {e}"))?;
    let clamped_height = height.clamp(24.0, 120.0);

    // Check if mutation is a no-op BEFORE taking undo snapshot
    {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let track = project
            .tracks
            .iter()
            .find(|t| t.id == parsed_id)
            .ok_or_else(|| format!("Track not found: {track_id}"))?;
        if (track.height - clamped_height).abs() < f64::EPSILON {
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
    track.height = clamped_height;
    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

#[tauri::command]
async fn set_track_color_cmd(
    track_id: String,
    color_hex: String,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let parsed_id = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track id: {e}"))?;
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
    track.color_hex = Some(normalized.to_ascii_uppercase());
    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
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

fn track_is_descendant_of(project: &Project, candidate_id: Uuid, ancestor_id: Uuid) -> bool {
    // Guard against circular parent references: the longest valid parent chain
    // can never exceed the total number of tracks in the project.
    let max_depth = project.tracks.len();
    let mut depth = 0usize;
    let mut current = project
        .tracks
        .iter()
        .find(|t| t.id == candidate_id)
        .and_then(|t| t.parent_track_id);
    while let Some(parent_id) = current {
        if parent_id == ancestor_id {
            return true;
        }
        depth += 1;
        if depth > max_depth {
            log::warn!(
                "[track_is_descendant_of] Cycle detected! candidate={candidate_id}, ancestor={ancestor_id}, depth={depth}"
            );
            return false;
        }
        current = project
            .tracks
            .iter()
            .find(|t| t.id == parent_id)
            .and_then(|t| t.parent_track_id);
    }
    false
}

fn collect_block_track_ids(project: &Project, root_id: Uuid) -> Vec<Uuid> {
    use std::collections::HashMap;
    let parent_map: HashMap<Uuid, Option<Uuid>> = project
        .tracks
        .iter()
        .map(|t| (t.id, t.parent_track_id))
        .collect();

    let mut descendants = Vec::new();
    let max_depth = project.tracks.len();

    for track in &project.tracks {
        if track.id == root_id {
            descendants.push(track.id);
            continue;
        }

        let mut depth = 0;
        let mut current = track.parent_track_id;
        while let Some(parent_id) = current {
            if parent_id == root_id {
                descendants.push(track.id);
                break;
            }
            depth += 1;
            if depth > max_depth {
                break;
            }
            current = parent_map.get(&parent_id).and_then(|&p| p);
        }
    }
    descendants
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
    let moving_id = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    let from_index = project
        .tracks
        .iter()
        .position(|t| t.id == moving_id)
        .ok_or_else(|| format!("Track not found: {track_id}"))?;
    if project.tracks.len() <= 1 {
        return Ok(());
    }

    let max_index = project.tracks.len().saturating_sub(1);
    let to_index = target_index.min(max_index);
    if from_index == to_index {
        return Ok(());
    }

    project.move_track(from_index, to_index);

    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!("[IPC] move_track_to_index_cmd({track_id}: {from_index} -> {to_index})");
    Ok(())
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
    let moving_id = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let target_parent = match target_parent_group_id {
        Some(raw) if raw == "none" || raw == "master" || raw.trim().is_empty() => None,
        Some(raw) => Some(Uuid::parse_str(&raw).map_err(|_| format!("Invalid target_parent_group_id: {raw}"))?),
        None => None,
    };

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let from_index = project
        .tracks
        .iter()
        .position(|t| t.id == moving_id)
        .ok_or_else(|| format!("Track not found: {track_id}"))?;

    if let Some(parent_id) = target_parent {
        let parent_track = project
            .tracks
            .iter()
            .find(|t| t.id == parent_id)
            .ok_or_else(|| format!("Target group not found: {parent_id}"))?;
        if parent_track.track_type != TrackType::Group {
            return Err("Target parent must be a group track".to_string());
        }
        if moving_id == parent_id {
            return Err("Track cannot be grouped into itself".to_string());
        }
        if track_is_descendant_of(&project, parent_id, moving_id) {
            return Err("Cannot move track into its own descendant".to_string());
        }
    }

    let mut moving_track = project.tracks.remove(from_index);
    moving_track.parent_track_id = target_parent;
    moving_track.output_destination_id = target_parent;

    if let Some(parent_id) = target_parent
        && let Some(parent_track) = project.tracks.iter_mut().find(|t| t.id == parent_id)
    {
        // Group output follows its own parent (None => Master).
        parent_track.output_destination_id = parent_track.parent_track_id;
    }

    let max_insert = project.tracks.len();
    let mut insert_index = target_index.min(max_insert);
    if from_index < insert_index {
        insert_index = insert_index.saturating_sub(1);
    }
    project.tracks.insert(insert_index, moving_track);

    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] move_track_with_parent_cmd({track_id}: {from_index} -> {insert_index}, parent={:?})",
        target_parent
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
    let moving_id = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let target_group = match group_id {
        Some(raw) if raw == "none" || raw == "master" || raw.trim().is_empty() => None,
        Some(raw) => Some(Uuid::parse_str(&raw).map_err(|_| format!("Invalid group_id: {raw}"))?),
        None => None,
    };

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    if let Some(group_uuid) = target_group {
        let group_track = project
            .tracks
            .iter()
            .find(|t| t.id == group_uuid)
            .ok_or_else(|| format!("Group not found: {group_uuid}"))?;
        if group_track.track_type != TrackType::Group {
            return Err("Target track is not a group".to_string());
        }
        if group_uuid == moving_id {
            return Err("Track cannot be grouped into itself".to_string());
        }
        if track_is_descendant_of(&project, group_uuid, moving_id) {
            return Err("Cannot group into descendant track".to_string());
        }
    }

    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == moving_id)
        .ok_or_else(|| format!("Track not found: {track_id}"))?;
    track.parent_track_id = target_group;
    track.output_destination_id = target_group;

    if let Some(group_uuid) = target_group
        && let Some(group_track) = project.tracks.iter_mut().find(|t| t.id == group_uuid)
    {
        // Group output follows its own parent (None => Master).
        group_track.output_destination_id = group_track.parent_track_id;
    }

    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!("[IPC] set_track_group_cmd({track_id} -> {:?})", target_group);
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
    let gid = Uuid::parse_str(&group_id).map_err(|_| format!("Invalid group_id: {group_id}"))?;
    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    let group_index = project
        .tracks
        .iter()
        .position(|t| t.id == gid)
        .ok_or_else(|| format!("Group track not found: {group_id}"))?;

    let parent_of_group = project.tracks[group_index].parent_track_id;
    if project.tracks[group_index].track_type != TrackType::Group {
        return Err("Selected track is not a group".to_string());
    }

    for t in &mut project.tracks {
        if t.parent_track_id == Some(gid) {
            t.parent_track_id = parent_of_group;
            t.output_destination_id = parent_of_group;
        }
    }

    project.tracks.remove(group_index);
    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!("[IPC] ungroup_track_cmd({group_id})");
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
    let root_id = Uuid::parse_str(&root_track_id).map_err(|_| format!("Invalid root_track_id: {root_track_id}"))?;
    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    let block_ids = collect_block_track_ids(&project, root_id);
    if block_ids.is_empty() {
        return Err(format!("Track not found: {root_track_id}"));
    }

    let mut block_indices: Vec<usize> = project
        .tracks
        .iter()
        .enumerate()
        .filter_map(|(idx, t)| if block_ids.contains(&t.id) { Some(idx) } else { None })
        .collect();
    block_indices.sort_unstable();

    let first_index = block_indices[0];
    let block_len = block_indices.len();

    let mut block_tracks: Vec<Track> = Vec::with_capacity(block_len);
    for idx in block_indices.iter().rev() {
        block_tracks.push(project.tracks.remove(*idx));
    }
    block_tracks.reverse();

    let removed_before_target = block_indices.iter().filter(|idx| **idx < target_index).count();
    let mut adjusted_target = target_index.saturating_sub(removed_before_target);
    if adjusted_target > project.tracks.len() {
        adjusted_target = project.tracks.len();
    }

    for (offset, t) in block_tracks.into_iter().enumerate() {
        project.tracks.insert(adjusted_target + offset, t);
    }

    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] move_track_block_to_index_cmd({root_track_id}: {} -> {}, len={})",
        first_index,
        adjusted_target,
        block_len
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
    if track_ids.is_empty() {
        return Ok(());
    }
    let parsed_ids: Vec<Uuid> = track_ids
        .iter()
        .map(|id| Uuid::parse_str(id).map_err(|_| format!("Invalid track id: {id}")))
        .collect::<Result<_, _>>()?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    let selected_indices: Vec<usize> = project
        .tracks
        .iter()
        .enumerate()
        .filter_map(|(idx, t)| if parsed_ids.contains(&t.id) { Some(idx) } else { None })
        .collect();
    if selected_indices.is_empty() {
        return Ok(());
    }

    let mut parent_id_map: std::collections::HashMap<Uuid, Option<Uuid>> = std::collections::HashMap::new();
    let mut originals: Vec<Track> = Vec::with_capacity(selected_indices.len());
    for idx in &selected_indices {
        originals.push(project.tracks[*idx].clone());
    }
    let mut duplicates: Vec<Track> = Vec::with_capacity(originals.len());
    for src in &originals {
        let dup = duplicate_track_with_new_ids(src);
        parent_id_map.insert(src.id, src.parent_track_id);
        duplicates.push(dup);
    }

    let old_to_new: std::collections::HashMap<Uuid, Uuid> = originals
        .iter()
        .zip(duplicates.iter())
        .map(|(old_t, new_t)| (old_t.id, new_t.id))
        .collect();

    for dup in &mut duplicates {
        let src_parent = parent_id_map
            .iter()
            .find_map(|(old_id, parent)| {
                if old_to_new.get(old_id) == Some(&dup.id) {
                    Some(*parent)
                } else {
                    None
                }
            })
            .flatten();
        dup.parent_track_id = src_parent.and_then(|pid| old_to_new.get(&pid).copied()).or(src_parent);
        dup.output_destination_id = dup.parent_track_id;
    }

    let mut insert_at = selected_indices.iter().max().copied().unwrap_or(0) + 1;
    for dup in duplicates {
        if insert_at > project.tracks.len() {
            insert_at = project.tracks.len();
        }
        project.tracks.insert(insert_at, dup);
        insert_at += 1;
    }

    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] duplicate_tracks_cmd(count={})",
        selected_indices.len()
    );
    Ok(())
}
