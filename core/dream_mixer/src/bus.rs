// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Summing Bus
// ═══════════════════════════════════════════════════════════════════════════
//
// Zero-allocation stereo summing for mixing multiple tracks.
//
// The bus accumulates audio from multiple sources and can be read
// as a final stereo pair. Used for:
//   - Track → Master summing
//   - Send → Return aux routing
//   - Group bus summing
//
// ═══════════════════════════════════════════════════════════════════════════

/// A zero-allocation stereo summing bus.
///
/// Accumulates audio from multiple `add_stereo()` calls,
/// then read via `left()` / `right()`.
///
/// # Usage Pattern
/// ```ignore
/// bus.clear(buffer_size);
/// for track in &tracks {
///     bus.add_stereo(&track.left, &track.right);
/// }
/// // bus.left() and bus.right() now contain the mixed result
/// ```
pub struct SummingBus {
    /// Left channel accumulator.
    left: Vec<f32>,

    /// Right channel accumulator.
    right: Vec<f32>,

    /// Number of sources that have been added this frame.
    source_count: usize,
}

impl SummingBus {
    /// Creates a new bus with pre-allocated capacity.
    pub fn new(max_buffer_size: usize) -> Self {
        Self {
            left: vec![0.0; max_buffer_size],
            right: vec![0.0; max_buffer_size],
            source_count: 0,
        }
    }

    /// Clears the bus for a new frame.
    ///
    /// # Real-Time Safety
    /// Real-time safe — only zeroes existing memory, never allocates.
    /// If `buffer_size` exceeds capacity, it is clamped to the
    /// pre-allocated size (logged once via debug_assert).
    #[inline]
    pub fn clear(&mut self, buffer_size: usize) {
        // Hard clamp — NEVER allocate on the audio thread.
        let buffer_size = buffer_size.min(self.left.len());

        // Zero-fill
        self.left[..buffer_size].fill(0.0);
        self.right[..buffer_size].fill(0.0);

        self.source_count = 0;
    }

    /// Adds a stereo signal to the bus (summing).
    ///
    /// # Real-Time Safety
    /// Real-time safe — bounded iteration, no allocations.
    #[inline]
    pub fn add_stereo(&mut self, left: &[f32], right: &[f32]) {
        let len = left.len().min(right.len()).min(self.left.len());

        for i in 0..len {
            // BUG-M7 FIX: Guard against NaN/Inf from misbehaving plugins.
            // A single NaN source poisons the entire master bus (NaN + x = NaN),
            // silencing ALL tracks. Skip non-finite samples instead.
            let l = left[i];
            let r = right[i];
            if l.is_finite() {
                self.left[i] += l;
            }
            if r.is_finite() {
                self.right[i] += r;
            }
        }

        self.source_count += 1;
    }

    /// Adds a mono signal to both channels of the bus.
    #[inline]
    pub fn add_mono(&mut self, mono: &[f32]) {
        let len = mono.len().min(self.left.len());

        for (i, sample) in mono.iter().copied().enumerate().take(len) {
            // BUG-M8 FIX: Guard NaN/Inf — same protection as add_stereo().
            // Previously missing, a single NaN from a mono source (sidechain return,
            // noise generator, broken plugin) poisoned the entire master bus sum
            // (NaN + x = NaN) causing total silence on ALL tracks.
            if sample.is_finite() {
                self.left[i] += sample;
                self.right[i] += sample;
            }
        }

        self.source_count += 1;
    }

    /// Returns the left channel accumulator.
    #[inline]
    pub fn left(&self) -> &[f32] {
        &self.left
    }

    /// Returns the right channel accumulator.
    #[inline]
    pub fn right(&self) -> &[f32] {
        &self.right
    }

    /// Returns mutable access to the left channel (for master processing).
    #[inline]
    pub fn left_mut(&mut self) -> &mut [f32] {
        &mut self.left
    }

    /// Returns mutable access to the right channel (for master processing).
    #[inline]
    pub fn right_mut(&mut self) -> &mut [f32] {
        &mut self.right
    }

    /// Number of sources added this frame.
    #[inline]
    pub fn source_count(&self) -> usize {
        self.source_count
    }
}

impl Default for SummingBus {
    fn default() -> Self {
        Self::new(1024)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_bus_is_silence() {
        let mut bus = SummingBus::new(256);
        bus.clear(256);

        assert!(bus.left()[..256].iter().all(|&s| s == 0.0));
        assert!(bus.right()[..256].iter().all(|&s| s == 0.0));
        assert_eq!(bus.source_count(), 0);
    }

    #[test]
    fn single_source_passthrough() {
        let mut bus = SummingBus::new(4);
        bus.clear(4);

        let left = vec![0.1, 0.2, 0.3, 0.4];
        let right = vec![0.5, 0.6, 0.7, 0.8];
        bus.add_stereo(&left, &right);

        assert!((bus.left()[0] - 0.1).abs() < 0.001);
        assert!((bus.right()[0] - 0.5).abs() < 0.001);
        assert_eq!(bus.source_count(), 1);
    }

    #[test]
    fn two_sources_sum() {
        let mut bus = SummingBus::new(4);
        bus.clear(4);

        bus.add_stereo(&[0.3, 0.3, 0.3, 0.3], &[0.0; 4]);
        bus.add_stereo(&[0.2, 0.2, 0.2, 0.2], &[0.0; 4]);

        // 0.3 + 0.2 = 0.5
        assert!((bus.left()[0] - 0.5).abs() < 0.001);
        assert_eq!(bus.source_count(), 2);
    }

    #[test]
    fn mono_adds_to_both_channels() {
        let mut bus = SummingBus::new(4);
        bus.clear(4);

        bus.add_mono(&[0.7, 0.7, 0.7, 0.7]);

        assert!((bus.left()[0] - 0.7).abs() < 0.001);
        assert!((bus.right()[0] - 0.7).abs() < 0.001);
    }

    #[test]
    fn clear_resets_everything() {
        let mut bus = SummingBus::new(4);
        bus.clear(4);

        bus.add_stereo(&[1.0; 4], &[1.0; 4]);
        assert_eq!(bus.source_count(), 1);

        bus.clear(4);
        assert_eq!(bus.source_count(), 0);
        assert!(bus.left()[0] == 0.0);
    }

    #[test]
    fn handles_larger_buffer_size() {
        let mut bus = SummingBus::new(256);
        // Clear with larger size should clamp to capacity (256),
        // NOT allocate — this is the RT-safety guarantee.
        bus.clear(512);

        // The bus capacity should remain at 256 (no reallocation)
        assert_eq!(bus.left().len(), 256);
        assert_eq!(bus.right().len(), 256);

        // Adding a signal within capacity should still work
        let signal = vec![0.5; 256];
        bus.add_mono(&signal);
        assert!((bus.left()[255] - 0.5).abs() < 0.001);
    }
}
