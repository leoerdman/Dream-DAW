// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Flanger Processor (Enterprise)
// ═══════════════════════════════════════════════════════════════════════════
//
// Through-zero flanger with:
//   - Independent LFO shapes (Sine, Triangle, Saw, Random)
//   - Feedback with LP damping
//   - Stereo offset for wide imaging
//   - Manual offset for static flanging / comb effects
//   - Through-zero mode toggle
//
// Parameters:
//   0: Rate       (0.01–10 Hz, default 0.3)
//   1: Depth      (0–100%, default 50%)
//   2: Feedback   (-95 to 95%, default 40%)
//   3: Delay      (0.1–10 ms, default 2.0) — base delay
//   4: Mix        (0–100%, default 50%)
//   5: Stereo     (0–180°, default 90°) — L/R LFO phase offset
//   6: LFO Shape  (0–3, default 0)
//   7: FB Damp    (1000–20000 Hz, default 8000) — LP in feedback
//   8: TZ Mode    (0 or 1, default 0) — through-zero
//
// Real-Time Safety: Pre-allocated arrays. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

const MAX_DELAY_SAMPLES: usize = 2048;
const DELAY_MASK: usize = MAX_DELAY_SAMPLES - 1;

pub struct FlangerProcessor {
    rate: f32,
    depth: f32,
    feedback: f32,
    base_delay_ms: f32,
    mix: f32,
    stereo_offset: f32, // degrees → fraction
    lfo_shape: u8,
    fb_damp_freq: f32,
    tz_mode: bool,
    // Buffers
    buf_l: [f32; MAX_DELAY_SAMPLES],
    buf_r: [f32; MAX_DELAY_SAMPLES],
    write_pos: usize,
    // State
    lfo_phase: f64,
    fb_l: f32,
    fb_r: f32,
    // Damping filter state
    damp_state_l: f32,
    damp_state_r: f32,
    damp_coeff: f32,
    sample_rate: f32,
    // S&H state for Random LFO shape
    sh_value_l: f32,
    sh_value_r: f32,
    prev_phase_l: f32,
    prev_phase_r: f32,
    sh_rng: u64,
}

impl FlangerProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let mut proc = Self {
            rate: 0.3,
            depth: 0.5,
            feedback: 0.4,
            base_delay_ms: 2.0,
            mix: 0.5,
            stereo_offset: 0.25, // 90°
            lfo_shape: 0,
            fb_damp_freq: 8000.0,
            tz_mode: false,
            buf_l: [0.0; MAX_DELAY_SAMPLES],
            buf_r: [0.0; MAX_DELAY_SAMPLES],
            write_pos: 0,
            lfo_phase: 0.0,
            fb_l: 0.0,
            fb_r: 0.0,
            damp_state_l: 0.0,
            damp_state_r: 0.0,
            damp_coeff: 0.0,
            sample_rate,
            sh_value_l: 0.0,
            sh_value_r: 0.0,
            prev_phase_l: 0.0,
            prev_phase_r: 0.0,
            sh_rng: 0xDEAD_BEEF_CAFE_1234,
        };
        proc.update_damp();
        proc
    }

    fn update_damp(&mut self) {
        // Exact one-pole LP: α = 1 - e^(-2πfc/sr)
        self.damp_coeff = (1.0 - (-std::f32::consts::TAU * self.fb_damp_freq / self.sample_rate).exp()).clamp(0.0, 1.0);
    }

    /// Advance S&H RNG and return value in [-1, 1]
    #[inline]
    fn next_sh_random(&mut self) -> f32 {
        let mut x = self.sh_rng;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.sh_rng = x;
        (x as i64 as f64 / i64::MAX as f64) as f32
    }

    #[inline]
    fn lfo(&self, phase: f32, shape: u8, sh_value: f32) -> f32 {
        match shape {
            0 | _ => {
                let p = phase.fract();
                let (t, sign) = if p < 0.5 {
                    (p * 2.0, 1.0f32)
                } else {
                    ((p - 0.5) * 2.0, -1.0)
                };
                let t2 = t * (1.0 - t);
                sign * (16.0 * t2) / (5.0 - 4.0 * t2)
            }
            1 => 1.0 - 4.0 * (phase - 0.5).abs(),
            2 => 2.0 * phase - 1.0,
            3 => sh_value,
        }
    }

    #[inline]
    fn read_interp(buf: &[f32; MAX_DELAY_SAMPLES], write_pos: usize, delay: f32) -> f32 {
        let int_d = delay as usize;
        let frac = delay - int_d as f32;
        let i0 = (write_pos + MAX_DELAY_SAMPLES - int_d) & DELAY_MASK;
        let i1 = (write_pos + MAX_DELAY_SAMPLES - int_d - 1) & DELAY_MASK;
        buf[i0] * (1.0 - frac) + buf[i1] * frac
    }
}

impl DspProcessor for FlangerProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        // Sync sample rate
        if sample_rate.is_finite()
            && sample_rate > 1000.0
            && (sample_rate - self.sample_rate).abs() > 0.5
        {
            self.sample_rate = sample_rate;
            self.update_damp();
        }
        let len = left.len().min(right.len());
        let sr = self.sample_rate;
        let lfo_inc = self.rate as f64 / sr as f64;
        let base = self.base_delay_ms * 0.001 * sr;
        let mod_depth = base * self.depth;
        let dc = self.damp_coeff;

        for i in 0..len {
            let phase_l = (self.lfo_phase as f32).fract();
            let phase_r = (self.lfo_phase as f32 + self.stereo_offset).fract();

            // BUG-DSP5 FIX: Advance S&H independently based on phase wrap
            if phase_l < self.prev_phase_l {
                self.sh_value_l = self.next_sh_random();
            }
            if phase_r < self.prev_phase_r {
                self.sh_value_r = self.next_sh_random();
            }
            self.prev_phase_l = phase_l;
            self.prev_phase_r = phase_r;

            let lfo_l = self.lfo(phase_l, self.lfo_shape, self.sh_value_l);
            let lfo_r = self.lfo(phase_r, self.lfo_shape, self.sh_value_r);

            // Modulated delay
            // BUG-027 FIX: Clamp TZ mode to minimum 1.0 sample (was 0.1).
            // Sub-sample delays cause read_interp to read from ~write_pos,
            // producing harsh metallic self-oscillation artifacts.
            let delay_l = if self.tz_mode {
                (base + lfo_l * (base * self.depth)).clamp(1.0, (MAX_DELAY_SAMPLES - 2) as f32)
            } else {
                (base + lfo_l * mod_depth).clamp(1.0, (MAX_DELAY_SAMPLES - 2) as f32)
            };
            let delay_r = if self.tz_mode {
                (base + lfo_r * (base * self.depth)).clamp(1.0, (MAX_DELAY_SAMPLES - 2) as f32)
            } else {
                (base + lfo_r * mod_depth).clamp(1.0, (MAX_DELAY_SAMPLES - 2) as f32)
            };

            let dry_l = left[i];
            let dry_r = right[i];

            // Write with damped feedback
            self.damp_state_l += dc * (self.fb_l - self.damp_state_l);
            self.damp_state_r += dc * (self.fb_r - self.damp_state_r);
            // BUG-AUD-102 FIX: Flush denormals in feedback damping filter to
            // prevent 50-100x CPU slowdown on x86 CPUs during quiet passages.
            if self.damp_state_l.abs() < 1.0e-20 {
                self.damp_state_l = 0.0;
            }
            if self.damp_state_r.abs() < 1.0e-20 {
                self.damp_state_r = 0.0;
            }
            self.buf_l[self.write_pos] = dry_l + self.damp_state_l * self.feedback;
            self.buf_r[self.write_pos] = dry_r + self.damp_state_r * self.feedback;

            // Read
            let wet_l = Self::read_interp(&self.buf_l, self.write_pos, delay_l);
            let wet_r = Self::read_interp(&self.buf_r, self.write_pos, delay_r);

            self.fb_l = wet_l;
            self.fb_r = wet_r;

            left[i] = dry_l * (1.0 - self.mix) + wet_l * self.mix;
            right[i] = dry_r * (1.0 - self.mix) + wet_r * self.mix;

            self.lfo_phase += lfo_inc;
            self.lfo_phase = self.lfo_phase.fract();
            self.write_pos = (self.write_pos + 1) & DELAY_MASK;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => {
                self.rate = value.clamp(0.01, 10.0);
            }
            1 => self.depth = (value / 100.0).clamp(0.0, 1.0),
            2 => self.feedback = (value / 100.0).clamp(-0.95, 0.95),
            3 => self.base_delay_ms = value.clamp(0.1, 10.0),
            4 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            5 => self.stereo_offset = value.clamp(0.0, 180.0) / 360.0,
            6 => self.lfo_shape = (value as u8).min(3),
            7 => {
                self.fb_damp_freq = value.clamp(1000.0, 20000.0);
                self.update_damp();
            }
            8 => self.tz_mode = value > 0.5,
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.buf_l = [0.0; MAX_DELAY_SAMPLES];
        self.buf_r = [0.0; MAX_DELAY_SAMPLES];
        self.write_pos = 0;
        self.lfo_phase = 0.0;
        self.fb_l = 0.0;
        self.fb_r = 0.0;
        self.damp_state_l = 0.0;
        self.damp_state_r = 0.0;
        self.sh_value_l = 0.0;
        self.sh_value_r = 0.0;
        self.prev_phase_l = 0.0;
        self.prev_phase_r = 0.0;
        self.sh_rng = 0xDEAD_BEEF_CAFE_1234;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flanger_processes_without_panic() {
        let mut proc = FlangerProcessor::new(44100.0);
        let mut l = vec![0.5f32; 512];
        let mut r = vec![0.5f32; 512];
        proc.process_stereo(&mut l, &mut r, 44100.0);
    }

    #[test]
    fn flanger_modifies_signal() {
        let mut proc = FlangerProcessor::new(44100.0);
        proc.set_param(0, 2.0);
        proc.set_param(1, 100.0);
        proc.set_param(4, 100.0);
        let sr = 44100.0;
        let mut l: Vec<f32> = (0..4096)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sr).sin() * 0.5)
            .collect();
        let orig = l.clone();
        let mut r = l.clone();
        proc.process_stereo(&mut l, &mut r, sr);
        let diff: f32 = l.iter().zip(orig.iter()).map(|(a, b)| (a - b).abs()).sum();
        assert!(diff > 1.0, "Flanger should modify: {diff}");
    }
}
