// ═══════════════════════════════════════════════════════════════════════
// Dream DAW — Ableton ALS XML Parsing Helpers
// ═══════════════════════════════════════════════════════════════════════
//
// Low-level XML DOM traversal utilities for roxmltree nodes.
// These are reused across every ALS import sub-module.
//
// ═══════════════════════════════════════════════════════════════════════

// ── Ableton Volume Conversion ──────────────────────────────────────────

/// Ableton Live unity gain reference point.
///
/// In ALS XML, `<Volume><Manual Value="0.85"/></Volume>` corresponds to
/// the fader at 0 dB (unity). Dream DAW uses 1.0 as unity.
///
/// Conversion: `dream_gain = ableton_vol / ABLETON_UNITY_GAIN`
///
/// Reference values:
///   Ableton 0.0    → -∞ dB  (silent)
///   Ableton 0.85   → 0 dB   (unity)
///   Ableton 1.0    → ~+1.4 dB
///   Ableton 1.413  → ~+4.4 dB (max Ableton slider)
const ABLETON_UNITY_GAIN: f64 = 0.85;

/// Converts an Ableton ALS XML volume value to Dream DAW linear gain.
///
/// Ableton stores volume fader values in its own linear scale where
/// 0.85 = 0 dB (unity). Dream DAW uses 1.0 = 0 dB (standard linear gain).
///
/// This function rescales the Ableton value so that 0.85 → 1.0,
/// and clamps the result to a safe range [0.0, 4.0] (+12 dB max).
#[inline]
pub fn ableton_volume_to_linear_gain(ableton_vol: f64) -> f64 {
    if ableton_vol <= 0.0 {
        return 0.0;
    }
    (ableton_vol / ABLETON_UNITY_GAIN).clamp(0.0, 4.0)
}

// ── Scalar Value Parsers ───────────────────────────────────────────────

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

// ── Beat ⟷ Frame Conversion ────────────────────────────────────────────

pub fn beats_to_frames(beats: f64, bpm: f64, sample_rate: f64) -> i64 {
    if !beats.is_finite()
        || !bpm.is_finite()
        || !sample_rate.is_finite()
        || bpm <= 0.0
        || sample_rate <= 0.0
    {
        return 0;
    }
    let safe_bpm = bpm.max(0.001);
    let frames = ((beats * 60.0 / safe_bpm) * sample_rate).round();

    // BUG-067 FIX: Clamp to prevent overflow during cast to i64.
    if frames >= i64::MAX as f64 {
        i64::MAX
    } else if frames <= i64::MIN as f64 {
        i64::MIN
    } else {
        frames as i64
    }
}

// ── Node Value Extraction ──────────────────────────────────────────────

/// Reads `<child_tag Value="..." />` from a parent node.
pub fn node_child_value(node: roxmltree::Node<'_, '_>, child_tag: &str) -> Option<String> {
    node.children()
        .find(|c| c.is_element() && c.has_tag_name(child_tag))
        .and_then(|n| n.attribute("Value"))
        .map(|s| s.to_string())
}

/// Reads `<param_tag><Manual Value="..." /></param_tag>` from a parent node.
pub fn node_manual_value(node: roxmltree::Node<'_, '_>, param_tag: &str) -> Option<String> {
    node.children()
        .find(|c| c.is_element() && c.has_tag_name(param_tag))
        .and_then(|param| {
            param
                .children()
                .find(|child| child.is_element() && child.has_tag_name("Manual"))
        })
        .and_then(|manual| manual.attribute("Value"))
        .map(|s| s.to_string())
}

/// Reads `<Manual Value="..." />` directly from the node.
pub fn direct_manual_value(node: roxmltree::Node<'_, '_>) -> Option<String> {
    node.children()
        .find(|c| c.is_element() && c.has_tag_name("Manual"))
        .and_then(|manual| manual.attribute("Value"))
        .map(|s| s.to_string())
}

pub fn maybe_parse_f64_manual(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<f64> {
    node_manual_value(node, tag)
        .as_deref()
        .and_then(parse_f64_value)
}

pub fn maybe_parse_bool_manual(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<bool> {
    node_manual_value(node, tag)
        .as_deref()
        .and_then(parse_bool_value)
}

// ── First-Child Convenience Wrappers ───────────────────────────────────

pub fn first_child_value(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<String> {
    node.children()
        .find(|c| c.is_element() && c.has_tag_name(tag))
        .and_then(|n| n.attribute("Value"))
        .map(|s| s.to_string())
}

pub fn first_child_f64(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<f64> {
    first_child_value(node, tag)
        .as_deref()
        .and_then(parse_f64_value)
}

pub fn first_child_i32(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<i32> {
    first_child_value(node, tag)
        .as_deref()
        .and_then(parse_i64_value)
        .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32)
}

pub fn first_child_bool(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<bool> {
    first_child_value(node, tag)
        .as_deref()
        .and_then(parse_bool_value)
}

// ── Descendant Helpers ─────────────────────────────────────────────────

pub fn descendant_value(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<String> {
    node.descendants()
        .find(|n| n.is_element() && n.has_tag_name(tag))
        .and_then(|n| n.attribute("Value"))
        .map(|s| s.to_string())
}

// ── LiveSet-Level Helpers ──────────────────────────────────────────────

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

// ── Music Theory Helpers ───────────────────────────────────────────────

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

// ── MIDI Editor Lane Parsing ───────────────────────────────────────────

pub fn parse_root_midi_editor_lanes(
    live_set: roxmltree::Node<'_, '_>,
    root_tag: &str,
) -> Vec<dream_models::project::MidiEditorLaneState> {
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
        out.push(dream_models::project::MidiEditorLaneState {
            id,
            lane_type,
            size,
            is_minimized,
        });
    }
    out.sort_by_key(|lane| lane.id);
    out
}

// ── Track-Level Helpers ────────────────────────────────────────────────

pub fn parse_track_send_manual_values(mixer: roxmltree::Node<'_, '_>) -> Vec<(usize, f64)> {
    parse_track_send_full(mixer)
        .into_iter()
        .map(|(idx, value, _, _)| (idx, value))
        .collect()
}

/// ENTERPRISE: Full send data extraction including pre/post fader and active state.
/// Returns Vec of (index, value, is_pre_fader, is_active).
///
/// Ableton XML structure:
/// ```xml
/// <TrackSendHolder Id="0">
///   <Send><Manual Value="0.5"/></Send>
///   <SendPreBool Value="true"/>
///   <Active Value="true"/>
/// </TrackSendHolder>
/// ```
pub fn parse_track_send_full(mixer: roxmltree::Node<'_, '_>) -> Vec<(usize, f64, bool, bool)> {
    let mut sends = Vec::new();
    for (seq_idx, holder) in mixer
        .descendants()
        .filter(|n| n.is_element() && n.has_tag_name("TrackSendHolder"))
        .enumerate()
    {
        let idx = holder
            .attribute("Id")
            .and_then(parse_i64_value)
            .filter(|v| *v >= 0)
            .map(|v| v as usize)
            .unwrap_or(seq_idx);

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

        // Pre/post fader: Ableton stores <SendPreBool Value="true/false"/>
        // true = pre-fader send, false = post-fader send (default)
        let is_pre_fader = holder
            .children()
            .find(|n| n.is_element() && n.has_tag_name("SendPreBool"))
            .and_then(|n| n.attribute("Value"))
            .and_then(parse_bool_value)
            .unwrap_or(false);

        // Active state: Ableton stores <Active Value="true/false"/>
        // Controls whether this send is enabled at all
        let is_active = holder
            .children()
            .find(|n| n.is_element() && n.has_tag_name("Active"))
            .and_then(|n| n.attribute("Value"))
            .and_then(parse_bool_value)
            .unwrap_or(true);

        sends.push((idx, value, is_pre_fader, is_active));
    }
    sends
}

/// Returns `true` if the tag is a device-chain-like container.
/// Ableton Live ≤11 uses `InsertEffectsChain`, Live 12+ uses `DeviceChain`.
#[inline]
pub fn is_device_chain_tag(tag: &str) -> bool {
    tag == "InsertEffectsChain" || tag == "DeviceChain"
}

pub fn parse_track_bool_flag(track_node: roxmltree::Node<'_, '_>, tag: &str) -> Option<bool> {
    track_node
        .children()
        .find(|n| n.is_element() && is_device_chain_tag(n.tag_name().name()))
        .and_then(|dc| {
            dc.children()
                .find(|n| n.is_element() && n.has_tag_name("Mixer"))
                .or_else(|| {
                    dc.descendants()
                        .find(|n| n.is_element() && n.has_tag_name("Mixer"))
                })
        })
        .and_then(|mixer| maybe_parse_bool_manual(mixer, tag))
        .or_else(|| maybe_parse_bool_manual(track_node, tag))
}

pub fn parse_track_key_note_target(track_node: roxmltree::Node<'_, '_>) -> Option<u8> {
    // ENTERPRISE FIX: Was reading "CrossFadeState" (crossfader A/B, 0-2)
    // instead of "KeyNoteTarget" (MIDI root note, 0-127). This caused
    // sampler root notes to be completely wrong for imported instruments.
    track_node
        .children()
        .find(|n| n.is_element() && is_device_chain_tag(n.tag_name().name()))
        .and_then(|dc| {
            dc.children()
                .find(|n| n.is_element() && n.has_tag_name("Mixer"))
                .or_else(|| {
                    dc.descendants()
                        .find(|n| n.is_element() && n.has_tag_name("Mixer"))
                })
        })
        .and_then(|mixer| maybe_parse_f64_manual(mixer, "KeyNoteTarget"))
        .map(|v| v.clamp(0.0, 127.0) as u8)
}

pub fn parse_track_i64_value(track_node: roxmltree::Node<'_, '_>, tag: &str) -> Option<i64> {
    track_node
        .children()
        .find(|n| n.is_element() && is_device_chain_tag(n.tag_name().name()))
        .and_then(|dc| {
            dc.children()
                .find(|n| n.is_element() && n.has_tag_name("Mixer"))
                .or_else(|| {
                    dc.descendants()
                        .find(|n| n.is_element() && n.has_tag_name("Mixer"))
                })
        })
        .and_then(|mixer| node_manual_value(mixer, tag))
        .as_deref()
        .and_then(parse_i64_value)
}

// ── Broad Track Value Parsers (ALS import compatibility) ──────────────

/// Broad descendant-search bool parser for ALS import.
/// Searches direct child `<Tag Value="...">` first, then any descendant.
/// Use this for ALS import where XML structure varies across versions.
pub fn parse_track_bool_flag_broad(
    track_node: roxmltree::Node<'_, '_>,
    tag: &str,
) -> Option<bool> {
    node_child_value(track_node, tag)
        .or_else(|| {
            track_node
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name(tag))
                .and_then(|n| n.attribute("Value"))
                .map(ToString::to_string)
        })
        .as_deref()
        .and_then(parse_bool_value)
}

/// Broad descendant-search key note parser for ALS import.
pub fn parse_track_key_note_target_broad(track_node: roxmltree::Node<'_, '_>) -> Option<u8> {
    node_child_value(track_node, "KeyNoteTarget")
        .or_else(|| {
            track_node
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("KeyNoteTarget"))
                .and_then(|n| n.attribute("Value"))
                .map(ToString::to_string)
        })
        .as_deref()
        .and_then(parse_i64_value)
        .map(|v| v.clamp(0, 127) as u8)
}

/// Broad descendant-search i64 parser for ALS import.
pub fn parse_track_i64_value_broad(track_node: roxmltree::Node<'_, '_>, tag: &str) -> Option<i64> {
    node_child_value(track_node, tag)
        .or_else(|| {
            track_node
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name(tag))
                .and_then(|n| n.attribute("Value"))
                .map(ToString::to_string)
        })
        .as_deref()
        .and_then(parse_i64_value)
}

// ── Device Container Helpers ───────────────────────────────────────────

/// Recursively collects all device nodes from a `<Devices>` container,
/// expanding intermediate wrapper elements like `InsertEffectsChain`.
pub fn collect_devices_in_container<'a, 'input>(
    device_container: roxmltree::Node<'a, 'input>,
    out: &mut Vec<roxmltree::Node<'a, 'input>>,
) {
    let mut visited = std::collections::HashSet::new();
    collect_devices_in_container_inner(device_container, out, &mut visited);
}

fn collect_devices_in_container_inner<'a, 'input>(
    device_container: roxmltree::Node<'a, 'input>,
    out: &mut Vec<roxmltree::Node<'a, 'input>>,
    visited: &mut std::collections::HashSet<roxmltree::NodeId>,
) {
    if !visited.insert(device_container.id()) {
        return;
    }

    for device in device_container.children().filter(|n| n.is_element()) {
        out.push(device);

        // Ableton can nest rack chains deeply:
        // Device -> ... -> InsertEffectsChain/DeviceChain -> ... -> Devices.
        // Walk descendant chain nodes and recurse into each nested
        // Devices container we can find.
        for nested_chain in device
            .descendants()
            .filter(|n| n.is_element() && is_device_chain_tag(n.tag_name().name()))
        {
            if let Some(nested_devices) = find_first_devices_container(nested_chain) {
                collect_devices_in_container_inner(nested_devices, out, visited);
            }
        }
    }
}

/// Finds the first `<Devices>` container within a node, searching common
/// Ableton XML nesting patterns.
pub fn find_first_devices_container<'a, 'input>(
    node: roxmltree::Node<'a, 'input>,
) -> Option<roxmltree::Node<'a, 'input>> {
    for child in node.children().filter(|n| n.is_element()) {
        if child.has_tag_name("Devices") {
            return Some(child);
        }
    }
    for child in node.children().filter(|n| n.is_element()) {
        if let Some(found) = find_first_devices_container(child) {
            return Some(found);
        }
    }
    None
}

/// Collects all top-level device XML nodes from a track node.
/// Supports both `InsertEffectsChain` (Live ≤11) and `DeviceChain` (Live 12+).
pub fn collect_track_devices<'a, 'input>(
    track_node: roxmltree::Node<'a, 'input>,
) -> Vec<roxmltree::Node<'a, 'input>> {
    let mut devices = Vec::new();
    for chain in track_node
        .children()
        .filter(|n| n.is_element() && is_device_chain_tag(n.tag_name().name()))
    {
        if let Some(root_devices) = find_first_devices_container(chain) {
            collect_devices_in_container(root_devices, &mut devices);
        }
    }
    devices
}

// ── Param Collection Helpers ───────────────────────────────────────────

/// Collects all `<Name><Manual Value="..." /></Name>` parameter values
/// from a device XML node into a HashMap.
pub fn collect_device_manual_params(
    device: roxmltree::Node<'_, '_>,
) -> std::collections::HashMap<String, f64> {
    let mut params = std::collections::HashMap::new();
    for child in device.children().filter(|n| n.is_element()) {
        if let Some(val) = direct_manual_value(child)
            && let Some(f) = parse_f64_value(&val)
        {
            params.insert(child.tag_name().name().to_string(), f);
        }
    }
    params
}

/// Finds the first matching key's value from a parameter map.
pub fn first_param_value(
    params: &std::collections::HashMap<String, f64>,
    keys: &[&str],
) -> Option<f64> {
    keys.iter().find_map(|k| params.get(*k).copied())
}

/// Normalizes a 0–100 percent value to 0.0–1.0, or passes through if < 2.0.
pub fn normalize_percent_or_unit(value: f64) -> f64 {
    if value > 2.0 {
        (value / 100.0).clamp(0.0, 1.0)
    } else {
        value.clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_track_devices_keeps_full_nested_chain() {
        let xml = r#"
        <AudioTrack>
          <InsertEffectsChain>
            <Devices>
              <OriginalSimpler Id="1">
                <InsertEffectsChain>
                  <Branches>
                    <Branch>
                      <InsertEffectsChain>
                        <Devices>
                          <Eq8 Id="2" />
                          <GlueCompressor Id="3" />
                        </Devices>
                      </InsertEffectsChain>
                    </Branch>
                  </Branches>
                </InsertEffectsChain>
              </OriginalSimpler>
              <Saturator Id="4" />
            </Devices>
          </InsertEffectsChain>
        </AudioTrack>
        "#;

        let doc = roxmltree::Document::parse(xml).expect("xml parse");
        let track = doc.root_element();
        let devices = collect_track_devices(track);
        let names: Vec<String> = devices
            .iter()
            .map(|d| d.tag_name().name().to_string())
            .collect();

        assert_eq!(
            names,
            vec![
                "OriginalSimpler".to_string(),
                "Eq8".to_string(),
                "GlueCompressor".to_string(),
                "Saturator".to_string(),
            ]
        );
    }
}
