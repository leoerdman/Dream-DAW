use dream_models::project::{DeviceNode, PluginSlot, Project};
use dream_plugins::PluginHost;
use tauri::State;
use uuid::Uuid;

use crate::{ClipPoolState, PluginHostState, ProjectState};

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

pub fn collect_external_slot_refs(project: &Project) -> Vec<(Uuid, String)> {
    fn collect_external_slots_from_node(node: &DeviceNode, out: &mut Vec<(Uuid, String)>) {
        match node {
            DeviceNode::Single(slot) => {
                if !slot.plugin_id.starts_with("internal://") && !slot.plugin_id.is_empty() {
                    out.push((slot.id, slot.plugin_id.clone()));
                }
            }
            DeviceNode::Rack(rack) => {
                for chain in &rack.chains {
                    for child in &chain.devices {
                        collect_external_slots_from_node(child, out);
                    }
                }
            }
        }
    }

    let mut external_slots: Vec<(Uuid, String)> = Vec::new();
    for track in &project.tracks {
        if let Some(inst) = &track.instrument {
            collect_external_slots_from_node(inst, &mut external_slots);
        }
        for fx in &track.effects {
            collect_external_slots_from_node(fx, &mut external_slots);
        }
    }
    for fx in &project.master_track.effects {
        collect_external_slots_from_node(fx, &mut external_slots);
    }
    external_slots
}

pub fn sync_external_fx_snapshot(
    project: &Project,
    clip_pool_state: &State<'_, ClipPoolState>,
    plugin_host_state: &State<'_, PluginHostState>,
) {
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();
}

pub fn load_external_slots_best_effort(
    slots: &[PluginSlot],
    plugin_host_state: &State<'_, PluginHostState>,
    log_context: &str,
) -> Option<String> {
    let mut first_error: Option<String> = None;
    for slot in slots {
        if slot.plugin_id.starts_with("internal://") {
            continue;
        }
        if let Err(err) = plugin_host_state.ensure_loaded_instance_for_slot(slot.id, &slot.plugin_id) {
            log::warn!(
                "[IPC] {log_context}: plugin '{}' failed to load (slot={}): {}",
                slot.plugin_id,
                slot.id,
                err
            );
            if first_error.is_none() {
                first_error = Some(format!("Plugin '{}' failed to load: {}", slot.name, err));
            }
        }
    }
    first_error
}

pub fn load_external_slot_best_effort(
    slot_id: Uuid,
    plugin_id: &str,
    plugin_name: &str,
    plugin_host_state: &State<'_, PluginHostState>,
    log_context: &str,
) -> Option<String> {
    if plugin_id.starts_with("internal://") {
        return None;
    }
    match plugin_host_state.ensure_loaded_instance_for_slot(slot_id, plugin_id) {
        Ok(_) => None,
        Err(err) => {
            log::warn!(
                "[IPC] {log_context}: plugin '{}' failed to load (slot={}): {}",
                plugin_id,
                slot_id,
                err
            );
            Some(format!("Plugin '{}' failed to load: {}", plugin_name, err))
        }
    }
}

pub fn sync_plugin_runtime_and_mark_dirty(
    project_state: &State<'_, ProjectState>,
    clip_pool_state: &State<'_, ClipPoolState>,
    plugin_host_state: &State<'_, PluginHostState>,
    app: &tauri::AppHandle,
    rebuild_routing: bool,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    if rebuild_routing {
        clip_pool_state.rebuild_routing_only(&project);
    }
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();
    drop(project);
    project_state.mark_dirty(&project_name, Some(app))?;
    Ok(())
}
