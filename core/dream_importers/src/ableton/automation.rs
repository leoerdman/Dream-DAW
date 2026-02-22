// ═══════════════════════════════════════════════════════════════════════
// Track Automation — Envelope import from ALS XML
// ═══════════════════════════════════════════════════════════════════════
//
// Handles PointeeId → param_id mapping and AutomationEnvelope parsing.
// This module will be fully populated during Phase 1A extraction.
// ═══════════════════════════════════════════════════════════════════════

use std::collections::HashMap;

use crate::ableton::routing::{
    choose_preferred_output_target,
    classify_output_routing_target,
    collapse_split_stereo_pan,
    parse_output_target,
    OutputRoutingTarget,
};
use crate::ableton::xml_helpers::{
    node_child_value,
    parse_i64_value,
    parse_track_bool_flag_legacy,
    maybe_parse_bool_manual,
    maybe_parse_f64_manual,
};
use dream_models::project::{AutomationLane, AutomationPoint, Track, TrackType};

pub struct MainTrackMixerSnapshot {
    pub volume: Option<f64>,
    pub pan: Option<f64>,
    pub static_mixer_values: Vec<(String, f64)>,
}

pub fn build_main_track_mixer_snapshot(
    main_track_node: roxmltree::Node<'_, '_>,
) -> MainTrackMixerSnapshot {
    let mut static_mixer_values = Vec::<(String, f64)>::new();
    let mut volume = None::<f64>;
    let mut pan = None::<f64>;

    if let Some(mixer) = main_track_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("DeviceChain"))
        .and_then(|dc| dc.children().find(|n| n.is_element() && n.has_tag_name("Mixer")))
    {
        let split_pan_l = maybe_parse_f64_manual(mixer, "SplitStereoPanL");
        let split_pan_r = maybe_parse_f64_manual(mixer, "SplitStereoPanR");

        if let Some(v) = maybe_parse_f64_manual(mixer, "Volume") {
            let normalized = v.clamp(0.0, 2.0);
            volume = Some(normalized);
            static_mixer_values.push(("volume".to_string(), normalized));
        }
        if let Some(v) = maybe_parse_f64_manual(mixer, "Pan") {
            let normalized = v.clamp(-1.0, 1.0);
            pan = Some(normalized);
            static_mixer_values.push(("pan".to_string(), normalized));
        }
        if let Some(collapsed_pan) = collapse_split_stereo_pan(split_pan_l, split_pan_r) {
            pan = Some(collapsed_pan);
            static_mixer_values.push(("pan".to_string(), collapsed_pan));
        }
        if let Some(on) = maybe_parse_bool_manual(mixer, "On") {
            static_mixer_values.push(("mixer.on".to_string(), if on { 1.0 } else { 0.0 }));
        }
        if let Some(speaker) = maybe_parse_bool_manual(mixer, "Speaker") {
            static_mixer_values.push(("mixer.speaker".to_string(), if speaker { 1.0 } else { 0.0 }));
        }
        if let Some(v) = maybe_parse_f64_manual(mixer, "CrossFadeState") {
            static_mixer_values.push(("mixer.crossfade_state".to_string(), v.clamp(0.0, 2.0)));
        }
        if let Some(v) = split_pan_l {
            static_mixer_values.push(("mixer.pan_left".to_string(), v.clamp(-1.0, 1.0)));
        }
        if let Some(v) = split_pan_r {
            static_mixer_values.push(("mixer.pan_right".to_string(), v.clamp(-1.0, 1.0)));
        }
    }

    let output_target = choose_preferred_output_target(
        TrackType::Master,
        parse_output_target(main_track_node, "AudioOutputRouting"),
        parse_output_target(main_track_node, "MidiOutputRouting"),
    );
    if let Some(target) = output_target {
        match classify_output_routing_target(&target) {
            OutputRoutingTarget::None => {
                static_mixer_values.push(("mixer.output_enabled".to_string(), 0.0));
            }
            OutputRoutingTarget::TrackXmlId(_)
            | OutputRoutingTarget::GroupFallback
            | OutputRoutingTarget::Master
            | OutputRoutingTarget::Unknown => {
                static_mixer_values.push(("mixer.output_enabled".to_string(), 1.0));
            }
        }
    }

    if let Some(v) = parse_track_bool_flag_legacy(main_track_node, "IsAutoSelectEnabled") {
        static_mixer_values.push((
            "mixer.is_auto_select_enabled".to_string(),
            if v { 1.0 } else { 0.0 },
        ));
    }
    if let Some(v) = parse_track_bool_flag_legacy(main_track_node, "KeepRecordMonitoringLatency") {
        static_mixer_values.push((
            "mixer.keep_record_monitoring_latency".to_string(),
            if v { 1.0 } else { 0.0 },
        ));
    }
    if let Some(monitoring_mode) = node_child_value(main_track_node, "MonitoringEnum")
        .or_else(|| {
            main_track_node
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("MonitoringEnum"))
                .and_then(|n| n.attribute("Value"))
                .map(ToString::to_string)
        })
        .as_deref()
        .and_then(parse_i64_value)
        .map(|v| v.clamp(0, 2) as u8)
    {
        static_mixer_values.push(("mixer.monitoring_mode".to_string(), monitoring_mode as f64));
    }

    MainTrackMixerSnapshot {
        volume,
        pan,
        static_mixer_values,
    }
}

pub fn consolidate_automation_lanes(track: &mut Track) {
    let mut merged: HashMap<String, Vec<AutomationPoint>> = HashMap::new();
    for lane in track.automation_lanes.drain(..) {
        let key = lane.param_id.trim().to_string();
        if key.is_empty() {
            continue;
        }
        merged.entry(key).or_default().extend(lane.points);
    }

    let mut out = Vec::new();
    for (param_id, mut points) in merged {
        points.sort_by(|a, b| a.beat.total_cmp(&b.beat));
        points.dedup_by(|a, b| (a.beat - b.beat).abs() < 1e-9);
        if points.is_empty() {
            continue;
        }
        out.push(AutomationLane { param_id, points });
    }
    out.sort_by(|a, b| a.param_id.cmp(&b.param_id));
    track.automation_lanes = out;
}
