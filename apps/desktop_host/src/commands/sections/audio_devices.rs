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
/// 4) BUG-AUD-301 FIX: reactivate all plugins with new device config
#[tauri::command]
fn set_audio_device(
    device_name: String,
    handle: tauri::State<'_, AudioEngineHandle>,
    settings_state: tauri::State<'_, SettingsState>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<String, String> {
    restart_audio_engine_impl(device_name, handle, settings_state, project_registry.clone(), plugin_host_state)
}

fn restart_audio_engine_impl(
    device_name: String,
    handle: tauri::State<'_, AudioEngineHandle>,
    settings_state: tauri::State<'_, SettingsState>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<String, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    log::info!("Audio device change requested: '{}'", device_name);

    // Build a fresh engine ring buffer and stream on requested device.
    let (new_producer, new_consumer) = rtrb::RingBuffer::<EngineCommand>::new(4096);
    let (new_prealloc_producer, new_prealloc_consumer) =
        dream_ipc::prealloc_queue::new_prealloc_queue();
    // BUF-001 FIX: Read validated buffer_size from settings for cpal.
    let preferred_buffer_size = settings_state
        .settings
        .lock()
        .ok()
        .map(|s| crate::settings::validated_buffer_size(s.buffer_size));

    let shared_state = dream_engine::driver::AudioSharedState {
        clock: Arc::clone(&handle.master_clock),
        meter_bank: Arc::clone(&handle.meter_bank),
        clip_pool: Arc::clone(&handle.clip_pool),
        clip_snapshot: Arc::clone(&handle.clip_snapshot),
        midi_snapshot: Arc::clone(&handle.midi_snapshot),
        routing_snapshot: Arc::clone(&handle.routing_snapshot),
        sidechain_snapshot: Arc::clone(&handle.sidechain_snapshot),
        external_fx_snapshot: Arc::clone(&handle.external_fx_snapshot),
        automation_snapshot: Arc::clone(&handle.automation_snapshot),
        sampler_samples: Arc::clone(&handle.sampler_samples),
        sample_rack_samples: Arc::clone(&handle.sample_rack_samples),
        prepared_graph_snapshot: Arc::clone(&handle.prepared_graph_snapshot),
        rt_debug_stats: Arc::clone(&handle.rt_debug_stats),
        plugin_registry: Arc::clone(&handle.plugin_registry),
        preview_buffer: Arc::clone(&handle.preview_buffer),
        preview_cursor: Arc::clone(&handle.preview_cursor),
        preview_source_sr: Arc::clone(&handle.preview_source_sr),
        disk_streamers: Arc::clone(&handle.disk_streamers),
        internal_latency_snapshot: Arc::clone(&handle.internal_latency_snapshot),
    };

    let new_stream = dream_engine::driver::start_audio_thread_on_device(
        new_consumer,
        new_prealloc_consumer,
        shared_state,
        Some(device_name.as_str()),
        Some(handle.stream_error_tx.clone()),
        preferred_buffer_size,
    )
    .map_err(|e| format!("Failed to restart engine on '{}': {}", device_name, e))?;

    let resolved_output_device = new_stream.output_device_name.clone();
    let new_sample_rate_hz = new_stream.sample_rate_hz;

    // Atomically replace queue producer first, then stream handle.
    {
        let mut producer = handle.producer.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        *producer = new_producer;
    }
    {
        let mut prealloc = handle.prealloc_producer.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        *prealloc = new_prealloc_producer;
    }
    {
        let mut stream = handle._stream.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        *stream = Some(Box::new(new_stream));
    }

    // BUG-AUD-301 FIX: Reactivate all loaded plugins with the new device's
    // actual sample rate and MAX_BUFFER_FRAMES (8192). Without this, plugins
    // remain activated at the OLD device's sample rate and buffer size, causing:
    // - Pitch-shifted output (wrong sample rate)
    // - Silent passthrough (num_frames > max_buffer_size guard triggers)
    if let Err(e) = plugin_host_state.update_audio_config(
        f64::from(new_sample_rate_hz),
        dream_engine::render_callback::MAX_BUFFER_FRAMES,
    ) {
        log::warn!(
            "[AudioDevices] Failed to sync PluginHostState after device switch: {}",
            e
        );
    } else {
        log::info!(
            "[AudioDevices] Synced PluginHostState to new device config: {}Hz / {} max frames",
            new_sample_rate_hz,
            dream_engine::render_callback::MAX_BUFFER_FRAMES,
        );
    }
    // Re-publish plugin registry so the new audio thread sees updated instances.
    plugin_host_state.publish_registry();

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
    {
        let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        push_command(
            &handle,
            EngineCommand::SetTimeSignature {
                numerator: project.time_signature.numerator.max(1),
                denominator: project.time_signature.denominator.max(1),
            },
        )?;
    }
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
    // ENTERPRISE FIX: Rebuild device chains FIRST so the new audio thread has
    // plugins inserted into per-track processing chains. Without this, external
    // plugins (Serum, etc.) remain silent after device switch because the new
    // thread's chains are empty — plugins are registered but not wired.
    {
        let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        rebuild_runtime_device_chains_from_project(&project, &handle)?;
        sync_track_mix_state_from_project(&project, &handle)?;
    }

    // Persist the resolved device only after successful hot-swap.
    {
        let mut settings = settings_state.settings.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        settings.output_device = resolved_output_device.clone();
    }
    settings_state.request_save();

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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<String, String> {
    restart_audio_engine_impl(device_name, handle, settings_state, project_registry.clone(), plugin_host_state)
}
