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
            default_value: Some(0.5),
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
    let hints = execute_orchestrator_query(
        &project_state,
        &dream_orchestrator::queries::ResolvePluginParamHintsQuery {
            plugin_id: plugin_id.clone(),
        },
    )?;
    let metadata_count = hints.metadata_count;
    let lane_name_hints = hints.lane_name_hints;
    let slot_states = resolve_plugin_slot_states_by_plugin_id(&project_state, &plugin_id)?;
    let Some(slot) = slot_states.first() else {
        return Ok(fallback_external_param_block(metadata_count));
    };
    if slot_states.len() > 1 {
        log::warn!(
            "[IPC] get_external_plugin_params({}) matched {} slots; reading slot {} only",
            plugin_id,
            slot_states.len(),
            slot.slot_id
        );
    }
    let Some(instance_id) = plugin_host_state.slot_instance_map.load().get(&slot.slot_id).copied() else {
        return Ok(fallback_external_param_block(metadata_count));
    };

    let mut host = match plugin_host_state.host.try_lock() {
        Ok(host) => host,
        Err(_) => return Ok(fallback_external_param_block(metadata_count)),
    };
    let Some(instance) = host.get_mut(instance_id) else {
        log::warn!(
            "[PluginParams] Missing instance for active plugin key '{}'; using fallback params",
            plugin_id
        );
        return Ok(fallback_external_param_block(metadata_count));
    };

    let Some(instance_guard) = instance.try_lock() else {
        return Ok(fallback_external_param_block(metadata_count));
    };

    let host_count = instance_guard.parameter_count() as usize;
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
        let value = instance_guard
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
            default_value: Some(value),
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
    _clip_pool_state: tauri::State<'_, ClipPoolState>,
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

    let hints = execute_orchestrator_query(
        &project_state,
        &dream_orchestrator::queries::ResolvePluginParamHintsQuery {
            plugin_id: slot_state.plugin_id.clone(),
        },
    )?;
    let lane_name_hints = hints.lane_name_hints;
    let metadata_count = (slot_state.external_parameter_count.unwrap_or(0).max(0) as usize)
        .max(hints.metadata_count);

    // RT-SAFETY FIX: Check if instance is already bound BEFORE calling
    // ensure_loaded_instance_for_slot. If it is, we skip state blob restore
    // entirely — the state was already restored when the instance was first
    // loaded or when the plugin editor was opened.
    let was_already_bound = plugin_host_state
        .slot_instance_map
        .load()
        .get(&slot_state.slot_id)
        .is_some();

    let instance_id =
        plugin_host_state.ensure_loaded_instance_for_slot(slot_state.slot_id, &slot_state.plugin_id)?;
    plugin_host_state.bind_slot_instance(slot_state.slot_id, instance_id);

    // RT-SAFETY FIX: Only restore state blob for FRESHLY loaded instances
    // (not already bound). Previously this ran on EVERY param query, holding
    // host.lock() for 100ms+ while deserializing Serum/massive preset blobs.
    // This blocked the audio thread's try_lock(), silently bypassing ALL VST3
    // plugins on the track and causing "DAW suspended processing".
    if !was_already_bound
        && (slot_state.external_state_blob.is_some() || slot_state.external_preset_blob.is_some())
    {
        // Use try_lock to avoid blocking the audio thread. If we can't
        // acquire the lock right now, fall back to reading default params
        // — the state will be restored the next time the user opens the
        // plugin editor (which uses blocking lock on purpose).
        if let Ok(mut host) = plugin_host_state.host.try_lock() {
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

    let params = {
        let mut host = match plugin_host_state.host.try_lock() {
            Ok(host) => host,
            Err(_) => return Ok(fallback_external_param_block(metadata_count)),
        };
        let Some(instance) = host.get_mut(instance_id) else {
            return Ok(fallback_external_param_block(metadata_count));
        };
        let Some(instance_guard) = instance.try_lock() else {
            return Ok(fallback_external_param_block(metadata_count));
        };
        let count_hint = instance_guard.parameter_count().max(metadata_count as u32);
        let count = (if count_hint > 0 { count_hint } else { 16 }).min(128);

        let mut params = Vec::with_capacity(count as usize);
        for idx in 0..count {
            let value = instance_guard.get_parameter(idx).unwrap_or(0.5);
            let fallback_name = format!("Param {}", idx + 1);
            let name = lane_name_hints
                .get(&idx)
                .cloned()
                .unwrap_or(fallback_name);
            params.push(ExternalPluginParamInfo {
                index: idx,
                name,
                min: 0.0,
                max: 1.0,
                step: 0.001,
                default_value: Some(value),
                value,
            });
        }
        params
    };

    // RT-SAFETY FIX: Removed sync_external_fx_snapshot_from_state() from
    // this READ-ONLY param query path. This function traverses all tracks
    // and slots, acquiring project + host mutexes — blocking the audio thread.
    // State sync should only happen on actual MUTATIONS (preset change,
    // plugin load, param set), not passive UI queries.

    Ok(params)
}
