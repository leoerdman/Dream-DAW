/// Enumerate available MIDI input ports from the OS.
#[tauri::command]
fn get_midi_inputs(
    midi_runtime: tauri::State<'_, MidiInputRuntime>,
) -> Result<Vec<MidiInputPortInfo>, String> {
    let midi_in = MidiInput::new("Dream DAW MIDI Input")
        .map_err(|e| format!("Failed to initialize MIDI input: {e}"))?;
    let ports = midi_in.ports();
    let connected = midi_runtime
        .connected_port
        .lock()
        .map_err(|e| e.to_string())?
        .clone();

    let mut out = Vec::with_capacity(ports.len());
    for port in ports {
        let name = midi_in
            .port_name(&port)
            .unwrap_or_else(|_| "Unknown MIDI Port".to_string());
        out.push(MidiInputPortInfo {
            connected: connected.as_deref() == Some(name.as_str()),
            name,
        });
    }
    Ok(out)
}

fn track_accepts_midi_live_input(track: &dream_models::project::Track) -> bool {
    use dream_models::project::TrackType;
    if track.track_type == TrackType::Master {
        return false;
    }
    track.track_type == TrackType::Midi || track.instrument.is_some()
}

/// Connect to a MIDI input port and stream NoteOn/NoteOff into the engine queue.
#[tauri::command]
fn connect_midi_input(
    app: tauri::AppHandle,
    port_name: String,
    midi_runtime: tauri::State<'_, MidiInputRuntime>,
) -> Result<(), String> {
    let mut midi_in = MidiInput::new("Dream DAW MIDI Input")
        .map_err(|e| format!("Failed to initialize MIDI input: {e}"))?;
    midi_in.ignore(midir::Ignore::None);

    let ports = midi_in.ports();
    let selected_port = ports
        .into_iter()
        .find(|p| midi_in.port_name(p).ok().as_deref() == Some(port_name.as_str()))
        .ok_or_else(|| format!("MIDI input port not found: {port_name}"))?;

    // Drop previous connection (if any) before reconnecting.
    if let Some(existing) = midi_runtime.connection.lock().map_err(|e| e.to_string())?.take() {
        drop(existing);
    }

    let app_for_cb = app.clone();
    let conn = midi_in
        .connect(
            &selected_port,
            "Dream DAW MIDI In",
            move |_timestamp, message, _| {
                if message.is_empty() {
                    return;
                }
                let status = message[0] & 0xF0;
                let note = message.get(1).copied().unwrap_or(0);
                let velocity = message.get(2).copied().unwrap_or(0);

                let _ = app_for_cb.emit(
                    "midi_event_received",
                    serde_json::json!({
                        "status": status,
                        "note": note,
                        "velocity": velocity,
                    }),
                );

                // Route live MIDI to the best instrument-capable track:
                // 1) armed MIDI/instrument track
                // 2) any MIDI/instrument track
                // 3) armed non-master track
                // 4) fallback track 0
                let target_track = {
                    let project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry> = app_for_cb.state();
                    match project_state.project.lock() {
                        Ok(project) => project
                            .tracks
                            .iter()
                            .position(|t| t.is_armed && track_accepts_midi_live_input(t))
                            .or_else(|| {
                                project
                                    .tracks
                                    .iter()
                                    .position(track_accepts_midi_live_input)
                            })
                            .or_else(|| {
                                project
                                    .tracks
                                    .iter()
                                    .position(|t| t.is_armed && t.track_type != dream_models::project::TrackType::Master)
                            })
                            .unwrap_or(0),
                        Err(_) => 0,
                    }
                };

                let engine_handle: tauri::State<'_, AudioEngineHandle> = app_for_cb.state();
                match status {
                    0x90 if velocity > 0 => {
                        if let Err(e) = push_command(
                            &engine_handle,
                            EngineCommand::SamplerNoteOn {
                                track_index: target_track as u16,
                                pitch: note,
                                velocity,
                            },
                        ) {
                            log::error!("[MIDI] Failed to push SamplerNoteOn for track {}: {}", target_track, e);
                        }
                    }
                    0x80 | 0x90 => {
                        if let Err(e) = push_command(
                            &engine_handle,
                            EngineCommand::SamplerNoteOff {
                                track_index: target_track as u16,
                                pitch: note,
                            },
                        ) {
                            log::error!("[MIDI] Failed to push SamplerNoteOff for track {}: {}", target_track, e);
                        }
                    }
                    _ => {}
                }
            },
            (),
        )
        .map_err(|e| format!("Failed to connect MIDI input '{port_name}': {e}"))?;

    *midi_runtime.connection.lock().map_err(|e| e.to_string())? = Some(conn);
    *midi_runtime.connected_port.lock().map_err(|e| e.to_string())? = Some(port_name.clone());
    log::info!("[IPC] connect_midi_input({port_name})");
    Ok(())
}
