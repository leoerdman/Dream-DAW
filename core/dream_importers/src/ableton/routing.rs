// ═══════════════════════════════════════════════════════════════════════
// Dream DAW — Ableton ALS Routing Helpers
// ═══════════════════════════════════════════════════════════════════════
//
// Parses and classifies Ableton's output/input routing targets
// from ALS XML nodes.
//
// ═══════════════════════════════════════════════════════════════════════

use dream_models::project::TrackType;

use super::xml_helpers::*;

// ── Output Routing Classification ──────────────────────────────────────

pub enum OutputRoutingTarget {
    TrackXmlId(String),
    GroupFallback,
    Master,
    None,
    Unknown,
}

pub fn classify_output_routing_target(target: &str) -> OutputRoutingTarget {
    let t = target.trim();
    if t.is_empty() {
        return OutputRoutingTarget::Unknown;
    }
    let low = t.to_ascii_lowercase();
    if low.ends_with("/none") || low.contains("no output") || low.contains("nooutput") {
        return OutputRoutingTarget::None;
    }
    if low.ends_with("/main") || low == "main" || low == "master" {
        return OutputRoutingTarget::Master;
    }
    if low.ends_with("/grouptrack") {
        return OutputRoutingTarget::GroupFallback;
    }
    if let Some(xml_id) = parse_target_track_xml_id(t) {
        return OutputRoutingTarget::TrackXmlId(xml_id);
    }
    OutputRoutingTarget::Unknown
}

// ── Target Track ID Extraction ─────────────────────────────────────────

pub fn parse_target_track_xml_id(target: &str) -> Option<String> {
    for segment in target.split('/') {
        let segment = segment.trim();
        let Some((kind, id)) = segment.split_once('.') else {
            continue;
        };
        let kind_norm = kind.trim().to_ascii_lowercase();
        if !["track", "audiotrack", "miditrack", "returntrack", "grouptrack"]
            .contains(&kind_norm.as_str())
        {
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

// ── Output Target Parsing ──────────────────────────────────────────────

pub fn parse_output_target(
    track_node: roxmltree::Node<'_, '_>,
    routing_tag: &str,
) -> Option<String> {
    fn clean(v: Option<&str>) -> Option<String> {
        v.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
    }

    let routing_node = track_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("DeviceChain"))
        .and_then(|dc| {
            dc.children()
                .find(|n| n.is_element() && n.has_tag_name(routing_tag))
                .or_else(|| {
                    dc.descendants()
                        .find(|n| n.is_element() && n.has_tag_name(routing_tag))
                })
        })
        .or_else(|| {
            track_node
                .children()
                .find(|n| n.is_element() && n.has_tag_name(routing_tag))
                .or_else(|| {
                    track_node
                        .descendants()
                        .find(|n| n.is_element() && n.has_tag_name(routing_tag))
                })
        });
    let Some(routing) = routing_node else {
        return None;
    };

    // Strategy 1: <Target><Value Value="..." /></Target>
    if let Some(target_val) = routing
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Target"))
        .and_then(|t| t.attribute("Value"))
    {
        if let Some(result) = clean(Some(target_val)) {
            return Some(result);
        }
    }

    // Strategy 2: <UpperDisplayString Value="..." />
    if let Some(display) = first_child_value(routing, "UpperDisplayString") {
        if let Some(result) = clean(Some(&display)) {
            return Some(result);
        }
    }

    // Strategy 3: <LowerDisplayString Value="..." />
    if let Some(display) = first_child_value(routing, "LowerDisplayString") {
        if let Some(result) = clean(Some(&display)) {
            return Some(result);
        }
    }

    None
}

// ── Output Target Preference ───────────────────────────────────────────

pub fn choose_preferred_output_target(
    track_type: TrackType,
    audio_output: Option<String>,
    midi_output: Option<String>,
) -> Option<String> {
    match track_type {
        TrackType::Midi => audio_output.or(midi_output),
        _ => audio_output.or(midi_output),
    }
}

// ── Pan Collapse ───────────────────────────────────────────────────────

pub fn collapse_split_stereo_pan(pan_left: Option<f64>, pan_right: Option<f64>) -> Option<f64> {
    match (pan_left, pan_right) {
        (Some(l), Some(r)) => Some(((l + r) * 0.5).clamp(-1.0, 1.0)),
        (Some(l), None) => Some(l.clamp(-1.0, 1.0)),
        (None, Some(r)) => Some(r.clamp(-1.0, 1.0)),
        (None, None) => None,
    }
}

// ── Input Routing ──────────────────────────────────────────────────────

pub fn normalize_input_routing_target(raw: &str) -> Option<String> {
    let v = raw.trim();
    if v.is_empty() {
        return None;
    }
    let low = v.to_ascii_lowercase();
    if low.contains("noinput")
        || low.contains("no_input")
        || low.contains("no input")
        || low.ends_with("/none")
    {
        return None;
    }
    Some(v.to_string())
}
