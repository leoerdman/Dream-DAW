// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — WAV Export Writer
// ═══════════════════════════════════════════════════════════════════════════
//
// Writes audio data to WAV files using the `hound` crate.
//
// Used for:
//   - Bounce/export (rendering the project to a stereo WAV)
//   - Recording capture (writing recorded audio to disk)
//   - Test utilities (creating test audio fixtures)
//
// ═══════════════════════════════════════════════════════════════════════════

use std::path::Path;

use hound::{SampleFormat, WavSpec};

/// Errors during WAV writing.
#[derive(Debug)]
pub enum WavWriterError {
    /// File I/O or hound error.
    WriteError(String),

    /// Invalid audio data.
    InvalidData(String),
}

impl std::fmt::Display for WavWriterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WriteError(e) => write!(f, "WAV write error: {e}"),
            Self::InvalidData(e) => write!(f, "Invalid audio data: {e}"),
        }
    }
}

impl std::error::Error for WavWriterError {}

/// WAV file writer for audio export.
pub struct WavWriter;

impl WavWriter {
    /// Writes interleaved f32 samples to a WAV file.
    ///
    /// # Arguments
    /// - `path`: Destination file path.
    /// - `samples`: Interleaved f32 audio data.
    /// - `sample_rate`: Output sample rate.
    /// - `channels`: Number of audio channels (1 = mono, 2 = stereo).
    /// - `bit_depth`: Output bit depth (16 or 24).
    pub fn write_interleaved(
        path: impl AsRef<Path>,
        samples: &[f32],
        sample_rate: u32,
        channels: u16,
        bit_depth: u16,
    ) -> Result<(), WavWriterError> {
        let spec = WavSpec {
            channels,
            sample_rate,
            bits_per_sample: bit_depth,
            sample_format: if bit_depth == 32 {
                SampleFormat::Float
            } else {
                SampleFormat::Int
            },
        };

        let mut writer = hound::WavWriter::create(path.as_ref(), spec)
            .map_err(|e| WavWriterError::WriteError(e.to_string()))?;

        match bit_depth {
            16 => {
                for &sample in samples {
                    let clamped = sample.clamp(-1.0, 1.0);
                    let int_sample = (clamped * i16::MAX as f32) as i16;
                    writer
                        .write_sample(int_sample)
                        .map_err(|e| WavWriterError::WriteError(e.to_string()))?;
                }
            }
            24 => {
                for &sample in samples {
                    let clamped = sample.clamp(-1.0, 1.0);
                    let int_sample = (clamped * 8_388_607.0) as i32; // 2^23 - 1
                    writer
                        .write_sample(int_sample)
                        .map_err(|e| WavWriterError::WriteError(e.to_string()))?;
                }
            }
            32 => {
                for &sample in samples {
                    writer
                        .write_sample(sample)
                        .map_err(|e| WavWriterError::WriteError(e.to_string()))?;
                }
            }
            _ => {
                return Err(WavWriterError::InvalidData(format!(
                    "Unsupported bit depth: {bit_depth}"
                )));
            }
        }

        writer
            .finalize()
            .map_err(|e| WavWriterError::WriteError(e.to_string()))?;

        let total_frames = samples.len() / channels as usize;
        log::info!(
            "WAV exported: {} — {}ch × {} frames @ {}Hz, {}bit",
            path.as_ref().display(),
            channels,
            total_frames,
            sample_rate,
            bit_depth,
        );

        Ok(())
    }

    /// Writes de-interleaved channel data to a WAV file.
    ///
    /// # Arguments
    /// - `path`: Destination file path.
    /// - `channels_data`: Per-channel audio data.
    /// - `sample_rate`: Output sample rate.
    /// - `bit_depth`: Output bit depth (16, 24, or 32).
    pub fn write_channels(
        path: impl AsRef<Path>,
        channels_data: &[&[f32]],
        sample_rate: u32,
        bit_depth: u16,
    ) -> Result<(), WavWriterError> {
        if channels_data.is_empty() {
            return Err(WavWriterError::InvalidData("No channels provided".into()));
        }

        let num_frames = channels_data[0].len();
        let num_channels = channels_data.len();

        // Verify all channels have the same length
        for (i, ch) in channels_data.iter().enumerate() {
            if ch.len() != num_frames {
                return Err(WavWriterError::InvalidData(format!(
                    "Channel {i} has {} frames, expected {num_frames}",
                    ch.len()
                )));
            }
        }

        // Interleave
        let mut interleaved = Vec::with_capacity(num_frames * num_channels);
        for frame in 0..num_frames {
            for ch in channels_data {
                interleaved.push(ch[frame]);
            }
        }

        Self::write_interleaved(
            path,
            &interleaved,
            sample_rate,
            num_channels as u16,
            bit_depth,
        )
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_wav(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("dream_daw_test_{name}.wav"))
    }

    fn sine_samples(freq: f32, sample_rate: f32, duration_secs: f32) -> Vec<f32> {
        let num_samples = (sample_rate * duration_secs) as usize;
        (0..num_samples)
            .map(|i| (i as f32 * freq * std::f32::consts::TAU / sample_rate).sin() * 0.5)
            .collect()
    }

    #[test]
    fn write_mono_16bit() {
        let path = temp_wav("mono_16");
        let samples = sine_samples(440.0, 44100.0, 0.1);

        WavWriter::write_interleaved(&path, &samples, 44100, 1, 16).unwrap();

        // Verify file was created and has content
        let metadata = std::fs::metadata(&path).unwrap();
        assert!(metadata.len() > 44); // WAV header is 44 bytes

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn write_stereo_24bit() {
        let path = temp_wav("stereo_24");
        let left = sine_samples(440.0, 44100.0, 0.1);
        let right = sine_samples(880.0, 44100.0, 0.1);

        WavWriter::write_channels(&path, &[&left, &right], 44100, 24).unwrap();

        let metadata = std::fs::metadata(&path).unwrap();
        assert!(metadata.len() > 44);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn write_32bit_float() {
        let path = temp_wav("float_32");
        let samples = sine_samples(440.0, 44100.0, 0.1);

        WavWriter::write_interleaved(&path, &samples, 44100, 1, 32).unwrap();

        let metadata = std::fs::metadata(&path).unwrap();
        assert!(metadata.len() > 44);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn unsupported_bit_depth_returns_error() {
        let path = temp_wav("bad_bits");
        let samples = vec![0.0; 100];

        let result = WavWriter::write_interleaved(&path, &samples, 44100, 1, 8);
        assert!(result.is_err());
    }

    #[test]
    fn empty_channels_returns_error() {
        let path = temp_wav("empty_ch");
        let result = WavWriter::write_channels(&path, &[], 44100, 16);
        assert!(result.is_err());
    }

    #[test]
    fn mismatched_channel_lengths_returns_error() {
        let path = temp_wav("mismatch");
        let left = vec![0.0; 100];
        let right = vec![0.0; 50];

        let result = WavWriter::write_channels(&path, &[&left, &right], 44100, 16);
        assert!(result.is_err());
    }
}
