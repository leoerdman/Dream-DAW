use crate::driver::midi_dispatcher::{PluginNoteTracker, clamp_midi_pitch, quantize_to_scale};
use dream_clip_engine::midi_scheduler::{MidiScheduler, ScheduledNote};
use dream_plugins::MidiEvent;
use crate::frame_domain::FrameDomainConverter;
use crate::driver::snapshots::MidiTrackRuntime;

/// Sorts MIDI events for VST processing:
///   1. CC events (0xBn) → flush/reset
///   2. Note-off (0x8n) → release stale notes
///   3. Note-on  (0x9n) → trigger new notes
#[inline]
pub(crate) fn midi_sort_priority(status: u8) -> u8 {
    match status & 0xF0 {
        0xB0 => 0, // CC (flush)
        0x80 => 1, // Note-off
        0x90 => 2, // Note-on
        _    => 3, // Other
    }
}

#[allow(clippy::too_many_arguments)]
#[allow(clippy::collapsible_if)]
pub(crate) fn process_midi_events(
    midi_track: &MidiTrackRuntime,
    midi_playhead_pos: i64,
    timeline_frame_count: usize,
    loop_region: Option<(i64, i64)>,
    frame_converter: &FrameDomainConverter,
    midi_schedule_scratch: &mut Vec<ScheduledNote>,
    midi_schedule_tmp: &mut Vec<ScheduledNote>,
    vst3_midi_scratch: &mut Vec<MidiEvent>,
    mut tracker: Option<&mut PluginNoteTracker>,
) -> Option<usize> {
    let fx = &midi_track.fx;
    let mut split_offset_device = None;

    midi_schedule_scratch.clear();
    MidiScheduler::fill_active_looped_with_tmp(
        &midi_track.clips,
        midi_playhead_pos,
        timeline_frame_count,
        loop_region,
        midi_schedule_scratch,
        midi_schedule_tmp,
    );

    // LOOP-WRAP-FIX (Enterprise): Handle All Sound/Notes Off at loop boundaries
    if let Some(lr) = loop_region {
        let buffer_end_timeline = midi_playhead_pos.saturating_add(timeline_frame_count as i64);
        if midi_playhead_pos < lr.1 && buffer_end_timeline > lr.1 {
            let wrap_offset_timeline = (lr.1 - midi_playhead_pos) as usize;
            let wrap_offset = frame_converter.timeline_to_device_offset(wrap_offset_timeline);
            split_offset_device = Some(wrap_offset);
            let flush_offset = (wrap_offset as i32).saturating_sub(1).max(0);
            vst3_midi_scratch.push(MidiEvent::cc(flush_offset, 0, 120, 0));
            vst3_midi_scratch.push(MidiEvent::cc(flush_offset, 0, 123, 0));
            // Clear the note tracker so post-wrap note-ons don't trigger stale note-offs.
            if let Some(ref mut t) = tracker {
                t.active.clear();
            }
        }
    }

    for event in midi_schedule_scratch.iter() {
        let offset_on = frame_converter.timeline_to_device_offset_i32(event.buffer_onset);
        let offset_off = frame_converter.timeline_to_device_offset_i32(event.buffer_offset_end);

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
            vst3_midi_scratch.push(MidiEvent::note_off(offset_off, 0, off_pitch, 0));
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
                mapped_pitch = quantize_to_scale(mapped_pitch, fx.scale_root, fx.scale_mask);
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
                        let signed = ((x >> 8) % ((span as u32) * 2 + 1)) as i16 - span;
                        mapped_pitch = clamp_midi_pitch(mapped_pitch as i16 + signed);
                    }
                }
            }

            if fx.velocity_enabled {
                velocity_i16 = ((velocity_i16 as f32) * fx.velocity_gain).round() as i16 + fx.velocity_offset as i16;
            }
            let mapped_velocity = velocity_i16.clamp(1, 127) as u8;

            if let Some(ref mut t) = tracker {
                if let Some(_dup_off) = t.note_on(mapped_pitch, 0) {
                    vst3_midi_scratch.push(MidiEvent::note_off(
                        offset_on.saturating_sub(1).max(0),
                        0,
                        mapped_pitch,
                        0,
                    ));
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

    vst3_midi_scratch.sort_unstable_by(|a, b| {
        a.sample_offset.cmp(&b.sample_offset).then_with(|| {
            midi_sort_priority(a.data[0]).cmp(&midi_sort_priority(b.data[0]))
        })
    });

    split_offset_device
}
