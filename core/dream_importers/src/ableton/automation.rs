// ═══════════════════════════════════════════════════════════════════════
// Track Automation — Envelope import from ALS XML
// ═══════════════════════════════════════════════════════════════════════
//
// Handles PointeeId → param_id mapping and AutomationEnvelope parsing.
// This module will be fully populated during Phase 1A extraction.
// ═══════════════════════════════════════════════════════════════════════

use std::collections::HashMap;

use crate::ableton::routing::{
    OutputRoutingTarget, choose_preferred_output_target, classify_output_routing_target,
    collapse_split_stereo_pan, parse_output_target,
};
use crate::ableton::xml_helpers::{
    ableton_volume_to_linear_gain, collect_track_devices, maybe_parse_bool_manual,
    maybe_parse_f64_manual, node_child_value, parse_bool_value, parse_f64_value, parse_i64_value,
    parse_track_bool_flag_legacy,
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
        .find(|n| n.is_element() && n.has_tag_name("InsertEffectsChain"))
        .and_then(|dc| {
            dc.children()
                .find(|n| n.is_element() && n.has_tag_name("Mixer"))
        })
    {
        let split_pan_l = maybe_parse_f64_manual(mixer, "SplitStereoPanL");
        let split_pan_r = maybe_parse_f64_manual(mixer, "SplitStereoPanR");

        if let Some(v) = maybe_parse_f64_manual(mixer, "Volume") {
            let normalized = ableton_volume_to_linear_gain(v);
            volume = Some(normalized);
            static_mixer_values.push(("volume".to_string(), normalized));
        }
        let pan_manual = maybe_parse_f64_manual(mixer, "Pan");
        if let Some(v) = pan_manual {
            let normalized = v.clamp(-1.0, 1.0);
            pan = Some(normalized);
            static_mixer_values.push(("pan".to_string(), normalized));
        }
        // Prefer main Pan when present; use split-pan only as fallback.
        if pan_manual.is_none()
            && let Some(collapsed_pan) = collapse_split_stereo_pan(split_pan_l, split_pan_r)
        {
            pan = Some(collapsed_pan);
            static_mixer_values.push(("pan".to_string(), collapsed_pan));
        }
        if let Some(on) = maybe_parse_bool_manual(mixer, "On") {
            static_mixer_values.push(("mixer.on".to_string(), if on { 1.0 } else { 0.0 }));
        }
        if let Some(speaker) = maybe_parse_bool_manual(mixer, "Speaker") {
            static_mixer_values
                .push(("mixer.speaker".to_string(), if speaker { 1.0 } else { 0.0 }));
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

pub fn plugin_param_lane_key_with(
    dev_idx: usize,
    plugin_name: &str,
    param_name: &str,
    param_id: &str,
    normalize_plugin_key: fn(&str) -> String,
) -> String {
    let plugin_key = normalize_plugin_key(plugin_name);
    let mut param_key = normalize_plugin_key(param_name);
    let maybe_numeric = param_id.trim().parse::<i64>().ok();
    if param_key.is_empty() {
        param_key = match maybe_numeric {
            Some(v) if v >= 0 => format!("id{v}"),
            _ => "unnamed".to_string(),
        };
    } else if let Some(v) = maybe_numeric
        && v >= 0
    {
        param_key = format!("{param_key}_id{v}");
    }
    format!("plugin:{dev_idx}:{plugin_key}:{param_key}")
}

pub fn plugin_param_manual_value(param_node: roxmltree::Node<'_, '_>) -> Option<f64> {
    if let Some(v) = param_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Manual"))
        .and_then(|n| n.attribute("Value"))
        .and_then(parse_f64_value)
        .filter(|v| v.is_finite())
    {
        return Some(v);
    }
    if let Some(v) = param_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Manual"))
        .and_then(|n| n.attribute("Value"))
        .and_then(parse_bool_value)
    {
        return Some(if v { 1.0 } else { 0.0 });
    }
    param_node
        .attribute("Value")
        .and_then(parse_f64_value)
        .filter(|v| v.is_finite())
}

pub fn semantic_external_aliases_with(
    dev_idx: usize,
    plugin_name: &str,
    param_name: &str,
    value: f64,
    normalize_plugin_key: fn(&str) -> String,
) -> Vec<(String, f64)> {
    let mut out = Vec::<(String, f64)>::new();
    let plugin_key = normalize_plugin_key(plugin_name);
    let param_key = normalize_plugin_key(param_name);
    if plugin_key.is_empty() || param_key.is_empty() {
        return out;
    }

    out.push((
        format!("plugin_semantic:{dev_idx}:{plugin_key}:{param_key}"),
        value,
    ));

    if (plugin_key.contains("nectar")
        || plugin_key.contains("prol")
        || plugin_key.contains("compressor"))
        && param_key.contains("threshold")
    {
        out.push((
            "effect.compressor.threshold".to_string(),
            value.clamp(-80.0, 0.0),
        ));
    } else if (plugin_key.contains("nectar")
        || plugin_key.contains("prol")
        || plugin_key.contains("compressor"))
        && param_key.contains("ratio")
    {
        out.push((
            "effect.compressor.ratio".to_string(),
            value.clamp(1.0, 20.0),
        ));
    } else if (plugin_key.contains("nectar")
        || plugin_key.contains("prol")
        || plugin_key.contains("compressor"))
        && param_key.contains("attack")
    {
        out.push((
            "effect.compressor.attack".to_string(),
            value.clamp(0.01, 200.0),
        ));
    } else if (plugin_key.contains("nectar")
        || plugin_key.contains("prol")
        || plugin_key.contains("compressor"))
        && param_key.contains("release")
    {
        out.push((
            "effect.compressor.release".to_string(),
            value.clamp(1.0, 1000.0),
        ));
    } else if plugin_key.contains("reastream")
        && (param_key.contains("mix") || param_key.contains("wet"))
    {
        out.push(("plugin.mono".to_string(), value.clamp(0.0, 1.0)));
    } else if plugin_key.contains("synthesizerv") && param_key.contains("detune") {
        out.push(("synth.detune".to_string(), value.clamp(-50.0, 50.0)));
    }

    out
}

pub fn build_pointee_map_with(
    track_node: roxmltree::Node<'_, '_>,
    infer_device_display_name: fn(roxmltree::Node<'_, '_>, &str) -> String,
    normalize_plugin_key: fn(&str) -> String,
) -> HashMap<String, String> {
    let mut map = HashMap::new();

    let mixer_params = [
        ("Volume", "volume"),
        ("Pan", "pan"),
        ("SplitStereoPanL", "pan_left"),
        ("SplitStereoPanR", "pan_right"),
        ("CrossFadeState", "mixer.crossfade_state"),
    ];

    let mixer = track_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("InsertEffectsChain"))
        .and_then(|dc| {
            dc.children()
                .find(|n| n.is_element() && n.has_tag_name("Mixer"))
        });

    if let Some(mixer) = mixer {
        for (tag, param_id) in &mixer_params {
            if let Some(param_node) = mixer
                .children()
                .find(|n| n.is_element() && n.has_tag_name(*tag))
                && let Some(target) = param_node
                    .descendants()
                    .find(|n| n.is_element() && n.has_tag_name("AutomationTarget"))
                && let Some(id) = target.attribute("Id")
            {
                map.insert(id.to_string(), param_id.to_string());
            }
        }

        for (tag, lane) in [
            ("On", "mixer.on"),
            ("Speaker", "mixer.speaker"),
            ("Solo", "mixer.solo"),
            ("Arm", "mixer.arm"),
        ] {
            if let Some(node) = mixer
                .children()
                .find(|n| n.is_element() && n.has_tag_name(tag))
                && let Some(target) = node
                    .descendants()
                    .find(|n| n.is_element() && n.has_tag_name("AutomationTarget"))
                && let Some(id) = target.attribute("Id")
            {
                map.insert(id.to_string(), lane.to_string());
            }
        }

        for (seq_idx, send) in mixer
            .descendants()
            .filter(|n| n.is_element() && n.has_tag_name("TrackSendHolder"))
            .enumerate()
        {
            let idx = send
                .attribute("Id")
                .and_then(parse_i64_value)
                .filter(|v| *v >= 0)
                .map(|v| v as usize)
                .unwrap_or(seq_idx);
            if idx >= 26 {
                continue;
            }
            if let Some(send_node) = send
                .children()
                .find(|n| n.is_element() && n.has_tag_name("Send"))
                && let Some(target) = send_node
                    .descendants()
                    .find(|n| n.is_element() && n.has_tag_name("AutomationTarget"))
                && let Some(id) = target.attribute("Id")
            {
                let send_letter = (b'A' + idx as u8) as char;
                map.insert(id.to_string(), format!("send.{send_letter}"));
            }
        }
    }

    for (dev_idx, device) in collect_track_devices(track_node).iter().enumerate() {
        if !device.is_element() || !device.has_tag_name("PluginDevice") {
            continue;
        }
        let plugin_name_raw = infer_device_display_name(*device, "plugin");

        for float_param in device
            .descendants()
            .filter(|n| n.is_element() && n.has_tag_name("PluginFloatParameter"))
        {
            let target_id = float_param
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("AutomationTarget"))
                .and_then(|n| n.attribute("Id"))
                .unwrap_or_default()
                .trim()
                .to_string();
            if target_id.is_empty() || map.contains_key(&target_id) {
                continue;
            }

            let param_name = node_child_value(float_param, "ParameterName")
                .unwrap_or_default()
                .trim()
                .to_string();
            let param_id = node_child_value(float_param, "ParameterId")
                .unwrap_or_default()
                .trim()
                .to_string();

            let lane_key = plugin_param_lane_key_with(
                dev_idx,
                &plugin_name_raw,
                &param_name,
                &param_id,
                normalize_plugin_key,
            );
            map.insert(target_id, lane_key);
        }
    }

    for (dev_idx, device) in collect_track_devices(track_node).iter().enumerate() {
        for target in device
            .descendants()
            .filter(|n| n.is_element() && n.has_tag_name("AutomationTarget"))
        {
            if let Some(id) = target.attribute("Id") {
                if map.contains_key(id) {
                    continue;
                }
                let param_tag = target
                    .parent()
                    .and_then(|p| {
                        if p.is_element() {
                            Some(p.tag_name().name().to_string())
                        } else {
                            None
                        }
                    })
                    .unwrap_or_else(|| "param".to_string());
                map.insert(id.to_string(), format!("device:{dev_idx}:{param_tag}"));
            }
        }
    }

    map
}

pub fn import_plugin_device_static_automation_fallback_with(
    track_node: roxmltree::Node<'_, '_>,
    track: &mut Track,
    infer_device_display_name: fn(roxmltree::Node<'_, '_>, &str) -> String,
    normalize_plugin_key: fn(&str) -> String,
    upsert_static_import_lane_if_missing: fn(&mut Track, &str, f64),
) {
    for (dev_idx, device) in collect_track_devices(track_node).iter().enumerate() {
        if !device.is_element() || !device.has_tag_name("PluginDevice") {
            continue;
        }
        let plugin_name_raw = infer_device_display_name(*device, "plugin");

        for param_node in device.descendants().filter(|n| {
            n.is_element()
                && (n.has_tag_name("PluginFloatParameter")
                    || n.has_tag_name("PluginIntParameter")
                    || n.has_tag_name("PluginBoolParameter"))
        }) {
            let param_name = node_child_value(param_node, "ParameterName").unwrap_or_default();
            let param_id = node_child_value(param_node, "ParameterId").unwrap_or_default();
            let lane_key = plugin_param_lane_key_with(
                dev_idx,
                &plugin_name_raw,
                &param_name,
                &param_id,
                normalize_plugin_key,
            );
            let Some(value) = plugin_param_manual_value(param_node) else {
                continue;
            };
            upsert_static_import_lane_if_missing(track, &lane_key, value);
            for (alias_key, alias_value) in semantic_external_aliases_with(
                dev_idx,
                &plugin_name_raw,
                &param_name,
                value,
                normalize_plugin_key,
            ) {
                upsert_static_import_lane_if_missing(track, &alias_key, alias_value);
            }
        }
    }
}

pub fn import_track_automation_with(
    track_node: roxmltree::Node<'_, '_>,
    track: &mut Track,
    infer_device_display_name: fn(roxmltree::Node<'_, '_>, &str) -> String,
    normalize_plugin_key: fn(&str) -> String,
    upsert_static_import_lane_if_missing: fn(&mut Track, &str, f64),
) {
    let pointee_map =
        build_pointee_map_with(track_node, infer_device_display_name, normalize_plugin_key);

    let envelopes_container = track_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("AutomationEnvelopes"))
        .and_then(|ae| {
            ae.children()
                .find(|n| n.is_element() && n.has_tag_name("Envelopes"))
        });

    if let Some(envelopes) = envelopes_container {
        for envelope in envelopes
            .children()
            .filter(|n| n.is_element() && n.has_tag_name("AutomationEnvelope"))
        {
            let pointee_id = envelope
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("PointeeId"))
                .and_then(|n| n.attribute("Value"))
                .unwrap_or_default()
                .to_string();

            let param_id = pointee_map
                .get(&pointee_id)
                .cloned()
                .unwrap_or_else(|| format!("unknown:{pointee_id}"));

            let mut points = Vec::new();
            for event in envelope
                .descendants()
                .filter(|n| n.is_element() && n.has_tag_name("FloatEvent"))
            {
                let time_beats = event
                    .attribute("Time")
                    .and_then(parse_f64_value)
                    .unwrap_or(0.0);
                if time_beats < -1_000_000.0 {
                    continue;
                }
                let value = event
                    .attribute("Value")
                    .and_then(parse_f64_value)
                    .unwrap_or(0.0);
                let has_curve = event.attribute("CurveControl1X").is_some();
                let curve_type = if has_curve { "bezier" } else { "linear" }.to_string();
                let (bezier_cp1x, bezier_cp1y, bezier_cp2x, bezier_cp2y, tension) = if has_curve {
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
                        Some(cp1x),
                        Some(cp1y),
                        Some(cp2x),
                        Some(cp2y),
                        Some(tension),
                    )
                } else {
                    (None, None, None, None, None)
                };

                points.push(AutomationPoint {
                    beat: time_beats,
                    value,
                    curve_type,
                    tension,
                    bezier_cp1x,
                    bezier_cp1y,
                    bezier_cp2x,
                    bezier_cp2y,
                });
            }

            if points.is_empty() {
                continue;
            }
            points.sort_by(|a, b| a.beat.total_cmp(&b.beat));
            track
                .automation_lanes
                .push(AutomationLane { param_id, points });
        }
    }

    import_plugin_device_static_automation_fallback_with(
        track_node,
        track,
        infer_device_display_name,
        normalize_plugin_key,
        upsert_static_import_lane_if_missing,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_track_pan_prefers_primary_pan_over_split_stereo() {
        let xml = r#"
        <MainTrack>
          <InsertEffectsChain>
            <Mixer>
              <Pan><Manual Value="0.4"/></Pan>
              <SplitStereoPanL><Manual Value="-1.0"/></SplitStereoPanL>
              <SplitStereoPanR><Manual Value="1.0"/></SplitStereoPanR>
            </Mixer>
          </InsertEffectsChain>
        </MainTrack>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("xml");
        let main_track = doc.root_element();
        let snap = build_main_track_mixer_snapshot(main_track);
        assert_eq!(snap.pan, Some(0.4));
    }
}
