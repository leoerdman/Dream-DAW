use super::super::rt_debug::SharedRtDebugStats;
use super::super::*;
use super::command_dispatch::{
    DeferredTopologyCmd, apply_pending_track_mixer_state, apply_single_topology_mutation,
};
use crate::sampler::{AdsrParams, Waveform};

pub(super) const MASTER_TRACK_INDEX: u16 = u16::MAX;

pub(super) struct CommandDrainContext<'a> {
    pub clock: &'a Arc<MasterClock>,
    pub render_ctx: &'a mut RenderContext,
    pub sampler_engines: &'a mut [SamplerEngine],
    pub sample_rack_engines: &'a mut [SampleRackEngine],
    pub midi_note_states: &'a mut [MidiNoteMapState],
    pub vst3_flush_per_track: &'a mut [bool; MAX_TRACKS],
    pub vst3_rt_midi_queue: &'a mut [Vec<MidiEvent>],
    pub is_playing: &'a mut bool,
    pub bpm: &'a mut f64,
    pub time_sig_numerator: &'a mut u8,
    pub time_sig_denominator: &'a mut u8,
    pub master_gain_target: &'a mut f32,
    pub track_disabled: &'a mut [bool; MAX_TRACKS],
    pub track_soloed: &'a mut [bool; MAX_TRACKS],
    pub any_solo: &'a mut bool,
    pub last_loop_region: &'a mut Option<LoopRegion>,
    pub test_tone_phase: &'a mut f64,
    pub test_tone_enabled: &'a mut bool,
    pub test_tone_target_freq: &'a mut f32,
    pub midi_chase_needed: &'a mut bool,
    pub deferred_topology: &'a mut VecDeque<DeferredTopologyCmd>,
    pub master_device_chain: &'a mut DeviceChain,
    pub routing_snapshot: &'a Arc<SharedRoutingSnapshot>,
    pub rt_debug_stats: &'a SharedRtDebugStats,
}

pub(super) fn drain_commands(
    consumer: &mut rtrb::Consumer<EngineCommand>,
    frame_count: usize,
    ctx: &mut CommandDrainContext<'_>,
) -> usize {
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
                *ctx.is_playing = play;
                ctx.render_ctx.playhead.set_advancing(play);
                if !play {
                    for idx in 0..ctx.sampler_engines.len() {
                        ctx.sampler_engines[idx].all_notes_off();
                        ctx.sample_rack_engines[idx].all_notes_off();
                        ctx.midi_note_states[idx].active_notes.clear();
                        ctx.midi_note_states[idx].rng_state = 0xA5A5_1337;
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
                    ctx.midi_note_states[idx].active_notes.clear();
                    ctx.midi_note_states[idx].rng_state = 0xA5A5_1337;
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
                if !loop_enabled {
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
            }
            EngineCommand::SetLoopEnabled(enabled) => {
                if !enabled {
                    ctx.render_ctx.loop_region = None;
                } else if let Some(ref lr) = *ctx.last_loop_region {
                    ctx.render_ctx.loop_region = Some(*lr);
                }
            }
            EngineCommand::SetLoopRegion { start, end } => {
                if end > start {
                    let region = LoopRegion { start, end };
                    *ctx.last_loop_region = Some(region);
                    ctx.render_ctx.loop_region = Some(region);
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
                *ctx.master_gain_target = volume.clamp(0.0, 2.0);
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
            EngineCommand::SamplerNoteOn {
                track_index,
                pitch,
                velocity,
            } => {
                let idx = track_index as usize;
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].note_on(pitch, velocity);
                }
                if idx < ctx.sample_rack_engines.len() {
                    ctx.sample_rack_engines[idx].note_on(pitch, velocity);
                }
                if idx < ctx.vst3_rt_midi_queue.len() && ctx.vst3_rt_midi_queue[idx].len() < 256 {
                    ctx.vst3_rt_midi_queue[idx].push(MidiEvent::note_on(0, 0, pitch, velocity));
                }
            }
            EngineCommand::SamplerNoteOff { track_index, pitch } => {
                let idx = track_index as usize;
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].note_off(pitch);
                }
                if idx < ctx.sample_rack_engines.len() {
                    ctx.sample_rack_engines[idx].note_off(pitch);
                }
                if idx < ctx.vst3_rt_midi_queue.len() && ctx.vst3_rt_midi_queue[idx].len() < 256 {
                    ctx.vst3_rt_midi_queue[idx].push(MidiEvent::note_off(0, 0, pitch, 0));
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
            EngineCommand::SetSamplerWaveform {
                track_index,
                waveform,
            } => {
                let idx = track_index as usize;
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].set_waveform(Waveform::from_u8(waveform));
                }
            }
            EngineCommand::SetSamplerOsc2Waveform {
                track_index,
                waveform,
            } => {
                let idx = track_index as usize;
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].set_waveform2(Waveform::from_u8(waveform));
                }
            }
            EngineCommand::SetSamplerOscMix { track_index, mix } => {
                let idx = track_index as usize;
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].set_osc_mix(mix);
                }
            }
            EngineCommand::SetSamplerDetuneCents { track_index, cents } => {
                let idx = track_index as usize;
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].set_detune_cents(cents);
                }
            }
            EngineCommand::SetSamplerSubLevel { track_index, level } => {
                let idx = track_index as usize;
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].set_sub_level(level);
                }
            }
            EngineCommand::SetSamplerFilterCutoff {
                track_index,
                cutoff,
            } => {
                let idx = track_index as usize;
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].set_filter_cutoff(cutoff);
                }
            }
            EngineCommand::SetSamplerFilterResonance {
                track_index,
                resonance,
            } => {
                let idx = track_index as usize;
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].set_filter_resonance(resonance);
                }
            }
            EngineCommand::SetSamplerFilterType {
                track_index,
                filter_type,
            } => {
                let idx = track_index as usize;
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].set_filter_type(filter_type);
                }
            }
            EngineCommand::SetSamplerLfoRate { track_index, rate } => {
                let idx = track_index as usize;
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].set_lfo_rate(rate);
                }
            }
            EngineCommand::SetSamplerLfoDepth { track_index, depth } => {
                let idx = track_index as usize;
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].set_lfo_depth(depth);
                }
            }
            EngineCommand::SetSamplerLfoTarget {
                track_index,
                target,
            } => {
                let idx = track_index as usize;
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].set_lfo_target(target);
                }
            }
            EngineCommand::SetSamplerPulseWidth { track_index, width } => {
                let idx = track_index as usize;
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].set_pulse_width(width);
                }
            }
            EngineCommand::SamplerAllNotesOff { track_index } => {
                let idx = track_index as usize;
                if idx < ctx.sampler_engines.len() {
                    ctx.sampler_engines[idx].all_notes_off();
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
                track_index: _,
                pad_index: _,
                muted: _,
            } => {}
            EngineCommand::SetSampleRackPadSolo {
                track_index: _,
                pad_index: _,
                soloed: _,
            } => {}
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
                track_index,
                pad_index,
                cutoff,
            } => {
                if let Some(engine) = ctx.sample_rack_engines.get_mut(track_index as usize)
                    && let Some(pad) = engine.pad_mut(pad_index as usize)
                {
                    pad.set_filter_cutoff(cutoff);
                }
            }
            EngineCommand::Shutdown => {
                *ctx.is_playing = false;
                *ctx.test_tone_phase = 0.0;
                for engine in ctx.sampler_engines.iter_mut() {
                    engine.all_notes_off();
                }
                ctx.vst3_flush_per_track.fill(true);
            }
            EngineCommand::AddDevice {
                track_index,
                slot_index,
                effect_type,
            } => {
                if ctx.deferred_topology.len() >= 1024 {
                    ctx.rt_debug_stats.record_topology_overflow();
                    let _ = ctx.deferred_topology.pop_front();
                }
                ctx.deferred_topology.push_back(DeferredTopologyCmd::Add {
                    track_index,
                    slot_index,
                    effect_type,
                });
            }
            EngineCommand::RemoveDevice {
                track_index,
                slot_index,
            } => {
                if ctx.deferred_topology.len() >= 1024 {
                    ctx.rt_debug_stats.record_topology_overflow();
                    let _ = ctx.deferred_topology.pop_front();
                }
                ctx.deferred_topology
                    .push_back(DeferredTopologyCmd::Remove {
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
                if track_index == MASTER_TRACK_INDEX {
                    ctx.master_device_chain
                        .set_param(slot_index as usize, param_index, value);
                } else {
                    let idx = track_index as usize;
                    if idx < ctx.render_ctx.track_slots.len() {
                        ctx.render_ctx.track_slots[idx].device_chain.set_param(
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
        ctx.render_ctx,
        &pending_track_volume,
        &pending_track_pan,
        &pending_track_mute,
        &pending_track_solo,
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
