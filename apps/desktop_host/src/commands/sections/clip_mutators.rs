// ═══════════════════════════════════════════════════════════════════════

/// Response type for the split_clip command.
#[derive(Debug, Serialize, Deserialize)]
struct SplitClipResponse {
    left_id: String,
    right_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct DuplicateClipResponse {
    new_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct MergeClipsResponse {
    new_id: String,
}

fn mutator_err_to_string(e: MutatorError) -> String {
    e.to_string()
}

fn move_midi_clip_in_project(
    project: &mut Project,
    clip_id: Uuid,
    new_track_index: usize,
    new_position: AbsoluteTime,
) -> bool {
    let mut extracted = None;
    for track in &mut project.tracks {
        if let Some(idx) = track.midi_clips.iter().position(|c| c.id == clip_id) {
            let mut clip = track.midi_clips.remove(idx);
            clip.position = new_position;
            extracted = Some(clip);
            break;
        }
    }

    let Some(clip) = extracted else {
        return false;
    };
    let target = &mut project.tracks[new_track_index];
    
    // Handle overlaps for MIDI clips
    dream_models::mutators::handle_midi_overlaps(target, &clip);

    let insert_pos = target
        .midi_clips
        .binary_search_by(|c| c.position.cmp(&clip.position))
        .unwrap_or_else(|i| i);
    target.midi_clips.insert(insert_pos, clip);
    true
}

fn delete_midi_clip_in_project(project: &mut Project, clip_id: Uuid) -> bool {
    for track in &mut project.tracks {
        if let Some(idx) = track.midi_clips.iter().position(|c| c.id == clip_id) {
            track.midi_clips.remove(idx);
            return true;
        }
    }
    false
}

/// Moves a clip to a new track and/or position.
///
/// The clip is identified by UUID string. After mutation, the
/// clip snapshot is atomically rebuilt for the audio thread.
#[tauri::command]
async fn move_clip_cmd(
    clip_id: String,
    new_track_index: usize,
    new_position_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id)
        .map_err(|e| format!("Invalid clip ID: {e}"))?;

    // Snapshot for undo BEFORE mutation
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    if new_track_index >= project.tracks.len() {
        return Err(format!(
            "Track out of range: requested {} but project has {} tracks",
            new_track_index,
            project.tracks.len()
        ));
    }

    let new_position = AbsoluteTime::new(new_position_frames);
    if let Err(audio_err) = mutators::move_clip(&mut project, uuid, new_track_index, new_position) {
        // If this is not an audio clip, attempt MIDI clip move using same UUID.
        if !move_midi_clip_in_project(&mut project, uuid, new_track_index, new_position) {
            return Err(mutator_err_to_string(audio_err));
        }
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);

    Ok(())
}

fn resize_midi_clip_in_project(
    project: &mut Project,
    clip_id: Uuid,
    new_position: AbsoluteTime,
    new_duration: AbsoluteTime,
) -> bool {
    let mut extracted = None;
    let mut source_track_idx = None;

    for (track_idx, track) in project.tracks.iter_mut().enumerate() {
        if let Some(idx) = track.midi_clips.iter().position(|c| c.id == clip_id) {
            let mut clip = track.midi_clips.remove(idx);
            clip.position = new_position;
            clip.duration = new_duration;
            extracted = Some(clip);
            source_track_idx = Some(track_idx);
            break;
        }
    }

    let Some(clip) = extracted else {
        return false;
    };
    
    // Safety check: re-insert into the same track if found
    if let Some(ti) = source_track_idx {
        let target = &mut project.tracks[ti];
        
        // Handle overlaps for MIDI clips
        dream_models::mutators::handle_midi_overlaps(target, &clip);

        let insert_pos = target
            .midi_clips
            .binary_search_by(|c| c.position.cmp(&clip.position))
            .unwrap_or_else(|i| i);
        target.midi_clips.insert(insert_pos, clip);
        true
    } else {
        false
    }
}

/// Resizes a clip to a new position and duration.
#[tauri::command]
async fn resize_clip_cmd(
    clip_id: String,
    new_position_frames: i64,
    new_duration_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id)
        .map_err(|e| format!("Invalid clip ID: {e}"))?;

    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    let new_position = AbsoluteTime::new(new_position_frames);
    let new_duration = AbsoluteTime::new(new_duration_frames);

    if let Err(audio_err) = mutators::resize_clip(&mut project, uuid, new_position, new_duration) {
        // If this is not an audio clip, attempt MIDI clip resize using same UUID.
        if !resize_midi_clip_in_project(&mut project, uuid, new_position, new_duration) {
            return Err(mutator_err_to_string(audio_err));
        }
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);

    Ok(())
}

/// Splits a clip at the given sample frame position.
///
/// Returns the UUIDs of the two resulting clips (left keeps original UUID).
/// Both halves preserve correct source_offset for seamless playback.
#[tauri::command]
async fn split_clip_cmd(
    clip_id: String,
    split_frame: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<SplitClipResponse, String> {
    let uuid = Uuid::parse_str(&clip_id)
        .map_err(|e| format!("Invalid clip ID: {e}"))?;

    // Snapshot for undo BEFORE mutation
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    let result = mutators::split_clip(&mut project, uuid, split_frame)
        .map_err(mutator_err_to_string)?;

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);

    Ok(SplitClipResponse {
        left_id: result.left_id.to_string(),
        right_id: result.right_id.to_string(),
    })
}

/// Deletes a clip from the project by UUID.
///
/// The removed clip data is returned for potential client-side undo.
#[tauri::command]
async fn delete_clip_cmd(
    clip_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id)
        .map_err(|e| format!("Invalid clip ID: {e}"))?;

    // Snapshot for undo BEFORE mutation
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    if let Err(audio_err) = mutators::delete_clip(&mut project, uuid) {
        // If this is not an audio clip, attempt MIDI clip delete using same UUID.
        if !delete_midi_clip_in_project(&mut project, uuid) {
            return Err(mutator_err_to_string(audio_err));
        }
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);

    Ok(())
}

/// Duplicate a clip, optionally at a specific destination position.
#[tauri::command]
async fn duplicate_clip_cmd(
    clip_id: String,
    new_position_frames: Option<i64>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<DuplicateClipResponse, String> {
    let uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let target_pos = new_position_frames.map(AbsoluteTime::new);

    let new_id = match mutators::duplicate_clip(&mut project, uuid, target_pos) {
        Ok(dup) => dup.id,
        Err(_) => {
            mutators::duplicate_midi_clip(&mut project, uuid, target_pos)
                .map_err(mutator_err_to_string)?
                .id
        }
    };


    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);

    Ok(DuplicateClipResponse {
        new_id: new_id.to_string(),
    })
}

/// Merge selected clips into one clip on the same track.
#[tauri::command]
async fn merge_clips_cmd(
    clip_ids: Vec<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<MergeClipsResponse, String> {
    if clip_ids.is_empty() {
        return Err("No clips selected".to_string());
    }

    let ids: Result<Vec<Uuid>, _> = clip_ids.iter().map(|id| Uuid::parse_str(id)).collect();
    let ids = ids.map_err(|e| format!("Invalid clip ID: {e}"))?;
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    // Find track containing all selected clips.
    let mut selected_track_idx: Option<usize> = None;
    for (ti, track) in project.tracks.iter().enumerate() {
        let audio_hits = ids.iter().filter(|id| track.clips.iter().any(|c| c.id == **id)).count();
        let midi_hits = ids.iter().filter(|id| track.midi_clips.iter().any(|c| c.id == **id)).count();
        if audio_hits == ids.len() || midi_hits == ids.len() {
            selected_track_idx = Some(ti);
            break;
        }
    }
    let ti = selected_track_idx.ok_or_else(|| "Selected clips must be on one track".to_string())?;
    let track = &mut project.tracks[ti];

    let audio_selected: Vec<_> = track
        .clips
        .iter()
        .filter(|c| ids.contains(&c.id))
        .cloned()
        .collect();
    let midi_selected: Vec<_> = track
        .midi_clips
        .iter()
        .filter(|c| ids.contains(&c.id))
        .cloned()
        .collect();

    if !audio_selected.is_empty() && !midi_selected.is_empty() {
        return Err("Cannot merge audio and MIDI clips together".to_string());
    }
    if audio_selected.len() + midi_selected.len() < 2 {
        return Err("Select at least two clips to merge".to_string());
    }

    let new_id = Uuid::new_v4();
    if !audio_selected.is_empty() {
        let first = audio_selected
            .iter()
            .min_by_key(|c| c.position.sample_frame)
            .ok_or_else(|| "No audio clips selected".to_string())?;
        let start = audio_selected
            .iter()
            .map(|c| c.position.sample_frame)
            .min()
            .unwrap_or(first.position.sample_frame);
        let end = audio_selected
            .iter()
            .map(|c| c.end_position().sample_frame)
            .max()
            .unwrap_or(first.end_position().sample_frame);

        track.clips.retain(|c| !ids.contains(&c.id));
        let merged = AudioClip {
            id: new_id,
            name: "Merged Clip".to_string(),
            position: AbsoluteTime::new(start),
            duration: AbsoluteTime::new((end - start).max(1)),
            fade_in_frames: 0,
            fade_out_frames: 0,
            is_selected: false,
            is_muted: false,
            ..first.clone()
        };
        let insert_at = track
            .clips
            .binary_search_by(|c| c.position.cmp(&merged.position))
            .unwrap_or_else(|i| i);
        track.clips.insert(insert_at, merged);
    } else {
        let start = midi_selected
            .iter()
            .map(|c| c.position.sample_frame)
            .min()
            .ok_or_else(|| "No MIDI clips selected".to_string())?;
        let end = midi_selected
            .iter()
            .map(|c| c.end_position().sample_frame)
            .max()
            .ok_or_else(|| "No MIDI clips selected".to_string())?;

        let mut merged = MidiClip::new("Merged Clip", AbsoluteTime::new(start), AbsoluteTime::new((end - start).max(1)));
        merged.id = new_id;
        for clip in &midi_selected {
            let clip_offset = clip.position.sample_frame - start;
            for note in &clip.notes {
                let mut moved = *note;
                moved.start_frame = (note.start_frame + clip_offset).max(0);
                merged.add_note(moved);
            }
        }

        track.midi_clips.retain(|c| !ids.contains(&c.id));
        let insert_at = track
            .midi_clips
            .binary_search_by(|c| c.position.cmp(&merged.position))
            .unwrap_or_else(|i| i);
        track.midi_clips.insert(insert_at, merged);
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);

    Ok(MergeClipsResponse {
        new_id: new_id.to_string(),
    })
}

/// Update a clip's source offset (slip editing).
#[tauri::command]
async fn set_clip_source_offset_cmd(
    clip_id: String,
    source_offset_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut updated = false;
    for track in &mut project.tracks {
        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == uuid) {
            clip.source_offset = AbsoluteTime::new(source_offset_frames.max(0));
            updated = true;
            break;
        }
    }

    if !updated {
        return Err(format!("Clip not found: {clip_id}"));
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    Ok(())
}

/// Set clip fades. Current engine applies always-on micro-fades; this command is
/// accepted for IPC compatibility with interactive UI fade handles.
#[tauri::command]
async fn set_clip_fades_cmd(
    clip_id: String,
    fade_in_frames: i64,
    fade_out_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut updated = false;
    for track in &mut project.tracks {
        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == uuid) {
            clip.fade_in_frames = fade_in_frames.max(0);
            clip.fade_out_frames = fade_out_frames.max(0);
            updated = true;
            break;
        }
    }

    if !updated {
        for track in &mut project.tracks {
            if let Some(clip) = track.midi_clips.iter_mut().find(|c| c.id == uuid) {
                clip.fade_in_frames = fade_in_frames.max(0);
                clip.fade_out_frames = fade_out_frames.max(0);
                updated = true;
                break;
            }
        }
    }

    if !updated {
        return Err(format!("Clip not found: {clip_id}"));
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);

    log::info!(
        "[IPC] set_clip_fades_cmd clip={} fade_in={} fade_out={}",
        clip_id,
        fade_in_frames.max(0),
        fade_out_frames.max(0)
    );
    Ok(())
}

/// Toggle mute state on a clip (audio or MIDI).
///
/// Muted clips remain on the timeline but are skipped during playback.
/// The visual renderer draws them with a dark overlay.
#[tauri::command]
async fn set_clip_muted_cmd(
    clip_id: String,
    muted: bool,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut updated = false;

    // Try audio clips first
    for track in &mut project.tracks {
        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == uuid) {
            clip.is_muted = muted;
            updated = true;
            break;
        }
    }

    // If not found in audio clips, try MIDI clips
    if !updated {
        for track in &mut project.tracks {
            if let Some(clip) = track.midi_clips.iter_mut().find(|c| c.id == uuid) {
                clip.is_muted = muted;
                updated = true;
                break;
            }
        }
    }

    if !updated {
        return Err(format!("Clip not found: {clip_id}"));
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);

    log::info!("[IPC] set_clip_muted_cmd clip={} muted={}", clip_id, muted);
    Ok(())
}

/// Clear clip color overrides on a track so all clips inherit track color.
#[tauri::command]
async fn paint_track_clips_with_track_color_cmd(
    track_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track ID: {e}"))?;
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {track_id}"))?;

    let mut changed = false;

    for clip in &mut track.clips {
        if clip.color_override.is_some() || clip.color_hex.is_some() {
            changed = true;
        }
        clip.color_override = None;
        clip.color_hex = None;
    }

    for clip in &mut track.midi_clips {
        if clip.color_override.is_some() || clip.color_hex.is_some() {
            changed = true;
        }
        clip.color_override = None;
        clip.color_hex = None;
    }

    if changed {
        *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
        clip_pool_state.rebuild_snapshot(&project);
        rebuild_midi_snapshot_from_project(&project, &handle);
    }

    Ok(())
}

/// Resolve offline media path for an existing clip.
#[tauri::command]
async fn resolve_missing_file_cmd(
    clip_id: String,
    new_path: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;
    if !PathBuf::from(&new_path).exists() {
        return Err(format!("Resolved file does not exist: {new_path}"));
    }

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut updated = false;
    for track in &mut project.tracks {
        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == uuid) {
            clip.file_path = new_path.clone();
            clip.is_offline = false;
            updated = true;
            break;
        }
    }
    if !updated {
        return Err(format!("Clip not found: {clip_id}"));
    }

    // Load resolved media into clip pool so playback recovers immediately.
    let decoded = AudioReader::read(PathBuf::from(&new_path))
        .map_err(|e| format!("Failed to decode resolved audio: {e}"))?;
    {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        pool.insert(ClipAudio {
            source_path: new_path.clone(),
            channels: decoded.channels,
            sample_rate: decoded.sample_rate,
            num_frames: decoded.num_frames,
        });
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    Ok(())
}

/// Accept automation points from frontend (throttled there to 16ms).
#[tauri::command]
async fn set_automation_points_cmd(
    track_id: String,
    param_id: String,
    points: Vec<AutomationPointPayload>,
    project_state: tauri::State<'_, ProjectState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track ID: {e}"))?;
    let normalized_param_id = param_id.trim().to_string();
    if normalized_param_id.is_empty() {
        return Err("Parameter ID cannot be empty".to_string());
    }
    push_undo(&project_state)?;
    {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        let track = project
            .tracks
            .iter_mut()
            .find(|t| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found: {track_id}"))?;

        let mut persistent_points: Vec<dream_models::project::AutomationPoint> = points
            .iter()
            .map(|p| dream_models::project::AutomationPoint {
                beat: p.beat.max(0.0),
                value: p.value,
                curve_type: p.curve_type.clone(),
                tension: p.tension,
                bezier_cp1x: None, bezier_cp1y: None, bezier_cp2x: None, bezier_cp2y: None,
            })
            .collect();
        persistent_points.sort_by(|a, b| a.beat.total_cmp(&b.beat));

        if let Some(existing) = track
            .automation_lanes
            .iter_mut()
            .find(|lane| lane.param_id.eq_ignore_ascii_case(&normalized_param_id))
        {
            existing.points = persistent_points;
            existing.param_id = normalized_param_id.clone();
        } else {
            track.automation_lanes.push(dream_models::project::AutomationLane {
                param_id: normalized_param_id.clone(),
                points: persistent_points,
            });
        }

        // Keep project clean: remove empty lanes.
        track.automation_lanes.retain(|lane| !lane.points.is_empty());

        *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
        rebuild_automation_snapshot_from_project(&project, &automation_runtime);
    }

    log::debug!(
        "[IPC] set_automation_points_cmd track={} param={} points={}",
        track_id,
        param_id,
        points.len()
    );
    Ok(())
}

/// Arm/disarm a track for recording.
#[tauri::command]
async fn arm_track_cmd(
    track_index: usize,
    armed: bool,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<(), String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .get_mut(track_index)
        .ok_or_else(|| format!("Track index out of range: {track_index}"))?;
    track.is_armed = armed;
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    Ok(())
}

/// Start live recording on the first armed track.
#[tauri::command]
async fn start_recording_cmd(
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    recording_runtime: tauri::State<'_, RecordingRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    if recording_runtime
        .session
        .lock()
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Err("Recording already in progress".to_string());
    }

    let armed_track_index = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        project
            .tracks
            .iter()
            .position(|t| t.is_armed)
            .ok_or_else(|| "No armed tracks".to_string())?
    };

    let output_dir = std::env::temp_dir().join("dream_daw_recordings");
    let start_frame = handle.master_clock.position();
    let file_name = format!("recording_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs());

    let session = RecordingSession::start(&output_dir, &file_name, start_frame)
        .map_err(|e| format!("start_recording failed: {e}"))?;

    let is_recording = Arc::clone(&session.state().is_recording);
    let peak_left = Arc::clone(&session.state().peak_left);
    let peak_right = Arc::clone(&session.state().peak_right);
    let app_for_peaks = app.clone();
    std::thread::spawn(move || {
        while is_recording.load(Ordering::Relaxed) {
            let left = f32::from_bits(peak_left.load(Ordering::Relaxed));
            let right = f32::from_bits(peak_right.load(Ordering::Relaxed));
            let payload = serde_json::json!({
                "track_index": armed_track_index,
                "peak": left.abs().max(right.abs()),
                "peaks": [left, right]
            });
            let _ = app_for_peaks.emit("live_audio_peaks", payload);
            std::thread::sleep(Duration::from_millis(16));
        }
    });

    *recording_runtime.session.lock().map_err(|e| e.to_string())? = Some(session);
    *recording_runtime
        .armed_track_index
        .lock()
        .map_err(|e| e.to_string())? = Some(armed_track_index);

    Ok(())
}

/// Stop recording, finalize file, and place resulting clip on armed track.
#[tauri::command]
async fn stop_recording_cmd(
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    recording_runtime: tauri::State<'_, RecordingRuntime>,
) -> Result<(), String> {
    let session = recording_runtime
        .session
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or_else(|| "No active recording session".to_string())?;

    let armed_idx = recording_runtime
        .armed_track_index
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or_else(|| "Missing armed track index".to_string())?;

    let result = session
        .stop()
        .map_err(|e| format!("stop_recording failed: {e}"))?;
    let path = result.file_path.display().to_string();

    let decoded = AudioReader::read(&result.file_path)
        .map_err(|e| format!("Failed to decode recorded file: {e}"))?;
    {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        pool.insert(ClipAudio {
            source_path: path.clone(),
            channels: decoded.channels,
            sample_rate: decoded.sample_rate,
            num_frames: decoded.num_frames,
        });
    }

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    while project.tracks.len() <= armed_idx {
        let track_num = project.tracks.len() + 1;
        project.add_track(Track::new(format!("Track {track_num}")));
    }

    let clip = AudioClip::new(
        "Recording",
        &path,
        AbsoluteTime::new(result.start_frame),
        AbsoluteTime::new(result.total_frames as i64),
    );
    project.tracks[armed_idx].clips.push(clip);
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);

    Ok(())
}

/// Offline bounce/export command.
#[tauri::command]
async fn export_mix_cmd(
    settings: ExportSettingsPayload,
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();
    let project_end_frame = project
        .tracks
        .iter()
        .flat_map(|t| t.clips.iter())
        .map(|c| c.position.sample_frame + c.duration.sample_frame)
        .max()
        .unwrap_or(0)
        .max(1);

    let (start_frame, end_frame) = if settings.range == "loop" {
        let state = handle.playback_state.lock().map_err(|e| e.to_string())?;
        if state.loop_enabled && state.loop_end > state.loop_start {
            (state.loop_start, state.loop_end)
        } else {
            (0, project_end_frame)
        }
    } else {
        (0, project_end_frame)
    };

    let mut local_pool = ClipPool::new();
    for track in &project.tracks {
        for clip in &track.clips {
            if clip.file_path.is_empty() {
                continue;
            }
            if local_pool.get(&clip.file_path).is_some() {
                continue;
            }
            if !PathBuf::from(&clip.file_path).exists() {
                continue;
            }
            if let Ok(decoded) = AudioReader::read(PathBuf::from(&clip.file_path)) {
                local_pool.insert(ClipAudio {
                    source_path: clip.file_path.clone(),
                    channels: decoded.channels,
                    sample_rate: decoded.sample_rate,
                    num_frames: decoded.num_frames,
                });
            }
        }
    }

    let cfg = BounceConfig {
        output_path: settings.output_path.clone(),
        sample_rate: settings.sample_rate,
        bit_depth: settings.bit_depth,
        start_frame,
        end_frame,
        normalize: settings.normalize,
        tail_frames: ((settings.tail_ms as f64 / 1000.0) * settings.sample_rate as f64) as i64,
        format: settings.format.clone(),
    };
    
    // Reset cancel flag and create bouncer with it
    handle.export_cancel.store(false, std::sync::atomic::Ordering::SeqCst);
    let mut bouncer = OfflineBouncer::new(cfg);
    bouncer.cancel_flag = std::sync::Arc::clone(&handle.export_cancel);
    
    let app_for_progress = app.clone();
    bouncer
        .bounce(&project, &local_pool, None, move |progress| {
            let payload = serde_json::json!({
                "progress": (progress * 100.0).clamp(0.0, 100.0),
                "phase": "Rendering"
            });
            let _ = app_for_progress.emit("bounce_progress", payload);
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Cancel an in-progress export/bounce operation.
#[tauri::command]
async fn cancel_export_cmd(
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    handle.export_cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    log::info!("[Export] Cancel requested");
    Ok(())
}
