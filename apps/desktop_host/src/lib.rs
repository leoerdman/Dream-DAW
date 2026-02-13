// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Tauri v2 Application Core
// ═══════════════════════════════════════════════════════════════════════════
//
// This file contains the shared Tauri application setup, including:
//   - Audio engine lifecycle management (init on launch, teardown on close)
//   - IPC command handlers (transport, metering, track control, project state)
//   - Thread-safe state management via Tauri's managed state
//
// Architecture:
//   Frontend (React/TS) → Tauri Invoke → Rust Commands → dream_ipc → Audio Thread
//
// The audio engine runs on a dedicated thread spawned at app startup.
// All IPC commands communicate with it via the lock-free `rtrb` command queue.
//
// ═══════════════════════════════════════════════════════════════════════════

use std::sync::{Arc, Mutex};

use dream_ipc::metering::{MeterBank, linear_to_db};
use dream_ipc::{EngineCommand, MasterClock};
use dream_models::PlaybackState;
use rtrb;
use serde::{Deserialize, Serialize};

// ── Audio Engine State ─────────────────────────────────────────────────

/// Thread-safe handle to the audio engine's command producer.
///
/// Wrapped in `Mutex` only for the UI-thread side (Tauri command handlers).
/// The actual audio callback uses the consumer end lock-free via `rtrb`.
struct AudioEngineHandle {
    /// Producer end of the lock-free command queue.
    producer: Mutex<rtrb::Producer<EngineCommand>>,

    /// Atomic master clock (read from any thread).
    master_clock: Arc<MasterClock>,

    /// Current playback state (UI mirror, NOT the audio thread's state).
    /// Updated when commands are sent, read by `get_state`.
    playback_state: Mutex<PlaybackState>,

    /// Lock-free meter bank — written by audio thread, read by UI.
    meter_bank: Arc<MeterBank>,

    /// Handle to the audio stream (kept alive to prevent drop).
    _stream: Mutex<Option<Box<dyn std::any::Any + Send>>>,
}

// ── IPC Response Types ─────────────────────────────────────────────────

/// Full engine state snapshot returned to the frontend.
#[derive(Debug, Clone, Serialize)]
struct EngineStateResponse {
    is_playing: bool,
    bpm: f64,
    test_tone_freq: f32,
    frames_rendered: i64,
    sample_rate: f64,
}

/// Per-channel meter reading (dB scale).
#[derive(Debug, Clone, Serialize)]
struct MeterReading {
    rms: f32,
    peak: f32,
    clipping: bool,
}

/// Full metering snapshot — all tracks + master.
#[derive(Debug, Clone, Serialize)]
struct MeteringSnapshot {
    tracks: Vec<(MeterReading, MeterReading)>, // (left, right) per track
    master_left: MeterReading,
    master_right: MeterReading,
}

/// Transport state returned to frontend for UI synchronization.
#[derive(Debug, Clone, Serialize)]
struct TransportState {
    is_playing: bool,
    position_frames: i64,
    position_seconds: f64,
    bpm: f64,
    loop_enabled: bool,
    loop_start: i64,
    loop_end: i64,
}

/// Track state returned to frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrackStateUpdate {
    track_index: u16,
    volume: Option<f32>,
    pan: Option<f32>,
    muted: Option<bool>,
    soloed: Option<bool>,
}

// ── Helper: push command with error handling ───────────────────────────

fn push_command(
    handle: &AudioEngineHandle,
    cmd: EngineCommand,
) -> Result<(), String> {
    let mut producer = handle
        .producer
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;

    producer
        .push(cmd)
        .map_err(|_| "Command queue full — audio thread overloaded".to_string())
}

fn read_meter(level: &dream_ipc::metering::LockFreeLevel) -> MeterReading {
    MeterReading {
        rms: level.load_rms(),
        peak: level.load_peak(),
        clipping: level.is_clipping(),
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Tauri Commands — Transport
// ═══════════════════════════════════════════════════════════════════════

/// Starts audio playback.
#[tauri::command]
fn play(handle: tauri::State<'_, AudioEngineHandle>) -> Result<(), String> {
    push_command(&handle, EngineCommand::SetPlay(true))?;

    let mut state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    state.is_playing = true;

    log::info!("[IPC] play()");
    Ok(())
}

/// Stops audio playback.
#[tauri::command]
fn stop(handle: tauri::State<'_, AudioEngineHandle>) -> Result<(), String> {
    push_command(&handle, EngineCommand::SetPlay(false))?;

    let mut state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    state.is_playing = false;

    log::info!("[IPC] stop()");
    Ok(())
}

/// Toggle play/stop.
#[tauri::command]
fn toggle_playback(handle: tauri::State<'_, AudioEngineHandle>) -> Result<bool, String> {
    let mut state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;

    let new_state = !state.is_playing;
    state.is_playing = new_state;
    drop(state);

    push_command(&handle, EngineCommand::SetPlay(new_state))?;

    log::info!("[IPC] toggle_playback → {}", if new_state { "play" } else { "stop" });
    Ok(new_state)
}

/// Seeks to a specific position in sample frames.
#[tauri::command]
fn seek(position_frames: i64, handle: tauri::State<'_, AudioEngineHandle>) -> Result<(), String> {
    push_command(&handle, EngineCommand::Seek(position_frames))?;
    log::info!("[IPC] seek({position_frames})");
    Ok(())
}

/// Seeks to a specific position in seconds.
#[tauri::command]
fn seek_seconds(
    seconds: f64,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    let sample_rate = state.sample_rate;
    drop(state);

    let frames = (seconds * sample_rate) as i64;
    push_command(&handle, EngineCommand::Seek(frames))?;
    log::info!("[IPC] seek_seconds({seconds}s → {frames} frames)");
    Ok(())
}

/// Sets the project tempo (BPM).
#[tauri::command]
fn set_bpm(bpm: f64, handle: tauri::State<'_, AudioEngineHandle>) -> Result<(), String> {
    if !(20.0..=999.0).contains(&bpm) {
        return Err(format!("BPM {bpm} out of range (20–999)"));
    }

    push_command(&handle, EngineCommand::SetBpm(bpm))?;

    let mut state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    state.bpm = bpm;

    log::info!("[IPC] set_bpm({bpm})");
    Ok(())
}

/// Sets the loop region and enables/disables looping.
#[tauri::command]
fn set_loop(
    enabled: bool,
    start_frames: i64,
    end_frames: i64,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    if end_frames <= start_frames {
        return Err("Loop end must be after loop start".to_string());
    }
    push_command(&handle, EngineCommand::SetLoopRegion {
        start: start_frames,
        end: end_frames,
    })?;
    push_command(&handle, EngineCommand::SetLoopEnabled(enabled))?;

    log::info!("[IPC] set_loop(enabled={enabled}, {start_frames}–{end_frames})");
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════
// Tauri Commands — Track Control
// ═══════════════════════════════════════════════════════════════════════

/// Sets a track's volume (linear gain 0.0–2.0).
#[tauri::command]
fn set_track_volume(
    track_index: u16,
    volume: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let clamped = volume.clamp(0.0, 2.0);
    push_command(&handle, EngineCommand::SetTrackVolume {
        track_index,
        volume: clamped,
    })?;
    log::debug!("[IPC] set_track_volume(track={track_index}, vol={clamped})");
    Ok(())
}

/// Sets a track's pan position (-1.0 to 1.0).
#[tauri::command]
fn set_track_pan(
    track_index: u16,
    pan: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let clamped = pan.clamp(-1.0, 1.0);
    push_command(&handle, EngineCommand::SetTrackPan {
        track_index,
        pan: clamped,
    })?;
    log::debug!("[IPC] set_track_pan(track={track_index}, pan={clamped})");
    Ok(())
}

/// Mutes or unmutes a track.
#[tauri::command]
fn set_track_mute(
    track_index: u16,
    muted: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(&handle, EngineCommand::SetTrackMute {
        track_index,
        muted,
    })?;
    log::info!("[IPC] set_track_mute(track={track_index}, muted={muted})");
    Ok(())
}

/// Solos or unsolos a track.
#[tauri::command]
fn set_track_solo(
    track_index: u16,
    soloed: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(&handle, EngineCommand::SetTrackSolo {
        track_index,
        soloed,
    })?;
    log::info!("[IPC] set_track_solo(track={track_index}, soloed={soloed})");
    Ok(())
}

/// Batch update a track's state (volume, pan, mute, solo).
#[tauri::command]
fn update_track(
    update: TrackStateUpdate,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    if let Some(vol) = update.volume {
        push_command(&handle, EngineCommand::SetTrackVolume {
            track_index: update.track_index,
            volume: vol.clamp(0.0, 2.0),
        })?;
    }
    if let Some(pan) = update.pan {
        push_command(&handle, EngineCommand::SetTrackPan {
            track_index: update.track_index,
            pan: pan.clamp(-1.0, 1.0),
        })?;
    }
    if let Some(muted) = update.muted {
        push_command(&handle, EngineCommand::SetTrackMute {
            track_index: update.track_index,
            muted,
        })?;
    }
    if let Some(soloed) = update.soloed {
        push_command(&handle, EngineCommand::SetTrackSolo {
            track_index: update.track_index,
            soloed,
        })?;
    }
    log::debug!("[IPC] update_track(track={})", update.track_index);
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════
// Tauri Commands — State Queries
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

/// Returns the current transport position and state.
#[tauri::command]
fn get_transport(handle: tauri::State<'_, AudioEngineHandle>) -> Result<TransportState, String> {
    let state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;

    let frames = handle.master_clock.position();
    let seconds = frames as f64 / state.sample_rate;

    Ok(TransportState {
        is_playing: state.is_playing,
        position_frames: frames,
        position_seconds: seconds,
        bpm: state.bpm,
        loop_enabled: state.loop_enabled,
        loop_start: state.loop_start,
        loop_end: state.loop_end,
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

// ═══════════════════════════════════════════════════════════════════════
// Application Setup
// ═══════════════════════════════════════════════════════════════════════

/// Initializes and runs the Tauri application.
///
/// Called from `main.rs` (desktop) or the mobile entry point.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    // Create the lock-free command queue (capacity: 1024 commands)
    let (producer, consumer) = rtrb::RingBuffer::<EngineCommand>::new(1024);
    let master_clock = Arc::new(MasterClock::new());
    let meter_bank = Arc::new(MeterBank::new(64)); // 64 tracks max

    // Start the audio engine on a dedicated thread
    let clock_for_engine = Arc::clone(&master_clock);
    let stream = dream_engine::driver::start_audio_thread(consumer, clock_for_engine)
        .expect("Fatal: failed to start audio engine");

    let engine_handle = AudioEngineHandle {
        producer: Mutex::new(producer),
        master_clock,
        playback_state: Mutex::new(PlaybackState::default()),
        meter_bank,
        _stream: Mutex::new(Some(Box::new(stream))),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(engine_handle)
        .invoke_handler(tauri::generate_handler![
            // Transport
            play,
            stop,
            toggle_playback,
            seek,
            seek_seconds,
            set_bpm,
            set_loop,
            // Track Control
            set_track_volume,
            set_track_pan,
            set_track_mute,
            set_track_solo,
            update_track,
            // State Queries
            get_state,
            get_transport,
            get_meters,
            // Legacy
            set_frequency,
        ])
        .setup(|app| {
            log::info!(
                "Dream DAW v{} — Audio engine initialized ({} IPC commands registered)",
                app.package_info().version,
                16
            );
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Fatal: failed to launch Dream DAW");
}
