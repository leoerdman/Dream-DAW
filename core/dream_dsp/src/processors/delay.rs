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
use crate::processors::sanitize_sample_rate;
use crate::processors::smoothing::SmoothedValue;

const MAX_DELAY_SECONDS: f32 = 2.0;

/// Maximum sample rate we pre-allocate for — covers 192kHz studio setups.
/// Buffers are allocated once at this ceiling and never resized at runtime,
/// guaranteeing zero heap allocations on the audio thread.
/// NOTE: 192kHz is the highest rate used by professional audio interfaces
/// (e.g., RME UFX+, Lynx Hilo). Pre-allocating for 384kHz wastes ~1.5MB
/// per delay instance with zero practical benefit.
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
    // Subtle high-pass in feedback loop to prevent low-end buildup.
    fb_hp_state_l: f32,
    fb_hp_state_r: f32,
    fb_hp_prev_l: f32,
    fb_hp_prev_r: f32,
    fb_hp_coeff: f32,
    // Sync
    bpm: f32,
    sync_l: bool,
    sync_r: bool,
    note_l: u8,
    note_r: u8,
    // Modulation LFO
    lfo_phase: f64,
    // Cross-feedback for ping-pong
    cross_fb_l: f32,
    cross_fb_r: f32,
    // Smoothed runtime params (anti-zipper)
    feedback_sm: SmoothedValue,
    dry_wet_sm: SmoothedValue,
    delay_l_sm: SmoothedValue,
    delay_r_sm: SmoothedValue,
}

impl DelayProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sample_rate = crate::processors::sanitize_sample_rate(sample_rate);
        // BUG-8 FIX: Pre-allocate at maximum possible size so we NEVER
        // resize on the audio thread. This covers SR up to 192kHz.
        // BUG-033 FIX: Round to next power-of-2 for bitwise AND masking in read_interp.
        let max_buf_size = ((MAX_SAMPLE_RATE * MAX_DELAY_SECONDS) as usize + 1).next_power_of_two();
        let buf_size = ((sample_rate * MAX_DELAY_SECONDS) as usize + 1).next_power_of_two();
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
            filter_freq: 22000.0,
            ping_pong: false,
            mod_rate: 0.5,
            mod_depth: 0.10,
            fb_filter_l: 0.0,
            fb_filter_r: 0.0,
            fb_filter_coeff: 0.0,
            fb_hp_state_l: 0.0,
            fb_hp_state_r: 0.0,
            fb_hp_prev_l: 0.0,
            fb_hp_prev_r: 0.0,
            fb_hp_coeff: 0.0,
            bpm: 120.0,
            sync_l: false,
            sync_r: false,
            note_l: 5, // 1/8 note
            note_r: 6, // 1/8D note
            lfo_phase: 0.0,
            cross_fb_l: 0.0,
            cross_fb_r: 0.0,
            feedback_sm: SmoothedValue::new(sample_rate, 8.0, 0.30),
            dry_wet_sm: SmoothedValue::new(sample_rate, 8.0, 0.30),
            delay_l_sm: SmoothedValue::new(sample_rate, 12.0, 250.0 * 0.001 * sample_rate),
            delay_r_sm: SmoothedValue::new(sample_rate, 12.0, 375.0 * 0.001 * sample_rate),
        };
        proc.update_filter();
        proc
    }

    fn update_filter(&mut self) {
        // Correct one-pole LP: α = 1 - e^(-2πfc/sr)
        let w = (-std::f32::consts::TAU * self.filter_freq / self.sample_rate).exp();
        self.fb_filter_coeff = (1.0 - w).clamp(0.001, 0.999);
        // Fixed gentle HP (~35 Hz) in feedback path.
        let hp_w = std::f32::consts::TAU * 35.0 / self.sample_rate.max(1.0);
        self.fb_hp_coeff = 1.0 / (1.0 + hp_w);
    }

    fn update_delay_l(&mut self) {
        let ms = if self.sync_l && self.bpm > 0.1 {
            let frac = note_to_fraction(self.note_l);
            let beats = frac * 4.0;
            let minutes = beats / self.bpm;
            minutes * 60_000.0
        } else {
            self.time_l_ms
        };
        self.delay_samples_l =
            (ms * 0.001 * self.sample_rate).clamp(1.0, (self.buf_size - 2) as f32);
    }

    fn update_delay_r(&mut self) {
        let ms = if self.sync_r && self.bpm > 0.1 {
            let frac = note_to_fraction(self.note_r);
            let beats = frac * 4.0;
            let minutes = beats / self.bpm;
            minutes * 60_000.0
        } else {
            self.time_r_ms
        };
        self.delay_samples_r =
            (ms * 0.001 * self.sample_rate).clamp(1.0, (self.buf_size - 2) as f32);
    }

    #[inline]
    fn sync_sample_rate(&mut self, sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            // BUG-8 + BUG-033 FIX: Update logical buf_size (power-of-2) without resizing.
            let required_size = ((sr * MAX_DELAY_SECONDS) as usize + 1)
                .next_power_of_two()
                .min(self.buf_capacity);
            
            if required_size > self.buf_size {
                self.buf_l[self.buf_size..required_size].fill(0.0);
                self.buf_r[self.buf_size..required_size].fill(0.0);
            }
            
            self.buf_size = required_size;
            self.write_pos &= self.buf_size - 1;
            self.update_filter();
            self.update_delay_l();
            self.update_delay_r();
            self.feedback_sm.set_sample_rate(sr);
            self.dry_wet_sm.set_sample_rate(sr);
            self.delay_l_sm.set_sample_rate(sr);
            self.delay_r_sm.set_sample_rate(sr);
            // BUG-079 FIX: Reset cross-feedback on SR change.
            // Stale values from old SR cause brief garbage in ping-pong mode.
            self.cross_fb_l = 0.0;
            self.cross_fb_r = 0.0;
        }
    }

    /// Read with 4-point Hermite interpolation for fractional delays.
    /// BUG-001 FIX: Upgraded from linear to 3rd-order Hermite interpolation.
    /// Prevents high-frequency smearing and harmonic distortion during
    /// LFO modulation (chorus/flanger modes).
    /// Uses bitwise AND instead of modulo for ring buffer indices.
    #[inline]
    fn read_interp(buf: &[f32], write_pos: usize, delay: f32, buf_size: usize) -> f32 {
        // Need +2 margin for Hermite (up to int_d + 2)
        let max_delay = (buf_size.saturating_sub(3)) as f32;
        let safe_delay = if delay.is_finite() {
            delay.clamp(1.0, max_delay)
        } else {
            1.0
        };
        let int_d = safe_delay.floor() as usize;
        let frac = safe_delay - int_d as f32;
        let mask = buf_size - 1; // buf_size is always power-of-2 aligned
        
        let im1 = (write_pos + buf_size - int_d + 1) & mask;
        let i0 = (write_pos + buf_size - int_d) & mask;
        let i1 = (write_pos + buf_size - int_d - 1) & mask;
        let i2 = (write_pos + buf_size - int_d - 2) & mask;
        
        crate::processors::hermite_interp(buf[im1], buf[i0], buf[i1], buf[i2], frac)
    }
}

fn note_to_fraction(val: u8) -> f32 {
    match val {
        0 => 1.0 / 32.0,
        1 => 1.0 / 16.0 * (2.0 / 3.0), // 1/16T
        2 => 1.0 / 16.0,               // 1/16
        3 => 1.0 / 16.0 * 1.5,         // 1/16D
        4 => 1.0 / 8.0 * (2.0 / 3.0),  // 1/8T
        5 => 1.0 / 8.0,                // 1/8
        6 => 1.0 / 8.0 * 1.5,          // 1/8D
        7 => 1.0 / 4.0 * (2.0 / 3.0),  // 1/4T
        8 => 1.0 / 4.0,                // 1/4
        9 => 1.0 / 4.0 * 1.5,          // 1/4D
        10 => 1.0 / 2.0 * (2.0 / 3.0), // 1/2T
        11 => 1.0 / 2.0,               // 1/2
        12 => 1.0 / 2.0 * 1.5,         // 1/2D
        13 => 1.0,                     // 1/1
        _ => 1.0 / 4.0,
    }
}

impl DspProcessor for DelayProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        self.sync_sample_rate(sample_rate);
        let len = left.len().min(right.len());
        let bs = self.buf_size;
        let fc = self.fb_filter_coeff;
        let hp_c = self.fb_hp_coeff;
        let lfo_inc = self.mod_rate as f64 / self.sample_rate as f64;

        // Keep smoother targets synced with latest parameter values.
        self.feedback_sm.set_target(self.feedback);
        self.dry_wet_sm.set_target(self.dry_wet);
        self.delay_l_sm.set_target(self.delay_samples_l);
        self.delay_r_sm.set_target(self.delay_samples_r);

        for i in 0..len {
            let fb = self.feedback_sm.next_value();
            let wet = self.dry_wet_sm.next_value();
            let dry = 1.0 - wet;

            // SSOT: Fast sine LFO from mod.rs.
            // BUG-061 FIX: Keep phase in f64 for precision over long sessions.
            // Only downcast to f32 for the sine approximation call.
            let lfo = crate::processors::fast_sin_phase(self.lfo_phase as f32);
            self.lfo_phase = (self.lfo_phase + lfo_inc).fract();

            // BUG-021 FIX: Clamp mod_max to half the base delay to prevent collapse.
            // Previously, at 100% depth with short delay (e.g., 10 samples),
            // mod_offset = ±20 could push delay below 1.0, killing the effect.
            let mod_max_raw = self.mod_depth * 20.0;
            let mod_offset = lfo * mod_max_raw;
            let base_dl = self.delay_l_sm.next_value();
            let base_dr = self.delay_r_sm.next_value();
            let safe_mod_l = mod_offset.clamp(-(base_dl * 0.5), base_dl * 0.5);
            let safe_mod_r = (-mod_offset).clamp(-(base_dr * 0.5), base_dr * 0.5);
            let dl = (base_dl + safe_mod_l).clamp(1.0, (bs - 2) as f32);
            // BUG-029 FIX: Symmetric modulation — removed 0.7 factor that caused
            // permanent pitch imbalance between L/R during modulation.
            let dr = (base_dr + safe_mod_r).clamp(1.0, (bs - 2) as f32);

            // Read delayed signals
            let delayed_l = Self::read_interp(&self.buf_l, self.write_pos, dl, bs);
            let delayed_r = Self::read_interp(&self.buf_r, self.write_pos, dr, bs);

            let dry_l = left[i];
            let dry_r = right[i];

            // Feedback signals with LP filtering for analog warmth
            let fb_l_raw = if self.ping_pong {
                self.cross_fb_l
            } else {
                delayed_l
            };
            let fb_r_raw = if self.ping_pong {
                self.cross_fb_r
            } else {
                delayed_r
            };

            // Store read outputs for Ping-Pong crossfeed on the NEXT sample
            self.cross_fb_l = delayed_r;
            self.cross_fb_r = delayed_l;

            // Apply One-Pole Low-Pass filter to feedback
            self.fb_filter_l += fc * (fb_l_raw - self.fb_filter_l);
            self.fb_filter_r += fc * (fb_r_raw - self.fb_filter_r);
            crate::processors::flush_denormal!(self.fb_filter_l);
            crate::processors::flush_denormal!(self.fb_filter_r);

            // Apply fixed ~35Hz High-Pass to prevent low-end mud buildup
            self.fb_hp_state_l = hp_c * (self.fb_hp_state_l + self.fb_filter_l - self.fb_hp_prev_l);
            self.fb_hp_state_r = hp_c * (self.fb_hp_state_r + self.fb_filter_r - self.fb_hp_prev_r);
            self.fb_hp_prev_l = self.fb_filter_l;
            self.fb_hp_prev_r = self.fb_filter_r;
            crate::processors::flush_denormal!(self.fb_hp_state_l);
            crate::processors::flush_denormal!(self.fb_hp_state_r);
            crate::processors::flush_denormal!(self.fb_hp_prev_l);
            crate::processors::flush_denormal!(self.fb_hp_prev_r);

            // Mix input + filtered feedback into the delay lines
            // BUG-004 FIX: Feedback clamped to 0.98 to prevent infinite explosion.
            let fb_clean = fb.clamp(0.0, 0.98);
            let in_l = dry_l + self.fb_hp_state_l * fb_clean;
            let in_r = dry_r + self.fb_hp_state_r * fb_clean;

            self.buf_l[self.write_pos] = in_l;
            self.buf_r[self.write_pos] = in_r;

            // Compute Wet Output
            let wet_l = delayed_l;
            let wet_r = delayed_r;

            left[i] = dry_l * dry + wet_l * wet;
            right[i] = dry_r * dry + wet_r * wet;

            self.write_pos = (self.write_pos + 1) & (bs - 1);
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        // Delay L/R are smoothed! Only trigger update if this parameter is what sets it.
        // The DspProcessor trait sets the underlying param to value.
        match index {
            0 => {
                self.time_l_ms = value.clamp(1.0, 2000.0);
                if !self.sync_l { self.update_delay_l(); }
            }
            1 => {
                self.time_r_ms = value.clamp(1.0, 2000.0);
                if !self.sync_r { self.update_delay_r(); }
            }
            2 => {
                self.feedback = (value / 100.0).clamp(0.0, 0.95);
            }
            3 => {
                self.dry_wet = (value / 100.0).clamp(0.0, 1.0);
                // Preserve deterministic pure-dry / pure-wet behavior.
                if self.dry_wet <= 0.0001 || self.dry_wet >= 0.9999 {
                    self.dry_wet_sm.set_instant(self.dry_wet);
                }
            }
            4 => {
                self.filter_freq = value.clamp(200.0, 22000.0);
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
            8 => {
                self.sync_l = value > 0.5;
                self.update_delay_l();
            }
            9 => {
                self.sync_r = value > 0.5;
                self.update_delay_r();
            }
            10 => {
                self.note_l = value as u8;
                self.update_delay_l();
            }
            11 => {
                self.note_r = value as u8;
                self.update_delay_r();
            }
            _ => {}
        }
    }

    fn set_transport(&mut self, bpm: f32, _is_playing: bool) {
        // If BPM changed, update sync times
        if (self.bpm - bpm).abs() > 0.001 {
            self.bpm = bpm;
            if self.sync_l { self.update_delay_l(); }
            if self.sync_r { self.update_delay_r(); }
        }
    }

    fn reset(&mut self) {
        let bs = self.buf_size;
        self.buf_l[..bs].fill(0.0);
        self.buf_r[..bs].fill(0.0);
        self.write_pos = 0;
        self.fb_filter_l = 0.0;
        self.fb_filter_r = 0.0;
        self.fb_hp_state_l = 0.0;
        self.fb_hp_state_r = 0.0;
        self.fb_hp_prev_l = 0.0;
        self.fb_hp_prev_r = 0.0;
        self.lfo_phase = 0.0;
        self.cross_fb_l = 0.0;
        self.cross_fb_r = 0.0;
        self.feedback_sm.set_instant(self.feedback);
        self.dry_wet_sm.set_instant(self.dry_wet);
        self.delay_l_sm.set_instant(self.delay_samples_l);
        self.delay_r_sm.set_instant(self.delay_samples_r);
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
    fn delay_feedback_tail() {
        let mut proc = DelayProcessor::new(44100.0);
        proc.set_param(0, 100.0); // 100ms L
        proc.set_param(1, 100.0); // 100ms R
        proc.set_param(2, 50.0); // 50% FB
        proc.set_param(3, 100.0); // 100% Wet
        proc.set_param(4, 15000.0); // Filter frequency Max
        
        // Process many blocks
        let mut left = vec![0.0f32; 88200];
        let mut right = vec![0.0f32; 88200];
        left[0] = 1.0; 
        right[0] = 1.0;
        
        proc.process_stereo(&mut left, &mut right, 44100.0);
        
        // We expect echoes at roughly sample indices: 4410, 8820, 13230...
        // Let's sum the energy of the tail
        let energy: f32 = left[4000..88000].iter().map(|s| s.abs()).sum();
        println!("Tail energy: {}", energy);
        assert!(energy > 1.0, "Tail has no energy! Energy: {}", energy);
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
        proc.set_param(0, 50.0); // 50ms left
        proc.set_param(1, 100.0); // 100ms right
        proc.set_param(2, 50.0); // feedback
        proc.set_param(3, 100.0); // mix
        proc.set_param(5, 1.0); // ping-pong ON
        
        // 1 second of audio
        let total = 44100;
        let mut left = vec![0.0f32; total];
        let mut right = vec![0.0f32; total];
        
        // Impulse on the LEFT channel ONLY
        left[0] = 1.0;
        
        proc.process_stereo(&mut left, &mut right, 44100.0);
        
        // In ping-pong, energy from the left channel should eventually cross over to the right channel
        // Since delay is 50ms on left, and 100ms on right, it takes ~150ms for the first right-channel ping.
        let r_energy: f32 = right.iter().map(|s| s * s).sum();
        assert!(
            r_energy > 0.0001,
            "Ping-pong should send to right: {r_energy}"
        );
    }
}
