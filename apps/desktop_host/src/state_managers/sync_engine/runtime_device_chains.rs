use super::*;
use dream_models::project::DeviceNode;

pub fn builtin_effect_type_from_plugin_id(plugin_id: &str) -> Option<u8> {
    dream_models::project::builtin_effect_type_from_plugin_id(plugin_id)
}

pub fn rebuild_runtime_device_chains_from_project(
    project: &Project,
    handle: &AudioEngineHandle,
) -> Result<(), String> {
    const MAX_DEVICE_SLOTS: u8 = 16;
    fn first_lane_value(track: &Track, keys: &[&str]) -> Option<f32> {
        for key in keys {
            if let Some(lane) = track
                .automation_lanes
                .iter()
                .find(|lane| lane.param_id.eq_ignore_ascii_case(key))
                && let Some(point) = lane.points.first()
            {
                return Some(point.value as f32);
            }
        }
        None
    }

    fn apply_static_imported_params_for_slot(
        handle: &AudioEngineHandle,
        track_index: u16,
        slot_index: u8,
        plugin_id: &str,
        track: &Track,
    ) -> Result<(), String> {
        let pid = plugin_id.to_ascii_lowercase();

        if pid == "internal://effect/utility" {
            if let Some(gain_lin) = first_lane_value(track, &["plugin.gain"]) {
                let gain_db = if gain_lin <= 0.00001 {
                    -60.0
                } else {
                    (20.0 * gain_lin.log10()).clamp(-60.0, 24.0)
                };
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: gain_db,
                    },
                )?;
            }
            if let Some(pan) = first_lane_value(track, &["plugin.pan"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: (pan * 100.0).clamp(-100.0, 100.0),
                    },
                )?;
            }
            if let Some(width) = first_lane_value(track, &["plugin.width"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: width.clamp(0.0, 200.0),
                    },
                )?;
            }
            if let Some(mono) = first_lane_value(track, &["plugin.mono"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: if mono >= 0.5 { 1.0 } else { 0.0 },
                    },
                )?;
            }
            return Ok(());
        }

        if pid == "internal://effect/eq-eight" {
            if let Some(out_gain) = first_lane_value(track, &["effect.eq.global_gain"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 32,
                        value: out_gain.clamp(-24.0, 24.0),
                    },
                )?;
            }
            for band in 0..8u8 {
                if let Some(v) = first_lane_value(track, &[&format!("effect.eq.band{band}.freq")]) {
                    push_command(
                        handle,
                        EngineCommand::SetDeviceParam {
                            track_index,
                            slot_index,
                            param_index: band * 4,
                            value: v.clamp(20.0, 20_000.0),
                        },
                    )?;
                }
                if let Some(v) = first_lane_value(track, &[&format!("effect.eq.band{band}.gain")]) {
                    push_command(
                        handle,
                        EngineCommand::SetDeviceParam {
                            track_index,
                            slot_index,
                            param_index: band * 4 + 1,
                            value: v.clamp(-24.0, 24.0),
                        },
                    )?;
                }
                if let Some(v) = first_lane_value(track, &[&format!("effect.eq.band{band}.q")]) {
                    push_command(
                        handle,
                        EngineCommand::SetDeviceParam {
                            track_index,
                            slot_index,
                            param_index: band * 4 + 2,
                            value: v.clamp(0.1, 18.0),
                        },
                    )?;
                }
                if let Some(v) = first_lane_value(track, &[&format!("effect.eq.band{band}.on")]) {
                    push_command(
                        handle,
                        EngineCommand::SetDeviceParam {
                            track_index,
                            slot_index,
                            param_index: band * 4 + 3,
                            value: if v >= 0.5 { 1.0 } else { 0.0 },
                        },
                    )?;
                }
            }
            return Ok(());
        }

        if pid == "internal://effect/auto-filter" {
            if let Some(cutoff) = first_lane_value(track, &["effect.auto_filter.cutoff"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: cutoff.clamp(20.0, 20_000.0),
                    },
                )?;
            }
            if let Some(res) = first_lane_value(track, &["effect.auto_filter.resonance"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: (res * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(ft) = first_lane_value(track, &["effect.auto_filter.type"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 5,
                        value: ft.round().clamp(0.0, 3.0),
                    },
                )?;
            }
            if let Some(drive) = first_lane_value(track, &["effect.auto_filter.drive"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 8,
                        value: drive.clamp(0.0, 24.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.lfo.rate"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: v.clamp(0.01, 20.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.lfo.depth"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.env.amount"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 4,
                        value: (v * 100.0).clamp(-100.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.mix"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 6,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.lfo.shape"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 7,
                        value: v.round().clamp(0.0, 5.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.env.speed_ms"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 9,
                        value: v.clamp(1.0, 200.0),
                    },
                )?;
            }
            return Ok(());
        }

        if pid == "internal://effect/compressor" {
            if let Some(v) = first_lane_value(track, &["effect.compressor.threshold"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: v.clamp(-60.0, 0.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.ratio"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: v.clamp(1.0, 20.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.attack"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: v.clamp(0.1, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.release"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: v.clamp(10.0, 1000.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.knee"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 4,
                        value: v.clamp(0.0, 24.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.makeup"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 5,
                        value: v.clamp(-12.0, 24.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.mix"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 6,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            return Ok(());
        }

        if pid == "internal://effect/reverb" {
            if let Some(v) = first_lane_value(track, &["effect.reverb.size"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.reverb.damping"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.reverb.mix"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.reverb.predelay"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: v.clamp(0.0, 200.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.reverb.width"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 4,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.reverb.low_damp"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 5,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            return Ok(());
        }

        if pid == "internal://effect/delay" {
            if let Some(v) = first_lane_value(track, &["effect.delay.time"]) {
                let ms = v.clamp(1.0, 2000.0);
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: ms,
                    },
                )?;
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: ms,
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.delay.feedback"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: (v * 100.0).clamp(0.0, 95.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.delay.mix"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            return Ok(());
        }

        Ok(())
    }

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

    fn collect_runtime_internal_effects(
        nodes: &[DeviceNode],
        parent_bypassed: bool,
        out: &mut Vec<(String, bool)>,
    ) {
        for node in nodes {
            match node {
                DeviceNode::Single(slot) => {
                    if slot.plugin_id.starts_with("internal://") {
                        out.push((slot.plugin_id.clone(), parent_bypassed || slot.is_bypassed));
                    }
                }
                DeviceNode::Rack(rack) => {
                    let rack_bypassed = parent_bypassed || rack.is_bypassed;
                    if let Some(chain) = selected_runtime_chain(rack) {
                        collect_runtime_internal_effects(&chain.devices, rack_bypassed, out);
                    }
                }
            }
        }
    }

    for track_index in 0..project.tracks.len() {
        let track_index = track_index as u16;
        for slot_index in 0..MAX_DEVICE_SLOTS {
            push_command(
                handle,
                EngineCommand::RemoveDevice {
                    track_index,
                    slot_index,
                },
            )?;
        }
    }

    for (track_index, track) in project.tracks.iter().enumerate() {
        let mut internal_effects: Vec<(String, bool)> = Vec::new();
        collect_runtime_internal_effects(&track.effects, false, &mut internal_effects);
        if internal_effects.len() > MAX_DEVICE_SLOTS as usize {
            log::warn!(
                "[RuntimeChain] track '{}' has {} internal effects; truncating to {} slots",
                track.name,
                internal_effects.len(),
                MAX_DEVICE_SLOTS
            );
        }
        for (slot_index, (plugin_id, bypassed)) in internal_effects
            .into_iter()
            .take(MAX_DEVICE_SLOTS as usize)
            .enumerate()
        {
            if let Some(effect_type) = builtin_effect_type_from_plugin_id(&plugin_id) {
                push_command(
                    handle,
                    EngineCommand::AddDevice {
                        track_index: track_index as u16,
                        slot_index: slot_index.min(u8::MAX as usize) as u8,
                        effect_type,
                    },
                )?;
                if bypassed {
                    push_command(
                        handle,
                        EngineCommand::BypassDevice {
                            track_index: track_index as u16,
                            slot_index: slot_index.min(u8::MAX as usize) as u8,
                            bypassed: true,
                        },
                    )?;
                }
                apply_static_imported_params_for_slot(
                    handle,
                    track_index as u16,
                    slot_index.min(u8::MAX as usize) as u8,
                    &plugin_id,
                    track,
                )?;
            }
        }
    }

    {
        const MASTER_TRACK_INDEX: u16 = u16::MAX;
        let master = &project.master_track;

        struct MasterFxEntry {
            plugin_id: String,
            bypassed: bool,
            params: Option<Vec<f32>>,
        }
        fn collect_master_internal_effects(
            node: &DeviceNode,
            parent_bypassed: bool,
            out: &mut Vec<MasterFxEntry>,
        ) {
            match node {
                DeviceNode::Single(slot) => {
                    if slot.plugin_id.starts_with("internal://effect/") {
                        out.push(MasterFxEntry {
                            plugin_id: slot.plugin_id.clone(),
                            bypassed: parent_bypassed || slot.is_bypassed,
                            params: slot.params.clone(),
                        });
                    }
                }
                DeviceNode::Rack(rack) => {
                    let rack_bypassed = parent_bypassed || rack.is_bypassed;
                    if let Some(chain) = selected_runtime_chain(rack) {
                        for child in &chain.devices {
                            collect_master_internal_effects(child, rack_bypassed, out);
                        }
                    }
                }
            }
        }

        let mut master_internal_effects: Vec<MasterFxEntry> = Vec::new();
        for node in &master.effects {
            collect_master_internal_effects(node, false, &mut master_internal_effects);
        }

        for (slot_index, entry) in master_internal_effects
            .into_iter()
            .take(MAX_DEVICE_SLOTS as usize)
            .enumerate()
        {
            if let Some(effect_type) = builtin_effect_type_from_plugin_id(&entry.plugin_id) {
                push_command(
                    handle,
                    EngineCommand::AddDevice {
                        track_index: MASTER_TRACK_INDEX,
                        slot_index: slot_index.min(u8::MAX as usize) as u8,
                        effect_type,
                    },
                )?;
                if entry.bypassed {
                    push_command(
                        handle,
                        EngineCommand::BypassDevice {
                            track_index: MASTER_TRACK_INDEX,
                            slot_index: slot_index.min(u8::MAX as usize) as u8,
                            bypassed: true,
                        },
                    )?;
                }
                if let Some(ref params) = entry.params {
                    for (param_idx, &value) in params.iter().enumerate() {
                        if value != 0.0 || param_idx < 33 {
                            push_command(
                                handle,
                                EngineCommand::SetDeviceParam {
                                    track_index: MASTER_TRACK_INDEX,
                                    slot_index: slot_index.min(u8::MAX as usize) as u8,
                                    param_index: param_idx.min(u8::MAX as usize) as u8,
                                    value,
                                },
                            )?;
                        }
                    }
                }
            }
        }
    }

    Ok(())
}
