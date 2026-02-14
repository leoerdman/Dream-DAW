// ═══════════════════════════════════════════════════════════════════════
use std::path::{Path, PathBuf};

fn canonical_internal_plugin_for_import(plugin_id: &str, plugin_name: &str) -> Option<(&'static str, &'static str, &'static str)> {
    let merged = format!("{} {}", plugin_id, plugin_name).to_lowercase();
    let compact = merged.replace(|c: char| !c.is_ascii_alphanumeric(), "");

    if compact.contains("originalsimpler") || compact.contains("drift") || compact.contains("instrumentvector") {
        if compact.contains("originalsimpler") {
            return Some(("internal://instrument/sampler", "Sampler", "instrument"));
        }
        return Some(("internal://instrument/wave-synth", "Wave Synth", "instrument"));
    }

    if merged.contains("operator")
        || merged.contains("analog")
        || merged.contains("wavetable")
        || compact.contains("simplesinesynth")
        || merged.contains("wave synth")
        || compact.contains("wavesynth")
        || compact.contains("instrumentvector")
        || compact.contains("stringstudio")
        || compact.contains("ultraanalog")
        || compact.contains("collision")
        || compact.contains("tension")
        || compact.contains("electricpiano")
        || compact.contains("instrumentmeld")
        || compact.contains("mxdeviceinstrument")
        || compact.contains("loungelizard")
    {
        return Some(("internal://instrument/wave-synth", "Wave Synth", "instrument"));
    }
    if merged.contains("sampler") || merged.contains("simpler") || compact.contains("multisampler") || compact.contains("drumcell") {
        return Some(("internal://instrument/sampler", "Sampler", "instrument"));
    }

    if merged.contains("eq") || merged.contains("channel eq") {
        return Some(("internal://effect/eq-eight", "EQ Eight", "effect"));
    }
    if compact.contains("proq") {
        return Some(("internal://effect/eq-eight", "EQ Eight", "effect"));
    }
    if merged.contains("compressor") || merged.contains("glue") || compact.contains("multibanddynamics") || compact.contains("drumbuss")
        || compact.contains("compressor2")
    {
        return Some(("internal://effect/compressor", "Compressor", "effect"));
    }
    if compact.contains("prol") || compact.contains("nectar") {
        return Some(("internal://effect/compressor", "Compressor", "effect"));
    }
    if merged.contains("delay") || merged.contains("echo") || merged.contains("ping pong")
        || compact.contains("beatrepeat") || compact.contains("graindelay")
        || compact.contains("filterdelay") || compact.contains("spectraltime")
    {
        return Some(("internal://effect/delay", "Delay", "effect"));
    }
    if merged.contains("reverb") || merged.contains("corpus") || merged.contains("resonators")
        || compact.contains("spectralresonator") || compact.contains("resonator")
        || compact.contains("hybrid")
    {
        return Some(("internal://effect/reverb", "Reverb", "effect"));
    }
    if merged.contains("chorus") || compact.contains("chorus2") {
        return Some(("internal://effect/chorus", "Chorus", "effect"));
    }
    if compact.contains("stereogain") {
        return Some(("internal://effect/utility", "Utility", "effect"));
    }
    if compact.contains("autopan") || compact.contains("autopan2") {
        return Some(("internal://effect/auto-pan", "Auto Pan", "effect"));
    }
    if compact.contains("midipitcher") {
        return Some(("internal://midi-fx/pitch", "MIDI Pitch", "effect"));
    }
    if compact.contains("mxdevicescale") || compact == "scale" {
        return Some(("internal://midi-fx/scale", "MIDI Scale", "effect"));
    }
    if compact.contains("mxdevicevelocity") || compact == "velocity" {
        return Some(("internal://midi-fx/velocity", "MIDI Velocity", "effect"));
    }
    if compact.contains("midivelocity") {
        return Some(("internal://midi-fx/velocity", "MIDI Velocity", "effect"));
    }
    if compact.contains("midichord") {
        return Some(("internal://midi-fx/scale", "MIDI Chord", "effect"));
    }
    if compact.contains("mxdevicerandom") || compact == "random" || compact.contains("midirandom") {
        return Some(("internal://midi-fx/random", "MIDI Random", "effect"));
    }
    if compact.contains("midiarpeggiator") {
        return Some(("internal://midi-fx/random", "MIDI Arp", "effect"));
    }
    if compact.contains("midinotelength") {
        return Some(("internal://midi-fx/velocity", "MIDI Note Length", "effect"));
    }
    if merged.contains("noise machine") || compact.contains("noisemachine") {
        return Some(("internal://effect/noise-machine", "Noise Machine", "effect"));
    }
    if merged.contains("saturator") || compact.contains("dynamictube")
        || compact == "tube"
    {
        return Some(("internal://effect/saturator", "Saturator", "effect"));
    }
    if merged.contains("spectrum") || compact.contains("spectrumanalyzer") {
        return Some(("internal://effect/spectrum", "Spectrum", "effect"));
    }
    if compact.contains("span")
        || compact.contains("youlean")
        || compact.contains("loudnessmeter")
        || compact.contains("psyscope")
    {
        return Some(("internal://effect/spectrum", "Spectrum", "effect"));
    }
    if merged.contains("utility") || merged.contains("looper") || merged.contains("tuner")
        || compact.contains("frequencyshifter")
        || compact.contains("shifter")
        || compact.contains("autoshift")
        || compact.contains("pitchhack") || compact.contains("spectral")
        || compact.contains("mxdeviceaudioeffect") || compact.contains("mxdevicemidieffect")
    {
        return Some(("internal://effect/utility", "Utility", "effect"));
    }
    if compact.contains("reastream") || compact.contains("ozoneimager") {
        return Some(("internal://effect/utility", "Utility", "effect"));
    }
    if merged.contains("limiter") {
        return Some(("internal://effect/limiter", "Limiter", "effect"));
    }
    if merged.contains("gate") && !merged.contains("bitcrusher") {
        return Some(("internal://effect/gate", "Gate", "effect"));
    }
    if compact.contains("redux") || compact.contains("bitcrusher") {
        return Some(("internal://effect/bitcrusher", "Bitcrusher", "effect"));
    }
    if merged.contains("auto filter") || merged.contains("autofilter") {
        return Some(("internal://effect/auto-filter", "Auto Filter", "effect"));
    }
    if merged.contains("phaser") {
        return Some(("internal://effect/phaser", "Phaser", "effect"));
    }
    if compact.contains("phasernew") {
        return Some(("internal://effect/phaser", "Phaser", "effect"));
    }
    if merged.contains("flanger") {
        return Some(("internal://effect/flanger", "Flanger", "effect"));
    }
    if merged.contains("distortion") || merged.contains("overdrive") || merged.contains("pedal")
        || merged.contains("cabinet") || merged.contains("amp") || merged.contains("shaper")
        || merged.contains("erosion") || merged.contains("vocoder") || merged.contains("vinyl")
        || merged.contains("transmute")
        || compact.contains("roar")
    {
        return Some(("internal://effect/distortion", "Distortion", "effect"));
    }
    if compact.contains("hybrid") {
        return Some(("internal://effect/reverb", "Reverb", "effect"));
    }
    None
}

fn normalize_internal_plugins_for_import(project: &mut Project) {
    for track in &mut project.tracks {
        if let Some(inst) = &mut track.instrument {
            let pid = inst.plugin_id();
            let pname = inst.name().to_string();
            if let Some((canonical_id, canonical_name, slot)) =
                canonical_internal_plugin_for_import(&pid, &pname)
                && slot == "instrument"
            {
                inst.set_plugin_id(canonical_id);
                if pname.trim().is_empty() || pname.to_lowercase() != canonical_name.to_lowercase() {
                    inst.set_name(canonical_name);
                }
                if track.sampler.is_none() {
                    track.sampler = Some(SamplerConfig::default());
                }
                if canonical_id == "internal://instrument/wave-synth"
                    && let Some(cfg) = &mut track.sampler
                    && cfg.sample_path.trim().is_empty()
                {
                    cfg.sample_path = "internal://waveform/sine".to_string();
                }
            }
        }
        for fx in &mut track.effects {
            normalize_effect_node(fx);
        }
    }
}

/// Recursively normalize a single `DeviceNode` and all children inside racks.
fn normalize_effect_node(node: &mut DeviceNode) {
    match node {
        DeviceNode::Single(slot) => {
            let pid = slot.plugin_id.clone();
            let pname = slot.name.clone();
            if let Some((canonical_id, canonical_name, _slot_kind)) =
                canonical_internal_plugin_for_import(&pid, &pname)
            {
                slot.plugin_id = canonical_id.to_string();
                if pname.trim().is_empty()
                    || pname.to_lowercase() != canonical_name.to_lowercase()
                {
                    slot.name = canonical_name.to_string();
                }
            }
        }
        DeviceNode::Rack(rack) => {
            for chain in &mut rack.chains {
                for device in &mut chain.devices {
                    normalize_effect_node(device);
                }
            }
        }
    }
}

fn parse_bool_value(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn parse_f64_value(raw: &str) -> Option<f64> {
    raw.trim().parse::<f64>().ok()
}

fn parse_i64_value(raw: &str) -> Option<i64> {
    raw.trim().parse::<i64>().ok()
}

fn beats_to_frames(beats: f64, bpm: f64, sample_rate: f64) -> i64 {
    if !beats.is_finite() || !bpm.is_finite() || !sample_rate.is_finite() || bpm <= 0.0 || sample_rate <= 0.0 {
        return 0;
    }
    ((beats * 60.0 / bpm) * sample_rate).round() as i64
}

fn node_child_value(node: roxmltree::Node<'_, '_>, child_tag: &str) -> Option<String> {
    node.children()
        .find(|c| c.is_element() && c.has_tag_name(child_tag))
        .and_then(|n| n.attribute("Value"))
        .map(|s| s.to_string())
}

fn node_manual_value(node: roxmltree::Node<'_, '_>, param_tag: &str) -> Option<String> {
    node.children()
        .find(|c| c.is_element() && c.has_tag_name(param_tag))
        .and_then(|param| {
            param.children()
                .find(|child| child.is_element() && child.has_tag_name("Manual"))
        })
        .and_then(|manual| manual.attribute("Value"))
        .map(|s| s.to_string())
}

fn maybe_parse_f64_manual(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<f64> {
    node_manual_value(node, tag).as_deref().and_then(parse_f64_value)
}

fn maybe_parse_bool_manual(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<bool> {
    node_manual_value(node, tag).as_deref().and_then(parse_bool_value)
}

fn first_child_value(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<String> {
    node.children()
        .find(|c| c.is_element() && c.has_tag_name(tag))
        .and_then(|n| n.attribute("Value"))
        .map(|s| s.to_string())
}

fn first_child_f64(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<f64> {
    first_child_value(node, tag).as_deref().and_then(parse_f64_value)
}

fn first_child_i32(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<i32> {
    first_child_value(node, tag)
        .as_deref()
        .and_then(parse_i64_value)
        .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32)
}

fn first_child_bool(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<bool> {
    first_child_value(node, tag).as_deref().and_then(parse_bool_value)
}

fn descendant_value(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<String> {
    node.descendants()
        .find(|n| n.is_element() && n.has_tag_name(tag))
        .and_then(|n| n.attribute("Value"))
        .map(|s| s.to_string())
}

fn parse_live_set_bool(live_set: roxmltree::Node<'_, '_>, tag: &str) -> Option<bool> {
    first_child_value(live_set, tag)
        .or_else(|| descendant_value(live_set, tag))
        .as_deref()
        .and_then(parse_bool_value)
}

fn parse_live_set_i32(live_set: roxmltree::Node<'_, '_>, tag: &str) -> Option<i32> {
    first_child_value(live_set, tag)
        .or_else(|| descendant_value(live_set, tag))
        .as_deref()
        .and_then(parse_i64_value)
        .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32)
}

fn parse_view_states_bool(live_set: roxmltree::Node<'_, '_>, tag: &str) -> Option<bool> {
    live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("ViewStates"))
        .and_then(|view_states| first_child_bool(view_states, tag))
}

fn semitone_to_tonic(root: u8) -> &'static str {
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

fn parse_clip_scale_info(clip_node: roxmltree::Node<'_, '_>) -> (bool, Option<u8>, Option<String>) {
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

fn parse_clip_follow_action(
    clip_node: roxmltree::Node<'_, '_>,
) -> (bool, f64, i32, i32, f64, f64) {
    let follow = clip_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("FollowAction"));
    let Some(follow) = follow else {
        return (false, 0.0, 0, 0, 0.0, 0.0);
    };
    (
        first_child_bool(follow, "FollowActionEnabled").unwrap_or(false),
        first_child_f64(follow, "FollowTime").unwrap_or(0.0),
        first_child_i32(follow, "FollowActionA").unwrap_or(0),
        first_child_i32(follow, "FollowActionB").unwrap_or(0),
        first_child_f64(follow, "FollowChanceA").unwrap_or(0.0),
        first_child_f64(follow, "FollowChanceB").unwrap_or(0.0),
    )
}

fn parse_clip_groove(clip_node: roxmltree::Node<'_, '_>) -> (Option<String>, f64) {
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

fn parse_clip_launch(clip_node: roxmltree::Node<'_, '_>) -> (i32, i32) {
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

fn parse_clip_loop(clip_node: roxmltree::Node<'_, '_>) -> (Option<f64>, Option<f64>, bool) {
    let loop_node = clip_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Loop"));
    let Some(loop_node) = loop_node else {
        return (None, None, false);
    };
    (
        first_child_f64(loop_node, "LoopStart"),
        first_child_f64(loop_node, "LoopEnd"),
        first_child_bool(loop_node, "LoopOn").unwrap_or(false),
    )
}

fn parse_audio_clip_warp(
    clip_node: roxmltree::Node<'_, '_>,
) -> (bool, Option<i32>, Vec<dream_models::project::WarpMarkerPoint>) {
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
            markers.push(dream_models::project::WarpMarkerPoint { sec_time, beat_time });
        }
    }
    (is_warped, warp_mode, markers)
}

fn parse_clip_envelopes(
    clip_node: roxmltree::Node<'_, '_>,
    pointee_map: &std::collections::HashMap<String, String>,
) -> Vec<dream_models::project::ClipEnvelope> {
    let mut envelopes_out = Vec::new();
    let envelopes_root = clip_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Envelopes"))
        .and_then(|e| e.children().find(|n| n.is_element() && n.has_tag_name("Envelopes")));
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
            points.push(dream_models::project::AutomationPoint {
                beat,
                value,
                curve_type: "linear".to_string(),
                tension: None,
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
        envelopes_out.push(dream_models::project::ClipEnvelope {
            pointee_id,
            param_id,
            points,
        });
    }
    envelopes_out
}

fn parse_clip_grid(
    clip_node: roxmltree::Node<'_, '_>,
) -> Option<(u16, u16, u8, bool, bool)> {
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

fn parse_project_markers(
    live_set: roxmltree::Node<'_, '_>,
) -> Vec<dream_models::project::ProjectMarker> {
    let mut out = Vec::<dream_models::project::ProjectMarker>::new();

    let mut idx = 0usize;

    for locator in live_set
        .descendants()
        .filter(|n| n.is_element() && n.has_tag_name("Locator"))
    {
        let position_beats = first_child_f64(locator, "Time")
            .or_else(|| locator.attribute("Time").and_then(parse_f64_value))
            .unwrap_or(0.0)
            .max(0.0);
        let name = first_child_value(locator, "Name")
            .or_else(|| {
                locator
                    .descendants()
                    .find(|n| n.is_element() && n.has_tag_name("EffectiveName"))
                    .and_then(|n| n.attribute("Value"))
                    .map(|s| s.to_string())
            })
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("Marker {}", idx + 1));
        let color = first_child_value(locator, "Color")
            .or_else(|| locator.attribute("Color").map(|s| s.to_string()))
            .as_deref()
            .and_then(parse_i64_value)
            .map(|v| ableton_color_to_track_color(v, idx));
        out.push(dream_models::project::ProjectMarker {
            id: Uuid::new_v4(),
            name,
            position_beats,
            color,
        });
        idx += 1;
    }

    // Some ALS files store timeline cue points outside <Locators>.
    for cue in live_set
        .descendants()
        .filter(|n| n.is_element() && n.has_tag_name("CuePoint"))
    {
        let position_beats = cue
            .attribute("Time")
            .and_then(parse_f64_value)
            .or_else(|| first_child_f64(cue, "Time"))
            .unwrap_or(0.0)
            .max(0.0);
        let name = cue
            .attribute("Name")
            .map(|s| s.to_string())
            .or_else(|| first_child_value(cue, "Name"))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("Cue {}", idx + 1));
        let color = cue
            .attribute("Color")
            .map(|s| s.to_string())
            .or_else(|| first_child_value(cue, "Color"))
            .as_deref()
            .and_then(parse_i64_value)
            .map(|v| ableton_color_to_track_color(v, idx));
        out.push(dream_models::project::ProjectMarker {
            id: Uuid::new_v4(),
            name,
            position_beats,
            color,
        });
        idx += 1;
    }

    // Drop duplicates by (rounded beat, normalized name).
    out.sort_by(|a, b| a.position_beats.total_cmp(&b.position_beats));
    out.dedup_by(|a, b| {
        ((a.position_beats - b.position_beats).abs() < 1e-6)
            && a.name.trim().eq_ignore_ascii_case(b.name.trim())
    });

    out
}

fn parse_project_scenes(
    live_set: roxmltree::Node<'_, '_>,
) -> Vec<dream_models::project::ProjectScene> {
    let mut out = Vec::<dream_models::project::ProjectScene>::new();

    let Some(scenes_root) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Scenes"))
        .or_else(|| live_set.descendants().find(|n| n.is_element() && n.has_tag_name("Scenes")))
    else {
        return out;
    };

    for (fallback_idx, scene) in scenes_root
        .children()
        .filter(|n| n.is_element() && n.has_tag_name("Scene"))
        .enumerate()
    {
        let index = scene
            .attribute("Id")
            .and_then(parse_i64_value)
            .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32)
            .unwrap_or(fallback_idx as i32);

        let name = first_child_value(scene, "Name")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("Scene {}", index + 1));

        let color = first_child_value(scene, "Color")
            .as_deref()
            .and_then(parse_i64_value)
            .and_then(|v| (v >= 0).then_some(ableton_color_to_track_color(v, fallback_idx)));

        let tempo = first_child_f64(scene, "Tempo").filter(|v| v.is_finite() && *v > 0.0);
        let tempo_enabled = first_child_bool(scene, "IsTempoEnabled").unwrap_or(false);
        let time_signature_id = first_child_i32(scene, "TimeSignatureId");
        let time_signature_enabled = first_child_bool(scene, "IsTimeSignatureEnabled").unwrap_or(false);
        let time_signature_numerator = scene
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Numerator"))
            .and_then(|n| n.attribute("Value"))
            .and_then(parse_i64_value)
            .map(|v| v.clamp(1, 32) as u8);
        let time_signature_denominator = scene
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Denominator"))
            .and_then(|n| n.attribute("Value"))
            .and_then(parse_i64_value)
            .map(|v| v.clamp(1, 32) as u8);
        let follow_action = scene
            .children()
            .find(|n| n.is_element() && n.has_tag_name("FollowAction"));
        let follow_action_enabled = follow_action
            .and_then(|f| first_child_bool(f, "FollowActionEnabled"))
            .unwrap_or(false);
        let follow_time = follow_action.and_then(|f| first_child_f64(f, "FollowTime"));
        let follow_action_a = follow_action.and_then(|f| first_child_i32(f, "FollowActionA"));
        let follow_action_b = follow_action.and_then(|f| first_child_i32(f, "FollowActionB"));
        let follow_chance_a = follow_action.and_then(|f| first_child_f64(f, "FollowChanceA"));
        let follow_chance_b = follow_action.and_then(|f| first_child_f64(f, "FollowChanceB"));

        out.push(dream_models::project::ProjectScene {
            index,
            name,
            color,
            tempo,
            tempo_enabled,
            time_signature_id,
            time_signature_enabled,
            time_signature_numerator,
            time_signature_denominator,
            follow_action_enabled,
            follow_time,
            follow_action_a,
            follow_action_b,
            follow_chance_a,
            follow_chance_b,
        });
    }

    out.sort_by_key(|s| s.index);
    out
}

fn direct_manual_value(node: roxmltree::Node<'_, '_>) -> Option<String> {
    node.children()
        .find(|c| c.is_element() && c.has_tag_name("Manual"))
        .and_then(|manual| manual.attribute("Value"))
        .map(|s| s.to_string())
}

fn parse_track_send_manual_values(mixer: roxmltree::Node<'_, '_>) -> Vec<(usize, f64)> {
    let mut sends = Vec::new();
    for (idx, holder) in mixer
        .descendants()
        .filter(|n| n.is_element() && n.has_tag_name("TrackSendHolder"))
        .enumerate()
    {
        let Some(send_node) = holder
            .children()
            .find(|n| n.is_element() && n.has_tag_name("Send"))
        else {
            continue;
        };
        let value = direct_manual_value(send_node)
            .as_deref()
            .and_then(parse_f64_value)
            .unwrap_or(0.0)
            .clamp(0.0, 2.0);
        sends.push((idx, value));
    }
    sends
}

fn parse_output_target(
    track_node: roxmltree::Node<'_, '_>,
    routing_tag: &str,
) -> Option<String> {
    track_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("DeviceChain"))
        .and_then(|dc| dc.children().find(|n| n.is_element() && n.has_tag_name(routing_tag)))
        .and_then(|routing| routing.children().find(|n| n.is_element() && n.has_tag_name("Target")))
        .and_then(|target| target.attribute("Value"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn parse_target_track_xml_id(target: &str) -> Option<String> {
    for segment in target.split('/') {
        let segment = segment.trim();
        let Some((kind, id)) = segment.split_once('.') else {
            continue;
        };
        if !["Track", "AudioTrack", "MidiTrack", "ReturnTrack", "GroupTrack"].contains(&kind) {
            continue;
        }
        let id = id.trim();
        if id.is_empty() || id == "-1" || !id.chars().all(|c| c.is_ascii_digit() || c == '-') {
            continue;
        }
        return Some(id.to_string());
    }
    None
}

fn resolve_als_file_path(
    als_path: &Path,
    absolute_path: Option<&str>,
    relative_path: Option<&str>,
) -> Option<String> {
    fn try_existing_variants(raw: &str) -> Option<String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }

        let candidates = [
            trimmed.to_string(),
            trimmed.replace(" - ", "-"),
            trimmed.replace(" -", "-"),
            trimmed.replace("- ", "-"),
            trimmed.replace("ABLETON - Projects", "ABLETON - Projects"),
            trimmed.replace("160 - 200 BPM", "160-200 BPM"),
        ];
        for candidate in candidates {
            if std::path::Path::new(&candidate).exists() {
                return Some(candidate);
            }
        }
        None
    }

    fn search_near_project(als_path: &Path, raw: &str) -> Option<String> {
        let file_name = std::path::Path::new(raw)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        if file_name.is_empty() {
            return None;
        }
        let root = als_path.parent()?;
        let hot_dirs = [
            root.join("Samples").join("Imported"),
            root.join("Samples").join("Processed"),
            root.join("Samples").join("Recorded"),
            root.join("Samples"),
        ];
        for dir in hot_dirs {
            if !dir.exists() {
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file()
                        && path
                            .file_name()
                            .and_then(|s| s.to_str())
                            .map(|n| n.eq_ignore_ascii_case(&file_name))
                            .unwrap_or(false)
                    {
                        return Some(path.to_string_lossy().to_string());
                    }
                }
            }
        }
        None
    }

    if let Some(abs) = absolute_path
        && !abs.trim().is_empty()
    {
        if let Some(found) = try_existing_variants(abs) {
            return Some(found);
        }
        if let Some(found) = search_near_project(als_path, abs) {
            return Some(found);
        }
        return Some(abs.trim().to_string());
    }
    if let Some(rel) = relative_path
        && !rel.trim().is_empty()
    {
        let rel_path = PathBuf::from(rel);
        if rel_path.is_absolute() {
            if let Some(found) = try_existing_variants(&rel_path.to_string_lossy()) {
                return Some(found);
            }
            return Some(rel_path.to_string_lossy().to_string());
        }
        let parent = als_path.parent().unwrap_or_else(|| Path::new("."));
        let joined = parent.join(rel_path).to_string_lossy().to_string();
        if let Some(found) = try_existing_variants(&joined) {
            return Some(found);
        }
        if let Some(found) = search_near_project(als_path, &joined) {
            return Some(found);
        }
        return Some(joined);
    }
    None
}

fn make_missing_plugin_slot(kind: &str, ableton_name: &str) -> DeviceNode {
    let normalized = ableton_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug = if normalized.is_empty() {
        "unknown".to_string()
    } else {
        normalized
    };
    DeviceNode::Single(PluginSlot::new(
        format!("Plugin Not Found: {}", ableton_name.trim()),
        format!("missing://{kind}/{slug}"),
    ))
}

fn encode_missing_meta(raw: &str) -> String {
    raw.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
                ch.to_string()
            } else {
                format!("%{:02X}", ch as u32)
            }
        })
        .collect::<String>()
}

fn make_missing_external_plugin_slot_with_metadata(
    kind: &str,
    preferred_name: &str,
    user_name: &str,
    vst2_name: &str,
    vst2_path: &str,
    vst3_name: &str,
    vst3_path: &str,
    is_placeholder: bool,
) -> DeviceNode {
    let mut details = Vec::new();
    if !user_name.trim().is_empty() {
        details.push(format!("user={}", user_name.trim()));
    }
    if !vst3_name.trim().is_empty() {
        details.push(format!("vst3={}", vst3_name.trim()));
    }
    if !vst3_path.trim().is_empty() {
        details.push(format!("vst3_path={}", vst3_path.trim()));
    }
    if !vst2_name.trim().is_empty() {
        details.push(format!("vst2={}", vst2_name.trim()));
    }
    if !vst2_path.trim().is_empty() {
        details.push(format!("vst2_path={}", vst2_path.trim()));
    }
    details.push(format!("placeholder={}", if is_placeholder { "1" } else { "0" }));

    let detail_text = details.join("; ");
    let display_name = if detail_text.is_empty() {
        format!("Plugin Not Found: {}", preferred_name.trim())
    } else {
        format!("Plugin Not Found: {} [{}]", preferred_name.trim(), detail_text)
    };

    let normalized = preferred_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug = if normalized.is_empty() {
        "unknown".to_string()
    } else {
        normalized
    };

    let mut query = Vec::new();
    query.push(format!("name={}", encode_missing_meta(preferred_name.trim())));
    if !user_name.trim().is_empty() {
        query.push(format!("user={}", encode_missing_meta(user_name.trim())));
    }
    if !vst3_name.trim().is_empty() {
        query.push(format!("vst3={}", encode_missing_meta(vst3_name.trim())));
    }
    if !vst3_path.trim().is_empty() {
        query.push(format!("vst3path={}", encode_missing_meta(vst3_path.trim())));
    }
    if !vst2_name.trim().is_empty() {
        query.push(format!("vst2={}", encode_missing_meta(vst2_name.trim())));
    }
    if !vst2_path.trim().is_empty() {
        query.push(format!("vst2path={}", encode_missing_meta(vst2_path.trim())));
    }
    query.push(format!("placeholder={}", if is_placeholder { "1" } else { "0" }));

    let plugin_id = format!("missing://{kind}/{slug}?{}", query.join("&"));
    DeviceNode::Single(PluginSlot::new(display_name, plugin_id))
}

fn normalize_plugin_key(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

struct ExternalPluginIndex {
    by_name: std::collections::HashMap<String, String>,
    by_stem: std::collections::HashMap<String, String>,
    by_file_name: std::collections::HashMap<String, String>,
    by_normalized: std::collections::HashMap<String, String>,
}

impl ExternalPluginIndex {
    fn build() -> Self {
        let mut by_name = std::collections::HashMap::new();
        let mut by_stem = std::collections::HashMap::new();
        let mut by_file_name = std::collections::HashMap::new();
        let mut by_normalized = std::collections::HashMap::new();

        for desc in dream_plugins::PluginScanner::new().scan_all() {
            let path_str = desc.path.to_string_lossy().to_string();
            let name_key = desc.name.to_lowercase();
            by_name.entry(name_key).or_insert_with(|| path_str.clone());
            let normalized_name = normalize_plugin_key(&desc.name);
            if !normalized_name.is_empty() {
                by_normalized
                    .entry(normalized_name)
                    .or_insert_with(|| path_str.clone());
            }

            let stem_key = desc
                .path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_lowercase();
            if !stem_key.is_empty() {
                by_stem.entry(stem_key).or_insert_with(|| path_str.clone());
                let normalized_stem = normalize_plugin_key(
                    desc.path.file_stem().and_then(|s| s.to_str()).unwrap_or_default(),
                );
                if !normalized_stem.is_empty() {
                    by_normalized
                        .entry(normalized_stem)
                        .or_insert_with(|| path_str.clone());
                }
            }

            let file_key = desc
                .path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_lowercase();
            if !file_key.is_empty() {
                by_file_name.entry(file_key).or_insert(path_str);
            }
        }

        Self {
            by_name,
            by_stem,
            by_file_name,
            by_normalized,
        }
    }

    fn resolve_by_name(&self, name: &str) -> Option<String> {
        let key = name.trim().to_lowercase();
        if key.is_empty() {
            return None;
        }
        let normalized = normalize_plugin_key(&key);

        self.by_name
            .get(&key)
            .cloned()
            .or_else(|| self.by_stem.get(&key).cloned())
            .or_else(|| self.by_file_name.get(&key).cloned())
            .or_else(|| self.by_normalized.get(&normalized).cloned())
            .or_else(|| {
                self.by_normalized
                    .iter()
                    .find(|(k, _)| k.contains(&normalized) || normalized.contains(*k))
                    .map(|(_, v)| v.clone())
            })
    }
}

fn collect_devices_in_container<'a, 'input>(
    device_container: roxmltree::Node<'a, 'input>,
    out: &mut Vec<roxmltree::Node<'a, 'input>>,
) {
    for device in device_container.children().filter(|n| n.is_element()) {
        out.push(device);

        // Dive into nested rack/chain device containers.
        // Ableton nests racks as: AudioEffectGroupDevice > Branches >
        // AudioEffectBranch > DeviceChain > AudioToAudioDeviceChain > Devices.
        // We search descendants for any <Devices> node inside a <DeviceChain>
        // to handle intermediary wrappers like AudioToAudioDeviceChain.
        for nested_chain in device
            .descendants()
            .filter(|n| n.is_element() && n.has_tag_name("DeviceChain"))
        {
            // First try direct <Devices> child (simple case)
            if let Some(nested_devices) = nested_chain
                .children()
                .find(|n| n.is_element() && n.has_tag_name("Devices"))
            {
                collect_devices_in_container(nested_devices, out);
            } else {
                // Ableton may wrap in AudioToAudioDeviceChain, MidiToAudioDeviceChain, etc.
                // Search one level deeper for a <Devices> node.
                for wrapper in nested_chain.children().filter(|n| n.is_element()) {
                    if let Some(nested_devices) = wrapper
                        .children()
                        .find(|n| n.is_element() && n.has_tag_name("Devices"))
                    {
                        collect_devices_in_container(nested_devices, out);
                    }
                }
            }
        }
    }
}

fn collect_track_devices<'a, 'input>(
    track_node: roxmltree::Node<'a, 'input>,
) -> Vec<roxmltree::Node<'a, 'input>> {
    let mut devices = Vec::new();
    for chain in track_node
        .children()
        .filter(|n| n.is_element() && n.has_tag_name("DeviceChain"))
    {
        if let Some(root_devices) = chain
            .children()
            .find(|n| n.is_element() && n.has_tag_name("Devices"))
        {
            collect_devices_in_container(root_devices, &mut devices);
        }
    }
    devices
}

fn parse_fade_frames_from_audio_clip(
    clip_node: roxmltree::Node<'_, '_>,
    bpm: f64,
    sample_rate: f64,
) -> (i64, i64) {
    let fade_in_beats = node_child_value(clip_node, "FadeInLength")
        .as_deref()
        .and_then(parse_f64_value)
        .unwrap_or(0.0);
    let fade_out_beats = node_child_value(clip_node, "FadeOutLength")
        .as_deref()
        .and_then(parse_f64_value)
        .unwrap_or(0.0);

    (
        beats_to_frames(fade_in_beats, bpm, sample_rate).max(0),
        beats_to_frames(fade_out_beats, bpm, sample_rate).max(0),
    )
}

fn extract_audio_clip_source_path(
    clip_node: roxmltree::Node<'_, '_>,
    als_path: &Path,
) -> String {
    if let Some(sample_ref) = clip_node
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("SampleRef"))
    {
        let abs = sample_ref
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Path"))
            .and_then(|n| n.attribute("Value"));
        let rel = sample_ref
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("RelativePath"))
            .and_then(|n| n.attribute("Value"));
        if let Some(path) = resolve_als_file_path(als_path, abs, rel) {
            return path;
        }
    }

    if let Some(file_ref) = clip_node
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("FileRef"))
    {
        let abs = file_ref
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Path"))
            .and_then(|n| n.attribute("Value"));
        let rel = file_ref
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("RelativePath"))
            .and_then(|n| n.attribute("Value"));
        if let Some(path) = resolve_als_file_path(als_path, abs, rel) {
            return path;
        }
    }

    String::new()
}

fn extract_simpler_sample_path(
    device: roxmltree::Node<'_, '_>,
    als_path: &Path,
) -> Option<String> {
    let sample_ref = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("SampleRef"))?;
    let abs = sample_ref
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Path"))
        .and_then(|n| n.attribute("Value"));
    let rel = sample_ref
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("RelativePath"))
        .and_then(|n| n.attribute("Value"));
    resolve_als_file_path(als_path, abs, rel)
}

#[cfg(test)]
mod als_import_tests {
    use super::*;

    #[test]
    fn nested_device_collector_finds_devices_inside_racks() {
        let xml = r#"
        <Track>
          <DeviceChain>
            <Devices>
              <AudioEffectGroupDevice Id="1">
                <DeviceChain>
                  <Devices>
                    <Eq8 Id="2"/>
                    <PluginDevice Id="3"/>
                  </Devices>
                </DeviceChain>
              </AudioEffectGroupDevice>
              <AutoFilter Id="4"/>
            </Devices>
          </DeviceChain>
        </Track>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let track = doc
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Track"))
            .expect("track");

        let names: Vec<String> = collect_track_devices(track)
            .into_iter()
            .map(|n| n.tag_name().name().to_string())
            .collect();

        assert!(names.iter().any(|n| n == "AudioEffectGroupDevice"));
        assert!(names.iter().any(|n| n == "Eq8"));
        assert!(names.iter().any(|n| n == "PluginDevice"));
        assert!(names.iter().any(|n| n == "AutoFilter"));
    }

    #[test]
    fn audio_clip_source_path_prefers_sample_ref() {
        let xml = r#"
        <AudioClip>
          <SampleRef>
            <FileRef>
              <RelativePath Value="Samples/Imported/kick.wav"/>
            </FileRef>
          </SampleRef>
        </AudioClip>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let clip = doc
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("AudioClip"))
            .expect("audio clip");

        let als_path = Path::new("/tmp/project/Test.als");
        let source = extract_audio_clip_source_path(clip, als_path);
        assert!(source.ends_with("Samples/Imported/kick.wav"));
    }

    #[test]
    fn parse_track_send_manual_values_reads_track_send_holders() {
        let xml = r#"
        <Mixer>
          <Sends>
            <TrackSendHolder Id="0">
              <Send>
                <Manual Value="0.25"/>
              </Send>
            </TrackSendHolder>
            <TrackSendHolder Id="1">
              <Send>
                <Manual Value="1.25"/>
              </Send>
            </TrackSendHolder>
          </Sends>
        </Mixer>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let mixer = doc
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Mixer"))
            .expect("mixer");

        let sends = parse_track_send_manual_values(mixer);
        assert_eq!(sends.len(), 2);
        assert!((sends[0].1 - 0.25).abs() < 1e-9);
        assert!((sends[1].1 - 1.25).abs() < 1e-9);
    }

    #[test]
    fn static_lane_if_missing_does_not_override_existing_lane() {
        let mut track = Track::new("Test");
        track.automation_lanes.push(dream_models::project::AutomationLane {
            param_id: "send.A".to_string(),
            points: vec![dream_models::project::AutomationPoint {
                beat: 0.0,
                value: 0.7,
                curve_type: "linear".to_string(),
                tension: None,
            }],
        });

        upsert_static_import_lane_if_missing(&mut track, "send.A", 0.1);
        assert_eq!(track.automation_lanes.len(), 1);
        assert!((track.automation_lanes[0].points[0].value - 0.7).abs() < 1e-9);
    }

    #[test]
    fn parse_target_track_xml_id_extracts_track_segment() {
        assert_eq!(
            parse_target_track_xml_id("AudioOut/Track.243"),
            Some("243".to_string())
        );
        assert_eq!(
            parse_target_track_xml_id("MidiOut/Track.77"),
            Some("77".to_string())
        );
        assert_eq!(
            parse_target_track_xml_id("AudioOut/ReturnTrack.81"),
            Some("81".to_string())
        );
        assert_eq!(parse_target_track_xml_id("AudioOut/Main"), None);
        assert_eq!(parse_target_track_xml_id("AudioOut/GroupTrack"), None);
    }

    #[test]
    fn build_pointee_map_captures_extended_mixer_targets() {
        let xml = r#"
        <Track>
          <DeviceChain>
            <Mixer>
              <CrossFadeState>
                <AutomationTarget Id="1001"/>
              </CrossFadeState>
              <Solo>
                <AutomationTarget Id="1002"/>
              </Solo>
              <Arm>
                <AutomationTarget Id="1003"/>
              </Arm>
              <Sends>
                <TrackSendHolder>
                  <Send><AutomationTarget Id="1004"/></Send>
                </TrackSendHolder>
              </Sends>
            </Mixer>
          </DeviceChain>
        </Track>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let track = doc
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Track"))
            .expect("track");

        let map = build_pointee_map(track);
        assert_eq!(map.get("1001").map(String::as_str), Some("mixer.crossfade_state"));
        assert_eq!(map.get("1002").map(String::as_str), Some("mixer.solo"));
        assert_eq!(map.get("1003").map(String::as_str), Some("mixer.arm"));
        assert_eq!(map.get("1004").map(String::as_str), Some("send.A"));
    }

    #[test]
    fn parse_clip_envelopes_uses_pointee_map_param_id() {
        let xml = r#"
        <AudioClip>
          <Envelopes>
            <Envelopes>
              <AutomationEnvelope>
                <EnvelopeTarget><PointeeId Value="42"/></EnvelopeTarget>
                <Automation>
                  <Events>
                    <FloatEvent Time="0" Value="0.5"/>
                  </Events>
                </Automation>
              </AutomationEnvelope>
            </Envelopes>
          </Envelopes>
        </AudioClip>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let clip = doc
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("AudioClip"))
            .expect("clip");
        let mut map = std::collections::HashMap::new();
        map.insert("42".to_string(), "volume".to_string());
        let env = parse_clip_envelopes(clip, &map);
        assert_eq!(env.len(), 1);
        assert_eq!(env[0].param_id, "volume");
    }

    #[test]
    fn parse_live_set_global_modes() {
        let xml = r#"
        <LiveSet>
          <AutomationMode Value="1"/>
          <SnapAutomationToGrid Value="false"/>
          <ArrangementOverdub Value="true"/>
          <SoloInPlace Value="0"/>
          <CrossfadeCurve Value="3"/>
          <LatencyCompensation Value="1"/>
          <SelectedDocumentViewInMainWindow Value="2"/>
          <ViewStateFxSlotCount Value="4"/>
          <ViewStateSessionMixerVolumeSectionHeight Value="283"/>
          <ViewStateArrangerMixerVolumeSectionHeight Value="120"/>
          <ViewStateSessionTrackWidth Value="74"/>
          <ViewStateMainWindowClipDetailOpen Value="false"/>
          <ViewStateMainWindowDeviceDetailOpen Value="true"/>
          <ViewStateSecondWindowClipDetailOpen Value="true"/>
          <ViewStateSecondWindowDeviceDetailOpen Value="false"/>
          <ShouldSceneTempoAndTimeSignatureBeVisible Value="true"/>
          <WaveformVerticalZoomFactor Value="1.25"/>
          <IsWaveformVerticalZoomActive Value="true"/>
          <HighlightedTrackIndex Value="34"/>
          <TrackHeaderWidth Value="102"/>
          <ResetNonautomatedMidiControllersOnClipStarts Value="true"/>
          <MidiFoldIn Value="true"/>
          <MidiFoldMode Value="-99"/>
          <MultiClipFocusMode Value="true"/>
          <MultiClipLoopBarHeight Value="16"/>
          <MidiPrelisten Value="1"/>
          <UseWarperLegacyHiQMode Value="false"/>
          <ShowVideoWindow Value="true"/>
          <SoloOrPflSavedValue Value="true"/>
          <ColorSequenceIndex Value="7"/>
          <NoteSpellingPreference Value="0"/>
          <AccidentalSpellingPreference Value="3"/>
          <PreferFlatRootNote Value="false"/>
          <ViewStateMainWindowHiddenOtherDocViewTypeClipDetailOpen Value="false"/>
          <ViewStateMainWindowHiddenOtherDocViewTypeDeviceDetailOpen Value="true"/>
          <ViewStates>
            <MixerInArrangement Value="0"/>
            <ArrangerMixerIO Value="1"/>
            <ArrangerMixerSends Value="1"/>
            <ArrangerMixerReturns Value="1"/>
            <ArrangerMixerVolume Value="1"/>
            <ArrangerMixerTrackOptions Value="0"/>
            <ArrangerMixerCrossFade Value="0"/>
            <ArrangerMixerTrackPerformanceImpactMeter Value="0"/>
            <MixerInSession Value="1"/>
            <SessionIO Value="1"/>
            <SessionSends Value="1"/>
            <SessionReturns Value="1"/>
            <SessionVolume Value="1"/>
            <SessionTrackOptions Value="0"/>
            <SessionCrossFade Value="0"/>
            <SessionTrackPerformanceImpactMeter Value="0"/>
            <SessionShowOverView Value="0"/>
            <ArrangerIO Value="1"/>
            <ArrangerReturns Value="1"/>
            <ArrangerVolume Value="1"/>
            <ArrangerTrackOptions Value="0"/>
            <ArrangerShowOverView Value="1"/>
          </ViewStates>
        </LiveSet>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let live_set = doc
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("LiveSet"))
            .expect("live set");

        assert_eq!(parse_live_set_bool(live_set, "AutomationMode"), Some(true));
        assert_eq!(parse_live_set_bool(live_set, "SnapAutomationToGrid"), Some(false));
        assert_eq!(parse_live_set_bool(live_set, "ArrangementOverdub"), Some(true));
        assert_eq!(parse_live_set_bool(live_set, "SoloInPlace"), Some(false));
        assert_eq!(parse_live_set_i32(live_set, "CrossfadeCurve"), Some(3));
        assert_eq!(parse_live_set_i32(live_set, "LatencyCompensation"), Some(1));
        assert_eq!(parse_live_set_i32(live_set, "SelectedDocumentViewInMainWindow"), Some(2));
        assert_eq!(parse_live_set_i32(live_set, "ViewStateFxSlotCount"), Some(4));
        assert_eq!(
            first_child_value(live_set, "ViewStateSessionMixerVolumeSectionHeight")
                .as_deref()
                .and_then(parse_f64_value),
            Some(283.0)
        );
        assert_eq!(
            first_child_value(live_set, "ViewStateArrangerMixerVolumeSectionHeight")
                .as_deref()
                .and_then(parse_f64_value),
            Some(120.0)
        );
        assert_eq!(
            first_child_value(live_set, "ViewStateSessionTrackWidth")
                .as_deref()
                .and_then(parse_f64_value),
            Some(74.0)
        );
        assert_eq!(parse_live_set_bool(live_set, "ViewStateMainWindowClipDetailOpen"), Some(false));
        assert_eq!(parse_live_set_bool(live_set, "ViewStateMainWindowDeviceDetailOpen"), Some(true));
        assert_eq!(parse_live_set_bool(live_set, "ViewStateSecondWindowClipDetailOpen"), Some(true));
        assert_eq!(parse_live_set_bool(live_set, "ViewStateSecondWindowDeviceDetailOpen"), Some(false));
        assert_eq!(parse_live_set_bool(live_set, "ShouldSceneTempoAndTimeSignatureBeVisible"), Some(true));
        assert_eq!(
            first_child_value(live_set, "WaveformVerticalZoomFactor")
                .as_deref()
                .and_then(parse_f64_value),
            Some(1.25)
        );
        assert_eq!(parse_live_set_bool(live_set, "IsWaveformVerticalZoomActive"), Some(true));
        assert_eq!(parse_live_set_i32(live_set, "HighlightedTrackIndex"), Some(34));
        assert_eq!(
            first_child_value(live_set, "TrackHeaderWidth")
                .as_deref()
                .and_then(parse_f64_value),
            Some(102.0)
        );
        assert_eq!(
            parse_live_set_bool(live_set, "ResetNonautomatedMidiControllersOnClipStarts"),
            Some(true)
        );
        assert_eq!(parse_live_set_bool(live_set, "MidiFoldIn"), Some(true));
        assert_eq!(parse_live_set_i32(live_set, "MidiFoldMode"), Some(-99));
        assert_eq!(parse_live_set_bool(live_set, "MultiClipFocusMode"), Some(true));
        assert_eq!(
            first_child_value(live_set, "MultiClipLoopBarHeight")
                .as_deref()
                .and_then(parse_f64_value),
            Some(16.0)
        );
        assert_eq!(parse_live_set_bool(live_set, "MidiPrelisten"), Some(true));
        assert_eq!(parse_live_set_bool(live_set, "UseWarperLegacyHiQMode"), Some(false));
        assert_eq!(parse_live_set_bool(live_set, "ShowVideoWindow"), Some(true));
        assert_eq!(parse_live_set_bool(live_set, "SoloOrPflSavedValue"), Some(true));
        assert_eq!(parse_live_set_i32(live_set, "ColorSequenceIndex"), Some(7));
        assert_eq!(parse_live_set_i32(live_set, "NoteSpellingPreference"), Some(0));
        assert_eq!(parse_live_set_i32(live_set, "AccidentalSpellingPreference"), Some(3));
        assert_eq!(parse_live_set_bool(live_set, "PreferFlatRootNote"), Some(false));
        assert_eq!(
            parse_live_set_bool(live_set, "ViewStateMainWindowHiddenOtherDocViewTypeClipDetailOpen"),
            Some(false)
        );
        assert_eq!(
            parse_live_set_bool(live_set, "ViewStateMainWindowHiddenOtherDocViewTypeDeviceDetailOpen"),
            Some(true)
        );
        assert_eq!(parse_view_states_bool(live_set, "MixerInArrangement"), Some(false));
        assert_eq!(parse_view_states_bool(live_set, "ArrangerMixerIO"), Some(true));
        assert_eq!(parse_view_states_bool(live_set, "SessionIO"), Some(true));
        assert_eq!(parse_view_states_bool(live_set, "SessionShowOverView"), Some(false));
        assert_eq!(parse_view_states_bool(live_set, "ArrangerIO"), Some(true));
        assert_eq!(parse_view_states_bool(live_set, "ArrangerReturns"), Some(true));
        assert_eq!(parse_view_states_bool(live_set, "ArrangerVolume"), Some(true));
        assert_eq!(parse_view_states_bool(live_set, "ArrangerTrackOptions"), Some(false));
        assert_eq!(parse_view_states_bool(live_set, "ArrangerShowOverView"), Some(true));
    }

    #[test]
    fn parse_clip_grid_accepts_root_grid_node() {
        let xml = r#"
        <Grid>
          <FixedNumerator Value="8" />
          <FixedDenominator Value="1" />
          <Ntoles Value="2" />
          <SnapToGrid Value="true" />
          <Fixed Value="false" />
        </Grid>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let grid = doc
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Grid"))
            .expect("grid");
        let parsed = parse_clip_grid(grid).expect("parsed");
        assert_eq!(parsed, (8, 1, 2, true, false));
    }

    #[test]
    fn parse_transport_values_from_live_set_transport_node() {
        let xml = r#"
        <LiveSet>
          <Transport>
            <PhaseNudgeTempo Value="10" />
            <LoopOn Value="true" />
            <LoopStart Value="16" />
            <LoopLength Value="8" />
            <LoopIsSongStart Value="false" />
            <CurrentTime Value="18.5" />
            <PunchIn Value="1" />
            <PunchOut Value="0" />
            <MetronomeTickDuration Value="0.25" />
            <DrawMode Value="true" />
          </Transport>
        </LiveSet>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let live_set = doc
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("LiveSet"))
            .expect("live set");
        let transport = live_set
            .children()
            .find(|n| n.is_element() && n.has_tag_name("Transport"))
            .expect("transport");
        assert_eq!(first_child_bool(transport, "LoopOn"), Some(true));
        assert_eq!(first_child_f64(transport, "LoopStart"), Some(16.0));
        assert_eq!(first_child_f64(transport, "LoopLength"), Some(8.0));
        assert_eq!(first_child_f64(transport, "PhaseNudgeTempo"), Some(10.0));
        assert_eq!(first_child_f64(transport, "CurrentTime"), Some(18.5));
        assert_eq!(first_child_bool(transport, "PunchIn"), Some(true));
        assert_eq!(first_child_bool(transport, "PunchOut"), Some(false));
        assert_eq!(first_child_bool(transport, "LoopIsSongStart"), Some(false));
        assert_eq!(first_child_f64(transport, "MetronomeTickDuration"), Some(0.25));
        assert_eq!(first_child_bool(transport, "DrawMode"), Some(true));
    }

    #[test]
    fn parse_live_set_session_scroll_and_breakpoint() {
        let xml = r#"
        <LiveSet>
          <SessionScrollPos X="-5582" Y="17" />
          <SelectedBreakpointValue Value="1308.18286" />
        </LiveSet>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let live_set = doc
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("LiveSet"))
            .expect("live set");
        let session_scroll = live_set
            .children()
            .find(|n| n.is_element() && n.has_tag_name("SessionScrollPos"))
            .expect("session scroll");
        assert_eq!(
            session_scroll.attribute("X").and_then(parse_i64_value),
            Some(-5582)
        );
        assert_eq!(
            session_scroll.attribute("Y").and_then(parse_i64_value),
            Some(17)
        );
        assert_eq!(
            first_child_f64(live_set, "SelectedBreakpointValue"),
            Some(1308.18286)
        );
    }

    #[test]
    fn parse_project_markers_includes_cue_points() {
        let xml = r#"
        <LiveSet>
          <Locators>
            <Locators>
              <Locator><Name Value="Verse"/><Time Value="8"/></Locator>
            </Locators>
          </Locators>
          <CuePoints>
            <CuePoint Name="Drop" Time="16" Color="2"/>
          </CuePoints>
        </LiveSet>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let live_set = doc
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("LiveSet"))
            .expect("live set");
        let markers = parse_project_markers(live_set);
        assert_eq!(markers.len(), 2);
        assert_eq!(markers[0].name, "Verse");
        assert_eq!(markers[1].name, "Drop");
        assert!((markers[1].position_beats - 16.0).abs() < 1e-9);
    }

    #[test]
    fn parse_project_scenes_reads_follow_and_time_signature_details() {
        let xml = r#"
        <LiveSet>
          <Scenes>
            <Scene Id="3">
              <Name Value="Build" />
              <Tempo Value="128" />
              <IsTempoEnabled Value="true" />
              <TimeSignatureId Value="201" />
              <IsTimeSignatureEnabled Value="true" />
              <TimeSignature>
                <TimeSignatures>
                  <RemoteableTimeSignature Id="0">
                    <Numerator Value="7" />
                    <Denominator Value="8" />
                  </RemoteableTimeSignature>
                </TimeSignatures>
              </TimeSignature>
              <FollowAction>
                <FollowActionEnabled Value="true" />
                <FollowTime Value="2" />
                <FollowActionA Value="4" />
                <FollowActionB Value="2" />
                <FollowChanceA Value="75" />
                <FollowChanceB Value="25" />
              </FollowAction>
            </Scene>
          </Scenes>
        </LiveSet>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let live_set = doc
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("LiveSet"))
            .expect("live set");
        let scenes = parse_project_scenes(live_set);
        assert_eq!(scenes.len(), 1);
        let s = &scenes[0];
        assert_eq!(s.index, 3);
        assert_eq!(s.name, "Build");
        assert_eq!(s.time_signature_numerator, Some(7));
        assert_eq!(s.time_signature_denominator, Some(8));
        assert!(s.follow_action_enabled);
        assert_eq!(s.follow_action_a, Some(4));
        assert_eq!(s.follow_action_b, Some(2));
    }
}

fn infer_device_display_name(device: roxmltree::Node<'_, '_>, fallback_tag: &str) -> String {
    if let Some(user_name) = node_child_value(device, "UserName")
        && !user_name.trim().is_empty()
    {
        return user_name.trim().to_string();
    }

    // Ableton built-ins often carry a FileRef/RelativePath like:
    // "Devices/Audio Effects/EQ Eight" -> use final segment.
    let rel = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("RelativePath"))
        .and_then(|n| n.attribute("Value"))
        .unwrap_or_default()
        .trim()
        .to_string();
    if !rel.is_empty() {
        let tail = rel
            .replace('\\', "/")
            .split('/')
            .next_back()
            .unwrap_or_default()
            .trim()
            .to_string();
        if !tail.is_empty() {
            return tail;
        }
    }

    let abs = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Path"))
        .and_then(|n| n.attribute("Value"))
        .unwrap_or_default()
        .trim()
        .to_string();
    if !abs.is_empty() {
        let tail = Path::new(&abs)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if !tail.is_empty() {
            return tail;
        }
    }

    fallback_tag.to_string()
}

#[tauri::command]
fn import_ableton_project(
    path: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    if !PathBuf::from(&path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| e.eq_ignore_ascii_case("als"))
        .unwrap_or(false)
    {
        return Err("Only .als files can be imported with this command.".to_string());
    }
    open_project(
        path,
        project_state,
        clip_pool_state,
        automation_runtime,
        handle,
        app,
    )
}

fn import_track_clips(
    track_node: roxmltree::Node<'_, '_>,
    track: &mut Track,
    als_path: &Path,
    bpm: f64,
    sample_rate: f64,
) {
    let pointee_map = build_pointee_map(track_node);

    for clip_node in track_node.descendants().filter(|n| n.is_element() && n.has_tag_name("AudioClip")) {
        let start_beats = node_child_value(clip_node, "CurrentStart")
            .as_deref()
            .and_then(parse_f64_value)
            .unwrap_or(0.0);
        let end_beats = node_child_value(clip_node, "CurrentEnd")
            .as_deref()
            .and_then(parse_f64_value)
            .unwrap_or(start_beats);
        let duration_beats = (end_beats - start_beats).max(0.0);
        if duration_beats <= 0.0 {
            continue;
        }

        let clip_name = node_child_value(clip_node, "Name")
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "Audio Clip".to_string());

        let source_path = extract_audio_clip_source_path(clip_node, als_path);

        let mut clip = AudioClip::new(
            clip_name,
            source_path,
            AbsoluteTime::new(beats_to_frames(start_beats, bpm, sample_rate)),
            AbsoluteTime::new(beats_to_frames(duration_beats, bpm, sample_rate).max(1)),
        );

        // Import clip color from Ableton's per-clip Color index
        if let Some(color_idx) = node_child_value(clip_node, "Color")
            .as_deref()
            .and_then(parse_i64_value)
        {
            clip.color_override = Some(ableton_color_to_track_color(color_idx, 0));
        }

        if let Some(sample_volume) = node_child_value(clip_node, "SampleVolume")
            .as_deref()
            .and_then(parse_f64_value)
        {
            clip.gain = sample_volume.clamp(0.0, 8.0);
        }
        let (fade_in, fade_out) = parse_fade_frames_from_audio_clip(clip_node, bpm, sample_rate);
        clip.fade_in_frames = fade_in;
        clip.fade_out_frames = fade_out;

        if let Some(start_relative_beats) = clip_node
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("StartRelative"))
            .and_then(|n| n.attribute("Value"))
            .and_then(parse_f64_value)
        {
            clip.source_offset = AbsoluteTime::new(beats_to_frames(start_relative_beats, bpm, sample_rate).max(0));
        }

        if let Some(disabled) = node_child_value(clip_node, "Disabled")
            .as_deref()
            .and_then(parse_bool_value)
        {
            clip.is_muted = disabled;
        }
        let (launch_mode, launch_quantization) = parse_clip_launch(clip_node);
        clip.launch_mode = launch_mode;
        clip.launch_quantization = launch_quantization;
        let (follow_enabled, follow_time, follow_a, follow_b, chance_a, chance_b) =
            parse_clip_follow_action(clip_node);
        clip.follow_action_enabled = follow_enabled;
        clip.follow_time = follow_time;
        clip.follow_action_a = follow_a;
        clip.follow_action_b = follow_b;
        clip.follow_chance_a = chance_a;
        clip.follow_chance_b = chance_b;
        let (in_key, scale_root, scale_name) = parse_clip_scale_info(clip_node);
        clip.is_in_key = in_key;
        clip.scale_root = scale_root;
        clip.scale_name = scale_name;
        let (loop_start_beats, loop_end_beats, loop_on) = parse_clip_loop(clip_node);
        clip.loop_start_beats = loop_start_beats;
        clip.loop_end_beats = loop_end_beats;
        clip.loop_on = loop_on;
        let (is_warped, warp_mode, warp_markers) = parse_audio_clip_warp(clip_node);
        clip.is_warped = is_warped;
        clip.warp_mode = warp_mode;
        clip.warp_markers = warp_markers;
        let (groove_name, groove_amount) = parse_clip_groove(clip_node);
        clip.groove_name = groove_name;
        clip.groove_amount = groove_amount;
        clip.envelopes = parse_clip_envelopes(clip_node, &pointee_map);

        track.clips.push(clip);
    }

    for clip_node in track_node.descendants().filter(|n| n.is_element() && n.has_tag_name("MidiClip")) {
        let start_beats = node_child_value(clip_node, "CurrentStart")
            .as_deref()
            .and_then(parse_f64_value)
            .unwrap_or(0.0);
        let end_beats = node_child_value(clip_node, "CurrentEnd")
            .as_deref()
            .and_then(parse_f64_value)
            .unwrap_or(start_beats);
        let duration_beats = (end_beats - start_beats).max(0.0);
        if duration_beats <= 0.0 {
            continue;
        }

        let mut clip = MidiClip::new(
            node_child_value(clip_node, "Name")
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| "MIDI Clip".to_string()),
            AbsoluteTime::new(beats_to_frames(start_beats, bpm, sample_rate)),
            AbsoluteTime::new(beats_to_frames(duration_beats, bpm, sample_rate).max(1)),
        );
        let (fade_in, fade_out) = parse_fade_frames_from_audio_clip(clip_node, bpm, sample_rate);
        clip.fade_in_frames = fade_in;
        clip.fade_out_frames = fade_out;

        if let Some(disabled) = node_child_value(clip_node, "Disabled")
            .as_deref()
            .and_then(parse_bool_value)
        {
            clip.is_muted = disabled;
        }
        let (launch_mode, launch_quantization) = parse_clip_launch(clip_node);
        clip.launch_mode = launch_mode;
        clip.launch_quantization = launch_quantization;
        let (follow_enabled, follow_time, follow_a, follow_b, chance_a, chance_b) =
            parse_clip_follow_action(clip_node);
        clip.follow_action_enabled = follow_enabled;
        clip.follow_time = follow_time;
        clip.follow_action_a = follow_a;
        clip.follow_action_b = follow_b;
        clip.follow_chance_a = chance_a;
        clip.follow_chance_b = chance_b;
        let (in_key, scale_root, scale_name) = parse_clip_scale_info(clip_node);
        clip.is_in_key = in_key;
        clip.scale_root = scale_root;
        clip.scale_name = scale_name;
        let (loop_start_beats, loop_end_beats, loop_on) = parse_clip_loop(clip_node);
        clip.loop_start_beats = loop_start_beats;
        clip.loop_end_beats = loop_end_beats;
        clip.loop_on = loop_on;
        let (groove_name, groove_amount) = parse_clip_groove(clip_node);
        clip.groove_name = groove_name;
        clip.groove_amount = groove_amount;
        clip.envelopes = parse_clip_envelopes(clip_node, &pointee_map);

        for key_track in clip_node.descendants().filter(|n| n.is_element() && n.has_tag_name("KeyTrack")) {
            let pitch = key_track
                .children()
                .find(|n| n.is_element() && n.has_tag_name("MidiKey"))
                .and_then(|n| n.attribute("Value"))
                .and_then(parse_i64_value)
                .map(|v| v.clamp(0, 127) as u8);
            let Some(pitch) = pitch else { continue };

            for note in key_track.descendants().filter(|n| n.is_element() && n.has_tag_name("MidiNoteEvent")) {
                let time_beats = note.attribute("Time").and_then(parse_f64_value).unwrap_or(0.0);
                let duration_note_beats = note.attribute("Duration").and_then(parse_f64_value).unwrap_or(0.0);
                let velocity = note
                    .attribute("Velocity")
                    .and_then(parse_i64_value)
                    .map(|v| v.clamp(1, 127) as u8)
                    .unwrap_or(100);
                let start_frame = beats_to_frames(time_beats, bpm, sample_rate).max(0);
                let duration_frames = beats_to_frames(duration_note_beats, bpm, sample_rate).max(1);
                clip.add_note(MidiNote::new(pitch, velocity, start_frame, duration_frames));
            }
        }

        track.midi_clips.push(clip);
    }
}

fn upsert_static_import_lane(track: &mut Track, param_id: &str, value: f64) {
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

fn upsert_static_import_lane_if_missing(track: &mut Track, param_id: &str, value: f64) {
    if track
        .automation_lanes
        .iter()
        .any(|lane| lane.param_id.eq_ignore_ascii_case(param_id))
    {
        return;
    }
    upsert_static_import_lane(track, param_id, value);
}

// ── Recursive ALS Rack Parser ──────────────────────────────────────────

/// Parses an Ableton group device XML node into a full `DeviceRack`.
///
/// Supports AudioEffectGroupDevice, InstrumentGroupDevice,
/// DrumGroupDevice, and MidiEffectGroupDevice. Recursively resolves
/// nested devices within each chain (including nested racks).
fn parse_als_rack(
    group_device: roxmltree::Node<'_, '_>,
    external_plugins: &ExternalPluginIndex,
    als_path: &Path,
) -> DeviceRack {
    let tag = group_device.tag_name().name();
    let rack_name = infer_device_display_name(group_device, tag);

    let rack_type = match tag {
        "InstrumentGroupDevice" => RackType::Instrument,
        "DrumGroupDevice" => RackType::DrumRack,
        "MidiEffectGroupDevice" => RackType::MidiEffect,
        _ => RackType::AudioEffect,
    };

    let mut rack = DeviceRack::new(&rack_name, rack_type);

    // ── Parse Branches → RackChains ─────────────────────────────────
    rack.chains = parse_als_rack_chains(group_device, external_plugins, als_path);

    // If no branches found, create a single default chain.
    if rack.chains.is_empty() {
        rack.chains.push(RackChain::new("Chain A"));
    }

    // ── Parse MacroControls (up to 16) ──────────────────────────────
    for macro_node in group_device.children().filter(|n| {
        n.is_element()
            && n.tag_name()
                .name()
                .starts_with("MacroControls.")
    }) {
        let tag_name = macro_node.tag_name().name();
        // Extract index from "MacroControls.0", "MacroControls.1", etc.
        if let Some(idx_str) = tag_name.strip_prefix("MacroControls.") {
            if let Ok(idx) = idx_str.parse::<u8>() {
                if (idx as usize) < rack.macro_controls.len() {
                    let display_name = macro_node
                        .children()
                        .find(|n| n.is_element() && n.has_tag_name("CustomName"))
                        .and_then(|n| n.attribute("Value"))
                        .unwrap_or("")
                        .to_string();

                    let value = macro_node
                        .children()
                        .find(|n| n.is_element() && n.has_tag_name("Manual"))
                        .and_then(|n| n.attribute("Value"))
                        .and_then(parse_f64_value)
                        .unwrap_or(0.0);

                    let mc = &mut rack.macro_controls[idx as usize];
                    if !display_name.is_empty() {
                        mc.name = display_name;
                    }
                    mc.value = value;
                    mc.default_value = value;
                }
            }
        }
    }

    // ── Parse bypass state ──────────────────────────────────────────
    rack.is_bypassed = group_device
        .children()
        .find(|n| n.is_element() && n.has_tag_name("On"))
        .and_then(|n| {
            n.children()
                .find(|c| c.is_element() && c.has_tag_name("Manual"))
                .and_then(|m| m.attribute("Value"))
                .and_then(parse_bool_value)
        })
        .map(|on| !on) // Ableton stores "On", we need "is_bypassed"
        .unwrap_or(false);

    rack
}

/// Parses the Branches element of a group device into a Vec<RackChain>.
///
/// Ableton structure:
/// ```xml
/// <Branches>
///   <AudioEffectBranch Id="0">
///     <Name Value="Chain A" />
///     <DeviceChain>
///       <AudioToAudioDeviceChain>
///         <Devices>
///           <Eq8 Id="123" />
///         </Devices>
///       </AudioToAudioDeviceChain>
///     </DeviceChain>
///     <ZoneSettings>
///       <KeyRange><Min Value="0"/><Max Value="127"/></KeyRange>
///       ...
///     </ZoneSettings>
///   </AudioEffectBranch>
/// </Branches>
/// ```
fn parse_als_rack_chains(
    group_device: roxmltree::Node<'_, '_>,
    external_plugins: &ExternalPluginIndex,
    als_path: &Path,
) -> Vec<RackChain> {
    let mut chains = Vec::new();

    let branches_node = match group_device
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Branches"))
    {
        Some(b) => b,
        None => return chains,
    };

    for branch in branches_node.children().filter(|n| n.is_element()) {
        let chain_name = node_child_value(branch, "Name")
            .unwrap_or_else(|| {
                let letter = (b'A' + chains.len().min(25) as u8) as char;
                format!("Chain {letter}")
            });

        let mut chain = RackChain::new(chain_name);

        // ── Parse ZoneSettings ──────────────────────────────────────
        if let Some(zone_node) = branch
            .children()
            .find(|n| n.is_element() && n.has_tag_name("ZoneSettings"))
        {
            chain.zone_settings = parse_als_zone_settings(zone_node);
        }

        // ── Parse chain mute/solo ───────────────────────────────────
        chain.is_solo = branch
            .children()
            .find(|n| n.is_element() && n.has_tag_name("IsSoloed"))
            .and_then(|n| n.attribute("Value"))
            .and_then(parse_bool_value)
            .unwrap_or(false);
        chain.is_mute = branch
            .children()
            .find(|n| n.is_element() && n.has_tag_name("IsMuted"))
            .and_then(|n| n.attribute("Value"))
            .and_then(parse_bool_value)
            .unwrap_or(false);

        // ── Parse devices from DeviceChain ──────────────────────────
        let device_chain = branch
            .children()
            .find(|n| n.is_element() && n.has_tag_name("DeviceChain"));

        if let Some(dc) = device_chain {
            // Ableton nests devices in:
            //   DeviceChain > AudioToAudioDeviceChain > Devices
            //   DeviceChain > MidiToAudioDeviceChain > Devices
            //   DeviceChain > Devices (direct)
            let devices_node = dc
                .children()
                .find(|n| n.is_element() && n.has_tag_name("Devices"))
                .or_else(|| {
                    // Check wrapper: AudioToAudioDeviceChain, MidiToAudioDeviceChain, etc.
                    dc.children()
                        .filter(|n| n.is_element())
                        .find_map(|wrapper| {
                            wrapper
                                .children()
                                .find(|n| n.is_element() && n.has_tag_name("Devices"))
                        })
                });

            if let Some(devs) = devices_node {
                for child_device in devs.children().filter(|n| n.is_element()) {
                    let child_tag = child_device.tag_name().name();

                    // Nested rack → recursive parse.
                    if matches!(
                        child_tag,
                        "AudioEffectGroupDevice"
                            | "InstrumentGroupDevice"
                            | "DrumGroupDevice"
                            | "MidiEffectGroupDevice"
                    ) {
                        let nested_rack = parse_als_rack(child_device, external_plugins, als_path);
                        chain.devices.push(DeviceNode::Rack(nested_rack));
                        continue;
                    }

                    // PluginDevice → external VST/VST3.
                    if child_tag == "PluginDevice" {
                        let display = infer_device_display_name(child_device, child_tag);
                        let user_name = node_child_value(child_device, "UserName").unwrap_or_default();
                        let vst3_name = child_device
                            .descendants()
                            .find(|n| n.is_element() && n.has_tag_name("Vst3PluginInfo"))
                            .and_then(|v| {
                                v.children()
                                    .find(|n| n.is_element() && n.has_tag_name("Name"))
                                    .and_then(|n| n.attribute("Value"))
                            })
                            .unwrap_or_default();
                        let vst2_name = child_device
                            .descendants()
                            .find(|n| n.is_element() && n.has_tag_name("VstPluginInfo"))
                            .and_then(|v| {
                                v.children()
                                    .find(|n| n.is_element() && n.has_tag_name("PlugName"))
                                    .and_then(|n| n.attribute("Value"))
                            })
                            .unwrap_or_default();
                        let vst3_path = child_device
                            .descendants()
                            .find(|n| n.is_element() && n.has_tag_name("Vst3PluginInfo"))
                            .and_then(|v| {
                                v.children()
                                    .find(|n| n.is_element() && n.has_tag_name("Path"))
                                    .and_then(|n| n.attribute("Value"))
                            })
                            .unwrap_or_default();
                        let vst2_path = child_device
                            .descendants()
                            .find(|n| n.is_element() && n.has_tag_name("VstPluginInfo"))
                            .and_then(|v| {
                                v.children()
                                    .find(|n| n.is_element() && n.has_tag_name("Path"))
                                    .and_then(|n| n.attribute("Value"))
                            })
                            .unwrap_or_default();

                        let preferred_name = if !display.trim().is_empty() {
                            display
                        } else if !vst3_name.is_empty() {
                            vst3_name.to_string()
                        } else if !vst2_name.is_empty() {
                            vst2_name.to_string()
                        } else {
                            "Unknown Plugin".to_string()
                        };

                        let resolved_plugin_id = if !vst2_path.is_empty() {
                            Some(vst2_path.to_string())
                        } else if !vst3_path.is_empty() {
                            Some(vst3_path.to_string())
                        } else if !vst3_name.is_empty() {
                            external_plugins.resolve_by_name(vst3_name)
                        } else if !vst2_name.is_empty() {
                            external_plugins.resolve_by_name(vst2_name)
                        } else {
                            None
                        };

                        if let Some(plugin_id) = resolved_plugin_id {
                            chain.devices.push(DeviceNode::Single(PluginSlot::new(
                                preferred_name,
                                plugin_id,
                            )));
                        } else if let Some((pid, pname, _)) =
                            canonical_internal_plugin_for_import("PluginDevice", &preferred_name)
                        {
                            chain
                                .devices
                                .push(DeviceNode::Single(PluginSlot::new(pname, pid)));
                        } else {
                            chain.devices.push(make_missing_external_plugin_slot_with_metadata(
                                "external",
                                &preferred_name,
                                &user_name,
                                &vst2_name,
                                &vst2_path,
                                &vst3_name,
                                &vst3_path,
                                false,
                            ));
                        }
                        continue;
                    }

                    // Internal Ableton device → canonical mapping.
                    let display = infer_device_display_name(child_device, child_tag);
                    if let Some((pid, pname, _)) =
                        canonical_internal_plugin_for_import(child_tag, &display)
                    {
                        chain
                            .devices
                            .push(DeviceNode::Single(PluginSlot::new(pname, pid)));
                    } else {
                        chain.devices.push(make_missing_plugin_slot(child_tag, &display));
                    }
                }
            }
        }

        // Parse volume/pan from the chain's mixer if present.
        if let Some(mixer) = branch.descendants().find(|n| {
            n.is_element() && n.has_tag_name("Mixer")
        }) {
            if let Some(vol) = mixer
                .children()
                .find(|n| n.is_element() && n.has_tag_name("Volume"))
                .and_then(|v| {
                    v.children()
                        .find(|c| c.is_element() && c.has_tag_name("Manual"))
                        .and_then(|m| m.attribute("Value"))
                        .and_then(parse_f64_value)
                })
            {
                chain.volume = vol.clamp(0.0, 2.0);
            }
            if let Some(pan) = mixer
                .children()
                .find(|n| n.is_element() && n.has_tag_name("Pan"))
                .and_then(|v| {
                    v.children()
                        .find(|c| c.is_element() && c.has_tag_name("Manual"))
                        .and_then(|m| m.attribute("Value"))
                        .and_then(parse_f64_value)
                })
            {
                chain.pan = pan.clamp(-1.0, 1.0);
            }
        }

        chains.push(chain);
    }

    chains
}

/// Parses Ableton zone settings XML into `ZoneSettings`.
fn parse_als_zone_settings(zone_node: roxmltree::Node<'_, '_>) -> dream_models::project::ZoneSettings {
    let mut zs = dream_models::project::ZoneSettings::default();

    fn range_min_max(parent: roxmltree::Node<'_, '_>, range_tag: &str) -> (Option<u8>, Option<u8>) {
        let range = match parent
            .children()
            .find(|n| n.is_element() && n.has_tag_name(range_tag))
        {
            Some(r) => r,
            None => return (None, None),
        };
        let min_val = range
            .children()
            .find(|n| n.is_element() && n.has_tag_name("Min"))
            .and_then(|n| n.attribute("Value"))
            .and_then(parse_i64_value)
            .map(|v| v.clamp(0, 127) as u8);
        let max_val = range
            .children()
            .find(|n| n.is_element() && n.has_tag_name("Max"))
            .and_then(|n| n.attribute("Value"))
            .and_then(parse_i64_value)
            .map(|v| v.clamp(0, 127) as u8);
        (min_val, max_val)
    }

    let (kmin, kmax) = range_min_max(zone_node, "KeyRange");
    if let Some(v) = kmin { zs.key_range_min = v; }
    if let Some(v) = kmax { zs.key_range_max = v; }

    let (vmin, vmax) = range_min_max(zone_node, "VelocityRange");
    if let Some(v) = vmin { zs.velocity_range_min = v; }
    if let Some(v) = vmax { zs.velocity_range_max = v; }

    let (cmin, cmax) = range_min_max(zone_node, "ChainSelectorRange");
    if let Some(v) = cmin { zs.chain_selector_min = v; }
    if let Some(v) = cmax { zs.chain_selector_max = v; }

    zs
}

fn collect_device_manual_params(device: roxmltree::Node<'_, '_>) -> std::collections::HashMap<String, f64> {
    let mut out = std::collections::HashMap::new();
    for node in device.descendants().filter(|n| n.is_element()) {
        let key = node.tag_name().name().to_string();
        let val = node
            .children()
            .find(|c| c.is_element() && c.has_tag_name("Manual"))
            .and_then(|m| m.attribute("Value"))
            .and_then(parse_f64_value);
        if let Some(v) = val {
            out.entry(key).or_insert(v);
        }
    }
    out
}

fn first_param_value(
    params: &std::collections::HashMap<String, f64>,
    keys: &[&str],
) -> Option<f64> {
    keys.iter().find_map(|k| params.get(*k).copied())
}

fn normalize_percent_or_unit(value: f64) -> f64 {
    if value > 1.0 {
        (value / 100.0).clamp(0.0, 1.0)
    } else {
        value.clamp(0.0, 1.0)
    }
}

fn import_internal_device_static_params(
    track: &mut Track,
    plugin_id: &str,
    device: roxmltree::Node<'_, '_>,
) {
    let params = collect_device_manual_params(device);
    let key = plugin_id.to_ascii_lowercase();

    // Common on/off switch where available.
    if let Some(on) = first_param_value(&params, &["On"]) {
        upsert_static_import_lane(track, "device.on", if on >= 0.5 { 1.0 } else { 0.0 });
    }

    if key == "internal://effect/utility" {
        if let Some(gain) = first_param_value(&params, &["Volume", "Gain", "Output", "GlobalGain"]) {
            upsert_static_import_lane(track, "plugin.gain", gain.clamp(0.0, 2.0));
        }
        if let Some(pan) = first_param_value(&params, &["Pan", "Panorama"]) {
            upsert_static_import_lane(track, "plugin.pan", pan.clamp(-1.0, 1.0));
        }
        if let Some(width) = first_param_value(&params, &["Width", "StereoWidth"]) {
            let normalized = if width <= 2.0 { width * 100.0 } else { width };
            upsert_static_import_lane(track, "plugin.width", normalized.clamp(0.0, 200.0));
        }
        if let Some(mono) = first_param_value(&params, &["Mono", "BassMono"]) {
            upsert_static_import_lane(track, "plugin.mono", if mono >= 0.5 { 1.0 } else { 0.0 });
        }
        return;
    }

    if key == "internal://effect/auto-filter" {
        if let Some(v) = first_param_value(&params, &["Cutoff", "Filter_Frequency"]) {
            upsert_static_import_lane(track, "effect.auto_filter.cutoff", v.clamp(20.0, 20_000.0));
        }
        if let Some(v) = first_param_value(&params, &["Resonance", "Filter_Resonance"]) {
            upsert_static_import_lane(track, "effect.auto_filter.resonance", v.clamp(0.0, 1.0));
        }
        if let Some(v) = first_param_value(&params, &["Drive", "Filter_Drive"]) {
            upsert_static_import_lane(track, "effect.auto_filter.drive", v.clamp(0.0, 24.0));
        }
        if let Some(v) = first_param_value(&params, &["FilterType", "Filter_Type"]) {
            upsert_static_import_lane(track, "effect.auto_filter.type", v.round().clamp(0.0, 8.0));
        }
        if let Some(v) = first_param_value(&params, &["Lfo_Frequency", "LfoRate"]) {
            upsert_static_import_lane(track, "effect.auto_filter.lfo.rate", v.clamp(0.01, 20.0));
        }
        if let Some(v) = first_param_value(&params, &["Lfo_Amount", "LfoAmount"]) {
            upsert_static_import_lane(track, "effect.auto_filter.lfo.depth", normalize_percent_or_unit(v));
        }
        if let Some(v) = first_param_value(&params, &["Envelope_Amount", "EnvAmount"]) {
            let env = if v.abs() > 1.0 { (v / 100.0).clamp(-1.0, 1.0) } else { v.clamp(-1.0, 1.0) };
            upsert_static_import_lane(track, "effect.auto_filter.env.amount", env);
        }
        if let Some(v) = first_param_value(&params, &["Lfo_Waveform", "LfoShape"]) {
            upsert_static_import_lane(track, "effect.auto_filter.lfo.shape", v.round().clamp(0.0, 5.0));
        }
        if let Some(v) = first_param_value(&params, &["Envelope_Attack", "EnvSpeed"]) {
            let ms = if v <= 1.0 { v * 1000.0 } else { v };
            upsert_static_import_lane(track, "effect.auto_filter.env.speed_ms", ms.clamp(1.0, 200.0));
        }
        if let Some(v) = first_param_value(&params, &["DryWet", "Mix"]) {
            upsert_static_import_lane(track, "effect.auto_filter.mix", normalize_percent_or_unit(v));
        }
        return;
    }

    if key == "internal://effect/compressor" {
        if let Some(v) = first_param_value(&params, &["Threshold"]) {
            upsert_static_import_lane(track, "effect.compressor.threshold", v.clamp(-80.0, 0.0));
        }
        if let Some(v) = first_param_value(&params, &["Ratio", "ExpansionRatio"]) {
            upsert_static_import_lane(track, "effect.compressor.ratio", v.clamp(1.0, 20.0));
        }
        if let Some(v) = first_param_value(&params, &["Attack"]) {
            upsert_static_import_lane(track, "effect.compressor.attack", v.clamp(0.01, 200.0));
        }
        if let Some(v) = first_param_value(&params, &["Release"]) {
            upsert_static_import_lane(track, "effect.compressor.release", v.clamp(1.0, 1000.0));
        }
        if let Some(v) = first_param_value(&params, &["Knee"]) {
            upsert_static_import_lane(track, "effect.compressor.knee", v.clamp(0.0, 24.0));
        }
        if let Some(v) = first_param_value(&params, &["Gain", "GainCompensation"]) {
            upsert_static_import_lane(track, "effect.compressor.makeup", v.clamp(-24.0, 24.0));
        }
        if let Some(v) = first_param_value(&params, &["DryWet"]) {
            upsert_static_import_lane(track, "effect.compressor.mix", normalize_percent_or_unit(v));
        }
        return;
    }

    if key == "internal://effect/reverb" {
        if let Some(v) = first_param_value(&params, &["PreDelay", "PreDelay_Time"]) {
            upsert_static_import_lane(track, "effect.reverb.predelay", v.clamp(0.0, 500.0));
        }
        if let Some(v) = first_param_value(&params, &["DecayTime", "Algorithm_Decay"]) {
            upsert_static_import_lane(track, "effect.reverb.decay", v.clamp(0.1, 60.0));
        }
        if let Some(v) = first_param_value(&params, &["RoomSize", "Algorithm_Size"]) {
            upsert_static_import_lane(track, "effect.reverb.size", normalize_percent_or_unit(v));
        }
        if let Some(v) = first_param_value(&params, &["DryWet", "MixDiffuse"]) {
            upsert_static_import_lane(track, "effect.reverb.mix", normalize_percent_or_unit(v));
        }
        return;
    }

    if key == "internal://effect/delay" {
        if let Some(v) = first_param_value(&params, &["Time", "DelayTime", "Feedback_FeedbackTime"]) {
            upsert_static_import_lane(track, "effect.delay.time", v.max(0.0));
        }
        if let Some(v) = first_param_value(&params, &["Feedback", "Feedback_FeedbackAmount"]) {
            upsert_static_import_lane(track, "effect.delay.feedback", normalize_percent_or_unit(v));
        }
        if let Some(v) = first_param_value(&params, &["DryWet", "Send"]) {
            upsert_static_import_lane(track, "effect.delay.mix", normalize_percent_or_unit(v));
        }
        return;
    }

    if key == "internal://effect/eq-eight" {
        if let Some(v) = first_param_value(&params, &["GlobalGain"]) {
            upsert_static_import_lane(track, "effect.eq.global_gain", v.clamp(-24.0, 24.0));
        }
        if let Some(v) = first_param_value(&params, &["Scale"]) {
            upsert_static_import_lane(track, "effect.eq.scale", normalize_percent_or_unit(v));
        }
        if let Some(v) = first_param_value(&params, &["AdaptiveQ"]) {
            upsert_static_import_lane(track, "effect.eq.adaptive_q", if v >= 0.5 { 1.0 } else { 0.0 });
        }
        for band in 0..8 {
            let band_tag = format!("Bands.{band}");
            if let Some(band_node) = device
                .descendants()
                .find(|n| n.is_element() && n.tag_name().name() == band_tag)
            {
                let param_node = band_node
                    .children()
                    .find(|n| n.is_element() && n.tag_name().name() == "ParameterA")
                    .or_else(|| band_node.children().find(|n| n.is_element()));
                if let Some(pn) = param_node {
                    if let Some(v) = maybe_parse_f64_manual(pn, "Freq") {
                        upsert_static_import_lane(
                            track,
                            &format!("effect.eq.band{band}.freq"),
                            v.clamp(20.0, 20_000.0),
                        );
                    }
                    if let Some(v) = maybe_parse_f64_manual(pn, "Gain") {
                        upsert_static_import_lane(
                            track,
                            &format!("effect.eq.band{band}.gain"),
                            v.clamp(-24.0, 24.0),
                        );
                    }
                    if let Some(v) = maybe_parse_f64_manual(pn, "Q") {
                        upsert_static_import_lane(
                            track,
                            &format!("effect.eq.band{band}.q"),
                            v.clamp(0.1, 18.0),
                        );
                    }
                    if let Some(v) = maybe_parse_f64_manual(pn, "IsOn") {
                        upsert_static_import_lane(
                            track,
                            &format!("effect.eq.band{band}.on"),
                            if v >= 0.5 { 1.0 } else { 0.0 },
                        );
                    }
                    if let Some(v) = maybe_parse_f64_manual(pn, "Mode") {
                        upsert_static_import_lane(
                            track,
                            &format!("effect.eq.band{band}.mode"),
                            v.round().clamp(0.0, 7.0),
                        );
                    }
                }
            }
        }
        return;
    }

    if key == "internal://instrument/wave-synth" {
        if let Some(v) = first_param_value(&params, &["Voice_Oscillator1_Pitch_Detune", "Detune"]) {
            upsert_static_import_lane(track, "synth.detune", v.clamp(-50.0, 50.0));
        }
        if let Some(v) = first_param_value(&params, &["Voice_SubOscillator_Gain"]) {
            upsert_static_import_lane(track, "synth.sub", normalize_percent_or_unit(v));
        }
        if let Some(v) = first_param_value(&params, &["Voice_Filter1_Frequency", "Filter_Frequency"]) {
            upsert_static_import_lane(track, "synth.filter.cutoff", v.clamp(20.0, 20_000.0));
        }
        if let Some(v) = first_param_value(&params, &["Voice_Filter1_Resonance", "Filter_Resonance"]) {
            upsert_static_import_lane(track, "synth.filter.resonance", v.clamp(0.0, 0.99));
        }
        if let Some(v) = first_param_value(&params, &["Voice_Filter1_Type", "Filter_Type"]) {
            upsert_static_import_lane(track, "synth.filter.type", v.round().clamp(0.0, 3.0));
        }

        if let (Some(osc1), Some(osc2)) = (
            first_param_value(&params, &["Voice_Oscillator1_Gain"]),
            first_param_value(&params, &["Voice_Oscillator2_Gain"]),
        ) {
            let total = osc1.abs() + osc2.abs();
            if total > 1e-6 {
                upsert_static_import_lane(track, "synth.osc.mix", (osc2.abs() / total).clamp(0.0, 1.0));
            }
        }

        if let Some(v) = first_param_value(&params, &["Voice_Modulators_AmpEnvelope_Times_Attack", "Attack"]) {
            upsert_static_import_lane(track, "sampler.attack", v.clamp(0.001, 10.0));
        }
        if let Some(v) = first_param_value(&params, &["Voice_Modulators_AmpEnvelope_Times_Decay", "Decay"]) {
            upsert_static_import_lane(track, "sampler.decay", v.clamp(0.001, 10.0));
        }
        if let Some(v) = first_param_value(&params, &["Voice_Modulators_AmpEnvelope_Sustain", "Sustain"]) {
            upsert_static_import_lane(track, "sampler.sustain", normalize_percent_or_unit(v));
        }
        if let Some(v) = first_param_value(&params, &["Voice_Modulators_AmpEnvelope_Times_Release", "Release"]) {
            upsert_static_import_lane(track, "sampler.release", v.clamp(0.001, 20.0));
        }
    }
}

fn import_track_devices(
    track_node: roxmltree::Node<'_, '_>,
    track: &mut Track,
    external_plugins: &ExternalPluginIndex,
    als_path: &Path,
) {
    fn is_group_rack_tag(tag: &str) -> bool {
        matches!(
            tag,
            "AudioEffectGroupDevice"
                | "DrumGroupDevice"
                | "MidiEffectGroupDevice"
                | "InstrumentGroupDevice"
        )
    }

    fn is_nested_inside_group_rack(node: roxmltree::Node<'_, '_>) -> bool {
        node.ancestors()
            .skip(1)
            .any(|a| a.is_element() && is_group_rack_tag(a.tag_name().name()))
    }

    let effect_rack_tags = [
        "AudioEffectGroupDevice",
        "DrumGroupDevice",
        "MidiEffectGroupDevice",
    ];

    for device in collect_track_devices(track_node) {
        let tag = device.tag_name().name();

        // Child devices of a rack are imported as part of that rack.
        // This prevents duplicate flattened import and enables "rack as one node"
        // behavior during Ableton .als migration.
        if is_nested_inside_group_rack(device) {
            continue;
        }

        // Effect racks: parse full rack structure from Ableton XML.
        if effect_rack_tags.contains(&tag) {
            let rack = parse_als_rack(device, external_plugins, als_path);
            track.effects.push(DeviceNode::Rack(rack));
            continue;
        }

        // Instrument racks: parse as full DeviceRack and assign to
        // instrument slot (if MIDI track) or push to effect chain.
        if tag == "InstrumentGroupDevice" {
            let rack = parse_als_rack(device, external_plugins, als_path);
            if track.track_type == TrackType::Midi && track.instrument.is_none() {
                track.instrument = Some(DeviceNode::Rack(rack));
            } else {
                track.effects.push(DeviceNode::Rack(rack));
            }
            continue;
        }

        if tag == "PluginDevice" {
            let user_name = node_child_value(device, "UserName").unwrap_or_default();
            let vst3_name = device
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("Vst3PluginInfo"))
                .and_then(|vst3| {
                    vst3.children()
                        .find(|n| n.is_element() && n.has_tag_name("Name"))
                        .and_then(|n| n.attribute("Value"))
                })
                .unwrap_or_default()
                .to_string();
            let vst2_name = device
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("VstPluginInfo"))
                .and_then(|vst2| {
                    vst2.children()
                        .find(|n| n.is_element() && n.has_tag_name("PlugName"))
                        .and_then(|n| n.attribute("Value"))
                })
                .unwrap_or_default()
                .to_string();
            let vst2_path = device
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("VstPluginInfo"))
                .and_then(|vst2| {
                    vst2.children()
                        .find(|n| n.is_element() && n.has_tag_name("Path"))
                        .and_then(|n| n.attribute("Value"))
                })
                .unwrap_or_default()
                .to_string();
            let vst3_path = device
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("Vst3PluginInfo"))
                .and_then(|vst3| {
                    vst3.children()
                        .find(|n| n.is_element() && n.has_tag_name("Path"))
                        .and_then(|n| n.attribute("Value"))
                })
                .unwrap_or_default()
                .to_string();
            let is_placeholder = device
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("IsPlaceholderDevice"))
                .and_then(|n| n.attribute("Value"))
                .and_then(parse_bool_value)
                .unwrap_or(false);

            let preferred_name = if !user_name.trim().is_empty() {
                user_name.trim().to_string()
            } else if !vst3_name.trim().is_empty() {
                vst3_name.trim().to_string()
            } else if !vst2_name.trim().is_empty() {
                vst2_name.trim().to_string()
            } else if !vst2_path.trim().is_empty() {
                Path::new(vst2_path.trim())
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Unknown Plugin")
                    .to_string()
            } else if !vst3_path.trim().is_empty() {
                Path::new(vst3_path.trim())
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Unknown Plugin")
                    .to_string()
            } else {
                infer_device_display_name(device, "Unknown Plugin")
            };

            let resolved_plugin_id = if !vst2_path.trim().is_empty() {
                Some(vst2_path.trim().to_string())
            } else if !vst3_path.trim().is_empty() {
                Some(vst3_path.trim().to_string())
            } else if !vst3_name.trim().is_empty() {
                external_plugins.resolve_by_name(&vst3_name)
            } else if !vst2_name.trim().is_empty() {
                external_plugins.resolve_by_name(&vst2_name)
            } else {
                None
            };

            let is_instrument_slot = track.track_type == TrackType::Midi && track.instrument.is_none();
            let slot = if let Some(plugin_id) = resolved_plugin_id {
                DeviceNode::Single(PluginSlot::new(preferred_name, plugin_id))
            } else if let Some((pid, pname, slot_kind)) =
                canonical_internal_plugin_for_import("PluginDevice", &preferred_name)
            {
                import_internal_device_static_params(track, pid, device);
                if slot_kind == "instrument" && is_instrument_slot {
                    DeviceNode::Single(PluginSlot::new(pname, pid))
                } else {
                    DeviceNode::Single(PluginSlot::new(pname, pid))
                }
            } else {
                make_missing_external_plugin_slot_with_metadata(
                    "external",
                    &preferred_name,
                    &user_name,
                    &vst2_name,
                    &vst2_path,
                    &vst3_name,
                    &vst3_path,
                    is_placeholder,
                )
            };

            if is_instrument_slot {
                track.instrument = Some(slot);
            } else {
                track.effects.push(slot);
            }
            continue;
        }

        let display_name = infer_device_display_name(device, tag);

        let canonical = canonical_internal_plugin_for_import(tag, &display_name);
        let is_instrument_slot = track.track_type == TrackType::Midi && track.instrument.is_none();
        if let Some((plugin_id, plugin_name, slot_kind)) = canonical {
            let slot = DeviceNode::Single(PluginSlot::new(plugin_name, plugin_id));
            import_internal_device_static_params(track, plugin_id, device);
            if slot_kind == "instrument" && is_instrument_slot {
                track.instrument = Some(slot);
                if track.sampler.is_none() {
                    track.sampler = Some(SamplerConfig::default());
                }
                if tag == "OriginalSimpler"
                    && let Some(sample_path) = extract_simpler_sample_path(device, als_path)
                    && let Some(cfg) = &mut track.sampler
                    && cfg.sample_path.trim().is_empty()
                {
                    cfg.sample_path = sample_path;
                }
                if plugin_id == "internal://instrument/wave-synth"
                    && let Some(cfg) = &mut track.sampler
                    && cfg.sample_path.trim().is_empty()
                {
                    cfg.sample_path = "internal://waveform/sine".to_string();
                }
            } else {
                track.effects.push(slot);
                // Import static MIDI FX settings into automation lanes so runtime
                // can reconstruct behavior after .als load.
                if plugin_id == "internal://midi-fx/pitch" {
                    let semitones = maybe_parse_f64_manual(device, "Pitch").unwrap_or(0.0)
                        + maybe_parse_f64_manual(device, "PitchScaleDegrees").unwrap_or(0.0);
                    upsert_static_import_lane(track, "midi.pitch.semitones", semitones.clamp(-48.0, 48.0));
                } else if plugin_id == "internal://midi-fx/velocity" {
                    let gain = maybe_parse_f64_manual(device, "Drive")
                        .or_else(|| maybe_parse_f64_manual(device, "OutHi"))
                        .unwrap_or(1.0);
                    let offset = maybe_parse_f64_manual(device, "OutLow")
                        .or_else(|| maybe_parse_f64_manual(device, "Random"))
                        .unwrap_or(0.0);
                    upsert_static_import_lane(track, "midi.velocity.gain", gain.clamp(0.0, 4.0));
                    upsert_static_import_lane(track, "midi.velocity.offset", offset.clamp(-127.0, 127.0));
                } else if plugin_id == "internal://midi-fx/random" {
                    let chance = maybe_parse_f64_manual(device, "Chance")
                        .or_else(|| maybe_parse_f64_manual(device, "Probability"))
                        .unwrap_or(1.0);
                    let semitones = maybe_parse_f64_manual(device, "Choices")
                        .or_else(|| maybe_parse_f64_manual(device, "Scale"))
                        .unwrap_or(0.0);
                    upsert_static_import_lane(track, "midi.random.chance", chance.clamp(0.0, 1.0));
                    upsert_static_import_lane(track, "midi.random.semitones", semitones.clamp(-24.0, 24.0));
                } else if plugin_id == "internal://midi-fx/scale" {
                    let root = maybe_parse_f64_manual(device, "Base")
                        .or_else(|| maybe_parse_f64_manual(device, "Root"))
                        .or_else(|| maybe_parse_f64_manual(device, "Lowest"))
                        .unwrap_or(0.0);
                    upsert_static_import_lane(track, "midi.scale.root", root.rem_euclid(12.0));
                    // Default to chromatic mask if explicit map isn't parsed yet.
                    upsert_static_import_lane(track, "midi.scale.mask", 4095.0);
                }
            }
        } else {
            let slot = make_missing_plugin_slot("ableton-device", &display_name);
            if is_instrument_slot {
                track.instrument = Some(slot);
            } else {
                track.effects.push(slot);
            }
        }
    }
}

// ── Ableton Color Mapping ────────────────────────────────────────────────
//
// Ableton Live uses a 70-color palette indexed 0–69. We map each index to
// the nearest TrackColor variant. Unmapped / out-of-range indices fall back
// to `TrackColor::for_index(fallback)`.

fn ableton_color_to_track_color(index: i64, fallback: usize) -> TrackColor {
    match index {
        // Reds / Coral
        0 | 1 | 2 => TrackColor::Coral,
        // Oranges
        3 | 4 | 5 => TrackColor::Orange,
        // Golds
        6 | 7 => TrackColor::Gold,
        // Yellows
        8 | 9 => TrackColor::Yellow,
        // Limes
        10 | 11 | 12 => TrackColor::Lime,
        // Greens
        13 | 14 | 15 => TrackColor::Green,
        // Teals
        16 | 17 => TrackColor::Teal,
        // Cyans
        18 | 19 => TrackColor::Cyan,
        // Sky blues
        20 | 21 => TrackColor::Sky,
        // Blues
        22 | 23 | 24 => TrackColor::Blue,
        // Indigos
        25 | 26 => TrackColor::Indigo,
        // Purples
        27 | 28 | 29 => TrackColor::Purple,
        // Magentas
        30 | 31 => TrackColor::Magenta,
        // Pinks
        32 | 33 | 34 => TrackColor::Pink,
        // Roses
        35 | 36 | 37 => TrackColor::Rose,
        // Grays / Slates
        38..=69 => TrackColor::Slate,
        _ => TrackColor::for_index(fallback),
    }
}

// ── Automation Envelope Import ───────────────────────────────────────────
//
// Ableton stores automation targets as numeric `PointeeId`s inside `Mixer`
// and device `AutomationTarget Id="N"` nodes. The matching envelopes live
// in `<AutomationEnvelopes>/<Envelopes>/<AutomationEnvelope>` with a
// `<EnvelopeTarget>/<PointeeId Value="N"/>` linking back to the target.
//
// We build a PointeeId → param_id map, then parse FloatEvent envelopes.

fn build_pointee_map(track_node: roxmltree::Node<'_, '_>) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();

    // Named mixer parameters → well-known param IDs
    let mixer_params = [
        ("Volume", "volume"),
        ("Pan", "pan"),
        ("SplitStereoPanL", "pan_left"),
        ("SplitStereoPanR", "pan_right"),
        ("CrossFadeState", "mixer.crossfade_state"),
    ];

    // Locate the Mixer node
    let mixer = track_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("DeviceChain"))
        .and_then(|dc| dc.children().find(|n| n.is_element() && n.has_tag_name("Mixer")));

    if let Some(mixer) = mixer {
        for (tag, param_id) in &mixer_params {
            if let Some(param_node) = mixer.children().find(|n| n.is_element() && n.has_tag_name(*tag)) {
                if let Some(target) = param_node
                    .descendants()
                    .find(|n| n.is_element() && n.has_tag_name("AutomationTarget"))
                {
                    if let Some(id) = target.attribute("Id") {
                        map.insert(id.to_string(), param_id.to_string());
                    }
                }
            }
        }

        // Mixer boolean controls
        for (tag, lane) in [
            ("On", "mixer.on"),
            ("Speaker", "mixer.speaker"),
            ("Solo", "mixer.solo"),
            ("Arm", "mixer.arm"),
        ] {
            if let Some(node) = mixer.children().find(|n| n.is_element() && n.has_tag_name(tag)) {
                if let Some(target) = node.descendants().find(|n| n.is_element() && n.has_tag_name("AutomationTarget")) {
                    if let Some(id) = target.attribute("Id") {
                        map.insert(id.to_string(), lane.to_string());
                    }
                }
            }
        }

        // Send levels (SendA, SendB, etc.)
        for (idx, send) in mixer
            .descendants()
            .filter(|n| n.is_element() && n.has_tag_name("TrackSendHolder"))
            .enumerate()
        {
            if let Some(send_node) = send.children().find(|n| n.is_element() && n.has_tag_name("Send")) {
                if let Some(target) = send_node.descendants().find(|n| n.is_element() && n.has_tag_name("AutomationTarget")) {
                    if let Some(id) = target.attribute("Id") {
                        let send_letter = (b'A' + idx as u8) as char;
                        map.insert(id.to_string(), format!("send.{send_letter}"));
                    }
                }
            }
        }
    }

    // Device parameters: prefer explicit plugin parameter names/ids for PluginDevice.
    for (dev_idx, device) in collect_track_devices(track_node).iter().enumerate() {
        if !device.is_element() || !device.has_tag_name("PluginDevice") {
            continue;
        }

        let plugin_name_raw = infer_device_display_name(*device, "plugin");
        let plugin_key = normalize_plugin_key(&plugin_name_raw);

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

            let mut param_key = normalize_plugin_key(&param_name);
            if param_key.is_empty() {
                let maybe_numeric = param_id.parse::<i64>().ok();
                param_key = match maybe_numeric {
                    Some(v) if v >= 0 => format!("id{v}"),
                    _ => "unnamed".to_string(),
                };
            }

            let lane_key = format!("plugin:{dev_idx}:{plugin_key}:{param_key}");
            map.insert(target_id, lane_key);
        }
    }

    // Generic fallback for any remaining automation target IDs.
    for (dev_idx, device) in collect_track_devices(track_node).iter().enumerate() {
        for target in device
            .descendants()
            .filter(|n| n.is_element() && n.has_tag_name("AutomationTarget"))
        {
            if let Some(id) = target.attribute("Id") {
                if map.contains_key(id) {
                    continue; // Already mapped by mixer
                }
                let param_tag = target
                    .parent()
                    .and_then(|p| if p.is_element() { Some(p.tag_name().name().to_string()) } else { None })
                    .unwrap_or_else(|| "param".to_string());
                map.insert(id.to_string(), format!("device:{dev_idx}:{param_tag}"));
            }
        }
    }

    map
}

fn import_track_automation(
    track_node: roxmltree::Node<'_, '_>,
    track: &mut Track,
) {
    let pointee_map = build_pointee_map(track_node);

    // Walk all AutomationEnvelope elements on this track
    let envelopes_container = track_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("AutomationEnvelopes"))
        .and_then(|ae| ae.children().find(|n| n.is_element() && n.has_tag_name("Envelopes")));

    let Some(envelopes) = envelopes_container else {
        return;
    };

    for envelope in envelopes
        .children()
        .filter(|n| n.is_element() && n.has_tag_name("AutomationEnvelope"))
    {
        // Resolve param_id from PointeeId
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

        // Parse FloatEvent entries
        let mut points = Vec::new();
        for event in envelope
            .descendants()
            .filter(|n| n.is_element() && n.has_tag_name("FloatEvent"))
        {
            let time_beats = event
                .attribute("Time")
                .and_then(parse_f64_value)
                .unwrap_or(0.0);

            // Skip the Ableton sentinel value (negative infinity placeholder)
            if time_beats < -1_000_000.0 {
                continue;
            }

            let value = event
                .attribute("Value")
                .and_then(parse_f64_value)
                .unwrap_or(0.0);

            // Detect bezier curve controls
            let has_curve = event.attribute("CurveControl1X").is_some();
            let curve_type = if has_curve {
                "bezier".to_string()
            } else {
                "linear".to_string()
            };

            // Extract tension from bezier control points if present
            let tension = if has_curve {
                let c1y = event
                    .attribute("CurveControl1Y")
                    .and_then(parse_f64_value)
                    .unwrap_or(0.5);
                let c2y = event
                    .attribute("CurveControl2Y")
                    .and_then(parse_f64_value)
                    .unwrap_or(0.5);
                // Approximate tension from control points: 0 = linear, ±1 = extreme curve
                Some((c2y - c1y).clamp(-1.0, 1.0))
            } else {
                None
            };

            points.push(dream_models::project::AutomationPoint {
                beat: time_beats,
                value,
                curve_type,
                tension,
            });
        }

        if points.is_empty() {
            continue;
        }

        // Sort by beat position
        points.sort_by(|a, b| a.beat.partial_cmp(&b.beat).unwrap_or(std::cmp::Ordering::Equal));

        track.automation_lanes.push(dream_models::project::AutomationLane {
            param_id,
            points,
        });
    }
}

fn consolidate_automation_lanes(track: &mut Track) {
    use std::collections::HashMap;

    let mut merged: HashMap<String, Vec<dream_models::project::AutomationPoint>> = HashMap::new();
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
        out.push(dream_models::project::AutomationLane { param_id, points });
    }
    out.sort_by(|a, b| a.param_id.cmp(&b.param_id));
    track.automation_lanes = out;
}

fn import_als_project(file_path: &Path) -> Result<Project, String> {
    use std::io::Read;

    let bytes = std::fs::read(file_path).map_err(|e| format!("Failed to read ALS file '{}': {e}", file_path.display()))?;
    let xml_bytes = {
        let mut decoder = flate2::read::GzDecoder::new(&bytes[..]);
        let mut inflated = Vec::new();
        match decoder.read_to_end(&mut inflated) {
            Ok(_) if !inflated.is_empty() => inflated,
            _ => bytes,
        }
    };
    let xml_text = std::str::from_utf8(&xml_bytes)
        .map_err(|e| format!("ALS is not valid UTF-8 XML: {e}"))?;
    let doc = roxmltree::Document::parse(xml_text)
        .map_err(|e| format!("Failed to parse ALS XML: {e}"))?;

    let live_set = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("LiveSet"))
        .ok_or("ALS parse error: <LiveSet> node not found")?;

    let tempo = live_set
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
        .unwrap_or(120.0);

    let project_name = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("Imported Ableton Project")
        .to_string();
    let sample_rate = 44100.0;
    let mut project = Project::new(project_name, tempo, sample_rate);
    project.tracks.clear();
    project.markers = parse_project_markers(live_set);
    project.session_scenes = parse_project_scenes(live_set);
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
    if let Some(v) = first_child_f64(live_set, "SelectedBreakpointValue")
        .filter(|v| v.is_finite())
    {
        project.selected_breakpoint_value = v;
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
        if let Some(v) = first_child_f64(transport, "PhaseNudgeTempo")
            .filter(|v| v.is_finite())
        {
            project.transport_phase_nudge_tempo = v;
        }
        if let Some(current_time_beats) = first_child_f64(transport, "CurrentTime")
            .filter(|v| v.is_finite() && *v >= 0.0)
        {
            project.playhead_position_frames = beats_to_frames(current_time_beats, tempo, sample_rate);
        }
        let loop_on = first_child_bool(transport, "LoopOn").unwrap_or(false);
        let loop_start_beats = first_child_f64(transport, "LoopStart").unwrap_or(0.0).max(0.0);
        let loop_length_beats = first_child_f64(transport, "LoopLength").unwrap_or(0.0).max(0.0);
        project.is_looping = loop_on;
        project.loop_start_frames = Some(beats_to_frames(loop_start_beats, tempo, sample_rate));
        project.loop_end_frames = Some(beats_to_frames(loop_start_beats + loop_length_beats, tempo, sample_rate));
        if let Some(v) = first_child_bool(transport, "PunchIn") {
            project.punch_in_enabled = v;
        }
        if let Some(v) = first_child_bool(transport, "PunchOut") {
            project.punch_out_enabled = v;
        }
        if let Some(v) = first_child_f64(transport, "MetronomeTickDuration")
            .filter(|v| v.is_finite())
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

    // Import arrangement/editor grid settings (prefer LiveSet root grid).
    if let Some((num, den, ntoles, snap, fixed)) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Grid"))
        .and_then(parse_clip_grid)
        .or_else(|| live_set
        .descendants()
        .filter(|n| n.is_element() && (n.has_tag_name("AudioClip") || n.has_tag_name("MidiClip")))
        .find_map(parse_clip_grid))
    {
        project.arrangement_grid_numerator = num;
        project.arrangement_grid_denominator = den;
        project.arrangement_grid_ntoles = ntoles;
        project.arrangement_snap_to_grid = snap;
        project.arrangement_grid_fixed = fixed;
    }

    // Import project key signature hint (prefer LiveSet root scale info).
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
    // ── Component 2: Time Signature Import ─────────────────────────────
    if let Some(main_track) = live_set.descendants().find(|n| n.is_element() && n.has_tag_name("MainTrack")) {
        // Ableton stores time signature inside MainTrack > TimeSignature
        if let Some(ts_node) = main_track.descendants().find(|n| n.is_element() && n.has_tag_name("TimeSignature")) {
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
    }

    let external_plugins = ExternalPluginIndex::build();

    let tracks_node = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Tracks"))
        .or_else(|| live_set.descendants().find(|n| n.is_element() && n.has_tag_name("Tracks")))
        .ok_or("ALS parse error: <Tracks> node not found")?;

    let mut xml_id_to_uuid = std::collections::HashMap::<String, Uuid>::new();
    let mut pending_group_refs = Vec::<(Uuid, String)>::new();
    let mut pending_output_refs = Vec::<(Uuid, String)>::new();
    let mut pending_group_output_fallback = Vec::<Uuid>::new();

    for (index, track_node) in tracks_node.children().filter(|n| n.is_element()).enumerate() {
        let tag = track_node.tag_name().name();
        // ── Component 3: ReturnTrack imported as Audio ──────────────────
        let track_type = match tag {
            "AudioTrack" | "ReturnTrack" => TrackType::Audio,
            "MidiTrack" => TrackType::Midi,
            "GroupTrack" => TrackType::Group,
            _ => continue,
        };
        let is_return_track = tag == "ReturnTrack";

        let track_name = track_node
            .children()
            .find(|n| n.is_element() && n.has_tag_name("Name"))
            .and_then(|name| {
                name.descendants()
                    .find(|n| n.is_element() && n.has_tag_name("EffectiveName"))
                    .and_then(|n| n.attribute("Value"))
            })
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("{tag} {}", index + 1));

        // Prefix return tracks for clarity
        let track_name = if is_return_track && !track_name.starts_with("(Return)") {
            format!("(Return) {track_name}")
        } else {
            track_name
        };

        let mut track = Track::with_type(track_name, track_type, index);
        let mut static_send_values = Vec::<(usize, f64)>::new();
        let mut static_mixer_values = Vec::<(String, f64)>::new();

        // ── Component 4: Ableton Color Index Mapping ──────────────────
        if let Some(color_value) = node_child_value(track_node, "Color")
            .as_deref()
            .and_then(parse_i64_value)
        {
            track.color = ableton_color_to_track_color(color_value, index);
        }

        if let Some(mixer) = track_node
            .children()
            .find(|n| n.is_element() && n.has_tag_name("DeviceChain"))
            .and_then(|dc| dc.children().find(|n| n.is_element() && n.has_tag_name("Mixer")))
        {
            if let Some(volume) = maybe_parse_f64_manual(mixer, "Volume") {
                track.volume = volume.clamp(0.0, 2.0);
            }
            if let Some(pan) = maybe_parse_f64_manual(mixer, "Pan") {
                track.pan = pan.clamp(-1.0, 1.0);
            }
            let on = maybe_parse_bool_manual(mixer, "On");
            let speaker = maybe_parse_bool_manual(mixer, "Speaker");
            track.is_mute = on == Some(false) || speaker == Some(false);
            let solo = maybe_parse_bool_manual(mixer, "Solo")
                .or_else(|| node_child_value(mixer, "SoloSink").as_deref().and_then(parse_bool_value))
                .unwrap_or(false);
            let armed = maybe_parse_bool_manual(mixer, "Arm").unwrap_or(false);
            track.is_solo = solo;
            track.is_armed = armed;
            if let Some(on) = on {
                static_mixer_values.push(("mixer.on".to_string(), if on { 1.0 } else { 0.0 }));
            }
            if let Some(speaker) = speaker {
                static_mixer_values.push(("mixer.speaker".to_string(), if speaker { 1.0 } else { 0.0 }));
            }
            static_mixer_values.push(("mixer.solo".to_string(), if solo { 1.0 } else { 0.0 }));
            static_mixer_values.push(("mixer.arm".to_string(), if armed { 1.0 } else { 0.0 }));
            if let Some(crossfade_state) = maybe_parse_f64_manual(mixer, "CrossFadeState") {
                static_mixer_values.push((
                    "mixer.crossfade_state".to_string(),
                    crossfade_state.clamp(0.0, 2.0),
                ));
            }
            static_send_values = parse_track_send_manual_values(mixer);
        }
        if let Some(monitoring_mode) = node_child_value(track_node, "MonitoringEnum")
            .as_deref()
            .and_then(parse_i64_value)
            .map(|v| v.clamp(0, 2) as f64)
        {
            static_mixer_values.push(("mixer.monitoring_mode".to_string(), monitoring_mode));
        }

        import_track_devices(track_node, &mut track, &external_plugins, file_path);
        import_track_clips(track_node, &mut track, file_path, tempo, sample_rate);
        import_track_automation(track_node, &mut track);
        for (send_idx, send_value) in static_send_values {
            if send_idx >= 26 {
                continue;
            }
            let send_letter = (b'A' + send_idx as u8) as char;
            upsert_static_import_lane_if_missing(&mut track, &format!("send.{send_letter}"), send_value);
        }
        for (param_id, value) in static_mixer_values {
            upsert_static_import_lane_if_missing(&mut track, &param_id, value);
        }
        consolidate_automation_lanes(&mut track);

        if track_type == TrackType::Midi && track.instrument.is_none() {
            track.instrument = Some(make_missing_plugin_slot("instrument", "Ableton Instrument"));
            if track.sampler.is_none() {
                track.sampler = Some(SamplerConfig::default());
            }
        }

        if let Some(xml_id) = track_node.attribute("Id")
            && !xml_id.trim().is_empty()
        {
            xml_id_to_uuid.insert(xml_id.to_string(), track.id);
        }

        if let Some(group_ref) = node_child_value(track_node, "TrackGroupId")
            && !group_ref.trim().is_empty()
            && group_ref.trim() != "-1"
            && group_ref.trim() != "0"
        {
            pending_group_refs.push((track.id, group_ref));
        }

        let preferred_output_target = if track_type == TrackType::Midi {
            parse_output_target(track_node, "MidiOutputRouting")
                .or_else(|| parse_output_target(track_node, "AudioOutputRouting"))
        } else {
            parse_output_target(track_node, "AudioOutputRouting")
        };
        if let Some(target) = preferred_output_target {
            if let Some(xml_target_id) = parse_target_track_xml_id(&target) {
                pending_output_refs.push((track.id, xml_target_id));
            } else if target.eq_ignore_ascii_case("AudioOut/GroupTrack") {
                pending_group_output_fallback.push(track.id);
            }
        }

        project.add_track(track);
    }

    for (child_id, parent_xml_id) in pending_group_refs {
        let Some(parent_id) = xml_id_to_uuid.get(parent_xml_id.trim()).copied() else {
            continue;
        };
        if let Some(child_track) = project.find_track_mut(child_id) {
            child_track.parent_track_id = Some(parent_id);
        }
        if let Some(parent_track) = project.find_track_mut(parent_id)
            && !parent_track.child_track_ids.contains(&child_id)
        {
            parent_track.child_track_ids.push(child_id);
        }
    }

    for (track_id, output_xml_id) in pending_output_refs {
        let Some(dest_id) = xml_id_to_uuid.get(output_xml_id.trim()).copied() else {
            continue;
        };
        if let Some(track) = project.find_track_mut(track_id) {
            track.output_destination_id = Some(dest_id);
        }
    }
    for track_id in pending_group_output_fallback {
        let parent_id = project.find_track(track_id).and_then(|t| t.parent_track_id);
        if let Some(parent_id) = parent_id
            && let Some(track) = project.find_track_mut(track_id)
            && track.output_destination_id.is_none()
        {
            track.output_destination_id = Some(parent_id);
        }
    }

    if let Some(main_track) = live_set.descendants().find(|n| n.is_element() && n.has_tag_name("MainTrack")) {
        import_track_devices(main_track, &mut project.master_track, &external_plugins, file_path);
        import_track_automation(main_track, &mut project.master_track);
        consolidate_automation_lanes(&mut project.master_track);
    }

    normalize_internal_plugins_for_import(&mut project);

    // ── Component 5: Sample Consolidation ─────────────────────────────
    //
    // Copy referenced audio samples into the Ableton project folder's
    // Samples/Imported/ directory so that clip paths remain valid even
    // if the original sample sources are moved or deleted. Non-fatal —
    // failures are logged but do not block the import.
    if let Some(project_dir) = file_path.parent() {
        let imported_dir = project_dir.join("Samples").join("Imported");
        if let Err(e) = std::fs::create_dir_all(&imported_dir) {
            log::warn!(
                "Could not create Samples/Imported directory for ALS import: {e}"
            );
        } else {
            // Copy each clip's source file into Samples/Imported/
            let mut rewrites = Vec::new();
            for track in &project.tracks {
                for clip in &track.clips {
                    let src = Path::new(&clip.file_path);
                    if !src.exists() || clip.file_path.trim().is_empty() {
                        continue;
                    }
                    if let Some(file_name) = src.file_name() {
                        let dest = imported_dir.join(file_name);
                        if !dest.exists() {
                            if let Err(e) = std::fs::copy(src, &dest) {
                                log::warn!(
                                    "Sample consolidation: failed to copy '{}': {e}",
                                    src.display()
                                );
                                continue;
                            }
                        }
                        rewrites.push((
                            track.id,
                            clip.file_path.clone(),
                            dest.to_string_lossy().to_string(),
                        ));
                    }
                }
            }

            // Rewrite clip paths to the consolidated location
            for (track_id, old_path, new_path) in rewrites {
                if let Some(track) = project.find_track_mut(track_id) {
                    for clip in &mut track.clips {
                        if clip.file_path == old_path {
                            clip.file_path = new_path.clone();
                        }
                    }
                }
            }

            log::info!(
                "ALS import: samples consolidated to '{}'",
                imported_dir.display()
            );
        }
    }

    Ok(project)
}

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
    rebuild_runtime_device_chains_from_project(&new, &handle)?;
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

    let importing_als = file_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("als"))
        .unwrap_or(false);

    let mut loaded = if importing_als {
        import_als_project(&file_path)?
    } else {
        let mut project = ProjectFile::load(&file_path).map_err(|e| e.to_string())?;
        normalize_internal_plugins_for_import(&mut project);
        project
    };
    refresh_offline_flags(&mut loaded);

    *project_state.project.lock().map_err(|e| e.to_string())? = loaded.clone();
    *project_state.file_path.lock().map_err(|e| e.to_string())? = if importing_als {
        None
    } else {
        Some(file_path.clone())
    };
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = importing_als;
    *project_state.undo.lock().map_err(|e| e.to_string())? = UndoState::new();
    clip_pool_state.rebuild_snapshot(&loaded);
    clip_pool_state.load_project_clips(&loaded);
    rebuild_automation_snapshot_from_project(&loaded, &automation_runtime);
    rebuild_midi_snapshot_from_project(&loaded, &handle);
    rebuild_sampler_snapshot_from_project(&loaded, &clip_pool_state, &handle);
    rebuild_runtime_device_chains_from_project(&loaded, &handle)?;
    sync_transport_from_project(&loaded, &handle)?;

    // Derive project folder from file path
    let folder = if importing_als {
        file_path.parent().map(|p| p.to_path_buf())
    } else {
        ProjectManager::folder_from_file(&file_path)
    };
    *project_state.project_folder.lock().map_err(|e| e.to_string())? = folder;

    // Track in recent projects
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let mut recent = RecentProjects::load(&app_data_dir);
        recent.add(loaded.name.clone(), path);
        let _ = recent.save(&app_data_dir);
    }

    // Update window title
    if let Some(window) = app.get_webview_window("main") {
        if importing_als {
            let _ = window.set_title(&format!("Dream DAW — {}*", loaded.name));
        } else {
            let _ = window.set_title(&format!("Dream DAW — {}", loaded.name));
        }
    }

    if importing_als {
        log::info!(
            "Ableton project imported: '{}' ({} tracks) from {}",
            loaded.name,
            loaded.track_count(),
            file_path.display()
        );
    } else {
        log::info!("Project opened: '{}' ({} tracks)", loaded.name, loaded.track_count());
    }
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

/// Persists arrangement/editor grid settings in the project.
#[tauri::command]
fn set_arrangement_grid_cmd(
    numerator: u16,
    denominator: u16,
    ntoles: u8,
    snap_to_grid: bool,
    fixed: bool,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let numerator = numerator.max(1);
    let denominator = denominator.max(1);
    let ntoles = ntoles.max(1);

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    project.arrangement_grid_numerator = numerator;
    project.arrangement_grid_denominator = denominator;
    project.arrangement_grid_ntoles = ntoles;
    project.arrangement_snap_to_grid = snap_to_grid;
    project.arrangement_grid_fixed = fixed;
    let name = project.name.clone();
    drop(project);

    project_state.mark_dirty(&name, Some(&app))?;
    Ok(())
}
