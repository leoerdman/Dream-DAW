// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Hann-Window Micro-Fades
// ═══════════════════════════════════════════════════════════════════════════
//
// Direct port of Swift `QuantumDSP.swift`.
//
// Eliminates digital clicks/pops at trimmed clip boundaries by applying
// a ~2ms Hann window fade to the edges of every audio buffer.
//
// Performance: Pre-allocated curves + vectorized multiply ≈ <1μs per buffer.
// Memory: Zero heap allocation during processing (curves pre-computed).
//
// The Hann window provides a smooth S-curve transition that is
// psychoacoustically transparent at 2ms duration.
//
// SIMD: Uses stable Rust auto-vectorization via `target-cpu=native`.
// The compiler generates AVX2 (Intel/AMD) or NEON (Apple Silicon) instructions
// from the simple loop patterns below when compiled with `--release`.
//
// ═══════════════════════════════════════════════════════════════════════════

use std::f32::consts::PI;

// ── Constants ──────────────────────────────────────────────────────────

/// Default fade length in samples at 44.1kHz = exactly 2ms.
const DEFAULT_FADE_LENGTH: usize = 88;

// ── Curve Generation ───────────────────────────────────────────────────

/// Generates a half-Hann window curve for fade-in (0.0 → 1.0).
///
/// Formula: `w(n) = 0.5 * (1 - cos(π * n / (N-1)))`
///
/// The curve starts at 0.0 and ends at 1.0, following an S-shaped
/// trajectory that eliminates discontinuity clicks.
pub fn generate_hann_fade_in(length: usize) -> Vec<f32> {
    assert!(length >= 2, "Fade length must be >= 2 samples");
    let mut curve = Vec::with_capacity(length);
    let len_f = (length - 1) as f32;

    for i in 0..length {
        let normalized = i as f32 / len_f;
        let value = 0.5 * (1.0 - (PI * normalized).cos());
        curve.push(value);
    }

    curve
}

/// Generates a half-Hann window curve for fade-out (1.0 → 0.0).
///
/// This is the mirror of the fade-in curve.
pub fn generate_hann_fade_out(length: usize) -> Vec<f32> {
    assert!(length >= 2, "Fade length must be >= 2 samples");
    let mut curve = Vec::with_capacity(length);
    let len_f = (length - 1) as f32;

    for i in 0..length {
        let normalized = i as f32 / len_f;
        let value = 0.5 * (1.0 + (PI * normalized).cos());
        curve.push(value);
    }

    curve
}

/// Computes the fade length in samples for a given sample rate (~2ms).
///
/// Returns 88 for 44.1kHz, 96 for 48kHz, 192 for 96kHz.
#[inline]
pub fn fade_length_for_sample_rate(sample_rate: f64) -> usize {
    (sample_rate * 0.002).round().max(16.0) as usize
}

// ── Pre-Computed Fade Cache ────────────────────────────────────────────

/// Pre-computed fade curves for a specific sample rate.
///
/// Allocate once at engine startup, reuse for every buffer.
/// This eliminates all heap allocations from the audio hot path.
pub struct FadeCache {
    /// Half-Hann fade-in curve (0.0 → 1.0).
    pub fade_in: Vec<f32>,
    /// Half-Hann fade-out curve (1.0 → 0.0).
    pub fade_out: Vec<f32>,
    /// Number of samples in each fade.
    pub fade_length: usize,
}

impl FadeCache {
    /// Creates a new `FadeCache` for the given sample rate.
    pub fn new(sample_rate: f64) -> Self {
        let length = fade_length_for_sample_rate(sample_rate);
        Self {
            fade_in: generate_hann_fade_in(length),
            fade_out: generate_hann_fade_out(length),
            fade_length: length,
        }
    }

    /// Creates a `FadeCache` with the default 44.1kHz fade length (88 samples).
    pub fn default_44100() -> Self {
        Self {
            fade_in: generate_hann_fade_in(DEFAULT_FADE_LENGTH),
            fade_out: generate_hann_fade_out(DEFAULT_FADE_LENGTH),
            fade_length: DEFAULT_FADE_LENGTH,
        }
    }
}

// ── Micro-Fade Application ─────────────────────────────────────────────

/// Applies Hann micro-fades to the edges of an interleaved audio buffer.
///
/// This is the primary entry point, designed for the audio hot path.
///
/// # Arguments
/// - `buffer`: Interleaved PCM audio data (`[L, R, L, R, ...]`).
/// - `channels`: Number of audio channels (1 = mono, 2 = stereo).
/// - `cache`: Pre-computed fade curves from `FadeCache`.
///
/// # Real-Time Safety
/// - Zero heap allocations.
/// - Loop pattern auto-vectorizes on x86 (AVX2) and ARM (NEON) in release mode.
///
/// # Behavior
/// - If the buffer has fewer than `2 * fade_length` frames, no fades are applied
///   (buffer is too short for non-overlapping head/tail fades).
/// - Fade-in is applied to the first `fade_length` frames.
/// - Fade-out is applied to the last `fade_length` frames.
#[inline]
pub fn apply_microfades(buffer: &mut [f32], channels: usize, cache: &FadeCache) {
    let total_samples = buffer.len();
    let total_frames = total_samples / channels;
    let fade_len = cache.fade_length;

    // Guard: buffer too short for non-overlapping fades
    if total_frames < fade_len * 2 {
        return;
    }

    // ── Fade-In: First `fade_len` frames ───────────────────────────
    // Multiply each sample by the corresponding fade-in curve value.
    // The loop iterates per-frame, applying the same gain to all channels.
    for frame in 0..fade_len {
        let gain = cache.fade_in[frame];
        let base = frame * channels;
        for ch in 0..channels {
            // SAFETY: bounds guaranteed by frame < fade_len < total_frames
            buffer[base + ch] *= gain;
        }
    }

    // ── Fade-Out: Last `fade_len` frames ───────────────────────────
    let tail_start_frame = total_frames - fade_len;
    for i in 0..fade_len {
        let gain = cache.fade_out[i];
        let frame = tail_start_frame + i;
        let base = frame * channels;
        for ch in 0..channels {
            buffer[base + ch] *= gain;
        }
    }
}

/// Convenience version that computes the fade curves on-the-fly.
///
/// For use outside the hot path (e.g., offline rendering).
/// Prefer `apply_microfades()` with a pre-allocated `FadeCache` for real-time use.
pub fn apply_microfades_oneshot(buffer: &mut [f32], channels: usize, sample_rate: f64) {
    let cache = FadeCache::new(sample_rate);
    apply_microfades(buffer, channels, &cache);
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fade_in_curve_boundaries() {
        let curve = generate_hann_fade_in(88);
        // First sample should be ≈0 (silence)
        assert!(
            curve[0].abs() < 1e-6,
            "Fade-in start should be ≈0, got {}",
            curve[0]
        );
        // Last sample should be ≈1 (full volume)
        assert!(
            (curve[87] - 1.0).abs() < 1e-6,
            "Fade-in end should be ≈1, got {}",
            curve[87]
        );
        // Middle should be ≈0.5
        assert!(
            (curve[44] - 0.5).abs() < 0.01,
            "Fade-in midpoint should be ≈0.5, got {}",
            curve[44]
        );
    }

    #[test]
    fn fade_out_curve_boundaries() {
        let curve = generate_hann_fade_out(88);
        // First sample should be ≈1 (full volume)
        assert!(
            (curve[0] - 1.0).abs() < 1e-6,
            "Fade-out start should be ≈1, got {}",
            curve[0]
        );
        // Last sample should be ≈0 (silence)
        assert!(
            curve[87].abs() < 1e-6,
            "Fade-out end should be ≈0, got {}",
            curve[87]
        );
    }

    #[test]
    fn fade_curves_are_complementary() {
        let fi = generate_hann_fade_in(64);
        let fo = generate_hann_fade_out(64);
        // fade_in + fade_out should sum to ≈1.0 at every point
        for i in 0..64 {
            let sum = fi[i] + fo[i];
            assert!(
                (sum - 1.0).abs() < 1e-5,
                "Curves not complementary at index {i}: sum = {sum}"
            );
        }
    }

    #[test]
    fn fade_length_for_standard_rates() {
        assert_eq!(fade_length_for_sample_rate(44100.0), 88);
        assert_eq!(fade_length_for_sample_rate(48000.0), 96);
        assert_eq!(fade_length_for_sample_rate(96000.0), 192);
    }

    #[test]
    fn apply_microfades_silences_edges() {
        let cache = FadeCache::default_44100();
        let channels = 2;
        let total_frames = 1024;
        let total_samples = total_frames * channels;

        // Fill buffer with 1.0 (unity)
        let mut buffer = vec![1.0f32; total_samples];
        apply_microfades(&mut buffer, channels, &cache);

        // First sample should be ≈0 (faded in)
        assert!(
            buffer[0].abs() < 1e-6,
            "First sample should be ≈0 after fade-in, got {}",
            buffer[0]
        );

        // Last sample should be ≈0 (faded out)
        let last = buffer[total_samples - 1];
        assert!(
            last.abs() < 1e-6,
            "Last sample should be ≈0 after fade-out, got {last}"
        );

        // Middle should be untouched (1.0)
        let mid = total_frames / 2 * channels;
        assert!(
            (buffer[mid] - 1.0).abs() < 1e-6,
            "Middle sample should be 1.0, got {}",
            buffer[mid]
        );
    }

    #[test]
    fn apply_microfades_skips_short_buffers() {
        let cache = FadeCache::default_44100();
        let channels = 2;
        // Buffer is too short for two non-overlapping fades
        let total_frames = cache.fade_length; // exactly 88, need > 176
        let total_samples = total_frames * channels;

        let mut buffer = vec![1.0f32; total_samples];
        let original = buffer.clone();
        apply_microfades(&mut buffer, channels, &cache);

        // Buffer should be untouched
        assert_eq!(buffer, original, "Short buffer should not be modified");
    }

    #[test]
    fn apply_microfades_mono() {
        let cache = FadeCache::new(48000.0);
        let total_frames = 512;
        let mut buffer = vec![1.0f32; total_frames];
        apply_microfades(&mut buffer, 1, &cache);

        assert!(buffer[0].abs() < 1e-6);
        assert!((buffer[total_frames / 2] - 1.0).abs() < 1e-6);
        assert!(buffer[total_frames - 1].abs() < 1e-6);
    }

    #[test]
    fn fade_cache_creation() {
        let cache = FadeCache::new(96000.0);
        assert_eq!(cache.fade_length, 192);
        assert_eq!(cache.fade_in.len(), 192);
        assert_eq!(cache.fade_out.len(), 192);
    }
}
