use super::*;
use crate::push_command_or_log;
use dream_clip_engine::pool::ClipAudio;
use std::sync::Arc;

/// The internal://* URI that identifies the Essence Synth instrument.
const ESSENCE_PLUGIN_ID: &str = "internal://instrument/wave-synth";

pub fn rebuild_sampler_snapshot_from_project(
    project: &Project,
    clip_pool_state: &ClipPoolState,
    handle: &AudioEngineHandle,
) {
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

    if let Ok(pool) = clip_pool_state.pool.lock() {
        for (idx, track) in project.tracks.iter().enumerate() {
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

    // ── Essence Synth Enablement on Project Load ──────────────────────
    // The Essence engine defaults to enabled=false. When a track has the
    // Essence instrument assigned (via plugin_id), we must explicitly
    // enable it during project load so it produces sound immediately
    // without requiring user interaction.
    for (idx, track) in project.tracks.iter().enumerate() {
        let is_essence = track
            .instrument
            .as_ref()
            .map_or(false, |dev| dev.plugin_id() == ESSENCE_PLUGIN_ID);

        push_command_or_log!(
            handle,
            EngineCommand::SetEssenceEnabled {
                track_index: idx as u16,
                enabled: is_essence,
            },
            "essence enabled sync"
        );
    }
}

