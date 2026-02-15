// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — MP3 File Writer (LAME Encoder)
// ═══════════════════════════════════════════════════════════════════════════
//
// Enterprise-grade MP3 encoder for audio export.
//
// Uses the mp3lame-encoder crate (LAME bindings) to produce high-quality
// MP3 files from f32 PCM audio channels.
//
// Features:
//   - 320 kbps CBR stereo encoding (studio-grade)
//   - Configurable sample rate (44.1k / 48k / 96k)
//   - Streaming encoder with 4096-frame chunks
//   - Matches the WavWriter API for drop-in use in OfflineBouncer
//
// ═══════════════════════════════════════════════════════════════════════════

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use log::info;
use mp3lame_encoder::{Bitrate, Builder, DualPcm, FlushNoGap, Quality};

// ── Error Type ──────────────────────────────────────────────────────────

/// Errors during MP3 writing.
#[derive(Debug)]
pub enum Mp3WriterError {
    /// Encoder initialisation failure.
    EncoderInit(String),

    /// Encoding failure.
    EncodeError(String),

    /// File I/O failure.
    WriteError(String),

    /// Invalid audio data.
    InvalidData(String),
}

impl std::fmt::Display for Mp3WriterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EncoderInit(e) => write!(f, "MP3 encoder init error: {e}"),
            Self::EncodeError(e) => write!(f, "MP3 encode error: {e}"),
            Self::WriteError(e) => write!(f, "MP3 write error: {e}"),
            Self::InvalidData(e) => write!(f, "Invalid audio data: {e}"),
        }
    }
}

impl std::error::Error for Mp3WriterError {}

// ── Mp3Writer ────────────────────────────────────────────────────────────

/// MP3 file writer for audio export.
///
/// Mirrors `WavWriter::write_channels` for seamless use in the
/// `OfflineBouncer`, substituting the WAV backend with LAME MP3 encoding.
pub struct Mp3Writer;

/// Incremental MP3 writer for large offline renders.
pub struct StreamingMp3Writer {
    encoder: mp3lame_encoder::Encoder,
    writer: BufWriter<File>,
    path: PathBuf,
    sample_rate: u32,
    frames_written: usize,
}

/// Chunk size for feeding the encoder (frames per iteration).
const ENCODE_CHUNK_FRAMES: usize = 4096;

impl Mp3Writer {
    /// Creates a streaming MP3 writer.
    pub fn create_streaming(
        path: impl AsRef<Path>,
        sample_rate: u32,
    ) -> Result<StreamingMp3Writer, Mp3WriterError> {
        let mut mp3_encoder = Builder::new().ok_or_else(|| {
            Mp3WriterError::EncoderInit("Failed to create LAME builder".to_string())
        })?;

        mp3_encoder
            .set_num_channels(2)
            .map_err(|e| Mp3WriterError::EncoderInit(format!("set_num_channels: {e:?}")))?;

        mp3_encoder
            .set_sample_rate(sample_rate)
            .map_err(|e| Mp3WriterError::EncoderInit(format!("set_sample_rate: {e:?}")))?;

        mp3_encoder
            .set_brate(Bitrate::Kbps320)
            .map_err(|e| Mp3WriterError::EncoderInit(format!("set_brate: {e:?}")))?;

        mp3_encoder
            .set_quality(Quality::Best)
            .map_err(|e| Mp3WriterError::EncoderInit(format!("set_quality: {e:?}")))?;

        let encoder = mp3_encoder.build().map_err(|e| {
            Mp3WriterError::EncoderInit(format!("Failed to build LAME encoder: {e:?}"))
        })?;

        let path_buf = path.as_ref().to_path_buf();
        let file = File::create(&path_buf)
            .map_err(|e| Mp3WriterError::WriteError(format!("Failed to create MP3 file: {e}")))?;

        Ok(StreamingMp3Writer {
            encoder,
            writer: BufWriter::new(file),
            path: path_buf,
            sample_rate,
            frames_written: 0,
        })
    }

    /// Writes de-interleaved f32 channel data to an MP3 file.
    ///
    /// # Arguments
    /// - `path`: Destination file path (should end in `.mp3`).
    /// - `channels_data`: Per-channel f32 audio data (`[left, right]`).
    /// - `sample_rate`: Audio sample rate in Hz.
    ///
    /// # Notes
    /// - Encodes at 320 kbps CBR stereo with Quality::Best.
    /// - If `channels_data` has only one channel, it is duplicated to stereo.
    /// - Bit depth is not applicable — MP3 operates on PCM floats directly.
    pub fn write_channels(
        path: impl AsRef<Path>,
        channels_data: &[&[f32]],
        sample_rate: u32,
    ) -> Result<(), Mp3WriterError> {
        if channels_data.is_empty() {
            return Err(Mp3WriterError::InvalidData(
                "No channel data provided".to_string(),
            ));
        }

        let left = channels_data[0];
        let right = if channels_data.len() > 1 {
            channels_data[1]
        } else {
            left // mono → duplicate to stereo
        };

        if left.len() != right.len() {
            return Err(Mp3WriterError::InvalidData(
                "Left and right channel lengths do not match".to_string(),
            ));
        }

        let total_frames = left.len();
        if total_frames == 0 {
            return Err(Mp3WriterError::InvalidData("Empty audio data".to_string()));
        }

        info!(
            "[Mp3Writer] Encoding {} frames @ {}Hz → {}",
            total_frames,
            sample_rate,
            path.as_ref().display()
        );

        let mut stream = Self::create_streaming(path, sample_rate)?;
        let mut offset = 0usize;
        while offset < total_frames {
            let chunk_end = (offset + ENCODE_CHUNK_FRAMES).min(total_frames);
            stream.write_chunk(&left[offset..chunk_end], &right[offset..chunk_end])?;
            offset = chunk_end;
        }
        stream.finalize()
    }
}

impl StreamingMp3Writer {
    /// Encodes one stereo chunk.
    pub fn write_chunk(&mut self, left: &[f32], right: &[f32]) -> Result<(), Mp3WriterError> {
        if left.len() != right.len() {
            return Err(Mp3WriterError::InvalidData(
                "Left and right chunk lengths do not match".to_string(),
            ));
        }
        if left.is_empty() {
            return Ok(());
        }

        let input = DualPcm { left, right };
        let required = mp3lame_encoder::max_required_buffer_size(left.len());
        let mut out: Vec<u8> = Vec::with_capacity(required);
        let encoded_size = self
            .encoder
            .encode(input, out.spare_capacity_mut())
            .map_err(|e| Mp3WriterError::EncodeError(format!("encode chunk: {e:?}")))?;

        unsafe {
            out.set_len(encoded_size);
        }

        self.writer
            .write_all(&out)
            .map_err(|e| Mp3WriterError::WriteError(format!("write chunk: {e}")))?;
        self.frames_written += left.len();
        Ok(())
    }

    /// Flushes encoder and finalizes file.
    pub fn finalize(mut self) -> Result<(), Mp3WriterError> {
        let required = mp3lame_encoder::max_required_buffer_size(0);
        let mut out: Vec<u8> = Vec::with_capacity(required);
        let flush_size = self
            .encoder
            .flush::<FlushNoGap>(out.spare_capacity_mut())
            .map_err(|e| Mp3WriterError::EncodeError(format!("flush: {e:?}")))?;
        unsafe {
            out.set_len(flush_size);
        }
        self.writer
            .write_all(&out)
            .map_err(|e| Mp3WriterError::WriteError(format!("write flush: {e}")))?;
        self.writer
            .flush()
            .map_err(|e| Mp3WriterError::WriteError(format!("flush file: {e}")))?;

        info!(
            "[Mp3Writer] Complete(stream): {} ({:.1}s @ {}Hz)",
            self.path.display(),
            self.frames_written as f64 / self.sample_rate as f64,
            self.sample_rate
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

    fn sine_samples(freq: f32, sample_rate: f32, duration_secs: f32) -> Vec<f32> {
        let num_samples = (sample_rate * duration_secs) as usize;
        (0..num_samples)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / sample_rate).sin() * 0.5)
            .collect()
    }

    #[test]
    fn write_stereo_mp3() {
        let out_path = std::env::temp_dir().join("dream_mp3_test.mp3");
        let left = sine_samples(440.0, 44100.0, 0.5);
        let right = sine_samples(880.0, 44100.0, 0.5);

        let result = Mp3Writer::write_channels(&out_path, &[&left, &right], 44100);

        assert!(result.is_ok(), "MP3 write failed: {:?}", result.err());
        assert!(out_path.exists(), "MP3 file not created");

        let metadata = std::fs::metadata(&out_path).unwrap();
        assert!(metadata.len() > 0, "MP3 file is empty");

        let _ = std::fs::remove_file(&out_path);
    }

    #[test]
    fn write_mono_mp3() {
        let out_path = std::env::temp_dir().join("dream_mp3_mono_test.mp3");
        let mono = sine_samples(440.0, 48000.0, 0.2);

        let result = Mp3Writer::write_channels(&out_path, &[&mono], 48000);

        assert!(result.is_ok(), "Mono MP3 write failed: {:?}", result.err());
        assert!(out_path.exists());

        let _ = std::fs::remove_file(&out_path);
    }

    #[test]
    fn empty_channels_returns_error() {
        let out_path = std::env::temp_dir().join("dream_mp3_empty_test.mp3");
        let result = Mp3Writer::write_channels(&out_path, &[], 44100);
        assert!(matches!(result, Err(Mp3WriterError::InvalidData(_))));
    }

    #[test]
    fn mismatched_lengths_returns_error() {
        let left = vec![0.0f32; 100];
        let right = vec![0.0f32; 200];
        let out_path = std::env::temp_dir().join("dream_mp3_mismatch_test.mp3");

        let result = Mp3Writer::write_channels(&out_path, &[&left, &right], 44100);
        assert!(matches!(result, Err(Mp3WriterError::InvalidData(_))));
    }
}
