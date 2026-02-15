// ═══════════════════════════════════════════════════════════════════════

fn find_slot_in_node_by_plugin_id(node: &DeviceNode, plugin_id: &str) -> Option<PluginSlot> {
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

fn find_project_plugin_slot(project: &Project, plugin_id: &str) -> Option<PluginSlot> {
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

fn find_slot_in_node_by_id(node: &DeviceNode, slot_id: Uuid) -> Option<PluginSlot> {
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

fn find_slot_on_track(project: &Project, track_id: Uuid, slot_id: Uuid) -> Option<PluginSlot> {
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

fn bind_runtime_instance_for_plugin_slots(
    project: &Project,
    plugin_id: &str,
    instance_id: Uuid,
    plugin_host_state: &tauri::State<'_, PluginHostState>,
) {
    fn visit_node(
        node: &DeviceNode,
        plugin_id: &str,
        instance_id: Uuid,
        plugin_host_state: &tauri::State<'_, PluginHostState>,
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

fn apply_imported_external_state_blob(
    host: &mut PluginHost,
    instance_id: uuid::Uuid,
    slot: &PluginSlot,
) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

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

fn normalize_plugin_key_local(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn humanize_param_token(raw: &str) -> String {
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

fn lane_param_name_hints(project: &Project, plugin_id: &str) -> std::collections::HashMap<u32, String> {
    fn scan_lanes(
        lanes: &[dream_models::project::AutomationLane],
        plugin_key: &str,
        out: &mut std::collections::HashMap<u32, String>,
    ) {
        for lane in lanes {
            let key = lane.param_id.trim().to_lowercase();
            let Some(rest) = key.strip_prefix("plugin:") else { continue };
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
    let mut out = std::collections::HashMap::new();
    for track in &project.tracks {
        scan_lanes(&track.automation_lanes, &plugin_key, &mut out);
    }
    scan_lanes(&project.master_track.automation_lanes, &plugin_key, &mut out);
    out
}

fn ensure_loaded_external_instance(
    plugin_id: &str,
    plugin_host_state: &tauri::State<'_, PluginHostState>,
    project_state: &tauri::State<'_, ProjectState>,
) -> Result<Uuid, String> {
    if let Some(instance_id) = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .get(plugin_id)
        .copied()
    {
        if let Ok(project) = project_state.project.lock() {
            bind_runtime_instance_for_plugin_slots(&project, plugin_id, instance_id, plugin_host_state);
        }
        return Ok(instance_id);
    }

    let descriptor = plugin_host_state.resolve_descriptor(plugin_id)?;
    if descriptor.format != PluginFormat::VST3 {
        return Err(format!(
            "External parameter control is currently supported only for VST3 (got {})",
            descriptor.format
        ));
    }

    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let instance_id = host
        .load_vst3(descriptor.clone())
        .map_err(|e| format!("Failed to load plugin '{}': {e}", descriptor.name))?;
    if let Ok(project) = project_state.project.lock()
        && let Some(slot) = find_project_plugin_slot(&project, plugin_id)
        && let Err(err) = apply_imported_external_state_blob(&mut host, instance_id, &slot)
    {
        log::warn!(
            "[PluginState] Could not restore imported state for '{}': {}",
            slot.name,
            err
        );
    }
    drop(host);

    plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .insert(plugin_id.to_string(), instance_id);

    if let Ok(project) = project_state.project.lock() {
        bind_runtime_instance_for_plugin_slots(&project, plugin_id, instance_id, plugin_host_state);
    }

    Ok(instance_id)
}

/// Open plugin native GUI window.
///
/// Current implementation delegates lifecycle to the backend plugin host.
/// If host-side windowing is not wired yet, this call is a no-op with logging.
#[tauri::command]
fn open_plugin_window(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<(), String> {
    if plugin_host_state.open_sandbox_editor(&plugin_id)? {
        log::info!("[IPC] open_plugin_window({plugin_id}) -> already managed by sandbox host");
        return Ok(());
    }

    if let Some(instance_id) = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .get(&plugin_id)
        .copied()
    {
        if let Ok(project) = project_state.project.lock() {
            bind_runtime_instance_for_plugin_slots(&project, &plugin_id, instance_id, &plugin_host_state);
        }
        let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
        host.open_editor(instance_id)
            .map_err(|e| format!("Failed to open existing plugin editor: {e}"))?;
        log::info!("[IPC] open_plugin_window({plugin_id}) -> reuse instance {instance_id}");
        return Ok(());
    }

    let descriptor = plugin_host_state.resolve_descriptor(&plugin_id)?;

    if plugin_host_state.sandbox_enabled().unwrap_or(false) {
        match plugin_host_state.open_in_sandbox(&plugin_id, descriptor.clone()) {
            Ok(instance_id) => {
                log::info!(
                    "[IPC] open_plugin_window({plugin_id}) -> sandbox instance {} ({})",
                    instance_id,
                    descriptor.path.display()
                );
                return Ok(());
            }
            Err(err) => {
                log::warn!(
                    "[PluginSandbox] open_plugin_window({plugin_id}) sandbox failed: {}. Falling back to in-process host.",
                    err
                );
            }
        }
    }

    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let instance_id = host
        .load_vst3(descriptor.clone())
        .map_err(|e| format!("Failed to load plugin '{}': {e}", descriptor.name))?;
    if let Ok(project) = project_state.project.lock()
        && let Some(slot) = find_project_plugin_slot(&project, &plugin_id)
        && let Err(err) = apply_imported_external_state_blob(&mut host, instance_id, &slot)
    {
        log::warn!(
            "[PluginState] Could not restore imported state for '{}': {}",
            slot.name,
            err
        );
    }
    if let Err(err) = host.open_editor(instance_id) {
        // Roll back loaded instance on editor-open failure to avoid leaked/ghost instances.
        let _ = host.remove(instance_id);
        return Err(format!("Plugin loaded but editor failed to open: {err}"));
    }
    drop(host);

    plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .insert(plugin_id.clone(), instance_id);
    if let Ok(project) = project_state.project.lock() {
        bind_runtime_instance_for_plugin_slots(&project, &plugin_id, instance_id, &plugin_host_state);
    }

    log::info!(
        "[IPC] open_plugin_window({plugin_id}) -> loaded VST instance {} ({})",
        instance_id,
        descriptor.path.display()
    );
    Ok(())
}

#[tauri::command]
fn open_plugin_window_for_slot(
    track_id: String,
    slot_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;

    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();
    let slot = find_slot_on_track(&project, track_uuid, slot_uuid)
        .ok_or_else(|| format!("Plugin slot not found on track {}: {}", track_id, slot_id))?;

    if slot.plugin_id.starts_with("internal://") {
        return Err("Internal device has no native external editor".to_string());
    }

    let instance_id = plugin_host_state.ensure_loaded_instance_for_slot(slot.id, &slot.plugin_id)?;
    plugin_host_state.bind_slot_instance(slot.id, instance_id);

    let mut first_open_err: Option<String> = None;
    {
        let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
        if let Err(err) = host.open_editor(instance_id) {
            first_open_err = Some(err.to_string());
        }
    }

    if let Some(first_err) = first_open_err {
        log::warn!(
            "[IPC] open_plugin_window_for_slot first open failed (track={}, slot={}, instance={}): {}",
            track_id,
            slot_id,
            instance_id,
            first_err
        );

        // Hard recovery path: drop stale instance, reload fresh, retry once.
        {
            let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
            let _ = host.remove(instance_id);
        }
        plugin_host_state.unbind_slot_instance(slot.id);

        let recovered_instance = plugin_host_state.ensure_loaded_instance_for_slot(slot.id, &slot.plugin_id)?;
        plugin_host_state.bind_slot_instance(slot.id, recovered_instance);
        {
            let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
            host.open_editor(recovered_instance).map_err(|e| {
                format!(
                    "Failed to open plugin editor (retry after reload). First error: {}. Retry error: {}",
                    first_err,
                    e
                )
            })?;
        }
    }

    clip_pool_state.rebuild_external_fx_snapshot(&project, plugin_host_state.slot_instance_snapshot().as_ref());
    log::info!(
        "[IPC] open_plugin_window_for_slot(track={}, slot={}) -> instance {}",
        track_id,
        slot_id,
        instance_id
    );
    Ok(())
}

#[tauri::command]
fn can_open_plugin_editor(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<PluginEditorCapability, String> {
    if plugin_host_state
        .loaded_sandbox_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&plugin_id)
    {
        return Ok(PluginEditorCapability {
            supported: true,
            reason: None,
        });
    }

    if let Some(instance_id) = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .get(&plugin_id)
        .copied()
    {
        let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
        let supported = host
            .supports_editor(instance_id)
            .map_err(|e| format!("Failed to check editor capability: {e}"))?;
        return Ok(PluginEditorCapability {
            supported,
            reason: if supported {
                None
            } else {
                Some("Native plugin editor host bridge is not implemented yet for this instance.".to_string())
            },
        });
    }

    let descriptor = plugin_host_state.resolve_descriptor(&plugin_id)?;
    if descriptor.format != PluginFormat::VST3 {
        let reason = match descriptor.format {
            PluginFormat::VST3 => None,
            PluginFormat::CLAP => Some("CLAP plugin editor is not supported by this host build.".to_string()),
            PluginFormat::AudioUnit => Some("AudioUnit editor is not supported by this host build.".to_string()),
        };
        return Ok(PluginEditorCapability {
            supported: false,
            reason,
        });
    }

    Ok(PluginEditorCapability {
        // Enterprise hardening: never instantiate an unloaded third-party plugin
        // just to probe editor capability. Some plugins crash during activation,
        // which can take down the whole DAW process.
        //
        // We only do exact capability checks on already-loaded instances above.
        // For unloaded VST3 descriptors, report optimistic support and defer the
        // real result to open_plugin_window (where failures are surfaced safely).
        supported: true,
        reason: None,
    })
}

#[tauri::command]
fn can_open_plugin_editor_for_slot(
    track_id: String,
    slot_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<PluginEditorCapability, String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let slot = find_slot_on_track(&project, track_uuid, slot_uuid)
        .ok_or_else(|| format!("Plugin slot not found on track {}: {}", track_id, slot_id))?;

    if slot.plugin_id.starts_with("internal://") {
        return Ok(PluginEditorCapability {
            supported: false,
            reason: Some("Internal device does not expose a native external editor.".to_string()),
        });
    }

    let instance_id = match plugin_host_state.ensure_loaded_instance_for_slot(slot.id, &slot.plugin_id) {
        Ok(id) => id,
        Err(err) => {
            return Ok(PluginEditorCapability {
                supported: false,
                reason: Some(format!("Plugin runtime load failed: {err}")),
            });
        }
    };

    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let supported = host.supports_editor(instance_id).unwrap_or(true);
    Ok(PluginEditorCapability {
        // Keep optimistic behavior here; definitive result is open_plugin_window_for_slot.
        supported: true,
        reason: if supported {
            None
        } else {
            Some("Host reports editor bridge uncertainty; opening will attempt recovery automatically.".to_string())
        },
    })
}

#[tauri::command]
fn get_plugin_slot_runtime_status_cmd(
    track_id: String,
    slot_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<PluginSlotRuntimeStatus, String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let slot = find_slot_on_track(&project, track_uuid, slot_uuid)
        .ok_or_else(|| format!("Plugin slot not found on track {}: {}", track_id, slot_id))?;

    if slot.plugin_id.starts_with("internal://") {
        return Ok(PluginSlotRuntimeStatus {
            loaded: true,
            editor_supported: false,
            runtime: "internal".to_string(),
            sidechain_ready: slot.supports_sidechain_input.unwrap_or(false) || slot.plugin_id.contains("compressor") || slot.plugin_id.contains("gate"),
            message: None,
        });
    }

    let slot_map = plugin_host_state.slot_instance_snapshot();
    let runtime_instance = slot_map.get(&slot.id).copied();
    let sandbox_loaded = plugin_host_state
        .loaded_sandbox_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&slot.plugin_id);

    if let Some(instance_id) = runtime_instance {
        let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
        let loaded = host.get_mut(instance_id).is_some();
        let editor_supported = if loaded {
            host.supports_editor(instance_id).unwrap_or(false)
        } else {
            false
        };
        return Ok(PluginSlotRuntimeStatus {
            loaded,
            editor_supported,
            runtime: "in-process".to_string(),
            sidechain_ready: slot.supports_sidechain_input.unwrap_or(false),
            message: if loaded {
                None
            } else {
                Some("Plugin instance missing in host runtime".to_string())
            },
        });
    }

    Ok(PluginSlotRuntimeStatus {
        loaded: sandbox_loaded,
        editor_supported: true,
        runtime: if sandbox_loaded {
            "sandbox".to_string()
        } else {
            "unloaded".to_string()
        },
        sidechain_ready: slot.supports_sidechain_input.unwrap_or(false),
        message: if sandbox_loaded {
            None
        } else {
            Some("Plugin not activated yet".to_string())
        },
    })
}

#[tauri::command]
fn ensure_plugin_slot_active_cmd(
    track_id: String,
    slot_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();
    let slot = find_slot_on_track(&project, track_uuid, slot_uuid)
        .ok_or_else(|| format!("Plugin slot not found on track {}: {}", track_id, slot_id))?;
    if slot.plugin_id.starts_with("internal://") {
        return Ok(());
    }

    let instance_id = plugin_host_state.ensure_loaded_instance_for_slot(slot.id, &slot.plugin_id)?;
    plugin_host_state.bind_slot_instance(slot.id, instance_id);
    clip_pool_state.rebuild_external_fx_snapshot(&project, plugin_host_state.slot_instance_snapshot().as_ref());
    log::info!(
        "[IPC] ensure_plugin_slot_active_cmd(track={}, slot={}) -> instance {}",
        track_id,
        slot_id,
        instance_id
    );
    Ok(())
}

/// Close plugin native GUI window.
#[tauri::command]
fn close_plugin_window(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<(), String> {
    plugin_host_state.close_in_sandbox(&plugin_id)?;

    let maybe_instance = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&plugin_id);

    if let Some(instance_id) = maybe_instance {
        let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
        if let Err(err) = host.close_editor(instance_id) {
            log::warn!(
                "[IPC] close_plugin_window({plugin_id}) editor close failed for {instance_id}: {err}"
            );
        }
        host.remove(instance_id)
            .map_err(|e| format!("Failed to unload plugin instance {instance_id}: {e}"))?;
        log::info!("[IPC] close_plugin_window({plugin_id}) -> removed instance {instance_id}");
    } else {
        log::info!("[IPC] close_plugin_window({plugin_id}) -> no loaded instance");
    }
    Ok(())
}

/// Set a normalized parameter on an external plugin instance.
///
/// `value` is expected in the plugin-native normalized range [0..1].
#[tauri::command]
fn set_external_plugin_param_cmd(
    plugin_id: String,
    param_index: u32,
    value: f64,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    _project_state: tauri::State<'_, ProjectState>,
) -> Result<(), String> {
    if plugin_host_state.set_sandbox_parameter(&plugin_id, param_index, value)? {
        return Ok(());
    }

    let normalized = value.clamp(0.0, 1.0);
    let maybe_instance_id = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .get(&plugin_id)
        .copied();
    let Some(instance_id) = maybe_instance_id else {
        log::debug!(
            "[IPC] set_external_plugin_param_cmd(plugin={}, idx={}, value={:.4}) skipped: plugin not active",
            plugin_id,
            param_index,
            normalized
        );
        return Ok(());
    };
    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let instance = host
        .get_mut(instance_id)
        .ok_or_else(|| format!("Plugin instance not found: {instance_id}"))?;
    instance
        .set_parameter(param_index, normalized)
        .map_err(|e| format!("Failed to set external plugin parameter {param_index}: {e}"))?;

    log::debug!(
        "[IPC] set_external_plugin_param_cmd(plugin={}, idx={}, value={:.4})",
        plugin_id,
        param_index,
        normalized
    );
    Ok(())
}

#[tauri::command]
fn set_external_plugin_param_for_slot_cmd(
    track_id: String,
    slot_id: String,
    param_index: u32,
    value: f64,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;

    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();
    let slot = find_slot_on_track(&project, track_uuid, slot_uuid)
        .ok_or_else(|| format!("Plugin slot not found on track {}: {}", track_id, slot_id))?;
    if slot.plugin_id.starts_with("internal://") {
        return Err("Internal plugin slot does not support external parameter API".to_string());
    }

    let normalized = value.clamp(0.0, 1.0);
    let instance_id = plugin_host_state.ensure_loaded_instance_for_slot(slot.id, &slot.plugin_id)?;
    plugin_host_state.bind_slot_instance(slot.id, instance_id);

    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let instance = host
        .get_mut(instance_id)
        .ok_or_else(|| format!("Plugin instance not found: {instance_id}"))?;
    instance
        .set_parameter(param_index, normalized)
        .map_err(|e| format!("Failed to set external plugin parameter {param_index}: {e}"))?;
    drop(host);

    clip_pool_state.rebuild_external_fx_snapshot(&project, plugin_host_state.slot_instance_snapshot().as_ref());

    log::debug!(
        "[IPC] set_external_plugin_param_for_slot_cmd(track={}, slot={}, idx={}, value={:.4})",
        track_id,
        slot_id,
        param_index,
        normalized
    );
    Ok(())
}

/// Returns externally controllable plugin params for inline UI.
#[tauri::command]
fn get_external_plugin_params(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<Vec<ExternalPluginParamInfo>, String> {
    fn fallback_param_block(metadata_count: usize) -> Vec<ExternalPluginParamInfo> {
        let count = if metadata_count > 0 { metadata_count } else { 16 }.min(128);
        let mut out = Vec::with_capacity(count);
        for idx in 0..count {
            out.push(ExternalPluginParamInfo {
                index: idx as u32,
                name: format!("Param {}", idx + 1),
                min: 0.0,
                max: 1.0,
                step: 0.001,
                value: 0.5,
            });
        }
        out
    }

    let plugin_key = normalize_plugin_key_local(&plugin_id);
    if plugin_host_state
        .loaded_sandbox_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&plugin_id)
    {
        return Ok(vec![ExternalPluginParamInfo {
            index: 0,
            name: "Gain".to_string(),
            min: 0.0,
            max: 2.0,
            step: 0.001,
            value: 1.0,
        }]);
    }

    let (metadata_count, lane_name_hints) = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let count = find_project_plugin_slot(&project, &plugin_id)
            .and_then(|slot| slot.external_parameter_count)
            .unwrap_or(0)
            .max(0) as usize;
        let hints = lane_param_name_hints(&project, &plugin_key);
        (count, hints)
    };

    let Some(instance_id) = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .get(&plugin_id)
        .copied()
    else {
        return Ok(fallback_param_block(metadata_count));
    };

    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let Some(instance) = host.get_mut(instance_id) else {
        log::warn!(
            "[PluginParams] Missing instance for active plugin key '{}'; using fallback params",
            plugin_id
        );
        return Ok(fallback_param_block(metadata_count));
    };

    let host_count = instance.parameter_count() as usize;
    let count = if host_count > 0 {
        host_count
    } else if metadata_count > 0 {
        metadata_count
    } else {
        16
    }
    .min(128);

    let mut out = Vec::with_capacity(count);
    for idx in 0..count {
        let value = instance
            .get_parameter(idx as u32)
            .unwrap_or(0.5)
            .clamp(0.0, 1.0);
        let fallback_name = format!("Param {}", idx + 1);
        let name = lane_name_hints
            .get(&(idx as u32))
            .cloned()
            .unwrap_or(fallback_name);
        out.push(ExternalPluginParamInfo {
            index: idx as u32,
            name,
            min: 0.0,
            max: 1.0,
            step: 0.001,
            value,
        });
    }
    Ok(out)
}

#[tauri::command]
fn get_external_plugin_params_for_slot(
    track_id: String,
    slot_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<Vec<ExternalPluginParamInfo>, String> {
    fn fallback_param_block(metadata_count: usize) -> Vec<ExternalPluginParamInfo> {
        let count = if metadata_count > 0 { metadata_count } else { 16 }.min(128);
        (0..count)
            .map(|idx| ExternalPluginParamInfo {
                index: idx as u32,
                name: format!("Param {}", idx + 1),
                min: 0.0,
                max: 1.0,
                step: 0.001,
                value: 0.5,
            })
            .collect()
    }

    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();
    let slot = find_slot_on_track(&project, track_uuid, slot_uuid)
        .ok_or_else(|| format!("Plugin slot not found on track {}: {}", track_id, slot_id))?;

    if slot.plugin_id.starts_with("internal://") {
        return Ok(Vec::new());
    }

    let metadata_count = slot.external_parameter_count.unwrap_or(0).max(0) as usize;
    let instance_id = plugin_host_state.ensure_loaded_instance_for_slot(slot.id, &slot.plugin_id)?;
    plugin_host_state.bind_slot_instance(slot.id, instance_id);

    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let Some(instance) = host.get_mut(instance_id) else {
        return Ok(fallback_param_block(metadata_count));
    };
    let count_hint = instance.parameter_count().max(metadata_count as u32);
    let count = (if count_hint > 0 { count_hint } else { 16 }).min(128);

    let mut params = Vec::with_capacity(count as usize);
    for idx in 0..count {
        params.push(ExternalPluginParamInfo {
            index: idx,
            name: format!("Param {}", idx + 1),
            min: 0.0,
            max: 1.0,
            step: 0.001,
            value: instance.get_parameter(idx).unwrap_or(0.5),
        });
    }
    drop(host);

    clip_pool_state.rebuild_external_fx_snapshot(&project, plugin_host_state.slot_instance_snapshot().as_ref());
    Ok(params)
}

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

/// Unified frontend error logger (ErrorBoundary -> backend log).
#[tauri::command]
fn log_frontend_error(module: String, error: String, stack: Option<String>) -> Result<(), String> {
    if let Some(stack_trace) = stack {
        log::error!("[FrontendError] module={} error={} stack={}", module, error, stack_trace);
    } else {
        log::error!("[FrontendError] module={} error={}", module, error);
    }
    Ok(())
}

/// Return valid routing targets for a track.
#[tauri::command]
fn get_routing_targets(
    track_id: String,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<Vec<RoutingTarget>, String> {
    let source_id = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?;

    let mut targets = Vec::new();
    for t in &project.tracks {
        if t.id == source_id {
            continue;
        }
        targets.push(RoutingTarget {
            track_id: t.id.to_string(),
            track_name: t.name.clone(),
            track_type: format!("{:?}", t.track_type),
        });
    }
    Ok(targets)
}

/// Set output routing destination for a track.
///
/// `target_id` can be another track UUID or "master" to route directly
/// to the master bus. The project model is updated atomically.
#[tauri::command]
fn set_track_routing_cmd(
    track_id: String,
    target_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let source_id = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let destination = if target_id == "master" {
        None
    } else {
        Some(Uuid::parse_str(&target_id).map_err(|_| format!("Invalid target_id: {target_id}"))?)
    };

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    if let Some(dest_id) = destination {
        let dest_exists = project.tracks.iter().any(|t| t.id == dest_id);
        if !dest_exists {
            return Err(format!("Routing target not found: {target_id}"));
        }
    }

    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == source_id)
        .ok_or_else(|| format!("Track not found: {track_id}"))?;
    track.output_destination_id = destination;

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    log::info!("[IPC] set_track_routing_cmd({track_id} -> {target_id})");
    Ok(())
}

/// Set track audio input source (placeholder hook for sidechain/input matrix).
#[tauri::command]
fn set_track_input_cmd(
    track_id: String,
    input_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let source_id = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == source_id)
        .ok_or_else(|| format!("Track not found: {track_id}"))?;

    let normalized = input_id.trim();
    track.input_source_id = if normalized.is_empty()
        || normalized.eq_ignore_ascii_case("none")
        || normalized.eq_ignore_ascii_case("no input")
        || normalized.eq_ignore_ascii_case("no_input")
    {
        None
    } else {
        Some(normalized.to_string())
    };

    let effective_input = track.input_source_id.clone();
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    log::info!(
        "[IPC] set_track_input_cmd({track_id} <- {})",
        effective_input.as_deref().unwrap_or("none")
    );
    Ok(())
}

/// Set sidechain source track for a specific plugin slot on a track.
#[tauri::command]
fn set_plugin_sidechain_source_cmd(
    track_id: String,
    slot_id: String,
    source_track_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    let source_normalized = source_track_id.trim();
    let source_value = if source_normalized.is_empty() || source_normalized.eq_ignore_ascii_case("none") {
        None
    } else {
        Some(source_normalized.to_string())
    };

    if let Some(source_id) = &source_value {
        let source_exists = project
            .tracks
            .iter()
            .any(|t| t.id.to_string() == *source_id);
        if !source_exists {
            return Err(format!("Source track not found: {source_id}"));
        }
        if source_id == &track_id {
            return Err("Sidechain source cannot be the same track".to_string());
        }
    }

    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {track_id}"))?;

    let mut updated = false;
    if let Some(inst) = track.instrument.as_mut()
        && let Some(slot) = inst.as_single_mut()
        && slot.id == slot_uuid
    {
        if slot.supports_sidechain_input == Some(false) {
            return Err("Plugin does not expose sidechain input".to_string());
        }
        slot.sidechain_source_track_id = source_value.clone();
        updated = true;
    }
    if !updated {
        for node in &mut track.effects {
            if let Some(slot) = node.as_single_mut()
                && slot.id == slot_uuid
            {
                if slot.supports_sidechain_input == Some(false) {
                    return Err("Plugin does not expose sidechain input".to_string());
                }
                slot.sidechain_source_track_id = source_value.clone();
                updated = true;
                break;
            }
        }
    }

    if !updated {
        return Err(format!("Plugin slot not found on track {}: {}", track_id, slot_id));
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    log::info!(
        "[IPC] set_plugin_sidechain_source_cmd(track={} slot={} source={})",
        track_id,
        slot_id,
        source_value.as_deref().unwrap_or("none")
    );
    Ok(())
}

/// Add a plugin slot to a track (instrument/effect) from frontend DnD.
#[tauri::command]
fn add_plugin_to_track_cmd(
    payload: AddPluginToTrackPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<(), String> {
    fn canonical_internal_plugin(plugin_id: &str, plugin_name: &str) -> Option<(&'static str, &'static str, &'static str)> {
        let merged = format!("{} {}", plugin_id, plugin_name).to_lowercase();
        let compact = merged.replace(|c: char| !c.is_ascii_alphanumeric(), "");

        // Instruments
        if merged.contains("operator")
            || merged.contains("analog")
            || merged.contains("wavetable")
            || compact.contains("simplesinesynth")
            || merged.contains("wave synth")
            || compact.contains("wavesynth")
            || compact.contains("drift")
            || compact.contains("instrumentvector")
            || compact.contains("stringstudio")
            || compact.contains("instrumentmeld")
            || compact.contains("mxdeviceinstrument")
            || compact.contains("loungelizard")
        {
            return Some(("internal://instrument/wave-synth", "Essense", "instrument"));
        }
        if merged.contains("sampler") || merged.contains("simpler") || compact.contains("multisampler") || compact.contains("drumcell") {
            return Some(("internal://instrument/sampler", "Sampler", "instrument"));
        }

        // Effects
        if merged.contains("eq eight") || merged.contains("eq8") {
            return Some(("internal://effect/eq-eight", "EQ", "effect"));
        }
        if merged.contains("eq three") || merged.contains("band eq") || merged.contains("eq3") {
            return Some(("internal://effect/eq-three", "Band EQ", "effect"));
        }
        if merged.contains("channel eq") {
            return Some(("internal://effect/channel-eq", "Channel EQ", "effect"));
        }
        if merged.contains("multiband dynamics") {
            return Some(("internal://effect/multiband-dynamics", "Multiband Dynamics", "effect"));
        }
        if merged.contains("glue compressor") {
            return Some(("internal://effect/compressor", "Compressor", "effect"));
        }
        if merged.contains("simple delay") || merged.contains("ping pong delay") || merged.contains("echo") {
            return Some(("internal://effect/delay", "Delay", "effect"));
        }
        if merged.contains("beat repeat") || merged.contains("filter delay") || merged.contains("grain delay") || merged.contains("looper") {
            return Some(("internal://effect/delay", "Delay", "effect"));
        }
        if merged.contains("hybrid reverb") {
            return Some(("internal://effect/reverb", "Reverb", "effect"));
        }
        if merged.contains("corpus") || merged.contains("resonators") || merged.contains("spectral resonator") {
            return Some(("internal://effect/reverb", "Reverb", "effect"));
        }
        if merged.contains("chorus-ensemble") || merged.contains("chorus ensemble") {
            return Some(("internal://effect/chorus", "Chorus", "effect"));
        }
        if merged.contains("drum buss") || merged.contains("dynamic tube") {
            return Some(("internal://effect/saturator", "Saturator", "effect"));
        }
        if merged.contains("transient shaper") {
            return Some(("internal://effect/compressor", "Compressor", "effect"));
        }
        if merged.contains("vocoder") {
            return Some(("internal://effect/vocoder", "Vocoder", "effect"));
        }
        if merged.contains("spectral time") {
            return Some(("internal://effect/delay", "Delay", "effect"));
        }
        if merged.contains("roar") {
            return Some(("internal://effect/distortion", "Distortion", "effect"));
        }
        if merged.contains("auto filter") || merged.contains("autofilter") {
            return Some(("internal://effect/auto-filter", "Auto Filter", "effect"));
        }
        if merged.contains("auto pan") || merged.contains("autopan") {
            return Some(("internal://effect/auto-pan", "Auto Pan", "effect"));
        }
        if merged.contains("midipitcher") || merged.contains("midi pitch") {
            return Some(("internal://midi-fx/pitch", "MIDI Pitch", "effect"));
        }
        if merged.contains("mxdevicescale") || merged.contains("midi scale") {
            return Some(("internal://midi-fx/scale", "MIDI Scale", "effect"));
        }
        if merged.contains("mxdevicevelocity") || merged.contains("midi velocity") {
            return Some(("internal://midi-fx/velocity", "MIDI Velocity", "effect"));
        }
        if compact.contains("midivelocity") {
            return Some(("internal://midi-fx/velocity", "MIDI Velocity", "effect"));
        }
        if compact.contains("midichord") {
            return Some(("internal://midi-fx/chord", "Chord", "effect"));
        }
        if merged.contains("mxdevicerandom") || merged.contains("midi random") {
            return Some(("internal://midi-fx/random", "MIDI Random", "effect"));
        }
        if merged.contains("arpeggiator") {
            return Some(("internal://midi-fx/arpeggiator", "Arpeggiator", "effect"));
        }
        if merged.contains("cc control") || merged.contains("expression control") {
            return Some(("internal://midi-fx/velocity", "MIDI Velocity", "effect"));
        }
        if compact.contains("midiarpeggiator") {
            return Some(("internal://midi-fx/arpeggiator", "Arpeggiator", "effect"));
        }
        if merged.contains("midi note length") || compact.contains("midinotelength") {
            return Some(("internal://midi-fx/note-length", "Note Length", "effect"));
        }
        if merged.contains("spectrum") || compact.contains("spectrumanalyzer") {
            return Some(("internal://effect/spectrum", "Spectrum", "effect"));
        }
        if merged.contains("tuner") {
            return Some(("internal://effect/tuner", "Tuner", "effect"));
        }
        if compact.contains("mxdeviceaudioeffect") {
            return Some(("internal://effect/external-audio-effect", "External Audio Effect", "effect"));
        }
        if compact.contains("mxdevicemidieffect") {
            return Some(("internal://effect/utility", "Utility", "effect"));
        }
        if compact.contains("autoshift") {
            return Some(("internal://effect/auto-shift", "Auto Shift", "effect"));
        }
        if compact.contains("shifter") || compact.contains("frequencyshifter") {
            return Some(("internal://effect/shifter", "Shifter", "effect"));
        }
        if merged.contains("phaser-flanger") || merged.contains("phaser flanger") {
            return Some(("internal://effect/phaser", "Phaser", "effect"));
        }
        if merged.contains("redux") {
            return Some(("internal://effect/bitcrusher", "Bitcrusher", "effect"));
        }
        if merged.contains("overdrive") || merged.contains("pedal") || merged.contains("cabinet") || merged.contains("amp") {
            return Some(("internal://effect/distortion", "Distortion", "effect"));
        }

        None
    }

    fn waveform_code_from_token(token: &str) -> u8 {
        let normalized = token.trim().to_lowercase();
        if normalized.contains("triangle") || normalized.ends_with("/tri") {
            return 1;
        }
        if normalized.contains("saw") {
            return 2;
        }
        if normalized.contains("square") || normalized.ends_with("/pulse") {
            return 3;
        }
        0
    }

    fn builtin_effect_type_from_plugin_id(plugin_id: &str) -> Option<u8> {
        // Must match dream_dsp::dsp_processor::BuiltinEffectType discriminants.
        const FX_EQ: u8 = 0;
        const FX_COMPRESSOR: u8 = 1;
        const FX_DELAY: u8 = 2;
        const FX_REVERB: u8 = 3;
        const FX_CHORUS: u8 = 4;
        const FX_UTILITY: u8 = 5;
        const FX_SATURATOR: u8 = 6;
        const FX_LIMITER: u8 = 7;
        const FX_GATE: u8 = 8;
        const FX_AUTO_FILTER: u8 = 9;
        const FX_PHASER: u8 = 10;
        const FX_FLANGER: u8 = 11;
        const FX_DISTORTION: u8 = 12;
        const FX_BITCRUSHER: u8 = 13;
        const FX_NOISE_MACHINE: u8 = 14;
        const FX_AUTO_PAN: u8 = 15;

        let key = plugin_id.to_lowercase();

        // ── Exact internal:// prefix matches (highest priority) ──────
        if key.starts_with("internal://effect/") {
            return match key.as_str() {
                "internal://effect/eq-eight" => Some(FX_EQ),
                "internal://effect/channel-eq" => Some(FX_EQ),
                "internal://effect/eq-three" => Some(FX_EQ),
                "internal://effect/compressor" => Some(FX_COMPRESSOR),
                "internal://effect/glue-compressor" => Some(FX_COMPRESSOR),
                "internal://effect/multiband-dynamics" => Some(FX_COMPRESSOR),
                "internal://effect/transient-shaper" => Some(FX_COMPRESSOR),
                "internal://effect/delay" => Some(FX_DELAY),
                "internal://effect/echo" => Some(FX_DELAY),
                "internal://effect/simple-delay" => Some(FX_DELAY),
                "internal://effect/filter-delay" => Some(FX_DELAY),
                "internal://effect/grain-delay" => Some(FX_DELAY),
                "internal://effect/beat-repeat" => Some(FX_DELAY),
                "internal://effect/looper" => Some(FX_DELAY),
                "internal://effect/spectral-time" => Some(FX_DELAY),
                "internal://effect/reverb" => Some(FX_REVERB),
                "internal://effect/hybrid-reverb" => Some(FX_REVERB),
                "internal://effect/corpus" => Some(FX_REVERB),
                "internal://effect/resonators" => Some(FX_REVERB),
                "internal://effect/spectral-resonator" => Some(FX_REVERB),
                "internal://effect/chorus" => Some(FX_CHORUS),
                "internal://effect/utility" => Some(FX_UTILITY),
                "internal://effect/tuner" => Some(FX_UTILITY),
                "internal://effect/external-audio-effect" => Some(FX_UTILITY),
                "internal://effect/auto-shift" => Some(FX_UTILITY),
                "internal://effect/shifter" => Some(FX_UTILITY),
                "internal://effect/saturator" => Some(FX_SATURATOR),
                "internal://effect/drum-buss" => Some(FX_SATURATOR),
                "internal://effect/dynamic-tube" => Some(FX_SATURATOR),
                "internal://effect/limiter" => Some(FX_LIMITER),
                "internal://effect/gate" => Some(FX_GATE),
                "internal://effect/auto-filter" => Some(FX_AUTO_FILTER),
                "internal://effect/vocoder" => Some(FX_AUTO_FILTER),
                "internal://effect/phaser" => Some(FX_PHASER),
                "internal://effect/phaser-flanger" => Some(FX_PHASER),
                "internal://effect/flanger" => Some(FX_FLANGER),
                "internal://effect/distortion" => Some(FX_DISTORTION),
                "internal://effect/amp" => Some(FX_DISTORTION),
                "internal://effect/cabinet" => Some(FX_DISTORTION),
                "internal://effect/overdrive" => Some(FX_DISTORTION),
                "internal://effect/pedal" => Some(FX_DISTORTION),
                "internal://effect/roar" => Some(FX_DISTORTION),
                "internal://effect/bitcrusher" => Some(FX_BITCRUSHER),
                "internal://effect/erosion" => Some(FX_BITCRUSHER),
                "internal://effect/noise-machine" => Some(FX_NOISE_MACHINE),
                "internal://effect/auto-pan" => Some(FX_AUTO_PAN),
                _ => None,
            };
        }

        // ── Keyword fallbacks (Ableton device names, aliases) ────────
        if key.contains("eq eight") || key.contains("eq8") || key.contains("eq3") || key.contains("channel eq") || key.contains("eq") {
            return Some(FX_EQ);
        }
        if key.contains("compressor") || key.contains("glue") || key.contains("multiband dynamics") {
            return Some(FX_COMPRESSOR);
        }
        if key.contains("delay") || key.contains("echo") || key.contains("ping pong") {
            return Some(FX_DELAY);
        }
        if key.contains("reverb") || key.contains("hybrid reverb") {
            return Some(FX_REVERB);
        }
        if key.contains("chorus") || key.contains("chorus-ensemble") {
            return Some(FX_CHORUS);
        }
        if key.contains("saturator") {
            return Some(FX_SATURATOR);
        }
        if key.contains("limiter") {
            return Some(FX_LIMITER);
        }
        if key.contains("auto-filter") || key.contains("autofilter") || key.contains("auto filter") {
            return Some(FX_AUTO_FILTER);
        }
        if key.contains("auto-pan") || key.contains("autopan") || key.contains("auto pan") {
            return Some(FX_AUTO_PAN);
        }
        if key.contains("noise-machine") || key.contains("noisemachine") || key.contains("noise machine") {
            return Some(FX_NOISE_MACHINE);
        }
        if key.contains("phaser") || key.contains("phaser-flanger") {
            return Some(FX_PHASER);
        }
        if key.contains("flanger") {
            return Some(FX_FLANGER);
        }
        if key.contains("distortion") || key.contains("overdrive") || key.contains("pedal") || key.contains("cabinet") || key.contains("amp") {
            return Some(FX_DISTORTION);
        }
        if key.contains("bitcrusher") || key.contains("bit-crusher") || key.contains("redux") {
            return Some(FX_BITCRUSHER);
        }
        if key.contains("utility") {
            return Some(FX_UTILITY);
        }
        if key.contains("gate") {
            return Some(FX_GATE);
        }
        None
    }

    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

    let slot = payload.slot.to_lowercase();
    let canonical = canonical_internal_plugin(&payload.plugin_id, &payload.plugin_name);
    let effective_plugin_id = canonical.map(|v| v.0.to_string()).unwrap_or_else(|| payload.plugin_id.clone());
    let effective_plugin_name = canonical
        .map(|v| {
            if payload.plugin_name.trim().is_empty() {
                v.1.to_string()
            } else {
                payload.plugin_name.clone()
            }
        })
        .unwrap_or_else(|| payload.plugin_name.clone());
    let canonical_slot_hint = canonical.map(|v| v.2);
    let use_instrument = match slot.as_str() {
        "instrument" => true,
        "effect" => false,
        "auto" => canonical_slot_hint == Some("instrument")
            || (track.track_type == TrackType::Midi && track.instrument.is_none()),
        _ => track.track_type == TrackType::Midi && track.instrument.is_none(),
    };

    let plugin_id_lower = effective_plugin_id.to_lowercase();
    let is_sampler_instrument = plugin_id_lower.starts_with("internal://instrument/sampler");
    let is_wave_synth_instrument = plugin_id_lower.starts_with("internal://instrument/wave-synth")
        || plugin_id_lower.starts_with("internal://instrument/simple-sine-synth");
    let mut slot_data = PluginSlot::new(effective_plugin_name.clone(), effective_plugin_id.clone());
    let new_slot_id = slot_data.id;
    if !effective_plugin_id.starts_with("internal://")
        && let Ok(desc) = plugin_host_state.resolve_descriptor(&effective_plugin_id)
    {
        slot_data.external_audio_inputs = Some(desc.audio_inputs);
        slot_data.supports_sidechain_input = Some(desc.audio_inputs > 2);
    }
    let plugin_slot = DeviceNode::Single(slot_data);
    let mut runtime_add: Option<(Uuid, u8, u8)> = None;
    let mut runtime_waveform: Option<(Uuid, u8)> = None;
    if use_instrument {
        track.instrument = Some(plugin_slot);
        if (is_sampler_instrument || is_wave_synth_instrument) && track.sampler.is_none() {
            track.sampler = Some(SamplerConfig::default());
        }
        if is_wave_synth_instrument {
            let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
            if cfg.sample_path.trim().is_empty() {
                cfg.sample_path = "internal://waveform/sine".to_string();
            }
            runtime_waveform = Some((track.id, waveform_code_from_token(&cfg.sample_path)));
        }
    } else {
        track.effects.push(plugin_slot);
        if effective_plugin_id.starts_with("internal://")
            && let Some(effect_type) = builtin_effect_type_from_plugin_id(&effective_plugin_id)
        {
            let slot_index = (track.effects.len().saturating_sub(1)).min(u8::MAX as usize) as u8;
            runtime_add = Some((track.id, slot_index, effect_type));
        }
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    if !effective_plugin_id.starts_with("internal://") {
        if let Err(err) = plugin_host_state.ensure_loaded_instance_for_slot(new_slot_id, &effective_plugin_id) {
            log::warn!(
                "[IPC] add_plugin_to_track_cmd slot runtime init failed (slot={}, plugin={}): {}",
                new_slot_id,
                effective_plugin_id,
                err
            );
        }
    }
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    if let Some((track_id, slot_index, effect_type)) = runtime_add {
        // Map project UUID track ordering to runtime track index.
        if let Some(runtime_track_index) = project.tracks.iter().position(|t| t.id == track_id) {
            push_command(&handle, EngineCommand::AddDevice {
                track_index: runtime_track_index as u16,
                slot_index,
                effect_type,
            })?;
        }
    }
    if let Some((track_id, waveform)) = runtime_waveform {
        if let Some(runtime_track_index) = project.tracks.iter().position(|t| t.id == track_id) {
            push_command(&handle, EngineCommand::SetSamplerWaveform {
                track_index: runtime_track_index as u16,
                waveform,
            })?;
        }
    }
    log::info!(
        "[IPC] add_plugin_to_track_cmd(track={}, plugin='{}', slot={})",
        payload.track_id,
        effective_plugin_name,
        if use_instrument { "instrument" } else { "effect" }
    );
    Ok(())
}

/// Remove a plugin slot from a track (instrument/effect) by slot UUID.
#[tauri::command]
fn remove_plugin_from_track_cmd(
    payload: RemovePluginFromTrackPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let slot_uuid = Uuid::parse_str(&payload.slot_id)
        .map_err(|_| format!("Invalid slot_id: {}", payload.slot_id))?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

    let mut removed = false;
    let mut runtime_remove_slot: Option<u8> = None;
    if let Some(inst) = &track.instrument
        && inst.id() == slot_uuid
    {
        let removed_plugin_id = inst.plugin_id();
        track.instrument = None;
        let removed_lower = removed_plugin_id.to_lowercase();
        if removed_lower.starts_with("internal://instrument/sampler")
            || removed_lower.starts_with("internal://instrument/wave-synth")
            || removed_lower.starts_with("internal://instrument/simple-sine-synth")
        {
            track.sampler = None;
        }
        removed = true;
    }

    if !removed {
        if let Some(effect_idx) = track.effects.iter().position(|node| node.id() == slot_uuid) {
            runtime_remove_slot = Some(effect_idx.min(u8::MAX as usize) as u8);
            track.effects.remove(effect_idx);
            removed = true;
        }
    }

    if !removed {
        return Err(format!(
            "Plugin slot not found on track {}: {}",
            payload.track_id, payload.slot_id
        ));
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    let _ = plugin_host_state.unload_slot_instance(slot_uuid);
    clip_pool_state.rebuild_snapshot(&project);
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    if let Some(slot_index) = runtime_remove_slot
        && let Some(runtime_track_index) = project.tracks.iter().position(|t| t.id == track_uuid)
    {
        push_command(&handle, EngineCommand::RemoveDevice {
            track_index: runtime_track_index as u16,
            slot_index,
        })?;
    }
    log::info!(
        "[IPC] remove_plugin_from_track_cmd(track={}, slot={})",
        payload.track_id,
        payload.slot_id
    );
    Ok(())
}

fn upsert_static_automation_lane(track: &mut Track, param_id: &str, value: f64) {
    if let Some(existing) = track
        .automation_lanes
        .iter_mut()
        .find(|lane| lane.param_id.eq_ignore_ascii_case(param_id))
    {
        existing.points = vec![dream_models::project::AutomationPoint {
            beat: 0.0,
            value,
            curve_type: "linear".to_string(),
            tension: None,
            bezier_cp1x: None, bezier_cp1y: None, bezier_cp2x: None, bezier_cp2y: None,
        }];
        existing.param_id = param_id.to_string();
        return;
    }

    track.automation_lanes.push(dream_models::project::AutomationLane {
        param_id: param_id.to_string(),
        points: vec![dream_models::project::AutomationPoint {
            beat: 0.0,
            value,
            curve_type: "linear".to_string(),
            tension: None,
            bezier_cp1x: None, bezier_cp1y: None, bezier_cp2x: None, bezier_cp2y: None,
        }],
    });
}

/// Set internal plugin parameter value and route to engine state/snapshots.
#[tauri::command]
fn set_internal_plugin_param_cmd(
    payload: InternalPluginParamPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    fn waveform_token_and_code(value: f64) -> (&'static str, u8) {
        let idx = value.round().clamp(0.0, 3.0) as u8;
        match idx {
            1 => ("internal://waveform/triangle", 1),
            2 => ("internal://waveform/saw", 2),
            3 => ("internal://waveform/square", 3),
            _ => ("internal://waveform/sine", 0),
        }
    }

    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    if payload.push_undo_step.unwrap_or(true) {
        push_undo(&project_state)?;
    }
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let raw_key = payload.param_id.to_lowercase();
    let key = if raw_key.starts_with("slot:") {
        raw_key
            .splitn(3, ':')
            .nth(2)
            .unwrap_or(raw_key.as_str())
            .to_string()
    } else {
        raw_key.clone()
    };
    let lane_param_id = |fallback: &str| -> String {
        if raw_key.starts_with("slot:") {
            payload.param_id.clone()
        } else {
            fallback.to_string()
        }
    };
    let mut sampler_command_needed = false;
    let mut sampler_waveform: Option<u8> = None;
    let mut sampler_waveform2: Option<u8> = None;
    let mut sampler_osc_mix: Option<f32> = None;
    let mut sampler_detune_cents: Option<f32> = None;
    let mut sampler_sub_level: Option<f32> = None;
    let mut sampler_filter_cutoff: Option<f32> = None;
    let mut sampler_filter_resonance: Option<f32> = None;
    let mut sampler_filter_type: Option<u8> = None;
    let mut sampler_lfo_rate: Option<f32> = None;
    let mut sampler_lfo_depth: Option<f32> = None;
    let mut sampler_lfo_target: Option<u8> = None;
    let mut sampler_pulse_width: Option<f32> = None;
    let (track_index, sampler_cfg_for_rt) = {
        let (idx, track) = project
            .tracks
            .iter_mut()
            .enumerate()
            .find(|(_, t)| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

        match key.as_str() {
            // Utility gain in dB => plugin.gain in linear 0..2
            "gain" | "utility.gain" | "plugin.gain" => {
                let linear = 10.0_f64.powf(payload.value.clamp(-60.0, 12.0) / 20.0).clamp(0.0, 2.0);
                upsert_static_automation_lane(track, &lane_param_id("plugin.gain"), linear);
            }
            // Utility pan in -100..100 or -1..1 => plugin.pan in -1..1
            "pan" | "utility.pan" | "plugin.pan" => {
                let pan = if payload.value.abs() > 1.0 {
                    (payload.value / 100.0).clamp(-1.0, 1.0)
                } else {
                    payload.value.clamp(-1.0, 1.0)
                };
                upsert_static_automation_lane(track, &lane_param_id("plugin.pan"), pan);
            }
            "width" | "utility.width" | "plugin.width" => {
                upsert_static_automation_lane(track, &lane_param_id("plugin.width"), payload.value.clamp(0.0, 200.0));
            }
            "mono" | "utility.mono" | "plugin.mono" => {
                upsert_static_automation_lane(
                    track,
                    &lane_param_id("plugin.mono"),
                    if payload.value >= 0.5 { 1.0 } else { 0.0 },
                );
            }
            // Sampler parameters
            "sampler.volume" | "volume" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.volume = payload.value.clamp(0.0, 2.0);
                sampler_command_needed = true;
            }
            "sampler.attack" | "attack" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.attack = payload.value.clamp(0.001, 10.0);
                sampler_command_needed = true;
            }
            "sampler.decay" | "decay" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.decay = payload.value.clamp(0.001, 10.0);
                sampler_command_needed = true;
            }
            "sampler.sustain" | "sustain" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.sustain = payload.value.clamp(0.0, 1.0);
                sampler_command_needed = true;
            }
            "sampler.release" | "release" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.release = payload.value.clamp(0.001, 20.0);
                sampler_command_needed = true;
            }
            "sampler.rootnote" | "rootnote" | "sampler.root_note" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.root_note = payload.value.round().clamp(0.0, 127.0) as u8;
                sampler_command_needed = true;
            }
            "synth.waveform" | "waveform" | "sampler.waveform" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let (token, code) = waveform_token_and_code(payload.value);
                cfg.sample_path = token.to_string();
                sampler_waveform = Some(code);
            }
            "synth.osc1.waveform" | "synth.osc1.wave" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let (token, code) = waveform_token_and_code(payload.value);
                cfg.sample_path = token.to_string();
                sampler_waveform = Some(code);
            }
            "synth.osc2.waveform" | "synth.osc2.wave" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let (_, code) = waveform_token_and_code(payload.value);
                cfg.osc2_waveform = code;
                sampler_waveform2 = Some(code);
            }
            "synth.osc.mix" | "synth.oscmix" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let mix = payload.value.clamp(0.0, 1.0) as f32;
                cfg.osc_mix = mix as f64;
                sampler_osc_mix = Some(mix);
            }
            "synth.detune" | "synth.detunecents" | "synth.osc2.detune" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let cents = payload.value.clamp(-50.0, 50.0) as f32;
                cfg.detune_cents = cents as f64;
                sampler_detune_cents = Some(cents);
            }
            "synth.sub" | "synth.sublevel" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let level = payload.value.clamp(0.0, 1.0) as f32;
                cfg.sub_level = level as f64;
                sampler_sub_level = Some(level);
            }
            "synth.filter.cutoff" | "synth.filtercutoff" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let cutoff = payload.value.clamp(20.0, 20000.0) as f32;
                cfg.filter_cutoff = cutoff as f64;
                sampler_filter_cutoff = Some(cutoff);
            }
            "synth.filter.resonance" | "synth.filterresonance" | "synth.filter.res" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let res = payload.value.clamp(0.0, 0.99) as f32;
                cfg.filter_resonance = res as f64;
                sampler_filter_resonance = Some(res);
            }
            "synth.filter.type" | "synth.filtertype" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let ft = payload.value.round().clamp(0.0, 3.0) as u8;
                cfg.filter_type = ft;
                sampler_filter_type = Some(ft);
            }
            "synth.lfo.rate" | "synth.lforate" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let rate = payload.value.clamp(0.01, 20.0) as f32;
                cfg.lfo_rate = rate as f64;
                sampler_lfo_rate = Some(rate);
            }
            "synth.lfo.depth" | "synth.lfodepth" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let depth = payload.value.clamp(0.0, 1.0) as f32;
                cfg.lfo_depth = depth as f64;
                sampler_lfo_depth = Some(depth);
            }
            "synth.lfo.target" | "synth.lfotarget" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let target = payload.value.round().clamp(0.0, 2.0) as u8;
                cfg.lfo_target = target;
                sampler_lfo_target = Some(target);
            }
            "synth.pulse_width" | "synth.pulsewidth" | "synth.pw" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let pw = payload.value.clamp(0.05, 0.95) as f32;
                cfg.pulse_width = pw as f64;
                sampler_pulse_width = Some(pw);
            }
            _ => {
                // Keep unknown params round-trippable in automation lanes.
                upsert_static_automation_lane(track, &payload.param_id, payload.value);
            }
        }

        if sampler_command_needed {
            (idx, track.sampler.clone())
        } else {
            (idx, None)
        }
    };

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_automation_snapshot_from_project(&project, &automation_runtime);
    rebuild_sampler_snapshot_from_project(&project, &clip_pool_state, &handle);

    if sampler_command_needed
        && let Some(cfg) = &sampler_cfg_for_rt
    {
        let idx = track_index as u16;
        push_command(&handle, EngineCommand::SetSamplerRootNote {
            track_index: idx,
            root_note: cfg.root_note,
        })?;
        push_command(&handle, EngineCommand::SetSamplerVolume {
            track_index: idx,
            volume: cfg.volume as f32,
        })?;
        push_command(&handle, EngineCommand::SetSamplerAdsr {
            track_index: idx,
            attack: cfg.attack as f32,
            decay: cfg.decay as f32,
            sustain: cfg.sustain as f32,
            release: cfg.release as f32,
        })?;
    }
    if let Some(waveform) = sampler_waveform {
        push_command(&handle, EngineCommand::SetSamplerWaveform {
            track_index: track_index as u16,
            waveform,
        })?;
    }
    if let Some(waveform) = sampler_waveform2 {
        push_command(&handle, EngineCommand::SetSamplerOsc2Waveform {
            track_index: track_index as u16,
            waveform,
        })?;
    }
    if let Some(mix) = sampler_osc_mix {
        push_command(&handle, EngineCommand::SetSamplerOscMix {
            track_index: track_index as u16,
            mix,
        })?;
    }
    if let Some(cents) = sampler_detune_cents {
        push_command(&handle, EngineCommand::SetSamplerDetuneCents {
            track_index: track_index as u16,
            cents,
        })?;
    }
    if let Some(level) = sampler_sub_level {
        push_command(&handle, EngineCommand::SetSamplerSubLevel {
            track_index: track_index as u16,
            level,
        })?;
    }
    if let Some(cutoff) = sampler_filter_cutoff {
        push_command(&handle, EngineCommand::SetSamplerFilterCutoff {
            track_index: track_index as u16,
            cutoff,
        })?;
    }
    if let Some(resonance) = sampler_filter_resonance {
        push_command(&handle, EngineCommand::SetSamplerFilterResonance {
            track_index: track_index as u16,
            resonance,
        })?;
    }
    if let Some(filter_type) = sampler_filter_type {
        push_command(&handle, EngineCommand::SetSamplerFilterType {
            track_index: track_index as u16,
            filter_type,
        })?;
    }
    if let Some(rate) = sampler_lfo_rate {
        push_command(&handle, EngineCommand::SetSamplerLfoRate {
            track_index: track_index as u16,
            rate,
        })?;
    }
    if let Some(depth) = sampler_lfo_depth {
        push_command(&handle, EngineCommand::SetSamplerLfoDepth {
            track_index: track_index as u16,
            depth,
        })?;
    }
    if let Some(target) = sampler_lfo_target {
        push_command(&handle, EngineCommand::SetSamplerLfoTarget {
            track_index: track_index as u16,
            target,
        })?;
    }
    if let Some(width) = sampler_pulse_width {
        push_command(&handle, EngineCommand::SetSamplerPulseWidth {
            track_index: track_index as u16,
            width,
        })?;
    }

    log::debug!(
        "[IPC] set_internal_plugin_param_cmd(track={}, slot={}, param={} value={})",
        payload.track_id,
        payload.slot_id,
        payload.param_id,
        payload.value
    );
    Ok(())
}

/// Assign sample file to a track sampler and stream it to the realtime engine.
#[tauri::command]
fn set_sampler_sample_cmd(
    payload: SetSamplerSamplePayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let sample_path = payload.sample_path.clone();
    if !PathBuf::from(&sample_path).exists() {
        return Err(format!("Sample path does not exist: {}", sample_path));
    }

    let decoded = AudioReader::read(PathBuf::from(&sample_path))
        .map_err(|e| format!("Failed to decode sample: {e}"))?;
    let clip_audio = ClipAudio::new(sample_path.clone(), decoded.channels, decoded.sample_rate);

    let sample_arc = {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        pool.insert(clip_audio);
        pool.get(&sample_path)
            .ok_or_else(|| "Failed to cache decoded sampler sample".to_string())?
    };
    clip_pool_state.sync_pool_to_arc();

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let (track_index, sampler_cfg) = {
        let (idx, track) = project
            .tracks
            .iter_mut()
            .enumerate()
            .find(|(_, t)| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

        let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
        cfg.sample_path = sample_path.clone();
        if let Some(root) = payload.root_note {
            cfg.root_note = root.min(127);
        }
        (idx, cfg.clone())
    };

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    handle
        .sampler_samples
        .set_track_sample(track_index, Some(sample_arc));

    let idx = track_index as u16;
    push_command(&handle, EngineCommand::SetSamplerRootNote {
        track_index: idx,
        root_note: sampler_cfg.root_note,
    })?;
    push_command(&handle, EngineCommand::SetSamplerVolume {
        track_index: idx,
        volume: sampler_cfg.volume as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerAdsr {
        track_index: idx,
        attack: sampler_cfg.attack as f32,
        decay: sampler_cfg.decay as f32,
        sustain: sampler_cfg.sustain as f32,
        release: sampler_cfg.release as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerOsc2Waveform {
        track_index: idx,
        waveform: sampler_cfg.osc2_waveform.min(3),
    })?;
    push_command(&handle, EngineCommand::SetSamplerOscMix {
        track_index: idx,
        mix: sampler_cfg.osc_mix.clamp(0.0, 1.0) as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerDetuneCents {
        track_index: idx,
        cents: sampler_cfg.detune_cents.clamp(-50.0, 50.0) as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerSubLevel {
        track_index: idx,
        level: sampler_cfg.sub_level.clamp(0.0, 1.0) as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerFilterCutoff {
        track_index: idx,
        cutoff: sampler_cfg.filter_cutoff.clamp(20.0, 20000.0) as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerFilterResonance {
        track_index: idx,
        resonance: sampler_cfg.filter_resonance.clamp(0.0, 0.99) as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerFilterType {
        track_index: idx,
        filter_type: sampler_cfg.filter_type.min(3),
    })?;

    log::info!(
        "[IPC] set_sampler_sample_cmd(track={}, path={})",
        payload.track_id,
        sample_path
    );
    Ok(())
}

// ── STUB-10 FIX: Eager external plugin activation at project load ─────────
//
// During ALS import, resolved external plugins have their state blobs stored
// on PluginSlot.external_state_blob / external_preset_blob. However, the
// plugins only get instantiated lazily (when user opens the editor).
//
// This command eagerly activates ALL resolved external plugins in the project,
// so their stored state is applied immediately and they are ready for playback.

fn collect_external_plugin_ids_from_devices(nodes: &[DeviceNode], out: &mut Vec<String>) {
    for node in nodes {
        match node {
            DeviceNode::Single(slot) => {
                if !slot.plugin_id.starts_with("internal://")
                    && !slot.plugin_id.is_empty()
                    && slot.external_format.is_some()
                {
                    out.push(slot.plugin_id.clone());
                }
            }
            DeviceNode::Rack(rack) => {
                for chain in &rack.chains {
                    collect_external_plugin_ids_from_devices(&chain.devices, out);
                }
            }
        }
    }
}

#[tauri::command]
fn eager_activate_external_plugins(
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<serde_json::Value, String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();

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

    let total = external_slots.len();
    let mut loaded = 0u32;
    let mut failed = 0u32;
    let skipped = 0u32;

    for (slot_id, plugin_id) in &external_slots {
        match plugin_host_state.ensure_loaded_instance_for_slot(*slot_id, plugin_id) {
            Ok(instance_id) => {
                loaded += 1;
                log::info!(
                    "[EagerActivate] Slot {} plugin '{}' active as instance {} ({}/{})",
                    slot_id,
                    plugin_id,
                    instance_id,
                    loaded,
                    total
                );
            }
            Err(err) => {
                // Don't fail the whole operation for one bad plugin
                failed += 1;
                log::warn!(
                    "[EagerActivate] Failed to activate '{}': {}",
                    plugin_id,
                    err
                );
            }
        }
    }

    log::info!(
        "[EagerActivate] Done: {} external plugin slots found, {} loaded, {} failed",
        total,
        loaded,
        failed
    );

    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());

    Ok(serde_json::json!({
        "total": total,
        "loaded": loaded,
        "failed": failed,
        "skipped": skipped,
    }))
}
