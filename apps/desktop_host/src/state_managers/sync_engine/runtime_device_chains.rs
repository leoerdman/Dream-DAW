use super::*;
use crate::state_managers::sync_engine::runtime_device_import_params::{
    first_lane_value, try_apply_primary_imported_params,
};
use dream_models::project::DeviceNode;

pub fn builtin_effect_type_from_plugin_id(plugin_id: &str) -> Option<u8> {
    dream_models::project::builtin_effect_type_from_plugin_id(plugin_id)
}

pub fn rebuild_runtime_device_chains_from_project(
    project: &Project,
    handle: &AudioEngineHandle,
) -> Result<(), String> {
    const MAX_DEVICE_SLOTS: u8 = 16;
    fn apply_static_imported_params_for_slot(
        handle: &AudioEngineHandle,
        track_index: u16,
        slot_index: u8,
        plugin_id: &str,
        track: &Track,
    ) -> Result<(), String> {
        let pid = plugin_id.to_ascii_lowercase();
        if try_apply_primary_imported_params(handle, track_index, slot_index, plugin_id, track)? {
            return Ok(());
        }

        let is_delay = matches!(
            pid.as_str(),
            "internal://effect/delay"
                | "internal://effect/echo"
                | "internal://effect/simple-delay"
                | "internal://effect/filter-delay"
                | "internal://effect/grain-delay"
                | "internal://effect/beat-repeat"
                | "internal://effect/looper"
                | "internal://effect/spectral-time"
        );
        let is_chorus = pid == "internal://effect/chorus";
        let is_saturator = matches!(
            pid.as_str(),
            "internal://effect/saturator"
                | "internal://effect/drum-buss"
                | "internal://effect/dynamic-tube"
        );
        let is_limiter = pid == "internal://effect/limiter";
        let is_gate = pid == "internal://effect/gate";
        let is_auto_pan = pid == "internal://effect/auto-pan";
        let is_phaser = matches!(
            pid.as_str(),
            "internal://effect/phaser" | "internal://effect/phaser-flanger"
        );
        let is_flanger = pid == "internal://effect/flanger";
        let is_distortion = matches!(
            pid.as_str(),
            "internal://effect/distortion"
                | "internal://effect/amp"
                | "internal://effect/cabinet"
                | "internal://effect/overdrive"
                | "internal://effect/pedal"
                | "internal://effect/roar"
                | "internal://effect/erosion"
        );
        let is_bitcrusher = pid == "internal://effect/bitcrusher";
        let is_noise_machine = pid == "internal://effect/noise-machine";
        let is_analyzer = matches!(
            pid.as_str(),
            "internal://effect/analyzer" | "internal://effect/spectrum"
        );

        if is_delay {
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

        if is_chorus {
            if let Some(v) = first_lane_value(track, &["effect.chorus.rate"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: v.clamp(0.05, 10.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.chorus.depth"]) {
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
            if let Some(v) = first_lane_value(track, &["effect.chorus.mix"]) {
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
            return Ok(());
        }

        if is_saturator {
            if let Some(v) = first_lane_value(track, &["effect.saturator.drive"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: v.clamp(0.0, 36.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.saturator.tone"]) {
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
            if let Some(v) = first_lane_value(track, &["effect.saturator.mix"]) {
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
            return Ok(());
        }

        if is_limiter {
            if let Some(v) = first_lane_value(track, &["effect.limiter.threshold"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: v.clamp(-30.0, 0.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.limiter.release"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: v.clamp(10.0, 1000.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.limiter.ceiling"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: v.clamp(-6.0, 0.0),
                    },
                )?;
            }
            return Ok(());
        }

        if is_gate {
            if let Some(v) = first_lane_value(track, &["effect.gate.threshold"]) {
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
            if let Some(v) = first_lane_value(track, &["effect.gate.attack"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: v.clamp(0.01, 50.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.gate.hold"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: v.clamp(0.0, 500.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.gate.release"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: v.clamp(5.0, 2000.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.gate.range"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 4,
                        value: v.clamp(-96.0, 0.0),
                    },
                )?;
            }
            return Ok(());
        }

        if is_auto_pan {
            if let Some(v) = first_lane_value(track, &["effect.auto_pan.rate"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: v.clamp(0.01, 20.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_pan.depth"]) {
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
            if let Some(v) = first_lane_value(track, &["effect.auto_pan.phase"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: v.clamp(0.0, 360.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_pan.shape"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: v.round().clamp(0.0, 4.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_pan.mix"]) {
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
            return Ok(());
        }

        if is_phaser || is_flanger {
            let (is_flanger_device, index_center_or_delay, index_mix) = if is_flanger {
                (true, 3u8, 4u8)
            } else {
                (false, 4u8, 5u8)
            };
            if let Some(v) = first_lane_value(
                track,
                &[if is_flanger_device {
                    "effect.flanger.rate"
                } else {
                    "effect.phaser.rate"
                }],
            ) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: v.clamp(0.01, 10.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(
                track,
                &[if is_flanger_device {
                    "effect.flanger.depth"
                } else {
                    "effect.phaser.depth"
                }],
            ) {
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
            if let Some(v) = first_lane_value(
                track,
                &[if is_flanger_device {
                    "effect.flanger.feedback"
                } else {
                    "effect.phaser.feedback"
                }],
            ) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: (v * 100.0).clamp(-95.0, 95.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(
                track,
                &[if is_flanger_device {
                    "effect.flanger.delay"
                } else {
                    "effect.phaser.center"
                }],
            ) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: index_center_or_delay,
                        value: if is_flanger_device {
                            v.clamp(0.1, 10.0)
                        } else {
                            v.clamp(100.0, 8000.0)
                        },
                    },
                )?;
            }
            if !is_flanger_device
                && let Some(v) = first_lane_value(track, &["effect.phaser.stages"])
            {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: v.round().clamp(2.0, 12.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(
                track,
                &[if is_flanger_device {
                    "effect.flanger.mix"
                } else {
                    "effect.phaser.mix"
                }],
            ) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: index_mix,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            return Ok(());
        }

        if is_distortion {
            if let Some(v) = first_lane_value(track, &["effect.distortion.drive"]) {
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
            if let Some(v) = first_lane_value(track, &["effect.distortion.tone"]) {
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
            if let Some(v) = first_lane_value(track, &["effect.distortion.mix"]) {
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
            if let Some(v) = first_lane_value(track, &["effect.distortion.mode"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: v.round().clamp(0.0, 4.0),
                    },
                )?;
            }
            return Ok(());
        }

        if is_bitcrusher {
            if let Some(v) = first_lane_value(track, &["effect.bitcrusher.bits"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: v.clamp(1.0, 32.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.bitcrusher.downsample"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: v.clamp(1.0, 64.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.bitcrusher.mix"]) {
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
            return Ok(());
        }

        if is_noise_machine {
            if let Some(v) = first_lane_value(track, &["effect.noise.type"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: v.round().clamp(0.0, 5.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.noise.level"]) {
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
            if let Some(v) = first_lane_value(track, &["effect.noise.stereo"]) {
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
            if let Some(v) = first_lane_value(track, &["effect.noise.lpfreq"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: v.clamp(200.0, 20_000.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.noise.hpfreq"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 4,
                        value: v.clamp(20.0, 5_000.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.noise.pan"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 5,
                        value: v.clamp(-100.0, 100.0),
                    },
                )?;
            }
            return Ok(());
        }

        if is_analyzer {
            if let Some(v) = first_lane_value(track, &["effect.analyzer.reset"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: if v >= 0.5 { 1.0 } else { 0.0 },
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

    struct TrackFxEntry {
        plugin_id: String,
        bypassed: bool,
        params: Option<Vec<f32>>,
    }

    fn collect_runtime_internal_effects(
        nodes: &[DeviceNode],
        parent_bypassed: bool,
        out: &mut Vec<TrackFxEntry>,
    ) {
        for node in nodes {
            match node {
                DeviceNode::Single(slot) => {
                    if slot.plugin_id.starts_with("internal://") {
                        out.push(TrackFxEntry {
                            plugin_id: slot.plugin_id.clone(),
                            bypassed: parent_bypassed || slot.is_bypassed,
                            params: slot.params.clone(),
                        });
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
        let mut internal_effects: Vec<TrackFxEntry> = Vec::new();
        collect_runtime_internal_effects(&track.effects, false, &mut internal_effects);
        let runtime_effects: Vec<(u8, TrackFxEntry)> = internal_effects
            .into_iter()
            .filter_map(|entry| {
                builtin_effect_type_from_plugin_id(&entry.plugin_id)
                    .map(|effect_type| (effect_type, entry))
            })
            .collect();
        if runtime_effects.len() > MAX_DEVICE_SLOTS as usize {
            log::warn!(
                "[RuntimeChain] track '{}' has {} internal effects; truncating to {} slots",
                track.name,
                runtime_effects.len(),
                MAX_DEVICE_SLOTS
            );
        }
        for (slot_index, (effect_type, entry)) in runtime_effects
            .into_iter()
            .take(MAX_DEVICE_SLOTS as usize)
            .enumerate()
        {
            let ti = track_index as u16;
            let si = slot_index.min(u8::MAX as usize) as u8;
            push_command(
                handle,
                EngineCommand::AddDevice {
                    track_index: ti,
                    slot_index: si,
                    effect_type,
                },
            )?;
            if entry.bypassed {
                push_command(
                    handle,
                    EngineCommand::BypassDevice {
                        track_index: ti,
                        slot_index: si,
                        bypassed: true,
                    },
                )?;
            }
            // SSOT FIX: Restore persisted params from project file.
            // Previously only master track effects had their saved params
            // restored; regular track effects lost knob positions on reload.
            if let Some(ref params) = entry.params {
                for (param_idx, &value) in params.iter().enumerate() {
                    if value != 0.0 || param_idx < 33 {
                        push_command(
                            handle,
                            EngineCommand::SetDeviceParam {
                                track_index: ti,
                                slot_index: si,
                                param_index: param_idx.min(u8::MAX as usize) as u8,
                                value,
                            },
                        )?;
                    }
                }
            }
            apply_static_imported_params_for_slot(handle, ti, si, &entry.plugin_id, track)?;
        }

        // SSOT FIX: Restore instrument bypass state on project load.
        // Previously only effect bypass was sent to the engine; bypassed
        // instruments would resume producing audio after save/load.
        if let Some(instrument) = &track.instrument {
            let inst_bypassed = instrument.is_bypassed();
            if inst_bypassed {
                push_command(
                    handle,
                    EngineCommand::BypassInstrument {
                        track_index: track_index as u16,
                        bypassed: true,
                    },
                )?;
                log::debug!(
                    "[RuntimeChain] restored instrument bypass for track '{}' (index={})",
                    track.name,
                    track_index
                );
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

        let master_runtime_effects: Vec<(u8, MasterFxEntry)> = master_internal_effects
            .into_iter()
            .filter_map(|entry| {
                builtin_effect_type_from_plugin_id(&entry.plugin_id)
                    .map(|effect_type| (effect_type, entry))
            })
            .collect();
        for (slot_index, (effect_type, entry)) in master_runtime_effects
            .into_iter()
            .take(MAX_DEVICE_SLOTS as usize)
            .enumerate()
        {
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

    Ok(())
}
