use super::super::*;
use crate::driver::midi_dispatcher::{ActiveMappedNote, clamp_midi_pitch, quantize_to_scale};
use dream_clip_engine::midi_scheduler::{MidiScheduler, ScheduledNote};

#[allow(clippy::too_many_arguments)]
pub(super) fn render_sampler_sources(
    track_count: usize,
    midi_snap: &[MidiTrackRuntime],
    render_ctx: &mut RenderContext,
    sampler_engines: &mut [SamplerEngine],
    sample_rack_engines: &mut [SampleRackEngine],
    midi_note_states: &mut [MidiNoteMapState],
    midi_schedule_scratch: &mut Vec<ScheduledNote>,
    midi_schedule_tmp: &mut Vec<ScheduledNote>,
    midi_events_scratch: &mut Vec<(usize, u8, u8, u8, u64)>,
    vst3_rt_midi_queue: &mut [Vec<MidiEvent>],
    rt_midi_uid_counter: &mut u64,
    midi_chase_needed: bool,
    is_playing: bool,
    midi_playhead_pos: i64,
    frame_count: usize,
) {
    for track_idx in 0..track_count {
        if track_idx >= midi_snap.len() || track_idx >= sampler_engines.len() {
            continue;
        }

        if track_idx < render_ctx.track_slots.len()
            && render_ctx.track_slots[track_idx].instrument_bypassed
        {
            continue;
        }

        let midi_track = &midi_snap[track_idx];
        let engine = &mut sampler_engines[track_idx];
        let rack = &mut sample_rack_engines[track_idx];
        let slot = &mut render_ctx.track_slots[track_idx];

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
                midi_schedule_scratch,
                midi_schedule_tmp,
            );
        }

        let mut rack_active = false;
        for p in 0..16 {
            if let Some(pad) = rack.pad_mut(p)
                && pad.has_active_voices()
            {
                rack_active = true;
                break;
            }
        }

        let has_rt_midi =
            track_idx < vst3_rt_midi_queue.len() && !vst3_rt_midi_queue[track_idx].is_empty();

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

        midi_events_scratch.clear();
        for event in &*midi_schedule_scratch {
            if event.is_note_off {
                midi_events_scratch.push((
                    event.buffer_offset_end.min(fc),
                    0,
                    event.pitch,
                    event.velocity,
                    event.note_uid,
                ));
            }
            if event.is_note_on {
                midi_events_scratch.push((
                    event.buffer_onset.min(fc),
                    1,
                    event.pitch,
                    event.velocity,
                    event.note_uid,
                ));
            }
            if midi_chase_needed && !event.is_note_on && !event.is_note_off {
                midi_events_scratch.push((0, 1, event.pitch, event.velocity, event.note_uid));
            }
        }

        if track_idx < vst3_rt_midi_queue.len() {
            for evt in &vst3_rt_midi_queue[track_idx] {
                let raw_offset = evt.sample_offset.max(0) as usize;
                let offset = raw_offset.min(fc);
                if evt.is_note_off() {
                    midi_events_scratch.push((
                        offset,
                        0,
                        evt.note(),
                        evt.velocity(),
                        *rt_midi_uid_counter,
                    ));
                    *rt_midi_uid_counter = rt_midi_uid_counter.wrapping_add(1);
                } else if evt.is_note_on() {
                    midi_events_scratch.push((
                        offset,
                        1,
                        evt.note(),
                        evt.velocity(),
                        *rt_midi_uid_counter,
                    ));
                    *rt_midi_uid_counter = rt_midi_uid_counter.wrapping_add(1);
                }
            }
        }

        midi_events_scratch.sort_unstable_by(|a, b| {
            a.0.cmp(&b.0)
                .then_with(|| a.1.cmp(&b.1))
                .then_with(|| a.2.cmp(&b.2))
                .then_with(|| a.4.cmp(&b.4))
        });

        for &(frame, kind, pitch, velocity, event_uid) in &*midi_events_scratch {
            let seg = frame.saturating_sub(cursor).min(fc - cursor);
            if seg > 0 {
                if engine.has_active_voices() {
                    engine.render(
                        &mut slot.buf_left[cursor..cursor + seg],
                        &mut slot.buf_right[cursor..cursor + seg],
                        seg,
                    );
                }
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
                let mut pitch_i16 = pitch as i16;
                let mut velocity_i16 = velocity as i16;

                if fx.pitch_enabled {
                    pitch_i16 += fx.pitch_semitones as i16;
                }
                let mut mapped_pitch = clamp_midi_pitch(pitch_i16);

                if fx.scale_enabled {
                    mapped_pitch = quantize_to_scale(mapped_pitch, fx.scale_root, fx.scale_mask);
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
                        let signed = ((x >> 8) % ((span as u32) * 2 + 1)) as i16 - span;
                        mapped_pitch = clamp_midi_pitch(mapped_pitch as i16 + signed);
                    }
                }

                if fx.velocity_enabled {
                    velocity_i16 = ((velocity_i16 as f32) * fx.velocity_gain).round() as i16
                        + fx.velocity_offset as i16;
                }
                let mapped_velocity = velocity_i16.clamp(1, 127) as u8;

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

        if note_state.active_notes.len() > 128 {
            let excess = note_state.active_notes.len() - 128;
            note_state.active_notes.drain(..excess);
        }

        slot.active = true;
    }
}
