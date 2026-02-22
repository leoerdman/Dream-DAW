use dream_models::project::{DeviceNode, PluginSlot, Project};
use dream_plugins::PluginHost;
use tauri::State;
use uuid::Uuid;

use crate::PluginHostState;

pub fn bind_runtime_instance_for_plugin_slots(
    project: &Project,
    plugin_id: &str,
    instance_id: Uuid,
    plugin_host_state: &State<'_, PluginHostState>,
) {
    fn visit_node(
        node: &DeviceNode,
        plugin_id: &str,
        instance_id: Uuid,
        plugin_host_state: &State<'_, PluginHostState>,
    ) {
        match node {
            DeviceNode::Single(slot) => {
                if slot.plugin_id == plugin_id {
                    if !plugin_host_state.slot_instance_snapshot().contains_key(&slot.id) {
                        plugin_host_state.bind_slot_instance(slot.id, instance_id);
                    }
                }
            }
            DeviceNode::Rack(rack) => {
                for chain in &rack.chains {
                    for child in &chain.devices {
                        visit_node(child, plugin_id, instance_id, plugin_host_state);
                    }
                }
            }
        }
    }

    for track in &project.tracks {
        if let Some(inst) = &track.instrument {
            visit_node(inst, plugin_id, instance_id, plugin_host_state);
        }
        for node in &track.effects {
            visit_node(node, plugin_id, instance_id, plugin_host_state);
        }
    }
    for node in &project.master_track.effects {
        visit_node(node, plugin_id, instance_id, plugin_host_state);
    }
}

pub fn apply_imported_external_state_blob(
    host: &mut PluginHost,
    instance_id: Uuid,
    slot: &PluginSlot,
) -> Result<(), String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    let attempts: Vec<(&str, Option<&String>, Option<&String>)> = vec![
        (
            "state",
            slot.external_state_blob.as_ref(),
            slot.external_state_blob_kind.as_ref(),
        ),
        (
            "preset",
            slot.external_preset_blob.as_ref(),
            slot.external_preset_blob_kind.as_ref(),
        ),
    ];

    for (label, maybe_blob, maybe_kind) in attempts {
        let Some(blob) = maybe_blob else { continue };
        let trimmed = blob.trim();
        if trimmed.is_empty() {
            continue;
        }
        let decoded = match STANDARD.decode(trimmed.as_bytes()) {
            Ok(bytes) => bytes,
            Err(err) => {
                log::warn!(
                    "[PluginState] {} blob decode failed for '{}': {}",
                    label,
                    slot.name,
                    err
                );
                continue;
            }
        };
        if decoded.is_empty() {
            continue;
        }
        host.load_state_blob(instance_id, maybe_kind.map(|s| s.as_str()), &decoded)
            .map_err(|e| format!("Failed to apply {} state blob: {e}", label))?;
        log::info!(
            "[PluginState] Applied {} blob for '{}' ({} bytes, kind={})",
            label,
            slot.name,
            decoded.len(),
            maybe_kind.map(|s| s.as_str()).unwrap_or("unknown")
        );
        return Ok(());
    }

    Ok(())
}

