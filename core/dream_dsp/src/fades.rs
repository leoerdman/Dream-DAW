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

/// AUD-201 FIX: Maximum fade length across all supported sample rates.
/// At 192kHz the fade length is 384 samples. Pre-allocating at this size
/// guarantees `rebuild_in_place` never triggers a heap allocation on the RT thread.
const MAX_FADE_LENGTH: usize = 384;

// ── Curve Generation ───────────────────────────────────────────────────

/// Generates a half-Hann window curve for fade-in (0.0 → 1.0).
///
/// Formula: `w(n) = 0.5 * (1 - cos(π * n / (N-1)))`
///
/// The curve starts at 0.0 and ends at 1.0, following an S-shaped
/// trajectory that eliminates discontinuity clicks.
pub fn generate_hann_fade_in(length: usize) -> Vec<f32> {
    // BUG-91 FIX: Graceful fallback instead of panic for short fades.
    if length < 2 {
        return vec![1.0; length.max(1)];
    }
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
    // BUG-91 FIX: Graceful fallback for short fades.
    if length < 2 {
        return vec![1.0; length.max(1)];
    }
    let mut curve = Vec::with_capacity(length);
    let len_f = (length - 1) as f32;

    for i in 0..length {
        let normalized = i as f32 / len_f;
        let value = 0.5 * (1.0 + (PI * normalized).cos());
        curve.push(value);
    }

    curve
}

/// AUD-099: Writes a Hann fade-in curve into an existing slice. **Zero-alloc.**
///
/// The caller must ensure `output.len() >= 2` for meaningful results.
#[inline]
pub fn generate_hann_fade_in_into(output: &mut [f32]) {
    let length = output.len();
    if length < 2 {
        output.fill(1.0);
        return;
    }
    let len_f = (length - 1) as f32;
    for (i, sample) in output.iter_mut().enumerate() {
        let normalized = i as f32 / len_f;
        *sample = 0.5 * (1.0 - (PI * normalized).cos());
    }
}

/// AUD-099: Writes a Hann fade-out curve into an existing slice. **Zero-alloc.**
#[inline]
pub fn generate_hann_fade_out_into(output: &mut [f32]) {
    let length = output.len();
    if length < 2 {
        output.fill(1.0);
        return;
    }
    let len_f = (length - 1) as f32;
    for (i, sample) in output.iter_mut().enumerate() {
        let normalized = i as f32 / len_f;
        *sample = 0.5 * (1.0 + (PI * normalized).cos());
    }
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
    ///
    /// AUD-201 FIX: Pre-allocates at `MAX_FADE_LENGTH` (384 samples = 192kHz)
    /// so that `rebuild_in_place` never allocates on the RT thread, even when
    /// switching to a higher sample rate.
    pub fn new(sample_rate: f64) -> Self {
        let length = fade_length_for_sample_rate(sample_rate);
        // Pre-allocate at max capacity, then fill only the active portion.
        let mut fade_in = vec![0.0f32; MAX_FADE_LENGTH];
        let mut fade_out = vec![0.0f32; MAX_FADE_LENGTH];
        generate_hann_fade_in_into(&mut fade_in[..length]);
        generate_hann_fade_out_into(&mut fade_out[..length]);
        // Truncate len (not capacity) to the active region.
        fade_in.truncate(length);
        fade_out.truncate(length);
        Self {
            fade_in,
            fade_out,
            fade_length: length,
        }
    }

    /// AUD-099 + AUD-201 FIX: Rebuilds fade curves in-place for a new sample rate.
    ///
    /// **RT-SAFE**: Reuses the existing Vec allocations. The constructor
    /// pre-allocates at `MAX_FADE_LENGTH` (384 = 192kHz), so `resize()`
    /// never allocates for any supported sample rate.
    pub fn rebuild_in_place(&mut self, sample_rate: f64) {
        let length = fade_length_for_sample_rate(sample_rate);
        // BUG-015 FIX: Replace debug_assert with proper clamp to prevent
        // RT-thread allocation if a future sample rate exceeds 192kHz.
        // debug_assert is stripped in release builds, leaving no protection.
        let length = if length > self.fade_in.capacity() {
            #[cfg(debug_assertions)]
            eprintln!(
                "[FadeCache] WARNING: fade length {length} exceeds pre-allocated capacity {}. \
                 Clamping to capacity. Increase MAX_FADE_LENGTH.",
                self.fade_in.capacity()
            );
            self.fade_in.capacity()
        } else {
            length
        };
        self.fade_length = length;
        // Resize within existing capacity (Vec::resize never shrinks capacity)
        self.fade_in.resize(length, 0.0);
        self.fade_out.resize(length, 0.0);
        // Overwrite with fresh curve data
        generate_hann_fade_in_into(&mut self.fade_in[..length]);
        generate_hann_fade_out_into(&mut self.fade_out[..length]);
    }

    /// Creates a `FadeCache` with the default 44.1kHz fade length (88 samples).
    ///
    /// AUD-201 FIX: Pre-allocates at `MAX_FADE_LENGTH` like `new()`.
    pub fn default_44100() -> Self {
        Self::new(44100.0)
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
    // BUG-010 FIX: Guard against channels=0 which causes division by zero.
    if channels == 0 {
        return;
    }
    let total_frames = total_samples / channels;
    let fade_len = cache.fade_length;

    // Guard: buffer too short for non-overlapping fades.
    // BUG-031 FIX: Use strict less-than so that buffers with exactly
    // 2×fade_len frames still receive fades (previously off-by-one skip).
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
