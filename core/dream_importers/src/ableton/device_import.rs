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
    apply_external_plugin_meta, canonical_internal_plugin_for_import, infer_device_display_name,
    make_missing_external_plugin_slot_with_metadata, make_missing_plugin_slot,
    normalize_plugin_key, parse_external_plugin_meta, ExternalPluginIndex,
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
        .filter(|n| n.is_element() && n.has_tag_name("PluginDevice"))
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

        // External VST/VST3 PluginDevice.
        if tag == "PluginDevice" {
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

    let vst3_name = extract_plugin_info_field(device, "Vst3PluginInfo", "Name");
    let vst2_name = extract_plugin_info_field(device, "VstPluginInfo", "PlugName");
    let vst3_path = extract_plugin_info_field(device, "Vst3PluginInfo", "Path");
    let vst2_path = extract_plugin_info_field(device, "VstPluginInfo", "Path");

    let is_placeholder = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("IsPlaceholderDevice"))
        .and_then(|n| n.attribute("Value"))
        .and_then(parse_bool_value)
        .unwrap_or(false);

    let preferred_name = resolve_preferred_plugin_name(
        &user_name, &vst3_name, &vst2_name, &vst3_path, &vst2_path, device,
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
        for (lane_key, value) in collect_external_plugin_static_lanes(device, dev_idx, &plugin_key) {
            upsert_static_import_lane_if_missing(track, &lane_key, value);
        }
    }

    let resolved_plugin_id = resolve_plugin_id(
        &vst2_path, &vst3_path, &vst3_name, &vst2_name, external_plugins,
    );

    let is_instrument_slot = track.track_type == TrackType::Midi && track.instrument.is_none();
    let slot = if let Some(plugin_id) = resolved_plugin_id {
        log::info!("[ALS Import] Instrument RESOLVED: '{}' → '{}'", preferred_name, plugin_id);
        let mut slot = PluginSlot::new(preferred_name, plugin_id);
        apply_external_plugin_meta(&mut slot, &meta);
        DeviceNode::Single(slot)
    } else if let Some((pid, pname, slot_kind)) =
        canonical_internal_plugin_for_import("PluginDevice", &preferred_name)
    {
        log::info!("[ALS Import] PluginDevice CANONICAL: '{}' → internal '{}' (kind='{}')", preferred_name, pid, slot_kind);
        import_internal_device_static_params(track, pid, device);
        DeviceNode::Single(PluginSlot::new(pname, pid))
    } else {
        log::warn!(
            "[ALS Import] Instrument NOT FOUND: '{}' (vst3='{}', vst2='{}', vst3_path='{}', vst2_path='{}')",
            preferred_name, vst3_name, vst2_name, vst3_path, vst2_path
        );
        make_missing_external_plugin_slot_with_metadata(
            "external", &preferred_name, &user_name,
            &vst2_name, &vst2_path, &vst3_name, &vst3_path,
            is_placeholder, Some(&meta),
        )
    };

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
        let slot = DeviceNode::Single(PluginSlot::new(plugin_name, plugin_id));
        import_internal_device_static_params(track, plugin_id, device);

        if slot_kind == "instrument" && is_instrument_slot {
            track.instrument = Some(slot);
            if track.sampler.is_none() {
                track.sampler = Some(SamplerConfig::default());
            }
            // OriginalSimpler sample path extraction.
            if tag == "OriginalSimpler"
                && let Some(sample_path) = super::file_resolver::extract_simpler_sample_path(device, als_path)
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
        let slot = make_missing_plugin_slot("ableton-device", &display_name);
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
                .children()
                .find(|n| n.is_element() && n.has_tag_name(field_tag))
                .and_then(|n| n.attribute("Value"))
        })
        .unwrap_or_default()
        .to_string()
}

/// Determines the best display name for an external plugin.
fn resolve_preferred_plugin_name(
    user_name: &str,
    vst3_name: &str,
    vst2_name: &str,
    vst3_path: &str,
    vst2_path: &str,
    device: roxmltree::Node<'_, '_>,
) -> String {
    if !user_name.trim().is_empty() {
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
    }
}

/// Resolves VST plugin ID from paths/names via the external plugin index.
fn resolve_plugin_id(
    vst2_path: &str,
    vst3_path: &str,
    vst3_name: &str,
    vst2_name: &str,
    external_plugins: &ExternalPluginIndex,
) -> Option<String> {
    if !vst2_path.trim().is_empty() {
        Some(vst2_path.trim().to_string())
    } else if !vst3_path.trim().is_empty() {
        Some(vst3_path.trim().to_string())
    } else if !vst3_name.trim().is_empty() {
        external_plugins.resolve_by_name(vst3_name)
    } else if !vst2_name.trim().is_empty() {
        external_plugins.resolve_by_name(vst2_name)
    } else {
        None
    }
}
