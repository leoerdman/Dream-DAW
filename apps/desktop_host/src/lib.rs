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

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use arc_swap::ArcSwap;

use dream_clip_engine::midi_scheduler::MidiScheduler;
use dream_clip_engine::pool::{ClipAudio, ClipPool};
use dream_engine::driver::{
    AutomationPoint, ExternalParamAutomationLane, MidiFxRuntimeConfig, MidiTrackRuntime,
    SharedClipSnapshot, SharedExternalFxSnapshot, SharedPreparedGraphSnapshot,
    SharedRoutingSnapshot, SharedRtDebugStats, SharedSidechainSnapshot, TrackAutomationState,
    parse_external_param_target,
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
use dream_plugins::{
    MidiEvent as PluginMidiEvent, PluginSandboxSnapshot,
};
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
pub(crate) use state_managers::{
    AudioEngineHandle, AutomationRuntime, MidiInputRuntime, PluginHostState, RecordingRuntime,
    SpectrumState, SpectrumStateInner,
};

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
    history: Mutex<ProjectHistory>,

    /// Device clipboard — stores a copied DeviceNode for cross-track paste.
    device_clipboard: Mutex<Option<DeviceNode>>,
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

/// BUG-063 FIX: Macro for best-effort command pushes that logs failures
/// instead of silently dropping them with `let _ =`.
/// Use this in restore/rebuild functions where individual parameter
/// failures should not abort the entire operation.
macro_rules! push_command_or_log {
    ($handle:expr, $cmd:expr, $context:expr) => {
        if let Err(err) = push_command($handle, $cmd) {
            log::warn!(
                "[Engine] BUG-063: Failed to push command ({}): {}",
                $context,
                err
            );
        }
    };
}

/// Snapshots the current project state onto the undo stack.
///
/// Must be called BEFORE any mutation. Clears the redo stack
/// (a new action invalidates the redo history).
#[track_caller]
fn push_undo(project_state: &ProjectState) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut undo = project_state.undo.lock().map_err(|e| e.to_string())?;
    let previous = undo.undo_stack.back();
    let snapshot = SharedProjectSnapshot::from_project(&project, previous);
    drop(project);
    undo.undo_stack.push_back(snapshot);
    let depth = undo.undo_stack.len();
    if undo.undo_stack.len() > MAX_UNDO_DEPTH {
        undo.undo_stack.pop_front(); // O(1) eviction via VecDeque ring buffer
    }
    undo.redo_stack.clear();
    drop(undo);

    // Always record the history event (it's lightweight and needed for undo/redo tracking).
    // BUG-FIX: Avoid format! heap allocation per push_undo in release builds.
    // Use a static detail string when debug logging is disabled.
    let detail = if log::log_enabled!(log::Level::Debug) {
        let caller = std::panic::Location::caller();
        format!(
            "captured undo snapshot depth={} caller={}:{}",
            depth,
            caller.file(),
            caller.line()
        )
    } else {
        String::from("undo snapshot")
    };
    project_state.record_history("mutation_snapshot", detail)?;
    Ok(())
}

/// Coalesced undo for rapid sequential operations (move/resize/drag).
///
/// If the last undo snapshot was pushed within `COALESCE_WINDOW_MS`,
/// replaces it instead of pushing a new one. This prevents undo stack bloat
/// when the user rapidly operates on clips and reduces lock contention
/// that contributes to audio stutter during playback.
const COALESCE_WINDOW_MS: u128 = 300;
static LAST_UNDO_PUSH_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[track_caller]
fn push_undo_coalesced(project_state: &ProjectState) -> Result<(), String> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let last_ms = LAST_UNDO_PUSH_MS.load(std::sync::atomic::Ordering::Relaxed);

    if last_ms > 0 && (now_ms.saturating_sub(last_ms) as u128) < COALESCE_WINDOW_MS {
        // Coalesce: replace the top of the undo stack instead of pushing a new entry.
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let mut undo = project_state.undo.lock().map_err(|e| e.to_string())?;
        let stack_len = undo.undo_stack.len();
        if stack_len > 0 {
            // Compute snapshot first using the second-to-last entry as delta base.
            let previous = if stack_len >= 2 {
                undo.undo_stack.get(stack_len - 2)
            } else {
                None
            };
            let new_snapshot = SharedProjectSnapshot::from_project(&project, previous);
            // Now replace the top entry.
            if let Some(top) = undo.undo_stack.back_mut() {
                *top = new_snapshot;
            }
        }
        // Update timestamp but don't push a new entry.
        LAST_UNDO_PUSH_MS.store(now_ms, std::sync::atomic::Ordering::Relaxed);
        return Ok(());
    }

    // First operation in a new coalesce window — push normally.
    LAST_UNDO_PUSH_MS.store(now_ms, std::sync::atomic::Ordering::Relaxed);
    push_undo(project_state)
}

/// BUG-009 FIX: Cache seen file paths to avoid redundant `Path::exists()` syscalls.
/// With 100 clips sharing 10 unique files, this reduces I/O from 100 to 10 calls.
fn refresh_offline_flags(project: &mut Project) {
    let mut offline_cache: std::collections::HashMap<String, bool> =
        std::collections::HashMap::new();
    for track in &mut project.tracks {
        for clip in &mut track.clips {
            let is_offline = *offline_cache
                .entry(clip.file_path.clone())
                .or_insert_with(|| !PathBuf::from(&clip.file_path).exists());
            clip.is_offline = is_offline;
        }
    }
}

fn rebuild_automation_snapshot_from_project(
    project: &Project,
    automation_runtime: &AutomationRuntime,
) {
    fn normalize_pan_value(raw: f32) -> f32 {
        // Track pan in the project/import model is bipolar [-1..1].
        // Treating [0..1] as a separate domain is ambiguous and maps 0.0
        // (center in many projects) to -1.0 (hard-left), which collapses
        // stereo image after ALS import.
        raw.clamp(-1.0, 1.0)
    }

    fn is_track_pan_param(key: &str) -> bool {
        matches!(key, "pan" | "track.pan" | "mixer.pan")
    }

    fn is_track_volume_param(key: &str) -> bool {
        matches!(
            key,
            "volume" | "gain" | "track.volume" | "track.gain" | "mixer.gain"
        )
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
                    p.value = normalize_pan_value(p.value);
                }
                state.pan = points;
            } else if is_track_volume_param(&key) {
                for p in &mut points {
                    p.value = p.value.clamp(0.0, 2.0);
                }
                state.volume = points;
            } else if !points.is_empty() {
                if let Some(alias) = canonical_plugin_param(&key) {
                    state
                        .plugin_params
                        .insert(alias.to_string(), points.clone());
                }
                if let Some(target) = parse_external_param_target(&lane.param_id) {
                    state
                        .external_plugin_params
                        .push(ExternalParamAutomationLane {
                            target,
                            points: points.clone(),
                        });
                }
                state.plugin_params.insert(lane.param_id.clone(), points);
            }
        }
        lanes[track_idx] = state;
    }

    automation_runtime.snapshot.swap(lanes);
}

fn rebuild_midi_snapshot_from_project(project: &Project, handle: &AudioEngineHandle) {
    fn sanitize_runtime_clip(mut clip: MidiClip) -> MidiClip {
        // Canonicalize notes for deterministic scheduling and guard against
        // accidental duplicate note entries produced by rapid editor edits.
        clip.notes.sort_by(|a, b| {
            a.start_frame
                .cmp(&b.start_frame)
                .then_with(|| a.pitch.cmp(&b.pitch))
                .then_with(|| a.duration_frames.cmp(&b.duration_frames))
                .then_with(|| a.velocity.cmp(&b.velocity))
        });

        if clip.notes.len() > 1 {
            let mut merged: Vec<dream_models::midi::MidiNote> =
                Vec::with_capacity(clip.notes.len());
            for note in clip.notes.into_iter() {
                if let Some(last) = merged.last_mut()
                    && last.pitch == note.pitch
                    && last.start_frame == note.start_frame
                {
                    last.duration_frames = last.duration_frames.max(note.duration_frames);
                    last.velocity = last.velocity.max(note.velocity);
                    continue;
                }
                merged.push(note);
            }
            clip.notes = merged;
        }

        clip.notes.sort_by_key(|n| n.start_frame);
        clip
    }

    fn first_lane_value(track: &Track, keys: &[&str], default: f32) -> f32 {
        for key in keys {
            if let Some(lane) = track
                .automation_lanes
                .iter()
                .find(|lane| lane.param_id.eq_ignore_ascii_case(key))
                && let Some(point) = lane.points.first()
            {
                return point.value as f32;
            }
        }
        default
    }

    let tracks: Vec<MidiTrackRuntime> = project
        .tracks
        .iter()
        .map(|track| {
            let has_pitch = track.effects.iter().any(|fx| {
                fx.plugin_id()
                    .eq_ignore_ascii_case("internal://midi-fx/pitch")
            });
            let has_scale = track.effects.iter().any(|fx| {
                fx.plugin_id()
                    .eq_ignore_ascii_case("internal://midi-fx/scale")
            });
            let has_velocity = track.effects.iter().any(|fx| {
                fx.plugin_id()
                    .eq_ignore_ascii_case("internal://midi-fx/velocity")
            });
            let has_random = track.effects.iter().any(|fx| {
                fx.plugin_id()
                    .eq_ignore_ascii_case("internal://midi-fx/random")
            });

            let fx = MidiFxRuntimeConfig {
                pitch_enabled: has_pitch,
                pitch_semitones: first_lane_value(
                    track,
                    &["midi.pitch.semitones", "midifx.pitch.semitones"],
                    0.0,
                )
                .round()
                .clamp(-48.0, 48.0) as i8,
                scale_enabled: has_scale,
                scale_root: first_lane_value(track, &["midi.scale.root", "midifx.scale.root"], 0.0)
                    .round()
                    .rem_euclid(12.0) as u8,
                scale_mask: first_lane_value(
                    track,
                    &["midi.scale.mask", "midifx.scale.mask"],
                    4095.0,
                )
                .round()
                .clamp(1.0, 4095.0) as u16,
                velocity_enabled: has_velocity,
                velocity_gain: first_lane_value(
                    track,
                    &["midi.velocity.gain", "midifx.velocity.gain"],
                    1.0,
                )
                .clamp(0.0, 4.0),
                velocity_offset: first_lane_value(
                    track,
                    &["midi.velocity.offset", "midifx.velocity.offset"],
                    0.0,
                )
                .round()
                .clamp(-127.0, 127.0) as i8,
                random_enabled: has_random,
                random_semitones: first_lane_value(
                    track,
                    &["midi.random.semitones", "midifx.random.semitones"],
                    0.0,
                )
                .round()
                .clamp(-24.0, 24.0) as i8,
                random_chance: first_lane_value(
                    track,
                    &["midi.random.chance", "midifx.random.chance"],
                    1.0,
                )
                .clamp(0.0, 1.0),
            };

            MidiTrackRuntime {
                clips: track
                    .midi_clips
                    .iter()
                    .cloned()
                    .map(sanitize_runtime_clip)
                    .collect(),
                fx,
            }
        })
        .collect();
    handle.midi_snapshot.swap(tracks);
}

fn rebuild_sampler_snapshot_from_project(
    project: &Project,
    clip_pool_state: &ClipPoolState,
    handle: &AudioEngineHandle,
) {
    fn waveform_code_from_token(token: &str) -> u8 {
        let normalized = token.trim().to_lowercase();
        if normalized.contains("triangle") || normalized.ends_with("/tri") {
            return 1;
        }
        if normalized.contains("saw") {
            return 2;
        }
        if normalized.contains("square") || normalized.ends_with("/pulse") {
            return 3;
        }
        0
    }

    let mut samples: Vec<Option<Arc<ClipAudio>>> = vec![None; project.tracks.len()];
    let empty_pad_samples: [Option<Arc<ClipAudio>>; 16] = Default::default();
    let mut rack_samples: Vec<[Option<Arc<ClipAudio>>; 16]> =
        vec![empty_pad_samples; project.tracks.len()];

    struct RackSettings {
        track_idx: u16,
        pad_idx: u8,
        volume: f32,
        attack: f32,
        decay: f32,
        sustain: f32,
        release: f32,
        filter_cutoff: f32,
    }
    let mut rack_settings: Vec<RackSettings> = Vec::new();

    let mut synth_settings: Vec<(
        usize,
        u8,
        u8,
        f32,
        f32,
        f32,
        f32,
        f32,
        u8,
        f32,
        f32,
        u8,
        f32,
    )> = Vec::new();
    if let Ok(pool) = clip_pool_state.pool.lock() {
        for (idx, track) in project.tracks.iter().enumerate() {
            let plugin_id_lower = track
                .instrument
                .as_ref()
                .map(|inst| inst.plugin_id().to_lowercase())
                .unwrap_or_default();
            let is_wave_synth = plugin_id_lower.starts_with("internal://instrument/wave-synth")
                || plugin_id_lower.starts_with("internal://instrument/simple-sine-synth");
            if is_wave_synth {
                let (
                    waveform,
                    osc2,
                    mix,
                    detune,
                    sub,
                    f_cutoff,
                    f_res,
                    f_type,
                    lfo_r,
                    lfo_d,
                    lfo_t,
                    pw,
                ) = track
                    .sampler
                    .as_ref()
                    .map(|cfg| {
                        (
                            waveform_code_from_token(&cfg.sample_path),
                            cfg.osc2_waveform.min(3),
                            cfg.osc_mix.clamp(0.0, 1.0) as f32,
                            cfg.detune_cents.clamp(-50.0, 50.0) as f32,
                            cfg.sub_level.clamp(0.0, 1.0) as f32,
                            cfg.filter_cutoff.clamp(20.0, 20000.0) as f32,
                            cfg.filter_resonance.clamp(0.0, 0.99) as f32,
                            cfg.filter_type.min(3),
                            cfg.lfo_rate.clamp(0.01, 20.0) as f32,
                            cfg.lfo_depth.clamp(0.0, 1.0) as f32,
                            cfg.lfo_target.min(2),
                            cfg.pulse_width.clamp(0.05, 0.95) as f32,
                        )
                    })
                    .unwrap_or((0, 0, 0.35, 0.0, 0.0, 20000.0, 0.0, 0, 1.0, 0.0, 0, 0.5));
                synth_settings.push((
                    idx, waveform, osc2, mix, detune, sub, f_cutoff, f_res, f_type, lfo_r, lfo_d,
                    lfo_t, pw,
                ));
            }
            if let Some(cfg) = &track.sampler
                && !cfg.sample_path.trim().is_empty()
                && !cfg.sample_path.starts_with("internal://")
                && let Some(audio) = pool.get(&cfg.sample_path)
            {
                samples[idx] = Some(audio);
            }

            if let Some(rack) = &track.sample_rack {
                for (p, pad) in rack.pads.iter().enumerate() {
                    rack_settings.push(RackSettings {
                        track_idx: idx as u16,
                        pad_idx: p as u8,
                        volume: pad.volume as f32,
                        attack: pad.attack as f32,
                        decay: pad.decay as f32,
                        sustain: pad.sustain as f32,
                        release: pad.release as f32,
                        filter_cutoff: pad.filter_cutoff as f32,
                    });
                    if !pad.sample_path.trim().is_empty()
                        && let Some(audio) = pool.get(&pad.sample_path)
                    {
                        rack_samples[idx][p] = Some(audio);
                    }
                }
            }
        }
    }
    handle.sampler_samples.swap(samples);
    handle.sample_rack_samples.swap(rack_samples);

    for (
        track_idx,
        waveform,
        osc2,
        mix,
        detune,
        sub,
        f_cutoff,
        f_res,
        f_type,
        lfo_r,
        lfo_d,
        lfo_t,
        pw,
    ) in synth_settings
    {
        if let Err(err) = push_command(
            handle,
            EngineCommand::SetSamplerWaveform {
                track_index: track_idx as u16,
                waveform,
            },
        ) {
            log::warn!(
                "[Sampler] Failed to restore waveform for track {}: {}",
                track_idx,
                err
            );
        }
        // BUG-063 FIX: Use push_command_or_log! instead of `let _ =` to ensure
        // queue-full conditions are visible in logs during sampler state restore.
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerOsc2Waveform {
                track_index: track_idx as u16,
                waveform: osc2,
            },
            "sampler osc2 waveform"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerOscMix {
                track_index: track_idx as u16,
                mix,
            },
            "sampler osc mix"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerDetuneCents {
                track_index: track_idx as u16,
                cents: detune,
            },
            "sampler detune"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerSubLevel {
                track_index: track_idx as u16,
                level: sub,
            },
            "sampler sub level"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerFilterCutoff {
                track_index: track_idx as u16,
                cutoff: f_cutoff,
            },
            "sampler filter cutoff"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerFilterResonance {
                track_index: track_idx as u16,
                resonance: f_res,
            },
            "sampler filter resonance"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerFilterType {
                track_index: track_idx as u16,
                filter_type: f_type,
            },
            "sampler filter type"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerLfoRate {
                track_index: track_idx as u16,
                rate: lfo_r,
            },
            "sampler lfo rate"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerLfoDepth {
                track_index: track_idx as u16,
                depth: lfo_d,
            },
            "sampler lfo depth"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerLfoTarget {
                track_index: track_idx as u16,
                target: lfo_t,
            },
            "sampler lfo target"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerPulseWidth {
                track_index: track_idx as u16,
                width: pw,
            },
            "sampler pulse width"
        );
    }

    for rs in rack_settings {
        push_command_or_log!(
            handle,
            EngineCommand::SetSampleRackPadVolume {
                track_index: rs.track_idx,
                pad_index: rs.pad_idx,
                volume: rs.volume,
            },
            "rack pad volume"
        );

        push_command_or_log!(
            handle,
            EngineCommand::SetSampleRackPadAdsr {
                track_index: rs.track_idx,
                pad_index: rs.pad_idx,
                attack: rs.attack,
                decay: rs.decay,
                sustain: rs.sustain,
                release: rs.release,
            },
            "rack pad adsr"
        );

        push_command_or_log!(
            handle,
            EngineCommand::SetSampleRackPadFilterCutoff {
                track_index: rs.track_idx,
                pad_index: rs.pad_idx,
                cutoff: rs.filter_cutoff,
            },
            "rack pad cutoff"
        );
    }
}

fn builtin_effect_type_from_plugin_id(plugin_id: &str) -> Option<u8> {
    dream_models::project::builtin_effect_type_from_plugin_id(plugin_id)
}

fn rebuild_runtime_device_chains_from_project(
    project: &Project,
    handle: &AudioEngineHandle,
) -> Result<(), String> {
    const MAX_DEVICE_SLOTS: u8 = 16;
    fn first_lane_value(track: &Track, keys: &[&str]) -> Option<f32> {
        for key in keys {
            if let Some(lane) = track
                .automation_lanes
                .iter()
                .find(|lane| lane.param_id.eq_ignore_ascii_case(key))
                && let Some(point) = lane.points.first()
            {
                return Some(point.value as f32);
            }
        }
        None
    }

    fn apply_static_imported_params_for_slot(
        handle: &AudioEngineHandle,
        track_index: u16,
        slot_index: u8,
        plugin_id: &str,
        track: &Track,
    ) -> Result<(), String> {
        let pid = plugin_id.to_ascii_lowercase();

        // UtilityProcessor params:
        // 0 gain dB, 1 pan %, 2 width %, 3 mono
        if pid == "internal://effect/utility" {
            if let Some(gain_lin) = first_lane_value(track, &["plugin.gain"]) {
                let gain_db = if gain_lin <= 0.00001 {
                    -60.0
                } else {
                    (20.0 * gain_lin.log10()).clamp(-60.0, 24.0)
                };
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: gain_db,
                    },
                )?;
            }
            if let Some(pan) = first_lane_value(track, &["plugin.pan"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: (pan * 100.0).clamp(-100.0, 100.0),
                    },
                )?;
            }
            if let Some(width) = first_lane_value(track, &["plugin.width"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: width.clamp(0.0, 200.0),
                    },
                )?;
            }
            if let Some(mono) = first_lane_value(track, &["plugin.mono"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: if mono >= 0.5 { 1.0 } else { 0.0 },
                    },
                )?;
            }
            return Ok(());
        }

        // EqProcessor param 32 = output gain dB.
        if pid == "internal://effect/eq-eight" {
            if let Some(out_gain) = first_lane_value(track, &["effect.eq.global_gain"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 32,
                        value: out_gain.clamp(-24.0, 24.0),
                    },
                )?;
            }
            for band in 0..8u8 {
                if let Some(v) = first_lane_value(track, &[&format!("effect.eq.band{band}.freq")]) {
                    push_command(
                        handle,
                        EngineCommand::SetDeviceParam {
                            track_index,
                            slot_index,
                            param_index: band * 4,
                            value: v.clamp(20.0, 20_000.0),
                        },
                    )?;
                }
                if let Some(v) = first_lane_value(track, &[&format!("effect.eq.band{band}.gain")]) {
                    push_command(
                        handle,
                        EngineCommand::SetDeviceParam {
                            track_index,
                            slot_index,
                            param_index: band * 4 + 1,
                            value: v.clamp(-24.0, 24.0),
                        },
                    )?;
                }
                if let Some(v) = first_lane_value(track, &[&format!("effect.eq.band{band}.q")]) {
                    push_command(
                        handle,
                        EngineCommand::SetDeviceParam {
                            track_index,
                            slot_index,
                            param_index: band * 4 + 2,
                            value: v.clamp(0.1, 18.0),
                        },
                    )?;
                }
                if let Some(v) = first_lane_value(track, &[&format!("effect.eq.band{band}.on")]) {
                    push_command(
                        handle,
                        EngineCommand::SetDeviceParam {
                            track_index,
                            slot_index,
                            param_index: band * 4 + 3,
                            value: if v >= 0.5 { 1.0 } else { 0.0 },
                        },
                    )?;
                }
            }
            return Ok(());
        }

        // AutoFilterProcessor:
        // 0 cutoff, 1 resonance %, 5 filter type, 8 drive dB.
        if pid == "internal://effect/auto-filter" {
            if let Some(cutoff) = first_lane_value(track, &["effect.auto_filter.cutoff"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: cutoff.clamp(20.0, 20_000.0),
                    },
                )?;
            }
            if let Some(res) = first_lane_value(track, &["effect.auto_filter.resonance"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: (res * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(ft) = first_lane_value(track, &["effect.auto_filter.type"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 5,
                        value: ft.round().clamp(0.0, 3.0),
                    },
                )?;
            }
            if let Some(drive) = first_lane_value(track, &["effect.auto_filter.drive"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 8,
                        value: drive.clamp(0.0, 24.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.lfo.rate"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: v.clamp(0.01, 20.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.lfo.depth"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.env.amount"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 4,
                        value: (v * 100.0).clamp(-100.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.mix"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 6,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.lfo.shape"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 7,
                        value: v.round().clamp(0.0, 5.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.env.speed_ms"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 9,
                        value: v.clamp(1.0, 200.0),
                    },
                )?;
            }
            return Ok(());
        }

        // CompressorProcessor:
        // 0 threshold, 1 ratio, 2 attack, 3 release, 4 knee, 5 makeup, 6 mix%.
        if pid == "internal://effect/compressor" {
            if let Some(v) = first_lane_value(track, &["effect.compressor.threshold"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: v.clamp(-60.0, 0.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.ratio"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: v.clamp(1.0, 20.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.attack"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: v.clamp(0.1, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.release"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: v.clamp(10.0, 1000.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.knee"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 4,
                        value: v.clamp(0.0, 24.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.makeup"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 5,
                        value: v.clamp(-12.0, 24.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.mix"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 6,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            return Ok(());
        }

        // ReverbProcessor:
        // 0 size%, 1 damping%, 2 mix%, 3 predelay ms, 4 width%, 5 low_damp%.
        if pid == "internal://effect/reverb" {
            if let Some(v) = first_lane_value(track, &["effect.reverb.size"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.reverb.damping"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.reverb.mix"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.reverb.predelay"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: v.clamp(0.0, 200.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.reverb.width"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 4,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.reverb.low_damp"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 5,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            return Ok(());
        }

        // DelayProcessor:
        // 0 time L ms, 1 time R ms, 2 feedback%, 3 mix%.
        if pid == "internal://effect/delay" {
            if let Some(v) = first_lane_value(track, &["effect.delay.time"]) {
                let ms = v.clamp(1.0, 2000.0);
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: ms,
                    },
                )?;
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: ms,
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.delay.feedback"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: (v * 100.0).clamp(0.0, 95.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.delay.mix"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            return Ok(());
        }

        Ok(())
    }

    fn selected_runtime_chain(
        rack: &dream_models::project::DeviceRack,
    ) -> Option<&dream_models::project::RackChain> {
        let has_solo = rack.chains.iter().any(|c| c.is_solo);
        if has_solo {
            rack.chains.iter().find(|c| c.is_solo && !c.is_mute)
        } else {
            rack.chains.iter().find(|c| !c.is_mute)
        }
    }

    fn collect_runtime_internal_effects(
        nodes: &[DeviceNode],
        parent_bypassed: bool,
        out: &mut Vec<(String, bool)>,
    ) {
        for node in nodes {
            match node {
                DeviceNode::Single(slot) => {
                    if slot.plugin_id.starts_with("internal://") {
                        out.push((slot.plugin_id.clone(), parent_bypassed || slot.is_bypassed));
                    }
                }
                DeviceNode::Rack(rack) => {
                    let rack_bypassed = parent_bypassed || rack.is_bypassed;
                    // Runtime chain in dream_dsp is currently serial.
                    // For rack nodes (parallel topology), choose one audible chain
                    // deterministically and use the same strategy everywhere.
                    if let Some(chain) = selected_runtime_chain(rack) {
                        collect_runtime_internal_effects(&chain.devices, rack_bypassed, out);
                    }
                }
            }
        }
    }

    // Reset current runtime chains for known tracks/slots.
    for track_index in 0..project.tracks.len() {
        let track_index = track_index as u16;
        for slot_index in 0..MAX_DEVICE_SLOTS {
            push_command(
                handle,
                EngineCommand::RemoveDevice {
                    track_index,
                    slot_index,
                },
            )?;
        }
    }

    // Rebuild from persisted internal effect slots.
    for (track_index, track) in project.tracks.iter().enumerate() {
        let mut internal_effects: Vec<(String, bool)> = Vec::new();
        collect_runtime_internal_effects(&track.effects, false, &mut internal_effects);
        if internal_effects.len() > MAX_DEVICE_SLOTS as usize {
            log::warn!(
                "[RuntimeChain] track '{}' has {} internal effects; truncating to {} slots",
                track.name,
                internal_effects.len(),
                MAX_DEVICE_SLOTS
            );
        }
        for (slot_index, (plugin_id, bypassed)) in internal_effects
            .into_iter()
            .take(MAX_DEVICE_SLOTS as usize)
            .enumerate()
        {
            if let Some(effect_type) = builtin_effect_type_from_plugin_id(&plugin_id) {
                push_command(
                    handle,
                    EngineCommand::AddDevice {
                        track_index: track_index as u16,
                        slot_index: slot_index.min(u8::MAX as usize) as u8,
                        effect_type,
                    },
                )?;
                if bypassed {
                    push_command(
                        handle,
                        EngineCommand::BypassDevice {
                            track_index: track_index as u16,
                            slot_index: slot_index.min(u8::MAX as usize) as u8,
                            bypassed: true,
                        },
                    )?;
                }
                apply_static_imported_params_for_slot(
                    handle,
                    track_index as u16,
                    slot_index.min(u8::MAX as usize) as u8,
                    &plugin_id,
                    track,
                )?;
            }
        }
    }

    // ── Master track internal FX (CRITICAL FIX) ────────────────────────
    // The master track's internal effects (EQ, compressor, etc.) were never
    // sent to the engine because this function only iterated project.tracks.
    // Use MASTER_TRACK_INDEX (u16::MAX) as the track_index sentinel value
    // so the driver routes these commands to master_device_chain.
    {
        const MASTER_TRACK_INDEX: u16 = u16::MAX;
        let master = &project.master_track;

        // Collect internal effects with their params for startup sync
        struct MasterFxEntry {
            plugin_id: String,
            bypassed: bool,
            params: Option<Vec<f32>>,
        }
        fn collect_master_internal_effects(
            node: &DeviceNode,
            parent_bypassed: bool,
            out: &mut Vec<MasterFxEntry>,
        ) {
            match node {
                DeviceNode::Single(slot) => {
                    if slot.plugin_id.starts_with("internal://effect/") {
                        out.push(MasterFxEntry {
                            plugin_id: slot.plugin_id.clone(),
                            bypassed: parent_bypassed || slot.is_bypassed,
                            params: slot.params.clone(),
                        });
                    }
                }
                DeviceNode::Rack(rack) => {
                    let rack_bypassed = parent_bypassed || rack.is_bypassed;
                    if let Some(chain) = selected_runtime_chain(rack) {
                        for child in &chain.devices {
                            collect_master_internal_effects(child, rack_bypassed, out);
                        }
                    }
                }
            }
        }

        let mut master_internal_effects: Vec<MasterFxEntry> = Vec::new();
        for node in &master.effects {
            collect_master_internal_effects(node, false, &mut master_internal_effects);
        }

        for (slot_index, entry) in master_internal_effects
            .into_iter()
            .take(MAX_DEVICE_SLOTS as usize)
            .enumerate()
        {
            if let Some(effect_type) = builtin_effect_type_from_plugin_id(&entry.plugin_id) {
                push_command(
                    handle,
                    EngineCommand::AddDevice {
                        track_index: MASTER_TRACK_INDEX,
                        slot_index: slot_index.min(u8::MAX as usize) as u8,
                        effect_type,
                    },
                )?;
                if entry.bypassed {
                    push_command(
                        handle,
                        EngineCommand::BypassDevice {
                            track_index: MASTER_TRACK_INDEX,
                            slot_index: slot_index.min(u8::MAX as usize) as u8,
                            bypassed: true,
                        },
                    )?;
                }
                // BUG-R4 FIX: Sync stored params to engine at startup.
                // Without this, master EQ always starts with flat/default
                // settings regardless of what the user configured.
                if let Some(ref params) = entry.params {
                    for (param_idx, &value) in params.iter().enumerate() {
                        if value != 0.0 || param_idx < 33 {
                            // Always sync EQ bands (0..32) + output gain (32)
                            push_command(
                                handle,
                                EngineCommand::SetDeviceParam {
                                    track_index: MASTER_TRACK_INDEX,
                                    slot_index: slot_index.min(u8::MAX as usize) as u8,
                                    param_index: param_idx.min(u8::MAX as usize) as u8,
                                    value,
                                },
                            )?;
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

fn sync_transport_from_project(
    project: &Project,
    handle: &AudioEngineHandle,
) -> Result<(), String> {
    let bpm = project_initial_transport_bpm(project);
    let timeline_sample_rate = project.sample_rate.max(1.0);
    let loop_enabled = project.is_looping;
    let loop_start = project.loop_start_frames.unwrap_or(0);
    let loop_end = project.loop_end_frames.unwrap_or(0);
    let playhead = project.playhead_position_frames.max(0);

    // Keep UI mirror state in sync.
    {
        let mut state = handle.playback_state.lock().map_err(|e| e.to_string())?;
        state.bpm = bpm;
        state.sample_rate = timeline_sample_rate;
        state.loop_enabled = loop_enabled;
        state.loop_start = loop_start;
        state.loop_end = loop_end;
        // Project load/new always starts from stopped transport.
        state.is_playing = false;
    }

    // Keep realtime transport in sync.
    push_command(handle, EngineCommand::SetPlay(false))?;
    push_command(
        handle,
        EngineCommand::SetTimelineSampleRate(timeline_sample_rate),
    )?;
    push_command(handle, EngineCommand::SetBpm(bpm))?;
    push_command(
        handle,
        EngineCommand::SetTimeSignature {
            numerator: project.time_signature.numerator.max(1),
            denominator: project.time_signature.denominator.max(1),
        },
    )?;
    if loop_enabled && loop_end > loop_start {
        push_command(
            handle,
            EngineCommand::SetLoopRegion {
                start: loop_start,
                end: loop_end,
            },
        )?;
    }
    push_command(handle, EngineCommand::SetLoopEnabled(loop_enabled))?;
    push_command(handle, EngineCommand::Seek(playhead))?;
    Ok(())
}

fn project_initial_transport_bpm(project: &Project) -> f64 {
    let base_bpm = project.pulse_map.initial_bpm();
    let automated_start_bpm = project
        .tempo_automation_events
        .iter()
        .filter(|e| e.beat.is_finite() && e.bpm.is_finite() && e.bpm > 0.0 && e.beat <= 0.0001)
        .min_by(|a, b| a.beat.total_cmp(&b.beat))
        .map(|e| e.bpm);
    automated_start_bpm.unwrap_or(base_bpm).clamp(10.0, 999.0)
}

pub(crate) fn sync_track_mix_state_from_project(
    project: &Project,
    handle: &AudioEngineHandle,
) -> Result<(), String> {
    for (track_index, track) in project.tracks.iter().enumerate() {
        let idx = track_index.min(u16::MAX as usize) as u16;
        push_command(
            handle,
            EngineCommand::SetTrackVolume {
                track_index: idx,
                volume: track.volume as f32,
            },
        )?;
        push_command(
            handle,
            EngineCommand::SetTrackPan {
                track_index: idx,
                pan: track.pan as f32,
            },
        )?;
        push_command(
            handle,
            EngineCommand::SetTrackMute {
                track_index: idx,
                muted: track.effective_mute_from_model(),
            },
        )?;
        push_command(
            handle,
            EngineCommand::SetTrackSolo {
                track_index: idx,
                soloed: track.is_solo,
            },
        )?;
    }

    push_command(
        handle,
        EngineCommand::SetMasterVolume {
            volume: project.master_track.volume as f32,
        },
    )?;

    Ok(())
}

// ── Clip Pool State (shared between UI and audio thread) ────────────
// Extracted to: apps/desktop_host/src/state_managers/clip_pool.rs

// RecordingRuntime::new() is defined in state_managers/recording.rs

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

    /// Hardware output latency in sample frames.
    ///
    /// The frontend subtracts this from `position_frames` before drawing
    /// the playhead, so the visual marker aligns with the audio actually
    /// reaching the speakers (compensates for OS + DAC buffer delay).
    output_latency_frames: u32,

    /// Monotonic wall-clock timestamp (milliseconds since UNIX epoch)
    /// captured at the moment this telemetry packet is serialized.
    ///
    /// The frontend compares this against `performance.now()` to
    /// extrapolate the playhead position between telemetry ticks,
    /// enabling silky-smooth 144fps playhead animation without
    /// waiting for the next Rust → IPC round-trip.
    telemetry_timestamp_ms: f64,
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
    #[serde(default)]
    push_undo_step: Option<bool>,
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
    /// Output format: "wav" or "mp3". Defaults to "wav" if omitted.
    #[serde(default = "default_export_format")]
    format: String,
    /// Optional start frame for "selected" range export.
    #[serde(default)]
    start_frame: Option<i64>,
    /// Optional end frame for "selected" range export.
    #[serde(default)]
    end_frame: Option<i64>,
}

fn default_export_format() -> String {
    "wav".to_string()
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
struct PluginSlotRuntimeStatus {
    loaded: bool,
    editor_supported: bool,
    runtime: String,
    sidechain_ready: bool,
    latency_frames: Option<u32>,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalPluginParamInfo {
    index: u32,
    name: String,
    min: f64,
    max: f64,
    step: f64,
    value: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MidiInputPortInfo {
    name: String,
    connected: bool,
}

// ── Device Rack Payloads ───────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRackPayload {
    track_id: String,
    device_ids: Vec<String>,
    rack_name: Option<String>,
    rack_type: Option<String>, // "audio_effect" | "instrument" | "drum" | "midi_effect"
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddChainToRackPayload {
    track_id: String,
    rack_id: String,
    chain_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddDeviceToRackChainPayload {
    track_id: String,
    rack_id: String,
    chain_id: String,
    plugin_id: String,
    plugin_name: String,
    insert_index: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveDeviceFromRackPayload {
    track_id: String,
    rack_id: String,
    device_id: String,
    auto_dissolve: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveDevicePresetPayload {
    track_id: String,
    device_id: String,
    output_path: String,
    preset_name: Option<String>,
    tags: Option<Vec<String>>,
    description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadDevicePresetPayload {
    track_id: String,
    preset_path: String,
    insert_index: Option<usize>,
}

// ── Helper: push command with error handling ───────────────────────────

fn push_command(handle: &AudioEngineHandle, cmd: EngineCommand) -> Result<(), String> {
    fn is_high_priority_command(cmd: &EngineCommand) -> bool {
        matches!(
            cmd,
            EngineCommand::SetPlay(_)
                | EngineCommand::Seek(_)
                | EngineCommand::SetBpm(_)
                | EngineCommand::SetTimeSignature { .. }
                | EngineCommand::SetLoopEnabled(_)
                | EngineCommand::SetLoopRegion { .. }
                | EngineCommand::SetTrackMute { .. }
                | EngineCommand::SetTrackSolo { .. }
                | EngineCommand::SetTrackVolume { .. }
                | EngineCommand::SetTrackPan { .. }
                | EngineCommand::SetMasterVolume { .. }
        )
    }

    let high_priority = is_high_priority_command(&cmd);
    let max_attempts = if high_priority { 14 } else { 6 };
    let mut pending = cmd;
    for attempt in 0..max_attempts {
        let push_result = {
            let mut producer = handle
                .producer
                .lock()
                .map_err(|e| format!("Lock poisoned: {e}"))?;
            producer.push(pending)
        };

        match push_result {
            Ok(()) => return Ok(()),
            Err(rtrb::PushError::Full(returned)) => {
                pending = returned;
                if attempt < 3 {
                    std::thread::yield_now();
                } else {
                    std::thread::sleep(Duration::from_micros(if high_priority {
                        250
                    } else {
                        150
                    }));
                }
            }
        }
    }

    handle.rt_debug_stats.record_queue_full_reject();
    Err("Command queue full — audio thread overloaded".to_string())
}

fn read_meter(level: &dream_ipc::metering::LockFreeLevel) -> MeterReading {
    MeterReading {
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
    rebuild_automation_snapshot_from_project(&bootstrap_project, &automation_runtime);
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
