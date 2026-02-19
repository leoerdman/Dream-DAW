//! ── Real-Time Spectrum Analyzer (Enterprise) ──────────────────────────────
//!
//! Lock-free ring-buffer FFT for real-time EQ spectrum display.
//! Architecture:
//!   1. `SpectrumAnalyzer::push()` — called from the audio thread, pushes samples
//!      into a lock-free ring buffer (no allocation, no locking).
//!   2. `SpectrumAnalyzer::compute()` — called from a background thread, runs FFT
//!      on the accumulated samples, applies Hann window + smoothing.
//!   3. Result is a `SpectrumData` with magnitude values in dB across frequency bins.
//!
//! The analyzer is designed for the EQ display and uses a 4096-sample FFT window
//! for ~1Hz resolution at 44.1kHz. A Hann window is applied to reduce spectral leakage.

use rustfft::{num_complex::Complex, FftPlanner};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Number of FFT bins (power of 2 for optimal FFT performance)
pub const FFT_SIZE: usize = 4096;

/// Number of output magnitude bins sent to the frontend.
/// We downsample the raw FFT bins to this count for efficient transfer.
pub const OUTPUT_BINS: usize = 256;

/// Smoothing factor for exponential moving average (0.0 = no smoothing, 1.0 = frozen)
const SMOOTHING: f32 = 0.7;

/// Floor dB value for very quiet signals
pub const FLOOR_DB: f32 = -120.0;

/// Spectrum data snapshot — sent to the frontend via Tauri events
#[derive(Clone)]
pub struct SpectrumData {
    /// Magnitude values in dB, one per output bin
    pub magnitudes: [f32; OUTPUT_BINS],
    /// Frequency of each bin center (Hz)
    pub frequencies: [f32; OUTPUT_BINS],
    /// Sequence number for ordering / freshness checks
    pub sequence: u64,
}

impl Default for SpectrumData {
    fn default() -> Self {
        Self {
            magnitudes: [FLOOR_DB; OUTPUT_BINS],
            frequencies: [0.0; OUTPUT_BINS],
            sequence: 0,
        }
    }
}

/// Lock-free spectrum analyzer using a ring buffer and FFT
pub struct SpectrumAnalyzer {
    /// Ring buffer for audio samples (single-producer, single-consumer pattern)
    ring: Box<[f32; FFT_SIZE]>,
    /// Write position in ring buffer (only modified by audio thread)
    write_pos: usize,
    /// Flag indicating new samples are available
    has_new_data: AtomicBool,
    /// FFT planner (cached for efficiency)
    fft_scratch: Vec<Complex<f32>>,
    fft_buffer: Vec<Complex<f32>>,
    /// Hann window coefficients (precomputed)
    hann_window: Box<[f32; FFT_SIZE]>,
    /// Smoothed output magnitudes
    smoothed: [f32; OUTPUT_BINS],
    /// Sample rate for frequency bin calculation
    sample_rate: f32,
    /// Sequence counter
    sequence: AtomicU64,
    /// Cached FFT plan
    fft_plan: std::sync::Arc<dyn rustfft::Fft<f32>>,
}

impl SpectrumAnalyzer {
    /// Create a new spectrum analyzer for the given sample rate
    pub fn new(sample_rate: f32) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft_plan = planner.plan_fft_forward(FFT_SIZE);
        let scratch_len = fft_plan.get_inplace_scratch_len();

        // Precompute Hann window
        let mut hann_window = Box::new([0.0f32; FFT_SIZE]);
        for i in 0..FFT_SIZE {
            hann_window[i] = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE - 1) as f32).cos());
        }

        Self {
            ring: Box::new([0.0f32; FFT_SIZE]),
            write_pos: 0,
            has_new_data: AtomicBool::new(false),
            fft_scratch: vec![Complex::default(); scratch_len],
            fft_buffer: vec![Complex::default(); FFT_SIZE],
            hann_window,
            smoothed: [FLOOR_DB; OUTPUT_BINS],
            sample_rate,
            sequence: AtomicU64::new(0),
            fft_plan,
        }
    }

    /// Push audio samples into the ring buffer.
    /// **Called from the audio thread** — must be lock-free and allocation-free.
    #[inline]
    pub fn push(&mut self, samples: &[f32]) {
        for &s in samples {
            self.ring[self.write_pos] = s;
            self.write_pos = (self.write_pos + 1) % FFT_SIZE;
        }
        self.has_new_data.store(true, Ordering::Release);
    }

    /// Push interleaved stereo samples, mixing to mono.
    /// **Called from the audio thread** — lock-free.
    #[inline]
    pub fn push_stereo_interleaved(&mut self, samples: &[f32]) {
        let pairs = samples.len() / 2;
        for i in 0..pairs {
            let mono = (samples[i * 2] + samples[i * 2 + 1]) * 0.5;
            self.ring[self.write_pos] = mono;
            self.write_pos = (self.write_pos + 1) % FFT_SIZE;
        }
        self.has_new_data.store(true, Ordering::Release);
    }

    /// Compute the FFT and return a smoothed spectrum snapshot.
    /// **Called from a background thread** — may allocate, may block briefly.
    /// Returns `None` if no new data since last compute.
    pub fn compute(&mut self) -> Option<SpectrumData> {
        if !self.has_new_data.swap(false, Ordering::AcqRel) {
            return None;
        }

        // Copy ring buffer into FFT buffer with Hann window applied
        // Read starting from write_pos (oldest sample) to get correct time order
        for i in 0..FFT_SIZE {
            let ring_idx = (self.write_pos + i) % FFT_SIZE;
            self.fft_buffer[i] = Complex {
                re: self.ring[ring_idx] * self.hann_window[i],
                im: 0.0,
            };
        }

        // Run FFT in-place
        self.fft_plan.process_with_scratch(&mut self.fft_buffer, &mut self.fft_scratch);

        // Convert to magnitude in dB, downsample to OUTPUT_BINS
        // Only use first half of FFT (positive frequencies)
        let half = FFT_SIZE / 2;
        let bin_freq_step = self.sample_rate / FFT_SIZE as f32;

        let mut data = SpectrumData::default();

        // Map FFT bins to output bins using logarithmic frequency mapping
        // This gives more resolution to lower frequencies (matching EQ display)
        let min_freq = 20.0_f32;
        let max_freq = (self.sample_rate / 2.0).min(20000.0);
        let log_min = min_freq.ln();
        let log_max = max_freq.ln();

        for i in 0..OUTPUT_BINS {
            // Logarithmic frequency for this output bin
            let t = i as f32 / (OUTPUT_BINS - 1) as f32;
            let freq = (log_min + t * (log_max - log_min)).exp();
            data.frequencies[i] = freq;

            // Find the corresponding FFT bin
            let fft_bin_f = freq / bin_freq_step;
            let fft_bin = (fft_bin_f as usize).min(half - 1);

            // Magnitude: |X[k]| / N, then convert to dB
            let mag = self.fft_buffer[fft_bin].norm() / FFT_SIZE as f32;
            let db = if mag > 1e-10 {
                20.0 * mag.log10()
            } else {
                FLOOR_DB
            };

            // Exponential smoothing
            self.smoothed[i] = SMOOTHING * self.smoothed[i] + (1.0 - SMOOTHING) * db;
            data.magnitudes[i] = self.smoothed[i];
        }

        let seq = self.sequence.fetch_add(1, Ordering::Relaxed);
        data.sequence = seq + 1;

        Some(data)
    }

    /// Update the sample rate (e.g., when project settings change)
    pub fn set_sample_rate(&mut self, sr: f32) {
        self.sample_rate = sr;
    }

    /// Reset the analyzer state (clear ring buffer and smoothed values)
    pub fn reset(&mut self) {
        self.ring.fill(0.0);
        self.write_pos = 0;
        self.smoothed.fill(FLOOR_DB);
        self.has_new_data.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spectrum_analyzer_basic() {
        let mut analyzer = SpectrumAnalyzer::new(44100.0);

        // Push a sine wave at 1kHz
        let freq = 1000.0;
        let sr = 44100.0;
        let samples: Vec<f32> = (0..FFT_SIZE)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / sr).sin())
            .collect();

        analyzer.push(&samples);
        let data = analyzer.compute();
        assert!(data.is_some());

        let data = data.unwrap();
        // Find the bin with the maximum magnitude
        let max_bin = data.magnitudes.iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap();

        // The peak should be near 1kHz
        let peak_freq = data.frequencies[max_bin.0];
        assert!(peak_freq > 800.0 && peak_freq < 1200.0,
            "Peak frequency {peak_freq} should be near 1000 Hz");
    }

    #[test]
    fn test_no_data_returns_none() {
        let mut analyzer = SpectrumAnalyzer::new(44100.0);
        assert!(analyzer.compute().is_none());
    }

    #[test]
    fn test_stereo_push() {
        let mut analyzer = SpectrumAnalyzer::new(44100.0);
        let stereo: Vec<f32> = (0..FFT_SIZE * 2).map(|i| (i as f32 * 0.001).sin()).collect();
        analyzer.push_stereo_interleaved(&stereo);
        assert!(analyzer.compute().is_some());
    }
}
