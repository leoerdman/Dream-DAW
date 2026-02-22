// ═══════════════════════════════════════════════════════════════════════
// Low-level roxmltree XML value extraction utilities
// ═══════════════════════════════════════════════════════════════════════
//
// These are small, pure helper functions for extracting typed values
// from Ableton Live Set XML nodes. Used throughout the ALS parser.
// ═══════════════════════════════════════════════════════════════════════

pub fn parse_bool_value(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

pub fn parse_f64_value(raw: &str) -> Option<f64> {
    raw.trim().parse::<f64>().ok()
}

pub fn parse_i64_value(raw: &str) -> Option<i64> {
    raw.trim().parse::<i64>().ok()
}

pub fn beats_to_frames(beats: f64, bpm: f64, sample_rate: f64) -> i64 {
    if !beats.is_finite() || !bpm.is_finite() || !sample_rate.is_finite() || bpm <= 0.0 || sample_rate <= 0.0 {
        return 0;
    }
    let safe_bpm = bpm.max(0.001);
    let frames = ((beats * 60.0 / safe_bpm) * sample_rate).round();

    if frames >= i64::MAX as f64 {
        i64::MAX
    } else if frames <= i64::MIN as f64 {
        i64::MIN
    } else {
        frames as i64
    }
}

pub fn node_child_value(node: roxmltree::Node<'_, '_>, child_tag: &str) -> Option<String> {
    node.children()
        .find(|c| c.is_element() && c.has_tag_name(child_tag))
        .and_then(|n| n.attribute("Value"))
        .map(|s| s.to_string())
}

pub fn node_manual_value(node: roxmltree::Node<'_, '_>, param_tag: &str) -> Option<String> {
    node.children()
        .find(|c| c.is_element() && c.has_tag_name(param_tag))
        .and_then(|param| {
            param.children()
                .find(|child| child.is_element() && child.has_tag_name("Manual"))
        })
        .and_then(|manual| manual.attribute("Value"))
        .map(|s| s.to_string())
}

pub fn maybe_parse_f64_manual(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<f64> {
    node_manual_value(node, tag).as_deref().and_then(parse_f64_value)
}

pub fn maybe_parse_bool_manual(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<bool> {
    node_manual_value(node, tag).as_deref().and_then(parse_bool_value)
}

pub fn first_child_value(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<String> {
    node.children()
        .find(|c| c.is_element() && c.has_tag_name(tag))
        .and_then(|n| n.attribute("Value"))
        .map(|s| s.to_string())
}

pub fn first_child_f64(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<f64> {
    first_child_value(node, tag).as_deref().and_then(parse_f64_value)
}

pub fn first_child_i32(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<i32> {
    first_child_value(node, tag)
        .as_deref()
        .and_then(parse_i64_value)
        .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32)
}

pub fn first_child_bool(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<bool> {
    first_child_value(node, tag).as_deref().and_then(parse_bool_value)
}

pub fn descendant_value(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<String> {
    node.descendants()
        .find(|n| n.is_element() && n.has_tag_name(tag))
        .and_then(|n| n.attribute("Value"))
        .map(|s| s.to_string())
}

pub fn parse_live_set_bool(live_set: roxmltree::Node<'_, '_>, tag: &str) -> Option<bool> {
    first_child_value(live_set, tag)
        .or_else(|| descendant_value(live_set, tag))
        .as_deref()
        .and_then(parse_bool_value)
}

pub fn parse_live_set_i32(live_set: roxmltree::Node<'_, '_>, tag: &str) -> Option<i32> {
    first_child_value(live_set, tag)
        .or_else(|| descendant_value(live_set, tag))
        .as_deref()
        .and_then(parse_i64_value)
        .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32)
}

pub fn parse_view_states_bool(live_set: roxmltree::Node<'_, '_>, tag: &str) -> Option<bool> {
    live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("ViewStates"))
        .and_then(|view_states| first_child_bool(view_states, tag))
}

pub fn direct_manual_value(node: roxmltree::Node<'_, '_>) -> Option<String> {
    node.children()
        .find(|c| c.is_element() && c.has_tag_name("Manual"))
        .and_then(|manual| manual.attribute("Value"))
        .map(|s| s.to_string())
}
