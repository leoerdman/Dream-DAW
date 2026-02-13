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

use dream_clip_engine::scheduler::{ClipScheduler, LoopRegion as ClipLoopRegion};
use dream_dsp::fades::FadeCache;
use dream_mixer::{ChannelStrip, SummingBus};
use dream_ipc::metering::{MeterBank, compute_rms, compute_peak, linear_to_db};
use dream_transport::Playhead;

use std::sync::Arc;

// ── Constants ──────────────────────────────────────────────────────────────

/// Maximum number of tracks supported per project.
/// Pre-allocates buffers for this count. Memory cost: 64 tracks × 2048 × 4 bytes ≈ 512KB.
pub const MAX_TRACKS: usize = 64;

/// Maximum audio buffer size in frames. Covers USB audio's worst case (4096) with margin.
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
    /// Was this slot active (had clips rendered) in the current buffer?
    pub active: bool,
}

impl TrackSlot {
    /// Creates a new pre-allocated track slot.
    pub fn new(max_frames: usize) -> Self {
        Self {
            buf_left: vec![0.0; max_frames],
            buf_right: vec![0.0; max_frames],
            strip: ChannelStrip::new(),
            active: false,
        }
    }

    /// Clears the scratch buffers (called at the start of each buffer).
    #[inline]
    pub fn clear(&mut self, frame_count: usize) {
        self.buf_left[..frame_count].fill(0.0);
        self.buf_right[..frame_count].fill(0.0);
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

    /// Number of output channels (typically 2 for stereo).
    pub channels: usize,

    /// Shared meter bank (audio thread writes, UI thread reads).
    pub meter_bank: Arc<MeterBank>,

    /// Current loop region (None = no looping).
    pub loop_region: Option<ClipLoopRegion>,
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
            track_slots.push(TrackSlot::new(MAX_BUFFER_FRAMES));
        }

        Self {
            track_slots,
            master_bus: SummingBus::new(MAX_BUFFER_FRAMES),
            fade_cache: FadeCache::new(sample_rate),
            playhead: Playhead::new(sample_rate),
            sample_rate,
            channels,
            meter_bank,
            loop_region: None,
        }
    }

    /// The core render function — called once per audio buffer.
    ///
    /// # Arguments
    /// - `output`: The interleaved output buffer to fill (`[L, R, L, R, ...]`).
    /// - `clips_per_track`: Per-track clip lists. Index matches track index.
    ///
    /// # Real-Time Safety
    /// Zero allocations. Zero locks. Zero I/O. Zero panics.
    /// All iteration is bounded by pre-known sizes.
    #[inline]
    pub fn render(
        &mut self,
        output: &mut [f32],
        clips_per_track: &[&[dream_models::project::AudioClip]],
    ) {
        let frame_count = output.len() / self.channels;
        let playhead_pos = self.playhead.position();

        // ── 1. Clear all track buffers ──────────────────────────────
        for slot in &mut self.track_slots {
            slot.clear(frame_count);
        }
        self.master_bus.clear(frame_count);

        // ── 2. Schedule clips per track ─────────────────────────────
        for (track_idx, clips) in clips_per_track.iter().enumerate() {
            if track_idx >= self.track_slots.len() {
                break;
            }

            let active_clips = ClipScheduler::find_active_looped(
                clips,
                playhead_pos,
                frame_count,
                self.loop_region.as_ref(),
            );

            if active_clips.is_empty() {
                continue;
            }

            let slot = &mut self.track_slots[track_idx];
            slot.active = true;

            // ── 3. Sum clip audio into track buffer ─────────────────
            // In a full implementation, this would read decoded audio
            // from the clip reader pool. For now, we mark the slot as
            // active and the framework for clip scheduling is in place.
            //
            // The actual audio read pipeline:
            //   ClipReader::read(active_clip) → FadeCache → track buffer
            //
            // This integration point will be connected when the
            // AsyncFileReader pool is wired up.
            let _ = active_clips; // Acknowledge usage (no-op until file reader is connected)
        }

        // ── 4. Process channel strips (gain + pan) per track ────────
        for (track_idx, slot) in self.track_slots.iter_mut().enumerate() {
            if !slot.active {
                continue;
            }

            // Process left and right through the channel strip
            slot.strip.process_stereo(
                &mut slot.buf_left[..frame_count],
                &mut slot.buf_right[..frame_count],
            );

            // Write metering data (lock-free atomic writes)
            if let Some((meter_l, meter_r)) = self.meter_bank.track(track_idx) {
                let rms_l = linear_to_db(compute_rms(&slot.buf_left[..frame_count]));
                let rms_r = linear_to_db(compute_rms(&slot.buf_right[..frame_count]));
                let peak_l = linear_to_db(compute_peak(&slot.buf_left[..frame_count]));
                let peak_r = linear_to_db(compute_peak(&slot.buf_right[..frame_count]));

                meter_l.store_rms(rms_l);
                meter_r.store_rms(rms_r);
                meter_l.store_peak_decay(peak_l, 0.99);
                meter_r.store_peak_decay(peak_r, 0.99);
            }

            // ── 5. Sum into master bus ──────────────────────────────
            self.master_bus.add_stereo(
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
        self.meter_bank.master_left().store_peak_decay(m_peak_l, 0.99);
        self.meter_bank.master_right().store_peak_decay(m_peak_r, 0.99);

        // Interleave into output [L, R, L, R, ...]
        for i in 0..frame_count {
            let base = i * self.channels;
            if base + 1 < output.len() {
                output[base] = master_l[i];
                output[base + 1] = master_r[i];
            }
        }

        // ── 7. Advance playhead ─────────────────────────────────────
        self.playhead.advance(frame_count, None);
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
    }

    #[test]
    fn track_slot_clear() {
        let mut slot = TrackSlot::new(512);
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
        let meter_bank = Arc::new(MeterBank::new(200));
        let ctx = RenderContext::new(200, 44100.0, 2, meter_bank);

        // Should be clamped to MAX_TRACKS
        assert_eq!(ctx.track_count(), MAX_TRACKS);
    }

    #[test]
    fn render_silence_produces_silence() {
        let meter_bank = Arc::new(MeterBank::new(8));
        let mut ctx = RenderContext::new(8, 44100.0, 2, meter_bank);

        let mut output = vec![1.0_f32; 512]; // Fill with 1.0 first
        let no_clips: Vec<&[dream_models::project::AudioClip]> = Vec::new();

        ctx.render(&mut output, &no_clips);

        // All output should be zero (no clips = silence)
        assert!(
            output.iter().all(|s| *s == 0.0),
            "Empty project should produce silence"
        );
    }
}
