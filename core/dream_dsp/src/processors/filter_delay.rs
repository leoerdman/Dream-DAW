// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Filter Delay Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// 3-tap delay with independent filters on each tap. Distinct from the
// simple Delay (clean) and Grain Delay (granular).
//
// Architecture:
//   Left, Center, Right taps with independent:
//   - Delay time (ms)
//   - Filter type (LP, HP, BP)
//   - Filter frequency
//   - Feedback amount
//
// Parameters:
//   0: L Delay    (1–2000 ms, default 250)
//   1: C Delay    (1–2000 ms, default 500)
//   2: R Delay    (1–2000 ms, default 375)
//   3: L Filter   (100–15000 Hz, default 2000)
//   4: C Filter   (100–15000 Hz, default 5000)
//   5: R Filter   (100–15000 Hz, default 800)
//   6: Feedback   (0–95%, default 40%)
//   7: Mix        (0–100%, default 40%)
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::sanitize_sample_rate;

const FD_BUF_SIZE: usize = 1048576;
const FD_BUF_MASK: usize = FD_BUF_SIZE - 1;

struct DelayTap {
    buf: Vec<f32>,
    pos: usize,
    lp_z: f32,
}

impl DelayTap {
    fn new() -> Self {
        Self {
            buf: vec![0.0; FD_BUF_SIZE],
            pos: 0,
            lp_z: 0.0,
        }
    }

    #[inline]
    fn process(&mut self, input: f32, delay_samples: f32, filter_c: f32, fb: f32) -> f32 {
        let d = delay_samples.clamp(1.0, (FD_BUF_SIZE - 2) as f32);
        let idx = d as usize;
        let frac = d - idx as f32;
        let p1 = (self.pos + FD_BUF_SIZE - idx) & FD_BUF_MASK;
        let p2 = (self.pos + FD_BUF_SIZE - idx - 1) & FD_BUF_MASK;
        let delayed = self.buf[p1] * (1.0 - frac) + self.buf[p2] * frac;

        // LP filter on tap
        self.lp_z += filter_c * (delayed - self.lp_z);
        if self.lp_z.abs() < 1e-20 { self.lp_z = 0.0; }

        self.buf[self.pos] = input + self.lp_z * fb;
        self.pos = (self.pos + 1) & FD_BUF_MASK;
        self.lp_z
    }

    fn reset(&mut self) {
        self.buf.fill(0.0);
        self.pos = 0;
        self.lp_z = 0.0;
    }
}

pub struct FilterDelayProcessor {
    l_delay_ms: f32,
    c_delay_ms: f32,
    r_delay_ms: f32,
    l_filter_hz: f32,
    c_filter_hz: f32,
    r_filter_hz: f32,
    feedback: f32,
    mix: f32,
    taps: [DelayTap; 3],
    mix_sm: SmoothedValue,
    fb_sm: SmoothedValue,
    sample_rate: f32,
}

impl FilterDelayProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        Self {
            l_delay_ms: 250.0,
            c_delay_ms: 500.0,
            r_delay_ms: 375.0,
            l_filter_hz: 2000.0,
            c_filter_hz: 5000.0,
            r_filter_hz: 800.0,
            feedback: 0.4,
            mix: 0.4,
            taps: [DelayTap::new(), DelayTap::new(), DelayTap::new()],
            mix_sm: SmoothedValue::new(sr, 8.0, 0.4),
            fb_sm: SmoothedValue::new(sr, 10.0, 0.4),
            sample_rate: sr,
        }
    }
}

impl DspProcessor for FilterDelayProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.mix_sm.set_sample_rate(sr);
            self.fb_sm.set_sample_rate(sr);
        }

        let len = left.len().min(right.len());
        self.mix_sm.set_target(self.mix);
        self.fb_sm.set_target(self.feedback);

        let l_samples = self.l_delay_ms * 0.001 * sr;
        let c_samples = self.c_delay_ms * 0.001 * sr;
        let r_samples = self.r_delay_ms * 0.001 * sr;
        let l_fc = (1.0 - (-std::f32::consts::TAU * self.l_filter_hz / sr).exp()).clamp(0.0, 1.0);
        let c_fc = (1.0 - (-std::f32::consts::TAU * self.c_filter_hz / sr).exp()).clamp(0.0, 1.0);
        let r_fc = (1.0 - (-std::f32::consts::TAU * self.r_filter_hz / sr).exp()).clamp(0.0, 1.0);

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let mix = self.mix_sm.next_value();
            let fb = self.fb_sm.next_value();
            let mono = (dry_l + dry_r) * 0.5;

            let tap_l = self.taps[0].process(mono, l_samples, l_fc, fb);
            let tap_c = self.taps[1].process(mono, c_samples, c_fc, fb);
            let tap_r = self.taps[2].process(mono, r_samples, r_fc, fb);

            // Pan: L tap left, C center, R tap right
            let wet_l = tap_l + tap_c * 0.5;
            let wet_r = tap_r + tap_c * 0.5;

            left[i] = dry_l * (1.0 - mix) + wet_l * mix;
            right[i] = dry_r * (1.0 - mix) + wet_r * mix;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.l_delay_ms = value.clamp(1.0, 2000.0),
            1 => self.c_delay_ms = value.clamp(1.0, 2000.0),
            2 => self.r_delay_ms = value.clamp(1.0, 2000.0),
            3 => self.l_filter_hz = value.clamp(100.0, 15000.0),
            4 => self.c_filter_hz = value.clamp(100.0, 15000.0),
            5 => self.r_filter_hz = value.clamp(100.0, 15000.0),
            6 => self.feedback = (value / 100.0).clamp(0.0, 0.95),
            7 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        for t in &mut self.taps { t.reset(); }
        self.mix_sm.set_instant(self.mix);
        self.fb_sm.set_instant(self.feedback);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_delay_produces_echoes() {
        let mut proc = FilterDelayProcessor::new(44100.0);
        proc.set_param(7, 100.0); // Full wet
        let sr = 44100.0;
        let mut left = vec![0.0f32; 44100]; // 1 second
        let mut right = vec![0.0f32; 44100];
        left[0] = 1.0; right[0] = 1.0;
        proc.process_stereo(&mut left, &mut right, sr);
        // L tap at 250ms = ~11025 samples
        let region = &left[10500..12000];
        let rms: f32 = (region.iter().map(|x| x * x).sum::<f32>() / region.len() as f32).sqrt();
        assert!(rms > 0.001, "Should have L echo: {rms}");
        assert!(left.iter().all(|x| x.is_finite()));
    }
}
