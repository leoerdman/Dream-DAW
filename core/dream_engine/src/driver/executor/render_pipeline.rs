use super::super::*;
use crate::render_callback::soft_clip;
// BUG-007 FIX: compute_peak/compute_rms removed — metering now in finalize_output_and_publish only.
use dream_plugins::TransportContext;
use std::sync::atomic::Ordering;

pub(super) fn sync_sampler_engines(
    sampler_engines: &mut [SamplerEngine],
    sampler_samples: &Arc<SharedSamplerSamples>,
) {
    let samples_snapshot = sampler_samples.load();
    for (idx, sample_opt) in samples_snapshot.iter().enumerate() {
        if idx < sampler_engines.len() {
            let engine = &mut sampler_engines[idx];
            match (sample_opt, &engine.sample) {
                (Some(new_sample), Some(existing)) => {
                    if !Arc::ptr_eq(new_sample, existing) {
                        engine.set_sample(Arc::clone(new_sample));
                    }
                }
                (Some(new_sample), None) => {
                    engine.set_sample(Arc::clone(new_sample));
                }
                (None, Some(_)) => {
                    engine.sample = None;
                }
                (None, None) => {}
            }
        }
    }
}

pub(super) fn sync_sample_rack_engines(
    sample_rack_engines: &mut [SampleRackEngine],
    sample_rack_samples: &Arc<SharedSampleRackSamples>,
) {
    let rack_samples_snapshot = sample_rack_samples.load();
    for (idx, rack_opt) in rack_samples_snapshot.iter().enumerate() {
        if idx < sample_rack_engines.len() {
            let engine = &mut sample_rack_engines[idx];
            for (p, sample_opt) in rack_opt.iter().enumerate().take(16) {
                if let Some(pad) = engine.pad_mut(p) {
                    match (sample_opt, &pad.sample) {
                        (Some(new_sample), Some(existing)) => {
                            if !Arc::ptr_eq(new_sample, existing) {
                                pad.set_sample(Arc::clone(new_sample));
                            }
                        }
                        (Some(new_sample), None) => {
                            pad.set_sample(Arc::clone(new_sample));
                        }
                        (None, Some(_)) => {
                            pad.sample = None;
                        }
                        (None, None) => {}
                    }
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn process_master_runtime_fx_and_gain(
    external_fx_map: &[Vec<ExternalFxRuntimeSlot>],
    track_count: usize,
    master_device_chain: &mut DeviceChain,
    plugin_registry_ref: &std::collections::HashMap<uuid::Uuid, PluginInstanceArc>,
    graph_out_left: &mut [f32],
    graph_out_right: &mut [f32],
    external_left: &mut [f32],
    external_right: &mut [f32],
    n: usize,
    playhead_pos: i64,
    sample_rate_f64: f64,
    bpm: f64,
    is_playing: bool,
    time_sig_numerator: u8,
    time_sig_denominator: u8,
    master_gain_target: f32,
    master_gain_current: &mut f32,
    master_gain_smooth: f32,
    // BUG-007 FIX: render_ctx and graph_peak_decay removed — metering
    // is now done exclusively in finalize_output_and_publish().
) {
    let master_slots_opt = resolve_master_runtime_slots(external_fx_map, track_count);
    if let Some(master_slots) = master_slots_opt {
        if !master_slots.is_empty() {
            for runtime_slot in master_slots {
                if let Some(internal_idx) = runtime_slot.internal_slot_index {
                    master_device_chain.process_slot_with_sidechain(
                        internal_idx,
                        &mut graph_out_left[..n],
                        &mut graph_out_right[..n],
                        None,
                        None,
                        sample_rate_f64 as f32,
                    );
                    continue;
                }

                if let Some(instance_id) = runtime_slot.instance_id
                    && let Some(plugin_mtx) = plugin_registry_ref.get(&instance_id)
                    && let Some(mut host) = plugin_mtx.try_lock()
                {
                    let main_inputs: [&[f32]; 2] = [&graph_out_left[..n], &graph_out_right[..n]];
                    let transport = TransportContext {
                        sample_rate: sample_rate_f64,
                        position_samples: playhead_pos,
                        tempo: bpm,
                        is_playing,
                        is_recording: false,
                        time_sig_numerator: i32::from(time_sig_numerator),
                        time_sig_denominator: i32::from(time_sig_denominator),
                    };
                    host.set_transport_context(transport);

                    let empty_midi: &[MidiEvent] = &[];
                    external_left[..n].copy_from_slice(&graph_out_left[..n]);
                    external_right[..n].copy_from_slice(&graph_out_right[..n]);
                    let mut out_slices: [&mut [f32]; 2] =
                        [&mut external_left[..n], &mut external_right[..n]];
                    let _ = host.process_with_sidechain(
                        &main_inputs,
                        None,
                        &mut out_slices,
                        n,
                        empty_midi,
                    );
                    graph_out_left[..n].copy_from_slice(&external_left[..n]);
                    graph_out_right[..n].copy_from_slice(&external_right[..n]);
                }
            }
        } else if !master_device_chain.is_empty() {
            master_device_chain.process_stereo(
                &mut graph_out_left[..n],
                &mut graph_out_right[..n],
                sample_rate_f64 as f32,
            );
        }
    } else if !master_device_chain.is_empty() {
        master_device_chain.process_stereo(
            &mut graph_out_left[..n],
            &mut graph_out_right[..n],
            sample_rate_f64 as f32,
        );
    }

    for i in 0..n {
        *master_gain_current += (master_gain_target - *master_gain_current) * master_gain_smooth;
        graph_out_left[i] *= *master_gain_current;
        graph_out_right[i] *= *master_gain_current;
    }

    // BUG-007 FIX: Removed redundant master metering here.
    // finalize_output_and_publish() already performs authoritative post-soft-clip
    // metering on the final output. The pre-soft-clip measurement here was:
    // (a) immediately overwritten by finalize_output, and
    // (b) wasting ~4μs per buffer on compute_rms/compute_peak.
}

pub(super) fn interleave_graph_output(
    graph_out_left: &[f32],
    graph_out_right: &[f32],
    n: usize,
    channels: usize,
    data: &mut [f32],
) {
    for i in 0..n {
        let base = i * channels;
        if base >= data.len() {
            break;
        }
        if channels == 1 {
            data[base] = (graph_out_left[i] + graph_out_right[i]) * std::f32::consts::FRAC_1_SQRT_2;
            continue;
        }
        data[base] = graph_out_left[i];
        if base + 1 < data.len() {
            data[base + 1] = graph_out_right[i];
        }
        for ch in 2..channels {
            let idx = base + ch;
            if idx < data.len() {
                data[idx] = 0.0;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn render_test_tone_if_needed(
    test_tone_enabled: bool,
    is_playing: bool,
    sample_rate_f64: f64,
    channels: usize,
    data: &mut [f32],
    test_tone_current_freq: &mut f32,
    test_tone_target_freq: f32,
    test_tone_phase: &mut f64,
    test_tone_amplitude: f32,
) {
    if !test_tone_enabled || is_playing {
        return;
    }

    let freq_smooth_coeff = 1.0 - (-1.0_f64 / (0.03 * sample_rate_f64)).exp() as f32;
    for frame in data.chunks_exact_mut(channels) {
        *test_tone_current_freq +=
            (test_tone_target_freq - *test_tone_current_freq) * freq_smooth_coeff;
        let phase_inc = *test_tone_current_freq as f64 / sample_rate_f64;
        let sample = (*test_tone_phase * std::f64::consts::TAU).sin() as f32 * test_tone_amplitude;
        for ch in frame.iter_mut() {
            *ch = sample;
        }
        *test_tone_phase += phase_inc;
        *test_tone_phase = test_tone_phase.fract();
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn mix_preview_audio(
    preview_buffer: &Arc<arc_swap::ArcSwap<Option<Vec<f32>>>>,
    preview_cursor: &Arc<AtomicUsize>,
    preview_source_sr: &Arc<AtomicU32>,
    sample_rate: u32,
    frame_count: usize,
    channels: usize,
    data: &mut [f32],
) {
    let preview_snap = preview_buffer.load();
    if let Some(ref preview_data) = **preview_snap {
        let cursor = preview_cursor.load(Ordering::Relaxed);
        let total = preview_data.len();
        let preview_channels = 2usize;
        let total_frames = total / preview_channels;
        if cursor < total {
            let cursor_frame = cursor / preview_channels;
            let src_sr = preview_source_sr.load(Ordering::Relaxed);
            let rate = if src_sr > 0 && sample_rate > 0 {
                src_sr as f64 / sample_rate as f64
            } else {
                1.0
            };

            if (rate - 1.0).abs() < 0.001 {
                let preview_frames = total_frames.saturating_sub(cursor_frame);
                let mix_frames = preview_frames.min(frame_count);
                for f in 0..mix_frames {
                    let p_idx = cursor + f * preview_channels;
                    let d_idx = f * channels;
                    if p_idx + 1 < total && d_idx < data.len() {
                        let p_left = preview_data[p_idx];
                        let p_right = preview_data[p_idx + 1];
                        if channels == 1 {
                            // BUG-006 FIX: Don't soft_clip here — finalize_output_and_publish does it once.
                            data[d_idx] +=
                                (p_left + p_right) * std::f32::consts::FRAC_1_SQRT_2;
                        } else {
                            data[d_idx] += p_left;
                            if d_idx + 1 < data.len() {
                                data[d_idx + 1] += p_right;
                            }
                        }
                    }
                }
                let new_cursor = cursor + mix_frames * preview_channels;
                let _ = preview_cursor.compare_exchange(
                    cursor,
                    new_cursor,
                    Ordering::Release,
                    Ordering::Relaxed,
                );
            } else {
                let mut src_pos = cursor_frame as f64;
                for f in 0..frame_count {
                    if src_pos >= (total_frames - 1) as f64 {
                        break;
                    }
                    let i0 = src_pos.floor() as usize;
                    let i1 = (i0 + 1).min(total_frames - 1);
                    let frac = (src_pos - i0 as f64) as f32;
                    let inv = 1.0 - frac;

                    let l0 = preview_data[i0 * 2];
                    let l1 = preview_data[i1 * 2];
                    let r0 = preview_data[i0 * 2 + 1];
                    let r1 = preview_data[i1 * 2 + 1];

                    let p_left = l0 * inv + l1 * frac;
                    let p_right = r0 * inv + r1 * frac;

                    let d_idx = f * channels;
                    if d_idx < data.len() {
                        if channels == 1 {
                            data[d_idx] +=
                                soft_clip((p_left + p_right) * std::f32::consts::FRAC_1_SQRT_2);
                        } else {
                            data[d_idx] += soft_clip(p_left);
                            if d_idx + 1 < data.len() {
                                data[d_idx + 1] += soft_clip(p_right);
                            }
                        }
                    }
                    src_pos += rate;
                }
                let new_cursor_frame = src_pos.ceil() as usize;
                let new_cursor = (new_cursor_frame * preview_channels).min(total);
                let _ = preview_cursor.compare_exchange(
                    cursor,
                    new_cursor,
                    Ordering::Release,
                    Ordering::Relaxed,
                );
            }
        }
    }
}

pub(super) fn finalize_output_and_publish(
    data: &mut [f32],
    n: usize,
    channels: usize,
    render_ctx: &mut RenderContext,
    sample_rate_f64: f64,
) {
    for sample in data[..n * channels].iter_mut() {
        *sample = soft_clip(*sample);
    }

    if let Some(producer) = &mut render_ctx.spectrum_producer {
        let mut drops = 0u32;
        if channels >= 2 {
            for frame in data.chunks_exact(channels) {
                let mono = (frame[0] + frame[1]) * 0.5;
                if producer.push(mono).is_err() {
                    drops += 1;
                }
            }
        } else if channels == 1 {
            for &sample in data.iter() {
                if producer.push(sample).is_err() {
                    drops += 1;
                }
            }
        }
        if drops > 0 {
            crate::render_callback::SPECTRUM_DROP_COUNT
                .fetch_add(drops, std::sync::atomic::Ordering::Relaxed);
        }
    }

    if channels >= 2 {
        let mut sum_sq_l = 0.0f64;
        let mut sum_sq_r = 0.0f64;
        let mut peak_l = 0.0f32;
        let mut peak_r = 0.0f32;
        let mut frames = 0usize;

        for frame in data.chunks_exact(channels) {
            let l = frame[0];
            let r = frame[1];
            sum_sq_l += (l as f64) * (l as f64);
            sum_sq_r += (r as f64) * (r as f64);
            peak_l = peak_l.max(l.abs());
            peak_r = peak_r.max(r.abs());
            frames += 1;
        }

        if frames > 0 {
            let rms_l = (sum_sq_l / frames as f64).sqrt() as f32;
            let rms_r = (sum_sq_r / frames as f64).sqrt() as f32;
            let master_decay = peak_decay_for_block(sample_rate_f64, frames);
            render_ctx
                .meter_bank
                .master_left()
                .store_rms(linear_to_db(rms_l));
            render_ctx
                .meter_bank
                .master_right()
                .store_rms(linear_to_db(rms_r));
            render_ctx
                .meter_bank
                .master_left()
                .store_peak_decay(linear_to_db(peak_l), master_decay);
            render_ctx
                .meter_bank
                .master_right()
                .store_peak_decay(linear_to_db(peak_r), master_decay);
        }
    } else if channels == 1 {
        // BUG-007 FIX: Mono outputs now get RMS/peak metering.
        let mut sum_sq = 0.0f64;
        let mut peak = 0.0f32;
        let mono_data = &data[..n];
        for &s in mono_data {
            sum_sq += (s as f64) * (s as f64);
            peak = peak.max(s.abs());
        }
        if n > 0 {
            let rms = (sum_sq / n as f64).sqrt() as f32;
            let master_decay = peak_decay_for_block(sample_rate_f64, n);
            let rms_db = linear_to_db(rms);
            let peak_db = linear_to_db(peak);
            // Mirror mono signal to both L/R master meters.
            render_ctx.meter_bank.master_left().store_rms(rms_db);
            render_ctx.meter_bank.master_right().store_rms(rms_db);
            render_ctx.meter_bank.master_left().store_peak_decay(peak_db, master_decay);
            render_ctx.meter_bank.master_right().store_peak_decay(peak_db, master_decay);
        }
    }
}
