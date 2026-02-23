// ═══════════════════════════════════════════════════════════════════════
// Routing Helpers — Pure project traversal for plugin slot lookups
// ═══════════════════════════════════════════════════════════════════════
//
// Extracted from desktop_host/commands/sections/plugins_routing.rs.
// These functions operate on (Project, DeviceNode, PluginSlot) only —
// zero Tauri or IPC dependencies.
//
// ═══════════════════════════════════════════════════════════════════════

use dream_models::project::{DeviceNode, PluginSlot, Project};
use std::collections::HashMap;
use std::path::PathBuf;
use uuid::Uuid;

// ── Slot Lookups by Plugin ID ───────────────────────────────────────────

/// Recursively searches a `DeviceNode` tree for a `PluginSlot` matching
/// the given `plugin_id` string. Returns the first match (clone).
pub fn find_slot_in_node_by_plugin_id(node: &DeviceNode, plugin_id: &str) -> Option<PluginSlot> {
    match node {
        DeviceNode::Single(slot) => {
            if slot.plugin_id == plugin_id {
                Some(slot.clone())
            } else {
                None
            }
        }
        DeviceNode::Rack(rack) => {
            for chain in &rack.chains {
                for child in &chain.devices {
                    if let Some(found) = find_slot_in_node_by_plugin_id(child, plugin_id) {
                        return Some(found);
                    }
                }
            }
            None
        }
    }
}

/// Searches the entire project (all tracks + master) for a `PluginSlot`
/// matching `plugin_id`. Returns the first match.
pub fn find_project_plugin_slot(project: &Project, plugin_id: &str) -> Option<PluginSlot> {
    for track in &project.tracks {
        if let Some(inst) = &track.instrument
            && let Some(found) = find_slot_in_node_by_plugin_id(inst, plugin_id)
        {
            return Some(found);
        }
        for fx in &track.effects {
            if let Some(found) = find_slot_in_node_by_plugin_id(fx, plugin_id) {
                return Some(found);
            }
        }
    }
    for fx in &project.master_track.effects {
        if let Some(found) = find_slot_in_node_by_plugin_id(fx, plugin_id) {
            return Some(found);
        }
    }
    None
}

// ── Slot Lookups by UUID ────────────────────────────────────────────────

/// Recursively searches a `DeviceNode` tree for a `PluginSlot` matching
/// the given slot UUID. Returns a clone of the first match.
pub fn find_slot_in_node_by_id(node: &DeviceNode, slot_id: Uuid) -> Option<PluginSlot> {
    match node {
        DeviceNode::Single(slot) => {
            if slot.id == slot_id {
                Some(slot.clone())
            } else {
                None
            }
        }
        DeviceNode::Rack(rack) => {
            for chain in &rack.chains {
                for child in &chain.devices {
                    if let Some(found) = find_slot_in_node_by_id(child, slot_id) {
                        return Some(found);
                    }
                }
            }
            None
        }
    }
}

/// Mutable version of `find_slot_in_node_by_id` — returns a mutable
/// reference to the matching `PluginSlot`.
pub fn find_slot_in_node_by_id_mut(
    node: &mut DeviceNode,
    slot_id: Uuid,
) -> Option<&mut PluginSlot> {
    match node {
        DeviceNode::Single(slot) => {
            if slot.id == slot_id {
                Some(slot)
            } else {
                None
            }
        }
        DeviceNode::Rack(rack) => {
            for chain in &mut rack.chains {
                for child in &mut chain.devices {
                    if let Some(found) = find_slot_in_node_by_id_mut(child, slot_id) {
                        return Some(found);
                    }
                }
            }
            None
        }
    }
}

/// Finds a `PluginSlot` anywhere in the project by its unique slot UUID.
///
/// Unlike `find_project_plugin_slot` (which matches by `plugin_id`), this
/// returns the exact slot regardless of how many instances of the same plugin
/// exist. Used for per-slot state restoration on project load.
pub fn find_project_plugin_slot_by_slot_id(project: &Project, slot_id: Uuid) -> Option<PluginSlot> {
    for track in &project.tracks {
        if let Some(inst) = &track.instrument
            && let Some(found) = find_slot_in_node_by_id(inst, slot_id)
        {
            return Some(found);
        }
        for fx in &track.effects {
            if let Some(found) = find_slot_in_node_by_id(fx, slot_id) {
                return Some(found);
            }
        }
    }
    for fx in &project.master_track.effects {
        if let Some(found) = find_slot_in_node_by_id(fx, slot_id) {
            return Some(found);
        }
    }
    None
}

/// Finds a mutable `PluginSlot` on a specific track by track UUID + slot UUID.
pub fn find_slot_on_track_mut(
    project: &mut Project,
    track_id: Uuid,
    slot_id: Uuid,
) -> Option<&mut PluginSlot> {
    let track = project.tracks.iter_mut().find(|t| t.id == track_id)?;
    if let Some(inst) = &mut track.instrument
        && let Some(found) = find_slot_in_node_by_id_mut(inst, slot_id)
    {
        return Some(found);
    }
    for fx in &mut track.effects {
        if let Some(found) = find_slot_in_node_by_id_mut(fx, slot_id) {
            return Some(found);
        }
    }
    None
}

/// Immutable version — finds a slot on a specific track by UUIDs.
pub fn find_slot_on_track(project: &Project, track_id: Uuid, slot_id: Uuid) -> Option<PluginSlot> {
    let track = project.tracks.iter().find(|t| t.id == track_id)?;
    if let Some(inst) = &track.instrument
        && let Some(found) = find_slot_in_node_by_id(inst, slot_id)
    {
        return Some(found);
    }
    for fx in &track.effects {
        if let Some(found) = find_slot_in_node_by_id(fx, slot_id) {
            return Some(found);
        }
    }
    None
}

// ── Plugin Diagnostics ──────────────────────────────────────────────────

/// Performs filesystem-level diagnostics on an external plugin path.
/// Returns `Some(diagnostic_message)` if a problem is detected, `None` if OK.
pub fn diagnose_external_plugin_reference(plugin_id: &str) -> Option<String> {
    if plugin_id.trim().is_empty() {
        return Some("Plugin path is empty.".to_string());
    }
    if plugin_id.starts_with("internal://") {
        return None;
    }

    let path = PathBuf::from(plugin_id);
    if !path.exists() {
        if plugin_id.contains(".vst3/") {
            return Some(format!(
                "Plugin path points inside a VST3 bundle and was not found: {}. Try rescanning plugin folders.",
                plugin_id
            ));
        }
        return Some(format!(
            "Plugin path does not exist on disk: {}. Try rescanning plugin folders.",
            plugin_id
        ));
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext == "vst" {
        return Some("This plugin is VST2; current runtime supports VST3 only.".to_string());
    }
    if ext != "vst3" {
        return Some(format!(
            "Unsupported plugin extension '.{}'. Expected a .vst3 bundle path.",
            ext
        ));
    }

    let macos_dir = path.join("Contents").join("MacOS");
    if !macos_dir.exists() {
        return Some(format!(
            "VST3 bundle missing Contents/MacOS directory: {}",
            path.display()
        ));
    }
    let Ok(entries) = std::fs::read_dir(&macos_dir) else {
        return Some(format!(
            "VST3 bundle MacOS directory is not readable: {}",
            macos_dir.display()
        ));
    };
    let file_count = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .count();
    if file_count == 0 {
        return Some(format!(
            "VST3 bundle has no native binaries in {}",
            macos_dir.display()
        ));
    }

    None
}

// ── Param Helpers ───────────────────────────────────────────────────────

/// Normalizes a plugin key to lowercase alphanumeric for fuzzy matching.
pub fn normalize_plugin_key_local(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Converts underscore/dash-separated tokens to human-readable strings.
/// e.g., "filter_cutoff" → "Filter Cutoff"
pub fn humanize_param_token(raw: &str) -> String {
    let trimmed = raw.trim_matches('_').trim();
    if trimmed.is_empty() {
        return "Param".to_string();
    }
    let mut out = String::with_capacity(trimmed.len() + 4);
    let mut upper = true;
    for ch in trimmed.chars() {
        if ch == '_' || ch == '-' {
            out.push(' ');
            upper = true;
            continue;
        }
        if upper {
            out.push(ch.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(ch);
        }
    }
    out
}

/// Scans all automation lanes in the project for plugin-specific param hints,
/// returning a map of param_index → display_name.
pub fn lane_param_name_hints(project: &Project, plugin_id: &str) -> HashMap<u32, String> {
    fn scan_lanes(
        lanes: &[dream_models::project::AutomationLane],
        plugin_key: &str,
        out: &mut HashMap<u32, String>,
    ) {
        for lane in lanes {
            let key = lane.param_id.trim().to_lowercase();
            let Some(rest) = key.strip_prefix("plugin:") else {
                continue;
            };
            let mut parts = rest.splitn(3, ':');
            let _dev_idx = parts.next();
            let lane_plugin_key = parts.next().unwrap_or_default();
            let param_token = parts.next().unwrap_or_default();
            if lane_plugin_key != plugin_key || param_token.is_empty() {
                continue;
            }

            // Expected token shape from ALS import: "<name>_idN" or "idN".
            let mut id_idx: Option<u32> = None;
            if let Some(id_pos) = param_token.rfind("_id") {
                let suffix = &param_token[id_pos + 3..];
                if let Ok(v) = suffix.parse::<u32>() {
                    id_idx = Some(v);
                }
            } else if let Some(suffix) = param_token.strip_prefix("id")
                && let Ok(v) = suffix.parse::<u32>()
            {
                id_idx = Some(v);
            }
            let Some(param_index) = id_idx else { continue };

            let display = if let Some(id_pos) = param_token.rfind("_id") {
                humanize_param_token(&param_token[..id_pos])
            } else if let Some(stripped) = param_token.strip_prefix("id") {
                let idx = stripped.parse::<u32>().unwrap_or(param_index) + 1;
                format!("Param {idx}")
            } else {
                humanize_param_token(param_token)
            };
            out.entry(param_index).or_insert(display);
        }
    }

    let plugin_key = normalize_plugin_key_local(plugin_id);
    let mut out = HashMap::new();
    for track in &project.tracks {
        scan_lanes(&track.automation_lanes, &plugin_key, &mut out);
    }
    scan_lanes(
        &project.master_track.automation_lanes,
        &plugin_key,
        &mut out,
    );
    out
}

// ── DeviceNode Lookups ──────────────────────────────────────────────────

/// Recursively search inside a `DeviceNode` (rack chains) for a nested device by UUID.
pub fn find_device_node_recursive(node: &DeviceNode, device_id: Uuid) -> Option<DeviceNode> {
    match node {
        DeviceNode::Single(_) => None,
        DeviceNode::Rack(rack) => {
            for chain in &rack.chains {
                for device in &chain.devices {
                    if device.id() == device_id {
                        return Some(device.clone());
                    }
                    if let Some(found) = find_device_node_recursive(device, device_id) {
                        return Some(found);
                    }
                }
            }
            None
        }
    }
}

/// Find a `DeviceNode` by its UUID on a track (searches instrument + effects recursively).
pub fn find_device_node_on_track(
    project: &Project,
    track_id: Uuid,
    device_id: Uuid,
) -> Option<DeviceNode> {
    let track = project.tracks.iter().find(|t| t.id == track_id)?;
    if let Some(inst) = &track.instrument {
        if inst.id() == device_id {
            return Some(inst.clone());
        }
        if let Some(found) = find_device_node_recursive(inst, device_id) {
            return Some(found);
        }
    }
    for fx in &track.effects {
        if fx.id() == device_id {
            return Some(fx.clone());
        }
        if let Some(found) = find_device_node_recursive(fx, device_id) {
            return Some(found);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_plugin_key_local_strips_symbols() {
        assert_eq!(
            normalize_plugin_key_local("FabFilter Pro-Q 3"),
            "fabfilterproq3"
        );
    }

    #[test]
    fn humanize_param_token_converts_underscores() {
        assert_eq!(humanize_param_token("filter_cutoff"), "Filter Cutoff");
        assert_eq!(humanize_param_token(""), "Param");
    }

    #[test]
    fn diagnose_returns_none_for_internal() {
        assert!(diagnose_external_plugin_reference("internal://eq8").is_none());
    }

    #[test]
    fn diagnose_returns_error_for_empty() {
        assert!(diagnose_external_plugin_reference("").is_some());
    }
}
