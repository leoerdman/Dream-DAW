// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Transient Shaper Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Shapes the attack and sustain portions of audio signals for punch control.
// Uses dual envelope followers (fast/slow) to separate transient from body.
//
// Algorithm:
//   1. Fast envelope (~1ms attack) captures transient onset
//   2. Slow envelope (~50ms attack) captures sustained body
//   3. Transient = fast - slow (differential)
//   4. Apply gain to transient and sustain portions independently
//   5. Reconstruct signal
//
// Parameters:
//   0: Attack   (-100 to +100%, default 0%) — transient boost/cut
//   1: Sustain  (-100 to +100%, default 0%) — body boost/cut
//   2: Output   (-24 to +12 dB, default 0)
//   3: Speed    (0–100%, default 50%)  — detection speed
//   4: Mix      (0–100%, default 100%)
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::{db_to_linear, sanitize_sample_rate};

pub struct TransientShaperProcessor {
    attack_pct: f32,   // -1..1
    sustain_pct: f32,  // -1..1
    output_db: f32,
    speed: f32,        // 0..1
    mix: f32,          // 0..1
    // Envelope followers
    env_fast_l: f32,
    env_fast_r: f32,
    env_slow_l: f32,
    env_slow_r: f32,
    // Cached coefficients
    fast_attack: f32,
    fast_release: f32,
    slow_attack: f32,
    slow_release: f32,
    // Smoothed params
    attack_sm: SmoothedValue,
    sustain_sm: SmoothedValue,
    output_sm: SmoothedValue,
    mix_sm: SmoothedValue,
    sample_rate: f32,
}

impl TransientShaperProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        let mut proc = Self {
            attack_pct: 0.0,
            sustain_pct: 0.0,
            output_db: 0.0,
            speed: 0.5,
            mix: 1.0,
            env_fast_l: 0.0,
            env_fast_r: 0.0,
            env_slow_l: 0.0,
            env_slow_r: 0.0,
            fast_attack: 0.0,
            fast_release: 0.0,
            slow_attack: 0.0,
            slow_release: 0.0,
            attack_sm: SmoothedValue::new(sr, 10.0, 0.0),
            sustain_sm: SmoothedValue::new(sr, 10.0, 0.0),
            output_sm: SmoothedValue::new(sr, 8.0, 1.0),
            mix_sm: SmoothedValue::new(sr, 8.0, 1.0),
            sample_rate: sr,
        };
        proc.update_coefficients();
        proc
    }

    fn update_coefficients(&mut self) {
        let sr = self.sample_rate;
        // Fast envelope: 0.1–5ms attack (speed-dependent), 10ms release
        let fast_attack_ms = 0.1 + (1.0 - self.speed) * 4.9;
        let fast_release_ms = 10.0 + (1.0 - self.speed) * 40.0;
        // Slow envelope: 20–100ms attack (speed-dependent), 100ms release
        let slow_attack_ms = 20.0 + (1.0 - self.speed) * 80.0;
        let slow_release_ms = 100.0 + (1.0 - self.speed) * 200.0;

        self.fast_attack = Self::env_coeff(fast_attack_ms, sr);
        self.fast_release = Self::env_coeff(fast_release_ms, sr);
        self.slow_attack = Self::env_coeff(slow_attack_ms, sr);
        self.slow_release = Self::env_coeff(slow_release_ms, sr);
    }

    #[inline]
    fn env_coeff(time_ms: f32, sr: f32) -> f32 {
        let samples = time_ms * 0.001 * sr;
        if samples > 0.0 {
            (-2.2 / samples).exp()
        } else {
            0.0
        }
    }

    #[inline]
    fn follow(input: f32, state: &mut f32, attack: f32, release: f32) -> f32 {
        let abs = input.abs();
        let coeff = if abs > *state { attack } else { release };
        *state = coeff * *state + (1.0 - coeff) * abs;
        if state.abs() < 1e-20 {
            *state = 0.0;
        }
        *state
    }
}

impl DspProcessor for TransientShaperProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.update_coefficients();
            self.attack_sm.set_sample_rate(sr);
            self.sustain_sm.set_sample_rate(sr);
            self.output_sm.set_sample_rate(sr);
            self.mix_sm.set_sample_rate(sr);
        }

        let len = left.len().min(right.len());
        let output_lin = if self.output_db <= -24.0 {
            0.0
        } else {
            db_to_linear(self.output_db)
        };
        self.attack_sm.set_target(self.attack_pct);
        self.sustain_sm.set_target(self.sustain_pct);
        self.output_sm.set_target(output_lin);
        self.mix_sm.set_target(self.mix);

        let fa = self.fast_attack;
        let fr = self.fast_release;
        let sa = self.slow_attack;
        let sr_coeff = self.slow_release;

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let atk_amt = self.attack_sm.next_value();
            let sus_amt = self.sustain_sm.next_value();
            let out_g = self.output_sm.next_value();
            let mix = self.mix_sm.next_value();

            // Dual envelope followers
            let fast_l = Self::follow(dry_l, &mut self.env_fast_l, fa, fr);
            let fast_r = Self::follow(dry_r, &mut self.env_fast_r, fa, fr);
            let slow_l = Self::follow(dry_l, &mut self.env_slow_l, sa, sr_coeff);
            let slow_r = Self::follow(dry_r, &mut self.env_slow_r, sa, sr_coeff);

            // Transient detection: ratio of fast/slow envelope
            // When transient occurs: fast >> slow → ratio > 1
            // During sustain: fast ≈ slow → ratio ≈ 1
            let transient_l = if slow_l > 1e-10 {
                (fast_l / slow_l - 1.0).max(0.0)
            } else {
                0.0
            };
            let transient_r = if slow_r > 1e-10 {
                (fast_r / slow_r - 1.0).max(0.0)
            } else {
                0.0
            };

            // Attack gain: boost/cut the transient portion
            // atk_amt > 0 → amplify transients, < 0 → soften transients
            let atk_gain_l = 1.0 + atk_amt * transient_l.min(4.0);
            let atk_gain_r = 1.0 + atk_amt * transient_r.min(4.0);

            // Sustain gain: boost/cut the body (non-transient)
            // sus_amt > 0 → louder sustain, < 0 → gate-like
            let sustain_ratio_l = 1.0 - transient_l.min(1.0);
            let sustain_ratio_r = 1.0 - transient_r.min(1.0);
            let sus_gain_l = 1.0 + sus_amt * sustain_ratio_l;
            let sus_gain_r = 1.0 + sus_amt * sustain_ratio_r;

            // Combined gain
            let gain_l = (atk_gain_l * sus_gain_l).clamp(0.0, 8.0);
            let gain_r = (atk_gain_r * sus_gain_r).clamp(0.0, 8.0);

            let wet_l = dry_l * gain_l;
            let wet_r = dry_r * gain_r;
            left[i] = (dry_l * (1.0 - mix) + wet_l * mix) * out_g;
            right[i] = (dry_r * (1.0 - mix) + wet_r * mix) * out_g;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.attack_pct = (value / 100.0).clamp(-1.0, 1.0),
            1 => self.sustain_pct = (value / 100.0).clamp(-1.0, 1.0),
            2 => self.output_db = value.clamp(-24.0, 12.0),
            3 => {
                self.speed = (value / 100.0).clamp(0.0, 1.0);
                self.update_coefficients();
            }
            4 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.env_fast_l = 0.0;
        self.env_fast_r = 0.0;
        self.env_slow_l = 0.0;
        self.env_slow_r = 0.0;
        self.attack_sm.set_instant(self.attack_pct);
        self.sustain_sm.set_instant(self.sustain_pct);
        let output_lin = if self.output_db <= -24.0 {
            0.0
        } else {
            db_to_linear(self.output_db)
        };
        self.output_sm.set_instant(output_lin);
        self.mix_sm.set_instant(self.mix);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_shaper_passthrough_at_zero() {
        let mut proc = TransientShaperProcessor::new(44100.0);
        // Attack=0, Sustain=0 → should be near-passthrough
        let sr = 44100.0;
        let mut left: Vec<f32> = (0..4096)
            .map(|i| (std::f32::consts::TAU * 440.0 * i as f32 / sr).sin() * 0.5)
            .collect();
        let original = left.clone();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, sr);
        let diff: f32 = left[2048..]
            .iter()
            .zip(original[2048..].iter())
            .map(|(a, b)| (a - b).abs())
            .sum::<f32>()
            / 2048.0;
        assert!(diff < 0.05, "Zero settings should be near-passthrough: {diff}");
    }

    #[test]
    fn transient_shaper_boost_attack_changes_signal() {
        let mut proc = TransientShaperProcessor::new(44100.0);
        proc.set_param(0, 100.0); // +100% attack
        // Simulate a drum hit: burst then silence
        let sr = 44100.0;
        let mut left = vec![0.0f32; 4096];
        let mut right = vec![0.0f32; 4096];
        // Burst for 100 samples
        for i in 0..100 {
            left[i] = (std::f32::consts::TAU * 200.0 * i as f32 / sr).sin() * 0.8;
            right[i] = left[i];
        }
        let original_peak: f32 = left.iter().map(|x| x.abs()).fold(0.0f32, f32::max);
        proc.process_stereo(&mut left, &mut right, sr);
        let processed_peak: f32 = left.iter().map(|x| x.abs()).fold(0.0f32, f32::max);
        assert!(
            processed_peak >= original_peak * 0.95,
            "Attack boost should increase or maintain peak: orig={original_peak}, proc={processed_peak}"
        );
        assert!(
            left.iter().all(|x| x.is_finite()),
            "All samples must be finite"
        );
    }
}
