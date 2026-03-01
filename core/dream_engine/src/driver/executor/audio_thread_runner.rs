use super::super::*;
use crate::essence_synth::EssenceSynthEngine;
use crate::flow_synth::FlowSynthEngine;
use cpal::traits::{DeviceTrait, StreamTrait};
use dream_dsp::device_slot::ProcessContext;
use log::{error, info};
use std::time::Instant;

use super::audio_thread_commands::{CommandProcessingContext, drain_commands};
use super::audio_thread_instrument_pass::render_instrument_sources;
use super::command_dispatch::DeferredDeviceChainCmd;
use super::render_pipeline::{
    finalize_output_and_publish, interleave_graph_output, mix_preview_audio,
    process_master_bus, render_test_tone_if_needed, sync_sample_rack_engines,
    sync_sampler_samples,
};
use super::audio_thread_track_pass::{TrackPassContext, process_track_graph_node};
use crate::driver::midi_dispatcher::PluginNoteTracker;
use dream_clip_engine::midi_scheduler::ScheduledNote;
use dream_graph::GraphRenderer;
use dream_ipc::metering::{METER_FLOOR_DB, compute_peak, compute_rms};

/// Safe test tone amplitude: -10 dBFS to avoid clipping during development.
const TEST_TONE_AMPLITUDE: f32 = 0.316_227_76;

// BUG-088, BUG-099 FIX: Moved static diagnostic counters out of function scopes

static TOPOLOGY_OVERFLOW: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

pub fn reset_runner_counters() {

    TOPOLOGY_OVERFLOW.store(0, std::sync::atomic::Ordering::Relaxed);
}
#[allow(dead_code)]
static PANIC_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

#[allow(clippy::too_many_arguments)]
pub(crate) fn start_audio_thread_on_device_impl(
    mut consumer: rtrb::Consumer<EngineCommand>,
    mut prealloc_consumer: rtrb::Consumer<dream_ipc::prealloc_queue::PrebuiltDevice>,
    shared_state: AudioSharedState,
    preferred_output_device: Option<&str>,
    stream_error_tx: Option<std::sync::mpsc::SyncSender<String>>,
    preferred_buffer_size: Option<u32>,
) -> Result<AudioStreamHandle, AudioDriverError> {
    let clock = shared_state.clock;
    let meter_bank = shared_state.meter_bank;
    let clip_pool = shared_state.clip_pool;
    let clip_snapshot = shared_state.clip_snapshot;
    let midi_snapshot = shared_state.midi_snapshot;
    let routing_snapshot = shared_state.routing_snapshot;
    let _sidechain_snapshot = shared_state.sidechain_snapshot;
    let external_fx_snapshot = shared_state.external_fx_snapshot;
    let automation_snapshot = shared_state.automation_snapshot;
    let sampler_samples = shared_state.sampler_samples;
    let sample_rack_samples = shared_state.sample_rack_samples;
    let prepared_graph_snapshot = shared_state.prepared_graph_snapshot;
    let rt_debug_stats = shared_state.rt_debug_stats;
    let plugin_registry = shared_state.plugin_registry;
    let preview_buffer = shared_state.preview_buffer;
    let preview_cursor = shared_state.preview_cursor;
    let preview_source_sr = shared_state.preview_source_sr;
    let disk_streamers = shared_state.disk_streamers;
    let output_setup = resolve_output_setup(preferred_output_device, preferred_buffer_size)?;
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
    // BUG-Q002 FIX: Removed dead _vst_diag_counter (was never read).

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
    let mut master_gain_smoother = crate::oscillator::ParameterSmoother::new(1.0, sample_rate_f64, 5.0);
    // MASTER DEVICE CHAIN: Internal FX on the master bus (EQ, compressor, etc.).
    // Historically this path was bypassed; now it is active in the master FX stage.
    let mut master_device_chain = DeviceChain::new(sample_rate_f64 as f32);
    // per-track disable/solo state (used for output-enable calculation)
    let mut track_disabled = [false; MAX_TRACKS];
    let mut track_soloed = [false; MAX_TRACKS];
    let mut any_solo: bool = false;
    // PREVIEW-FIX: Per-track flag indicating an external VST instrument is loaded.
    // When true, preview note-on/off skips the built-in sampler/rack engines
    // (they would produce a buzzing waveform layered on top of the VST).
    // Updated every callback from external_fx_snapshot.
    let mut track_has_external_instrument = [false; MAX_TRACKS];

    // UI state mutations are accumulated here to avoid mid-buffer discontinuities
    let mut pending_track_volume: [Option<f32>; MAX_TRACKS] = [None; MAX_TRACKS];
    let mut pending_track_pan: [Option<f32>; MAX_TRACKS] = [None; MAX_TRACKS];
    let mut pending_track_disabled: [Option<bool>; MAX_TRACKS] = [None; MAX_TRACKS];
    let mut pending_track_solo: [Option<bool>; MAX_TRACKS] = [None; MAX_TRACKS];
    // BUG-026 FIX: Persist the last loop region so SetLoopEnabled(true) can restore it.
    let mut last_loop_region: Option<LoopRegion> = None;
    let mut loop_enabled = false;

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
    let mut essence_engines: Vec<EssenceSynthEngine> = (0..MAX_TRACKS)
        .map(|_| EssenceSynthEngine::new(sample_rate_f64))
        .collect();
    let mut flow_engines: Vec<FlowSynthEngine> = (0..MAX_TRACKS)
        .map(|_| FlowSynthEngine::new(sample_rate_f64))
        .collect();
    let mut midi_note_states: Vec<MidiNoteMapState> = vec![MidiNoteMapState::default(); MAX_TRACKS];
    // Scratch buffers for sampler output (reused each buffer, zero-alloc)
    let mut external_left = vec![0.0f32; MAX_BUFFER_FRAMES];
    let mut external_right = vec![0.0f32; MAX_BUFFER_FRAMES];
    let mut deferred_topology: VecDeque<DeferredDeviceChainCmd> = VecDeque::with_capacity(1024);
    // RT-safe drain buffer for pre-constructed devices from the IPC thread.
    // The IPC thread pre-allocates processors and pushes them via the lock-free
    // SPSC prealloc queue. We drain them here into deferred_topology as AddDevice
    // commands — zero heap allocation on the audio thread.
    // (prealloc_consumer is captured by the closure below)
    let mut midi_schedule_scratch: Vec<ScheduledNote> = Vec::with_capacity(2048);
    let mut midi_schedule_tmp: Vec<ScheduledNote> = Vec::with_capacity(2048);
    // Pre-allocated scratch buffer for converting scheduled MIDI events to MidiEvent
    // objects that external VST3 plugins receive.
    let mut vst3_midi_scratch: Vec<MidiEvent> = Vec::with_capacity(4096);
    // Per-track active-note tracking for VST3 plugins (flush on stop/seek).
    let mut vst3_note_trackers: Vec<PluginNoteTracker> = vec![PluginNoteTracker::default(); MAX_TRACKS];
    // BUG-012 FIX: Per-track flush instead of global flag.
    // The previous global flag killed notes on ALL VST3 instruments when only
    // one track needed flushing (e.g. single-track bypass/stop).
    let mut vst3_flush_per_track: [bool; MAX_TRACKS] = [false; MAX_TRACKS];
    // MIDI Chase flag: when true, sustaining notes (is_note_on=false but active)
    // get a synthetic note-on injected at frame 0 so the sampler re-triggers them.
    // Set on Seek/Play — cleared after the first render callback uses it.
    let mut midi_chase_needed = false;
    // EXPORT-SAFETY: When true, skip ALL external VST plugin try_lock()
    // calls. Set via SetExportActive command to prevent RT/export state
    // contention that causes crackling in the exported audio.
    let mut export_active = false;
    // BUG-C002 FIX: Per-track MIDI queue with bounded capacity.
    // A stuck MIDI device sending continuous events could grow unbounded.
    let mut plugin_rt_midi_queue: Vec<Vec<MidiEvent>> =
        (0..MAX_TRACKS).map(|_| Vec::with_capacity(32)).collect();
    let mut rt_midi_uid_counter: u64 = 1;
    // Track which samples were last loaded per-track to avoid re-assigning
    // BUG-068 FIX: Removed dead variable _last_sample_generation (was never read).

    // ── BUG-102 FIX: Wait-Free GC Queue for ArcSwap Pointers ──
    // Dropping an ArcSwap Guard on the audio thread invokes the system allocator
    // if it completes the ref drop. We use a wait-free rtrb ring buffer to send
    // disconnected Arcs to a background thread for safe disposal.
    let (mut gc_producer, mut gc_consumer) = rtrb::RingBuffer::<std::sync::Arc<dyn std::any::Any + Send + Sync>>::new(4096);
    // BUG-A055 FIX: Atomic overflow counter — exposed via rt_debug_stats for diagnostic visibility.
    match std::thread::Builder::new()
        .name("dream-audio-gc".into())
        .spawn(move || {
            // BUG-005 FIX: Exit the GC thread when the producer side is dropped
            // (i.e., the audio callback closure is dropped when the stream stops).
            // Without this, the GC thread runs forever, leaking a thread per
            // audio engine lifecycle.
            loop {
                let mut drained_any = false;
                while let Ok(arc) = gc_consumer.pop() {
                    drop(arc); // Deallocate off the audio thread
                    drained_any = true;
                }
                // If the producer is dropped and queue is empty, the rtrb
                // consumer.pop() returns Err permanently. We check if we
                // haven't drained anything AND the producer is gone.
                if !drained_any && gc_consumer.is_abandoned() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }) {
        Ok(_) => {}
        Err(e) => {
            eprintln!("[dream-audio-gc] WARN: Failed to spawn GC thread: {e}. Arc pointers will leak but audio will continue.");
        }
    }

    let mut prev_clip_snap = clip_snapshot.load_full();
    let mut prev_routing_snap = std::sync::Arc::clone(&*routing_snapshot.load());
    let mut prev_midi_snap = midi_snapshot.load_full();
    let mut prev_prepared_snap = std::sync::Arc::clone(&*prepared_graph_snapshot.load());
    let mut prev_clip_pool = std::sync::Arc::clone(&*clip_pool.load());

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
                        // SAFETY: reading/updating MXCSR is thread-local CPU state for current callback thread.
                        let original_csr = unsafe {
                            use std::arch::x86_64::*;
                            let csr = _mm_getcsr();
                            _mm_setcsr(csr | 0x8040); // DAZ + FTZ bits
                            csr
                        };

                        #[cfg(target_arch = "aarch64")]
                        // SAFETY: FPCR read/write targets current thread FPU control register only.
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
                        // ── A0. Drain pre-allocated devices (RT-safe) ──────────
                        // Pre-constructed DSP processors from the IPC thread arrive
                        // via the lock-free SPSC prealloc queue. We drain them into
                        // deferred_topology as AddDevice — zero heap alloc.
                        while let Ok(prebuilt) = prealloc_consumer.pop() {
                            if deferred_topology.len() >= 4096 {
                                // BUG-RT002 FIX: Track overflow via atomic counter AND
                                // expose count in rt_debug_stats for diagnostic visibility.
                                let count = TOPOLOGY_OVERFLOW.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                // Only drop oldest when truly saturated — log the first few overflows.
                                if count < 3 {
                                    rt_debug_stats.record_topology_overflow();
                                }
                                let _ = deferred_topology.pop_front();
                            }
                            deferred_topology.push_back(
                                DeferredDeviceChainCmd::AddDevice {
                                    track_index: prebuilt.track_index,
                                    slot_index: prebuilt.slot_index,
                                    device: prebuilt.device,
                                },
                            );
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
                            &mut CommandProcessingContext {
                                clock: &clock,
                                render_ctx: &mut render_ctx,
                                sampler_engines: &mut sampler_engines,
                                sample_rack_engines: &mut sample_rack_engines,
                                essence_engines: &mut essence_engines,
                                flow_engines: &mut flow_engines,
                                midi_note_states: &mut midi_note_states,
                                vst3_flush_per_track: &mut vst3_flush_per_track,
                                plugin_rt_midi_queue: &mut plugin_rt_midi_queue,
                                is_playing: &mut is_playing,
                                bpm: &mut bpm,
                                time_sig_numerator: &mut time_sig_numerator,
                                time_sig_denominator: &mut time_sig_denominator,
                                master_gain_smoother: &mut master_gain_smoother,
                                track_disabled: &mut track_disabled,
                                track_soloed: &mut track_soloed,
                                any_solo: &mut any_solo,
                                track_has_external_instrument: &track_has_external_instrument,
                                pending_track_volume: &mut pending_track_volume,
                                pending_track_pan: &mut pending_track_pan,
                                pending_track_disabled: &mut pending_track_disabled,
                                pending_track_solo: &mut pending_track_solo,
                                last_loop_region: &mut last_loop_region,
                                loop_enabled: &mut loop_enabled,
                                test_tone_phase: &mut test_tone_phase,
                                test_tone_enabled: &mut test_tone_enabled,
                                test_tone_target_freq: &mut test_tone_target_freq,
                                midi_chase_needed: &mut midi_chase_needed,
                                deferred_topology: &mut deferred_topology,
                                master_device_chain: &mut master_device_chain,
                                routing_snapshot: &routing_snapshot,
                                rt_debug_stats: rt_debug_stats.as_ref(),
                                export_active: &mut export_active,
                            },
                        );

                        // ── B-1. Prepare track strips for mixer automation ──────────────
                        // If a track has volume/pan automation lanes, we neutralize the
                        // strip mixer controls here and apply absolute sample-accurate
                        // mixer automation later on graph output buffers.
                        let automation = automation_snapshot.load();
                        // AUD-504 FIX: Removed unused _sidechain_map = sidechain_snapshot.load().
                        // Sidechain routing is resolved via ExternalPluginRuntimeSlot.sidechain_track_index,
                        // not through the raw sidechain snapshot.
                        let external_fx_map = external_fx_snapshot.load();
                        // PREVIEW-FIX: Refresh per-track VST instrument flags from snapshot.
                        // When a track has an external VST instrument slot, the built-in
                        // sampler/rack should NOT be triggered by preview note-on/off.
                        let active_tracks = render_ctx.meter_bank.track_count();
                        track_has_external_instrument[..active_tracks].fill(false);
                        for (k, slots) in external_fx_map.iter().enumerate() {
                            if k >= active_tracks { continue; }
                            track_has_external_instrument[k] = slots.iter().any(|s| {
                                s.is_instrument && s.instance_id.is_some()
                            });
                        }
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
                        let current_clip_snap = clip_snapshot.load_full();
                        if !std::sync::Arc::ptr_eq(&current_clip_snap, &prev_clip_snap) {
                            let old = std::mem::replace(&mut prev_clip_snap, current_clip_snap.clone());
                            if gc_producer.push(old as std::sync::Arc<dyn std::any::Any + Send + Sync>).is_err() {
                                rt_debug_stats.record_gc_overflow();
                            }
                        }
                        let snapshot = &current_clip_snap;
                        let track_count = snapshot.len().min(MAX_TRACKS);

                        let current_prepared_snap = std::sync::Arc::clone(&*prepared_graph_snapshot.load());
                        if !std::sync::Arc::ptr_eq(&current_prepared_snap, &prev_prepared_snap) {
                            let old = std::mem::replace(&mut prev_prepared_snap, current_prepared_snap.clone());
                            if gc_producer.push(old as std::sync::Arc<dyn std::any::Any + Send + Sync>).is_err() {
                                rt_debug_stats.record_gc_overflow();
                            }
                        }
                        let prepared = &current_prepared_snap;

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
                        
                        let current_routing_snap = std::sync::Arc::clone(&*routing_snapshot.load());
                        if !std::sync::Arc::ptr_eq(&current_routing_snap, &prev_routing_snap) {
                            let old = std::mem::replace(&mut prev_routing_snap, current_routing_snap.clone());
                            if gc_producer.push(old as std::sync::Arc<dyn std::any::Any + Send + Sync>).is_err() {
                                rt_debug_stats.record_gc_overflow();
                            }
                        }
                        let routing_now = &current_routing_snap;

                        for src_idx in 0..track_count {
                            if let Some(Some(dest_idx)) = routing_now.get(src_idx)
                                && *dest_idx < track_count
                            {
                                post_sum_processing_mask[*dest_idx] = true;
                            }
                        }



                        // ── B. Source render pass (Clips & Samplers) ────
                        // Sync loaded samples from shared snapshots once per buffer.
                        sync_sampler_samples(&mut sampler_engines, &sampler_samples);
                        sync_sample_rack_engines(&mut sample_rack_engines, &sample_rack_samples);


                        let current_midi_snap = midi_snapshot.load_full();
                        if !std::sync::Arc::ptr_eq(&current_midi_snap, &prev_midi_snap) {
                            let old = std::mem::replace(&mut prev_midi_snap, current_midi_snap.clone());
                            if gc_producer.push(old as std::sync::Arc<dyn std::any::Any + Send + Sync>).is_err() {
                                rt_debug_stats.record_gc_overflow();
                            }
                        }
                        let midi_snap = &current_midi_snap;

                        let has_clips = !snapshot.is_empty()
                            && snapshot.iter().any(|track_clips| !track_clips.is_empty());

                        // ▸ Capture pre-advance playhead for MIDI scheduling.
                        let midi_playhead_pos = render_ctx.playhead.position();
                        // FRAME-DOMAIN-FIX (Enterprise): Single converter replaces
                        // all ad-hoc ratio computations. Computed once per callback.
                        let frame_converter = crate::frame_domain::FrameDomainConverter::new(
                            render_ctx.sample_rate,
                            render_ctx.timeline_sample_rate,
                            frame_count,
                        );
                        let timeline_frame_count = frame_converter.timeline_frames();
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

                            let current_clip_pool = std::sync::Arc::clone(&*clip_pool.load());
                            if !std::sync::Arc::ptr_eq(&current_clip_pool, &prev_clip_pool) {
                                let old = std::mem::replace(&mut prev_clip_pool, current_clip_pool.clone());
                                if gc_producer.push(old as std::sync::Arc<dyn std::any::Any + Send + Sync>).is_err() {
                                    rt_debug_stats.record_gc_overflow();
                                }
                            }
                            let pool_snap = &current_clip_pool;

                            let render_frames = frame_count
                                .min(graph_out_left.len())
                                .min(graph_out_right.len());

                            render_ctx.read_audio_clips_into_tracks(
                                render_frames,
                                snapshot.as_slice(),
                                pool_snap,
                                bpm,
                            );
                            render_ctx.advance_playhead_by_frames(render_frames);
                            playhead_advanced_in_render = true;
                            // LOOP-WRAP-FIX-3 (Enterprise): Detect loop wrap by
                            // comparing post-advance position with pre-advance.
                            // When a wrap occurs, set midi_chase = true so that
                            // sustaining notes at the new position are re-triggered.
                            if render_ctx.playhead.position() < midi_playhead_pos {
                                midi_chase_needed = true;
                            }
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
                        render_instrument_sources(
                            track_count,
                            midi_snap.as_ref(),
                            &mut render_ctx,
                            &mut sampler_engines,
                            &mut sample_rack_engines,
                            &mut essence_engines,
                            &mut flow_engines,
                            &mut midi_note_states,
                            &mut plugin_rt_midi_queue,
                            &mut rt_midi_uid_counter,
                            midi_chase_needed,
                            is_playing,
                            midi_playhead_pos,
                            &frame_converter,
                        );

                        // Graph pass: route pre-rendered tracks through DAG.
                        // This UNIFIED block handles both playing (clips) and stopped (tails/real-time MIDI) states.
                        // PDC-005 FIX: On seek or loop wrap, flush PDC delay line ring buffers
                        // so stale audio from the previous playhead position doesn't leak out.
                        if midi_chase_needed {
                            graph_renderer.reset_pdc_delays();
                        }
                        // MIDI-CHASE: Clear the chase flag after all tracks have been processed.
                        // It only needs to be active for the first buffer after a seek.
                        midi_chase_needed = false;
                        let n = frame_count;
                        graph_out_left[..n].fill(0.0);
                        graph_out_right[..n].fill(0.0);

                        // Build ProcessContext once per buffer for unified device processing.
                        let process_ctx = ProcessContext {
                            sample_rate: sample_rate_f64 as f32,
                            playhead_frames: render_ctx.playhead.position(),
                            tempo: bpm,
                            is_playing,
                            time_sig_numerator,
                            time_sig_denominator,
                        };

                        graph_renderer.render(
                            &graph_plan,
                            &graph_dag,
                            n,
                            &mut graph_out_left[..n],
                            &mut graph_out_right[..n],
                            |node, left, right, count, sidechain_resolver| {
                                // AUD-077 FIX: Named constant for master output node ID.
                                const MASTER_OUTPUT_ID: u64 = 0;
                                if node.id.0 == MASTER_OUTPUT_ID {
                                    return;
                                }
                                let track_idx = (node.id.0 - 1) as usize;
                                if track_idx < render_ctx.track_slots.len() {
                                    let (_left_tracks, right_tracks) =
                                        render_ctx.track_slots.split_at_mut(track_idx);
                                    let Some((slot, _right_tracks_rest)) =
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

                                    let mut ctx = TrackPassContext {
                                        c,
                                        track_idx,
                                        post_sum_processed,
                                        slot,
                                        left_tracks: _left_tracks,
                                        right_tracks: _right_tracks_rest,
                                        external_fx_map: &external_fx_map,
                                        automation: &automation,
                                        playhead_pos,
                                        sample_rate_f64,
                                        process_ctx: &process_ctx,
                                        plugin_registry_ref,
                                        external_left: &mut external_left,
                                        external_right: &mut external_right,
                                        midi_snap,
                                        midi_playhead_pos,
                                        timeline_frame_count,
                                        frame_converter: &frame_converter,
                                        vst3_midi_scratch: &mut vst3_midi_scratch,
                                        plugin_rt_midi_queue: &mut plugin_rt_midi_queue,
                                        vst3_flush_per_track: &vst3_flush_per_track,
                                        vst3_note_trackers: &mut vst3_note_trackers,
                                        midi_schedule_scratch: &mut midi_schedule_scratch,
                                        midi_schedule_tmp: &mut midi_schedule_tmp,
                                        is_playing,
                                        bpm,
                                        time_sig_numerator,
                                        time_sig_denominator,
                                        timeline_sample_rate: render_ctx.timeline_sample_rate,
                                        loop_region: render_ctx.loop_region,
                                        export_active,
                                    };

                                    process_track_graph_node(left, right, &mut ctx, sidechain_resolver);

                                    // 4. Per-track metering (graph pass)
                                    if let Some((meter_l, meter_r)) =
                                        render_ctx.meter_bank.track(track_idx)
                                    {
                                        let rms_l = linear_to_db(compute_rms(&left[..c]));
                                        let rms_r = linear_to_db(compute_rms(&right[..c]));
                                        let peak_l = linear_to_db(compute_peak(&left[..c]));
                                        let peak_r = linear_to_db(compute_peak(&right[..c]));
                                        let track_decay = peak_decay_for_block(sample_rate_f64, c);
                                        meter_l.store_rms(rms_l);
                                        meter_r.store_rms(rms_r);
                                        meter_l.store_peak_decay(peak_l, track_decay);
                                        meter_r.store_peak_decay(peak_r, track_decay);
                                    }
                                }
                            },
                            |_node, _left, _right, _count, _resolver| {},
                        );
                        // BUG-012 FIX: Clear per-track flush flags after processing.
                        // AUD-009 FIX: Only clear flags for tracks that were actually
                        // processed in this graph pass. Tracks beyond track_count
                        // should retain their flush flag until they become active.
                        vst3_flush_per_track[..track_count.min(MAX_TRACKS)].fill(false);

                        // BUG-Q002 FIX: Removed _vst_diag_counter usage (dead code).

                        process_master_bus(
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
                            &mut master_gain_smoother,
                            &mut render_ctx,
                            &process_ctx,
                            export_active,
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
                            // LOOP-WRAP-FIX-3b: Same chase detection for MIDI-only tracks.
                            if render_ctx.playhead.position() < midi_playhead_pos {
                                midi_chase_needed = true;
                            }
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

                        // BUG-M005 FIX: Force-clear the active real-time MIDI queue for all tracks.
                        // Events sent from the frontend during this callback window MUST be 
                        // consumed by a VST in this exact block, or they are stale. Unconsumed
                        // events on tracks without instruments previously leaked memory.
                        for queue in plugin_rt_midi_queue.iter_mut() {
                            queue.clear();
                        }

                        rt_debug_stats.record_callback(
                            frame_count,
                            commands_processed,
                            callback_start.map(|s| s.elapsed().as_micros() as u64).unwrap_or(0),
                            deferred_topology.len(),
                        );

                        // MEGA-03 FIX: Restore original FPU semantics for OS audio thread
                        #[cfg(target_arch = "x86_64")]
                        // SAFETY: value was captured from this same thread before mutation in this callback.
                        unsafe { std::arch::x86_64::_mm_setcsr(original_csr); }

                        #[cfg(target_arch = "aarch64")]
                        // SAFETY: value was captured from this same thread before mutation in this callback.
                        unsafe { std::arch::asm!("msr fpcr, {}", in(reg) original_fpcr); }
                    };

                // BUG-004 FIX: Always wrap callback in catch_unwind, including release builds.
                // Previously only debug_assertions had panic protection — in release,
                // any panic in the audio callback killed the entire audio stream permanently.
                {
                    let callback_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                        &mut run_callback,
                    ));
                    if callback_result.is_err() {
                        data.fill(0.0);
                        #[cfg(debug_assertions)]
                        error!(
                            "[RT] Panic trapped inside audio callback; emitted silence for this buffer"
                        );
                        #[cfg(not(debug_assertions))]
                        {
                            PANIC_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        }
                    }
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
