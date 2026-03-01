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
use num_traits::ToPrimitive;
/// A MIDI note event scheduled for the current buffer.
///
/// Contains timing relative to the output buffer for sample-accurate triggering.
#[derive(Debug, Clone, Copy)]
pub struct ScheduledNote {
    /// The MIDI note data.
    pub pitch: u8,
    pub velocity: u8,
    /// Stable note identity for pairing note-on/off across loop wraps.
    pub note_uid: u64,
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
    #[inline]
    fn i64_nonneg_to_usize(value: i64) -> usize {
        usize::try_from(value.max(0)).unwrap_or(usize::MAX)
    }
    #[inline]
    fn velocity_with_fades(raw_velocity: u8, fade_gain: f64) -> u8 {
        let scaled = (f64::from(raw_velocity) * fade_gain)
            .round()
            .clamp(0.0, 127.0);
        scaled.to_u8().unwrap_or(127).min(127)
    }
    #[inline]
    fn note_uid(clip: &MidiClip, note: &dream_models::midi::MidiNote) -> u64 {
        let clip_u128 = clip.id.as_u128();
        let clip_lo = u64::try_from(clip_u128 & u128::from(u64::MAX)).unwrap_or(u64::MAX);
        let clip_hi = u64::try_from(clip_u128 >> 64).unwrap_or(0);
        let mut x = clip_lo.wrapping_mul(0x9E3779B185EBCA87) ^ clip_hi;
        x ^= u64::from(note.pitch) << 56;
        let start = u64::try_from(note.start_frame).unwrap_or(0);
        let duration = u64::try_from(note.duration_frames).unwrap_or(0);
        x ^= start.rotate_left(17);
        x ^= duration.rotate_left(41);
        // splitmix64 finalizer
        x ^= x >> 30;
        x = x.wrapping_mul(0xbf58476d1ce4e5b9);
        x ^= x >> 27;
        x = x.wrapping_mul(0x94d049bb133111eb);
        x ^ (x >> 31)
    }
    #[inline]
    fn sort_and_dedup(events: &mut Vec<ScheduledNote>) {
        events.sort_by(|a, b| {
            a.buffer_onset
                .cmp(&b.buffer_onset)
                .then_with(|| a.buffer_offset_end.cmp(&b.buffer_offset_end))
                .then_with(|| a.is_note_on.cmp(&b.is_note_on))
                .then_with(|| a.is_note_off.cmp(&b.is_note_off))
                .then_with(|| a.pitch.cmp(&b.pitch))
                .then_with(|| a.note_uid.cmp(&b.note_uid))
        });
        if events.len() <= 1 {
            return;
        }
        let mut write = 0usize;
        for read in 0..events.len() {
            if write > 0 {
                let prev = events[write - 1];
                let curr = events[read];
                if prev.buffer_onset == curr.buffer_onset
                    && prev.buffer_offset_end == curr.buffer_offset_end
                    && prev.is_note_on == curr.is_note_on
                    && prev.is_note_off == curr.is_note_off
                    && prev.pitch == curr.pitch
                    && prev.note_uid == curr.note_uid
                {
                    if curr.velocity > events[write - 1].velocity {
                        events[write - 1].velocity = curr.velocity;
                    }
                    continue;
                }
            }
            if write != read {
                events[write] = events[read];
            }
            write += 1;
        }
        events.truncate(write);
    }
    /// Fills caller-provided output with active MIDI notes (zero alloc reuse).
    pub fn fill_active(
        clips: &[MidiClip],
        playhead_pos: i64,
        frame_count: usize,
        out: &mut Vec<ScheduledNote>,
    ) {
        out.clear();
        // BUG-021 FIX: saturating_add prevents i64 overflow in long sessions
        // (matching ClipScheduler::fill_active which already has this guard).
        let frame_count_i64 = i64::try_from(frame_count).unwrap_or(i64::MAX);
        let buffer_end = playhead_pos.saturating_add(frame_count_i64);
        for clip in clips {
            // Skip muted clips — they remain visible but produce no MIDI output.
            if clip.is_disabled {
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
                    Self::i64_nonneg_to_usize(note_abs_start - playhead_pos)
                } else {
                    0
                };
                let offset_end = if note_abs_end <= buffer_end {
                    Self::i64_nonneg_to_usize(note_abs_end - playhead_pos)
                } else {
                    frame_count
                };
                let is_note_on = note_abs_start >= playhead_pos && note_abs_start < buffer_end;
                let is_note_off = note_abs_end > playhead_pos && note_abs_end <= buffer_end;
                let clip_fade_in = clip.fade_in_frames.max(0).to_f64().unwrap_or(0.0);
                let clip_fade_out = clip.fade_out_frames.max(0).to_f64().unwrap_or(0.0);
                let clip_len = clip.duration.sample_frame.max(1).to_f64().unwrap_or(1.0);
                let note_pos_in_clip = note.start_frame.max(0).to_f64().unwrap_or(0.0);
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
                let velocity_scaled =
                    Self::velocity_with_fades(note.velocity, fade_in_gain.min(fade_out_gain));
                // AUD-208 FIX: Per MIDI 1.0 spec, velocity-0 note-on is note-off
                // (Running Status optimization). Some MIDI files/controllers use this.
                // Without this, such notes create a stuck note with velocity=1 that
                // never receives its corresponding note-off.
                if velocity_scaled == 0 && is_note_on {
                    out.push(ScheduledNote {
                        pitch: note.pitch,
                        velocity: 0,
                        note_uid: Self::note_uid(clip, note),
                        buffer_onset: onset.min(frame_count),
                        buffer_offset_end: onset.min(frame_count),
                        is_note_on: false,
                        is_note_off: true,
                    });
                    continue;
                }
                out.push(ScheduledNote {
                    pitch: note.pitch,
                    velocity: velocity_scaled.max(1),
                    note_uid: Self::note_uid(clip, note),
                    buffer_onset: onset.min(frame_count),
                    buffer_offset_end: offset_end.min(frame_count),
                    is_note_on,
                    is_note_off,
                });
            }
        }
        Self::sort_and_dedup(out);
    }
    /// Loop-aware MIDI scheduling into caller-provided scratch output.
    pub fn fill_active_looped_with_tmp(
        clips: &[MidiClip],
        playhead_pos: i64,
        frame_count: usize,
        loop_region: Option<(i64, i64)>,
        out: &mut Vec<ScheduledNote>,
        tmp: &mut Vec<ScheduledNote>,
    ) {
        let (loop_start, loop_end) = match loop_region {
            Some((start, end)) if end >= start + 32 && start >= 0 => (start, end),
            _ => {
                Self::fill_active(clips, playhead_pos, frame_count, out);
                return;
            }
        };
        // ── Guard: playhead genuinely past the loop ────────────────────
        // When the user places the cursor AFTER the loop region, the scheduler
        // must NOT wrap it back into the loop. The transport only wraps when
        // `position < loop_end` (Playhead::advance). If the playhead is at or
        // past loop_end, normal non-looped scheduling is correct — `fill_active`
        // will naturally produce zero notes because no clips exist there.
        //
        // The only edge case: `midi_playhead_pos` is captured BEFORE the
        // transport advance. On a wrap, the transport moves position from
        // loop_end - Δ  to  loop_start + Δ. So `midi_playhead_pos` is always
        // < loop_end during active looped playback. If it's >= loop_end, the user
        // has explicitly seeked past the loop → no looping.
        if playhead_pos >= loop_end {
            Self::fill_active(clips, playhead_pos, frame_count, out);
            return;
        }
        let frame_count_i64 = i64::try_from(frame_count).unwrap_or(i64::MAX);
        let buffer_end = playhead_pos.saturating_add(frame_count_i64);
        // If the buffer fits entirely within the loop (no wrap crossing),
        // standard scheduling is sufficient.
        if buffer_end <= loop_end {
            Self::fill_active(clips, playhead_pos, frame_count, out);
            return;
        }
        out.clear();
        let mut current_playhead = playhead_pos;
        let mut frames_remaining = frame_count;
        let mut current_buffer_offset = 0;
        // BUG-C004 FIX (MIDI): Same safety limit as audio scheduler.
        // Prevents infinite loop from corrupted loop regions on RT thread.
        let mut safety_iterations = 0u32;
        const MAX_LOOP_ITERATIONS: u32 = 16;
        while frames_remaining > 0 {
            safety_iterations += 1;
            if safety_iterations > MAX_LOOP_ITERATIONS {
                break;
            }
            let frames_to_end = Self::i64_nonneg_to_usize(loop_end - current_playhead);
            let chunk_frames = frames_remaining.min(frames_to_end);
            // STAGE3-02 FIX: Same infinite loop guard as scheduler.rs STAGE3-01.
            // If current_playhead == loop_end, chunk_frames is 0 and the loop spins forever.
            if chunk_frames == 0 {
                current_playhead = loop_start;
                continue;
            }
            Self::fill_active(clips, current_playhead, chunk_frames, tmp);
            for mut note in tmp.iter().copied() {
                note.buffer_onset += current_buffer_offset;
                note.buffer_offset_end += current_buffer_offset;
                note.buffer_onset = note.buffer_onset.min(frame_count);
                note.buffer_offset_end = note.buffer_offset_end.min(frame_count);
                out.push(note);
            }
            frames_remaining -= chunk_frames;
            current_buffer_offset += chunk_frames;
            if frames_remaining > 0 {
                // Loop boundary safety: explicitly turn off notes that cross the wrap point.
                //
                // LOOP-WRAP-FIX (Enterprise): Place forced note-offs 1 sample BEFORE
                // the wrap offset. When a note-off and a new note-on share the exact
                // same sample offset, many VST3 plugins (Kontakt, Serum, Diva, etc.)
                // process them in undefined order or cancel the pair entirely,
                // causing the first beat of the loop to go silent.
                // By placing the forced note-off 1 sample earlier, the VST always
                // sees: note-off(sample=N-1), note-on(sample=N) — unambiguous ordering.
                let forced_off_offset = current_buffer_offset.saturating_sub(1).min(frame_count);
                let mut forced_off_by_pitch = [false; 128];
                
                // BUG-009 FIX (MIDI): Only emit forced note-offs for pitches that were
                // actually playing in the pre-wrap segment. Iterating all clips and notes
                // caused ghost note-offs for clips that were elsewhere on the track.
                for pre_wrap_note in tmp.iter() {
                    if !pre_wrap_note.is_note_off {
                        let p = usize::from(pre_wrap_note.pitch);
                        if !forced_off_by_pitch[p] {
                            forced_off_by_pitch[p] = true;
                            out.push(ScheduledNote {
                                pitch: pre_wrap_note.pitch,
                                velocity: 1, // Velocity doesn't matter for note-off
                                note_uid: pre_wrap_note.note_uid,
                                buffer_onset: forced_off_offset,
                                buffer_offset_end: forced_off_offset,
                                is_note_on: false,
                                is_note_off: true,
                            });
                        }
                    }
                }
                // Wrap around to loop start
                current_playhead = loop_start;
            }
        }
        Self::sort_and_dedup(out);
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
    #[derive(Clone, Copy)]
    struct Rng32 {
        state: u32,
    }
    impl Rng32 {
        fn new(seed: u32) -> Self {
            Self { state: seed.max(1) }
        }
        fn next_u32(&mut self) -> u32 {
            let mut x = self.state;
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            self.state = x;
            x
        }
        fn range_i64(&mut self, min: i64, max_exclusive: i64) -> i64 {
            let span = (max_exclusive - min).max(1) as u64;
            min + (self.next_u32() as u64 % span) as i64
        }
        fn range_u8(&mut self, min: u8, max_inclusive: u8) -> u8 {
            let span = (max_inclusive - min).max(1) as u32 + 1;
            min + (self.next_u32() % span) as u8
        }
    }
    fn make_midi_clip(pos: i64, dur: i64, notes: Vec<MidiNote>) -> MidiClip {
        let mut clip = MidiClip::new("Test", AbsoluteTime::new(pos), AbsoluteTime::new(dur));
        clip.notes = notes;
        clip
    }
    fn looped_events(
        clips: &[MidiClip],
        playhead_pos: i64,
        frame_count: usize,
        loop_region: Option<(i64, i64)>,
    ) -> Vec<ScheduledNote> {
        let mut out = Vec::new();
        let mut tmp = Vec::new();
        MidiScheduler::fill_active_looped_with_tmp(
            clips,
            playhead_pos,
            frame_count,
            loop_region,
            &mut out,
            &mut tmp,
        );
        out
    }
    fn find_active_tmp(clips: &[MidiClip], pos: i64, fc: usize) -> Vec<ScheduledNote> {
        let mut tmp = Vec::new();
        let mut out = Vec::new();
        MidiScheduler::fill_active_looped_with_tmp(clips, pos, fc, None, &mut out, &mut tmp);
        out
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
        let events = find_active_tmp(&[clip], 0, 1024);
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
        let events = find_active_tmp(&[clip], 512, 1024);
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
        let events = find_active_tmp(&[clip], 200, 1024);
        assert!(events.is_empty()); // note ended before buffer
    }
    #[test]
    fn note_after_buffer() {
        let clip = make_midi_clip(0, 44100, vec![MidiNote::new(60, 100, 2000, 500)]);
        let events = find_active_tmp(&[clip], 0, 1024);
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
        let events = find_active_tmp(&[clip], 0, 1024);
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
        let events = find_active_tmp(&[clip], 10000, 1024);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].buffer_onset, 100); // 10100 - 10000
        assert!(events[0].is_note_on);
    }
    #[test]
    fn empty_clip_returns_empty() {
        let clip = make_midi_clip(0, 44100, vec![]);
        let events = find_active_tmp(&[clip], 0, 1024);
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
        let events = find_active_tmp(&[clip], 0, 256);
        let at_100: Vec<_> = events.iter().filter(|e| e.buffer_onset == 100).collect();
        assert_eq!(at_100.len(), 2);
        assert_eq!(at_100[0].pitch, 60);
        assert_eq!(at_100[1].pitch, 67);
    }
    // ── Loop-Aware Scheduling Tests ────────────────────────────────────
    #[test]
    fn looped_no_wrap_same_as_standard() {
        let clip = make_midi_clip(0, 44100, vec![MidiNote::new(60, 100, 100, 500)]);
        let standard = find_active_tmp(std::slice::from_ref(&clip), 0, 1024);
        let looped = looped_events(&[clip], 0, 1024, Some((0, 44100)));
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
        let events = looped_events(&[clip], 3800, 512, Some((0, 4000)));
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
        // Playhead at 3800, buffer 512: pre-wrap 200 frames, post-wrap 312 frames
        let events = looped_events(&[clip], 3800, 512, Some((0, 4000)));
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
        let events = looped_events(&[clip], 0, 1024, None);
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
        // Playhead at 13800, buffer 512 → crosses 14000
        // Pre-wrap: 200 frames (13800..14000)
        // Post-wrap: 312 frames (10000..10312)
        let events = looped_events(&[clip], 13800, 512, Some((10000, 14000)));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].pitch, 60);
        assert!(events[0].is_note_on);
        assert_eq!(events[0].buffer_onset, 200);
    }
    #[test]
    fn dedups_identical_notes_same_frame_and_pitch() {
        let clip = make_midi_clip(
            0,
            4000,
            vec![
                MidiNote::new(42, 90, 120, 120),
                MidiNote::new(42, 110, 120, 120), // duplicate, stronger velocity
            ],
        );
        let events = find_active_tmp(&[clip], 0, 512);
        let on_events: Vec<_> = events
            .iter()
            .filter(|e| e.is_note_on && e.pitch == 42 && e.buffer_onset == 120)
            .collect();
        assert_eq!(on_events.len(), 1, "duplicate note-on must be collapsed");
        assert_eq!(
            on_events[0].velocity, 110,
            "strongest velocity should be kept"
        );
    }
    #[test]
    fn loop_wrap_emits_single_forced_note_off_for_crossing_note() {
        // Note crosses loop end and should receive exactly one forced off at wrap.
        let clip = make_midi_clip(
            0,
            4000,
            vec![MidiNote::new(42, 100, 3900, 300)], // spans 3900..4200 across loop end
        );
        let events = looped_events(&[clip], 3800, 512, Some((0, 4000)));
        let offs: Vec<_> = events
            .iter()
            .filter(|e| e.is_note_off && !e.is_note_on && e.pitch == 42)
            .collect();
        assert_eq!(
            offs.len(),
            1,
            "crossing note should produce one forced note-off"
        );
        assert_eq!(
            offs[0].buffer_onset, 199,
            "forced off must happen 1 sample before wrap frame"
        );
    }
    #[test]
    fn stress_loop_wrap_single_note_never_duplicates_in_callback() {
        let clip = make_midi_clip(0, 4000, vec![MidiNote::new(42, 100, 0, 180)]);
        let frame_sizes = [64usize, 96, 128, 256, 192];
        let mut pos = 3890i64;
        let mut observed_on = 0usize;
        let mut observed_off = 0usize;
        for i in 0..200usize {
            let fc = frame_sizes[i % frame_sizes.len()];
            let events = looped_events(std::slice::from_ref(&clip), pos, fc, Some((0, 4000)));
            let on_count = events
                .iter()
                .filter(|e| e.pitch == 42 && e.is_note_on)
                .count();
            let off_count = events
                .iter()
                .filter(|e| e.pitch == 42 && e.is_note_off)
                .count();
            assert!(
                on_count <= 1,
                "duplicate note-on in callback (i={i}, pos={pos}, fc={fc}, events={events:?})"
            );
            assert!(
                off_count <= 1,
                "duplicate note-off in callback (i={i}, pos={pos}, fc={fc}, events={events:?})"
            );
            observed_on += on_count;
            observed_off += off_count;
            let next = pos + fc as i64;
            pos = if next >= 4000 {
                0 + (next - 4000)
            } else {
                next
            };
        }
        assert!(
            observed_on > 0,
            "expected at least one note-on in stress run"
        );
        assert!(
            observed_off > 0,
            "expected at least one note-off in stress run"
        );
    }
    #[test]
    fn fuzz_scheduler_no_duplicate_events_per_callback() {
        let mut rng = Rng32::new(0xC0FF_EE11);
        let loop_len = 8192i64;
        let frame_sizes = [64usize, 96, 128, 192, 256, 384, 512];
        for _case in 0..120 {
            let note_count = rng.range_i64(1, 28) as usize;
            let mut notes = Vec::with_capacity(note_count);
            for _ in 0..note_count {
                notes.push(MidiNote::new(
                    rng.range_u8(36, 84),
                    rng.range_u8(60, 127),
                    rng.range_i64(0, loop_len - 1),
                    rng.range_i64(1, 1400),
                ));
            }
            let clip = make_midi_clip(0, loop_len, notes);
            let mut pos = rng.range_i64(0, loop_len);
            for i in 0..260usize {
                let fc = frame_sizes
                    [(i + (rng.next_u32() as usize % frame_sizes.len())) % frame_sizes.len()];
                let events = looped_events(std::slice::from_ref(&clip), pos, fc, Some((0, loop_len)));
                let mut sigs = std::collections::HashSet::<(usize, usize, u8, u64)>::new();
                for e in &events {
                    if e.is_note_on {
                        assert!(sigs.insert((e.buffer_onset, 1, e.pitch, e.note_uid)));
                    }
                    if e.is_note_off {
                        assert!(sigs.insert((e.buffer_offset_end, 0, e.pitch, e.note_uid)));
                    }
                    assert!(e.buffer_onset <= fc);
                    assert!(e.buffer_offset_end <= fc);
                }
                let next = pos + fc as i64;
                pos = if next >= loop_len {
                    0 + (next - loop_len)
                } else {
                    next
                };
            }
        }
    }
    #[test]
    fn fuzz_scheduler_event_bounds_and_order() {
        let mut rng = Rng32::new(0xA11C_ED42);
        let loop_len = 12288i64;
        for _case in 0..80 {
            let note_count = rng.range_i64(1, 40) as usize;
            let mut notes = Vec::with_capacity(note_count);
            for _ in 0..note_count {
                notes.push(MidiNote::new(
                    rng.range_u8(24, 96),
                    rng.range_u8(1, 127),
                    rng.range_i64(0, loop_len - 1),
                    rng.range_i64(1, 1800),
                ));
            }
            let clip = make_midi_clip(0, loop_len, notes);
            let fc = rng.range_i64(32, 1024) as usize;
            let pos = rng.range_i64(0, loop_len);
            let events = looped_events(&[clip], pos, fc, Some((0, loop_len)));
            for w in events.windows(2) {
                let a = w[0];
                let b = w[1];
                assert!(a.buffer_onset <= b.buffer_onset);
            }
            for e in events {
                assert!(e.buffer_onset <= fc);
                assert!(e.buffer_offset_end <= fc);
                if e.is_note_on && e.is_note_off {
                    assert!(e.buffer_onset <= e.buffer_offset_end);
                }
            }
        }
    }
}