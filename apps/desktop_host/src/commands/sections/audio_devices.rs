use super::*;

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
) -> Result<(), String> {
    restart_audio_engine_impl(device_name, handle, settings_state)
}

fn restart_audio_engine_impl(
    device_name: String,
    handle: tauri::State<'_, AudioEngineHandle>,
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<(), String> {
    log::info!("Audio device change requested: '{}'", device_name);

    // Persist selection immediately.
    {
        let mut settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
        settings.output_device = device_name.clone();
    }
    settings_state.save_to_user_folder()?;

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
        Arc::clone(&handle.automation_snapshot),
        Arc::clone(&handle.sampler_samples),
        Arc::clone(&handle.preview_buffer),
        Arc::clone(&handle.preview_cursor),
        Some(device_name.as_str()),
    )
    .map_err(|e| format!("Failed to restart engine on '{}': {}", device_name, e))?;

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
    push_command(
        &handle,
        EngineCommand::SetBpm(snapshot.bpm),
    )?;
    push_command(
        &handle,
        EngineCommand::SetFreq(snapshot.test_tone_freq),
    )?;
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
    push_command(
        &handle,
        EngineCommand::SetPlay(snapshot.is_playing),
    )?;

    log::info!("Audio engine hot-swapped to output device '{}'", device_name);
    Ok(())
}

/// Explicit hot-restart command for audio engine on selected output device.
#[tauri::command]
fn restart_audio_engine(
    device_name: String,
    handle: tauri::State<'_, AudioEngineHandle>,
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<(), String> {
    restart_audio_engine_impl(device_name, handle, settings_state)
}

