// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Triangular PDF (TPDF) Dithering
// ═══════════════════════════════════════════════════════════════════════════
//
// WHAT:
//   Adds ±1 LSB triangular-distributed noise before integer quantization.
//   This converts harsh truncation distortion into a flat, inaudible noise
//   floor — critical for 16-bit and 24-bit WAV exports.
//
// WHY:
//   Without dithering, quantizing 32-bit float → 16-bit PCM introduces
//   correlated truncation artifacts (audible on reverb tails, quiet
//   passages, and fade-outs). TPDF dithering decorrelates the
//   quantization error, making it perceptually transparent.
//
// HOW:
//   1. Generate two uniform random integers via xorshift64 (RT-safe PRNG).
//   2. Sum them → triangular distribution (Central Limit Theorem, N=2).
//   3. Scale to ±1 LSB of target bit depth.
//   4. Add to the scaled signal BEFORE rounding.
//
// REAL-TIME SAFETY:
//   - Zero allocations, zero locks, zero I/O.
//   - xorshift64 is branch-free and deterministic.
//   - Designed for both offline export and (future) real-time monitoring.
//
// REFERENCES:
//   - "Digital Audio Signal Processing" by Udo Zölzer, Chapter 9
//   - AES-17 Standard for dithered digital audio measurements
//   - https://en.wikipedia.org/wiki/Dither#Digital_audio
//
// ═══════════════════════════════════════════════════════════════════════════

/// Triangular Probability Density Function (TPDF) Ditherer.
///
/// Generates ±1 LSB triangular-distributed noise for dithering
/// quantization when converting from float to fixed-point PCM.
///
/// # Usage
/// ```
/// use dream_dsp::dither::TpdfDitherer;
///
/// let mut ditherer = TpdfDitherer::new();
/// let sample: f32 = 0.5;
/// let scaled = sample * 32767.0;       // Scale to 16-bit range
/// let dithered = scaled + ditherer.next_tpdf();  // Add TPDF noise
/// let quantized = dithered.round() as i16;       // Round to integer
/// ```
pub struct TpdfDitherer {
    /// xorshift64 PRNG state (must never be zero).
    rng_state: u64,
}

impl TpdfDitherer {
    /// Creates a new TPDF ditherer with default seed.
    ///
    /// The seed is chosen to be a large prime to ensure good
    /// distribution from the first sample onwards.
    #[inline]
    pub fn new() -> Self {
        Self {
            rng_state: 0x5DEECE66D_u64, // Classic Knuth multiplier
        }
    }

    /// Creates a new TPDF ditherer with a custom seed.
    ///
    /// The seed must be non-zero (xorshift requirement).
    /// If zero is passed, it is replaced with the default seed.
    #[inline]
    pub fn with_seed(seed: u64) -> Self {
        Self {
            rng_state: if seed == 0 { 0x5DEECE66D_u64 } else { seed },
        }
    }

    /// Generates the next ±1.0 LSB TPDF noise sample.
    ///
    /// Returns a value in the range `[-1.0, +1.0)` with a triangular
    /// probability distribution centered at zero.
    ///
    /// # Algorithm
    /// Two independent uniform random values in `[-0.5, +0.5)` are summed
    /// to produce a triangular distribution in `[-1.0, +1.0)`.
    /// This is the standard TPDF construction (CLT with N=2).
    #[inline]
    pub fn next_tpdf(&mut self) -> f32 {
        // Generate two independent uniform random samples.
        let u1 = self.next_uniform();
        let u2 = self.next_uniform();
        // Sum of two uniform [-0.5, 0.5) → triangular [-1.0, 1.0)
        u1 + u2
    }

    /// Generates a uniform random value in `[-0.5, +0.5)`.
    ///
    /// Uses xorshift64 — a fast, allocation-free, branch-free PRNG
    /// with a period of 2^64 - 1. Perfectly adequate for audio dithering
    /// (no cryptographic security needed).
    #[inline]
    fn next_uniform(&mut self) -> f32 {
        // xorshift64: https://en.wikipedia.org/wiki/Xorshift
        let mut x = self.rng_state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rng_state = x;

        // Convert to float in [-0.5, 0.5).
        // Take the upper 24 bits for float mantissa precision,
        // map to [0.0, 1.0) then shift to [-0.5, 0.5).
        let mantissa = (x >> 40) as f32; // 24-bit value: [0, 16777215]
        mantissa / 16777216.0 - 0.5 // → [-0.5, ~+0.5)
    }

    /// Resets the PRNG state to a given seed.
    ///
    /// Useful for deterministic offline rendering or testing.
    #[inline]
    pub fn reset(&mut self, seed: u64) {
        self.rng_state = if seed == 0 { 0x5DEECE66D_u64 } else { seed };
    }
}

impl Default for TpdfDitherer {
    fn default() -> Self {
        Self::new()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tpdf_output_is_bounded() {
        let mut d = TpdfDitherer::new();
        for _ in 0..100_000 {
            let v = d.next_tpdf();
            assert!(
                v >= -1.0 && v < 1.0,
                "TPDF value {v} out of range [-1.0, 1.0)"
            );
        }
    }

    #[test]
    fn tpdf_mean_is_approximately_zero() {
        let mut d = TpdfDitherer::new();
        let n = 1_000_000;
        let sum: f64 = (0..n).map(|_| d.next_tpdf() as f64).sum();
        let mean = sum / n as f64;
        // Mean should be very close to 0 for a symmetric distribution.
        assert!(mean.abs() < 0.002, "TPDF mean {mean} is not close to zero");
    }

    #[test]
    fn tpdf_distribution_is_triangular() {
        // Verify the distribution peaks near zero and tapers to ±1.
        // A triangular distribution has variance = 1/6 for each uniform
        // in [-0.5, 0.5), so sum of two has variance = 1/3.
        let mut d = TpdfDitherer::new();
        let n = 1_000_000;
        let variance: f64 = (0..n)
            .map(|_| {
                let v = d.next_tpdf() as f64;
                v * v
            })
            .sum::<f64>()
            / n as f64;

        // Expected variance ≈ 1/6 (≈ 0.1667)
        // (Each uniform in [-0.5, 0.5) has variance 1/12.
        //  Sum of two independent → variance = 2 × 1/12 = 1/6.)
        let expected = 1.0 / 6.0;
        assert!(
            (variance - expected).abs() < 0.005,
            "TPDF variance {variance} differs from expected {expected}"
        );
    }

    #[test]
    fn uniform_output_is_bounded() {
        let mut d = TpdfDitherer::new();
        for _ in 0..100_000 {
            let v = d.next_uniform();
            assert!(
                v >= -0.5 && v < 0.5,
                "Uniform value {v} out of range [-0.5, 0.5)"
            );
        }
    }

    #[test]
    fn deterministic_with_same_seed() {
        let mut d1 = TpdfDitherer::with_seed(42);
        let mut d2 = TpdfDitherer::with_seed(42);
        for _ in 0..1000 {
            assert_eq!(d1.next_tpdf(), d2.next_tpdf());
        }
    }

    #[test]
    fn different_seeds_produce_different_sequences() {
        let mut d1 = TpdfDitherer::with_seed(42);
        let mut d2 = TpdfDitherer::with_seed(99);
        let mut differ = false;
        for _ in 0..100 {
            if d1.next_tpdf() != d2.next_tpdf() {
                differ = true;
                break;
            }
        }
        assert!(differ, "Different seeds should produce different sequences");
    }

    #[test]
    fn zero_seed_uses_default() {
        let d = TpdfDitherer::with_seed(0);
        let d_default = TpdfDitherer::new();
        assert_eq!(d.rng_state, d_default.rng_state);
    }

    #[test]
    fn dithered_quantization_example() {
        // Demonstrate the full dithering pipeline for 16-bit.
        let mut d = TpdfDitherer::new();
        let sample: f32 = 0.001; // Very quiet signal
        let scaler = 32767.0_f32;

        let scaled = sample * scaler;
        let dithered = scaled + d.next_tpdf();
        let quantized = dithered.round().clamp(-32768.0, 32767.0) as i16;

        // The quantized value should be near the scaled value ± 1 LSB.
        let diff = (quantized as f32 - scaled).abs();
        assert!(
            diff < 2.0,
            "Dithered quantization error {diff} exceeds ±1 LSB"
        );
    }
}
