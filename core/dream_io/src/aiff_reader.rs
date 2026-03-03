// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Native AIFF/AIFF-C Reader
// ═══════════════════════════════════════════════════════════════════════════
//
// Zero-dependency AIFF parser that handles the IFF (big-endian) container
// format used by Apple/SGI audio files. Symphonia 0.5 does NOT include an
// AIFF format reader, so this provides first-class AIFF support without
// relying on the `afconvert` process-spawn fallback.
//
// Supported formats:
//   - FORM/AIFF (standard uncompressed):
//       • 8-bit unsigned PCM
//       • 16-bit signed PCM (big-endian)
//       • 24-bit signed PCM (big-endian)
//       • 32-bit signed PCM (big-endian)
//   - FORM/AIFC (compressed AIFF):
//       • 'NONE' — uncompressed big-endian (same as AIFF)
//       • 'twos' — signed big-endian (same as NONE)
//       • 'sowt' — signed little-endian (Intel byte order)
//       • 'fl32' / 'FL32' — 32-bit IEEE float
//       • 'fl64' / 'FL64' — 64-bit IEEE float
//       • 'in24' / 'IN24' — 24-bit signed big-endian
//       • 'in32' / 'IN32' — 32-bit signed big-endian
//
// Architecture:
//   1. Parse FORM header → verify AIFF or AIFC form type
//   2. Walk IFF chunks looking for COMM (format) and SSND (sound data)
//   3. Parse COMM: channels, num_frames, bit_depth, sample_rate (80-bit ext)
//   4. For AIFC: also parse 4-byte compression_type from COMM
//   5. Read SSND: skip 8-byte offset/block header, read raw PCM data
//   6. Convert to de-interleaved f32 channels (same as AudioBuffer)
//
// ═══════════════════════════════════════════════════════════════════════════

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::audio_reader::{AudioBuffer, AudioReaderError};

/// Reads an AIFF or AIFF-C file and returns decoded audio as de-interleaved
/// f32 channels.
///
/// This is called by `AudioReader::read()` as a fast path for `.aif`/`.aiff`/
/// `.aifc` files, bypassing symphonia entirely.
pub fn read_aiff(path: &Path) -> Result<AudioBuffer, AudioReaderError> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| AudioReaderError::FileNotFound(format!("{}: {e}", path.display())))?;

    // ── FORM header ──────────────────────────────────────────────────
    let form_id = read_chunk_id(&mut file)?;
    if form_id != *b"FORM" {
        return Err(AudioReaderError::UnsupportedFormat(format!(
            "Not an AIFF file (expected FORM, got '{}')",
            String::from_utf8_lossy(&form_id)
        )));
    }
    let _form_size = read_u32_be(&mut file)?;
    let form_type = read_chunk_id(&mut file)?;

    let is_aifc = match &form_type {
        b"AIFF" => false,
        b"AIFC" => true,
        _ => {
            return Err(AudioReaderError::UnsupportedFormat(format!(
                "Unknown AIFF form type: '{}'",
                String::from_utf8_lossy(&form_type)
            )));
        }
    };

    // ── Walk chunks ──────────────────────────────────────────────────
    let mut comm: Option<CommChunk> = None;
    let mut ssnd_offset: Option<u64> = None;
    let mut ssnd_size: Option<u32> = None;

    loop {
        let chunk_id = match read_chunk_id(&mut file) {
            Ok(id) => id,
            Err(_) => break, // EOF — stop walking
        };
        let chunk_size = match read_u32_be(&mut file) {
            Ok(s) => s,
            Err(_) => break,
        };

        match &chunk_id {
            b"COMM" => {
                comm = Some(parse_comm(&mut file, chunk_size, is_aifc)?);
            }
            b"SSND" => {
                ssnd_offset = Some(file.stream_position().map_err(io_err)?);
                ssnd_size = Some(chunk_size);
                // Skip past SSND data for continued chunk walking
                let padded = if chunk_size % 2 != 0 { chunk_size + 1 } else { chunk_size };
                file.seek(SeekFrom::Current(padded as i64)).map_err(io_err)?;
            }
            _ => {
                // Skip unknown chunk (IFF chunks are padded to even size)
                let padded = if chunk_size % 2 != 0 { chunk_size + 1 } else { chunk_size };
                file.seek(SeekFrom::Current(padded as i64)).map_err(io_err)?;
            }
        }
    }

    // ── Validate ─────────────────────────────────────────────────────
    let comm = comm.ok_or_else(|| {
        AudioReaderError::DecodeError("AIFF: missing COMM chunk".into())
    })?;
    let ssnd_pos = ssnd_offset.ok_or_else(|| {
        AudioReaderError::DecodeError("AIFF: missing SSND chunk".into())
    })?;
    let ssnd_total = ssnd_size.ok_or_else(|| {
        AudioReaderError::DecodeError("AIFF: SSND chunk has no size".into())
    })?;

    if comm.num_channels == 0 {
        return Err(AudioReaderError::DecodeError(
            "AIFF: file has 0 channels".into(),
        ));
    }
    if comm.sample_rate == 0 {
        return Err(AudioReaderError::DecodeError(
            "AIFF: sample rate is 0".into(),
        ));
    }

    // ── Seek to SSND data ────────────────────────────────────────────
    file.seek(SeekFrom::Start(ssnd_pos)).map_err(io_err)?;

    // SSND starts with 4-byte offset and 4-byte blockSize (usually both 0)
    let ssnd_data_offset = read_u32_be(&mut file)?;
    let _ssnd_block_size = read_u32_be(&mut file)?;

    // Skip the data offset (rare — used for alignment padding)
    if ssnd_data_offset > 0 {
        file.seek(SeekFrom::Current(ssnd_data_offset as i64))
            .map_err(io_err)?;
    }

    // Calculate how many bytes of PCM data to read
    let ssnd_header_bytes = 8 + ssnd_data_offset;
    let pcm_bytes = (ssnd_total as usize).saturating_sub(ssnd_header_bytes as usize);

    // Read raw PCM data
    let mut raw = vec![0u8; pcm_bytes];
    file.read_exact(&mut raw).map_err(|e| {
        AudioReaderError::DecodeError(format!("AIFF: failed to read SSND data: {e}"))
    })?;

    // ── Decode samples to f32 ────────────────────────────────────────
    let num_channels = comm.num_channels as usize;
    let num_frames = comm.num_sample_frames as usize;
    let compression = comm.compression_type;

    let interleaved = decode_pcm_to_f32(
        &raw,
        num_channels,
        num_frames,
        comm.bit_depth,
        compression,
    )?;

    // ── De-interleave ────────────────────────────────────────────────
    let actual_frames = interleaved.len() / num_channels.max(1);
    let mut channels = vec![Vec::with_capacity(actual_frames); num_channels];

    for frame in 0..actual_frames {
        for ch in 0..num_channels {
            let idx = frame * num_channels + ch;
            let sample = interleaved.get(idx).copied().unwrap_or(0.0);
            channels[ch].push(if sample.is_finite() { sample } else { 0.0 });
        }
    }

    log::info!(
        "AIFF native decode: '{}' → {}ch × {} frames @ {}Hz ({})",
        path.display(),
        num_channels,
        actual_frames,
        comm.sample_rate,
        if is_aifc { "AIFC" } else { "AIFF" },
    );

    Ok(AudioBuffer {
        channels,
        sample_rate: comm.sample_rate,
        num_frames: actual_frames,
    })
}

/// Returns `true` if the file extension (case-insensitive) is an AIFF variant.
pub fn is_aiff_extension(ext: &str) -> bool {
    matches!(ext.to_lowercase().as_str(), "aif" | "aiff" | "aifc")
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal types and helpers
// ═══════════════════════════════════════════════════════════════════════════

/// AIFF-C compression type identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AiffCompression {
    /// Standard uncompressed PCM (big-endian). Covers AIFF and AIFC 'NONE'/'twos'.
    PcmBigEndian,
    /// Little-endian PCM ('sowt' — Intel byte order). Used by Logic Pro exports.
    PcmLittleEndian,
    /// 32-bit IEEE float ('fl32'/'FL32').
    Float32,
    /// 64-bit IEEE float ('fl64'/'FL64').
    Float64,
}

/// Parsed COMM chunk data.
struct CommChunk {
    num_channels: u16,
    num_sample_frames: u32,
    bit_depth: u16,
    sample_rate: u32,
    compression_type: AiffCompression,
}

fn parse_comm<R: Read + Seek>(
    r: &mut R,
    chunk_size: u32,
    is_aifc: bool,
) -> Result<CommChunk, AudioReaderError> {
    let num_channels = read_u16_be(r)?;
    let num_sample_frames = read_u32_be(r)?;
    let bit_depth = read_u16_be(r)?;

    // Sample rate is stored as 80-bit IEEE 754 extended precision
    let mut sr_bytes = [0u8; 10];
    r.read_exact(&mut sr_bytes).map_err(io_err)?;
    let sample_rate = extended80_to_u32(&sr_bytes);

    let compression_type = if is_aifc {
        // AIFC COMM has additional 4-byte compression type + pascal string
        let mut comp_id = [0u8; 4];
        r.read_exact(&mut comp_id).map_err(io_err)?;

        let comp = match &comp_id {
            b"NONE" | b"twos" => AiffCompression::PcmBigEndian,
            b"sowt" => AiffCompression::PcmLittleEndian,
            b"fl32" | b"FL32" => AiffCompression::Float32,
            b"fl64" | b"FL64" => AiffCompression::Float64,
            b"in24" | b"IN24" => AiffCompression::PcmBigEndian, // 24-bit BE
            b"in32" | b"IN32" => AiffCompression::PcmBigEndian, // 32-bit BE
            _ => {
                return Err(AudioReaderError::UnsupportedFormat(format!(
                    "AIFF-C: unsupported compression '{}'",
                    String::from_utf8_lossy(&comp_id)
                )));
            }
        };

        // Skip remaining COMM bytes (pascal compression name string)
        let consumed = 2 + 4 + 2 + 10 + 4; // channels + frames + bits + sr + comp_id
        let remaining = (chunk_size as usize).saturating_sub(consumed);
        if remaining > 0 {
            r.seek(SeekFrom::Current(remaining as i64)).map_err(io_err)?;
        }

        comp
    } else {
        // Standard AIFF — always big-endian PCM
        let consumed = 2 + 4 + 2 + 10;
        let remaining = (chunk_size as usize).saturating_sub(consumed);
        if remaining > 0 {
            r.seek(SeekFrom::Current(remaining as i64)).map_err(io_err)?;
        }
        AiffCompression::PcmBigEndian
    };

    Ok(CommChunk {
        num_channels,
        num_sample_frames,
        bit_depth,
        sample_rate,
        compression_type,
    })
}

/// Decodes raw PCM bytes to interleaved f32 samples.
fn decode_pcm_to_f32(
    raw: &[u8],
    num_channels: usize,
    num_frames: usize,
    bit_depth: u16,
    compression: AiffCompression,
) -> Result<Vec<f32>, AudioReaderError> {
    match compression {
        AiffCompression::Float32 => decode_float32(raw, num_channels, num_frames),
        AiffCompression::Float64 => decode_float64(raw, num_channels, num_frames),
        AiffCompression::PcmBigEndian => {
            decode_pcm_integer(raw, num_channels, num_frames, bit_depth, true)
        }
        AiffCompression::PcmLittleEndian => {
            decode_pcm_integer(raw, num_channels, num_frames, bit_depth, false)
        }
    }
}

/// Decodes integer PCM (8/16/24/32-bit) to f32.
fn decode_pcm_integer(
    raw: &[u8],
    num_channels: usize,
    num_frames: usize,
    bit_depth: u16,
    big_endian: bool,
) -> Result<Vec<f32>, AudioReaderError> {
    let bytes_per_sample = ((bit_depth + 7) / 8) as usize;
    let total_samples = num_channels * num_frames;
    let expected_bytes = total_samples * bytes_per_sample;

    // Use the smaller of expected and available data to handle truncated files
    let available_samples = raw.len() / bytes_per_sample;
    let sample_count = total_samples.min(available_samples);

    let mut out = Vec::with_capacity(sample_count);

    for i in 0..sample_count {
        let offset = i * bytes_per_sample;
        if offset + bytes_per_sample > raw.len() {
            break;
        }
        let bytes = &raw[offset..offset + bytes_per_sample];

        let sample = match bit_depth {
            8 => {
                // 8-bit AIFF is unsigned (0-255, center at 128)
                let val = bytes[0] as i16 - 128;
                val as f32 / 128.0
            }
            16 => {
                let val = if big_endian {
                    i16::from_be_bytes([bytes[0], bytes[1]])
                } else {
                    i16::from_le_bytes([bytes[0], bytes[1]])
                };
                val as f32 / 32768.0
            }
            24 => {
                // 24-bit → sign-extend to 32-bit
                let val = if big_endian {
                    let raw32 = (bytes[0] as i32) << 16 | (bytes[1] as i32) << 8 | (bytes[2] as i32);
                    if raw32 & 0x800000 != 0 { raw32 | !0xFFFFFF } else { raw32 }
                } else {
                    let raw32 = (bytes[2] as i32) << 16 | (bytes[1] as i32) << 8 | (bytes[0] as i32);
                    if raw32 & 0x800000 != 0 { raw32 | !0xFFFFFF } else { raw32 }
                };
                val as f32 / 8388608.0
            }
            32 => {
                let val = if big_endian {
                    i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
                } else {
                    i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
                };
                val as f32 / 2147483648.0
            }
            _ => {
                return Err(AudioReaderError::UnsupportedFormat(format!(
                    "AIFF: unsupported bit depth {bit_depth}"
                )));
            }
        };

        out.push(sample);
    }

    if out.len() < expected_bytes / bytes_per_sample {
        log::warn!(
            "AIFF: truncated data — expected {} samples, got {}",
            total_samples,
            out.len()
        );
    }

    Ok(out)
}

/// Decodes 32-bit float PCM (big-endian) to f32.
fn decode_float32(
    raw: &[u8],
    num_channels: usize,
    num_frames: usize,
) -> Result<Vec<f32>, AudioReaderError> {
    let total_samples = num_channels * num_frames;
    let available = raw.len() / 4;
    let count = total_samples.min(available);

    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let offset = i * 4;
        let val = f32::from_be_bytes([
            raw[offset],
            raw[offset + 1],
            raw[offset + 2],
            raw[offset + 3],
        ]);
        out.push(val);
    }
    Ok(out)
}

/// Decodes 64-bit float PCM (big-endian) to f32.
fn decode_float64(
    raw: &[u8],
    num_channels: usize,
    num_frames: usize,
) -> Result<Vec<f32>, AudioReaderError> {
    let total_samples = num_channels * num_frames;
    let available = raw.len() / 8;
    let count = total_samples.min(available);

    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let offset = i * 8;
        let val = f64::from_be_bytes([
            raw[offset],
            raw[offset + 1],
            raw[offset + 2],
            raw[offset + 3],
            raw[offset + 4],
            raw[offset + 5],
            raw[offset + 6],
            raw[offset + 7],
        ]);
        out.push(val as f32);
    }
    Ok(out)
}

// ═══════════════════════════════════════════════════════════════════════════
// Low-level I/O helpers
// ═══════════════════════════════════════════════════════════════════════════

fn read_chunk_id<R: Read>(r: &mut R) -> Result<[u8; 4], AudioReaderError> {
    let mut buf = [0u8; 4];
    r.read_exact(&mut buf)
        .map_err(|e| AudioReaderError::DecodeError(format!("AIFF: failed to read chunk ID: {e}")))?;
    Ok(buf)
}

fn read_u32_be<R: Read>(r: &mut R) -> Result<u32, AudioReaderError> {
    let mut buf = [0u8; 4];
    r.read_exact(&mut buf)
        .map_err(|e| AudioReaderError::DecodeError(format!("AIFF: failed to read u32: {e}")))?;
    Ok(u32::from_be_bytes(buf))
}

fn read_u16_be<R: Read>(r: &mut R) -> Result<u16, AudioReaderError> {
    let mut buf = [0u8; 2];
    r.read_exact(&mut buf)
        .map_err(|e| AudioReaderError::DecodeError(format!("AIFF: failed to read u16: {e}")))?;
    Ok(u16::from_be_bytes(buf))
}

fn io_err(e: std::io::Error) -> AudioReaderError {
    AudioReaderError::DecodeError(format!("AIFF I/O error: {e}"))
}

/// Converts an 80-bit IEEE 754 extended precision float to u32.
///
/// This is the Apple SANE format used for sample rates in AIFF files.
/// The 80-bit extended format is: 1 sign bit, 15 exponent bits, 64 mantissa bits.
/// We only need integer sample rates, so we truncate to u32.
fn extended80_to_u32(bytes: &[u8; 10]) -> u32 {
    // Extract sign (bit 79), exponent (bits 78-64), mantissa (bits 63-0)
    let exponent = ((bytes[0] as u16 & 0x7F) << 8) | bytes[1] as u16;
    let mantissa = u64::from_be_bytes([
        bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9],
    ]);

    if exponent == 0 && mantissa == 0 {
        return 0;
    }

    // Extended precision: exponent bias is 16383
    // The mantissa has an explicit integer bit (bit 63)
    let bias: i32 = 16383;
    let exp = exponent as i32 - bias;

    // The mantissa's integer bit is bit 63. For a sample rate like 44100,
    // the value is: mantissa × 2^(exp - 63)
    let value = (mantissa as f64) * 2.0_f64.powi(exp - 63);
    value.round() as u32
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extended80_common_rates() {
        // 80-bit extended: 1 sign bit, 15 exponent bits (bias 16383), 64 mantissa bits.
        // For integer N with highest set bit at position P:
        //   exponent = 16383 + P
        //   mantissa = N << (63 - P)

        // 44100 Hz: 0xAC44 = 16 bits → P=15 → exponent = 16398 = 0x400E
        let sr_44100: [u8; 10] = [0x40, 0x0E, 0xAC, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        assert_eq!(extended80_to_u32(&sr_44100), 44100);

        // 48000 Hz: 0xBB80 = 16 bits → P=15 → exponent = 16398 = 0x400E
        let sr_48000: [u8; 10] = [0x40, 0x0E, 0xBB, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        assert_eq!(extended80_to_u32(&sr_48000), 48000);

        // 96000 Hz: 0x17700 = 17 bits → P=16 → exponent = 16399 = 0x400F
        // mantissa = 0xBB80_0000_0000_0000 (96000 >> 1 = 48000 = 0xBB80, shifted to bit 63)
        let sr_96000: [u8; 10] = [0x40, 0x0F, 0xBB, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        assert_eq!(extended80_to_u32(&sr_96000), 96000);

        // 22050 Hz: P=14 → exponent = 16397 = 0x400D, mantissa = 0xAC44...
        let sr_22050: [u8; 10] = [0x40, 0x0D, 0xAC, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        assert_eq!(extended80_to_u32(&sr_22050), 22050);
    }

    #[test]
    fn extended80_zero() {
        let zero: [u8; 10] = [0; 10];
        assert_eq!(extended80_to_u32(&zero), 0);
    }

    #[test]
    fn is_aiff_ext() {
        assert!(is_aiff_extension("aif"));
        assert!(is_aiff_extension("AIFF"));
        assert!(is_aiff_extension("AIF"));
        assert!(is_aiff_extension("aifc"));
        assert!(is_aiff_extension("AIFC"));
        assert!(!is_aiff_extension("wav"));
        assert!(!is_aiff_extension("mp3"));
    }

    #[test]
    fn decode_16bit_be_round_trip() {
        // Simulate 2-channel, 3-frame, 16-bit big-endian PCM
        let samples: Vec<i16> = vec![0, 16384, -16384, 32767, -32768, 0];
        let mut raw = Vec::new();
        for s in &samples {
            raw.extend_from_slice(&s.to_be_bytes());
        }
        let result = decode_pcm_integer(&raw, 2, 3, 16, true).unwrap();
        assert_eq!(result.len(), 6);
        assert!((result[0] - 0.0).abs() < 0.001);
        assert!((result[1] - 0.5).abs() < 0.001);
        assert!((result[2] - (-0.5)).abs() < 0.001);
    }

    #[test]
    fn decode_8bit_round_trip() {
        // 8-bit AIFF is unsigned: 128 = silence, 0 = -1.0, 255 ≈ +1.0
        let raw = vec![128u8, 0, 255, 192];
        let result = decode_pcm_integer(&raw, 1, 4, 8, true).unwrap();
        assert_eq!(result.len(), 4);
        assert!((result[0] - 0.0).abs() < 0.01);    // 128 → 0.0
        assert!((result[1] - (-1.0)).abs() < 0.01);  // 0 → -1.0
        assert!((result[2] - 0.992).abs() < 0.02);   // 255 → ~+1.0
        assert!((result[3] - 0.5).abs() < 0.01);     // 192 → 0.5
    }

    #[test]
    fn decode_24bit_be() {
        // Max positive 24-bit: 0x7FFFFF = 8388607
        let raw = vec![0x7F, 0xFF, 0xFF, 0x80, 0x00, 0x00];
        let result = decode_pcm_integer(&raw, 1, 2, 24, true).unwrap();
        assert!((result[0] - 1.0).abs() < 0.001);
        assert!((result[1] - (-1.0)).abs() < 0.001);
    }

    #[test]
    fn decode_float32_be() {
        let samples: Vec<f32> = vec![0.5, -0.5, 1.0, -1.0];
        let mut raw = Vec::new();
        for s in &samples {
            raw.extend_from_slice(&s.to_be_bytes());
        }
        let result = decode_float32(&raw, 2, 2).unwrap();
        assert_eq!(result.len(), 4);
        for (a, b) in result.iter().zip(samples.iter()) {
            assert!((a - b).abs() < 0.0001);
        }
    }

    #[test]
    fn decode_16bit_le_sowt() {
        // 'sowt' compression = little-endian 16-bit
        let samples: Vec<i16> = vec![16384, -16384];
        let mut raw = Vec::new();
        for s in &samples {
            raw.extend_from_slice(&s.to_le_bytes());
        }
        let result = decode_pcm_integer(&raw, 1, 2, 16, false).unwrap();
        assert!((result[0] - 0.5).abs() < 0.001);
        assert!((result[1] - (-0.5)).abs() < 0.001);
    }
}
