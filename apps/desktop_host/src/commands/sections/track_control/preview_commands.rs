/// Trigger a sampler note-on for live audition from Piano Roll.
#[tauri::command]
fn preview_sampler_note_on_cmd(
    track_index: u16,
    pitch: u8,
    velocity: u8,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(
        &handle,
        EngineCommand::SamplerNoteOn {
            track_index,
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
) -> Result<(), String> {
    push_command(&handle, EngineCommand::SamplerNoteOff { track_index, pitch })?;
    Ok(())
}
