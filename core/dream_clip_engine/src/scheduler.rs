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
}

/// Schedules clips for playback based on the current playhead position.
pub struct ClipScheduler;

impl ClipScheduler {
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
    /// # Real-Time Safety
    /// This allocates a Vec — in production, use a pre-allocated scratch buffer.
    /// For now, this is acceptable as clip counts are typically < 100 per track.
    pub fn find_active<'a>(
        clips: &'a [AudioClip],
        playhead_pos: i64,
        buffer_size: usize,
    ) -> Vec<ActiveClip<'a>> {
        let buffer_end = playhead_pos + buffer_size as i64;
        let mut active = Vec::new();

        for clip in clips {
            let clip_start = clip.position.sample_frame;
            let clip_end = clip.end_position().sample_frame;

            // Check overlap: clip range intersects buffer range
            if clip_end <= playhead_pos || clip_start >= buffer_end {
                continue; // No overlap
            }

            // Calculate the intersection
            let intersect_start = playhead_pos.max(clip_start);
            let intersect_end = buffer_end.min(clip_end);
            let frames_to_read = (intersect_end - intersect_start) as usize;

            if frames_to_read == 0 {
                continue;
            }

            // Buffer offset: where in the output buffer does this clip start writing?
            let buffer_offset = if clip_start > playhead_pos {
                (clip_start - playhead_pos) as usize
            } else {
                0
            };

            // Source frame: where in the clip's source audio do we start reading?
            let source_start_frame = clip.source_offset.sample_frame
                + (intersect_start - clip_start);

            active.push(ActiveClip {
                clip,
                source_start_frame,
                buffer_offset,
                frames_to_read,
            });
        }

        active
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

    #[test]
    fn clip_fully_inside_buffer() {
        let clips = vec![make_clip("A", 100, 200)]; // 100..300
        let active = ClipScheduler::find_active(&clips, 0, 512);

        assert_eq!(active.len(), 1);
        assert_eq!(active[0].buffer_offset, 100);
        assert_eq!(active[0].frames_to_read, 200);
    }

    #[test]
    fn clip_starts_before_buffer() {
        let clips = vec![make_clip("A", 0, 1000)]; // 0..1000
        let active = ClipScheduler::find_active(&clips, 500, 256);

        assert_eq!(active.len(), 1);
        assert_eq!(active[0].buffer_offset, 0);
        assert_eq!(active[0].frames_to_read, 256);
        assert_eq!(active[0].source_start_frame, 500); // reading from position 500 in source
    }

    #[test]
    fn clip_ends_during_buffer() {
        let clips = vec![make_clip("A", 0, 600)]; // 0..600
        let active = ClipScheduler::find_active(&clips, 500, 256);

        assert_eq!(active.len(), 1);
        assert_eq!(active[0].frames_to_read, 100); // Only 100 frames remain
    }

    #[test]
    fn clip_before_buffer() {
        let clips = vec![make_clip("A", 0, 100)]; // 0..100
        let active = ClipScheduler::find_active(&clips, 200, 256);

        assert!(active.is_empty());
    }

    #[test]
    fn clip_after_buffer() {
        let clips = vec![make_clip("A", 1000, 100)]; // 1000..1100
        let active = ClipScheduler::find_active(&clips, 0, 256);

        assert!(active.is_empty());
    }

    #[test]
    fn multiple_overlapping_clips() {
        let clips = vec![
            make_clip("A", 0, 500),    // 0..500
            make_clip("B", 200, 500),  // 200..700
            make_clip("C", 1000, 100), // 1000..1100 (not in range)
        ];
        let active = ClipScheduler::find_active(&clips, 100, 256);

        assert_eq!(active.len(), 2);
        assert_eq!(active[0].clip.name, "A");
        assert_eq!(active[1].clip.name, "B");
    }

    #[test]
    fn source_offset_is_respected() {
        let mut clip = make_clip("A", 0, 500);
        clip.source_offset = AbsoluteTime::new(1000); // Trimmed: source starts at frame 1000

        let clips = vec![clip];
        let active = ClipScheduler::find_active(&clips, 100, 256);

        assert_eq!(active.len(), 1);
        assert_eq!(active[0].source_start_frame, 1100); // 1000 + 100
    }

    #[test]
    fn empty_clips_returns_empty() {
        let active = ClipScheduler::find_active(&[], 0, 256);
        assert!(active.is_empty());
    }

    #[test]
    fn clip_exactly_at_buffer_boundary() {
        // Clip ends exactly where buffer starts
        let clips = vec![make_clip("A", 0, 256)]; // 0..256
        let active = ClipScheduler::find_active(&clips, 256, 256);
        assert!(active.is_empty()); // End is exclusive
    }
}
