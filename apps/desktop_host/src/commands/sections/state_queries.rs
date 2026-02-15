// ═══════════════════════════════════════════════════════════════════════

/// Returns the current engine state as JSON.
#[tauri::command]
fn get_state(handle: tauri::State<'_, AudioEngineHandle>) -> Result<EngineStateResponse, String> {
    let state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;

    let frames = handle.master_clock.position();

    Ok(EngineStateResponse {
        is_playing: state.is_playing,
        bpm: state.bpm,
        test_tone_freq: state.test_tone_freq,
        frames_rendered: frames,
        sample_rate: state.sample_rate,
    })
}

/// Returns recent project mutation events (append-only in-memory history).
#[tauri::command]
fn get_project_history(
    project_state: tauri::State<'_, ProjectState>,
) -> Result<Vec<ProjectHistoryEvent>, String> {
    project_state.history_snapshot()
}

/// Returns the current transport position and state.
///
/// Includes `output_latency_frames` so the frontend can offset the
/// visual playhead to match actual speaker output, and
/// `telemetry_timestamp_ms` so the frontend can interpolate the
/// playhead at 144fps between telemetry ticks.
#[tauri::command]
fn get_transport(
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<TransportState, String> {
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

    // Authoritative beat conversion must use project pulse map, not mirrored
    // transport BPM, otherwise imported ALS projects can show playhead drift
    // (e.g. 33rd bar audio sounding while UI reads ~23rd bar).
    let (bpm, position_beats) = if let Ok(project) = project_state.project.lock() {
        let bpm = project.pulse_map.initial_bpm();
        let beats = project.pulse_map.beats(frames.max(0));
        (bpm, beats)
    } else {
        (fallback_bpm, seconds * fallback_bpm / 60.0)
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
        telemetry_timestamp_ms,
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

/// Sets the test tone frequency (legacy / debug).
#[tauri::command]
fn set_frequency(freq: f32, handle: tauri::State<'_, AudioEngineHandle>) -> Result<(), String> {
    if !(20.0..=20000.0).contains(&freq) {
        return Err(format!("Frequency {freq}Hz out of audible range (20–20000 Hz)"));
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
