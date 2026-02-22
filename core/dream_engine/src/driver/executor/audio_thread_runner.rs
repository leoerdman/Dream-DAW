use super::super::*;
use super::SharedRtDebugStats;
use cpal::traits::{DeviceTrait, StreamTrait};
use log::{error, info};
use std::sync::atomic::Ordering;
use std::time::Instant;

use super::command_dispatch::{
    DeferredTopologyCmd, apply_pending_track_mixer_state, apply_single_topology_mutation,
};
use super::render_pipeline::{sync_sample_rack_engines, sync_sampler_engines};

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
    // Previously these were completely bypassed (TODO stub at the master FX processing point).
    // Sentinel value for commands: MASTER_TRACK_INDEX = u16::MAX (65535).
    const MASTER_TRACK_INDEX: u16 = u16::MAX;
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
    // AUD-072 FIX: Reduced from 16384 to 2048. Typical MIDI density is <100
    // events per buffer. 16384 wastes 120KB per Vec allocation.
    let mut midi_events_scratch: Vec<(usize, u8, u8, u8, u64)> = Vec::with_capacity(2048);
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
                        let max_commands = (frame_count * 4).clamp(64, 512);
                        let mut commands_processed = 0usize;
                        let mut pending_track_volume: [Option<f32>; MAX_TRACKS] = [None; MAX_TRACKS];
                        let mut pending_track_pan: [Option<f32>; MAX_TRACKS] = [None; MAX_TRACKS];
                        let mut pending_track_mute: [Option<bool>; MAX_TRACKS] = [None; MAX_TRACKS];
                        let mut pending_track_solo: [Option<bool>; MAX_TRACKS] = [None; MAX_TRACKS];
                        for _ in 0..max_commands {
                            let Ok(cmd) = consumer.pop() else {
                                break;
                            };
                            commands_processed += 1;
                            match cmd {
                                EngineCommand::SetPlay(play) => {
                                    is_playing = play;
                                    render_ctx.playhead.set_advancing(play);
                                    if !play {
                                        for idx in 0..sampler_engines.len() {
                                            sampler_engines[idx].all_notes_off();
                                            sample_rack_engines[idx].all_notes_off();
                                            // DEEP-01 FIX: Reuse existing Vec allocation instead of
                                            // constructing a new MidiNoteMapState (which heap-allocates
                                            // Vec::with_capacity(128) and drops the old Vec on the RT thread).
                                            midi_note_states[idx].active_notes.clear();
                                            midi_note_states[idx].rng_state = 0xA5A5_1337;
                                        }
                                        // BUG-012 FIX: Flush all tracks on transport stop.
                                        vst3_flush_per_track.fill(true);
                                        test_tone_phase = 0.0;
                                        test_tone_enabled = false;
                                        // Reset all meters to silence when transport stops
                                        // so stale peaks don't stick on the UI.
                                        render_ctx.meter_bank.reset_all();
                                    }
                                }
                                EngineCommand::SetFreq(freq) => {
                                    test_tone_target_freq = freq.clamp(20.0, 20_000.0);
                                    test_tone_enabled = true;
                                }
                                EngineCommand::Seek(frame) => {
                                    // BUG-056 FIX: Clamp negative seek to 0.
                                    let safe_frame = frame.max(0);
                                    clock.set_position(safe_frame);
                                    render_ctx.playhead.seek(safe_frame);
                                    // Prevent stuck/stacked notes after timeline jumps.
                                    for idx in 0..sampler_engines.len() {
                                        sampler_engines[idx].all_notes_off();
                                        sample_rack_engines[idx].all_notes_off();
                                        // DEEP-07 FIX: Same as DEEP-01 — reuse existing Vec allocation.
                                        midi_note_states[idx].active_notes.clear();
                                        midi_note_states[idx].rng_state = 0xA5A5_1337;
                                    }
                                    // BUG-012 FIX: Flush all tracks on seek.
                                    vst3_flush_per_track.fill(true);
                                    // MIDI-CHASE: Re-trigger sustaining notes at the new position.
                                    midi_chase_needed = true;
                                }
                                EngineCommand::SetBpm(new_bpm) => {
                                    // AUD-088 FIX: Extended BPM range. DAWs support
                                    // extreme tempos for sound design (10 BPM) and
                                    // breakcore/speedcore (999 BPM).
                                    bpm = new_bpm.clamp(10.0, 999.0);
                                }
                                EngineCommand::SetTimeSignature { numerator, denominator } => {
                                    time_sig_numerator = numerator.max(1);
                                    time_sig_denominator = denominator.max(1);
                                }
                                EngineCommand::SetBpmAndLoop {
                                    bpm: new_bpm,
                                    loop_enabled,
                                    loop_region,
                                } => {
                                    bpm = new_bpm.clamp(10.0, 999.0);
                                    if !loop_enabled {
                                        render_ctx.loop_region = None;
                                    } else if let Some((start, end)) = loop_region {
                                        let region = LoopRegion { start, end };
                                        last_loop_region = Some(region.clone());
                                        render_ctx.loop_region = Some(region);
                                    } else if let Some(ref lr) = last_loop_region {
                                        // enabled but no struct given = fallback to last known
                                        render_ctx.loop_region = Some(lr.clone());
                                    }
                                }
                                EngineCommand::SetTimelineSampleRate(sample_rate) => {
                                    render_ctx.set_timeline_sample_rate(sample_rate);
                                }
                                EngineCommand::SetLoopEnabled(enabled) => {
                                    // BUG-026 FIX: Store last loop region so re-enabling
                                    // restores it. Previously SetLoopEnabled(false) destroyed
                                    // the region irreversibly.
                                    if !enabled {
                                        render_ctx.loop_region = None;
                                    } else if let Some(ref lr) = last_loop_region {
                                        render_ctx.loop_region = Some(lr.clone());
                                    }
                                }
                                EngineCommand::SetLoopRegion { start, end } => {
                                    if end > start {
                                        let region = LoopRegion { start, end };
                                        last_loop_region = Some(region.clone());
                                        render_ctx.loop_region = Some(region);
                                    }
                                }
                                EngineCommand::SetTrackVolume {
                                    track_index,
                                    volume,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < MAX_TRACKS {
                                        pending_track_volume[idx] = Some(volume);
                                    }
                                }
                                EngineCommand::SetTrackPan { track_index, pan } => {
                                    let idx = track_index as usize;
                                    if idx < MAX_TRACKS {
                                        pending_track_pan[idx] = Some(pan);
                                    }
                                }
                                EngineCommand::SetMasterVolume { volume } => {
                                    master_gain_target = volume.clamp(0.0, 2.0);
                                }
                                EngineCommand::SetTrackMute { track_index, muted } => {
                                    let idx = track_index as usize;
                                    if idx < MAX_TRACKS {
                                        pending_track_mute[idx] = Some(muted);
                                    }
                                }
                                EngineCommand::SetTrackSolo {
                                    track_index,
                                    soloed,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < MAX_TRACKS {
                                        pending_track_solo[idx] = Some(soloed);
                                    }
                                }
                                // ── Sampler Commands ────────────────────────
                                EngineCommand::SamplerNoteOn {
                                    track_index,
                                    pitch,
                                    velocity,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].note_on(pitch, velocity);
                                    }
                                    if idx < sample_rack_engines.len() {
                                        sample_rack_engines[idx].note_on(pitch, velocity);
                                    }
                                    // Also queue for VST3 instruments on this track.
                                    // The graph pass will drain this into vst3_midi_scratch.
                                    // BUG-S1-02 FIX: Bounded push — drop events beyond 256 per
                                    // buffer to prevent unbounded Vec growth from MIDI storms.
                                    if idx < vst3_rt_midi_queue.len() && vst3_rt_midi_queue[idx].len() < 256 {
                                        vst3_rt_midi_queue[idx].push(
                                            MidiEvent::note_on(0, 0, pitch, velocity),
                                        );
                                    }
                                }
                                EngineCommand::SamplerNoteOff { track_index, pitch } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].note_off(pitch);
                                    }
                                    if idx < sample_rack_engines.len() {
                                        sample_rack_engines[idx].note_off(pitch);
                                    }
                                    // Also queue for VST3 instruments on this track.
                                    // BUG-S1-02 FIX: Same bounded push guard as note-on above.
                                    if idx < vst3_rt_midi_queue.len() && vst3_rt_midi_queue[idx].len() < 256 {
                                        vst3_rt_midi_queue[idx].push(
                                            MidiEvent::note_off(0, 0, pitch, 0),
                                        );
                                    }
                                }
                                EngineCommand::SetSamplerRootNote {
                                    track_index,
                                    root_note,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].root_note = root_note;
                                    }
                                }
                                EngineCommand::SetSamplerVolume {
                                    track_index,
                                    volume,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].volume = volume;
                                    }
                                }
                                EngineCommand::SetSamplerAdsr {
                                    track_index,
                                    attack,
                                    decay,
                                    sustain,
                                    release,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_adsr(AdsrParams {
                                            attack: attack as f64,
                                            decay: decay as f64,
                                            sustain: sustain as f64,
                                            release: release as f64,
                                        });
                                    }
                                }
                                EngineCommand::SetSamplerWaveform {
                                    track_index,
                                    waveform,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx]
                                            .set_waveform(Waveform::from_u8(waveform));
                                    }
                                }
                                EngineCommand::SetSamplerOsc2Waveform {
                                    track_index,
                                    waveform,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx]
                                            .set_waveform2(Waveform::from_u8(waveform));
                                    }
                                }
                                EngineCommand::SetSamplerOscMix { track_index, mix } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_osc_mix(mix);
                                    }
                                }
                                EngineCommand::SetSamplerDetuneCents { track_index, cents } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_detune_cents(cents);
                                    }
                                }
                                EngineCommand::SetSamplerSubLevel { track_index, level } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_sub_level(level);
                                    }
                                }
                                EngineCommand::SetSamplerFilterCutoff {
                                    track_index,
                                    cutoff,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_filter_cutoff(cutoff);
                                    }
                                }
                                EngineCommand::SetSamplerFilterResonance {
                                    track_index,
                                    resonance,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_filter_resonance(resonance);
                                    }
                                }
                                EngineCommand::SetSamplerFilterType {
                                    track_index,
                                    filter_type,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_filter_type(filter_type);
                                    }
                                }
                                EngineCommand::SetSamplerLfoRate { track_index, rate } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_lfo_rate(rate);
                                    }
                                }
                                EngineCommand::SetSamplerLfoDepth { track_index, depth } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_lfo_depth(depth);
                                    }
                                }
                                EngineCommand::SetSamplerLfoTarget {
                                    track_index,
                                    target,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_lfo_target(target);
                                    }
                                }
                                EngineCommand::SetSamplerPulseWidth { track_index, width } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_pulse_width(width);
                                    }
                                }
                                EngineCommand::SamplerAllNotesOff { track_index } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].all_notes_off();
                                    }
                                }
                                EngineCommand::BypassInstrument {
                                    track_index,
                                    bypassed,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < render_ctx.track_slots.len() {
                                        render_ctx.track_slots[idx].instrument_bypassed = bypassed;
                                    }
                                    // Kill active voices when bypassing so sound stops immediately.
                                    if bypassed && idx < sampler_engines.len() {
                                        sampler_engines[idx].all_notes_off();
                                    }
                                    if bypassed && idx < sample_rack_engines.len() {
                                        sample_rack_engines[idx].all_notes_off();
                                    }
                                    // BUG-012 FIX: Only flush the bypassed track, not all.
                                    if bypassed && idx < MAX_TRACKS {
                                        vst3_flush_per_track[idx] = true;
                                    }
                                }
                                EngineCommand::SetSampleRackPadVolume { track_index, pad_index, volume } => {
                                    if let Some(engine) = sample_rack_engines.get_mut(track_index as usize) {
                                        if let Some(pad) = engine.pad_mut(pad_index as usize) {
                                            pad.volume = volume;
                                        }
                                    }
                                }
                                EngineCommand::SetSampleRackPadMute { track_index: _, pad_index: _, muted: _ } => {
                                    // handled via composite volume in host, no-op in engine layer
                                }
                                EngineCommand::SetSampleRackPadSolo { track_index: _, pad_index: _, soloed: _ } => {
                                    // handled via composite volume in host, no-op in engine layer
                                }
                                EngineCommand::SetSampleRackPadAdsr { track_index, pad_index, attack, decay, sustain, release } => {
                                    if let Some(engine) = sample_rack_engines.get_mut(track_index as usize) {
                                        if let Some(pad) = engine.pad_mut(pad_index as usize) {
                                            pad.set_adsr(AdsrParams {
                                                attack: attack as f64,
                                                decay: decay as f64,
                                                sustain: sustain as f64,
                                                release: release as f64,
                                            });
                                        }
                                    }
                                }
                                EngineCommand::SetSampleRackPadFilterCutoff { track_index, pad_index, cutoff } => {
                                    if let Some(engine) = sample_rack_engines.get_mut(track_index as usize) {
                                        if let Some(pad) = engine.pad_mut(pad_index as usize) {
                                            pad.set_filter_cutoff(cutoff);
                                        }
                                    }
                                }
                                EngineCommand::Shutdown => {
                                    is_playing = false;
                                    test_tone_phase = 0.0;
                                    // Kill all sampler voices on shutdown
                                    for engine in sampler_engines.iter_mut() {
                                        engine.all_notes_off();
                                    }
                                    // BUG-012 FIX: Flush all tracks on shutdown.
                                    vst3_flush_per_track.fill(true);
                                }
                                // ── Device Chain Commands ────────────────────
                                EngineCommand::AddDevice {
                                    track_index,
                                    slot_index,
                                    effect_type,
                                } => {
                                    if deferred_topology.len() >= 1024 {
                                        // RT-SAFETY: Never log from the audio callback.
                                        // Atomic counter avoids the global Mutex in log backends.
                                        rt_debug_stats.record_topology_overflow();
                                        let _ = deferred_topology.pop_front();
                                    }
                                    deferred_topology.push_back(DeferredTopologyCmd::Add {
                                        track_index,
                                        slot_index,
                                        effect_type,
                                    });
                                }
                                EngineCommand::RemoveDevice {
                                    track_index,
                                    slot_index,
                                } => {
                                    if deferred_topology.len() >= 1024 {
                                        rt_debug_stats.record_topology_overflow();
                                        let _ = deferred_topology.pop_front();
                                    }
                                    deferred_topology.push_back(DeferredTopologyCmd::Remove {
                                        track_index,
                                        slot_index,
                                    });
                                }
                                EngineCommand::BypassDevice {
                                    track_index,
                                    slot_index,
                                    bypassed,
                                } => {
                                    if track_index == MASTER_TRACK_INDEX {
                                        master_device_chain.set_bypass(slot_index as usize, bypassed);
                                    } else {
                                    let idx = track_index as usize;
                                    if idx < render_ctx.track_slots.len() {
                                        render_ctx.track_slots[idx]
                                            .device_chain
                                            .set_bypass(slot_index as usize, bypassed);
                                    }
                                    }
                                }
                                EngineCommand::SetDeviceParam {
                                    track_index,
                                    slot_index,
                                    param_index,
                                    value,
                                } => {
                                    if track_index == MASTER_TRACK_INDEX {
                                        master_device_chain.set_param(
                                            slot_index as usize,
                                            param_index,
                                            value,
                                        );
                                    } else {
                                    let idx = track_index as usize;
                                    if idx < render_ctx.track_slots.len() {
                                        render_ctx.track_slots[idx].device_chain.set_param(
                                            slot_index as usize,
                                            param_index,
                                            value,
                                        );
                                    }
                                    }
                                }
                            }
                        }

                        apply_pending_track_mixer_state(
                            &mut render_ctx,
                            &pending_track_volume,
                            &pending_track_pan,
                            &pending_track_mute,
                            &pending_track_solo,
                            &mut track_disabled,
                            &mut track_soloed,
                            &mut any_solo,
                            &routing_snapshot,
                        );

                        apply_single_topology_mutation(
                            &mut deferred_topology,
                            &mut master_device_chain,
                            &mut render_ctx,
                            MASTER_TRACK_INDEX,
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
                        for track_idx in 0..track_count {
                            if track_idx >= midi_snap.len() || track_idx >= sampler_engines.len() {
                                continue;
                            }

                            // Skip sampler render entirely when instrument is bypassed.
                            // Buffers stay zeroed → no audio leaks to group bus.
                            if track_idx < render_ctx.track_slots.len()
                                && render_ctx.track_slots[track_idx].instrument_bypassed
                            {
                                continue;
                            }

                            let midi_track = &midi_snap[track_idx];
                            let engine = &mut sampler_engines[track_idx];
                            let rack = &mut sample_rack_engines[track_idx];
                            let slot = &mut render_ctx.track_slots[track_idx];

                            // Schedule MIDI clips for this track (gated by transport)
                            let midi_loop_region = render_ctx
                                .loop_region
                                .as_ref()
                                .map(|r| dream_clip_engine::LoopRegion::new(r.start, r.end));

                            midi_schedule_scratch.clear();
                            if is_playing {
                                MidiScheduler::fill_active_looped_with_tmp(
                                    &midi_track.clips,
                                    midi_playhead_pos,
                                    frame_count,
                                    midi_loop_region.as_ref(),
                                    &mut midi_schedule_scratch,
                                    &mut midi_schedule_tmp,
                                );
                            }

                            // Both sampler and rack use the same MIDI schedule buffer
                            let mut rack_active = false;
                            for p in 0..16 {
                                if let Some(pad) = rack.pad_mut(p) {
                                    if pad.has_active_voices() {
                                        rack_active = true;
                                        break;
                                    }
                                }
                            }

                            let has_rt_midi = track_idx < vst3_rt_midi_queue.len()
                                && !vst3_rt_midi_queue[track_idx].is_empty();

                            if midi_schedule_scratch.is_empty()
                                && !has_rt_midi
                                && !engine.has_active_voices()
                                && !rack_active
                            {
                                continue;
                            }

                            let fc = frame_count.min(slot.buf_left.len());
                            let mut cursor = 0usize;
                            let fx = &midi_track.fx;
                            let note_state = &mut midi_note_states[track_idx];

                            // Convert scheduled notes to instantaneous events (NoteOn and NoteOff)
                            midi_events_scratch.clear();
                            for event in &midi_schedule_scratch {
                                if event.is_note_off {
                                    midi_events_scratch.push((
                                        event.buffer_offset_end.min(fc),
                                        0, // Note Off
                                        event.pitch,
                                        event.velocity,
                                        event.note_uid,
                                    ));
                                }
                                if event.is_note_on {
                                    midi_events_scratch.push((
                                        event.buffer_onset.min(fc),
                                        1, // Note On
                                        event.pitch,
                                        event.velocity,
                                        event.note_uid,
                                    ));
                                }
                                // MIDI-CHASE FIX: After a seek, notes that were already
                                // playing (started before playhead) have is_note_on=false.
                                // The sampler was never told about them → silence until the
                                // next natural note-on. Inject a synthetic note-on at frame 0
                                // so the sampler re-triggers sustaining notes immediately.
                                if midi_chase_needed && !event.is_note_on && !event.is_note_off {
                                    midi_events_scratch.push((
                                        0, // Trigger at start of buffer
                                        1, // Note On
                                        event.pitch,
                                        event.velocity,
                                        event.note_uid,
                                    ));
                                }
                            }
                            // Real-time monitored MIDI (keyboard preview) bypasses transport
                            // and is merged into the sampler event stream.
                            if track_idx < vst3_rt_midi_queue.len() {
                                for evt in &vst3_rt_midi_queue[track_idx] {
                                    let raw_offset = evt.sample_offset.max(0) as usize;
                                    let offset = raw_offset.min(fc);
                                    if evt.is_note_off() {
                                        midi_events_scratch.push((
                                            offset,
                                            0, // Note Off
                                            evt.note(),
                                            evt.velocity(),
                                            rt_midi_uid_counter,
                                        ));
                                        rt_midi_uid_counter = rt_midi_uid_counter.wrapping_add(1);
                                    } else if evt.is_note_on() {
                                        midi_events_scratch.push((
                                            offset,
                                            1, // Note On
                                            evt.note(),
                                            evt.velocity(),
                                            rt_midi_uid_counter,
                                        ));
                                        rt_midi_uid_counter = rt_midi_uid_counter.wrapping_add(1);
                                    }
                                }
                            }
                            // RT-SAFETY: sort_unstable_by is zero-alloc (pdqsort).
                            // sort_by (merge sort) allocates a temp buffer on the heap.
                            midi_events_scratch.sort_unstable_by(|a, b| {
                                a.0.cmp(&b.0)
                                    .then_with(|| a.1.cmp(&b.1))  // note-off before note-on at same frame
                                    .then_with(|| a.2.cmp(&b.2))  // sort by pitch for determinism
                                    .then_with(|| a.4.cmp(&b.4))  // AUD-012 FIX: sort by UID for stable ordering
                            });

                            for &(frame, kind, pitch, velocity, event_uid) in &midi_events_scratch {
                                let seg = frame.saturating_sub(cursor).min(fc - cursor);
                                if seg > 0 {
                                    if engine.has_active_voices() {
                                        engine.render(
                                            &mut slot.buf_left[cursor..cursor + seg],
                                            &mut slot.buf_right[cursor..cursor + seg],
                                            seg,
                                        );
                                    }
                                    // Rack sums natively into the same buffers
                                    rack.render(
                                        &mut slot.buf_left[cursor..cursor + seg],
                                        &mut slot.buf_right[cursor..cursor + seg],
                                        seg,
                                    );
                                    cursor += seg;
                                } else if frame > cursor {
                                    cursor = frame;
                                }

                                if kind == 0 {
                                    // Note Off: Find the mapped pitch for this UID
                                    let off_pitch = if let Some(pos) = note_state
                                        .active_notes
                                        .iter()
                                        .rposition(|n| n.uid == event_uid)
                                    {
                                        let mapped = note_state.active_notes[pos].mapped_pitch;
                                        note_state.active_notes.swap_remove(pos);
                                        mapped
                                    } else {
                                        pitch
                                    };
                                    engine.note_off(off_pitch);
                                    rack.note_off(off_pitch);
                                } else {
                                    // Note On: Apply MIDI FX
                                    let mut pitch_i16 = pitch as i16;
                                    let mut velocity_i16 = velocity as i16;

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

                                    if fx.random_enabled && fx.random_semitones != 0 {
                                        let mut x = note_state.rng_state;
                                        x ^= x << 13;
                                        x ^= x >> 17;
                                        x ^= x << 5;
                                        note_state.rng_state = x;
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
                                            .round()
                                            as i16
                                            + fx.velocity_offset as i16;
                                    }
                                    let mapped_velocity = velocity_i16.clamp(1, 127) as u8;

                                    // Guard against duplicate note-on (release previous if same UID)
                                    if let Some(pos) = note_state
                                        .active_notes
                                        .iter()
                                        .rposition(|n| n.uid == event_uid)
                                    {
                                        let previous = note_state.active_notes.swap_remove(pos);
                                        engine.note_off(previous.mapped_pitch);
                                        rack.note_off(previous.mapped_pitch);
                                    }

                                    note_state.active_notes.push(ActiveMappedNote {
                                        uid: event_uid,
                                        _src_pitch: pitch,
                                        mapped_pitch,
                                    });
                                    engine.note_on(mapped_pitch, mapped_velocity);
                                    rack.note_on(mapped_pitch, mapped_velocity);
                                }
                            }

                            if cursor < fc {
                                let rem = fc - cursor;
                                if engine.has_active_voices() {
                                    engine.render(
                                        &mut slot.buf_left[cursor..fc],
                                        &mut slot.buf_right[cursor..fc],
                                        rem,
                                    );
                                }
                                rack.render(
                                    &mut slot.buf_left[cursor..fc],
                                    &mut slot.buf_right[cursor..fc],
                                    rem,
                                );
                            }

                            // Safety cap: prevent active_notes from leaking unboundedly
                            // if note-off UIDs are missed (e.g., rapid seek edge cases).
                            // 128 simultaneous mapped notes is far beyond any legitimate
                            // polyphony — drain oldest entries if exceeded.
                            if note_state.active_notes.len() > 128 {
                                // AE-018 FIX: Drop the OLDEST notes (front of Vec) to keep
                                // the 128 most recent. Previous truncate(128) kept the oldest
                                // and dropped the newest — wrong priority.
                                let excess = note_state.active_notes.len() - 128;
                                note_state.active_notes.drain(..excess);
                            }

                            // ── Mark slot active so the metering loop in
                            //    render_callback sees MIDI/sampler tracks.
                            slot.active = true;
                        }

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
                                        if !runtime_slots.is_empty() {
                                            for (runtime_slot_idx, runtime_slot) in runtime_slots.iter().enumerate() {
                                                let source_slot = runtime_slot
                                                    .sidechain_track_index
                                                    .and_then(|src_idx| {
                                                        if src_idx < track_idx {
                                                            left_tracks.get(src_idx)
                                                        } else if src_idx == track_idx {
                                                            None
                                                        } else {
                                                            right_tracks_rest.get(
                                                                src_idx - track_idx - 1,
                                                            )
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

                                                if let Some(internal_idx) =
                                                    runtime_slot.internal_slot_index
                                                {
                                                    slot.device_chain
                                                        .process_slot_with_sidechain(
                                                            internal_idx,
                                                            &mut left[..c],
                                                            &mut right[..c],
                                                            sc_l,
                                                            sc_r,
                                                            sample_rate_f64 as f32,
                                                        );
                                                    continue;
                                                }

                                                if let Some(instance_id) =
                                                    runtime_slot.instance_id
                                                    && let Some(plugin_mtx) =
                                                        plugin_registry_ref.get(&instance_id) // LOCK-FREE ArcSwap GET
                                                    && let Some(mut host) = plugin_mtx.try_lock()
                                                {
                                                    apply_external_plugin_param_automation_block(
                                                        &mut *host,
                                                        automation.get(track_idx),
                                                        runtime_slot,
                                                        runtime_slot_idx,
                                                        playhead_pos,
                                                    );
                                                    external_left[..c]
                                                        .copy_from_slice(&left[..c]);
                                                    external_right[..c]
                                                        .copy_from_slice(&right[..c]);
                                                    let main_inputs: [&[f32]; 2] =
                                                        [&left[..c], &right[..c]];
                                                    let sc_pair = source_slot.map(|src| {
                                                        [
                                                            &src.buf_left[..c],
                                                            &src.buf_right[..c],
                                                        ]
                                                    });
                                                let transport = TransportContext {
                                                    sample_rate: sample_rate_f64,
                                                    position_samples: playhead_pos,
                                                    tempo: bpm,
                                                    is_playing,
                                                    is_recording: false, // AUD-033: TODO — pass actual recording state when recording is implemented
                                                    time_sig_numerator: i32::from(time_sig_numerator),
                                                    time_sig_denominator: i32::from(time_sig_denominator),
                                                };
                                                host.set_transport_context(transport);

                                                // ENTERPRISE MIDI: Populate scratch with scheduled events for this track.
                                                // BUG-1/2/3 FIX: VST3 path now has:
                                                //   - All-Notes-Off flush on stop/seek/bypass
                                                //   - MIDI FX parity with sampler path
                                                //   - Active note tracking with duplicate protection
                                                vst3_midi_scratch.clear();

                                                // Drain real-time keyboard/preview MIDI into the
                                                // VST3 scratch buffer so instruments receive
                                                // live note events alongside clip MIDI.
                                                if track_idx < vst3_rt_midi_queue.len() {
                                                    vst3_midi_scratch.extend(
                                                        vst3_rt_midi_queue[track_idx].drain(..),
                                                    );
                                                }

                                                // BUG-012 FIX: Per-track flush instead of global flag.
                                                if vst3_flush_per_track.get(track_idx).copied().unwrap_or(false)
                                                    && track_idx < vst3_note_trackers.len() {
                                                    vst3_note_trackers[track_idx].flush_all(&mut vst3_midi_scratch);
                                                }

                                                if is_playing {
                                                    if let Some(midi_track) = midi_snap.get(track_idx) {
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
                                                                // BUG-2 FIX: Apply same pitch mapping for note-off
                                                                // so the off matches the mapped on.
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
                                                                vst3_midi_scratch.push(
                                                                    MidiEvent::note_off(offset_off, 0, off_pitch, 0),
                                                                );
                                                                // BUG-3 FIX: Deregister from tracker.
                                                                if let Some(ref mut t) = tracker {
                                                                    t.note_off(off_pitch, 0);
                                                                }
                                                            }

                                                            if event.is_note_on {
                                                                // BUG-2 FIX: Apply MIDI FX (pitch, velocity, scale, random)
                                                                // — same pipeline as sampler path.
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

                                                                if fx.random_enabled && fx.random_semitones != 0 {
                                                                    if let Some(ref mut t) = tracker {
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
                                                                }

                                                                if fx.velocity_enabled {
                                                                    velocity_i16 = ((velocity_i16 as f32) * fx.velocity_gain)
                                                                        .round()
                                                                        as i16
                                                                        + fx.velocity_offset as i16;
                                                                }
                                                                let mapped_velocity = velocity_i16.clamp(1, 127) as u8;

                                                                // BUG-3 FIX: Duplicate protection + tracking.
                                                                if let Some(ref mut t) = tracker {
                                                                    if let Some(dup_off) = t.note_on(mapped_pitch, 0) {
                                                                        vst3_midi_scratch.push(MidiEvent::note_off(
                                                                            offset_on.saturating_sub(1).max(0),
                                                                            0,
                                                                            mapped_pitch,
                                                                            0,
                                                                        ));
                                                                        let _ = dup_off; // already handled via note_on return
                                                                    }
                                                                    // BUG-S1-06 FIX: Guard against unbounded active note growth.
                                                                    if t.can_push() {
                                                                        t.active.push((mapped_pitch, 0));
                                                                    }
                                                                }

                                                                vst3_midi_scratch.push(
                                                                    MidiEvent::note_on(
                                                                        offset_on,
                                                                        0,
                                                                        mapped_pitch,
                                                                        mapped_velocity,
                                                                    ),
                                                                );
                                                            }
                                                        }
                                                    }
                                                }

                                                // CRITICAL FIX: Sort MIDI events by sample_offset.
                                                // Events were pushed in scheduler iteration order
                                                // (note-off then note-on per ScheduledNote), NOT
                                                // by chronological sample_offset. VST3 plugins
                                                // expect events sorted by offset. Without this,
                                                // consecutive same-pitch notes (e.g. kick drums)
                                                // randomly fail because a note-off at offset 1000
                                                // appears before a note-on at offset 0.
                                                // Tie-break: note-off (0x80) before note-on (0x90)
                                                // at the same offset ensures clean retrigger.
                                                // RT-SAFETY: sort_unstable_by is zero-alloc (pdqsort).
                                                vst3_midi_scratch.sort_unstable_by(|a, b| {
                                                    a.sample_offset.cmp(&b.sample_offset)
                                                        .then_with(|| {
                                                            a.data[0].cmp(&b.data[0])
                                                        })
                                                });


                                                let mut out_slices: [&mut [f32]; 2] = [
                                                    &mut external_left[..c],
                                                    &mut external_right[..c],
                                                ];
                                                let _ = host.process_with_sidechain(
                                                    &main_inputs,
                                                    sc_pair
                                                        .as_ref()
                                                        .map(|pair| pair.as_slice()),
                                                    &mut out_slices,
                                                    c,
                                                    &vst3_midi_scratch,
                                                );
                                                left[..c].copy_from_slice(
                                                    &external_left[..c],
                                                );
                                                right[..c].copy_from_slice(
                                                    &external_right[..c],
                                                );
                                                }
                                            }
                                        } else {
                                            if !slot.device_chain.is_empty() {
                                                slot.device_chain.process_stereo(
                                                    &mut left[..c],
                                                    &mut right[..c],
                                                    sample_rate_f64 as f32,
                                                );
                                            }
                                        }
                                    } else {
                                        if !slot.device_chain.is_empty() {
                                            slot.device_chain.process_stereo(
                                                &mut left[..c],
                                                &mut right[..c],
                                                sample_rate_f64 as f32,
                                            );
                                        }
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

                        // ── Post-graph master external FX processing ─────────
                        // CRITICAL FIX: External VST3 plugins on the master bus
                        // (e.g. Muse, OTT, limiter) were never processed because:
                        //   1. The graph callback returns early for MASTER_OUTPUT_ID=0
                        //   2. master_track was separate from project.tracks
                        // Now that rebuild_external_fx_snapshot appends master FX
                        // after active tracks, process them on graph_out_left/right
                        // BEFORE interleaving to the output buffer.
                        //
                        // SSOT safety: prefer index `track_count` for the current
                        // capped topology, but if the snapshot was built with an
                        // older/uncapped shape (len > track_count + 1), fallback
                        // to the last entry where master FX are appended.
                        let master_slots_opt =
                            resolve_master_runtime_slots(external_fx_map.as_slice(), track_count);
                        if let Some(master_slots) = master_slots_opt {
                            if !master_slots.is_empty() {
                                for runtime_slot in master_slots.iter() {
                                    // Internal effects on master bus (EQ, compressor, etc.)
                                    // are processed via the master_device_chain.
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
                                        let c = n;
                                        let main_inputs: [&[f32]; 2] = [
                                            &graph_out_left[..c],
                                            &graph_out_right[..c],
                                        ];
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

                                        // Master bus plugins don't receive MIDI.
                                        // Use empty slice (zero-alloc) for RT-safety.
                                        let empty_midi: &[MidiEvent] = &[];

                                        // Seed output with current master input so plugin failure
                                        // or partial writes cannot leak stale buffer data.
                                        external_left[..c].copy_from_slice(&graph_out_left[..c]);
                                        external_right[..c].copy_from_slice(&graph_out_right[..c]);
                                        let mut out_slices: [&mut [f32]; 2] = [
                                            &mut external_left[..c],
                                            &mut external_right[..c],
                                        ];
                                        let _ = host.process_with_sidechain(
                                            &main_inputs,
                                            None, // No sidechain on master bus
                                            &mut out_slices,
                                            c,
                                            &empty_midi,
                                        );

                                        // Write processed output back to graph_out buffers.
                                        graph_out_left[..c].copy_from_slice(&external_left[..c]);
                                        graph_out_right[..c].copy_from_slice(&external_right[..c]);
                                    }
                                }
                            } else if !master_device_chain.is_empty() {
                                // Safety fallback: if snapshot exists but has no runtime
                                // entries, still run the master native chain.
                                master_device_chain.process_stereo(
                                    &mut graph_out_left[..n],
                                    &mut graph_out_right[..n],
                                    sample_rate_f64 as f32,
                                );
                            }
                        } else if !master_device_chain.is_empty() {
                            // Safety fallback: stale/missing external snapshot must never
                            // bypass master native processing.
                            master_device_chain.process_stereo(
                                &mut graph_out_left[..n],
                                &mut graph_out_right[..n],
                                sample_rate_f64 as f32,
                            );
                        }

                        // ── BUG-R4/R5 FIX: Apply master gain to graph_out BEFORE metering ──
                        // Previously master gain was applied after interleave at L3157,
                        // causing: (1) master meters to show pre-fader levels (wrong), and
                        // (2) double soft_clip on hot signals (altered saturation character).
                        // Now master gain is per-sample smoothed into graph_out buffers first,
                        // so metering reflects the true output level.
                        for i in 0..n {
                            master_gain_current +=
                                (master_gain_target - master_gain_current) * master_gain_smooth;
                            graph_out_left[i] *= master_gain_current;
                            graph_out_right[i] *= master_gain_current;
                        }

                        // ── Master bus metering (post-FX, post-master-gain) ──────────
                        {
                            let decay = graph_peak_decay;
                            let rms_l = linear_to_db(compute_rms(&graph_out_left[..n]));
                            let rms_r = linear_to_db(compute_rms(&graph_out_right[..n]));
                            let peak_l = linear_to_db(compute_peak(&graph_out_left[..n]));
                            let peak_r = linear_to_db(compute_peak(&graph_out_right[..n]));
                            render_ctx.meter_bank.master_left().store_rms(rms_l);
                            render_ctx.meter_bank.master_right().store_rms(rms_r);
                            render_ctx.meter_bank.master_left().store_peak_decay(peak_l, decay);
                            render_ctx.meter_bank.master_right().store_peak_decay(peak_r, decay);
                        }



                        // BUG-R5 FIX: Interleave without soft_clip here — final soft_clip
                        // is applied once at the output stage below. Previously signal was
                        // soft-clipped twice (here + master gain loop), altering saturation.
                        for i in 0..n {
                            let base = i * channels;
                            if base >= data.len() { break; }
                            if channels == 1 {
                                // AUD-062 FIX: Equal-power mono fold.
                                data[base] = (graph_out_left[i] + graph_out_right[i]) * std::f32::consts::FRAC_1_SQRT_2;
                                continue;
                            }
                            data[base] = graph_out_left[i];
                            if base + 1 < data.len() {
                                data[base + 1] = graph_out_right[i];
                            }
                            for ch in 2..channels {
                                let idx = base + ch;
                                if idx < data.len() { data[idx] = 0.0; }
                            }
                        }

                        if test_tone_enabled && !is_playing {
                            // Test tone only when stopped (otherwise clips handle it)
                            // AUD-010 FIX: Use sample-rate-dependent smoothing so the
                            // frequency transition time is identical regardless of sample
                            // rate. FREQ_SMOOTHING was a fixed constant producing ~30ms
                            // at 44.1kHz but ~15ms at 96kHz.
                            let freq_smooth_coeff = 1.0 - (-1.0_f64 / (0.03 * sample_rate_f64)).exp() as f32;
                            for frame in data.chunks_exact_mut(channels) {
                                test_tone_current_freq += (test_tone_target_freq - test_tone_current_freq) * freq_smooth_coeff;
                                let phase_inc = test_tone_current_freq as f64 / sample_rate_f64;
                                let sample = (test_tone_phase * std::f64::consts::TAU).sin() as f32 * TEST_TONE_AMPLITUDE;
                                for ch in frame.iter_mut() { *ch = sample; }
                                test_tone_phase += phase_inc;
                                // BUG-014 FIX: Use fract() for safe phase wrapping.
                                // The previous `if >= 1.0 { -= 1.0 }` fails when phase_inc > 1.0
                                // (high frequencies / low sample rates), causing pitch aliasing.
                                test_tone_phase = test_tone_phase.fract();
                            }
                        }

                        if is_playing && !playhead_advanced_in_render {
                            render_ctx.advance_playhead_by_frames(frame_count);
                        }
                        // ── C. Mix preview audio (browser audition) ─────
                        // Preview plays regardless of transport state.
                        // 100% lock-free: ArcSwap::load() is wait-free.
                        // BUG-002 FIX: Preview data is interleaved stereo. Mix it
                        // respecting the actual output channel count to prevent
                        // misalignment on mono or surround devices.
                        //
                        // SSOT-FIX: Fractional cursor advancement for pitch-correct
                        // preview. When source SR ≠ device SR, advancing 1:1 causes
                        // pitch shift. Now advances by (source_sr / device_sr) per
                        // output frame, using linear interpolation for sub-sample positions.
                        let preview_snap = preview_buffer.load();
                        if let Some(ref preview_data) = **preview_snap {
                            let cursor = preview_cursor.load(Ordering::Relaxed);
                            let total = preview_data.len();
                            let preview_channels = 2usize; // preview is always stereo
                            let total_frames = total / preview_channels;
                            if cursor < total {
                                let cursor_frame = cursor / preview_channels;
                                // SSOT-FIX: Compute advancement rate.
                                // source_sr=0 means "same as device" (legacy fallback).
                                let src_sr = preview_source_sr.load(Ordering::Relaxed);
                                let rate = if src_sr > 0 && sample_rate > 0 {
                                    src_sr as f64 / sample_rate as f64
                                } else {
                                    1.0
                                };

                                if (rate - 1.0).abs() < 0.001 {
                                    // Fast path: 1:1 advancement (no interpolation needed)
                                    let preview_frames = total_frames.saturating_sub(cursor_frame);
                                    let mix_frames = preview_frames.min(frame_count);
                                    for f in 0..mix_frames {
                                        let p_idx = cursor + f * preview_channels;
                                        let d_idx = f * channels;
                                        if p_idx + 1 < total && d_idx < data.len() {
                                            let p_left = preview_data[p_idx];
                                            let p_right = preview_data[p_idx + 1];
                                            if channels == 1 {
                                                data[d_idx] += soft_clip((p_left + p_right) * std::f32::consts::FRAC_1_SQRT_2);
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
                                    // SR-conversion path: fractional advancement with linear interp
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
                                                data[d_idx] += soft_clip((p_left + p_right) * std::f32::consts::FRAC_1_SQRT_2);
                                            } else {
                                                data[d_idx] += soft_clip(p_left);
                                                if d_idx + 1 < data.len() {
                                                    data[d_idx + 1] += soft_clip(p_right);
                                                }
                                            }
                                        }
                                        src_pos += rate;
                                    }
                                    // Convert fractional position back to interleaved cursor
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

                        // ── C2. Final safety limiter ─────────────────────
                        // BUG-R4/R5 FIX: Master gain is now applied pre-metering
                        // (to graph_out buffers above). This loop applies only
                        // the final soft_clip limiter to prevent DAC clipping
                        // from preview audio mix-in or accumulated rounding.
                        for sample in data[..n * channels].iter_mut() {
                            *sample = soft_clip(*sample);
                        }

                        // ── BUG-075 FIX: Feed spectrum analyzer POST-fader ──
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

                        // Keep master metering in sync with the real final output,
                        // including sampler and preview contributions.
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
                                // AUD-037 FIX: Compute master peak_decay once per metering pass.
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
