// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Waveform Peak Cache
// ═══════════════════════════════════════════════════════════════════════════
//
// Generates and caches waveform peak data at multiple zoom levels
// for the WebGPU timeline renderer.
//
// The peak cache uses a mip-map strategy:
//   Level 0: 1 peak per 256 samples
//   Level 1: 1 peak per 1024 samples
//   Level 2: 1 peak per 4096 samples
//   Level 3: 1 peak per 16384 samples
//
// Each level stores min/max pairs for accurate visualization.
//
// ═══════════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};

/// Samples-per-peak at each mip level.
const MIP_FACTORS: [usize; 4] = [256, 1024, 4096, 16384];

/// Number of mip levels.
const NUM_MIP_LEVELS: usize = MIP_FACTORS.len();

/// A single min/max peak pair.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PeakPair {
    pub min: f32,
    pub max: f32,
}

impl PeakPair {
    /// Returns the absolute amplitude (for single-value rendering).
    pub fn amplitude(&self) -> f32 {
        self.max.abs().max(self.min.abs())
    }
}

/// Waveform peak data at a single mip level.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeakMipLevel {
    /// Samples per peak at this level.
    pub samples_per_peak: usize,

    /// Min/max peak pairs.
    pub peaks: Vec<PeakPair>,
}

/// Multi-resolution waveform peak data for a single audio file.
///
/// Contains 4 mip levels for efficient rendering at different zoom levels.
/// The renderer picks the mip level closest to the current
/// `samples_per_pixel` to avoid aliasing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaveformPeaks {
    /// Source file identifier (typically the file path hash or UUID).
    pub source_id: String,

    /// Sample rate of the source audio.
    pub sample_rate: u32,

    /// Total number of samples in the source.
    pub total_samples: usize,

    /// Mip levels, from finest (level 0) to coarsest.
    pub mip_levels: Vec<PeakMipLevel>,
}

/// Generates and caches waveform peaks.
pub struct PeakCache;

impl PeakCache {
    /// Generates multi-resolution peak data from raw audio samples.
    ///
    /// # Arguments
    /// - `samples`: Mono f32 audio data (use `AudioBuffer::to_mono()` first).
    /// - `source_id`: Identifier for cache lookup.
    /// - `sample_rate`: Source sample rate.
    ///
    /// # Returns
    /// `WaveformPeaks` with 4 mip levels.
    pub fn generate(samples: &[f32], source_id: &str, sample_rate: u32) -> WaveformPeaks {
        let total_samples = samples.len();

        let mip_levels: Vec<PeakMipLevel> = MIP_FACTORS
            .iter()
            .map(|&spp| {
                let peaks = Self::compute_peaks(samples, spp);
                PeakMipLevel {
                    samples_per_peak: spp,
                    peaks,
                }
            })
            .collect();

        log::info!(
            "Peak cache generated for '{}': {} samples → {} levels ({}/{}/{}/{} peaks)",
            source_id,
            total_samples,
            NUM_MIP_LEVELS,
            mip_levels[0].peaks.len(),
            mip_levels[1].peaks.len(),
            mip_levels[2].peaks.len(),
            mip_levels[3].peaks.len(),
        );

        WaveformPeaks {
            source_id: source_id.to_string(),
            sample_rate,
            total_samples,
            mip_levels,
        }
    }

    /// Computes peaks at a given samples-per-peak resolution.
    fn compute_peaks(samples: &[f32], samples_per_peak: usize) -> Vec<PeakPair> {
        if samples.is_empty() || samples_per_peak == 0 {
            return Vec::new();
        }

        samples
            .chunks(samples_per_peak)
            .map(|chunk| {
                let mut min = f32::MAX;
                let mut max = f32::MIN;
                for &s in chunk {
                    if s < min {
                        min = s;
                    }
                    if s > max {
                        max = s;
                    }
                }
                PeakPair { min, max }
            })
            .collect()
    }

    /// Selects the best mip level for the given samples-per-pixel.
    ///
    /// Returns the index of the mip level whose `samples_per_peak`
    /// is closest to (but not exceeding) the current SPP.
    /// Falls back to the finest level if SPP is very small.
    pub fn best_mip_level(samples_per_pixel: f64) -> usize {
        for (i, &spp) in MIP_FACTORS.iter().enumerate().rev() {
            if samples_per_pixel >= spp as f64 {
                return i;
            }
        }
        0 // Finest level
    }

    /// Extracts a flat f32 array of peak amplitudes for GPU upload.
    ///
    /// This is the format expected by `WaveformPeakBuffer::push_peaks()`.
    /// Returns amplitudes (0.0–1.0) for the given mip level.
    pub fn extract_amplitudes(peaks: &WaveformPeaks, mip_level: usize) -> Vec<f32> {
        let level = &peaks.mip_levels[mip_level.min(peaks.mip_levels.len() - 1)];
        level.peaks.iter().map(|p| p.amplitude()).collect()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn test_sine(length: usize) -> Vec<f32> {
        (0..length)
            .map(|i| (i as f32 * std::f32::consts::TAU / 100.0).sin())
            .collect()
    }

    #[test]
    fn peak_generation_produces_all_mip_levels() {
        let samples = test_sine(44100);
        let peaks = PeakCache::generate(&samples, "test", 44100);

        assert_eq!(peaks.mip_levels.len(), 4);
        assert_eq!(peaks.total_samples, 44100);
        assert_eq!(peaks.sample_rate, 44100);
    }

    #[test]
    fn mip_level_0_has_correct_count() {
        let samples = test_sine(44100);
        let peaks = PeakCache::generate(&samples, "test", 44100);

        let expected = (44100 + 255) / 256; // ceiling division
        assert_eq!(peaks.mip_levels[0].peaks.len(), expected);
    }

    #[test]
    fn coarser_levels_have_fewer_peaks() {
        let samples = test_sine(100_000);
        let peaks = PeakCache::generate(&samples, "test", 44100);

        for i in 1..peaks.mip_levels.len() {
            assert!(
                peaks.mip_levels[i].peaks.len() <= peaks.mip_levels[i - 1].peaks.len(),
                "Level {} should have fewer peaks than level {}",
                i,
                i - 1,
            );
        }
    }

    #[test]
    fn peak_pair_amplitude() {
        let p = PeakPair {
            min: -0.8,
            max: 0.5,
        };
        assert!((p.amplitude() - 0.8).abs() < 0.001);
    }

    #[test]
    fn best_mip_level_selection() {
        assert_eq!(PeakCache::best_mip_level(100.0), 0); // Very zoomed in
        assert_eq!(PeakCache::best_mip_level(256.0), 0); // Exact match level 0
        assert_eq!(PeakCache::best_mip_level(1024.0), 1);
        assert_eq!(PeakCache::best_mip_level(5000.0), 2);
        assert_eq!(PeakCache::best_mip_level(20000.0), 3);
    }

    #[test]
    fn extract_amplitudes_has_correct_length() {
        let samples = test_sine(44100);
        let peaks = PeakCache::generate(&samples, "test", 44100);

        let amps = PeakCache::extract_amplitudes(&peaks, 0);
        assert_eq!(amps.len(), peaks.mip_levels[0].peaks.len());

        // All amplitudes should be 0.0–1.0
        for &a in &amps {
            assert!(a >= 0.0 && a <= 1.0, "Amplitude {a} out of range");
        }
    }

    #[test]
    fn empty_input_produces_empty_peaks() {
        let peaks = PeakCache::generate(&[], "empty", 44100);
        assert_eq!(peaks.total_samples, 0);
        for level in &peaks.mip_levels {
            assert!(level.peaks.is_empty());
        }
    }

    #[test]
    fn peak_serialization_roundtrip() {
        let samples = test_sine(4096);
        let peaks = PeakCache::generate(&samples, "roundtrip", 44100);

        let json = serde_json::to_string(&peaks).unwrap();
        let restored: WaveformPeaks = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.source_id, "roundtrip");
        assert_eq!(restored.mip_levels.len(), 4);
        assert_eq!(
            restored.mip_levels[0].peaks.len(),
            peaks.mip_levels[0].peaks.len()
        );
    }
}
