// ═══════════════════════════════════════════════════════════════════════

use dream_models::project::Project;

fn selected_runtime_chain(
    rack: &dream_models::project::DeviceRack,
) -> Option<&dream_models::project::RackChain> {
    let has_solo = rack.chains.iter().any(|c| c.is_solo);
    if has_solo {
        rack.chains.iter().find(|c| c.is_solo && !c.is_mute)
    } else {
        rack.chains.iter().find(|c| !c.is_mute)
    }
}

fn count_runtime_internal_effects(node: &dream_models::project::DeviceNode) -> usize {
    match node {
        dream_models::project::DeviceNode::Single(slot) => {
            usize::from(slot.plugin_id.starts_with("internal://effect/"))
        }
        dream_models::project::DeviceNode::Rack(rack) => selected_runtime_chain(rack)
            .map(|chain| chain.devices.iter().map(count_runtime_internal_effects).sum())
            .unwrap_or(0),
    }
}

/// Converts a raw effects-array slot index to the internal-only device_chain
/// slot index.
///
/// The frontend sends `slot_index` as the position in `track.effects[]` which
/// includes BOTH internal effects (EQ, compressor) AND external VST3 plugins.
/// But the engine's `DeviceChain` only contains internal effects, indexed 0, 1, 2...
/// This function counts how many internal (`internal://effect/...`) effects
/// appear before (and including) the given position to produce the correct
/// device_chain slot index.
///
/// Returns `None` if the slot at `raw_index` is not an internal effect.
fn raw_slot_to_internal_device_index(project: &Project, track_index: u16, raw_slot_index: u8) -> Option<u8> {
    let track = project.tracks.get(track_index as usize)?;
    let raw = raw_slot_index as usize;
    let target = track.effects.get(raw)?;
    let preceding_internal = track.effects[..raw]
        .iter()
        .map(count_runtime_internal_effects)
        .sum::<usize>();
    match target {
        dream_models::project::DeviceNode::Single(slot)
            if slot.plugin_id.starts_with("internal://effect/") =>
        {
            Some(preceding_internal as u8)
        }
        _ => None,
    }
}

/// Same conversion but for the master track.
fn raw_slot_to_internal_device_index_master(project: &Project, raw_slot_index: u8) -> Option<u8> {
    let raw = raw_slot_index as usize;
    let target = project.master_track.effects.get(raw)?;
    let preceding_internal = project.master_track.effects[..raw]
        .iter()
        .map(count_runtime_internal_effects)
        .sum::<usize>();
    match target {
        dream_models::project::DeviceNode::Single(slot)
            if slot.plugin_id.starts_with("internal://effect/") =>
        {
            Some(preceding_internal as u8)
        }
        _ => None,
    }
}

/// Adds a built-in DSP device to a track's insert chain.
#[tauri::command]
fn add_device_cmd(
    track_index: u16,
    slot_index: u8,
    effect_type: u8,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(
        &handle,
        EngineCommand::AddDevice {
            track_index,
            slot_index,
            effect_type,
        },
    )?;
    log::info!("[IPC] add_device(track={track_index}, slot={slot_index}, type={effect_type})");
    Ok(())
}

/// Removes a device from a track's insert chain.
#[tauri::command]
fn remove_device_cmd(
    track_index: u16,
    slot_index: u8,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    push_command(
        &handle,
        EngineCommand::RemoveDevice {
            track_index,
            slot_index,
        },
    )?;
    log::info!("[IPC] remove_device(track={track_index}, slot={slot_index})");
    Ok(())
}

/// Bypasses or enables a device in a track's insert chain.
///
/// BUG-027 FIX: Persists bypass to project model.
/// BUG-ROUTING FIX: Converts raw slot_index to internal-only device_chain index.
/// BUG-R3 FIX: Handles master track (MASTER_TRACK_INDEX=65535) via project.master_track.
#[tauri::command]
fn bypass_device_cmd(
    track_index: u16,
    slot_index: u8,
    bypassed: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    const MASTER_TRACK_INDEX: u16 = u16::MAX;

    let engine_slot_index = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

        // Persist bypass to project model (SSOT)
        let effects = if track_index == MASTER_TRACK_INDEX {
            &mut project.master_track.effects
        } else if let Some(track) = project.tracks.get_mut(track_index as usize) {
            if slot_index == 255 {
                // Instrument slot
                if let Some(slot) = track.instrument.as_mut().and_then(|n| n.as_single_mut()) {
                    slot.is_bypassed = bypassed;
                }
                let pn = project.name.clone();
                drop(project);
                let _ = project_state.mark_dirty(&pn, Some(&app));
                // Instrument bypass uses sentinel 255 directly
                return push_command(&handle, EngineCommand::BypassDevice {
                    track_index, slot_index: 255, bypassed,
                });
            }
            &mut track.effects
        } else {
            return Err(format!("Track index out of range: {}", track_index));
        };

        if let Some(slot) = effects.get_mut(slot_index as usize).and_then(|n| n.as_single_mut()) {
            slot.is_bypassed = bypassed;
        }

        // Convert raw effects-array index to internal-only device_chain slot index
        let internal_idx = if track_index == MASTER_TRACK_INDEX {
            raw_slot_to_internal_device_index_master(&project, slot_index)
        } else {
            raw_slot_to_internal_device_index(&project, track_index, slot_index)
        };

        let project_name = project.name.clone();
        drop(project);
        let _ = project_state.mark_dirty(&project_name, Some(&app));
        internal_idx
    };

    if let Some(resolved_slot) = engine_slot_index {
        push_command(
            &handle,
            EngineCommand::BypassDevice {
                track_index,
                slot_index: resolved_slot,
                bypassed,
            },
        )?;
        log::debug!("[IPC] bypass_device(track={track_index}, raw_slot={slot_index}, engine_slot={resolved_slot}, bypassed={bypassed})");
    } else {
        log::debug!("[IPC] bypass_device(track={track_index}, slot={slot_index}) — skipped (not an internal effect)");
    }
    Ok(())
}

/// Sets a parameter on a device in a track's insert chain.
///
/// BUG-070 FIX: Persists params to project model.
/// BUG-ROUTING FIX: Converts raw slot_index to internal-only device_chain index.
/// BUG-R2 FIX: Handles master track (MASTER_TRACK_INDEX=65535) via project.master_track.
#[tauri::command]
fn set_device_param_cmd(
    track_index: u16,
    slot_index: u8,
    param_index: u8,
    value: f32,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    const MASTER_TRACK_INDEX: u16 = u16::MAX;

    let (project_name, engine_slot_index) = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

        // Resolve the effects list: master_track or regular track
        let effects = if track_index == MASTER_TRACK_INDEX {
            &mut project.master_track.effects
        } else if let Some(track) = project.tracks.get_mut(track_index as usize) {
            if slot_index == 255 {
                // Instrument slot — persist and send directly
                if let Some(slot) = track.instrument.as_mut().and_then(|n| n.as_single_mut()) {
                    persist_param_to_slot(slot, param_index, value);
                }
                let pn = project.name.clone();
                drop(project);
                project_state.mark_dirty(&pn, Some(&app))?;
                push_command(&handle, EngineCommand::SetDeviceParam {
                    track_index, slot_index: 255, param_index, value,
                })?;
                log::debug!("[IPC] set_device_param(track={track_index}, instrument, param={param_index}, val={value})");
                return Ok(());
            }
            &mut track.effects
        } else {
            return Err(format!("Track index out of range: {}", track_index));
        };

        // Persist param to project model (SSOT)
        if let Some(slot) = effects.get_mut(slot_index as usize).and_then(|n| n.as_single_mut()) {
            persist_param_to_slot(slot, param_index, value);
        }

        // Convert raw effects-array index to internal-only device_chain slot index
        let internal_idx = if track_index == MASTER_TRACK_INDEX {
            raw_slot_to_internal_device_index_master(&project, slot_index)
        } else {
            raw_slot_to_internal_device_index(&project, track_index, slot_index)
        };

        (project.name.clone(), internal_idx)
    };

    project_state.mark_dirty(&project_name, Some(&app))?;

    if let Some(resolved_slot) = engine_slot_index {
        push_command(
            &handle,
            EngineCommand::SetDeviceParam {
                track_index,
                slot_index: resolved_slot,
                param_index,
                value,
            },
        )?;
        log::debug!("[IPC] set_device_param(track={track_index}, raw_slot={slot_index}, engine_slot={resolved_slot}, param={param_index}, val={value})");
    } else {
        log::debug!("[IPC] set_device_param(track={track_index}, slot={slot_index}) — skipped (not an internal effect)");
    }
    Ok(())
}

/// Persists a param value into a PluginSlot's params vec, auto-resizing as needed.
fn persist_param_to_slot(slot: &mut dream_models::project::PluginSlot, param_index: u8, value: f32) {
    if slot.params.is_none() {
        slot.params = Some(vec![0.0; 32]);
    }
    if let Some(params) = &mut slot.params {
        let p_idx = param_index as usize;
        if p_idx < params.len() {
            params[p_idx] = value;
        } else if p_idx < 128 {
            params.resize(p_idx + 1, 0.0);
            params[p_idx] = value;
        }
    }
}

/// Batch update a track's state (volume, pan, mute, solo).
#[tauri::command]
fn update_track(
    update: TrackStateUpdate,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let project_name = {
        // BUG-068 & BUG-069 FIX: Obtain lock first, check bounds, update SSOT, then push safely.
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        let idx = update.track_index as usize;
        let track = project
            .tracks
            .get_mut(idx)
            .ok_or_else(|| format!("Track index out of range: {}", update.track_index))?;

        if let Some(vol) = update.volume {
            let clamped = vol.clamp(0.0, 2.0);
            track.volume = clamped as f64;
            // BUG-026 FIX: Was `let _ = push_command()` — silently dropped engine
            // commands when ring buffer was full. The project model updated (volume=0.5)
            // but engine kept playing at old volume → audible SSOT divergence.
            if let Err(e) = push_command(&handle, EngineCommand::SetTrackVolume {
                track_index: update.track_index,
                volume: clamped,
            }) {
                log::error!("[update_track] SetTrackVolume dropped: {e}");
            }
        }
        if let Some(pan) = update.pan {
            let clamped = pan.clamp(-1.0, 1.0);
            track.pan = clamped as f64;
            if let Err(e) = push_command(&handle, EngineCommand::SetTrackPan {
                track_index: update.track_index,
                pan: clamped,
            }) {
                log::error!("[update_track] SetTrackPan dropped: {e}");
            }
        }
        if let Some(muted) = update.muted {
            track.is_mute = muted;
            if let Err(e) = push_command(&handle, EngineCommand::SetTrackMute {
                track_index: update.track_index,
                muted,
            }) {
                log::error!("[update_track] SetTrackMute dropped: {e}");
            }
        }
        if let Some(soloed) = update.soloed {
            track.is_solo = soloed;
            if let Err(e) = push_command(&handle, EngineCommand::SetTrackSolo {
                track_index: update.track_index,
                soloed,
            }) {
                log::error!("[update_track] SetTrackSolo dropped: {e}");
            }
        }
        project.name.clone()
    };
    
    project_state.mark_dirty(&project_name, Some(&app))?;
    log::debug!("[IPC] update_track(track={})", update.track_index);
    Ok(())
}

#[cfg(test)]
mod device_chain_tests {
    use super::*;
    use dream_models::project::{DeviceNode, DeviceRack, PluginSlot, RackChain, RackType, Track, TrackType};

    #[test]
    fn raw_slot_mapping_counts_internal_effects_inside_preceding_rack() {
        let mut project = Project::default();
        project.tracks.clear();

        let mut track = Track::with_type("Audio 1", TrackType::Audio, 0);

        let mut chain = RackChain::new("RackChain");
        chain.devices.push(DeviceNode::single(PluginSlot::new(
            "Rack EQ",
            "internal://effect/eq_eight",
        )));
        chain.devices.push(DeviceNode::single(PluginSlot::new(
            "Rack External",
            "vst3://rack-ext",
        )));
        let mut rack = DeviceRack::new("Fx Rack", RackType::AudioEffect);
        rack.chains.push(chain);
        track.effects.push(DeviceNode::rack(rack)); // raw index 0

        track.effects.push(DeviceNode::single(PluginSlot::new(
            "Track Compressor",
            "internal://effect/compressor",
        ))); // raw index 1

        project.add_track(track);

        let mapped = raw_slot_to_internal_device_index(&project, 0, 1);
        assert_eq!(
            mapped,
            Some(1),
            "preceding rack internal effect must shift internal slot index"
        );
    }

    #[test]
    fn raw_slot_mapping_for_master_counts_internal_effects_inside_rack() {
        let mut project = Project::default();

        let mut chain = RackChain::new("MasterChain");
        chain.devices.push(DeviceNode::single(PluginSlot::new(
            "Master EQ",
            "internal://effect/eq_eight",
        )));
        let mut rack = DeviceRack::new("Master Rack", RackType::AudioEffect);
        rack.chains.push(chain);
        project.master_track.effects.push(DeviceNode::rack(rack)); // raw index 0

        project
            .master_track
            .effects
            .push(DeviceNode::single(PluginSlot::new(
                "Master Compressor",
                "internal://effect/compressor",
            ))); // raw index 1

        let mapped = raw_slot_to_internal_device_index_master(&project, 1);
        assert_eq!(
            mapped,
            Some(1),
            "master raw slot mapping must include internal effects inside rack"
        );
    }
}
