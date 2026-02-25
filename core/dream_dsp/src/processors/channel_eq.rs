// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Channel EQ (3-Band DJ EQ)
// ═══════════════════════════════════════════════════════════════════════════
//
// A simple 3-band EQ with kill switches (DJ/console style).
// Unlike the 8-band parametric EQ, this uses fixed crossover frequencies
// with Linkwitz-Riley crossovers for clean band separation.
//
// Parameters:
//   0: Low Gain     (-inf to +6 dB, default 0)
//   1: Mid Gain     (-inf to +6 dB, default 0)
//   2: High Gain    (-inf to +6 dB, default 0)
//   3: Low Freq     (60–500 Hz, default 200)   — crossover LP → Mid
//   4: High Freq    (2000–16000 Hz, default 6000) — crossover Mid → HP
//   5: Low Kill     (0 or 1, default 0)
//   6: Mid Kill     (0 or 1, default 0)
//   7: High Kill    (0 or 1, default 0)
//   8: Output Gain  (-24 to +12 dB, default 0)
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::{db_to_linear, sanitize_sample_rate};

// ── Second-order biquad for Linkwitz-Riley (LR2) crossovers ─────────────

#[derive(Clone)]
struct Biquad2 {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad2 {
    fn new() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    /// Set as 2nd-order Butterworth lowpass (component of LR4 crossover).
    fn set_lowpass(&mut self, freq: f32, sr: f32) {
        let w0 = std::f32::consts::TAU * (freq / sr).clamp(0.001, 0.499);
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
        let a0_inv = 1.0 / (1.0 + alpha);
        self.b0 = ((1.0 - cos_w0) * 0.5) * a0_inv;
        self.b1 = (1.0 - cos_w0) * a0_inv;
        self.b2 = self.b0;
        self.a1 = (-2.0 * cos_w0) * a0_inv;
        self.a2 = (1.0 - alpha) * a0_inv;
    }

    /// Set as 2nd-order Butterworth highpass (component of LR4 crossover).
    fn set_highpass(&mut self, freq: f32, sr: f32) {
        let w0 = std::f32::consts::TAU * (freq / sr).clamp(0.001, 0.499);
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
        let a0_inv = 1.0 / (1.0 + alpha);
        self.b0 = ((1.0 + cos_w0) * 0.5) * a0_inv;
        self.b1 = (-(1.0 + cos_w0)) * a0_inv;
        self.b2 = self.b0;
        self.a1 = (-2.0 * cos_w0) * a0_inv;
        self.a2 = (1.0 - alpha) * a0_inv;
    }

    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        let out = self.b0 * input + self.z1;
        self.z1 = self.b1 * input - self.a1 * out + self.z2;
        self.z2 = self.b2 * input - self.a2 * out;
        // Flush denormals
        if self.z1.abs() < 1e-20 {
            self.z1 = 0.0;
        }
        if self.z2.abs() < 1e-20 {
            self.z2 = 0.0;
        }
        out
    }

    fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

// ── LR4 Crossover (two cascaded Butterworth 2nd-order) ──────────────────

/// Linkwitz-Riley 4th-order crossover filter (24 dB/oct).
/// Two cascaded 2nd-order Butterworth filters produce the LR4 response.
/// Sum of LP + HP outputs yields flat magnitude response and zero phase shift.
#[derive(Clone)]
struct Lr4Filter {
    stage1: Biquad2,
    stage2: Biquad2,
}

impl Lr4Filter {
    fn new() -> Self {
        Self {
            stage1: Biquad2::new(),
            stage2: Biquad2::new(),
        }
    }

    fn set_lowpass(&mut self, freq: f32, sr: f32) {
        self.stage1.set_lowpass(freq, sr);
        self.stage2.set_lowpass(freq, sr);
    }

    fn set_highpass(&mut self, freq: f32, sr: f32) {
        self.stage1.set_highpass(freq, sr);
        self.stage2.set_highpass(freq, sr);
    }

    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        self.stage2.process(self.stage1.process(input))
    }

    fn reset(&mut self) {
        self.stage1.reset();
        self.stage2.reset();
    }
}

// ── Channel EQ Processor ────────────────────────────────────────────────

pub struct ChannelEqProcessor {
    // Crossover frequency parameters
    low_freq: f32,
    high_freq: f32,
    // Gain parameters (dB)
    low_gain_db: f32,
    mid_gain_db: f32,
    high_gain_db: f32,
    output_gain_db: f32,
    // Kill switches
    low_kill: bool,
    mid_kill: bool,
    high_kill: bool,
    // State: LR4 crossover filters (stereo)
    lp_low_l: Lr4Filter,
    lp_low_r: Lr4Filter,
    hp_low_l: Lr4Filter,
    hp_low_r: Lr4Filter,
    lp_high_l: Lr4Filter,
    lp_high_r: Lr4Filter,
    hp_high_l: Lr4Filter,
    hp_high_r: Lr4Filter,
    // Smoothed band gains
    low_gain_sm: SmoothedValue,
    mid_gain_sm: SmoothedValue,
    high_gain_sm: SmoothedValue,
    output_gain_sm: SmoothedValue,
    // Smoothed kill switches
    low_kill_sm: SmoothedValue,
    mid_kill_sm: SmoothedValue,
    high_kill_sm: SmoothedValue,
    // SR
    sample_rate: f32,
}

impl ChannelEqProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        let mut proc = Self {
            low_freq: 200.0,
            high_freq: 6000.0,
            low_gain_db: 0.0,
            mid_gain_db: 0.0,
            high_gain_db: 0.0,
            output_gain_db: 0.0,
            low_kill: false,
            mid_kill: false,
            high_kill: false,
            lp_low_l: Lr4Filter::new(),
            lp_low_r: Lr4Filter::new(),
            hp_low_l: Lr4Filter::new(),
            hp_low_r: Lr4Filter::new(),
            lp_high_l: Lr4Filter::new(),
            lp_high_r: Lr4Filter::new(),
            hp_high_l: Lr4Filter::new(),
            hp_high_r: Lr4Filter::new(),
            low_gain_sm: SmoothedValue::new(sr, 10.0, 1.0),
            mid_gain_sm: SmoothedValue::new(sr, 10.0, 1.0),
            high_gain_sm: SmoothedValue::new(sr, 10.0, 1.0),
            output_gain_sm: SmoothedValue::new(sr, 8.0, 1.0),
            low_kill_sm: SmoothedValue::new(sr, 5.0, 1.0),
            mid_kill_sm: SmoothedValue::new(sr, 5.0, 1.0),
            high_kill_sm: SmoothedValue::new(sr, 5.0, 1.0),
            sample_rate: sr,
        };
        proc.update_crossovers();
        proc
    }

    fn update_crossovers(&mut self) {
        let sr = self.sample_rate;
        self.lp_low_l.set_lowpass(self.low_freq, sr);
        self.lp_low_r.set_lowpass(self.low_freq, sr);
        self.hp_low_l.set_highpass(self.low_freq, sr);
        self.hp_low_r.set_highpass(self.low_freq, sr);
        self.lp_high_l.set_lowpass(self.high_freq, sr);
        self.lp_high_r.set_lowpass(self.high_freq, sr);
        self.hp_high_l.set_highpass(self.high_freq, sr);
        self.hp_high_r.set_highpass(self.high_freq, sr);
    }

    fn gain_for_db(db: f32) -> f32 {
        if db <= -60.0 {
            0.0
        } else {
            db_to_linear(db)
        }
    }
}

impl DspProcessor for ChannelEqProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.update_crossovers();
            self.low_gain_sm.set_sample_rate(sr);
            self.mid_gain_sm.set_sample_rate(sr);
            self.high_gain_sm.set_sample_rate(sr);
            self.output_gain_sm.set_sample_rate(sr);
            self.low_kill_sm.set_sample_rate(sr);
            self.mid_kill_sm.set_sample_rate(sr);
            self.high_kill_sm.set_sample_rate(sr);
        }

        let len = left.len().min(right.len());
        // Set smoothing targets
        let low_gain_lin = Self::gain_for_db(self.low_gain_db);
        let mid_gain_lin = Self::gain_for_db(self.mid_gain_db);
        let high_gain_lin = Self::gain_for_db(self.high_gain_db);
        let output_gain_lin = Self::gain_for_db(self.output_gain_db);
        self.low_gain_sm.set_target(low_gain_lin);
        self.mid_gain_sm.set_target(mid_gain_lin);
        self.high_gain_sm.set_target(high_gain_lin);
        self.output_gain_sm.set_target(output_gain_lin);
        // Kill: target 0.0 when killed, 1.0 when active (smoothed for click-free kills)
        self.low_kill_sm
            .set_target(if self.low_kill { 0.0 } else { 1.0 });
        self.mid_kill_sm
            .set_target(if self.mid_kill { 0.0 } else { 1.0 });
        self.high_kill_sm
            .set_target(if self.high_kill { 0.0 } else { 1.0 });

        for i in 0..len {
            let in_l = left[i];
            let in_r = right[i];

            let low_g = self.low_gain_sm.next_value();
            let mid_g = self.mid_gain_sm.next_value();
            let high_g = self.high_gain_sm.next_value();
            let out_g = self.output_gain_sm.next_value();
            let low_k = self.low_kill_sm.next_value();
            let mid_k = self.mid_kill_sm.next_value();
            let high_k = self.high_kill_sm.next_value();

            // Split into 3 bands using LR4 crossovers:
            // Low:  LP(low_freq)
            // Mid:  HP(low_freq) * LP(high_freq)
            // High: HP(high_freq)

            // Low band
            let low_l = self.lp_low_l.process(in_l);
            let low_r = self.lp_low_r.process(in_r);

            // HP of low crossover (everything above low_freq)
            let hp_low_l = self.hp_low_l.process(in_l);
            let hp_low_r = self.hp_low_r.process(in_r);

            // Mid band (LP of high crossover applied to HP of low)
            let mid_l = self.lp_high_l.process(hp_low_l);
            let mid_r = self.lp_high_r.process(hp_low_r);

            // High band (HP of high crossover applied to HP of low)
            let high_l = self.hp_high_l.process(hp_low_l);
            let high_r = self.hp_high_r.process(hp_low_r);

            // Apply gains and kill switches, then sum
            left[i] = (low_l * low_g * low_k + mid_l * mid_g * mid_k + high_l * high_g * high_k)
                * out_g;
            right[i] =
                (low_r * low_g * low_k + mid_r * mid_g * mid_k + high_r * high_g * high_k)
                    * out_g;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.low_gain_db = value.clamp(-60.0, 6.0),
            1 => self.mid_gain_db = value.clamp(-60.0, 6.0),
            2 => self.high_gain_db = value.clamp(-60.0, 6.0),
            3 => {
                self.low_freq = value.clamp(60.0, 500.0);
                self.update_crossovers();
            }
            4 => {
                self.high_freq = value.clamp(2000.0, 16000.0);
                self.update_crossovers();
            }
            5 => self.low_kill = value > 0.5,
            6 => self.mid_kill = value > 0.5,
            7 => self.high_kill = value > 0.5,
            8 => self.output_gain_db = value.clamp(-24.0, 12.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.lp_low_l.reset();
        self.lp_low_r.reset();
        self.hp_low_l.reset();
        self.hp_low_r.reset();
        self.lp_high_l.reset();
        self.lp_high_r.reset();
        self.hp_high_l.reset();
        self.hp_high_r.reset();
        let low_gain_lin = Self::gain_for_db(self.low_gain_db);
        let mid_gain_lin = Self::gain_for_db(self.mid_gain_db);
        let high_gain_lin = Self::gain_for_db(self.high_gain_db);
        let output_gain_lin = Self::gain_for_db(self.output_gain_db);
        self.low_gain_sm.set_instant(low_gain_lin);
        self.mid_gain_sm.set_instant(mid_gain_lin);
        self.high_gain_sm.set_instant(high_gain_lin);
        self.output_gain_sm.set_instant(output_gain_lin);
        self.low_kill_sm
            .set_instant(if self.low_kill { 0.0 } else { 1.0 });
        self.mid_kill_sm
            .set_instant(if self.mid_kill { 0.0 } else { 1.0 });
        self.high_kill_sm
            .set_instant(if self.high_kill { 0.0 } else { 1.0 });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_eq_flat_passthrough() {
        let mut proc = ChannelEqProcessor::new(44100.0);
        let mut left = vec![0.5f32; 2048];
        let mut right = vec![0.5f32; 2048];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        // After settling, DC-like input should pass through ~unity
        let tail_avg = left[1024..].iter().sum::<f32>() / 1024.0;
        assert!(
            (tail_avg - 0.5).abs() < 0.05,
            "Flat EQ should be ~passthrough: {tail_avg}"
        );
    }

    #[test]
    fn channel_eq_kill_switch() {
        let mut proc = ChannelEqProcessor::new(44100.0);
        proc.set_param(5, 1.0); // Kill low
        proc.set_param(6, 1.0); // Kill mid
        proc.set_param(7, 1.0); // Kill high
        let mut left = vec![0.5f32; 4096];
        let mut right = vec![0.5f32; 4096];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        let tail_avg: f32 = left[2048..].iter().map(|x| x.abs()).sum::<f32>() / 2048.0;
        assert!(
            tail_avg < 0.01,
            "All kills should mute signal: {tail_avg}"
        );
    }

    #[test]
    fn channel_eq_boost_changes_level() {
        let mut proc = ChannelEqProcessor::new(44100.0);
        proc.set_param(0, 6.0); // Boost low by 6dB
        // Generate a 100Hz sine to hit the low band
        let sr = 44100.0;
        let mut left: Vec<f32> = (0..4096)
            .map(|i| (std::f32::consts::TAU * 100.0 * i as f32 / sr).sin() * 0.5)
            .collect();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, sr);
        // Tail RMS should be > 0.5 (boosted from 0.5 * sqrt(0.5) ≈ 0.35 baseline)
        let tail_rms: f32 =
            (left[2048..].iter().map(|x| x * x).sum::<f32>() / 2048.0).sqrt();
        assert!(tail_rms > 0.4, "Boosted low should increase level: {tail_rms}");
    }
}
