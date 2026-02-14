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
use rtrb;
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
        if !was_dirty {
            if let Some(app) = app {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title(&format!("Dream DAW — {}*", project_name));
                }
            }
        }
        Ok(())
    }

    /// Clears the dirty flag and updates the window title (removes `*`).
    fn clear_dirty(&self, project_name: &str, app: Option<&tauri::AppHandle>) -> Result<(), String> {
        *self.is_dirty.lock().map_err(|e| e.to_string())? = false;
        if let Some(app) = app {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&format!("Dream DAW — {}", project_name));
            }
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
            if let Some(cfg) = &track.sampler {
                if !cfg.sample_path.trim().is_empty() {
                    if let Some(audio) = pool.get(&cfg.sample_path) {
                        samples[idx] = Some(audio);
                    }
                }
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
        if user_info_path.exists() {
            if let Ok(json) = std::fs::read_to_string(&user_info_path) {
                if let Ok(settings) = serde_json::from_str::<AppSettings>(&json) {
                    log::info!("Settings loaded from: {}", user_info_path.display());
                    return Self { settings: Mutex::new(settings) };
                }
            }
        }

        // Fallback: load from app_data_dir (legacy Tauri location)
        let legacy_path = app_data_dir.join("settings.json");
        if legacy_path.exists() {
            if let Ok(json) = std::fs::read_to_string(&legacy_path) {
                if let Ok(settings) = serde_json::from_str::<AppSettings>(&json) {
                    log::info!("Settings loaded from legacy path: {}", legacy_path.display());
                    // Migrate: save to user folder and clean up
                    let state = Self { settings: Mutex::new(settings) };
                    if let Err(e) = state.save_to_user_folder() {
                        log::warn!("Failed to migrate settings: {}", e);
                    }
                    return state;
                }
            }
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

/// Seeks to a specific position in beats (uses current BPM + sample rate).
#[tauri::command]
fn seek_to_beat(
    beat: f64,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    let bpm = state.bpm;
    let sample_rate = state.sample_rate;
    drop(state);

    let seconds = beat * 60.0 / bpm;
    let frames = (seconds * sample_rate) as i64;
    push_command(&handle, EngineCommand::Seek(frames))?;
    log::info!("[IPC] seek_to_beat({beat:.4} beat → {frames} frames)");
    Ok(())
}

/// Sets the project tempo (BPM).
#[tauri::command]
fn set_bpm(
    bpm: f64,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
) -> Result<(), String> {
    if !(20.0..=999.0).contains(&bpm) {
        return Err(format!("BPM {bpm} out of range (20–999)"));
    }

    // Runtime transport BPM update for the audio thread.
    push_command(&handle, EngineCommand::SetBpm(bpm))?;

    // Snapshot undo BEFORE project mutation.
    push_undo(&project_state)?;

    // Persisted project retime: keep musical beat positions/durations invariant
    // while converting all sample-frame fields to the new tempo map.
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let old_pulse_map = project.pulse_map.clone();
    let mut new_pulse_map = old_pulse_map.clone();
    new_pulse_map.set_constant_tempo(bpm);
    let current_engine_frame = handle.master_clock.position().max(0);
    let current_engine_beat = old_pulse_map.beats(current_engine_frame);
    let remapped_engine_frame = new_pulse_map.sample_frame(current_engine_beat).max(0);

    let remap_frame = |frame: i64| -> i64 {
        let beat = old_pulse_map.beats(frame.max(0));
        new_pulse_map.sample_frame(beat).max(0)
    };

    for track in &mut project.tracks {
        for clip in &mut track.clips {
            let old_start = clip.position.sample_frame.max(0);
            let old_end = (old_start + clip.duration.sample_frame.max(1)).max(old_start + 1);
            let new_start = remap_frame(old_start);
            let new_end = remap_frame(old_end).max(new_start + 1);
            clip.position = AbsoluteTime::new(new_start);
            clip.duration = AbsoluteTime::new((new_end - new_start).max(1));
        }

        for clip in &mut track.midi_clips {
            let old_clip_start = clip.position.sample_frame.max(0);
            let old_clip_end = (old_clip_start + clip.duration.sample_frame.max(1)).max(old_clip_start + 1);
            let new_clip_start = remap_frame(old_clip_start);
            let new_clip_end = remap_frame(old_clip_end).max(new_clip_start + 1);
            let new_clip_duration = (new_clip_end - new_clip_start).max(1);

            for note in &mut clip.notes {
                let old_abs_start = (old_clip_start + note.start_frame.max(0)).max(old_clip_start);
                let old_abs_end = (old_abs_start + note.duration_frames.max(1)).max(old_abs_start + 1);
                let new_abs_start = remap_frame(old_abs_start);
                let new_abs_end = remap_frame(old_abs_end).max(new_abs_start + 1);

                let rel_start = (new_abs_start - new_clip_start).clamp(0, new_clip_duration - 1);
                let rel_end = (new_abs_end - new_clip_start).clamp(rel_start + 1, new_clip_duration);
                note.start_frame = rel_start;
                note.duration_frames = (rel_end - rel_start).max(1);
            }
            clip.notes.sort_by_key(|n| n.start_frame);
            clip.position = AbsoluteTime::new(new_clip_start);
            clip.duration = AbsoluteTime::new(new_clip_duration);
        }
    }

    // Persist transport/loop points in project domain.
    project.playhead_position_frames = remapped_engine_frame;
    let remapped_loop_start = project.loop_start_frames.map(remap_frame);
    let remapped_loop_end = project.loop_end_frames.map(remap_frame);
    match (remapped_loop_start, remapped_loop_end) {
        (Some(start), Some(end)) if end > start => {
            project.loop_start_frames = Some(start);
            project.loop_end_frames = Some(end);
        }
        _ => {
            project.loop_start_frames = remapped_loop_start;
            project.loop_end_frames = remapped_loop_end;
        }
    }

    project.pulse_map = new_pulse_map;

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    rebuild_automation_snapshot_from_project(&project, &automation_runtime);

    // Re-anchor realtime transport to the same musical beat after tempo change.
    push_command(&handle, EngineCommand::Seek(remapped_engine_frame))?;
    if let (Some(start), Some(end)) = (project.loop_start_frames, project.loop_end_frames) {
        if end > start {
            push_command(&handle, EngineCommand::SetLoopRegion { start, end })?;
        }
    }
    push_command(&handle, EngineCommand::SetLoopEnabled(project.is_looping))?;

    let mut state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    state.bpm = bpm;
    if let (Some(start), Some(end)) = (project.loop_start_frames, project.loop_end_frames) {
        if end > start {
            state.loop_start = start;
            state.loop_end = end;
            state.loop_enabled = project.is_looping;
        }
    }
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

/// Sets master output volume (linear gain 0.0–2.0).
#[tauri::command]
fn set_master_volume(
    volume: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let clamped = volume.clamp(0.0, 2.0);
    push_command(&handle, EngineCommand::SetMasterVolume { volume: clamped })?;
    log::debug!("[IPC] set_master_volume(vol={clamped})");
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

// ═══════════════════════════════════════════════════════════════════════
// Tauri Commands — Device Chain
// ═══════════════════════════════════════════════════════════════════════

/// Adds a built-in DSP device to a track's insert chain.
#[tauri::command]
fn add_device_cmd(
    track_index: u16,
    slot_index: u8,
    effect_type: u8,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(&handle, EngineCommand::AddDevice {
        track_index,
        slot_index,
        effect_type,
    })?;
    log::info!("[IPC] add_device(track={track_index}, slot={slot_index}, type={effect_type})");
    Ok(())
}

/// Removes a device from a track's insert chain.
#[tauri::command]
fn remove_device_cmd(
    track_index: u16,
    slot_index: u8,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(&handle, EngineCommand::RemoveDevice {
        track_index,
        slot_index,
    })?;
    log::info!("[IPC] remove_device(track={track_index}, slot={slot_index})");
    Ok(())
}

/// Bypasses or enables a device in a track's insert chain.
#[tauri::command]
fn bypass_device_cmd(
    track_index: u16,
    slot_index: u8,
    bypassed: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(&handle, EngineCommand::BypassDevice {
        track_index,
        slot_index,
        bypassed,
    })?;
    log::debug!("[IPC] bypass_device(track={track_index}, slot={slot_index}, bypassed={bypassed})");
    Ok(())
}

/// Sets a parameter on a device in a track's insert chain.
#[tauri::command]
fn set_device_param_cmd(
    track_index: u16,
    slot_index: u8,
    param_index: u8,
    value: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(&handle, EngineCommand::SetDeviceParam {
        track_index,
        slot_index,
        param_index,
        value,
    })?;
    log::debug!("[IPC] set_device_param(track={track_index}, slot={slot_index}, param={param_index}, val={value})");
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
    let sample_rate = state.sample_rate;
    let seconds = frames as f64 / sample_rate;
    let position_beats = seconds * state.bpm / 60.0;

    Ok(TransportState {
        is_playing: state.is_playing,
        position_frames: frames,
        position_seconds: seconds,
        position_beats,
        bpm: state.bpm,
        sample_rate,
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
    position_frames: Option<i64>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    project_state: tauri::State<'_, ProjectState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<ImportAudioResponse, String> {
    log::info!("[IPC] import_audio_file: path='{}' track={} pos={:?}", path, track_index, position_frames);
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

    // Snapshot for undo BEFORE mutation
    push_undo(&project_state)?;

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
    // Publish updated pool snapshot to audio thread
    {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        clip_pool_state.rebuild_snapshot(&project);
    }

    // Determine clip position: use provided drop position, or fall back to playhead
    let clip_position = match position_frames {
        Some(frames) => frames,
        None => handle.master_clock.position(),
    };

    // Create AudioClip in the project
    let clip = AudioClip::new(
        &clip_name,
        &path,
        AbsoluteTime::new(clip_position),
        AbsoluteTime::new(num_frames as i64),
    );
    let clip_id = clip.id.to_string();

    // Add clip to the specified track (create track if needed)
    {
        // Snapshot for undo BEFORE mutation
        push_undo(&project_state)?;

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
// MIDI Clip Creation
// ═══════════════════════════════════════════════════════════════════════

/// Response from creating a MIDI clip.
#[derive(Debug, Serialize, Deserialize)]
struct CreateMidiClipResponse {
    clip_id: String,
    clip_name: String,
    position_frames: i64,
    duration_frames: i64,
}

/// Creates an empty MIDI clip on a track at a specified position.
///
/// Used when the user double-clicks on a MIDI track to create a new
/// 1-bar (or N-bar) MIDI clip for note input.
#[tauri::command]
async fn create_midi_clip_cmd(
    track_index: u32,
    position_frames: i64,
    duration_frames: i64,
    name: Option<String>,
    project_state: tauri::State<'_, ProjectState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<CreateMidiClipResponse, String> {
    let clip_name = name.unwrap_or_else(|| "MIDI Clip".to_string());
    log::info!("[IPC] create_midi_clip_cmd: '{}' track={} pos={} dur={}", clip_name, track_index, position_frames, duration_frames);

    push_undo(&project_state)?;

    let clip = MidiClip::new(
        &clip_name,
        AbsoluteTime::new(position_frames),
        AbsoluteTime::new(duration_frames),
    );
    let clip_id = clip.id.to_string();

    {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

        let idx = track_index as usize;
        while project.tracks.len() <= idx {
            let track_num = project.tracks.len() + 1;
            project.add_track(Track::new(format!("Track {track_num}")));
        }

        project.tracks[idx].midi_clips.push(clip);

        *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
        rebuild_midi_snapshot_from_project(&project, &handle);
    }

    log::info!(
        "[IPC] create_midi_clip: '{}' → track {} @ frame {} ({} frames)",
        clip_name, track_index, position_frames, duration_frames
    );

    Ok(CreateMidiClipResponse {
        clip_id,
        clip_name,
        position_frames,
        duration_frames,
    })
}

#[derive(Debug, Clone, Deserialize)]
struct MidiNotePayload {
    pitch: u8,
    velocity: u8,
    start_frames: i64,
    duration_frames: i64,
}

/// Replace all notes in a MIDI clip.
#[tauri::command]
async fn update_midi_clip_cmd(
    clip_id: String,
    notes: Vec<MidiNotePayload>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut updated = false;

    for track in &mut project.tracks {
        if let Some(clip) = track.midi_clips.iter_mut().find(|c| c.id == uuid) {
            let clip_len = clip.duration.sample_frame.max(1);
            let mut normalized: Vec<MidiNote> = notes
                .iter()
                .map(|n| {
                    let start = n.start_frames.max(0).min(clip_len.saturating_sub(1));
                    let max_duration = (clip_len - start).max(1);
                    MidiNote::new(
                        n.pitch,
                        n.velocity,
                        start,
                        n.duration_frames.max(1).min(max_duration),
                    )
                })
                .collect();
            normalized.sort_by_key(|n| n.start_frame);
            clip.notes = normalized;
            updated = true;
            break;
        }
    }

    // Compatibility path:
    // migrate old "MIDI" clips that were historically written into audio clips with empty path.
    if !updated {
        for track in &mut project.tracks {
            if let Some(idx) = track
                .clips
                .iter()
                .position(|c| c.id == uuid && c.file_path.trim().is_empty())
            {
                let legacy = track.clips.remove(idx);
                let clip_len = legacy.duration.sample_frame.max(1);
                let mut normalized: Vec<MidiNote> = notes
                    .iter()
                    .map(|n| {
                        let start = n.start_frames.max(0).min(clip_len.saturating_sub(1));
                        let max_duration = (clip_len - start).max(1);
                        MidiNote::new(
                            n.pitch,
                            n.velocity,
                            start,
                            n.duration_frames.max(1).min(max_duration),
                        )
                    })
                    .collect();
                normalized.sort_by_key(|n| n.start_frame);

                track.midi_clips.push(MidiClip {
                    id: legacy.id,
                    name: legacy.name,
                    position: legacy.position,
                    duration: legacy.duration,
                    notes: normalized,
                    is_selected: false,
                });
                updated = true;
                break;
            }
        }
    }

    if !updated {
        return Err(format!("MIDI clip not found: {clip_id}"));
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════
// Waveform Peaks
// ═══════════════════════════════════════════════════════════════════════

/// Returns multi-resolution waveform peak data for a given audio file.
///
/// Peak data is generated from the decoded audio in the ClipPool.
/// The frontend uses this to draw high-performance canvas waveforms.
/// Returns 4 mip levels (256/1K/4K/16K samples-per-peak) for the
/// renderer to pick from based on the current zoom level.
#[tauri::command]
async fn get_waveform_peaks(
    file_path: String,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<WaveformPeaks, String> {
    let pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;

    let audio = pool
        .get(&file_path)
        .ok_or_else(|| format!("Audio not loaded: {file_path}"))?;

    // Convert stereo to mono for peak generation (average L+R)
    let left = audio.left();
    let right = audio.right();
    let mono: Vec<f32> = if right.is_empty() {
        left.to_vec()
    } else {
        left.iter()
            .zip(right.iter())
            .map(|(l, r)| (l + r) * 0.5)
            .collect()
    };

    let peaks = PeakCache::generate(&mono, &file_path, audio.sample_rate);

    log::info!(
        "[IPC] get_waveform_peaks: '{}' → {} samples, 4 mip levels",
        file_path,
        mono.len(),
    );

    Ok(peaks)
}

// ═══════════════════════════════════════════════════════════════════════
// Clip Mutator Commands
// ═══════════════════════════════════════════════════════════════════════

/// Response type for the split_clip command.
#[derive(Debug, Serialize, Deserialize)]
struct SplitClipResponse {
    left_id: String,
    right_id: String,
}

fn mutator_err_to_string(e: MutatorError) -> String {
    e.to_string()
}

fn move_midi_clip_in_project(
    project: &mut Project,
    clip_id: Uuid,
    new_track_index: usize,
    new_position: AbsoluteTime,
) -> bool {
    let mut extracted = None;
    for track in &mut project.tracks {
        if let Some(idx) = track.midi_clips.iter().position(|c| c.id == clip_id) {
            let mut clip = track.midi_clips.remove(idx);
            clip.position = new_position;
            extracted = Some(clip);
            break;
        }
    }

    let Some(clip) = extracted else {
        return false;
    };
    let target = &mut project.tracks[new_track_index];
    let insert_pos = target
        .midi_clips
        .binary_search_by(|c| c.position.cmp(&clip.position))
        .unwrap_or_else(|i| i);
    target.midi_clips.insert(insert_pos, clip);
    true
}

fn delete_midi_clip_in_project(project: &mut Project, clip_id: Uuid) -> bool {
    for track in &mut project.tracks {
        if let Some(idx) = track.midi_clips.iter().position(|c| c.id == clip_id) {
            track.midi_clips.remove(idx);
            return true;
        }
    }
    false
}

/// Moves a clip to a new track and/or position.
///
/// The clip is identified by UUID string. After mutation, the
/// clip snapshot is atomically rebuilt for the audio thread.
#[tauri::command]
async fn move_clip_cmd(
    clip_id: String,
    new_track_index: usize,
    new_position_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id)
        .map_err(|e| format!("Invalid clip ID: {e}"))?;

    // Snapshot for undo BEFORE mutation
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    if new_track_index >= project.tracks.len() {
        return Err(format!(
            "Track out of range: requested {} but project has {} tracks",
            new_track_index,
            project.tracks.len()
        ));
    }

    let new_position = AbsoluteTime::new(new_position_frames);
    if let Err(audio_err) = mutators::move_clip(&mut project, uuid, new_track_index, new_position) {
        // If this is not an audio clip, attempt MIDI clip move using same UUID.
        if !move_midi_clip_in_project(&mut project, uuid, new_track_index, new_position) {
            return Err(mutator_err_to_string(audio_err));
        }
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);

    Ok(())
}

/// Splits a clip at the given sample frame position.
///
/// Returns the UUIDs of the two resulting clips (left keeps original UUID).
/// Both halves preserve correct source_offset for seamless playback.
#[tauri::command]
async fn split_clip_cmd(
    clip_id: String,
    split_frame: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<SplitClipResponse, String> {
    let uuid = Uuid::parse_str(&clip_id)
        .map_err(|e| format!("Invalid clip ID: {e}"))?;

    // Snapshot for undo BEFORE mutation
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    let result = mutators::split_clip(&mut project, uuid, split_frame)
        .map_err(mutator_err_to_string)?;

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);

    Ok(SplitClipResponse {
        left_id: result.left_id.to_string(),
        right_id: result.right_id.to_string(),
    })
}

/// Deletes a clip from the project by UUID.
///
/// The removed clip data is returned for potential client-side undo.
#[tauri::command]
async fn delete_clip_cmd(
    clip_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id)
        .map_err(|e| format!("Invalid clip ID: {e}"))?;

    // Snapshot for undo BEFORE mutation
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    if let Err(audio_err) = mutators::delete_clip(&mut project, uuid) {
        // If this is not an audio clip, attempt MIDI clip delete using same UUID.
        if !delete_midi_clip_in_project(&mut project, uuid) {
            return Err(mutator_err_to_string(audio_err));
        }
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);

    Ok(())
}

/// Update a clip's source offset (slip editing).
#[tauri::command]
async fn set_clip_source_offset_cmd(
    clip_id: String,
    source_offset_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut updated = false;
    for track in &mut project.tracks {
        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == uuid) {
            clip.source_offset = AbsoluteTime::new(source_offset_frames.max(0));
            updated = true;
            break;
        }
    }

    if !updated {
        return Err(format!("Clip not found: {clip_id}"));
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    Ok(())
}

/// Set clip fades. Current engine applies always-on micro-fades; this command is
/// accepted for IPC compatibility with interactive UI fade handles.
#[tauri::command]
async fn set_clip_fades_cmd(
    clip_id: String,
    fade_in_frames: i64,
    fade_out_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut updated = false;
    for track in &mut project.tracks {
        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == uuid) {
            clip.fade_in_frames = fade_in_frames.max(0);
            clip.fade_out_frames = fade_out_frames.max(0);
            updated = true;
            break;
        }
    }

    if !updated {
        return Err(format!("Clip not found: {clip_id}"));
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);

    log::info!(
        "[IPC] set_clip_fades_cmd clip={} fade_in={} fade_out={}",
        clip_id,
        fade_in_frames.max(0),
        fade_out_frames.max(0)
    );
    Ok(())
}

/// Resolve offline media path for an existing clip.
#[tauri::command]
async fn resolve_missing_file_cmd(
    clip_id: String,
    new_path: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;
    if !PathBuf::from(&new_path).exists() {
        return Err(format!("Resolved file does not exist: {new_path}"));
    }

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut updated = false;
    for track in &mut project.tracks {
        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == uuid) {
            clip.file_path = new_path.clone();
            clip.is_offline = false;
            updated = true;
            break;
        }
    }
    if !updated {
        return Err(format!("Clip not found: {clip_id}"));
    }

    // Load resolved media into clip pool so playback recovers immediately.
    let decoded = AudioReader::read(PathBuf::from(&new_path))
        .map_err(|e| format!("Failed to decode resolved audio: {e}"))?;
    {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        pool.insert(ClipAudio {
            source_path: new_path.clone(),
            channels: decoded.channels,
            sample_rate: decoded.sample_rate,
            num_frames: decoded.num_frames,
        });
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    Ok(())
}

/// Accept automation points from frontend (throttled there to 16ms).
#[tauri::command]
async fn set_automation_points_cmd(
    track_id: String,
    param_id: String,
    points: Vec<AutomationPointPayload>,
    project_state: tauri::State<'_, ProjectState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track ID: {e}"))?;
    let normalized_param_id = param_id.trim().to_string();
    if normalized_param_id.is_empty() {
        return Err("Parameter ID cannot be empty".to_string());
    }
    push_undo(&project_state)?;
    {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        let track = project
            .tracks
            .iter_mut()
            .find(|t| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found: {track_id}"))?;

        let mut persistent_points: Vec<dream_models::project::AutomationPoint> = points
            .iter()
            .map(|p| dream_models::project::AutomationPoint {
                beat: p.beat.max(0.0),
                value: p.value,
                curve_type: p.curve_type.clone(),
                tension: p.tension,
            })
            .collect();
        persistent_points.sort_by(|a, b| a.beat.total_cmp(&b.beat));

        if let Some(existing) = track
            .automation_lanes
            .iter_mut()
            .find(|lane| lane.param_id.eq_ignore_ascii_case(&normalized_param_id))
        {
            existing.points = persistent_points;
            existing.param_id = normalized_param_id.clone();
        } else {
            track.automation_lanes.push(dream_models::project::AutomationLane {
                param_id: normalized_param_id.clone(),
                points: persistent_points,
            });
        }

        // Keep project clean: remove empty lanes.
        track.automation_lanes.retain(|lane| !lane.points.is_empty());

        *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
        rebuild_automation_snapshot_from_project(&project, &automation_runtime);
    }

    log::debug!(
        "[IPC] set_automation_points_cmd track={} param={} points={}",
        track_id,
        param_id,
        points.len()
    );
    Ok(())
}

/// Arm/disarm a track for recording.
#[tauri::command]
async fn arm_track_cmd(
    track_index: usize,
    armed: bool,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<(), String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .get_mut(track_index)
        .ok_or_else(|| format!("Track index out of range: {track_index}"))?;
    track.is_armed = armed;
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    Ok(())
}

/// Start live recording on the first armed track.
#[tauri::command]
async fn start_recording_cmd(
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    recording_runtime: tauri::State<'_, RecordingRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    if recording_runtime
        .session
        .lock()
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Err("Recording already in progress".to_string());
    }

    let armed_track_index = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        project
            .tracks
            .iter()
            .position(|t| t.is_armed)
            .ok_or_else(|| "No armed tracks".to_string())?
    };

    let output_dir = std::env::temp_dir().join("dream_daw_recordings");
    let start_frame = handle.master_clock.position();
    let file_name = format!("recording_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs());

    let session = RecordingSession::start(&output_dir, &file_name, start_frame)
        .map_err(|e| format!("start_recording failed: {e}"))?;

    let is_recording = Arc::clone(&session.state().is_recording);
    let peak_left = Arc::clone(&session.state().peak_left);
    let peak_right = Arc::clone(&session.state().peak_right);
    let app_for_peaks = app.clone();
    std::thread::spawn(move || {
        while is_recording.load(Ordering::Relaxed) {
            let left = f32::from_bits(peak_left.load(Ordering::Relaxed));
            let right = f32::from_bits(peak_right.load(Ordering::Relaxed));
            let payload = serde_json::json!({
                "track_index": armed_track_index,
                "peak": left.abs().max(right.abs()),
                "peaks": [left, right]
            });
            let _ = app_for_peaks.emit("live_audio_peaks", payload);
            std::thread::sleep(Duration::from_millis(16));
        }
    });

    *recording_runtime.session.lock().map_err(|e| e.to_string())? = Some(session);
    *recording_runtime
        .armed_track_index
        .lock()
        .map_err(|e| e.to_string())? = Some(armed_track_index);

    Ok(())
}

/// Stop recording, finalize file, and place resulting clip on armed track.
#[tauri::command]
async fn stop_recording_cmd(
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    recording_runtime: tauri::State<'_, RecordingRuntime>,
) -> Result<(), String> {
    let session = recording_runtime
        .session
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or_else(|| "No active recording session".to_string())?;

    let armed_idx = recording_runtime
        .armed_track_index
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or_else(|| "Missing armed track index".to_string())?;

    let result = session
        .stop()
        .map_err(|e| format!("stop_recording failed: {e}"))?;
    let path = result.file_path.display().to_string();

    let decoded = AudioReader::read(&result.file_path)
        .map_err(|e| format!("Failed to decode recorded file: {e}"))?;
    {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        pool.insert(ClipAudio {
            source_path: path.clone(),
            channels: decoded.channels,
            sample_rate: decoded.sample_rate,
            num_frames: decoded.num_frames,
        });
    }

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    while project.tracks.len() <= armed_idx {
        let track_num = project.tracks.len() + 1;
        project.add_track(Track::new(format!("Track {track_num}")));
    }

    let clip = AudioClip::new(
        "Recording",
        &path,
        AbsoluteTime::new(result.start_frame),
        AbsoluteTime::new(result.total_frames as i64),
    );
    project.tracks[armed_idx].clips.push(clip);
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);

    Ok(())
}

/// Offline bounce/export command.
#[tauri::command]
async fn export_mix_cmd(
    settings: ExportSettingsPayload,
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();
    let project_end_frame = project
        .tracks
        .iter()
        .flat_map(|t| t.clips.iter())
        .map(|c| c.position.sample_frame + c.duration.sample_frame)
        .max()
        .unwrap_or(0)
        .max(1);

    let (start_frame, end_frame) = if settings.range == "loop" {
        let state = handle.playback_state.lock().map_err(|e| e.to_string())?;
        if state.loop_enabled && state.loop_end > state.loop_start {
            (state.loop_start, state.loop_end)
        } else {
            (0, project_end_frame)
        }
    } else {
        (0, project_end_frame)
    };

    let mut local_pool = ClipPool::new();
    for track in &project.tracks {
        for clip in &track.clips {
            if clip.file_path.is_empty() {
                continue;
            }
            if local_pool.get(&clip.file_path).is_some() {
                continue;
            }
            if !PathBuf::from(&clip.file_path).exists() {
                continue;
            }
            if let Ok(decoded) = AudioReader::read(PathBuf::from(&clip.file_path)) {
                local_pool.insert(ClipAudio {
                    source_path: clip.file_path.clone(),
                    channels: decoded.channels,
                    sample_rate: decoded.sample_rate,
                    num_frames: decoded.num_frames,
                });
            }
        }
    }

    let cfg = BounceConfig {
        output_path: settings.output_path.clone(),
        sample_rate: settings.sample_rate,
        bit_depth: settings.bit_depth,
        start_frame,
        end_frame,
        normalize: settings.normalize,
        tail_frames: ((settings.tail_ms as f64 / 1000.0) * settings.sample_rate as f64) as i64,
    };
    
    // Reset cancel flag and create bouncer with it
    handle.export_cancel.store(false, std::sync::atomic::Ordering::SeqCst);
    let mut bouncer = OfflineBouncer::new(cfg);
    bouncer.cancel_flag = std::sync::Arc::clone(&handle.export_cancel);
    
    let app_for_progress = app.clone();
    bouncer
        .bounce(&project, &local_pool, None, move |progress| {
            let payload = serde_json::json!({
                "progress": (progress * 100.0).clamp(0.0, 100.0),
                "phase": "Rendering"
            });
            let _ = app_for_progress.emit("bounce_progress", payload);
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Cancel an in-progress export/bounce operation.
#[tauri::command]
async fn cancel_export_cmd(
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    handle.export_cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    log::info!("[Export] Cancel requested");
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════════
// Undo / Redo Commands
// ═══════════════════════════════════════════════════════════════════════

/// Undo the last project mutation.
///
/// Pops the most recent snapshot from the undo stack and swaps it
/// into the current project. The current state is pushed onto redo.
#[tauri::command]
async fn undo_cmd(
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let mut undo = project_state.undo.lock().map_err(|e| e.to_string())?;
    let previous = undo.undo_stack.pop()
        .ok_or_else(|| "Nothing to undo".to_string())?;

    // Save current state to redo stack
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let current_snapshot = SharedProjectSnapshot::from_project(&project, undo.redo_stack.last());
    undo.redo_stack.push(current_snapshot);
    *project = previous.to_project();
    drop(undo);

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_automation_snapshot_from_project(&project, &automation_runtime);
    rebuild_midi_snapshot_from_project(&project, &handle);
    rebuild_sampler_snapshot_from_project(&project, &clip_pool_state, &handle);
    log::info!("[IPC] undo_cmd: restored previous state");
    Ok(())
}

/// Redo a previously undone mutation.
///
/// Pops from the redo stack, pushes current state onto undo, and
/// swaps the redo snapshot into the project.
#[tauri::command]
async fn redo_cmd(
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let mut undo = project_state.undo.lock().map_err(|e| e.to_string())?;
    let next = undo.redo_stack.pop()
        .ok_or_else(|| "Nothing to redo".to_string())?;

    // Save current state to undo stack
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let current_snapshot = SharedProjectSnapshot::from_project(&project, undo.undo_stack.last());
    undo.undo_stack.push(current_snapshot);
    *project = next.to_project();
    drop(undo);

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_automation_snapshot_from_project(&project, &automation_runtime);
    rebuild_midi_snapshot_from_project(&project, &handle);
    rebuild_sampler_snapshot_from_project(&project, &clip_pool_state, &handle);
    log::info!("[IPC] redo_cmd: restored redo state");
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════
// Track Management Commands
// ═══════════════════════════════════════════════════════════════════════

/// Adds a new audio track to the project.
///
/// If `name` is `None`, auto-generates a name ("Audio N").
/// The track is auto-assigned a color from the 16-color palette.
#[tauri::command]
async fn add_track_cmd(
    name: Option<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    // Snapshot for undo BEFORE mutation
    drop(project);
    push_undo(&project_state)?;
    project = project_state.project.lock().map_err(|e| e.to_string())?;

    let track_num = project.tracks.len() + 1;
    let track_name = name.unwrap_or_else(|| format!("Audio {}", track_num));
    project.add_track(Track::new(&track_name));
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    log::info!("[IPC] add_track_cmd: '{}' (now {} tracks)", track_name, project.tracks.len());
    Ok(())
}

/// Deletes a track by index. Pushes undo snapshot before mutation.
#[tauri::command]
async fn delete_track_cmd(
    index: usize,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    if index >= project.tracks.len() {
        return Err(format!("Track index {} out of range ({})", index, project.tracks.len()));
    }

    // Snapshot for undo BEFORE mutation
    drop(project);
    push_undo(&project_state)?;
    project = project_state.project.lock().map_err(|e| e.to_string())?;

    let removed_name = project.tracks[index].name.clone();
    project.tracks.remove(index);
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    log::info!("[IPC] delete_track_cmd: index={} name='{}' (now {} tracks)", index, removed_name, project.tracks.len());
    Ok(())
}

/// Renames a track by index.
#[tauri::command]
async fn rename_track_cmd(
    index: usize,
    name: String,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<(), String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    if index >= project.tracks.len() {
        return Err(format!("Track index {} out of range ({})", index, project.tracks.len()));
    }
    let old_name = project.tracks[index].name.clone();
    project.tracks[index].name = name.clone();
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    log::info!("[IPC] rename_track_cmd: index={} '{}' → '{}'", index, old_name, name);
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════
// Splash Screen → Main Window Transition
// ═══════════════════════════════════════════════════════════════════════

/// Expands the main window from splash mode (500×500) to full DAW mode.
///
/// Called from the React splash screen after the loading animation completes.
/// This provides the native "small window → big window" UX identical to
/// the original Swift implementation.
///
/// Transitions:
///   500×500 borderless → maximized with decorations + resizable + fullscreen button
#[tauri::command]
fn expand_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    // ── Phase 1: Hide the splash window (avoids visual glitch during reconfigure) ──
    window.hide()
        .map_err(|e| format!("Failed to hide window: {e}"))?;

    // ── Phase 2: Reconfigure window for DAW mode ──
    // Enable decorations (title bar with traffic lights: red/yellow/GREEN fullscreen)
    window.set_decorations(true)
        .map_err(|e| format!("Failed to set decorations: {e}"))?;

    // Enable resizing (required for green fullscreen button to work on macOS)
    window.set_resizable(true)
        .map_err(|e| format!("Failed to set resizable: {e}"))?;

    // Minimum size so the DAW doesn't get too small
    let min_size = tauri::LogicalSize::new(900.0_f64, 600.0_f64);
    window.set_min_size(Some(min_size))
        .map_err(|e| format!("Failed to set min size: {e}"))?;

    // ── Phase 3: Maximize to fill screen (minus Dock & menu bar) ──
    window.maximize()
        .map_err(|e| format!("Failed to maximize: {e}"))?;

    // Brief delay to let macOS window manager finish compositing
    std::thread::sleep(std::time::Duration::from_millis(80));

    // ── Phase 4: Show the fully-configured DAW window ──
    window.show()
        .map_err(|e| format!("Failed to show window: {e}"))?;

    // Focus the window so it's the frontmost app
    window.set_focus()
        .map_err(|e| format!("Failed to focus window: {e}"))?;

    log::info!("[Splash] Window expanded to maximized DAW mode");
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════
// Project Management Commands
// ═══════════════════════════════════════════════════════════════════════

/// Creates a new empty project and replaces the current one.
#[tauri::command]
fn new_project(
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    let mut new = Project::default();
    refresh_offline_flags(&mut new);
    *project_state.project.lock().map_err(|e| e.to_string())? = new.clone();
    *project_state.file_path.lock().map_err(|e| e.to_string())? = None;
    *project_state.project_folder.lock().map_err(|e| e.to_string())? = None;
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;
    *project_state.undo.lock().map_err(|e| e.to_string())? = UndoState::new();
    clip_pool_state.rebuild_snapshot(&new);
    rebuild_automation_snapshot_from_project(&new, &automation_runtime);
    rebuild_midi_snapshot_from_project(&new, &handle);
    rebuild_sampler_snapshot_from_project(&new, &clip_pool_state, &handle);
    sync_transport_from_project(&new, &handle)?;

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
    app: tauri::AppHandle,
) -> Result<String, String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let file_path_guard = project_state.file_path.lock().map_err(|e| e.to_string())?;

    let path = file_path_guard
        .as_ref()
        .ok_or("No file path set. Use Save As first.")?
        .clone();

    // Keep project name aligned with the active file name.
    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
        let normalized = stem.trim_end_matches(".dream").trim();
        if !normalized.is_empty() && project.name != normalized {
            project.name = normalized.to_string();
        }
    }

    ProjectFile::save(&project, &path).map_err(|e| e.to_string())?;

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;

    // Update window title (also clears any dirty marker left from mark_dirty_cmd).
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", project.name));
    }

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
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let file_path = PathBuf::from(&path);

    // Determine if we should create an Ableton-style folder structure.
    // If the user chose a path like "Foo.dream.json", we create:
    //   parent/Foo/Foo.dream.json + Samples/ + Backup/
    let parent_dir = file_path.parent().unwrap_or(std::path::Path::new("."));
    let project_name = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&project.name)
        .trim_end_matches(".dream")
        .to_string();

    // Save As should establish the active project name from chosen filename.
    if !project_name.trim().is_empty() {
        project.name = project_name.trim().to_string();
    }

    let (actual_file_path, folder) = if ProjectManager::is_project_directory(parent_dir) {
        // Already inside a project directory — save in place
        ProjectFile::save(&project, &file_path)
            .map_err(|e| e.to_string())?;
        (file_path.clone(), parent_dir.to_path_buf())
    } else {
        // New location — create Ableton-style folder structure
        let folder = ProjectManager::create_project_folder(parent_dir, &project_name)
            .map_err(|e| e.to_string())?;
        let saved_path = ProjectManager::save_to_folder(&project, &folder, true)
            .map_err(|e| e.to_string())?;
        (saved_path, folder)
    };

    *project_state.file_path.lock().map_err(|e| e.to_string())? = Some(actual_file_path.clone());
    *project_state.project_folder.lock().map_err(|e| e.to_string())? = Some(folder);
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;

    // Track in recent projects
    let result_path = actual_file_path.display().to_string();
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let mut recent = RecentProjects::load(&app_data_dir);
        recent.add(project.name.clone(), result_path.clone());
        let _ = recent.save(&app_data_dir);
    }

    // Update window title
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", project.name));
    }

    log::info!("Project saved as: '{}' → {}", project.name, actual_file_path.display());
    Ok(result_path)
}

/// Opens a project from a file path.
#[tauri::command]
fn open_project(
    path: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    let file_path = PathBuf::from(&path);

    let mut loaded = ProjectFile::load(&file_path)
        .map_err(|e| e.to_string())?;
    refresh_offline_flags(&mut loaded);

    *project_state.project.lock().map_err(|e| e.to_string())? = loaded.clone();
    *project_state.file_path.lock().map_err(|e| e.to_string())? = Some(file_path.clone());
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;
    *project_state.undo.lock().map_err(|e| e.to_string())? = UndoState::new();
    clip_pool_state.rebuild_snapshot(&loaded);
    clip_pool_state.load_project_clips(&loaded);
    rebuild_automation_snapshot_from_project(&loaded, &automation_runtime);
    rebuild_midi_snapshot_from_project(&loaded, &handle);
    rebuild_sampler_snapshot_from_project(&loaded, &clip_pool_state, &handle);
    sync_transport_from_project(&loaded, &handle)?;

    // Derive project folder from file path
    let folder = ProjectManager::folder_from_file(&file_path);
    *project_state.project_folder.lock().map_err(|e| e.to_string())? = folder;

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
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    refresh_offline_flags(&mut project);
    Ok(project.clone())
}

/// Returns whether the project has unsaved changes and the current file path.
#[tauri::command]
fn get_project_status(
    project_state: tauri::State<'_, ProjectState>,
) -> Result<serde_json::Value, String> {
    let is_dirty = *project_state.is_dirty.lock().map_err(|e| e.to_string())?;
    let file_path = project_state.file_path.lock().map_err(|e| e.to_string())?;
    let project_folder = project_state.project_folder.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "isDirty": is_dirty,
        "filePath": file_path.as_ref().map(|p| p.display().to_string()),
        "projectFolder": project_folder.as_ref().map(|p| p.display().to_string()),
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

/// Returns the resolved samples folder path by reading settings.json directly.
/// This avoids the SettingsState mutex — safe for lightweight IPC calls.
#[tauri::command]
fn get_samples_path(app: tauri::AppHandle) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {}", e))?;
    let settings_path = app_data_dir.join("settings.json");

    let samples_path = if settings_path.exists() {
        if let Ok(json) = std::fs::read_to_string(&settings_path) {
            if let Ok(settings) = serde_json::from_str::<AppSettings>(&json) {
                settings.samples_path
            } else {
                default_samples_path()
            }
        } else {
            default_samples_path()
        }
    } else {
        default_samples_path()
    };

    // Auto-create the samples directory if it doesn't exist
    let path = std::path::Path::new(&samples_path);
    if !path.exists() {
        let _ = std::fs::create_dir_all(path);
        log::info!("[Settings] Created samples directory: {}", samples_path);
    }

    Ok(samples_path)
}

/// Updates application settings and persists to disk.
/// If `user_folder_path` changed, migrates settings to the new location.
#[tauri::command]
fn update_settings(
    new_settings: AppSettings,
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<(), String> {
    // Check if user_folder_path changed (need to migrate)
    let old_folder_path = {
        let current = settings_state.settings.lock().map_err(|e| e.to_string())?;
        current.user_folder_path.clone()
    };

    let folder_changed = old_folder_path != new_settings.user_folder_path;
    let new_folder_path = new_settings.user_folder_path.clone();

    // Update in-memory state
    *settings_state.settings.lock().map_err(|e| e.to_string())? = new_settings;

    // Persist to disk
    if folder_changed {
        settings_state.migrate_to_new_folder(&old_folder_path, &new_folder_path)?;
    } else {
        settings_state.save_to_user_folder()?;
    }

    log::info!("Settings updated and persisted");
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════
// File Browser Commands
// ═══════════════════════════════════════════════════════════════════════

/// A single audio file entry returned by the browser scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AudioFileEntry {
    name: String,
    path: String,
    size_bytes: u64,
    modified_at: String,
    format: String,
}

/// Audio extensions recognized by the file browser (case-insensitive).
const AUDIO_EXTENSIONS: &[&str] = &[
    "wav", "wave", "aiff", "aif", "mp3", "m4a", "flac", "ogg", "caf",
];

/// Plugin bundle extensions recognized by the browser.
const PLUGIN_EXTENSIONS: &[&str] = &[
    "vst", "vst3", "component", "au", "aaxplugin",
];

/// Project file extensions recognized by the browser.
const PROJECT_EXTENSIONS: &[&str] = &[
    "ddpj", "als", "flp", "logic", "ptx", "rpp",
];

/// Preset file extensions recognized by the browser.
const PRESET_EXTENSIONS: &[&str] = &[
    "fxp", "fxb", "vstpreset", "aupreset",
];

/// Generates a set of demo WAV samples in the Samples folder so the browser
/// has real draggable audio files from the very first launch.
#[tauri::command]
fn generate_demo_samples_cmd(
    app: tauri::AppHandle,
) -> Result<u32, String> {
    // Resolve samples path (also creates the directory)
    let samples_path = get_samples_path(app)?;
    let dir = std::path::Path::new(&samples_path);

    // Only generate if the folder is empty or doesn't have our marker
    let marker = dir.join(".dream_demo_generated");
    if marker.exists() {
        log::info!("[DemoSamples] Marker exists, skipping generation");
        return Ok(0);
    }

    const SR: u32 = 44100;
    let mut count: u32 = 0;

    // Helper functions for synthesis
    fn gen_sine(sr: u32, freq: f32, dur: f32, amp: f32) -> Vec<f32> {
        let n = (sr as f32 * dur) as usize;
        (0..n).map(|i| {
            let t = i as f32 / sr as f32;
            let env = if t < 0.005 { t / 0.005 }
                      else if t > dur - 0.01 { (dur - t) / 0.01 }
                      else { 1.0 };
            (t * freq * std::f32::consts::TAU).sin() * amp * env.clamp(0.0, 1.0)
        }).collect()
    }

    fn gen_noise_burst(sr: u32, dur: f32, amp: f32) -> Vec<f32> {
        let n = (sr as f32 * dur) as usize;
        let mut rng: u64 = 0xDEAD_BEEF;
        (0..n).map(|i| {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
            let noise = ((rng >> 33) as f32 / (u32::MAX >> 1) as f32) * 2.0 - 1.0;
            let t = i as f32 / sr as f32;
            let env = (-t * 20.0).exp();
            noise * amp * env
        }).collect()
    }

    fn gen_kick(sr: u32, amp: f32) -> Vec<f32> {
        let dur: f32 = 0.35;
        let n = (sr as f32 * dur) as usize;
        (0..n).map(|i| {
            let t = i as f32 / sr as f32;
            let freq = 150.0 * (-t * 8.0).exp() + 40.0;
            let env = (-t * 6.0).exp();
            (t * freq * std::f32::consts::TAU).sin() * amp * env
        }).collect()
    }

    // Generate all demo samples eagerly
    let demos: Vec<(&str, Vec<f32>)> = vec![
        ("Kick_808_Deep", gen_kick(SR, 0.85)),
        ("Kick_Acoustic", gen_kick(SR, 0.7)),
        ("Snare_Tight", {
            let body = gen_sine(SR, 200.0, 0.15, 0.5);
            let noise = gen_noise_burst(SR, 0.15, 0.6);
            body.iter().zip(noise.iter()).map(|(a, b)| a + b).collect()
        }),
        ("HiHat_Closed", gen_noise_burst(SR, 0.06, 0.4)),
        ("HiHat_Open", gen_noise_burst(SR, 0.25, 0.35)),
        ("Clap_Vinyl", {
            let mut out = Vec::new();
            for _ in 0..3 {
                out.extend(gen_noise_burst(SR, 0.01, 0.5).iter());
                out.extend(vec![0.0; 220]);
            }
            out.extend(gen_noise_burst(SR, 0.12, 0.6).iter());
            out
        }),
        ("Bass_Sub", gen_sine(SR, 55.0, 1.0, 0.7)),
        ("Pad_Ambient_Dm", {
            let dur: f32 = 2.0;
            let n = (SR as f32 * dur) as usize;
            (0..n).map(|i| {
                let t = i as f32 / SR as f32;
                let env = if t < 0.2 { t / 0.2 } else if t > dur - 0.3 { (dur - t) / 0.3 } else { 1.0 };
                let s1 = (t * 293.66 * std::f32::consts::TAU).sin();
                let s2 = (t * 349.23 * std::f32::consts::TAU).sin();
                let s3 = (t * 440.0 * std::f32::consts::TAU).sin();
                (s1 + s2 * 0.7 + s3 * 0.5) * 0.2 * env.clamp(0.0, 1.0)
            }).collect()
        }),
    ];

    for (name, samples) in &demos {
        let path = dir.join(format!("{}.wav", name));
        if path.exists() { continue; }
        if let Err(e) = WavWriter::write_interleaved(&path, samples, SR, 1, 24) {
            log::warn!("[DemoSamples] Failed to write {}: {}", name, e);
            continue;
        }
        count += 1;
    }

    // Write marker file
    let _ = std::fs::write(&marker, "generated");
    log::info!("[DemoSamples] Generated {} demo samples in {}", count, samples_path);
    Ok(count)
}

/// Preview (audition) an audio file through system audio output.
/// Decodes the file and sends it to a one-shot playback thread.
#[tauri::command]
async fn preview_audio_file_cmd(
    path: String,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let file_path = std::path::PathBuf::from(&path);
    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    // Decode the audio file
    let decoded = AudioReader::read(&file_path)
        .map_err(|e| format!("Failed to decode: {e}"))?;

    // Build interleaved buffer for preview
    let num_ch = decoded.channels.len().min(2);
    let num_frames = decoded.num_frames;
    let mut interleaved = vec![0.0f32; num_frames * 2]; // always stereo output

    for frame in 0..num_frames {
        let l = decoded.channels[0][frame];
        let r = if num_ch > 1 { decoded.channels[1][frame] } else { l };
        interleaved[frame * 2] = l;
        interleaved[frame * 2 + 1] = r;
    }

    // Store preview buffer in engine for mixing into output
    // The audio driver will pick it up and mix it in
    handle.set_preview_buffer(interleaved);

    log::info!("[Preview] Playing '{}' ({} frames, {}Hz)", 
        file_path.file_name().unwrap_or_default().to_string_lossy(),
        num_frames, decoded.sample_rate);
    Ok(())
}

/// Stop any active audio preview.
#[tauri::command]
async fn stop_preview_cmd(
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    handle.clear_preview_buffer();
    log::info!("[Preview] Stopped");
    Ok(())
}

/// Recursively scans the given directory for audio files.
#[tauri::command]
fn scan_audio_folder(path: String) -> Result<Vec<AudioFileEntry>, String> {
    log::info!("[IPC] scan_audio_folder: {}", path);
    let root = std::path::Path::new(&path);
    if !root.exists() {
        return Err(format!("Folder does not exist: {}", path));
    }
    if !root.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut entries = Vec::new();
    let mut file_count: usize = 0;
    scan_directory_recursive(root, &mut entries, 0, 8, &mut file_count, MAX_SCAN_FILES)?; // max depth 8
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

/// Scans ALL audio sources: the configured samples_path + every user browser_folder.
/// Returns a deduplicated, alphabetically sorted list of audio files.
/// Caps at MAX_SCAN_FILES to prevent UI freeze on massive libraries.
/// This powers the unified "All" category in the browser sidebar.
const MAX_SCAN_FILES: usize = 10_000;

#[tauri::command]
fn scan_all_audio_sources(
    app: tauri::AppHandle,
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<Vec<AudioFileEntry>, String> {
    let samples_path = get_samples_path(app)?;
    let browser_folders = {
        let settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
        settings.browser_folders.clone()
    };

    let mut all_entries: Vec<AudioFileEntry> = Vec::new();
    let mut seen_paths = std::collections::HashSet::new();
    let mut file_count: usize = 0;

    // Scan samples_path
    let samples_dir = std::path::Path::new(&samples_path);
    if samples_dir.is_dir() {
        let _ = scan_directory_recursive(samples_dir, &mut all_entries, 0, 8, &mut file_count, MAX_SCAN_FILES);
    }

    // Scan each browser folder
    for folder in &browser_folders {
        if file_count >= MAX_SCAN_FILES {
            break;
        }
        let dir = std::path::Path::new(folder);
        if dir.is_dir() {
            let _ = scan_directory_recursive(dir, &mut all_entries, 0, 8, &mut file_count, MAX_SCAN_FILES);
        }
    }

    // Deduplicate by absolute path
    all_entries.retain(|e| seen_paths.insert(e.path.clone()));

    // Sort alphabetically (case-insensitive)
    all_entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    log::info!(
        "[IPC] scan_all_audio_sources: {} files from {} sources (cap: {})",
        all_entries.len(),
        1 + browser_folders.len(),
        MAX_SCAN_FILES
    );
    Ok(all_entries)
}

/// Recursive directory walker for audio files.
/// Stops when `file_count` reaches `max_files` to prevent scanning massive libraries.
fn scan_directory_recursive(
    dir: &std::path::Path,
    entries: &mut Vec<AudioFileEntry>,
    depth: u32,
    max_depth: u32,
    file_count: &mut usize,
    max_files: usize,
) -> Result<(), String> {
    if depth > max_depth || *file_count >= max_files {
        return Ok(());
    }

    let read_dir = std::fs::read_dir(dir).map_err(|e| format!("Cannot read {}: {}", dir.display(), e))?;

    for entry in read_dir.flatten() {
        if *file_count >= max_files {
            break;
        }

        let path = entry.path();

        // Skip hidden files/directories
        if entry.file_name().to_str().map_or(false, |n| n.starts_with('.')) {
            continue;
        }

        if path.is_dir() {
            scan_directory_recursive(&path, entries, depth + 1, max_depth, file_count, max_files)?;
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if AUDIO_EXTENSIONS.contains(&ext.to_lowercase().as_str()) {
                let metadata = std::fs::metadata(&path).ok();
                let size_bytes = metadata.as_ref().map_or(0, |m| m.len());
                let modified_at = metadata
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs().to_string())
                    .unwrap_or_default();

                entries.push(AudioFileEntry {
                    name: entry.file_name().to_string_lossy().to_string(),
                    path: path.to_string_lossy().to_string(),
                    size_bytes,
                    modified_at,
                    format: ext.to_uppercase(),
                });
                *file_count += 1;
            }
        }
    }

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════
// Browser Folder Management — Persistent user folders in PLACES section
// ═══════════════════════════════════════════════════════════════════════

/// A file system entry returned by `scan_folder_all`.
/// Classifies files into audio, plugin, project, preset, or other.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct BrowserFileEntry {
    name: String,
    path: String,
    size_bytes: u64,
    modified_at: String,
    /// File extension (uppercase), e.g. "WAV", "VST3"
    extension: String,
    /// Semantic type: "audio", "plugin", "project", "preset", "folder", "other"
    file_type: String,
    /// Whether this entry is a directory
    is_directory: bool,
}

/// Returns the list of user-added browser folders from settings.
#[tauri::command]
fn get_browser_folders(
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<Vec<String>, String> {
    let settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
    Ok(settings.browser_folders.clone())
}

/// Adds a folder to the browser PLACES section (with native picker).
/// Returns the updated list of browser folders.
#[tauri::command]
async fn add_browser_folder(
    app: tauri::AppHandle,
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();

    app.dialog().file()
        .pick_folder(move |folder| {
            let _ = tx.send(folder.map(|p| p.to_string()));
        });

    let picked = tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|e| format!("Dialog error: {}", e))
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Cancelled".to_string())?;

    {
        let mut settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
        // Don't add duplicates
        if !settings.browser_folders.contains(&picked) {
            settings.browser_folders.push(picked.clone());
        }
    }
    settings_state.save_to_user_folder()?;

    let settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
    log::info!("[Browser] Added folder: '{}' (total: {})", picked, settings.browser_folders.len());
    Ok(settings.browser_folders.clone())
}

/// Removes a folder from the browser PLACES section.
/// Returns the updated list.
#[tauri::command]
fn remove_browser_folder(
    path: String,
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<Vec<String>, String> {
    {
        let mut settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
        settings.browser_folders.retain(|f| f != &path);
    }
    settings_state.save_to_user_folder()?;

    let settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
    log::info!("[Browser] Removed folder: '{}' (total: {})", path, settings.browser_folders.len());
    Ok(settings.browser_folders.clone())
}

/// Classifies a file extension into a semantic type.
fn classify_file_type(ext: &str) -> &'static str {
    let lower = ext.to_lowercase();
    if AUDIO_EXTENSIONS.contains(&lower.as_str()) {
        "audio"
    } else if PLUGIN_EXTENSIONS.contains(&lower.as_str()) {
        "plugin"
    } else if PROJECT_EXTENSIONS.contains(&lower.as_str()) {
        "project"
    } else if PRESET_EXTENSIONS.contains(&lower.as_str()) {
        "preset"
    } else {
        "other"
    }
}

/// Scans a folder for ALL file types (audio, plugins, projects, presets, etc.).
/// Returns classified entries. Subfolders are also listed as navigable entries.
#[tauri::command]
fn scan_folder_all(path: String) -> Result<Vec<BrowserFileEntry>, String> {
    log::info!("[IPC] scan_folder_all: {}", path);
    let root = std::path::Path::new(&path);
    if !root.exists() {
        return Err(format!("Folder does not exist: {}", path));
    }
    if !root.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let read_dir = std::fs::read_dir(root)
        .map_err(|e| format!("Cannot read {}: {}", path, e))?;

    let mut entries = Vec::new();

    for entry in read_dir.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden files
        if file_name.starts_with('.') {
            continue;
        }

        let entry_path = entry.path();
        let metadata = std::fs::metadata(&entry_path).ok();
        let size_bytes = metadata.as_ref().map_or(0, |m| m.len());
        let modified_at = metadata
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default();

        if entry_path.is_dir() {
            // Check if it's a plugin bundle (.vst, .vst3, .component, .au)
            let ext = entry_path.extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            let ext_lower = ext.to_lowercase();
            if PLUGIN_EXTENSIONS.contains(&ext_lower.as_str()) {
                entries.push(BrowserFileEntry {
                    name: file_name,
                    path: entry_path.to_string_lossy().to_string(),
                    size_bytes,
                    modified_at,
                    extension: ext.to_uppercase(),
                    file_type: "plugin".to_string(),
                    is_directory: false, // Treat as file for UX
                });
            } else {
                // Regular subfolder
                entries.push(BrowserFileEntry {
                    name: file_name,
                    path: entry_path.to_string_lossy().to_string(),
                    size_bytes: 0,
                    modified_at,
                    extension: String::new(),
                    file_type: "folder".to_string(),
                    is_directory: true,
                });
            }
        } else if let Some(ext) = entry_path.extension().and_then(|e| e.to_str()) {
            let file_type = classify_file_type(ext);
            entries.push(BrowserFileEntry {
                name: file_name,
                path: entry_path.to_string_lossy().to_string(),
                size_bytes,
                modified_at,
                extension: ext.to_uppercase(),
                file_type: file_type.to_string(),
                is_directory: false,
            });
        }
    }

    // Sort: folders first, then by name
    entries.sort_by(|a, b| {
        b.is_directory.cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Scans VST2 and VST3 system paths for installed plugins.
/// Returns all discovered plugin bundles.
#[tauri::command]
fn scan_plugin_folders(
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<Vec<BrowserFileEntry>, String> {
    let settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
    let mut entries = Vec::new();

    // Scan each plugin path
    let au_path = "/Library/Audio/Plug-Ins/Components".to_string();
    let paths: Vec<(&String, &str)> = vec![
        (&settings.vst2_path, "VST2"),
        (&settings.vst3_path, "VST3"),
        // macOS AU components
        (&au_path, "AU"),
    ];

    let home = dirs::home_dir().unwrap_or_default();
    let user_vst = home.join("Library/Audio/Plug-Ins/VST").to_string_lossy().to_string();
    let user_vst3 = home.join("Library/Audio/Plug-Ins/VST3").to_string_lossy().to_string();
    let user_au = home.join("Library/Audio/Plug-Ins/Components").to_string_lossy().to_string();

    let all_paths: Vec<(&str, &str)> = paths.iter()
        .map(|(p, t)| (p.as_str(), *t))
        .chain(vec![
            (user_vst.as_str(), "VST2"),
            (user_vst3.as_str(), "VST3"),
            (user_au.as_str(), "AU"),
        ])
        .collect();

    let mut seen = std::collections::HashSet::new();

    for (dir_path, plugin_type) in &all_paths {
        let dir = std::path::Path::new(dir_path);
        if !dir.exists() || !dir.is_dir() {
            continue;
        }

        if let Ok(read_dir) = std::fs::read_dir(dir) {
            for entry in read_dir.flatten() {
                let entry_path = entry.path();
                let file_name = entry.file_name().to_string_lossy().to_string();

                if file_name.starts_with('.') {
                    continue;
                }

                // Check if it's a plugin bundle
                let ext = entry_path.extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                let ext_lower = ext.to_lowercase();

                if PLUGIN_EXTENSIONS.contains(&ext_lower.as_str()) {
                    let path_str = entry_path.to_string_lossy().to_string();
                    if seen.contains(&path_str) {
                        continue;
                    }
                    seen.insert(path_str.clone());

                    // Strip extension from display name for cleaner look
                    let display_name = file_name
                        .rsplit_once('.')
                        .map(|(n, _)| n.to_string())
                        .unwrap_or_else(|| file_name.clone());

                    let metadata = std::fs::metadata(&entry_path).ok();
                    let size_bytes = metadata.as_ref().map_or(0, |m| m.len());
                    let modified_at = metadata
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs().to_string())
                        .unwrap_or_default();

                    entries.push(BrowserFileEntry {
                        name: display_name,
                        path: path_str,
                        size_bytes,
                        modified_at,
                        extension: plugin_type.to_string(),
                        file_type: "plugin".to_string(),
                        is_directory: false,
                    });
                }
            }
        }
    }

    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    log::info!("[IPC] scan_plugin_folders: found {} plugins", entries.len());
    Ok(entries)
}

/// Opens a native folder picker dialog and returns the selected path.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();

    app.dialog().file()
        .pick_folder(move |folder| {
            let _ = tx.send(folder.map(|p| p.to_string()));
        });

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|e| format!("Dialog error: {}", e))
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
}

/// Opens a native file picker dialog for .ddpj project files.
#[tauri::command]
async fn pick_project_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();

    app.dialog().file()
        .add_filter("Dream DAW Project", &["ddpj", "json"])
        .set_title("Open Project")
        .pick_file(move |file| {
            let _ = tx.send(file.map(|p| p.to_string()));
        });

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|e| format!("Dialog error: {}", e))
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
}

/// Opens a native save dialog for .ddpj project files.
#[tauri::command]
async fn save_project_dialog(
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    // Use current project name as default filename
    let default_name = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        format!("{}.ddpj", project.name)
    };

    let (tx, rx) = std::sync::mpsc::channel();

    app.dialog().file()
        .add_filter("Dream DAW Project", &["ddpj"])
        .set_title("Save Project As")
        .set_file_name(&default_name)
        .save_file(move |file| {
            let _ = tx.send(file.map(|p| p.to_string()));
        });

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|e| format!("Dialog error: {}", e))
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
}

// ═══════════════════════════════════════════════════════════════════════
// Extended Project Management Commands
// ═══════════════════════════════════════════════════════════════════════

/// Creates a backup of the current project in the project's Backup/ directory.
///
/// Returns the path to the backup file, or an error if no project folder is set.
#[tauri::command]
fn create_backup_cmd(
    project_state: tauri::State<'_, ProjectState>,
) -> Result<String, String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let folder = project_state.project_folder.lock().map_err(|e| e.to_string())?;

    let folder = folder
        .as_ref()
        .ok_or("No project folder set. Save the project first.")?;

    let backup_path = ProjectManager::create_backup(&project, folder)
        .map_err(|e| e.to_string())?;

    log::info!("Backup created: {}", backup_path.display());
    Ok(backup_path.display().to_string())
}

/// Marks the project as having unsaved changes (dirty state).
///
/// Called by the frontend when the user makes a change that isn't
/// tracked by a backend mutation (e.g., view state changes).
#[tauri::command]
fn mark_dirty_cmd(
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&name, Some(&app))?;
    Ok(())
}

/// Syncs the window title with the current dirty state.
///
/// Called by the frontend after mutations to ensure the title bar
/// accurately reflects whether there are unsaved changes.
#[tauri::command]
fn sync_title_cmd(
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let name = project.name.clone();
    let is_dirty = *project_state.is_dirty.lock().map_err(|e| e.to_string())?;
    drop(project);

    if let Some(window) = app.get_webview_window("main") {
        if is_dirty {
            let _ = window.set_title(&format!("Dream DAW — {}*", name));
        } else {
            let _ = window.set_title(&format!("Dream DAW — {}", name));
        }
    }
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════
// Audio Device Management
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

// ═══════════════════════════════════════════════════════════════════════
// Plugin Windows & Track Routing (Epic 2)
// ═══════════════════════════════════════════════════════════════════════

/// Open plugin native GUI window.
///
/// Current implementation delegates lifecycle to the backend plugin host.
/// If host-side windowing is not wired yet, this call is a no-op with logging.
#[tauri::command]
fn open_plugin_window(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<(), String> {
    if let Some(instance_id) = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .get(&plugin_id)
        .copied()
    {
        let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
        host.open_editor(instance_id)
            .map_err(|e| format!("Failed to open existing plugin editor: {e}"))?;
        log::info!("[IPC] open_plugin_window({plugin_id}) -> reuse instance {instance_id}");
        return Ok(());
    }

    let descriptor = plugin_host_state.resolve_descriptor(&plugin_id)?;
    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let instance_id = host
        .load_vst3(descriptor.clone())
        .map_err(|e| format!("Failed to load plugin '{}': {e}", descriptor.name))?;
    if let Err(err) = host.open_editor(instance_id) {
        // Roll back loaded instance on editor-open failure to avoid leaked/ghost instances.
        let _ = host.remove(instance_id);
        return Err(format!("Plugin loaded but editor failed to open: {err}"));
    }
    drop(host);

    plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .insert(plugin_id.clone(), instance_id);

    log::info!(
        "[IPC] open_plugin_window({plugin_id}) -> loaded VST instance {} ({})",
        instance_id,
        descriptor.path.display()
    );
    Ok(())
}

#[tauri::command]
fn can_open_plugin_editor(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<PluginEditorCapability, String> {
    if let Some(instance_id) = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .get(&plugin_id)
        .copied()
    {
        let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
        let supported = host
            .supports_editor(instance_id)
            .map_err(|e| format!("Failed to check editor capability: {e}"))?;
        return Ok(PluginEditorCapability {
            supported,
            reason: if supported {
                None
            } else {
                Some("Native plugin editor host bridge is not implemented yet for this instance.".to_string())
            },
        });
    }

    let descriptor = plugin_host_state.resolve_descriptor(&plugin_id)?;
    if descriptor.format != PluginFormat::VST3 {
        let reason = match descriptor.format {
            PluginFormat::VST3 => None,
            PluginFormat::CLAP => Some("CLAP plugin editor is not supported by this host build.".to_string()),
            PluginFormat::AudioUnit => Some("AudioUnit editor is not supported by this host build.".to_string()),
        };
        return Ok(PluginEditorCapability {
            supported: false,
            reason,
        });
    }

    // Probe capability by loading the plugin and querying the live instance.
    // The probe instance is removed immediately to avoid changing chain state.
    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let probe_id = host
        .load_vst3(descriptor.clone())
        .map_err(|e| format!("Failed to load plugin '{}': {e}", descriptor.name))?;
    let supported = host
        .supports_editor(probe_id)
        .map_err(|e| format!("Failed to check editor capability: {e}"))?;
    let _ = host.remove(probe_id);

    Ok(PluginEditorCapability {
        supported,
        reason: if supported {
            None
        } else {
            Some("Plugin does not expose a host-openable editor in this build.".to_string())
        },
    })
}

/// Close plugin native GUI window.
#[tauri::command]
fn close_plugin_window(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<(), String> {
    let maybe_instance = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&plugin_id);

    if let Some(instance_id) = maybe_instance {
        let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
        if let Err(err) = host.close_editor(instance_id) {
            log::warn!(
                "[IPC] close_plugin_window({plugin_id}) editor close failed for {instance_id}: {err}"
            );
        }
        host.remove(instance_id)
            .map_err(|e| format!("Failed to unload plugin instance {instance_id}: {e}"))?;
        log::info!("[IPC] close_plugin_window({plugin_id}) -> removed instance {instance_id}");
    } else {
        log::info!("[IPC] close_plugin_window({plugin_id}) -> no loaded instance");
    }
    Ok(())
}

/// Unified frontend error logger (ErrorBoundary -> backend log).
#[tauri::command]
fn log_frontend_error(module: String, error: String, stack: Option<String>) -> Result<(), String> {
    if let Some(stack_trace) = stack {
        log::error!("[FrontendError] module={} error={} stack={}", module, error, stack_trace);
    } else {
        log::error!("[FrontendError] module={} error={}", module, error);
    }
    Ok(())
}

/// Return valid routing targets for a track.
#[tauri::command]
fn get_routing_targets(
    track_id: String,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<Vec<RoutingTarget>, String> {
    let source_id = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?;

    let mut targets = Vec::new();
    for t in &project.tracks {
        if t.id == source_id {
            continue;
        }
        targets.push(RoutingTarget {
            track_id: t.id.to_string(),
            track_name: t.name.clone(),
            track_type: format!("{:?}", t.track_type),
        });
    }
    Ok(targets)
}

/// Set output routing destination for a track.
///
/// `target_id` can be another track UUID or "master" to route directly
/// to the master bus. The project model is updated atomically.
#[tauri::command]
fn set_track_routing_cmd(
    track_id: String,
    target_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let source_id = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let destination = if target_id == "master" {
        None
    } else {
        Some(Uuid::parse_str(&target_id).map_err(|_| format!("Invalid target_id: {target_id}"))?)
    };

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    if let Some(dest_id) = destination {
        let dest_exists = project.tracks.iter().any(|t| t.id == dest_id);
        if !dest_exists {
            return Err(format!("Routing target not found: {target_id}"));
        }
    }

    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == source_id)
        .ok_or_else(|| format!("Track not found: {track_id}"))?;
    track.output_destination_id = destination;

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    log::info!("[IPC] set_track_routing_cmd({track_id} -> {target_id})");
    Ok(())
}

/// Set track audio input source (placeholder hook for sidechain/input matrix).
#[tauri::command]
fn set_track_input_cmd(track_id: String, input_id: String) -> Result<(), String> {
    log::info!("[IPC] set_track_input_cmd({track_id} <- {input_id})");
    Ok(())
}

/// Add a plugin slot to a track (instrument/effect) from frontend DnD.
#[tauri::command]
fn add_plugin_to_track_cmd(
    payload: AddPluginToTrackPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

    let slot = payload.slot.to_lowercase();
    let use_instrument = match slot.as_str() {
        "instrument" => true,
        "effect" => false,
        _ => track.track_type == TrackType::Midi && track.instrument.is_none(),
    };

    let plugin_slot = PluginSlot::new(payload.plugin_name.clone(), payload.plugin_id.clone());
    if use_instrument {
        track.instrument = Some(plugin_slot);
        if payload.plugin_id.starts_with("internal://instrument/sampler") && track.sampler.is_none() {
            track.sampler = Some(SamplerConfig::default());
        }
    } else {
        track.effects.push(plugin_slot);
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    log::info!(
        "[IPC] add_plugin_to_track_cmd(track={}, plugin='{}', slot={})",
        payload.track_id,
        payload.plugin_name,
        if use_instrument { "instrument" } else { "effect" }
    );
    Ok(())
}

/// Remove a plugin slot from a track (instrument/effect) by slot UUID.
#[tauri::command]
fn remove_plugin_from_track_cmd(
    payload: RemovePluginFromTrackPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let slot_uuid = Uuid::parse_str(&payload.slot_id)
        .map_err(|_| format!("Invalid slot_id: {}", payload.slot_id))?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

    let mut removed = false;
    if let Some(inst) = &track.instrument {
        if inst.id == slot_uuid {
            let removed_plugin_id = inst.plugin_id.clone();
            track.instrument = None;
            if removed_plugin_id.starts_with("internal://instrument/sampler") {
                track.sampler = None;
            }
            removed = true;
        }
    }

    if !removed {
        let before = track.effects.len();
        track.effects.retain(|slot| slot.id != slot_uuid);
        removed = track.effects.len() != before;
    }

    if !removed {
        return Err(format!(
            "Plugin slot not found on track {}: {}",
            payload.track_id, payload.slot_id
        ));
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    log::info!(
        "[IPC] remove_plugin_from_track_cmd(track={}, slot={})",
        payload.track_id,
        payload.slot_id
    );
    Ok(())
}

fn upsert_static_automation_lane(track: &mut Track, param_id: &str, value: f64) {
    if let Some(existing) = track
        .automation_lanes
        .iter_mut()
        .find(|lane| lane.param_id.eq_ignore_ascii_case(param_id))
    {
        existing.points = vec![dream_models::project::AutomationPoint {
            beat: 0.0,
            value,
            curve_type: "linear".to_string(),
            tension: None,
        }];
        existing.param_id = param_id.to_string();
        return;
    }

    track.automation_lanes.push(dream_models::project::AutomationLane {
        param_id: param_id.to_string(),
        points: vec![dream_models::project::AutomationPoint {
            beat: 0.0,
            value,
            curve_type: "linear".to_string(),
            tension: None,
        }],
    });
}

/// Set internal plugin parameter value and route to engine state/snapshots.
#[tauri::command]
fn set_internal_plugin_param_cmd(
    payload: InternalPluginParamPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let key = payload.param_id.to_lowercase();
    let mut sampler_command_needed = false;
    let (track_index, sampler_cfg_for_rt) = {
        let (idx, track) = project
            .tracks
            .iter_mut()
            .enumerate()
            .find(|(_, t)| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

        match key.as_str() {
            // Utility gain in dB => plugin.gain in linear 0..2
            "gain" | "utility.gain" | "plugin.gain" => {
                let linear = 10.0_f64.powf(payload.value.clamp(-60.0, 12.0) / 20.0).clamp(0.0, 2.0);
                upsert_static_automation_lane(track, "plugin.gain", linear);
            }
            // Utility pan in -100..100 or -1..1 => plugin.pan in -1..1
            "pan" | "utility.pan" | "plugin.pan" => {
                let pan = if payload.value.abs() > 1.0 {
                    (payload.value / 100.0).clamp(-1.0, 1.0)
                } else {
                    payload.value.clamp(-1.0, 1.0)
                };
                upsert_static_automation_lane(track, "plugin.pan", pan);
            }
            "width" | "utility.width" | "plugin.width" => {
                upsert_static_automation_lane(track, "plugin.width", payload.value.clamp(0.0, 200.0));
            }
            "mono" | "utility.mono" | "plugin.mono" => {
                upsert_static_automation_lane(track, "plugin.mono", if payload.value >= 0.5 { 1.0 } else { 0.0 });
            }
            // Sampler parameters
            "sampler.volume" | "volume" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.volume = payload.value.clamp(0.0, 2.0);
                sampler_command_needed = true;
            }
            "sampler.attack" | "attack" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.attack = payload.value.clamp(0.001, 10.0);
                sampler_command_needed = true;
            }
            "sampler.decay" | "decay" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.decay = payload.value.clamp(0.001, 10.0);
                sampler_command_needed = true;
            }
            "sampler.sustain" | "sustain" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.sustain = payload.value.clamp(0.0, 1.0);
                sampler_command_needed = true;
            }
            "sampler.release" | "release" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.release = payload.value.clamp(0.001, 20.0);
                sampler_command_needed = true;
            }
            "sampler.rootnote" | "rootnote" | "sampler.root_note" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.root_note = payload.value.round().clamp(0.0, 127.0) as u8;
                sampler_command_needed = true;
            }
            _ => {
                // Keep unknown params round-trippable in automation lanes.
                upsert_static_automation_lane(track, &payload.param_id, payload.value);
            }
        }

        if sampler_command_needed {
            (idx, track.sampler.clone())
        } else {
            (idx, None)
        }
    };

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_automation_snapshot_from_project(&project, &automation_runtime);
    rebuild_sampler_snapshot_from_project(&project, &clip_pool_state, &handle);

    if sampler_command_needed {
        if let Some(cfg) = &sampler_cfg_for_rt {
            let idx = track_index as u16;
            push_command(&handle, EngineCommand::SetSamplerRootNote {
                track_index: idx,
                root_note: cfg.root_note,
            })?;
            push_command(&handle, EngineCommand::SetSamplerVolume {
                track_index: idx,
                volume: cfg.volume as f32,
            })?;
            push_command(&handle, EngineCommand::SetSamplerAdsr {
                track_index: idx,
                attack: cfg.attack as f32,
                decay: cfg.decay as f32,
                sustain: cfg.sustain as f32,
                release: cfg.release as f32,
            })?;
        }
    }

    log::debug!(
        "[IPC] set_internal_plugin_param_cmd(track={}, slot={}, param={} value={})",
        payload.track_id,
        payload.slot_id,
        payload.param_id,
        payload.value
    );
    Ok(())
}

/// Assign sample file to a track sampler and stream it to the realtime engine.
#[tauri::command]
fn set_sampler_sample_cmd(
    payload: SetSamplerSamplePayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let sample_path = payload.sample_path.clone();
    if !PathBuf::from(&sample_path).exists() {
        return Err(format!("Sample path does not exist: {}", sample_path));
    }

    let decoded = AudioReader::read(PathBuf::from(&sample_path))
        .map_err(|e| format!("Failed to decode sample: {e}"))?;
    let clip_audio = ClipAudio::new(sample_path.clone(), decoded.channels, decoded.sample_rate);

    let sample_arc = {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        pool.insert(clip_audio);
        pool.get(&sample_path)
            .ok_or_else(|| "Failed to cache decoded sampler sample".to_string())?
    };
    clip_pool_state.sync_pool_to_arc();

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let (track_index, sampler_cfg) = {
        let (idx, track) = project
            .tracks
            .iter_mut()
            .enumerate()
            .find(|(_, t)| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

        let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
        cfg.sample_path = sample_path.clone();
        if let Some(root) = payload.root_note {
            cfg.root_note = root.min(127);
        }
        (idx, cfg.clone())
    };

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    handle
        .sampler_samples
        .set_track_sample(track_index, Some(sample_arc));

    let idx = track_index as u16;
    push_command(&handle, EngineCommand::SetSamplerRootNote {
        track_index: idx,
        root_note: sampler_cfg.root_note,
    })?;
    push_command(&handle, EngineCommand::SetSamplerVolume {
        track_index: idx,
        volume: sampler_cfg.volume as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerAdsr {
        track_index: idx,
        attack: sampler_cfg.attack as f32,
        decay: sampler_cfg.decay as f32,
        sustain: sampler_cfg.sustain as f32,
        release: sampler_cfg.release as f32,
    })?;

    log::info!(
        "[IPC] set_sampler_sample_cmd(track={}, path={})",
        payload.track_id,
        sample_path
    );
    Ok(())
}

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

                // Route live MIDI to first armed track (fallback track 0).
                let target_track = {
                    let project_state: tauri::State<'_, ProjectState> = app_for_cb.state();
                    match project_state.project.lock() {
                        Ok(project) => project
                            .tracks
                            .iter()
                            .position(|t| t.is_armed)
                            .unwrap_or(0),
                        Err(_) => 0,
                    }
                };

                let engine_handle: tauri::State<'_, AudioEngineHandle> = app_for_cb.state();
                match status {
                    0x90 if velocity > 0 => {
                        let _ = push_command(
                            &engine_handle,
                            EngineCommand::SamplerNoteOn {
                                track_index: target_track as u16,
                                pitch: note,
                                velocity,
                            },
                        );
                    }
                    0x80 | 0x90 => {
                        let _ = push_command(
                            &engine_handle,
                            EngineCommand::SamplerNoteOff {
                                track_index: target_track as u16,
                                pitch: note,
                            },
                        );
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
            play,
            stop,
            toggle_playback,
            seek,
            seek_seconds,
            seek_to_beat,
            set_bpm,
            set_loop,
            // Track Control
            set_track_volume,
            set_track_pan,
            set_master_volume,
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
            get_samples_path,
            // File Browser
            generate_demo_samples_cmd,
            scan_audio_folder,
            scan_all_audio_sources,
            scan_folder_all,
            scan_plugin_folders,
            get_browser_folders,
            add_browser_folder,
            remove_browser_folder,
            preview_audio_file_cmd,
            stop_preview_cmd,
            pick_folder,
            pick_project_file,
            save_project_dialog,
            // Splash
            expand_window,
            // Legacy
            set_frequency,
            // Audio Import
            import_audio_file,
            create_midi_clip_cmd,
            update_midi_clip_cmd,
            // Waveform
            get_waveform_peaks,
            // Track Management
            add_track_cmd,
            delete_track_cmd,
            rename_track_cmd,
            // Clip Editing
            move_clip_cmd,
            split_clip_cmd,
            delete_clip_cmd,
            set_clip_fades_cmd,
            set_clip_source_offset_cmd,
            resolve_missing_file_cmd,
            // Automation / recording / export
            set_automation_points_cmd,
            arm_track_cmd,
            start_recording_cmd,
            stop_recording_cmd,
            export_mix_cmd,
            cancel_export_cmd,
            // Undo/Redo
            undo_cmd,
            redo_cmd,
            // Audio Device Management
            get_audio_devices,
            set_audio_device,
            restart_audio_engine,
            // MIDI input
            get_midi_inputs,
            connect_midi_input,
            // Epic 2: plugin windows + routing
            open_plugin_window,
            can_open_plugin_editor,
            close_plugin_window,
            log_frontend_error,
            get_routing_targets,
            set_track_routing_cmd,
            set_track_input_cmd,
            add_plugin_to_track_cmd,
            remove_plugin_from_track_cmd,
            set_internal_plugin_param_cmd,
            set_sampler_sample_cmd,
            // Device Chain
            add_device_cmd,
            remove_device_cmd,
            bypass_device_cmd,
            set_device_param_cmd,
            // Project Management (extended)
            create_backup_cmd,
            mark_dirty_cmd,
            sync_title_cmd,
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
