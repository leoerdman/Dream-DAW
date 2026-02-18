// ═══════════════════════════════════════════════════════════════════════

/// Lists all available audio input and output devices.
///
/// Uses `cpal` via `dream_engine::driver::list_audio_devices()`.
/// Returns `{ outputs: ["name", ...], inputs: ["name", ...] }`.
#[tauri::command]
fn get_audio_devices() -> Result<serde_json::Value, String> {
    let (outputs, inputs) = dream_engine::driver::list_audio_devices();
    Ok(serde_json::json!({
        "outputs": outputs,
        "inputs": inputs,
    }))
}

/// Switch the live engine to a different audio output device by name.
///
/// This performs a hot-swap:
/// 1) build a new audio stream on the requested device
/// 2) atomically replace producer + stream handles
/// 3) replay transport state into the new callback
#[tauri::command]
fn set_audio_device(
    device_name: String,
    handle: tauri::State<'_, AudioEngineHandle>,
    settings_state: tauri::State<'_, SettingsState>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<String, String> {
    restart_audio_engine_impl(device_name, handle, settings_state, project_state)
}

fn restart_audio_engine_impl(
    device_name: String,
    handle: tauri::State<'_, AudioEngineHandle>,
    settings_state: tauri::State<'_, SettingsState>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<String, String> {
    log::info!("Audio device change requested: '{}'", device_name);

    // Build a fresh engine ring buffer and stream on requested device.
    let (new_producer, new_consumer) = rtrb::RingBuffer::<EngineCommand>::new(1024);
    let new_stream = dream_engine::driver::start_audio_thread_on_device(
        new_consumer,
        Arc::clone(&handle.master_clock),
        Arc::clone(&handle.meter_bank),
        Arc::clone(&handle.clip_pool),
        Arc::clone(&handle.clip_snapshot),
        Arc::clone(&handle.midi_snapshot),
        Arc::clone(&handle.routing_snapshot),
        Arc::clone(&handle.sidechain_snapshot),
        Arc::clone(&handle.external_fx_snapshot),
        Arc::clone(&handle.automation_snapshot),
        Arc::clone(&handle.sampler_samples),
        Arc::clone(&handle.prepared_graph_snapshot),
        Arc::clone(&handle.rt_debug_stats),
        Arc::clone(&handle.plugin_host),
        Arc::clone(&handle.preview_buffer),
        Arc::clone(&handle.preview_cursor),
        Some(device_name.as_str()),
        Some(handle.stream_error_tx.clone()),
    )
    .map_err(|e| format!("Failed to restart engine on '{}': {}", device_name, e))?;

    let resolved_output_device = new_stream.output_device_name.clone();

    // Atomically replace queue producer first, then stream handle.
    {
        let mut producer = handle.producer.lock().map_err(|e| e.to_string())?;
        *producer = new_producer;
    }
    {
        let mut stream = handle._stream.lock().map_err(|e| e.to_string())?;
        *stream = Some(Box::new(new_stream));
    }

    // Re-apply latest transport state to the new callback state machine.
    let snapshot = handle
        .playback_state
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let current_pos_frames = handle.master_clock.position();
    push_command(
        &handle,
        EngineCommand::SetTimelineSampleRate(snapshot.sample_rate),
    )?;
    push_command(&handle, EngineCommand::SetBpm(snapshot.bpm))?;
    push_command(&handle, EngineCommand::SetFreq(snapshot.test_tone_freq))?;
    push_command(
        &handle,
        EngineCommand::SetLoopEnabled(snapshot.loop_enabled),
    )?;
    if snapshot.loop_enabled && snapshot.loop_end > snapshot.loop_start {
        push_command(
            &handle,
            EngineCommand::SetLoopRegion {
                start: snapshot.loop_start,
                end: snapshot.loop_end,
            },
        )?;
    }
    push_command(&handle, EngineCommand::Seek(current_pos_frames.max(0)))?;
    push_command(&handle, EngineCommand::SetPlay(snapshot.is_playing))?;

    // Re-apply per-track mixer state (volume, pan, mute, solo) + master volume.
    // Without this, the new audio thread starts with all tracks unmuted.
    {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        sync_track_mix_state_from_project(&project, &handle)?;
    }

    // Persist the resolved device only after successful hot-swap.
    {
        let mut settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
        settings.output_device = resolved_output_device.clone();
    }
    settings_state.save_to_user_folder()?;

    log::info!(
        "Audio engine hot-swapped: requested='{}', resolved='{}'",
        device_name,
        resolved_output_device
    );
    Ok(resolved_output_device)
}

/// Explicit hot-restart command for audio engine on selected output device.
#[tauri::command]
fn restart_audio_engine(
    device_name: String,
    handle: tauri::State<'_, AudioEngineHandle>,
    settings_state: tauri::State<'_, SettingsState>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<String, String> {
    restart_audio_engine_impl(device_name, handle, settings_state, project_state)
}
