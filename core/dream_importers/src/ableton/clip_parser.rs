// ═══════════════════════════════════════════════════════════════════════
// Clip Parsing — Audio & MIDI clip extraction from ALS XML
// ═══════════════════════════════════════════════════════════════════════

use crate::ableton::xml_helpers::*;
use dream_models::project;

/// Maps Ableton warp mode integer to human-readable name.
///
/// Reference (Ableton Live source):
///   0 = Beats, 1 = Tones, 2 = Texture, 3 = Re-Pitch,
///   4 = Complex, 5 = Rex, 6 = Complex Pro
pub fn warp_mode_name(mode: i32) -> &'static str {
    match mode {
        0 => "Beats",
        1 => "Tones",
        2 => "Texture",
        3 => "Re-Pitch",
        4 => "Complex",
        5 => "Rex",
        6 => "Complex Pro",
        _ => "Unknown",
    }
}

pub fn parse_clip_scale_info(
    clip_node: roxmltree::Node<'_, '_>,
) -> (bool, Option<u8>, Option<String>) {
    let is_in_key = node_child_value(clip_node, "IsInKey")
        .as_deref()
        .and_then(parse_bool_value)
        .unwrap_or(false);
    let scale_info = clip_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("ScaleInformation"));
    let scale_root = scale_info
        .and_then(|n| first_child_value(n, "Root"))
        .as_deref()
        .and_then(parse_i64_value)
        .map(|v| v.rem_euclid(12) as u8);
    let scale_name = scale_info
        .and_then(|n| first_child_value(n, "Name"))
        .filter(|s| !s.trim().is_empty());
    (is_in_key, scale_root, scale_name)
}

/// Parsed follow action data.
pub struct FollowActionInfo {
    pub enabled: bool,
    pub time: f64,
    pub action_a: i32,
    pub action_b: i32,
    pub chance_a: f64,
    pub chance_b: f64,
    pub jump_index_a: i32,
    pub jump_index_b: i32,
    pub loop_iterations: i32,
    pub is_linked: bool,
}

pub fn parse_clip_follow_action(
    clip_node: roxmltree::Node<'_, '_>,
) -> FollowActionInfo {
    let follow = clip_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("FollowAction"));
    let Some(follow) = follow else {
        return FollowActionInfo {
            enabled: false,
            time: 0.0,
            action_a: 0,
            action_b: 0,
            chance_a: 0.0,
            chance_b: 0.0,
            jump_index_a: 1,
            jump_index_b: 1,
            loop_iterations: 1,
            is_linked: true,
        };
    };
    FollowActionInfo {
        enabled: first_child_bool(follow, "FollowActionEnabled").unwrap_or(false),
        time: first_child_f64(follow, "FollowTime").unwrap_or(0.0),
        action_a: first_child_i32(follow, "FollowActionA").unwrap_or(0),
        action_b: first_child_i32(follow, "FollowActionB").unwrap_or(0),
        chance_a: first_child_f64(follow, "FollowChanceA").unwrap_or(0.0),
        chance_b: first_child_f64(follow, "FollowChanceB").unwrap_or(0.0),
        jump_index_a: first_child_i32(follow, "JumpIndexA").unwrap_or(1),
        jump_index_b: first_child_i32(follow, "JumpIndexB").unwrap_or(1),
        loop_iterations: first_child_i32(follow, "LoopIterations").unwrap_or(1),
        is_linked: first_child_bool(follow, "IsLinked").unwrap_or(true),
    }
}

pub fn parse_clip_groove(clip_node: roxmltree::Node<'_, '_>) -> (Option<String>, f64) {
    let groove = clip_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("GrooveSettings"));
    let Some(groove) = groove else {
        return (None, 0.0);
    };
    let groove_id = first_child_value(groove, "GrooveId")
        .unwrap_or_default()
        .trim()
        .to_string();
    let groove_amount = first_child_f64(groove, "GrooveAmount")
        .map(|v| (v / 100.0).clamp(0.0, 1.0))
        .unwrap_or(0.0);
    let groove_name = if groove_id.is_empty() || groove_id == "-1" {
        None
    } else {
        Some(format!("Groove {groove_id}"))
    };
    (groove_name, groove_amount)
}

pub fn parse_clip_launch(clip_node: roxmltree::Node<'_, '_>) -> (i32, i32) {
    (
        node_child_value(clip_node, "LaunchMode")
            .as_deref()
            .and_then(parse_i64_value)
            .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32)
            .unwrap_or(0),
        node_child_value(clip_node, "LaunchQuantisation")
            .as_deref()
            .and_then(parse_i64_value)
            .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32)
            .unwrap_or(0),
    )
}

/// Parsed loop data from ALS clip.
pub struct LoopInfo {
    pub loop_start: Option<f64>,
    pub loop_end: Option<f64>,
    pub loop_on: bool,
    pub out_marker: Option<f64>,
    pub hidden_loop_start: Option<f64>,
    pub hidden_loop_end: Option<f64>,
}

pub fn parse_clip_loop(clip_node: roxmltree::Node<'_, '_>) -> LoopInfo {
    let loop_node = clip_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Loop"));
    let Some(loop_node) = loop_node else {
        return LoopInfo {
            loop_start: None,
            loop_end: None,
            loop_on: false,
            out_marker: None,
            hidden_loop_start: None,
            hidden_loop_end: None,
        };
    };
    LoopInfo {
        loop_start: first_child_f64(loop_node, "LoopStart"),
        loop_end: first_child_f64(loop_node, "LoopEnd"),
        loop_on: first_child_bool(loop_node, "LoopOn").unwrap_or(false),
        out_marker: first_child_f64(loop_node, "OutMarker"),
        hidden_loop_start: first_child_f64(loop_node, "HiddenLoopStart"),
        hidden_loop_end: first_child_f64(loop_node, "HiddenLoopEnd"),
    }
}

pub fn parse_local_clip_grid(clip_node: roxmltree::Node<'_, '_>, tag_name: &str) -> Option<project::ClipGrid> {
    let grid_node = clip_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name(tag_name))?;

    Some(project::ClipGrid {
        fixed_numerator: first_child_i32(grid_node, "FixedNumerator").unwrap_or(1),
        fixed_denominator: first_child_i32(grid_node, "FixedDenominator").unwrap_or(16),
        grid_interval_pixel: first_child_i32(grid_node, "GridIntervalPixel").unwrap_or(20),
        ntoles: first_child_i32(grid_node, "Ntoles").unwrap_or(0),
        snap_to_grid: first_child_bool(grid_node, "SnapToGrid").unwrap_or(true),
        fixed: first_child_bool(grid_node, "Fixed").unwrap_or(false),
    })
}

pub fn parse_audio_clip_warp(
    clip_node: roxmltree::Node<'_, '_>,
) -> (bool, Option<i32>, Vec<project::WarpMarkerPoint>) {
    let is_warped = node_child_value(clip_node, "IsWarped")
        .as_deref()
        .and_then(parse_bool_value)
        .unwrap_or(false);
    let warp_mode = node_child_value(clip_node, "WarpMode")
        .as_deref()
        .and_then(parse_i64_value)
        .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32);
    let mut markers = Vec::new();
    if let Some(warp_markers) = clip_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("WarpMarkers"))
    {
        for marker in warp_markers
            .children()
            .filter(|n| n.is_element() && n.has_tag_name("WarpMarker"))
        {
            let sec_time = marker
                .attribute("SecTime")
                .and_then(parse_f64_value)
                .unwrap_or(0.0);
            let beat_time = marker
                .attribute("BeatTime")
                .and_then(parse_f64_value)
                .unwrap_or(0.0);
            markers.push(project::WarpMarkerPoint {
                sec_time,
                beat_time,
            });
        }
    }
    if !markers.is_empty() {
        markers.sort_by(|a, b| {
            a.beat_time
                .partial_cmp(&b.beat_time)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    a.sec_time
                        .partial_cmp(&b.sec_time)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        });
        markers.dedup_by(|a, b| {
            (a.beat_time - b.beat_time).abs() < 1e-9
                && (a.sec_time - b.sec_time).abs() < 1e-9
        });
    }
    (is_warped, warp_mode, markers)
}

pub fn parse_audio_clip_warp_base_bpm(clip_node: roxmltree::Node<'_, '_>) -> Option<f64> {
    fn parse_bpm(v: &str) -> Option<f64> {
        // ENTERPRISE FIX: Raised from 320 to 500 to match
        // infer_warp_base_bpm_from_markers (DnB/halftime support).
        parse_f64_value(v).filter(|bpm| bpm.is_finite() && *bpm >= 20.0 && *bpm <= 500.0)
    }

    const DIRECT_TAGS: [&str; 5] = [
        "WarpBaseBpm",
        "OriginalTempo",
        "SourceTempo",
        "SourceBpm",
        "SegmentationBpm",
    ];
    for tag in DIRECT_TAGS {
        if let Some(v) = node_child_value(clip_node, tag)
            .as_deref()
            .and_then(parse_bpm)
        {
            return Some(v);
        }
    }

    const DESC_TAGS: [&str; 8] = [
        "WarpBaseBpm",
        "OriginalTempo",
        "SourceTempo",
        "SourceBpm",
        "SegmentationBpm",
        "Tempo",
        "NominalTempo",
        "Bpm",
    ];
    for node in clip_node.descendants().filter(|n| n.is_element()) {
        if !DESC_TAGS.iter().any(|tag| node.has_tag_name(*tag)) {
            continue;
        }
        if let Some(v) = node.attribute("Value").and_then(parse_bpm) {
            return Some(v);
        }
        if let Some(v) = node.text().and_then(parse_bpm) {
            return Some(v);
        }
    }

    None
}

pub fn parse_clip_time_signature(clip_node: roxmltree::Node<'_, '_>) -> (Option<u8>, Option<u8>) {
    let ts = clip_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("TimeSignature"));
    let numerator = ts
        .and_then(|n| {
            n.descendants()
                .find(|d| d.is_element() && d.has_tag_name("Numerator"))
        })
        .and_then(|n| n.attribute("Value"))
        .and_then(parse_i64_value)
        .map(|v| v.clamp(1, 32) as u8);
    let denominator = ts
        .and_then(|n| {
            n.descendants()
                .find(|d| d.is_element() && d.has_tag_name("Denominator"))
        })
        .and_then(|n| n.attribute("Value"))
        .and_then(parse_i64_value)
        .map(|v| v.clamp(1, 32) as u8);
    (numerator, denominator)
}

pub fn parse_clip_envelopes(
    clip_node: roxmltree::Node<'_, '_>,
    pointee_map: &std::collections::HashMap<String, String>,
) -> Vec<project::ClipEnvelope> {
    let mut envelopes_out = Vec::new();
    let envelopes_root = clip_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Envelopes"))
        .and_then(|e| {
            e.children()
                .find(|n| n.is_element() && n.has_tag_name("Envelopes"))
        });
    let Some(envelopes_root) = envelopes_root else {
        return envelopes_out;
    };
    for envelope in envelopes_root
        .children()
        .filter(|n| n.is_element() && n.has_tag_name("AutomationEnvelope"))
    {
        let pointee_id = envelope
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("PointeeId"))
            .and_then(|n| n.attribute("Value"))
            .and_then(parse_i64_value)
            .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32)
            .unwrap_or(0);
        if pointee_id == 0 {
            continue;
        }
        let mut points = Vec::new();
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
            let value = event
                .attribute("Value")
                .and_then(parse_f64_value)
                .unwrap_or(0.0);

            // ENTERPRISE FIX: Parse Bezier control points for smooth curves.
            // Ableton stores CurveControl1X/Y and CurveControl2X/Y on FloatEvent
            // nodes that have non-linear curves. Without this, all clip envelope
            // curves were flattened to linear — losing smooth filter sweeps, etc.
            let has_curve = event.attribute("CurveControl1X").is_some();
            let (curve_type, bezier_cp1x, bezier_cp1y, bezier_cp2x, bezier_cp2y, tension) =
                if has_curve {
                    let cp1x = event
                        .attribute("CurveControl1X")
                        .and_then(parse_f64_value)
                        .unwrap_or(0.0);
                    let cp1y = event
                        .attribute("CurveControl1Y")
                        .and_then(parse_f64_value)
                        .unwrap_or(0.5);
                    let cp2x = event
                        .attribute("CurveControl2X")
                        .and_then(parse_f64_value)
                        .unwrap_or(1.0);
                    let cp2y = event
                        .attribute("CurveControl2Y")
                        .and_then(parse_f64_value)
                        .unwrap_or(0.5);
                    let tension = (cp2y - cp1y).clamp(-1.0, 1.0);
                    (
                        "bezier".to_string(),
                        Some(cp1x),
                        Some(cp1y),
                        Some(cp2x),
                        Some(cp2y),
                        Some(tension),
                    )
                } else {
                    ("linear".to_string(), None, None, None, None, None)
                };

            points.push(project::AutomationPoint {
                beat,
                value,
                curve_type,
                tension,
                bezier_cp1x,
                bezier_cp1y,
                bezier_cp2x,
                bezier_cp2y,
            });
        }
        // ENTERPRISE FIX: BoolEvent + EnumEvent in clip envelopes.
        for event in envelope
            .descendants()
            .filter(|n| n.is_element() && n.has_tag_name("BoolEvent"))
        {
            let beat = event
                .attribute("Time")
                .and_then(parse_f64_value)
                .unwrap_or(0.0);
            if beat < -1_000_000.0 {
                continue;
            }
            let value = event
                .attribute("Value")
                .and_then(parse_bool_value)
                .map(|b| if b { 1.0 } else { 0.0 })
                .unwrap_or(0.0);
            points.push(project::AutomationPoint {
                beat,
                value,
                curve_type: "hold".to_string(),
                tension: None,
                bezier_cp1x: None,
                bezier_cp1y: None,
                bezier_cp2x: None,
                bezier_cp2y: None,
            });
        }
        for event in envelope
            .descendants()
            .filter(|n| n.is_element() && n.has_tag_name("EnumEvent"))
        {
            let beat = event
                .attribute("Time")
                .and_then(parse_f64_value)
                .unwrap_or(0.0);
            if beat < -1_000_000.0 {
                continue;
            }
            let value = event
                .attribute("Value")
                .and_then(parse_i64_value)
                .map(|v| v as f64)
                .unwrap_or(0.0);
            points.push(project::AutomationPoint {
                beat,
                value,
                curve_type: "hold".to_string(),
                tension: None,
                bezier_cp1x: None,
                bezier_cp1y: None,
                bezier_cp2x: None,
                bezier_cp2y: None,
            });
        }
        if points.is_empty() {
            continue;
        }
        points.sort_by(|a, b| a.beat.total_cmp(&b.beat));
        let param_id = pointee_map
            .get(&pointee_id.to_string())
            .cloned()
            .unwrap_or_else(|| format!("clip:{pointee_id}"));
        envelopes_out.push(project::ClipEnvelope {
            pointee_id,
            param_id,
            points,
        });
    }
    envelopes_out
}

pub fn parse_clip_grid(clip_node: roxmltree::Node<'_, '_>) -> Option<(u16, u16, u8, bool, bool)> {
    let grid = if clip_node.has_tag_name("Grid") {
        clip_node
    } else {
        clip_node
            .children()
            .find(|n| n.is_element() && n.has_tag_name("Grid"))?
    };
    let numerator = first_child_value(grid, "FixedNumerator")
        .as_deref()
        .and_then(parse_i64_value)
        .map(|v| v.clamp(1, u16::MAX as i64) as u16)
        .unwrap_or(1);
    let denominator = first_child_value(grid, "FixedDenominator")
        .as_deref()
        .and_then(parse_i64_value)
        .map(|v| v.clamp(1, u16::MAX as i64) as u16)
        .unwrap_or(16);
    let ntoles = first_child_value(grid, "Ntoles")
        .as_deref()
        .and_then(parse_i64_value)
        .map(|v| v.clamp(1, u8::MAX as i64) as u8)
        .unwrap_or(2);
    let snap = first_child_bool(grid, "SnapToGrid").unwrap_or(true);
    let fixed = first_child_bool(grid, "Fixed").unwrap_or(false);
    Some((numerator, denominator, ntoles, snap, fixed))
}

pub fn semitone_to_tonic(root: u8) -> &'static str {
    match root % 12 {
        0 => "C",
        1 => "C#",
        2 => "D",
        3 => "D#",
        4 => "E",
        5 => "F",
        6 => "F#",
        7 => "G",
        8 => "G#",
        9 => "A",
        10 => "A#",
        _ => "B",
    }
}

pub fn parse_root_midi_editor_lanes(
    live_set: roxmltree::Node<'_, '_>,
    root_tag: &str,
) -> Vec<project::MidiEditorLaneState> {
    let Some(root) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name(root_tag))
    else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for lane in root
        .children()
        .filter(|n| n.is_element() && n.has_tag_name("MidiEditorLaneModel"))
    {
        let id = lane
            .attribute("Id")
            .and_then(parse_i64_value)
            .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32)
            .unwrap_or(0);
        let lane_type = first_child_i32(lane, "Type").unwrap_or(0);
        let size = first_child_f64(lane, "Size").unwrap_or(0.0);
        let is_minimized = first_child_bool(lane, "IsMinimized").unwrap_or(false);
        out.push(project::MidiEditorLaneState {
            id,
            lane_type,
            size,
            is_minimized,
        });
    }
    out.sort_by_key(|lane| lane.id);
    out
}
