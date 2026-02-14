// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Clip Reader (Sample Data Access)
// ═══════════════════════════════════════════════════════════════════════════
//
// Reads sample data from pre-loaded audio buffers for the mixer.
//
// The reader does NOT perform disk I/O — all audio data must be
// pre-loaded into the ClipPool by the UI/worker thread.
//
// ═══════════════════════════════════════════════════════════════════════════

/// Reads samples from a pre-loaded audio source into a mix buffer.
///
/// This is the second stage of the playback pipeline:
///   ClipScheduler → ActiveClip → ClipReader → mix buffer
pub struct ClipReader;

impl ClipReader {
    /// Reads samples from a source buffer and writes them into the output,
    /// applying gain and micro-fades.
    ///
    /// # Arguments
    /// - `source`: Pre-loaded audio data (mono channel).
    /// - `source_start`: Frame offset in the source to start reading.
    /// - `output`: Output buffer to write into.
    /// - `output_offset`: Frame offset in the output to start writing.
    /// - `num_frames`: Number of frames to read/write.
    /// - `gain`: Volume multiplier for this clip.
    ///
    /// # Real-Time Safety
    /// Real-time safe — no allocations, bounded iteration.
    /// Reads samples from a source buffer and additively mixes them into
    /// the output buffer, applying gain.
    ///
    /// **Fades are NOT applied here** — clip boundary fades are handled
    /// by the render callback (FadeCache / user-defined fades) to avoid
    /// double-fading artifacts.
    #[inline]
    pub fn read_into(
        source: &[f32],
        source_start: usize,
        output: &mut [f32],
        output_offset: usize,
        num_frames: usize,
        gain: f32,
    ) {
        let src_end = (source_start + num_frames).min(source.len());
        let actual_frames = src_end.saturating_sub(source_start);
        let out_end = (output_offset + actual_frames).min(output.len());
        let write_frames = out_end.saturating_sub(output_offset);

        if write_frames == 0 {
            return;
        }

        // Pure additive mixing — no fades, no coloration
        for i in 0..write_frames {
            let src_idx = source_start + i;
            let out_idx = output_offset + i;
            output[out_idx] += source[src_idx] * gain;
        }
    }

    /// Reads stereo samples from two source channels into stereo output buffers.
    ///
    /// # Real-Time Safety
    /// Real-time safe.
    #[inline]
    #[allow(clippy::too_many_arguments)]
    pub fn read_stereo_into(
        source_left: &[f32],
        source_right: &[f32],
        source_start: usize,
        output_left: &mut [f32],
        output_right: &mut [f32],
        output_offset: usize,
        num_frames: usize,
        gain: f32,
    ) {
        Self::read_into(
            source_left,
            source_start,
            output_left,
            output_offset,
            num_frames,
            gain,
        );
        Self::read_into(
            source_right,
            source_start,
            output_right,
            output_offset,
            num_frames,
            gain,
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_read() {
        let source = vec![0.5; 256];
        let mut output = vec![0.0; 256];

        ClipReader::read_into(&source, 0, &mut output, 0, 256, 1.0);

        // All samples should be exactly 0.5 (no micro-fade applied)
        assert!((output[0] - 0.5).abs() < 0.001);
        assert!((output[128] - 0.5).abs() < 0.001);
        assert!((output[255] - 0.5).abs() < 0.001);
    }

    #[test]
    fn gain_is_applied() {
        let source = vec![1.0; 200];
        let mut output = vec![0.0; 200];

        ClipReader::read_into(&source, 0, &mut output, 0, 200, 0.5);

        // Middle sample should be ~0.5 (1.0 * 0.5)
        assert!((output[100] - 0.5).abs() < 0.01);
    }

    #[test]
    fn output_offset_works() {
        let source = vec![1.0; 200];
        let mut output = vec![0.0; 300];

        ClipReader::read_into(&source, 0, &mut output, 50, 200, 1.0);

        // First 50 samples should be 0 (not written)
        assert_eq!(output[0], 0.0);
        assert_eq!(output[49], 0.0);

        // Written samples should be exactly 1.0
        assert!((output[50] - 1.0).abs() < 0.001);
        assert!((output[150] - 1.0).abs() < 0.001);
    }

    #[test]
    fn source_offset_works() {
        let source = vec![1.0; 200];
        let mut output = vec![0.0; 200];

        ClipReader::read_into(&source, 50, &mut output, 0, 150, 1.0);

        // All written samples should be exactly 1.0
        assert!((output[0] - 1.0).abs() < 0.001);
        assert!((output[75] - 1.0).abs() < 0.001);
    }

    #[test]
    fn additive_mixing() {
        let source = vec![0.5; 200];
        let mut output = vec![0.3; 200];

        ClipReader::read_into(&source, 0, &mut output, 0, 200, 1.0);

        // Middle: existing 0.3 + new 0.5 = 0.8
        assert!((output[100] - 0.8).abs() < 0.01);
    }

    #[test]
    fn out_of_bounds_source_is_safe() {
        let source = vec![1.0; 10];
        let mut output = vec![0.0; 100];

        // Try to read 100 frames from a 10-frame source
        ClipReader::read_into(&source, 0, &mut output, 0, 100, 1.0);

        // Should not panic; only first 10 frames written
        assert!(output[5] > 0.0);
        assert_eq!(output[50], 0.0);
    }

    #[test]
    fn empty_source_is_noop() {
        let source: Vec<f32> = Vec::new();
        let mut output = vec![0.0; 100];

        ClipReader::read_into(&source, 0, &mut output, 0, 100, 1.0);

        assert!(output.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn stereo_read() {
        let left = vec![1.0; 200];
        let right = vec![-1.0; 200];
        let mut out_l = vec![0.0; 200];
        let mut out_r = vec![0.0; 200];

        ClipReader::read_stereo_into(&left, &right, 0, &mut out_l, &mut out_r, 0, 200, 0.5);

        assert!(out_l[100] > 0.0);
        assert!(out_r[100] < 0.0);
    }
}
