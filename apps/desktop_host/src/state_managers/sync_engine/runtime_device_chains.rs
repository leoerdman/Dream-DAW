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
    // MAX_DEVICE_SLOTS is no longer used for truncation — chains grow dynamically.
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
                (true, 3u32, 4u32)
            } else {
                (false, 4u32, 5u32)
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

    /// ENTERPRISE FIX: Returns ALL applicable runtime chains from a rack.
    /// Ableton racks process chains IN PARALLEL — all enabled chains contribute
    /// devices simultaneously, their outputs are summed.
    ///
    /// Solo logic: when any chain is solo'd, ONLY solo'd+enabled chains play.
    /// When no chains are solo'd, ALL non-disabled chains contribute.
    /// Previously `selected_runtime_chain()` only returned ONE chain, which
    /// meant only 1 chain's effects ran — completely breaking multi-chain racks.
    fn collect_applicable_runtime_chains(
        rack: &dream_models::project::DeviceRack,
    ) -> Vec<&dream_models::project::RackChain> {
        let has_solo = rack.chains.iter().any(|c| c.is_solo);
        if has_solo {
            // Only solo'd + enabled chains
            rack.chains.iter().filter(|c| c.is_solo && !c.is_disabled).collect()
        } else {
            // All non-disabled chains
            rack.chains.iter().filter(|c| !c.is_disabled).collect()
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
                    // ENTERPRISE FIX: Iterate ALL applicable chains, not just one.
                    for chain in collect_applicable_runtime_chains(rack) {
                        collect_runtime_internal_effects(&chain.devices, rack_bypassed, out);
                    }
                }
            }
        }
    }

    // ENTERPRISE FIX: Replace 16×N individual RemoveDevice commands with a single
    // ClearAllDeviceChains command. This reduces command queue pressure from 256+
    // commands to 1, preventing deferred_topology overflow and drain_commands
    // budget exhaustion that caused permanent DeviceChain desync on group tracks.
    push_command(handle, EngineCommand::ClearAllDeviceChains)?;

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
        for (slot_index, (effect_type, entry)) in runtime_effects
            .into_iter()
            .enumerate()
        {
            let ti = track_index as u16;
            let si = slot_index.min(u8::MAX as usize) as u8;
            push_prealloc_device(
                handle,
                ti,
                si,
                effect_type,
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
            // STATE-RESTORE FIX: Restore ALL persisted params on rebuild.
            // Previous code had `if value != 0.0 || param_idx < 33` which
            // silently skipped EQ filter-type params (indices 33-40) when
            // their value was 0 (= Highpass type). This corrupted EQ state
            // whenever tracks were moved, grouped, or undo/redo was invoked.
            if let Some(ref params) = entry.params {
                for (param_idx, &value) in params.iter().enumerate() {
                    push_command(
                        handle,
                        EngineCommand::SetDeviceParam {
                            track_index: ti,
                            slot_index: si,
                            param_index: param_idx as u32,
                            value,
                        },
                    )?;
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
                    if builtin_effect_type_from_plugin_id(&slot.plugin_id).is_some() {
                        out.push(MasterFxEntry {
                            plugin_id: slot.plugin_id.clone(),
                            bypassed: parent_bypassed || slot.is_bypassed,
                            params: slot.params.clone(),
                        });
                    }
                }
                DeviceNode::Rack(rack) => {
                    let rack_bypassed = parent_bypassed || rack.is_bypassed;
                    // ENTERPRISE FIX: Iterate ALL applicable chains.
                    for chain in collect_applicable_runtime_chains(rack) {
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
            .enumerate()
        {
            push_prealloc_device(
                handle,
                MASTER_TRACK_INDEX,
                slot_index.min(u8::MAX as usize) as u8,
                effect_type,
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
            // STATE-RESTORE FIX: Same fix as for regular tracks (see above).
            if let Some(ref params) = entry.params {
                for (param_idx, &value) in params.iter().enumerate() {
                    push_command(
                        handle,
                        EngineCommand::SetDeviceParam {
                            track_index: MASTER_TRACK_INDEX,
                            slot_index: slot_index.min(u8::MAX as usize) as u8,
                            param_index: param_idx as u32,
                            value,
                        },
                    )?;
                }
            }
        }
    }

    Ok(())
}
