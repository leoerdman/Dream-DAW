use super::*;
use crate::push_command_or_log;
use dream_clip_engine::pool::ClipAudio;
use std::sync::Arc;

pub fn rebuild_sampler_snapshot_from_project(
    project: &Project,
    clip_pool_state: &ClipPoolState,
    handle: &AudioEngineHandle,
) {
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

    let mut samples: Vec<Option<Arc<ClipAudio>>> = vec![None; project.tracks.len()];
    let empty_pad_samples: [Option<Arc<ClipAudio>>; 16] = Default::default();
    let mut rack_samples: Vec<[Option<Arc<ClipAudio>>; 16]> =
        vec![empty_pad_samples; project.tracks.len()];

    struct RackSettings {
        track_idx: u16,
        pad_idx: u8,
        volume: f32,
        attack: f32,
        decay: f32,
        sustain: f32,
        release: f32,
        filter_cutoff: f32,
    }
    let mut rack_settings: Vec<RackSettings> = Vec::new();

    let mut synth_settings: Vec<(
        usize,
        u8,
        u8,
        f32,
        f32,
        f32,
        f32,
        f32,
        u8,
        f32,
        f32,
        u8,
        f32,
    )> = Vec::new();
    if let Ok(pool) = clip_pool_state.pool.lock() {
        for (idx, track) in project.tracks.iter().enumerate() {
            let plugin_id_lower = track
                .instrument
                .as_ref()
                .map(|inst| inst.plugin_id().to_lowercase())
                .unwrap_or_default();
            let is_wave_synth = plugin_id_lower.starts_with("internal://instrument/wave-synth")
                || plugin_id_lower.starts_with("internal://instrument/simple-sine-synth");
            if is_wave_synth {
                let (
                    waveform,
                    osc2,
                    mix,
                    detune,
                    sub,
                    f_cutoff,
                    f_res,
                    f_type,
                    lfo_r,
                    lfo_d,
                    lfo_t,
                    pw,
                ) = track
                    .sampler
                    .as_ref()
                    .map(|cfg| {
                        (
                            waveform_code_from_token(&cfg.sample_path),
                            cfg.osc2_waveform.min(3),
                            cfg.osc_mix.clamp(0.0, 1.0) as f32,
                            cfg.detune_cents.clamp(-50.0, 50.0) as f32,
                            cfg.sub_level.clamp(0.0, 1.0) as f32,
                            cfg.filter_cutoff.clamp(20.0, 20000.0) as f32,
                            cfg.filter_resonance.clamp(0.0, 0.99) as f32,
                            cfg.filter_type.min(3),
                            cfg.lfo_rate.clamp(0.01, 20.0) as f32,
                            cfg.lfo_depth.clamp(0.0, 1.0) as f32,
                            cfg.lfo_target.min(2),
                            cfg.pulse_width.clamp(0.05, 0.95) as f32,
                        )
                    })
                    .unwrap_or((0, 0, 0.35, 0.0, 0.0, 20000.0, 0.0, 0, 1.0, 0.0, 0, 0.5));
                synth_settings.push((
                    idx, waveform, osc2, mix, detune, sub, f_cutoff, f_res, f_type, lfo_r, lfo_d,
                    lfo_t, pw,
                ));
            }
            if let Some(cfg) = &track.sampler
                && !cfg.sample_path.trim().is_empty()
                && !cfg.sample_path.starts_with("internal://")
                && let Some(audio) = pool.get(&cfg.sample_path)
            {
                samples[idx] = Some(audio);
            }

            if let Some(rack) = &track.sample_rack {
                for (p, pad) in rack.pads.iter().enumerate() {
                    rack_settings.push(RackSettings {
                        track_idx: idx as u16,
                        pad_idx: p as u8,
                        volume: pad.volume as f32,
                        attack: pad.attack as f32,
                        decay: pad.decay as f32,
                        sustain: pad.sustain as f32,
                        release: pad.release as f32,
                        filter_cutoff: pad.filter_cutoff as f32,
                    });
                    if !pad.sample_path.trim().is_empty()
                        && let Some(audio) = pool.get(&pad.sample_path)
                    {
                        rack_samples[idx][p] = Some(audio);
                    }
                }
            }
        }
    }
    handle.sampler_samples.swap(samples);
    handle.sample_rack_samples.swap(rack_samples);

    for (
        track_idx,
        waveform,
        osc2,
        mix,
        detune,
        sub,
        f_cutoff,
        f_res,
        f_type,
        lfo_r,
        lfo_d,
        lfo_t,
        pw,
    ) in synth_settings
    {
        if let Err(err) = push_command(
            handle,
            EngineCommand::SetSamplerWaveform {
                track_index: track_idx as u16,
                waveform,
            },
        ) {
            log::warn!(
                "[Sampler] Failed to restore waveform for track {}: {}",
                track_idx,
                err
            );
        }
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerOsc2Waveform {
                track_index: track_idx as u16,
                waveform: osc2,
            },
            "sampler osc2 waveform"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerOsc1Volume {
                track_index: track_idx as u16,
                volume: 1.0 - mix,
            },
            "sampler osc1 volume"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerOsc2Volume {
                track_index: track_idx as u16,
                volume: mix,
            },
            "sampler osc2 volume"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerDetuneCents {
                track_index: track_idx as u16,
                cents: detune,
            },
            "sampler detune"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerSubLevel {
                track_index: track_idx as u16,
                level: sub,
            },
            "sampler sub level"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerFilterCutoff {
                track_index: track_idx as u16,
                cutoff: f_cutoff,
            },
            "sampler filter cutoff"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerFilterResonance {
                track_index: track_idx as u16,
                resonance: f_res,
            },
            "sampler filter resonance"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerFilterType {
                track_index: track_idx as u16,
                filter_type: f_type,
            },
            "sampler filter type"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerLfoRate {
                track_index: track_idx as u16,
                rate: lfo_r,
            },
            "sampler lfo rate"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerLfoDepth {
                track_index: track_idx as u16,
                depth: lfo_d,
            },
            "sampler lfo depth"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerLfoTarget {
                track_index: track_idx as u16,
                target: lfo_t,
            },
            "sampler lfo target"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerPulseWidth {
                track_index: track_idx as u16,
                width: pw,
            },
            "sampler pulse width"
        );
    }

    for rs in rack_settings {
        push_command_or_log!(
            handle,
            EngineCommand::SetSampleRackPadVolume {
                track_index: rs.track_idx,
                pad_index: rs.pad_idx,
                volume: rs.volume,
            },
            "rack pad volume"
        );

        push_command_or_log!(
            handle,
            EngineCommand::SetSampleRackPadAdsr {
                track_index: rs.track_idx,
                pad_index: rs.pad_idx,
                attack: rs.attack,
                decay: rs.decay,
                sustain: rs.sustain,
                release: rs.release,
            },
            "rack pad adsr"
        );

        push_command_or_log!(
            handle,
            EngineCommand::SetSampleRackPadFilterCutoff {
                track_index: rs.track_idx,
                pad_index: rs.pad_idx,
                cutoff: rs.filter_cutoff,
            },
            "rack pad cutoff"
        );
    }
}
