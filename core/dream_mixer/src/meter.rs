// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — VU Meter (Peak + RMS with Ballistics)
// ═══════════════════════════════════════════════════════════════════════════
//
// Professional VU meter with separate peak and RMS readings.
//
// Features:
//   - True peak detection (sample-accurate, no interpolation)
//   - RMS level calculation (power average)
//   - Ballistic fall-off (configurable attack/release)
//   - Peak hold with configurable hold time
//
// All methods are REAL-TIME SAFE.
//
// ═══════════════════════════════════════════════════════════════════════════

use super::gain::linear_to_db;

/// Professional VU meter with ballistics.
///
/// Feed audio buffers into `process()` and read `peak_db()` / `rms_db()`
/// from the UI thread. The meter applies configurable ballistic smoothing
/// to create natural-looking level movement.
#[derive(Debug, Clone)]
pub struct VuMeter {
    /// Current smoothed peak level (linear).
    peak_level: f32,

    /// Current smoothed RMS level (linear).
    rms_level: f32,

    /// Peak hold value (linear). Decays after hold time expires.
    peak_hold: f32,

    /// Frames remaining in peak hold.
    peak_hold_frames: u32,

    /// Configuration: peak hold duration in frames.
    hold_duration_frames: u32,

    /// Attack coefficient (fast rise).
    attack_coeff: f32,

    /// Release coefficient (slow fall).
    release_coeff: f32,

    /// BUG-M1 FIX: Track whether clipping was detected in the most recent block.
    /// Using peak_hold for clipping detection was wrong — hold decay (0.99×)
    /// kept the clipping flag active for seconds after the signal dropped below 1.0.
    clip_flag: bool,
}

/// Default peak hold time: ~1.5 seconds at 44100Hz / 512-sample blocks.
const DEFAULT_HOLD_BLOCKS: u32 = 130;

impl VuMeter {
    /// Creates a new VU meter with default settings.
    pub fn new() -> Self {
        Self {
            peak_level: 0.0,
            rms_level: 0.0,
            peak_hold: 0.0,
            peak_hold_frames: 0,
            hold_duration_frames: DEFAULT_HOLD_BLOCKS,
            attack_coeff: 0.9,    // Fast attack (~1ms)
            release_coeff: 0.005, // Slow release (~300ms)
            clip_flag: false,
        }
    }

    /// Creates a VU meter with custom ballistic coefficients.
    pub fn with_ballistics(attack: f32, release: f32, hold_blocks: u32) -> Self {
        Self {
            attack_coeff: attack.clamp(0.0, 1.0),
            release_coeff: release.clamp(0.0, 1.0),
            hold_duration_frames: hold_blocks,
            ..Self::new()
        }
    }

    /// AUD-212 FIX: Recalculate ballistic coefficients from IEC-standard time
    /// constants based on actual sample rate and block size.
    /// Previous hardcoded values (0.9 attack, 0.005 release) produced inconsistent
    /// timing at different block sizes / sample rates.
    ///
    /// Target time constants: 12ms attack (~IEC 268-10), 300ms release.
    pub fn set_sample_rate(&mut self, sample_rate: f32, block_size: usize) {
        let blocks_per_sec = sample_rate / (block_size.max(1) as f32);
        if blocks_per_sec > 0.0 && blocks_per_sec.is_finite() {
            // τ_attack  = 12ms  → coefficient per block
            let attack_blocks = 0.012 * blocks_per_sec;
            self.attack_coeff = if attack_blocks > 0.0 {
                (-1.0 / attack_blocks as f64).exp() as f32
            } else {
                0.9
            };
            // τ_release = 300ms → coefficient per block
            let release_blocks = 0.300 * blocks_per_sec;
            self.release_coeff = if release_blocks > 0.0 {
                (1.0 - (-1.0 / release_blocks as f64).exp()) as f32
            } else {
                0.005
            };
            // Hold = ~1.5 seconds in blocks
            self.hold_duration_frames = (1.5 * blocks_per_sec) as u32;
        }
    }

    /// Processes a block of audio samples and updates meter levels.
    ///
    /// # Real-Time Safety
    /// Real-time safe — bounded iteration, no allocations.
    #[inline]
    pub fn process(&mut self, buffer: &[f32]) {
        if buffer.is_empty() {
            return;
        }

        // Calculate block peak and RMS
        let mut block_peak: f32 = 0.0;
        let mut sum_sq: f32 = 0.0;
        let mut finite_count: usize = 0;

        for &sample in buffer {
            // BUG-M1 FIX: Guard NaN/Inf inputs. Without this, a single NaN
            // from a plugin poisons peak_level, rms_level, and peak_hold
            // permanently (NaN + x = NaN, NaN > x = false).
            if !sample.is_finite() {
                continue;
            }
            finite_count += 1;
            let abs = sample.abs();
            if abs > block_peak {
                block_peak = abs;
            }
            sum_sq += sample * sample;
        }

        // BUG-M9 FIX: Divide by finite_count, not buffer.len(). When NaN
        // samples are skipped, the old code still divided by the full buffer
        // length — artificially deflating RMS when plugins emit occasional
        // NaN bursts (e.g. denormal flush, uninitialized output).
        // BUG-037 FIX: Fast-path for silence (skip sqrt on zero).
        let mean_sq = if finite_count > 0 {
            sum_sq / finite_count as f32
        } else {
            0.0
        };
        let block_rms = if mean_sq > 0.0 { mean_sq.sqrt() } else { 0.0 };

        // Apply ballistics to peak
        if block_peak >= self.peak_level {
            // Attack: fast rise
            self.peak_level += (block_peak - self.peak_level) * self.attack_coeff;
        } else {
            // Release: slow fall
            self.peak_level += (block_peak - self.peak_level) * self.release_coeff;
        }

        // Apply ballistics to RMS
        if block_rms >= self.rms_level {
            self.rms_level += (block_rms - self.rms_level) * self.attack_coeff;
        } else {
            self.rms_level += (block_rms - self.rms_level) * self.release_coeff;
        }

        // Peak hold logic
        if block_peak >= self.peak_hold {
            self.peak_hold = block_peak;
            self.peak_hold_frames = self.hold_duration_frames;
        } else if self.peak_hold_frames > 0 {
            self.peak_hold_frames -= 1;
        } else {
            // BUG-M2 FIX: Use release_coeff for hold decay instead of hardcoded 0.99.
            // The previous constant created a fixed ~300-block decay regardless of
            // sample rate or configured release speed, making the hold indicator
            // visually inconsistent with the peak meter's own release ballistic.
            self.peak_hold += (0.0 - self.peak_hold) * self.release_coeff;
        }

        // BUG-M3 FIX: Clipping detection based on instantaneous block peak,
        // not peak_hold. Previously is_clipping() checked peak_hold which
        // persists for hold_duration_frames + slow decay → clipping flag
        // stayed active for SECONDS after signal dropped below 1.0.
        self.clip_flag = block_peak > 1.0;
    }

    /// Returns the current peak level in dB.
    #[inline]
    pub fn peak_db(&self) -> f32 {
        linear_to_db(self.peak_level)
    }

    /// Returns the current RMS level in dB.
    #[inline]
    pub fn rms_db(&self) -> f32 {
        linear_to_db(self.rms_level)
    }

    /// Returns the peak hold level in dB.
    #[inline]
    pub fn peak_hold_db(&self) -> f32 {
        linear_to_db(self.peak_hold)
    }

    /// Returns the current peak level (linear 0.0–1.0+).
    #[inline]
    pub fn peak_linear(&self) -> f32 {
        self.peak_level
    }

    /// Returns the current RMS level (linear 0.0–1.0+).
    #[inline]
    pub fn rms_linear(&self) -> f32 {
        self.rms_level
    }

    /// Returns whether the signal is clipping (block peak > 1.0).
    #[inline]
    pub fn is_clipping(&self) -> bool {
        self.clip_flag
    }

    /// Resets all meter state.
    pub fn reset(&mut self) {
        self.peak_level = 0.0;
        self.rms_level = 0.0;
        self.peak_hold = 0.0;
        self.peak_hold_frames = 0;
        self.clip_flag = false;
    }
}

impl Default for VuMeter {
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

    fn sine_block(amplitude: f32, length: usize) -> Vec<f32> {
        (0..length)
            .map(|i| (i as f32 * std::f32::consts::TAU / 100.0).sin() * amplitude)
            .collect()
    }

    #[test]
    fn meter_starts_at_silence() {
        let meter = VuMeter::new();
        assert!(meter.peak_db() <= -120.0);
        assert!(meter.rms_db() <= -120.0);
    }

    #[test]
    fn meter_rises_on_loud_signal() {
        let mut meter = VuMeter::new();
        let block = sine_block(0.8, 512);

        meter.process(&block);

        assert!(meter.peak_linear() > 0.5);
        assert!(meter.rms_linear() > 0.1);
    }

    #[test]
    fn meter_falls_on_silence() {
        let mut meter = VuMeter::new();

        // Feed loud signal
        let loud = sine_block(1.0, 512);
        meter.process(&loud);
        let peak_after_loud = meter.peak_linear();

        // Feed silence — need many blocks due to slow release ballistics
        let silence = vec![0.0; 512];
        for _ in 0..500 {
            meter.process(&silence);
        }

        assert!(
            meter.peak_linear() < peak_after_loud * 0.1,
            "Meter should fall towards silence, got {}",
            meter.peak_linear(),
        );
    }

    #[test]
    fn peak_hold_persists() {
        let mut meter = VuMeter::new();
        let loud = sine_block(0.9, 512);
        meter.process(&loud);

        let hold_value = meter.peak_hold_db();

        // Feed moderate signal (lower than peak)
        let moderate = sine_block(0.2, 512);
        for _ in 0..5 {
            meter.process(&moderate);
        }

        // Peak hold should still be near the original peak
        assert!(
            meter.peak_hold_db() > hold_value - 1.0,
            "Peak hold should persist"
        );
    }

    #[test]
    fn clipping_detection() {
        let mut meter = VuMeter::new();
        let clipping = vec![1.5; 512]; // Over 1.0 = clipping
        meter.process(&clipping);

        assert!(meter.is_clipping());
    }

    #[test]
    fn reset_clears_state() {
        let mut meter = VuMeter::new();
        let loud = sine_block(1.0, 512);
        meter.process(&loud);

        meter.reset();

        assert!(meter.peak_linear() == 0.0);
        assert!(meter.rms_linear() == 0.0);
        assert!(!meter.is_clipping());
    }

    #[test]
    fn empty_buffer_is_noop() {
        let mut meter = VuMeter::new();
        meter.process(&[]);
        assert!(meter.peak_linear() == 0.0);
    }

    #[test]
    fn custom_ballistics() {
        let meter = VuMeter::with_ballistics(0.95, 0.01, 200);
        assert!((meter.attack_coeff - 0.95).abs() < 0.001);
        assert!((meter.release_coeff - 0.01).abs() < 0.001);
    }
}
