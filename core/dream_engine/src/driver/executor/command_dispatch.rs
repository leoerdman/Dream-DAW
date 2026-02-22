use super::super::*;

#[derive(Clone, Copy)]
pub(super) enum DeferredTopologyCmd {
    Add {
        track_index: u16,
        slot_index: u8,
        effect_type: u8,
    },
    Remove {
        track_index: u16,
        slot_index: u8,
    },
}

pub(super) fn apply_pending_track_mixer_state(
    render_ctx: &mut RenderContext,
    pending_track_volume: &[Option<f32>; MAX_TRACKS],
    pending_track_pan: &[Option<f32>; MAX_TRACKS],
    pending_track_mute: &[Option<bool>; MAX_TRACKS],
    pending_track_solo: &[Option<bool>; MAX_TRACKS],
    track_disabled: &mut [bool; MAX_TRACKS],
    track_soloed: &mut [bool; MAX_TRACKS],
    any_solo: &mut bool,
    routing_snapshot: &Arc<SharedRoutingSnapshot>,
) {
    for i in 0..render_ctx.track_slots.len().min(MAX_TRACKS) {
        if let Some(v) = pending_track_volume[i] {
            render_ctx.track_slots[i].strip.set_volume(v);
        }
        if let Some(p) = pending_track_pan[i] {
            render_ctx.track_slots[i].strip.set_pan(p);
        }
        if let Some(m) = pending_track_mute[i] {
            track_disabled[i] = m;
        }
        if let Some(s) = pending_track_solo[i] {
            track_soloed[i] = s;
        }
    }

    let has_pending_solo_or_mute = pending_track_solo
        .iter()
        .take(render_ctx.track_slots.len())
        .any(|v| v.is_some())
        || pending_track_mute
            .iter()
            .take(render_ctx.track_slots.len())
            .any(|v| v.is_some());
    if !has_pending_solo_or_mute {
        return;
    }

    let active_track_count = render_ctx.track_slots.len().min(MAX_TRACKS);
    let mut effective_soloed = [false; MAX_TRACKS];
    effective_soloed[..MAX_TRACKS].copy_from_slice(&track_soloed[..MAX_TRACKS]);
    let routing_now = routing_snapshot.load();

    for child_idx in 0..active_track_count {
        if !track_soloed[child_idx] {
            continue;
        }
        let mut visited = [0u64; 4];
        let mut current = child_idx;
        loop {
            let word = current / 64;
            let bit = current % 64;
            if word >= 4 || (visited[word] & (1u64 << bit)) != 0 {
                break;
            }
            visited[word] |= 1u64 << bit;
            match routing_now.get(current) {
                Some(Some(parent_idx)) if *parent_idx < active_track_count => {
                    effective_soloed[*parent_idx] = true;
                    current = *parent_idx;
                }
                _ => break,
            }
        }
    }

    for descendant_idx in 0..active_track_count {
        if effective_soloed[descendant_idx] {
            continue;
        }
        let mut visited = [0u64; 4];
        let mut current = descendant_idx;
        loop {
            let word = current / 64;
            let bit = current % 64;
            if word >= 4 || (visited[word] & (1u64 << bit)) != 0 {
                break;
            }
            visited[word] |= 1u64 << bit;
            match routing_now.get(current) {
                Some(Some(parent_idx)) if *parent_idx < active_track_count => {
                    if track_soloed[*parent_idx] {
                        effective_soloed[descendant_idx] = true;
                        break;
                    }
                    current = *parent_idx;
                }
                _ => break,
            }
        }
    }

    *any_solo = effective_soloed.iter().take(active_track_count).any(|s| *s);
    for i in 0..active_track_count {
        let enabled = !track_disabled[i] && (!*any_solo || effective_soloed[i]);
        render_ctx.track_slots[i].strip.set_output_enabled(enabled);
    }
}

pub(super) fn apply_single_topology_mutation(
    deferred_topology: &mut VecDeque<DeferredTopologyCmd>,
    master_device_chain: &mut DeviceChain,
    render_ctx: &mut RenderContext,
    master_track_index: u16,
) {
    let Some(topology_cmd) = deferred_topology.pop_front() else {
        return;
    };
    match topology_cmd {
        DeferredTopologyCmd::Add {
            track_index,
            slot_index,
            effect_type,
        } => {
            let idx = track_index as usize;
            if track_index == master_track_index {
                if let Some(etype) = BuiltinEffectType::from_u8(effect_type) {
                    master_device_chain.add_device(slot_index as usize, etype);
                }
            } else if idx < render_ctx.track_slots.len()
                && let Some(etype) = BuiltinEffectType::from_u8(effect_type)
            {
                render_ctx.track_slots[idx]
                    .device_chain
                    .add_device(slot_index as usize, etype);
            }
        }
        DeferredTopologyCmd::Remove {
            track_index,
            slot_index,
        } => {
            let idx = track_index as usize;
            if track_index == master_track_index {
                master_device_chain.remove_device(slot_index as usize);
            } else if idx < render_ctx.track_slots.len() {
                render_ctx.track_slots[idx]
                    .device_chain
                    .remove_device(slot_index as usize);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn dispatch_engine_command(
    cmd: EngineCommand,
    is_playing: &mut bool,
    render_ctx: &mut RenderContext,
    sampler_engines: &mut [SamplerEngine],
    sample_rack_engines: &mut [SampleRackEngine],
    midi_note_states: &mut [MidiNoteMapState],
    vst3_flush_per_track: &mut [bool; MAX_TRACKS],
    test_tone_phase: &mut f64,
    test_tone_target_freq: &mut f32,
    test_tone_enabled: &mut bool,
    midi_chase_needed: &mut bool,
    bpm: &mut f64,
    time_sig_numerator: &mut u8,
    time_sig_denominator: &mut u8,
    last_loop_region: &mut Option<LoopRegion>,
    pending_track_volume: &mut [Option<f32>; MAX_TRACKS],
    pending_track_pan: &mut [Option<f32>; MAX_TRACKS],
    pending_track_mute: &mut [Option<bool>; MAX_TRACKS],
    pending_track_solo: &mut [Option<bool>; MAX_TRACKS],
    master_gain_target: &mut f32,
    vst3_rt_midi_queue: &mut [Vec<MidiEvent>],
    deferred_topology: &mut VecDeque<DeferredTopologyCmd>,
    master_device_chain: &mut DeviceChain,
    master_track_index: u16,
    rt_debug_stats: &SharedRtDebugStats,
    clock: &MasterClock,
) {
    match cmd {
        EngineCommand::SetPlay(play) => {
            *is_playing = play;
            render_ctx.playhead.set_advancing(play);
            if !play {
                for idx in 0..sampler_engines.len() {
                    sampler_engines[idx].all_notes_off();
                    sample_rack_engines[idx].all_notes_off();
                    midi_note_states[idx].active_notes.clear();
                    midi_note_states[idx].rng_state = 0xA5A5_1337;
                }
                vst3_flush_per_track.fill(true);
                *test_tone_phase = 0.0;
                *test_tone_enabled = false;
                render_ctx.meter_bank.reset_all();
            }
        }
        EngineCommand::SetFreq(freq) => {
            *test_tone_target_freq = freq.clamp(20.0, 20_000.0);
            *test_tone_enabled = true;
        }
        EngineCommand::Seek(frame) => {
            let safe_frame = frame.max(0);
            clock.set_position(safe_frame);
            render_ctx.playhead.seek(safe_frame);
            for idx in 0..sampler_engines.len() {
                sampler_engines[idx].all_notes_off();
                sample_rack_engines[idx].all_notes_off();
                midi_note_states[idx].active_notes.clear();
                midi_note_states[idx].rng_state = 0xA5A5_1337;
            }
            vst3_flush_per_track.fill(true);
            *midi_chase_needed = true;
        }
        EngineCommand::SetBpm(new_bpm) => {
            *bpm = new_bpm.clamp(10.0, 999.0);
        }
        EngineCommand::SetTimeSignature {
            numerator,
            denominator,
        } => {
            *time_sig_numerator = numerator.max(1);
            *time_sig_denominator = denominator.max(1);
        }
        EngineCommand::SetBpmAndLoop {
            bpm: new_bpm,
            loop_enabled,
            loop_region,
        } => {
            *bpm = new_bpm.clamp(10.0, 999.0);
            if !loop_enabled {
                render_ctx.loop_region = None;
            } else if let Some((start, end)) = loop_region {
                let region = LoopRegion { start, end };
                *last_loop_region = Some(region.clone());
                render_ctx.loop_region = Some(region);
            } else if let Some(lr) = last_loop_region.as_ref() {
                render_ctx.loop_region = Some(lr.clone());
            }
        }
        EngineCommand::SetTimelineSampleRate(sample_rate) => {
            render_ctx.set_timeline_sample_rate(sample_rate);
        }
        EngineCommand::SetLoopEnabled(enabled) => {
            if !enabled {
                render_ctx.loop_region = None;
            } else if let Some(lr) = last_loop_region.as_ref() {
                render_ctx.loop_region = Some(lr.clone());
            }
        }
        EngineCommand::SetLoopRegion { start, end } => {
            if end > start {
                let region = LoopRegion { start, end };
                *last_loop_region = Some(region.clone());
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
            *master_gain_target = volume.clamp(0.0, 2.0);
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
            if idx < sampler_engines.len() {
                sampler_engines[idx].note_on(pitch, velocity);
            }
            if idx < sample_rack_engines.len() {
                sample_rack_engines[idx].note_on(pitch, velocity);
            }
            if idx < vst3_rt_midi_queue.len() && vst3_rt_midi_queue[idx].len() < 256 {
                vst3_rt_midi_queue[idx].push(MidiEvent::note_on(0, 0, pitch, velocity));
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
            if idx < vst3_rt_midi_queue.len() && vst3_rt_midi_queue[idx].len() < 256 {
                vst3_rt_midi_queue[idx].push(MidiEvent::note_off(0, 0, pitch, 0));
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
                sampler_engines[idx].set_waveform(Waveform::from_u8(waveform));
            }
        }
        EngineCommand::SetSamplerOsc2Waveform {
            track_index,
            waveform,
        } => {
            let idx = track_index as usize;
            if idx < sampler_engines.len() {
                sampler_engines[idx].set_waveform2(Waveform::from_u8(waveform));
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
        EngineCommand::SetSamplerLfoTarget { track_index, target } => {
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
            if bypassed && idx < sampler_engines.len() {
                sampler_engines[idx].all_notes_off();
            }
            if bypassed && idx < sample_rack_engines.len() {
                sample_rack_engines[idx].all_notes_off();
            }
            if bypassed && idx < MAX_TRACKS {
                vst3_flush_per_track[idx] = true;
            }
        }
        EngineCommand::SetSampleRackPadVolume {
            track_index,
            pad_index,
            volume,
        } => {
            if let Some(engine) = sample_rack_engines.get_mut(track_index as usize)
                && let Some(pad) = engine.pad_mut(pad_index as usize)
            {
                pad.volume = volume;
            }
        }
        EngineCommand::SetSampleRackPadMute { .. } => {}
        EngineCommand::SetSampleRackPadSolo { .. } => {}
        EngineCommand::SetSampleRackPadAdsr {
            track_index,
            pad_index,
            attack,
            decay,
            sustain,
            release,
        } => {
            if let Some(engine) = sample_rack_engines.get_mut(track_index as usize)
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
            if let Some(engine) = sample_rack_engines.get_mut(track_index as usize)
                && let Some(pad) = engine.pad_mut(pad_index as usize)
            {
                pad.set_filter_cutoff(cutoff);
            }
        }
        EngineCommand::Shutdown => {
            *is_playing = false;
            *test_tone_phase = 0.0;
            for engine in sampler_engines.iter_mut() {
                engine.all_notes_off();
            }
            vst3_flush_per_track.fill(true);
        }
        EngineCommand::AddDevice {
            track_index,
            slot_index,
            effect_type,
        } => {
            if deferred_topology.len() >= 1024 {
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
            if track_index == master_track_index {
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
            if track_index == master_track_index {
                master_device_chain.set_param(slot_index as usize, param_index, value);
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
