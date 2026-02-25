// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Compressor Processor (Enterprise)
// ═══════════════════════════════════════════════════════════════════════════
//
// Feed-forward dynamic range compressor with:
//   - Soft/hard knee
//   - Sidechain high-pass filter (rumble rejection)
//   - Auto make-up gain
//   - Gain reduction smoothing (attack/release)
//   - RMS or Peak detection modes
//   - Dry/wet (parallel compression)
//
// Parameters:
//   0: Threshold  (-60 to 0 dB, default -18)
//   1: Ratio      (1.0 to 20.0, default 4.0)
//   2: Attack     (0.1 to 100 ms, default 10)
//   3: Release    (10 to 1000 ms, default 100)
//   4: Knee       (0 to 24 dB, default 6) — soft knee width
//   5: Makeup     (-12 to +24 dB, default 0)
//   6: Mix        (0 to 100%, default 100%) — parallel blend
//   7: SC HPF     (20–500 Hz, default 20) — sidechain highpass
//   8: Auto Gain  (0 or 1, default 1)
//   9: RMS Mode   (0=Peak, 1=RMS, default 0)
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::{db_to_linear, sanitize_sample_rate};
use crate::processors::smoothing::SmoothedValue;

const MAX_LOOKAHEAD_SAMPLES: usize = 2048;
const LOOKAHEAD_MASK: usize = MAX_LOOKAHEAD_SAMPLES - 1;
const DEFAULT_LOOKAHEAD_MS: f32 = 1.0;

pub struct CompressorProcessor {
    threshold_db: f32,
    ratio: f32,
    attack_ms: f32,
    release_ms: f32,
    knee_db: f32,
    makeup_db: f32,
    makeup_lin: f32,
    mix: f32,
    sc_hpf_freq: f32,
    auto_gain: bool,
    rms_mode: bool,
    // State
    envelope_db: f32,
    rms_state: f32,
    // Sidechain HPF state
    sc_hp_state_l: f32,
    sc_hp_state_r: f32,
    /// Previous SC HPF input for first-order HP: y[n] = α*(y[n-1] + x[n] - x[n-1])
    sc_hp_prev_l: f32,
    sc_hp_prev_r: f32,
    sc_hp_coeff: f32,
    // Cached coefficients
    attack_coeff: f32,
    release_coeff: f32,
    /// Slower release coefficient used for program-dependent release blending.
    release_slow_coeff: f32,
    sample_rate: f32,
    threshold_sm_db: SmoothedValue,
    mix_sm: SmoothedValue,
    ratio_sm: SmoothedValue,
    knee_sm_db: SmoothedValue,
    /// Cached RMS coefficient — only recalculated on SR change.
    rms_coeff: f32,
    // Fixed internal lookahead (pre-allocated; zero RT allocs).
    lookahead_ms: f32,
    lookahead_samples: usize,
    la_pos: usize,
    la_filled: usize,
    la_buf_l: [f32; MAX_LOOKAHEAD_SAMPLES],
    la_buf_r: [f32; MAX_LOOKAHEAD_SAMPLES],
}

impl CompressorProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sample_rate = crate::processors::sanitize_sample_rate(sample_rate);
        let mut proc = Self {
            threshold_db: -18.0,
            ratio: 4.0,
            attack_ms: 10.0,
            release_ms: 100.0,
            knee_db: 6.0,
            makeup_db: 0.0,
            makeup_lin: 1.0,
            mix: 1.0,
            sc_hpf_freq: 20.0,
            auto_gain: true,
            rms_mode: false,
            envelope_db: -96.0,
            rms_state: 0.0,
            sc_hp_state_l: 0.0,
            sc_hp_state_r: 0.0,
            sc_hp_prev_l: 0.0,
            sc_hp_prev_r: 0.0,
            sc_hp_coeff: 0.0,
            attack_coeff: 0.0,
            release_coeff: 0.0,
            release_slow_coeff: 0.0,
            sample_rate,
            threshold_sm_db: SmoothedValue::new(sample_rate, 10.0, -18.0),
            mix_sm: SmoothedValue::new(sample_rate, 8.0, 1.0),
            ratio_sm: SmoothedValue::new(sample_rate, 10.0, 4.0),
            knee_sm_db: SmoothedValue::new(sample_rate, 10.0, 6.0),
            rms_coeff: 0.0,
            lookahead_ms: DEFAULT_LOOKAHEAD_MS,
            lookahead_samples: 0,
            la_pos: 0,
            la_filled: 0,
            la_buf_l: [0.0; MAX_LOOKAHEAD_SAMPLES],
            la_buf_r: [0.0; MAX_LOOKAHEAD_SAMPLES],
        };
        proc.update_coefficients();
        proc.update_sc_hpf();
        proc.update_rms_coeff();
        proc
    }

    fn update_coefficients(&mut self) {
        let sr = self.sample_rate;
        if sr > 0.0 {
            // BUG-009 FIX: Use proper 10dB/time_constant formula.
            // Previous formula used -1.0 which produced ~2x faster response.
            // The standard -2.2 factor gives the correct time constant where
            // the envelope reaches ~10dB of its target in the specified time.
            // AUD-228 FIX: Use shared SSOT envelope_coeff helper.
            self.attack_coeff = if self.attack_ms > 0.0 {
                crate::processors::envelope_coeff(self.attack_ms, sr)
            } else {
                0.0 // Instant attack
            };
            self.release_coeff = if self.release_ms > 0.0 {
                crate::processors::envelope_coeff(self.release_ms, sr)
            } else {
                0.0 // Instant release
            };
            // Program-dependent release companion:
            // under heavy GR, release gets slower to reduce pumping/chatter.
            let slow_release_ms = (self.release_ms * 2.5).min(5000.0);
            self.release_slow_coeff = if slow_release_ms > 0.0 {
                crate::processors::envelope_coeff(slow_release_ms, sr)
            } else {
                0.0
            };
            self.lookahead_samples =
                ((self.lookahead_ms * 0.001 * sr) as usize).clamp(1, MAX_LOOKAHEAD_SAMPLES - 1);
        }
    }

    fn update_sc_hpf(&mut self) {
        // BUG-FIX: Previous formula exp(-2πfc/fs) is a LP coefficient.
        // The HP filter equation y[n] = α*(y[n-1] + x[n] - x[n-1])
        // requires α = 1/(1 + 2πfc/fs) for correct HP behaviour.
        let w = std::f32::consts::TAU * self.sc_hpf_freq / self.sample_rate;
        self.sc_hp_coeff = 1.0 / (1.0 + w);
    }

    fn update_rms_coeff(&mut self) {
        self.rms_coeff = if self.rms_mode {
            1.0 - (-1.0 / (0.020 * self.sample_rate)).exp()
        } else {
            0.0
        };
    }

    fn compute_auto_makeup(&self) -> f32 {
        // Estimate makeup from threshold and ratio
        if self.auto_gain {
            let over = -self.threshold_db;
            if over > 0.0 {
                let reduction = over * (1.0 - 1.0 / self.ratio) * 0.5;
                db_to_linear(reduction)
            } else {
                1.0
            }
        } else {
            self.makeup_lin
        }
    }

    #[inline]
    fn sync_sample_rate(&mut self, sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.update_coefficients();
            self.update_sc_hpf();
            self.update_rms_coeff();
            self.threshold_sm_db.set_sample_rate(sr);
            self.mix_sm.set_sample_rate(sr);
            self.ratio_sm.set_sample_rate(sr);
            self.knee_sm_db.set_sample_rate(sr);
            // BUG-C09 FIX: Recalculate lookahead_samples on SR change.
            // Without this, the lookahead in ms drifts across sample rates.
            self.lookahead_samples =
                ((self.lookahead_ms * 0.001 * sr) as usize).clamp(1, MAX_LOOKAHEAD_SAMPLES - 1);
            // BUG-H05 FIX: Reset la_filled so the lookahead buffer refills
            // correctly at the new sample rate. Without this, la_filled
            // retains the old value and may exceed the new lookahead_samples,
            // reading stale entries.
            self.la_filled = 0;
        }
    }

    #[inline]
    fn linear_to_db(x: f32) -> f32 {
        if x < 1e-10 {
            -96.0
        } else {
            // Use exact log10 here to keep threshold/knee behavior deterministic.
            20.0 * x.log10()
        }
    }


    /// Soft-knee gain computation.
    #[inline]
    fn compute_gain_reduction(input_db: f32, threshold: f32, ratio: f32, knee: f32) -> f32 {
        if knee <= 1.0e-6 {
            // Hard-knee fallback prevents division-by-zero when knee = 0.
            if input_db <= threshold {
                return 0.0;
            }
            let over = input_db - threshold;
            return -(over * (1.0 - 1.0 / ratio));
        }
        let half_knee = knee * 0.5;

        if input_db < threshold - half_knee {
            // Below knee: no compression
            0.0
        } else if input_db > threshold + half_knee {
            // Above knee: full compression
            let over = input_db - threshold;
            -(over * (1.0 - 1.0 / ratio))
        } else {
            // In the knee zone: quadratic interpolation
            let x = input_db - threshold + half_knee;
            let slope = (1.0 - 1.0 / ratio) / (2.0 * knee);
            -(slope * x * x)
        }
    }
}

impl DspProcessor for CompressorProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        self.sync_sample_rate(sample_rate);
        let len = left.len().min(right.len());
        let attack = self.attack_coeff;
        let release = self.release_coeff;
        let release_slow = self.release_slow_coeff;
        let makeup = self.compute_auto_makeup();
        self.threshold_sm_db.set_target(self.threshold_db);
        self.mix_sm.set_target(self.mix);
        self.ratio_sm.set_target(self.ratio);
        self.knee_sm_db.set_target(self.knee_db);
        // BUG-15 FIX: Use cached rms_coeff instead of per-call exp().
        let rms_coeff = self.rms_coeff;

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            self.la_buf_l[self.la_pos] = dry_l;
            self.la_buf_r[self.la_pos] = dry_r;
            let threshold_db = self.threshold_sm_db.next_value();
            let mix = self.mix_sm.next_value();
            let ratio = self.ratio_sm.next_value().clamp(1.0, 20.0);
            let knee = self.knee_sm_db.next_value().clamp(0.0, 24.0);
            let dry_mix = 1.0 - mix;

            // Sidechain HPF: standard first-order HP y[n] = α*(y[n-1] + x[n] - x[n-1])
            let sc_l = if self.sc_hpf_freq > 25.0 {
                self.sc_hp_state_l =
                    self.sc_hp_coeff * (self.sc_hp_state_l + dry_l - self.sc_hp_prev_l);
                self.sc_hp_prev_l = dry_l;
                self.sc_hp_state_l
            } else {
                dry_l
            };
            let sc_r = if self.sc_hpf_freq > 25.0 {
                self.sc_hp_state_r =
                    self.sc_hp_coeff * (self.sc_hp_state_r + dry_r - self.sc_hp_prev_r);
                self.sc_hp_prev_r = dry_r;
                self.sc_hp_state_r
            } else {
                dry_r
            };

            // Detection
            let detection = if self.rms_mode {
                let sq = (sc_l * sc_l + sc_r * sc_r) * 0.5;
                self.rms_state += rms_coeff * (sq - self.rms_state);
                self.rms_state.max(0.0).sqrt()
            } else {
                sc_l.abs().max(sc_r.abs())
            };

            let input_db = Self::linear_to_db(detection);

            // Envelope with program-dependent release:
            // deeper GR => slower release (musical, less pumping).
            let gr_probe_db =
                -Self::compute_gain_reduction(self.envelope_db, threshold_db, ratio, knee);
            let rel_blend = (gr_probe_db / 24.0).clamp(0.0, 1.0);
            let release_dyn = release + (release_slow - release) * rel_blend;
            let coeff = if input_db > self.envelope_db {
                attack
            } else {
                release_dyn
            };
            self.envelope_db = coeff * self.envelope_db + (1.0 - coeff) * input_db;
            // SSOT: Flush denormals in envelope/RMS state.
            crate::processors::flush_denormal!(self.envelope_db);
            crate::processors::flush_denormal!(self.rms_state);
            // BUG-M17 FIX: Flush SC-HPF state denormals in the non-sidechain
            // path too. Previously only the sidechain path flushed these.
            crate::processors::flush_denormal!(self.sc_hp_state_l);
            crate::processors::flush_denormal!(self.sc_hp_state_r);
            // BUG-027b FIX: Flush sc_hp_prev too — same pattern as gate.rs BUG-027.
            crate::processors::flush_denormal!(self.sc_hp_prev_l);
            crate::processors::flush_denormal!(self.sc_hp_prev_r);

            // Gain computation (with soft knee)
            let gain_db = Self::compute_gain_reduction(self.envelope_db, threshold_db, ratio, knee);
            let gain = db_to_linear(gain_db) * makeup;

            let read_pos =
                (self.la_pos + MAX_LOOKAHEAD_SAMPLES - self.lookahead_samples) & LOOKAHEAD_MASK;
            // BUG-022 FIX: Output silence during lookahead fill instead of dry signal.
            // Previously output uncompressed input during initial fill = pre-echo burst.
            let delayed_l = if self.la_filled < self.lookahead_samples {
                0.0
            } else {
                self.la_buf_l[read_pos]
            };
            let delayed_r = if self.la_filled < self.lookahead_samples {
                0.0
            } else {
                self.la_buf_r[read_pos]
            };
            left[i] = dry_l * dry_mix + delayed_l * gain * mix;
            right[i] = dry_r * dry_mix + delayed_r * gain * mix;
            self.la_pos = (self.la_pos + 1) & LOOKAHEAD_MASK;
            self.la_filled = (self.la_filled + 1).min(self.lookahead_samples);
        }
    }

    fn process_stereo_with_sidechain(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        sidechain_left: Option<&[f32]>,
        sidechain_right: Option<&[f32]>,
        sample_rate: f32,
    ) {
        self.sync_sample_rate(sample_rate);
        let len = left.len().min(right.len());
        let attack = self.attack_coeff;
        let release = self.release_coeff;
        let release_slow = self.release_slow_coeff;
        let makeup = self.compute_auto_makeup();
        self.threshold_sm_db.set_target(self.threshold_db);
        self.mix_sm.set_target(self.mix);
        self.ratio_sm.set_target(self.ratio);
        self.knee_sm_db.set_target(self.knee_db);
        // BUG-15 FIX: Use cached rms_coeff instead of per-call exp().
        let rms_coeff = self.rms_coeff;

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            self.la_buf_l[self.la_pos] = dry_l;
            self.la_buf_r[self.la_pos] = dry_r;
            let threshold_db = self.threshold_sm_db.next_value();
            let mix = self.mix_sm.next_value();
            let ratio = self.ratio_sm.next_value().clamp(1.0, 20.0);
            let knee = self.knee_sm_db.next_value().clamp(0.0, 24.0);
            let dry_mix = 1.0 - mix;

            let sc_src_l = sidechain_left
                .and_then(|sc| sc.get(i).copied())
                .unwrap_or(dry_l);
            let sc_src_r = sidechain_right
                .and_then(|sc| sc.get(i).copied())
                .unwrap_or(dry_r);

            // Sidechain HPF: standard first-order HP y[n] = α*(y[n-1] + x[n] - x[n-1])
            let sc_l = if self.sc_hpf_freq > 25.0 {
                self.sc_hp_state_l =
                    self.sc_hp_coeff * (self.sc_hp_state_l + sc_src_l - self.sc_hp_prev_l);
                self.sc_hp_prev_l = sc_src_l;
                self.sc_hp_state_l
            } else {
                sc_src_l
            };
            let sc_r = if self.sc_hpf_freq > 25.0 {
                self.sc_hp_state_r =
                    self.sc_hp_coeff * (self.sc_hp_state_r + sc_src_r - self.sc_hp_prev_r);
                self.sc_hp_prev_r = sc_src_r;
                self.sc_hp_state_r
            } else {
                sc_src_r
            };

            let detection = if self.rms_mode {
                let sq = (sc_l * sc_l + sc_r * sc_r) * 0.5;
                self.rms_state += rms_coeff * (sq - self.rms_state);
                self.rms_state.max(0.0).sqrt()
            } else {
                sc_l.abs().max(sc_r.abs())
            };

            let input_db = Self::linear_to_db(detection);
            let gr_probe_db =
                -Self::compute_gain_reduction(self.envelope_db, threshold_db, ratio, knee);
            let rel_blend = (gr_probe_db / 24.0).clamp(0.0, 1.0);
            let release_dyn = release + (release_slow - release) * rel_blend;
            let coeff = if input_db > self.envelope_db {
                attack
            } else {
                release_dyn
            };
            self.envelope_db = coeff * self.envelope_db + (1.0 - coeff) * input_db;
            // SSOT: Flush denormals in envelope/RMS/SC-HPF state.
            crate::processors::flush_denormal!(self.envelope_db);
            crate::processors::flush_denormal!(self.rms_state);
            crate::processors::flush_denormal!(self.sc_hp_state_l);
            crate::processors::flush_denormal!(self.sc_hp_state_r);
            // BUG-027b FIX: Flush sc_hp_prev too — same pattern as gate.rs BUG-027.
            crate::processors::flush_denormal!(self.sc_hp_prev_l);
            crate::processors::flush_denormal!(self.sc_hp_prev_r);

            let gain_db = Self::compute_gain_reduction(self.envelope_db, threshold_db, ratio, knee);
            let gain = db_to_linear(gain_db) * makeup;

            let read_pos =
                (self.la_pos + MAX_LOOKAHEAD_SAMPLES - self.lookahead_samples) & LOOKAHEAD_MASK;
            // BUG-002 FIX: Output silence during lookahead fill phase, matching
            // process_stereo() behavior. Previously output dry signal = pre-echo burst.
            let delayed_l = if self.la_filled < self.lookahead_samples {
                0.0
            } else {
                self.la_buf_l[read_pos]
            };
            let delayed_r = if self.la_filled < self.lookahead_samples {
                0.0
            } else {
                self.la_buf_r[read_pos]
            };
            left[i] = dry_l * dry_mix + delayed_l * gain * mix;
            right[i] = dry_r * dry_mix + delayed_r * gain * mix;
            self.la_pos = (self.la_pos + 1) & LOOKAHEAD_MASK;
            self.la_filled = (self.la_filled + 1).min(self.lookahead_samples);
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.threshold_db = value.clamp(-60.0, 0.0),
            1 => self.ratio = value.clamp(1.0, 20.0),
            2 => {
                self.attack_ms = value.clamp(0.1, 100.0);
                self.update_coefficients();
            }
            3 => {
                self.release_ms = value.clamp(10.0, 1000.0);
                self.update_coefficients();
            }
            4 => self.knee_db = value.clamp(0.0, 24.0),
            5 => {
                self.makeup_db = value.clamp(-12.0, 24.0);
                self.makeup_lin = db_to_linear(self.makeup_db);
            }
            6 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            7 => {
                self.sc_hpf_freq = value.clamp(20.0, 500.0);
                self.update_sc_hpf();
            }
            8 => self.auto_gain = value > 0.5,
            9 => {
                self.rms_mode = value > 0.5;
                self.update_rms_coeff();
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.envelope_db = -96.0;
        self.rms_state = 0.0;
        self.sc_hp_state_l = 0.0;
        self.sc_hp_state_r = 0.0;
        self.sc_hp_prev_l = 0.0;
        self.sc_hp_prev_r = 0.0;
        self.la_pos = 0;
        self.la_filled = 0;
        // BUG-024 FIX: In-place fill instead of stack array literal copy (avoids 2×8KB stack alloc).
        self.la_buf_l.fill(0.0);
        self.la_buf_r.fill(0.0);
        self.threshold_sm_db.set_instant(self.threshold_db);
        self.mix_sm.set_instant(self.mix);
        self.ratio_sm.set_instant(self.ratio);
        self.knee_sm_db.set_instant(self.knee_db);
    }

    fn latency_samples(&self) -> usize {
        self.lookahead_samples
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressor_passes_quiet_signal() {
        let mut proc = CompressorProcessor::new(44100.0);
        let mut left = vec![0.01f32; 256];
        let mut right = vec![0.01f32; 256];
        let original = left.clone();
        proc.process_stereo(&mut left, &mut right, 44100.0);
        for (i, s) in left.iter().enumerate() {
            assert!((s - original[i]).abs() < 0.05, "Quiet signal changed: {s}");
        }
    }

    #[test]
    fn compressor_reduces_loud_signal() {
        let mut proc = CompressorProcessor::new(44100.0);
        proc.set_param(0, -20.0);
        proc.set_param(1, 10.0);
        proc.set_param(2, 0.1);
        proc.set_param(8, 0.0); // manual gain
        proc.set_param(5, 0.0); // 0 dB makeup
        let mut left = vec![1.0f32; 4096];
        let mut right = vec![1.0f32; 4096];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        let tail_avg: f32 = left[2048..].iter().sum::<f32>() / 2048.0;
        assert!(
            tail_avg < 0.5,
            "Loud signal should be compressed, got: {tail_avg}"
        );
    }

    #[test]
    fn compressor_soft_knee() {
        let mut proc = CompressorProcessor::new(44100.0);
        proc.set_param(4, 12.0); // 12dB soft knee
        proc.set_param(0, -12.0);
        // Just test it doesn't panic
        let mut l = vec![0.3f32; 1024];
        let mut r = vec![0.3f32; 1024];
        proc.process_stereo(&mut l, &mut r, 44100.0);
    }

    #[test]
    fn compressor_program_dependent_release_is_stable() {
        let mut proc = CompressorProcessor::new(48000.0);
        proc.set_param(0, -24.0);
        proc.set_param(1, 12.0);
        proc.set_param(2, 2.0);
        proc.set_param(3, 120.0);
        proc.set_param(8, 0.0); // manual makeup
        proc.set_param(5, 0.0);

        let mut l = vec![0.0f32; 8192];
        let mut r = vec![0.0f32; 8192];
        // Loud block then silence to exercise release trajectory.
        for i in 0..4096 {
            l[i] = 0.95;
            r[i] = 0.95;
        }
        proc.process_stereo(&mut l, &mut r, 48000.0);
        for s in l.iter().chain(r.iter()) {
            assert!(s.is_finite(), "non-finite sample: {s}");
        }
    }
}
