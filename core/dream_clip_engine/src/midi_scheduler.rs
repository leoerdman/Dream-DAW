// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — MIDI Note Scheduler
// ═══════════════════════════════════════════════════════════════════════════
//
// Determines which MIDI notes from MidiClips are active (note-on/note-off)
// within the current playback buffer window.
//
// Similar to ClipScheduler but operates on MidiClip → MidiNote events
// rather than AudioClip → audio sample data.
//
// Real-Time Safety:
//   - Returns Vec (allocated once per buffer, not per-sample)
//   - All iteration is bounded by clip/note counts
//   - No I/O, no locks, no panics
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::scheduler::LoopRegion;
use dream_models::midi::MidiClip;

/// A MIDI note event scheduled for the current buffer.
///
/// Contains timing relative to the output buffer for sample-accurate triggering.
#[derive(Debug, Clone, Copy)]
pub struct ScheduledNote {
    /// The MIDI note data.
    pub pitch: u8,
    pub velocity: u8,

    /// Frame offset within the current buffer where this note starts.
    /// For notes that started before this buffer, this is 0.
    pub buffer_onset: usize,

    /// Frame offset within the current buffer where this note ends.
    /// For notes that extend beyond this buffer, this equals `frame_count`.
    pub buffer_offset_end: usize,

    /// Whether this note is starting in this buffer (trigger note-on).
    pub is_note_on: bool,

    /// Whether this note is ending in this buffer (trigger note-off).
    pub is_note_off: bool,
}

/// Schedules MIDI notes from clips for the current playback buffer.
pub struct MidiScheduler;

impl MidiScheduler {
    /// Fills caller-provided output with active MIDI notes (zero alloc reuse).
    pub fn fill_active(
        clips: &[MidiClip],
        playhead_pos: i64,
        frame_count: usize,
        out: &mut Vec<ScheduledNote>,
    ) {
        out.clear();
        let buffer_end = playhead_pos + frame_count as i64;

        for clip in clips {
            // Skip muted clips — they remain visible but produce no MIDI output.
            if clip.is_muted {
                continue;
            }

            let clip_start = clip.position.sample_frame;
            let clip_end = clip.end_position().sample_frame;

            // Skip clips entirely outside the buffer window.
            if clip_end <= playhead_pos || clip_start >= buffer_end {
                continue;
            }

            for note in &clip.notes {
                let note_abs_start = clip_start + note.start_frame;
                let note_abs_end = clip_start + note.end_frame();

                if note_abs_end <= playhead_pos || note_abs_start >= buffer_end {
                    continue;
                }

                let onset = if note_abs_start >= playhead_pos {
                    (note_abs_start - playhead_pos) as usize
                } else {
                    0
                };

                let offset_end = if note_abs_end <= buffer_end {
                    (note_abs_end - playhead_pos) as usize
                } else {
                    frame_count
                };

                let is_note_on = note_abs_start >= playhead_pos && note_abs_start < buffer_end;
                let is_note_off = note_abs_end > playhead_pos && note_abs_end <= buffer_end;

                let clip_fade_in = clip.fade_in_frames.max(0) as f64;
                let clip_fade_out = clip.fade_out_frames.max(0) as f64;
                let clip_len = clip.duration.sample_frame.max(1) as f64;
                let note_pos_in_clip = note.start_frame.max(0) as f64;
                let fade_in_gain = if clip_fade_in > 0.0 {
                    (note_pos_in_clip / clip_fade_in).clamp(0.0, 1.0)
                } else {
                    1.0
                };
                let dist_to_end = (clip_len - note_pos_in_clip).max(0.0);
                let fade_out_gain = if clip_fade_out > 0.0 {
                    (dist_to_end / clip_fade_out).clamp(0.0, 1.0)
                } else {
                    1.0
                };
                let velocity_scaled = ((note.velocity as f64) * fade_in_gain.min(fade_out_gain))
                    .round()
                    .clamp(1.0, 127.0) as u8;

                out.push(ScheduledNote {
                    pitch: note.pitch,
                    velocity: velocity_scaled,
                    buffer_onset: onset.min(frame_count),
                    buffer_offset_end: offset_end.min(frame_count),
                    is_note_on,
                    is_note_off,
                });
            }
        }

        out.sort_by(|a, b| {
            a.buffer_onset
                .cmp(&b.buffer_onset)
                .then_with(|| a.is_note_on.cmp(&b.is_note_on))
                .then_with(|| a.pitch.cmp(&b.pitch))
        });
    }

    /// Finds all MIDI notes active within the current buffer window.
    ///
    /// # Arguments
    /// - `clips`: All MIDI clips on a track.
    /// - `playhead_pos`: Current playhead position (sample frames, absolute).
    /// - `frame_count`: Size of the current buffer in frames.
    ///
    /// # Returns
    /// A list of `ScheduledNote` events to process this buffer.
    /// Notes are sorted by `buffer_onset` for sequential processing.
    pub fn find_active(
        clips: &[MidiClip],
        playhead_pos: i64,
        frame_count: usize,
    ) -> Vec<ScheduledNote> {
        let mut events = Vec::new();
        Self::fill_active(clips, playhead_pos, frame_count, &mut events);
        events
    }

    /// Loop-aware MIDI scheduling into caller-provided scratch output.
    pub fn fill_active_looped_with_tmp(
        clips: &[MidiClip],
        playhead_pos: i64,
        frame_count: usize,
        loop_region: Option<&LoopRegion>,
        out: &mut Vec<ScheduledNote>,
        tmp: &mut Vec<ScheduledNote>,
    ) {
        let lr = match loop_region {
            Some(lr) if lr.is_valid() => lr,
            _ => {
                Self::fill_active(clips, playhead_pos, frame_count, out);
                return;
            }
        };

        let buffer_end = playhead_pos + frame_count as i64;
        if buffer_end <= lr.end {
            Self::fill_active(clips, playhead_pos, frame_count, out);
            return;
        }

        let pre_wrap_frames = (lr.end - playhead_pos).max(0) as usize;
        let post_wrap_frames = frame_count.saturating_sub(pre_wrap_frames);

        out.clear();
        if pre_wrap_frames > 0 {
            Self::fill_active(clips, playhead_pos, pre_wrap_frames, out);
        }

        if post_wrap_frames > 0 {
            Self::fill_active(clips, lr.start, post_wrap_frames, tmp);
            for mut note in tmp.iter().copied() {
                note.buffer_onset += pre_wrap_frames;
                note.buffer_offset_end += pre_wrap_frames;
                note.buffer_onset = note.buffer_onset.min(frame_count);
                note.buffer_offset_end = note.buffer_offset_end.min(frame_count);
                out.push(note);
            }
        }

        out.sort_by(|a, b| {
            a.buffer_onset
                .cmp(&b.buffer_onset)
                .then_with(|| a.is_note_on.cmp(&b.is_note_on))
                .then_with(|| a.pitch.cmp(&b.pitch))
        });
    }

    /// Loop-aware MIDI scheduling into caller-provided scratch output.
    pub fn fill_active_looped(
        clips: &[MidiClip],
        playhead_pos: i64,
        frame_count: usize,
        loop_region: Option<&LoopRegion>,
        out: &mut Vec<ScheduledNote>,
    ) {
        let mut tmp = Vec::new();
        Self::fill_active_looped_with_tmp(
            clips,
            playhead_pos,
            frame_count,
            loop_region,
            out,
            &mut tmp,
        );
    }

    /// Loop-aware MIDI note scheduling.
    ///
    /// When the buffer window crosses the loop end boundary, the buffer is
    /// split into two segments:
    ///   1. **Pre-wrap**: from `playhead_pos` to `loop_region.end`
    ///   2. **Post-wrap**: from `loop_region.start` for the remaining frames
    ///
    /// Notes in both segments are scheduled with correct buffer offsets.
    /// This mirrors `ClipScheduler::fill_active_looped_with_tmp()` for audio.
    ///
    /// Without this, MIDI notes exactly at the first beat of the loop
    /// would be missed after the loop restarts.
    pub fn find_active_looped(
        clips: &[MidiClip],
        playhead_pos: i64,
        frame_count: usize,
        loop_region: Option<&LoopRegion>,
    ) -> Vec<ScheduledNote> {
        let mut events = Vec::new();
        Self::fill_active_looped(clips, playhead_pos, frame_count, loop_region, &mut events);
        events
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use dream_models::midi::MidiNote;
    use dream_models::time::AbsoluteTime;

    fn make_midi_clip(pos: i64, dur: i64, notes: Vec<MidiNote>) -> MidiClip {
        let mut clip = MidiClip::new("Test", AbsoluteTime::new(pos), AbsoluteTime::new(dur));
        clip.notes = notes;
        clip
    }

    #[test]
    fn note_inside_buffer() {
        let clip = make_midi_clip(
            0,
            44100,
            vec![
                MidiNote::new(60, 100, 100, 500), // starts at frame 100, 500 frames long
            ],
        );

        let events = MidiScheduler::find_active(&[clip], 0, 1024);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].pitch, 60);
        assert_eq!(events[0].buffer_onset, 100);
        assert!(events[0].is_note_on);
        assert!(events[0].is_note_off); // ends at 600, within 1024
    }

    #[test]
    fn note_spans_buffer() {
        let clip = make_midi_clip(
            0,
            44100,
            vec![
                MidiNote::new(64, 80, 0, 44100), // spans entire clip
            ],
        );

        let events = MidiScheduler::find_active(&[clip], 512, 1024);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].buffer_onset, 0); // already started
        assert!(!events[0].is_note_on); // started before buffer
        assert!(!events[0].is_note_off); // ends after buffer
    }

    #[test]
    fn note_before_buffer() {
        let clip = make_midi_clip(
            0,
            44100,
            vec![
                MidiNote::new(60, 100, 0, 100), // ends at frame 100
            ],
        );

        let events = MidiScheduler::find_active(&[clip], 200, 1024);
        assert!(events.is_empty()); // note ended before buffer
    }

    #[test]
    fn note_after_buffer() {
        let clip = make_midi_clip(0, 44100, vec![MidiNote::new(60, 100, 2000, 500)]);

        let events = MidiScheduler::find_active(&[clip], 0, 1024);
        assert!(events.is_empty()); // note starts after buffer
    }

    #[test]
    fn multiple_notes_sorted_by_onset() {
        let clip = make_midi_clip(
            0,
            44100,
            vec![
                MidiNote::new(60, 100, 500, 200),
                MidiNote::new(64, 100, 100, 200),
                MidiNote::new(67, 100, 300, 200),
            ],
        );

        let events = MidiScheduler::find_active(&[clip], 0, 1024);
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].pitch, 64); // onset=100 (first)
        assert_eq!(events[1].pitch, 67); // onset=300
        assert_eq!(events[2].pitch, 60); // onset=500
    }

    #[test]
    fn clip_offset_applied() {
        // Clip starts at absolute frame 10000
        let clip = make_midi_clip(
            10000,
            44100,
            vec![
                MidiNote::new(60, 100, 100, 500), // absolute: 10100–10600
            ],
        );

        // Buffer at 10000..11024
        let events = MidiScheduler::find_active(&[clip], 10000, 1024);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].buffer_onset, 100); // 10100 - 10000
        assert!(events[0].is_note_on);
    }

    #[test]
    fn empty_clip_returns_empty() {
        let clip = make_midi_clip(0, 44100, vec![]);
        let events = MidiScheduler::find_active(&[clip], 0, 1024);
        assert!(events.is_empty());
    }

    #[test]
    fn notes_with_same_onset_are_sorted_by_pitch_as_tie_break() {
        let clip = make_midi_clip(
            0,
            44100,
            vec![
                MidiNote::new(67, 110, 100, 200),
                MidiNote::new(60, 100, 100, 200),
            ],
        );

        let events = MidiScheduler::find_active(&[clip], 0, 256);
        let at_100: Vec<_> = events.iter().filter(|e| e.buffer_onset == 100).collect();
        assert_eq!(at_100.len(), 2);
        assert_eq!(at_100[0].pitch, 60);
        assert_eq!(at_100[1].pitch, 67);
    }

    // ── Loop-Aware Scheduling Tests ────────────────────────────────────

    #[test]
    fn looped_no_wrap_same_as_standard() {
        let clip = make_midi_clip(0, 44100, vec![MidiNote::new(60, 100, 100, 500)]);
        let lr = LoopRegion::new(0, 44100);

        let standard = MidiScheduler::find_active(&[clip.clone()], 0, 1024);
        let looped = MidiScheduler::find_active_looped(&[clip], 0, 1024, Some(&lr));

        assert_eq!(standard.len(), looped.len());
        assert_eq!(standard[0].pitch, looped[0].pitch);
        assert_eq!(standard[0].buffer_onset, looped[0].buffer_onset);
    }

    #[test]
    fn looped_note_at_loop_start_after_wrap() {
        // This is the exact bug scenario:
        // Loop region: 0..4000, Clip: 0..4000
        // Kick note at frame 0 (first beat of the loop)
        // Playhead at 3800, buffer size 512 → crosses loop end at 4000
        // Pre-wrap: 3800..4000 (200 frames)
        // Post-wrap: 0..312 (from loop start)
        // The kick at frame 0 MUST be scheduled in the post-wrap segment.
        let clip = make_midi_clip(
            0,
            4000,
            vec![
                MidiNote::new(36, 100, 0, 200), // Kick at frame 0, 200 frames long
            ],
        );
        let lr = LoopRegion::new(0, 4000);

        let events = MidiScheduler::find_active_looped(&[clip], 3800, 512, Some(&lr));

        // Should find the note in the post-wrap segment
        assert_eq!(events.len(), 1, "Kick at loop start must be scheduled");
        assert_eq!(events[0].pitch, 36);
        assert!(events[0].is_note_on, "Must trigger note-on");
        // Buffer onset should be at pre_wrap_frames (200) + note offset (0) = 200
        assert_eq!(events[0].buffer_onset, 200);
    }

    #[test]
    fn looped_notes_both_segments() {
        // Note near loop end AND note at loop start
        let clip = make_midi_clip(
            0,
            4000,
            vec![
                MidiNote::new(36, 100, 0, 200),   // At frame 0 (loop start)
                MidiNote::new(42, 100, 3900, 50), // Near loop end
            ],
        );
        let lr = LoopRegion::new(0, 4000);

        // Playhead at 3800, buffer 512: pre-wrap 200 frames, post-wrap 312 frames
        let events = MidiScheduler::find_active_looped(&[clip], 3800, 512, Some(&lr));

        assert_eq!(events.len(), 2, "Should schedule notes from both segments");
        // First should be the hi-hat near loop end (onset = 3900 - 3800 = 100)
        assert_eq!(events[0].pitch, 42);
        assert_eq!(events[0].buffer_onset, 100);
        // Second should be the kick at loop start (onset = 200 + 0 = 200)
        assert_eq!(events[1].pitch, 36);
        assert_eq!(events[1].buffer_onset, 200);
    }

    #[test]
    fn looped_no_region_falls_back() {
        let clip = make_midi_clip(0, 44100, vec![MidiNote::new(60, 100, 100, 500)]);
        let events = MidiScheduler::find_active_looped(&[clip], 0, 1024, None);
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn looped_with_offset_loop_region() {
        // Loop region doesn't start at 0
        // Loop: 10000..14000, clip: 10000..14000
        // Note at frame 0 inside clip (absolute frame 10000 = loop start)
        let clip = make_midi_clip(
            10000,
            4000,
            vec![
                MidiNote::new(60, 100, 0, 200), // absolute: 10000..10200
            ],
        );
        let lr = LoopRegion::new(10000, 14000);

        // Playhead at 13800, buffer 512 → crosses 14000
        // Pre-wrap: 200 frames (13800..14000)
        // Post-wrap: 312 frames (10000..10312)
        let events = MidiScheduler::find_active_looped(&[clip], 13800, 512, Some(&lr));

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].pitch, 60);
        assert!(events[0].is_note_on);
        assert_eq!(events[0].buffer_onset, 200);
    }
}
