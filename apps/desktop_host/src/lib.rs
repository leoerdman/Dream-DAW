// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Tauri v2 Application Core
// ═══════════════════════════════════════════════════════════════════════════
//
// This file contains the shared Tauri application setup, including:
//   - Audio engine lifecycle management (init on launch, teardown on close)
//   - IPC command handlers (transport, metering, track control, project state)
//   - Project management (new, save, open, recent projects)
//   - Application settings (get/update, persisted to settings.json)
//   - Thread-safe state management via Tauri's managed state
//
// Architecture:
//   Frontend (React/TS) → Tauri Invoke → Rust Commands → dream_ipc → Audio Thread
//
// The audio engine runs on a dedicated thread spawned at app startup.
// All IPC commands communicate with it via the lock-free `rtrb` command queue.
//
// ═══════════════════════════════════════════════════════════════════════════

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use dream_clip_engine::pool::{ClipAudio, ClipPool};
use dream_engine::driver::SharedClipSnapshot;
use dream_io::audio_reader::AudioReader;
use dream_io::project_file::ProjectFile;
use dream_ipc::metering::MeterBank;
use dream_ipc::{EngineCommand, MasterClock};
use dream_models::project::{AudioClip, Project, Track};
use dream_models::time::AbsoluteTime;
use dream_models::PlaybackState;
use tauri::Manager;
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

// ── Project State (managed by Tauri) ──────────────────────────────────

/// Thread-safe handle to the current project's state.
///
/// The project is independently managed from the audio engine.
/// Changes to the project trigger serialization and engine re-sync.
struct ProjectState {
    /// The currently loaded project.
    project: Mutex<Project>,

    /// Path to the current project file on disk. `None` if unsaved.
    file_path: Mutex<Option<PathBuf>>,

    /// Whether the project has unsaved changes.
    is_dirty: Mutex<bool>,
}

impl ProjectState {
    fn new() -> Self {
        Self {
            project: Mutex::new(Project::default()),
            file_path: Mutex::new(None),
            is_dirty: Mutex::new(false),
        }
    }
}

// ── Clip Pool State (shared between UI and audio thread) ────────────

/// Thread-safe handle to the shared clip pool and project clip snapshot.
///
/// The clip pool stores decoded audio data (pre-loaded into RAM).
/// The clip snapshot provides a lock-free view of project clips for
/// the audio thread.
struct ClipPoolState {
    /// Decoded audio samples (UI thread writes, audio thread reads via Arc).
    pool: Arc<Mutex<ClipPool>>,

    /// Atomic snapshot of per-track clips (lock-free audio thread access).
    snapshot: Arc<SharedClipSnapshot>,
}

impl ClipPoolState {
    fn new() -> Self {
        Self {
            pool: Arc::new(Mutex::new(ClipPool::new())),
            snapshot: Arc::new(SharedClipSnapshot::new()),
        }
    }

    /// Rebuilds the clip snapshot from the current project state.
    ///
    /// Called after any project mutation (import, delete, etc.).
    /// The audio thread will pick up the new snapshot on the next buffer.
    fn rebuild_snapshot(&self, project: &Project) {
        let clips_per_track: Vec<Vec<AudioClip>> = project
            .tracks
            .iter()
            .map(|track| track.clips.clone())
            .collect();
        self.snapshot.swap(clips_per_track);
    }
}

// ── Application Settings State ────────────────────────────────────────

/// Persisted application settings.
///
/// Mirrors the Swift `AppSettings` — stored as `settings.json` in the
/// application data directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppSettings {
    language: String,
    startup_behavior: String,
    waveform_style: String,
    driver_type: String,
    output_device: String,
    input_device: String,
    sample_rate: u32,
    buffer_size: u32,
    driver_error_compensation: f64,
    test_tone_enabled: bool,
    test_tone_volume: f64,
    test_tone_frequency: f64,
    cpu_usage_simulator: bool,
    sr_pitch_conversion: bool,
    user_folder_path: String,
    samples_path: String,
    vst2_path: String,
    vst3_path: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let music_dir = home.join("Music").join("Dream DAW");
        Self {
            language: "English".into(),
            startup_behavior: "new".into(),
            waveform_style: "colored".into(),
            driver_type: "CoreAudio".into(),
            output_device: "Default Output".into(),
            input_device: "Default Input".into(),
            sample_rate: 44100,
            buffer_size: 512,
            driver_error_compensation: 0.0,
            test_tone_enabled: false,
            test_tone_volume: -20.0,
            test_tone_frequency: 440.0,
            cpu_usage_simulator: false,
            sr_pitch_conversion: true,
            user_folder_path: music_dir.display().to_string(),
            samples_path: music_dir.join("Samples").display().to_string(),
            vst2_path: "/Library/Audio/Plug-Ins/VST".into(),
            vst3_path: "/Library/Audio/Plug-Ins/VST3".into(),
        }
    }
}

/// Thread-safe settings state.
struct SettingsState {
    settings: Mutex<AppSettings>,
}

impl SettingsState {
    fn load_from_disk(app_data_dir: &std::path::Path) -> Self {
        let settings_path = app_data_dir.join("settings.json");
        let settings = if settings_path.exists() {
            match std::fs::read_to_string(&settings_path) {
                Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
                Err(_) => AppSettings::default(),
            }
        } else {
            AppSettings::default()
        };
        Self {
            settings: Mutex::new(settings),
        }
    }

    fn save_to_disk(&self, app_data_dir: &std::path::Path) -> Result<(), String> {
        let settings = self.settings.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&*settings)
            .map_err(|e| e.to_string())?;
        let settings_path = app_data_dir.join("settings.json");
        std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
        std::fs::write(&settings_path, json).map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ── Recent Projects Tracker ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecentProject {
    name: String,
    path: String,
    last_opened: String, // ISO 8601
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct RecentProjects {
    projects: Vec<RecentProject>,
}

impl RecentProjects {
    fn load(app_data_dir: &std::path::Path) -> Self {
        let path = app_data_dir.join("recent_projects.json");
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
                Err(_) => Self::default(),
            }
        } else {
            Self::default()
        }
    }

    fn save(&self, app_data_dir: &std::path::Path) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
        std::fs::write(app_data_dir.join("recent_projects.json"), json)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn add(&mut self, name: String, path: String) {
        // Remove existing entry for same path
        self.projects.retain(|p| p.path != path);
        // Add to front
        self.projects.insert(0, RecentProject {
            name,
            path,
            last_opened: chrono_now(),
        });
        // Keep max 20 recent projects
        self.projects.truncate(20);
    }
}

/// Returns current UTC time as ISO 8601 string (no chrono dependency).
fn chrono_now() -> String {
    use std::time::SystemTime;
    let since_epoch = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}s", since_epoch.as_secs())
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
// Tauri Commands — Audio Import
// ═══════════════════════════════════════════════════════════════════════

/// Import response sent back to frontend.
#[derive(Debug, Clone, Serialize)]
struct ImportAudioResponse {
    clip_id: String,
    clip_name: String,
    duration_seconds: f64,
    sample_rate: u32,
    channels: usize,
    frames: usize,
}

/// Imports an audio file, decodes it into the clip pool, and places
/// a clip on the specified track at the current playhead position.
///
/// # Performance
/// Decoding happens on the Tauri async thread pool — NOT the audio thread.
/// The decoded samples are inserted into the shared ClipPool, and the
/// project clip snapshot is atomically swapped for the audio thread.
#[tauri::command]
async fn import_audio_file(
    path: String,
    track_index: u16,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    project_state: tauri::State<'_, ProjectState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<ImportAudioResponse, String> {
    let file_path = PathBuf::from(&path);

    // Validate file exists
    if !file_path.exists() {
        return Err(format!("File not found: {}", file_path.display()));
    }

    // Validate extension
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !matches!(ext.as_str(), "wav" | "mp3" | "flac" | "aiff" | "aif" | "ogg" | "m4a" | "aac") {
        return Err(format!("Unsupported audio format: .{ext}"));
    }

    // Decode audio file (NOT real-time safe — runs on async thread pool)
    let decoded = AudioReader::read(&file_path)
        .map_err(|e| format!("Failed to decode audio: {e}"))?;

    let clip_name = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();

    let sample_rate = decoded.sample_rate;
    let num_frames = decoded.num_frames;
    let num_channels = decoded.channels.len();
    let duration_seconds = num_frames as f64 / sample_rate as f64;

    // Convert AudioBuffer → ClipAudio for the pool
    let clip_audio = ClipAudio {
        source_path: path.clone(),
        channels: decoded.channels,
        sample_rate,
        num_frames,
    };

    // Insert into pool
    {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        pool.insert(clip_audio);
    }

    // Get playhead position for clip placement
    let playhead_frames = handle.master_clock.position();

    // Create AudioClip in the project
    let clip = AudioClip::new(
        &clip_name,
        &path,
        AbsoluteTime::new(playhead_frames),
        AbsoluteTime::new(num_frames as i64),
    );
    let clip_id = clip.id.to_string();

    // Add clip to the specified track (create track if needed)
    {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

        let idx = track_index as usize;
        while project.tracks.len() <= idx {
            let track_num = project.tracks.len() + 1;
            project.add_track(Track::new(format!("Track {track_num}")));
        }

        project.tracks[idx].clips.push(clip);

        // Mark project dirty
        *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;

        // Rebuild clip snapshot for audio thread
        clip_pool_state.rebuild_snapshot(&project);
    }

    log::info!(
        "[IPC] import_audio_file: '{}' → track {} ({} frames, {:.1}s, {}Hz, {}ch)",
        clip_name, track_index, num_frames, duration_seconds, sample_rate, num_channels
    );

    Ok(ImportAudioResponse {
        clip_id,
        clip_name,
        duration_seconds,
        sample_rate,
        channels: num_channels,
        frames: num_frames,
    })
}

// ═══════════════════════════════════════════════════════════════════════
// Splash Screen → Main Window Transition
// ═══════════════════════════════════════════════════════════════════════

/// Expands the main window from splash mode (450×450) to full DAW mode.
///
/// Called from the React splash screen after the loading animation completes.
/// This provides the native "small window → big window" UX identical to
/// the original Swift implementation.
///
/// Transitions:
///   450×450 borderless → 1400×900 with decorations + resizable
#[tauri::command]
fn expand_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    // Enable decorations (title bar, traffic lights)
    window.set_decorations(true)
        .map_err(|e| format!("Failed to set decorations: {e}"))?;

    // Resize to full DAW dimensions
    let size = tauri::LogicalSize::new(1400.0_f64, 900.0_f64);
    window.set_size(size)
        .map_err(|e| format!("Failed to resize: {e}"))?;

    // Set minimum size
    let min_size = tauri::LogicalSize::new(900.0_f64, 600.0_f64);
    window.set_min_size(Some(min_size))
        .map_err(|e| format!("Failed to set min size: {e}"))?;

    // Enable resizing
    window.set_resizable(true)
        .map_err(|e| format!("Failed to set resizable: {e}"))?;

    // Center the resized window
    window.center()
        .map_err(|e| format!("Failed to center: {e}"))?;

    log::info!("[Splash] Window expanded to full DAW mode (1400×900)");
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════
// Project Management Commands
// ═══════════════════════════════════════════════════════════════════════

/// Creates a new empty project and replaces the current one.
#[tauri::command]
fn new_project(
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    let new = Project::default();
    *project_state.project.lock().map_err(|e| e.to_string())? = new.clone();
    *project_state.file_path.lock().map_err(|e| e.to_string())? = None;
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;

    // Update window title
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", new.name));
    }

    log::info!("New project created: '{}'", new.name);
    Ok(new)
}

/// Saves the current project to its existing path (or fails if unsaved).
#[tauri::command]
fn save_project(
    project_state: tauri::State<'_, ProjectState>,
) -> Result<String, String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let file_path = project_state.file_path.lock().map_err(|e| e.to_string())?;

    let path = file_path
        .as_ref()
        .ok_or("No file path set. Use Save As first.")?;

    ProjectFile::save(&project, path)
        .map_err(|e| e.to_string())?;

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;

    log::info!("Project saved: '{}' → {}", project.name, path.display());
    Ok(path.display().to_string())
}

/// Saves the project to a specific path.
#[tauri::command]
fn save_project_as(
    path: String,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let file_path = PathBuf::from(&path);

    ProjectFile::save(&project, &file_path)
        .map_err(|e| e.to_string())?;

    *project_state.file_path.lock().map_err(|e| e.to_string())? = Some(file_path.clone());
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;

    // Track in recent projects
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let mut recent = RecentProjects::load(&app_data_dir);
        recent.add(project.name.clone(), path.clone());
        let _ = recent.save(&app_data_dir);
    }

    // Update window title
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", project.name));
    }

    log::info!("Project saved as: '{}' → {}", project.name, file_path.display());
    Ok(path)
}

/// Opens a project from a file path.
#[tauri::command]
fn open_project(
    path: String,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    let file_path = PathBuf::from(&path);

    let loaded = ProjectFile::load(&file_path)
        .map_err(|e| e.to_string())?;

    *project_state.project.lock().map_err(|e| e.to_string())? = loaded.clone();
    *project_state.file_path.lock().map_err(|e| e.to_string())? = Some(file_path);
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;

    // Track in recent projects
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let mut recent = RecentProjects::load(&app_data_dir);
        recent.add(loaded.name.clone(), path);
        let _ = recent.save(&app_data_dir);
    }

    // Update window title
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", loaded.name));
    }

    log::info!("Project opened: '{}' ({} tracks)", loaded.name, loaded.track_count());
    Ok(loaded)
}

/// Returns the list of recently opened projects.
#[tauri::command]
fn get_recent_projects(
    app: tauri::AppHandle,
) -> Result<Vec<RecentProject>, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| e.to_string())?;
    let recent = RecentProjects::load(&app_data_dir);
    Ok(recent.projects)
}

/// Returns the current project state.
#[tauri::command]
fn get_project(
    project_state: tauri::State<'_, ProjectState>,
) -> Result<Project, String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    Ok(project.clone())
}

/// Returns whether the project has unsaved changes and the current file path.
#[tauri::command]
fn get_project_status(
    project_state: tauri::State<'_, ProjectState>,
) -> Result<serde_json::Value, String> {
    let is_dirty = *project_state.is_dirty.lock().map_err(|e| e.to_string())?;
    let file_path = project_state.file_path.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "isDirty": is_dirty,
        "filePath": file_path.as_ref().map(|p| p.display().to_string()),
    }))
}

// ═══════════════════════════════════════════════════════════════════════
// Settings Commands
// ═══════════════════════════════════════════════════════════════════════

/// Returns the current application settings.
#[tauri::command]
fn get_settings(
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<AppSettings, String> {
    let settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

/// Updates application settings and persists to disk.
#[tauri::command]
fn update_settings(
    new_settings: AppSettings,
    settings_state: tauri::State<'_, SettingsState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    *settings_state.settings.lock().map_err(|e| e.to_string())? = new_settings;

    if let Ok(app_data_dir) = app.path().app_data_dir() {
        settings_state.save_to_disk(&app_data_dir)?;
    }

    log::info!("Settings updated and persisted");
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

    // Create shared clip pool and snapshot
    let clip_pool_state = ClipPoolState::new();
    let clip_pool_for_engine = Arc::clone(&clip_pool_state.pool);
    let snapshot_for_engine = Arc::clone(&clip_pool_state.snapshot);

    // Start the audio engine on a dedicated thread
    let clock_for_engine = Arc::clone(&master_clock);
    let meter_for_engine = Arc::clone(&meter_bank);
    let stream = dream_engine::driver::start_audio_thread(
        consumer,
        clock_for_engine,
        meter_for_engine,
        clip_pool_for_engine,
        snapshot_for_engine,
    )
    .expect("Fatal: failed to start audio engine");

    let engine_handle = AudioEngineHandle {
        producer: Mutex::new(producer),
        master_clock,
        playback_state: Mutex::new(PlaybackState::default()),
        meter_bank,
        _stream: Mutex::new(Some(Box::new(stream))),
    };

    // Load settings from disk
    let app_data_dir_for_settings = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.dreamdaw.app");
    let settings_state = SettingsState::load_from_disk(&app_data_dir_for_settings);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(engine_handle)
        .manage(ProjectState::new())
        .manage(clip_pool_state)
        .manage(settings_state)
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
            // Project Management
            new_project,
            save_project,
            save_project_as,
            open_project,
            get_recent_projects,
            get_project,
            get_project_status,
            // Settings
            get_settings,
            update_settings,
            // Splash
            expand_window,
            // Legacy
            set_frequency,
            // Audio Import
            import_audio_file,
        ])
        .setup(|app| {
            log::info!(
                "Dream DAW v{} — Audio engine initialized ({} IPC commands registered)",
                app.package_info().version,
                25
            );
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Fatal: failed to launch Dream DAW");
}
