// ═══════════════════════════════════════════════════════════════════════
// ALS Parser — foundational helpers for top-level Ableton import
// ═══════════════════════════════════════════════════════════════════════
//
// This module holds non-UI, non-Tauri orchestration helpers used by the
// desktop host ALS importer:
// - read/decompress ALS payload
// - parse XML document and resolve <LiveSet>
// - parse top-level tempo/sample-rate/project-name defaults
//
// Full end-to-end project import orchestration is still migrated in phases.
// ═══════════════════════════════════════════════════════════════════════

use std::io::Read;
use std::path::Path;

use crate::ableton::clip_parser::{parse_clip_grid, parse_clip_scale_info, semitone_to_tonic};
use crate::ableton::xml_helpers::parse_f64_value;
use crate::ableton::xml_helpers::{
    beats_to_frames, first_child_bool, first_child_f64, first_child_i32, first_child_value,
    node_child_value, parse_i64_value, parse_live_set_bool, parse_live_set_i32,
    parse_root_midi_editor_lanes, parse_view_states_bool,
};
use dream_models::project::{Project, TempoAutomationEvent, TimeSignature, TimeSignatureChange};

pub fn read_als_xml_text(file_path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(file_path)
        .map_err(|e| format!("Failed to read ALS file '{}': {e}", file_path.display()))?;
    let xml_bytes = {
        let mut decoder = flate2::read::GzDecoder::new(&bytes[..]);
        let mut inflated = Vec::new();
        match decoder.read_to_end(&mut inflated) {
            Ok(_) if !inflated.is_empty() => inflated,
            _ => bytes,
        }
    };
    String::from_utf8(xml_bytes).map_err(|e| format!("ALS is not valid UTF-8 XML: {e}"))
}

pub fn parse_als_document<'a>(xml_text: &'a str) -> Result<roxmltree::Document<'a>, String> {
    roxmltree::Document::parse(xml_text).map_err(|e| format!("Failed to parse ALS XML: {e}"))
}

pub fn find_live_set<'a>(
    doc: &'a roxmltree::Document<'a>,
) -> Result<roxmltree::Node<'a, 'a>, String> {
    doc.descendants()
        .find(|n| n.is_element() && n.has_tag_name("LiveSet"))
        .ok_or_else(|| "ALS parse error: <LiveSet> node not found".to_string())
}

pub fn parse_project_name(file_path: &Path) -> String {
    file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("Imported Ableton Project")
        .to_string()
}

pub fn parse_main_tempo(live_set: roxmltree::Node<'_, '_>) -> f64 {
    live_set
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("MainTrack"))
        .and_then(|main_track| {
            main_track
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("Tempo"))
        })
        .and_then(|tempo_node| {
            tempo_node
                .children()
                .find(|n| n.is_element() && n.has_tag_name("Manual"))
                .and_then(|manual| manual.attribute("Value"))
                .and_then(parse_f64_value)
        })
        .unwrap_or(120.0)
}

pub fn parse_imported_sample_rate(live_set: roxmltree::Node<'_, '_>) -> f64 {
    live_set
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("OverrideSampleRate"))
        .and_then(|n| {
            n.children()
                .find(|c| c.is_element() && c.has_tag_name("Manual"))
        })
        .and_then(|n| n.attribute("Value"))
        .and_then(parse_f64_value)
        .filter(|v| *v > 0.0)
        .or_else(|| {
            live_set
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("SampleRate"))
                .and_then(|n| {
                    n.children()
                        .find(|c| c.is_element() && c.has_tag_name("Manual"))
                })
                .and_then(|n| n.attribute("Value"))
                .and_then(parse_f64_value)
                .filter(|v| *v > 0.0)
        })
        .unwrap_or(44100.0)
}

pub fn resolve_timeline_sample_rate(
    imported_sample_rate: f64,
    target_sample_rate: Option<f64>,
) -> f64 {
    target_sample_rate
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(imported_sample_rate)
}

pub fn apply_live_set_editor_view_metadata(
    project: &mut Project,
    live_set: roxmltree::Node<'_, '_>,
) {
    if let Some(session_scroll) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("SessionScrollPos"))
    {
        if let Some(v) = session_scroll.attribute("X").and_then(parse_i64_value) {
            project.session_scroll_x = v.clamp(i32::MIN as i64, i32::MAX as i64) as i32;
        }
        if let Some(v) = session_scroll.attribute("Y").and_then(parse_i64_value) {
            project.session_scroll_y = v.clamp(i32::MIN as i64, i32::MAX as i64) as i32;
        }
    }
    if let Some(v) = first_child_f64(live_set, "SelectedBreakpointValue").filter(|v| v.is_finite())
    {
        project.selected_breakpoint_value = v;
    }
    if let Some(time_selection) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("TimeSelection"))
    {
        if let Some(v) =
            first_child_f64(time_selection, "AnchorTime").filter(|v| v.is_finite() && *v >= 0.0)
        {
            project.time_selection_anchor_beats = Some(v);
        }
        if let Some(v) =
            first_child_f64(time_selection, "OtherTime").filter(|v| v.is_finite() && *v >= 0.0)
        {
            project.time_selection_other_beats = Some(v);
        }
    }
    if let Some(sequencer_navigator) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("SequencerNavigator"))
    {
        if let Some(v) = sequencer_navigator
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("CurrentZoom"))
            .and_then(|n| n.attribute("Value"))
            .and_then(parse_f64_value)
            .filter(|v| v.is_finite() && *v > 0.0)
        {
            project.sequencer_navigator_zoom = Some(v);
            project.view_zoom_scale = Some(v);
        }
        if let Some(scroller_pos) = sequencer_navigator
            .children()
            .find(|n| n.is_element() && n.has_tag_name("ScrollerPos"))
        {
            if let Some(v) = scroller_pos.attribute("X").and_then(parse_i64_value) {
                let x = v.clamp(i32::MIN as i64, i32::MAX as i64) as i32;
                project.sequencer_navigator_scroll_x = Some(x);
                project.view_scroll_position = Some(x as f64);
            }
            if let Some(v) = scroller_pos.attribute("Y").and_then(parse_i64_value) {
                project.sequencer_navigator_scroll_y =
                    Some(v.clamp(i32::MIN as i64, i32::MAX as i64) as i32);
            }
        }
        if let Some(client_size) = sequencer_navigator
            .children()
            .find(|n| n.is_element() && n.has_tag_name("ClientSize"))
        {
            if let Some(v) = client_size.attribute("X").and_then(parse_i64_value) {
                project.sequencer_navigator_client_width =
                    Some(v.clamp(i32::MIN as i64, i32::MAX as i64) as i32);
            }
            if let Some(v) = client_size.attribute("Y").and_then(parse_i64_value) {
                project.sequencer_navigator_client_height =
                    Some(v.clamp(i32::MIN as i64, i32::MAX as i64) as i32);
            }
        }
    }
    if let Some(v) = parse_live_set_bool(live_set, "IsContentSplitterOpen") {
        project.is_content_splitter_open = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "IsExpressionSplitterOpen") {
        project.is_expression_splitter_open = v;
    }
    project.expression_lanes = parse_root_midi_editor_lanes(live_set, "ExpressionLanes");
    project.content_lanes = parse_root_midi_editor_lanes(live_set, "ContentLanes");
    project.view_data_json = first_child_value(live_set, "ViewData");
    if let Some(v) = first_child_value(live_set, "Annotation") {
        project.annotation = v;
    }
    if let Some(v) = parse_live_set_i32(live_set, "SmpteFormat") {
        project.smpte_format = v;
    }
}

pub fn apply_live_set_timeline_and_signature_metadata(
    project: &mut Project,
    live_set: roxmltree::Node<'_, '_>,
    tempo: f64,
    sample_rate: f64,
) {
    if let Some(main_track) = live_set
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("MainTrack"))
        && let Some(global_groove_amount) = main_track
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("GlobalGrooveAmount"))
            .and_then(|n| {
                n.children()
                    .find(|c| c.is_element() && c.has_tag_name("Manual"))
                    .and_then(|m| m.attribute("Value"))
                    .and_then(parse_f64_value)
            })
            .filter(|v| v.is_finite())
    {
        project.global_groove_amount = global_groove_amount;
    }

    if let Some(transport) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Transport"))
    {
        if let Some(v) = first_child_f64(transport, "PhaseNudgeTempo").filter(|v| v.is_finite()) {
            project.transport_phase_nudge_tempo = v;
        }
        if let Some(current_time_beats) =
            first_child_f64(transport, "CurrentTime").filter(|v| v.is_finite() && *v >= 0.0)
        {
            project.playhead_position_frames =
                beats_to_frames(current_time_beats, tempo, sample_rate);
        }
        let loop_on = first_child_bool(transport, "LoopOn").unwrap_or(false);
        let loop_start_beats = first_child_f64(transport, "LoopStart")
            .unwrap_or(0.0)
            .max(0.0);
        let loop_length_beats = first_child_f64(transport, "LoopLength")
            .unwrap_or(0.0)
            .max(0.0);
        project.is_looping = loop_on;
        project.loop_start_frames = Some(beats_to_frames(loop_start_beats, tempo, sample_rate));
        project.loop_end_frames = Some(beats_to_frames(
            loop_start_beats + loop_length_beats,
            tempo,
            sample_rate,
        ));
        if let Some(v) = first_child_bool(transport, "PunchIn") {
            project.punch_in_enabled = v;
        }
        if let Some(v) = first_child_bool(transport, "PunchOut") {
            project.punch_out_enabled = v;
        }
        if let Some(v) =
            first_child_f64(transport, "MetronomeTickDuration").filter(|v| v.is_finite())
        {
            project.metronome_tick_duration = v;
        }
        if let Some(v) = first_child_bool(transport, "LoopIsSongStart") {
            project.transport_loop_is_song_start = v;
        }
        if let Some(v) = first_child_bool(transport, "DrawMode") {
            project.transport_draw_mode = v;
        }
    }

    if let Some((num, den, ntoles, snap, fixed)) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Grid"))
        .and_then(parse_clip_grid)
        .or_else(|| {
            live_set
                .descendants()
                .filter(|n| {
                    n.is_element() && (n.has_tag_name("AudioClip") || n.has_tag_name("MidiClip"))
                })
                .find_map(parse_clip_grid)
        })
    {
        project.arrangement_grid_numerator = num;
        project.arrangement_grid_denominator = den;
        project.arrangement_grid_ntoles = ntoles;
        project.arrangement_snap_to_grid = snap;
        project.arrangement_grid_fixed = fixed;
    }

    if let Some(root_scale) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("ScaleInformation"))
    {
        let is_in_key = first_child_bool(live_set, "InKey").unwrap_or(false);
        let scale_root = first_child_value(root_scale, "Root")
            .as_deref()
            .and_then(parse_i64_value)
            .map(|v| v.rem_euclid(12) as u8);
        let scale_name = first_child_value(root_scale, "Name");
        if is_in_key || scale_root.is_some() {
            project.key_sig_enabled = true;
        }
        if let Some(root) = scale_root {
            project.key_sig_tonic = semitone_to_tonic(root).to_string();
        }
        if let Some(name) = scale_name {
            project.key_sig_mode = if name.chars().all(|c| c.is_ascii_digit()) {
                format!("Scale {name}")
            } else {
                name
            };
        }
    } else if let Some(first_clip_with_scale) = live_set
        .descendants()
        .filter(|n| n.is_element() && (n.has_tag_name("AudioClip") || n.has_tag_name("MidiClip")))
        .find(|clip| {
            clip.children()
                .any(|c| c.is_element() && c.has_tag_name("ScaleInformation"))
                || node_child_value(*clip, "IsInKey").is_some()
        })
    {
        let (is_in_key, scale_root, scale_name) = parse_clip_scale_info(first_clip_with_scale);
        if is_in_key || scale_root.is_some() {
            project.key_sig_enabled = true;
        }
        if let Some(root) = scale_root {
            project.key_sig_tonic = semitone_to_tonic(root).to_string();
        }
        if let Some(name) = scale_name {
            project.key_sig_mode = if name.chars().all(|c| c.is_ascii_digit()) {
                format!("Scale {name}")
            } else {
                name
            };
        }
    }

    if let Some(main_track) = live_set
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("MainTrack"))
    {
        if let Some(ts_node) = main_track
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("TimeSignature"))
        {
            let numerator = ts_node
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("Numerator"))
                .and_then(|n| n.attribute("Value"))
                .and_then(parse_i64_value)
                .map(|v| v.clamp(1, 32) as u8)
                .unwrap_or(4);
            let denominator = ts_node
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("Denominator"))
                .and_then(|n| n.attribute("Value"))
                .and_then(parse_i64_value)
                .map(|v| v.clamp(1, 32) as u8)
                .unwrap_or(4);
            project.time_signature = TimeSignature::new(numerator, denominator);
        }

        if let Some(tempo_node) = main_track
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Tempo"))
        {
            let tempo_pointee_id = tempo_node
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("AutomationTarget"))
                .and_then(|at| at.attribute("Id"))
                .unwrap_or_default()
                .to_string();

            if !tempo_pointee_id.is_empty()
                && let Some(env_container) = main_track
                    .children()
                    .find(|n| n.is_element() && n.has_tag_name("AutomationEnvelopes"))
                    .and_then(|ae| {
                        ae.children()
                            .find(|n| n.is_element() && n.has_tag_name("Envelopes"))
                    })
            {
                for envelope in env_container
                    .children()
                    .filter(|n| n.is_element() && n.has_tag_name("AutomationEnvelope"))
                {
                    let pid = envelope
                        .descendants()
                        .find(|n| n.is_element() && n.has_tag_name("PointeeId"))
                        .and_then(|n| n.attribute("Value"))
                        .unwrap_or_default();
                    if pid != tempo_pointee_id {
                        continue;
                    }

                    let mut events = Vec::new();
                    for event in envelope
                        .descendants()
                        .filter(|n| n.is_element() && n.has_tag_name("FloatEvent"))
                    {
                        let beat = event
                            .attribute("Time")
                            .and_then(parse_f64_value)
                            .unwrap_or(0.0);
                        if beat < -1_000_000.0 {
                            continue;
                        }
                        let bpm = event
                            .attribute("Value")
                            .and_then(parse_f64_value)
                            .unwrap_or(tempo);
                        let curve_type = if event.attribute("CurveControl1X").is_some() {
                            "bezier".to_string()
                        } else {
                            "linear".to_string()
                        };
                        events.push(TempoAutomationEvent {
                            beat,
                            bpm: bpm.clamp(20.0, 999.0),
                            curve_type,
                        });
                    }
                    if !events.is_empty() {
                        events.sort_by(|a, b| {
                            a.beat
                                .partial_cmp(&b.beat)
                                .unwrap_or(std::cmp::Ordering::Equal)
                        });
                        project.tempo_automation_events = events;
                    }
                    break;
                }
            }
        }

        if let Some(ts_node) = main_track
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("TimeSignature"))
        {
            let num_pointee = ts_node
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("Numerator"))
                .and_then(|n| {
                    n.descendants()
                        .find(|c| c.is_element() && c.has_tag_name("AutomationTarget"))
                })
                .and_then(|at| at.attribute("Id"))
                .unwrap_or_default()
                .to_string();

            let den_pointee = ts_node
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("Denominator"))
                .and_then(|n| {
                    n.descendants()
                        .find(|c| c.is_element() && c.has_tag_name("AutomationTarget"))
                })
                .and_then(|at| at.attribute("Id"))
                .unwrap_or_default()
                .to_string();

            if !num_pointee.is_empty()
                && let Some(env_container) = main_track
                    .children()
                    .find(|n| n.is_element() && n.has_tag_name("AutomationEnvelopes"))
                    .and_then(|ae| {
                        ae.children()
                            .find(|n| n.is_element() && n.has_tag_name("Envelopes"))
                    })
            {
                let mut num_events: Vec<(f64, u8)> = Vec::new();
                let mut den_events: Vec<(f64, u8)> = Vec::new();

                for envelope in env_container
                    .children()
                    .filter(|n| n.is_element() && n.has_tag_name("AutomationEnvelope"))
                {
                    let pid = envelope
                        .descendants()
                        .find(|n| n.is_element() && n.has_tag_name("PointeeId"))
                        .and_then(|n| n.attribute("Value"))
                        .unwrap_or_default();

                    let is_num = pid == num_pointee;
                    let is_den = !den_pointee.is_empty() && pid == den_pointee;
                    if !is_num && !is_den {
                        continue;
                    }

                    for event in envelope
                        .descendants()
                        .filter(|n| n.is_element() && n.has_tag_name("FloatEvent"))
                    {
                        let beat = event
                            .attribute("Time")
                            .and_then(parse_f64_value)
                            .unwrap_or(0.0);
                        if beat < -1_000_000.0 {
                            continue;
                        }
                        let val = event
                            .attribute("Value")
                            .and_then(parse_f64_value)
                            .unwrap_or(4.0);
                        let clamped = val.round().clamp(1.0, 32.0) as u8;
                        if is_num {
                            num_events.push((beat, clamped));
                        } else {
                            den_events.push((beat, clamped));
                        }
                    }
                }

                if !num_events.is_empty() {
                    num_events
                        .sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
                    den_events
                        .sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

                    let default_den = project.time_signature.denominator;
                    let mut ts_changes = Vec::new();
                    for (beat, num) in &num_events {
                        let den = den_events
                            .iter()
                            .rev()
                            .find(|(b, _)| *b <= *beat)
                            .map(|(_, d)| *d)
                            .unwrap_or(default_den);
                        ts_changes.push(TimeSignatureChange {
                            beat: *beat,
                            numerator: *num,
                            denominator: den,
                        });
                    }
                    if !ts_changes.is_empty() {
                        project.time_signature_changes = ts_changes;
                    }
                }
            }
        }
    }
}

pub fn apply_live_set_project_metadata(project: &mut Project, live_set: roxmltree::Node<'_, '_>) {
    if let Some(v) = parse_live_set_bool(live_set, "AutomationMode") {
        project.automation_mode_enabled = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "SnapAutomationToGrid") {
        project.snap_automation_to_grid = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "ArrangementOverdub") {
        project.arrangement_overdub = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "SoloInPlace") {
        project.solo_in_place = v;
    }
    if let Some(v) = parse_live_set_i32(live_set, "CrossfadeCurve") {
        project.crossfade_curve = v;
    }
    if let Some(v) = parse_live_set_i32(live_set, "LatencyCompensation") {
        project.latency_compensation_mode = v;
    }
    if let Some(v) = parse_live_set_i32(live_set, "GlobalQuantisation") {
        project.global_quantisation = v;
    }
    if let Some(v) = parse_live_set_i32(live_set, "AutoQuantisation") {
        project.auto_quantisation = v;
    }

    apply_live_set_editor_view_metadata(project, live_set);

    if let Some(v) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("AutoColorPickerForPlayerAndGroupTracks"))
        .and_then(|n| first_child_i32(n, "NextColorIndex"))
    {
        project.auto_color_picker_player_group_next_color_index = v;
    }
    if let Some(v) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("AutoColorPickerForReturnAndMainTracks"))
        .and_then(|n| first_child_i32(n, "NextColorIndex"))
    {
        project.auto_color_picker_return_main_next_color_index = v;
    }
    if let Some(v) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("GroovePool"))
        .and_then(|n| first_child_i32(n, "DefaultGrooveId"))
    {
        project.groove_pool_default_groove_id = Some(v);
    }
    if let Some(groove_pool) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("GroovePool"))
    {
        let count = groove_pool
            .descendants()
            .filter(|n| n.is_element() && n.has_tag_name("Groove"))
            .count();
        project.groove_pool_groove_count = count.clamp(0, i32::MAX as usize) as i32;
    }
    if let Some(linked_groups) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("LinkedTrackGroups"))
    {
        let count = linked_groups.children().filter(|n| n.is_element()).count();
        project.linked_track_group_count = count.clamp(0, i32::MAX as usize) as i32;
    }
    if let Some(tuning_systems) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("TuningSystems"))
    {
        let count = tuning_systems.children().filter(|n| n.is_element()).count();
        project.tuning_system_count = count.clamp(0, i32::MAX as usize) as i32;
    }
    if let Some(note_algorithms) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("NoteAlgorithms"))
    {
        let count = note_algorithms
            .children()
            .filter(|n| n.is_element())
            .count();
        project.note_algorithm_count = count.clamp(0, i32::MAX as usize) as i32;
    }
    if let Some(video_rect) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("VideoWindowRect"))
    {
        project.video_window_rect_top = video_rect
            .attribute("Top")
            .and_then(parse_i64_value)
            .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32);
        project.video_window_rect_left = video_rect
            .attribute("Left")
            .and_then(parse_i64_value)
            .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32);
        project.video_window_rect_bottom = video_rect
            .attribute("Bottom")
            .and_then(parse_i64_value)
            .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32);
        project.video_window_rect_right = video_rect
            .attribute("Right")
            .and_then(parse_i64_value)
            .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32);
    }
    if let Some(v) = parse_live_set_i32(live_set, "SelectedDocumentViewInMainWindow") {
        project.selected_document_view = v;
    }
    if let Some(v) = parse_live_set_i32(live_set, "ViewStateFxSlotCount") {
        project.view_state_fx_slot_count = v;
    }
    if let Some(v) = first_child_value(live_set, "ViewStateSessionMixerVolumeSectionHeight")
        .as_deref()
        .and_then(parse_f64_value)
        .filter(|v| v.is_finite())
    {
        project.view_state_session_mixer_volume_section_height = v;
    }
    if let Some(v) = first_child_value(live_set, "ViewStateArrangerMixerVolumeSectionHeight")
        .as_deref()
        .and_then(parse_f64_value)
        .filter(|v| v.is_finite())
    {
        project.view_state_arranger_mixer_volume_section_height = v;
    }
    if let Some(v) = first_child_value(live_set, "ViewStateSessionTrackWidth")
        .as_deref()
        .and_then(parse_f64_value)
        .filter(|v| v.is_finite())
    {
        project.view_state_session_track_width = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "ViewStateMainWindowClipDetailOpen") {
        project.view_state_main_window_clip_detail_open = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "ViewStateMainWindowDeviceDetailOpen") {
        project.view_state_main_window_device_detail_open = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "ViewStateSecondWindowClipDetailOpen") {
        project.view_state_second_window_clip_detail_open = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "ViewStateSecondWindowDeviceDetailOpen") {
        project.view_state_second_window_device_detail_open = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "ShouldSceneTempoAndTimeSignatureBeVisible") {
        project.should_scene_tempo_time_signature_be_visible = v;
    }
    if let Some(v) = first_child_value(live_set, "WaveformVerticalZoomFactor")
        .as_deref()
        .and_then(parse_f64_value)
        .filter(|v| v.is_finite())
    {
        project.waveform_vertical_zoom_factor = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "IsWaveformVerticalZoomActive") {
        project.is_waveform_vertical_zoom_active = v;
    }
    if let Some(v) = parse_live_set_i32(live_set, "HighlightedTrackIndex") {
        project.highlighted_track_index = v;
    }
    if let Some(v) = first_child_value(live_set, "TrackHeaderWidth")
        .as_deref()
        .and_then(parse_f64_value)
        .filter(|v| v.is_finite())
    {
        project.track_header_width = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "ResetNonautomatedMidiControllersOnClipStarts") {
        project.reset_nonautomated_midi_controllers_on_clip_starts = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "MidiFoldIn") {
        project.midi_fold_in = v;
    }
    if let Some(v) = parse_live_set_i32(live_set, "MidiFoldMode") {
        project.midi_fold_mode = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "MultiClipFocusMode") {
        project.multi_clip_focus_mode = v;
    }
    if let Some(v) = first_child_value(live_set, "MultiClipLoopBarHeight")
        .as_deref()
        .and_then(parse_f64_value)
        .filter(|v| v.is_finite())
    {
        project.multi_clip_loop_bar_height = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "MidiPrelisten") {
        project.midi_prelisten = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "UseWarperLegacyHiQMode") {
        project.use_warper_legacy_hiq_mode = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "ShowVideoWindow") {
        project.show_video_window = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "SoloOrPflSavedValue") {
        project.solo_or_pfl_saved_value = v;
    }
    if let Some(v) = parse_live_set_i32(live_set, "ColorSequenceIndex") {
        project.color_sequence_index = v;
    }
    if let Some(v) = parse_live_set_i32(live_set, "NoteSpellingPreference") {
        project.note_spelling_preference = v;
    }
    if let Some(v) = parse_live_set_i32(live_set, "AccidentalSpellingPreference") {
        project.accidental_spelling_preference = v;
    }
    if let Some(v) = parse_live_set_bool(live_set, "PreferFlatRootNote") {
        project.prefer_flat_root_note = v;
    }
    if let Some(v) = parse_live_set_bool(
        live_set,
        "ViewStateMainWindowHiddenOtherDocViewTypeClipDetailOpen",
    ) {
        project.view_state_main_window_hidden_other_doc_view_type_clip_detail_open = v;
    }
    if let Some(v) = parse_live_set_bool(
        live_set,
        "ViewStateMainWindowHiddenOtherDocViewTypeDeviceDetailOpen",
    ) {
        project.view_state_main_window_hidden_other_doc_view_type_device_detail_open = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "MixerInArrangement") {
        project.view_mixer_in_arrangement = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "ArrangerMixerIO") {
        project.view_arranger_mixer_io = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "ArrangerMixerSends") {
        project.view_arranger_mixer_sends = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "ArrangerMixerReturns") {
        project.view_arranger_mixer_returns = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "ArrangerMixerVolume") {
        project.view_arranger_mixer_volume = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "ArrangerMixerTrackOptions") {
        project.view_arranger_mixer_track_options = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "ArrangerMixerCrossFade") {
        project.view_arranger_mixer_crossfade = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "ArrangerMixerTrackPerformanceImpactMeter") {
        project.view_arranger_mixer_track_performance_impact_meter = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "MixerInSession") {
        project.view_mixer_in_session = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "SessionIO") {
        project.view_session_io = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "SessionSends") {
        project.view_session_sends = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "SessionReturns") {
        project.view_session_returns = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "SessionVolume") {
        project.view_session_volume = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "SessionTrackOptions") {
        project.view_session_track_options = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "SessionCrossFade") {
        project.view_session_crossfade = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "SessionTrackPerformanceImpactMeter") {
        project.view_session_track_performance_impact_meter = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "SessionShowOverView") {
        project.view_session_show_overview = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "ArrangerIO") {
        project.view_arranger_io = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "ArrangerReturns") {
        project.view_arranger_returns = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "ArrangerVolume") {
        project.view_arranger_volume = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "ArrangerTrackOptions") {
        project.view_arranger_track_options = v;
    }
    if let Some(v) = parse_view_states_bool(live_set, "ArrangerShowOverView") {
        project.view_arranger_show_overview = v;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn parse_project_name_uses_file_stem() {
        let p = Path::new("/tmp/My Cool Project.als");
        assert_eq!(parse_project_name(p), "My Cool Project");
    }

    #[test]
    fn parse_main_tempo_reads_manual_value() {
        let xml = r#"
        <Ableton>
          <LiveSet>
            <MainTrack>
              <Tempo>
                <Manual Value="174.0" />
              </Tempo>
            </MainTrack>
          </LiveSet>
        </Ableton>
        "#;
        let doc = parse_als_document(xml).expect("doc");
        let live_set = find_live_set(&doc).expect("live set");
        assert!((parse_main_tempo(live_set) - 174.0).abs() < 1e-9);
    }

    #[test]
    fn parse_imported_sample_rate_prefers_override() {
        let xml = r#"
        <Ableton>
          <LiveSet>
            <SampleRate><Manual Value="44100"/></SampleRate>
            <OverrideSampleRate><Manual Value="48000"/></OverrideSampleRate>
          </LiveSet>
        </Ableton>
        "#;
        let doc = parse_als_document(xml).expect("doc");
        let live_set = find_live_set(&doc).expect("live set");
        assert!((parse_imported_sample_rate(live_set) - 48000.0).abs() < 1e-9);
    }

    #[test]
    fn resolve_timeline_sample_rate_prefers_valid_target() {
        assert_eq!(
            resolve_timeline_sample_rate(44100.0, Some(48000.0)),
            48000.0
        );
        assert_eq!(resolve_timeline_sample_rate(44100.0, Some(0.0)), 44100.0);
        assert_eq!(resolve_timeline_sample_rate(44100.0, None), 44100.0);
    }
}
