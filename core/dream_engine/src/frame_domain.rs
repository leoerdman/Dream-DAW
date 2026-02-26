// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Frame Domain Converter
// ═══════════════════════════════════════════════════════════════════════════
//
// Centralised, RT-safe abstraction for converting between the three sample-
// frame domains used throughout the engine:
//
//   1. **Device frames** — determined by the OS audio callback.  Buffer sizes
//      and VST3 process calls operate in this domain.
//
//   2. **Timeline frames** — the project sample rate.  Playhead position,
//      clip positions, MIDI note positions, and loop regions live here.
//
//   3. **Source frames** — the original sample rate of an audio file.  Only
//      relevant when reading samples from the clip pool.
//
// Previously, each conversion was computed ad-hoc at the callsite with
// inconsistent naming (`midi_sr_ratio`, `source_to_device_rate`, `ratio`,
// `inverse_midi_sr_ratio`).  This struct replaces ALL of them with a single
// source of truth, computed once per audio callback.
//
// # RT-Safety
//
//   ✅ Zero-allocation, Copy, no I/O, no locks.
//   ✅ All methods are `#[inline]` and branchless (except the initial guard).
//
// ═══════════════════════════════════════════════════════════════════════════

/// RT-safe, zero-allocation frame-domain converter.
///
/// Constructed once per audio callback from the current `RenderContext` and
/// the device frame count.  All conversion methods are `Copy` and `#[inline]`.
#[derive(Debug, Clone, Copy)]
pub struct FrameDomainConverter {
    // ── Precomputed ratios ─────────────────────────────────────────────
    /// `timeline_sr / device_sr` — converts **device → timeline** (multiply).
    device_to_timeline_ratio: f64,

    /// `device_sr / timeline_sr` — converts **timeline → device** (multiply).
    timeline_to_device_ratio: f64,

    // ── Buffer sizes ───────────────────────────────────────────────────
    /// Device buffer size (frame_count from OS audio callback).
    device_frames: usize,

    /// Equivalent timeline frames for this buffer (`ceil(device_frames * d2t)`).
    /// Used by the MIDI scheduler.
    timeline_frames: usize,

    // ── Raw sample rates (for source conversions) ──────────────────────
    device_sr: f64,
    timeline_sr: f64,
}

impl FrameDomainConverter {
    // ── Ratio bounds ───────────────────────────────────────────────────
    // Guard against pathological SR mismatches (e.g. 8kHz device, 192kHz
    // timeline).  Clamp to 8× which covers all professional scenarios.
    const RATIO_MIN: f64 = 0.125;
    const RATIO_MAX: f64 = 8.0;

    /// Creates a new converter for the current audio callback.
    ///
    /// # Arguments
    /// - `device_sr`: OS audio device sample rate (Hz).
    /// - `timeline_sr`: Project / timeline sample rate (Hz).
    /// - `device_frame_count`: Number of frames in this callback's buffer.
    #[inline]
    pub fn new(device_sr: f64, timeline_sr: f64, device_frame_count: usize) -> Self {
        let dev = device_sr.max(1.0);
        let tl = timeline_sr.max(1.0);

        let d2t = (tl / dev).clamp(Self::RATIO_MIN, Self::RATIO_MAX);
        let t2d = (dev / tl).clamp(Self::RATIO_MIN, Self::RATIO_MAX);

        let timeline_frames =
            ((device_frame_count as f64) * d2t).ceil().max(1.0) as usize;

        Self {
            device_to_timeline_ratio: d2t,
            timeline_to_device_ratio: t2d,
            device_frames: device_frame_count,
            timeline_frames,
            device_sr: dev,
            timeline_sr: tl,
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Accessors
    // ═══════════════════════════════════════════════════════════════════

    /// Device buffer size (OS frame count).
    #[inline]
    pub fn device_frames(&self) -> usize {
        self.device_frames
    }

    /// Timeline-equivalent frame count for this buffer.
    /// Always `>= 1` (ceil ensures MIDI scheduler window is never empty).
    #[inline]
    pub fn timeline_frames(&self) -> usize {
        self.timeline_frames
    }

    /// Device sample rate (Hz).
    #[inline]
    pub fn device_sr(&self) -> f64 {
        self.device_sr
    }

    /// Timeline / project sample rate (Hz).
    #[inline]
    pub fn timeline_sr(&self) -> f64 {
        self.timeline_sr
    }

    /// `timeline_sr / device_sr` — multiply device frames by this to get timeline frames.
    #[inline]
    pub fn device_to_timeline_ratio(&self) -> f64 {
        self.device_to_timeline_ratio
    }

    /// `device_sr / timeline_sr` — multiply timeline frames by this to get device frames.
    #[inline]
    pub fn timeline_to_device_ratio(&self) -> f64 {
        self.timeline_to_device_ratio
    }

    // ═══════════════════════════════════════════════════════════════════
    // Offset conversions (buffer-local)
    // ═══════════════════════════════════════════════════════════════════

    /// Converts a **timeline-frame offset** (from the MIDI scheduler) to a
    /// **device-frame offset** (for instrument rendering / VST3 dispatch).
    ///
    /// Result is clamped to `[0, device_frames]`.
    #[inline]
    pub fn timeline_to_device_offset(&self, timeline_offset: usize) -> usize {
        let device = ((timeline_offset as f64) * self.timeline_to_device_ratio).round() as usize;
        device.min(self.device_frames)
    }

    /// Converts a **timeline-frame offset** to a device-frame `i32` for VST3
    /// `MidiEvent::sample_offset`.
    ///
    /// Result is clamped to `[0, device_frames as i32]`.
    #[inline]
    pub fn timeline_to_device_offset_i32(&self, timeline_offset: usize) -> i32 {
        let device = ((timeline_offset as f64) * self.timeline_to_device_ratio).round() as i32;
        device.clamp(0, self.device_frames as i32)
    }

    /// Converts a **device-frame offset** to a **timeline-frame offset**.
    ///
    /// Result is clamped to `[0, timeline_frames]`.
    #[inline]
    pub fn device_to_timeline_offset(&self, device_offset: usize) -> usize {
        let timeline = ((device_offset as f64) * self.device_to_timeline_ratio).round() as usize;
        timeline.min(self.timeline_frames)
    }

    // ═══════════════════════════════════════════════════════════════════
    // Source ↔ other domain conversions
    // ═══════════════════════════════════════════════════════════════════

    /// Source-file-SR to device-SR ratio.  Multiply source frames by this to
    /// get device frames (used for sample rate conversion / playback speed).
    #[inline]
    pub fn source_to_device_ratio(&self, source_sr: u32) -> f64 {
        ((source_sr.max(1) as f64) / self.device_sr).clamp(Self::RATIO_MIN, Self::RATIO_MAX)
    }

    /// Source-file-SR to timeline-SR ratio.  Multiply source frames by this
    /// to get timeline frames (used for clip position mapping).
    #[inline]
    pub fn source_to_timeline_ratio(&self, source_sr: u32) -> f64 {
        (source_sr.max(1) as f64) / self.timeline_sr
    }

    // ═══════════════════════════════════════════════════════════════════
    // Playhead advance helper
    // ═══════════════════════════════════════════════════════════════════

    /// Computes the exact fractional timeline-frame advance for this device
    /// buffer, incorporating a fractional accumulator for drift-free advance.
    ///
    /// Returns `(integer_advance_frames, new_accumulator)`.
    #[inline]
    pub fn playhead_advance(&self, accumulator: f64) -> (usize, f64) {
        let advance_exact =
            (self.device_frames as f64) * self.device_to_timeline_ratio + accumulator;
        let advance_frames = advance_exact.floor().max(0.0) as usize;
        let mut new_acc = advance_exact - (advance_frames as f64);
        // BUG-015 FIX: rem_euclid prevents negative fractional accumulation.
        if new_acc.abs() > 1.0 {
            new_acc = new_acc.rem_euclid(1.0);
        }
        (advance_frames, new_acc)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    // ── Same SR (common case) ──────────────────────────────────────────

    #[test]
    fn same_sr_ratios_are_unity() {
        let fc = FrameDomainConverter::new(44100.0, 44100.0, 512);
        assert!((fc.device_to_timeline_ratio() - 1.0).abs() < 1e-10);
        assert!((fc.timeline_to_device_ratio() - 1.0).abs() < 1e-10);
        assert_eq!(fc.device_frames(), 512);
        assert_eq!(fc.timeline_frames(), 512);
    }

    #[test]
    fn same_sr_offset_identity() {
        let fc = FrameDomainConverter::new(48000.0, 48000.0, 256);
        assert_eq!(fc.timeline_to_device_offset(100), 100);
        assert_eq!(fc.device_to_timeline_offset(100), 100);
        assert_eq!(fc.timeline_to_device_offset_i32(200), 200);
    }

    // ── Different SRs ──────────────────────────────────────────────────

    #[test]
    fn timeline_48k_device_441k() {
        let fc = FrameDomainConverter::new(44100.0, 48000.0, 512);
        // d2t = 48000/44100 ≈ 1.0884
        assert!(fc.timeline_frames() >= 557); // ceil(512 * 1.0884)
        // Timeline offset 557 → device ≈ 512
        let dev = fc.timeline_to_device_offset(fc.timeline_frames());
        assert!(dev <= fc.device_frames() + 1); // rounding tolerance
    }

    #[test]
    fn device_96k_timeline_441k() {
        let fc = FrameDomainConverter::new(96000.0, 44100.0, 1024);
        // d2t = 44100/96000 ≈ 0.459
        assert!(fc.timeline_frames() <= 512);
        // Device offset 1024 → timeline ≈ 470
        let tl = fc.device_to_timeline_offset(1024);
        assert!(tl <= fc.timeline_frames() + 1);
    }

    // ── Clamping ───────────────────────────────────────────────────────

    #[test]
    fn timeline_offset_clamped_to_device_frames() {
        let fc = FrameDomainConverter::new(44100.0, 48000.0, 512);
        // An offset beyond timeline_frames should clamp to device_frames
        let dev = fc.timeline_to_device_offset(99999);
        assert_eq!(dev, fc.device_frames());
    }

    #[test]
    fn device_offset_clamped_to_timeline_frames() {
        let fc = FrameDomainConverter::new(44100.0, 48000.0, 512);
        let tl = fc.device_to_timeline_offset(99999);
        assert_eq!(tl, fc.timeline_frames());
    }

    #[test]
    fn i32_offset_clamped() {
        let fc = FrameDomainConverter::new(44100.0, 44100.0, 256);
        assert_eq!(fc.timeline_to_device_offset_i32(1000), 256);
        assert_eq!(fc.timeline_to_device_offset_i32(0), 0);
    }

    // ── Source conversions ─────────────────────────────────────────────

    #[test]
    fn source_to_device_same_sr() {
        let fc = FrameDomainConverter::new(44100.0, 44100.0, 512);
        let r = fc.source_to_device_ratio(44100);
        assert!((r - 1.0).abs() < 1e-10);
    }

    #[test]
    fn source_48k_device_441k() {
        let fc = FrameDomainConverter::new(44100.0, 48000.0, 512);
        let r = fc.source_to_device_ratio(48000);
        // 48000 / 44100 ≈ 1.0884
        assert!((r - 48000.0 / 44100.0).abs() < 1e-6);
    }

    #[test]
    fn source_to_timeline_ratio() {
        let fc = FrameDomainConverter::new(44100.0, 48000.0, 512);
        let r = fc.source_to_timeline_ratio(44100);
        // 44100 / 48000 ≈ 0.91875
        assert!((r - 44100.0 / 48000.0).abs() < 1e-6);
    }

    // ── Playhead advance ───────────────────────────────────────────────

    #[test]
    fn playhead_advance_same_sr() {
        let fc = FrameDomainConverter::new(44100.0, 44100.0, 512);
        let (frames, acc) = fc.playhead_advance(0.0);
        assert_eq!(frames, 512);
        assert!(acc.abs() < 1e-10);
    }

    #[test]
    fn playhead_advance_accumulates_fractional() {
        let fc = FrameDomainConverter::new(44100.0, 48000.0, 512);
        let (frames1, acc1) = fc.playhead_advance(0.0);
        // 512 * (48000/44100) = 557.142...
        assert_eq!(frames1, 557);
        assert!(acc1 > 0.0 && acc1 < 1.0);

        let (frames2, acc2) = fc.playhead_advance(acc1);
        // Should advance 557 or 558 depending on accumulator
        assert!(frames2 == 557 || frames2 == 558);
        assert!(acc2 >= 0.0 && acc2 < 1.0);
    }

    #[test]
    fn playhead_advance_drift_free_over_many_callbacks() {
        let fc = FrameDomainConverter::new(44100.0, 48000.0, 512);
        let mut acc = 0.0_f64;
        let mut total_timeline_frames = 0_u64;
        let num_callbacks = 10000;

        for _ in 0..num_callbacks {
            let (frames, new_acc) = fc.playhead_advance(acc);
            total_timeline_frames += frames as u64;
            acc = new_acc;
        }

        // Expected total: 10000 * 512 * (48000/44100) = 5_571_428.571...
        let expected = (num_callbacks as f64) * 512.0 * (48000.0 / 44100.0);
        let drift = (total_timeline_frames as f64 - expected).abs();
        assert!(
            drift < 1.0,
            "Drift over {} callbacks: {} frames (expected ~{})",
            num_callbacks,
            drift,
            expected
        );
    }

    // ── Edge cases ─────────────────────────────────────────────────────

    #[test]
    fn zero_device_sr_clamped() {
        let fc = FrameDomainConverter::new(0.0, 44100.0, 512);
        // device_sr clamped to 1.0, ratio = 44100/1 clamped to 8.0
        assert!((fc.device_to_timeline_ratio() - 8.0).abs() < 1e-10);
    }

    #[test]
    fn zero_timeline_sr_clamped() {
        let fc = FrameDomainConverter::new(44100.0, 0.0, 512);
        // timeline_sr clamped to 1.0, ratio = 1/44100 clamped to 0.125
        assert!((fc.device_to_timeline_ratio() - 0.125).abs() < 1e-10);
    }

    #[test]
    fn zero_frame_count() {
        let fc = FrameDomainConverter::new(44100.0, 44100.0, 0);
        assert_eq!(fc.device_frames(), 0);
        assert_eq!(fc.timeline_frames(), 1); // ceil ensures >= 1
    }

    #[test]
    fn source_sr_zero_clamped() {
        let fc = FrameDomainConverter::new(44100.0, 44100.0, 512);
        let r = fc.source_to_device_ratio(0);
        // source clamped to 1, ratio = 1/44100 clamped to 0.125
        assert!((r - 0.125).abs() < 1e-10);
    }
}
