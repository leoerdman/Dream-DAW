fn resolve_preview_track_index(project: &dream_models::project::Project, requested: u16) -> u16 {
    let track_count = project.tracks.len();
    if track_count == 0 { return 0; }
    (requested as usize).min(track_count.saturating_sub(1)) as u16
}

/// Trigger a sampler note-on for live audition from Piano Roll.
#[tauri::command]
fn preview_sampler_note_on_cmd(
    track_index: u16,
    pitch: u8,
    velocity: u8,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
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
