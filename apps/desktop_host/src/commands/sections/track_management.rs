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

