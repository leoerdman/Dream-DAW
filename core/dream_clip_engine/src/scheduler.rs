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
    /// `true` when the clip is being abruptly cut off because the playhead
    /// wrapped to the loop start. Triggers a micro fade-out.
    pub is_loop_wrap_fade_out: bool,
    /// `true` when the clip is abruptly resuming after the playhead
    /// wrapped to the loop start. Triggers a micro fade-in.
    pub is_loop_wrap_fade_in: bool,
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
    pub is_loop_wrap_fade_out: bool,
    pub is_loop_wrap_fade_in: bool,
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
            if clip.is_disabled {
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
                is_loop_wrap_fade_out: false,
                is_loop_wrap_fade_in: false,
            });
        }
    }
    /// Loop-aware, allocation-free scheduler variant for RT callback.
    ///
    /// Only applies loop-aware buffer splitting when the playhead is
    /// **inside** the loop region and the buffer straddles the loop end.
    /// When the playhead is outside the loop (before start or past end),
    /// standard non-loop scheduling is used — the transport's
    /// `Playhead::advance()` handles the actual position wrapping.
    pub fn fill_active_looped_with_tmp(
        clips: &[AudioClip],
        playhead_pos: i64,
        buffer_size: usize,
        loop_region: Option<(i64, i64)>,
        out: &mut Vec<ActiveClipInfo>,
        tmp: &mut Vec<ActiveClipInfo>,
    ) {
        let (loop_start, loop_end) = match loop_region {
            Some((start, end)) if end >= start + 32 && start >= 0 => (start, end),
            _ => {
                Self::fill_active(clips, playhead_pos, buffer_size, out);
                return;
            }
        };
        let buffer_size_i64 = i64::try_from(buffer_size).unwrap_or(i64::MAX);
        let buffer_end = playhead_pos.saturating_add(buffer_size_i64);
        // ── Playhead is PAST the loop end ───────────────────────────────
        // The transport's Playhead::advance() handles wrapping during
        // continuous playback. If we get a position past the loop end,
        // the user has seeked beyond it — play only what's actually there.
        // Previously this wrapped back into the loop, causing clips from
        // inside the loop to falsely play on empty timeline sections.
        if playhead_pos >= loop_end {
            Self::fill_active(clips, playhead_pos, buffer_size, out);
            return;
        }
        // ── Playhead is BEFORE the loop start ──────────────────────────
        // If the buffer doesn't reach into the loop start, standard
        // scheduling is sufficient (play pre-loop content normally).
        if playhead_pos < loop_start && buffer_end <= loop_start {
            Self::fill_active(clips, playhead_pos, buffer_size, out);
            return;
        }
        // ── Playhead is INSIDE the loop (or buffer straddles start) ────
        // If the entire buffer fits within the loop region, no split needed.
        if buffer_end <= loop_end && playhead_pos >= loop_start {
            Self::fill_active(clips, playhead_pos, buffer_size, out);
            return;
        }
        // Buffer straddles the loop end boundary — split into segments.
        out.clear();
        tmp.clear();
        let mut current_playhead = playhead_pos;
        let mut frames_remaining = buffer_size;
        let mut current_buffer_offset = 0;
        // BUG-C004 FIX: Safety limit prevents infinite loop when loop region
        // is corrupt (e.g. start >= end). Normal processing never exceeds 2
        // iterations; 16 is a generous safety margin.
        let mut safety_iterations = 0u32;
        const MAX_LOOP_ITERATIONS: u32 = 16;
        let mut is_first_chunk = true;
        while frames_remaining > 0 {
            safety_iterations += 1;
            if safety_iterations > MAX_LOOP_ITERATIONS {
                break;
            }
            let frames_to_end_i64 = (loop_end - current_playhead).max(0);
            let frames_to_end = usize::try_from(frames_to_end_i64).unwrap_or(usize::MAX);
            let chunk_frames = frames_remaining.min(frames_to_end);
            // STAGE3-01 FIX: If current_playhead is exactly at loop_end,
            // frames_to_end is 0, chunk_frames is 0, and frames_remaining never
            // decreases — causing an infinite loop on the RT thread.
            if chunk_frames == 0 {
                current_playhead = loop_start;
                is_first_chunk = false;
                continue;
            }
            Self::fill_active(clips, current_playhead, chunk_frames, tmp);
            
            // If this chunk pushes the playhead exactly to the end of the loop,
            // the clips active at the end will be forcefully cut.
            let reaches_loop_end = current_playhead + (chunk_frames as i64) >= loop_end;
            for mut clip in tmp.iter().copied() {
                clip.buffer_offset += current_buffer_offset;
                
                // Set the loop wrap boundary flags so the renderer knows to crossfade them
                if is_first_chunk && reaches_loop_end && !clip.is_clip_tail {
                    clip.is_loop_wrap_fade_out = true;
                }
                if !is_first_chunk && !clip.is_clip_head {
                    clip.is_loop_wrap_fade_in = true;
                }
                
                // STAGE3 BUG-FIX: If a clip spans the loop, playhead = 0 might mistakenly 
                // trigger `is_clip_head` because `clip_start` is also 0. It is NOT the head;
                // it's just wrapping. Override it, the loop_wrap_fade_in will handle it.
                if !is_first_chunk && clip.is_clip_head && clip.source_start_frame > clips[clip.clip_index].source_offset.sample_frame {
                    // Only applies if we've already been reading from the clip
                    clip.is_clip_head = false;
                }
                // BUG-008 FIX (Audio): Deduplicate clips spanning the exact loop boundary
                // that appear in both pre-wrap and post-wrap segments by overlapping offsets.
                let is_duplicate = !is_first_chunk && out.iter().any(|existing| {
                    existing.clip_index == clip.clip_index &&
                    existing.buffer_offset < clip.buffer_offset + clip.frames_to_read &&
                    existing.buffer_offset + existing.frames_to_read > clip.buffer_offset
                });
                if !is_duplicate {
                    out.push(clip);
                }
            }
            frames_remaining -= chunk_frames;
            current_buffer_offset += chunk_frames;
            is_first_chunk = false;
            if frames_remaining > 0 {
                // Wrap around to loop start
                current_playhead = loop_start;
            }
        }
    }
}
// SSOT FIX: Removed duplicate LoopRegion struct entirely.

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
                is_loop_wrap_fade_out: info.is_loop_wrap_fade_out,
                is_loop_wrap_fade_in: info.is_loop_wrap_fade_in,
            })
            .collect()
    }
    fn active_for_looped<'a>(
        clips: &'a [AudioClip],
        playhead_pos: i64,
        buffer_size: usize,
        loop_region: Option<(i64, i64)>,
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
                is_loop_wrap_fade_out: info.is_loop_wrap_fade_out,
                is_loop_wrap_fade_in: info.is_loop_wrap_fade_in,
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
        let standard = active_for(&clips, 100, 256);
        let looped = active_for_looped(&clips, 100, 256, Some((0, 2000)));
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
        let active = active_for_looped(&clips, 400, 256, Some((0, 500)));
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
                    // ── Loop Past-End Fix Tests ────────────────────────────────────────
    #[test]
    fn loop_past_end_no_false_playback() {
        // BUG FIX: When playhead is past the loop end, clips inside the
        // loop must NOT play. Previously, the scheduler wrapped the playhead
        // back into the loop, causing clips to falsely appear active.
        let clips = vec![make_clip("A", 0, 1000)]; // Clip at 0..1000
        // Playhead at 2000 — well past the loop end, on empty timeline
        let active = active_for_looped(&clips, 2000, 256, Some((0, 1000)));
        assert!(
            active.is_empty(),
            "Clips inside the loop must NOT play when playhead is past the loop end"
        );
    }
    #[test]
    fn loop_past_end_plays_actual_content() {
        // If there IS a clip past the loop end, it should play normally.
        let clips = vec![
            make_clip("A", 0, 1000),    // Inside loop (0..1000)
            make_clip("B", 2000, 500),  // Past loop (2000..2500)
        ];
        let active = active_for_looped(&clips, 2000, 256, Some((0, 1000)));
        assert_eq!(active.len(), 1, "Only clip B (past loop) should play");
        assert_eq!(active[0].clip.name, "B");
    }
    #[test]
    fn loop_before_start_plays_actual_content() {
        // Clips before the loop start should play normally.
        let clips = vec![
            make_clip("A", 0, 500),     // Before loop
            make_clip("B", 1000, 1000), // Inside loop (1000..2000)
        ];
        let active = active_for_looped(&clips, 0, 256, Some((1000, 2000)));
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].clip.name, "A");
    }
}