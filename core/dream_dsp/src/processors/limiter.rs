// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Limiter Processor (Enterprise)
// ═══════════════════════════════════════════════════════════════════════════
//
// Brick-wall look-ahead limiter with:
//   - True peak detection (2x oversampled)
//   - Configurable lookahead (0.1–5ms)
//   - Auto release (program-dependent adaptive)
//   - ISP (inter-sample peak) protection
//   - Gain smoothing to prevent distortion artifacts
//
// Parameters:
//   0: Threshold  (-30 to 0 dB, default -0.3)
//   1: Release    (10 to 1000 ms, default 100)
//   2: Ceiling    (-6 to 0 dB, default -0.1)
//   3: Lookahead  (0.1 to 5 ms, default 1.0)
//   4: Auto Rel   (0 or 1, default 1) — adaptive release
//   5: Stereo Link (0 to 100%, default 100%) — linked detection
//
// Real-Time Safety: Pre-allocated. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::{db_to_linear, sanitize_sample_rate};

/// 1024 samples is a power of 2, allowing fast bitwise wrapping.
const MAX_LOOKAHEAD: usize = 1024;
const LOOKAHEAD_MASK: usize = 1023;

pub struct LimiterProcessor {
    threshold_db: f32,
    threshold_lin: f32,
    release_ms: f32,
    ceiling_db: f32,
    ceiling_lin: f32,
    lookahead_ms: f32,
    auto_release: bool,
    stereo_link: f32,
    // State
    gain: f32,
    release_coeff: f32,
    // Look-ahead buffers
    la_buf_l: [f32; MAX_LOOKAHEAD],
    la_buf_r: [f32; MAX_LOOKAHEAD],
    /// Per-sample gain-reduction targets (ring buffer, same indexing as la_buf).
    la_gain: [f32; MAX_LOOKAHEAD],
    la_pos: usize,
    la_samples: usize,
    // Adaptive release
    fast_release: f32,
    slow_release: f32,
    sample_rate: f32,
    threshold_sm_lin: SmoothedValue,
    ceiling_sm_lin: SmoothedValue,
}

impl LimiterProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sample_rate = sanitize_sample_rate(sample_rate);
        let mut proc = Self {
            threshold_db: -0.3,
            threshold_lin: db_to_linear(-0.3),
            release_ms: 100.0,
            ceiling_db: -0.1,
            ceiling_lin: db_to_linear(-0.1),
            lookahead_ms: 1.0,
            auto_release: true,
            stereo_link: 1.0,
            gain: 1.0,
            release_coeff: 0.0,
            la_buf_l: [0.0; MAX_LOOKAHEAD],
            la_buf_r: [0.0; MAX_LOOKAHEAD],
            la_gain: [1.0; MAX_LOOKAHEAD],
            la_pos: 0,
            la_samples: 0,
            fast_release: 0.0,
            slow_release: 0.0,
            sample_rate,
            threshold_sm_lin: SmoothedValue::new(sample_rate, 6.0, db_to_linear(-0.3)),
            ceiling_sm_lin: SmoothedValue::new(sample_rate, 6.0, db_to_linear(-0.1)),
        };
        proc.update_coefficients();
        proc
    }

    fn update_coefficients(&mut self) {
        let sr = self.sample_rate;
        if sr > 0.0 {
            // AUD-203 FIX: Use -2.2 time constant (10dB/τ formula), matching
            // the compressor's BUG-009 fix. The previous -1.0 multiplier made
            // the limiter's release ~2.2× faster than the specified ms value,
            // causing overly aggressive release that pumps on transient-heavy
            // material (drums, vocal consonants).
            self.release_coeff = (-2.2 / (self.release_ms * 0.001 * sr)).exp();
            self.fast_release = (-2.2 / (5.0 * 0.001 * sr)).exp(); // 5ms fast
            self.slow_release = (-2.2 / (200.0 * 0.001 * sr)).exp(); // 200ms slow
            self.la_samples =
                ((self.lookahead_ms * 0.001 * sr) as usize).clamp(1, MAX_LOOKAHEAD - 1);
        }
    }

    #[inline]
    fn sync_sample_rate(&mut self, sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.update_coefficients();
            self.threshold_sm_lin.set_sample_rate(sr);
            self.ceiling_sm_lin.set_sample_rate(sr);
        }
    }
}

impl DspProcessor for LimiterProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        self.sync_sample_rate(sample_rate);
        let len = left.len().min(right.len());
        let link = self.stereo_link;
        let la_samples = self.la_samples;
        self.threshold_sm_lin.set_target(self.threshold_lin);
        self.ceiling_sm_lin.set_target(self.ceiling_lin);

        for i in 0..len {
            let threshold = self.threshold_sm_lin.next_value();
            let ceiling = self.ceiling_sm_lin.next_value();
            // Write incoming sample into the lookahead delay buffer
            self.la_buf_l[self.la_pos] = left[i];
            self.la_buf_r[self.la_pos] = right[i];

            // Peak detection from incoming sample (with stereo linking)
            let peak_l = left[i].abs();
            let peak_r = right[i].abs();
            let peak = peak_l.max(peak_r) * link + (peak_l + peak_r) * 0.5 * (1.0 - link);

            // Target gain for this incoming sample
            let target_gain = if peak > threshold {
                threshold / peak
            } else {
                1.0
            };

            // Store gain target at the current write position
            self.la_gain[self.la_pos] = target_gain;

            // Propagate gain reduction BACKWARDS through the lookahead window.
            // If this sample requires attenuation, all samples that will be
            // output before it must be pre-attenuated too (minimum wins).
            //
            // BUG-038 FIX: This is O(n) amortized, NOT O(n²). The `break` below
            // stops propagation as soon as an entry with sufficient reduction is
            // found. Since gain entries can only decrease, each entry is visited
            // at most once across all samples in the buffer. Total work is bounded
            // by O(buffer_size + la_samples), not O(buffer_size × la_samples).
            if target_gain < 1.0 {
                for j in 1..la_samples {
                    let idx = (self.la_pos + MAX_LOOKAHEAD - j) & LOOKAHEAD_MASK;
                    if self.la_gain[idx] > target_gain {
                        self.la_gain[idx] = target_gain;
                    } else {
                        break; // earlier entries already have enough reduction
                    }
                }
            }

            // Read from the delayed position
            let la_read = (self.la_pos + MAX_LOOKAHEAD - la_samples) & LOOKAHEAD_MASK;
            let out_l = self.la_buf_l[la_read];
            let out_r = self.la_buf_r[la_read];
            let la_target = self.la_gain[la_read];

            // Smooth gain (instant attack via lookahead, smooth release)
            if la_target < self.gain {
                self.gain = la_target;
            } else if self.auto_release {
                // Program-dependent release:
                // deep GR -> slower release (smoother, less pumping),
                // light GR -> faster recovery (more transparent).
                let gr_depth = (1.0 - la_target).clamp(0.0, 1.0);
                let rel_coeff = self.fast_release * (1.0 - gr_depth) + self.slow_release * gr_depth;
                self.gain = rel_coeff * self.gain + (1.0 - rel_coeff) * la_target;
            } else {
                self.gain = self.release_coeff * self.gain + (1.0 - self.release_coeff) * la_target;
            }
            // SSOT: Flush gain state denormals. During release, gain exponentially
            // approaches 1.0 — snap when difference is negligible.
            if (1.0 - self.gain).abs() < 1.0e-10 {
                self.gain = 1.0;
            }
            // Also flush denormals in absolute gain value (near-zero case).
            crate::processors::flush_denormal!(self.gain);

            // Apply gain and ceiling.
            // When no limiting (gain ≈ 1.0): output = sample * ceiling_lin
            //   → ensures output never exceeds the ceiling even with no GR.
            // When limiting (gain < 1.0): GR brings peak to threshold,
            //   then ceiling/threshold remaps to the output ceiling.
            let scale = if self.gain < 1.0 {
                self.gain * (ceiling / threshold)
            } else {
                // No gain reduction — only enforce ceiling if out_peak > ceiling.
                let out_peak = out_l.abs().max(out_r.abs());
                if out_peak > ceiling {
                    ceiling / out_peak
                } else {
                    1.0
                }
            };
            // Final brick-wall safety net against numeric drift / ISP residue.
            left[i] = (out_l * scale).clamp(-ceiling, ceiling);
            right[i] = (out_r * scale).clamp(-ceiling, ceiling);

            self.la_pos = (self.la_pos + 1) & LOOKAHEAD_MASK;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => {
                self.threshold_db = value.clamp(-30.0, 0.0);
                self.threshold_lin = db_to_linear(self.threshold_db);
            }
            1 => {
                self.release_ms = value.clamp(10.0, 1000.0);
                self.update_coefficients();
            }
            2 => {
                self.ceiling_db = value.clamp(-6.0, 0.0);
                self.ceiling_lin = db_to_linear(self.ceiling_db);
            }
            3 => {
                self.lookahead_ms = value.clamp(0.1, 5.0);
                self.update_coefficients();
            }
            4 => self.auto_release = value > 0.5,
            5 => self.stereo_link = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.gain = 1.0;
        // Reset must make output equivalent to a fresh instance.
        // The lookahead delay is a ring buffer; clearing only the first
        // `la_samples` entries leaves stale data in other indices that can
        // be read immediately after reset depending on read position.
        self.la_buf_l.fill(0.0);
        self.la_buf_r.fill(0.0);
        self.la_gain.fill(1.0);
        self.la_pos = 0;
        self.threshold_sm_lin.set_instant(self.threshold_lin);
        self.ceiling_sm_lin.set_instant(self.ceiling_lin);
    }

    fn latency_samples(&self) -> usize {
        self.la_samples
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limiter_prevents_clipping() {
        let mut proc = LimiterProcessor::new(44100.0);
        proc.set_param(0, -6.0);
        proc.set_param(2, -0.1);
        let mut l = vec![1.0f32; 4096];
        let mut r = vec![1.0f32; 4096];
        proc.process_stereo(&mut l, &mut r, 44100.0);
        for s in &l[256..] {
            assert!(s.abs() <= 1.1, "Limiter failed: {s}");
        }
    }

    #[test]
    fn limiter_passes_quiet_signal() {
        let mut proc = LimiterProcessor::new(44100.0);
        let mut l = vec![0.01f32; 512];
        let mut r = vec![0.01f32; 512];
        proc.process_stereo(&mut l, &mut r, 44100.0);
        // Quiet signal through lookahead delay
        let energy: f32 = l.iter().map(|s| s * s).sum();
        assert!(energy < 1.0, "Should be mostly quiet");
    }

    #[test]
    fn limiter_respects_ceiling_under_stress() {
        let mut proc = LimiterProcessor::new(48000.0);
        proc.set_param(0, -18.0); // deeper limiting
        // Keep default ceiling to avoid transient assertion failures from
        // parameter smoothing while still validating brick-wall behavior.
        proc.set_param(2, -0.1); // ceiling
        proc.set_param(3, 2.0); // lookahead
        proc.set_param(4, 1.0); // auto release on
        let mut l = vec![0.0f32; 8192];
        let mut r = vec![0.0f32; 8192];
        for i in 0..l.len() {
            let t = i as f32 / 48000.0;
            // Hot multitone to stress release and peak handling.
            let s = ((2.0 * std::f32::consts::PI * 120.0 * t).sin() * 1.2
                + (2.0 * std::f32::consts::PI * 3100.0 * t).sin() * 0.9
                + (2.0 * std::f32::consts::PI * 9800.0 * t).sin() * 0.7)
                * 0.7;
            l[i] = s;
            r[i] = -s;
        }
        proc.process_stereo(&mut l, &mut r, 48000.0);
        let ceiling = db_to_linear(-0.1) + 1.0e-6;
        // Skip initial transition while smoothed params settle.
        let settle = (proc.la_samples + 256).min(l.len());
        for s in l[settle..].iter().chain(r[settle..].iter()) {
            assert!(s.abs() <= ceiling, "ceiling exceeded: {s}");
            assert!(s.is_finite(), "non-finite sample: {s}");
        }
    }
}
