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
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

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
    let insert_index = insert_after_index
        .map(|idx| idx.saturating_add(1))
        .unwrap_or(project.tracks.len())
        .min(project.tracks.len());

    let mut track = Track::with_type(
        &track_name,
        resolved_type,
        insert_index,
    );
    // Keep deterministic colors by visual order after insert.
    track.color = TrackColor::for_index(insert_index);
    project.tracks.insert(insert_index, track);

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    log::info!(
        "[IPC] add_track_cmd: '{}' type={:?} after={:?} inserted_at={} (now {} tracks)",
        track_name,
        resolved_type,
        insert_after_index,
        insert_index,
        project.tracks.len()
    );
    Ok(())
}

/// Deletes a track by index. Pushes undo snapshot before mutation.
#[tauri::command]
async fn delete_track_cmd(
    index: usize,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    if index >= project.tracks.len() {
        return Err(format!("Track index {} out of range ({})", index, project.tracks.len()));
    }

    // Snapshot for undo BEFORE mutation
    drop(project);
    push_undo(&project_state)?;
    project = project_state.project.lock().map_err(|e| e.to_string())?;

    let removed_name = project.tracks[index].name.clone();
    project.tracks.remove(index);
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    log::info!("[IPC] delete_track_cmd: index={} name='{}' (now {} tracks)", index, removed_name, project.tracks.len());
    Ok(())
}

/// Renames a track by index.
#[tauri::command]
async fn rename_track_cmd(
    index: usize,
    name: String,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<(), String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    if index >= project.tracks.len() {
        return Err(format!("Track index {} out of range ({})", index, project.tracks.len()));
    }
    let old_name = project.tracks[index].name.clone();
    project.tracks[index].name = name.clone();
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    log::info!("[IPC] rename_track_cmd: index={} '{}' → '{}'", index, old_name, name);
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
    let mut current = project
        .tracks
        .iter()
        .find(|t| t.id == candidate_id)
        .and_then(|t| t.parent_track_id);
    while let Some(parent_id) = current {
        if parent_id == ancestor_id {
            return true;
        }
        current = project
            .tracks
            .iter()
            .find(|t| t.id == parent_id)
            .and_then(|t| t.parent_track_id);
    }
    false
}

#[tauri::command]
async fn create_group_cmd(
    track_ids: Vec<String>,
    group_name: Option<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
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

    rebuild_group_children(&mut project);

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
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
) -> Result<(), String> {
    let gid = Uuid::parse_str(&group_id).map_err(|_| format!("Invalid group_id: {group_id}"))?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let group_track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == gid && t.track_type == TrackType::Group)
        .ok_or_else(|| format!("Group track not found: {group_id}"))?;
    group_track.is_expanded = expanded;
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    log::info!("[IPC] set_group_expanded_cmd({group_id} -> {expanded})");
    Ok(())
}

#[tauri::command]
async fn move_track_to_index_cmd(
    track_id: String,
    target_index: usize,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
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
    rebuild_group_children(&mut project);

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
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

    let max_insert = project.tracks.len();
    let insert_index = target_index.min(max_insert);
    project.tracks.insert(insert_index, moving_track);
    rebuild_group_children(&mut project);

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
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

    rebuild_group_children(&mut project);
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    log::info!("[IPC] set_track_group_cmd({track_id} -> {:?})", target_group);
    Ok(())
}
