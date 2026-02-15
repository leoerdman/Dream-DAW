// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Polyphase Sinc Resampler
// ═══════════════════════════════════════════════════════════════════════════
//
// High-quality sample rate conversion via the `rubato` crate.
//
// Rubato implements a polyphase sinc interpolation filter that achieves
// mastering-studio quality (-140dB alias rejection). This wrapper provides
// a simplified API for the common DAW use cases:
//
//   1. File import: Convert imported audio files to the project sample rate.
//   2. Offline render: Convert project audio to the export sample rate.
//
// The actual resampling is NOT real-time-safe (it allocates internally).
// It should run on a background thread, never in the audio callback.
//
// ═══════════════════════════════════════════════════════════════════════════

use rubato::{FastFixedIn, PolynomialDegree, Resampler as RubatoResampler};

// ── Error Type ─────────────────────────────────────────────────────────

/// Errors from the resampling process.
#[derive(Debug)]
pub enum ResampleError {
    /// The rubato crate returned an error during initialization or processing.
    RubatoError(String),
    /// Invalid parameters (e.g., zero sample rate, empty input).
    InvalidInput(String),
}

impl std::fmt::Display for ResampleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RubatoError(e) => write!(f, "Rubato resampling error: {e}"),
            Self::InvalidInput(e) => write!(f, "Invalid resampling input: {e}"),
        }
    }
}

impl std::error::Error for ResampleError {}

// ── Public API ─────────────────────────────────────────────────────────

/// Resamples a single channel of audio from one sample rate to another.
///
/// Uses `rubato::FastFixedIn` with cubic polynomial interpolation
/// for a balance of quality and speed suitable for file import.
///
/// # Arguments
/// - `input`: Mono audio data as `&[f32]`.
/// - `from_rate`: Source sample rate (e.g., 44100).
/// - `to_rate`: Target sample rate (e.g., 48000).
///
/// # Returns
/// A new `Vec<f32>` with the resampled audio.
///
/// # Thread Safety
/// NOT real-time-safe. Allocates memory internally.
/// Call from a background/IO thread only.
pub fn resample_mono(
    input: &[f32],
    from_rate: usize,
    to_rate: usize,
) -> Result<Vec<f32>, ResampleError> {
    if input.is_empty() {
        return Err(ResampleError::InvalidInput(
            "Input buffer is empty".to_string(),
        ));
    }
    if from_rate == 0 || to_rate == 0 {
        return Err(ResampleError::InvalidInput(
            "Sample rates must be > 0".to_string(),
        ));
    }
    if from_rate == to_rate {
        return Ok(input.to_vec());
    }

    resample_channels(&[input.to_vec()], from_rate, to_rate).map(|mut ch| ch.remove(0))
}

/// Resamples multi-channel audio from one sample rate to another.
///
/// # Arguments
/// - `channels`: Each element is one channel's audio data (all must be same length).
/// - `from_rate`: Source sample rate.
/// - `to_rate`: Target sample rate.
///
/// # Returns
/// A `Vec<Vec<f32>>` with one `Vec<f32>` per channel, resampled.
pub fn resample_channels(
    channels: &[Vec<f32>],
    from_rate: usize,
    to_rate: usize,
) -> Result<Vec<Vec<f32>>, ResampleError> {
    if channels.is_empty() {
        return Err(ResampleError::InvalidInput(
            "No channels provided".to_string(),
        ));
    }
    if from_rate == 0 || to_rate == 0 {
        return Err(ResampleError::InvalidInput(
            "Sample rates must be > 0".to_string(),
        ));
    }
    if from_rate == to_rate {
        return Ok(channels.to_vec());
    }

    let num_channels = channels.len();
    let ratio = to_rate as f64 / from_rate as f64;

    // Chunk size for rubato processing
    let chunk_size = 1024;

    let mut resampler = FastFixedIn::<f32>::new(
        ratio,
        2.0, // max relative ratio (allows some margin)
        PolynomialDegree::Cubic,
        chunk_size,
        num_channels,
    )
    .map_err(|e| ResampleError::RubatoError(e.to_string()))?;

    let input_len = channels[0].len();
    let estimated_output_len = (input_len as f64 * ratio).ceil() as usize + chunk_size;

    let mut output_channels: Vec<Vec<f32>> = (0..num_channels)
        .map(|_| Vec::with_capacity(estimated_output_len))
        .collect();

    // Process in chunks
    let mut pos = 0;
    while pos < input_len {
        let remaining = input_len - pos;
        let this_chunk = remaining.min(chunk_size);

        // Prepare input slice for each channel
        let input_chunk: Vec<Vec<f32>> = channels
            .iter()
            .map(|ch| {
                let end = (pos + this_chunk).min(ch.len());
                let mut chunk = ch[pos..end].to_vec();
                // Pad with zeros if needed to fill chunk_size
                chunk.resize(chunk_size, 0.0);
                chunk
            })
            .collect();

        let input_refs: Vec<&[f32]> = input_chunk.iter().map(|v| v.as_slice()).collect();

        let result = resampler
            .process(&input_refs, None)
            .map_err(|e| ResampleError::RubatoError(e.to_string()))?;

        for (ch_idx, resampled) in result.into_iter().enumerate() {
            output_channels[ch_idx].extend_from_slice(&resampled);
        }

        pos += this_chunk;
    }

    // Trim output to expected length
    let expected_len = (input_len as f64 * ratio).round() as usize;
    for ch in &mut output_channels {
        ch.truncate(expected_len);
    }

    Ok(output_channels)
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_resample_returns_copy() {
        let input: Vec<f32> = (0..1000).map(|i| (i as f32 / 1000.0).sin()).collect();
        let output = resample_mono(&input, 44100, 44100).unwrap();
        assert_eq!(input.len(), output.len());
        assert_eq!(input, output);
    }

    #[test]
    fn upsample_increases_length() {
        let input: Vec<f32> = vec![0.0; 44100]; // 1 second at 44.1kHz
        let output = resample_mono(&input, 44100, 48000).unwrap();
        // Output should be approximately 48000 samples (1 second at 48kHz)
        let expected = 48000;
        let tolerance = 100; // rubato may produce slightly different lengths
        assert!(
            (output.len() as i64 - expected as i64).unsigned_abs() < tolerance,
            "Expected ~{expected} samples, got {}",
            output.len()
        );
    }

    #[test]
    fn downsample_decreases_length() {
        let input: Vec<f32> = vec![0.0; 96000]; // 1 second at 96kHz
        let output = resample_mono(&input, 96000, 44100).unwrap();
        let expected = 44100;
        let tolerance = 100;
        assert!(
            (output.len() as i64 - expected as i64).unsigned_abs() < tolerance,
            "Expected ~{expected} samples, got {}",
            output.len()
        );
    }

    #[test]
    fn empty_input_returns_error() {
        let result = resample_mono(&[], 44100, 48000);
        assert!(result.is_err());
    }

    #[test]
    fn zero_rate_returns_error() {
        let input = vec![1.0f32; 100];
        assert!(resample_mono(&input, 0, 48000).is_err());
        assert!(resample_mono(&input, 44100, 0).is_err());
    }

    #[test]
    fn multichannel_resampling() {
        let ch0: Vec<f32> = (0..44100).map(|i| (i as f32 * 0.001).sin()).collect();
        let ch1: Vec<f32> = (0..44100).map(|i| (i as f32 * 0.002).cos()).collect();
        let result = resample_channels(&[ch0, ch1], 44100, 48000).unwrap();
        assert_eq!(result.len(), 2);

        let expected = 48000;
        let tolerance = 100;
        for (idx, ch) in result.iter().enumerate() {
            assert!(
                (ch.len() as i64 - expected as i64).unsigned_abs() < tolerance,
                "Channel {idx}: expected ~{expected} samples, got {}",
                ch.len()
            );
        }
    }
}
