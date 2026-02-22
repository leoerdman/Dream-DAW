use std::collections::VecDeque;
use std::path::Path;

/// Size of each streaming chunk in frames.
/// At 48kHz stereo, 8192 frames = ~170ms of audio ≈ 64KB per channel.
pub const CHUNK_FRAMES: usize = 8192;

/// Number of chunks to buffer ahead of the playhead.
/// 16 chunks × 8192 frames ≈ 2.7 seconds of look-ahead at 48kHz.
pub const LOOK_AHEAD_CHUNKS: usize = 16;

/// Maximum file size (in bytes) below which audio is loaded entirely into RAM.
/// Files larger than this threshold use disk streaming.
/// 50 MB ≈ ~4.6 minutes of stereo 44.1kHz 32-bit float audio.
pub const RAM_THRESHOLD_BYTES: u64 = 50 * 1024 * 1024;

/// A chunk of decoded audio data from the disk streamer.
///
/// Contains de-interleaved stereo data for a contiguous range of frames.
/// Produced by the DiskIO thread, consumed by the audio callback.
#[derive(Clone)]
pub struct StreamChunk {
    /// Left channel samples for this chunk.
    pub left: Vec<f32>,

    /// Right channel samples for this chunk (mono sources duplicate left).
    pub right: Vec<f32>,

    /// Absolute frame position in the source file where this chunk starts.
    pub start_frame: i64,

    /// Number of valid frames in this chunk (may be < CHUNK_FRAMES at EOF).
    pub num_frames: usize,
}

/// Internal state for the streaming window — a sorted ring of chunks
/// covering frames around the playhead.
///
/// Used by the audio callback to quickly locate the chunk(s) needed
/// for the current render buffer.
pub struct StreamingWindow {
    /// Sorted deque of chunks, ordered by `start_frame`.
    chunks: VecDeque<StreamChunk>,

    /// Total number of frames in the source file.
    total_frames: i64,

    /// Number of audio channels in the source.
    _num_channels: usize,

    /// Sample rate of the source.
    sample_rate: u32,

    /// Source file path (for logging/diagnostics).
    _source_path: String,
}

impl StreamingWindow {
    /// Creates a new empty streaming window.
    pub fn new(
        source_path: &str,
        total_frames: i64,
        num_channels: usize,
        sample_rate: u32,
    ) -> Self {
        Self {
            // Pre-allocate enough room for LOOK_AHEAD_CHUNKS*2 plus a small margin
            // so sorted inserts avoid reallocations in the audio callback.
            chunks: VecDeque::with_capacity((LOOK_AHEAD_CHUNKS * 2) + 2),
            total_frames,
            _num_channels: num_channels,
            sample_rate,
            _source_path: source_path.to_string(),
        }
    }

    /// Inserts a chunk into the window, maintaining sorted order.
    ///
    /// If a chunk with the same start_frame already exists, it is replaced.
    pub fn push_chunk(&mut self, chunk: StreamChunk) {
        let inserted_start = chunk.start_frame;
        let pos = self
            .chunks
            .binary_search_by_key(&chunk.start_frame, |c| c.start_frame);

        match pos {
            Ok(idx) => {
                self.chunks[idx] = chunk;
            }
            Err(idx) => {
                self.chunks.insert(idx, chunk);
            }
        }

        while self.chunks.len() > LOOK_AHEAD_CHUNKS * 2 {
            let first_start = self.chunks.front().map(|c| c.start_frame).unwrap_or(0);
            let last_start = self.chunks.back().map(|c| c.start_frame).unwrap_or(0);
            if (inserted_start - first_start).abs() > (inserted_start - last_start).abs() {
                self.chunks.pop_front();
            } else {
                self.chunks.pop_back();
            }
        }
    }

    /// Reads samples from the streaming window for a given frame range.
    ///
    /// If the requested range isn't fully buffered, returns silence
    /// for the missing portions (graceful degradation).
    ///
    /// # Real-Time Safety
    /// Zero allocations. Bounded iteration over a fixed-size deque.
    #[inline]
    pub fn read_into(
        &self,
        source_start: i64,
        num_frames: usize,
        out_left: &mut [f32],
        out_right: &mut [f32],
        out_offset: usize,
        gain: f32,
    ) -> bool {
        if num_frames == 0 || source_start >= self.total_frames {
            return false;
        }

        let mut any_hit = false;

        for chunk in &self.chunks {
            let chunk_end = chunk.start_frame + chunk.num_frames as i64;

            if chunk_end <= source_start {
                continue;
            }
            if chunk.start_frame >= source_start + num_frames as i64 {
                break;
            }

            let overlap_start = source_start.max(chunk.start_frame);
            let overlap_end = (source_start + num_frames as i64).min(chunk_end);
            let overlap_frames = (overlap_end - overlap_start) as usize;

            if overlap_frames == 0 {
                continue;
            }

            any_hit = true;

            let src_offset = (overlap_start - chunk.start_frame) as usize;
            let dst_offset = out_offset + (overlap_start - source_start) as usize;

            for i in 0..overlap_frames {
                let src_idx = src_offset + i;
                let dst_idx = dst_offset + i;

                if dst_idx >= out_left.len() || src_idx >= chunk.left.len() {
                    break;
                }

                out_left[dst_idx] += chunk.left[src_idx] * gain;
                out_right[dst_idx] += chunk.right[src_idx] * gain;
            }
        }

        any_hit
    }

    /// SR/warp aware read with Catmull-Rom interpolation.
    #[inline]
    #[allow(clippy::too_many_arguments)]
    pub fn read_into_rate(
        &self,
        source_start: f64,
        rate: f64,
        out_left: &mut [f32],
        out_right: &mut [f32],
        out_offset: usize,
        num_frames: usize,
        gain: f32,
    ) -> bool {
        if num_frames == 0 || out_offset >= out_left.len() || out_offset >= out_right.len() {
            return false;
        }

        let out_end = (out_offset + num_frames)
            .min(out_left.len())
            .min(out_right.len());
        let write_frames = out_end.saturating_sub(out_offset);
        if write_frames == 0 {
            return false;
        }

        let mut any_hit = false;
        let mut chunk_idx_hint = 0;
        let max_pos = (self.total_frames.saturating_sub(1)) as f64;
        if max_pos < 0.0 {
            return false;
        }

        for i in 0..write_frames {
            let src_pos = source_start + (i as f64) * rate;
            let out_idx = out_offset + i;

            if !src_pos.is_finite() {
                continue;
            }
            let clamped = src_pos.clamp(0.0, max_pos);
            let idx = clamped.floor() as i64;
            let t = (clamped - idx as f64) as f32;

            let frame0 = (idx - 1).max(0);
            let frame1 = idx.max(0).min(self.total_frames.saturating_sub(1));
            let frame2 = (idx + 1).max(0).min(self.total_frames.saturating_sub(1));
            let frame3 = (idx + 2).max(0).min(self.total_frames.saturating_sub(1));

            let mut sample_frame = |frame: i64, is_right: bool| -> Option<f32> {
                if frame < 0 || frame >= self.total_frames {
                    return None;
                }
                if let Some(c) = self.chunks.get(chunk_idx_hint) {
                    let end = c.start_frame + c.num_frames as i64;
                    if frame >= c.start_frame && frame < end {
                        let i = (frame - c.start_frame) as usize;
                        return if is_right {
                            c.right.get(i).copied()
                        } else {
                            c.left.get(i).copied()
                        };
                    }
                }
                for (search_idx, c) in self.chunks.iter().enumerate() {
                    let end = c.start_frame + c.num_frames as i64;
                    if frame >= c.start_frame && frame < end {
                        chunk_idx_hint = search_idx;
                        let src_idx = (frame - c.start_frame) as usize;
                        return if is_right {
                            c.right.get(src_idx).copied()
                        } else {
                            c.left.get(src_idx).copied()
                        };
                    }
                }
                None
            };

            let l1 = sample_frame(frame1, false);
            if let Some(p1) = l1 {
                let p0 = sample_frame(frame0, false).unwrap_or(p1);
                let p2 = sample_frame(frame2, false).unwrap_or(p1);
                let p3 = sample_frame(frame3, false).unwrap_or(p2);

                let a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
                let b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
                let c = -0.5 * p0 + 0.5 * p2;
                let d = p1;
                out_left[out_idx] += (((a * t + b) * t + c) * t + d) * gain;
                any_hit = true;
            }

            let r1 = sample_frame(frame1, true);
            if let Some(p1) = r1 {
                let p0 = sample_frame(frame0, true).unwrap_or(p1);
                let p2 = sample_frame(frame2, true).unwrap_or(p1);
                let p3 = sample_frame(frame3, true).unwrap_or(p2);

                let a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
                let b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
                let c = -0.5 * p0 + 0.5 * p2;
                let d = p1;
                out_right[out_idx] += (((a * t + b) * t + c) * t + d) * gain;
                any_hit = true;
            }
        }

        any_hit
    }

    /// Evicts chunks that are fully behind the given playhead position.
    pub fn evict_behind(&mut self, playhead: i64) {
        let rewind_margin = (LOOK_AHEAD_CHUNKS * CHUNK_FRAMES / 2) as i64;
        let evict_before = playhead.saturating_sub(rewind_margin);

        while let Some(front) = self.chunks.front() {
            let chunk_end = front.start_frame + front.num_frames as i64;
            if chunk_end <= evict_before {
                self.chunks.pop_front();
            } else {
                break;
            }
        }
    }

    /// Returns the range of frames currently buffered.
    pub fn buffered_range(&self) -> Option<(i64, i64)> {
        if let (Some(first), Some(last)) = (self.chunks.front(), self.chunks.back()) {
            Some((first.start_frame, last.start_frame + last.num_frames as i64))
        } else {
            None
        }
    }

    /// Returns the total number of frames in the source.
    pub fn total_frames(&self) -> i64 {
        self.total_frames
    }

    /// Returns the sample rate of the source.
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

/// Checks if a file exceeds the RAM threshold and should use disk streaming.
///
/// Returns `true` if the file should be streamed from disk.
pub fn should_stream(path: impl AsRef<Path>) -> bool {
    match std::fs::metadata(path) {
        Ok(meta) => meta.len() > RAM_THRESHOLD_BYTES,
        Err(_) => false,
    }
}
