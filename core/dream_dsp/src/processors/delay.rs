// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Stereo Delay Processor (Enterprise)
// ═══════════════════════════════════════════════════════════════════════════
//
// Professional stereo delay with:
//   - Independent L/R delay times
//   - Feedback with one-pole LP/HP filter in the loop (analog warmth)
//   - Ping-pong mode (alternates L→R→L)
//   - Subtle modulation on delay time (avoids metallic feedback)
//   - Dry/Wet mix with crossfeed control
//
// Parameters:
//   0: Time L      (1–2000 ms, default 250)
//   1: Time R      (1–2000 ms, default 375)
//   2: Feedback    (0–95%, default 30%)
//   3: Mix         (0–100%, default 30%)
//   4: Filter Freq (200–15000 Hz, default 5000) — LP filter in feedback
//   5: Ping-Pong   (0=off, 1=on, default 0)
//   6: Mod Rate    (0–5 Hz, default 0.5)
//   7: Mod Depth   (0–100%, default 10%)
//
// Real-Time Safety: Pre-allocated Vec buffers. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

const MAX_DELAY_SECONDS: f32 = 2.0;

/// Maximum sample rate we pre-allocate for — covers 192kHz studio setups.
/// Buffers are allocated once at this ceiling and never resized at runtime,
/// guaranteeing zero heap allocations on the audio thread.
const MAX_SAMPLE_RATE: f32 = 192_000.0;

pub struct DelayProcessor {
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    write_pos: usize,
    /// Logical buffer size for the current sample rate.
    /// Always <= physical Vec capacity (pre-allocated at MAX_SAMPLE_RATE).
    buf_size: usize,
    /// Physical allocation size — never changes after construction.
    buf_capacity: usize,
    sample_rate: f32,
    // Params
    time_l_ms: f32,
    time_r_ms: f32,
    delay_samples_l: f32,
    delay_samples_r: f32,
    feedback: f32,
    dry_wet: f32,
    filter_freq: f32,
    ping_pong: bool,
    mod_rate: f32,
    mod_depth: f32,
    // Feedback filter state (one-pole LP)
    fb_filter_l: f32,
    fb_filter_r: f32,
    fb_filter_coeff: f32,
    // Modulation LFO
    lfo_phase: f64,
    // Cross-feedback for ping-pong
    cross_fb_l: f32,
    cross_fb_r: f32,
}

impl DelayProcessor {
    pub fn new(sample_rate: f32) -> Self {
        // BUG-8 FIX: Pre-allocate at maximum possible size so we NEVER
        // resize on the audio thread. This covers SR up to 192kHz.
        let max_buf_size = (MAX_SAMPLE_RATE * MAX_DELAY_SECONDS) as usize + 1;
        let buf_size = (sample_rate * MAX_DELAY_SECONDS) as usize + 1;
        let mut proc = Self {
            buf_l: vec![0.0; max_buf_size],
            buf_r: vec![0.0; max_buf_size],
            write_pos: 0,
            buf_size,
            buf_capacity: max_buf_size,
            sample_rate,
            time_l_ms: 250.0,
            time_r_ms: 375.0,
            delay_samples_l: 250.0 * 0.001 * sample_rate,
            delay_samples_r: 375.0 * 0.001 * sample_rate,
            feedback: 0.30,
            dry_wet: 0.30,
            filter_freq: 5000.0,
            ping_pong: false,
            mod_rate: 0.5,
            mod_depth: 0.10,
            fb_filter_l: 0.0,
            fb_filter_r: 0.0,
            fb_filter_coeff: 0.0,
            lfo_phase: 0.0,
            cross_fb_l: 0.0,
            cross_fb_r: 0.0,
        };
        proc.update_filter();
        proc
    }

    fn update_filter(&mut self) {
        // Correct one-pole LP: α = 1 - e^(-2πfc/sr)
        let w = (-std::f32::consts::TAU * self.filter_freq / self.sample_rate).exp();
        self.fb_filter_coeff = (1.0 - w).clamp(0.001, 0.999);
    }

    fn update_delay_l(&mut self) {
        self.delay_samples_l =
            (self.time_l_ms * 0.001 * self.sample_rate).clamp(1.0, (self.buf_size - 2) as f32);
    }

    fn update_delay_r(&mut self) {
        self.delay_samples_r =
            (self.time_r_ms * 0.001 * self.sample_rate).clamp(1.0, (self.buf_size - 2) as f32);
    }

    #[inline]
    fn sync_sample_rate(&mut self, sample_rate: f32) {
        if sample_rate.is_finite()
            && sample_rate > 1000.0
            && (sample_rate - self.sample_rate).abs() > 0.5
        {
            self.sample_rate = sample_rate;
            // BUG-8 FIX: Update logical buf_size without resizing.
            // Physical allocation already covers up to MAX_SAMPLE_RATE.
            let required_size = ((sample_rate * MAX_DELAY_SECONDS) as usize + 1)
                .min(self.buf_capacity);
            self.buf_size = required_size;
            self.write_pos = self.write_pos % self.buf_size;
            self.update_filter();
            self.update_delay_l();
            self.update_delay_r();
        }
    }

    /// Read with linear interpolation for fractional delays.
    #[inline]
    fn read_interp(buf: &[f32], write_pos: usize, delay: f32, buf_size: usize) -> f32 {
        let int_d = delay as usize;
        let frac = delay - int_d as f32;
        let i0 = (write_pos + buf_size - int_d) % buf_size;
        let i1 = (write_pos + buf_size - int_d - 1) % buf_size;
        buf[i0] * (1.0 - frac) + buf[i1] * frac
    }
}

impl DspProcessor for DelayProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        self.sync_sample_rate(sample_rate);
        let len = left.len().min(right.len());
        let bs = self.buf_size;
        let fb = self.feedback;
        let wet = self.dry_wet;
        let dry = 1.0 - wet;
        let fc = self.fb_filter_coeff;
        let lfo_inc = self.mod_rate as f64 / self.sample_rate as f64;
        let mod_max = self.mod_depth * 20.0; // ±20 samples at full depth

        for i in 0..len {
            // LFO modulation
            let lfo = (self.lfo_phase as f32 * std::f32::consts::TAU).sin();
            self.lfo_phase += lfo_inc;
            if self.lfo_phase >= 1.0 {
                self.lfo_phase -= 1.0;
            }

            let mod_offset = lfo * mod_max;
            let dl = (self.delay_samples_l + mod_offset).clamp(1.0, (bs - 2) as f32);
            let dr = (self.delay_samples_r - mod_offset * 0.7).clamp(1.0, (bs - 2) as f32);

            // Read delayed signals
            let delayed_l = Self::read_interp(&self.buf_l, self.write_pos, dl, bs);
            let delayed_r = Self::read_interp(&self.buf_r, self.write_pos, dr, bs);

            let dry_l = left[i];
            let dry_r = right[i];

            // Feedback signals with LP filtering for analog warmth
            let fb_l_raw = if self.ping_pong {
                self.cross_fb_r
            } else {
                delayed_l
            };
            let fb_r_raw = if self.ping_pong {
                self.cross_fb_l
            } else {
                delayed_r
            };

            // One-pole LP in feedback loop
            self.fb_filter_l += fc * (fb_l_raw - self.fb_filter_l);
            self.fb_filter_r += fc * (fb_r_raw - self.fb_filter_r);

            // Write to buffer: input + filtered feedback
            self.buf_l[self.write_pos] = dry_l + self.fb_filter_l * fb;
            self.buf_r[self.write_pos] = dry_r + self.fb_filter_r * fb;

            // Store for ping-pong
            self.cross_fb_l = delayed_l;
            self.cross_fb_r = delayed_r;

            // Mix
            left[i] = dry_l * dry + delayed_l * wet;
            right[i] = dry_r * dry + delayed_r * wet;

            self.write_pos = (self.write_pos + 1) % bs;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => {
                self.time_l_ms = value.clamp(1.0, 2000.0);
                self.update_delay_l();
            }
            1 => {
                self.time_r_ms = value.clamp(1.0, 2000.0);
                self.update_delay_r();
            }
            2 => {
                self.feedback = (value / 100.0).clamp(0.0, 0.95);
            }
            3 => {
                self.dry_wet = (value / 100.0).clamp(0.0, 1.0);
            }
            4 => {
                self.filter_freq = value.clamp(200.0, 15000.0);
                self.update_filter();
            }
            5 => {
                self.ping_pong = value > 0.5;
            }
            6 => {
                self.mod_rate = value.clamp(0.0, 5.0);
            }
            7 => {
                self.mod_depth = (value / 100.0).clamp(0.0, 1.0);
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.buf_l.iter_mut().for_each(|s| *s = 0.0);
        self.buf_r.iter_mut().for_each(|s| *s = 0.0);
        self.write_pos = 0;
        self.fb_filter_l = 0.0;
        self.fb_filter_r = 0.0;
        self.lfo_phase = 0.0;
        self.cross_fb_l = 0.0;
        self.cross_fb_r = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delay_0_wet_passthrough() {
        let mut proc = DelayProcessor::new(44100.0);
        proc.set_param(3, 0.0);
        let input = vec![0.5f32; 256];
        let mut left = input.clone();
        let mut right = input.clone();
        proc.process_stereo(&mut left, &mut right, 44100.0);
        for (i, s) in left.iter().enumerate() {
            assert!((s - input[i]).abs() < 0.001, "Dry pass failed");
        }
    }

    #[test]
    fn delay_produces_echo() {
        let mut proc = DelayProcessor::new(44100.0);
        proc.set_param(0, 100.0);
        proc.set_param(1, 100.0);
        proc.set_param(2, 0.0);
        proc.set_param(3, 100.0);
        let delay_samples = (0.1 * 44100.0) as usize;
        let total = delay_samples + 100;
        let mut left = vec![0.0f32; total];
        let mut right = vec![0.0f32; total];
        left[0] = 1.0;
        right[0] = 1.0;
        proc.process_stereo(&mut left, &mut right, 44100.0);
        // With modulation, echo might be slightly offset; check a range
        let echo_region: f32 = left[delay_samples.saturating_sub(30)..delay_samples + 30]
            .iter()
            .map(|s| s.abs())
            .sum();
        assert!(echo_region > 0.3, "Echo not found in region");
    }

    #[test]
    fn delay_ping_pong() {
        let mut proc = DelayProcessor::new(44100.0);
        proc.set_param(0, 50.0);
        proc.set_param(1, 50.0);
        proc.set_param(2, 50.0);
        proc.set_param(3, 100.0);
        proc.set_param(5, 1.0); // ping-pong ON
        let mut left = vec![0.0f32; 8192];
        let mut right = vec![0.0f32; 8192];
        left[0] = 1.0;
        proc.process_stereo(&mut left, &mut right, 44100.0);
        // In ping-pong, right channel should receive echo from left
        let r_energy: f32 = right.iter().map(|s| s * s).sum();
        assert!(
            r_energy > 0.01,
            "Ping-pong should send to right: {r_energy}"
        );
    }
}
