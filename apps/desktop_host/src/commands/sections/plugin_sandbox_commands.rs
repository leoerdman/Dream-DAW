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

/// Manually restart a sandboxed plugin host process.
#[tauri::command]
fn reload_plugin_sandbox_instance(
    instance_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<PluginSandboxSnapshot, String> {
    let instance_uuid =
        Uuid::parse_str(&instance_id).map_err(|_| format!("Invalid instance_id: {instance_id}"))?;
    let slot_ids = plugin_host_state.manual_restart_sandbox_instance(instance_uuid)?;

    if !slot_ids.is_empty() {
        // ENTERPRISE/Lazarus: Do NOT clear project-level forced bypass here.
        // The daemon is only "spawning" after manual restart; clearing bypass
        // early can route not-yet-recovered plugin output and create glitches.
        //
        // Bypass is lifted by the watchdog path when we receive an actual
        // PluginHostEventMessage::Ready -> PluginRecoveryEvent.
        let _ = app.emit(
            "plugin_sandbox_reloaded",
            serde_json::json!({
                "instanceId": instance_id,
                "slotIds": slot_ids.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                "changedSlots": 0usize,
            }),
        );
    }

    plugin_host_state.sandbox_snapshot()
}

/// Restart all unhealthy sandbox instances in one backend transaction.
#[tauri::command]
fn reload_unhealthy_plugin_sandboxes(
    plugin_host_state: tauri::State<'_, PluginHostState>,
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

    // ENTERPRISE/Lazarus: leave changed_slots=0 on restart request.
    // Forced bypass is cleared only on confirmed recovery (Ready event).
    let changed_slots = 0usize;
    if !recovered_slot_ids.is_empty() {
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
