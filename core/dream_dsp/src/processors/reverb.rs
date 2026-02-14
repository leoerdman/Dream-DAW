// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Reverb Processor (Enterprise)
// ═══════════════════════════════════════════════════════════════════════════
//
// Freeverb-based algorithmic reverb with enterprise extensions:
//   - Pre-delay (0–200ms)
//   - Damping with LP/HP filtering (low & high damp)
//   - Internal modulation for lush tails
//   - Stereo width control
//   - Freeze mode (infinite sustain)
//   - 8 parallel comb + 4 serial allpass (Schroeder topology)
//
// Parameters:
//   0: Size       (0–100%, default 50%) — room size / decay
//   1: Damping    (0–100%, default 40%) — HF damping in feedback
//   2: Mix        (0–100%, default 30%)
//   3: Pre-delay  (0–200ms, default 10ms)
//   4: Width      (0–100%, default 100%) — stereo width
//   5: Low Damp   (0–100%, default 20%) — LF damping
//   6: Mod Rate   (0–3 Hz, default 0.3) — internal modulation
//   7: Mod Depth  (0–100%, default 15%)
//   8: Freeze     (0 or 1, default 0) — infinite sustain
//
// Real-Time Safety: Pre-allocated. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

// ── Comb Filter ─────────────────────────────────────────────────────────

struct CombFilter {
    buffer: Vec<f32>,
    buf_size: usize,
    index: usize,
    filter_store: f32,
    feedback: f32,
    damp1: f32,
    damp2: f32,
}

impl CombFilter {
    fn new(size: usize) -> Self {
        Self {
            buffer: vec![0.0; size],
            buf_size: size,
            index: 0,
            filter_store: 0.0,
            feedback: 0.5,
            damp1: 0.4,
            damp2: 0.6,
        }
    }

    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        let output = self.buffer[self.index];
        self.filter_store = output * self.damp2 + self.filter_store * self.damp1;
        self.buffer[self.index] = input + self.filter_store * self.feedback;
        self.index = (self.index + 1) % self.buf_size;
        output
    }

    fn set_damp(&mut self, val: f32) {
        self.damp1 = val;
        self.damp2 = 1.0 - val;
    }

    fn set_feedback(&mut self, val: f32) {
        self.feedback = val;
    }

    fn reset(&mut self) {
        self.buffer.iter_mut().for_each(|s| *s = 0.0);
        self.filter_store = 0.0;
    }
}

// ── Allpass Filter ──────────────────────────────────────────────────────

struct AllpassFilter {
    buffer: Vec<f32>,
    buf_size: usize,
    index: usize,
}

impl AllpassFilter {
    fn new(size: usize) -> Self {
        Self {
            buffer: vec![0.0; size],
            buf_size: size,
            index: 0,
        }
    }

    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        let buf_out = self.buffer[self.index];
        let output = -input + buf_out;
        self.buffer[self.index] = input + buf_out * 0.5;
        self.index = (self.index + 1) % self.buf_size;
        output
    }

    fn reset(&mut self) {
        self.buffer.iter_mut().for_each(|s| *s = 0.0);
    }
}

// ── Freeverb Tuning ─────────────────────────────────────────────────────

const COMB_SIZES_L: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const COMB_SPREAD: usize = 23;
const AP_SIZES: [usize; 4] = [556, 441, 341, 225];
const REF_SAMPLE_RATE: f32 = 44100.0;

// ── Pre-delay buffer ────────────────────────────────────────────────────
const MAX_PREDELAY_SAMPLES: usize = 9600; // ~200ms @ 48kHz

pub struct ReverbProcessor {
    combs_l: Vec<CombFilter>,
    combs_r: Vec<CombFilter>,
    allpasses_l: Vec<AllpassFilter>,
    allpasses_r: Vec<AllpassFilter>,
    // Pre-delay
    predelay_buf_l: [f32; MAX_PREDELAY_SAMPLES],
    predelay_buf_r: [f32; MAX_PREDELAY_SAMPLES],
    predelay_pos: usize,
    predelay_samples: usize,
    // Parameters
    room_size: f32,
    damping: f32,
    mix: f32,
    width: f32,
    low_damp: f32,
    mod_rate: f32,
    mod_depth: f32,
    freeze: bool,
    predelay_ms: f32,
    // Modulation LFO
    lfo_phase: f64,
    // Low-damp filter state
    low_cut_l: f32,
    low_cut_r: f32,
    sample_rate: f32,
}

impl ReverbProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let ratio = sample_rate / REF_SAMPLE_RATE;
        let scale = |s: usize| ((s as f32 * ratio) as usize).max(1);

        let combs_l: Vec<CombFilter> = COMB_SIZES_L.iter().map(|&s| CombFilter::new(scale(s))).collect();
        let combs_r: Vec<CombFilter> = COMB_SIZES_L.iter().map(|&s| CombFilter::new(scale(s + COMB_SPREAD))).collect();
        let allpasses_l: Vec<AllpassFilter> = AP_SIZES.iter().map(|&s| AllpassFilter::new(scale(s))).collect();
        let allpasses_r: Vec<AllpassFilter> = AP_SIZES.iter().map(|&s| AllpassFilter::new(scale(s + COMB_SPREAD))).collect();

        let mut proc = Self {
            combs_l,
            combs_r,
            allpasses_l,
            allpasses_r,
            predelay_buf_l: [0.0; MAX_PREDELAY_SAMPLES],
            predelay_buf_r: [0.0; MAX_PREDELAY_SAMPLES],
            predelay_pos: 0,
            predelay_samples: 0,
            room_size: 0.5,
            damping: 0.4,
            mix: 0.3,
            width: 1.0,
            low_damp: 0.2,
            mod_rate: 0.3,
            mod_depth: 0.15,
            freeze: false,
            predelay_ms: 10.0,
            lfo_phase: 0.0,
            low_cut_l: 0.0,
            low_cut_r: 0.0,
            sample_rate,
        };
        proc.update_combs();
        proc.update_predelay();
        proc
    }

    fn update_combs(&mut self) {
        let fb = if self.freeze { 1.0 } else { 0.28 + self.room_size * 0.70 };
        let damp = if self.freeze { 0.0 } else { self.damping };
        for c in &mut self.combs_l { c.set_feedback(fb); c.set_damp(damp); }
        for c in &mut self.combs_r { c.set_feedback(fb); c.set_damp(damp); }
    }

    fn update_predelay(&mut self) {
        self.predelay_samples = ((self.predelay_ms * 0.001 * self.sample_rate) as usize)
            .min(MAX_PREDELAY_SAMPLES - 1);
    }
}

impl DspProcessor for ReverbProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], _sample_rate: f32) {
        let len = left.len().min(right.len());
        let wet = self.mix;
        let dry = 1.0 - wet;
        let wet1 = wet * (1.0 + self.width) * 0.5;
        let wet2 = wet * (1.0 - self.width) * 0.5;
        let lfo_inc = self.mod_rate as f64 / self.sample_rate as f64;
        let low_damp_coeff = self.low_damp * 0.5;

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];

            // Pre-delay
            let pd_pos = self.predelay_pos;
            let pd_read = (pd_pos + MAX_PREDELAY_SAMPLES - self.predelay_samples) % MAX_PREDELAY_SAMPLES;
            let pd_l = self.predelay_buf_l[pd_read];
            let pd_r = self.predelay_buf_r[pd_read];
            self.predelay_buf_l[pd_pos] = dry_l;
            self.predelay_buf_r[pd_pos] = dry_r;
            self.predelay_pos = (pd_pos + 1) % MAX_PREDELAY_SAMPLES;

            let input = (pd_l + pd_r) * 0.5;

            // LFO for subtle modulation
            let lfo = (self.lfo_phase as f32 * std::f32::consts::TAU).sin() * self.mod_depth * 0.002;
            self.lfo_phase += lfo_inc;
            if self.lfo_phase >= 1.0 { self.lfo_phase -= 1.0; }

            let input_mod = input * (1.0 + lfo);

            // Parallel comb filters
            let mut out_l = 0.0f32;
            let mut out_r = 0.0f32;
            for c in &mut self.combs_l {
                out_l += c.process(input_mod);
            }
            for c in &mut self.combs_r {
                out_r += c.process(input_mod);
            }

            // Serial allpass filters
            for ap in &mut self.allpasses_l {
                out_l = ap.process(out_l);
            }
            for ap in &mut self.allpasses_r {
                out_r = ap.process(out_r);
            }

            // Low-frequency damping (HP filter in the reverb tail)
            self.low_cut_l += low_damp_coeff * (out_l - self.low_cut_l);
            self.low_cut_r += low_damp_coeff * (out_r - self.low_cut_r);
            out_l -= self.low_cut_l;
            out_r -= self.low_cut_r;

            // Width + mix
            left[i] = dry_l * dry + out_l * wet1 + out_r * wet2;
            right[i] = dry_r * dry + out_r * wet1 + out_l * wet2;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => { self.room_size = (value / 100.0).clamp(0.0, 1.0); self.update_combs(); }
            1 => { self.damping = (value / 100.0).clamp(0.0, 1.0); self.update_combs(); }
            2 => { self.mix = (value / 100.0).clamp(0.0, 1.0); }
            3 => { self.predelay_ms = value.clamp(0.0, 200.0); self.update_predelay(); }
            4 => { self.width = (value / 100.0).clamp(0.0, 1.0); }
            5 => { self.low_damp = (value / 100.0).clamp(0.0, 1.0); }
            6 => { self.mod_rate = value.clamp(0.0, 3.0); }
            7 => { self.mod_depth = (value / 100.0).clamp(0.0, 1.0); }
            8 => { self.freeze = value > 0.5; self.update_combs(); }
            _ => {}
        }
    }

    fn reset(&mut self) {
        for c in &mut self.combs_l { c.reset(); }
        for c in &mut self.combs_r { c.reset(); }
        for a in &mut self.allpasses_l { a.reset(); }
        for a in &mut self.allpasses_r { a.reset(); }
        self.predelay_buf_l = [0.0; MAX_PREDELAY_SAMPLES];
        self.predelay_buf_r = [0.0; MAX_PREDELAY_SAMPLES];
        self.predelay_pos = 0;
        self.lfo_phase = 0.0;
        self.low_cut_l = 0.0;
        self.low_cut_r = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reverb_processes_without_panic() {
        let mut proc = ReverbProcessor::new(44100.0);
        let mut l = vec![0.5f32; 512];
        let mut r = vec![0.5f32; 512];
        proc.process_stereo(&mut l, &mut r, 44100.0);
    }

    #[test]
    fn reverb_produces_tail() {
        let mut proc = ReverbProcessor::new(44100.0);
        proc.set_param(0, 80.0);
        proc.set_param(2, 100.0);
        let mut l = vec![0.0f32; 44100];
        let mut r = vec![0.0f32; 44100];
        l[0] = 1.0; r[0] = 1.0;
        proc.process_stereo(&mut l, &mut r, 44100.0);
        let tail_energy: f32 = l[22050..].iter().map(|s| s * s).sum();
        assert!(tail_energy > 0.001, "Reverb tail too short: {tail_energy}");
    }

    #[test]
    fn reverb_freeze_sustains() {
        let mut proc = ReverbProcessor::new(44100.0);
        proc.set_param(8, 1.0);  // freeze ON
        proc.set_param(2, 100.0); // full wet
        let mut l = vec![0.0f32; 22050];
        let mut r = vec![0.0f32; 22050];
        l[0] = 1.0; r[0] = 1.0;
        proc.process_stereo(&mut l, &mut r, 44100.0);
        // Late tail should still have energy in freeze mode
        let late: f32 = l[20000..].iter().map(|s| s * s).sum();
        assert!(late > 0.0001, "Freeze should sustain, got: {late}");
    }
}
