use dream_models::project::{PluginSlot, Project};
use dream_plugins::PluginHost;
use tauri::State;
use uuid::Uuid;

use crate::{AudioEngineHandle, AutomationRuntime, ClipPoolState, PluginHostState, ProjectState};

#[allow(dead_code)] // Preserved as backward-compatible API for non-sandbox callers.
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

/// ENTERPRISE SANDBOX FIX: Sandbox-aware variant of `apply_imported_external_state_blob`.
///
/// First attempts the in-process `host.load_state_blob()` path. If that fails
/// (sandbox instances return `UnsupportedFormat` from the default trait impl),
/// falls back to sending `RestoreState` via the sandbox supervisor IPC channel.
///
/// This fixes plugin state restore for ALL sandboxed VST3 plugins, which previously
/// had their state silently discarded on project load, editor re-open, and eager activation.
pub fn apply_external_state_blob_with_sandbox(
    host: &mut PluginHost,
    instance_id: Uuid,
    slot: &PluginSlot,
    plugin_host_state: &PluginHostState,
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

        // Try in-process path first.
        match host.load_state_blob(instance_id, maybe_kind.map(|s| s.as_str()), &decoded) {
            Ok(()) => {
                log::info!(
                    "[PluginState] Applied {} blob for '{}' via in-process path ({} bytes, kind={})",
                    label,
                    slot.name,
                    decoded.len(),
                    maybe_kind.map(|s| s.as_str()).unwrap_or("unknown")
                );
                return Ok(());
            }
            Err(e) => {
                // Check if the error is UnsupportedFormat — that means it's a sandbox instance.
                let is_unsupported = matches!(e, dream_plugins::instance::PluginError::UnsupportedFormat(_));
                if !is_unsupported {
                    return Err(format!("Failed to apply {} state blob: {e}", label));
                }

                // SANDBOX FALLBACK: Send RestoreState via IPC to the sandbox daemon.
                log::info!(
                    "[PluginState] In-process load unsupported for '{}', trying sandbox IPC...",
                    slot.name
                );

                // The blob is already base64 — use the original trimmed string directly.
                let mut supervisor = plugin_host_state.sandbox_supervisor.lock();
                match supervisor.send_restore_state(instance_id, trimmed.to_string()) {
                    Ok(()) => {
                        log::info!(
                            "[PluginState] Applied {} blob for '{}' via sandbox IPC ({} b64 chars)",
                            label,
                            slot.name,
                            trimmed.len()
                        );
                        return Ok(());
                    }
                    Err(sandbox_err) => {
                        log::warn!(
                            "[PluginState] Sandbox restore also failed for '{}': {}",
                            slot.name,
                            sandbox_err
                        );
                        return Err(format!(
                            "Failed to apply {} state blob for '{}': in-process={}, sandbox={}",
                            label, slot.name, e, sandbox_err
                        ));
                    }
                }
            }
        }
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
    project_state: &ProjectState,
    clip_pool_state: &State<'_, ClipPoolState>,
    plugin_host_state: &State<'_, PluginHostState>,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    sync_external_fx_snapshot(&project, clip_pool_state, plugin_host_state);
    Ok(())
}

pub fn sync_routing_and_mark_dirty(
    project_state: &ProjectState,
    clip_pool_state: &State<'_, ClipPoolState>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
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
    let mut restored_state_count: usize = 0;
    for slot in slots {
        if slot.plugin_id.starts_with("internal://") {
            continue;
        }
        match plugin_host_state.ensure_loaded_instance_for_slot(slot.id, &slot.plugin_id) {
            Ok(instance_id) => {
                // If ALS/native import provided processor state or preset blobs,
                // restore them immediately so playback/export starts with correct sound.
                if slot.external_state_blob.is_some() || slot.external_preset_blob.is_some() {
                    {
                        let mut host = plugin_host_state.host.lock();
                        if let Err(err) = apply_external_state_blob_with_sandbox(&mut host, instance_id, slot, plugin_host_state) {
                            log::warn!(
                                "[IPC] {log_context}: state restore failed for '{}' (slot={}): {}",
                                slot.name,
                                slot.id,
                                err
                            );
                            if first_error.is_none() {
                                first_error = Some(format!(
                                    "Plugin '{}' failed to restore state: {}",
                                    slot.name, err
                                ));
                            }
                        } else {
                            restored_state_count = restored_state_count.saturating_add(1);
                        }
                    }
                }
            }
            Err(err) => {
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
    }
    if restored_state_count > 0 {
        log::info!(
            "[IPC] {log_context}: restored imported state/preset for {} external slot(s)",
            restored_state_count
        );
    }
    first_error
}

pub fn load_external_slot_best_effort(
    slot_id: Uuid,
    plugin_id: &str,
    plugin_name: &str,
    slot_state: Option<&PluginSlot>,
    plugin_host_state: &State<'_, PluginHostState>,
    log_context: &str,
) -> Option<String> {
    if plugin_id.starts_with("internal://") {
        return None;
    }
    match plugin_host_state.ensure_loaded_instance_for_slot(slot_id, plugin_id) {
        Ok(instance_id) => {
            if let Some(slot) = slot_state
                && (slot.external_state_blob.is_some() || slot.external_preset_blob.is_some())
            {
                {
                    let mut host = plugin_host_state.host.lock();
                    if let Err(err) = apply_external_state_blob_with_sandbox(&mut host, instance_id, slot, plugin_host_state) {
                        log::warn!(
                            "[IPC] {log_context}: state restore failed for '{}' (slot={}): {}",
                            slot.name,
                            slot.id,
                            err
                        );
                    }
                }
            }
            None
        }
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

#[allow(dead_code)] // Retained for project-level operations that may need full rebuild in the future
pub fn sync_plugin_runtime_and_mark_dirty(
    project_state: &ProjectState,
    clip_pool_state: &State<'_, ClipPoolState>,
    plugin_host_state: &State<'_, PluginHostState>,
    handle: &State<'_, AudioEngineHandle>,
    app: &tauri::AppHandle,
    rebuild_routing: bool,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    let project_name = project.name.clone();
    if rebuild_routing {
        clip_pool_state.rebuild_routing_only(&project);
    }
    // RT-SYNC FIX: Rebuild device chains FIRST (queues Remove+Add commands),
    // then publish the external_fx_snapshot (ArcSwap — instant).
    // Previously the snapshot was published first, causing the audio thread
    // to see NEW internal_slot_index values with OLD DeviceChain.slots[],
    // which silently skipped FX processing on sidechain tracks.
    let runtime_project = project.clone();
    drop(project);
    crate::state_managers::sync_engine::rebuild_runtime_device_chains_from_project(
        &runtime_project,
        handle,
    )?;
    // Publish snapshot AFTER device chain commands are queued so the audio
    // thread picks up both atomically on the same callback cycle.
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&runtime_project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();
    project_state.mark_dirty(&project_name, Some(app))?;
    Ok(())
}

/// ENTERPRISE-BYPASS-FIX: Lightweight bypass-only sync path.
///
/// Updates the external FX snapshot (so the audio thread sees the updated
/// `is_bypassed` flag) and rebuilds PDC routing (because bypassing a plugin
/// with reported latency changes time-alignment for other tracks).
///
/// Crucially, this does NOT call `rebuild_runtime_device_chains_from_project`
/// which sends `ClearAllDeviceChains` — that command destroys ALL device chains
/// across ALL tracks, killing reverb/delay tails and causing metallic artifacts
/// during the 1-2 callback rebuild window. Bypass doesn't change device chain
/// topology, only the processing state of an existing slot.
///
/// For internal effects: the `BypassDevice` engine command (sent separately by
/// the caller) sets the `InternalDeviceSlot::bypassed` flag, which triggers a
/// smooth 5ms IIR crossfade ramp between wet and dry signals.
///
/// For external plugins: the `SharedExternalPluginSnapshot.is_bypassed` flag
/// (updated via `rebuild_external_fx_snapshot`) causes `process_track_graph_node`
/// to skip the `try_lock()` call entirely.
pub fn sync_bypass_only_and_mark_dirty(
    project_state: &ProjectState,
    clip_pool_state: &State<'_, ClipPoolState>,
    plugin_host_state: &State<'_, PluginHostState>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    let project_name = project.name.clone();
    // Rebuild routing for PDC recalculation: bypassing a plugin with reported
    // latency (e.g., lookahead compressor) changes PDC edge delays for all tracks.
    // This is correct behavior matching Ableton Live / Logic Pro.
    clip_pool_state.rebuild_routing_only(&project);
    // Rebuild FX snapshot so the audio thread sees the updated is_bypassed flag
    // via the wait-free ArcSwap read in process_track_graph_node.
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();
    drop(project);
    project_state.mark_dirty(&project_name, Some(app))?;
    Ok(())
}

/// ENTERPRISE: Per-track plugin sync path for plugin mutations (add, remove,
/// move, paste, replace).
///
/// This function:
/// 1. Rebuilds routing (PDC recalculation) — lightweight, no audio disruption
/// 2. Rebuilds device chain for ONLY the affected track via
///    `rebuild_single_track_device_chain` — preserves all other tracks' effect
///    tails (reverb, delay, etc.)
/// 3. Publishes the external FX snapshot and registry — wait-free ArcSwap
///
/// This replaces `sync_plugin_runtime_and_mark_dirty` for single-track plugin
/// mutations. The global variant is still used for project-level operations
/// (load, undo/redo, track reorder) where ALL tracks legitimately change.
pub fn sync_plugin_runtime_single_track_and_mark_dirty(
    project_state: &ProjectState,
    clip_pool_state: &State<'_, ClipPoolState>,
    plugin_host_state: &State<'_, PluginHostState>,
    handle: &State<'_, AudioEngineHandle>,
    app: &tauri::AppHandle,
    track_index: usize,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    let project_name = project.name.clone();

    // Rebuild routing for PDC recalculation (lightweight, no audio disruption)
    clip_pool_state.rebuild_routing_only(&project);

    // Rebuild device chain for ONLY the affected track
    let runtime_project = project.clone();
    drop(project);
    crate::state_managers::sync_engine::rebuild_single_track_device_chain(
        &runtime_project,
        handle,
        track_index,
    )?;

    // Publish FX snapshot + registry AFTER device chain commands are queued
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&runtime_project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();

    project_state.mark_dirty(&project_name, Some(app))?;
    log::info!(
        "[PluginSync] Single-track device chain rebuild for track {} ('{}')",
        track_index,
        runtime_project.tracks.get(track_index).map(|t| t.name.as_str()).unwrap_or("?"),
    );
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
    // Use OFFLINE_BUFFER_FRAMES (512) to match the actual block size used by
    // OfflineRenderer. This ensures VST3 plugin internals (envelope followers,
    // sidechain compressors) produce identical output to the RT path.
    let buffer_size = dream_engine::offline_bounce::OFFLINE_BUFFER_FRAMES_FOR_PLUGINS;
    plugin_host_state
        .reactivate_all(project_sample_rate.max(1.0), buffer_size)
        .map_err(|e| format!("{op_name} aborted: failed to reactivate plugin runtime: {e}"))?;

    Ok(())
}

pub fn finalize_external_param_update(
    project_state: &ProjectState,
    clip_pool_state: &State<'_, ClipPoolState>,
    plugin_host_state: &State<'_, PluginHostState>,
    automation_runtime: &State<'_, AutomationRuntime>,
    app: &tauri::AppHandle,
    should_commit_snapshot: bool,
) -> Result<(), String> {
    *project_state.is_dirty.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())? = true;
    if !should_commit_snapshot {
        return Ok(());
    }

    let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    crate::state_managers::rebuild_automation_snapshot_from_project(&project, automation_runtime);
    clip_pool_state.rebuild_external_fx_snapshot(&project, plugin_host_state.slot_instance_snapshot().as_ref());
    plugin_host_state.publish_registry();
    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(app))?;
    Ok(())
}

pub fn finalize_internal_param_update(
    project_state: &ProjectState,
    clip_pool_state: &State<'_, ClipPoolState>,
    automation_runtime: &State<'_, AutomationRuntime>,
    handle: &State<'_, AudioEngineHandle>,
    app: &tauri::AppHandle,
    should_commit_snapshot: bool,
) -> Result<(), String> {
    if should_commit_snapshot {
        let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        let project_name = project.name.clone();
        clip_pool_state.rebuild_routing_only(&project);
        crate::state_managers::rebuild_automation_snapshot_from_project(&project, automation_runtime);
        crate::state_managers::rebuild_sampler_snapshot_from_project(&project, clip_pool_state, handle);
        drop(project);
        project_state.mark_dirty(&project_name, Some(app))?;
    } else {
        // Always update the window title `*` marker so users see their changes
        // are unsaved, even for intermediate gesture values (pushUndoStep=false).
        project_state.mark_dirty_current(Some(app))?;
    }
    Ok(())
}
