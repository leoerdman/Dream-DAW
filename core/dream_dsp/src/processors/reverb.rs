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
//   9: Lo Cut     (20–12000 Hz, default 20)
//  10: Hi Cut     (1200–20000 Hz, default 16000)
//  11: Diffusion  (0–100%, default 75)
//  12: Density    (0–100%, default 80)
//  13: Chorus     (0–100%, default 20)
//  14: Voicing    (0=Room, 1=Hall, 2=Plate, default 1)
//
// Real-Time Safety: Pre-allocated. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::sanitize_sample_rate;
use crate::processors::smoothing::SmoothedValue;

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
        // SSOT: Flush denormals in feedback path.
        crate::processors::flush_denormal!(self.filter_store);
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
        self.buffer.fill(0.0); // BUG-035 FIX: fill() is auto-vectorized
        self.filter_store = 0.0;
    }
}

// ── Allpass Filter ──────────────────────────────────────────────────────

struct AllpassFilter {
    buffer: Vec<f32>,
    buf_size: usize,
    index: usize,
    feedback: f32,
}

impl AllpassFilter {
    fn new(size: usize) -> Self {
        Self {
            buffer: vec![0.0; size],
            buf_size: size,
            index: 0,
            feedback: Self::AP_FEEDBACK,
        }
    }

    /// BUG-033 FIX: Allpass feedback coefficient.
    /// Default 0.5 is the standard Schroeder value for natural decay.
    /// Higher values (0.6–0.7) produce denser reverb; lower values (0.3–0.4)
    /// produce cleaner but sparser reflections.
    const AP_FEEDBACK: f32 = 0.5;

    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        let buf_out = self.buffer[self.index];
        let output = -input + buf_out;
        let mut new_val = input + buf_out * self.feedback;
        // SSOT: Flush denormals in allpass feedback path.
        crate::processors::flush_denormal!(new_val);
        self.buffer[self.index] = new_val;
        self.index = (self.index + 1) % self.buf_size;
        output
    }

    fn set_feedback(&mut self, val: f32) {
        self.feedback = val.clamp(0.0, 0.95);
    }

    fn reset(&mut self) {
        self.buffer.fill(0.0); // BUG-035 FIX: fill() is auto-vectorized
    }
}

// ── Freeverb Tuning ─────────────────────────────────────────────────────

const COMB_SIZES_L: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const COMB_SPREAD: usize = 23;
const AP_SIZES: [usize; 4] = [556, 441, 341, 225];
const REF_SAMPLE_RATE: f32 = 44100.0;
/// Maximum sample rate we pre-allocate for — covers 192kHz studio setups.
/// AUD-113 FIX: Buffers are allocated once at this ceiling and never resized
/// at runtime, guaranteeing zero heap allocations on the audio thread.
const MAX_SUPPORTED_RATE: f32 = 192_000.0;

// ── Pre-delay buffer ────────────────────────────────────────────────────
/// 200ms at up to 192kHz. Covers all standard DAW sample rates.
const MAX_PREDELAY_SAMPLES: usize = 38400; // ~200ms @ 192kHz

pub struct ReverbProcessor {
    combs_l: Vec<CombFilter>,
    combs_r: Vec<CombFilter>,
    allpasses_l: Vec<AllpassFilter>,
    allpasses_r: Vec<AllpassFilter>,
    // Pre-delay
    predelay_buf_l: Box<[f32]>,
    predelay_buf_r: Box<[f32]>,
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
    chorus_amount: f32,
    diffusion: f32,
    density: f32,
    input_low_cut_hz: f32,
    input_high_cut_hz: f32,
    voicing: u8,
    freeze: bool,
    predelay_ms: f32,
    // Modulation LFO
    lfo_phase: f64,
    // Low-damp filter state
    low_cut_l: f32,
    low_cut_r: f32,
    // Post-tail tone filter state (musical HF damping)
    tail_lp_l: f32,
    tail_lp_r: f32,
    // Input filter state (pre-reverb)
    input_lp_l: f32,
    input_lp_r: f32,
    input_hp_l: f32,
    input_hp_r: f32,
    sample_rate: f32,
    // Smoothed runtime params (anti-zipper)
    mix_sm: SmoothedValue,
    width_sm: SmoothedValue,
    predelay_sm_ms: SmoothedValue,
    low_damp_sm: SmoothedValue,
    mod_depth_sm: SmoothedValue,
    chorus_amount_sm: SmoothedValue,
    diffusion_sm: SmoothedValue,
    density_sm: SmoothedValue,
    input_low_cut_sm: SmoothedValue,
    input_high_cut_sm: SmoothedValue,
}

impl ReverbProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sample_rate = sanitize_sample_rate(sample_rate);
        // AUD-113 FIX: Pre-allocate ALL comb and allpass buffers at MAX_SUPPORTED_RATE
        // so that sync_sample_rate() never needs to resize (= zero heap allocs on RT thread).
        // Logical buf_size is adjusted on SR change; physical capacity stays fixed.
        let max_ratio = MAX_SUPPORTED_RATE / REF_SAMPLE_RATE;
        let max_scale = |s: usize| ((s as f32 * max_ratio) as usize).max(1);

        // Allocate at maximum capacity
        let combs_l: Vec<CombFilter> = COMB_SIZES_L
            .iter()
            .map(|&s| CombFilter::new(max_scale(s)))
            .collect();
        let combs_r: Vec<CombFilter> = COMB_SIZES_L
            .iter()
            .map(|&s| CombFilter::new(max_scale(s + COMB_SPREAD)))
            .collect();
        let allpasses_l: Vec<AllpassFilter> = AP_SIZES
            .iter()
            .map(|&s| AllpassFilter::new(max_scale(s)))
            .collect();
        let allpasses_r: Vec<AllpassFilter> = AP_SIZES
            .iter()
            .map(|&s| AllpassFilter::new(max_scale(s + COMB_SPREAD)))
            .collect();

        let mut proc = Self {
            combs_l,
            combs_r,
            allpasses_l,
            allpasses_r,
            predelay_buf_l: vec![0.0; MAX_PREDELAY_SAMPLES].into_boxed_slice(),
            predelay_buf_r: vec![0.0; MAX_PREDELAY_SAMPLES].into_boxed_slice(),
            predelay_pos: 0,
            predelay_samples: 0,
            room_size: 0.5,
            damping: 0.4,
            mix: 0.3,
            width: 1.0,
            low_damp: 0.2,
            mod_rate: 0.3,
            mod_depth: 0.15,
            chorus_amount: 0.2,
            diffusion: 0.75,
            density: 0.8,
            input_low_cut_hz: 20.0,
            input_high_cut_hz: 20000.0,
            voicing: 1,
            freeze: false,
            predelay_ms: 10.0,
            lfo_phase: 0.0,
            low_cut_l: 0.0,
            low_cut_r: 0.0,
            tail_lp_l: 0.0,
            tail_lp_r: 0.0,
            input_lp_l: 0.0,
            input_lp_r: 0.0,
            input_hp_l: 0.0,
            input_hp_r: 0.0,
            sample_rate,
            mix_sm: SmoothedValue::new(sample_rate, 10.0, 0.3),
            width_sm: SmoothedValue::new(sample_rate, 10.0, 1.0),
            predelay_sm_ms: SmoothedValue::new(sample_rate, 12.0, 10.0),
            low_damp_sm: SmoothedValue::new(sample_rate, 10.0, 0.2),
            mod_depth_sm: SmoothedValue::new(sample_rate, 10.0, 0.15),
            chorus_amount_sm: SmoothedValue::new(sample_rate, 12.0, 0.2),
            diffusion_sm: SmoothedValue::new(sample_rate, 12.0, 0.75),
            density_sm: SmoothedValue::new(sample_rate, 12.0, 0.8),
            input_low_cut_sm: SmoothedValue::new(sample_rate, 15.0, 20.0),
            input_high_cut_sm: SmoothedValue::new(sample_rate, 15.0, 20000.0),
        };
        // Set logical buf_size for the actual sample rate (within max capacity)
        proc.rescale_logical_sizes(sample_rate);
        proc.update_combs();
        proc.update_predelay();
        proc
    }

    /// AUD-113 FIX: Rescale logical buffer sizes WITHOUT reallocation.
    /// Physical Vec capacity was pre-allocated at MAX_SUPPORTED_RATE.
    /// This only adjusts buf_size and clamps index — zero allocs.
    fn rescale_logical_sizes(&mut self, sample_rate: f32) {
        let ratio = sample_rate / REF_SAMPLE_RATE;
        let scale = |s: usize| ((s as f32 * ratio) as usize).max(1);

        // BUG-M19 FIX: Zero entries beyond the new logical size when SR
        // decreases. Without this, old samples remain in the physical
        // buffer and re-enter the feedback loop if SR later increases.
        for (idx, c) in self.combs_l.iter_mut().enumerate() {
            let new_size = scale(COMB_SIZES_L[idx]).min(c.buffer.len());
            let old_size = c.buf_size;
            c.buf_size = new_size;
            c.index %= new_size;
            c.filter_store = 0.0;
            if new_size < old_size {
                c.buffer[new_size..old_size].fill(0.0);
            }
        }
        for (idx, c) in self.combs_r.iter_mut().enumerate() {
            let new_size = scale(COMB_SIZES_L[idx] + COMB_SPREAD).min(c.buffer.len());
            let old_size = c.buf_size;
            c.buf_size = new_size;
            c.index %= new_size;
            c.filter_store = 0.0;
            if new_size < old_size {
                c.buffer[new_size..old_size].fill(0.0);
            }
        }
        for (idx, a) in self.allpasses_l.iter_mut().enumerate() {
            let new_size = scale(AP_SIZES[idx]).min(a.buffer.len());
            let old_size = a.buf_size;
            a.buf_size = new_size;
            a.index %= new_size;
            if new_size < old_size {
                a.buffer[new_size..old_size].fill(0.0);
            }
        }
        for (idx, a) in self.allpasses_r.iter_mut().enumerate() {
            let new_size = scale(AP_SIZES[idx] + COMB_SPREAD).min(a.buffer.len());
            let old_size = a.buf_size;
            a.buf_size = new_size;
            a.index %= new_size;
            if new_size < old_size {
                a.buffer[new_size..old_size].fill(0.0);
            }
        }
    }

    fn update_combs(&mut self) {
        // Enterprise tuning: use a psychoacoustic curve so low size values are
        // still usable ("small room" ambience) while preserving long tails at
        // high size. Linear mapping made 1-10% effectively too dry.
        let fb = if self.freeze {
            1.0
        } else {
            // curve range: 0.18 .. 0.98
            // - at size=0%  -> short but audible room
            // - at size=100% -> long decay tail
            0.18 + self.room_size.powf(0.6) * 0.80
        };
        let damp = if self.freeze { 0.0 } else { self.damping };
        for c in &mut self.combs_l {
            c.set_feedback(fb);
            c.set_damp(damp);
        }
        for c in &mut self.combs_r {
            c.set_feedback(fb);
            c.set_damp(damp);
        }

        // Diffusion controls allpass feedback: lower = clearer taps, higher = denser cloud.
        let ap_fb = 0.45 + self.diffusion.clamp(0.0, 1.0) * 0.43;
        for a in &mut self.allpasses_l {
            a.set_feedback(ap_fb);
        }
        for a in &mut self.allpasses_r {
            a.set_feedback(ap_fb);
        }
    }

    fn update_predelay(&mut self) {
        self.predelay_samples =
            ((self.predelay_ms * 0.001 * self.sample_rate) as usize).min(MAX_PREDELAY_SAMPLES - 1);
    }

    #[inline]
    fn read_delay_frac(buf: &[f32], write_pos: usize, delay_samples: f32) -> f32 {
        let len = buf.len();
        if len == 0 {
            return 0.0;
        }
        let len_f = len as f32;
        let delay = delay_samples.clamp(0.0, (len - 1) as f32);
        let mut read_pos = (write_pos as f32 - delay).rem_euclid(len_f);
        if read_pos >= len_f {
            read_pos = 0.0;
        }
        let base = read_pos.floor();
        let i0 = base as usize;
        let i1 = (i0 + 1) % len;
        let frac = read_pos - base;
        buf[i0] * (1.0 - frac) + buf[i1] * frac
    }

    #[inline]
    fn sync_sample_rate(&mut self, sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;

            // AUD-113 FIX: Rescale logical sizes WITHOUT reallocation.
            // Physical Vec capacity was pre-allocated at MAX_SUPPORTED_RATE in new().
            // Previous code called resize() which could allocate on the RT thread.
            self.rescale_logical_sizes(sr);

            self.update_combs();
            self.update_predelay();
            self.mix_sm.set_sample_rate(sr);
            self.width_sm.set_sample_rate(sr);
            self.predelay_sm_ms.set_sample_rate(sr);
            self.low_damp_sm.set_sample_rate(sr);
            self.mod_depth_sm.set_sample_rate(sr);
            self.chorus_amount_sm.set_sample_rate(sr);
            self.diffusion_sm.set_sample_rate(sr);
            self.density_sm.set_sample_rate(sr);
            self.input_low_cut_sm.set_sample_rate(sr);
            self.input_high_cut_sm.set_sample_rate(sr);
        }
    }
}

impl DspProcessor for ReverbProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        self.sync_sample_rate(sample_rate);
        let len = left.len().min(right.len());

        // BUG-025 FIX: Early-return when fully dry — skip all 12 delay lines.
        // Saves ~200 multiply-adds per sample when reverb is bypassed via mix=0.
        if self.mix <= 0.001 && !self.freeze {
            return;
        }

        let lfo_inc = self.mod_rate as f64 / self.sample_rate as f64;
        let sr = self.sample_rate;

        // Early reflection tap times (seconds), spread across L/R for stereo depth.
        let er_tap_1 = (0.0068 * sr).clamp(0.0, (MAX_PREDELAY_SAMPLES - 1) as f32);
        let er_tap_2 = (0.0139 * sr).clamp(0.0, (MAX_PREDELAY_SAMPLES - 1) as f32);
        let er_tap_3 = (0.0247 * sr).clamp(0.0, (MAX_PREDELAY_SAMPLES - 1) as f32);
        let er_tap_4 = (0.0371 * sr).clamp(0.0, (MAX_PREDELAY_SAMPLES - 1) as f32);

        let (voicing_er_mul, voicing_tail_hf, voicing_mod_mul, voicing_density_mul) =
            match self.voicing {
                0 => (0.95f32, 0.85f32, 0.70f32, 0.85f32), // Room: tighter/less lush
                2 => (0.70f32, 1.20f32, 1.15f32, 1.05f32), // Plate: brighter/sheen
                _ => (1.00f32, 1.00f32, 1.00f32, 1.00f32), // Hall: balanced
            };

        // BUG-FIX: Normalise the summed output of 8 parallel combs.
        // Without this, the wet signal is ~8× hotter than the dry signal,
        // causing massive distortion/clipping.  1/8 = 0.125.
        const COMB_NORM: f32 = 1.0 / 8.0;

        self.mix_sm.set_target(self.mix);
        self.width_sm.set_target(self.width);
        self.predelay_sm_ms.set_target(self.predelay_ms);
        self.low_damp_sm.set_target(self.low_damp.clamp(0.0, 1.0));
        self.mod_depth_sm.set_target(self.mod_depth.clamp(0.0, 1.0));
        self.chorus_amount_sm
            .set_target(self.chorus_amount.clamp(0.0, 1.0));
        self.diffusion_sm.set_target(self.diffusion.clamp(0.0, 1.0));
        self.density_sm.set_target(self.density.clamp(0.0, 1.0));
        self.input_low_cut_sm
            .set_target(self.input_low_cut_hz.clamp(20.0, 12000.0));
        self.input_high_cut_sm
            .set_target(self.input_high_cut_hz.clamp(1200.0, 20000.0));

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let low_damp_coeff = self.low_damp_sm.next_value() * 0.5;
            let mod_depth = self.mod_depth_sm.next_value();
            let chorus_amt = self.chorus_amount_sm.next_value();
            let density = self.density_sm.next_value();
            let diffusion = self.diffusion_sm.next_value();

            let wet = self.mix_sm.next_value();
            let dry = 1.0 - wet;
            let width = self.width_sm.next_value();
            let wet1 = wet * (1.0 + width) * 0.5;
            let wet2 = wet * (1.0 - width) * 0.5;

            // Pre-delay
            let predelay_ms = self.predelay_sm_ms.next_value();
            let predelay_samples_f = (predelay_ms * 0.001 * self.sample_rate)
                .clamp(0.0, (MAX_PREDELAY_SAMPLES - 1) as f32);
            self.predelay_samples = predelay_samples_f as usize;
            let pd_pos = self.predelay_pos;
            let pd_l = Self::read_delay_frac(&self.predelay_buf_l, pd_pos, predelay_samples_f);
            let pd_r = Self::read_delay_frac(&self.predelay_buf_r, pd_pos, predelay_samples_f);

            // Early reflections (before reverb tail) for room definition.
            // Includes light crossfeed to prevent flat/mono center image.
            let er_l = Self::read_delay_frac(&self.predelay_buf_l, pd_pos, er_tap_1) * 0.55
                + Self::read_delay_frac(&self.predelay_buf_l, pd_pos, er_tap_3) * 0.28
                + Self::read_delay_frac(&self.predelay_buf_r, pd_pos, er_tap_4) * 0.17;
            let er_r = Self::read_delay_frac(&self.predelay_buf_r, pd_pos, er_tap_2) * 0.55
                + Self::read_delay_frac(&self.predelay_buf_r, pd_pos, er_tap_4) * 0.28
                + Self::read_delay_frac(&self.predelay_buf_l, pd_pos, er_tap_3) * 0.17;

            self.predelay_buf_l[pd_pos] = if self.freeze { 0.0 } else { dry_l };
            self.predelay_buf_r[pd_pos] = if self.freeze { 0.0 } else { dry_r };
            self.predelay_pos = (pd_pos + 1) % MAX_PREDELAY_SAMPLES;

            // Input filter block (LoCut/HiCut), pre-reverb send only.
            // BUG-B003 FIX: Use LP-subtraction for high-pass instead of
            // chained or cross-channel first-order HP.
            // BUG-B004 FIX: Both use correct one-pole LP formula.
            let low_cut = self.input_low_cut_sm.next_value().clamp(20.0, 12000.0);
            let high_cut = self.input_high_cut_sm.next_value().clamp(1200.0, 20000.0);
            // BUG-C011 FIX: Replaced per-sample `exp(-2π*fc/sr)` calls (40ns each!)
            // with the SSOT `one_pole_lp_coeff()` helper which uses the same formula
            // but is inlined and compiled with fast-math intrinsics. The helper also
            // clamps the coefficient to [0.001, 0.999] preventing denormals.
            let lp_a = 1.0 - crate::processors::one_pole_lp_coeff(high_cut, sr);
            self.input_lp_l = lp_a * self.input_lp_l + (1.0 - lp_a) * pd_l;
            self.input_lp_r = lp_a * self.input_lp_r + (1.0 - lp_a) * pd_r;
            // LP for low-cut (subtract to get HP effect)
            let hp_lp_a = 1.0 - crate::processors::one_pole_lp_coeff(low_cut, sr);
            self.input_hp_l = hp_lp_a * self.input_hp_l + (1.0 - hp_lp_a) * self.input_lp_l;
            self.input_hp_r = hp_lp_a * self.input_hp_r + (1.0 - hp_lp_a) * self.input_lp_r;
            // Bandpass: LP output minus its LP-of-LP (= removes low freqs)
            let filtered_l = self.input_lp_l - self.input_hp_l;
            let filtered_r = self.input_lp_r - self.input_hp_r;

            // BUG-FIX: Feed pre-delayed LEFT into L-combs, RIGHT into R-combs.
            // Previously `(pd_l + pd_r) * 0.5` collapsed to mono before the
            // comb banks, destroying the stereo image entirely.
            let er_send = 0.20 + self.room_size * 0.22;
            let input_l = filtered_l + er_l * er_send;
            let input_r = filtered_r + er_r * er_send;

            // SSOT: Fast sine approximation from mod.rs.
            let fast_sin = crate::processors::fast_sin_phase(self.lfo_phase as f32);
            let lfo = fast_sin * mod_depth * voicing_mod_mul * (0.008 + chorus_amt * 0.02);
            self.lfo_phase += lfo_inc;
            self.lfo_phase = self.lfo_phase.fract();

            // BUG-H06 FIX: Right channel gets inverted LFO for true stereo
            // movement. Previously both channels used `(1.0 + lfo)`, producing
            // mono pulsing instead of spatial modulation.
            let input_l_mod = input_l * (1.0 + lfo);
            let input_r_mod = input_r * (1.0 - lfo);

            // Parallel comb filters — L and R fed independently for stereo
            let mut out_l = 0.0f32;
            let mut out_r = 0.0f32;
            for c in &mut self.combs_l {
                out_l += c.process(input_l_mod);
            }
            for c in &mut self.combs_r {
                out_r += c.process(input_r_mod);
            }

            // Normalise summed comb output + density gain staging.
            out_l *= COMB_NORM;
            out_r *= COMB_NORM;
            let density_gain = (0.82 + density * 0.36) * voicing_density_mul;
            out_l *= density_gain;
            out_r *= density_gain;

            // Serial allpass filters
            for ap in &mut self.allpasses_l {
                out_l = ap.process(out_l);
            }
            for ap in &mut self.allpasses_r {
                out_r = ap.process(out_r);
            }

            // Gentle size-dependent gain compensation to keep tails perceptible
            // across the full size range without over-driving large rooms.
            let room_gain = (0.85 + self.room_size * 0.35) * (0.9 + diffusion * 0.2);
            out_l *= room_gain;
            out_r *= room_gain;

            // Low-frequency damping (HP filter in the reverb tail)
            self.low_cut_l += low_damp_coeff * (out_l - self.low_cut_l);
            self.low_cut_r += low_damp_coeff * (out_r - self.low_cut_r);
            // SSOT: Flush denormals in low-damp HP filter states.
            crate::processors::flush_denormal!(self.low_cut_l);
            crate::processors::flush_denormal!(self.low_cut_r);
            out_l -= self.low_cut_l;
            out_r -= self.low_cut_r;

            // Musical post-tail HF damping:
            // damping=0 -> brighter tail, damping=1 -> darker/softer tail.
            let tail_lp_coeff = 0.02 + (1.0 - self.damping) * 0.22;
            self.tail_lp_l += tail_lp_coeff * (out_l - self.tail_lp_l);
            self.tail_lp_r += tail_lp_coeff * (out_r - self.tail_lp_r);
            crate::processors::flush_denormal!(self.tail_lp_l);
            crate::processors::flush_denormal!(self.tail_lp_r);
            out_l = self.tail_lp_l * voicing_tail_hf;
            out_r = self.tail_lp_r * voicing_tail_hf;

            // Width + mix
            let er_wet = (0.12 + self.room_size * 0.10) * voicing_er_mul;
            let wet_l = out_l + er_l * er_wet;
            let wet_r = out_r + er_r * er_wet;
            left[i] = dry_l * dry + wet_l * wet1 + wet_r * wet2;
            right[i] = dry_r * dry + wet_r * wet1 + wet_l * wet2;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => {
                self.room_size = (value / 100.0).clamp(0.0, 1.0);
                self.update_combs();
            }
            1 => {
                self.damping = (value / 100.0).clamp(0.0, 1.0);
                self.update_combs();
            }
            2 => {
                self.mix = (value / 100.0).clamp(0.0, 1.0);
            }
            3 => {
                self.predelay_ms = value.clamp(0.0, 200.0);
                self.update_predelay();
            }
            4 => {
                self.width = (value / 100.0).clamp(0.0, 1.0);
            }
            5 => {
                self.low_damp = (value / 100.0).clamp(0.0, 1.0);
            }
            6 => {
                self.mod_rate = value.clamp(0.0, 3.0);
            }
            7 => {
                self.mod_depth = (value / 100.0).clamp(0.0, 1.0);
            }
            8 => {
                self.freeze = value > 0.5;
                self.update_combs();
            }
            9 => {
                self.input_low_cut_hz = value.clamp(20.0, 12000.0);
            }
            10 => {
                self.input_high_cut_hz = value.clamp(1200.0, 20000.0);
            }
            11 => {
                self.diffusion = (value / 100.0).clamp(0.0, 1.0);
                self.update_combs();
            }
            12 => {
                self.density = (value / 100.0).clamp(0.0, 1.0);
            }
            13 => {
                self.chorus_amount = (value / 100.0).clamp(0.0, 1.0);
            }
            14 => {
                self.voicing = (value as u8).min(2);
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        for c in &mut self.combs_l {
            c.reset();
        }
        for c in &mut self.combs_r {
            c.reset();
        }
        for a in &mut self.allpasses_l {
            a.reset();
        }
        for a in &mut self.allpasses_r {
            a.reset();
        }
        self.predelay_buf_l.fill(0.0);
        self.predelay_buf_r.fill(0.0);
        self.predelay_pos = 0;
        self.lfo_phase = 0.0;
        self.low_cut_l = 0.0;
        self.low_cut_r = 0.0;
        self.tail_lp_l = 0.0;
        self.tail_lp_r = 0.0;
        self.input_lp_l = 0.0;
        self.input_lp_r = 0.0;
        self.input_hp_l = 0.0;
        self.input_hp_r = 0.0;
        self.mix_sm.set_instant(self.mix);
        self.width_sm.set_instant(self.width);
        self.predelay_sm_ms.set_instant(self.predelay_ms);
        self.low_damp_sm.set_instant(self.low_damp);
        self.mod_depth_sm.set_instant(self.mod_depth);
        self.chorus_amount_sm.set_instant(self.chorus_amount);
        self.diffusion_sm.set_instant(self.diffusion);
        self.density_sm.set_instant(self.density);
        self.input_low_cut_sm.set_instant(self.input_low_cut_hz);
        self.input_high_cut_sm.set_instant(self.input_high_cut_hz);
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
        l[0] = 1.0;
        r[0] = 1.0;
        proc.process_stereo(&mut l, &mut r, 44100.0);
        let tail_energy: f32 = l[22050..].iter().map(|s| s * s).sum();
        assert!(tail_energy > 0.0001, "Reverb tail too short: {tail_energy}");
    }

    #[test]
    fn reverb_freeze_sustains() {
        let mut proc = ReverbProcessor::new(44100.0);
        proc.set_param(8, 1.0); // freeze ON
        proc.set_param(2, 100.0); // full wet
        let mut l = vec![0.0f32; 22050];
        let mut r = vec![0.0f32; 22050];
        l[0] = 1.0;
        r[0] = 1.0;
        proc.process_stereo(&mut l, &mut r, 44100.0);
        // Late tail should still have energy in freeze mode
        let late: f32 = l[20000..].iter().map(|s| s * s).sum();
        assert!(late > 0.0001, "Freeze should sustain, got: {late}");
    }

    #[test]
    fn reverb_small_room_is_audible() {
        let mut proc = ReverbProcessor::new(44100.0);
        proc.set_param(0, 2.0); // tiny room
        proc.set_param(2, 100.0); // full wet
        let mut l = vec![0.0f32; 8192];
        let mut r = vec![0.0f32; 8192];
        l[0] = 1.0;
        r[0] = 1.0;
        proc.process_stereo(&mut l, &mut r, 44100.0);
        let tail_energy: f32 = l[1024..].iter().map(|s| s * s).sum();
        assert!(
            tail_energy > 1.0e-6,
            "Small-room tail should be audible: {tail_energy}"
        );
    }
}
