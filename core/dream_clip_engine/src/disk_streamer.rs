// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Disk Streaming Engine (OOM Prevention)
// ═══════════════════════════════════════════════════════════════════════════
//
// Streams audio data from disk in real time, preventing out-of-memory
// conditions when working with large audio files (podcasts, film scores).
//
// Architecture:
//   ┌─────────────────┐    rtrb (lock-free SPSC)    ┌──────────────────┐
//   │  DiskIO Thread   │ ─────────────────────────▶ │  Audio Callback  │
//   │ (symphonia read) │    StreamChunk { data }     │ (zero-alloc mix) │
//   └─────────────────┘                              └──────────────────┘
//           ▲                                               │
//           │ playhead position (AtomicI64)                  │
//           └───────────────────────────────────────────────┘
//
// The DiskIO thread reads AHEAD of the playhead (look-ahead window),
// decoding audio chunks from disk and pushing them into a ring buffer.
// The audio callback pops chunks and copies samples into track buffers.
//
// Memory usage: O(buffer_size) — constant, regardless of file length.
//
// ═══════════════════════════════════════════════════════════════════════════

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::thread;

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
            chunks: VecDeque::with_capacity(LOOK_AHEAD_CHUNKS + 4),
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
        // Find insertion point (sorted by start_frame)
        let pos = self
            .chunks
            .iter()
            .position(|c| c.start_frame >= chunk.start_frame);

        match pos {
            Some(idx) => {
                if self.chunks[idx].start_frame == chunk.start_frame {
                    // Replace existing chunk at same position
                    self.chunks[idx] = chunk;
                } else {
                    self.chunks.insert(idx, chunk);
                }
            }
            None => {
                self.chunks.push_back(chunk);
            }
        }

        // Evict old chunks that are far behind the newest chunk
        while self.chunks.len() > LOOK_AHEAD_CHUNKS * 2 {
            self.chunks.pop_front();
        }
    }

    /// Reads samples from the streaming window for a given frame range.
    ///
    /// Returns `&[f32]` slices for left and right channels covering
    /// `[start_frame..start_frame + num_frames)`.
    ///
    /// If the requested range isn't fully buffered, returns silence
    /// for the missing portions (graceful degradation).
    ///
    /// # Arguments
    /// - `start_frame`: Absolute frame position in the source file.
    /// - `num_frames`: Number of frames to read.
    /// - `out_left`: Output buffer for left channel.
    /// - `out_right`: Output buffer for right channel.
    /// - `out_offset`: Offset in the output buffers to start writing.
    /// - `gain`: Volume multiplier.
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

        // Fades are NOT applied here — clip boundary fades are handled
        // by the render callback (FadeCache / user-defined fades).

        for chunk in &self.chunks {
            let chunk_end = chunk.start_frame + chunk.num_frames as i64;

            // Skip chunks that don't overlap the requested range
            if chunk_end <= source_start {
                continue;
            }
            if chunk.start_frame >= source_start + num_frames as i64 {
                break; // Past the range (chunks are sorted)
            }

            // Calculate overlap
            let overlap_start = source_start.max(chunk.start_frame);
            let overlap_end = (source_start + num_frames as i64).min(chunk_end);
            let overlap_frames = (overlap_end - overlap_start) as usize;

            if overlap_frames == 0 {
                continue;
            }

            any_hit = true;

            // Source offset within the chunk
            let src_offset = (overlap_start - chunk.start_frame) as usize;
            // Destination offset within the output buffers
            let dst_offset = out_offset + (overlap_start - source_start) as usize;

            // Pure additive mixing — no fades, no coloration
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

    #[inline(always)]
    fn sample_at_frame(&self, frame: i64, right_channel: bool) -> Option<f32> {
        if frame < 0 || frame >= self.total_frames {
            return None;
        }

        for chunk in &self.chunks {
            let start = chunk.start_frame;
            let end = chunk.start_frame + chunk.num_frames as i64;
            if frame < start || frame >= end {
                continue;
            }
            let idx = (frame - start) as usize;
            if right_channel {
                return chunk.right.get(idx).copied();
            }
            return chunk.left.get(idx).copied();
        }

        None
    }

    #[inline(always)]
    fn sample_linear_at(&self, pos: f64, right_channel: bool) -> Option<f32> {
        if !pos.is_finite() {
            return None;
        }
        let max_pos = (self.total_frames.saturating_sub(1)) as f64;
        if max_pos < 0.0 {
            return None;
        }

        let clamped = pos.clamp(0.0, max_pos);
        let i0 = clamped.floor() as i64;
        let i1 = (i0 + 1).min(self.total_frames.saturating_sub(1));
        let frac = (clamped - i0 as f64) as f32;

        let s0 = self.sample_at_frame(i0, right_channel)?;
        let s1 = self.sample_at_frame(i1, right_channel).unwrap_or(s0);
        Some(s0 * (1.0 - frac) + s1 * frac)
    }

    /// SR/warp aware read with linear interpolation.
    ///
    /// This is used when timeline-domain and source-domain frame rates diverge
    /// (sample-rate conversion and/or warp playback-rate).
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
        for i in 0..write_frames {
            let src_pos = source_start + (i as f64) * rate;
            let out_idx = out_offset + i;

            if let Some(v) = self.sample_linear_at(src_pos, false) {
                out_left[out_idx] += v * gain;
                any_hit = true;
            }
            if let Some(v) = self.sample_linear_at(src_pos, true) {
                out_right[out_idx] += v * gain;
                any_hit = true;
            }
        }

        any_hit
    }

    /// Evicts chunks that are fully behind the given playhead position.
    ///
    /// Keeps chunks within `LOOK_AHEAD_CHUNKS * CHUNK_FRAMES` frames
    /// behind the playhead for rewind tolerance.
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

/// Handle for the DiskIO background thread.
///
/// Manages the lifecycle of a background disk reading thread for a
/// single audio source. The thread pre-reads audio ahead of the
/// playhead and fills the `StreamingWindow` via lock-free ring buffer.
pub struct DiskStreamerHandle {
    /// Shared playhead position — written by the audio callback,
    /// read by the DiskIO thread to determine what to read next.
    pub playhead: Arc<AtomicI64>,

    /// Kill signal — set to `true` to stop the DiskIO thread.
    kill: Arc<AtomicBool>,

    /// Thread join handle.
    thread: Option<thread::JoinHandle<()>>,

    /// Consumer side of the chunk ring buffer.
    /// The audio callback drains this into the `StreamingWindow`.
    consumer: rtrb::Consumer<StreamChunk>,

    /// Source file path.
    pub source_path: String,

    /// Total frames in the source.
    pub total_frames: i64,

    /// Number of channels.
    pub num_channels: usize,

    /// Sample rate.
    pub sample_rate: u32,
}

impl DiskStreamerHandle {
    /// Spawns a new disk streaming thread for the given audio file.
    ///
    /// The thread starts reading from frame 0 and continuously reads
    /// ahead of the playhead position.
    ///
    /// # Arguments
    /// - `path`: Path to the audio file.
    /// - `sample_rate`: Expected sample rate (for validation).
    /// - `total_frames`: Total number of frames in the file.
    /// - `num_channels`: Number of audio channels.
    pub fn spawn(
        path: impl AsRef<Path>,
        sample_rate: u32,
        total_frames: i64,
        num_channels: usize,
    ) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        let source_path = path.to_string_lossy().to_string();

        // Create lock-free ring buffer for chunk delivery
        let ring_size = LOOK_AHEAD_CHUNKS * 2;
        let (producer, consumer) = rtrb::RingBuffer::new(ring_size);

        let playhead = Arc::new(AtomicI64::new(0));
        let kill = Arc::new(AtomicBool::new(false));

        let playhead_clone = Arc::clone(&playhead);
        let kill_clone = Arc::clone(&kill);
        let path_for_thread = path.clone();
        let num_ch = num_channels;

        let thread = thread::Builder::new()
            .name(format!("disk-io:{}", source_path))
            .spawn(move || {
                disk_io_thread(
                    path_for_thread,
                    producer,
                    playhead_clone,
                    kill_clone,
                    sample_rate,
                    total_frames,
                    num_ch,
                );
            })
            .map_err(|e| format!("Failed to spawn DiskIO thread: {e}"))?;

        log::info!(
            "DiskStreamer: spawned for '{}' ({} frames, {}ch, {}Hz)",
            source_path,
            total_frames,
            num_channels,
            sample_rate
        );

        Ok(Self {
            playhead,
            kill,
            thread: Some(thread),
            consumer,
            source_path,
            total_frames,
            num_channels,
            sample_rate,
        })
    }

    /// Drains available chunks from the ring buffer into the streaming window.
    ///
    /// # Real-Time Safety
    /// Lock-free — `rtrb::Consumer::pop()` is wait-free.
    /// Call this at the start of each render callback.
    #[inline]
    pub fn drain_into(&mut self, window: &mut StreamingWindow) {
        while let Ok(chunk) = self.consumer.pop() {
            window.push_chunk(chunk);
        }
    }

    /// Updates the playhead position (called from the audio callback).
    ///
    /// The DiskIO thread uses this to determine which chunks to pre-read.
    #[inline]
    pub fn set_playhead(&self, position: i64) {
        self.playhead.store(position, Ordering::Release);
    }
}

impl Drop for DiskStreamerHandle {
    fn drop(&mut self) {
        self.kill.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            // BUG-053 FIX: Timeout on thread join to prevent infinite hang
            // if the DiskIO thread is stuck on a slow I/O operation.
            let (tx, rx) = std::sync::mpsc::channel();
            let join_thread = std::thread::spawn(move || {
                let _ = thread.join();
                let _ = tx.send(());
            });
            match rx.recv_timeout(std::time::Duration::from_secs(2)) {
                Ok(()) => {}
                Err(_) => {
                    log::warn!("DiskStreamer: thread join timed out for '{}', detaching", self.source_path);
                    drop(join_thread); // Detach — OS will clean up
                }
            }
        }
        log::info!("DiskStreamer: stopped for '{}'", self.source_path);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// DiskIO Thread Implementation
// ═══════════════════════════════════════════════════════════════════════════

/// Background thread that reads audio chunks from disk ahead of the playhead.
///
/// This is NOT real-time safe — it performs disk I/O and allocations.
/// It communicates with the audio thread ONLY through:
/// - `producer`: Lock-free SPSC ring buffer for chunk delivery
/// - `playhead`: Atomic read of the current playhead position
/// - `kill`: Atomic kill signal
fn disk_io_thread(
    path: PathBuf,
    mut producer: rtrb::Producer<StreamChunk>,
    playhead: Arc<AtomicI64>,
    kill: Arc<AtomicBool>,
    _sample_rate: u32,
    total_frames: i64,
    _num_channels: usize,
) {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    // symphonia::core::units::Time available for future seek-by-time

    // ── Open and probe the audio file ───────────────────────────
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) => {
            log::error!("DiskIO: failed to open '{}': {}", path.display(), e);
            return;
        }
    };

    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = match symphonia::default::get_probe().format(
        &hint,
        mss,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    ) {
        Ok(p) => p,
        Err(e) => {
            log::error!("DiskIO: failed to probe '{}': {}", path.display(), e);
            return;
        }
    };

    let mut format = probed.format;
    let track = match format.default_track() {
        Some(t) => t.clone(),
        None => {
            log::error!("DiskIO: no audio track in '{}'", path.display());
            return;
        }
    };

    let mut decoder = match symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
    {
        Ok(d) => d,
        Err(e) => {
            log::error!(
                "DiskIO: failed to create decoder for '{}': {}",
                path.display(),
                e
            );
            return;
        }
    };

    let track_id = track.id;

    // ── Streaming loop ──────────────────────────────────────────
    let mut last_read_frame: i64 = 0;
    let mut needs_seek = false;
    let mut consecutive_errors = 0u32;
    let mut pending_chunk: Option<StreamChunk> = None;
    // BUG-051 FIX: Pre-allocate SampleBuffer outside the loop to avoid
    // allocating a new one for every decoded packet. Lazily initialized
    // because we need the AudioSpec from the first decoded packet.
    let mut reusable_sample_buf: Option<SampleBuffer<f32>> = None;

    log::info!("DiskIO: thread started for '{}'", path.display());

    loop {
        if kill.load(Ordering::Relaxed) {
            break;
        }

        let current_playhead = playhead.load(Ordering::Acquire);

        // If back-pressure left us with an unsent chunk, retry push first.
        // This avoids re-decoding the same source span repeatedly when the ring
        // is temporarily full.
        if let Some(chunk) = pending_chunk.take() {
            match producer.push(chunk) {
                Ok(()) => {
                    // Successfully delivered; continue with normal prefetch.
                }
                Err(rtrb::PushError::Full(chunk)) => {
                    pending_chunk = Some(chunk);
                    thread::sleep(std::time::Duration::from_millis(1));
                    continue;
                }
            }
        }

        // ── Determine what to read ──────────────────────────────
        // Read ahead of the playhead by LOOK_AHEAD_CHUNKS chunks.
        let look_ahead_end = current_playhead + (LOOK_AHEAD_CHUNKS as i64 * CHUNK_FRAMES as i64);

        // Check if we need to seek (playhead jumped significantly)
        let jump_threshold = (CHUNK_FRAMES * LOOK_AHEAD_CHUNKS / 2) as i64;
        if (current_playhead - last_read_frame).abs() > jump_threshold && last_read_frame != 0 {
            needs_seek = true;
            last_read_frame = current_playhead;
        }

        // If we're already ahead of the look-ahead window, sleep and retry
        if last_read_frame >= look_ahead_end || last_read_frame >= total_frames {
            thread::sleep(std::time::Duration::from_millis(5));
            continue;
        }

        // ── Seek if needed ──────────────────────────────────────
        if needs_seek {
            let seek_to_frame = current_playhead.max(0) as u64;
            match format.seek(
                SeekMode::Coarse,
                SeekTo::TimeStamp {
                    ts: seek_to_frame,
                    track_id,
                },
            ) {
                Ok(seeked) => {
                    last_read_frame = seeked.actual_ts as i64;
                    decoder.reset();
                    log::debug!(
                        "DiskIO: seeked to frame {} (requested {})",
                        last_read_frame,
                        seek_to_frame
                    );
                }
                Err(e) => {
                    // BUG-003 FIX: Stay near the playhead instead of jumping to 0.
                    // Resetting to 0 would cause the user to hear wrong audio.
                    log::error!(
                        "DiskIO: seek to frame {} failed: {} — staying at frame {}",
                        seek_to_frame, e, current_playhead
                    );
                    last_read_frame = current_playhead;
                }
            }
            needs_seek = false;
        }

        // ── Read a chunk ────────────────────────────────────────
        let mut left_buf = Vec::with_capacity(CHUNK_FRAMES);
        let mut right_buf = Vec::with_capacity(CHUNK_FRAMES);
        let chunk_start_frame = last_read_frame;
        let mut frames_read = 0usize;

        while frames_read < CHUNK_FRAMES {
            if kill.load(Ordering::Relaxed) {
                return;
            }

            let packet = match format.next_packet() {
                Ok(p) => {
                    if p.track_id() != track_id {
                        continue;
                    }
                    p
                }
                Err(symphonia::core::errors::Error::IoError(ref e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    // End of file — pad remaining with silence
                    let remaining = CHUNK_FRAMES - frames_read;
                    left_buf.extend(std::iter::repeat_n(0.0f32, remaining));
                    right_buf.extend(std::iter::repeat_n(0.0f32, remaining));
                    frames_read = CHUNK_FRAMES;
                    last_read_frame = total_frames;
                    break;
                }
                Err(e) => {
                    consecutive_errors += 1;
                    if consecutive_errors > 100 {
                        log::error!("DiskIO: too many errors, stopping: {}", e);
                        return;
                    }
                    log::warn!("DiskIO: packet error (#{consecutive_errors}): {}", e);
                    // BUG-049 FIX: Exponential backoff (1→2→4→...→100ms) prevents
                    // spinning at full CPU during sustained filesystem issues while
                    // recovering quickly from transient errors.
                    let backoff_ms = (1u64 << consecutive_errors.min(7)).min(100);
                    thread::sleep(std::time::Duration::from_millis(backoff_ms));
                    continue;
                }
            };

            consecutive_errors = 0;

            let decoded = match decoder.decode(&packet) {
                Ok(d) => d,
                Err(e) => {
                    log::warn!("DiskIO: decode error: {}", e);
                    continue;
                }
            };

            let spec = *decoded.spec();
            let duration = decoded.capacity();
            // BUG-051 FIX: Reuse SampleBuffer across packets. Re-create only
            // when the current buffer is too small (rare — codec packets are
            // typically a fixed size like 1024 or 2048 frames).
            let sample_buf = reusable_sample_buf.get_or_insert_with(|| {
                SampleBuffer::<f32>::new(duration as u64, spec)
            });
            // If capacity is insufficient (variable-length codec), replace.
            if sample_buf.capacity() < duration {
                *sample_buf = SampleBuffer::<f32>::new(duration as u64, spec);
            }
            sample_buf.copy_interleaved_ref(decoded);
            let samples = sample_buf.samples();
            let ch = spec.channels.count().max(1);

            let packet_frames = samples.len() / ch;
            let take_frames = (CHUNK_FRAMES - frames_read).min(packet_frames);

            for i in 0..take_frames {
                let l = samples[i * ch];
                let r = if ch > 1 { samples[i * ch + 1] } else { l };
                left_buf.push(l);
                right_buf.push(r);
            }

            frames_read += take_frames;
        }

        // ── Push chunk to ring buffer ───────────────────────────
        let chunk = StreamChunk {
            left: left_buf,
            right: right_buf,
            start_frame: chunk_start_frame,
            num_frames: frames_read,
        };

        match producer.push(chunk) {
            Ok(()) => {
                last_read_frame = chunk_start_frame + frames_read as i64;
            }
            Err(rtrb::PushError::Full(chunk)) => {
                // Ring buffer full — preserve the already decoded chunk and retry
                // on the next loop iteration instead of decoding it again.
                pending_chunk = Some(chunk);
                thread::sleep(std::time::Duration::from_millis(1));
            }
        }
    }

    log::info!("DiskIO: thread exiting for '{}'", path.display());
}

// ═══════════════════════════════════════════════════════════════════════════
// Utility: File size check
// ═══════════════════════════════════════════════════════════════════════════

/// Checks if a file exceeds the RAM threshold and should use disk streaming.
///
/// Returns `true` if the file should be streamed from disk.
pub fn should_stream(path: impl AsRef<Path>) -> bool {
    match std::fs::metadata(path) {
        Ok(meta) => meta.len() > RAM_THRESHOLD_BYTES,
        Err(_) => false,
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_window_push_and_read() {
        let mut window = StreamingWindow::new("test.wav", 100000, 2, 48000);

        // Push a chunk
        let chunk = StreamChunk {
            left: vec![0.5; CHUNK_FRAMES],
            right: vec![-0.3; CHUNK_FRAMES],
            start_frame: 0,
            num_frames: CHUNK_FRAMES,
        };
        window.push_chunk(chunk);

        // Read from it
        let mut out_l = vec![0.0; 256];
        let mut out_r = vec![0.0; 256];
        let hit = window.read_into(0, 256, &mut out_l, &mut out_r, 0, 1.0);

        assert!(hit);
        // Middle samples (past micro-fade) should have content
        assert!(out_l[128].abs() > 0.3);
        assert!(out_r[128].abs() > 0.2);
    }

    #[test]
    fn streaming_window_sorted_insert() {
        let mut window = StreamingWindow::new("test.wav", 100000, 2, 48000);

        // Push chunks out of order
        window.push_chunk(StreamChunk {
            left: vec![0.2; 100],
            right: vec![0.2; 100],
            start_frame: 200,
            num_frames: 100,
        });
        window.push_chunk(StreamChunk {
            left: vec![0.5; 100],
            right: vec![0.5; 100],
            start_frame: 0,
            num_frames: 100,
        });
        window.push_chunk(StreamChunk {
            left: vec![0.3; 100],
            right: vec![0.3; 100],
            start_frame: 100,
            num_frames: 100,
        });

        let range = window.buffered_range().unwrap();
        assert_eq!(range.0, 0);
        assert_eq!(range.1, 300);
    }

    #[test]
    fn streaming_window_eviction() {
        let mut window = StreamingWindow::new("test.wav", 1000000, 2, 48000);

        // Push many chunks
        for i in 0..LOOK_AHEAD_CHUNKS * 3 {
            window.push_chunk(StreamChunk {
                left: vec![0.1; CHUNK_FRAMES],
                right: vec![0.1; CHUNK_FRAMES],
                start_frame: (i * CHUNK_FRAMES) as i64,
                num_frames: CHUNK_FRAMES,
            });
        }

        let big_playhead = (LOOK_AHEAD_CHUNKS * 2 * CHUNK_FRAMES) as i64;
        window.evict_behind(big_playhead);

        // Old chunks should be evicted
        let range = window.buffered_range().unwrap();
        assert!(range.0 > 0);
    }

    #[test]
    fn should_stream_small_file() {
        // This test just verifies the threshold logic
        assert!(!should_stream("/nonexistent/file.wav"));
    }

    #[test]
    fn empty_window_returns_false() {
        let window = StreamingWindow::new("test.wav", 100000, 2, 48000);
        let mut out_l = vec![0.0; 256];
        let mut out_r = vec![0.0; 256];
        let hit = window.read_into(0, 256, &mut out_l, &mut out_r, 0, 1.0);
        assert!(!hit);
    }
}
