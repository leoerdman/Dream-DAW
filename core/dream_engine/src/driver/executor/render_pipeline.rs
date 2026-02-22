use super::super::*;
use crate::render_callback::soft_clip;
use dream_ipc::metering::{compute_peak, compute_rms};
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
            for p in 0..16 {
                if let Some(pad) = engine.pad_mut(p) {
                    let sample_opt = &rack_opt[p];
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
                            data[d_idx] +=
                                soft_clip((p_left + p_right) * std::f32::consts::FRAC_1_SQRT_2);
                        } else {
                            data[d_idx] += soft_clip(p_left);
                            if d_idx + 1 < data.len() {
                                data[d_idx + 1] += soft_clip(p_right);
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
    }
}
