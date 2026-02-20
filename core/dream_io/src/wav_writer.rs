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

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

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

/// BUG-067 FIX: Enable ergonomic `?` operator with hound errors.
impl From<hound::Error> for WavWriterError {
    fn from(err: hound::Error) -> Self {
        WavWriterError::WriteError(err.to_string())
    }
}

/// Simple XorShift PRNG for Triangular Probability Density Function (TPDF) dithering.
struct TpdfDither {
    state: u32,
}

impl TpdfDither {
    fn new() -> Self {
        Self { state: 0x82f63b78 } // Arbitrary non-zero seed
    }

    #[inline(always)]
    fn next_f32(&mut self) -> f32 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.state = x;
        (x as f32) / (u32::MAX as f32)
    }

    /// Returns a TPDF random value in the range [-1.0, 1.0].
    #[inline(always)]
    fn dither(&mut self) -> f32 {
        self.next_f32() - self.next_f32()
    }
}

/// WAV file writer for audio export.
pub struct WavWriter;

/// Incremental WAV writer for large offline renders.
///
/// Allows writing interleaved chunks without keeping the entire render in memory.
///
/// BUG-069 FIX: Implements `Drop` to finalize the WAV header on scope exit,
/// preventing corrupted files on panics or early returns.
pub struct StreamingWavWriter {
    writer: Option<hound::WavWriter<BufWriter<File>>>,
    path: PathBuf,
    channels: u16,
    sample_rate: u32,
    bit_depth: u16,
    frames_written: usize,
    /// BUG-073 FIX: State for PRNG used for TPDF dithering across chunks.
    dither: TpdfDither,
}

/// BUG-069 FIX: Finalize WAV header on drop to prevent corrupted files.
impl Drop for StreamingWavWriter {
    fn drop(&mut self) {
        if let Some(writer) = self.writer.take() {
            if let Err(e) = writer.finalize() {
                log::error!("[StreamingWavWriter] failed to finalize {}: {}", self.path.display(), e);
            }
        }
    }
}

impl WavWriter {
    /// Creates a streaming WAV writer for chunked output.
    pub fn create_streaming(
        path: impl AsRef<Path>,
        sample_rate: u32,
        channels: u16,
        bit_depth: u16,
    ) -> Result<StreamingWavWriter, WavWriterError> {
        if channels == 0 {
            return Err(WavWriterError::InvalidData("channels must be > 0".into()));
        }
        if bit_depth != 16 && bit_depth != 24 && bit_depth != 32 {
            return Err(WavWriterError::InvalidData(format!(
                "Unsupported bit depth: {bit_depth}"
            )));
        }

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

        let path_buf = path.as_ref().to_path_buf();
        let writer = hound::WavWriter::create(&path_buf, spec)
            .map_err(|e| WavWriterError::WriteError(e.to_string()))?;

        Ok(StreamingWavWriter {
            writer: Some(writer),
            path: path_buf,
            channels,
            sample_rate,
            bit_depth,
            frames_written: 0,
            dither: TpdfDither::new(),
        })
    }

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
                let mut dither = TpdfDither::new();
                for &sample in samples {
                    let val = (sample * 32767.0) + dither.dither();
                    let int_sample = val.clamp(i16::MIN as f32, i16::MAX as f32).round() as i16;
                    writer
                        .write_sample(int_sample)
                        .map_err(|e| WavWriterError::WriteError(e.to_string()))?;
                }
            }
            24 => {
                let mut dither = TpdfDither::new();
                for &sample in samples {
                    let val = (sample * 8_388_607.0) + dither.dither();
                    let int_sample = val.clamp(-8_388_608.0, 8_388_607.0).round() as i32;
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

impl StreamingWavWriter {
    /// Writes one interleaved chunk (`[L, R, L, R, ...]`).
    pub fn write_interleaved_chunk(&mut self, samples: &[f32]) -> Result<(), WavWriterError> {
        if samples.len() % self.channels as usize != 0 {
            return Err(WavWriterError::InvalidData(format!(
                "Chunk length {} is not divisible by channels {}",
                samples.len(),
                self.channels
            )));
        }

        let writer = self.writer.as_mut()
            .ok_or_else(|| WavWriterError::WriteError("Writer already finalized".into()))?;

        match self.bit_depth {
            16 => {
                for &sample in samples {
                    let val = (sample * 32767.0) + self.dither.dither();
                    let int_sample = val.clamp(i16::MIN as f32, i16::MAX as f32).round() as i16;
                    writer
                        .write_sample(int_sample)
                        .map_err(|e| WavWriterError::WriteError(e.to_string()))?;
                }
            }
            24 => {
                for &sample in samples {
                    let val = (sample * 8_388_607.0) + self.dither.dither();
                    let int_sample = val.clamp(-8_388_608.0, 8_388_607.0).round() as i32;
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
                    "Unsupported bit depth: {}",
                    self.bit_depth
                )));
            }
        }

        self.frames_written += samples.len() / self.channels as usize;
        Ok(())
    }

    /// Finalizes the file and flushes headers.
    ///
    /// After calling this, the Drop impl will be a no-op.
    pub fn finalize(mut self) -> Result<(), WavWriterError> {
        let writer = self.writer.take()
            .ok_or_else(|| WavWriterError::WriteError("Writer already finalized".into()))?;
        writer
            .finalize()
            .map_err(|e| WavWriterError::WriteError(e.to_string()))?;
        log::debug!(
            "WAV exported (stream): {} — {}ch × {} frames @ {}Hz, {}bit",
            self.path.display(),
            self.channels,
            self.frames_written,
            self.sample_rate,
            self.bit_depth,
        );
        Ok(())
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
