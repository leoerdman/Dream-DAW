use dream_plugins::PluginSandboxStatus;

/// Snapshot plugin sandbox runtime (supervisor + instance statuses).
#[tauri::command]
fn get_plugin_sandbox_runtime(
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<PluginSandboxSnapshot, String> {
    plugin_host_state.sandbox_snapshot()
}

/// Enable/disable out-of-process plugin sandbox mode.
///
/// When disabled, plugin windows are loaded in-process (legacy path).
#[tauri::command]
fn set_plugin_sandbox_enabled(
    enabled: bool,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<PluginSandboxSnapshot, String> {
    plugin_host_state.set_sandbox_enabled(enabled)
}

/// Run one watchdog tick for sandboxed plugin host processes.
#[tauri::command]
fn tick_plugin_sandbox_watchdog(
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<PluginSandboxSnapshot, String> {
    plugin_host_state.tick_sandbox_watchdog()
}

#[derive(Debug, Clone, Serialize)]
struct ReloadSandboxInstancesResponse {
    snapshot: PluginSandboxSnapshot,
    restarted_instances: usize,
    changed_slots: usize,
    errors: Vec<String>,
}

/// Manually restart a sandboxed plugin host process and clear forced bypass.
#[tauri::command]
fn reload_plugin_sandbox_instance(
    instance_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<PluginSandboxSnapshot, String> {
    let instance_uuid =
        Uuid::parse_str(&instance_id).map_err(|_| format!("Invalid instance_id: {instance_id}"))?;
    let slot_ids = plugin_host_state.manual_restart_sandbox_instance(instance_uuid)?;

    if !slot_ids.is_empty() {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        let changed = set_plugin_slots_bypass_in_project(&mut project, &slot_ids, false);
        if changed > 0 {
            clip_pool_state.rebuild_routing_only(&project);
            let slot_instance_map = plugin_host_state.slot_instance_snapshot();
            clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
            let _ = project_state.mark_dirty(&project.name, Some(&app));
        }
        let _ = app.emit(
            "plugin_sandbox_reloaded",
            serde_json::json!({
                "instanceId": instance_id,
                "slotIds": slot_ids.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                "changedSlots": changed,
            }),
        );
    }

    plugin_host_state.sandbox_snapshot()
}

/// Restart all unhealthy sandbox instances in one backend transaction.
#[tauri::command]
fn reload_unhealthy_plugin_sandboxes(
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<ReloadSandboxInstancesResponse, String> {
    let snapshot = plugin_host_state.sandbox_snapshot()?;
    if !snapshot.enabled {
        return Ok(ReloadSandboxInstancesResponse {
            snapshot,
            restarted_instances: 0,
            changed_slots: 0,
            errors: Vec::new(),
        });
    }

    let targets: Vec<_> = snapshot
        .instances
        .iter()
        .filter(|inst| {
            matches!(
                inst.status,
                PluginSandboxStatus::Crashed | PluginSandboxStatus::TimedOut
            ) || inst.bypass_requested
        })
        .map(|inst| inst.plugin_instance_id)
        .collect();

    if targets.is_empty() {
        return Ok(ReloadSandboxInstancesResponse {
            snapshot,
            restarted_instances: 0,
            changed_slots: 0,
            errors: Vec::new(),
        });
    }

    let mut restarted_instances = 0usize;
    let mut recovered_slot_ids = std::collections::HashSet::<Uuid>::new();
    let mut errors = Vec::new();

    for instance_id in targets {
        match plugin_host_state.manual_restart_sandbox_instance(instance_id) {
            Ok(slot_ids) => {
                restarted_instances = restarted_instances.saturating_add(1);
                recovered_slot_ids.extend(slot_ids);
            }
            Err(err) => errors.push(format!("{instance_id}: {err}")),
        }
    }

    let mut changed_slots = 0usize;
    if !recovered_slot_ids.is_empty() {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        changed_slots =
            set_plugin_slots_bypass_in_project(&mut project, &recovered_slot_ids, false);
        if changed_slots > 0 {
            clip_pool_state.rebuild_routing_only(&project);
            let slot_instance_map = plugin_host_state.slot_instance_snapshot();
            clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
            let _ = project_state.mark_dirty(&project.name, Some(&app));
        }
        let _ = app.emit(
            "plugin_sandbox_reloaded",
            serde_json::json!({
                "instanceIds": recovered_slot_ids.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                "changedSlots": changed_slots,
                "restartedInstances": restarted_instances,
                "errors": errors,
            }),
        );
    }

    let snapshot = plugin_host_state.sandbox_snapshot()?;
    Ok(ReloadSandboxInstancesResponse {
        snapshot,
        restarted_instances,
        changed_slots,
        errors,
    })
}

/// Unified frontend error logger (ErrorBoundary -> backend log).
#[tauri::command]
fn log_frontend_error(module: String, error: String, stack: Option<String>) -> Result<(), String> {
    if let Some(stack_trace) = stack {
        log::error!(
            "[FrontendError] module={} error={} stack={}",
            module,
            error,
            stack_trace
        );
    } else {
        log::error!("[FrontendError] module={} error={}", module, error);
    }
    Ok(())
}
