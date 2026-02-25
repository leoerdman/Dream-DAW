// ═══════════════════════════════════════════════════════════════════════
// Structural-sharing undo/redo snapshots for the project model.
//
// Extracted from lib.rs — zero Tauri dependency. Only depends on
// dream_models and std.
// ═══════════════════════════════════════════════════════════════════════

use std::collections::VecDeque;
use std::sync::Arc;

use serde::Serialize;
use uuid::Uuid;

use dream_models::midi::{MidiClip, SampleRackConfig, SamplerConfig};
use dream_models::project::{
    AudioClip, DeviceNode, Project, TimeSignature, Track, TrackColor, TrackType,
};

// ── Track Snapshot ──────────────────────────────────────────────────────

#[derive(Clone)]
pub(crate) struct SharedTrackSnapshot {
    id: Uuid,
    name: String,
    track_type: TrackType,
    clips: Vec<Arc<AudioClip>>,
    volume: f64,
    pan: f64,
    is_solo: bool,
    is_disabled: bool,
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
    pub(crate) fn from_track(track: &Track, prev: Option<&SharedTrackSnapshot>) -> Self {
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
            is_disabled: track.is_disabled,
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

    pub(crate) fn equals_track(&self, track: &Track) -> bool {
        self.id == track.id
            && self.name == track.name
            && self.track_type == track.track_type
            && self.volume == track.volume
            && self.pan == track.pan
            && self.is_solo == track.is_solo
            && self.is_disabled == track.is_disabled
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

    pub(crate) fn to_track(&self) -> Track {
        Track {
            id: self.id,
            name: self.name.clone(),
            track_type: self.track_type,
            clips: self.clips.iter().map(|c| (**c).clone()).collect(),
            volume: self.volume,
            pan: self.pan,
            is_solo: self.is_solo,
            is_disabled: self.is_disabled,
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

// ── Project Snapshot ────────────────────────────────────────────────────

#[derive(Clone)]
pub(crate) struct SharedProjectSnapshot {
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
    pub(crate) fn from_project(project: &Project, prev: Option<&SharedProjectSnapshot>) -> Self {
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

    pub(crate) fn to_project(&self) -> Project {
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

// ── Undo/Redo ───────────────────────────────────────────────────────────

/// Maximum redo stack depth — prevents unbounded memory growth. (BUG-024 FIX)
pub(crate) const MAX_REDO_DEPTH: usize = 50;

/// Undo/Redo history backed by structural-sharing snapshots.
///
/// Uses `VecDeque` for O(1) front eviction when the undo depth
/// exceeds `MAX_UNDO_DEPTH`. `Vec::remove(0)` was previously used
/// here, which is O(n) due to element shifting — unacceptable for
/// a hot path that fires on every user mutation.
pub(crate) struct UndoState {
    pub(crate) undo_stack: VecDeque<SharedProjectSnapshot>,
    pub(crate) redo_stack: VecDeque<SharedProjectSnapshot>,
}

impl UndoState {
    pub(crate) fn new() -> Self {
        Self {
            undo_stack: VecDeque::new(),
            redo_stack: VecDeque::new(),
        }
    }
}

/// Maximum number of undo snapshots to retain.
pub(crate) const MAX_UNDO_DEPTH: usize = 100;
pub(crate) const MAX_PROJECT_HISTORY: usize = 2048;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectHistoryEvent {
    pub(crate) seq: u64,
    pub(crate) kind: String,
    pub(crate) detail: String,
    pub(crate) timestamp_ms: u128,
}

pub(crate) struct ProjectHistory {
    pub(crate) next_seq: u64,
    pub(crate) events: VecDeque<ProjectHistoryEvent>,
}

impl ProjectHistory {
    pub(crate) fn new() -> Self {
        Self {
            next_seq: 1,
            events: VecDeque::new(),
        }
    }

    pub(crate) fn push(&mut self, kind: impl Into<String>, detail: impl Into<String>) {
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

    pub(crate) fn snapshot(
        &self,
        limit: Option<usize>,
        since_seq: Option<u64>,
    ) -> Vec<ProjectHistoryEvent> {
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
