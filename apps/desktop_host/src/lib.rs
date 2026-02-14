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
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::collections::HashMap;

use arc_swap::ArcSwap;

use dream_clip_engine::pool::{ClipAudio, ClipPool};
use dream_engine::driver::{
    AutomationPoint, SharedAutomationSnapshot, SharedClipSnapshot, SharedRoutingSnapshot,
    TrackAutomationState,
};
use dream_engine::offline_bounce::{BounceConfig, OfflineBouncer};
use dream_engine::recording::RecordingSession;
use dream_io::audio_reader::AudioReader;
use dream_io::peak_cache::{PeakCache, WaveformPeaks};
use dream_io::project_file::ProjectFile;
use dream_io::project_manager::ProjectManager;
use dream_io::wav_writer::WavWriter;
use dream_plugins::{PluginDescriptor, PluginHost, PluginScanner};
use dream_plugins::format::{PluginCategory, PluginFormat};
use dream_ipc::metering::MeterBank;
use dream_ipc::{EngineCommand, MasterClock};
use dream_models::mutators::{self, MutatorError};
use dream_models::midi::{MidiClip, MidiNote, SamplerConfig};
use dream_models::project::{AudioClip, PluginSlot, Project, TimeSignature, Track, TrackColor, TrackType};
use dream_models::time::AbsoluteTime;
use dream_models::PlaybackState;
use tauri::{Manager, Emitter};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use midir::MidiInput;

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

    /// Preview buffer — interleaved stereo f32 samples for browser audition.
    preview_buffer: Arc<ArcSwap<Option<Vec<f32>>>>,

    /// Preview playback cursor (frame index × 2 for stereo interleaved).
    preview_cursor: Arc<std::sync::atomic::AtomicUsize>,

    /// Export cancel flag - set to true to abort offline bounce.
    pub export_cancel: Arc<std::sync::atomic::AtomicBool>,

    /// Shared clip pool snapshot (lock-free) for restarting audio stream.
    clip_pool: Arc<ArcSwap<ClipPool>>,
    clip_snapshot: Arc<SharedClipSnapshot>,
    midi_snapshot: Arc<dream_engine::driver::SharedMidiSnapshot>,
    routing_snapshot: Arc<SharedRoutingSnapshot>,
    automation_snapshot: Arc<SharedAutomationSnapshot>,
    sampler_samples: Arc<dream_engine::driver::SharedSamplerSamples>,
}

impl AudioEngineHandle {
    /// Load an interleaved stereo buffer for preview playback.
    /// Uses ArcSwap::store() — lock-free, never blocks the audio thread.
    fn set_preview_buffer(&self, buffer: Vec<f32>) {
        self.preview_cursor.store(0, std::sync::atomic::Ordering::SeqCst);
        self.preview_buffer.store(Arc::new(Some(buffer)));
    }

    /// Stop preview and discard the buffer.
    fn clear_preview_buffer(&self) {
        self.preview_buffer.store(Arc::new(None));
        self.preview_cursor.store(0, std::sync::atomic::Ordering::SeqCst);
    }
}

// ── Project State (managed by Tauri) ──────────────────────────────────



/// Structural-sharing snapshot of a project.
///
/// Track snapshots and clip payloads are shared via Arc between snapshots
/// so undo/redo does not deep-clone unchanged timeline data.
#[derive(Clone)]
struct SharedTrackSnapshot {
    id: Uuid,
    name: String,
    track_type: TrackType,
    clips: Vec<Arc<AudioClip>>,
    volume: f64,
    pan: f64,
    is_solo: bool,
    is_mute: bool,
    is_armed: bool,
    color: TrackColor,
    height: f64,
    output_destination_id: Option<Uuid>,
    effects: Vec<PluginSlot>,
    instrument: Option<PluginSlot>,
    parent_track_id: Option<Uuid>,
    child_track_ids: Vec<Uuid>,
    is_expanded: bool,
    midi_clips: Vec<MidiClip>,
    sampler: Option<SamplerConfig>,
    automation_lanes: Vec<dream_models::project::AutomationLane>,
}

impl SharedTrackSnapshot {
    fn from_track(track: &Track, prev: Option<&SharedTrackSnapshot>) -> Self {
        let mut clips = Vec::with_capacity(track.clips.len());
        for clip in &track.clips {
            let reused = prev.and_then(|previous| {
                previous
                    .clips
                    .iter()
                    .find(|p| p.id == clip.id && ***p == *clip)
                    .cloned()
            });
            clips.push(reused.unwrap_or_else(|| Arc::new(clip.clone())));
        }

        Self {
            id: track.id,
            name: track.name.clone(),
            track_type: track.track_type,
            clips,
            volume: track.volume,
            pan: track.pan,
            is_solo: track.is_solo,
            is_mute: track.is_mute,
            is_armed: track.is_armed,
            color: track.color,
            height: track.height,
            output_destination_id: track.output_destination_id,
            effects: track.effects.clone(),
            instrument: track.instrument.clone(),
            parent_track_id: track.parent_track_id,
            child_track_ids: track.child_track_ids.clone(),
            is_expanded: track.is_expanded,
            midi_clips: track.midi_clips.clone(),
            sampler: track.sampler.clone(),
            automation_lanes: track.automation_lanes.clone(),
        }
    }

    fn equals_track(&self, track: &Track) -> bool {
        self.id == track.id
            && self.name == track.name
            && self.track_type == track.track_type
            && self.volume == track.volume
            && self.pan == track.pan
            && self.is_solo == track.is_solo
            && self.is_mute == track.is_mute
            && self.is_armed == track.is_armed
            && self.color == track.color
            && self.height == track.height
            && self.output_destination_id == track.output_destination_id
            && self.effects == track.effects
            && self.instrument == track.instrument
            && self.parent_track_id == track.parent_track_id
            && self.child_track_ids == track.child_track_ids
            && self.is_expanded == track.is_expanded
            && self.midi_clips == track.midi_clips
            && self.sampler == track.sampler
            && self.automation_lanes == track.automation_lanes
            && self.clips.len() == track.clips.len()
            && self
                .clips
                .iter()
                .zip(track.clips.iter())
                .all(|(a, b)| **a == *b)
    }

    fn to_track(&self) -> Track {
        Track {
            id: self.id,
            name: self.name.clone(),
            track_type: self.track_type,
            clips: self.clips.iter().map(|c| (**c).clone()).collect(),
            volume: self.volume,
            pan: self.pan,
            is_solo: self.is_solo,
            is_mute: self.is_mute,
            is_armed: self.is_armed,
            color: self.color,
            height: self.height,
            output_destination_id: self.output_destination_id,
            effects: self.effects.clone(),
            instrument: self.instrument.clone(),
            parent_track_id: self.parent_track_id,
            child_track_ids: self.child_track_ids.clone(),
            is_expanded: self.is_expanded,
            midi_clips: self.midi_clips.clone(),
            sampler: self.sampler.clone(),
            automation_lanes: self.automation_lanes.clone(),
        }
    }
}

#[derive(Clone)]
struct SharedProjectSnapshot {
    id: Uuid,
    name: String,
    tracks: Vec<Arc<SharedTrackSnapshot>>,
    master_track: Arc<Track>,
    pulse_map: dream_models::pulse_map::PulseMap,
    sample_rate: f64,
    time_signature: TimeSignature,
    version: String,
    view_zoom_scale: Option<f64>,
    view_scroll_position: Option<f64>,
    view_browser_width: Option<f64>,
    playhead_position_frames: i64,
    is_looping: bool,
    loop_start_frames: Option<i64>,
    loop_end_frames: Option<i64>,
    key_sig_enabled: bool,
    key_sig_tonic: String,
    key_sig_mode: String,
}

impl SharedProjectSnapshot {
    fn from_project(project: &Project, prev: Option<&SharedProjectSnapshot>) -> Self {
        let prev_tracks = prev
            .map(|p| {
                p.tracks
                    .iter()
                    .map(|t| (t.id, t))
                    .collect::<std::collections::HashMap<Uuid, &Arc<SharedTrackSnapshot>>>()
            })
            .unwrap_or_default();

        let tracks = project
            .tracks
            .iter()
            .map(|track| {
                if let Some(previous) = prev_tracks.get(&track.id) {
                    if previous.equals_track(track) {
                        return (*previous).clone();
                    }
                    return Arc::new(SharedTrackSnapshot::from_track(track, Some(previous)));
                }
                Arc::new(SharedTrackSnapshot::from_track(track, None))
            })
            .collect();

        let master_track = if let Some(previous) = prev {
            if *previous.master_track == project.master_track {
                previous.master_track.clone()
            } else {
                Arc::new(project.master_track.clone())
            }
        } else {
            Arc::new(project.master_track.clone())
        };

        Self {
            id: project.id,
            name: project.name.clone(),
            tracks,
            master_track,
            pulse_map: project.pulse_map.clone(),
            sample_rate: project.sample_rate,
            time_signature: project.time_signature,
            version: project.version.clone(),
            view_zoom_scale: project.view_zoom_scale,
            view_scroll_position: project.view_scroll_position,
            view_browser_width: project.view_browser_width,
            playhead_position_frames: project.playhead_position_frames,
            is_looping: project.is_looping,
            loop_start_frames: project.loop_start_frames,
            loop_end_frames: project.loop_end_frames,
            key_sig_enabled: project.key_sig_enabled,
            key_sig_tonic: project.key_sig_tonic.clone(),
            key_sig_mode: project.key_sig_mode.clone(),
        }
    }

    fn to_project(&self) -> Project {
        Project {
            id: self.id,
            name: self.name.clone(),
            tracks: self.tracks.iter().map(|t| t.to_track()).collect(),
            master_track: (*self.master_track).clone(),
            pulse_map: self.pulse_map.clone(),
            sample_rate: self.sample_rate,
            time_signature: self.time_signature,
            version: self.version.clone(),
            view_zoom_scale: self.view_zoom_scale,
            view_scroll_position: self.view_scroll_position,
            view_browser_width: self.view_browser_width,
            playhead_position_frames: self.playhead_position_frames,
            is_looping: self.is_looping,
            loop_start_frames: self.loop_start_frames,
            loop_end_frames: self.loop_end_frames,
            key_sig_enabled: self.key_sig_enabled,
            key_sig_tonic: self.key_sig_tonic.clone(),
            key_sig_mode: self.key_sig_mode.clone(),
        }
    }
}

/// Undo/Redo history backed by structural-sharing snapshots.
struct UndoState {
    undo_stack: Vec<SharedProjectSnapshot>,
    redo_stack: Vec<SharedProjectSnapshot>,
}

impl UndoState {
    fn new() -> Self {
        Self {
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        }
    }
}

/// Maximum number of undo snapshots to retain.
const MAX_UNDO_DEPTH: usize = 100;

/// Thread-safe handle to the current project's state.
/// The project is independently managed from the audio engine.
/// Changes to the project trigger serialization and engine re-sync.
struct ProjectState {
    /// The currently loaded project.
    project: Mutex<Project>,

    /// Path to the current project file on disk. `None` if unsaved.
    file_path: Mutex<Option<PathBuf>>,

    /// Path to the project directory (Ableton-style folder). `None` if unsaved.
    project_folder: Mutex<Option<PathBuf>>,

    /// Whether the project has unsaved changes.
    is_dirty: Mutex<bool>,

    /// Undo/Redo history.
    undo: Mutex<UndoState>,
}

impl ProjectState {
    fn new() -> Self {
        Self {
            project: Mutex::new(Project::default()),
            file_path: Mutex::new(None),
            project_folder: Mutex::new(None),
            is_dirty: Mutex::new(false),
            undo: Mutex::new(UndoState::new()),
        }
    }

    /// Marks the project as dirty and updates the window title with a `*` suffix.
    ///
    /// This is the single choke-point for every mutation that makes the project
    /// "unsaved". The caller must supply the project name (to avoid a double-lock
    /// on `self.project` when the caller already holds it) and an optional
    /// `AppHandle` to update the native title bar.
    fn mark_dirty(&self, project_name: &str, app: Option<&tauri::AppHandle>) -> Result<(), String> {
        let mut dirty = self.is_dirty.lock().map_err(|e| e.to_string())?;
        let was_dirty = *dirty;
        *dirty = true;
        // Only update the title if transitioning from clean → dirty
        if !was_dirty
            && let Some(app) = app
            && let Some(window) = app.get_webview_window("main")
        {
            let _ = window.set_title(&format!("Dream DAW — {}*", project_name));
        }
        Ok(())
    }

    /// Clears the dirty flag and updates the window title (removes `*`).
    #[allow(dead_code)]
    fn clear_dirty(&self, project_name: &str, app: Option<&tauri::AppHandle>) -> Result<(), String> {
        *self.is_dirty.lock().map_err(|e| e.to_string())? = false;
        if let Some(app) = app
            && let Some(window) = app.get_webview_window("main")
        {
            let _ = window.set_title(&format!("Dream DAW — {}", project_name));
        }
        Ok(())
    }
}

/// Snapshots the current project state onto the undo stack.
///
/// Must be called BEFORE any mutation. Clears the redo stack
/// (a new action invalidates the redo history).
fn push_undo(project_state: &ProjectState) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut undo = project_state.undo.lock().map_err(|e| e.to_string())?;
    let previous = undo.undo_stack.last();
    let snapshot = SharedProjectSnapshot::from_project(&project, previous);
    drop(project);
    undo.undo_stack.push(snapshot);
    if undo.undo_stack.len() > MAX_UNDO_DEPTH {
        undo.undo_stack.remove(0);
    }
    undo.redo_stack.clear();
    Ok(())
}

fn refresh_offline_flags(project: &mut Project) {
    for track in &mut project.tracks {
        for clip in &mut track.clips {
            clip.is_offline = !PathBuf::from(&clip.file_path).exists();
        }
    }
}

fn rebuild_automation_snapshot_from_project(
    project: &Project,
    automation_runtime: &AutomationRuntime,
) {
    fn is_track_pan_param(key: &str) -> bool {
        matches!(key, "pan" | "track.pan" | "mixer.pan")
    }

    fn is_track_volume_param(key: &str) -> bool {
        matches!(key, "volume" | "gain" | "track.volume" | "track.gain" | "mixer.gain")
    }

    fn canonical_plugin_param(key: &str) -> Option<&'static str> {
        match key {
            "plugin.gain" | "plugin/gain" | "fx.gain" | "fx/gain" => Some("__plugin_gain__"),
            "plugin.pan" | "plugin/pan" | "fx.pan" | "fx/pan" => Some("__plugin_pan__"),
            _ => None,
        }
    }

    let mut lanes = vec![TrackAutomationState::default(); project.tracks.len()];

    for (track_idx, track) in project.tracks.iter().enumerate() {
        let mut state = TrackAutomationState::default();
        for lane in &track.automation_lanes {
            let key = lane.param_id.to_lowercase();
            let mut points: Vec<AutomationPoint> = lane
                .points
                .iter()
                .map(|p| AutomationPoint {
                    sample_frame: project.pulse_map.sample_frame(p.beat.max(0.0)),
                    value: p.value as f32,
                })
                .collect();
            points.sort_by_key(|p| p.sample_frame);

            if is_track_pan_param(&key) {
                for p in &mut points {
                    p.value = (p.value * 2.0 - 1.0).clamp(-1.0, 1.0);
                }
                state.pan = points;
            } else if is_track_volume_param(&key) {
                for p in &mut points {
                    p.value = p.value.clamp(0.0, 2.0);
                }
                state.volume = points;
            } else if !points.is_empty() {
                if let Some(alias) = canonical_plugin_param(&key) {
                    state.plugin_params.insert(alias.to_string(), points.clone());
                }
                state.plugin_params.insert(lane.param_id.clone(), points);
            }
        }
        lanes[track_idx] = state;
    }

    automation_runtime.snapshot.swap(lanes);
}

fn rebuild_midi_snapshot_from_project(project: &Project, handle: &AudioEngineHandle) {
    let clips_per_track: Vec<Vec<MidiClip>> = project
        .tracks
        .iter()
        .map(|track| track.midi_clips.clone())
        .collect();
    handle.midi_snapshot.swap(clips_per_track);
}

fn rebuild_sampler_snapshot_from_project(
    project: &Project,
    clip_pool_state: &ClipPoolState,
    handle: &AudioEngineHandle,
) {
    let mut samples: Vec<Option<Arc<ClipAudio>>> = vec![None; project.tracks.len()];
    if let Ok(pool) = clip_pool_state.pool.lock() {
        for (idx, track) in project.tracks.iter().enumerate() {
            if let Some(cfg) = &track.sampler
                && !cfg.sample_path.trim().is_empty()
                && let Some(audio) = pool.get(&cfg.sample_path)
            {
                samples[idx] = Some(audio);
            }
        }
    }
    handle.sampler_samples.swap(samples);
}

fn sync_transport_from_project(project: &Project, handle: &AudioEngineHandle) -> Result<(), String> {
    let bpm = project.pulse_map.initial_bpm();
    let loop_enabled = project.is_looping;
    let loop_start = project.loop_start_frames.unwrap_or(0);
    let loop_end = project.loop_end_frames.unwrap_or(0);
    let playhead = project.playhead_position_frames.max(0);

    // Keep UI mirror state in sync.
    {
        let mut state = handle.playback_state.lock().map_err(|e| e.to_string())?;
        state.bpm = bpm;
        state.loop_enabled = loop_enabled;
        state.loop_start = loop_start;
        state.loop_end = loop_end;
        // Project load/new always starts from stopped transport.
        state.is_playing = false;
    }

    // Keep realtime transport in sync.
    push_command(handle, EngineCommand::SetPlay(false))?;
    push_command(handle, EngineCommand::SetBpm(bpm))?;
    if loop_enabled && loop_end > loop_start {
        push_command(handle, EngineCommand::SetLoopRegion {
            start: loop_start,
            end: loop_end,
        })?;
    }
    push_command(handle, EngineCommand::SetLoopEnabled(loop_enabled))?;
    push_command(handle, EngineCommand::Seek(playhead))?;
    Ok(())
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

    /// ArcSwap-wrapped pool for lock-free audio thread access.
    arc_pool: Arc<ArcSwap<ClipPool>>,

    /// Atomic snapshot of per-track clips (lock-free audio thread access).
    snapshot: Arc<SharedClipSnapshot>,

    /// Atomic snapshot of per-track routing destinations for DAG rendering.
    routing_snapshot: Arc<SharedRoutingSnapshot>,
}

impl ClipPoolState {
    fn new() -> Self {
        Self {
            pool: Arc::new(Mutex::new(ClipPool::new())),
            arc_pool: Arc::new(ArcSwap::from_pointee(ClipPool::new())),
            snapshot: Arc::new(SharedClipSnapshot::new()),
            routing_snapshot: Arc::new(SharedRoutingSnapshot::new()),
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

        let routing: Vec<Option<usize>> = project
            .tracks
            .iter()
            .map(|track| {
                track.output_destination_id.and_then(|dest_id| {
                    project
                        .tracks
                        .iter()
                        .position(|candidate| candidate.id == dest_id)
                })
            })
            .collect();
        self.routing_snapshot.swap(routing);

        // Sync decoded audio data to the lock-free ArcSwap pool
        // so the audio thread can read it without locks.
        self.sync_pool_to_arc();
    }

    /// Propagates the Mutex-guarded pool to the lock-free ArcSwap.
    ///
    /// Called after any pool mutation (import, delete, project load).
    /// `ClipPool::clone()` only bumps `Arc` refcounts — no audio data
    /// is copied, making this O(n) on pool size with negligible cost.
    fn sync_pool_to_arc(&self) {
        if let Ok(pool) = self.pool.lock() {
            let cloned = pool.clone();
            log::info!(
                "[ClipPool] synced {} entries ({:.1} MB) to audio thread",
                cloned.len(),
                cloned.total_memory_bytes() as f64 / (1024.0 * 1024.0),
            );
            self.arc_pool.store(Arc::new(cloned));
        } else {
            log::error!("[ClipPool] failed to lock pool for sync — audio thread pool stale");
        }
    }

    /// Loads (decodes) all audio files referenced by the project's tracks
    /// into the shared clip pool. Skips clips that are already loaded,
    /// have empty paths, or reference missing files.
    ///
    /// Called on project open/load to populate the pool for live playback.
    /// Decoding happens on the calling thread (Tauri command pool) — NOT
    /// the audio thread.
    fn load_project_clips(&self, project: &Project) {
        let mut pool = match self.pool.lock() {
            Ok(p) => p,
            Err(e) => {
                log::error!("[ClipPool] lock failed in load_project_clips: {e}");
                return;
            }
        };

        let mut loaded = 0usize;
        let mut skipped = 0usize;
        let mut failed = 0usize;

        let mut load_path = |source_path: &str| {
            if source_path.trim().is_empty() {
                return;
            }
            if pool.get(source_path).is_some() {
                skipped += 1;
                return;
            }
            let path = PathBuf::from(source_path);
            if !path.exists() {
                log::warn!("[ClipPool] file not found, skipping: '{}'", source_path);
                failed += 1;
                return;
            }
            match AudioReader::read(&path) {
                Ok(decoded) => {
                    pool.insert(ClipAudio {
                        source_path: source_path.to_string(),
                        channels: decoded.channels,
                        sample_rate: decoded.sample_rate,
                        num_frames: decoded.num_frames,
                    });
                    loaded += 1;
                }
                Err(e) => {
                    log::error!("[ClipPool] decode failed for '{}': {e}", source_path);
                    failed += 1;
                }
            }
        };

        for track in &project.tracks {
            for clip in &track.clips {
                load_path(&clip.file_path);
            }
            if let Some(sampler) = &track.sampler {
                load_path(&sampler.sample_path);
            }
        }

        // Release the lock before sync
        drop(pool);

        log::info!(
            "[ClipPool] load_project_clips: loaded={}, skipped={}, failed={}",
            loaded, skipped, failed
        );

        // Push to the audio thread's lock-free ArcSwap
        self.sync_pool_to_arc();
    }
}

/// Runtime state for live recording sessions.
struct RecordingRuntime {
    session: Mutex<Option<RecordingSession>>,
    armed_track_index: Mutex<Option<usize>>,
}

/// Runtime automation snapshot shared with the audio thread.
struct AutomationRuntime {
    snapshot: Arc<SharedAutomationSnapshot>,
}

impl AutomationRuntime {
    fn new() -> Self {
        Self {
            snapshot: Arc::new(SharedAutomationSnapshot::new()),
        }
    }
}

/// Runtime MIDI input connection state.
struct MidiInputRuntime {
    connection: Mutex<Option<midir::MidiInputConnection<()>>>,
    connected_port: Mutex<Option<String>>,
}

impl MidiInputRuntime {
    fn new() -> Self {
        Self {
            connection: Mutex::new(None),
            connected_port: Mutex::new(None),
        }
    }
}

/// Runtime plugin host state for native VST instance lifecycle.
struct PluginHostState {
    host: Mutex<PluginHost>,
    loaded_by_key: Mutex<HashMap<String, Uuid>>,
}

impl PluginHostState {
    fn new() -> Self {
        Self {
            host: Mutex::new(PluginHost::new(44100.0, 1024)),
            loaded_by_key: Mutex::new(HashMap::new()),
        }
    }

    fn resolve_descriptor(&self, plugin_id: &str) -> Result<PluginDescriptor, String> {
        let path = PathBuf::from(plugin_id);
        if path.exists() {
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Unknown VST")
                .to_string();
            return Ok(PluginDescriptor::new(
                name,
                "Unknown Vendor",
                PluginFormat::VST3,
                PluginCategory::Effect,
                path,
            ));
        }

        let scanner = PluginScanner::new();
        let all = scanner.scan_all();
        all.into_iter()
            .find(|desc| {
                desc.path.to_string_lossy() == plugin_id
                    || desc.name == plugin_id
                    || desc.id.to_string() == plugin_id
                    || desc
                        .unique_id
                        .as_ref()
                        .map(|u| u == plugin_id)
                        .unwrap_or(false)
            })
            .ok_or_else(|| format!("Plugin not found: {plugin_id}"))
    }
}

impl RecordingRuntime {
    fn new() -> Self {
        Self {
            session: Mutex::new(None),
            armed_track_index: Mutex::new(None),
        }
    }
}

// ── Application Settings State ────────────────────────────────────────

/// Persisted application settings.
///
/// Mirrors the Swift `AppSettings` — stored as `settings.json` in the
/// user folder's `User Info/` directory (matching Swift convention).
/// Path: `{user_folder_path}/User Info/settings.json`
///
/// Uses camelCase serialization to maintain compatibility with the
/// existing Swift-generated settings.json files.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    #[serde(default = "default_language")]
    language: String,
    #[serde(default = "default_startup_behavior")]
    startup_behavior: String,
    #[serde(default = "default_waveform_style")]
    waveform_style: String,
    #[serde(default = "default_driver_type")]
    driver_type: String,
    #[serde(default = "default_output_device", alias = "audioOutputDeviceUID")]
    output_device: String,
    #[serde(default = "default_input_device", alias = "audioInputDeviceUID")]
    input_device: String,
    #[serde(default = "default_sample_rate", alias = "audioSampleRate")]
    sample_rate: u32,
    #[serde(default = "default_buffer_size", alias = "audioBufferSize")]
    buffer_size: u32,
    #[serde(default)]
    driver_error_compensation: f64,
    #[serde(default)]
    test_tone_enabled: bool,
    #[serde(default = "default_test_tone_volume")]
    test_tone_volume: f64,
    #[serde(default = "default_test_tone_frequency")]
    test_tone_frequency: f64,
    #[serde(default, alias = "cpuUsageSimulator")]
    cpu_usage_simulator: bool,
    #[serde(default = "default_true", alias = "srPitchConversionHighQuality")]
    sr_pitch_conversion: bool,
    #[serde(default = "default_user_folder", alias = "userFolderPath")]
    user_folder_path: String,
    /// User-added folders shown in the browser PLACES section.
    #[serde(default, alias = "browserFolders")]
    browser_folders: Vec<String>,
    #[serde(default = "default_samples_path", alias = "samplesPath")]
    samples_path: String,
    #[serde(default = "default_vst2_path", alias = "vst2Path")]
    vst2_path: String,
    #[serde(default = "default_vst3_path", alias = "vst3Path")]
    vst3_path: String,
}

fn default_language() -> String { "English".into() }
fn default_startup_behavior() -> String { "new".into() }
fn default_waveform_style() -> String { "colored".into() }
fn default_driver_type() -> String { "CoreAudio".into() }
fn default_output_device() -> String { "Default Output".into() }
fn default_input_device() -> String { "Default Input".into() }
fn default_sample_rate() -> u32 { 44100 }
fn default_buffer_size() -> u32 { 512 }
fn default_test_tone_volume() -> f64 { -20.0 }
fn default_test_tone_frequency() -> f64 { 440.0 }
fn default_true() -> bool { true }
fn default_user_folder() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    home.join("Music").join("Dream DAW").display().to_string()
}
fn default_samples_path() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    home.join("Music").join("Dream DAW").join("Samples").display().to_string()
}
fn default_vst2_path() -> String { "/Library/Audio/Plug-Ins/VST".into() }
fn default_vst3_path() -> String { "/Library/Audio/Plug-Ins/VST3".into() }

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
            browser_folders: Vec::new(),
        }
    }
}

impl AppSettings {
    /// Returns the path to the User Info directory for the current user folder.
    fn user_info_dir(&self) -> PathBuf {
        PathBuf::from(&self.user_folder_path).join("User Info")
    }

    /// Returns the path to the settings.json file in the User Info directory.
    fn settings_file_path(&self) -> PathBuf {
        self.user_info_dir().join("settings.json")
    }
}

/// Thread-safe settings state.
struct SettingsState {
    settings: Mutex<AppSettings>,
}

impl SettingsState {
    /// Load settings from disk using the Swift-compatible pattern:
    /// 1. Try `{user_folder_path}/User Info/settings.json` (primary)
    /// 2. Try `{app_data_dir}/settings.json` (legacy/fallback)
    /// 3. Fall back to defaults
    fn load_from_disk(app_data_dir: &std::path::Path) -> Self {
        // First build defaults to get the default user_folder_path
        let defaults = AppSettings::default();
        let user_info_path = defaults.settings_file_path();

        // Primary: load from user folder's User Info directory
        if user_info_path.exists()
            && let Ok(json) = std::fs::read_to_string(&user_info_path)
            && let Ok(settings) = serde_json::from_str::<AppSettings>(&json)
        {
            log::info!("Settings loaded from: {}", user_info_path.display());
            return Self { settings: Mutex::new(settings) };
        }

        // Fallback: load from app_data_dir (legacy Tauri location)
        let legacy_path = app_data_dir.join("settings.json");
        if legacy_path.exists()
            && let Ok(json) = std::fs::read_to_string(&legacy_path)
            && let Ok(settings) = serde_json::from_str::<AppSettings>(&json)
        {
            log::info!("Settings loaded from legacy path: {}", legacy_path.display());
            // Migrate: save to user folder and clean up
            let state = Self { settings: Mutex::new(settings) };
            if let Err(e) = state.save_to_user_folder() {
                log::warn!("Failed to migrate settings: {}", e);
            }
            return state;
        }

        log::info!("No settings found, using defaults");
        Self { settings: Mutex::new(defaults) }
    }

    /// Save settings to `{user_folder_path}/User Info/settings.json`.
    /// Creates the directory structure if it doesn't exist.
    fn save_to_user_folder(&self) -> Result<(), String> {
        let settings = self.settings.lock().map_err(|e| e.to_string())?;
        let user_info_dir = settings.user_info_dir();
        let settings_path = settings.settings_file_path();

        std::fs::create_dir_all(&user_info_dir)
            .map_err(|e| format!("Failed to create User Info dir: {}", e))?;

        let json = serde_json::to_string_pretty(&*settings)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;
        std::fs::write(&settings_path, &json)
            .map_err(|e| format!("Failed to write settings: {}", e))?;

        log::info!("Settings saved to: {}", settings_path.display());
        Ok(())
    }

    /// When the user_folder_path changes, migrate settings.json to the new location.
    fn migrate_to_new_folder(&self, old_path: &str, new_path: &str) -> Result<(), String> {
        let old_settings_file = PathBuf::from(old_path).join("User Info").join("settings.json");
        let new_user_info_dir = PathBuf::from(new_path).join("User Info");
        let new_settings_file = new_user_info_dir.join("settings.json");

        // Create new User Info directory
        std::fs::create_dir_all(&new_user_info_dir)
            .map_err(|e| format!("Failed to create new User Info dir: {}", e))?;

        // Copy old settings if they exist
        if old_settings_file.exists() && !new_settings_file.exists() {
            std::fs::copy(&old_settings_file, &new_settings_file)
                .map_err(|e| format!("Failed to copy settings: {}", e))?;
            log::info!("Settings migrated from {} to {}", old_settings_file.display(), new_settings_file.display());
        }

        // Now save current state to the new location
        self.save_to_user_folder()?;
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
    position_beats: f64,
    bpm: f64,
    sample_rate: f64,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddPluginToTrackPayload {
    track_id: String,
    plugin_id: String,
    plugin_name: String,
    slot: String, // "instrument" | "effect" | "auto"
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemovePluginFromTrackPayload {
    track_id: String,
    slot_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InternalPluginParamPayload {
    track_id: String,
    slot_id: String,
    param_id: String,
    value: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetSamplerSamplePayload {
    track_id: String,
    sample_path: String,
    root_note: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportSettingsPayload {
    output_path: String,
    sample_rate: u32,
    bit_depth: u16,
    range: String,
    normalize: bool,
    tail_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationPointPayload {
    beat: f64,
    value: f64,
    curve_type: String,
    tension: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutingTarget {
    track_id: String,
    track_name: String,
    track_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginEditorCapability {
    supported: bool,
    reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MidiInputPortInfo {
    name: String,
    connected: bool,
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

mod commands;

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
    let bootstrap_project = Project::default();
    clip_pool_state.rebuild_snapshot(&bootstrap_project);
    let clip_pool_for_engine = Arc::clone(&clip_pool_state.arc_pool);
    let snapshot_for_engine = Arc::clone(&clip_pool_state.snapshot);

    // Create shared MIDI snapshot and sampler sample state
    let midi_snapshot = Arc::new(dream_engine::driver::SharedMidiSnapshot::new());
    let automation_runtime = AutomationRuntime::new();
    let midi_input_runtime = MidiInputRuntime::new();
    rebuild_automation_snapshot_from_project(&bootstrap_project, &automation_runtime);
    let sampler_samples = Arc::new(dream_engine::driver::SharedSamplerSamples::new());
    let routing_snapshot_for_engine = Arc::clone(&clip_pool_state.routing_snapshot);
    let midi_snapshot_for_engine = Arc::clone(&midi_snapshot);
    let automation_snapshot_for_engine = Arc::clone(&automation_runtime.snapshot);
    let sampler_samples_for_engine = Arc::clone(&sampler_samples);
    let clip_pool_for_handle = Arc::clone(&clip_pool_state.arc_pool);
    let clip_snapshot_for_handle = Arc::clone(&clip_pool_state.snapshot);
    let midi_snapshot_for_handle = Arc::clone(&midi_snapshot);
    let routing_snapshot_for_handle = Arc::clone(&clip_pool_state.routing_snapshot);
    let automation_snapshot_for_handle = Arc::clone(&automation_runtime.snapshot);
    let sampler_samples_for_handle = Arc::clone(&sampler_samples);

    // Create preview buffer Arcs (shared between engine handle and audio driver)
    let preview_buffer: Arc<ArcSwap<Option<Vec<f32>>>> = Arc::new(ArcSwap::from_pointee(None));
    let preview_cursor: Arc<std::sync::atomic::AtomicUsize> = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let preview_buffer_for_engine = Arc::clone(&preview_buffer);
    let preview_cursor_for_engine = Arc::clone(&preview_cursor);

    // Start the audio engine on a dedicated thread
    let clock_for_engine = Arc::clone(&master_clock);
    let meter_for_engine = Arc::clone(&meter_bank);
    let stream = dream_engine::driver::start_audio_thread(
        consumer,
        clock_for_engine,
        meter_for_engine,
        clip_pool_for_engine,
        snapshot_for_engine,
        midi_snapshot_for_engine,
        routing_snapshot_for_engine,
        automation_snapshot_for_engine,
        sampler_samples_for_engine,
        preview_buffer_for_engine,
        preview_cursor_for_engine,
    )
    .expect("Fatal: failed to start audio engine");

    let engine_handle = AudioEngineHandle {
        producer: Mutex::new(producer),
        master_clock,
        playback_state: Mutex::new(PlaybackState::default()),
        meter_bank,
        _stream: Mutex::new(Some(Box::new(stream))),
        preview_buffer,
        preview_cursor,
        export_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        clip_pool: clip_pool_for_handle,
        clip_snapshot: clip_snapshot_for_handle,
        midi_snapshot: midi_snapshot_for_handle,
        routing_snapshot: routing_snapshot_for_handle,
        automation_snapshot: automation_snapshot_for_handle,
        sampler_samples: sampler_samples_for_handle,
    };

    // Load settings from user folder (primary) or app_data_dir (fallback)
    let app_data_dir_for_settings = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.dreamdaw.desktop");
    let settings_state = SettingsState::load_from_disk(&app_data_dir_for_settings);

    // Ensure User Info directory and initial settings.json exist
    if let Err(e) = settings_state.save_to_user_folder() {
        log::warn!("Failed to create initial settings file: {}", e);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(engine_handle)
        .manage(ProjectState::new())
        .manage(clip_pool_state)
        .manage(settings_state)
        .manage(RecordingRuntime::new())
        .manage(automation_runtime)
        .manage(midi_input_runtime)
        .manage(PluginHostState::new())
        .invoke_handler(tauri::generate_handler![
            // Transport
            commands::play,
            commands::stop,
            commands::toggle_playback,
            commands::seek,
            commands::seek_seconds,
            commands::seek_to_beat,
            commands::set_bpm,
            commands::set_loop,
            // Track Control
            commands::set_track_volume,
            commands::set_track_pan,
            commands::set_master_volume,
            commands::set_track_mute,
            commands::set_track_solo,
            commands::update_track,
            // State Queries
            commands::get_state,
            commands::get_transport,
            commands::get_meters,
            // Project Management
            commands::new_project,
            commands::save_project,
            commands::save_project_as,
            commands::open_project,
            commands::get_recent_projects,
            commands::get_project,
            commands::get_project_status,
            // Settings
            commands::get_settings,
            commands::update_settings,
            commands::get_samples_path,
            // File Browser
            commands::generate_demo_samples_cmd,
            commands::scan_audio_folder,
            commands::scan_all_audio_sources,
            commands::scan_folder_all,
            commands::scan_plugin_folders,
            commands::get_browser_folders,
            commands::add_browser_folder,
            commands::remove_browser_folder,
            commands::preview_audio_file_cmd,
            commands::stop_preview_cmd,
            commands::pick_folder,
            commands::pick_project_file,
            commands::save_project_dialog,
            // Splash
            commands::expand_window,
            // Legacy
            commands::set_frequency,
            // Audio Import
            commands::import_audio_file,
            commands::create_midi_clip_cmd,
            commands::update_midi_clip_cmd,
            // Waveform
            commands::get_waveform_peaks,
            // Track Management
            commands::add_track_cmd,
            commands::delete_track_cmd,
            commands::rename_track_cmd,
            // Clip Editing
            commands::move_clip_cmd,
            commands::split_clip_cmd,
            commands::duplicate_clip_cmd,
            commands::merge_clips_cmd,
            commands::delete_clip_cmd,
            commands::set_clip_fades_cmd,
            commands::set_clip_source_offset_cmd,
            commands::resolve_missing_file_cmd,
            // Automation / recording / export
            commands::set_automation_points_cmd,
            commands::arm_track_cmd,
            commands::start_recording_cmd,
            commands::stop_recording_cmd,
            commands::export_mix_cmd,
            commands::cancel_export_cmd,
            // Undo/Redo
            commands::undo_cmd,
            commands::redo_cmd,
            // Audio Device Management
            commands::get_audio_devices,
            commands::set_audio_device,
            commands::restart_audio_engine,
            // MIDI input
            commands::get_midi_inputs,
            commands::connect_midi_input,
            // Epic 2: plugin windows + routing
            commands::open_plugin_window,
            commands::can_open_plugin_editor,
            commands::close_plugin_window,
            commands::log_frontend_error,
            commands::get_routing_targets,
            commands::set_track_routing_cmd,
            commands::set_track_input_cmd,
            commands::add_plugin_to_track_cmd,
            commands::remove_plugin_from_track_cmd,
            commands::set_internal_plugin_param_cmd,
            commands::set_sampler_sample_cmd,
            // Device Chain
            commands::add_device_cmd,
            commands::remove_device_cmd,
            commands::bypass_device_cmd,
            commands::set_device_param_cmd,
            // Project Management (extended)
            commands::create_backup_cmd,
            commands::mark_dirty_cmd,
            commands::sync_title_cmd,
        ])
        .setup(|app| {
            // ── Telemetry Push Thread (30fps) ─────────────────────────
            // Replaces frontend requestAnimationFrame polling with
            // server-pushed events. Zero invoke() overhead per frame.
            let telemetry_app = app.handle().clone();

            std::thread::Builder::new()
                .name("telemetry-push".into())
                .spawn(move || {
                    loop {
                        std::thread::sleep(Duration::from_millis(33)); // ~30fps

                        // Access managed state via cloned AppHandle
                        let handle: tauri::State<'_, AudioEngineHandle> = telemetry_app.state();

                        // Build transport snapshot
                        let transport_json = {
                            let state = match handle.playback_state.lock() {
                                Ok(s) => s,
                                Err(_) => continue,
                            };
                            let frames = handle.master_clock.position();
                            let seconds = frames as f64 / state.sample_rate;
                            serde_json::json!({
                                "is_playing": state.is_playing,
                                "position_frames": frames,
                                "position_seconds": seconds,
                                "bpm": state.bpm,
                                "loop_enabled": state.loop_enabled,
                                "loop_start": state.loop_start,
                                "loop_end": state.loop_end,
                            })
                        };

                        // Build meter snapshot (lock-free reads)
                        let meter_bank = &handle.meter_bank;
                        let mut tracks = Vec::with_capacity(meter_bank.track_count());
                        for i in 0..meter_bank.track_count() {
                            if let Some((left, right)) = meter_bank.track(i) {
                                tracks.push(serde_json::json!([
                                    { "rms": left.load_rms(), "peak": left.load_peak(), "clipping": left.is_clipping() },
                                    { "rms": right.load_rms(), "peak": right.load_peak(), "clipping": right.is_clipping() },
                                ]));
                            }
                        }

                        let meters_json = serde_json::json!({
                            "tracks": tracks,
                            "master_left": {
                                "rms": meter_bank.master_left().load_rms(),
                                "peak": meter_bank.master_left().load_peak(),
                                "clipping": meter_bank.master_left().is_clipping(),
                            },
                            "master_right": {
                                "rms": meter_bank.master_right().load_rms(),
                                "peak": meter_bank.master_right().load_peak(),
                                "clipping": meter_bank.master_right().is_clipping(),
                            },
                        });

                        let payload = serde_json::json!({
                            "transport": transport_json,
                            "meters": meters_json,
                        });

                        // Emit to all webviews (fire-and-forget)
                        let _ = telemetry_app.emit("telemetry_tick", payload);
                    }
                })
                .expect("Failed to spawn telemetry thread");

            log::info!(
                "Dream DAW v{} — Audio engine initialized ({} IPC commands registered)",
                app.package_info().version,
                33
            );
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Fatal: failed to launch Dream DAW");
}
