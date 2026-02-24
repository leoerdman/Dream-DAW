use dream_models::project::{PluginSlot, Project};
use dream_plugins::PluginHost;
use tauri::State;
use uuid::Uuid;

use crate::{AudioEngineHandle, AutomationRuntime, ClipPoolState, PluginHostState, ProjectState};

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

pub fn sync_external_fx_snapshot(
    project: &Project,
    clip_pool_state: &State<'_, ClipPoolState>,
    plugin_host_state: &State<'_, PluginHostState>,
) {
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();
}

pub fn sync_external_fx_snapshot_from_state(
    project_state: &State<'_, ProjectState>,
    clip_pool_state: &State<'_, ClipPoolState>,
    plugin_host_state: &State<'_, PluginHostState>,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    sync_external_fx_snapshot(&project, clip_pool_state, plugin_host_state);
    Ok(())
}

pub fn sync_routing_and_mark_dirty(
    project_state: &State<'_, ProjectState>,
    clip_pool_state: &State<'_, ClipPoolState>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    clip_pool_state.rebuild_routing_only(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(app))?;
    Ok(())
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

pub fn ensure_external_plugins_prepared_for_offline_render(
    project: &Project,
    clip_pool_state: &State<'_, ClipPoolState>,
    plugin_host_state: &State<'_, PluginHostState>,
    project_sample_rate: f64,
    op_name: &str,
) -> Result<(), String> {
    let mut slot_instance_map = plugin_host_state.slot_instance_snapshot();
    let mut ensured_count = 0usize;

    let mut ensure_loaded_slot = |slot: &PluginSlot| {
        let plugin_id = slot.plugin_id.as_str();
        if plugin_id.starts_with("internal://") || plugin_id.starts_with("missing://") {
            return;
        }
        if slot_instance_map.contains_key(&slot.id) {
            return;
        }
        match plugin_host_state.ensure_loaded_instance_for_slot(slot.id, plugin_id) {
            Ok(_) => {
                ensured_count = ensured_count.saturating_add(1);
                slot_instance_map = plugin_host_state.slot_instance_snapshot();
            }
            Err(err) => {
                log::warn!(
                    "[{op_name}] Failed to ensure plugin instance for slot '{}' ({}): {}",
                    slot.name,
                    plugin_id,
                    err
                );
            }
        }
    };

    for track in &project.tracks {
        if let Some(inst) = &track.instrument {
            for slot in inst.collect_plugin_slots() {
                ensure_loaded_slot(slot);
            }
        }
        for node in &track.effects {
            for slot in node.collect_plugin_slots() {
                ensure_loaded_slot(slot);
            }
        }
    }
    if let Some(inst) = &project.master_track.instrument {
        for slot in inst.collect_plugin_slots() {
            ensure_loaded_slot(slot);
        }
    }
    for node in &project.master_track.effects {
        for slot in node.collect_plugin_slots() {
            ensure_loaded_slot(slot);
        }
    }

    if ensured_count > 0 {
        log::info!(
            "[{op_name}] Ensured {} previously-unbound external plugin slot(s) before offline render",
            ensured_count
        );
    }

    clip_pool_state.rebuild_external_fx_snapshot(project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();
    plugin_host_state
        .reactivate_all(project_sample_rate.max(1.0), 512)
        .map_err(|e| format!("{op_name} aborted: failed to reactivate plugin runtime: {e}"))?;

    Ok(())
}

pub fn finalize_external_param_update(
    project_state: &State<'_, ProjectState>,
    clip_pool_state: &State<'_, ClipPoolState>,
    plugin_host_state: &State<'_, PluginHostState>,
    automation_runtime: &State<'_, AutomationRuntime>,
    app: &tauri::AppHandle,
    should_commit_snapshot: bool,
) -> Result<(), String> {
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    if !should_commit_snapshot {
        return Ok(());
    }

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    crate::state_managers::rebuild_automation_snapshot_from_project(&project, automation_runtime);
    clip_pool_state.rebuild_external_fx_snapshot(&project, plugin_host_state.slot_instance_snapshot().as_ref());
    plugin_host_state.publish_registry();
    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(app))?;
    Ok(())
}

pub fn finalize_internal_param_update(
    project_state: &State<'_, ProjectState>,
    clip_pool_state: &State<'_, ClipPoolState>,
    automation_runtime: &State<'_, AutomationRuntime>,
    handle: &State<'_, AudioEngineHandle>,
    app: &tauri::AppHandle,
    should_commit_snapshot: bool,
) -> Result<(), String> {
    if should_commit_snapshot {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let project_name = project.name.clone();
        clip_pool_state.rebuild_routing_only(&project);
        crate::state_managers::rebuild_automation_snapshot_from_project(&project, automation_runtime);
        crate::state_managers::rebuild_sampler_snapshot_from_project(&project, clip_pool_state, handle);
        drop(project);
        project_state.mark_dirty(&project_name, Some(app))?;
    } else {
        *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    }
    Ok(())
}
