// ═══════════════════════════════════════════════════════════════════════
// Dream DAW — Ableton ALS Device Import Orchestrator
// ═══════════════════════════════════════════════════════════════════════
//
// Top-level device import for individual ALS tracks. Iterates over all
// device XML nodes, dispatches to rack_parser (for group devices),
// plugin_mapper (for canonical ID resolution), and device_params
// (for static parameter import).
//
// Supports: AudioEffectGroupDevice, InstrumentGroupDevice,
// DrumGroupDevice, MidiEffectGroupDevice, PluginDevice, and all
// internal Ableton devices.
//
// ═══════════════════════════════════════════════════════════════════════

use std::collections::HashMap;
use std::path::Path;

use dream_models::midi::SamplerConfig;
use dream_models::project::{DeviceNode, PluginSlot, Track, TrackType};

use super::device_params::{
    collect_external_plugin_static_lanes, import_internal_device_static_params,
    upsert_static_import_lane, upsert_static_import_lane_if_missing,
};
use super::plugin_mapper::{
    ExternalPluginIndex, MissingExternalPluginSlotSpec, apply_external_plugin_meta,
    canonical_internal_from_plugin_device_node, canonical_internal_plugin_for_import,
    infer_device_display_name, make_missing_external_plugin_slot_with_metadata,
    make_missing_plugin_slot, normalize_plugin_key, parse_external_plugin_meta,
};
use super::rack_parser::parse_als_rack;
use super::xml_helpers::*;

// ── Import Track Devices ───────────────────────────────────────────────

/// Imports all devices from an ALS track XML node into the Dream DAW
/// `Track` model. Handles:
///   • Group/rack devices → recursive `parse_als_rack`
///   • External PluginDevice → VST/VST3 resolution via `ExternalPluginIndex`
///   • Internal Ableton devices → canonical plugin ID mapping
///   • Static parameter import for all recognized device types
pub fn import_track_devices(
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

    // Build a map from XML `Id` attribute to sequential plugin index
    // for stable parameter lane keys.
    let mut plugin_xml_id_to_idx = HashMap::<String, usize>::new();
    for (idx, plugin_node) in track_node
        .descendants()
        .filter(|n| n.is_element() && (n.has_tag_name("PluginDevice") || n.has_tag_name("AuPluginDevice")))
        .enumerate()
    {
        if let Some(xml_id) = plugin_node.attribute("Id")
            && !xml_id.trim().is_empty()
        {
            plugin_xml_id_to_idx.insert(xml_id.trim().to_string(), idx);
        }
    }
    let mut plugin_fallback_idx = 0usize;

    for device in collect_track_devices(track_node) {
        let tag = device.tag_name().name();

        // Child devices of a rack are imported as part of that rack.
        if is_nested_inside_group_rack(device) {
            continue;
        }

        // Effect racks → full recursive parse.
        if effect_rack_tags.contains(&tag) {
            let rack = parse_als_rack(device, external_plugins, als_path);
            track.effects.push(DeviceNode::Rack(rack));
            continue;
        }

        // Instrument racks → instrument slot or effect chain.
        if tag == "InstrumentGroupDevice" {
            let rack = parse_als_rack(device, external_plugins, als_path);
            if track.track_type == TrackType::Midi && track.instrument.is_none() {
                track.instrument = Some(DeviceNode::Rack(rack));
            } else {
                track.effects.push(DeviceNode::Rack(rack));
            }
            continue;
        }

        // External VST/VST3/AU PluginDevice or AuPluginDevice.
        // ENTERPRISE FIX: AuPluginDevice was previously unhandled at the
        // top-level import, causing AU plugins to fall through to the
        // internal device mapper where they were misidentified or dropped.
        if tag == "PluginDevice" || tag == "AuPluginDevice" {
            import_external_plugin_device(
                device,
                track,
                external_plugins,
                &plugin_xml_id_to_idx,
                &mut plugin_fallback_idx,
            );
            continue;
        }

        // Internal Ableton device → canonical mapping.
        import_internal_ableton_device(device, track, tag, als_path);
    }
}

// ── Device Bypass State ────────────────────────────────────────────────

/// Parses the device bypass state from an ALS device XML node.
///
/// Ableton stores bypass as `<On><Manual Value="false"/></On>` on each device.
/// `On = true` means the device is active (not bypassed).
/// `On = false` means the device is bypassed.
fn parse_device_bypass_state(device: roxmltree::Node<'_, '_>) -> bool {
    device
        .children()
        .find(|n| n.is_element() && n.has_tag_name("On"))
        .and_then(|on_node| maybe_parse_bool_manual(on_node, "On")
            .or_else(|| {
                // Direct <On><Manual Value="..."/></On> form
                on_node
                    .children()
                    .find(|n| n.is_element() && n.has_tag_name("Manual"))
                    .and_then(|n| n.attribute("Value"))
                    .and_then(parse_bool_value)
            }))
        .map(|on| !on) // Ableton stores "On", we need "is_bypassed"
        .unwrap_or(false)
}

/// Applies the bypass state to a DeviceNode.
fn apply_device_bypass(node: &mut DeviceNode, device: roxmltree::Node<'_, '_>) {
    let bypass = parse_device_bypass_state(device);
    match node {
        DeviceNode::Single(slot) => {
            slot.is_bypassed = bypass;
        }
        DeviceNode::Rack(rack) => {
            rack.is_bypassed = bypass;
        }
    }
}

// ── External Plugin Device Import ──────────────────────────────────────

fn import_external_plugin_device(
    device: roxmltree::Node<'_, '_>,
    track: &mut Track,
    external_plugins: &ExternalPluginIndex,
    plugin_xml_id_to_idx: &HashMap<String, usize>,
    plugin_fallback_idx: &mut usize,
) {
    let meta = parse_external_plugin_meta(device);
    let user_name = node_child_value(device, "UserName").unwrap_or_default();
    let plug_name = node_child_value(device, "PlugName").unwrap_or_default();

    let vst3_name = extract_plugin_info_field(device, "Vst3PluginInfo", "Name");
    let vst2_name = extract_plugin_info_field(device, "VstPluginInfo", "PlugName");
    let au_name = extract_plugin_info_field(device, "AuPluginInfo", "Name");
    let vst3_path = extract_plugin_info_field(device, "Vst3PluginInfo", "Path");
    let vst2_path = extract_plugin_info_field(device, "VstPluginInfo", "Path");

    // Extract plugin UID and name from BranchDeviceId
    // (e.g. "device:vst3:audiofx:72c4db71-..." or "device:vst:audiofx:123?n=Name")
    let branch_uid = extract_branch_device_uid(device);
    let branch_name = extract_branch_device_name(device);

    let is_placeholder = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("IsPlaceholderDevice"))
        .and_then(|n| n.attribute("Value"))
        .and_then(parse_bool_value)
        .unwrap_or(false);

    let preferred_name = resolve_preferred_plugin_name(
        &user_name, &plug_name, &vst3_name, &vst2_name, &au_name,
        &vst3_path, &vst2_path, branch_name.as_deref(), device,
    );

    let dev_idx = device
        .attribute("Id")
        .map(|s| s.trim().to_string())
        .and_then(|id| plugin_xml_id_to_idx.get(&id).copied())
        .unwrap_or_else(|| {
            let cur = *plugin_fallback_idx;
            *plugin_fallback_idx += 1;
            cur
        });

    let plugin_key = normalize_plugin_key(&preferred_name);
    if !plugin_key.is_empty() {
        for (lane_key, value) in collect_external_plugin_static_lanes(device, dev_idx, &plugin_key)
        {
            upsert_static_import_lane_if_missing(track, &lane_key, value);
        }
    }

    // Merge UIDs: prefer ALS metadata UID, fallback to BranchDeviceId UID
    let effective_uid = meta.uid.as_deref().or(branch_uid.as_deref());
    let resolved_plugin_id = resolve_plugin_id(
        &vst2_path,
        &vst3_path,
        &vst3_name,
        &vst2_name,
        &au_name,
        &preferred_name,
        effective_uid,
        external_plugins,
    );

    let is_instrument_slot = track.track_type == TrackType::Midi && track.instrument.is_none();
    let slot = if let Some(plugin_id) = resolved_plugin_id {
        log::info!(
            "[ALS Import] Instrument RESOLVED: '{}' → '{}'",
            preferred_name,
            plugin_id
        );
        let mut slot = PluginSlot::new(preferred_name, plugin_id);
        apply_external_plugin_meta(&mut slot, &meta);
        DeviceNode::Single(slot)
    } else if let Some((pid, pname, slot_kind)) =
        canonical_internal_from_plugin_device_node(device, &preferred_name)
    {
        log::info!(
            "[ALS Import] PluginDevice CANONICAL: '{}' → internal '{}' (kind='{}')",
            preferred_name,
            pid,
            slot_kind
        );
        import_internal_device_static_params(track, pid, device);
        DeviceNode::Single(PluginSlot::new(pname, pid))
    } else {
        log::warn!(
            "[ALS Import] Instrument NOT FOUND: '{}' (vst3='{}', vst2='{}', vst3_path='{}', vst2_path='{}')",
            preferred_name,
            vst3_name,
            vst2_name,
            vst3_path,
            vst2_path
        );
        make_missing_external_plugin_slot_with_metadata(MissingExternalPluginSlotSpec {
            kind: "external",
            preferred_name: &preferred_name,
            user_name: &user_name,
            vst2_name: &vst2_name,
            vst2_path: &vst2_path,
            vst3_name: &vst3_name,
            vst3_path: &vst3_path,
            is_placeholder,
            meta: Some(&meta),
        })
    };

    // Apply device bypass state
    let mut slot = slot;
    apply_device_bypass(&mut slot, device);

    if is_instrument_slot {
        track.instrument = Some(slot);
    } else {
        track.effects.push(slot);
    }
}

// ── Internal Ableton Device Import ─────────────────────────────────────

fn import_internal_ableton_device(
    device: roxmltree::Node<'_, '_>,
    track: &mut Track,
    tag: &str,
    als_path: &Path,
) {
    let display_name = infer_device_display_name(device, tag);
    let canonical = canonical_internal_plugin_for_import(tag, &display_name);
    let is_instrument_slot = track.track_type == TrackType::Midi && track.instrument.is_none();

    if let Some((plugin_id, plugin_name, slot_kind)) = canonical {
        let mut slot = DeviceNode::Single(PluginSlot::new(plugin_name, plugin_id));
        apply_device_bypass(&mut slot, device);
        import_internal_device_static_params(track, plugin_id, device);

        if slot_kind == "instrument" && is_instrument_slot {
            track.instrument = Some(slot);
            if track.sampler.is_none() {
                track.sampler = Some(SamplerConfig::default());
            }
            // OriginalSimpler sample path extraction.
            if tag == "OriginalSimpler"
                && let Some(sample_path) =
                    super::file_resolver::extract_simpler_sample_path(device, als_path)
                && let Some(cfg) = &mut track.sampler
                && cfg.sample_path.trim().is_empty()
            {
                cfg.sample_path = sample_path;
            }
            // Wave synth default waveform.
            if plugin_id == "internal://instrument/wave-synth"
                && let Some(cfg) = &mut track.sampler
                && cfg.sample_path.trim().is_empty()
            {
                cfg.sample_path = "internal://waveform/sine".to_string();
            }
        } else {
            track.effects.push(slot);
            // Import static MIDI FX settings.
            import_midi_fx_static_params(track, plugin_id, device);
        }
    } else {
        let mut slot = make_missing_plugin_slot("ableton-device", &display_name);
        apply_device_bypass(&mut slot, device);
        if is_instrument_slot {
            track.instrument = Some(slot);
        } else {
            track.effects.push(slot);
        }
    }
}

// ── MIDI FX Static Parameter Import ────────────────────────────────────

fn import_midi_fx_static_params(
    track: &mut Track,
    plugin_id: &str,
    device: roxmltree::Node<'_, '_>,
) {
    match plugin_id {
        "internal://midi-fx/pitch" => {
            let semitones = maybe_parse_f64_manual(device, "Pitch").unwrap_or(0.0)
                + maybe_parse_f64_manual(device, "PitchScaleDegrees").unwrap_or(0.0);
            upsert_static_import_lane(track, "midi.pitch.semitones", semitones.clamp(-48.0, 48.0));
        }
        "internal://midi-fx/velocity" => {
            let gain = maybe_parse_f64_manual(device, "Drive")
                .or_else(|| maybe_parse_f64_manual(device, "OutHi"))
                .unwrap_or(1.0);
            let offset = maybe_parse_f64_manual(device, "OutLow")
                .or_else(|| maybe_parse_f64_manual(device, "Random"))
                .unwrap_or(0.0);
            upsert_static_import_lane(track, "midi.velocity.gain", gain.clamp(0.0, 4.0));
            upsert_static_import_lane(track, "midi.velocity.offset", offset.clamp(-127.0, 127.0));
        }
        "internal://midi-fx/random" => {
            let chance = maybe_parse_f64_manual(device, "Chance")
                .or_else(|| maybe_parse_f64_manual(device, "Probability"))
                .unwrap_or(1.0);
            let semitones = maybe_parse_f64_manual(device, "Choices")
                .or_else(|| maybe_parse_f64_manual(device, "Scale"))
                .unwrap_or(0.0);
            upsert_static_import_lane(track, "midi.random.chance", chance.clamp(0.0, 1.0));
            upsert_static_import_lane(track, "midi.random.semitones", semitones.clamp(-24.0, 24.0));
        }
        "internal://midi-fx/scale" => {
            let root = maybe_parse_f64_manual(device, "Base")
                .or_else(|| maybe_parse_f64_manual(device, "Root"))
                .or_else(|| maybe_parse_f64_manual(device, "Lowest"))
                .unwrap_or(0.0);
            upsert_static_import_lane(track, "midi.scale.root", root.rem_euclid(12.0));
            upsert_static_import_lane(track, "midi.scale.mask", 4095.0);
        }
        _ => {}
    }
}

// ── Private Helpers ────────────────────────────────────────────────────

/// Extracts a named field from a VST plugin info container.
///
/// Uses `descendants()` to find the field, since some ALS versions
/// nest fields deeper than direct children of the container element.
fn extract_plugin_info_field(
    device: roxmltree::Node<'_, '_>,
    container_tag: &str,
    field_tag: &str,
) -> String {
    device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name(container_tag))
        .and_then(|container| {
            container
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name(field_tag))
                .and_then(|n| n.attribute("Value"))
        })
        .unwrap_or_default()
        .to_string()
}

/// Determines the best display name for an external plugin.
///
/// Resolution order (most reliable → least reliable):
///   1. UserName (explicitly set by user in Ableton)
///   2. Top-level PlugName (from PluginDevice XML element)
///   3. Vst3PluginInfo/Name
///   4. VstPluginInfo/PlugName
///   5. AuPluginInfo/Name
///   6. File stem from VST2 path
///   7. File stem from VST3 path
///   8. BranchDeviceId `?n=` parameter (URL-encoded name)
///   9. BrowserContentPath query string fragment
///  10. infer_device_display_name() fallback
fn resolve_preferred_plugin_name(
    user_name: &str,
    plug_name: &str,
    vst3_name: &str,
    vst2_name: &str,
    au_name: &str,
    vst3_path: &str,
    vst2_path: &str,
    branch_name: Option<&str>,
    device: roxmltree::Node<'_, '_>,
) -> String {
    if !user_name.trim().is_empty() {
        user_name.trim().to_string()
    } else if !plug_name.trim().is_empty() {
        plug_name.trim().to_string()
    } else if !vst3_name.trim().is_empty() {
        vst3_name.trim().to_string()
    } else if !vst2_name.trim().is_empty() {
        vst2_name.trim().to_string()
    } else if !au_name.trim().is_empty() {
        au_name.trim().to_string()
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
    } else if let Some(name) = branch_name.filter(|s| !s.trim().is_empty()) {
        name.trim().to_string()
    } else if let Some(name) = extract_browser_query_plugin_name(device) {
        name
    } else {
        infer_device_display_name(device, "Unknown Plugin")
    }
}

/// Extracts the plugin name from Ableton's `BrowserContentPath` query string.
///
/// Ableton 12 stores the browser context as:
///   `<BrowserContentPath Value="query:Everything#Serum%202" />`
///
/// This is the last reliable name source for plugins whose Vst3/Vst2/AU
/// PluginInfo `Name` elements are empty (e.g. Serum 2).
fn extract_browser_query_plugin_name(device: roxmltree::Node<'_, '_>) -> Option<String> {
    device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("BrowserContentPath"))
        .and_then(|n| n.attribute("Value"))
        .and_then(|val| {
            // Format: "query:Everything#Plugin%20Name"
            let fragment = val.split('#').nth(1)?;
            if fragment.trim().is_empty() {
                return None;
            }
            // URL-decode: %20 → space, %25 → %, etc.
            let decoded = percent_decode(fragment);
            let trimmed = decoded.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
}

/// ENTERPRISE percent-decoding for Ableton browser query strings.
/// Handles multi-byte UTF-8 sequences (e.g., %C3%A9 → 'é') correctly.
fn percent_decode(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let mut chars = input.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let hi = chars.next().unwrap_or(b'0');
            let lo = chars.next().unwrap_or(b'0');
            let hex = [hi, lo];
            if let Ok(s) = std::str::from_utf8(&hex)
                && let Ok(byte) = u8::from_str_radix(s, 16) {
                    bytes.push(byte);
                    continue;
                }
            bytes.push(b'%');
            bytes.push(hi);
            bytes.push(lo);
        } else {
            bytes.push(b);
        }
    }
    // ENTERPRISE FIX: Decode accumulated bytes as UTF-8 instead of per-byte char cast.
    // This correctly handles multi-byte sequences like %C3%A9 (é) which span two %XX tokens.
    String::from_utf8(bytes).unwrap_or_else(|_| input.to_string())
}

/// Extracts a VST3 GUID or VST2 numeric ID from `BranchDeviceId`.
///
/// Ableton's `SourceContext/BranchSourceContext/BranchDeviceId` stores
/// stable identifiers for plugins:
///   - VST3:  `device:vst3:audiofx:72c4db71-7a4d-459a-b97e-51745d84b39d`
///   - VST3:  `device:vst3:instr:56534558-6573-5073-6572-756d20320000`
///   - VST2:  `device:vst:audiofx:1179726960?n=FabFilter%20Pro-Q%204`
///
/// Returns the UID portion (GUID or numeric ID) when available.
fn extract_branch_device_uid(device: roxmltree::Node<'_, '_>) -> Option<String> {
    let branch_id = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("BranchDeviceId"))
        .and_then(|n| n.attribute("Value"))?;

    // Skip Ableton internal devices (e.g. "device:ableton:audiofx:Eq8")
    if branch_id.contains(":ableton:") {
        return None;
    }

    // Extract the UID segment after the last ':'
    // "device:vst3:audiofx:72c4db71-..." → "72c4db71-..."
    // "device:vst:audiofx:1179726960?n=..." → "1179726960"
    let uid_segment = branch_id.rsplit(':').next()?;
    // Strip query parameters if present
    let uid = uid_segment.split('?').next().unwrap_or(uid_segment);
    if uid.is_empty() {
        return None;
    }
    Some(uid.to_string())
}

/// Extracts a plugin display name from the `BranchDeviceId` `?n=` parameter.
///
/// Some ALS entries encode the name directly:
///   `device:vst:audiofx:1179726960?n=FabFilter%20Pro-Q%204`
///
/// Returns the URL-decoded name when the `?n=` parameter is present.
fn extract_branch_device_name(device: roxmltree::Node<'_, '_>) -> Option<String> {
    let branch_id = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("BranchDeviceId"))
        .and_then(|n| n.attribute("Value"))?;

    // Look for ?n= parameter
    let name_param = branch_id.split("?n=").nth(1)?;
    // Take everything up to the next '&' or end of string
    let raw_name = name_param.split('&').next().unwrap_or(name_param);
    if raw_name.is_empty() {
        return None;
    }
    let decoded = percent_decode(raw_name);
    let trimmed = decoded.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Resolves VST plugin ID from paths/names via the external plugin index.
#[allow(clippy::too_many_arguments)]
fn resolve_plugin_id(
    vst2_path: &str,
    vst3_path: &str,
    vst3_name: &str,
    vst2_name: &str,
    au_name: &str,
    preferred_name: &str,
    plugin_uid: Option<&str>,
    external_plugins: &ExternalPluginIndex,
) -> Option<String> {
    fn push_candidate(out: &mut Vec<String>, raw: &str) {
        let c = raw.trim();
        if c.is_empty() {
            return;
        }
        if out.iter().any(|existing| existing.eq_ignore_ascii_case(c)) {
            return;
        }
        out.push(c.to_string());
    }

    fn push_from_path(out: &mut Vec<String>, raw_path: &str) {
        let p = raw_path.trim();
        if p.is_empty() {
            return;
        }
        let normalized = p.replace('\\', "/");
        push_candidate(out, &normalized);
        if let Some(file_name) = Path::new(&normalized).file_name().and_then(|s| s.to_str()) {
            push_candidate(out, file_name);
        }
        if let Some(stem) = Path::new(&normalized).file_stem().and_then(|s| s.to_str()) {
            push_candidate(out, stem);
        }
        for token in normalized.split('/') {
            let t = token.trim();
            if t.is_empty() {
                continue;
            }
            push_candidate(out, t);
            if let Some(stem) = Path::new(t).file_stem().and_then(|s| s.to_str()) {
                push_candidate(out, stem);
            }
        }
    }

    let v3_path = vst3_path.trim();
    let v2_path = vst2_path.trim();

    // Prefer real, existing bundle paths on this machine.
    if !v3_path.is_empty() && Path::new(v3_path).exists() {
        return Some(v3_path.to_string());
    }
    if !v2_path.is_empty() && Path::new(v2_path).exists() {
        return Some(v2_path.to_string());
    }

    // Prefer explicit plugin UID from ALS metadata when available.
    if let Some(uid) = plugin_uid
        && let Some(path) = external_plugins.resolve_by_uid(uid)
    {
        return Some(path);
    }

    // Fallback to scanner index by multiple metadata candidates. ALS exports
    // can vary by OS (Windows path on macOS), format (VST2/VST3/AU), and
    // host-specific naming, so we probe a richer candidate set.
    let mut candidates: Vec<String> = Vec::new();
    push_candidate(&mut candidates, preferred_name);
    push_candidate(&mut candidates, vst3_name);
    push_candidate(&mut candidates, vst2_name);
    push_candidate(&mut candidates, au_name);
    push_from_path(&mut candidates, v3_path);
    push_from_path(&mut candidates, v2_path);

    for candidate in &candidates {
        if let Some(path) = external_plugins.resolve_by_name(candidate) {
            return Some(path);
        }
    }

    None
}
