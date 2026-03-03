// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — 2x Oversampling Engine (Enterprise)
// ═══════════════════════════════════════════════════════════════════════════
//
// A lightweight, zero-latency (minimum phase) 2x oversampler for 
// non-linear processors (Distortion, Saturation, Compressors) to prevent
// digital aliasing artifacts.
//
// Pipeline:
// 1. Upsample (Zero-Order Hold or Linear)
// 2. Process non-linear function at 2x SR
// 3. Anti-Aliasing (AA) Lowpass Filter (4th-order Butterworth at original Nyquist)
// 4. Downsample (Decimate by discarding every other sample)
//
// Using a 4th-order IIR provides excellent aliasing rejection (>24dB/oct)
// with very low CPU overhead compared to linear-phase FIR Polyphase forests.
// 
// ═══════════════════════════════════════════════════════════════════════════

use crate::biquad::{BiquadCoeffs, BiquadType, BiquadFilter};

#[derive(Clone)]
pub struct Oversampler2x {
    // 4th-order Butterworth (Two 2nd-order stages)
    aa_stage1: BiquadFilter,
    aa_stage2: BiquadFilter,
    prev_input: f32,
}

impl Oversampler2x {
    pub fn new(sample_rate: f32) -> Self {
        let mut os = Self {
            aa_stage1: BiquadFilter::lowpass(20000.0, 44100.0),
            aa_stage2: BiquadFilter::lowpass(20000.0, 44100.0),
            prev_input: 0.0,
        };
        os.set_sample_rate(sample_rate);
        os
    }

    pub fn set_sample_rate(&mut self, base_sample_rate: f32) {
        // Nyquist of base sample rate. Limit to 20kHz max to avoid dulling 
        // high SR (e.g. 96k) but safely trap aliasing at 44.1/48k.
        let nyquist = (base_sample_rate * 0.49).clamp(100.0, 22050.0);
        let sr_2x = base_sample_rate as f64 * 2.0;

        // Cascade two biquads with specific Q factors for 4th-order Butterworth
        // Q1 = 0.5411961, Q2 = 1.3065630
        let c1 = BiquadCoeffs::new(BiquadType::Lowpass, nyquist as f64, 0.5411961, sr_2x, 0.0);
        let c2 = BiquadCoeffs::new(BiquadType::Lowpass, nyquist as f64, 1.3065630, sr_2x, 0.0);

        self.aa_stage1.update_coefficients(c1);
        self.aa_stage2.update_coefficients(c2);
    }

    /// Process a single base-rate sample through a non-linear closure.
    /// The closure runs TWICE per input sample.
    #[inline]
    pub fn process<F>(&mut self, input: f32, mut non_linear_func: F) -> f32
    where
        F: FnMut(f32) -> f32,
    {
        // 1. Upsample: Linear interpolation for the intermediate sub-sample
        let sub0 = (self.prev_input + input) * 0.5;
        let sub1 = input;
        self.prev_input = input;

        // 2. Process non-linear function at 2x rate
        let shaped0 = non_linear_func(sub0);
        let shaped1 = non_linear_func(sub1);

        // 3. Anti-Alias Filter (4th-order IIR running at 2x rate)
        // We must evaluate both to update the continuous IIR filter state!
        let _filtered0 = self.aa_stage2.process_f32(self.aa_stage1.process_f32(shaped0));
        let filtered1 = self.aa_stage2.process_f32(self.aa_stage1.process_f32(shaped1));

        // 4. Downsample (Discard sub0, keep sub1)
        filtered1
    }

    pub fn reset(&mut self) {
        self.aa_stage1.reset();
        self.aa_stage2.reset();
        self.prev_input = 0.0;
    }
}
