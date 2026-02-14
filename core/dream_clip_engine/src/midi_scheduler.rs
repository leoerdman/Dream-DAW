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
        let buffer_end = playhead_pos + frame_count as i64;
        let mut events = Vec::new();

        for clip in clips {
            // Skip muted clips — they remain visible but produce no MIDI output.
            if clip.is_muted {
                continue;
            }

            let clip_start = clip.position.sample_frame;
            let clip_end = clip.end_position().sample_frame;

            // Skip clips entirely outside the buffer window
            if clip_end <= playhead_pos || clip_start >= buffer_end {
                continue;
            }

            // Process each note in this clip
            for note in &clip.notes {
                // Convert note positions from clip-relative to absolute
                let note_abs_start = clip_start + note.start_frame;
                let note_abs_end = clip_start + note.end_frame();

                // Skip notes entirely outside buffer
                if note_abs_end <= playhead_pos || note_abs_start >= buffer_end {
                    continue;
                }

                // Calculate buffer-relative positions
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

                // Clip fades for MIDI clips: scale note-on velocity by fade envelope
                // at the note start position inside the clip.
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

                events.push(ScheduledNote {
                    pitch: note.pitch,
                    velocity: velocity_scaled,
                    buffer_onset: onset.min(frame_count),
                    buffer_offset_end: offset_end.min(frame_count),
                    is_note_on,
                    is_note_off,
                });
            }
        }

        // Sort by onset time for sequential processing
        events.sort_by_key(|e| e.buffer_onset);
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
        let mut clip = MidiClip::new(
            "Test",
            AbsoluteTime::new(pos),
            AbsoluteTime::new(dur),
        );
        clip.notes = notes;
        clip
    }

    #[test]
    fn note_inside_buffer() {
        let clip = make_midi_clip(0, 44100, vec![
            MidiNote::new(60, 100, 100, 500), // starts at frame 100, 500 frames long
        ]);

        let events = MidiScheduler::find_active(&[clip], 0, 1024);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].pitch, 60);
        assert_eq!(events[0].buffer_onset, 100);
        assert!(events[0].is_note_on);
        assert!(events[0].is_note_off); // ends at 600, within 1024
    }

    #[test]
    fn note_spans_buffer() {
        let clip = make_midi_clip(0, 44100, vec![
            MidiNote::new(64, 80, 0, 44100), // spans entire clip
        ]);

        let events = MidiScheduler::find_active(&[clip], 512, 1024);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].buffer_onset, 0); // already started
        assert!(!events[0].is_note_on); // started before buffer
        assert!(!events[0].is_note_off); // ends after buffer
    }

    #[test]
    fn note_before_buffer() {
        let clip = make_midi_clip(0, 44100, vec![
            MidiNote::new(60, 100, 0, 100), // ends at frame 100
        ]);

        let events = MidiScheduler::find_active(&[clip], 200, 1024);
        assert!(events.is_empty()); // note ended before buffer
    }

    #[test]
    fn note_after_buffer() {
        let clip = make_midi_clip(0, 44100, vec![
            MidiNote::new(60, 100, 2000, 500),
        ]);

        let events = MidiScheduler::find_active(&[clip], 0, 1024);
        assert!(events.is_empty()); // note starts after buffer
    }

    #[test]
    fn multiple_notes_sorted_by_onset() {
        let clip = make_midi_clip(0, 44100, vec![
            MidiNote::new(60, 100, 500, 200),
            MidiNote::new(64, 100, 100, 200),
            MidiNote::new(67, 100, 300, 200),
        ]);

        let events = MidiScheduler::find_active(&[clip], 0, 1024);
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].pitch, 64); // onset=100 (first)
        assert_eq!(events[1].pitch, 67); // onset=300
        assert_eq!(events[2].pitch, 60); // onset=500
    }

    #[test]
    fn clip_offset_applied() {
        // Clip starts at absolute frame 10000
        let clip = make_midi_clip(10000, 44100, vec![
            MidiNote::new(60, 100, 100, 500), // absolute: 10100–10600
        ]);

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
}
