/// Returns the current transport position and state.
///
/// Includes `output_latency_frames` so the frontend can offset the
/// visual playhead to match actual speaker output, and
/// `telemetry_timestamp_ms` so the frontend can interpolate the
/// playhead at 144fps between telemetry ticks.
#[tauri::command]
fn get_transport(
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<TransportState, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    let state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;

    let frames = handle.master_clock.position();
    let sample_rate = state.sample_rate;
    let seconds = frames as f64 / sample_rate;
    let fallback_bpm = state.bpm;
    let is_playing = state.is_playing;
    let loop_enabled = state.loop_enabled;
    let loop_start = state.loop_start;
    let loop_end = state.loop_end;
    drop(state);

    // Keep BPM source consistent with transport sync rules used during project load.
    // If an ALS project starts with tempo automation at beat 0, pulse_map may still
    // carry the legacy/default BPM while transport actually runs at the automated BPM.
    // Using the same resolver avoids UI playhead-beat drift.
    let (bpm, position_beats, time_sig_numerator, time_sig_denominator, master_pdc) = if let Ok(project) = project_state.project.lock() {
        let bpm = project_initial_transport_bpm(&project);
        let beats = seconds * bpm / 60.0;
        // PDC-006: Read master bus PDC latency for frontend playhead compensation
        let master_pdc_latency = project.master_track.total_latency_frames();
        (
            bpm,
            beats,
            u32::from(project.time_signature.numerator.max(1)),
            u32::from(project.time_signature.denominator.max(1)),
            master_pdc_latency,
        )
    } else {
        (fallback_bpm, seconds * fallback_bpm / 60.0, 4, 4, 0)
    };

    // Monotonic timestamp for frontend playhead interpolation.
    // Uses wall-clock ms since UNIX epoch — the frontend converts
    // to its own `performance.now()` timebase on first receipt.
    let telemetry_timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);

    Ok(TransportState {
        is_playing,
        position_frames: frames,
        position_seconds: seconds,
        position_beats,
        bpm,
        sample_rate,
        loop_enabled,
        loop_start,
        loop_end,
        output_latency_frames: handle.output_latency_frames,
        master_pdc_latency_frames: master_pdc,
        telemetry_timestamp_ms,
        time_sig_numerator,
        time_sig_denominator,
    })
}

/// Returns lock-free meter readings for all tracks and master.
/// Called at 30-60fps from the frontend for VU meter animation.
///
/// # Performance
/// Zero locks. Reads atomic values via `Ordering::Relaxed`.
/// Latency: <1μs total for 64 tracks.
#[tauri::command]
fn get_meters(handle: tauri::State<'_, AudioEngineHandle>) -> Result<MeteringSnapshot, String> {
    let bank = &handle.meter_bank;

    let mut tracks = Vec::with_capacity(bank.track_count());
    for i in 0..bank.track_count() {
        if let Some((left, right)) = bank.track(i) {
            tracks.push((read_meter(left), read_meter(right)));
        }
    }

    Ok(MeteringSnapshot {
        tracks,
        master_left: read_meter(bank.master_left()),
        master_right: read_meter(bank.master_right()),
    })
}

/// Returns compact binary meter payload:\n/// f32 triplets per channel [rms, peak, clipping01].
///
/// See `MeterBank::pack_meters_binary()` for the canonical format.
#[tauri::command]
fn get_meters_binary(handle: tauri::State<'_, AudioEngineHandle>) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(handle.meter_bank.pack_meters_binary()))
}

/// Sets the test tone frequency (legacy / debug).
#[tauri::command]
fn set_frequency(freq: f32, handle: tauri::State<'_, AudioEngineHandle>) -> Result<(), String> {
    if !(20.0..=20000.0).contains(&freq) {
        return Err(format!(
            "Frequency {freq}Hz out of audible range (20–20000 Hz)"
        ));
    }

    push_command(&handle, EngineCommand::SetFreq(freq))?;

    let mut state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    state.test_tone_freq = freq;

    log::info!("[IPC] set_frequency({freq}Hz)");
    Ok(())
}
