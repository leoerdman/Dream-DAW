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
    let cmd = dream_orchestrator::commands::MoveTrackToIndexCommand::from_str_track_id(
        &track_id,
        target_index,
    )
    .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    let result = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let result = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        if result.changed {
            *project_state.project.lock().map_err(|e| e.to_string())? =
                ctx.lock_project().map_err(|e| e.to_string())?.clone();
        }
        result
    };
    if !result.changed {
        return Ok(());
    }
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] move_track_to_index_cmd({track_id}: {} -> {})",
        result.old_index,
        result.new_index
    );
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
    let cmd = dream_orchestrator::commands::MoveTrackToIndexCommand::from_str_track_id(
        &track_id,
        target_index,
    )
    .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    let result = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let result = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        if result.changed {
            *project_state.project.lock().map_err(|e| e.to_string())? =
                ctx.lock_project().map_err(|e| e.to_string())?.clone();
        }
        result
    };
    if !result.changed {
        return Ok(TrackManagementDeltaResponse { deltas: vec![] });
    }
    let moving_id = cmd.track_id;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] move_track_to_index_with_deltas_cmd({track_id}: {} -> {})",
        result.old_index,
        result.new_index
    );
    Ok(TrackManagementDeltaResponse {
        deltas: vec![dream_models::delta::ProjectDelta::TrackMoved {
            track_id: moving_id,
            old_index: result.old_index,
            new_index: result.new_index,
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
    let cmd = dream_orchestrator::commands::MoveTrackWithParentCommand::from_str_ids(
        &track_id,
        target_index,
        target_parent_group_id.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    let result = {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        let result = ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
        result
    };

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] move_track_with_parent_cmd({track_id}: {} -> {}, parent={:?})",
        result.old_index,
        result.new_index,
        cmd.target_parent_group_id
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
    let cmd = dream_orchestrator::commands::SetTrackGroupCommand::from_str_ids(
        &track_id,
        group_id.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    push_undo(&project_state)?;
    {
        let ctx = dream_orchestrator::OrchestratorContext::new(
            project_state
                .project
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        );
        ctx.execute(&cmd).map_err(|e| e.to_string())?;
        *project_state.project.lock().map_err(|e| e.to_string())? =
            ctx.lock_project().map_err(|e| e.to_string())?.clone();
    }

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(&mut project, &clip_pool_state, &plugin_host_state, &handle)?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] set_track_group_cmd({track_id} -> {:?})",
        cmd.target_group_id
    );
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

#[tauri::command]
async fn duplicate_tracks_with_deltas_cmd(
    track_ids: Vec<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<TrackManagementDeltaResponse, String> {
    if track_ids.is_empty() {
        return Ok(TrackManagementDeltaResponse { deltas: vec![] });
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
        return Ok(TrackManagementDeltaResponse { deltas: vec![] });
    }

    let mut parent_id_map: std::collections::HashMap<Uuid, Option<Uuid>> =
        std::collections::HashMap::new();
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
        dup.parent_track_id = src_parent
            .and_then(|pid| old_to_new.get(&pid).copied())
            .or(src_parent);
        dup.output_destination_id = dup.parent_track_id;
    }

    let mut insert_at = selected_indices.iter().max().copied().unwrap_or(0) + 1;
    let mut deltas = Vec::with_capacity(duplicates.len());
    for dup in duplicates {
        if insert_at > project.tracks.len() {
            insert_at = project.tracks.len();
        }
        let inserted_index = insert_at;
        deltas.push(dream_models::delta::ProjectDelta::TrackAdded {
            track_index: inserted_index,
            track_id: dup.id,
            name: dup.name.clone(),
            track_type: format!("{:?}", dup.track_type),
        });
        project.tracks.insert(inserted_index, dup);
        insert_at += 1;
    }

    let project_name = project.name.clone();
    refresh_runtime_after_track_topology_change(
        &mut project,
        &clip_pool_state,
        &plugin_host_state,
        &handle,
    )?;
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::info!(
        "[IPC] duplicate_tracks_with_deltas_cmd(count={})",
        selected_indices.len()
    );
    Ok(TrackManagementDeltaResponse { deltas })
}
