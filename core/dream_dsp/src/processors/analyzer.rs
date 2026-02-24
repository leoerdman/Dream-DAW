// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Analyzer Processor (Enterprise)
// ═══════════════════════════════════════════════════════════════════════════
//
// Pass-through audio analyzer providing:
//   - Peak Level (dBFS) per channel
//   - RMS Level (dBFS) per channel — 300ms sliding window
//   - Momentary LUFS (400ms, ITU-R BS.1770 K-weighting)
//   - Short-term LUFS (3s window)
//   - Crest Factor (peak/RMS ratio in dB)
//
// Parameters:
//   0: Reset (>0.5 triggers reset of all metering)
//
// K-weighting (ITU-R BS.1770):
//   Stage 1: 2nd-order high-shelf (+3.999dB at 1681.974Hz, Q=0.7071)
//   Stage 2: 2nd-order highpass (cutoff 38.135Hz, Q=0.5003)
//
// Real-Time Safety: Zero allocations. Pass-through (audio unchanged).
//
// Metering values are stored in atomic u32 (f32 bits) for lock-free
// UI reads via exported getter methods on the processor.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

// ── K-weighting filter coefficients (biquad) ────────────────────────────

/// Pre-computed biquad coefficients for K-weighting filters.
/// These are computed for 44100 Hz and auto-adjusted for other rates.
#[derive(Clone, Copy)]
struct BiquadState {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    // State
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl BiquadState {
    fn new(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Self {
        let inv = 1.0 / a0;
        Self {
            b0: b0 * inv,
            b1: b1 * inv,
            b2: b2 * inv,
            a1: a1 * inv,
            a2: a2 * inv,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    #[inline]
    fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        // BUG-C03 FIX: Flush denormals in K-weighting biquad feedback states.
        // 4 biquads × 2 channels = 8 potential denormal stalls during silence.
        self.y1 = if y.abs() > crate::processors::DENORMAL_THRESHOLD_F64 || y == 0.0 { y } else { 0.0 };
        self.y1
    }

    fn reset(&mut self) {
        self.x1 = 0.0;
        self.x2 = 0.0;
        self.y1 = 0.0;
        self.y2 = 0.0;
    }
}

/// Computes K-weighting Stage 1 (high-shelf) coefficients for a given sample rate.
/// ITU-R BS.1770: +3.999844 dB boost, fc=1681.974450 Hz, Q=0.7071752
fn k_weight_stage1(sr: f64) -> BiquadState {
    let gain_db = 3.999844;
    let freq = 1681.974450;
    let q = 0.7071752;
    let a = 10.0_f64.powf(gain_db / 40.0);
    let w0 = 2.0 * std::f64::consts::PI * freq / sr;
    let cos_w = w0.cos();
    let sin_w = w0.sin();
    let alpha = sin_w / (2.0 * q);
    let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;

    // High shelf
    let b0 = a * ((a + 1.0) + (a - 1.0) * cos_w + two_sqrt_a_alpha);
    let b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w);
    let b2 = a * ((a + 1.0) + (a - 1.0) * cos_w - two_sqrt_a_alpha);
    let a0 = (a + 1.0) - (a - 1.0) * cos_w + two_sqrt_a_alpha;
    let a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cos_w);
    let a2 = (a + 1.0) - (a - 1.0) * cos_w - two_sqrt_a_alpha;

    BiquadState::new(b0, b1, b2, a0, a1, a2)
}

/// Computes K-weighting Stage 2 (highpass) coefficients for a given sample rate.
/// ITU-R BS.1770: fc=38.13547 Hz, Q=0.5003270
fn k_weight_stage2(sr: f64) -> BiquadState {
    let freq = 38.13547;
    let q = 0.5003270;
    let w0 = 2.0 * std::f64::consts::PI * freq / sr;
    let cos_w = w0.cos();
    let sin_w = w0.sin();
    let alpha = sin_w / (2.0 * q);

    // Highpass
    let b0 = (1.0 + cos_w) / 2.0;
    let b1 = -(1.0 + cos_w);
    let b2 = (1.0 + cos_w) / 2.0;
    let a0 = 1.0 + alpha;
    let a1 = -2.0 * cos_w;
    let a2 = 1.0 - alpha;

    BiquadState::new(b0, b1, b2, a0, a1, a2)
}

// ── Metering ring buffer ────────────────────────────────────────────────

/// Ring buffer for LUFS gated mean-square accumulation.
/// BUG-M21 FIX: Increased from 512 to 2048 to support 3s short-term LUFS
/// at 192kHz with 32-sample blocks (~6000 blocks/sec → 18000 blocks for 3s).
const RING_SIZE: usize = 2048;

struct MeanSquareRing {
    buf: [f64; RING_SIZE],
    pos: usize,
    count: usize,
}

impl MeanSquareRing {
    fn new() -> Self {
        Self {
            buf: [0.0; RING_SIZE],
            pos: 0,
            count: 0,
        }
    }

    fn push(&mut self, val: f64) {
        self.buf[self.pos] = val;
        self.pos = (self.pos + 1) % RING_SIZE;
        if self.count < RING_SIZE {
            self.count += 1;
        }
    }

    /// Mean over the last `n` entries (or fewer if not enough data).
    fn mean_last(&self, n: usize) -> f64 {
        let n = n.min(self.count);
        if n == 0 {
            return 0.0;
        }
        let mut sum = 0.0;
        for i in 0..n {
            let idx = (self.pos + RING_SIZE - 1 - i) % RING_SIZE;
            sum += self.buf[idx];
        }
        sum / n as f64
    }

    fn reset(&mut self) {
        self.buf.fill(0.0);
        self.pos = 0;
        self.count = 0;
    }
}

// ── Shared metering state (lock-free, read from UI thread) ──────────────

/// Atomic metering state shared between audio and UI threads.
#[derive(Default)]
pub struct AnalyzerMetering {
    pub peak_l: AtomicU32,
    pub peak_r: AtomicU32,
    pub rms_l: AtomicU32,
    pub rms_r: AtomicU32,
    pub lufs_momentary: AtomicU32,
    pub lufs_short_term: AtomicU32,
    pub crest_factor: AtomicU32,
}

impl AnalyzerMetering {
    pub fn new() -> Self {
        let floor = (-100.0_f32).to_bits();
        Self {
            peak_l: AtomicU32::new(floor),
            peak_r: AtomicU32::new(floor),
            rms_l: AtomicU32::new(floor),
            rms_r: AtomicU32::new(floor),
            lufs_momentary: AtomicU32::new(floor),
            lufs_short_term: AtomicU32::new(floor),
            crest_factor: AtomicU32::new(0_f32.to_bits()),
        }
    }

    fn store(&self, metrics: (f32, f32, f32, f32, f32, f32, f32)) {
        let (peak_l, peak_r, rms_l, rms_r, lufs_m, lufs_st, crest) = metrics;
        self.peak_l.store(peak_l.to_bits(), Ordering::Relaxed);
        self.peak_r.store(peak_r.to_bits(), Ordering::Relaxed);
        self.rms_l.store(rms_l.to_bits(), Ordering::Relaxed);
        self.rms_r.store(rms_r.to_bits(), Ordering::Relaxed);
        self.lufs_momentary
            .store(lufs_m.to_bits(), Ordering::Relaxed);
        self.lufs_short_term
            .store(lufs_st.to_bits(), Ordering::Relaxed);
        self.crest_factor.store(crest.to_bits(), Ordering::Relaxed);
    }

    pub fn load_peak_l(&self) -> f32 {
        f32::from_bits(self.peak_l.load(Ordering::Relaxed))
    }
    pub fn load_peak_r(&self) -> f32 {
        f32::from_bits(self.peak_r.load(Ordering::Relaxed))
    }
    pub fn load_rms_l(&self) -> f32 {
        f32::from_bits(self.rms_l.load(Ordering::Relaxed))
    }
    pub fn load_rms_r(&self) -> f32 {
        f32::from_bits(self.rms_r.load(Ordering::Relaxed))
    }
    pub fn load_lufs_momentary(&self) -> f32 {
        f32::from_bits(self.lufs_momentary.load(Ordering::Relaxed))
    }
    pub fn load_lufs_short_term(&self) -> f32 {
        f32::from_bits(self.lufs_short_term.load(Ordering::Relaxed))
    }
    pub fn load_crest_factor(&self) -> f32 {
        f32::from_bits(self.crest_factor.load(Ordering::Relaxed))
    }
}

// ── Analyzer Processor ──────────────────────────────────────────────────

const FLOOR_DB: f32 = -100.0;

/// Converts linear amplitude to dBFS.
#[inline]
fn to_dbfs(linear: f64) -> f32 {
    if linear <= 1e-10 {
        FLOOR_DB
    } else {
        (20.0 * linear.log10()) as f32
    }
}

pub struct AnalyzerProcessor {
    sample_rate: f64,
    // K-weighting filters (stereo = 4 biquads)
    kw_stage1_l: BiquadState,
    kw_stage1_r: BiquadState,
    kw_stage2_l: BiquadState,
    kw_stage2_r: BiquadState,
    // LUFS ring buffer (stores per-block mean-square of K-weighted signal)
    lufs_ring: MeanSquareRing,
    blocks_per_second: f64,
    // RMS (one-pole smoother, ~300ms time constant)
    rms_decay: f64,
    rms_smoothed_l: f64,
    rms_smoothed_r: f64,
    // Peak hold with decay
    peak_hold_l: f64,
    peak_hold_r: f64,
    /// BUG-C01 FIX: SR-dependent peak decay — previously was hardcoded 0.9995
    /// which made peak meters show wildly different ballistics across SRs.
    peak_decay: f64,
    // Shared metering (read by UI)
    pub metering: Arc<AnalyzerMetering>,
}

impl AnalyzerProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sample_rate = crate::processors::sanitize_sample_rate(sample_rate);
        let sr = sample_rate as f64;
        let bps = sr / 512.0;
        // BUG-C01 FIX: ~200ms peak hold time, computed from blocks_per_second.
        let peak_decay = (-1.0 / (0.2 * bps)).exp();
        Self {
            sample_rate: sr,
            kw_stage1_l: k_weight_stage1(sr),
            kw_stage1_r: k_weight_stage1(sr),
            kw_stage2_l: k_weight_stage2(sr),
            kw_stage2_r: k_weight_stage2(sr),
            lufs_ring: MeanSquareRing::new(),
            blocks_per_second: bps,
            rms_decay: (-1.0 / (0.3 * bps)).exp(), // ~300ms time constant
            rms_smoothed_l: 0.0,
            rms_smoothed_r: 0.0,
            peak_hold_l: 0.0,
            peak_hold_r: 0.0,
            peak_decay,
            metering: Arc::new(AnalyzerMetering::new()),
        }
    }
}

impl DspProcessor for AnalyzerProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let n = left.len().min(right.len());
        if n == 0 {
            return;
        }

        // BUG-C01 FIX: Recalculate SR-dependent coefficients on SR change.
        let sr = crate::processors::sanitize_sample_rate(sample_rate) as f64;
        if sr.is_finite() && sr > 1000.0 && (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.kw_stage1_l = k_weight_stage1(sr);
            self.kw_stage1_r = k_weight_stage1(sr);
            self.kw_stage2_l = k_weight_stage2(sr);
            self.kw_stage2_r = k_weight_stage2(sr);
            self.blocks_per_second = sr / n.max(1) as f64;
            self.rms_decay = (-1.0 / (0.3 * self.blocks_per_second)).exp();
            self.peak_decay = (-1.0 / (0.2 * self.blocks_per_second)).exp();
        }
        self.blocks_per_second = sr / n.max(1) as f64;

        // ── Peak detection ──
        let mut block_peak_l: f64 = 0.0;
        let mut block_peak_r: f64 = 0.0;

        // ── RMS accumulation ──
        let mut rms_accum_l: f64 = 0.0;
        let mut rms_accum_r: f64 = 0.0;

        // ── K-weighted mean-square for LUFS ──
        let mut kw_ms: f64 = 0.0;

        for i in 0..n {
            let sl = left[i] as f64;
            let sr_val = right[i] as f64;

            // Peak
            let abs_l = sl.abs();
            let abs_r = sr_val.abs();
            if abs_l > block_peak_l {
                block_peak_l = abs_l;
            }
            if abs_r > block_peak_r {
                block_peak_r = abs_r;
            }

            // RMS
            rms_accum_l += sl * sl;
            rms_accum_r += sr_val * sr_val;

            // K-weighting (stage 1: high-shelf, stage 2: highpass)
            let kl = self.kw_stage2_l.process(self.kw_stage1_l.process(sl));
            let kr = self.kw_stage2_r.process(self.kw_stage1_r.process(sr_val));

            // Mean-square of K-weighted signal (mono sum, equal weighting per ITU-R BS.1770)
            kw_ms += kl * kl + kr * kr;
        }

        let inv_n = 1.0 / n as f64;

        // ── Peak with decay ──
        self.peak_hold_l = (self.peak_hold_l * self.peak_decay).max(block_peak_l);
        self.peak_hold_r = (self.peak_hold_r * self.peak_decay).max(block_peak_r);

        // ── RMS (one-pole smoothing, ~300ms) ──
        let block_rms_l = (rms_accum_l * inv_n).sqrt();
        let block_rms_r = (rms_accum_r * inv_n).sqrt();
        let d = self.rms_decay;
        self.rms_smoothed_l = d * self.rms_smoothed_l + (1.0 - d) * block_rms_l;
        self.rms_smoothed_r = d * self.rms_smoothed_r + (1.0 - d) * block_rms_r;

        // ── LUFS (push K-weighted mean-square per block) ──
        let block_kw_ms = kw_ms * inv_n;
        self.lufs_ring.push(block_kw_ms);

        // Momentary LUFS: 400ms window
        let momentary_blocks = (0.4 * self.blocks_per_second).ceil() as usize;
        let momentary_ms = self.lufs_ring.mean_last(momentary_blocks);
        let lufs_m = if momentary_ms > 1e-10 {
            (-0.691 + 10.0 * momentary_ms.log10()) as f32
        } else {
            FLOOR_DB
        };

        // Short-term LUFS: 3s window
        let short_term_blocks = (3.0 * self.blocks_per_second).ceil() as usize;
        let short_term_ms = self.lufs_ring.mean_last(short_term_blocks);
        let lufs_st = if short_term_ms > 1e-10 {
            (-0.691 + 10.0 * short_term_ms.log10()) as f32
        } else {
            FLOOR_DB
        };

        // ── Crest factor (peak / RMS in dB) ──
        let rms_avg = ((self.rms_smoothed_l + self.rms_smoothed_r) / 2.0).max(1e-10);
        let peak_avg = ((self.peak_hold_l + self.peak_hold_r) / 2.0).max(1e-10);
        let crest = (20.0 * (peak_avg / rms_avg).log10()) as f32;

        // ── Store all values atomically ──
        self.metering.store((
            to_dbfs(self.peak_hold_l),
            to_dbfs(self.peak_hold_r),
            to_dbfs(self.rms_smoothed_l),
            to_dbfs(self.rms_smoothed_r),
            lufs_m,
            lufs_st,
            crest.clamp(0.0, 40.0),
        ));

        // Audio passes through unchanged (analyzer is transparent)
    }

    fn set_param(&mut self, index: u8, value: f32) {
        if index == 0 {
            // Reset trigger
            if value > 0.5 {
                self.reset();
            }
        }
    }

    fn reset(&mut self) {
        self.kw_stage1_l.reset();
        self.kw_stage1_r.reset();
        self.kw_stage2_l.reset();
        self.kw_stage2_r.reset();
        self.lufs_ring.reset();
        self.rms_smoothed_l = 0.0;
        self.rms_smoothed_r = 0.0;
        self.peak_hold_l = 0.0;
        self.peak_hold_r = 0.0;
        let floor = FLOOR_DB;
        self.metering
            .store((floor, floor, floor, floor, floor, floor, 0.0));
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analyzer_passthrough() {
        let mut proc = AnalyzerProcessor::new(44100.0);
        let input = vec![0.5f32; 256];
        let mut left = input.clone();
        let mut right = input.clone();
        proc.process_stereo(&mut left, &mut right, 44100.0);
        // Verify audio is unchanged (pass-through)
        for (i, s) in left.iter().enumerate() {
            assert_eq!(*s, 0.5, "Analyzer modified sample at index {i}");
        }
    }

    #[test]
    fn analyzer_silence_yields_low_levels() {
        let mut proc = AnalyzerProcessor::new(44100.0);
        let mut left = vec![0.0f32; 1024];
        let mut right = vec![0.0f32; 1024];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        let peak_l = proc.metering.load_peak_l();
        assert!(
            peak_l <= -90.0,
            "Peak should be very low for silence, got {peak_l}"
        );
    }

    #[test]
    fn analyzer_full_scale_sine() {
        let mut proc = AnalyzerProcessor::new(44100.0);
        // Generate 1kHz full-scale sine
        let n = 4096;
        let mut left = vec![0.0f32; n];
        let mut right = vec![0.0f32; n];
        for i in 0..n {
            let t = i as f32 / 44100.0;
            let sample = (2.0 * std::f32::consts::PI * 1000.0 * t).sin();
            left[i] = sample;
            right[i] = sample;
        }
        // Process multiple blocks to allow smoothing
        for chunk_start in (0..n).step_by(512) {
            let chunk_end = (chunk_start + 512).min(n);
            proc.process_stereo(
                &mut left[chunk_start..chunk_end],
                &mut right[chunk_start..chunk_end],
                44100.0,
            );
        }
        let peak_l = proc.metering.load_peak_l();
        assert!(
            peak_l > -1.0 && peak_l <= 0.01,
            "Full-scale sine peak should be ~0 dBFS, got {peak_l}"
        );
        let rms_l = proc.metering.load_rms_l();
        assert!(
            rms_l > -20.0 && rms_l < 0.0,
            "Full-scale sine RMS should be above -20 dBFS (smoother may not reach steady state), got {rms_l}"
        );
    }

    #[test]
    fn analyzer_reset_clears() {
        let mut proc = AnalyzerProcessor::new(44100.0);
        let mut left = vec![1.0f32; 512];
        let mut right = vec![1.0f32; 512];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        assert!(proc.metering.load_peak_l() > -1.0);
        proc.set_param(0, 1.0); // reset
        assert!(
            proc.metering.load_peak_l() <= -90.0,
            "Reset should clear peak"
        );
    }
}
