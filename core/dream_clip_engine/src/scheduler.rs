// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Clip Scheduler
// ═══════════════════════════════════════════════════════════════════════════
//
// Determines which audio clips are active (overlapping) for a given
// buffer window on the timeline.
//
// This is the first stage of the playback pipeline:
//   Transport → Playhead position → ClipScheduler → active clips
//
// ═══════════════════════════════════════════════════════════════════════════

use dream_models::project::AudioClip;

/// Describes how a clip intersects with the current playback buffer.
#[derive(Debug, Clone)]
pub struct ActiveClip<'a> {
    /// Reference to the clip model data.
    pub clip: &'a AudioClip,

    /// Offset into the clip's source audio (in frames) for this buffer.
    /// This accounts for `source_offset` and the clip's position on the timeline.
    pub source_start_frame: i64,

    /// Offset into the output buffer where this clip begins writing.
    /// 0 if the clip started before this buffer.
    pub buffer_offset: usize,

    /// Number of frames to read from this clip in this buffer.
    pub frames_to_read: usize,

    /// `true` when this buffer contains the clip's first audio frame.
    /// Used by the render callback to apply a Hann fade-in (anti-click).
    pub is_clip_head: bool,

    /// `true` when this buffer contains the clip's last audio frame.
    /// Used by the render callback to apply a Hann fade-out (anti-click).
    pub is_clip_tail: bool,
}

/// Allocation-free active clip descriptor for RT hot path.
#[derive(Debug, Clone, Copy)]
pub struct ActiveClipInfo {
    /// Index of clip in the source clip slice.
    pub clip_index: usize,
    pub source_start_frame: i64,
    pub buffer_offset: usize,
    pub frames_to_read: usize,
    pub is_clip_head: bool,
    pub is_clip_tail: bool,
}

/// Schedules clips for playback based on the current playhead position.
pub struct ClipScheduler;

impl ClipScheduler {
    /// Fills a caller-provided scratch buffer with active clips (zero alloc on hot path).
    pub fn fill_active(
        clips: &[AudioClip],
        playhead_pos: i64,
        buffer_size: usize,
        out: &mut Vec<ActiveClipInfo>,
    ) {
        // BUG-010 FIX: saturating_add prevents i64 overflow in long sessions.
        let buffer_size_i64 = i64::try_from(buffer_size).unwrap_or(i64::MAX);
        let buffer_end = playhead_pos.saturating_add(buffer_size_i64);
        out.clear();

        for (clip_index, clip) in clips.iter().enumerate() {
            // Skip muted/disabled clips — they stay on timeline but produce no audio
            if clip.is_muted {
                continue;
            }

            let clip_start = clip.position.sample_frame;
            let clip_end = clip.end_position().sample_frame;

            if clip_end <= playhead_pos || clip_start >= buffer_end {
                continue;
            }

            let intersect_start = playhead_pos.max(clip_start);
            let intersect_end = buffer_end.min(clip_end);
            let frames_span = intersect_end.saturating_sub(intersect_start);
            let Ok(frames_to_read) = usize::try_from(frames_span) else {
                continue;
            };
            if frames_to_read == 0 {
                continue;
            }

            let buffer_offset = if clip_start > playhead_pos {
                usize::try_from(clip_start.saturating_sub(playhead_pos)).unwrap_or(usize::MAX)
            } else {
                0
            };

            let source_start_frame =
                clip.source_offset.sample_frame + (intersect_start - clip_start);
            let is_clip_head = intersect_start == clip_start;
            let is_clip_tail = intersect_end == clip_end;

            out.push(ActiveClipInfo {
                clip_index,
                source_start_frame,
                buffer_offset,
                frames_to_read,
                is_clip_head,
                is_clip_tail,
            });
        }
    }

    /// Loop-aware, allocation-free scheduler variant for RT callback.
    pub fn fill_active_looped_with_tmp(
        clips: &[AudioClip],
        playhead_pos: i64,
        buffer_size: usize,
        loop_region: Option<&LoopRegion>,
        out: &mut Vec<ActiveClipInfo>,
        tmp: &mut Vec<ActiveClipInfo>,
    ) {
        let loop_region = match loop_region {
            Some(lr) if lr.is_valid() => lr,
            _ => {
                Self::fill_active(clips, playhead_pos, buffer_size, out);
                return;
            }
        };

        let buffer_size_i64 = i64::try_from(buffer_size).unwrap_or(i64::MAX);
        let buffer_end = playhead_pos.saturating_add(buffer_size_i64);
        // If the entire buffer fits within the loop region (no wrap needed),
        // use standard scheduling — no split required.
        if buffer_end <= loop_region.end && playhead_pos >= loop_region.start {
            Self::fill_active(clips, playhead_pos, buffer_size, out);
            return;
        }

        // If the playhead is past the loop end (e.g. seek beyond loop or
        // transport tick hasn't wrapped yet), wrap it back into the loop
        // region so clips outside the loop never play.
        let effective_playhead = if playhead_pos >= loop_region.end {
            loop_region.wrap_position(playhead_pos)
        } else {
            playhead_pos
        };

        out.clear();
        tmp.clear();

        let mut current_playhead = effective_playhead;
        let mut frames_remaining = buffer_size;
        let mut current_buffer_offset = 0;

        while frames_remaining > 0 {
            let frames_to_end_i64 = (loop_region.end - current_playhead).max(0);
            let frames_to_end = usize::try_from(frames_to_end_i64).unwrap_or(usize::MAX);
            let chunk_frames = frames_remaining.min(frames_to_end);

            // STAGE3-01 FIX: If current_playhead is exactly at loop_region.end,
            // frames_to_end is 0, chunk_frames is 0, and frames_remaining never
            // decreases — causing an infinite loop on the RT thread.
            if chunk_frames == 0 {
                current_playhead = loop_region.start;
                continue;
            }

            Self::fill_active(clips, current_playhead, chunk_frames, tmp);
            for mut clip in tmp.iter().copied() {
                clip.buffer_offset += current_buffer_offset;
                out.push(clip);
            }

            frames_remaining -= chunk_frames;
            current_buffer_offset += chunk_frames;

            if frames_remaining > 0 {
                // Wrap around to loop start
                current_playhead = loop_region.start;
            }
        }
    }

    /// Loop-aware scheduler variant.
    ///
    /// # ⚠ RT-Safety Warning
    /// This allocates a temporary `Vec` internally. For real-time audio callbacks,
    /// use [`fill_active_looped_with_tmp`](Self::fill_active_looped_with_tmp) instead.
    #[deprecated(
        note = "RT-unsafe: allocates Vec. Use fill_active_looped_with_tmp for audio thread."
    )]
    pub fn fill_active_looped(
        clips: &[AudioClip],
        playhead_pos: i64,
        buffer_size: usize,
        loop_region: Option<&LoopRegion>,
        out: &mut Vec<ActiveClipInfo>,
    ) {
        let mut tmp = Vec::new();
        Self::fill_active_looped_with_tmp(
            clips,
            playhead_pos,
            buffer_size,
            loop_region,
            out,
            &mut tmp,
        );
    }

    /// Finds all clips that overlap the given playback window.
    ///
    /// # Arguments
    /// - `clips`: All clips on a track (should be sorted by position).
    /// - `playhead_pos`: Current playhead position in sample frames.
    /// - `buffer_size`: Size of the current audio buffer in frames.
    ///
    /// # Returns
    /// A vector of `ActiveClip` descriptors for clips that need rendering.
    ///
    /// # ⚠ RT-Safety Warning
    /// This allocates a `Vec` — do NOT use on the audio thread.
    /// Use [`fill_active`](Self::fill_active) with a pre-allocated scratch buffer instead.
    #[deprecated(note = "RT-unsafe: allocates Vec. Use fill_active with pre-allocated buffer.")]
    pub fn find_active<'a>(
        clips: &'a [AudioClip],
        playhead_pos: i64,
        buffer_size: usize,
    ) -> Vec<ActiveClip<'a>> {
        let mut scratch = Vec::new();
        Self::fill_active(clips, playhead_pos, buffer_size, &mut scratch);
        scratch
            .into_iter()
            .map(|info| ActiveClip {
                clip: &clips[info.clip_index],
                source_start_frame: info.source_start_frame,
                buffer_offset: info.buffer_offset,
                frames_to_read: info.frames_to_read,
                is_clip_head: info.is_clip_head,
                is_clip_tail: info.is_clip_tail,
            })
            .collect()
    }

    /// Finds active clips with loop-aware scheduling.
    ///
    /// When the playback window crosses a loop boundary (end → start),
    /// the buffer is split into two segments:
    ///   1. Pre-wrap: from playhead to loop end
    ///   2. Post-wrap: from loop start for remaining frames
    ///
    /// Clips are scheduled for both segments independently.
    ///
    /// Ported from Swift `PlaybackScheduler.scheduleLoopedBuffer()`.
    ///
    /// # Arguments
    /// - `clips`: All clips on a track.
    /// - `playhead_pos`: Current playhead position in sample frames.
    /// - `buffer_size`: Size of the current audio buffer in frames.
    /// - `loop_region`: Optional loop region. If `None`, behaves like `find_active`.
    ///
    /// # ⚠ RT-Safety Warning
    /// This allocates `Vec`s — do NOT use on the audio thread.
    /// Use [`fill_active_looped_with_tmp`](Self::fill_active_looped_with_tmp) instead.
    #[deprecated(
        note = "RT-unsafe: allocates Vec. Use fill_active_looped_with_tmp for audio thread."
    )]
    pub fn find_active_looped<'a>(
        clips: &'a [AudioClip],
        playhead_pos: i64,
        buffer_size: usize,
        loop_region: Option<&LoopRegion>,
    ) -> Vec<ActiveClip<'a>> {
        let mut scratch = Vec::new();
        let mut tmp = Vec::new();
        Self::fill_active_looped_with_tmp(
            clips,
            playhead_pos,
            buffer_size,
            loop_region,
            &mut scratch,
            &mut tmp,
        );
        scratch
            .into_iter()
            .map(|info| ActiveClip {
                clip: &clips[info.clip_index],
                source_start_frame: info.source_start_frame,
                buffer_offset: info.buffer_offset,
                frames_to_read: info.frames_to_read,
                is_clip_head: info.is_clip_head,
                is_clip_tail: info.is_clip_tail,
            })
            .collect()
    }
}

// ── Loop Region ────────────────────────────────────────────────────────

/// Defines a loop region on the timeline (in sample frames).
///
/// When playback reaches `end`, it wraps back to `start`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoopRegion {
    /// Loop start position in sample frames.
    pub start: i64,

    /// Loop end position in sample frames (exclusive).
    pub end: i64,
}

impl LoopRegion {
    /// Creates a new loop region.
    pub fn new(start: i64, end: i64) -> Self {
        Self { start, end }
    }

    /// Whether this loop region is valid (end > start, positive length).
    #[inline]
    pub fn is_valid(&self) -> bool {
        // BUG FIX: Enforce minimum loop length (32 frames) to prevent RT thread CPU spikes
        self.end >= self.start + 32 && self.start >= 0
    }

    /// Length of the loop in sample frames.
    #[inline]
    pub fn length(&self) -> i64 {
        self.end - self.start
    }

    /// Wraps a position to stay within the loop.
    #[inline]
    pub fn wrap_position(&self, position: i64) -> i64 {
        if !self.is_valid() || position < self.start {
            return position;
        }
        let offset = (position - self.start) % self.length();
        self.start + offset
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use dream_models::time::AbsoluteTime;

    fn make_clip(name: &str, position: i64, duration: i64) -> AudioClip {
        AudioClip::new(
            name,
            "test.wav",
            AbsoluteTime::new(position),
            AbsoluteTime::new(duration),
        )
    }

    fn active_for<'a>(
        clips: &'a [AudioClip],
        playhead_pos: i64,
        buffer_size: usize,
    ) -> Vec<ActiveClip<'a>> {
        let mut scratch = Vec::new();
        ClipScheduler::fill_active(clips, playhead_pos, buffer_size, &mut scratch);
        scratch
            .into_iter()
            .map(|info| ActiveClip {
                clip: &clips[info.clip_index],
                source_start_frame: info.source_start_frame,
                buffer_offset: info.buffer_offset,
                frames_to_read: info.frames_to_read,
                is_clip_head: info.is_clip_head,
                is_clip_tail: info.is_clip_tail,
            })
            .collect()
    }

    fn active_for_looped<'a>(
        clips: &'a [AudioClip],
        playhead_pos: i64,
        buffer_size: usize,
        loop_region: Option<&LoopRegion>,
    ) -> Vec<ActiveClip<'a>> {
        let mut scratch = Vec::new();
        let mut tmp = Vec::new();
        ClipScheduler::fill_active_looped_with_tmp(
            clips,
            playhead_pos,
            buffer_size,
            loop_region,
            &mut scratch,
            &mut tmp,
        );
        scratch
            .into_iter()
            .map(|info| ActiveClip {
                clip: &clips[info.clip_index],
                source_start_frame: info.source_start_frame,
                buffer_offset: info.buffer_offset,
                frames_to_read: info.frames_to_read,
                is_clip_head: info.is_clip_head,
                is_clip_tail: info.is_clip_tail,
            })
            .collect()
    }

    #[test]
    fn clip_fully_inside_buffer() {
        let clips = vec![make_clip("A", 100, 200)]; // 100..300
        let active = active_for(&clips, 0, 512);

        assert_eq!(active.len(), 1);
        assert_eq!(active[0].buffer_offset, 100);
        assert_eq!(active[0].frames_to_read, 200);
    }

    #[test]
    fn clip_starts_before_buffer() {
        let clips = vec![make_clip("A", 0, 1000)]; // 0..1000
        let active = active_for(&clips, 500, 256);

        assert_eq!(active.len(), 1);
        assert_eq!(active[0].buffer_offset, 0);
        assert_eq!(active[0].frames_to_read, 256);
        assert_eq!(active[0].source_start_frame, 500); // reading from position 500 in source
    }

    #[test]
    fn clip_ends_during_buffer() {
        let clips = vec![make_clip("A", 0, 600)]; // 0..600
        let active = active_for(&clips, 500, 256);

        assert_eq!(active.len(), 1);
        assert_eq!(active[0].frames_to_read, 100); // Only 100 frames remain
    }

    #[test]
    fn clip_before_buffer() {
        let clips = vec![make_clip("A", 0, 100)]; // 0..100
        let active = active_for(&clips, 200, 256);

        assert!(active.is_empty());
    }

    #[test]
    fn clip_after_buffer() {
        let clips = vec![make_clip("A", 1000, 100)]; // 1000..1100
        let active = active_for(&clips, 0, 256);

        assert!(active.is_empty());
    }

    #[test]
    fn multiple_overlapping_clips() {
        let clips = vec![
            make_clip("A", 0, 500),    // 0..500
            make_clip("B", 200, 500),  // 200..700
            make_clip("C", 1000, 100), // 1000..1100 (not in range)
        ];
        let active = active_for(&clips, 100, 256);

        assert_eq!(active.len(), 2);
        assert_eq!(active[0].clip.name, "A");
        assert_eq!(active[1].clip.name, "B");
    }

    #[test]
    fn source_offset_is_respected() {
        let mut clip = make_clip("A", 0, 500);
        clip.source_offset = AbsoluteTime::new(1000); // Trimmed: source starts at frame 1000

        let clips = vec![clip];
        let active = active_for(&clips, 100, 256);

        assert_eq!(active.len(), 1);
        assert_eq!(active[0].source_start_frame, 1100); // 1000 + 100
    }

    #[test]
    fn empty_clips_returns_empty() {
        let active = active_for(&[], 0, 256);
        assert!(active.is_empty());
    }

    #[test]
    fn clip_exactly_at_buffer_boundary() {
        // Clip ends exactly where buffer starts
        let clips = vec![make_clip("A", 0, 256)]; // 0..256
        let active = active_for(&clips, 256, 256);
        assert!(active.is_empty()); // End is exclusive
    }

    // ── Loop-Aware Scheduling Tests ────────────────────────────────────

    #[test]
    fn loop_no_wrap_same_as_standard() {
        let clips = vec![make_clip("A", 0, 1000)];
        let loop_region = LoopRegion::new(0, 2000);

        let standard = active_for(&clips, 100, 256);
        let looped = active_for_looped(&clips, 100, 256, Some(&loop_region));

        assert_eq!(standard.len(), looped.len());
        assert_eq!(standard[0].frames_to_read, looped[0].frames_to_read);
    }

    #[test]
    fn loop_wrap_splits_buffer() {
        // Clip spans 0..1000, loop is 0..500, playhead at 400 with buffer 256
        // Buffer range: 400..656, but loop end is 500
        // Pre-wrap: 400..500 = 100 frames
        // Post-wrap: 0..156 = 156 frames (from loop start)
        let clips = vec![make_clip("A", 0, 1000)];
        let loop_region = LoopRegion::new(0, 500);

        let active = active_for_looped(&clips, 400, 256, Some(&loop_region));

        assert_eq!(
            active.len(),
            2,
            "Should have pre-wrap and post-wrap segments"
        );

        // Pre-wrap: starts at buffer offset 0, 100 frames
        assert_eq!(active[0].buffer_offset, 0);
        assert_eq!(active[0].frames_to_read, 100);

        // Post-wrap: starts at buffer offset 100, 156 frames
        assert_eq!(active[1].buffer_offset, 100);
        assert_eq!(active[1].frames_to_read, 156);
    }

    #[test]
    fn loop_without_region_falls_back() {
        let clips = vec![make_clip("A", 0, 1000)];
        let active = active_for_looped(&clips, 100, 256, None);
        assert_eq!(active.len(), 1);
    }

    #[test]
    fn loop_region_validity() {
        assert!(LoopRegion::new(0, 1000).is_valid());
        assert!(!LoopRegion::new(1000, 0).is_valid()); // Inverted
        assert!(!LoopRegion::new(500, 500).is_valid()); // Zero length
        assert!(!LoopRegion::new(-100, 500).is_valid()); // Negative start
    }

    #[test]
    fn loop_region_wrap_position() {
        let lr = LoopRegion::new(0, 1000);
        assert_eq!(lr.wrap_position(500), 500); // Within loop
        assert_eq!(lr.wrap_position(1000), 0); // At end → wraps to start
        assert_eq!(lr.wrap_position(1500), 500); // Past end → wraps
        assert_eq!(lr.wrap_position(2000), 0); // Double wrap
    }

    #[test]
    fn loop_region_wrap_with_offset() {
        let lr = LoopRegion::new(1000, 2000);
        assert_eq!(lr.wrap_position(1500), 1500); // Within
        assert_eq!(lr.wrap_position(2000), 1000); // At end → wraps
        assert_eq!(lr.wrap_position(2500), 1500); // Past end
    }

    #[test]
    fn loop_region_length() {
        assert_eq!(LoopRegion::new(0, 44100).length(), 44100);
        assert_eq!(LoopRegion::new(1000, 5000).length(), 4000);
    }
}
