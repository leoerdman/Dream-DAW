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

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use bytemuck::{Pod, Zeroable};
use serde::{Deserialize, Serialize};

/// Samples-per-peak at each mip level.
const MIP_FACTORS: [usize; 4] = [256, 1024, 4096, 16384];

/// Number of mip levels.
const NUM_MIP_LEVELS: usize = MIP_FACTORS.len();
const PEAK_CACHE_MAGIC: [u8; 4] = *b"DPK1";
const PEAK_CACHE_VERSION: u32 = 1;

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

/// Binary waveform peak pair (`min`, `max`) for zero-copy IPC / cache IO.
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct WaveformPeakPair {
    pub min: f32,
    pub max: f32,
}

// BUG-019 FIX: repr(C) for stable layout + future zero-copy potential.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct PeakCacheHeader {
    magic: [u8; 4],
    version: u32,
    sample_rate: u32,
    level_count: u32,
    total_samples: u64,
}

// BUG-019 FIX: repr(C) for stable layout + future zero-copy potential.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct PeakCacheLevelIndex {
    samples_per_peak: u32,
    peak_count: u64,
    peak_offset_pairs: u64,
}

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

        log::debug!(
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
                // BUG-070 FIX: INFINITY handles NaN samples correctly.
                let mut min = f32::INFINITY;
                let mut max = f32::NEG_INFINITY;
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

    /// Returns sidecar `.peaks` path for a source audio file.
    ///
    /// Example:
    /// - `/path/kick.wav` -> `/path/kick.wav.peaks`
    pub fn sidecar_path_for(source_path: &Path) -> PathBuf {
        let mut out = source_path.to_path_buf();
        let ext = source_path
            .extension()
            .and_then(|e| e.to_str())
            .filter(|e| !e.is_empty())
            .map(|e| format!("{e}.peaks"))
            .unwrap_or_else(|| "peaks".to_string());
        out.set_extension(ext);
        out
    }

    /// Generates peaks and persists sidecar cache next to source file.
    pub fn generate_to_sidecar(
        samples: &[f32],
        source_path: &Path,
        sample_rate: u32,
    ) -> io::Result<WaveformPeaks> {
        let source_id = source_path.to_string_lossy().to_string();
        let peaks = Self::generate(samples, &source_id, sample_rate);
        let _ = Self::save_to_sidecar(&peaks, source_path)?;
        Ok(peaks)
    }

    /// Saves a `.peaks` binary cache sidecar.
    pub fn save_to_sidecar(peaks: &WaveformPeaks, source_path: &Path) -> io::Result<PathBuf> {
        let sidecar = Self::sidecar_path_for(source_path);
        let mut indices = Vec::<PeakCacheLevelIndex>::with_capacity(peaks.mip_levels.len());
        let mut flat_pairs = Vec::<WaveformPeakPair>::new();

        for level in &peaks.mip_levels {
            let offset_pairs = flat_pairs.len() as u64;
            let peak_count = level.peaks.len() as u64;
            indices.push(PeakCacheLevelIndex {
                samples_per_peak: level.samples_per_peak as u32,
                peak_count,
                peak_offset_pairs: offset_pairs,
            });
            flat_pairs.extend(level.peaks.iter().map(|p| WaveformPeakPair {
                min: p.min,
                max: p.max,
            }));
        }

        let header = PeakCacheHeader {
            magic: PEAK_CACHE_MAGIC,
            version: PEAK_CACHE_VERSION,
            sample_rate: peaks.sample_rate,
            level_count: indices.len() as u32,
            total_samples: peaks.total_samples as u64,
        };

        let mut bytes = Vec::<u8>::with_capacity(
            24 + indices.len() * 20 + flat_pairs.len() * std::mem::size_of::<WaveformPeakPair>(),
        );
        bytes.extend_from_slice(&header.magic);
        bytes.extend_from_slice(&header.version.to_le_bytes());
        bytes.extend_from_slice(&header.sample_rate.to_le_bytes());
        bytes.extend_from_slice(&header.level_count.to_le_bytes());
        bytes.extend_from_slice(&header.total_samples.to_le_bytes());
        for idx in &indices {
            bytes.extend_from_slice(&idx.samples_per_peak.to_le_bytes());
            bytes.extend_from_slice(&idx.peak_count.to_le_bytes());
            bytes.extend_from_slice(&idx.peak_offset_pairs.to_le_bytes());
        }
        bytes.extend_from_slice(bytemuck::cast_slice(flat_pairs.as_slice()));

        fs::write(&sidecar, bytes)?;
        Ok(sidecar)
    }

    /// Loads peaks from `.peaks` sidecar.
    pub fn load_from_sidecar(source_path: &Path) -> io::Result<WaveformPeaks> {
        let sidecar = Self::sidecar_path_for(source_path);
        let bytes = fs::read(&sidecar)?;

        let header_size = 24;
        if bytes.len() < header_size {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "peak cache header too small",
            ));
        }

        let header = PeakCacheHeader {
            magic: [bytes[0], bytes[1], bytes[2], bytes[3]],
            version: u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
            sample_rate: u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]),
            level_count: u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]),
            total_samples: u64::from_le_bytes([
                bytes[16], bytes[17], bytes[18], bytes[19], bytes[20], bytes[21], bytes[22],
                bytes[23],
            ]),
        };
        if header.magic != PEAK_CACHE_MAGIC || header.version != PEAK_CACHE_VERSION {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "peak cache header mismatch",
            ));
        }

        let levels = header.level_count as usize;
        // BUG-020 FIX: Use computed constant instead of magic number.
        // PeakCacheLevelIndex = u32 (4) + u64 (8) + u64 (8) = 20 bytes
        const PEAK_LEVEL_INDEX_BYTE_SIZE: usize = std::mem::size_of::<u32>() + std::mem::size_of::<u64>() * 2;
        let idx_size = PEAK_LEVEL_INDEX_BYTE_SIZE;
        let idx_bytes_len = levels
            .checked_mul(idx_size)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "peak index overflow"))?;
        let idx_start = header_size;
        let idx_end = idx_start + idx_bytes_len;
        if bytes.len() < idx_end {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "peak cache index truncated",
            ));
        }

        let mut indices = Vec::<PeakCacheLevelIndex>::with_capacity(levels);
        for chunk in bytes[idx_start..idx_end].chunks_exact(idx_size) {
            indices.push(PeakCacheLevelIndex {
                samples_per_peak: u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]),
                peak_count: u64::from_le_bytes([
                    chunk[4], chunk[5], chunk[6], chunk[7], chunk[8], chunk[9], chunk[10],
                    chunk[11],
                ]),
                peak_offset_pairs: u64::from_le_bytes([
                    chunk[12], chunk[13], chunk[14], chunk[15], chunk[16], chunk[17], chunk[18],
                    chunk[19],
                ]),
            });
        }

        // BUG-052 FIX: Validate all samples_per_peak values are non-zero
        // to prevent division-by-zero with corrupted cache files.
        for idx in &indices {
            if idx.samples_per_peak == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "peak cache level has samples_per_peak=0",
                ));
            }
        }

        let pair_size = std::mem::size_of::<WaveformPeakPair>();
        let data = &bytes[idx_end..];
        if data.len() % pair_size != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "peak cache data alignment invalid",
            ));
        }
        let total_pairs = data.len() / pair_size;

        let mut mip_levels = Vec::<PeakMipLevel>::with_capacity(indices.len());
        for idx in indices {
            let start = idx.peak_offset_pairs as usize;
            let count = idx.peak_count as usize;
            let end = start.saturating_add(count);
            if end > total_pairs {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "peak cache pair range out of bounds",
                ));
            }

            let mut peaks = Vec::<PeakPair>::with_capacity(count);
            for pair_idx in start..end {
                let off = pair_idx * pair_size;
                let pair: WaveformPeakPair =
                    bytemuck::pod_read_unaligned(&data[off..off + pair_size]);
                peaks.push(PeakPair {
                    min: pair.min,
                    max: pair.max,
                });
            }

            mip_levels.push(PeakMipLevel {
                samples_per_peak: idx.samples_per_peak as usize,
                peaks,
            });
        }

        Ok(WaveformPeaks {
            source_id: source_path.to_string_lossy().to_string(),
            sample_rate: header.sample_rate,
            total_samples: header.total_samples as usize,
            mip_levels,
        })
    }

    /// Returns raw little-endian bytes for a single LOD level as
    /// contiguous `WaveformPeakPair` array.
    pub fn lod_level_bytes(peaks: &WaveformPeaks, lod_level: usize) -> Vec<u8> {
        if peaks.mip_levels.is_empty() {
            return Vec::new();
        }
        let level = &peaks.mip_levels[lod_level.min(peaks.mip_levels.len() - 1)];
        let pairs: Vec<WaveformPeakPair> = level
            .peaks
            .iter()
            .map(|p| WaveformPeakPair {
                min: p.min,
                max: p.max,
            })
            .collect();
        bytemuck::cast_slice(pairs.as_slice()).to_vec()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

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

        let expected = 44100_usize.div_ceil(256); // ceiling division
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
            assert!((0.0..=1.0).contains(&a), "Amplitude {a} out of range");
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

    #[test]
    fn sidecar_roundtrip_and_lod_bytes() {
        let samples = test_sine(8192);
        let peaks = PeakCache::generate(&samples, "roundtrip", 44100);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("dream_peak_cache_test_{ts}.wav"));

        let sidecar = PeakCache::save_to_sidecar(&peaks, &path).unwrap();
        let loaded = PeakCache::load_from_sidecar(&path).unwrap();

        assert_eq!(loaded.sample_rate, peaks.sample_rate);
        assert_eq!(loaded.total_samples, peaks.total_samples);
        assert_eq!(loaded.mip_levels.len(), peaks.mip_levels.len());

        let lod_bytes = PeakCache::lod_level_bytes(&loaded, 0);
        assert!(!lod_bytes.is_empty());
        assert_eq!(lod_bytes.len() % std::mem::size_of::<WaveformPeakPair>(), 0);

        let _ = std::fs::remove_file(sidecar);
    }
}
