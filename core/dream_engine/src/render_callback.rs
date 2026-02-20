// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Render Callback (The Conductor)
// ═══════════════════════════════════════════════════════════════════════════
//
// This module defines the stateful render context that processes audio
// in the real-time callback. It orchestrates ALL subsystems:
//
//   1. Transport → Where are we on the timeline?
//   2. ClipScheduler → Which clips are active in this buffer?
//   3. FadeCache → Click-free clip edges
//   4. ChannelStrip → Per-track gain + pan + metering
//   5. SummingBus → Mix all tracks into the master output
//   6. MasterClock → Publish frame count to UI thread
//
// THE HOT PATH. Zero allocations. Zero locks. Zero panics.
//
// ═══════════════════════════════════════════════════════════════════════════

use dream_clip_engine::disk_streamer::StreamingWindow;
use dream_clip_engine::pool::ClipPool;
use dream_clip_engine::reader::{ClipReader, WarpResampleMode};
use dream_clip_engine::scheduler::{ActiveClipInfo, ClipScheduler, LoopRegion as ClipLoopRegion};
use dream_dsp::device_chain::DeviceChain;
use dream_dsp::fades::FadeCache;
use dream_ipc::metering::{compute_peak, compute_rms, linear_to_db, peak_decay_for_block, MeterBank};
use dream_mixer::{ChannelStrip, SummingBus};
use dream_transport::Playhead;

use std::sync::Arc;

/// Module-level atomic counter for pool misses (RT-safe, no per-miss allocation).
static POOL_MISS_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// BUG-FIX: Separate counter for spectrum ring buffer drops (SSOT violation fix).
/// Previously both clip pool misses AND spectrum drops shared POOL_MISS_COUNT.
static SPECTRUM_DROP_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// BUG-64 FIX: Expose pool miss count for runtime diagnostics.
/// Returns the total number of clips that could not be found in the clip pool
/// or streaming windows since engine start.
#[inline]
pub fn pool_miss_count() -> u32 {
    POOL_MISS_COUNT.load(std::sync::atomic::Ordering::Relaxed)
}

/// Returns the total number of spectrum analyzer samples dropped due to
/// ring buffer overflow since engine start.
#[inline]
pub fn spectrum_drop_count() -> u32 {
    SPECTRUM_DROP_COUNT.load(std::sync::atomic::Ordering::Relaxed)
}

/// AUD-050 FIX: Reset diagnostic counters. Call when starting a new session
/// or when the UI requests a counter reset for fresh diagnostics.
pub fn reset_diagnostic_counters() {
    POOL_MISS_COUNT.store(0, std::sync::atomic::Ordering::Relaxed);
    SPECTRUM_DROP_COUNT.store(0, std::sync::atomic::Ordering::Relaxed);
}

// ── Constants ──────────────────────────────────────────────────────────────

/// Maximum number of tracks supported per project.
/// Pre-allocates buffers for this count.
pub const MAX_TRACKS: usize = 256;

/// Maximum audio buffer size in frames. Covers USB audio's worst case (4096)
/// with 2× margin for safety. This is the backing allocation size — actual
/// per-callback frame_count may be smaller (e.g. 256 on macOS CoreAudio).
pub const MAX_BUFFER_FRAMES: usize = 8192;

// ── Track Render Slot ──────────────────────────────────────────────────────

/// Pre-allocated per-track processing state (inline, zero-alloc in hot path).
pub struct TrackSlot {
    /// Scratch buffer: left channel samples for this track.
    pub buf_left: Vec<f32>,
    /// Scratch buffer: right channel samples for this track.
    pub buf_right: Vec<f32>,
    /// Per-track channel strip (gain, pan, mute).
    pub strip: ChannelStrip,
    /// Per-track insert effect chain (processed after strip, before metering).
    pub device_chain: DeviceChain,
    /// Was this slot active (had clips rendered) in the current buffer?
    pub active: bool,
    /// When `true`, the internal sampler on this track is bypassed and produces silence.
    pub instrument_bypassed: bool,
}

impl TrackSlot {
    /// Creates a new pre-allocated track slot.
    pub fn new(max_frames: usize, sample_rate: f64) -> Self {
        Self {
            buf_left: vec![0.0; max_frames],
            buf_right: vec![0.0; max_frames],
            strip: ChannelStrip::new(),
            // AUD-067: f64→f32 cast for DeviceChain sample rate. This is
            // lossless for common rates (44100, 48000, 96000) since they
            // fit exactly in f32. Only exotic rates (e.g. 176400/3) could
            // lose sub-Hz precision.
            device_chain: DeviceChain::new(sample_rate as f32),
            active: false,
            instrument_bypassed: false,
        }
    }

    /// Clears the scratch buffers (called at the start of each buffer).
    #[inline]
    pub fn clear(&mut self, frame_count: usize) {
        // AUD-001 FIX: Guard against frame_count exceeding buffer size.
        // Prevents panic if cpal delivers a larger-than-expected buffer.
        let n = frame_count.min(self.buf_left.len()).min(self.buf_right.len());
        self.buf_left[..n].fill(0.0);
        self.buf_right[..n].fill(0.0);
        self.active = false;
    }
}

// ── Render Context ─────────────────────────────────────────────────────────

/// The complete render context for the audio callback.
///
/// This struct is created once at engine startup and reused for every
/// buffer. All memory is pre-allocated — the hot path only fills
/// existing buffers.
///
/// # Thread Safety
/// This entire struct lives on the audio thread and is NEVER shared.
/// Cross-thread communication happens through:
/// - `rtrb::Consumer` for commands (drain per buffer)
/// - `Arc<MeterBank>` for metering (atomic writes)
/// - `Arc<MasterClock>` for frame count (atomic write)
pub struct RenderContext {
    /// Pre-allocated track slots.
    pub track_slots: Vec<TrackSlot>,

    /// Master output bus — sums all tracks.
    pub master_bus: SummingBus,

    /// Pre-computed fade curves (allocated once, used per-clip).
    pub fade_cache: FadeCache,

    /// Playhead — tracks current timeline position.
    pub playhead: Playhead,

    /// Sample rate (cached from stream config).
    pub sample_rate: f64,

    /// Timeline/project sample-rate domain for transport math.
    pub timeline_sample_rate: f64,

    /// Fractional carry when converting device frames into timeline frames.
    timeline_advance_accumulator: f64,

    /// Number of output channels (typically 2 for stereo).
    pub channels: usize,

    /// Shared meter bank (audio thread writes, UI thread reads).
    pub meter_bank: Arc<MeterBank>,

    /// Current loop region (None = no looping).
    pub loop_region: Option<ClipLoopRegion>,

    /// Streaming windows for disk-streamed clips (large files).
    /// Keyed by source file path. If a clip's file_path is found here,
    /// audio is read from the streaming window instead of the in-memory pool.
    /// This prevents OOM for files exceeding `RAM_THRESHOLD_BYTES`.
    ///
    /// AUD-002 NOTE: Uses Vec instead of HashMap to prevent allocation
    /// on insert. Reads in the hot path (`.find()`) are O(N) but N is very small.
    pub streaming_windows: Vec<(String, StreamingWindow)>,

    /// Reused active-clip scratch (pre-allocated, no per-buffer allocs).
    scratch_active_clips: Vec<ActiveClipInfo>,
    /// Secondary scratch for loop-wrap scheduling.
    scratch_post_wrap_clips: Vec<ActiveClipInfo>,

    /// Lock-free producer for spectrum analyzer feed.
    /// Audio thread pushes mono-mixed master output samples here.
    /// The consumer lives on the UI/spectrum thread and feeds FFT.
    pub spectrum_producer: Option<rtrb::Producer<f32>>,
}

/// Transparent soft-knee limiter using tanh identity.
///
/// AUD-034 NOTE: Uses `exp()` internally via the identity
/// `tanh(x) = (e^(2x) - 1) / (e^(2x) + 1)`. For extreme signals,
/// excess is clamped to 10.0 to prevent exp() overflow → NaN.
/// A tanh lookup table would save ~3ns/call at 4KB memory cost.
///
/// - Below ±1.0 (0 dBFS): **passthrough** — no coloration whatsoever.
/// - Above ±1.0: soft-knee compression that asymptotically approaches ±1.5,
///   preventing hard digital clipping while preserving transient shape.
///
/// This replaces the previous `x / (1 + |x|)` waveshaper which compressed
/// ALL signals (even –6 dBFS content was crushed by 34%).
#[inline]
pub fn soft_clip(sample: f32) -> f32 {
    // BUG-FIX: Guard NaN/Inf inputs early to prevent propagation.
    if !sample.is_finite() {
        return 0.0;
    }
    let abs = sample.abs();
    if abs <= 1.0 {
        sample // transparent below 0 dBFS
    } else {
        // Soft-knee: 1.0 + 0.5 * tanh(excess)
        // Uses the identity tanh(x) = 1 - 2/(e^(2x)+1) to avoid libm dependency.
        // Clamp excess to prevent exp() overflow → NaN at extreme signal levels.
        let excess = (abs - 1.0).min(10.0);
        let e2x = (2.0 * excess).exp();
        let tanh_val = (e2x - 1.0) / (e2x + 1.0);
        sample.signum() * (1.0 + 0.5 * tanh_val)
    }
}

impl RenderContext {
    /// Creates a fully pre-allocated render context.
    ///
    /// # Arguments
    /// - `track_count`: Number of tracks to pre-allocate slots for.
    /// - `sample_rate`: Audio sample rate (Hz).
    /// - `channels`: Number of output channels (usually 2).
    /// - `meter_bank`: Shared meter bank for lock-free metering.
    pub fn new(
        track_count: usize,
        sample_rate: f64,
        channels: usize,
        meter_bank: Arc<MeterBank>,
    ) -> Self {
        let actual_tracks = track_count.min(MAX_TRACKS);
        let mut track_slots: Vec<TrackSlot> = Vec::with_capacity(actual_tracks);
        for _ in 0..actual_tracks {
            track_slots.push(TrackSlot::new(MAX_BUFFER_FRAMES, sample_rate));
        }

        Self {
            track_slots,
            master_bus: SummingBus::new(MAX_BUFFER_FRAMES),
            fade_cache: FadeCache::new(sample_rate),
            playhead: Playhead::new(sample_rate),
            sample_rate,
            timeline_sample_rate: sample_rate,
            timeline_advance_accumulator: 0.0,
            // BUG-94 FIX: Guard against 0 channels to prevent div-by-zero in interleave.
            channels: channels.max(1),
            meter_bank,
            loop_region: None,
            streaming_windows: Vec::with_capacity(32),
            // AUD-071 FIX: 128 active clips per buffer is the realistic max.
            // 1024 wastes 7× memory for the scratch Vec's backing allocation.
            scratch_active_clips: Vec::with_capacity(128),
            scratch_post_wrap_clips: Vec::with_capacity(128),
            spectrum_producer: None,
        }
    }

    /// Set project/timeline sample-rate domain used by playhead and clip scheduling.
    pub fn set_timeline_sample_rate(&mut self, sample_rate: f64) {
        let sr = if sample_rate.is_finite() && sample_rate > 0.0 {
            sample_rate
        } else {
            self.sample_rate
        };
        self.timeline_sample_rate = sr;
        self.playhead.set_sample_rate(sr);
        // AUD-087: Accumulator reset is intentional here —
        // set_timeline_sample_rate is called from EngineCommand::SetTimelineSampleRate
        // which happens when the project SR changes (e.g., importing 96kHz clips
        // into a 44.1kHz project). The position jump is negligible (< 1 frame)
        // and prefer correctness over sub-frame continuity.
        self.timeline_advance_accumulator = 0.0;
        // BUG-034 FIX: Use device sample rate for fade curves since fades operate
        // in device-time (samples output to the soundcard), not timeline-time.
        // A 10ms fade at 44.1kHz project SR on a 96kHz device needs 960 samples.
        self.fade_cache = FadeCache::new(self.sample_rate);
    }

    /// The core render function — called once per audio buffer.
    ///
    /// # Arguments
    /// - `output`: The interleaved output buffer to fill (`[L, R, L, R, ...]`).
    /// - `clips_per_track`: Per-track clip lists. Index matches track index.
    /// - `clip_pool`: Pre-loaded audio data for zero-copy sample access.
    ///
    /// # Real-Time Safety
    /// Zero allocations. Zero locks. Zero I/O. Zero panics.
    /// All iteration is bounded by pre-known sizes.
    ///
    /// Phase 1: Fills track slot buffers with scheduled, faded, strip-processed audio.
    ///
    /// After this call, `self.track_slots[i].buf_left/buf_right` contain fully
    /// processed per-track audio (gain, pan, metering done). The master bus is
    /// NOT summed — use `render()` for the full pipeline, or sum manually in the
    /// graph path.
    ///
    /// Also advances the playhead.
    ///
    /// # Real-Time Safety
    /// Zero allocations. Zero locks. Zero I/O. Zero panics.
    #[inline]
    pub fn render_tracks(
        &mut self,
        frame_count: usize,
        clips_per_track: &[Vec<dream_models::project::AudioClip>],
        clip_pool: &ClipPool,
    ) {
        self.render_tracks_with_post_sum_mask(frame_count, clips_per_track, clip_pool, None, None);
    }

    /// Renders all tracks with support for post-sum mask and device-chain skipping.
    ///
    /// `skip_device_chain_mask`: when `true` for a track, the per-track
    /// `device_chain.process_stereo()` is SKIPPED here because the graph
    /// render callback in `driver.rs` handles individual device slots in
    /// user-defined order (interleaved with external VST plugins).
    /// Without this, internal effects (EQ, Compressor…) would be applied
    /// TWICE: once here (full-chain) and once in the graph loop.
    #[inline]
    pub fn render_tracks_with_post_sum_mask(
        &mut self,
        frame_count: usize,
        clips_per_track: &[Vec<dream_models::project::AudioClip>],
        clip_pool: &ClipPool,
        post_sum_mask: Option<&[bool]>,
        skip_device_chain_mask: Option<&[bool]>,
    ) {
        let playhead_pos = self.playhead.position();

        // ── 1. Clear all track buffers ──────────────────────────────
        for slot in &mut self.track_slots {
            slot.clear(frame_count);
        }
        self.master_bus.clear(frame_count);

        // ── 2. Schedule clips per track ─────────────────────────────
        // Diagnostic: track total active clips this buffer.
        // AUD-074: These are trace-only — zero-cost in release builds.
        let mut total_active = 0usize;
        let mut total_pool_hits = 0usize;
        // BUG-019 FIX: Larger buffers have more CPU time available → more Pro warp budget.
        // Previous values were inverted (1024+ frames got FEWER Pro warp slots).
        let mut pro_warp_budget = if frame_count >= 1024 { 12usize } else { 6usize };

        for (track_idx, clips) in clips_per_track.iter().enumerate() {
            if track_idx >= self.track_slots.len() {
                break;
            }

            ClipScheduler::fill_active_looped_with_tmp(
                clips,
                playhead_pos,
                frame_count,
                self.loop_region.as_ref(),
                &mut self.scratch_active_clips,
                &mut self.scratch_post_wrap_clips,
            );

            if self.scratch_active_clips.is_empty() {
                continue;
            }

            total_active += self.scratch_active_clips.len();
            let slot = &mut self.track_slots[track_idx];
            slot.active = true;

            // ── 3. Read clip audio into track buffer ────────────────
            for ac in &self.scratch_active_clips {
                let clip = &clips[ac.clip_index];
                // Skip muted clips — they remain visible but produce no audio.
                if clip.is_muted {
                    continue;
                }
                let clip_timeline_len = clip.duration.sample_frame.max(1) as f64;
                // AUD-089 FIX: Warn on zero-duration clips (hidden by max(1)).
                #[cfg(debug_assertions)]
                if clip.duration.sample_frame <= 0 {
                    log::warn!(
                        "[render] Zero-duration clip at track {} — will produce no audio",
                        track_idx
                    );
                }
                let clip_source_len = if clip.warp_source_duration_frames > 0 {
                    clip.warp_source_duration_frames as f64
                } else {
                    clip.duration.sample_frame.max(1) as f64
                };
                let is_warped = clip.is_warped && clip_source_len > 1.0;
                let playback_rate = if is_warped {
                    let rate = (clip_source_len / clip_timeline_len).clamp(0.125, 8.0);
                    // AUD-020 FIX: Log when playback rate is clamped.
                    #[cfg(debug_assertions)]
                    {
                        let unclamped = clip_source_len / clip_timeline_len;
                        if (unclamped - rate).abs() > 0.001 {
                            log::trace!(
                                "[render] Clip playback_rate clamped: {:.3} → {:.3}",
                                unclamped,
                                rate
                            );
                        }
                    }
                    rate
                } else {
                    1.0
                };
                let mut warp_mode = if clip.warp_mode.unwrap_or(0) <= 0 {
                    WarpResampleMode::Standard
                } else {
                    WarpResampleMode::Pro
                };
                if matches!(warp_mode, WarpResampleMode::Pro) {
                    if pro_warp_budget == 0 {
                        // BUG-010 FIX: Log quality downgrade at trace level (zero-cost in release).
                        log::trace!("[render] Pro warp budget exhausted — downgrading to Standard");
                        warp_mode = WarpResampleMode::Standard;
                    } else {
                        pro_warp_budget = pro_warp_budget.saturating_sub(1);
                    }
                }

                if let Some(audio) = clip_pool.get(&clip.file_path) {
                    total_pool_hits += 1;
                    let source_to_timeline_rate = (audio.sample_rate.max(1) as f64
                        / self.sample_rate.max(1.0))
                    .clamp(0.125, 8.0);
                    if is_warped {
                        let clip_local_timeline_start = (playhead_pos + ac.buffer_offset as i64
                            - clip.position.sample_frame)
                            .max(0) as f64;
                        let source_start = (clip.source_offset.sample_frame.max(0) as f64)
                            + clip_local_timeline_start * playback_rate * source_to_timeline_rate;
                        ClipReader::read_stereo_into_rate(
                            audio.left(),
                            audio.right(),
                            source_start,
                            playback_rate * source_to_timeline_rate,
                            &mut slot.buf_left,
                            &mut slot.buf_right,
                            ac.buffer_offset,
                            ac.frames_to_read,
                            clip.gain as f32,
                            warp_mode,
                        );
                    } else {
                        ClipReader::read_stereo_into_rate(
                            audio.left(),
                            audio.right(),
                            (ac.source_start_frame as f64) * source_to_timeline_rate,
                            source_to_timeline_rate,
                            &mut slot.buf_left,
                            &mut slot.buf_right,
                            ac.buffer_offset,
                            ac.frames_to_read,
                            clip.gain as f32,
                            WarpResampleMode::Standard,
                        );
                    }
                } else if let Some((_, window)) = self.streaming_windows.iter().find(|(p, _)| p == &clip.file_path) {
                    total_pool_hits += 1;
                    let source_to_timeline_rate = (window.sample_rate().max(1) as f64
                        / self.sample_rate.max(1.0))
                    .clamp(0.125, 8.0);
                    if is_warped {
                        let clip_local_timeline_start = (playhead_pos + ac.buffer_offset as i64
                            - clip.position.sample_frame)
                            .max(0) as f64;
                        let source_start = (clip.source_offset.sample_frame.max(0) as f64)
                            + clip_local_timeline_start * playback_rate * source_to_timeline_rate;
                        window.read_into_rate(
                            source_start,
                            playback_rate * source_to_timeline_rate,
                            &mut slot.buf_left,
                            &mut slot.buf_right,
                            ac.buffer_offset,
                            ac.frames_to_read,
                            clip.gain as f32,
                        );
                    } else {
                        window.read_into_rate(
                            (ac.source_start_frame as f64) * source_to_timeline_rate,
                            source_to_timeline_rate,
                            &mut slot.buf_left,
                            &mut slot.buf_right,
                            ac.buffer_offset,
                            ac.frames_to_read,
                            clip.gain as f32,
                        );
                    }
                } else {
                    POOL_MISS_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    continue;
                }

                // ── 3a. Apply fades at clip boundaries ───────────────
                let offset = ac.buffer_offset;
                let read_len = ac.frames_to_read;
                // AUD-004 FIX: Guard against offset + read_len exceeding buffer bounds.
                // This can happen if ClipScheduler returns stale buffer offsets after
                // a sample rate change or buffer size switch mid-stream.
                let safe_end = (offset + read_len).min(slot.buf_left.len()).min(slot.buf_right.len());
                let safe_read_len = safe_end.saturating_sub(offset);
                if safe_read_len > 0 {
                    let user_fade_in = clip.fade_in_frames.max(0) as usize;
                    let user_fade_out = clip.fade_out_frames.max(0) as usize;
                    let clip_len_frames = clip.duration.sample_frame.max(1) as usize;
                    let clip_local_start = (playhead_pos + ac.buffer_offset as i64
                        - clip.position.sample_frame)
                        .max(0) as usize;

                    let has_user_fades = user_fade_in > 0 || user_fade_out > 0;
                    if has_user_fades {
                        for i in 0..safe_read_len {
                            let clip_frame = clip_local_start + i;
                            let mut g = 1.0f32;

                            if user_fade_in > 0 && clip_frame < user_fade_in {
                                let t = clip_frame as f32 / user_fade_in.max(1) as f32;
                                let fade = t * t * (3.0 - 2.0 * t);
                                g *= fade;
                            }

                            if user_fade_out > 0 {
                                let fade_out_start = clip_len_frames.saturating_sub(user_fade_out);
                                if clip_frame >= fade_out_start {
                                    let rel = clip_frame.saturating_sub(fade_out_start);
                                    // BUG-017 FIX: Clamp t to [0,1] — prevents negative
                                    // Hann window values when clip_frame > clip_len_frames.
                                    let t = (rel as f32 / user_fade_out.max(1) as f32).min(1.0);
                                    let fade = 1.0 - (t * t * (3.0 - 2.0 * t));
                                    g *= fade;
                                }
                            }

                            slot.buf_left[offset + i] *= g;
                            slot.buf_right[offset + i] *= g;
                        }
                    } else {
                        let fade_len = self.fade_cache.fade_length;
                        // AE-015 FIX: Apply head fade even for short clips.
                        // Previously skipped when safe_read_len < fade_len,
                        // causing clicks at the start of very short clips.
                        if ac.is_clip_head {
                            let actual_fade = fade_len.min(safe_read_len);
                            if actual_fade > 0 {
                                for i in 0..actual_fade {
                                    // Map into the START portion of the fade_in table
                                    // so the first sample always hits gain=0.
                                    let table_idx = i;
                                    let gain = self.fade_cache.fade_in[table_idx];
                                    slot.buf_left[offset + i] *= gain;
                                    slot.buf_right[offset + i] *= gain;
                                }
                            }
                        }

                        // AUD-093 FIX: Apply tail fade even when safe_read_len < fade_len.
                        // Very short clips (< fade_len frames) previously got no auto-fade
                        // at all, producing a click at the end.
                        if ac.is_clip_tail {
                            let actual_fade = fade_len.min(safe_read_len);
                            if actual_fade > 0 {
                                let tail_start = offset + safe_read_len - actual_fade;
                                for i in 0..actual_fade {
                                    // Map into the END portion of the fade_out table
                                    // so that the last sample always hits gain=0.
                                    let table_idx = fade_len - actual_fade + i;
                                    let gain = self.fade_cache.fade_out[table_idx];
                                    slot.buf_left[tail_start + i] *= gain;
                                    slot.buf_right[tail_start + i] *= gain;
                                }
                            }
                        }
                    }
                }
            }
        }

        // BUG-65 FIX: Wire diagnostics to debug log instead of suppressing.
        if total_active > 0 {
            log::trace!(
                "[RenderCtx] pos={} active_clips={} pool_hits={}",
                playhead_pos, total_active, total_pool_hits
            );
        }

        // ── 4. Process channel strips (gain + pan) per track ────────
        let sr = self.sample_rate as f32;
        // AUD-003 FIX: Cache peak_decay once per render call. Previously
        // computed inside the per-track loop — exp() is ~5ns × 256 tracks
        // = 1.3μs wasted per buffer.
        let track_decay = peak_decay_for_block(self.sample_rate, frame_count);
        for (track_idx, slot) in self.track_slots.iter_mut().enumerate() {
            if !slot.active {
                continue;
            }
            let needs_post_sum_processing = post_sum_mask
                .and_then(|mask| mask.get(track_idx))
                .copied()
                .unwrap_or(false);
            if needs_post_sum_processing {
                continue;
            }

            slot.strip.process_stereo(
                &mut slot.buf_left[..frame_count],
                &mut slot.buf_right[..frame_count],
            );

            // Only process the full device chain here if the graph render
            // callback is NOT handling this track's effects. When external VSTs
            // are present, the graph callback processes internal + external
            // slots in user-defined order via process_slot_with_sidechain().
            let skip_device_chain = skip_device_chain_mask
                .and_then(|mask| mask.get(track_idx))
                .copied()
                .unwrap_or(false);
            if !skip_device_chain && !slot.device_chain.is_empty() {
                slot.device_chain.process_stereo(
                    &mut slot.buf_left[..frame_count],
                    &mut slot.buf_right[..frame_count],
                    sr,
                );
            }

            if let Some((meter_l, meter_r)) = self.meter_bank.track(track_idx) {
                let rms_l = linear_to_db(compute_rms(&slot.buf_left[..frame_count]));
                let rms_r = linear_to_db(compute_rms(&slot.buf_right[..frame_count]));
                let peak_l = linear_to_db(compute_peak(&slot.buf_left[..frame_count]));
                let peak_r = linear_to_db(compute_peak(&slot.buf_right[..frame_count]));

                meter_l.store_rms(rms_l);
                meter_r.store_rms(rms_r);
                meter_l.store_peak_decay(peak_l, track_decay);
                meter_r.store_peak_decay(peak_r, track_decay);
            }
        }

        // ── Advance playhead ─────────────────────────────────────
        // Convert ClipLoopRegion → transport LoopRegion so the
        // playhead wraps at the loop boundary during advance.
        let transport_loop = self.loop_region.as_ref().map(|r| {
            dream_transport::LoopRegion {
                start: r.start,
                end: r.end,
                enabled: true, // presence of Some = enabled
            }
        });
        let ratio = (self.timeline_sample_rate / self.sample_rate.max(1.0)).clamp(0.125, 8.0);
        let advance_exact = frame_count as f64 * ratio + self.timeline_advance_accumulator;
        let advance_frames = advance_exact.floor().max(0.0) as usize;
        self.timeline_advance_accumulator = advance_exact - (advance_frames as f64);
        // AUD-039/063 FIX: Recalibrate accumulator periodically.
        // At 192kHz/44.1kHz ratio, f64 precision errors accumulate ~1e-12 per frame.
        // After ~1M frames (~5 seconds), clamp to prevent unbounded drift.
        // This is a safety net — in practice drift is negligible for hours.
        if self.timeline_advance_accumulator.abs() > 1.0 {
            self.timeline_advance_accumulator = self.timeline_advance_accumulator.fract();
        }
        self.playhead
            .advance(advance_frames, transport_loop.as_ref());
    }

    /// Full render pipeline: fills track slots, sums into master bus, interleaves output.
    ///
    /// Use this when the audio DAG / graph path is NOT active.
    /// When the graph is active, call `render_tracks()` instead and let
    /// the graph handle summing and interleaving.
    #[inline]
    pub fn render(
        &mut self,
        output: &mut [f32],
        clips_per_track: &[Vec<dream_models::project::AudioClip>],
        clip_pool: &ClipPool,
    ) {
        let frame_count = output.len() / self.channels.max(1);

        // Phase 1: Fill track slots
        self.render_tracks(frame_count, clips_per_track, clip_pool);

        // ── 5. Sum into master bus ──────────────────────────────
        // SOLO FIX: Check BOTH active AND output_enabled. The driver sets
        // output_enabled=false when the track is muted or excluded by solo
        // (see set_output_enabled at L2097). Without this check, Solo had
        // no audible effect in the non-graph rendering path.
        let track_slots = &self.track_slots;
        let master_bus = &mut self.master_bus;
        for slot in track_slots {
            if !slot.active || !slot.strip.is_output_enabled() {
                continue;
            }
            master_bus.add_stereo(
                &slot.buf_left[..frame_count],
                &slot.buf_right[..frame_count],
            );
        }

        // ── 6. Write master output ──────────────────────────────────
        let master_l = &self.master_bus.left()[..frame_count];
        let master_r = &self.master_bus.right()[..frame_count];

        // Master metering
        let m_rms_l = linear_to_db(compute_rms(master_l));
        let m_rms_r = linear_to_db(compute_rms(master_r));
        let m_peak_l = linear_to_db(compute_peak(master_l));
        let m_peak_r = linear_to_db(compute_peak(master_r));

        let master_decay = peak_decay_for_block(self.sample_rate, frame_count);
        self.meter_bank.master_left().store_rms(m_rms_l);
        self.meter_bank.master_right().store_rms(m_rms_r);
        self.meter_bank
            .master_left()
            .store_peak_decay(m_peak_l, master_decay);
        self.meter_bank
            .master_right()
            .store_peak_decay(m_peak_r, master_decay);

        // AUD-043 FIX: Precompute safe frame count to avoid per-frame branch.
        let safe_frames = if self.channels >= 2 {
            (output.len() / self.channels).min(frame_count)
        } else {
            frame_count
        };
        // AUD-078 FIX: Stereo-specialized interleave (most common case).
        if self.channels == 2 {
            for i in 0..safe_frames {
                let base = i * 2;
                output[base] = soft_clip(master_l[i]);
                output[base + 1] = soft_clip(master_r[i]);
            }
        } else {
            for i in 0..safe_frames {
                let base = i * self.channels;
                if base + 1 < output.len() {
                    output[base] = soft_clip(master_l[i]);
                    output[base + 1] = soft_clip(master_r[i]);
                    for ch in 2..self.channels {
                        let idx = base + ch;
                        if idx < output.len() {
                            output[idx] = 0.0;
                        }
                    }
                }
            }
        }
        }
    }

    /// Returns the number of active (pre-allocated) track slots.
    pub fn track_count(&self) -> usize {
        self.track_slots.len()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_context_creation() {
        let meter_bank = Arc::new(MeterBank::new(32));
        let ctx = RenderContext::new(32, 44100.0, 2, meter_bank);

        assert_eq!(ctx.track_count(), 32);
        assert_eq!(ctx.channels, 2);
        assert_eq!(ctx.sample_rate, 44100.0);
        // AUD-083 FIX: Verify buffers are MAX_BUFFER_FRAMES.
        assert_eq!(ctx.track_slots[0].buf_left.len(), MAX_BUFFER_FRAMES);
        assert_eq!(ctx.track_slots[0].buf_right.len(), MAX_BUFFER_FRAMES);
    }

    #[test]
    fn track_slot_clear() {
        let mut slot = TrackSlot::new(512, 44100.0);
        slot.buf_left[0] = 1.0;
        slot.buf_left[100] = 0.5;
        slot.active = true;

        slot.clear(256);

        assert_eq!(slot.buf_left[0], 0.0);
        assert_eq!(slot.buf_left[100], 0.0);
        assert!(!slot.active);
    }

    #[test]
    fn max_tracks_clamped() {
        let meter_bank = Arc::new(MeterBank::new(MAX_TRACKS));
        let ctx = RenderContext::new(500, 44100.0, 2, meter_bank);

        // Requesting 500 tracks should be clamped to MAX_TRACKS (256).
        assert_eq!(ctx.track_count(), MAX_TRACKS);
    }

    #[test]
    fn render_silence_produces_silence() {
        let meter_bank = Arc::new(MeterBank::new(8));
        let mut ctx = RenderContext::new(8, 44100.0, 2, meter_bank);
        let pool = ClipPool::new();

        let mut output = vec![1.0_f32; 512]; // Fill with 1.0 first
        let no_clips: Vec<Vec<dream_models::project::AudioClip>> = Vec::new();

        ctx.render(&mut output, &no_clips, &pool);

        // All output should be zero (no clips = silence)
        assert!(
            output.iter().all(|s| *s == 0.0),
            "Empty project should produce silence"
        );
    }
}
