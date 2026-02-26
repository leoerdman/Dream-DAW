// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Audio File Reader (symphonia)
// ═══════════════════════════════════════════════════════════════════════════
//
// Decodes audio files into raw f32 sample buffers.
//
// Supported formats (via symphonia):
//   WAV, FLAC, OGG/Vorbis, MP3, AIFF, AAC, ALAC
//
// Design:
//   - All decoding is NON-REAL-TIME (called from UI/worker thread)
//   - Returns AudioBuffer containing interleaved f32 samples
//   - Automatically handles sample format conversion (i16/i32/f32/f64)
//
// ═══════════════════════════════════════════════════════════════════════════

use std::fs::File;
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Decoded audio data stored as de-interleaved f32 channels.
#[derive(Debug, Clone)]
pub struct AudioBuffer {
    /// De-interleaved channel data. `channels[0]` = left, `channels[1]` = right, etc.
    pub channels: Vec<Vec<f32>>,

    /// Sample rate of the decoded audio.
    pub sample_rate: u32,

    /// Total number of frames (samples per channel).
    pub num_frames: usize,
}

impl AudioBuffer {
    /// Returns the number of channels.
    pub fn num_channels(&self) -> usize {
        self.channels.len()
    }

    /// Returns the duration in seconds.
    pub fn duration_seconds(&self) -> f64 {
        self.num_frames as f64 / self.sample_rate as f64
    }

    /// Returns channel data as a slice. Panics if channel is out of bounds.
    pub fn channel(&self, index: usize) -> &[f32] {
        &self.channels[index]
    }

    /// Returns a mono mixdown (average of all channels).
    pub fn to_mono(&self) -> Vec<f32> {
        if self.channels.is_empty() || self.num_frames == 0 {
            return Vec::new();
        }
        if self.channels.len() == 1 {
            return self.channels[0].clone();
        }

        let scale = 1.0 / self.channels.len() as f32;
        let mut mono = vec![0.0f32; self.num_frames];
        for ch in &self.channels {
            for (i, sample) in ch.iter().enumerate() {
                mono[i] += sample * scale;
            }
        }
        mono
    }
}

/// Errors that can occur during audio file reading.
#[derive(Debug)]
pub enum AudioReaderError {
    /// File does not exist or cannot be opened.
    FileNotFound(String),

    /// Unsupported audio format.
    UnsupportedFormat(String),

    /// Decoder error.
    DecodeError(String),

    /// No audio tracks found in the file.
    NoAudioTrack,
}

impl std::fmt::Display for AudioReaderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FileNotFound(e) => write!(f, "File not found: {e}"),
            Self::UnsupportedFormat(e) => write!(f, "Unsupported format: {e}"),
            Self::DecodeError(e) => write!(f, "Decode error: {e}"),
            Self::NoAudioTrack => write!(f, "No audio track found in file"),
        }
    }
}

impl std::error::Error for AudioReaderError {}

/// Audio file reader using the symphonia decoding library.
///
/// Supports all major audio formats: WAV, FLAC, OGG, MP3, AIFF, AAC, ALAC.
pub struct AudioReader;

/// Normalizes common audio file extension aliases to their symphonia-canonical forms.
///
/// Symphonia registers format readers under specific extension strings.
/// Without normalization, `Hint::with_extension("aif")` may fail to match the
/// `"aiff"` reader, causing a spurious `UnsupportedFormat` error even though
/// the underlying codec is fully supported.
fn normalize_audio_extension(ext: &str) -> String {
    match ext.to_lowercase().as_str() {
        "aif"   => "aiff".to_string(),
        "aifc"  => "aiff".to_string(),
        "wave"  => "wav".to_string(),
        "m4a"   => "mp4".to_string(),
        "aac"   => "mp4".to_string(),
        "oga"   => "ogg".to_string(),
        "opus"  => "ogg".to_string(),
        other   => other.to_string(),
    }
}

impl AudioReader {
    /// Decodes an entire audio file into an `AudioBuffer`.
    ///
    /// # Arguments
    /// - `path`: Path to the audio file.
    ///
    /// # Returns
    /// `AudioBuffer` containing de-interleaved f32 channels.
    ///
    /// # Performance
    /// This is NOT real-time safe — it reads from disk and allocates.
    /// Call from a worker thread, not the audio callback.
    pub fn read(path: impl AsRef<Path>) -> Result<AudioBuffer, AudioReaderError> {
        let path = path.as_ref();
        let file = File::open(path)
            .map_err(|e| AudioReaderError::FileNotFound(format!("{}: {e}", path.display())))?;

        let mss = MediaSourceStream::new(Box::new(file), Default::default());

        // Probe the format — two-stage approach for maximum compatibility:
        // Stage 1: Try with normalized extension hint (fast path).
        // Stage 2: If hint-based probe fails, re-open and try pure content-
        //          based auto-detection (catches AIF, AIFC, unusual extensions).
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(&normalize_audio_extension(ext));
        }

        let probed = match symphonia::default::get_probe().format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        ) {
            Ok(p) => p,
            Err(hint_err) => {
                // Stage 2: Fallback — re-open and probe without extension hint.
                // This lets symphonia inspect the file header bytes directly.
                let file2 = File::open(path).map_err(|e| {
                    AudioReaderError::FileNotFound(format!("{}: {e}", path.display()))
                })?;
                let mss2 = MediaSourceStream::new(Box::new(file2), Default::default());
                symphonia::default::get_probe()
                    .format(
                        &Hint::new(),
                        mss2,
                        &FormatOptions::default(),
                        &MetadataOptions::default(),
                    )
                    .map_err(|e| {
                        AudioReaderError::UnsupportedFormat(format!(
                            "{}: hint probe failed ({hint_err}), content probe failed ({e})",
                            path.display()
                        ))
                    })?
            }
        };

        let mut format_reader = probed.format;

        // Find the first audio track
        let track = format_reader
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
            .ok_or(AudioReaderError::NoAudioTrack)?;

        let track_id = track.id;
        let codec_params = track.codec_params.clone();

        let sample_rate = codec_params
            .sample_rate
            .ok_or_else(|| AudioReaderError::DecodeError("Unknown sample rate".into()))?;

        let num_channels = codec_params.channels.map(|c| c.count()).unwrap_or(2);

        // ENT-IO2: Zero-channel guard — refuse files with no audio channels.
        if num_channels == 0 {
            return Err(AudioReaderError::DecodeError(
                format!("File has 0 audio channels: {}", path.display()),
            ));
        }

        // Create decoder
        let mut decoder = symphonia::default::get_codecs()
            .make(&codec_params, &DecoderOptions::default())
            .map_err(|e| AudioReaderError::DecodeError(format!("Codec init: {e}")))?;

        // Decode all packets
        let mut all_samples: Vec<Vec<f32>> = (0..num_channels).map(|_| Vec::new()).collect();

        // BUG-013 FIX: Allocate the SampleBuffer once outside the loop and reuse it.
        // The previous implementation allocated a new SampleBuffer per decoded packet,
        // causing ~460 alloc+dealloc cycles for a 5-minute 48kHz WAV.
        let mut sample_buf: Option<SampleBuffer<f32>> = None;
        // IO-1 FIX: Track the spec of the current SampleBuffer to detect channel
        // layout changes mid-stream. Without this, a packet with a different spec
        // reuses the old buffer → corrupted de-interleave.
        let mut sample_buf_spec: Option<symphonia::core::audio::SignalSpec> = None;

        loop {
            let packet = match format_reader.next_packet() {
                Ok(p) => p,
                Err(symphonia::core::errors::Error::IoError(ref e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break; // End of stream
                }
                // IO-2 FIX: Non-EOF packet errors (e.g., damaged MP3 frame) should
                // not terminate the entire decode. Skip the bad packet and continue
                // to recover as much audio as possible.
                Err(symphonia::core::errors::Error::DecodeError(ref msg)) => {
                    log::warn!("Packet read error (skipping frame): {msg}");
                    continue;
                }
                Err(e) => {
                    log::warn!("Packet read error (fatal, stopping): {e}");
                    break;
                }
            };

            if packet.track_id() != track_id {
                continue;
            }

            let decoded = match decoder.decode(&packet) {
                Ok(d) => d,
                Err(e) => {
                    log::warn!("Decode error (skipping packet): {e}");
                    continue;
                }
            };

            // Convert to interleaved f32 via SampleBuffer
            let spec = *decoded.spec();
            let duration = decoded.capacity();

            // IO-1 FIX: Reuse SampleBuffer only if BOTH capacity AND spec match.
            // A codec that changes channel layout mid-stream (or VBR packet size
            // changes) would otherwise reuse a buffer with the wrong spec,
            // causing corrupted de-interleave.
            let spec_changed = sample_buf_spec != Some(spec);
            let buf =
                sample_buf.get_or_insert_with(|| SampleBuffer::<f32>::new(duration as u64, spec));
            if buf.capacity() < duration || spec_changed {
                *buf = SampleBuffer::<f32>::new(duration as u64, spec);
                sample_buf_spec = Some(spec);
            }
            buf.copy_interleaved_ref(decoded);

            let samples = buf.samples();
            // ENT-IO3: Use all_samples.len() as the authoritative channel count
            // instead of the per-packet spec. If a codec changes channel layout
            // mid-stream, this prevents out-of-bounds access and corruption.
            let target_ch_count = all_samples.len();
            let packet_ch_count = spec.channels.count().max(1);

            // De-interleave into per-channel vectors
            for (i, sample) in samples.iter().enumerate() {
                let ch = i % packet_ch_count;
                if ch < target_ch_count {
                    all_samples[ch].push(*sample);
                }
            }
        }

        let num_frames = all_samples.first().map(|ch| ch.len()).unwrap_or(0);

        // ENT-IO1: Sanitize NaN/Inf samples that corrupt decoders may produce.
        // A single NaN propagates through the entire audio graph causing
        // permanent silence or infinite distortion.
        for ch in &mut all_samples {
            for sample in ch.iter_mut() {
                if !sample.is_finite() {
                    *sample = 0.0;
                }
            }
        }

        log::info!(
            "Decoded {}: {}ch × {} frames @ {}Hz ({:.2}s)",
            path.display(),
            num_channels,
            num_frames,
            sample_rate,
            num_frames as f64 / sample_rate as f64,
        );

        Ok(AudioBuffer {
            channels: all_samples,
            sample_rate,
            num_frames,
        })
    }

    /// Reads audio file metadata without decoding the entire file.
    ///
    /// Returns (sample_rate, num_channels, num_frames).
    pub fn read_metadata(
        path: impl AsRef<Path>,
    ) -> Result<(u32, usize, Option<u64>), AudioReaderError> {
        let path = path.as_ref();
        let file = File::open(path)
            .map_err(|e| AudioReaderError::FileNotFound(format!("{}: {e}", path.display())))?;

        let mss = MediaSourceStream::new(Box::new(file), Default::default());

        // Same two-stage probe as read():
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(&normalize_audio_extension(ext));
        }

        let probed = match symphonia::default::get_probe().format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        ) {
            Ok(p) => p,
            Err(hint_err) => {
                let file2 = File::open(path).map_err(|e| {
                    AudioReaderError::FileNotFound(format!("{}: {e}", path.display()))
                })?;
                let mss2 = MediaSourceStream::new(Box::new(file2), Default::default());
                symphonia::default::get_probe()
                    .format(
                        &Hint::new(),
                        mss2,
                        &FormatOptions::default(),
                        &MetadataOptions::default(),
                    )
                    .map_err(|e| {
                        AudioReaderError::UnsupportedFormat(format!(
                            "{}: hint probe ({hint_err}), content probe ({e})",
                            path.display()
                        ))
                    })?
            }
        };

        let track = probed
            .format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
            .ok_or(AudioReaderError::NoAudioTrack)?;

        let sample_rate = track
            .codec_params
            .sample_rate
            .ok_or_else(|| AudioReaderError::DecodeError("Unknown sample rate".into()))?;

        let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);

        let num_frames = track.codec_params.n_frames;

        Ok((sample_rate, channels, num_frames))
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_buffer_mono_mixdown_empty() {
        let buf = AudioBuffer {
            channels: vec![],
            sample_rate: 44100,
            num_frames: 0,
        };
        assert!(buf.to_mono().is_empty());
    }

    #[test]
    fn audio_buffer_mono_passthrough() {
        let mono_data = vec![0.1, 0.5, -0.3, 0.8];
        let buf = AudioBuffer {
            channels: vec![mono_data.clone()],
            sample_rate: 44100,
            num_frames: 4,
        };
        assert_eq!(buf.to_mono(), mono_data);
    }

    #[test]
    fn audio_buffer_stereo_to_mono() {
        let left = vec![1.0, 0.0, -1.0];
        let right = vec![0.0, 1.0, 1.0];
        let buf = AudioBuffer {
            channels: vec![left, right],
            sample_rate: 44100,
            num_frames: 3,
        };
        let mono = buf.to_mono();
        assert!((mono[0] - 0.5).abs() < 0.001);
        assert!((mono[1] - 0.5).abs() < 0.001);
        assert!((mono[2] - 0.0).abs() < 0.001);
    }

    #[test]
    fn audio_buffer_duration() {
        let buf = AudioBuffer {
            channels: vec![vec![0.0; 44100]],
            sample_rate: 44100,
            num_frames: 44100,
        };
        assert!((buf.duration_seconds() - 1.0).abs() < 0.001);
    }

    #[test]
    fn read_nonexistent_file_returns_error() {
        let result = AudioReader::read("/nonexistent/path/audio.wav");
        assert!(result.is_err());
    }

    #[test]
    fn error_display() {
        let err = AudioReaderError::FileNotFound("test.wav".into());
        assert_eq!(format!("{err}"), "File not found: test.wav");
    }
}
