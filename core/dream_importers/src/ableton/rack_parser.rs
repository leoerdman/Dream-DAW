// ═══════════════════════════════════════════════════════════════════════
// Dream DAW — Ableton ALS Rack Parser
// ═══════════════════════════════════════════════════════════════════════
//
// Recursive parser for Ableton group devices (AudioEffectGroupDevice,
// InstrumentGroupDevice, DrumGroupDevice, MidiEffectGroupDevice).
//
// Produces DeviceRack with chains, devices, macro controls, and
// macro → parameter mappings.
//
// ═══════════════════════════════════════════════════════════════════════

use std::path::Path;

use dream_models::project::{
    DeviceNode, DeviceRack, MacroControl, PluginSlot, RackChain, RackType, ZoneSettings,
};

use super::plugin_mapper::{
    ExternalPluginIndex, MissingExternalPluginSlotSpec, apply_external_plugin_meta,
    canonical_internal_from_plugin_device_node, canonical_internal_plugin_for_import,
    infer_device_display_name, make_missing_external_plugin_slot_with_metadata,
    make_missing_plugin_slot, normalize_plugin_key, parse_external_plugin_meta,
};
use super::xml_helpers::*;

/// Parses the device bypass state from an ALS device XML node.
///
/// Ableton stores bypass as `<On><Manual Value="false"/></On>` on each device.
/// `On = true` means the device is active (not bypassed).
/// `On = false` means the device is bypassed.
///
/// ENTERPRISE FIX: This was missing from rack_parser — devices inside rack
/// chains never had their bypass state applied, causing bypassed effects
/// inside racks to still process audio after import.
fn parse_device_bypass_state(device: roxmltree::Node<'_, '_>) -> bool {
    device
        .children()
        .find(|n| n.is_element() && n.has_tag_name("On"))
        .and_then(|on_node| maybe_parse_bool_manual(on_node, "On")
            .or_else(|| {
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

// ── Pending Macro Mapping ──────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PendingMacroMapping {
    pub macro_index: usize,
    pub device_id: uuid::Uuid,
    pub param_id: String,
    pub min_value: f64,
    pub max_value: f64,
}

// ── Macro Mapping Collector ────────────────────────────────────────────

pub fn collect_pending_macro_mappings_for_device(
    device_xml: roxmltree::Node<'_, '_>,
    device_node: &DeviceNode,
) -> Vec<PendingMacroMapping> {
    let Some(slot) = device_node.as_single() else {
        return Vec::new();
    };

    fn child_value(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<String> {
        node.children()
            .find(|n| n.is_element() && n.has_tag_name(tag))
            .and_then(|n| n.attribute("Value"))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    let mut out = Vec::<PendingMacroMapping>::new();

    for candidate in device_xml.descendants().filter(|n| n.is_element()) {
        let Some(macro_idx) = child_value(candidate, "PowerMacroControlIndex")
            .as_deref()
            .and_then(parse_i64_value)
            .and_then(|v| (0..=15).contains(&v).then_some(v as usize))
        else {
            continue;
        };

        let mapping_range = candidate
            .children()
            .find(|n| n.is_element() && n.has_tag_name("PowerMacroMappingRange"));
        let min_value = mapping_range
            .and_then(|r| {
                r.children()
                    .find(|n| n.is_element() && n.has_tag_name("Min"))
                    .and_then(|n| n.attribute("Value"))
                    .and_then(parse_f64_value)
            })
            .unwrap_or(0.0);
        let max_value = mapping_range
            .and_then(|r| {
                r.children()
                    .find(|n| n.is_element() && n.has_tag_name("Max"))
                    .and_then(|n| n.attribute("Value"))
                    .and_then(parse_f64_value)
            })
            .unwrap_or(127.0);

        let param_id = child_value(candidate, "ParameterName")
            .or_else(|| child_value(candidate, "ParameterId"))
            .map(|s| {
                let normalized = normalize_plugin_key(&s);
                if normalized.is_empty() { s } else { normalized }
            })
            .unwrap_or_else(|| normalize_plugin_key(candidate.tag_name().name()));
        if param_id.is_empty() {
            continue;
        }

        out.push(PendingMacroMapping {
            macro_index: macro_idx,
            device_id: slot.id,
            param_id,
            min_value,
            max_value,
        });
    }

    out.sort_by(|a, b| {
        a.macro_index
            .cmp(&b.macro_index)
            .then_with(|| a.device_id.cmp(&b.device_id))
            .then_with(|| a.param_id.cmp(&b.param_id))
    });
    out.dedup_by(|a, b| {
        a.macro_index == b.macro_index
            && a.device_id == b.device_id
            && a.param_id == b.param_id
            && (a.min_value - b.min_value).abs() < 1e-9
            && (a.max_value - b.max_value).abs() < 1e-9
    });
    out
}

// ── Zone Settings Parser ───────────────────────────────────────────────

/// Parses Ableton zone settings XML into `ZoneSettings`.
pub fn parse_als_zone_settings(zone_node: roxmltree::Node<'_, '_>) -> ZoneSettings {
    let mut zs = ZoneSettings::default();

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
    if let Some(v) = kmin {
        zs.key_range_min = v;
    }
    if let Some(v) = kmax {
        zs.key_range_max = v;
    }

    let (vmin, vmax) = range_min_max(zone_node, "VelocityRange");
    if let Some(v) = vmin {
        zs.velocity_range_min = v;
    }
    if let Some(v) = vmax {
        zs.velocity_range_max = v;
    }

    let (cmin, cmax) = range_min_max(zone_node, "ChainSelectorRange");
    if let Some(v) = cmin {
        zs.chain_selector_min = v;
    }
    if let Some(v) = cmax {
        zs.chain_selector_max = v;
    }

    zs
}

// ── Recursive ALS Rack Parser ──────────────────────────────────────────

/// Parses an Ableton group device XML node into a full `DeviceRack`.
///
/// Supports AudioEffectGroupDevice, InstrumentGroupDevice,
/// DrumGroupDevice, and MidiEffectGroupDevice. Recursively resolves
/// nested devices within each chain (including nested racks).
pub fn parse_als_rack(
    group_device: roxmltree::Node<'_, '_>,
    external_plugins: &ExternalPluginIndex,
    als_path: &Path,
) -> DeviceRack {
    fn parse_macro_index(tag_name: &str, prefix: &str) -> Option<usize> {
        tag_name
            .strip_prefix(prefix)
            .and_then(|idx| idx.parse::<usize>().ok())
    }

    fn ensure_rack_macro_capacity(rack: &mut DeviceRack, desired_count: usize) {
        let clamped = desired_count.clamp(8, 16);
        while rack.macro_controls.len() < clamped {
            let idx = rack.macro_controls.len() as u8;
            rack.macro_controls.push(MacroControl::new(idx));
        }
    }

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
    let mut pending_macro_mappings = Vec::<PendingMacroMapping>::new();
    rack.chains = parse_als_rack_chains(
        group_device,
        external_plugins,
        als_path,
        &mut pending_macro_mappings,
    );

    // If no branches found, create a single default chain.
    if rack.chains.is_empty() {
        rack.chains.push(RackChain::new("Chain A"));
    }

    // ALS racks can expose up to 16 macros. Expand capacity.
    let mut max_macro_index = 7usize;
    if let Some(visible) = node_child_value(group_device, "NumVisibleMacroControls")
        .and_then(|v| v.parse::<usize>().ok())
    {
        max_macro_index = max_macro_index.max(visible.saturating_sub(1));
    }
    for child in group_device.children().filter(|n| n.is_element()) {
        let name = child.tag_name().name();
        if let Some(idx) = parse_macro_index(name, "MacroControls.")
            .or_else(|| parse_macro_index(name, "MacroDisplayNames."))
            .or_else(|| parse_macro_index(name, "MacroDefaults."))
        {
            max_macro_index = max_macro_index.max(idx);
        }
    }
    if let Some(mapped_max) = pending_macro_mappings.iter().map(|m| m.macro_index).max() {
        max_macro_index = max_macro_index.max(mapped_max);
    }
    ensure_rack_macro_capacity(&mut rack, max_macro_index + 1);

    // ── Parse MacroControls (up to 16) ──────────────────────────────
    for macro_node in group_device
        .children()
        .filter(|n| n.is_element() && n.tag_name().name().starts_with("MacroControls."))
    {
        let tag_name = macro_node.tag_name().name();
        if let Some(idx) = parse_macro_index(tag_name, "MacroControls.")
            && idx < rack.macro_controls.len()
        {
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
            let mc = &mut rack.macro_controls[idx];
            if !display_name.is_empty() {
                mc.name = display_name;
            }
            mc.value = value;
            mc.default_value = value;
        }
    }

    for name_node in group_device
        .children()
        .filter(|n| n.is_element() && n.tag_name().name().starts_with("MacroDisplayNames."))
    {
        let tag_name = name_node.tag_name().name();
        if let Some(idx) = parse_macro_index(tag_name, "MacroDisplayNames.")
            && idx < rack.macro_controls.len()
            && let Some(display_name) = name_node.attribute("Value")
            && !display_name.is_empty()
        {
            rack.macro_controls[idx].name = display_name.to_string();
        }
    }
    for default_node in group_device
        .children()
        .filter(|n| n.is_element() && n.tag_name().name().starts_with("MacroDefaults."))
    {
        let tag_name = default_node.tag_name().name();
        if let Some(idx) = parse_macro_index(tag_name, "MacroDefaults.")
            && idx < rack.macro_controls.len()
            && let Some(value) = default_node.attribute("Value").and_then(parse_f64_value)
        {
            rack.macro_controls[idx].default_value = value;
        }
    }

    // ── Parse macro → parameter mappings (PowerMacro*) ─────────────
    for mapping in pending_macro_mappings {
        if mapping.macro_index >= rack.macro_controls.len() {
            continue;
        }
        rack.macro_controls[mapping.macro_index].mappings.push(
            dream_models::project::MacroMapping {
                device_id: mapping.device_id,
                param_id: mapping.param_id,
                min_value: mapping.min_value,
                max_value: mapping.max_value,
            },
        );
    }
    for mc in &mut rack.macro_controls {
        mc.mappings.sort_by(|a, b| {
            a.device_id
                .cmp(&b.device_id)
                .then_with(|| a.param_id.cmp(&b.param_id))
                .then_with(|| a.min_value.total_cmp(&b.min_value))
                .then_with(|| a.max_value.total_cmp(&b.max_value))
        });
        mc.mappings.dedup_by(|a, b| {
            a.device_id == b.device_id
                && a.param_id == b.param_id
                && (a.min_value - b.min_value).abs() < 1e-9
                && (a.max_value - b.max_value).abs() < 1e-9
        });
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

// ── Rack Chains Parser ─────────────────────────────────────────────────

/// Parses the Branches element of a group device into a `Vec<RackChain>`.
pub fn parse_als_rack_chains(
    group_device: roxmltree::Node<'_, '_>,
    external_plugins: &ExternalPluginIndex,
    als_path: &Path,
    pending_macro_mappings: &mut Vec<PendingMacroMapping>,
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
        let chain_name = node_child_value(branch, "Name").unwrap_or_else(|| {
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
        chain.is_disabled = branch
            .children()
            .find(|n| n.is_element() && n.has_tag_name("IsMuted"))
            .and_then(|n| n.attribute("Value"))
            .and_then(parse_bool_value)
            .unwrap_or(false);

        // ── Parse devices from InsertEffectsChain/DeviceChain ─────────────
        let device_chain = branch
            .children()
            .find(|n| {
                n.is_element()
                    && (n.has_tag_name("InsertEffectsChain") || n.has_tag_name("DeviceChain"))
            });

        if let Some(dc) = device_chain {
            let devices_node = find_first_devices_container(dc);

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
                        let mut node = DeviceNode::Rack(nested_rack);
                        apply_device_bypass(&mut node, child_device);
                        chain.devices.push(node);
                        continue;
                    }

                    // PluginDevice / AuPluginDevice → external VST/VST3/AU.
                    // ENTERPRISE FIX: AuPluginDevice was previously unhandled,
                    // causing AU plugins inside racks to be silently dropped.
                    if child_tag == "PluginDevice" || child_tag == "AuPluginDevice" {
                        let mut node = resolve_external_plugin_device(
                            child_device,
                            external_plugins,
                            pending_macro_mappings,
                        );
                        apply_device_bypass(&mut node, child_device);
                        chain.devices.push(node);
                        continue;
                    }

                    // Internal Ableton device → canonical mapping.
                    let display = infer_device_display_name(child_device, child_tag);
                    if let Some((pid, pname, _)) =
                        canonical_internal_plugin_for_import(child_tag, &display)
                    {
                        let mut node = DeviceNode::Single(PluginSlot::new(pname, pid));
                        apply_device_bypass(&mut node, child_device);
                        pending_macro_mappings.extend(collect_pending_macro_mappings_for_device(
                            child_device,
                            &node,
                        ));
                        chain.devices.push(node);
                    } else {
                        let mut node = make_missing_plugin_slot(child_tag, &display);
                        apply_device_bypass(&mut node, child_device);
                        pending_macro_mappings.extend(collect_pending_macro_mappings_for_device(
                            child_device,
                            &node,
                        ));
                        chain.devices.push(node);
                    }
                }
            }
        }

        // Parse volume/pan from the chain's mixer if present.
        if let Some(mixer) = branch
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Mixer"))
        {
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
                chain.volume = ableton_volume_to_linear_gain(vol);
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

// ── External Plugin Device Resolution ──────────────────────────────────

/// Resolves a `PluginDevice` XML node to a `DeviceNode`, handling VST3/VST2
/// lookup via the external plugin index.
fn resolve_external_plugin_device(
    child_device: roxmltree::Node<'_, '_>,
    external_plugins: &ExternalPluginIndex,
    pending_macro_mappings: &mut Vec<PendingMacroMapping>,
) -> DeviceNode {
    let meta = parse_external_plugin_meta(child_device);
    let display = infer_device_display_name(child_device, "PluginDevice");
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

    let resolved_plugin_id = if !vst3_path.is_empty() && Path::new(vst3_path).exists() {
        Some(vst3_path.to_string())
    } else if !vst2_path.is_empty() && Path::new(vst2_path).exists() {
        Some(vst2_path.to_string())
    } else if !vst3_name.is_empty() {
        external_plugins.resolve_by_name(vst3_name)
    } else if !vst2_name.is_empty() {
        external_plugins.resolve_by_name(vst2_name)
    } else {
        None
    }
    .or_else(|| {
        if !vst3_path.is_empty()
            && let Some(stem) = Path::new(vst3_path).file_stem().and_then(|s| s.to_str())
        {
            return external_plugins.resolve_by_name(stem);
        }
        None
    })
    .or_else(|| {
        if !vst2_path.is_empty()
            && let Some(stem) = Path::new(vst2_path).file_stem().and_then(|s| s.to_str())
        {
            return external_plugins.resolve_by_name(stem);
        }
        None
    });

    if let Some(plugin_id) = resolved_plugin_id {
        log::info!(
            "[ALS Import] Plugin RESOLVED: '{}' → '{}'",
            preferred_name,
            plugin_id
        );
        let mut slot = PluginSlot::new(preferred_name, plugin_id);
        apply_external_plugin_meta(&mut slot, &meta);
        let node = DeviceNode::Single(slot);
        pending_macro_mappings.extend(collect_pending_macro_mappings_for_device(
            child_device,
            &node,
        ));
        node
    } else if let Some((pid, pname, _)) =
        canonical_internal_from_plugin_device_node(child_device, &preferred_name)
    {
        log::info!(
            "[ALS Import] Plugin CANONICAL: '{}' → internal '{}'",
            preferred_name,
            pid
        );
        let node = DeviceNode::Single(PluginSlot::new(pname, pid));
        pending_macro_mappings.extend(collect_pending_macro_mappings_for_device(
            child_device,
            &node,
        ));
        node
    } else {
        log::warn!(
            "[ALS Import] Plugin NOT FOUND: '{}' (vst3='{}', vst2='{}', vst3_path='{}', vst2_path='{}')",
            preferred_name,
            vst3_name,
            vst2_name,
            vst3_path,
            vst2_path
        );
        let node = make_missing_external_plugin_slot_with_metadata(MissingExternalPluginSlotSpec {
            kind: "external",
            preferred_name: &preferred_name,
            user_name: &user_name,
            vst2_name,
            vst2_path,
            vst3_name,
            vst3_path,
            is_placeholder: false,
            meta: Some(&meta),
        });
        pending_macro_mappings.extend(collect_pending_macro_mappings_for_device(
            child_device,
            &node,
        ));
        node
    }
}
