use super::super::*;
use super::SharedRtDebugStats;
use cpal::traits::{DeviceTrait, StreamTrait};
use log::{error, info};
use std::time::Instant;

use super::audio_thread_commands::{CommandDrainContext, drain_commands};
use super::audio_thread_sampler_pass::render_sampler_sources;
use super::command_dispatch::DeferredTopologyCmd;
use super::render_pipeline::{
    finalize_output_and_publish, interleave_graph_output, mix_preview_audio,
    process_master_runtime_fx_and_gain, render_test_tone_if_needed, sync_sample_rack_engines,
    sync_sampler_engines,
};

use crate::driver::automation::{
    apply_external_plugin_param_automation_block, apply_track_mixer_automation_sample_accurate,
};
use crate::driver::midi_dispatcher::{Vst3NoteTracker, clamp_midi_pitch, quantize_to_scale};
use dream_clip_engine::midi_scheduler::{MidiScheduler, ScheduledNote};
use dream_graph::GraphRenderer;
use dream_ipc::metering::{METER_FLOOR_DB, compute_peak, compute_rms};
use dream_plugins::TransportContext;

/// Safe test tone amplitude: -10 dBFS to avoid clipping during development.
const TEST_TONE_AMPLITUDE: f32 = 0.316_227_76;

#[allow(clippy::too_many_arguments)]
pub(crate) fn start_audio_thread_on_device_impl(
    mut consumer: rtrb::Consumer<EngineCommand>,
    clock: Arc<MasterClock>,
    meter_bank: Arc<MeterBank>,
    clip_pool: Arc<ArcSwap<ClipPool>>,
    clip_snapshot: Arc<SharedClipSnapshot>,
    midi_snapshot: Arc<SharedMidiSnapshot>,
    routing_snapshot: Arc<SharedRoutingSnapshot>,
    sidechain_snapshot: Arc<SharedSidechainSnapshot>,
    external_fx_snapshot: Arc<SharedExternalFxSnapshot>,
    automation_snapshot: Arc<SharedAutomationSnapshot>,
    sampler_samples: Arc<SharedSamplerSamples>,
    sample_rack_samples: Arc<SharedSampleRackSamples>,
    prepared_graph_snapshot: Arc<SharedPreparedGraphSnapshot>,
    rt_debug_stats: Arc<SharedRtDebugStats>,
    plugin_registry: Arc<SharedPluginRegistry>,
    preview_buffer: Arc<ArcSwap<Option<Vec<f32>>>>,
    preview_cursor: Arc<AtomicUsize>,
    preview_source_sr: Arc<AtomicU32>,
    disk_streamers: Arc<SharedDiskStreamers>,
    preferred_output_device: Option<&str>,
    stream_error_tx: Option<std::sync::mpsc::SyncSender<String>>,
) -> Result<AudioStreamHandle, AudioDriverError> {
    let output_setup = resolve_output_setup(preferred_output_device)?;
    let device = output_setup.device;
    let device_name = output_setup.device_name;
    let sample_format = output_setup.sample_format;
    let sample_rate = output_setup.sample_rate;
    let channels = output_setup.channels;
    let config = output_setup.config;

    // ── 3. Build RenderContext ──────────────────────────────────────
    // cpal 0.17: sample_rate() returns u32 directly
    let sample_rate_f64 = config.sample_rate as f64;
    let mut render_ctx = RenderContext::new(
        MAX_TRACKS,
        sample_rate_f64,
        channels,
        Arc::clone(&meter_bank),
    );

    // ── Spectrum analyzer ring buffer (lock-free: audio thread → UI thread) ──
    let (spectrum_producer, spectrum_consumer) = rtrb::RingBuffer::new(8192);
    render_ctx.spectrum_producer = Some(spectrum_producer);

    // AUD-057/058 FIX: Use named constants instead of hardcoded magic numbers.
    let mut graph_renderer = GraphRenderer::new(MAX_TRACKS, MAX_BUFFER_FRAMES);
    let prepared_graph = prepared_graph_snapshot.load();
    // AUD-016: graph_dag/plan clone() allocates inside the closure that builds
    // the callback — this is OK because it happens BEFORE the first callback
    // fires. Inside the callback, clones only happen on generation change.
    let mut graph_dag = prepared_graph.dag.clone();
    let mut graph_plan = prepared_graph.plan.clone();
    let mut graph_out_left = vec![0.0f32; MAX_BUFFER_FRAMES];
    let mut graph_out_right = vec![0.0f32; MAX_BUFFER_FRAMES];
    let mut post_sum_processing_mask = vec![false; MAX_TRACKS];
    graph_renderer.update_plan(&graph_plan, &graph_dag);
    let mut graph_last_generation = prepared_graph.generation;
    let mut graph_last_track_count = prepared_graph.track_count;

    // ── 4. Test tone state (fallback when no clips loaded) ──────────
    let mut test_tone_phase: f64 = 0.0;
    let mut test_tone_current_freq: f32 = DEFAULT_FREQUENCY;
    let mut test_tone_target_freq: f32 = DEFAULT_FREQUENCY;
    let mut test_tone_enabled: bool = false;

    // ── 5. Playback state ───────────────────────────────────────────
    let mut is_playing: bool = false;
    // BUG-035 FIX: Removed misleading underscore — BPM IS used in TransportContext.
    let mut bpm: f64 = 120.0;
    let mut time_sig_numerator: u8 = 4;
    let mut time_sig_denominator: u8 = 4;
    let mut master_gain_target: f32 = 1.0;
    let mut master_gain_current: f32 = 1.0;
    // AUD-035/036 FIX: Documented master gain system.
    // master_gain_target: set by EngineCommand::SetMasterGain, clamped [0.0, 2.0].
    // master_gain_current: exponentially smoothed toward target each frame.
    // master_gain_smooth: one-pole coefficient for ~5ms time constant.
    //   Formula: 1.0 - exp(-1/(tau * sr)) where tau = 5ms.
    //   At 44.1kHz: ~0.00455, at 96kHz: ~0.00208.
    let master_gain_smooth: f32 = 1.0 - (-1.0_f64 / (0.005 * sample_rate_f64)).exp() as f32;
    // MASTER DEVICE CHAIN: Internal FX on the master bus (EQ, compressor, etc.).
    // Historically this path was bypassed; now it is active in the master FX stage.
    let mut master_device_chain = DeviceChain::new(sample_rate_f64 as f32);
    // per-track disable/solo state (used for output-enable calculation)
    let mut track_disabled: [bool; MAX_TRACKS] = [false; MAX_TRACKS];
    let mut track_soloed: [bool; MAX_TRACKS] = [false; MAX_TRACKS];
    let mut any_solo: bool = false;
    // BUG-026 FIX: Persist the last loop region so SetLoopEnabled(true) can restore it.
    let mut last_loop_region: Option<LoopRegion> = None;

    // ── 6. Per-track sampler engines ─────────────────────────────────
    // Pre-allocated sampler engines (one per track max).
    // Each engine starts with no sample loaded — it becomes active
    // when the user assigns a sample via SharedSamplerSamples.
    let mut sampler_engines: Vec<SamplerEngine> = (0..MAX_TRACKS)
        .map(|_| SamplerEngine::new(sample_rate_f64))
        .collect();
    let mut sample_rack_engines: Vec<SampleRackEngine> = (0..MAX_TRACKS)
        .map(|_| SampleRackEngine::new(sample_rate_f64))
        .collect();
    let mut midi_note_states: Vec<MidiNoteMapState> = vec![MidiNoteMapState::default(); MAX_TRACKS];
    // Scratch buffers for sampler output (reused each buffer, zero-alloc)
    let mut external_left = vec![0.0f32; MAX_BUFFER_FRAMES];
    let mut external_right = vec![0.0f32; MAX_BUFFER_FRAMES];
    let mut deferred_topology: VecDeque<DeferredTopologyCmd> = VecDeque::with_capacity(1024);
    let mut midi_schedule_scratch: Vec<ScheduledNote> = Vec::with_capacity(2048);
    let mut midi_schedule_tmp: Vec<ScheduledNote> = Vec::with_capacity(2048);
    // Pre-allocated scratch buffer for converting scheduled MIDI events to MidiEvent
    // objects that external VST3 plugins receive.
    let mut vst3_midi_scratch: Vec<MidiEvent> = Vec::with_capacity(4096);
    // Per-track active-note tracking for VST3 plugins (flush on stop/seek).
    let mut vst3_note_trackers: Vec<Vst3NoteTracker> = vec![Vst3NoteTracker::default(); MAX_TRACKS];
    // BUG-012 FIX: Per-track flush instead of global flag.
    // The previous global flag killed notes on ALL VST3 instruments when only
    // one track needed flushing (e.g. single-track bypass/stop).
    let mut vst3_flush_per_track: [bool; MAX_TRACKS] = [false; MAX_TRACKS];
    // MIDI Chase flag: when true, sustaining notes (is_note_on=false but active)
    // get a synthetic note-on injected at frame 0 so the sampler re-triggers them.
    // Set on Seek/Play — cleared after the first render callback uses it.
    let mut midi_chase_needed = false;
    // Per-track real-time MIDI queue: keyboard/preview NoteOn/Off events
    // are pushed here in the command loop and drained into vst3_midi_scratch
    // during the graph pass so external VST3 instruments (Serum, etc.)
    // receive real-time MIDI alongside clip events.
    let mut vst3_rt_midi_queue: Vec<Vec<MidiEvent>> =
        (0..MAX_TRACKS).map(|_| Vec::with_capacity(32)).collect();
    let mut rt_midi_uid_counter: u64 = 1;
    // Track which samples were last loaded per-track to avoid re-assigning
    // BUG-068 FIX: Removed dead variable _last_sample_generation (was never read).

    let stream = device
        .build_output_stream(
            &config,
            // RT_CALLBACK_START
            // ┌──────────────────────────────────────────────────────┐
            // │  THE HOT PATH — Real-Time Audio Callback             │
            // │  NO allocations. NO locks (except Arc::clone which   │
            // │  is atomic). NO I/O. NO panics.                      │
            // └──────────────────────────────────────────────────────┘
            move |data: &mut [f32], _info: &cpal::OutputCallbackInfo| {
                let mut run_callback = || {
                        // BUG-050 FIX: Only call Instant::now() when debug stats
                        // are active. mach_absolute_time() is a ~20ns syscall
                        // that's unnecessary overhead in production builds.
                        let callback_start = if rt_debug_stats.is_enabled() {
                            Some(Instant::now())
                        } else {
                            None
                        };
                        // ═══════════════════════════════════════════════════════════════
                        // RT-Armor: Zero-Alloc, Panic-Safe, Denormal-Free Audio Pipeline
                        // ═══════════════════════════════════════════════════════════════

                        // ── A0. Denormal Protection (DAZ/FTZ) ────────────────────────
                        // MEGA-03 FIX: Save original hardware FPU state so we can restore it.
                        // Mutating the OS audio thread's FPU state permanently breaks IEEE-754
                        // for the entire host process (logic pro, bitwig, ableton, etc.)
                        #[cfg(target_arch = "x86_64")]
                        let original_csr = unsafe {
                            use std::arch::x86_64::*;
                            let csr = _mm_getcsr();
                            _mm_setcsr(csr | 0x8040); // DAZ + FTZ bits
                            csr
                        };

                        #[cfg(target_arch = "aarch64")]
                        let original_fpcr = unsafe {
                            let mut fpcr: u64;
                            std::arch::asm!("mrs {}, fpcr", out(reg) fpcr);
                            let orig = fpcr;
                            fpcr |= 1 << 24; // FZ bit
                            std::arch::asm!("msr fpcr, {}", in(reg) fpcr);
                            orig
                        };

                        let frame_count = data.len() / channels.max(1);

                        // Baseline all track meters to silence each callback, with
                        // peak-decay persistence. Active signal paths below will lift
                        // meters back up for tracks that actually output audio.
                        let baseline_decay = peak_decay_for_block(sample_rate_f64, frame_count);
                        for track_idx in 0..render_ctx.meter_bank.track_count() {
                            if let Some((meter_l, meter_r)) = render_ctx.meter_bank.track(track_idx) {
                                meter_l.store_rms(METER_FLOOR_DB);
                                meter_r.store_rms(METER_FLOOR_DB);
                                meter_l.store_peak_decay(METER_FLOOR_DB, baseline_decay);
                                meter_r.store_peak_decay(METER_FLOOR_DB, baseline_decay);
                            }
                        }
                        // ── A1. Drain command queue (bounded) ─────────────────────
                        // Bound per-callback command work so UI command bursts
                        // cannot starve audio rendering and cause dropouts.
                        // BUG-040 FIX: Adaptive command budget based on frame_count.
                        // At 128 frames (2.7ms), original 512 commands could use 18%
                        // of the budget. Now scales: min 64, max 512.
                        let commands_processed = drain_commands(
                            &mut consumer,
                            frame_count,
                            &mut CommandDrainContext {
                                clock: &clock,
                                render_ctx: &mut render_ctx,
                                sampler_engines: &mut sampler_engines,
                                sample_rack_engines: &mut sample_rack_engines,
                                midi_note_states: &mut midi_note_states,
                                vst3_flush_per_track: &mut vst3_flush_per_track,
                                vst3_rt_midi_queue: &mut vst3_rt_midi_queue,
                                is_playing: &mut is_playing,
                                bpm: &mut bpm,
                                time_sig_numerator: &mut time_sig_numerator,
                                time_sig_denominator: &mut time_sig_denominator,
                                master_gain_target: &mut master_gain_target,
                                track_disabled: &mut track_disabled,
                                track_soloed: &mut track_soloed,
                                any_solo: &mut any_solo,
                                last_loop_region: &mut last_loop_region,
                                test_tone_phase: &mut test_tone_phase,
                                test_tone_enabled: &mut test_tone_enabled,
                                test_tone_target_freq: &mut test_tone_target_freq,
                                midi_chase_needed: &mut midi_chase_needed,
                                deferred_topology: &mut deferred_topology,
                                master_device_chain: &mut master_device_chain,
                                routing_snapshot: &routing_snapshot,
                                rt_debug_stats: rt_debug_stats.as_ref(),
                            },
                        );

                        // ── B-1. Prepare track strips for mixer automation ──────────────
                        // If a track has volume/pan automation lanes, we neutralize the
                        // strip mixer controls here and apply absolute sample-accurate
                        // mixer automation later on graph output buffers.
                        let automation = automation_snapshot.load();
                        let _sidechain_map = sidechain_snapshot.load();
                        let external_fx_map = external_fx_snapshot.load();
                        // PERF-FIX: Lock-free plugin processing!
                        // The UI thread now periodically publishes an `Arc<HashMap>` of
                        // all active plugins into an `ArcSwap`. The audio thread loads this
                        // snapshot in ~nanoseconds without ever blocking or spinning.
                        // Priority inversions and 1-buffer dropout clicks are eliminated.
                        let plugin_registry_guard = plugin_registry.load();
                        let plugin_registry_ref = &*plugin_registry_guard;
                        let playhead_pos = render_ctx.playhead.position();
                        for (track_idx, lane) in automation.iter().enumerate() {
                            if track_idx >= render_ctx.track_slots.len() {
                                break;
                            }
                            if !lane.volume.is_empty() {
                                render_ctx.track_slots[track_idx].strip.set_volume(1.0);
                            }
                            if !lane.pan.is_empty() {
                                render_ctx.track_slots[track_idx].strip.set_pan(0.0);
                            }
                        }

                        // ── B0. Rebuild graph on routing/track topology changes ─────────
                        let snapshot = clip_snapshot.load();
                        let track_count = snapshot.len().min(MAX_TRACKS);
                        let prepared = prepared_graph_snapshot.load();
                        if prepared.generation != graph_last_generation
                            || prepared.track_count != graph_last_track_count
                        {
                            graph_dag = prepared.dag.clone();
                            graph_plan = prepared.plan.clone();
                            graph_renderer.update_plan(&graph_plan, &graph_dag);
                            graph_last_generation = prepared.generation;
                            graph_last_track_count = prepared.track_count;
                        }

                        // Tracks that receive routed input should apply strip/device
                        // processing after graph summing (bus/group semantics).
                        post_sum_processing_mask[..track_count].fill(false);
                        let routing_now = routing_snapshot.load();
                        for src_idx in 0..track_count {
                            if let Some(Some(dest_idx)) = routing_now.get(src_idx)
                                && *dest_idx < track_count
                            {
                                post_sum_processing_mask[*dest_idx] = true;
                            }
                        }



                        // ── B. Source render pass (Clips & Samplers) ────
                        // Sync loaded samples from shared snapshots once per buffer.
                        sync_sampler_engines(&mut sampler_engines, &sampler_samples);
                        sync_sample_rack_engines(&mut sample_rack_engines, &sample_rack_samples);


                        let midi_snap = midi_snapshot.load();

                        let has_clips = !snapshot.is_empty()
                            && snapshot.iter().any(|track_clips| !track_clips.is_empty());

                        // ▸ Capture pre-advance playhead for MIDI scheduling.
                        let midi_playhead_pos = render_ctx.playhead.position();
                        let mut playhead_advanced_in_render = false;
                        if is_playing && has_clips {
                            // Disable test tone automatically when real clips exist
                            test_tone_enabled = false;

                            // ── A0. Disk Streaming: drain background I/O chunks ──
                            // For files exceeding RAM_THRESHOLD_BYTES (~50 MB), a
                            // background DiskIO thread reads audio ahead of the
                            // playhead and fills an rtrb ring buffer. We drain
                            // pending chunks into the RenderContext's streaming
                            // windows here (try_lock = non-blocking, RT-safe).
                            disk_streamers.drain_all_into(
                                &mut render_ctx.streaming_windows,
                                midi_playhead_pos,
                            );

                            let pool_snap = clip_pool.load();

                            let render_frames = frame_count
                                .min(graph_out_left.len())
                                .min(graph_out_right.len());

                            render_ctx.read_audio_clips_into_tracks(
                                render_frames,
                                snapshot.as_ref(),
                                &pool_snap,
                            );
                            render_ctx.advance_playhead_by_frames(render_frames);
                            playhead_advanced_in_render = true;
                        } else {
                            // AUD-017 FIX: When stopped or no clips, only clear tracks
                            // that are actually in use. Previously cleared ALL 256 slots.
                            for slot in render_ctx.track_slots[..track_count].iter_mut() {
                                slot.clear(frame_count);
                            }
                        }

                        // ── B1. Sampler Render Pass (Source Generation) ──
                        // This renders internal samplers directly into slot buffers.
                        // This happens BEFORE the FX graph, so FX apply to sampler voices.
                        render_sampler_sources(
                            track_count,
                            midi_snap.as_ref(),
                            &mut render_ctx,
                            &mut sampler_engines,
                            &mut sample_rack_engines,
                            &mut midi_note_states,
                            &mut vst3_rt_midi_queue,
                            &mut rt_midi_uid_counter,
                            midi_chase_needed,
                            is_playing,
                            midi_playhead_pos,
                            frame_count,
                        );

                        // Graph pass: route pre-rendered tracks through DAG.
                        // This UNIFIED block handles both playing (clips) and stopped (tails/real-time MIDI) states.
                        // MIDI-CHASE: Clear the chase flag after all tracks have been processed.
                        // It only needs to be active for the first buffer after a seek.
                        midi_chase_needed = false;
                        let n = frame_count;
                        graph_out_left[..n].fill(0.0);
                        graph_out_right[..n].fill(0.0);

                        // AE-013 FIX: Cache peak_decay_for_block ONCE before the graph
                        // closure. Previously called per-track inside the closure —
                        // exp() is ~5ns × 256 tracks = 1.3μs wasted per buffer.
                        let graph_peak_decay = peak_decay_for_block(sample_rate_f64, n);

                        graph_renderer.render(
                            &graph_plan,
                            &graph_dag,
                            n,
                            &mut graph_out_left[..n],
                            &mut graph_out_right[..n],
                            |node, left, right, count| {
                                // AUD-077 FIX: Named constant for master output node ID.
                                const MASTER_OUTPUT_ID: u64 = 0;
                                if node.id.0 == MASTER_OUTPUT_ID {
                                    return;
                                }
                                let track_idx = (node.id.0 - 1) as usize;
                                if track_idx < render_ctx.track_slots.len() {
                                    let (left_tracks, right_tracks) =
                                        render_ctx.track_slots.split_at_mut(track_idx);
                                    let Some((slot, right_tracks_rest)) =
                                        right_tracks.split_first_mut()
                                    else {
                                        return;
                                    };
                                    let c = count
                                        .min(slot.buf_left.len())
                                        .min(slot.buf_right.len());

                                    let post_sum_processed = post_sum_processing_mask
                                        .get(track_idx)
                                        .copied()
                                        .unwrap_or(false);

                                    // 1. Unify Working Buffer
                                    // GraphRenderer clears `left/right` before calling track_processor.
                                    // For group/bus tracks (post_sum_processed), upstream routed audio
                                    // is already present in `left/right`, so we MIX in the track's own
                                    // source buffer (if it has local clips/instrument output).
                                    // For source tracks, we copy their source buffer directly.
                                    if post_sum_processed {
                                        for i in 0..c {
                                            left[i] += slot.buf_left[i];
                                            right[i] += slot.buf_right[i];
                                        }
                                    } else {
                                        left[..c].copy_from_slice(&slot.buf_left[..c]);
                                        right[..c].copy_from_slice(&slot.buf_right[..c]);
                                    }

                                    // 2. Process Inserts (Native FX + VSTs in chain order)
                                    // All inserts now operate in-place on the graph's `left/right` buffer.
                                    if let Some(runtime_slots) = external_fx_map.get(track_idx) {
                                        if runtime_slots.is_empty() {
                                            if !slot.device_chain.is_empty() {
                                                slot.device_chain.process_stereo(
                                                    &mut left[..c],
                                                    &mut right[..c],
                                                    sample_rate_f64 as f32,
                                                );
                                            }
                                        } else {
                                            for (runtime_slot_idx, runtime_slot) in runtime_slots.iter().enumerate() {
                                                let source_slot = runtime_slot
                                                    .sidechain_track_index
                                                    .and_then(|src_idx| {
                                                        if src_idx < track_idx {
                                                            left_tracks.get(src_idx)
                                                        } else if src_idx == track_idx {
                                                            None
                                                        } else {
                                                            right_tracks_rest.get(src_idx - track_idx - 1)
                                                        }
                                                    });
                                                let (sc_l, sc_r) = source_slot
                                                    .map(|src_slot| {
                                                        (
                                                            Some(&src_slot.buf_left[..c]),
                                                            Some(&src_slot.buf_right[..c]),
                                                        )
                                                    })
                                                    .unwrap_or((None, None));

                                                if let Some(internal_idx) = runtime_slot.internal_slot_index {
                                                    slot.device_chain.process_slot_with_sidechain(
                                                        internal_idx,
                                                        &mut left[..c],
                                                        &mut right[..c],
                                                        sc_l,
                                                        sc_r,
                                                        sample_rate_f64 as f32,
                                                    );
                                                    continue;
                                                }

                                                if let Some(instance_id) = runtime_slot.instance_id
                                                    && let Some(plugin_mtx) = plugin_registry_ref.get(&instance_id)
                                                    && let Some(mut host) = plugin_mtx.try_lock()
                                                {
                                                    apply_external_plugin_param_automation_block(
                                                        &mut host,
                                                        automation.get(track_idx),
                                                        runtime_slot,
                                                        runtime_slot_idx,
                                                        playhead_pos,
                                                    );
                                                    external_left[..c].copy_from_slice(&left[..c]);
                                                    external_right[..c].copy_from_slice(&right[..c]);
                                                    let main_inputs: [&[f32]; 2] = [&left[..c], &right[..c]];
                                                    let sc_pair = source_slot.map(|src| {
                                                        [&src.buf_left[..c], &src.buf_right[..c]]
                                                    });

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

                                                    vst3_midi_scratch.clear();
                                                    if track_idx < vst3_rt_midi_queue.len() {
                                                        vst3_midi_scratch.append(&mut vst3_rt_midi_queue[track_idx]);
                                                    }
                                                    if vst3_flush_per_track.get(track_idx).copied().unwrap_or(false)
                                                        && track_idx < vst3_note_trackers.len()
                                                    {
                                                        vst3_note_trackers[track_idx].flush_all(&mut vst3_midi_scratch);
                                                    }

                                                    if is_playing
                                                        && let Some(midi_track) = midi_snap.get(track_idx)
                                                    {
                                                        let fx = &midi_track.fx;
                                                        let midi_loop_region = render_ctx
                                                            .loop_region
                                                            .as_ref()
                                                            .map(|r| dream_clip_engine::LoopRegion::new(r.start, r.end));
                                                        midi_schedule_scratch.clear();
                                                        MidiScheduler::fill_active_looped_with_tmp(
                                                            &midi_track.clips,
                                                            midi_playhead_pos,
                                                            frame_count,
                                                            midi_loop_region.as_ref(),
                                                            &mut midi_schedule_scratch,
                                                            &mut midi_schedule_tmp,
                                                        );
                                                        let mut tracker = if track_idx < vst3_note_trackers.len() {
                                                            Some(&mut vst3_note_trackers[track_idx])
                                                        } else {
                                                            None
                                                        };
                                                        for event in &midi_schedule_scratch {
                                                            let offset_on = event.buffer_onset as i32;
                                                            let offset_off = event.buffer_offset_end as i32;

                                                            if event.is_note_off {
                                                                let mut off_pitch_i16 = event.pitch as i16;
                                                                if fx.pitch_enabled {
                                                                    off_pitch_i16 += fx.pitch_semitones as i16;
                                                                }
                                                                let off_pitch = clamp_midi_pitch(off_pitch_i16);
                                                                let off_pitch = if fx.scale_enabled {
                                                                    quantize_to_scale(off_pitch, fx.scale_root, fx.scale_mask)
                                                                } else {
                                                                    off_pitch
                                                                };
                                                                vst3_midi_scratch.push(MidiEvent::note_off(
                                                                    offset_off,
                                                                    0,
                                                                    off_pitch,
                                                                    0,
                                                                ));
                                                                if let Some(ref mut t) = tracker {
                                                                    t.note_off(off_pitch, 0);
                                                                }
                                                            }

                                                            if event.is_note_on {
                                                                let mut pitch_i16 = event.pitch as i16;
                                                                let mut velocity_i16 = event.velocity as i16;

                                                                if fx.pitch_enabled {
                                                                    pitch_i16 += fx.pitch_semitones as i16;
                                                                }
                                                                let mut mapped_pitch = clamp_midi_pitch(pitch_i16);

                                                                if fx.scale_enabled {
                                                                    mapped_pitch = quantize_to_scale(
                                                                        mapped_pitch,
                                                                        fx.scale_root,
                                                                        fx.scale_mask,
                                                                    );
                                                                }

                                                                if fx.random_enabled
                                                                    && fx.random_semitones != 0
                                                                    && let Some(ref mut t) = tracker
                                                                {
                                                                    let mut x = t.rng_state;
                                                                    x ^= x << 13;
                                                                    x ^= x >> 17;
                                                                    x ^= x << 5;
                                                                    t.rng_state = x;
                                                                    let rnd01 = (x as f32) / (u32::MAX as f32);
                                                                    if rnd01 <= fx.random_chance.clamp(0.0, 1.0) {
                                                                        let span = fx.random_semitones.abs().max(1) as i16;
                                                                        let signed =
                                                                            ((x >> 8) % ((span as u32) * 2 + 1)) as i16 - span;
                                                                        mapped_pitch =
                                                                            clamp_midi_pitch(mapped_pitch as i16 + signed);
                                                                    }
                                                                }

                                                                if fx.velocity_enabled {
                                                                    velocity_i16 = ((velocity_i16 as f32) * fx.velocity_gain)
                                                                        .round() as i16
                                                                        + fx.velocity_offset as i16;
                                                                }
                                                                let mapped_velocity = velocity_i16.clamp(1, 127) as u8;

                                                                if let Some(ref mut t) = tracker {
                                                                    if let Some(dup_off) = t.note_on(mapped_pitch, 0) {
                                                                        vst3_midi_scratch.push(MidiEvent::note_off(
                                                                            offset_on.saturating_sub(1).max(0),
                                                                            0,
                                                                            mapped_pitch,
                                                                            0,
                                                                        ));
                                                                        let _ = dup_off;
                                                                    }
                                                                    if t.can_push() {
                                                                        t.active.push((mapped_pitch, 0));
                                                                    }
                                                                }

                                                                vst3_midi_scratch.push(MidiEvent::note_on(
                                                                    offset_on,
                                                                    0,
                                                                    mapped_pitch,
                                                                    mapped_velocity,
                                                                ));
                                                            }
                                                        }
                                                    }

                                                    vst3_midi_scratch.sort_unstable_by(|a, b| {
                                                        a.sample_offset
                                                            .cmp(&b.sample_offset)
                                                            .then_with(|| a.data[0].cmp(&b.data[0]))
                                                    });

                                                    let mut out_slices: [&mut [f32]; 2] = [
                                                        &mut external_left[..c],
                                                        &mut external_right[..c],
                                                    ];
                                                    let _ = host.process_with_sidechain(
                                                        &main_inputs,
                                                        sc_pair.as_ref().map(|pair| pair.as_slice()),
                                                        &mut out_slices,
                                                        c,
                                                        &vst3_midi_scratch,
                                                    );
                                                    left[..c].copy_from_slice(&external_left[..c]);
                                                    right[..c].copy_from_slice(&external_right[..c]);
                                                }
                                            }
                                        }
                                    } else if !slot.device_chain.is_empty() {
                                        slot.device_chain.process_stereo(
                                            &mut left[..c],
                                            &mut right[..c],
                                            sample_rate_f64 as f32,
                                        );
                                    }
                                    // 3. Process Mixer Strip (Volume, Pan, Mute, Solo output gate)
                                    if slot.strip.is_output_enabled() {
                                        slot.strip.process_stereo(
                                            &mut left[..c],
                                            &mut right[..c],
                                        );
                                    } else {
                                        left[..c].fill(0.0);
                                        right[..c].fill(0.0);
                                    }

                                    if let Some(lane) = automation.get(track_idx) {
                                        apply_track_mixer_automation_sample_accurate(
                                            &mut left[..c],
                                            &mut right[..c],
                                            playhead_pos,
                                            (!lane.volume.is_empty())
                                                .then_some(lane.volume.as_slice()),
                                            (!lane.pan.is_empty())
                                                .then_some(lane.pan.as_slice()),
                                        );
                                    }

                                    // 4. Per-track metering (graph pass)
                                    if let Some((meter_l, meter_r)) =
                                        render_ctx.meter_bank.track(track_idx)
                                    {
                                        let rms_l = linear_to_db(compute_rms(&left[..c]));
                                        let rms_r = linear_to_db(compute_rms(&right[..c]));
                                        let peak_l = linear_to_db(compute_peak(&left[..c]));
                                        let peak_r = linear_to_db(compute_peak(&right[..c]));
                                        meter_l.store_rms(rms_l);
                                        meter_r.store_rms(rms_r);
                                        meter_l.store_peak(peak_l.max(meter_l.load_peak()));
                                        meter_r.store_peak(peak_r.max(meter_r.load_peak()));
                                    }

                                    // SSOT-FIX: Publish post-insert/post-strip track output
                                    // back into slot buffers so downstream sidechain taps
                                    // read the processed signal, not stale pre-FX source data.
                                    slot.buf_left[..c].copy_from_slice(&left[..c]);
                                    slot.buf_right[..c].copy_from_slice(&right[..c]);
                                }
                            },
                            |_node, _left, _right, _count| {},
                        );
                        // BUG-012 FIX: Clear per-track flush flags after processing.
                        // AUD-009 FIX: Only clear flags for tracks that were actually
                        // processed in this graph pass. Tracks beyond track_count
                        // should retain their flush flag until they become active.
                        vst3_flush_per_track[..track_count.min(MAX_TRACKS)].fill(false);

                        process_master_runtime_fx_and_gain(
                            external_fx_map.as_slice(),
                            track_count,
                            &mut master_device_chain,
                            plugin_registry_ref,
                            &mut graph_out_left,
                            &mut graph_out_right,
                            &mut external_left,
                            &mut external_right,
                            n,
                            playhead_pos,
                            sample_rate_f64,
                            bpm,
                            is_playing,
                            time_sig_numerator,
                            time_sig_denominator,
                            master_gain_target,
                            &mut master_gain_current,
                            master_gain_smooth,
                            &mut render_ctx,
                            graph_peak_decay,
                        );
                        interleave_graph_output(
                            &graph_out_left,
                            &graph_out_right,
                            n,
                            channels,
                            data,
                        );

                        render_test_tone_if_needed(
                            test_tone_enabled,
                            is_playing,
                            sample_rate_f64,
                            channels,
                            data,
                            &mut test_tone_current_freq,
                            test_tone_target_freq,
                            &mut test_tone_phase,
                            TEST_TONE_AMPLITUDE,
                        );

                        if is_playing && !playhead_advanced_in_render {
                            render_ctx.advance_playhead_by_frames(frame_count);
                        }
                        mix_preview_audio(
                            &preview_buffer,
                            &preview_cursor,
                            &preview_source_sr,
                            sample_rate,
                            frame_count,
                            channels,
                            data,
                        );
                        finalize_output_and_publish(
                            data,
                            n,
                            channels,
                            &mut render_ctx,
                            sample_rate_f64,
                        );

                        // ── D. Sync master clock to transport playhead ───
                        if is_playing {
                            clock.set_position(render_ctx.playhead.position());
                        }

                        rt_debug_stats.record_callback(
                            frame_count,
                            commands_processed,
                            callback_start.map(|s| s.elapsed().as_micros() as u64).unwrap_or(0),
                            deferred_topology.len(),
                        );

                        // MEGA-03 FIX: Restore original FPU semantics for OS audio thread
                        #[cfg(target_arch = "x86_64")]
                        unsafe { std::arch::x86_64::_mm_setcsr(original_csr); }

                        #[cfg(target_arch = "aarch64")]
                        unsafe { std::arch::asm!("msr fpcr, {}", in(reg) original_fpcr); }
                    };

                #[cfg(debug_assertions)]
                {
                    let callback_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                        &mut run_callback,
                    ));
                    if callback_result.is_err() {
                        data.fill(0.0);
                        error!(
                            "[RT] Panic trapped inside audio callback; emitted silence for this buffer"
                        );
                    }
                }
                #[cfg(not(debug_assertions))]
                {
                    run_callback();
                }
            },
            // RT_CALLBACK_END
            move |err| {
                let err_msg = err.to_string();
                error!("Audio stream error: {}", err_msg);
                if let Some(tx) = stream_error_tx.as_ref() {
                    let _ = tx.send(err_msg);
                }
            },
            None,
        )
        .map_err(|e| AudioDriverError::BuildStreamError(e.to_string()))?;

    // ── 6. Estimate output latency ──────────────────────────────────
    // cpal 0.17: StreamConfig.buffer_size may be Default (OS-chosen)
    // or Fixed(n). When Default, we use a conservative 512 frames
    // which matches typical macOS CoreAudio buffer size (~10.7ms @ 48kHz).
    // AUD-086 FIX: Proportional latency estimate based on sample rate.
    // 512 is correct for 48kHz (~10.7ms) but too low for 96kHz (~5.3ms).
    // Use sample_rate/100 to target ~10ms consistently.
    let output_latency_frames: u32 = match config.buffer_size {
        cpal::BufferSize::Fixed(n) => n,
        cpal::BufferSize::Default => (sample_rate / 100).max(256),
    };

    // ── 7. Start ────────────────────────────────────────────────────
    stream
        .play()
        .map_err(|e| AudioDriverError::PlayStreamError(e.to_string()))?;

    info!(
        "🔊 Audio stream started ({}Hz, {}ch, {:?}, latency ≈ {} frames)",
        sample_rate, channels, sample_format, output_latency_frames
    );

    Ok(AudioStreamHandle {
        _stream: stream,
        sample_rate_hz: sample_rate,
        output_latency_frames,
        output_device_name: device_name,
        spectrum_consumer: Some(spectrum_consumer),
    })
}
