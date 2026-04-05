use std::collections::HashMap;

/// BUG-A034 FIX: Moved static out of closure for explicit reset capability.
pub static PLUGIN_MISS_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

pub fn reset_track_pass_counters() {
    PLUGIN_MISS_COUNT.store(0, std::sync::atomic::Ordering::Relaxed);
}
use uuid::Uuid;

use dream_clip_engine::midi_scheduler::ScheduledNote;
use dream_dsp::device_slot::ProcessContext;
use dream_plugins::{MidiEvent, TransportContext};
use crate::driver::PluginInstanceArc;
use crate::driver::LoopRegion;

use crate::driver::{
    automation::{
        apply_external_plugin_param_automation_block,
        apply_track_mixer_automation_sample_accurate,
    },
    midi_dispatcher::PluginNoteTracker,
};
use crate::frame_domain::FrameDomainConverter;
use crate::render_callback::TrackSlot;
use crate::driver::{ExternalPluginRuntimeSlot, MidiTrackRuntime, TrackAutomationState};

use crate::driver::executor::audio_thread_process::process_midi_events;

pub(crate) struct TrackPassContext<'a> {
    pub c: usize,
    pub track_idx: usize,
    pub post_sum_processed: bool,
    pub slot: &'a mut TrackSlot,
    pub left_tracks: &'a [TrackSlot],
    pub right_tracks: &'a [TrackSlot],
    pub external_fx_map: &'a [Vec<ExternalPluginRuntimeSlot>],
    pub automation: &'a [TrackAutomationState],
    pub playhead_pos: i64,
    pub sample_rate_f64: f64,
    pub process_ctx: &'a ProcessContext,
    pub plugin_registry_ref: &'a HashMap<Uuid, PluginInstanceArc>,
    pub external_left: &'a mut [f32],
    pub external_right: &'a mut [f32],
    pub midi_snap: &'a [MidiTrackRuntime],
    pub midi_playhead_pos: i64,
    pub timeline_frame_count: usize,
    pub frame_converter: &'a FrameDomainConverter,
    pub vst3_midi_scratch: &'a mut Vec<MidiEvent>,
    pub plugin_rt_midi_queue: &'a mut [Vec<MidiEvent>],
    pub vst3_flush_per_track: &'a [bool],
    pub vst3_note_trackers: &'a mut [PluginNoteTracker],
    pub midi_schedule_scratch: &'a mut Vec<ScheduledNote>,
    pub midi_schedule_tmp: &'a mut Vec<ScheduledNote>,
    pub is_playing: bool,
    pub bpm: f64,
    pub time_sig_numerator: u8,
    pub time_sig_denominator: u8,
    pub timeline_sample_rate: f64,
    pub loop_region: Option<LoopRegion>,
    /// EXPORT-DISTORTION-FIX: When true, skip ALL external VST plugin
    /// try_lock() calls on the RT thread. The offline renderer holds
    /// exclusive access to plugins during export — contention here
    /// caused interleaved process() calls that corrupted plugin DSP
    /// state, producing crackling/distortion in the exported audio.
    pub export_active: bool,
    /// PERF-010: When false, skip sidechain tap buffer copies.
    /// Most tracks have no sidechain consumers — saving 4 × copy_from_slice(c)
    /// per unused track (2 pre-FX + 2 post-FX).
    pub has_sidechain_consumers: bool,
}

pub(crate) fn process_track_graph_node(
    left: &mut [f32],
    right: &mut [f32],
    ctx: &mut TrackPassContext,
    sidechain_resolver: &(impl Fn(usize) -> Option<(*const f32, *const f32)> + ?Sized)
) {
    let c = ctx.c;
    // 1. Unify Working Buffer
    if ctx.post_sum_processed {
        for i in 0..c {
            left[i] += ctx.slot.buf_left[i];
            right[i] += ctx.slot.buf_right[i];
        }
    } else {
        left[..c].copy_from_slice(&ctx.slot.buf_left[..c]);
        right[..c].copy_from_slice(&ctx.slot.buf_right[..c]);
    }

    // ── SIDECHAIN TAP: Pre-FX snapshot ──
    // Capture the raw signal (after clip read / bus summing, before FX chain)
    // so other tracks requesting Pre-FX sidechain can read it.
    // PERF-010: Only copy when at least one track consumes this sidechain.
    if ctx.has_sidechain_consumers {
        ctx.slot.sidechain_pre_fx_left[..c].copy_from_slice(&left[..c]);
        ctx.slot.sidechain_pre_fx_right[..c].copy_from_slice(&right[..c]);
    }

    // 2. Process Inserts (Native FX + VSTs in chain order)
    if let Some(runtime_slots) = ctx.external_fx_map.get(ctx.track_idx) {
        if runtime_slots.is_empty() {
            if !ctx.slot.device_chain.is_empty() {
                ctx.slot.device_chain.process_with_context(
                    &mut left[..c],
                    &mut right[..c],
                    ctx.process_ctx,
                );
            }
        } else {
            let has_external = runtime_slots.iter().any(|s| s.instance_id.is_some());
            let has_internal_sidechain = runtime_slots.iter().any(|s| {
                s.internal_slot_index.is_some() && s.sidechain_track_index.is_some()
            });

            let chain_len = ctx.slot.device_chain.len();
            let indices_valid = runtime_slots.iter().all(|s| {
                s.internal_slot_index.is_none_or(|idx| idx < chain_len)
            });
            // BUG-CHAIN-001 FIX: Only fall back to whole-chain when there are
            // NO external plugins AND NO internal sidechains AND indices are valid.
            // Previously, !indices_valid caused fallback to whole-chain which
            // silently dropped ALL external VST/AU plugins from the processing chain.
            // Now: when external plugins exist, we always iterate per-slot so VSTs
            // are never skipped. Invalid internal indices are individually guarded.
            if !has_external && !has_internal_sidechain && indices_valid {
                if !ctx.slot.device_chain.is_empty() {
                    ctx.slot.device_chain.process_with_context(
                        &mut left[..c],
                        &mut right[..c],
                        ctx.process_ctx,
                    );
                }
            } else {
                for (runtime_slot_idx, runtime_slot) in runtime_slots.iter().enumerate() {
                    // ENTERPRISE-BYPASS-FIX: Only skip external bypassed plugins here.
                    // Internal slots handle bypass via smooth 5ms IIR crossfade ramp
                    // inside InternalDeviceSlot::process(). Skipping them entirely
                    // causes audible clicks because the ramp never runs — the signal
                    // jumps discontinuously from wet→dry. External plugins don't have
                    // this ramp, so they need explicit skip.
                    if runtime_slot.is_bypassed && runtime_slot.internal_slot_index.is_none() {
                        continue;
                    }
                    // SC-001 FIX: Sidechain source resolution strategy:
                    //
                    // 1. Try the graph renderer's sidechain_resolver FIRST.
                    //    It returns PDC-compensated buffers via EdgeDelayRuntime
                    //    scratch buffers. This ensures sidechain triggers are
                    //    time-aligned even when the source track has high-latency
                    //    plugins (e.g., 512-sample reverb on a kick track).
                    //
                    // 2. Fall back to direct tap buffer reads ONLY when the
                    //    resolver returns None (no PDC edge exists for this
                    //    source→consumer pair).
                    //
                    // DAG NodeId mapping: track_idx K → NodeId(K+1) → NodeIndex(K+1).
                    let safe_source_ptrs = runtime_slot
                        .sidechain_track_index
                        .and_then(|src_idx| {
                            // SC-001: Try PDC-compensated resolver first.
                            // DAG NodeId = track_idx + 1 (master is 0).
                            let src_node_idx = src_idx + 1;
                            if let Some((pdc_l, pdc_r)) = sidechain_resolver(src_node_idx) {
                                // SAFETY: pointers come from GraphRenderer's
                                // EdgeDelayRuntime scratch buffers which are
                                // valid for the duration of this render() call.
                                let sl = unsafe { std::slice::from_raw_parts(pdc_l, c) };
                                let sr = unsafe { std::slice::from_raw_parts(pdc_r, c) };
                                return Some((sl, sr));
                            }

                            // Fallback: direct tap buffer reads (no PDC).
                            let mode = runtime_slot.sidechain_send_mode;
                            match mode {
                                // Pre-FX: read from source's pre-FX tap buffer
                                0 => {
                                    if src_idx < ctx.track_idx {
                                        let target_slot = &ctx.left_tracks[src_idx];
                                        Some((&target_slot.sidechain_pre_fx_left[..c], &target_slot.sidechain_pre_fx_right[..c]))
                                    } else if src_idx > ctx.track_idx {
                                        let offset_idx = src_idx - ctx.track_idx - 1;
                                        if offset_idx < ctx.right_tracks.len() {
                                            let target_slot = &ctx.right_tracks[offset_idx];
                                            Some((&target_slot.sidechain_pre_fx_left[..c], &target_slot.sidechain_pre_fx_right[..c]))
                                        } else { None }
                                    } else { None }
                                }
                                // Post-FX: read from source's post-FX tap buffer
                                1 => {
                                    if src_idx < ctx.track_idx {
                                        let target_slot = &ctx.left_tracks[src_idx];
                                        Some((&target_slot.sidechain_post_fx_left[..c], &target_slot.sidechain_post_fx_right[..c]))
                                    } else if src_idx > ctx.track_idx {
                                        let offset_idx = src_idx - ctx.track_idx - 1;
                                        if offset_idx < ctx.right_tracks.len() {
                                            let target_slot = &ctx.right_tracks[offset_idx];
                                            Some((&target_slot.sidechain_post_fx_left[..c], &target_slot.sidechain_post_fx_right[..c]))
                                        } else { None }
                                    } else { None }
                                }
                                // Post-Mixer (default): read from source's buf_left/buf_right
                                // which contains the post-strip (volume/pan) signal.
                                _ => {
                                    if src_idx < ctx.track_idx {
                                        let target_slot = &ctx.left_tracks[src_idx];
                                        Some((&target_slot.buf_left[..c], &target_slot.buf_right[..c]))
                                    } else if src_idx > ctx.track_idx {
                                        let offset_idx = src_idx - ctx.track_idx - 1;
                                        if offset_idx < ctx.right_tracks.len() {
                                            let target_slot = &ctx.right_tracks[offset_idx];
                                            Some((&target_slot.buf_left[..c], &target_slot.buf_right[..c]))
                                        } else { None }
                                    } else { None }
                                }
                            }
                        });
                    
                    let (sc_l, sc_r) = if let Some((sl, sr)) = safe_source_ptrs {
                        (Some(sl), Some(sr))
                    } else {
                        (None, None)
                    };

                    if let Some(internal_idx) = runtime_slot.internal_slot_index {
                        ctx.slot.device_chain.process_slot_with_sidechain_ctx(
                            internal_idx,
                            &mut left[..c],
                            &mut right[..c],
                            sc_l,
                            sc_r,
                            ctx.process_ctx,
                        );
                        continue;
                    }

                    if let Some(instance_id) = runtime_slot.instance_id {
                        let Some(plugin_mtx) = ctx.plugin_registry_ref.get(&instance_id) else {
                            PLUGIN_MISS_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            continue;
                        };

                        ctx.external_left[..c].copy_from_slice(&left[..c]);
                        ctx.external_right[..c].copy_from_slice(&right[..c]);

                        // EXPORT-DISTORTION-FIX: Skip VST processing entirely
                        // when offline export is active. The offline renderer
                        // holds exclusive plugin access — any RT try_lock()
                        // success would feed the plugin a different playhead/
                        // buffer, corrupting its internal state and producing
                        // distorted audio in the export file.
                        if ctx.export_active {
                            // Dry passthrough: external_left/right already
                            // contain the input signal from copy above.
                            left[..c].copy_from_slice(&ctx.external_left[..c]);
                            right[..c].copy_from_slice(&ctx.external_right[..c]);
                            continue;
                        }

                        if let Some(mut host) = plugin_mtx.try_lock() {
                            apply_external_plugin_param_automation_block(
                                &mut host,
                                ctx.automation.get(ctx.track_idx),
                                runtime_slot,
                                runtime_slot_idx,
                                ctx.playhead_pos,
                            );
                            let main_inputs: [&[f32]; 2] = [&left[..c], &right[..c]];
                            let sc_pair: Option<[&[f32]; 2]> = safe_source_ptrs.map(|(sl, sr)| [sl, sr]);

                            let device_playhead_pos = if ctx.timeline_sample_rate > 0.0 {
                                (ctx.playhead_pos as f64 / ctx.timeline_sample_rate * ctx.sample_rate_f64).round() as i64
                            } else { ctx.playhead_pos };

                            let device_loop_start = ctx.loop_region.as_ref()
                                .map(|r| if ctx.timeline_sample_rate > 0.0 {
                                    (r.start as f64 / ctx.timeline_sample_rate * ctx.sample_rate_f64).round() as i64
                                } else { r.start }).unwrap_or(0);

                            let device_loop_end = ctx.loop_region.as_ref()
                                .map(|r| if ctx.timeline_sample_rate > 0.0 {
                                    (r.end as f64 / ctx.timeline_sample_rate * ctx.sample_rate_f64).round() as i64
                                } else { r.end }).unwrap_or(0);

                            let transport = TransportContext {
                                sample_rate: ctx.sample_rate_f64,
                                position_samples: device_playhead_pos,
                                tempo: ctx.bpm,
                                is_playing: ctx.is_playing,
                                is_recording: false,
                                time_sig_numerator: i32::from(ctx.time_sig_numerator),
                                time_sig_denominator: i32::from(ctx.time_sig_denominator),
                                cycle_active: ctx.loop_region.is_some(),
                                loop_start_samples: device_loop_start,
                                loop_end_samples: device_loop_end,
                            };
                            host.set_transport_context(transport);

                            ctx.vst3_midi_scratch.clear();
                            if ctx.track_idx < ctx.plugin_rt_midi_queue.len() {
                                ctx.vst3_midi_scratch.append(&mut ctx.plugin_rt_midi_queue[ctx.track_idx]);
                            }
                            if ctx.vst3_flush_per_track.get(ctx.track_idx).copied().unwrap_or(false)
                                && ctx.track_idx < ctx.vst3_note_trackers.len()
                            {
                                ctx.vst3_note_trackers[ctx.track_idx].flush_all(ctx.vst3_midi_scratch);
                            }

                            let mut split_offset_device: Option<usize> = None;

                            if ctx.is_playing
                                && let Some(midi_track) = ctx.midi_snap.get(ctx.track_idx)
                            {
                                let midi_loop_region = ctx.loop_region
                                    .as_ref()
                                    .map(|r| dream_clip_engine::LoopRegion::new(r.start, r.end));
                                ctx.midi_schedule_scratch.clear();
                                dream_clip_engine::midi_scheduler::MidiScheduler::fill_active_looped_with_tmp(
                                    &midi_track.clips,
                                    ctx.midi_playhead_pos,
                                    ctx.timeline_frame_count,
                                    midi_loop_region.as_ref(),
                                    ctx.midi_schedule_scratch,
                                    ctx.midi_schedule_tmp,
                                );
                                let tracker = if ctx.track_idx < ctx.vst3_note_trackers.len() {
                                    Some(&mut ctx.vst3_note_trackers[ctx.track_idx])
                                } else { None };

                                split_offset_device = process_midi_events(
                                    midi_track,
                                    ctx.midi_playhead_pos,
                                    ctx.timeline_frame_count,
                                    midi_loop_region.as_ref(),
                                    ctx.frame_converter,
                                    ctx.midi_schedule_scratch,
                                    ctx.midi_schedule_tmp,
                                    ctx.vst3_midi_scratch,
                                    tracker,
                                );
                            }

                            let mut out_slices: [&mut [f32]; 2] = [
                                &mut ctx.external_left[..c],
                                &mut ctx.external_right[..c],
                            ];

                            if let Some(split_at) = split_offset_device.filter(|&s| s > 0 && s < c) {
                                let split_i32 = split_at as i32;
                                let split_idx = ctx.vst3_midi_scratch.partition_point(|ev| ev.sample_offset < split_i32);

                                let main_before = [&main_inputs[0][..split_at], &main_inputs[1][..split_at]];
                                let main_after = [&main_inputs[0][split_at..], &main_inputs[1][split_at..]];
                                
                                let sc_before = sc_pair.map(|p| [&p[0][..split_at], &p[1][..split_at]]);
                                let sc_after = sc_pair.map(|p| [&p[0][split_at..], &p[1][split_at..]]);

                                let (out_l, out_r) = out_slices.split_at_mut(1);
                                let (out_l_before, out_l_after) = out_l[0].split_at_mut(split_at);
                                let (out_r_before, out_r_after) = out_r[0].split_at_mut(split_at);

                                let mut out_before: [&mut [f32]; 2] = [out_l_before, out_r_before];
                                let mut out_after: [&mut [f32]; 2] = [out_l_after, out_r_after];

                                if host.process_with_sidechain(
                                    &main_before,
                                    sc_before.as_ref().map(|p| p.as_slice()),
                                    &mut out_before,
                                    split_at,
                                    &ctx.vst3_midi_scratch[..split_idx],
                                ).is_err() {
                                    static PROC_ERR_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
                                    PROC_ERR_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                }
                                
                                for ev in &mut ctx.vst3_midi_scratch[split_idx..] {
                                    ev.sample_offset -= split_i32;
                                }

                                if host.process_with_sidechain(
                                    &main_after,
                                    sc_after.as_ref().map(|p| p.as_slice()),
                                    &mut out_after,
                                    c - split_at,
                                    &ctx.vst3_midi_scratch[split_idx..],
                                ).is_err() {
                                    static PROC_ERR_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
                                    PROC_ERR_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                }
                            } else if host.process_with_sidechain(
                                &main_inputs,
                                sc_pair.as_ref().map(|pair| pair.as_slice()),
                                &mut out_slices,
                                c,
                                ctx.vst3_midi_scratch,
                            ).is_err() {
                                static PROC_ERR_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
                                PROC_ERR_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            }
                        } else {
                            static LOCK_MISS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
                            LOCK_MISS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            // HOLD-LAST-OUTPUT FIX: On lock miss, replay the last
                            // successfully processed VST output from slot.ext_left/right
                            // instead of outputting silence. This prevents audio dropouts
                            // when the UI thread holds the plugin mutex during GUI redraws.
                            // This is the standard technique used by Ableton Live, Logic
                            // Pro, and Pro Tools for handling plugin lock contention.
                            let hold_n = c.min(ctx.slot.vst_hold_left.len()).min(ctx.slot.vst_hold_right.len());
                            left[..hold_n].copy_from_slice(&ctx.slot.vst_hold_left[..hold_n]);
                            right[..hold_n].copy_from_slice(&ctx.slot.vst_hold_right[..hold_n]);
                            continue;
                        }

                        left[..c].copy_from_slice(&ctx.external_left[..c]);
                        right[..c].copy_from_slice(&ctx.external_right[..c]);

                        for si in 0..c {
                            if !left[si].is_finite() { left[si] = 0.0; }
                            if !right[si].is_finite() { right[si] = 0.0; }
                        }

                        // HOLD-LAST-OUTPUT FIX: Cache the post-VST output so that
                        // on the next lock miss, we replay this valid output instead
                        // of silence. This eliminates audio dropouts caused by
                        // try_lock() contention when the plugin GUI is open.
                        let hold_n = c.min(ctx.slot.vst_hold_left.len()).min(ctx.slot.vst_hold_right.len());
                        ctx.slot.vst_hold_left[..hold_n].copy_from_slice(&left[..hold_n]);
                        ctx.slot.vst_hold_right[..hold_n].copy_from_slice(&right[..hold_n]);
                    }
                }
            }
        }
    } else if !ctx.slot.device_chain.is_empty() {
        ctx.slot.device_chain.process_with_context(
            &mut left[..c],
            &mut right[..c],
            ctx.process_ctx,
        );
    }

    // ── SIDECHAIN TAP: Post-FX snapshot ──
    // Capture the signal after all FX processing but before the mixer strip
    // (volume/pan/mute). Other tracks requesting Post-FX sidechain read this.
    // PERF-010: Only copy when this track has sidechain consumers.
    if ctx.has_sidechain_consumers {
        ctx.slot.sidechain_post_fx_left[..c].copy_from_slice(&left[..c]);
        ctx.slot.sidechain_post_fx_right[..c].copy_from_slice(&right[..c]);
    }

    // 3. Process Mixer Strip
    if ctx.slot.strip.is_output_enabled() {
        ctx.slot.strip.process_stereo(&mut left[..c], &mut right[..c]);
    } else {
        left[..c].fill(0.0);
        right[..c].fill(0.0);
    }

    if let Some(lane) = ctx.automation.get(ctx.track_idx) {
        apply_track_mixer_automation_sample_accurate(
            &mut left[..c],
            &mut right[..c],
            ctx.playhead_pos,
            (!lane.volume.is_empty()).then_some(lane.volume.as_slice()),
            (!lane.pan.is_empty()).then_some(lane.pan.as_slice()),
        );
    }

    // SSOT-FIX: Publish post-insert/post-strip track output
    ctx.slot.buf_left[..c].copy_from_slice(&left[..c]);
    ctx.slot.buf_right[..c].copy_from_slice(&right[..c]);
}
