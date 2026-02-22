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

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use arc_swap::ArcSwap;

use dream_clip_engine::midi_scheduler::MidiScheduler;
use dream_clip_engine::pool::{ClipAudio, ClipPool};
use dream_engine::driver::{
    parse_external_param_target, AutomationPoint, ExternalParamAutomationLane,
    MidiFxRuntimeConfig, MidiTrackRuntime, SharedAutomationSnapshot,
    SharedClipSnapshot, SharedExternalFxSnapshot, SharedPreparedGraphSnapshot,
    SharedRoutingSnapshot, SharedRtDebugStats, SharedSidechainSnapshot, TrackAutomationState,
};
use dream_engine::offline_bounce::{BounceConfig, OfflineBouncer};
use dream_engine::recording::RecordingSession;
use dream_io::audio_reader::AudioReader;
use dream_io::peak_cache::{PeakCache, WaveformPeaks};
use dream_io::project_file::ProjectFile;
use dream_io::project_manager::ProjectManager;
use dream_io::wav_writer::WavWriter;
use dream_ipc::metering::MeterBank;
use dream_ipc::{EngineCommand, MasterClock};
use dream_models::PlaybackState;
use dream_models::midi::{MidiClip, MidiNote, SamplerConfig, SampleRackConfig};
use dream_models::mutators::{self, MutatorError};
use dream_models::project::{
    AudioClip, DeviceNode, PluginSlot, Project, TimeSignature, Track, TrackColor, TrackType,
};
use dream_models::time::AbsoluteTime;
use dream_plugins::format::{PluginCategory, PluginFormat};
use dream_plugins::{
    MidiEvent as PluginMidiEvent, PluginDescriptor, PluginHost, PluginSandboxConfig,
    PluginSandboxSnapshot, PluginSandboxSupervisor, PluginScanner,
};
use midir::MidiInput;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use uuid::Uuid;

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

    /// SSOT-FIX: Source sample rate of the preview audio.
    /// Used by the RT callback to compute fractional cursor advancement
    /// so preview pitch matches the original file regardless of device SR.
    /// Stored as u32 (e.g. 44100, 48000). 0 means "same as device" (legacy fallback).
    preview_source_sr: Arc<std::sync::atomic::AtomicU32>,

    /// Export cancel flag - set to true to abort offline bounce.
    pub export_cancel: Arc<std::sync::atomic::AtomicBool>,

    /// Shared clip pool snapshot (lock-free) for restarting audio stream.
    clip_pool: Arc<ArcSwap<ClipPool>>,
    clip_snapshot: Arc<SharedClipSnapshot>,
    midi_snapshot: Arc<dream_engine::driver::SharedMidiSnapshot>,
    routing_snapshot: Arc<SharedRoutingSnapshot>,
    prepared_graph_snapshot: Arc<SharedPreparedGraphSnapshot>,
    sidechain_snapshot: Arc<SharedSidechainSnapshot>,
    external_fx_snapshot: Arc<SharedExternalFxSnapshot>,
    automation_snapshot: Arc<SharedAutomationSnapshot>,
    sampler_samples: Arc<dream_engine::driver::SharedSamplerSamples>,
    sample_rack_samples: Arc<dream_engine::driver::SharedSampleRackSamples>,
    plugin_host: Arc<Mutex<PluginHost>>,
    plugin_registry: Arc<dream_engine::driver::SharedPluginRegistry>,
    rt_debug_stats: Arc<SharedRtDebugStats>,

    /// Estimated hardware output latency in sample frames.
    /// Captured from cpal at stream init. Passed to frontend so the
    /// visual playhead can be offset to match actual speaker output.
    output_latency_frames: u32,

    /// Event channel for RT stream errors (device disconnect, backend failures).
    stream_error_tx: std::sync::mpsc::SyncSender<String>,

    /// Global shutdown flag (BUG-14)
    pub is_shutting_down: Arc<std::sync::atomic::AtomicBool>,
}

// ── Spectrum Analyzer State ────────────────────────────────────────────

/// Inner mutable state for the spectrum analyzer (protected by Mutex).
struct SpectrumStateInner {
    /// Lock-free consumer of mono master output samples from the audio thread
    consumer: rtrb::Consumer<f32>,
    /// FFT analyzer — accumulates samples and computes spectrum
    analyzer: dream_dsp::spectrum_analyzer::SpectrumAnalyzer,
    /// Cached last magnitudes for when no new data is available
    last_magnitudes: Vec<f32>,
}

/// Thread-safe Tauri managed state for the real-time spectrum analyzer.
struct SpectrumState {
    inner: Mutex<SpectrumStateInner>,
}

impl AudioEngineHandle {
    /// Load an interleaved stereo buffer for preview playback.
    /// Uses ArcSwap::store() — lock-free, never blocks the audio thread.
    ///
    /// SSOT-FIX: Now accepts `source_sr` so the RT callback can advance
    /// the cursor at the correct rate (source_sr / device_sr) for pitch-correct preview.
    fn set_preview_buffer(&self, buffer: Vec<f32>, source_sr: u32) {
        self.preview_cursor
            .store(0, std::sync::atomic::Ordering::SeqCst);
        self.preview_source_sr
            .store(source_sr, std::sync::atomic::Ordering::Release);
        self.preview_buffer.store(Arc::new(Some(buffer)));
    }

    /// Stop preview and discard the buffer.
    fn clear_preview_buffer(&self) {
        self.preview_buffer.store(Arc::new(None));
        self.preview_cursor
            .store(0, std::sync::atomic::Ordering::SeqCst);
        self.preview_source_sr
            .store(0, std::sync::atomic::Ordering::Relaxed);
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
    color_hex: Option<String>,
    height: f64,
    output_destination_id: Option<Uuid>,
    input_source_id: Option<String>,
    monitoring_mode: Option<u8>,
    effects: Vec<DeviceNode>,
    instrument: Option<DeviceNode>,
    parent_track_id: Option<Uuid>,
    child_track_ids: Vec<Uuid>,
    is_expanded: bool,
    midi_clips: Vec<MidiClip>,
    sampler: Option<SamplerConfig>,
    sample_rack: Option<SampleRackConfig>,
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
            color_hex: track.color_hex.clone(),
            height: track.height,
            output_destination_id: track.output_destination_id,
            input_source_id: track.input_source_id.clone(),
            monitoring_mode: track.monitoring_mode,
            effects: track.effects.clone(),
            instrument: track.instrument.clone(),
            parent_track_id: track.parent_track_id,
            child_track_ids: track.child_track_ids.clone(),
            is_expanded: track.is_expanded,
            midi_clips: track.midi_clips.clone(),
            sampler: track.sampler.clone(),
            sample_rack: track.sample_rack.clone(),
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
            && self.color_hex == track.color_hex
            && self.height == track.height
            && self.output_destination_id == track.output_destination_id
            && self.input_source_id == track.input_source_id
            && self.monitoring_mode == track.monitoring_mode
            && self.effects == track.effects
            && self.instrument == track.instrument
            && self.parent_track_id == track.parent_track_id
            && self.child_track_ids == track.child_track_ids
            && self.is_expanded == track.is_expanded
            && self.midi_clips == track.midi_clips
            && self.sampler == track.sampler
            && self.sample_rack == track.sample_rack
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
            color_hex: self.color_hex.clone(),
            height: self.height,
            output_destination_id: self.output_destination_id,
            input_source_id: self.input_source_id.clone(),
            monitoring_mode: self.monitoring_mode,
            effects: self.effects.clone(),
            instrument: self.instrument.clone(),
            parent_track_id: self.parent_track_id,
            child_track_ids: self.child_track_ids.clone(),
            is_expanded: self.is_expanded,
            midi_clips: self.midi_clips.clone(),
            sampler: self.sampler.clone(),
            sample_rack: self.sample_rack.clone(),
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
    arrangement_grid_numerator: u16,
    arrangement_grid_denominator: u16,
    arrangement_grid_ntoles: u8,
    arrangement_snap_to_grid: bool,
    markers: Vec<dream_models::project::ProjectMarker>,
    arrangement_grid_fixed: bool,
    automation_mode_enabled: bool,
    snap_automation_to_grid: bool,
    arrangement_overdub: bool,
    solo_in_place: bool,
    crossfade_curve: i32,
    latency_compensation_mode: i32,
    punch_in_enabled: bool,
    punch_out_enabled: bool,
    metronome_tick_duration: f64,
    global_groove_amount: f64,
    global_quantisation: i32,
    auto_quantisation: i32,
    selected_document_view: i32,
    view_state_fx_slot_count: i32,
    view_state_session_mixer_volume_section_height: f64,
    view_state_arranger_mixer_volume_section_height: f64,
    view_state_session_track_width: f64,
    view_state_main_window_clip_detail_open: bool,
    view_state_main_window_device_detail_open: bool,
    view_state_second_window_clip_detail_open: bool,
    view_state_second_window_device_detail_open: bool,
    should_scene_tempo_time_signature_be_visible: bool,
    waveform_vertical_zoom_factor: f64,
    is_waveform_vertical_zoom_active: bool,
    highlighted_track_index: i32,
    track_header_width: f64,
    reset_nonautomated_midi_controllers_on_clip_starts: bool,
    midi_fold_in: bool,
    midi_fold_mode: i32,
    multi_clip_focus_mode: bool,
    multi_clip_loop_bar_height: f64,
    midi_prelisten: bool,
    use_warper_legacy_hiq_mode: bool,
    show_video_window: bool,
    solo_or_pfl_saved_value: bool,
    color_sequence_index: i32,
    note_spelling_preference: i32,
    accidental_spelling_preference: i32,
    prefer_flat_root_note: bool,
    view_state_main_window_hidden_other_doc_view_type_clip_detail_open: bool,
    view_state_main_window_hidden_other_doc_view_type_device_detail_open: bool,
    transport_phase_nudge_tempo: f64,
    transport_loop_is_song_start: bool,
    transport_draw_mode: bool,
    view_mixer_in_arrangement: bool,
    view_arranger_mixer_io: bool,
    view_arranger_mixer_sends: bool,
    view_arranger_mixer_returns: bool,
    view_arranger_mixer_volume: bool,
    view_arranger_mixer_track_options: bool,
    view_arranger_mixer_crossfade: bool,
    view_arranger_mixer_track_performance_impact_meter: bool,
    view_mixer_in_session: bool,
    view_session_io: bool,
    view_session_sends: bool,
    view_session_returns: bool,
    view_session_volume: bool,
    view_session_track_options: bool,
    view_session_crossfade: bool,
    view_session_track_performance_impact_meter: bool,
    view_session_show_overview: bool,
    view_arranger_io: bool,
    view_arranger_returns: bool,
    view_arranger_volume: bool,
    view_arranger_track_options: bool,
    view_arranger_show_overview: bool,
    session_scroll_x: i32,
    session_scroll_y: i32,
    selected_breakpoint_value: f64,
    time_selection_anchor_beats: Option<f64>,
    time_selection_other_beats: Option<f64>,
    sequencer_navigator_zoom: Option<f64>,
    sequencer_navigator_scroll_x: Option<i32>,
    sequencer_navigator_scroll_y: Option<i32>,
    sequencer_navigator_client_width: Option<i32>,
    sequencer_navigator_client_height: Option<i32>,
    is_content_splitter_open: bool,
    is_expression_splitter_open: bool,
    annotation: String,
    smpte_format: i32,
    expression_lanes: Vec<dream_models::project::MidiEditorLaneState>,
    content_lanes: Vec<dream_models::project::MidiEditorLaneState>,
    view_data_json: Option<String>,
    auto_color_picker_player_group_next_color_index: i32,
    auto_color_picker_return_main_next_color_index: i32,
    groove_pool_default_groove_id: Option<i32>,
    groove_pool_groove_count: i32,
    linked_track_group_count: i32,
    tuning_system_count: i32,
    note_algorithm_count: i32,
    video_window_rect_top: Option<i32>,
    video_window_rect_left: Option<i32>,
    video_window_rect_bottom: Option<i32>,
    video_window_rect_right: Option<i32>,
    session_scenes: Vec<dream_models::project::ProjectScene>,
    playhead_position_frames: i64,
    is_looping: bool,
    loop_start_frames: Option<i64>,
    loop_end_frames: Option<i64>,
    key_sig_enabled: bool,
    key_sig_tonic: String,
    key_sig_mode: String,
    tempo_automation_events: Vec<dream_models::project::TempoAutomationEvent>,
    time_signature_changes: Vec<dream_models::project::TimeSignatureChange>,
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
            arrangement_grid_numerator: project.arrangement_grid_numerator,
            arrangement_grid_denominator: project.arrangement_grid_denominator,
            arrangement_grid_ntoles: project.arrangement_grid_ntoles,
            arrangement_snap_to_grid: project.arrangement_snap_to_grid,
            markers: project.markers.clone(),
            arrangement_grid_fixed: project.arrangement_grid_fixed,
            automation_mode_enabled: project.automation_mode_enabled,
            snap_automation_to_grid: project.snap_automation_to_grid,
            arrangement_overdub: project.arrangement_overdub,
            solo_in_place: project.solo_in_place,
            crossfade_curve: project.crossfade_curve,
            latency_compensation_mode: project.latency_compensation_mode,
            punch_in_enabled: project.punch_in_enabled,
            punch_out_enabled: project.punch_out_enabled,
            metronome_tick_duration: project.metronome_tick_duration,
            global_groove_amount: project.global_groove_amount,
            global_quantisation: project.global_quantisation,
            auto_quantisation: project.auto_quantisation,
            selected_document_view: project.selected_document_view,
            view_state_fx_slot_count: project.view_state_fx_slot_count,
            view_state_session_mixer_volume_section_height: project
                .view_state_session_mixer_volume_section_height,
            view_state_arranger_mixer_volume_section_height: project
                .view_state_arranger_mixer_volume_section_height,
            view_state_session_track_width: project.view_state_session_track_width,
            view_state_main_window_clip_detail_open: project
                .view_state_main_window_clip_detail_open,
            view_state_main_window_device_detail_open: project
                .view_state_main_window_device_detail_open,
            view_state_second_window_clip_detail_open: project
                .view_state_second_window_clip_detail_open,
            view_state_second_window_device_detail_open: project
                .view_state_second_window_device_detail_open,
            should_scene_tempo_time_signature_be_visible: project
                .should_scene_tempo_time_signature_be_visible,
            waveform_vertical_zoom_factor: project.waveform_vertical_zoom_factor,
            is_waveform_vertical_zoom_active: project.is_waveform_vertical_zoom_active,
            highlighted_track_index: project.highlighted_track_index,
            track_header_width: project.track_header_width,
            reset_nonautomated_midi_controllers_on_clip_starts: project
                .reset_nonautomated_midi_controllers_on_clip_starts,
            midi_fold_in: project.midi_fold_in,
            midi_fold_mode: project.midi_fold_mode,
            multi_clip_focus_mode: project.multi_clip_focus_mode,
            multi_clip_loop_bar_height: project.multi_clip_loop_bar_height,
            midi_prelisten: project.midi_prelisten,
            use_warper_legacy_hiq_mode: project.use_warper_legacy_hiq_mode,
            show_video_window: project.show_video_window,
            solo_or_pfl_saved_value: project.solo_or_pfl_saved_value,
            color_sequence_index: project.color_sequence_index,
            note_spelling_preference: project.note_spelling_preference,
            accidental_spelling_preference: project.accidental_spelling_preference,
            prefer_flat_root_note: project.prefer_flat_root_note,
            view_state_main_window_hidden_other_doc_view_type_clip_detail_open: project
                .view_state_main_window_hidden_other_doc_view_type_clip_detail_open,
            view_state_main_window_hidden_other_doc_view_type_device_detail_open: project
                .view_state_main_window_hidden_other_doc_view_type_device_detail_open,
            transport_phase_nudge_tempo: project.transport_phase_nudge_tempo,
            transport_loop_is_song_start: project.transport_loop_is_song_start,
            transport_draw_mode: project.transport_draw_mode,
            view_mixer_in_arrangement: project.view_mixer_in_arrangement,
            view_arranger_mixer_io: project.view_arranger_mixer_io,
            view_arranger_mixer_sends: project.view_arranger_mixer_sends,
            view_arranger_mixer_returns: project.view_arranger_mixer_returns,
            view_arranger_mixer_volume: project.view_arranger_mixer_volume,
            view_arranger_mixer_track_options: project.view_arranger_mixer_track_options,
            view_arranger_mixer_crossfade: project.view_arranger_mixer_crossfade,
            view_arranger_mixer_track_performance_impact_meter: project
                .view_arranger_mixer_track_performance_impact_meter,
            view_mixer_in_session: project.view_mixer_in_session,
            view_session_io: project.view_session_io,
            view_session_sends: project.view_session_sends,
            view_session_returns: project.view_session_returns,
            view_session_volume: project.view_session_volume,
            view_session_track_options: project.view_session_track_options,
            view_session_crossfade: project.view_session_crossfade,
            view_session_track_performance_impact_meter: project
                .view_session_track_performance_impact_meter,
            view_session_show_overview: project.view_session_show_overview,
            view_arranger_io: project.view_arranger_io,
            view_arranger_returns: project.view_arranger_returns,
            view_arranger_volume: project.view_arranger_volume,
            view_arranger_track_options: project.view_arranger_track_options,
            view_arranger_show_overview: project.view_arranger_show_overview,
            session_scroll_x: project.session_scroll_x,
            session_scroll_y: project.session_scroll_y,
            selected_breakpoint_value: project.selected_breakpoint_value,
            time_selection_anchor_beats: project.time_selection_anchor_beats,
            time_selection_other_beats: project.time_selection_other_beats,
            sequencer_navigator_zoom: project.sequencer_navigator_zoom,
            sequencer_navigator_scroll_x: project.sequencer_navigator_scroll_x,
            sequencer_navigator_scroll_y: project.sequencer_navigator_scroll_y,
            sequencer_navigator_client_width: project.sequencer_navigator_client_width,
            sequencer_navigator_client_height: project.sequencer_navigator_client_height,
            is_content_splitter_open: project.is_content_splitter_open,
            is_expression_splitter_open: project.is_expression_splitter_open,
            annotation: project.annotation.clone(),
            smpte_format: project.smpte_format,
            expression_lanes: project.expression_lanes.clone(),
            content_lanes: project.content_lanes.clone(),
            view_data_json: project.view_data_json.clone(),
            auto_color_picker_player_group_next_color_index: project
                .auto_color_picker_player_group_next_color_index,
            auto_color_picker_return_main_next_color_index: project
                .auto_color_picker_return_main_next_color_index,
            groove_pool_default_groove_id: project.groove_pool_default_groove_id,
            groove_pool_groove_count: project.groove_pool_groove_count,
            linked_track_group_count: project.linked_track_group_count,
            tuning_system_count: project.tuning_system_count,
            note_algorithm_count: project.note_algorithm_count,
            video_window_rect_top: project.video_window_rect_top,
            video_window_rect_left: project.video_window_rect_left,
            video_window_rect_bottom: project.video_window_rect_bottom,
            video_window_rect_right: project.video_window_rect_right,
            session_scenes: project.session_scenes.clone(),
            playhead_position_frames: project.playhead_position_frames,
            is_looping: project.is_looping,
            loop_start_frames: project.loop_start_frames,
            loop_end_frames: project.loop_end_frames,
            key_sig_enabled: project.key_sig_enabled,
            key_sig_tonic: project.key_sig_tonic.clone(),
            key_sig_mode: project.key_sig_mode.clone(),
            tempo_automation_events: project.tempo_automation_events.clone(),
            time_signature_changes: project.time_signature_changes.clone(),
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
            arrangement_grid_numerator: self.arrangement_grid_numerator,
            arrangement_grid_denominator: self.arrangement_grid_denominator,
            arrangement_grid_ntoles: self.arrangement_grid_ntoles,
            arrangement_snap_to_grid: self.arrangement_snap_to_grid,
            markers: self.markers.clone(),
            arrangement_grid_fixed: self.arrangement_grid_fixed,
            automation_mode_enabled: self.automation_mode_enabled,
            snap_automation_to_grid: self.snap_automation_to_grid,
            arrangement_overdub: self.arrangement_overdub,
            solo_in_place: self.solo_in_place,
            crossfade_curve: self.crossfade_curve,
            latency_compensation_mode: self.latency_compensation_mode,
            punch_in_enabled: self.punch_in_enabled,
            punch_out_enabled: self.punch_out_enabled,
            metronome_tick_duration: self.metronome_tick_duration,
            global_groove_amount: self.global_groove_amount,
            global_quantisation: self.global_quantisation,
            auto_quantisation: self.auto_quantisation,
            selected_document_view: self.selected_document_view,
            view_state_fx_slot_count: self.view_state_fx_slot_count,
            view_state_session_mixer_volume_section_height: self
                .view_state_session_mixer_volume_section_height,
            view_state_arranger_mixer_volume_section_height: self
                .view_state_arranger_mixer_volume_section_height,
            view_state_session_track_width: self.view_state_session_track_width,
            view_state_main_window_clip_detail_open: self.view_state_main_window_clip_detail_open,
            view_state_main_window_device_detail_open: self
                .view_state_main_window_device_detail_open,
            view_state_second_window_clip_detail_open: self
                .view_state_second_window_clip_detail_open,
            view_state_second_window_device_detail_open: self
                .view_state_second_window_device_detail_open,
            should_scene_tempo_time_signature_be_visible: self
                .should_scene_tempo_time_signature_be_visible,
            waveform_vertical_zoom_factor: self.waveform_vertical_zoom_factor,
            is_waveform_vertical_zoom_active: self.is_waveform_vertical_zoom_active,
            highlighted_track_index: self.highlighted_track_index,
            track_header_width: self.track_header_width,
            reset_nonautomated_midi_controllers_on_clip_starts: self
                .reset_nonautomated_midi_controllers_on_clip_starts,
            midi_fold_in: self.midi_fold_in,
            midi_fold_mode: self.midi_fold_mode,
            multi_clip_focus_mode: self.multi_clip_focus_mode,
            multi_clip_loop_bar_height: self.multi_clip_loop_bar_height,
            midi_prelisten: self.midi_prelisten,
            use_warper_legacy_hiq_mode: self.use_warper_legacy_hiq_mode,
            show_video_window: self.show_video_window,
            solo_or_pfl_saved_value: self.solo_or_pfl_saved_value,
            color_sequence_index: self.color_sequence_index,
            note_spelling_preference: self.note_spelling_preference,
            accidental_spelling_preference: self.accidental_spelling_preference,
            prefer_flat_root_note: self.prefer_flat_root_note,
            view_state_main_window_hidden_other_doc_view_type_clip_detail_open: self
                .view_state_main_window_hidden_other_doc_view_type_clip_detail_open,
            view_state_main_window_hidden_other_doc_view_type_device_detail_open: self
                .view_state_main_window_hidden_other_doc_view_type_device_detail_open,
            transport_phase_nudge_tempo: self.transport_phase_nudge_tempo,
            transport_loop_is_song_start: self.transport_loop_is_song_start,
            transport_draw_mode: self.transport_draw_mode,
            view_mixer_in_arrangement: self.view_mixer_in_arrangement,
            view_arranger_mixer_io: self.view_arranger_mixer_io,
            view_arranger_mixer_sends: self.view_arranger_mixer_sends,
            view_arranger_mixer_returns: self.view_arranger_mixer_returns,
            view_arranger_mixer_volume: self.view_arranger_mixer_volume,
            view_arranger_mixer_track_options: self.view_arranger_mixer_track_options,
            view_arranger_mixer_crossfade: self.view_arranger_mixer_crossfade,
            view_arranger_mixer_track_performance_impact_meter: self
                .view_arranger_mixer_track_performance_impact_meter,
            view_mixer_in_session: self.view_mixer_in_session,
            view_session_io: self.view_session_io,
            view_session_sends: self.view_session_sends,
            view_session_returns: self.view_session_returns,
            view_session_volume: self.view_session_volume,
            view_session_track_options: self.view_session_track_options,
            view_session_crossfade: self.view_session_crossfade,
            view_session_track_performance_impact_meter: self
                .view_session_track_performance_impact_meter,
            view_session_show_overview: self.view_session_show_overview,
            view_arranger_io: self.view_arranger_io,
            view_arranger_returns: self.view_arranger_returns,
            view_arranger_volume: self.view_arranger_volume,
            view_arranger_track_options: self.view_arranger_track_options,
            view_arranger_show_overview: self.view_arranger_show_overview,
            session_scroll_x: self.session_scroll_x,
            session_scroll_y: self.session_scroll_y,
            selected_breakpoint_value: self.selected_breakpoint_value,
            time_selection_anchor_beats: self.time_selection_anchor_beats,
            time_selection_other_beats: self.time_selection_other_beats,
            sequencer_navigator_zoom: self.sequencer_navigator_zoom,
            sequencer_navigator_scroll_x: self.sequencer_navigator_scroll_x,
            sequencer_navigator_scroll_y: self.sequencer_navigator_scroll_y,
            sequencer_navigator_client_width: self.sequencer_navigator_client_width,
            sequencer_navigator_client_height: self.sequencer_navigator_client_height,
            is_content_splitter_open: self.is_content_splitter_open,
            is_expression_splitter_open: self.is_expression_splitter_open,
            annotation: self.annotation.clone(),
            smpte_format: self.smpte_format,
            expression_lanes: self.expression_lanes.clone(),
            content_lanes: self.content_lanes.clone(),
            view_data_json: self.view_data_json.clone(),
            auto_color_picker_player_group_next_color_index: self
                .auto_color_picker_player_group_next_color_index,
            auto_color_picker_return_main_next_color_index: self
                .auto_color_picker_return_main_next_color_index,
            groove_pool_default_groove_id: self.groove_pool_default_groove_id,
            groove_pool_groove_count: self.groove_pool_groove_count,
            linked_track_group_count: self.linked_track_group_count,
            tuning_system_count: self.tuning_system_count,
            note_algorithm_count: self.note_algorithm_count,
            video_window_rect_top: self.video_window_rect_top,
            video_window_rect_left: self.video_window_rect_left,
            video_window_rect_bottom: self.video_window_rect_bottom,
            video_window_rect_right: self.video_window_rect_right,
            session_scenes: self.session_scenes.clone(),
            playhead_position_frames: self.playhead_position_frames,
            is_looping: self.is_looping,
            loop_start_frames: self.loop_start_frames,
            loop_end_frames: self.loop_end_frames,
            key_sig_enabled: self.key_sig_enabled,
            key_sig_tonic: self.key_sig_tonic.clone(),
            key_sig_mode: self.key_sig_mode.clone(),
            tempo_automation_events: self.tempo_automation_events.clone(),
            time_signature_changes: self.time_signature_changes.clone(),
        }
    }
}

/// Maximum redo stack depth — prevents unbounded memory growth. (BUG-024 FIX)
const MAX_REDO_DEPTH: usize = 50;

/// Undo/Redo history backed by structural-sharing snapshots.
///
/// Uses `VecDeque` for O(1) front eviction when the undo depth
/// exceeds `MAX_UNDO_DEPTH`. `Vec::remove(0)` was previously used
/// here, which is O(n) due to element shifting — unacceptable for
/// a hot path that fires on every user mutation.
struct UndoState {
    undo_stack: VecDeque<SharedProjectSnapshot>,
    redo_stack: VecDeque<SharedProjectSnapshot>,
}

impl UndoState {
    fn new() -> Self {
        Self {
            undo_stack: VecDeque::new(),
            redo_stack: VecDeque::new(),
        }
    }
}

/// Maximum number of undo snapshots to retain.
const MAX_UNDO_DEPTH: usize = 100;
const MAX_PROJECT_HISTORY: usize = 2048;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectHistoryEvent {
    seq: u64,
    kind: String,
    detail: String,
    timestamp_ms: u128,
}

struct ProjectHistory {
    next_seq: u64,
    events: VecDeque<ProjectHistoryEvent>,
}

impl ProjectHistory {
    fn new() -> Self {
        Self {
            next_seq: 1,
            events: VecDeque::new(),
        }
    }

    fn push(&mut self, kind: impl Into<String>, detail: impl Into<String>) {
        let timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let event = ProjectHistoryEvent {
            seq: self.next_seq,
            kind: kind.into(),
            detail: detail.into(),
            timestamp_ms,
        };
        self.next_seq = self.next_seq.saturating_add(1);
        self.events.push_back(event);
        if self.events.len() > MAX_PROJECT_HISTORY {
            self.events.pop_front();
        }
    }

    fn snapshot(&self, limit: Option<usize>, since_seq: Option<u64>) -> Vec<ProjectHistoryEvent> {
        // BUG-FIX: Previous implementation did double-collect (first into a Vec,
        // then skip+collect into another Vec). Refactored to single allocation.
        let iter: Box<dyn Iterator<Item = &ProjectHistoryEvent>> = if let Some(since) = since_seq {
            let tail_seq = self.events.back().map(|e| e.seq).unwrap_or(0);
            if since > tail_seq {
                Box::new(self.events.iter())
            } else {
                Box::new(self.events.iter().filter(move |e| e.seq > since))
            }
        } else {
            Box::new(self.events.iter())
        };
        // Collect once, then truncate from the front to apply the limit.
        let mut selected: Vec<ProjectHistoryEvent> = iter.cloned().collect();
        if let Some(max) = limit {
            let len = selected.len();
            if len > max {
                selected.drain(..len - max);
            }
        }
        selected
    }
}

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
            log::warn!("[Engine] BUG-063: Failed to push command ({}): {}", $context, err);
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
    let mut offline_cache: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
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
                    state.external_plugin_params.push(ExternalParamAutomationLane {
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
            let mut merged: Vec<dream_models::midi::MidiNote> = Vec::with_capacity(clip.notes.len());
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
                clips: track.midi_clips.iter().cloned().map(sanitize_runtime_clip).collect(),
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
    let mut rack_samples: Vec<[Option<Arc<ClipAudio>>; 16]> = vec![empty_pad_samples; project.tracks.len()];
    
    struct RackSettings {
        track_idx: u16,
        pad_idx: u8,
        volume: f32,
        is_muted: bool,
        is_soloed: bool,
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
                        is_muted: pad.is_muted,
                        is_soloed: pad.is_soloed,
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
        push_command_or_log!(handle, EngineCommand::SetSamplerOsc2Waveform {
            track_index: track_idx as u16,
            waveform: osc2,
        }, "sampler osc2 waveform");
        push_command_or_log!(handle, EngineCommand::SetSamplerOscMix {
            track_index: track_idx as u16,
            mix,
        }, "sampler osc mix");
        push_command_or_log!(handle, EngineCommand::SetSamplerDetuneCents {
            track_index: track_idx as u16,
            cents: detune,
        }, "sampler detune");
        push_command_or_log!(handle, EngineCommand::SetSamplerSubLevel {
            track_index: track_idx as u16,
            level: sub,
        }, "sampler sub level");
        push_command_or_log!(handle, EngineCommand::SetSamplerFilterCutoff {
            track_index: track_idx as u16,
            cutoff: f_cutoff,
        }, "sampler filter cutoff");
        push_command_or_log!(handle, EngineCommand::SetSamplerFilterResonance {
            track_index: track_idx as u16,
            resonance: f_res,
        }, "sampler filter resonance");
        push_command_or_log!(handle, EngineCommand::SetSamplerFilterType {
            track_index: track_idx as u16,
            filter_type: f_type,
        }, "sampler filter type");
        push_command_or_log!(handle, EngineCommand::SetSamplerLfoRate {
            track_index: track_idx as u16,
            rate: lfo_r,
        }, "sampler lfo rate");
        push_command_or_log!(handle, EngineCommand::SetSamplerLfoDepth {
            track_index: track_idx as u16,
            depth: lfo_d,
        }, "sampler lfo depth");
        push_command_or_log!(handle, EngineCommand::SetSamplerLfoTarget {
            track_index: track_idx as u16,
            target: lfo_t,
        }, "sampler lfo target");
        push_command_or_log!(handle, EngineCommand::SetSamplerPulseWidth {
            track_index: track_idx as u16,
            width: pw,
        }, "sampler pulse width");
    }

    for rs in rack_settings {
        push_command_or_log!(handle, EngineCommand::SetSampleRackPadVolume {
            track_index: rs.track_idx,
            pad_index: rs.pad_idx,
            volume: rs.volume,
        }, "rack pad volume");
        
        push_command_or_log!(handle, EngineCommand::SetSampleRackPadAdsr {
            track_index: rs.track_idx,
            pad_index: rs.pad_idx,
            attack: rs.attack,
            decay: rs.decay,
            sustain: rs.sustain,
            release: rs.release,
        }, "rack pad adsr");

        push_command_or_log!(handle, EngineCommand::SetSampleRackPadFilterCutoff {
            track_index: rs.track_idx,
            pad_index: rs.pad_idx,
            cutoff: rs.filter_cutoff,
        }, "rack pad cutoff");
    }
}

fn builtin_effect_type_from_plugin_id(plugin_id: &str) -> Option<u8> {
    // Must match dream_dsp::dsp_processor::BuiltinEffectType discriminants.
    const FX_EQ: u8 = 0;
    const FX_COMPRESSOR: u8 = 1;
    const FX_DELAY: u8 = 2;
    const FX_REVERB: u8 = 3;
    const FX_CHORUS: u8 = 4;
    const FX_UTILITY: u8 = 5;
    const FX_SATURATOR: u8 = 6;
    const FX_LIMITER: u8 = 7;
    const FX_GATE: u8 = 8;
    const FX_AUTO_FILTER: u8 = 9;
    const FX_PHASER: u8 = 10;
    const FX_FLANGER: u8 = 11;
    const FX_DISTORTION: u8 = 12;
    const FX_BITCRUSHER: u8 = 13;
    const FX_NOISE_MACHINE: u8 = 14;
    const FX_AUTO_PAN: u8 = 15;
    const FX_ANALYZER: u8 = 16;

    let key = plugin_id.to_lowercase();

    // ── Exact internal:// prefix matches (highest priority) ──────────
    if key.starts_with("internal://effect/") {
        return match key.as_str() {
            "internal://effect/eq-eight" => Some(FX_EQ),
            "internal://effect/compressor" => Some(FX_COMPRESSOR),
            "internal://effect/delay" => Some(FX_DELAY),
            "internal://effect/reverb" => Some(FX_REVERB),
            "internal://effect/chorus" => Some(FX_CHORUS),
            "internal://effect/utility" => Some(FX_UTILITY),
            "internal://effect/saturator" => Some(FX_SATURATOR),
            "internal://effect/limiter" => Some(FX_LIMITER),
            "internal://effect/gate" => Some(FX_GATE),
            "internal://effect/auto-filter" => Some(FX_AUTO_FILTER),
            "internal://effect/phaser" => Some(FX_PHASER),
            "internal://effect/flanger" => Some(FX_FLANGER),
            "internal://effect/distortion" => Some(FX_DISTORTION),
            "internal://effect/bitcrusher" => Some(FX_BITCRUSHER),
            "internal://effect/noise-machine" => Some(FX_NOISE_MACHINE),
            "internal://effect/auto-pan" => Some(FX_AUTO_PAN),
            "internal://effect/analyzer" => Some(FX_ANALYZER),
            _ => None,
        };
    }

    // ── Keyword fallbacks (Ableton device names, aliases) ────────────
    // Order: more specific matches before generic ones to avoid shadowing.
    if key.contains("eq eight")
        || key.contains("eq8")
        || key.contains("eq3")
        || key.contains("channel eq")
        || key == "eq"
        || key.contains(" equalizer ")
        || key.starts_with("equalizer ")
        || key.ends_with(" equalizer")
    {
        return Some(FX_EQ);
    }
    if key.contains("compressor") || key.contains("glue") || key.contains("multiband dynamics") {
        return Some(FX_COMPRESSOR);
    }
    if key.contains("delay") || key.contains("echo") || key.contains("ping pong") {
        return Some(FX_DELAY);
    }
    if key.contains("reverb") || key.contains("hybrid reverb") {
        return Some(FX_REVERB);
    }
    if key.contains("chorus") || key.contains("chorus-ensemble") {
        return Some(FX_CHORUS);
    }
    if key.contains("saturator") {
        return Some(FX_SATURATOR);
    }
    if key.contains("limiter") {
        return Some(FX_LIMITER);
    }
    if key.contains("auto-filter") || key.contains("autofilter") || key.contains("auto filter") {
        return Some(FX_AUTO_FILTER);
    }
    if key.contains("auto-pan") || key.contains("autopan") || key.contains("auto pan") {
        return Some(FX_AUTO_PAN);
    }
    if key.contains("noise-machine")
        || key.contains("noisemachine")
        || key.contains("noise machine")
    {
        return Some(FX_NOISE_MACHINE);
    }
    if key.contains("phaser") || key.contains("phaser-flanger") {
        return Some(FX_PHASER);
    }
    if key.contains("flanger") {
        return Some(FX_FLANGER);
    }
    if key.contains("distortion")
        || key.contains("overdrive")
        || key.contains("pedal")
        || key.contains("cabinet")
        || key.contains("amp")
    {
        return Some(FX_DISTORTION);
    }
    if key.contains("bitcrusher") || key.contains("bit-crusher") || key.contains("redux") {
        return Some(FX_BITCRUSHER);
    }
    if key.contains("utility") {
        return Some(FX_UTILITY);
    }
    if key.contains("gate") {
        return Some(FX_GATE);
    }
    None
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
                    // For rack nodes (parallel topology), choose the first audible chain
                    // deterministically to avoid flattening parallel branches incorrectly.
                    let has_solo = rack.chains.iter().any(|c| c.is_solo);
                    let selected_chain = if has_solo {
                        rack.chains.iter().find(|c| c.is_solo && !c.is_mute)
                    } else {
                        rack.chains.iter().find(|c| !c.is_mute)
                    };
                    if let Some(chain) = selected_chain {
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
    Ok(())
}

fn sync_transport_from_project(
    project: &Project,
    handle: &AudioEngineHandle,
) -> Result<(), String> {
    let bpm = project.pulse_map.initial_bpm();
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
    push_command(handle, EngineCommand::SetTimelineSampleRate(timeline_sample_rate))?;
    push_command(handle, EngineCommand::SetBpm(bpm))?;
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
                muted: track.is_mute,
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

    /// Prebuilt DAG+plan snapshot consumed by the audio callback.
    prepared_graph_snapshot: Arc<SharedPreparedGraphSnapshot>,

    /// Atomic snapshot of internal effect sidechain source mapping.
    sidechain_snapshot: Arc<SharedSidechainSnapshot>,

    /// Atomic snapshot of external FX runtime instances per track.
    external_fx_snapshot: Arc<SharedExternalFxSnapshot>,
}

impl ClipPoolState {
    fn new() -> Self {
        Self {
            pool: Arc::new(Mutex::new(ClipPool::new())),
            arc_pool: Arc::new(ArcSwap::from_pointee(ClipPool::new())),
            snapshot: Arc::new(SharedClipSnapshot::new()),
            routing_snapshot: Arc::new(SharedRoutingSnapshot::new()),
            prepared_graph_snapshot: Arc::new(SharedPreparedGraphSnapshot::new()),
            sidechain_snapshot: Arc::new(SharedSidechainSnapshot::new()),
            external_fx_snapshot: Arc::new(SharedExternalFxSnapshot::new()),
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

        // O(1) index lookup for routing resolution (BUG-26 fix in lib.rs)
        let id_to_index: std::collections::HashMap<uuid::Uuid, usize> = project
            .tracks
            .iter()
            .enumerate()
            .map(|(i, t)| (t.id, i))
            .collect();

        let routing: Vec<Option<usize>> = project
            .tracks
            .iter()
            .map(|track| {
                track
                    .output_destination_id
                    .and_then(|dest_id| id_to_index.get(&dest_id).copied())
            })
            .collect();
        self.routing_snapshot.swap(routing);
        let routing_now = self.routing_snapshot.load();
        let sidechains: Vec<Vec<Option<usize>>> = project
            .tracks
            .iter()
            .map(|track| {
                // Collect sidechain sources from ALL plugins on the track.
                // Instrument (if external) + all effects.
                let mut sources = Vec::new();

                if let Some(inst) = track.instrument.as_ref().and_then(|i| i.as_single()) {
                    if let Some(source_id) = &inst.sidechain_source_track_id {
                        let idx = project.tracks.iter().position(|t| t.id.to_string() == *source_id);
                        sources.push(idx);
                    }
                }

                for node in &track.effects {
                    if let Some(slot) = node.as_single() {
                        if let Some(source_id) = &slot.sidechain_source_track_id {
                            let idx = project.tracks.iter().position(|t| t.id.to_string() == *source_id);
                            sources.push(idx);
                        }
                    }
                }
                sources
            })
            .collect();

        // ── ENTERPRISE GRAPH UPDATE: ──
        // Now that we have the full sidechain map, rebuild the audio graph
        // so that the processing order is correct.
        self.prepared_graph_snapshot
            .rebuild_for_routing(project.tracks.len(), routing_now.as_ref(), &sidechains);

        self.sidechain_snapshot.swap(sidechains);

        // Sync decoded audio data to the lock-free ArcSwap pool
        // so the audio thread can read it without locks.
        self.sync_pool_to_arc();
    }

    /// Routing-only snapshot rebuild for device chain topology changes.
    ///
    /// Used by device_rack operations (create rack, add chain, add/remove device,
    /// load preset) where the effect chain topology changes but no new audio files
    /// are added or removed.
    ///
    /// ~5x faster than full rebuild_snapshot() because it skips:
    ///   - Pool sync (Mutex lock + decode + Arc swap)
    ///
    /// Still rebuilds: clips, routing, sidechains, and audio DAG.
    fn rebuild_routing_only(&self, project: &Project) {
        let clips_per_track: Vec<Vec<AudioClip>> = project
            .tracks
            .iter()
            .map(|track| track.clips.clone())
            .collect();
        self.snapshot.swap(clips_per_track);

        let id_to_index: std::collections::HashMap<uuid::Uuid, usize> = project
            .tracks
            .iter()
            .enumerate()
            .map(|(i, t)| (t.id, i))
            .collect();

        let routing: Vec<Option<usize>> = project
            .tracks
            .iter()
            .map(|track| {
                track
                    .output_destination_id
                    .and_then(|dest_id| id_to_index.get(&dest_id).copied())
            })
            .collect();
        self.routing_snapshot.swap(routing);
        let routing_now = self.routing_snapshot.load();

        let sidechains: Vec<Vec<Option<usize>>> = project
            .tracks
            .iter()
            .map(|track| {
                let mut sources = Vec::new();
                if let Some(inst) = track.instrument.as_ref().and_then(|i| i.as_single()) {
                    if let Some(source_id) = &inst.sidechain_source_track_id {
                        let idx = project.tracks.iter().position(|t| t.id.to_string() == *source_id);
                        sources.push(idx);
                    }
                }
                for node in &track.effects {
                    if let Some(slot) = node.as_single() {
                        if let Some(source_id) = &slot.sidechain_source_track_id {
                            let idx = project.tracks.iter().position(|t| t.id.to_string() == *source_id);
                            sources.push(idx);
                        }
                    }
                }
                sources
            })
            .collect();

        self.prepared_graph_snapshot
            .rebuild_for_routing(project.tracks.len(), routing_now.as_ref(), &sidechains);
        self.sidechain_snapshot.swap(sidechains);
        // NOTE: Deliberately skips sync_pool_to_arc() — device topology changes
        // don't add/remove audio files from the pool.
    }

    /// Lightweight clip-only snapshot rebuild for position/duration changes.
    ///
    /// Used by move_clip_cmd and resize_clip_cmd where only clip positions
    /// change — routing, sidechains, DAG, and clip pool are unchanged.
    /// This is ~10x faster than full rebuild_snapshot() because it skips:
    ///   - Routing resolution (O(n) with HashMap, but still unnecessary)
    ///   - Sidechain resolution
    ///   - Audio DAG rebuild
    ///   - Pool sync (Mutex lock + log::info! allocation)
    fn rebuild_clips_only(&self, project: &Project) {
        let clips_per_track: Vec<Vec<AudioClip>> = project
            .tracks
            .iter()
            .map(|track| track.clips.clone())
            .collect();
        self.snapshot.swap(clips_per_track);
    }

    fn rebuild_external_fx_snapshot(
        &self,
        project: &Project,
        slot_instance_map: &HashMap<Uuid, Uuid>,
    ) {
        let mut external_fx: Vec<Vec<dream_engine::driver::ExternalFxRuntimeSlot>> = project
            .tracks
            .iter()
            .map(|track| {
                let mut internal_slot_index: usize = 0;

                // ── Include the instrument plugin (if external) first ──
                // Without this, external instrument plugins (e.g. Serum2) never
                // appear in the external_fx_map and thus never receive process()
                // calls in the audio callback — causing "DAW suspended processing"
                // and no MIDI input.
                let instrument_slot = track.instrument.as_ref()
                    .and_then(|inst| inst.as_single())
                    .and_then(|slot| {
                        if slot.plugin_id.starts_with("internal://") {
                            None  // Internal instruments handled separately
                        } else {
                            if slot.is_bypassed {
                                return None;
                            }
                            let instance_id = slot_instance_map.get(&slot.id).copied()?;
                            Some(dream_engine::driver::ExternalFxRuntimeSlot {
                                slot_id: Some(slot.id),
                                internal_slot_index: None,
                                instance_id: Some(instance_id),
                                sidechain_track_index: None,
                            })
                        }
                    });

                let effects_iter = track
                    .effects
                    .iter()
                    .filter_map(|node| node.as_single())
                    .filter_map(|slot| {
                        let sidechain_track_index =
                            slot.sidechain_source_track_id
                                .as_ref()
                                .and_then(|source_id| {
                                    project.tracks.iter().position(|candidate| {
                                        candidate.id.to_string() == *source_id
                                    })
                                });

                        if slot.plugin_id.starts_with("internal://effect/") {
                            let idx = internal_slot_index;
                            internal_slot_index = internal_slot_index.saturating_add(1);
                            Some(dream_engine::driver::ExternalFxRuntimeSlot {
                                slot_id: Some(slot.id),
                                internal_slot_index: Some(idx),
                                instance_id: None,
                                sidechain_track_index,
                            })
                        } else {
                            if slot.is_bypassed {
                                return None;
                            }
                            let instance_id = slot_instance_map.get(&slot.id).copied()?;
                            Some(dream_engine::driver::ExternalFxRuntimeSlot {
                                slot_id: Some(slot.id),
                                internal_slot_index: None,
                                instance_id: Some(instance_id),
                                sidechain_track_index,
                            })
                        }
                    });

                instrument_slot.into_iter().chain(effects_iter).collect()
            })
            .collect();

        // ── Master track external FX (CRITICAL FIX) ──────────────────────
        // The master track is stored separately from project.tracks,
        // so its external plugins (e.g., Muse, OTT, limiter VSTs) were
        // never included in the external FX map — meaning they NEVER
        // received process() calls in the audio callback.
        // Appending master FX as the LAST entry makes them available
        // at index `project.tracks.len()` for the post-graph master
        // FX processing pass in driver.rs.
        {
            let master = &project.master_track;
            let mut master_internal_idx: usize = 0;

            let master_instrument = master.instrument.as_ref()
                .and_then(|inst| inst.as_single())
                .and_then(|slot| {
                    if slot.plugin_id.starts_with("internal://") || slot.is_bypassed {
                        None
                    } else {
                        let instance_id = slot_instance_map.get(&slot.id).copied()?;
                        Some(dream_engine::driver::ExternalFxRuntimeSlot {
                            slot_id: Some(slot.id),
                            internal_slot_index: None,
                            instance_id: Some(instance_id),
                            sidechain_track_index: None,
                        })
                    }
                });

            let master_effects_iter = master.effects
                .iter()
                .filter_map(|node| node.as_single())
                .filter_map(|slot| {
                    if slot.plugin_id.starts_with("internal://effect/") {
                        let idx = master_internal_idx;
                        master_internal_idx = master_internal_idx.saturating_add(1);
                        Some(dream_engine::driver::ExternalFxRuntimeSlot {
                            slot_id: Some(slot.id),
                            internal_slot_index: Some(idx),
                            instance_id: None,
                            sidechain_track_index: None,
                        })
                    } else {
                        if slot.is_bypassed {
                            return None;
                        }
                        let instance_id = slot_instance_map.get(&slot.id).copied()?;
                        Some(dream_engine::driver::ExternalFxRuntimeSlot {
                            slot_id: Some(slot.id),
                            internal_slot_index: None,
                            instance_id: Some(instance_id),
                            sidechain_track_index: None,
                        })
                    }
                });

            let master_fx_chain: Vec<_> = master_instrument.into_iter()
                .chain(master_effects_iter)
                .collect();
            external_fx.push(master_fx_chain);
        }

        self.external_fx_snapshot.swap(external_fx);
    }

    /// Propagates the Mutex-guarded pool to the lock-free ArcSwap.
    ///
    /// Called after any pool mutation (import, delete, project load).
    /// `ClipPool::clone()` only bumps `Arc` refcounts — no audio data
    /// is copied, making this O(n) on pool size with negligible cost.
    fn sync_pool_to_arc(&self) {
        if let Ok(pool) = self.pool.lock() {
            let cloned = pool.clone();
            // Demoted from info! → debug! to eliminate heap allocation string formatting
            // during real-time playback. This runs on every rebuild_snapshot (34+ call sites).
            log::debug!(
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
            if source_path.starts_with("internal://") {
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
                    let _ = pool.insert(ClipAudio {
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
            loaded,
            skipped,
            failed
        );

        // Push to the audio thread's lock-free ArcSwap
        self.sync_pool_to_arc();
    }

    /// Evicts clips from the pool that are NO LONGER referenced by the current project
    /// OR the undo/redo history stacks. This prevents memory leaks on clip deletion,
    /// while preserving audio data so Undo works instantly without glitches.
    pub fn evict_unused_clips(&self, project_state: &ProjectState) {
        let mut referenced_paths = std::collections::HashSet::new();

        // 1. Scan current project
        if let Ok(project) = project_state.project.lock() {
            for track in &project.tracks {
                for clip in &track.clips {
                    if !clip.file_path.trim().is_empty() && !clip.file_path.starts_with("internal://") {
                        referenced_paths.insert(clip.file_path.clone());
                    }
                }
                if let Some(sampler) = &track.sampler {
                    if !sampler.sample_path.trim().is_empty() && !sampler.sample_path.starts_with("internal://") {
                        referenced_paths.insert(sampler.sample_path.clone());
                    }
                }
            }
        }

        // 2. Scan undo/redo history
        if let Ok(undo) = project_state.undo.lock() {
            for snapshot in undo.undo_stack.iter().chain(undo.redo_stack.iter()) {
                let p = snapshot.to_project();
                for track in &p.tracks {
                    for clip in &track.clips {
                        if !clip.file_path.trim().is_empty() && !clip.file_path.starts_with("internal://") {
                            referenced_paths.insert(clip.file_path.clone());
                        }
                    }
                    if let Some(sampler) = &track.sampler {
                        if !sampler.sample_path.trim().is_empty() && !sampler.sample_path.starts_with("internal://") {
                            referenced_paths.insert(sampler.sample_path.clone());
                        }
                    }
                }
            }
        }

        // 3. Evict from pool
        if let Ok(mut pool) = self.pool.lock() {
            let (evicted, freed) = pool.evict_unreferenced(&referenced_paths);
            if evicted > 0 {
                log::info!("[ClipPool] Evicted {} unused clips ({:.1} MB freed)", evicted, freed as f64 / 1_048_576.0);
            }
        }
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
    host: Arc<Mutex<PluginHost>>,
    loaded_by_key: Mutex<HashMap<String, Uuid>>,
    loaded_sandbox_by_key: Mutex<HashMap<String, Uuid>>,
    slot_instance_map: Arc<ArcSwap<HashMap<Uuid, Uuid>>>,
    sandbox_supervisor: Mutex<PluginSandboxSupervisor>,
    /// Cached plugin scan results to avoid re-scanning the filesystem on every
    /// `resolve_descriptor` call. Cleared on explicit rescan request.
    cached_scan: Mutex<Option<Vec<PluginDescriptor>>>,
}

impl PluginHostState {
    /// Returns `true` when in-process (unsandboxed) VST3 loading is permitted.
    ///
    /// Default: **true** — in-process loading is the primary path for native
    /// plugin editors. Set `DREAM_DAW_FORCE_SANDBOX_ONLY=1` to disable
    /// in-process loading (useful for crash-isolation testing with the
    /// sandbox daemon).
    fn allow_unsandboxed_vst3() -> bool {
        let force_sandbox = std::env::var("DREAM_DAW_FORCE_SANDBOX_ONLY")
            .ok()
            .map(|v| {
                let s = v.trim().to_ascii_lowercase();
                matches!(s.as_str(), "1" | "true" | "yes" | "on")
            })
            .unwrap_or(false);
        !force_sandbox
    }

    fn try_enable_sandbox_if_available(&self) {
        if let Ok(mut sup) = self.sandbox_supervisor.lock() {
            sup.set_enabled(true);
            if sup.enabled() {
                log::info!("[PluginHost] Sandbox auto-enabled on startup");
            } else {
                log::warn!("[PluginHost] Sandbox auto-enable failed (daemon binary not found)");
            }
        }
    }

    fn new() -> Self {
        let sandbox_config = PluginSandboxConfig::from_env();
        Self {
            host: Arc::new(Mutex::new(PluginHost::new(44100.0, 1024))),
            loaded_by_key: Mutex::new(HashMap::new()),
            loaded_sandbox_by_key: Mutex::new(HashMap::new()),
            slot_instance_map: Arc::new(ArcSwap::from_pointee(HashMap::new())),
            sandbox_supervisor: Mutex::new(PluginSandboxSupervisor::new(sandbox_config)),
            cached_scan: Mutex::new(None),
        }
    }

    fn bind_slot_instance(&self, slot_id: Uuid, instance_id: Uuid) {
        let mut map = self.slot_instance_map.load_full().as_ref().clone();
        map.insert(slot_id, instance_id);
        self.slot_instance_map.store(Arc::new(map));
    }

    /// Invalidates the cached plugin scan results, forcing a fresh
    /// filesystem scan on the next `resolve_descriptor` call.
    #[allow(dead_code)]
    fn clear_scan_cache(&self) -> Result<(), String> {
        *self.cached_scan.lock().map_err(|e| format!("cached_scan lock poisoned: {e}"))? = None;
        Ok(())
    }

    /// Reactivates all loaded plugin instances with a new sample rate
    /// and buffer size. Used when the audio device configuration changes.
    #[allow(dead_code)]
    fn reactivate_all(&self, sample_rate: f64, buffer_size: usize) -> Result<(), String> {
        let mut host = self.host.lock().map_err(|e| e.to_string())?;
        host.reactivate_all(sample_rate, buffer_size);
        Ok(())
    }

    /// Gracefully shuts down all loaded plugin instances.
    ///
    /// Must be called before the process exits to prevent SIGSEGV crashes
    /// from third-party plugins whose C++ static destructors access
    /// released resources during `exit()` teardown.
    fn shutdown_all_plugins(&self) {
        log::info!("[PluginHostState] Initiating graceful plugin shutdown...");
        match self.host.lock() {
            Ok(mut host) => host.shutdown_all(),
            Err(e) => log::error!(
                "[PluginHostState] Failed to acquire plugin host lock for shutdown: {}",
                e
            ),
        }
        // Also shut down sandbox supervisor to clean up any out-of-process
        // plugin daemons that may be running.
        if let Ok(mut sup) = self.sandbox_supervisor.lock() {
            sup.set_enabled(false);
            log::info!("[PluginHostState] Sandbox supervisor disabled");
        }
        log::info!("[PluginHostState] Plugin shutdown complete");
    }

    fn unbind_slot_instance(&self, slot_id: Uuid) {
        let mut map = self.slot_instance_map.load_full().as_ref().clone();
        map.remove(&slot_id);
        self.slot_instance_map.store(Arc::new(map));
    }

    fn take_slot_instance(&self, slot_id: Uuid) -> Option<Uuid> {
        let mut map = self.slot_instance_map.load_full().as_ref().clone();
        let removed = map.remove(&slot_id);
        self.slot_instance_map.store(Arc::new(map));
        removed
    }

    fn slot_instance_snapshot(&self) -> Arc<HashMap<Uuid, Uuid>> {
        self.slot_instance_map.load_full()
    }

    fn clear_slot_instance_bindings(&self) {
        self.slot_instance_map.store(Arc::new(HashMap::new()));
    }

    fn unload_instance(&self, instance_id: Uuid) -> Result<(), String> {
        {
            let mut host = self.host.lock().map_err(|e| e.to_string())?;
            let _ = host.remove(instance_id);
        }

        {
            let mut map = self.loaded_by_key.lock().map_err(|e| e.to_string())?;
            map.retain(|_, id| *id != instance_id);
        }

        {
            let mut sandbox_map = self
                .loaded_sandbox_by_key
                .lock()
                .map_err(|e| e.to_string())?;
            let had_sandbox_entry = sandbox_map.values().any(|id| *id == instance_id);
            if had_sandbox_entry {
                sandbox_map.retain(|_, id| *id != instance_id);
                let mut supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
                let _ = supervisor.send_close_editor(instance_id);
                supervisor.remove_instance(instance_id);
            }
        }

        let mut slot_map = self.slot_instance_map.load_full().as_ref().clone();
        slot_map.retain(|_, id| *id != instance_id);
        self.slot_instance_map.store(Arc::new(slot_map));
        Ok(())
    }

    fn unload_slot_instance(&self, slot_id: Uuid) -> Result<(), String> {
        if let Some(instance_id) = self.take_slot_instance(slot_id) {
            self.unload_instance(instance_id)?;
        }
        Ok(())
    }

    fn unload_all_instances(&self) -> Result<(), String> {
        let mut ids = HashSet::<Uuid>::new();
        {
            let map = self.loaded_by_key.lock().map_err(|e| e.to_string())?;
            ids.extend(map.values().copied());
        }
        {
            let map = self
                .loaded_sandbox_by_key
                .lock()
                .map_err(|e| e.to_string())?;
            ids.extend(map.values().copied());
        }
        ids.extend(self.slot_instance_map.load_full().values().copied());

        for id in ids {
            let _ = self.unload_instance(id);
        }

        self.loaded_by_key
            .lock()
            .map_err(|e| e.to_string())?
            .clear();
        self.loaded_sandbox_by_key
            .lock()
            .map_err(|e| e.to_string())?
            .clear();
        self.clear_slot_instance_bindings();
        Ok(())
    }

    fn capture_plugin_states_into_project(&self, project: &mut dream_models::project::Project) -> Result<(), String> {
        use base64::Engine;

        let slot_map = self.slot_instance_snapshot();
        log::info!(
            "[PluginState-Capture] slot_instance_map has {} entries: {:?}",
            slot_map.len(),
            slot_map.as_ref()
        );

        let host = self.host.lock().map_err(|e| format!("PluginHost lock: {e}"))?;
        let instance_states = host.save_all_states();

        log::info!(
            "[PluginState-Capture] save_all_states returned {} instance states",
            instance_states.len()
        );
        for (id, bytes) in &instance_states {
            log::info!(
                "[PluginState-Capture]   instance {} → {} bytes",
                id,
                bytes.len()
            );
        }

        if instance_states.is_empty() {
            log::warn!("[PluginState-Capture] No instance states to save — returning early!");
            return Ok(());
        }

        // Build reverse map: instance_id → Vec<slot_id>
        // (multiple slots can share the same instance)
        let mut instance_to_slots: std::collections::HashMap<uuid::Uuid, Vec<uuid::Uuid>> =
            std::collections::HashMap::new();
        for (slot_id, instance_id) in slot_map.iter() {
            instance_to_slots
                .entry(*instance_id)
                .or_default()
                .push(*slot_id);
        }

        let mut updated_count = 0usize;

        for (instance_id, state_bytes) in &instance_states {
            let Some(slot_ids) = instance_to_slots.get(instance_id) else {
                log::warn!(
                    "[PluginState-Capture] Instance {} has state but NO slot mapping — skipping!",
                    instance_id
                );
                continue;
            };

            let b64 = base64::engine::general_purpose::STANDARD.encode(state_bytes);

            for slot_id in slot_ids {
                // Find the slot in the project's device trees and update its state blob
                let mut found = false;
                for track in &mut project.tracks {
                    // Walk effects chain (Vec<DeviceNode>)
                    for device in &mut track.effects {
                        for slot in device.collect_plugin_slots_mut() {
                            if slot.id == *slot_id {
                                slot.external_state_blob = Some(b64.clone());
                                slot.external_state_blob_kind = Some("ProcessorState".to_string());
                                updated_count += 1;
                                found = true;
                                log::info!(
                                    "[PluginState-Capture] Updated effect slot '{}' (id={}) on track '{}' ({} bytes b64)",
                                    slot.name, slot_id, track.name, b64.len()
                                );
                            }
                        }
                    }
                    // Walk instrument (Option<DeviceNode>)
                    if let Some(inst) = &mut track.instrument {
                        for slot in inst.collect_plugin_slots_mut() {
                            if slot.id == *slot_id {
                                slot.external_state_blob = Some(b64.clone());
                                slot.external_state_blob_kind = Some("ProcessorState".to_string());
                                updated_count += 1;
                                found = true;
                                log::info!(
                                    "[PluginState-Capture] Updated instrument slot '{}' (id={}) on track '{}' ({} bytes b64)",
                                    slot.name, slot_id, track.name, b64.len()
                                );
                            }
                        }
                    }
                }
                // Also check master_track effects
                for device in &mut project.master_track.effects {
                    for slot in device.collect_plugin_slots_mut() {
                        if slot.id == *slot_id {
                            slot.external_state_blob = Some(b64.clone());
                            slot.external_state_blob_kind = Some("ProcessorState".to_string());
                            updated_count += 1;
                            found = true;
                            log::info!(
                                "[PluginState-Capture] Updated master track slot '{}' (id={}) ({} bytes b64)",
                                slot.name, slot_id, b64.len()
                            );
                        }
                    }
                }
                if !found {
                    log::warn!(
                        "[PluginState-Capture] Slot {} mapped to instance {} but NOT found in any project track!",
                        slot_id, instance_id
                    );
                }
            }
        }

        if updated_count > 0 {
            log::info!(
                "[PluginHost] Captured live state for {} plugin slot(s) ({} instances)",
                updated_count,
                instance_states.len()
            );
        } else {
            log::warn!(
                "[PluginState-Capture] 0 slots updated despite {} instance states! Check slot mapping.",
                instance_states.len()
            );
        }

        Ok(())
    }

    fn ensure_loaded_instance_for_slot(
        &self,
        slot_id: Uuid,
        plugin_id: &str,
    ) -> Result<Uuid, String> {
        self.try_enable_sandbox_if_available();
        if let Some(instance_id) = self.slot_instance_map.load().get(&slot_id).copied() {
            return Ok(instance_id);
        }

        let descriptor = self.resolve_descriptor(plugin_id)?;
        if descriptor.format != PluginFormat::VST3 {
            return Err(format!(
                "External runtime currently supports only VST3 (got {})",
                descriptor.format
            ));
        }

        if self.sandbox_enabled().unwrap_or(false) {
            match self.open_in_sandbox(plugin_id, descriptor.clone()) {
                Ok(instance_id) => {
                    self.bind_slot_instance(slot_id, instance_id);
                    self.loaded_by_key
                        .lock()
                        .map_err(|e| e.to_string())?
                        .entry(plugin_id.to_string())
                        .or_insert(instance_id);
                    return Ok(instance_id);
                }
                Err(err) => {
                    if !Self::allow_unsandboxed_vst3() {
                        return Err(format!(
                            "Plugin sandbox failed for '{}': {}. In-process VST3 loading is disabled (DREAM_DAW_FORCE_SANDBOX_ONLY is active).",
                            descriptor.name,
                            err
                        ));
                    }
                    log::warn!(
                        "[PluginSandbox] fallback to in-process load for '{}' due to error: {}",
                        descriptor.name,
                        err
                    );
                }
            }
        }

        if !Self::allow_unsandboxed_vst3() {
            return Err(format!(
                "Plugin sandbox is unavailable for '{}'. In-process VST3 loading is disabled (DREAM_DAW_FORCE_SANDBOX_ONLY is active).",
                descriptor.name
            ));
        }

        let mut host = self.host.lock().map_err(|e| e.to_string())?;
        let instance_id = host
            .load_vst3(descriptor.clone())
            .map_err(|e| format!("Failed to load plugin '{}': {e}", descriptor.name))?;
        drop(host);

        self.bind_slot_instance(slot_id, instance_id);
        self.loaded_by_key
            .lock()
            .map_err(|e| e.to_string())?
            .entry(plugin_id.to_string())
            .or_insert(instance_id);

        Ok(instance_id)
    }

    fn resolve_descriptor(&self, plugin_id: &str) -> Result<PluginDescriptor, String> {
        let mut path = PathBuf::from(plugin_id);
        if path.exists() {
            // If caller passed an inner binary path from a .vst3 bundle
            // (e.g. .../Foo.vst3/Contents/MacOS/Foo), normalize to the bundle root.
            if !path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("vst3"))
                .unwrap_or(false)
            {
                if let Some(bundle_root) = path
                    .ancestors()
                    .find(|p| {
                        p.extension()
                            .and_then(|e| e.to_str())
                            .map(|e| e.eq_ignore_ascii_case("vst3"))
                            .unwrap_or(false)
                    })
                    .map(|p| p.to_path_buf())
                {
                    path = bundle_root;
                }
            }

            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext == "vst" {
                return Err(
                    "VST2 runtime is not supported in this build yet. Use VST3 plugins."
                        .to_string(),
                );
            }
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Unknown VST")
                .to_string();
            let format = match ext.as_str() {
                "vst3" => PluginFormat::VST3,
                "component" | "au" => PluginFormat::AudioUnit,
                "clap" => PluginFormat::CLAP,
                _ => PluginFormat::VST3,
            };
            return Ok(PluginDescriptor::new(
                name,
                "Unknown Vendor",
                format,
                PluginCategory::Effect,
                path,
            ));
        }

        // Use cached scan results to avoid expensive filesystem traversal on every call.
        let cached = self.cached_scan.lock().map_err(|e| format!("cached_scan lock poisoned: {e}"))?;
        let scan_result = if let Some(ref cached_list) = *cached {
            cached_list.clone()
        } else {
            drop(cached);
            let scanner = PluginScanner::new();
            let all = scanner.scan_all();
            *self.cached_scan.lock().map_err(|e| format!("cached_scan lock poisoned: {e}"))? = Some(all.clone());
            all
        };
        scan_result
            .into_iter()
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

    fn sandbox_snapshot(&self) -> Result<PluginSandboxSnapshot, String> {
        let supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
        Ok(supervisor.snapshot())
    }

    fn set_sandbox_enabled(&self, enabled: bool) -> Result<PluginSandboxSnapshot, String> {
        let mut supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
        supervisor.set_enabled(enabled);
        Ok(supervisor.snapshot())
    }

    fn sandbox_enabled(&self) -> Result<bool, String> {
        let supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
        Ok(supervisor.enabled())
    }

    fn open_in_sandbox(
        &self,
        plugin_key: &str,
        descriptor: PluginDescriptor,
    ) -> Result<Uuid, String> {
        let mut supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
        let instance_id = supervisor
            .attach_plugin_process(descriptor.clone())
            .map_err(|e| format!("Sandbox spawn failed: {e}"))?;
        let shared_region = supervisor
            .shared_region_for_instance(instance_id)
            .ok_or_else(|| "Sandbox shared region was not created".to_string())?;
        drop(supervisor);

        {
            let mut host = self.host.lock().map_err(|e| e.to_string())?;
            host.load_vst3_sandboxed(
                instance_id,
                descriptor,
                PathBuf::from(shared_region.map_name.clone()),
                shared_region.num_inputs,
                shared_region.num_outputs,
                shared_region.max_frames,
            )
            .map_err(|e| format!("Sandbox plugin bridge registration failed: {e}"))?;
        }

        self.loaded_sandbox_by_key
            .lock()
            .map_err(|e| e.to_string())?
            .insert(plugin_key.to_string(), instance_id);
        {
            let mut supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
            let _ = supervisor.send_open_editor(instance_id);
        }
        Ok(instance_id)
    }

    fn close_in_sandbox(&self, plugin_key: &str) -> Result<(), String> {
        let maybe_id = self
            .loaded_sandbox_by_key
            .lock()
            .map_err(|e| e.to_string())?
            .remove(plugin_key);
        if let Some(id) = maybe_id {
            if let Ok(mut supervisor) = self.sandbox_supervisor.lock() {
                let _ = supervisor.send_close_editor(id);
            }
            if let Ok(mut host) = self.host.lock() {
                let _ = host.remove(id);
            }
            let mut supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
            supervisor.remove_instance(id);
        }
        Ok(())
    }

    fn tick_sandbox_watchdog(&self) -> Result<PluginSandboxSnapshot, String> {
        let mut supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
        let timed_out = supervisor.tick_watchdog();
        if !timed_out.is_empty() {
            let mut reverse = HashMap::<Uuid, String>::new();
            if let Ok(map) = self.loaded_sandbox_by_key.lock() {
                for (k, v) in map.iter() {
                    reverse.insert(*v, k.clone());
                }
            }
            for id in timed_out {
                if let Some(key) = reverse.get(&id) {
                    log::error!(
                        "[PluginSandbox] Host unhealthy for key='{}' (instance={}) -> bypass requested",
                        key,
                        id
                    );
                } else {
                    log::error!(
                        "[PluginSandbox] Host unhealthy for instance={} -> bypass requested",
                        id
                    );
                }
            }
        }
        Ok(supervisor.snapshot())
    }

    fn open_sandbox_editor(&self, plugin_key: &str) -> Result<bool, String> {
        let maybe_id = self
            .loaded_sandbox_by_key
            .lock()
            .map_err(|e| e.to_string())?
            .get(plugin_key)
            .copied();
        let Some(id) = maybe_id else { return Ok(false) };
        let mut supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
        match supervisor.send_open_editor(id) {
            Ok(()) => Ok(true),
            Err(err) => {
                // Sandbox daemon is unhealthy or crashed — evict the stale
                // entry so the caller can fall through to in-process loading.
                log::warn!(
                    "[PluginSandbox] open_sandbox_editor failed for '{}' (instance={}): {}. Evicting stale sandbox entry.",
                    plugin_key,
                    id,
                    err
                );
                drop(supervisor);
                if let Ok(mut map) = self.loaded_sandbox_by_key.lock() {
                    map.remove(plugin_key);
                }
                Ok(false)
            }
        }
    }

    fn set_sandbox_parameter(
        &self,
        plugin_key: &str,
        param_index: u32,
        value: f64,
    ) -> Result<bool, String> {
        let maybe_id = self
            .loaded_sandbox_by_key
            .lock()
            .map_err(|e| e.to_string())?
            .get(plugin_key)
            .copied();
        let Some(id) = maybe_id else { return Ok(false) };
        let mut supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
        supervisor
            .send_set_parameter(id, param_index, value)
            .map_err(|e| format!("Sandbox set parameter failed: {e}"))?;
        Ok(true)
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
    #[serde(default = "default_output_device")]
    fallback_output_device: String,
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
    #[serde(default, alias = "openRouterApiKey")]
    open_router_api_key: String,
    #[serde(default = "default_open_router_model", alias = "openRouterModel")]
    open_router_model: String,
    /// Browser file list columns visibility (persisted UI prefs).
    #[serde(default = "default_true", alias = "browserShowSizeColumn")]
    browser_show_size_column: bool,
    #[serde(default, alias = "browserShowTypeColumn")]
    browser_show_type_column: bool,
    /// Browser left category pane width in pixels.
    #[serde(
        default = "default_browser_left_pane_width",
        alias = "browserLeftPaneWidth"
    )]
    browser_left_pane_width: u32,
}

fn default_language() -> String {
    "English".into()
}
fn default_startup_behavior() -> String {
    "last".into()
}
fn default_waveform_style() -> String {
    "colored".into()
}
fn default_driver_type() -> String {
    "CoreAudio".into()
}
fn default_output_device() -> String {
    "Default Output".into()
}
fn default_input_device() -> String {
    "Default Input".into()
}
fn default_sample_rate() -> u32 {
    44100
}
fn default_buffer_size() -> u32 {
    512
}
fn default_test_tone_volume() -> f64 {
    -20.0
}
fn default_test_tone_frequency() -> f64 {
    440.0
}
fn default_true() -> bool {
    true
}
fn default_user_folder() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    home.join("Music").join("Dream DAW").display().to_string()
}
fn default_samples_path() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    home.join("Music")
        .join("Dream DAW")
        .join("Samples")
        .display()
        .to_string()
}
fn default_vst2_path() -> String {
    "/Library/Audio/Plug-Ins/VST".into()
}
fn default_vst3_path() -> String {
    "/Library/Audio/Plug-Ins/VST3".into()
}
fn default_open_router_model() -> String {
    "anthropic/claude-sonnet-4-5".into()
}
fn default_browser_left_pane_width() -> u32 {
    92
}

impl Default for AppSettings {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let music_dir = home.join("Music").join("Dream DAW");
        Self {
            language: "English".into(),
            startup_behavior: "last".into(),
            waveform_style: "colored".into(),
            driver_type: "CoreAudio".into(),
            output_device: "Default Output".into(),
            fallback_output_device: "Default Output".into(),
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
            open_router_api_key: String::new(),
            open_router_model: default_open_router_model(),
            browser_show_size_column: true,
            browser_show_type_column: false,
            browser_left_pane_width: default_browser_left_pane_width(),
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
            return Self {
                settings: Mutex::new(settings),
            };
        }

        // Fallback: load from app_data_dir (legacy Tauri location)
        let legacy_path = app_data_dir.join("settings.json");
        if legacy_path.exists()
            && let Ok(json) = std::fs::read_to_string(&legacy_path)
            && let Ok(settings) = serde_json::from_str::<AppSettings>(&json)
        {
            log::info!(
                "Settings loaded from legacy path: {}",
                legacy_path.display()
            );
            // Migrate: save to user folder and clean up
            let state = Self {
                settings: Mutex::new(settings),
            };
            if let Err(e) = state.save_to_user_folder() {
                log::warn!("Failed to migrate settings: {}", e);
            }
            return state;
        }

        log::info!("No settings found, using defaults");
        Self {
            settings: Mutex::new(defaults),
        }
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
        let old_settings_file = PathBuf::from(old_path)
            .join("User Info")
            .join("settings.json");
        let new_user_info_dir = PathBuf::from(new_path).join("User Info");
        let new_settings_file = new_user_info_dir.join("settings.json");

        // Create new User Info directory
        std::fs::create_dir_all(&new_user_info_dir)
            .map_err(|e| format!("Failed to create new User Info dir: {}", e))?;

        // Copy old settings if they exist
        if old_settings_file.exists() && !new_settings_file.exists() {
            std::fs::copy(&old_settings_file, &new_settings_file)
                .map_err(|e| format!("Failed to copy settings: {}", e))?;
            log::info!(
                "Settings migrated from {} to {}",
                old_settings_file.display(),
                new_settings_file.display()
            );
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
        self.projects.insert(
            0,
            RecentProject {
                name,
                path,
                last_opened: chrono_now(),
            },
        );
        // Keep max 20 recent projects
        self.projects.truncate(20);
    }
}

/// Returns current UTC time as ISO 8601 / RFC 3339 string.
///
/// Format: `2026-02-18T14:30:00Z` — human-readable, lexicographically
/// sortable, and universally parseable.
fn chrono_now() -> String {
    use std::time::SystemTime;
    let since_epoch = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = since_epoch.as_secs();
    // Manual UTC decomposition — no external dependency required.
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;
    // Civil date from days since epoch (1970-01-01).
    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

/// Converts days since 1970-01-01 to (year, month, day).
/// Algorithm from Howard Hinnant's `chrono`-compatible date library.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
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
                    std::thread::sleep(Duration::from_micros(if high_priority { 250 } else { 150 }));
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
    let plugin_host_state = PluginHostState::new();

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
    let plugin_host_for_engine = Arc::clone(&plugin_host_state.host);
    let plugin_host_for_handle = Arc::clone(&plugin_host_state.host);
    let plugin_registry = Arc::new(dream_engine::driver::SharedPluginRegistry::new());
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
                analyzer: dream_dsp::spectrum_analyzer::SpectrumAnalyzer::new(stream.sample_rate_hz as f32),
                last_magnitudes: vec![dream_dsp::spectrum_analyzer::FLOOR_DB; dream_dsp::spectrum_analyzer::OUTPUT_BINS],
            }),
        }
    } else {
        // Fallback: create a dummy consumer (no audio data)
        let (_producer, consumer) = rtrb::RingBuffer::<f32>::new(64);
        SpectrumState {
            inner: Mutex::new(SpectrumStateInner {
                consumer,
                analyzer: dream_dsp::spectrum_analyzer::SpectrumAnalyzer::new(stream.sample_rate_hz as f32),
                last_magnitudes: vec![dream_dsp::spectrum_analyzer::FLOOR_DB; dream_dsp::spectrum_analyzer::OUTPUT_BINS],
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
    if should_persist_resolved_output
        && let Err(e) = settings_state.save_to_user_folder()
    {
        log::warn!("Failed to persist resolved output device: {}", e);
    }

    let mut playback_state = PlaybackState::default();
    playback_state.sample_rate = bootstrap_project.sample_rate.max(1.0);

    // Ensure audio callback starts in the same timeline sample-rate domain
    // as the bootstrap project before any transport activity.
    let _ = producer.push(EngineCommand::SetTimelineSampleRate(playback_state.sample_rate));

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
        plugin_host: plugin_host_for_handle,
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
                        let snapshot = match plugin_host_state.tick_sandbox_watchdog() {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        let _ = sandbox_app.emit("plugin_sandbox_tick", &snapshot);
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

                    let ns_event_class = Class::get("NSEvent").expect("NSEvent class must exist on macOS");
                    let _: *mut Object = msg_send![
                        ns_event_class,
                        addLocalMonitorForEventsMatchingMask: mask
                        handler: &*block
                    ];
                    // Intentionally leak the block — it must live for the app's lifetime.
                    std::mem::forget(block);
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
}
