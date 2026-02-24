fn track_supports_live_preview(track: &dream_models::project::Track) -> bool {
    use dream_models::project::TrackType;
    if track.track_type == TrackType::Master {
        return false;
    }
    track.track_type == TrackType::Midi || track.instrument.is_some()
}

fn resolve_preview_track_index(project: &dream_models::project::Project, requested: u16) -> u16 {
    let track_count = project.tracks.len();
    if track_count == 0 {
        return requested;
    }
    let req_idx = requested as usize;
    if req_idx < track_count {
        let req_track = &project.tracks[req_idx];
        if track_supports_live_preview(req_track) {
            return requested;
        }
    }
    if let Some(idx) = project
        .tracks
        .iter()
        .position(|t| t.is_armed && track_supports_live_preview(t))
    {
        return idx as u16;
    }
    if let Some(idx) = project.tracks.iter().position(track_supports_live_preview) {
        return idx as u16;
    }
    if let Some(idx) = project.tracks.iter().position(|t| {
        t.is_armed && t.track_type != dream_models::project::TrackType::Master
    }) {
        return idx as u16;
    }
    req_idx.min(track_count.saturating_sub(1)) as u16
}

/// Trigger a sampler note-on for live audition from Piano Roll.
#[tauri::command]
fn preview_sampler_note_on_cmd(
    track_index: u16,
    pitch: u8,
    velocity: u8,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<(), String> {
    let resolved_track_index = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        resolve_preview_track_index(&project, track_index)
    };
    push_command(
        &handle,
        EngineCommand::SamplerNoteOn {
            track_index: resolved_track_index,
            pitch,
            velocity,
        },
    )?;
    Ok(())
}

/// Trigger a sampler note-off for live audition from Piano Roll.
#[tauri::command]
fn preview_sampler_note_off_cmd(
    track_index: u16,
    pitch: u8,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<(), String> {
    let resolved_track_index = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        resolve_preview_track_index(&project, track_index)
    };
    push_command(
        &handle,
        EngineCommand::SamplerNoteOff {
            track_index: resolved_track_index,
            pitch,
        },
    )?;
    Ok(())
}
