use super::*;

pub fn first_lane_value(track: &Track, keys: &[&str]) -> Option<f32> {
    fn normalize_lane_key(raw: &str) -> String {
        let lowered = raw.to_ascii_lowercase();
        let unscoped = if let Some(rest) = lowered.strip_prefix("slot:") {
            if let Some(split_at) = rest.find(':') {
                &rest[split_at + 1..]
            } else {
                lowered.as_str()
            }
        } else {
            lowered.as_str()
        };
        unscoped
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect()
    }

    let normalized_keys: Vec<String> = keys.iter().map(|k| normalize_lane_key(k)).collect();
    for lane in &track.automation_lanes {
        let lane_key = normalize_lane_key(&lane.param_id);
        let matches = normalized_keys
            .iter()
            .any(|key| lane_key == *key || lane_key.ends_with(key));
        if !matches {
            continue;
        }
        if let Some(point) = lane.points.first() {
            return Some(point.value as f32);
        }
    }
    None
}

pub fn try_apply_primary_imported_params(
    handle: &AudioEngineHandle,
    track_index: u16,
    slot_index: u8,
    plugin_id: &str,
    track: &Track,
) -> Result<bool, String> {
    let pid = plugin_id.to_ascii_lowercase();
    let is_utility = matches!(
        pid.as_str(),
        "internal://effect/utility"
            | "internal://effect/tuner"
            | "internal://effect/external-audio-effect"
            | "internal://effect/auto-shift"
            | "internal://effect/shifter"
    );
    let is_eq = matches!(
        pid.as_str(),
        "internal://effect/eq-eight"
            | "internal://effect/channel-eq"
            | "internal://effect/eq-three"
    );
    let is_auto_filter = matches!(
        pid.as_str(),
        "internal://effect/auto-filter" | "internal://effect/vocoder"
    );
    let is_compressor = matches!(
        pid.as_str(),
        "internal://effect/compressor"
            | "internal://effect/glue-compressor"
            | "internal://effect/multiband-dynamics"
            | "internal://effect/transient-shaper"
    );
    let is_reverb = matches!(
        pid.as_str(),
        "internal://effect/reverb"
            | "internal://effect/hybrid-reverb"
            | "internal://effect/corpus"
            | "internal://effect/resonators"
            | "internal://effect/spectral-resonator"
    );

    if is_utility {
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
        return Ok(true);
    }

    if is_eq {
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
        return Ok(true);
    }

    if is_auto_filter {
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
        return Ok(true);
    }

    if is_compressor {
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
        return Ok(true);
    }

    if is_reverb {
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
        return Ok(true);
    }

    Ok(false)
}
