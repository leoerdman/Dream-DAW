use super::super::*;
use dream_dsp::device_slot::ProcessContext;
use dream_plugins::TransportContext;
use std::sync::atomic::Ordering;

pub(super) fn sync_sampler_samples(
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
pub(super) fn process_master_bus(
    external_fx_map: &[Vec<ExternalPluginRuntimeSlot>],
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
    master_gain_smoother: &mut crate::oscillator::ParameterSmoother,
    render_ctx: &mut RenderContext,
    process_ctx: &ProcessContext,
    export_active: bool,
) {
    let master_slots_opt = resolve_master_runtime_slots(external_fx_map, track_count);
    if let Some(master_slots) = master_slots_opt {
        if !master_slots.is_empty() {
            let has_external = master_slots.iter().any(|s| s.instance_id.is_some());
            // BUG-11 FIX: Check if ANY master slot has a sidechain source.
            // Previously, the !has_external fast path processed the entire
            // chain without sidechain via process_with_context(), silently
            // ignoring any sidechain routing on internal master effects.
            let has_internal_sidechain = master_slots.iter().any(|s| {
                s.internal_slot_index.is_some() && s.sidechain_track_index.is_some()
            });
            if !has_external && !has_internal_sidechain {
                // AUD-500 FIX: Diagnostic — count topology sync mismatches via atomic counter.
                // BUG-001 FIX: Removed log::warn! — log backend Mutex is RT-unsafe (priority inversion).
                if master_device_chain.is_empty() && master_slots.iter().any(|s| s.internal_slot_index.is_some()) {
                    static TOPOLOGY_SYNC_MISS: std::sync::atomic::AtomicU32 =
                        std::sync::atomic::AtomicU32::new(0);
                    TOPOLOGY_SYNC_MISS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
                if !master_device_chain.is_empty() {
                    master_device_chain.process_with_context(
                        &mut graph_out_left[..n],
                        &mut graph_out_right[..n],
                        process_ctx,
                    );
                }
            } else {
                for runtime_slot in master_slots {
                    // BUG-11 FIX: Master sidechain source resolution.
                    // The master bus processes AFTER all graph tracks, so every
                    // track's Pre-FX / Post-FX / Post-Mixer tap buffers are valid.
                    // Read sidechain audio from render_ctx.track_slots[src_idx].
                    let (sc_l, sc_r): (Option<&[f32]>, Option<&[f32]>) = runtime_slot
                        .sidechain_track_index
                        .and_then(|src_idx| {
                            if src_idx >= render_ctx.track_slots.len() { return None; }
                            let src = &render_ctx.track_slots[src_idx];
                            let mode = runtime_slot.sidechain_send_mode;
                            Some(match mode {
                                0 => (&src.sidechain_pre_fx_left[..n], &src.sidechain_pre_fx_right[..n]),
                                1 => (&src.sidechain_post_fx_left[..n], &src.sidechain_post_fx_right[..n]),
                                _ => (&src.buf_left[..n], &src.buf_right[..n]),
                            })
                        })
                        .map(|(sl, sr)| (Some(sl), Some(sr)))
                        .unwrap_or((None, None));

                    if let Some(internal_idx) = runtime_slot.internal_slot_index {
                        // BUG-11 FIX: Pass resolved sidechain buffers instead of None.
                        master_device_chain.process_slot_with_sidechain_ctx(
                            internal_idx,
                            &mut graph_out_left[..n],
                            &mut graph_out_right[..n],
                            sc_l,
                            sc_r,
                            process_ctx,
                        );
                        continue;
                    }

                    if let Some(instance_id) = runtime_slot.instance_id {
                        let Some(plugin_mtx) = plugin_registry_ref.get(&instance_id) else {
                            // AUD-601 FIX: Diagnose missing master-bus plugin instances.
                            // BUG-003 FIX: Removed log::warn! — RT-unsafe Mutex in log backend.
                            static MASTER_MISS: std::sync::atomic::AtomicU32 =
                                std::sync::atomic::AtomicU32::new(0);
                            MASTER_MISS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            continue;
                        };
                        // CRACKLE-FIX-1: Copy input into external buffers BEFORE
                        // attempting lock. On lock miss, the dry signal is already
                        // in external_left/right, so the copy-back below produces
                        // clean passthrough instead of a one-buffer audio gap.
                        external_left[..n].copy_from_slice(&graph_out_left[..n]);
                        external_right[..n].copy_from_slice(&graph_out_right[..n]);

                        // EXPORT-DISTORTION-FIX: Skip master bus VST processing
                        // on the RT thread when offline export is active. The
                        // offline renderer holds exclusive plugin access via
                        // blocking lock — any RT try_lock() success here would
                        // feed the plugin a different playhead/buffer, corrupting
                        // its DSP state and producing distorted export audio.
                        // Master bus FX are applied by the offline renderer's
                        // Phase 4.5 (render_routing_aware), so they ARE included
                        // in the export — just not processed by the RT thread.
                        if export_active {
                            // Dry passthrough — external buffers already contain
                            // the input. Sanitize and copy back below.
                        } else if let Some(mut host) = plugin_mtx.try_lock() {
                            // Lock acquired — full plugin processing
                            let main_inputs: [&[f32]; 2] = [&graph_out_left[..n], &graph_out_right[..n]];
                            // BUG-11 FIX: Pass resolved SC pair to external VST plugins on master.
                            let sc_pair: Option<[&[f32]; 2]> = sc_l.zip(sc_r).map(|(l, r)| [l, r]);
                            let transport = TransportContext {
                                sample_rate: sample_rate_f64,
                                position_samples: playhead_pos,
                                tempo: bpm,
                                is_playing,
                                is_recording: false,
                                time_sig_numerator: i32::from(time_sig_numerator),
                                time_sig_denominator: i32::from(time_sig_denominator),
                                cycle_active: false,
                                loop_start_samples: 0,
                                loop_end_samples: 0,
                            };
                            host.set_transport_context(transport);

                            let empty_midi: &[MidiEvent] = &[];
                            let mut out_slices: [&mut [f32]; 2] =
                                [&mut external_left[..n], &mut external_right[..n]];
                            if let Err(_proc_err) = host.process_with_sidechain(
                                &main_inputs,
                                sc_pair.as_ref().map(|p| p.as_slice()),
                                &mut out_slices,
                                n,
                                empty_midi,
                            ) {
                                static MASTER_PROC_ERR: std::sync::atomic::AtomicU32 =
                                    std::sync::atomic::AtomicU32::new(0);
                                MASTER_PROC_ERR.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            }
                        } else {
                            // CRACKLE-FIX-1: Lock contended — dry passthrough.
                            // external_left/right already contain the input signal.
                            static MASTER_LOCK_MISS: std::sync::atomic::AtomicU32 =
                                std::sync::atomic::AtomicU32::new(0);
                            MASTER_LOCK_MISS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        }

                        // Always sanitize and copy back, regardless of lock outcome.
                        for i in 0..n {
                            if !external_left[i].is_finite() {
                                external_left[i] = 0.0;
                            }
                            if !external_right[i].is_finite() {
                                external_right[i] = 0.0;
                            }
                        }
                        graph_out_left[..n].copy_from_slice(&external_left[..n]);
                        graph_out_right[..n].copy_from_slice(&external_right[..n]);
                    }
                }
            }
        } else if !master_device_chain.is_empty() {
            master_device_chain.process_with_context(
                &mut graph_out_left[..n],
                &mut graph_out_right[..n],
                process_ctx,
            );
        }
    } else if !master_device_chain.is_empty() {
        master_device_chain.process_with_context(
            &mut graph_out_left[..n],
            &mut graph_out_right[..n],
            process_ctx,
        );
    }
    // ENTERPRISE FIX: Apply master gain BEFORE soft_clip so the gain
    // reduction happens before saturation — not after. Previously,
    // gain was applied post-soft_clip which could push an already-saturated
    // signal above 0dBFS.
    for i in 0..n {
        let gain = master_gain_smoother.next();
        graph_out_left[i] *= gain;
        graph_out_right[i] *= gain;
    }

    // AUD-503 FIX: Removed redundant pre-soft-clip master metering.
    // The authoritative master meters are computed in finalize_output_and_publish()
    // AFTER soft_clip, which gives the user the true final output levels.

    // Export master bus plugin metrics (e.g. Master Gain Reduction)
    let num_slots = master_device_chain.slots().len().min(16);
    let master_metrics = render_ctx.meter_bank.master_plugin_metrics();
    for i in 0..num_slots {
        master_metrics[i].store_peak(master_device_chain.slots()[i].get_metric_f32());
    }
    for i in num_slots..16 {
        master_metrics[i].store_peak(0.0);
    }
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
            // ENTERPRISE FIX: Standard -6dB mono fold-down.
            // Summing L+R without attenuation produces +6dBFS with correlated stereo,
            // causing hard clipping. 0.5 (-6dB) is the industry standard.
            data[base] = (graph_out_left[i] + graph_out_right[i]) * 0.5;
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
            *ch += sample;
        }
        *test_tone_phase += phase_inc;
        *test_tone_phase = test_tone_phase.fract();
    }
    // BUG-082 FIX: Zero-fill any trailing samples that chunks_exact_mut
    // skips when data.len() isn't divisible by channels.
    let remainder_start = (data.len() / channels) * channels;
    for s in &mut data[remainder_start..] {
        *s = 0.0;
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
                            // ENTERPRISE FIX: Removed per-sample soft_clip here.
                            // Preview audio is already soft-clipped in
                            // finalize_output_and_publish(). Double soft-clip
                            // attenuated preview volume and changed timbre.
                            if channels == 1 {
                                data[d_idx] +=
                                    (p_left + p_right) * 0.5;
                            } else {
                                data[d_idx] += p_left;
                                if d_idx + 1 < data.len() {
                                    data[d_idx + 1] += p_right;
                                }
                            }
                        }
                }
                let new_cursor = cursor + mix_frames * preview_channels;
                // BUG-009 FIX: Use store instead of compare_exchange.
                // The audio callback is the sole writer — CAS failure (from UI reset)
                // should not silently replay the same chunk. Unconditional store
                // ensures cursor always advances.
                preview_cursor.store(new_cursor, Ordering::Release);
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
                        // ENTERPRISE FIX: Removed per-sample soft_clip.
                        // Preview audio is soft-clipped once in finalize_output_and_publish().
                        if channels == 1 {
                            // ENTERPRISE FIX: -6dB mono fold-down for preview audio.
                            data[d_idx] +=
                                (p_left + p_right) * 0.5;
                        } else {
                            data[d_idx] += p_left;
                            if d_idx + 1 < data.len() {
                                data[d_idx + 1] += p_right;
                            }
                        }
                    }
                    src_pos += rate;
                }
                let new_cursor_frame = src_pos.ceil() as usize;
                let new_cursor = (new_cursor_frame * preview_channels).min(total);
                // BUG-009 FIX: Same as above — unconditional store.
                preview_cursor.store(new_cursor, Ordering::Release);
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
    let valid_data = &data[..n * channels];

    if let Some(producer) = &mut render_ctx.spectrum_producer {
        // BUG-013 FIX: Track drops as boolean per-buffer, not per-sample counter.
        // Previously incremented the atomic up to N times per buffer (e.g., 1024
        // atomic ops at 48kHz) — pure overhead when the ring is full.
        let mut had_drops = false;
        if channels >= 2 {
            for frame in valid_data.chunks_exact(channels) {
                let mono = (frame[0] + frame[1]) * 0.5;
                if producer.push(mono).is_err() {
                    had_drops = true;
                }
            }
        } else if channels == 1 {
            // ENTERPRISE FIX: For mono devices, iterate frame-by-frame
            // instead of per-sample to avoid pushing extra surround channel data.
            for frame in valid_data.chunks_exact(channels) {
                if producer.push(frame[0]).is_err() {
                    had_drops = true;
                }
            }
        }
        if had_drops {
            crate::render_callback::SPECTRUM_DROP_COUNT
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }

    if channels >= 2 {
        let mut sum_sq_l = 0.0f64;
        let mut sum_sq_r = 0.0f64;
        let mut peak_l = 0.0f32;
        let mut peak_r = 0.0f32;
        let mut frames = 0usize;

        for frame in valid_data.chunks_exact(channels) {
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
