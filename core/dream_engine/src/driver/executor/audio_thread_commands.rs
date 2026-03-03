use super::super::rt_debug::SharedRtDebugStats;
use super::super::*;
use super::command_dispatch::{
    DeferredDeviceChainCmd, apply_pending_track_mixer_state, apply_single_topology_mutation,
};
use crate::essence_synth::EssenceSynthEngine;
use crate::flow_synth::FlowSynthEngine;
use crate::instrument_core::AdsrParams;

pub(super) const MASTER_TRACK_INDEX: u16 = u16::MAX;
const MAX_RT_PLUGIN_MIDI_QUEUE_EVENTS: usize = 256;

#[inline]
fn enqueue_rt_plugin_note_on(queue: &mut Vec<MidiEvent>, pitch: u8, velocity: u8) {
    if queue.len() < MAX_RT_PLUGIN_MIDI_QUEUE_EVENTS {
        queue.push(MidiEvent::note_on(0, 0, pitch, velocity));
    }
}

#[inline]
fn enqueue_rt_plugin_note_off(queue: &mut Vec<MidiEvent>, pitch: u8) {
    // Prioritize release events under pressure. If the queue is saturated,
    // purge stale note-ons and force a deterministic silence command block.
    if queue.len() >= MAX_RT_PLUGIN_MIDI_QUEUE_EVENTS {
        queue.clear();
        queue.push(MidiEvent::cc(0, 0, 120, 0)); // All Sound Off
        queue.push(MidiEvent::cc(0, 0, 123, 0)); // All Notes Off
    }
    queue.push(MidiEvent::note_off(0, 0, pitch, 0));
}

pub(super) struct CommandProcessingContext<'a> {
    pub clock: &'a Arc<MasterClock>,
    pub render_ctx: &'a mut RenderContext,
    pub sampler_engines: &'a mut [SamplerEngine],
    pub sample_rack_engines: &'a mut [SampleRackEngine],
    pub essence_engines: &'a mut [EssenceSynthEngine],
    pub flow_engines: &'a mut [FlowSynthEngine],
    pub midi_note_states: &'a mut [MidiNoteMapState],
    pub vst3_flush_per_track: &'a mut [bool; MAX_TRACKS],
    pub plugin_rt_midi_queue: &'a mut [Vec<MidiEvent>],
    pub is_playing: &'a mut bool,
    pub bpm: &'a mut f64,
    pub time_sig_numerator: &'a mut u8,
    pub time_sig_denominator: &'a mut u8,
    pub master_gain_smoother: &'a mut crate::oscillator::ParameterSmoother,
    pub track_disabled: &'a mut [bool; MAX_TRACKS],
    pub track_soloed: &'a mut [bool; MAX_TRACKS],
    pub any_solo: &'a mut bool,
    /// PREVIEW-FIX: When `true`, the track has an external VST instrument loaded.
    /// Preview note-on/off will skip the built-in sampler/rack engines to prevent
    /// buzzing from the internal wave synth layered on top of the VST.
    pub track_has_external_instrument: &'a [bool],
    pub last_loop_region: &'a mut Option<LoopRegion>,
    pub loop_enabled: &'a mut bool,
    pub test_tone_phase: &'a mut f64,
    pub test_tone_enabled: &'a mut bool,
    pub test_tone_target_freq: &'a mut f32,
    pub midi_chase_needed: &'a mut bool,
    pub deferred_topology: &'a mut VecDeque<DeferredDeviceChainCmd>,
    pub master_device_chain: &'a mut DeviceChain,
    pub pending_track_volume: &'a mut [Option<f32>; MAX_TRACKS],
    pub pending_track_pan: &'a mut [Option<f32>; MAX_TRACKS],
    pub pending_track_disabled: &'a mut [Option<bool>; MAX_TRACKS],
    pub pending_track_solo: &'a mut [Option<bool>; MAX_TRACKS],
    pub routing_snapshot: &'a Arc<SharedRoutingSnapshot>,
    pub rt_debug_stats: &'a SharedRtDebugStats,
    /// When true, skip all external VST plugin try_lock() calls.
    /// Set via SetExportActive command to prevent RT/export state contention.
    pub export_active: &'a mut bool,
}

pub(super) fn drain_commands(
    consumer: &mut rtrb::Consumer<EngineCommand>,
    frame_count: usize,
    ctx: &mut CommandProcessingContext<'_>,
) -> usize {
    let max_commands = (frame_count * 4).clamp(64, 512);
    let mut commands_processed = 0usize;
    // BUG-UNDO-FX-001 FIX: Track whether ClearAllDeviceChains was processed
    // in this drain cycle. When true, SetDeviceParam and BypassDevice commands
    // must be deferred to the topology queue — the actual device chains are
    // empty until apply_all_topology_mutations() re-creates them.
    let mut chains_cleared = false;

    ctx.pending_track_volume.fill(None);
    ctx.pending_track_pan.fill(None);
    ctx.pending_track_disabled.fill(None);
    ctx.pending_track_solo.fill(None);

    for _ in 0..max_commands {
        let Ok(cmd) = consumer.pop() else {
            break;
        };
        commands_processed += 1;

        match cmd {
            // ENTERPRISE FIX: Atomic device chain reset. Processes immediately
            // (not deferred) so the chain state is fully synchronized before
            // any subsequent AddDevice commands in the same callback cycle.
            EngineCommand::ClearAllDeviceChains => {
                for slot in ctx.render_ctx.track_slots.iter_mut() {
                    slot.device_chain.clear();
                }
                ctx.master_device_chain.clear();
                // BUG-D005 FIX: Reset test tone when clearing engine state for a new project.
                *ctx.test_tone_enabled = false;
                *ctx.test_tone_phase = 0.0;
                
                // BUG-A025 FIX: Reset diagnostic pool-miss counters on project change.
                crate::render_callback::reset_diagnostic_counters();

                // BUG-A034 FIX: Reset executor-level diagnostic counters (topology / GC) on project change.
                crate::driver::executor::audio_thread_runner::reset_runner_counters();
                crate::driver::executor::audio_thread_track_pass::reset_track_pass_counters();

                // BUG-UNDO-FX-001 FIX: All subsequent SetDeviceParam / BypassDevice
                // commands in this drain cycle must be deferred until devices are
                // re-created by apply_all_topology_mutations().
                chains_cleared = true;
            }
            EngineCommand::SetPlay(play) => {
                *ctx.is_playing = play;
                ctx.render_ctx.playhead.set_advancing(play);
                if !play {
                    for idx in 0..ctx.sampler_engines.len() {
                        ctx.sampler_engines[idx].all_notes_off();
                        ctx.sample_rack_engines[idx].all_notes_off();
                        if idx < ctx.essence_engines.len() {
                            ctx.essence_engines[idx].all_notes_off();
                        }
                        if idx < ctx.flow_engines.len() {
                            ctx.flow_engines[idx].all_notes_off();
                        }
                        ctx.midi_note_states[idx].active_notes.clear();
                        ctx.midi_note_states[idx].rng_state = 0xA5A5_1337;
                        if idx < ctx.plugin_rt_midi_queue.len() {
                            ctx.plugin_rt_midi_queue[idx].clear();
                        }
                    }
                    ctx.vst3_flush_per_track.fill(true);
                    *ctx.test_tone_phase = 0.0;
                    *ctx.test_tone_enabled = false;
                    ctx.render_ctx.meter_bank.reset_all();
                }
            }
            EngineCommand::SetFreq(freq) => {
                *ctx.test_tone_target_freq = freq.clamp(20.0, 20_000.0);
                *ctx.test_tone_enabled = true;
            }
            EngineCommand::Seek(frame) => {
                let safe_frame = frame.max(0);
                ctx.clock.set_position(safe_frame);
                ctx.render_ctx.playhead.seek(safe_frame);
                for idx in 0..ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].all_notes_off();
                    ctx.sample_rack_engines[idx].all_notes_off();
                    if idx < ctx.essence_engines.len() {
                        ctx.essence_engines[idx].all_notes_off();
                    }
                    if idx < ctx.flow_engines.len() {
                        ctx.flow_engines[idx].all_notes_off();
                    }
                    ctx.midi_note_states[idx].active_notes.clear();
                    ctx.midi_note_states[idx].rng_state = 0xA5A5_1337;
                    if idx < ctx.plugin_rt_midi_queue.len() {
                        ctx.plugin_rt_midi_queue[idx].clear();
                    }
                }
                ctx.vst3_flush_per_track.fill(true);
                *ctx.midi_chase_needed = true;
            }
            EngineCommand::SetBpm(new_bpm) => {
                *ctx.bpm = new_bpm.clamp(10.0, 999.0);
            }
            EngineCommand::SetTimeSignature {
                numerator,
                denominator,
            } => {
                *ctx.time_sig_numerator = numerator.max(1);
                *ctx.time_sig_denominator = denominator.max(1);
            }
            EngineCommand::SetBpmAndLoop {
                bpm: new_bpm,
                loop_enabled,
                loop_region,
            } => {
                *ctx.bpm = new_bpm.clamp(10.0, 999.0);
                *ctx.loop_enabled = loop_enabled;
                if !*ctx.loop_enabled {
                    ctx.render_ctx.loop_region = None;
                } else if let Some((start, end)) = loop_region {
                    let region = LoopRegion { start, end };
                    *ctx.last_loop_region = Some(region);
                    ctx.render_ctx.loop_region = Some(region);
                } else if let Some(ref lr) = *ctx.last_loop_region {
                    ctx.render_ctx.loop_region = Some(*lr);
                }
            }
            EngineCommand::SetTimelineSampleRate(sample_rate) => {
                ctx.render_ctx.set_timeline_sample_rate(sample_rate);
                ctx.master_gain_smoother.set_time_constant(sample_rate, 5.0);
            }
            EngineCommand::SetLoopEnabled(enabled) => {
                *ctx.loop_enabled = enabled;
                if !*ctx.loop_enabled {
                    ctx.render_ctx.loop_region = None;
                } else if let Some(ref lr) = *ctx.last_loop_region {
                    ctx.render_ctx.loop_region = Some(*lr);
                }
            }
            EngineCommand::SetLoopRegion { start, end } => {
                if end > start {
                    let region = LoopRegion { start, end };
                    *ctx.last_loop_region = Some(region);
                    // Keep loop markers cached, but only apply loop playback when
                    // loop mode is explicitly enabled.
                    if *ctx.loop_enabled {
                        ctx.render_ctx.loop_region = Some(region);
                    }
                }
            }
            EngineCommand::SetTrackVolume {
                track_index,
                volume,
            } => {
                let idx = track_index as usize;
                if idx < ctx.pending_track_volume.len() {
                    ctx.pending_track_volume[idx] = Some(volume);
                }
            }
            EngineCommand::SetTrackPan { track_index, pan } => {
                let idx = track_index as usize;
                if idx < ctx.pending_track_pan.len() {
                    ctx.pending_track_pan[idx] = Some(pan);
                }
            }
            EngineCommand::SetMasterVolume { volume } => {
                ctx.master_gain_smoother.set_target(volume.clamp(0.0, 2.0));
            }
            EngineCommand::SetTrackDisabled { track_index, disabled } => {
                let idx = track_index as usize;
                if idx < ctx.pending_track_disabled.len() {
                    ctx.pending_track_disabled[idx] = Some(disabled);
                }
            }
            EngineCommand::SetTrackSolo {
                track_index,
                soloed,
            } => {
                let idx = track_index as usize;
                if idx < ctx.pending_track_solo.len() {
                    ctx.pending_track_solo[idx] = Some(soloed);
                }
            }
            EngineCommand::SamplerNoteOn {
                track_index,
                pitch,
                velocity,
            } => {
                let idx = track_index as usize;
                // PREVIEW-FIX: When the track has an external VST instrument,
                // do NOT trigger the built-in sampler/rack. They would produce
                // a buzzing waveform layered on top of the VST instrument sound.
                let has_vst_instrument = idx < MAX_TRACKS && ctx.track_has_external_instrument[idx];
                if !has_vst_instrument {
                    // SAMPLER-DRONE-FIX: Preview commands target sample-based
                    // engines ONLY (Sampler + SampleRack). The EssenceSynth
                    // oscillator must NOT be triggered from preview commands —
                    // it produces a continuous sine drone that stacks and never
                    // stops when rapid preview clicks miss the note-off.
                    if idx < ctx.sampler_engines.len() {
                        ctx.sampler_engines[idx].note_on(pitch, velocity);
                    }
                    if idx < ctx.sample_rack_engines.len() {
                        ctx.sample_rack_engines[idx].note_on(pitch, velocity);
                    }
                }
                if idx < ctx.plugin_rt_midi_queue.len() {
                    enqueue_rt_plugin_note_on(&mut ctx.plugin_rt_midi_queue[idx], pitch, velocity);
                }
            }
            EngineCommand::SamplerNoteOff { track_index, pitch } => {
                let idx = track_index as usize;
                let has_vst_instrument = idx < MAX_TRACKS && ctx.track_has_external_instrument[idx];
                if !has_vst_instrument {
                    // SAMPLER-DRONE-FIX: Mirror note-on — sample engines only.
                    if idx < ctx.sampler_engines.len() {
                        ctx.sampler_engines[idx].note_off(pitch);
                    }
                    if idx < ctx.sample_rack_engines.len() {
                        ctx.sample_rack_engines[idx].note_off(pitch);
                    }
                    // Also send note-off to EssenceSynth unconditionally to
                    // clean up any dangling voices from before this fix.
                    if idx < ctx.essence_engines.len() {
                        ctx.essence_engines[idx].note_off(pitch);
                    }
                }
                if idx < ctx.plugin_rt_midi_queue.len() {
                    enqueue_rt_plugin_note_off(&mut ctx.plugin_rt_midi_queue[idx], pitch);
                }
            }
            EngineCommand::SetSamplerRootNote {
                track_index,
                root_note,
            } => {
                let idx = track_index as usize;
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].root_note = root_note;
                }
            }
            EngineCommand::SetSamplerVolume {
                track_index,
                volume,
            } => {
                let idx = track_index as usize;
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].volume = volume;
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
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].set_adsr(AdsrParams {
                        attack: attack as f64,
                        decay: decay as f64,
                        sustain: sustain as f64,
                        release: release as f64,
                    });
                }
            }

            EngineCommand::SamplerAllNotesOff { track_index } => {
                let idx = track_index as usize;
                // ENTERPRISE: Silence ALL internal engines, not just the sampler.
                // This command is used by piano roll preview / MIDI input to stop
                // all sound from internal instruments on a track.
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].all_notes_off();
                }
                if idx < ctx.sample_rack_engines.len() {
                    ctx.sample_rack_engines[idx].all_notes_off();
                }
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].all_notes_off();
                }
                if idx < ctx.flow_engines.len() {
                    ctx.flow_engines[idx].all_notes_off();
                }
            }
            EngineCommand::BypassInstrument {
                track_index,
                bypassed,
            } => {
                let idx = track_index as usize;
                if idx < ctx.render_ctx.track_slots.len() {
                    ctx.render_ctx.track_slots[idx].instrument_bypassed = bypassed;
                }
                if bypassed && idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].all_notes_off();
                }
                if bypassed && idx < ctx.sample_rack_engines.len() {
                    ctx.sample_rack_engines[idx].all_notes_off();
                }
                if bypassed && idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].all_notes_off();
                }
                if bypassed && idx < ctx.flow_engines.len() {
                    ctx.flow_engines[idx].all_notes_off();
                }
                if bypassed && idx < MAX_TRACKS {
                    ctx.vst3_flush_per_track[idx] = true;
                }
            }
            EngineCommand::SetSampleRackPadVolume {
                track_index,
                pad_index,
                volume,
            } => {
                if let Some(engine) = ctx.sample_rack_engines.get_mut(track_index as usize)
                    && let Some(pad) = engine.pad_mut(pad_index as usize)
                {
                    pad.volume = volume;
                }
            }
            EngineCommand::SetSampleRackPadMute {
                track_index,
                pad_index,
                muted,
            } => {
                if let Some(engine) = ctx.sample_rack_engines.get_mut(track_index as usize) {
                    engine.set_pad_muted(pad_index as usize, muted);
                }
            }
            EngineCommand::SetSampleRackPadSolo {
                track_index,
                pad_index,
                soloed,
            } => {
                if let Some(engine) = ctx.sample_rack_engines.get_mut(track_index as usize) {
                    engine.set_pad_solo(pad_index as usize, soloed);
                }
            }
            EngineCommand::SetSampleRackPadAdsr {
                track_index,
                pad_index,
                attack,
                decay,
                sustain,
                release,
            } => {
                if let Some(engine) = ctx.sample_rack_engines.get_mut(track_index as usize)
                    && let Some(pad) = engine.pad_mut(pad_index as usize)
                {
                    pad.set_adsr(AdsrParams {
                        attack: attack as f64,
                        decay: decay as f64,
                        sustain: sustain as f64,
                        release: release as f64,
                    });
                }
            }
            EngineCommand::SetSampleRackPadFilterCutoff {
                track_index: _,
                pad_index: _,
                cutoff: _,
            } => {
                // No-op: per-pad filter cutoff is not implemented for the
                // sample-playback engine. The SamplerEngine only plays PCM
                // data — filtering belongs to synth engines (EssenceSynth).
            }
            EngineCommand::SetFlowEnabled { track_index, enabled } => {
                let idx = track_index as usize;
                if idx < ctx.flow_engines.len() {
                    ctx.flow_engines[idx].set_enabled(enabled);
                }
            }
            EngineCommand::SyncFlowGraph { track_index, nodes, connections } => {
                let idx = track_index as usize;
                if idx < ctx.flow_engines.len() {
                    ctx.flow_engines[idx].sync_graph(&nodes, &connections);
                }
            }
            // ── Essence Synth Commands ────────────────────────────────
            EngineCommand::SetEssenceEnabled { track_index, enabled } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_enabled(enabled);
                }
            }
            // ENTERPRISE: All EssenceSynth param handlers below do NOT auto-enable.
            // Enabling is the UI's responsibility via `SetEssenceEnabled`.
            // This is the single source of truth — no scattered `set_enabled(true)`.
            EngineCommand::SetEssenceWaveform1 { track_index, waveform } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_waveform_1(waveform);
                }
            }
            EngineCommand::SetEssenceWaveform2 { track_index, waveform } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_waveform_2(waveform);
                }
            }
            EngineCommand::SetEssenceOsc1Volume { track_index, volume } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_osc1_volume(volume);
                }
            }
            EngineCommand::SetEssenceOsc2Volume { track_index, volume } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_osc2_volume(volume);
                }
            }
            EngineCommand::SetEssenceOsc1Enabled { track_index, enabled } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_osc1_enabled(enabled);
                }
            }
            EngineCommand::SetEssenceOsc2Enabled { track_index, enabled } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_osc2_enabled(enabled);
                }
            }
            EngineCommand::SetEssenceDetuneCents { track_index, cents } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_detune_cents(cents);
                }
            }
            EngineCommand::SetEssenceSubLevel { track_index, level } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_sub_level(level);
                }
            }
            EngineCommand::SetEssencePulseWidth { track_index, width } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_pulse_width(width);
                }
            }
            EngineCommand::SetEssenceFilterCutoff { track_index, cutoff } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_filter_cutoff(cutoff);
                }
            }
            EngineCommand::SetEssenceFilterResonance { track_index, resonance } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_filter_resonance(resonance);
                }
            }
            EngineCommand::SetEssenceFilterType { track_index, filter_type } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_filter_type(filter_type);
                }
            }
            EngineCommand::SetEssenceLfoRate { track_index, rate } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_lfo_rate(rate);
                }
            }
            EngineCommand::SetEssenceLfoDepth { track_index, depth } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_lfo_depth(depth);
                }
            }
            EngineCommand::SetEssenceLfoTarget { track_index, target } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_lfo_target(target);
                }
            }
            EngineCommand::SetEssenceAdsr {
                track_index,
                attack,
                decay,
                sustain,
                release,
            } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_adsr(AdsrParams {
                        attack: attack as f64,
                        decay: decay as f64,
                        sustain: sustain as f64,
                        release: release as f64,
                    });
                }
            }
            EngineCommand::SetEssenceVolume { track_index, volume } => {
                let idx = track_index as usize;
                if idx < ctx.essence_engines.len() {
                    ctx.essence_engines[idx].set_volume(volume);
                }
            }

            EngineCommand::SetExportActive(active) => {
                *ctx.export_active = active;
            }
            EngineCommand::Shutdown => {
                *ctx.is_playing = false;
                *ctx.test_tone_phase = 0.0;
                // ENTERPRISE: Silence ALL internal instrument engines on shutdown.
                for (idx, engine) in ctx.sampler_engines.iter_mut().enumerate() {
                    engine.all_notes_off();
                    if idx < ctx.sample_rack_engines.len() {
                        ctx.sample_rack_engines[idx].all_notes_off();
                    }
                    if idx < ctx.plugin_rt_midi_queue.len() {
                        ctx.plugin_rt_midi_queue[idx].clear();
                    }
                }
                for engine in ctx.essence_engines.iter_mut() {
                    engine.all_notes_off();
                }
                for engine in ctx.flow_engines.iter_mut() {
                    engine.all_notes_off();
                }
                ctx.vst3_flush_per_track.fill(true);
            }
            EngineCommand::AddDevice {
                track_index,
                slot_index,
                effect_type,
            } => {
                if ctx.deferred_topology.len() >= 4096 {
                    ctx.rt_debug_stats.record_topology_overflow();
                    // RT-SAFETY FIX: pop_front() instead of log::error! which acquires a global mutex.
                    // The rt_debug_stats counter records the overflow for offline diagnostics.
                    let _ = ctx.deferred_topology.pop_front();
                }
                ctx.deferred_topology.push_back(DeferredDeviceChainCmd::AddInternal {
                    track_index,
                    slot_index,
                    effect_type,
                });
            }
            EngineCommand::RemoveDevice {
                track_index,
                slot_index,
            } => {
                if ctx.deferred_topology.len() >= 4096 {
                    ctx.rt_debug_stats.record_topology_overflow();
                    // RT-SAFETY FIX: pop_front() instead of log::error! which acquires a global mutex.
                    // The rt_debug_stats counter records the overflow for offline diagnostics.
                    let _ = ctx.deferred_topology.pop_front();
                }
                ctx.deferred_topology
                    .push_back(DeferredDeviceChainCmd::Remove {
                        track_index,
                        slot_index,
                    });
            }
            EngineCommand::ReorderDevice {
                track_index,
                from_slot,
                to_slot,
            } => {
                if ctx.deferred_topology.len() >= 4096 {
                    ctx.rt_debug_stats.record_topology_overflow();
                    // RT-SAFETY FIX: pop_front() instead of log::error! which acquires a global mutex.
                    // The rt_debug_stats counter records the overflow for offline diagnostics.
                    let _ = ctx.deferred_topology.pop_front();
                }
                ctx.deferred_topology
                    .push_back(DeferredDeviceChainCmd::Reorder {
                        track_index,
                        from_slot,
                        to_slot,
                    });
            }
            EngineCommand::BypassDevice {
                track_index,
                slot_index,
                bypassed,
            } => {
                // BUG-UNDO-FX-001 FIX: If chains were cleared in this cycle,
                // defer bypass until devices are re-created.
                if chains_cleared {
                    ctx.deferred_topology.push_back(DeferredDeviceChainCmd::SetBypass {
                        track_index,
                        slot_index,
                        bypassed,
                    });
                } else if track_index == MASTER_TRACK_INDEX {
                    ctx.master_device_chain
                        .set_bypass(slot_index as usize, bypassed);
                } else {
                    let idx = track_index as usize;
                    if idx < ctx.render_ctx.track_slots.len() {
                        ctx.render_ctx.track_slots[idx]
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
                // BUG-UNDO-FX-001 FIX: If chains were cleared in this cycle,
                // defer param set until devices are re-created.
                if chains_cleared {
                    ctx.deferred_topology.push_back(DeferredDeviceChainCmd::SetParam {
                        track_index,
                        slot_index,
                        param_index,
                        value,
                    });
                } else if track_index == MASTER_TRACK_INDEX {
                    ctx.master_device_chain
                        .set_param(slot_index as usize, param_index as u32, value);
                } else {
                    let idx = track_index as usize;
                    if idx < ctx.render_ctx.track_slots.len() {
                        ctx.render_ctx.track_slots[idx].device_chain.set_param(
                            slot_index as usize,
                            param_index as u32,
                            value,
                        );
                    }
                }
            }
        }
    }

    apply_pending_track_mixer_state(
        ctx.render_ctx,
        ctx.pending_track_volume,
        ctx.pending_track_pan,
        ctx.pending_track_disabled,
        ctx.pending_track_solo,
        ctx.track_disabled,
        ctx.track_soloed,
        ctx.any_solo,
        ctx.routing_snapshot,
    );

    apply_single_topology_mutation(
        ctx.deferred_topology,
        ctx.master_device_chain,
        ctx.render_ctx,
        MASTER_TRACK_INDEX,
    );

    commands_processed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enqueue_rt_plugin_note_off_forces_silence_when_queue_is_saturated() {
        let mut queue = Vec::new();
        for pitch in 0..MAX_RT_PLUGIN_MIDI_QUEUE_EVENTS {
            queue.push(MidiEvent::note_on(0, 0, (pitch % 127) as u8, 100));
        }
        enqueue_rt_plugin_note_off(&mut queue, 64);

        assert_eq!(queue.len(), 3);
        assert_eq!(queue[0].data[0] & 0xF0, 0xB0);
        assert_eq!(queue[0].data[1], 120);
        assert_eq!(queue[1].data[0] & 0xF0, 0xB0);
        assert_eq!(queue[1].data[1], 123);
        assert_eq!(queue[2].data[0] & 0xF0, 0x80);
        assert_eq!(queue[2].data[1], 64);
    }
}
