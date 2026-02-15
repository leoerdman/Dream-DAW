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

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::collections::{HashMap, VecDeque};

use arc_swap::ArcSwap;

use dream_clip_engine::pool::{ClipAudio, ClipPool};
use dream_engine::driver::{
    AutomationPoint, MidiFxRuntimeConfig, MidiTrackRuntime, SharedAutomationSnapshot, SharedClipSnapshot, SharedRoutingSnapshot,
    TrackAutomationState,
};
use dream_engine::offline_bounce::{BounceConfig, OfflineBouncer};
use dream_engine::recording::RecordingSession;
use dream_io::audio_reader::AudioReader;
use dream_io::peak_cache::{PeakCache, WaveformPeaks};
use dream_io::project_file::ProjectFile;
use dream_io::project_manager::ProjectManager;
use dream_io::wav_writer::WavWriter;
use dream_plugins::{
    PluginDescriptor, PluginHost, PluginSandboxConfig, PluginSandboxSnapshot, PluginSandboxSupervisor,
    PluginScanner,
};
use dream_plugins::format::{PluginCategory, PluginFormat};
use dream_ipc::metering::MeterBank;
use dream_ipc::{EngineCommand, MasterClock};
use dream_models::mutators::{self, MutatorError};
use dream_models::midi::{MidiClip, MidiNote, SamplerConfig};
use dream_models::project::{AudioClip, DeviceNode, PluginSlot, Project, TimeSignature, Track, TrackColor, TrackType};
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

    /// Estimated hardware output latency in sample frames.
    /// Captured from cpal at stream init. Passed to frontend so the
    /// visual playhead can be offset to match actual speaker output.
    output_latency_frames: u32,
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
            view_state_main_window_device_detail_open: self.view_state_main_window_device_detail_open,
            view_state_second_window_clip_detail_open: self.view_state_second_window_clip_detail_open,
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

    fn snapshot(&self, limit: Option<usize>) -> Vec<ProjectHistoryEvent> {
        let count = limit.unwrap_or(self.events.len()).min(self.events.len());
        let start = self.events.len().saturating_sub(count);
        self.events.iter().skip(start).cloned().collect()
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

    fn record_history(&self, kind: impl Into<String>, detail: impl Into<String>) -> Result<(), String> {
        let mut history = self.history.lock().map_err(|e| e.to_string())?;
        history.push(kind, detail);
        Ok(())
    }

    fn history_snapshot(&self, limit: Option<usize>) -> Result<Vec<ProjectHistoryEvent>, String> {
        let history = self.history.lock().map_err(|e| e.to_string())?;
        Ok(history.snapshot(limit))
    }
}

/// Snapshots the current project state onto the undo stack.
///
/// Must be called BEFORE any mutation. Clears the redo stack
/// (a new action invalidates the redo history).
#[track_caller]
fn push_undo(project_state: &ProjectState) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut undo = project_state.undo.lock().map_err(|e| e.to_string())?;
    let previous = undo.undo_stack.last();
    let snapshot = SharedProjectSnapshot::from_project(&project, previous);
    drop(project);
    undo.undo_stack.push(snapshot);
    let depth = undo.undo_stack.len();
    if undo.undo_stack.len() > MAX_UNDO_DEPTH {
        undo.undo_stack.remove(0);
    }
    undo.redo_stack.clear();
    drop(undo);

    let caller = std::panic::Location::caller();
    project_state.record_history(
        "mutation_snapshot",
        format!(
            "captured undo snapshot depth={} caller={}:{}",
            depth,
            caller.file(),
            caller.line()
        ),
    )?;
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
            let has_pitch = track
                .effects
                .iter()
                .any(|fx| fx.plugin_id().eq_ignore_ascii_case("internal://midi-fx/pitch"));
            let has_scale = track
                .effects
                .iter()
                .any(|fx| fx.plugin_id().eq_ignore_ascii_case("internal://midi-fx/scale"));
            let has_velocity = track
                .effects
                .iter()
                .any(|fx| fx.plugin_id().eq_ignore_ascii_case("internal://midi-fx/velocity"));
            let has_random = track
                .effects
                .iter()
                .any(|fx| fx.plugin_id().eq_ignore_ascii_case("internal://midi-fx/random"));

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
                scale_root: first_lane_value(
                    track,
                    &["midi.scale.root", "midifx.scale.root"],
                    0.0,
                )
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
                clips: track.midi_clips.clone(),
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
    let mut synth_settings: Vec<(usize, u8, u8, f32, f32, f32, f32, f32, u8, f32, f32, u8, f32)> = Vec::new();
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
                let (waveform, osc2, mix, detune, sub, f_cutoff, f_res, f_type, lfo_r, lfo_d, lfo_t, pw) = track
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
                synth_settings.push((idx, waveform, osc2, mix, detune, sub, f_cutoff, f_res, f_type, lfo_r, lfo_d, lfo_t, pw));
            }
            if let Some(cfg) = &track.sampler
                && !cfg.sample_path.trim().is_empty()
                && !cfg.sample_path.starts_with("internal://")
                && let Some(audio) = pool.get(&cfg.sample_path)
            {
                samples[idx] = Some(audio);
            }
        }
    }
    handle.sampler_samples.swap(samples);
    for (track_idx, waveform, osc2, mix, detune, sub, f_cutoff, f_res, f_type, lfo_r, lfo_d, lfo_t, pw) in synth_settings {
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
        let _ = push_command(
            handle,
            EngineCommand::SetSamplerOsc2Waveform {
                track_index: track_idx as u16,
                waveform: osc2,
            },
        );
        let _ = push_command(
            handle,
            EngineCommand::SetSamplerOscMix {
                track_index: track_idx as u16,
                mix,
            },
        );
        let _ = push_command(
            handle,
            EngineCommand::SetSamplerDetuneCents {
                track_index: track_idx as u16,
                cents: detune,
            },
        );
        let _ = push_command(
            handle,
            EngineCommand::SetSamplerSubLevel {
                track_index: track_idx as u16,
                level: sub,
            },
        );
        let _ = push_command(
            handle,
            EngineCommand::SetSamplerFilterCutoff {
                track_index: track_idx as u16,
                cutoff: f_cutoff,
            },
        );
        let _ = push_command(
            handle,
            EngineCommand::SetSamplerFilterResonance {
                track_index: track_idx as u16,
                resonance: f_res,
            },
        );
        let _ = push_command(
            handle,
            EngineCommand::SetSamplerFilterType {
                track_index: track_idx as u16,
                filter_type: f_type,
            },
        );
        let _ = push_command(
            handle,
            EngineCommand::SetSamplerLfoRate {
                track_index: track_idx as u16,
                rate: lfo_r,
            },
        );
        let _ = push_command(
            handle,
            EngineCommand::SetSamplerLfoDepth {
                track_index: track_idx as u16,
                depth: lfo_d,
            },
        );
        let _ = push_command(
            handle,
            EngineCommand::SetSamplerLfoTarget {
                track_index: track_idx as u16,
                target: lfo_t,
            },
        );
        let _ = push_command(
            handle,
            EngineCommand::SetSamplerPulseWidth {
                track_index: track_idx as u16,
                width: pw,
            },
        );
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
            _ => None,
        };
    }

    // ── Keyword fallbacks (Ableton device names, aliases) ────────────
    // Order: more specific matches before generic ones to avoid shadowing.
    if key.contains("eq eight") || key.contains("eq8") || key.contains("eq3") || key.contains("channel eq") || key.contains("eq") {
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
    if key.contains("noise-machine") || key.contains("noisemachine") || key.contains("noise machine") {
        return Some(FX_NOISE_MACHINE);
    }
    if key.contains("phaser") || key.contains("phaser-flanger") {
        return Some(FX_PHASER);
    }
    if key.contains("flanger") {
        return Some(FX_FLANGER);
    }
    if key.contains("distortion") || key.contains("overdrive") || key.contains("pedal") || key.contains("cabinet") || key.contains("amp") {
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
        // 0 size%, 2 mix%, 3 predelay ms.
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
            push_command(handle, EngineCommand::RemoveDevice { track_index, slot_index })?;
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
    loaded_sandbox_by_key: Mutex<HashMap<String, Uuid>>,
    sandbox_supervisor: Mutex<PluginSandboxSupervisor>,
}

impl PluginHostState {
    fn new() -> Self {
        let sandbox_config = PluginSandboxConfig::from_env();
        Self {
            host: Mutex::new(PluginHost::new(44100.0, 1024)),
            loaded_by_key: Mutex::new(HashMap::new()),
            loaded_sandbox_by_key: Mutex::new(HashMap::new()),
            sandbox_supervisor: Mutex::new(PluginSandboxSupervisor::new(sandbox_config)),
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
        Ok(instance_id)
    }

    fn close_in_sandbox(&self, plugin_key: &str) -> Result<(), String> {
        let maybe_id = self
            .loaded_sandbox_by_key
            .lock()
            .map_err(|e| e.to_string())?
            .remove(plugin_key);
        if let Some(id) = maybe_id {
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
                        key, id
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
    #[serde(default, alias = "openRouterApiKey")]
    open_router_api_key: String,
    #[serde(default = "default_open_router_model", alias = "openRouterModel")]
    open_router_model: String,
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
fn default_open_router_model() -> String { "openai/gpt-4o-mini".into() }

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
            open_router_api_key: String::new(),
            open_router_model: default_open_router_model(),
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
    let stream = match dream_engine::driver::start_audio_thread(
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
    ) {
        Ok(stream) => stream,
        Err(err) => {
            log::error!("Fatal: failed to start audio engine: {err}");
            return;
        }
    };

    // Capture output latency from the stream handle before boxing
    let output_latency_frames = stream.output_latency_frames;

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
        output_latency_frames,
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
        .invoke_handler(commands::invoke_handler())
        .setup(|app| {
            // ── Telemetry Push Thread (30fps) ─────────────────────────
            // Replaces frontend requestAnimationFrame polling with
            // server-pushed events. Zero invoke() overhead per frame.
            let telemetry_app = app.handle().clone();

            if let Err(err) = std::thread::Builder::new()
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

            log::info!(
                "Dream DAW v{} — Audio engine initialized ({} IPC commands registered)",
                app.package_info().version,
                33
            );
            Ok(())
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|err| {
            log::error!("Fatal: failed to launch Dream DAW: {err}");
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

        let events = history.snapshot();
        assert_eq!(events.len(), MAX_PROJECT_HISTORY);
        assert_eq!(events.first().map(|e| e.seq), Some(6));
        assert_eq!(
            events.first().map(|e| e.detail.as_str()),
            Some("event-5")
        );
        assert_eq!(
            events.last().map(|e| e.detail.as_str()),
            Some("event-2052")
        );

        for pair in events.windows(2) {
            assert!(pair[0].seq < pair[1].seq);
        }
    }

    #[test]
    fn push_undo_records_history_event() {
        let state = ProjectState::new();
        push_undo(&state).expect("push_undo should snapshot default project");

        let history = state
            .history_snapshot()
            .expect("history snapshot should be readable");
        assert_eq!(history.len(), 1);
        let event = &history[0];
        assert_eq!(event.kind, "mutation_snapshot");
        assert!(event.detail.contains("captured undo snapshot"));
        assert!(event.detail.contains("apps/desktop_host/src/lib.rs"));
    }
}
