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
async fn move_track_to_index_with_deltas_cmd(
    track_id: String,
    target_index: usize,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<TrackManagementDeltaResponse, String> {
    let moving_id = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    let from_index = project
        .tracks
        .iter()
        .position(|t| t.id == moving_id)
        .ok_or_else(|| format!("Track not found: {track_id}"))?;
    if project.tracks.len() <= 1 {
        return Ok(TrackManagementDeltaResponse { deltas: vec![] });
    }

    let max_index = project.tracks.len().saturating_sub(1);
    let to_index = target_index.min(max_index);
    if from_index == to_index {
        return Ok(TrackManagementDeltaResponse { deltas: vec![] });
    }

    project.move_track(from_index, to_index);

    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!("[IPC] move_track_to_index_with_deltas_cmd({track_id}: {from_index} -> {to_index})");
    Ok(TrackManagementDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackMoved {
            track_id: moving_id,
            old_index: from_index,
            new_index: to_index,
        }],
    })
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
