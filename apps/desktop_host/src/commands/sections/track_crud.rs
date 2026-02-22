// ═══════════════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize)]
struct TrackManagementDeltaResponse {
    deltas: Vec<dream_models::delta::ProjectDelta>,
}

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

#[tauri::command]
async fn add_track_with_deltas_cmd(
    name: Option<String>,
    track_type: Option<String>,
    insert_after_index: Option<usize>,
    inherit_from_track_id: Option<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<TrackManagementDeltaResponse, String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    if project.tracks.len() >= 256 {
        return Err("Maximum track count (256) reached. Remove existing tracks to add more.".to_string());
    }
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
        TrackType::Audio => project.tracks.iter().filter(|t| t.track_type == TrackType::Audio).count() + 1,
        TrackType::Midi => project.tracks.iter().filter(|t| t.track_type == TrackType::Midi).count() + 1,
        TrackType::Group => project.tracks.iter().filter(|t| t.track_type == TrackType::Group).count() + 1,
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

    let mut track = Track::with_type(&track_name, resolved_type, insert_index);
    track.parent_track_id = inherited_parent_group;
    track.output_destination_id = inherited_parent_group;
    match inherited_group_color {
        Some((color_enum, color_hex)) => {
            track.color = color_enum;
            track.color_hex = color_hex;
        }
        None => {
            track.color = TrackColor::for_index(insert_index);
        }
    }
    let track_id = track.id;
    let track_type_string = match resolved_type {
        TrackType::Audio => "audio",
        TrackType::Midi => "midi",
        TrackType::Group => "group",
        TrackType::Master => "master",
    }
    .to_string();
    project.tracks.insert(insert_index, track);

    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(TrackManagementDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackAdded {
            track_index: insert_index,
            track_id,
            name: track_name,
            track_type: track_type_string,
        }],
    })
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

    // BUG-013 FIX: Re-validate after lock re-acquisition. Between drop(project)
    // and re-acquisition, another command could have modified the track list.
    if index >= project.tracks.len() {
        return Err(format!("Track index {} became invalid after undo snapshot", index));
    }

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
    clip_pool_state.evict_unused_clips(&project_state);
    log::info!("[IPC] delete_track_cmd: index={} name='{}' (now {} tracks)", index, removed_name, track_count);
    Ok(())
}

#[tauri::command]
async fn delete_track_with_deltas_cmd(
    index: usize,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<TrackManagementDeltaResponse, String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    if index >= project.tracks.len() {
        return Err(format!("Track index {} out of range ({})", index, project.tracks.len()));
    }

    drop(project);
    push_undo(&project_state)?;
    project = project_state.project.lock().map_err(|e| e.to_string())?;
    if index >= project.tracks.len() {
        return Err(format!("Track index {} became invalid after undo snapshot", index));
    }

    let removed_track = project.tracks.remove(index);
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

    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    clip_pool_state.evict_unused_clips(&project_state);

    Ok(TrackManagementDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackRemoved {
            track_id: removed_id,
            track_index: index,
        }],
    })
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
async fn rename_track_with_deltas_cmd(
    index: usize,
    name: String,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<TrackManagementDeltaResponse, String> {
    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    if index >= project.tracks.len() {
        return Err(format!("Track index {} out of range ({})", index, project.tracks.len()));
    }
    let sanitized: String = name.chars().filter(|c| !c.is_control()).take(256).collect();
    if sanitized.is_empty() {
        return Err("Track name cannot be empty".to_string());
    }
    let track = &mut project.tracks[index];
    let track_id = track.id;
    track.name = sanitized.clone();
    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(TrackManagementDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackRenamed {
            track_id,
            new_name: sanitized,
        }],
    })
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

