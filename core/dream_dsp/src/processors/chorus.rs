// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Chorus-Ensemble Processor (Enterprise)
// ═══════════════════════════════════════════════════════════════════════════
//
// 3-voice chorus ensemble with:
//   - Three independent delay lines with staggered LFO phases
//   - Feedback for flanger-like tones
//   - Configurable stereo spread
//   - High-pass filter on wet signal to preserve bass clarity
//
// Parameters:
//   0: Rate      (0.05–10 Hz, default 1.0)
//   1: Depth     (0–100%, default 50%)
//   2: Mix       (0–100%, default 50%)
//   3: Feedback  (-95 to 95%, default 0%)
//   4: Voices    (1–3, default 3)
//   5: Spread    (0–100%, default 80%) — stereo width of voices
//   6: HP Freq   (20–500 Hz, default 80) — high-pass on wet signal
//
// Real-Time Safety: Pre-allocated arrays. O(N × voices).
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::sanitize_sample_rate;
use crate::processors::smoothing::SmoothedValue;

const MAX_DELAY_SAMPLES: usize = 4096;
const DELAY_MASK: usize = MAX_DELAY_SAMPLES - 1;
const MAX_VOICES: usize = 3;

/// LFO phase offsets for 3 voices (evenly spaced).
const VOICE_PHASE_OFFSETS: [f64; MAX_VOICES] = [0.0, 0.333, 0.666];

/// Base delay per voice (staggered for richness).
const VOICE_BASE_DELAY_MS: [f32; MAX_VOICES] = [7.0, 9.0, 11.0];

/// Modulation depth per voice (varying for organic feel).
const VOICE_MOD_DEPTH_MS: [f32; MAX_VOICES] = [3.0, 2.5, 3.5];

pub struct ChorusProcessor {
    buf_l: [[f32; MAX_DELAY_SAMPLES]; MAX_VOICES],
    buf_r: [[f32; MAX_DELAY_SAMPLES]; MAX_VOICES],
    write_pos: usize,
    lfo_phase: f64,
    rate_hz: f32,
    depth: f32,
    mix: f32,
    feedback: f32,
    num_voices: usize,
    spread: f32,
    hp_freq: f32,
    // HP filter state (one-pole per channel)
    hp_state_l: f32,
    hp_state_r: f32,
    hp_prev_l: f32,
    hp_prev_r: f32,
    hp_coeff: f32,
    // Feedback state
    fb_l: [f32; MAX_VOICES],
    fb_r: [f32; MAX_VOICES],
    sample_rate: f32,
    rate_sm: SmoothedValue,
    depth_sm: SmoothedValue,
    mix_sm: SmoothedValue,
    feedback_sm: SmoothedValue,
}

impl ChorusProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sample_rate = crate::processors::sanitize_sample_rate(sample_rate);
        let mut proc = Self {
            buf_l: [[0.0; MAX_DELAY_SAMPLES]; MAX_VOICES],
            buf_r: [[0.0; MAX_DELAY_SAMPLES]; MAX_VOICES],
            write_pos: 0,
            lfo_phase: 0.0,
            rate_hz: 1.0,
            depth: 0.5,
            mix: 0.5,
            feedback: 0.0,
            num_voices: 3,
            spread: 0.8,
            hp_freq: 80.0,
            hp_state_l: 0.0,
            hp_state_r: 0.0,
            hp_prev_l: 0.0,
            hp_prev_r: 0.0,
            hp_coeff: 0.0,
            fb_l: [0.0; MAX_VOICES],
            fb_r: [0.0; MAX_VOICES],
            sample_rate,
            rate_sm: SmoothedValue::new(sample_rate, 8.0, 1.0),
            depth_sm: SmoothedValue::new(sample_rate, 8.0, 0.5),
            mix_sm: SmoothedValue::new(sample_rate, 8.0, 0.5),
            feedback_sm: SmoothedValue::new(sample_rate, 8.0, 0.0),
        };
        proc.update_hp();
        proc
    }

    fn update_hp(&mut self) {
        // Proper one-pole HP coefficient: alpha = 1 / (1 + 2*pi*fc/fs)
        let w = std::f32::consts::TAU * self.hp_freq / self.sample_rate;
        self.hp_coeff = 1.0 / (1.0 + w);
    }

    #[inline]
    fn sync_sample_rate(&mut self, sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.update_hp();
            self.rate_sm.set_sample_rate(sr);
            self.depth_sm.set_sample_rate(sr);
            self.mix_sm.set_sample_rate(sr);
            self.feedback_sm.set_sample_rate(sr);
        }
    }

    #[inline]
    fn read_delay(buf: &[f32; MAX_DELAY_SAMPLES], write_pos: usize, delay_samples: f32) -> f32 {
        let int_d = delay_samples as usize;
        let frac = delay_samples - int_d as f32;
        let i0 = (write_pos + MAX_DELAY_SAMPLES - int_d) & DELAY_MASK;
        let i1 = (write_pos + MAX_DELAY_SAMPLES - int_d - 1) & DELAY_MASK;
        buf[i0] * (1.0 - frac) + buf[i1] * frac
    }
}

impl DspProcessor for ChorusProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        self.sync_sample_rate(sample_rate);
        let len = left.len().min(right.len());
        let sr = self.sample_rate;
        let nv = self.num_voices.min(MAX_VOICES);
        let voice_gain = 1.0 / nv as f32;
        self.rate_sm.set_target(self.rate_hz);
        self.depth_sm.set_target(self.depth);
        self.mix_sm.set_target(self.mix);
        self.feedback_sm.set_target(self.feedback);

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let rate = self.rate_sm.next_value();
            let depth = self.depth_sm.next_value();
            let mix = self.mix_sm.next_value();
            let feedback = self.feedback_sm.next_value();
            let mut wet_l = 0.0f32;
            let mut wet_r = 0.0f32;

            for v in 0..nv {
                let base = VOICE_BASE_DELAY_MS[v] * 0.001 * sr;
                let mod_depth = VOICE_MOD_DEPTH_MS[v] * 0.001 * sr * depth;

                // Per-voice LFO with offset — SSOT fast sine approximation from mod.rs
                let phase_l = (self.lfo_phase + VOICE_PHASE_OFFSETS[v]) as f32;
                let phase_r = phase_l + 0.25 * self.spread;

                let lfo_l = crate::processors::fast_sin_phase(phase_l);
                let lfo_r = crate::processors::fast_sin_phase(phase_r);

                let delay_l = (base + lfo_l * mod_depth).clamp(1.0, (MAX_DELAY_SAMPLES - 2) as f32);
                let delay_r = (base + lfo_r * mod_depth).clamp(1.0, (MAX_DELAY_SAMPLES - 2) as f32);

                // Write with feedback
                self.buf_l[v][self.write_pos] = dry_l + self.fb_l[v] * feedback;
                self.buf_r[v][self.write_pos] = dry_r + self.fb_r[v] * feedback;

                let out_l = Self::read_delay(&self.buf_l[v], self.write_pos, delay_l);
                let out_r = Self::read_delay(&self.buf_r[v], self.write_pos, delay_r);

                self.fb_l[v] = out_l;
                self.fb_r[v] = out_r;

                // SSOT: Flush denormals in per-voice feedback states.
                crate::processors::flush_denormal!(self.fb_l[v]);
                crate::processors::flush_denormal!(self.fb_r[v]);

                // Pan voices for stereo spread
                let pan = if nv > 1 {
                    (v as f32 / (nv - 1).max(1) as f32 - 0.5) * 2.0 * self.spread
                } else {
                    0.0
                };
                let pan_l = (1.0 - pan.max(0.0)).min(1.0);
                let pan_r = (1.0 + pan.min(0.0)).min(1.0);

                wet_l += out_l * voice_gain * pan_l;
                wet_r += out_r * voice_gain * pan_r;
            }

            // HP filter on wet signal (preserve bass clarity)
            // Standard one-pole HP: y[n] = alpha * (y[n-1] + x[n] - x[n-1])
            self.hp_state_l =
                (self.hp_coeff * (self.hp_state_l + wet_l - self.hp_prev_l)).clamp(-8.0, 8.0);
            self.hp_state_r =
                (self.hp_coeff * (self.hp_state_r + wet_r - self.hp_prev_r)).clamp(-8.0, 8.0);
            self.hp_prev_l = wet_l;
            self.hp_prev_r = wet_r;
            // SSOT: Flush denormals in HP filter and prev states.
            crate::processors::flush_denormal!(self.hp_state_l);
            crate::processors::flush_denormal!(self.hp_state_r);
            // M03 FIX: hp_prev states can also go denormal from input.
            crate::processors::flush_denormal!(self.hp_prev_l);
            crate::processors::flush_denormal!(self.hp_prev_r);

            // Mix
            left[i] = (dry_l * (1.0 - mix) + self.hp_state_l * mix).clamp(-8.0, 8.0);
            right[i] = (dry_r * (1.0 - mix) + self.hp_state_r * mix).clamp(-8.0, 8.0);

            self.lfo_phase += rate as f64 / sr as f64;
            self.lfo_phase = self.lfo_phase.fract();
            self.write_pos = (self.write_pos + 1) & DELAY_MASK;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.rate_hz = value.clamp(0.05, 10.0),
            1 => self.depth = (value / 100.0).clamp(0.0, 1.0),
            2 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            3 => self.feedback = (value / 100.0).clamp(-0.95, 0.95),
            4 => self.num_voices = (value as usize).clamp(1, MAX_VOICES),
            5 => self.spread = (value / 100.0).clamp(0.0, 1.0),
            6 => {
                self.hp_freq = value.clamp(20.0, 500.0);
                self.update_hp();
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        for v in 0..MAX_VOICES {
            self.buf_l[v] = [0.0; MAX_DELAY_SAMPLES];
            self.buf_r[v] = [0.0; MAX_DELAY_SAMPLES];
            self.fb_l[v] = 0.0;
            self.fb_r[v] = 0.0;
        }
        self.write_pos = 0;
        self.lfo_phase = 0.0;
        self.hp_state_l = 0.0;
        self.hp_state_r = 0.0;
        self.hp_prev_l = 0.0;
        self.hp_prev_r = 0.0;
        self.rate_sm.set_instant(self.rate_hz);
        self.depth_sm.set_instant(self.depth);
        self.mix_sm.set_instant(self.mix);
        self.feedback_sm.set_instant(self.feedback);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chorus_processes_without_panic() {
        let mut proc = ChorusProcessor::new(44100.0);
        let mut left = vec![0.5f32; 512];
        let mut right = vec![0.5f32; 512];
        proc.process_stereo(&mut left, &mut right, 44100.0);
    }

    #[test]
    fn chorus_modulates_signal() {
        let mut proc = ChorusProcessor::new(44100.0);
        proc.set_param(0, 5.0);
        proc.set_param(1, 100.0);
        proc.set_param(2, 100.0);
        let mut left = vec![0.5f32; 4096];
        let mut right = vec![0.5f32; 4096];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        let diffs: f32 = left
            .iter()
            .zip(right.iter())
            .map(|(l, r)| (l - r).abs())
            .sum();
        assert!(diffs > 0.1, "Should create stereo difference: {diffs}");
    }

    #[test]
    fn chorus_single_voice() {
        let mut proc = ChorusProcessor::new(44100.0);
        proc.set_param(4, 1.0); // 1 voice
        let mut left = vec![0.3f32; 1024];
        let mut right = vec![0.3f32; 1024];
        proc.process_stereo(&mut left, &mut right, 44100.0);
    }
}
