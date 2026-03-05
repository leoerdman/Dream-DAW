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
use dream_ipc::metering::{
    MeterBank, compute_peak, compute_rms, linear_to_db, peak_decay_for_block,
};
use dream_mixer::{ChannelStrip, SummingBus};
use dream_transport::Playhead;

use std::sync::Arc;

/// Module-level atomic counter for pool misses (RT-safe, no per-miss allocation).
static POOL_MISS_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// BUG-FIX: Separate counter for spectrum ring buffer drops (SSOT violation fix).
/// Previously both clip pool misses AND spectrum drops shared POOL_MISS_COUNT.
pub static SPECTRUM_DROP_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);


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
    // atomic clear removed
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
    /// Thread-local scratch buffer for external left output.
    pub ext_left: Vec<f32>,
    /// Thread-local scratch buffer for external right output.
    pub ext_right: Vec<f32>,
    /// Sidechain tap: Pre-FX signal (after clip read, before device chain).
    pub sidechain_pre_fx_left: Vec<f32>,
    /// Sidechain tap: Pre-FX signal (after clip read, before device chain).
    pub sidechain_pre_fx_right: Vec<f32>,
    /// Sidechain tap: Post-FX signal (after device chain, before channel strip).
    pub sidechain_post_fx_left: Vec<f32>,
    /// Sidechain tap: Post-FX signal (after device chain, before channel strip).
    pub sidechain_post_fx_right: Vec<f32>,
    /// Thread-local scratch buffer for VST3 MIDI events.
    pub vst3_midi_scratch: Vec<dream_plugins::MidiEvent>,
    /// Thread-local scratch buffer for scheduled MIDI notes.
    pub midi_schedule_scratch: Vec<dream_clip_engine::midi_scheduler::ScheduledNote>,
    /// Thread-local scratch buffer for MIDI note loop wrapping.
    pub midi_schedule_tmp: Vec<dream_clip_engine::midi_scheduler::ScheduledNote>,
    /// Thread-local scratch buffer for sorted MIDI events.
    pub midi_events_scratch: Vec<(usize, u8, u8, u8, u64)>,
}

impl TrackSlot {
    /// Creates a new pre-allocated track slot.
    pub fn new(max_frames: usize, sample_rate: f64) -> Self {
        Self {
            buf_left: vec![0.0; max_frames],
            buf_right: vec![0.0; max_frames],
            // BUG-006 FIX: Use with_sample_rate() so smoothing coefficients are
            // tuned for the actual device sample rate from the start. Previously
            // used new() which hardcodes 44.1kHz — at 96kHz the smoothing was 2×
            // faster until set_sample_rate() was called.
            strip: ChannelStrip::with_sample_rate(sample_rate as f32),
            // AUD-067: f64→f32 cast for DeviceChain sample rate. This is
            // lossless for common rates (44100, 48000, 96000) since they
            // fit exactly in f32. Only exotic rates (e.g. 176400/3) could
            // lose sub-Hz precision.
            device_chain: DeviceChain::new(sample_rate as f32),
            active: false,
            instrument_bypassed: false,
            ext_left: vec![0.0; max_frames],
            ext_right: vec![0.0; max_frames],
            sidechain_pre_fx_left: vec![0.0; max_frames],
            sidechain_pre_fx_right: vec![0.0; max_frames],
            sidechain_post_fx_left: vec![0.0; max_frames],
            sidechain_post_fx_right: vec![0.0; max_frames],
            vst3_midi_scratch: Vec::with_capacity(4096),
            midi_schedule_scratch: Vec::with_capacity(4096),
            midi_schedule_tmp: Vec::with_capacity(4096),
            midi_events_scratch: Vec::with_capacity(4096),
        }
    }

    /// Clears the scratch buffers (called at the start of each buffer).
    #[inline]
    pub fn clear(&mut self, frame_count: usize) {
        // AUD-001 FIX: Guard against frame_count exceeding buffer size.
        // Prevents panic if cpal delivers a larger-than-expected buffer.
        let n = frame_count
            .min(self.buf_left.len())
            .min(self.buf_right.len());
        self.buf_left[..n].fill(0.0);
        self.buf_right[..n].fill(0.0);
        // BUG-014 FIX: Also clear external plugin scratch buffers.
        // Without this, leftover audio from a removed plugin leaks
        // into subsequent buffers.
        let ext_n = n.min(self.ext_left.len()).min(self.ext_right.len());
        self.ext_left[..ext_n].fill(0.0);
        self.ext_right[..ext_n].fill(0.0);
        // Sidechain tap buffers: Pre-FX and Post-FX.
        let sc_n = n.min(self.sidechain_pre_fx_left.len())
            .min(self.sidechain_pre_fx_right.len())
            .min(self.sidechain_post_fx_left.len())
            .min(self.sidechain_post_fx_right.len());
        self.sidechain_pre_fx_left[..sc_n].fill(0.0);
        self.sidechain_pre_fx_right[..sc_n].fill(0.0);
        self.sidechain_post_fx_left[..sc_n].fill(0.0);
        self.sidechain_post_fx_right[..sc_n].fill(0.0);
        self.active = false;
    }
}

// ── Render Context ─────────────────────────────────────────────────────────

/// BUG-8 FIX: Lock-free per-track internal effect latency snapshot.
///
/// The audio thread publishes `device_chain.total_latency_samples()` for each
/// track here. The background thread reads it during PDC latency collection
/// so that internal effects with non-zero latency (Compressor lookahead,
/// Limiter lookahead) are properly compensated.
///
/// Uses a flat `AtomicU32` array for TRUE RT-safety: zero allocations,
/// zero Mutex, zero blocking. Each write is a single atomic store.
pub struct SharedInternalLatencySnapshot {
    latencies: Vec<std::sync::atomic::AtomicU32>,
}

impl SharedInternalLatencySnapshot {
    pub fn new(track_count: usize) -> Self {
        let mut latencies = Vec::with_capacity(track_count);
        for _ in 0..track_count {
            latencies.push(std::sync::atomic::AtomicU32::new(0));
        }
        Self { latencies }
    }

    /// RT-safe publish: single atomic store per track, zero allocations.
    #[inline]
    pub fn publish_track(&self, track_idx: usize, latency_samples: u32) {
        if let Some(slot) = self.latencies.get(track_idx) {
            slot.store(latency_samples, std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// Lock-free load for background/UI thread.
    pub fn load_all(&self, out: &mut Vec<u32>) {
        out.clear();
        out.reserve(self.latencies.len());
        for slot in &self.latencies {
            out.push(slot.load(std::sync::atomic::Ordering::Relaxed));
        }
    }

    pub fn track_count(&self) -> usize {
        self.latencies.len()
    }
}

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

    /// BUG-8 FIX: Per-track internal effect latency for PDC.
    /// Published by audio thread after each callback.
    pub internal_latency_snapshot: Arc<SharedInternalLatencySnapshot>,

    /// Current loop region (None = no looping).
    pub loop_region: Option<ClipLoopRegion>,

    /// Streaming windows for disk-streamed clips (large files).
    /// Keyed by source file path. If a clip's file_path is found here,
    /// audio is read from the streaming window instead of the in-memory pool.
    /// This prevents OOM for files exceeding `RAM_THRESHOLD_BYTES`.
    ///
    /// AUD-002 NOTE: Now uses HashMap for O(1) lookups to avoid O(N) string comparisons.
    pub streaming_windows: std::collections::HashMap<String, StreamingWindow>,

    /// Reused active-clip scratch (pre-allocated, no per-buffer allocs).
    scratch_active_clips: Vec<ActiveClipInfo>,
    /// Secondary scratch for loop-wrap scheduling.
    scratch_post_wrap_clips: Vec<ActiveClipInfo>,

    /// Lock-free producer for spectrum analyzer feed.
    /// Audio thread pushes mono-mixed master output samples here.
    /// The consumer lives on the UI/spectrum thread and feeds FFT.
    pub spectrum_producer: Option<rtrb::Producer<f32>>,

    /// Per-track spectrum producers (lock-free: audio thread → UI thread).
    /// Each slot corresponds to a track index. Only populated for tracks
    /// whose EQ UI is active and requesting spectrum data.
    /// Mono-mixed post-FX audio is pushed here after the graph pass.
    pub per_track_spectrum_producers: Vec<Option<rtrb::Producer<f32>>>,

    /// When `true`, this context is used for offline rendering (bounce/export).
    /// Disables real-time safety constraints that degrade quality, such as
    /// the Pro warp budget limit. The offline path has no RT deadline.
    pub offline_mode: bool,

    /// BUG-047 FIX: Round-robin start index for Pro warp budget.
    /// Each buffer callback advances this index, ensuring later tracks
    /// get first pick on alternating callbacks for fair distribution.
    pro_warp_start_track: usize,
}

pub fn soft_clip(sample: f32) -> f32 {
    // ENTERPRISE: Guard NaN/Inf inputs early to prevent propagation.
    if !sample.is_finite() {
        return 0.0;
    }
    let abs = sample.abs();

    // BUG-004 FIX: Raised threshold from 0.8 (-1.9 dBFS) to 0.95 (-0.45 dBFS).
    // The old 0.8 threshold was compressing transients in the top 1.9 dB, causing
    // noticeably quieter output than Ableton (which passes float samples cleanly).
    // 0.95 preserves 99.5% of dynamic range while preventing harsh digital clips
    // that occur when CoreAudio/CPAL hard-clip f32 outputs at 1.0.
    const THRESH: f32 = 0.95;
    const BETA: f32 = 1.0 - THRESH; // 0.05

    if abs <= THRESH {
        sample // 100% transparent below -0.45 dBFS
    } else {
        let excess = abs - THRESH;
        // Rational curve mapping [0.95, inf) to [0.95, 1.0] with slope=1.0 at THRESH
        let mapped = THRESH + (BETA * excess) / (BETA + excess);
        sample.signum() * mapped
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
        internal_latency_snapshot: Arc<SharedInternalLatencySnapshot>,
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
            streaming_windows: std::collections::HashMap::with_capacity(32),
            // AUD-071 FIX: 128 active clips per buffer is the realistic max.
            // 1024 wastes 7× memory for the scratch Vec's backing allocation.
            scratch_active_clips: Vec::with_capacity(128),
            scratch_post_wrap_clips: Vec::with_capacity(128),
            spectrum_producer: None,
            per_track_spectrum_producers: (0..actual_tracks).map(|_| None).collect(),
            offline_mode: false,
            pro_warp_start_track: 0,
            internal_latency_snapshot,
        }
    }

    /// Set project/timeline sample-rate domain used by playhead and clip scheduling.
    pub fn set_timeline_sample_rate(&mut self, sample_rate: f64) {
        let sr = if sample_rate.is_finite() && sample_rate > 0.0 {
            sample_rate
        } else {
            self.sample_rate
        };
        // PERF FIX: Skip rebuild when SR hasn't changed. toggle_playback sends
        // SetTimelineSampleRate before every play, which previously reconstructed
        // FadeCache (Vec allocation) on the RT thread causing a first-buffer stutter.
        if (self.timeline_sample_rate - sr).abs() < 0.01 {
            return;
        }
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
        // AUD-099 FIX: Rebuild in-place to avoid heap allocation on the RT thread.
        // Previously `FadeCache::new()` created two new Vecs per call.
        self.fade_cache.rebuild_in_place(self.sample_rate);
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
    /// Reads all active overlapping Audio Clips into the track slots.
    /// Phase 1: Clears the track slots.
    /// Phase 2: Writes the audio data, applying fades.
    ///
    /// NOTE: This function NO LONGER applies per-track internal FX (DeviceChain)
    /// or volume/pan/metering (ChannelStrip). These must be applied by the caller
    /// AFTER synthesizing any MIDI instruments into the same track buffers!
    #[inline]
    pub fn read_audio_clips_into_tracks_simple(
        &mut self,
        frame_count: usize,
        clips_per_track: &[Vec<dream_models::project::AudioClip>],
        clip_pool: &ClipPool,
        current_bpm: f64,
    ) {
        self.read_audio_clips_into_tracks(frame_count, clips_per_track, clip_pool, current_bpm);
    }

    /// Reads all tracks.
    #[inline]
    pub fn read_audio_clips_into_tracks(
        &mut self,
        frame_count: usize,
        clips_per_track: &[Vec<dream_models::project::AudioClip>],
        clip_pool: &ClipPool,
        current_bpm: f64,
    ) {
        let playhead_pos = self.playhead.position();

        // ── 1. Clear active track buffers ──────────────────────────
        let track_count = clips_per_track.len().min(self.track_slots.len());
        // BUG-A038 FIX: Only clear active layout slots, avoiding 500KB of memsets.
        for slot in &mut self.track_slots[..track_count] {
            slot.clear(frame_count);
        }
        self.master_bus.clear(frame_count);

        // ── 2. Schedule clips per track ─────────────────────────────
        // Diagnostic: track total active clips this buffer.
        // AUD-074: These are trace-only — zero-cost in release builds.
        let mut total_active = 0usize;
        let mut total_pool_hits = 0usize;
        // ENTERPRISE FIX: Offline mode has unlimited Pro warp budget.
        // The RT path limits concurrent Pro warp clips to avoid dropouts,
        // but offline rendering has no real-time constraint — allow
        // every clip to use its configured warp mode at full quality.
        //
        // BUG-A042 FIX: Use named constants for pro warp budgets instead of magic numbers.
        const PRO_WARP_BUDGET_LARGE: usize = 12;
        const PRO_WARP_BUDGET_SMALL: usize = 6;
        
        let mut pro_warp_budget = if self.offline_mode {
            usize::MAX
        } else if frame_count >= 1024 {
            PRO_WARP_BUDGET_LARGE
        } else {
            PRO_WARP_BUDGET_SMALL
        };

        // BUG-047 FIX: Round-robin track ordering for Pro warp budget.
        // Rotate the starting track index each callback so later tracks
        // get first pick on alternating buffers, preventing systematic
        // starvation of higher-indexed tracks.
        let start = if track_count > 0 { self.pro_warp_start_track % track_count } else { 0 };
        self.pro_warp_start_track = start.wrapping_add(1);

        for offset in 0..track_count {
            let track_idx = (start + offset) % track_count;
            let clips = &clips_per_track[track_idx];
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
                if clip.is_disabled {
                    continue;
                }
                // AUD-089 FIX: Count zero-duration clips via RT-safe atomic counter.
                // Previously used log::warn! which acquires a global Mutex in the
                // log backend — forbidden on the audio thread.
                // BUG-011 FIX: Also skip the clip entirely — zero-duration clips
                // have no audio to render and entering the read path wastes cycles.
                if clip.duration.sample_frame <= 0 {
                    // Counter increment removed (Bug 69)
                    continue;
                }
                // WARP-005 FIX: Determine is_warped flag early; actual source length
                // is resolved per-backend (pool vs streaming) using real file frame count.
                let clip_source_len_hint = if clip.warp_source_duration_frames > 0 {
                    clip.warp_source_duration_frames as f64
                } else {
                    // Fallback refined inside pool/streaming blocks below.
                    clip.duration.sample_frame.max(1) as f64
                };
                let is_warped = clip.is_warped && clip_source_len_hint > 1.0;

                // BUG-020 FIX: Clamp pitch_shift_semitones to ±36 (±3 octaves) before powf()
                // to prevent intermediate f64 underflow/overflow for extreme values.
                let clamped_pitch = clip.pitch_shift_semitones.clamp(-36.0, 36.0);
                let pitch_multiplier = 2.0_f64.powf(clamped_pitch / 12.0);

                let mut warp_mode = if clip.warp_mode.unwrap_or(0) <= 0 {
                    WarpResampleMode::Standard
                } else {
                    WarpResampleMode::Pro
                };
                if matches!(warp_mode, WarpResampleMode::Pro) {
                    if pro_warp_budget == 0 {
                        warp_mode = WarpResampleMode::Standard;
                    } else {
                        pro_warp_budget = pro_warp_budget.saturating_sub(1);
                    }
                }

                // BUG-047 FIX: Runtime guard — NaN/Infinity gain must never propagate.
                // debug_assert was stripped in release, allowing corrupt gain to reach output.
                // Default to unity gain (1.0) to prevent silent audio or NaN corruption.
                let safe_gain = if clip.gain.is_finite() { clip.gain } else {
                    // BUG-W5-001 FIX: Replaced log::warn! with RT-safe atomic counter.
                    // log::warn! acquires a global Mutex in the log backend — forbidden
                    // on the audio thread (priority inversion risk).
                    static NONFINITE_GAIN_COUNT: std::sync::atomic::AtomicU32 =
                        std::sync::atomic::AtomicU32::new(0);
                    NONFINITE_GAIN_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    1.0
                };

                if let Some(audio) = clip_pool.get(&clip.file_path) {
                    total_pool_hits += 1;

                    let source_to_device_rate = (audio.sample_rate.max(1) as f64
                        / self.sample_rate.max(1.0))
                    .clamp(0.125, 8.0);

                    let source_to_timeline_ratio =
                        audio.sample_rate.max(1) as f64 / self.timeline_sample_rate.max(1.0);

                    if is_warped {
                        // WARP-001 FIX (Enterprise): Compute warped playback using warp markers
                        // when available, falling back to linear source/timeline ratio.
                        let clip_source_len = if clip.warp_source_duration_frames > 0 {
                            clip.warp_source_duration_frames as f64
                        } else {
                            audio.num_frames.max(1) as f64
                        };
                        let clip_timeline_len = clip.duration.sample_frame.max(1) as f64;
                        let linear_warp_rate = (clip_source_len / clip_timeline_len)
                            * source_to_timeline_ratio;

                        let clip_local_timeline_start =
                            (ac.source_start_frame - clip.source_offset.sample_frame).max(0) as f64;

                        // WARP-MARKERS FIX: Use warp markers intelligently.
                        // Ableton auto-generates exactly 2 markers per warped clip as
                        // tempo anchors (typically 0.03125 beats apart). These are NOT
                        // user-placed warp markers. Only use piecewise-linear interpolation
                        // for clips with ≥3 markers spanning a meaningful beat range.
                        let use_marker_interpolation = clip.warp_markers.len() >= 3
                            && {
                                // AUDIT-RT-04 FIX: Replaced .unwrap() with safe
                                // pattern match — no panicking code on RT thread.
                                if let (Some(first), Some(last)) = (
                                    clip.warp_markers.first(),
                                    clip.warp_markers.last(),
                                ) {
                                    (last.beat_time - first.beat_time).abs() > 0.5
                                } else {
                                    false
                                }
                            };

                        let (source_start, warp_rate) = if use_marker_interpolation {
                            let source_sr = audio.sample_rate.max(1) as f64;
                            let timeline_beat_offset = clip_local_timeline_start
                                / self.timeline_sample_rate.max(1.0)
                                * (current_bpm / 60.0);
                            let abs_beat = clip.warp_markers[0].beat_time + timeline_beat_offset;
                            let source_sec = warp_markers_beat_to_source_seconds(
                                &clip.warp_markers, abs_beat,
                            );
                            let source_frame = source_sec * source_sr;
                            let marker_rate = warp_markers_local_rate(
                                &clip.warp_markers, abs_beat, source_sr,
                                self.timeline_sample_rate.max(1.0),
                                current_bpm,
                            );
                            // Safety guard: if marker interpolation produces invalid
                            // positions, fall back to linear warp to avoid silence.
                            if source_frame >= 0.0
                                && source_frame.is_finite()
                                && marker_rate.is_finite()
                                && marker_rate > 0.0
                            {
                                (source_frame, marker_rate)
                            } else {
                                let source_start = (clip.source_offset.sample_frame.max(0) as f64)
                                    + clip_local_timeline_start * linear_warp_rate;
                                (source_start, linear_warp_rate)
                            }
                        } else {
                            // 2-marker or no-marker clips: use linear warp rate.
                            let source_start = (clip.source_offset.sample_frame.max(0) as f64)
                                + clip_local_timeline_start * linear_warp_rate;
                            (source_start, linear_warp_rate)
                        };

                        let playback_rate = (warp_rate * pitch_multiplier).clamp(0.125, 8.0);

                        ClipReader::read_stereo_into_rate(
                            audio.left(),
                            audio.right(),
                            source_start,
                            playback_rate * source_to_device_rate / source_to_timeline_ratio,
                            &mut slot.buf_left,
                            &mut slot.buf_right,
                            ac.buffer_offset,
                            ac.frames_to_read,
                            safe_gain,
                            warp_mode,
                        );
                    } else {
                        // Unwarped: timeline maps to source directly, but modified by pitch_multiplier.
                        // So local timeline duration T corresponds to T * pitch_multiplier in source frames.
                        let clip_local_timeline_start =
                            (ac.source_start_frame - clip.source_offset.sample_frame).max(0) as f64;
                        let source_start = (clip.source_offset.sample_frame.max(0) as f64)
                            + clip_local_timeline_start
                                * pitch_multiplier
                                * source_to_timeline_ratio;

                        ClipReader::read_stereo_into_rate(
                            audio.left(),
                            audio.right(),
                            source_start,
                            pitch_multiplier * source_to_device_rate,
                            &mut slot.buf_left,
                            &mut slot.buf_right,
                            ac.buffer_offset,
                            ac.frames_to_read,
                            safe_gain,
                            WarpResampleMode::Standard,
                        );
                    }
                } else if let Some(window) = self.streaming_windows.get(&clip.file_path) {
                    total_pool_hits += 1;
                    let source_to_device_rate = (window.sample_rate().max(1) as f64
                        / self.sample_rate.max(1.0))
                    .clamp(0.125, 8.0);

                    let source_to_timeline_ratio =
                        window.sample_rate().max(1) as f64 / self.timeline_sample_rate.max(1.0);

                    if is_warped {
                        // WARP-MARKERS FIX (streaming path): Same logic as pool path.
                        let clip_source_len = if clip.warp_source_duration_frames > 0 {
                            clip.warp_source_duration_frames as f64
                        } else {
                            window.total_frames().max(1) as f64
                        };
                        let clip_timeline_len = clip.duration.sample_frame.max(1) as f64;
                        let linear_warp_rate = (clip_source_len / clip_timeline_len)
                            * source_to_timeline_ratio;

                        let clip_local_timeline_start =
                            (ac.source_start_frame - clip.source_offset.sample_frame).max(0) as f64;

                        let use_marker_interpolation = clip.warp_markers.len() >= 3
                            && {
                                // AUDIT-RT-04 FIX: Replaced .unwrap() with safe
                                // pattern match — no panicking code on RT thread.
                                if let (Some(first), Some(last)) = (
                                    clip.warp_markers.first(),
                                    clip.warp_markers.last(),
                                ) {
                                    (last.beat_time - first.beat_time).abs() > 0.5
                                } else {
                                    false
                                }
                            };

                        let (source_start, warp_rate) = if use_marker_interpolation {
                            let source_sr = window.sample_rate().max(1) as f64;
                            let timeline_beat_offset = clip_local_timeline_start
                                / self.timeline_sample_rate.max(1.0)
                                * (current_bpm / 60.0);
                            let abs_beat = clip.warp_markers[0].beat_time + timeline_beat_offset;
                            let source_sec = warp_markers_beat_to_source_seconds(
                                &clip.warp_markers, abs_beat,
                            );
                            let source_frame = source_sec * source_sr;
                            let marker_rate = warp_markers_local_rate(
                                &clip.warp_markers, abs_beat, source_sr,
                                self.timeline_sample_rate.max(1.0),
                                current_bpm,
                            );
                            // Safety guard: fall back to linear if invalid
                            if source_frame >= 0.0
                                && source_frame.is_finite()
                                && marker_rate.is_finite()
                                && marker_rate > 0.0
                            {
                                (source_frame, marker_rate)
                            } else {
                                let source_start = (clip.source_offset.sample_frame.max(0) as f64)
                                    + clip_local_timeline_start * linear_warp_rate;
                                (source_start, linear_warp_rate)
                            }
                        } else {
                            let source_start = (clip.source_offset.sample_frame.max(0) as f64)
                                + clip_local_timeline_start * linear_warp_rate;
                            (source_start, linear_warp_rate)
                        };

                        let playback_rate = (warp_rate * pitch_multiplier).clamp(0.125, 8.0);

                        window.read_into_rate(
                            source_start,
                            playback_rate * source_to_device_rate / source_to_timeline_ratio,
                            &mut slot.buf_left,
                            &mut slot.buf_right,
                            ac.buffer_offset,
                            ac.frames_to_read,
                            safe_gain,
                        );
                    } else {
                        // BUG-A1/A2 FIX: Unwarped streaming path must match pool path
                        // (L443-463). Previously ignored pitch_shift_semitones and
                        // source_offset, causing pitch-shifted or trimmed streaming
                        // clips to play back at wrong pitch/position.
                        let clip_local_timeline_start =
                            (ac.source_start_frame - clip.source_offset.sample_frame).max(0) as f64;
                        let source_start = (clip.source_offset.sample_frame.max(0) as f64)
                            + clip_local_timeline_start
                                * pitch_multiplier
                                * source_to_timeline_ratio;
                        window.read_into_rate(
                            source_start,
                            pitch_multiplier * source_to_device_rate,
                            &mut slot.buf_left,
                            &mut slot.buf_right,
                            ac.buffer_offset,
                            ac.frames_to_read,
                            safe_gain,
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
                let safe_end = (offset + read_len)
                    .min(slot.buf_left.len())
                    .min(slot.buf_right.len());
                let safe_read_len = safe_end.saturating_sub(offset);
                if safe_read_len > 0 {
                    let user_fade_in = clip.fade_in_frames.max(0) as usize;
                    let user_fade_out = clip.fade_out_frames.max(0) as usize;
                    let clip_len_frames = clip.duration.sample_frame.max(1) as usize;
                    // MEGA-02 FIX: Base fade automation envelope on robust source offset
                    // so fades don't jump/reset when a clip crosses a loop wrap boundary.
                    let clip_local_start =
                        (ac.source_start_frame - clip.source_offset.sample_frame).max(0) as usize;

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
                        if ac.is_clip_head || ac.is_loop_wrap_fade_in {
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
                        if ac.is_clip_tail || ac.is_loop_wrap_fade_out {
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

        // BUG-65 FIX: Diagnostic counters for render pass.
        // AUDIT-S1-04: Removed log::trace! — log backend Mutex is RT-unsafe.
        let _ = (total_active, total_pool_hits);
    }

    /// Advances the playhead with exact fractional sample rate interpolation.
    #[inline]
    pub fn advance_playhead_by_frames(&mut self, frame_count: usize) {
        let transport_loop = self
            .loop_region
            .as_ref()
            .map(|r| dream_transport::LoopRegion {
                start: r.start,
                end: r.end,
                enabled: true,
            });
        let converter = crate::frame_domain::FrameDomainConverter::new(
            self.sample_rate,
            self.timeline_sample_rate,
            frame_count,
        );
        let (advance_frames, new_acc) =
            converter.playhead_advance(self.timeline_advance_accumulator);
        self.timeline_advance_accumulator = new_acc;
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
        current_bpm: f64,
    ) {
        let frame_count = output.len() / self.channels.max(1);

        // Phase 1: Fill track slots with Audio Clips.
        self.read_audio_clips_into_tracks_simple(frame_count, clips_per_track, clip_pool, current_bpm);

        // Phase 2: Apply DeviceChain (FX) and ChannelStrip (Gain/Pan) for standalone rendering
        let decay = peak_decay_for_block(self.sample_rate, frame_count);
        for track_idx in 0..self.track_slots.len() {
            let slot = &mut self.track_slots[track_idx];
            if !slot.active {
                continue;
            }
            if !slot.device_chain.is_empty() {
                slot.device_chain.process_stereo(
                    &mut slot.buf_left[..frame_count],
                    &mut slot.buf_right[..frame_count],
                    self.sample_rate as f32,
                );
            }
            slot.strip.process_stereo(
                &mut slot.buf_left[..frame_count],
                &mut slot.buf_right[..frame_count],
            );

            if let Some((meter_l, meter_r)) = self.meter_bank.track(track_idx) {
                let rms_l = linear_to_db(compute_rms(&slot.buf_left[..frame_count]));
                let rms_r = linear_to_db(compute_rms(&slot.buf_right[..frame_count]));
                let peak_l = linear_to_db(compute_peak(&slot.buf_left[..frame_count]));
                let peak_r = linear_to_db(compute_peak(&slot.buf_right[..frame_count]));

                meter_l.store_rms(rms_l);
                meter_r.store_rms(rms_r);
                meter_l.store_peak_decay(peak_l, decay);
                meter_r.store_peak_decay(peak_r, decay);
            }
        }

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

        self.meter_bank.master_left().store_rms(m_rms_l);
        self.meter_bank.master_right().store_rms(m_rms_r);
        self.meter_bank
            .master_left()
            .store_peak_decay(m_peak_l, decay);
        self.meter_bank
            .master_right()
            .store_peak_decay(m_peak_r, decay);

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
        } else if self.channels == 1 {
            // BUG-078 FIX: Mix stereo to mono, preventing sample overlap corruption.
            for i in 0..safe_frames {
                let mono = (master_l[i] + master_r[i]) * std::f32::consts::FRAC_1_SQRT_2;
                if i < output.len() {
                    output[i] = soft_clip(mono);
                }
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

    /// Returns the number of active (pre-allocated) track slots.
    pub fn track_count(&self) -> usize {
        self.track_slots.len()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Warp Marker Interpolation — Piecewise-Linear Beat↔Source Mapping
// ═══════════════════════════════════════════════════════════════════════════
// Ableton's warp markers define anchor points mapping:
//   BeatTime (timeline beats) → SecTime (source audio seconds)
// Between markers, the mapping is linear. This is the same algorithm
// Ableton Live uses internally.
// ═══════════════════════════════════════════════════════════════════════════

/// Maps a beat position to source audio seconds using piecewise-linear
/// interpolation between warp markers.
///
/// Zero-allocation, O(n) where n = number of markers (typically 2-20).
/// Called from the audio render callback hot path.
#[inline]
fn warp_markers_beat_to_source_seconds(
    markers: &[dream_models::project::WarpMarkerPoint],
    beat: f64,
) -> f64 {
    debug_assert!(markers.len() >= 2);

    // Before first marker: extrapolate from first segment
    if beat <= markers[0].beat_time {
        let m0 = &markers[0];
        let m1 = &markers[1];
        let beat_span = m1.beat_time - m0.beat_time;
        if beat_span.abs() > f64::EPSILON {
            let ratio = (m1.sec_time - m0.sec_time) / beat_span;
            return m0.sec_time + (beat - m0.beat_time) * ratio;
        }
        return markers[0].sec_time;
    }

    // After last marker: extrapolate from last segment
    let last_idx = markers.len() - 1;
    if beat >= markers[last_idx].beat_time {
        let m0 = &markers[last_idx - 1];
        let m1 = &markers[last_idx];
        let beat_span = m1.beat_time - m0.beat_time;
        if beat_span.abs() > f64::EPSILON {
            let ratio = (m1.sec_time - m0.sec_time) / beat_span;
            return m1.sec_time + (beat - m1.beat_time) * ratio;
        }
        return markers[last_idx].sec_time;
    }

    // Between markers: find the segment and interpolate
    for i in 0..markers.len() - 1 {
        let m0 = &markers[i];
        let m1 = &markers[i + 1];
        if beat >= m0.beat_time && beat < m1.beat_time {
            let beat_span = m1.beat_time - m0.beat_time;
            if beat_span.abs() <= f64::EPSILON {
                return m0.sec_time;
            }
            let t = (beat - m0.beat_time) / beat_span;
            return m0.sec_time + t * (m1.sec_time - m0.sec_time);
        }
    }

    // Fallback (shouldn't reach here)
    markers[last_idx].sec_time
}

/// Computes the local playback rate (source frames per timeline frame) at
/// a given beat position, derived from the derivative of the warp marker mapping.
///
/// This gives the instantaneous stretch/compress factor needed for the
/// audio resampler.
#[inline]
fn warp_markers_local_rate(
    markers: &[dream_models::project::WarpMarkerPoint],
    beat: f64,
    source_sr: f64,
    timeline_sr: f64,
    bpm: f64,
) -> f64 {
    debug_assert!(markers.len() >= 2);

    // Find the segment containing this beat
    let (m0, m1) = if beat <= markers[0].beat_time || markers.len() < 2 {
        (&markers[0], &markers[1])
    } else {
        let last = markers.len() - 1;
        if beat >= markers[last].beat_time {
            (&markers[last - 1], &markers[last])
        } else {
            let mut pair = (&markers[0], &markers[1]);
            for i in 0..markers.len() - 1 {
                if beat >= markers[i].beat_time && beat < markers[i + 1].beat_time {
                    pair = (&markers[i], &markers[i + 1]);
                    break;
                }
            }
            pair
        }
    };

    let beat_span = (m1.beat_time - m0.beat_time).abs();
    let sec_span = (m1.sec_time - m0.sec_time).abs();

    if beat_span <= f64::EPSILON || sec_span <= f64::EPSILON {
        return 1.0; // Unity rate fallback
    }

    // d(source_seconds) / d(beat) = sec_span / beat_span
    // d(source_frames) / d(timeline_frames) =
    //   (sec_span / beat_span) * source_sr * (bpm / 60.0) / timeline_sr
    let sec_per_beat = sec_span / beat_span;
    let beats_per_sec_timeline = bpm / 60.0;
    (sec_per_beat * source_sr * beats_per_sec_timeline) / timeline_sr.max(1.0)
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
        let int_lat = Arc::new(SharedInternalLatencySnapshot::new(32));
        let ctx = RenderContext::new(32, 44100.0, 2, meter_bank, int_lat);

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
        let int_lat = Arc::new(SharedInternalLatencySnapshot::new(MAX_TRACKS));
        let ctx = RenderContext::new(500, 44100.0, 2, meter_bank, int_lat);

        // Requesting 500 tracks should be clamped to MAX_TRACKS (256).
        assert_eq!(ctx.track_count(), MAX_TRACKS);
    }

    #[test]
    fn render_silence_produces_silence() {
        let meter_bank = Arc::new(MeterBank::new(8));
        let int_lat = Arc::new(SharedInternalLatencySnapshot::new(8));
        let mut ctx = RenderContext::new(8, 44100.0, 2, meter_bank, int_lat);
        let pool = ClipPool::new();

        let mut output = vec![1.0_f32; 512]; // Fill with 1.0 first
        let no_clips: Vec<Vec<dream_models::project::AudioClip>> = Vec::new();

        ctx.render(&mut output, &no_clips, &pool, 120.0);

        // All output should be zero (no clips = silence)
        assert!(
            output.iter().all(|s| *s == 0.0),
            "Empty project should produce silence"
        );
    }
}
