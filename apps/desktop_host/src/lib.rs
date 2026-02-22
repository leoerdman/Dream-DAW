#![allow(clippy::collapsible_if)]
#![allow(clippy::excessive_precision)]
#![allow(clippy::if_same_then_else)]
#![allow(clippy::manual_find)]
#![allow(clippy::manual_range_patterns)]
#![allow(clippy::match_result_ok)]
#![allow(clippy::needless_borrow)]
#![allow(clippy::needless_return)]
#![allow(clippy::no_effect_replace)]
#![allow(clippy::question_mark)]
#![allow(clippy::single_match)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::type_complexity)]
#![allow(clippy::vec_init_then_push)]

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

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::state_managers::sync_engine::*;
use arc_swap::ArcSwap;

use dream_clip_engine::midi_scheduler::MidiScheduler;
use dream_clip_engine::pool::{ClipAudio, ClipPool};
use dream_engine::driver::{
    AutomationPoint, ExternalParamAutomationLane, MidiFxRuntimeConfig, MidiTrackRuntime,
    SharedRtDebugStats, TrackAutomationState, parse_external_param_target,
};
use dream_engine::offline_bounce::{BounceConfig, OfflineBouncer};
use dream_engine::recording::RecordingSession;
use dream_engine::render_callback::MAX_TRACKS;
use dream_io::audio_reader::AudioReader;
use dream_io::peak_cache::{PeakCache, WaveformPeaks};
use dream_io::project_file::ProjectFile;
use dream_io::project_manager::ProjectManager;
use dream_io::wav_writer::WavWriter;
use dream_ipc::metering::MeterBank;
use dream_ipc::{EngineCommand, MasterClock};
use dream_models::PlaybackState;
use dream_models::midi::{MidiClip, MidiNote, SampleRackConfig, SamplerConfig};
use dream_models::mutators::{self};
use dream_models::project::{
    AudioClip, DeviceNode, PluginSlot, Project, Track, TrackColor, TrackType,
};
use dream_models::time::AbsoluteTime;
use dream_plugins::format::PluginFormat;
use dream_plugins::{MidiEvent as PluginMidiEvent, PluginSandboxSnapshot};
use midir::MidiInput;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use uuid::Uuid;

// Audio Engine State and Spectrum Analyzer State
// Extracted to: apps/desktop_host/src/state_managers/audio_engine.rs

// ── Project State (managed by Tauri) ──────────────────────────────────

// Structural-sharing snapshots, undo/redo, and project history.
// Extracted to: apps/desktop_host/src/snapshot.rs
mod snapshot;
use snapshot::*;

// Application settings, recent projects, and time utilities.
// Extracted to: apps/desktop_host/src/settings.rs
mod settings;
use settings::*;

// Sandbox crash mapping and project plugin-slot bypass helpers.
mod plugin_sandbox_recovery;
use plugin_sandbox_recovery::*;

// ── State Manager Modules ─────────────────────────────────────────────
// PluginHostState, RecordingRuntime, AutomationRuntime, MidiInputRuntime
// are all extracted into dedicated files; the types are re-imported here
// so the rest of lib.rs can reference them without any path prefix.
mod state_managers;
pub use commands::payloads::*;
pub(crate) use state_managers::{
    AudioEngineHandle, AutomationRuntime, ClipPoolState, MidiInputRuntime, PluginHostState,
    RecordingRuntime, SpectrumState, SpectrumStateInner,
};

/// Thread-safe handle to the current project's state.
/// The project is independently managed from the audio engine.
/// Changes to the project trigger serialization and engine re-sync.
pub struct ProjectState {
    /// The currently loaded project.
    pub project: Mutex<Project>,

    /// Path to the current project file on disk. `None` if unsaved.
    pub file_path: Mutex<Option<PathBuf>>,

    /// Path to the project directory (Ableton-style folder). `None` if unsaved.
    pub project_folder: Mutex<Option<PathBuf>>,

    /// Whether the project has unsaved changes.
    pub is_dirty: Mutex<bool>,

    /// Undo/Redo history.
    undo: Mutex<UndoState>,
    history: Mutex<ProjectHistory>,

    /// Device clipboard — stores a copied DeviceNode for cross-track paste.
    pub device_clipboard: Mutex<Option<DeviceNode>>,
}

impl ProjectState {
    fn new() -> Self {
        Self {
            project: Mutex::new(Project::default()),
            file_path: Mutex::new(None),
            project_folder: Mutex::new(None),
            is_dirty: Mutex::new(false),
            undo: Mutex::new(UndoState::new()),
            history: Mutex::new(ProjectHistory::new()),
            device_clipboard: Mutex::new(None),
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
    fn clear_dirty(
        &self,
        project_name: &str,
        app: Option<&tauri::AppHandle>,
    ) -> Result<(), String> {
        *self.is_dirty.lock().map_err(|e| e.to_string())? = false;
        if let Some(app) = app
            && let Some(window) = app.get_webview_window("main")
        {
            let _ = window.set_title(&format!("Dream DAW — {}", project_name));
        }
        Ok(())
    }

    fn record_history(
        &self,
        kind: impl Into<String>,
        detail: impl Into<String>,
    ) -> Result<(), String> {
        let mut history = self.history.lock().map_err(|e| e.to_string())?;
        history.push(kind, detail);
        Ok(())
    }

    fn history_snapshot(
        &self,
        limit: Option<usize>,
        since_seq: Option<u64>,
    ) -> Result<Vec<ProjectHistoryEvent>, String> {
        let history = self.history.lock().map_err(|e| e.to_string())?;
        Ok(history.snapshot(limit, since_seq))
    }
}

// ── Sync Engine & Snapshot Builders ─────────────────────────────────────
// Extracted to: apps/desktop_host/src/state_managers/sync_engine.rs

fn read_meter(
    level: &dream_ipc::metering::LockFreeLevel,
) -> crate::commands::payloads::MeterReading {
    crate::commands::payloads::MeterReading {
        rms: level.load_rms(),
        peak: level.load_peak(),
        clipping: level.is_clipping(),
    }
}

mod commands;
// Tauri's `generate_handler!` macro requires `__cmd__*` internal macros
// (generated by `#[tauri::command]`) to be in the current scope.
// Using `commands::func` paths alone will NOT work — glob re-export is mandatory.
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
    let (mut producer, consumer) = rtrb::RingBuffer::<EngineCommand>::new(4096);
    let master_clock = Arc::new(MasterClock::new());
    let meter_bank = Arc::new(MeterBank::new(64)); // 64 tracks max
    let mut plugin_host_state = PluginHostState::new();

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
    crate::state_managers::rebuild_automation_snapshot_from_project(
        &bootstrap_project,
        &automation_runtime,
    );
    let sampler_samples = Arc::new(dream_engine::driver::SharedSamplerSamples::new());
    let sample_rack_samples = Arc::new(dream_engine::driver::SharedSampleRackSamples::new());
    let routing_snapshot_for_engine = Arc::clone(&clip_pool_state.routing_snapshot);
    let prepared_graph_snapshot_for_engine = Arc::clone(&clip_pool_state.prepared_graph_snapshot);
    let sidechain_snapshot_for_engine = Arc::clone(&clip_pool_state.sidechain_snapshot);
    let external_fx_snapshot_for_engine = Arc::clone(&clip_pool_state.external_fx_snapshot);
    let midi_snapshot_for_engine = Arc::clone(&midi_snapshot);
    let automation_snapshot_for_engine = Arc::clone(&automation_runtime.snapshot);
    let sampler_samples_for_engine = Arc::clone(&sampler_samples);
    let sample_rack_samples_for_engine = Arc::clone(&sample_rack_samples);
    let clip_pool_for_handle = Arc::clone(&clip_pool_state.arc_pool);
    let clip_snapshot_for_handle = Arc::clone(&clip_pool_state.snapshot);
    let midi_snapshot_for_handle = Arc::clone(&midi_snapshot);
    let routing_snapshot_for_handle = Arc::clone(&clip_pool_state.routing_snapshot);
    let prepared_graph_snapshot_for_handle = Arc::clone(&clip_pool_state.prepared_graph_snapshot);
    let sidechain_snapshot_for_handle = Arc::clone(&clip_pool_state.sidechain_snapshot);
    let external_fx_snapshot_for_handle = Arc::clone(&clip_pool_state.external_fx_snapshot);
    let automation_snapshot_for_handle = Arc::clone(&automation_runtime.snapshot);
    let sampler_samples_for_handle = Arc::clone(&sampler_samples);
    let sample_rack_samples_for_handle = Arc::clone(&sample_rack_samples);
    let plugin_host_for_handle = Arc::clone(&plugin_host_state.host);
    let plugin_registry = Arc::new(dream_engine::driver::SharedPluginRegistry::new());
    plugin_host_state.set_plugin_registry(Arc::clone(&plugin_registry));
    let plugin_registry_for_engine = Arc::clone(&plugin_registry);
    let plugin_registry_for_handle = Arc::clone(&plugin_registry);
    let rt_debug_stats = Arc::new(SharedRtDebugStats::new());
    let rt_debug_stats_for_engine = Arc::clone(&rt_debug_stats);
    let rt_debug_stats_for_handle = Arc::clone(&rt_debug_stats);

    // Create preview buffer Arcs (shared between engine handle and audio driver)
    let preview_buffer: Arc<ArcSwap<Option<Vec<f32>>>> = Arc::new(ArcSwap::from_pointee(None));
    let preview_cursor: Arc<std::sync::atomic::AtomicUsize> =
        Arc::new(std::sync::atomic::AtomicUsize::new(0));
    // SSOT-FIX: Source SR of preview audio for pitch-correct playback
    let preview_source_sr: Arc<std::sync::atomic::AtomicU32> =
        Arc::new(std::sync::atomic::AtomicU32::new(0));
    let preview_buffer_for_engine = Arc::clone(&preview_buffer);
    let preview_cursor_for_engine = Arc::clone(&preview_cursor);
    let preview_source_sr_for_engine = Arc::clone(&preview_source_sr);

    // Load settings from disk before booting audio so we can honor persisted
    // output device selection on startup.
    let app_data_dir_for_settings = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.dreamdaw.desktop");
    let settings_state = SettingsState::load_from_disk(&app_data_dir_for_settings);

    // Ensure User Info directory and initial settings.json exist
    if let Err(e) = settings_state.save_to_user_folder() {
        log::warn!("Failed to create initial settings file: {}", e);
    }

    let preferred_output_device = {
        let settings = settings_state.settings.lock().ok();
        settings
            .as_ref()
            .map(|s| s.output_device.clone())
            .filter(|v| !v.trim().is_empty())
    };

    let (stream_error_tx, stream_error_rx) = std::sync::mpsc::sync_channel::<String>(4);

    // Start the audio engine on a dedicated thread
    let clock_for_engine = Arc::clone(&master_clock);
    let meter_for_engine = Arc::clone(&meter_bank);
    let mut stream = match dream_engine::driver::start_audio_thread_on_device(
        consumer,
        clock_for_engine,
        meter_for_engine,
        clip_pool_for_engine,
        snapshot_for_engine,
        midi_snapshot_for_engine,
        routing_snapshot_for_engine,
        sidechain_snapshot_for_engine,
        external_fx_snapshot_for_engine,
        automation_snapshot_for_engine,
        sampler_samples_for_engine,
        sample_rack_samples_for_engine,
        prepared_graph_snapshot_for_engine,
        rt_debug_stats_for_engine,
        plugin_registry_for_engine,
        preview_buffer_for_engine,
        preview_cursor_for_engine,
        preview_source_sr_for_engine,
        preferred_output_device.as_deref(),
        Some(stream_error_tx.clone()),
    ) {
        Ok(stream) => stream,
        Err(err) => {
            log::error!("Fatal: failed to start audio engine: {err}");
            return;
        }
    };

    // Capture output latency from the stream handle before boxing
    let output_latency_frames = stream.output_latency_frames;
    let resolved_output_device = stream.output_device_name.clone();

    // Extract spectrum consumer from stream handle for real-time EQ display
    let spectrum_consumer = stream.spectrum_consumer.take();
    let spectrum_state = if let Some(consumer) = spectrum_consumer {
        SpectrumState {
            inner: Mutex::new(SpectrumStateInner {
                consumer,
                analyzer: dream_dsp::spectrum_analyzer::SpectrumAnalyzer::new(
                    stream.sample_rate_hz as f32,
                ),
                last_magnitudes: vec![
                    dream_dsp::spectrum_analyzer::FLOOR_DB;
                    dream_dsp::spectrum_analyzer::OUTPUT_BINS
                ],
            }),
        }
    } else {
        // Fallback: create a dummy consumer (no audio data)
        let (_producer, consumer) = rtrb::RingBuffer::<f32>::new(64);
        SpectrumState {
            inner: Mutex::new(SpectrumStateInner {
                consumer,
                analyzer: dream_dsp::spectrum_analyzer::SpectrumAnalyzer::new(
                    stream.sample_rate_hz as f32,
                ),
                last_magnitudes: vec![
                    dream_dsp::spectrum_analyzer::FLOOR_DB;
                    dream_dsp::spectrum_analyzer::OUTPUT_BINS
                ],
            }),
        }
    };

    let mut should_persist_resolved_output = false;
    {
        if let Ok(mut s) = settings_state.settings.lock()
            && s.output_device != resolved_output_device
        {
            s.output_device = resolved_output_device;
            should_persist_resolved_output = true;
        }
    }
    if should_persist_resolved_output && let Err(e) = settings_state.save_to_user_folder() {
        log::warn!("Failed to persist resolved output device: {}", e);
    }

    let mut playback_state = PlaybackState::default();
    playback_state.sample_rate = bootstrap_project.sample_rate.max(1.0);

    // Ensure audio callback starts in the same timeline sample-rate domain
    // as the bootstrap project before any transport activity.
    let _ = producer.push(EngineCommand::SetTimelineSampleRate(
        playback_state.sample_rate,
    ));

    let engine_handle = AudioEngineHandle {
        producer: Mutex::new(producer),
        master_clock,
        playback_state: Mutex::new(playback_state),
        meter_bank,
        _stream: Mutex::new(Some(Box::new(stream))),
        preview_buffer,
        preview_cursor,
        preview_source_sr,
        export_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        clip_pool: clip_pool_for_handle,
        clip_snapshot: clip_snapshot_for_handle,
        midi_snapshot: midi_snapshot_for_handle,
        routing_snapshot: routing_snapshot_for_handle,
        prepared_graph_snapshot: prepared_graph_snapshot_for_handle,
        sidechain_snapshot: sidechain_snapshot_for_handle,
        external_fx_snapshot: external_fx_snapshot_for_handle,
        automation_snapshot: automation_snapshot_for_handle,
        sampler_samples: sampler_samples_for_handle,
        sample_rack_samples: sample_rack_samples_for_handle,
        _plugin_host: plugin_host_for_handle,
        plugin_registry: plugin_registry_for_handle,
        rt_debug_stats: rt_debug_stats_for_handle,
        output_latency_frames,
        stream_error_tx,
        is_shutting_down: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };

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
        .manage(plugin_host_state)
        .manage(spectrum_state)
        .invoke_handler(commands::invoke_handler())
        .setup(|app| {

            // ── Telemetry Push Thread (30fps) ─────────────────────────
            // Replaces frontend requestAnimationFrame polling with
            // server-pushed events. Zero invoke() overhead per frame.
            let telemetry_app = app.handle().clone();

            if let Err(err) = std::thread::Builder::new()
                .name("telemetry-push".into())
                .spawn(move || {
                    let mut telemetry_tick_count: u64 = 0;
                    loop {
                        // BUG-14: Graceful shutdown check
                        {
                            let handle: tauri::State<'_, AudioEngineHandle> = telemetry_app.state();
                            if handle.is_shutting_down.load(std::sync::atomic::Ordering::Relaxed) {
                                log::info!("[Telemetry] Shutdown signal received, exiting thread.");
                                break;
                            }
                        }
                        std::thread::sleep(Duration::from_millis(33)); // ~30fps
                        telemetry_tick_count += 1;
                        // Heartbeat log every ~5s for diagnostics
                        if telemetry_tick_count % 150 == 0 {
                            log::debug!("[Telemetry] heartbeat tick={}", telemetry_tick_count);
                        }

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
                            let beats = seconds * state.bpm / 60.0;
                            let telemetry_timestamp_ms = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis())
                                .unwrap_or(0);
                            serde_json::json!({
                                "is_playing": state.is_playing,
                                "position_frames": frames,
                                "position_seconds": seconds,
                                "position_beats": beats,
                                "bpm": state.bpm,
                                "sample_rate": state.sample_rate,
                                "loop_enabled": state.loop_enabled,
                                "loop_start": state.loop_start,
                                "loop_end": state.loop_end,
                                "output_latency_frames": handle.output_latency_frames,
                                "telemetry_timestamp_ms": telemetry_timestamp_ms,
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

                        // ── Plugin dirty flag relay ──────────────────────
                        // VST3 IComponentHandler callbacks (performEdit,
                        // setDirty, restartComponent) set a global atomic.
                        // Poll it here and mark the project dirty so the
                        // title bar shows the unsaved asterisk (*).
                        if dream_plugins::vst3_host::take_plugin_state_dirty() {
                            let pstate: tauri::State<'_, ProjectState> = telemetry_app.state();
                            if let Ok(project) = pstate.project.lock() {
                                let _ = pstate.mark_dirty(&project.name, Some(&telemetry_app));
                            }
                        }
                    }
                })
            {
                log::warn!("Failed to spawn telemetry thread: {err}");
            }

            // ── Plugin Sandbox Watchdog Thread ────────────────────────
            let sandbox_app = app.handle().clone();
            if let Err(err) = std::thread::Builder::new()
                .name("plugin-sandbox-watchdog".into())
                .spawn(move || {
                    loop {
                        // BUG-14: Graceful shutdown check
                        {
                            let sandbox_app_state: tauri::State<'_, AudioEngineHandle> = sandbox_app.state();
                            if sandbox_app_state.is_shutting_down.load(std::sync::atomic::Ordering::Relaxed) {
                                log::info!("[Watchdog] Shutdown signal received, exiting thread.");
                                break;
                            }
                        }
                        std::thread::sleep(Duration::from_millis(75));
                        let plugin_host_state: tauri::State<'_, PluginHostState> = sandbox_app.state();
                        let (snapshot, crashes, recoveries) =
                            match plugin_host_state.tick_sandbox_watchdog_with_events() {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        let _ = sandbox_app.emit("plugin_sandbox_tick", &snapshot);
                        if !crashes.is_empty() || !recoveries.is_empty() {
                            let mut failed_instance_ids: HashSet<Uuid> = crashes
                                .iter()
                                .filter(|c| !c.auto_restarted)
                                .map(|c| c.instance_id)
                                .collect();
                            let recovered_instance_ids: HashSet<Uuid> =
                                recoveries.iter().map(|r| r.instance_id).collect();

                            // ENTERPRISE/Lazarus: if an instance both crashed and recovered
                            // within the same watchdog tick, treat it as recovered to avoid
                            // transient forced-bypass/event flicker in UI and routing state.
                            failed_instance_ids
                                .retain(|id| !recovered_instance_ids.contains(id));

                            let failed_slot_ids =
                                plugin_host_state.slot_ids_for_instance_ids(&failed_instance_ids);
                            let recovered_slot_ids =
                                plugin_host_state.slot_ids_for_instance_ids(&recovered_instance_ids);

                            if !failed_slot_ids.is_empty() || !recovered_slot_ids.is_empty() {
                                let clip_pool_state: tauri::State<'_, ClipPoolState> = sandbox_app.state();
                                let project_state: tauri::State<'_, ProjectState> = sandbox_app.state();
                                if let Ok(mut project) = project_state.project.lock() {
                                    let bypassed_changed = if failed_slot_ids.is_empty() {
                                        0
                                    } else {
                                        bypass_plugin_slots_in_project(&mut project, &failed_slot_ids)
                                    };
                                    let recovered_changed = if recovered_slot_ids.is_empty() {
                                        0
                                    } else {
                                        set_plugin_slots_bypass_in_project(
                                            &mut project,
                                            &recovered_slot_ids,
                                            false,
                                        )
                                    };

                                    if bypassed_changed > 0 || recovered_changed > 0 {
                                        clip_pool_state.rebuild_routing_only(&project);
                                        let slot_instance_map = plugin_host_state.slot_instance_snapshot();
                                        clip_pool_state.rebuild_external_fx_snapshot(
                                            &project,
                                            slot_instance_map.as_ref(),
                                        );
                                        let _ = project_state.mark_dirty(&project.name, Some(&sandbox_app));

                                        if bypassed_changed > 0 {
                                            let _ = sandbox_app.emit(
                                                "plugin_sandbox_auto_bypass",
                                                serde_json::json!({
                                                    "instanceIds": failed_instance_ids.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
                                                    "slotIds": failed_slot_ids.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                                                    "changedSlots": bypassed_changed,
                                                }),
                                            );
                                        }

                                        if recovered_changed > 0 {
                                            let _ = sandbox_app.emit(
                                                "plugin_sandbox_auto_recovered",
                                                serde_json::json!({
                                                    "instanceIds": recovered_instance_ids.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
                                                    "slotIds": recovered_slot_ids.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                                                    "changedSlots": recovered_changed,
                                                }),
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        for crash in crashes {
                            // Suppress transient crash events for instances that already
                            // recovered in this same tick.
                            if recoveries.iter().any(|r| r.instance_id == crash.instance_id) {
                                continue;
                            }
                            let _ = sandbox_app.emit("plugin_sandbox_crashed", &crash);
                        }
                        for recovery in recoveries {
                            let _ = sandbox_app.emit("plugin_sandbox_recovered", &recovery);
                        }
                    }
                })
            {
                log::warn!("Failed to spawn plugin sandbox watchdog thread: {err}");
            }

            // ── Audio Stream Error Relay (event-driven, zero polling) ─
            let stream_error_app = app.handle().clone();
            if let Err(err) = std::thread::Builder::new()
                .name("audio-stream-error-relay".into())
                .spawn(move || {
                    while let Ok(err_msg) = stream_error_rx.recv() {
                        let payload = serde_json::json!({
                            "error": err_msg,
                            "at_ms": std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis())
                                .unwrap_or(0),
                        });
                        let _ = stream_error_app.emit("audio_stream_error", payload);
                    }
                })
            {
                log::warn!("Failed to spawn audio stream error relay: {err}");
            }

            // ── macOS NSEvent Local Monitor (Space → Play/Stop) ────────
            // When a native VST3 plugin editor window has focus, the WebView
            // doesn't receive keyDown events, so the Space shortcut stops
            // working. This local event monitor intercepts Space at the
            // application level before it reaches any window.
            #[cfg(target_os = "macos")]
            {
                use std::sync::Arc;
                let transport_app = Arc::new(app.handle().clone());
                unsafe {
                    use objc::runtime::{Class, Object, BOOL, YES};
                    use objc::{msg_send, sel, sel_impl};
                    use std::os::raw::c_ulong;

                    // NSEventMaskKeyDown = 1 << 10
                    let mask: c_ulong = 1 << 10;

                    let transport_app_clone = Arc::clone(&transport_app);
                    let block = objc::rc::autoreleasepool(|| {
                        let block = block::ConcreteBlock::new(move |event: *mut Object| -> *mut Object {
                            let keycode: u16 = msg_send![event, keyCode];
                            // keyCode 49 = Space bar on macOS
                            if keycode == 49 {
                                let window: *mut Object = msg_send![event, window];
                                if !window.is_null() {
                                    let first_responder: *mut Object = msg_send![window, firstResponder];
                                    if !first_responder.is_null() {
                                        let class_ptr: *const Class = msg_send![first_responder, class];
                                        let c_name = objc::runtime::class_getName(class_ptr);
                                        let name = std::ffi::CStr::from_ptr(c_name).to_string_lossy();
                                        if name.contains("WebView") {
                                            // Let the frontend JS handle it (which has proper text input guards)
                                            return event;
                                        }
                                    }
                                }

                                let is_repeat: BOOL = msg_send![event, isARepeat];
                                if is_repeat != YES {
                                    let app_ref = Arc::clone(&transport_app_clone);
                                    // Mirror toggle_playback logic exactly
                                    let handle: tauri::State<'_, AudioEngineHandle> = app_ref.state();
                                    if let Ok(mut state) = handle.playback_state.lock() {
                                        let new_state = !state.is_playing;
                                        let sr = state.sample_rate;
                                        state.is_playing = new_state;
                                        drop(state);

                                        if let Ok(mut prod) = handle.producer.lock() {
                                            if new_state {
                                                let _ = prod.push(EngineCommand::SetTimelineSampleRate(sr));
                                            }
                                            let _ = prod.push(EngineCommand::SetPlay(new_state));
                                        }

                                        log::info!(
                                            "[NSEventMonitor] Space → {}",
                                            if new_state { "play" } else { "stop" }
                                        );
                                    }
                                    // Swallow the event so the plugin doesn't also receive Space
                                    return std::ptr::null_mut();
                                }
                            }
                            event
                        });
                        block.copy()
                    });

                    if let Some(ns_event_class) = Class::get("NSEvent") {
                        let _: *mut Object = msg_send![
                            ns_event_class,
                            addLocalMonitorForEventsMatchingMask: mask
                            handler: &*block
                        ];
                        // Intentionally leak the block — it must live for the app's lifetime.
                        std::mem::forget(block);
                    } else {
                        log::warn!(
                            "[NSEventMonitor] NSEvent class unavailable; skipping transport monitor install"
                        );
                    }
                }
                log::info!("[NSEventMonitor] Installed Space key local monitor for transport control");
            }

            log::info!(
                "Dream DAW v{} — Audio engine initialized ({} IPC commands registered)",
                app.package_info().version,
                33
            );
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|err| {
            log::error!("Fatal: failed to build Dream DAW: {err}");
            std::process::exit(1);
        })
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // ── Graceful plugin shutdown ──────────────────────────────
                // Third-party VST3 plugins (e.g. Slate Digital's SlateCore)
                // register C++ static destructors / atexit handlers that
                // try to use Objective-C objects during `exit()` teardown.
                // If plugins are still loaded when `process::exit()` fires,
                // their destructors hit nil ObjC pointers → SIGSEGV.
                //
                // By deactivating and dropping all plugin instances HERE
                // (before the process exits), their COM release / C++
                // destructor code runs in a safe, well-defined order.
                log::info!("[Dream DAW] RunEvent::Exit — initiating graceful shutdown");
                let plugin_state: tauri::State<'_, PluginHostState> = app_handle.state();
                plugin_state.shutdown_all_plugins();
                log::info!("[Dream DAW] Graceful shutdown complete, exiting");
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use dream_models::project::{
        DeviceNode, DeviceRack, PluginSlot, RackChain, RackType, TempoAutomationEvent, Track,
        TrackType,
    };
    use std::collections::HashMap;
    use uuid::Uuid;

    #[test]
    fn project_history_keeps_recent_events_with_monotonic_seq() {
        let mut history = ProjectHistory::new();
        for i in 0..(MAX_PROJECT_HISTORY + 5) {
            history.push("mutation", format!("event-{i}"));
        }

        let events = history.snapshot(None, None);
        assert_eq!(events.len(), MAX_PROJECT_HISTORY);
        assert_eq!(events.first().map(|e| e.seq), Some(6));
        assert_eq!(events.first().map(|e| e.detail.as_str()), Some("event-5"));
        assert_eq!(events.last().map(|e| e.detail.as_str()), Some("event-2052"));

        for pair in events.windows(2) {
            assert!(pair[0].seq < pair[1].seq);
        }
    }

    #[test]
    fn project_history_snapshot_since_returns_only_new_events() {
        let mut history = ProjectHistory::new();
        for i in 0..8 {
            history.push("mutation", format!("event-{i}"));
        }

        let events = history.snapshot(None, Some(5));
        assert_eq!(events.len(), 3);
        assert_eq!(events.first().map(|e| e.seq), Some(6));
        assert_eq!(events.last().map(|e| e.seq), Some(8));
    }

    #[test]
    fn project_history_snapshot_since_falls_back_after_reset_cursor() {
        let mut history = ProjectHistory::new();
        history.push("open_project", "loaded A");
        history.push("save", "saved A");

        let events = history.snapshot(Some(10), Some(999));
        assert_eq!(events.len(), 2);
        assert_eq!(events.first().map(|e| e.seq), Some(1));
        assert_eq!(events.last().map(|e| e.seq), Some(2));
    }

    #[test]
    fn push_undo_records_history_event() {
        let state = ProjectState::new();
        push_undo(&state).expect("push_undo should snapshot default project");

        let history = state
            .history_snapshot(None, None)
            .expect("history snapshot should be readable");
        assert_eq!(history.len(), 1);
        let event = &history[0];
        assert_eq!(event.kind, "mutation_snapshot");
        assert!(event.detail.contains("undo snapshot"));
        // Caller file path is only included when debug logging is enabled.
        // In test mode without RUST_LOG=debug, we just verify the snapshot was recorded.
    }

    #[test]
    fn external_fx_snapshot_includes_selected_rack_chain_and_master_chain() {
        let mut project = Project::default();
        project.tracks.clear();

        let mut track = Track::with_type("Audio 1", TrackType::Audio, 0);

        let muted_ext = PluginSlot::new("MutedExt", "vst3://ignored");
        let mut muted_chain = RackChain::new("Muted");
        muted_chain.is_mute = true;
        muted_chain.devices.push(DeviceNode::single(muted_ext));

        let ext_inst = PluginSlot::new("ExtInst", "vst3://instrument");
        let ext_inst_slot_id = ext_inst.id;
        let mut active_chain = RackChain::new("Active");
        active_chain.devices.push(DeviceNode::single(ext_inst));

        let mut instrument_rack = DeviceRack::new("InstRack", RackType::Instrument);
        instrument_rack.chains.push(muted_chain);
        instrument_rack.chains.push(active_chain);
        track.instrument = Some(DeviceNode::rack(instrument_rack));

        let internal_eq = PluginSlot::new("EQ8", "internal://effect/eq_eight");
        let external_fx = PluginSlot::new("OTT", "vst3://ott");
        let external_fx_slot_id = external_fx.id;

        let mut fx_chain = RackChain::new("Main");
        fx_chain.devices.push(DeviceNode::single(internal_eq));
        fx_chain.devices.push(DeviceNode::single(external_fx));
        let mut fx_rack = DeviceRack::new("FxRack", RackType::AudioEffect);
        fx_rack.chains.push(fx_chain);
        track.effects.push(DeviceNode::rack(fx_rack));
        project.add_track(track);

        let master_internal = PluginSlot::new("MasterEQ", "internal://effect/eq_eight");
        let master_external = PluginSlot::new("MasterLim", "vst3://limiter");
        let master_external_slot_id = master_external.id;
        let mut master_chain = RackChain::new("MasterMain");
        master_chain
            .devices
            .push(DeviceNode::single(master_internal));
        master_chain
            .devices
            .push(DeviceNode::single(master_external));
        let mut master_rack = DeviceRack::new("MasterRack", RackType::AudioEffect);
        master_rack.chains.push(master_chain);
        project
            .master_track
            .effects
            .push(DeviceNode::rack(master_rack));

        let mut slot_instance_map = HashMap::<Uuid, Uuid>::new();
        slot_instance_map.insert(ext_inst_slot_id, Uuid::new_v4());
        slot_instance_map.insert(external_fx_slot_id, Uuid::new_v4());
        slot_instance_map.insert(master_external_slot_id, Uuid::new_v4());

        let state = ClipPoolState::new();
        state.rebuild_external_fx_snapshot(&project, &slot_instance_map);
        let snapshot = state.external_fx_snapshot.load();

        assert_eq!(snapshot.len(), 2, "expected 1 track + master snapshot");

        let track_slots = &snapshot[0];
        assert_eq!(
            track_slots.len(),
            3,
            "expected external instrument + internal effect + external effect"
        );
        assert!(track_slots[0].instance_id.is_some());
        assert_eq!(track_slots[0].internal_slot_index, None);
        assert_eq!(track_slots[1].internal_slot_index, Some(0));
        assert!(track_slots[2].instance_id.is_some());

        let master_slots = &snapshot[1];
        assert_eq!(
            master_slots.len(),
            2,
            "expected internal + external master FX"
        );
        assert_eq!(master_slots[0].internal_slot_index, Some(0));
        assert!(master_slots[1].instance_id.is_some());
    }

    #[test]
    fn external_fx_snapshot_skips_bypassed_internal_effects() {
        let mut project = Project::default();
        project.tracks.clear();

        let mut track = Track::with_type("Audio 1", TrackType::Audio, 0);
        let mut bypassed_internal = PluginSlot::new("BypassedEQ", "internal://effect/eq_eight");
        bypassed_internal.is_bypassed = true;
        let active_internal = PluginSlot::new("ActiveComp", "internal://effect/compressor");
        track.effects.push(DeviceNode::single(bypassed_internal));
        track.effects.push(DeviceNode::single(active_internal));
        project.add_track(track);

        let mut bypassed_master_internal =
            PluginSlot::new("MasterBypassedEQ", "internal://effect/eq_eight");
        bypassed_master_internal.is_bypassed = true;
        let active_master_internal =
            PluginSlot::new("MasterActiveComp", "internal://effect/compressor");
        project
            .master_track
            .effects
            .push(DeviceNode::single(bypassed_master_internal));
        project
            .master_track
            .effects
            .push(DeviceNode::single(active_master_internal));

        let state = ClipPoolState::new();
        state.rebuild_external_fx_snapshot(&project, &HashMap::new());
        let snapshot = state.external_fx_snapshot.load();

        assert_eq!(snapshot.len(), 2, "expected 1 track + master snapshot");

        let track_slots = &snapshot[0];
        assert_eq!(
            track_slots.len(),
            1,
            "bypassed internal FX on track must be excluded from runtime slots"
        );
        assert_eq!(track_slots[0].internal_slot_index, Some(0));

        let master_slots = &snapshot[1];
        assert_eq!(
            master_slots.len(),
            1,
            "bypassed internal FX on master must be excluded from runtime slots"
        );
        assert_eq!(master_slots[0].internal_slot_index, Some(0));
    }

    #[test]
    fn bypass_plugin_slots_in_project_sets_only_target_slots() {
        let mut project = Project::default();
        project.tracks.clear();

        let mut track = Track::with_type("Audio 1", TrackType::Audio, 0);
        let slot_a = PluginSlot::new("A", "vst3://a");
        let slot_a_id = slot_a.id;
        let slot_b = PluginSlot::new("B", "vst3://b");
        let slot_b_id = slot_b.id;
        track.effects.push(DeviceNode::single(slot_a));
        track.effects.push(DeviceNode::single(slot_b));
        project.add_track(track);

        let mut target_ids = HashSet::new();
        target_ids.insert(slot_a_id);

        let changed = bypass_plugin_slots_in_project(&mut project, &target_ids);
        assert_eq!(changed, 1);

        let mut a_bypassed = None;
        let mut b_bypassed = None;
        for node in &project.tracks[0].effects {
            for slot in node.collect_plugin_slots() {
                if slot.id == slot_a_id {
                    a_bypassed = Some(slot.is_bypassed);
                }
                if slot.id == slot_b_id {
                    b_bypassed = Some(slot.is_bypassed);
                }
            }
        }

        assert_eq!(a_bypassed, Some(true));
        assert_eq!(b_bypassed, Some(false));
    }

    #[test]
    fn set_plugin_slots_bypass_in_project_can_clear_bypass_after_recovery() {
        let mut project = Project::default();
        project.tracks.clear();

        let mut track = Track::with_type("Audio 1", TrackType::Audio, 0);
        let mut slot = PluginSlot::new("A", "vst3://a");
        let slot_id = slot.id;
        slot.is_bypassed = true;
        track.effects.push(DeviceNode::single(slot));
        project.add_track(track);

        let mut target_ids = HashSet::new();
        target_ids.insert(slot_id);

        let changed = set_plugin_slots_bypass_in_project(&mut project, &target_ids, false);
        assert_eq!(changed, 1);

        let mut bypass_state = None;
        for node in &project.tracks[0].effects {
            for slot_ref in node.collect_plugin_slots() {
                if slot_ref.id == slot_id {
                    bypass_state = Some(slot_ref.is_bypassed);
                }
            }
        }
        assert_eq!(bypass_state, Some(false));
    }

    #[test]
    fn sidechain_snapshot_ignores_muted_or_bypassed_rack_paths() {
        let mut project = Project::default();
        project.tracks.clear();

        let source = Track::with_type("Source", TrackType::Audio, 0);
        let source_id = source.id.to_string();
        let source_track_index = project.tracks.len();
        project.add_track(source);

        let mut target = Track::with_type("Target", TrackType::Audio, 1);

        let mut muted_slot = PluginSlot::new("MutedSC", "vst3://sc-muted");
        muted_slot.sidechain_source_track_id = Some(source_id.clone());
        let mut muted_chain = RackChain::new("Muted");
        muted_chain.is_mute = true;
        muted_chain.devices.push(DeviceNode::single(muted_slot));

        let mut bypassed_slot = PluginSlot::new("BypassedSC", "vst3://sc-bypassed");
        bypassed_slot.is_bypassed = true;
        bypassed_slot.sidechain_source_track_id = Some(source_id.clone());
        let mut active_chain = RackChain::new("Active");
        active_chain.devices.push(DeviceNode::single(bypassed_slot));

        let mut rack = DeviceRack::new("SidechainRack", RackType::AudioEffect);
        rack.chains.push(muted_chain);
        rack.chains.push(active_chain);
        target.effects.push(DeviceNode::rack(rack));
        let target_track_index = project.tracks.len();
        project.add_track(target);

        let state = ClipPoolState::new();
        state.rebuild_snapshot(&project);
        let sidechains = state.sidechain_snapshot.load();

        assert_eq!(sidechains.len(), 2);
        assert!(
            sidechains[target_track_index].is_empty(),
            "muted/bypassed rack branches must not contribute sidechain deps"
        );
        assert!(
            sidechains[source_track_index].is_empty(),
            "source track should have no sidechain dependencies"
        );
    }

    #[test]
    fn external_fx_snapshot_caps_tracks_to_max_tracks_and_keeps_master_at_tail() {
        let mut project = Project::default();
        project.tracks.clear();

        let mut slot_instance_map = HashMap::<Uuid, Uuid>::new();

        for idx in 0..(MAX_TRACKS + 5) {
            let mut track = Track::with_type(format!("T{idx}"), TrackType::Audio, idx);
            let ext_fx = PluginSlot::new(format!("FX{idx}"), format!("vst3://fx-{idx}"));
            slot_instance_map.insert(ext_fx.id, Uuid::new_v4());
            track.effects.push(DeviceNode::single(ext_fx));
            project.add_track(track);
        }

        let master_external = PluginSlot::new("MasterLim", "vst3://master-lim");
        let master_external_slot_id = master_external.id;
        project
            .master_track
            .effects
            .push(DeviceNode::single(master_external));
        slot_instance_map.insert(master_external_slot_id, Uuid::new_v4());

        let state = ClipPoolState::new();
        state.rebuild_external_fx_snapshot(&project, &slot_instance_map);
        let snapshot = state.external_fx_snapshot.load();

        assert_eq!(
            snapshot.len(),
            MAX_TRACKS + 1,
            "snapshot must be capped to MAX_TRACKS tracks plus master tail"
        );
        assert!(
            snapshot[MAX_TRACKS]
                .iter()
                .any(|slot| slot.instance_id.is_some()),
            "master chain must remain at tail index MAX_TRACKS"
        );
    }

    #[test]
    fn project_initial_transport_bpm_prefers_tempo_automation_at_zero() {
        let mut project = Project::new("Tempo Test", 120.0, 44100.0);
        project.tempo_automation_events = vec![
            TempoAutomationEvent {
                beat: 0.0,
                bpm: 174.0,
                curve_type: "linear".to_string(),
            },
            TempoAutomationEvent {
                beat: 16.0,
                bpm: 170.0,
                curve_type: "linear".to_string(),
            },
        ];

        let bpm = project_initial_transport_bpm(&project);
        assert!((bpm - 174.0).abs() < 1e-9);
    }

    #[test]
    fn project_initial_transport_bpm_keeps_pulse_map_when_no_zero_beat_automation() {
        let mut project = Project::new("Tempo Base", 128.0, 44100.0);
        project.tempo_automation_events = vec![TempoAutomationEvent {
            beat: 8.0,
            bpm: 160.0,
            curve_type: "linear".to_string(),
        }];

        let bpm = project_initial_transport_bpm(&project);
        assert!((bpm - 128.0).abs() < 1e-9);
    }
}
