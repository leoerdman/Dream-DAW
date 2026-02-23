fn fallback_external_param_block(metadata_count: usize) -> Vec<ExternalPluginParamInfo> {
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

/// Returns externally controllable plugin params for inline UI.
#[tauri::command]
fn get_external_plugin_params(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<Vec<ExternalPluginParamInfo>, String> {
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

    let hints = execute_orchestrator_query(
        &project_state,
        &dream_orchestrator::queries::ResolvePluginParamHintsQuery {
            plugin_id: plugin_id.clone(),
        },
    )?;
    let metadata_count = hints.metadata_count;
    let lane_name_hints = hints.lane_name_hints;

    let Some(instance_id) = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .get(&plugin_id)
        .copied()
    else {
        return Ok(fallback_external_param_block(metadata_count));
    };

    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let Some(instance) = host.get_mut(instance_id) else {
        log::warn!(
            "[PluginParams] Missing instance for active plugin key '{}'; using fallback params",
            plugin_id
        );
        return Ok(fallback_external_param_block(metadata_count));
    };

    let host_count = instance.lock().parameter_count() as usize;
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
            .lock()
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
    let track_uuid = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let slot_uuid = Uuid::parse_str(&slot_id).map_err(|_| format!("Invalid slot_id: {slot_id}"))?;
    let slot_state = execute_orchestrator_query(
        &project_state,
        &dream_orchestrator::queries::ResolvePluginSlotStateQuery {
            track_id: track_uuid,
            slot_id: slot_uuid,
        },
    )?;

    if slot_state.plugin_id.starts_with("internal://") {
        return Ok(Vec::new());
    }

    let metadata_count = slot_state.external_parameter_count.unwrap_or(0).max(0) as usize;
    let instance_id =
        plugin_host_state.ensure_loaded_instance_for_slot(slot_state.slot_id, &slot_state.plugin_id)?;
    plugin_host_state.bind_slot_instance(slot_state.slot_id, instance_id);

    // Restore saved state before reading parameters so we report the
    // actual preset values instead of plugin defaults.
    if slot_state.external_state_blob.is_some() || slot_state.external_preset_blob.is_some() {
        if let Ok(mut host) = plugin_host_state.host.lock() {
            let mut slot =
                dream_models::project::PluginSlot::new(slot_state.name.clone(), slot_state.plugin_id.clone());
            slot.id = slot_state.slot_id;
            slot.external_parameter_count = slot_state.external_parameter_count;
            slot.external_state_blob = slot_state.external_state_blob.clone();
            slot.external_state_blob_kind = slot_state.external_state_blob_kind.clone();
            slot.external_preset_blob = slot_state.external_preset_blob.clone();
            slot.external_preset_blob_kind = slot_state.external_preset_blob_kind.clone();
            let _ = apply_imported_external_state_blob(&mut host, instance_id, &slot);
        }
    }

    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let Some(instance) = host.get_mut(instance_id) else {
        return Ok(fallback_external_param_block(metadata_count));
    };
    let count_hint = instance.lock().parameter_count().max(metadata_count as u32);
    let count = (if count_hint > 0 { count_hint } else { 16 }).min(128);

    let mut params = Vec::with_capacity(count as usize);
    for idx in 0..count {
        params.push(ExternalPluginParamInfo {
            index: idx,
            name: format!("Param {}", idx + 1),
            min: 0.0,
            max: 1.0,
            step: 0.001,
            value: instance.lock().get_parameter(idx).unwrap_or(0.5),
        });
    }
    drop(host);

    sync_external_fx_snapshot_from_state(&project_state, &clip_pool_state, &plugin_host_state)?;
    Ok(params)
}
