// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Device Chain Runtime
// ═══════════════════════════════════════════════════════════════════════════
//
// Manages a per-track chain of insert effect slots.
// Each slot holds a `Box<dyn DspProcessor>` and a bypass flag.
//
// The chain processes audio in-place: Slot 0 → Slot 1 → ... → Slot N.
//
// # Design
// - Max 8 slots per track (pre-allocated Vec capacity)
// - Slot management (add/remove/reorder) via lock-free engine commands
// - All processing is O(N × slots) with zero allocations
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::{BuiltinEffectType, DspProcessor};

/// BUG-95 FIX: Increased from 8 to 16 for professional effect chains.
pub const MAX_DEVICE_SLOTS: usize = 16;

/// A single device slot in the effect chain.
pub struct DeviceChainSlot {
    /// The DSP processor instance.
    pub processor: Box<dyn DspProcessor>,
    /// Whether this slot is bypassed (passthrough).
    pub is_bypassed: bool,
    /// The type of effect in this slot (for serialization/UI sync).
    pub effect_type: BuiltinEffectType,
}

/// Per-track insert effect chain.
///
/// Processes audio through all active (non-bypassed) slots in series.
pub struct DeviceChain {
    /// Effect slots (processed in order, 0 → N).
    slots: Vec<DeviceChainSlot>,
    /// Cached sample rate for new processor initialization.
    sample_rate: f32,
}

impl DeviceChain {
    /// Creates a new empty device chain.
    pub fn new(sample_rate: f32) -> Self {
        Self {
            slots: Vec::with_capacity(MAX_DEVICE_SLOTS),
            sample_rate,
        }
    }

    /// Returns the number of active slots.
    pub fn slot_count(&self) -> usize {
        self.slots.len()
    }

    /// Returns `true` if the chain has no slots.
    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    /// Adds a device at the specified slot index.
    ///
    /// If `slot_index` exceeds the current count, the device is appended
    /// at the end. If the chain is full (`MAX_DEVICE_SLOTS` slots), the call is ignored.
    ///
    /// # Returns
    /// `true` if the device was added successfully.
    pub fn add_device(&mut self, slot_index: usize, effect_type: BuiltinEffectType) -> bool {
        if self.slots.len() >= MAX_DEVICE_SLOTS {
            return false;
        }

        let processor = effect_type.create_processor(self.sample_rate);
        let slot = DeviceChainSlot {
            processor,
            is_bypassed: false,
            effect_type,
        };

        let idx = slot_index.min(self.slots.len());
        self.slots.insert(idx, slot);
        true
    }

    /// Removes the device at the specified slot index.
    ///
    /// # Returns
    /// `true` if a device was removed.
    pub fn remove_device(&mut self, slot_index: usize) -> bool {
        if slot_index < self.slots.len() {
            self.slots.remove(slot_index);
            true
        } else {
            false
        }
    }

    /// Sets the bypass state of a device slot.
    pub fn set_bypass(&mut self, slot_index: usize, bypassed: bool) {
        if let Some(slot) = self.slots.get_mut(slot_index) {
            slot.is_bypassed = bypassed;
        }
    }

    /// Sets a parameter on a specific device slot.
    pub fn set_param(&mut self, slot_index: usize, param_index: u8, value: f32) {
        if let Some(slot) = self.slots.get_mut(slot_index) {
            slot.processor.set_param(param_index, value);
        }
    }

    /// Processes stereo audio through all non-bypassed slots in series.
    ///
    /// # Real-Time Safety
    /// Zero allocations. O(N × slot_count).
    #[inline]
    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        for slot in &mut self.slots {
            if !slot.is_bypassed {
                slot.processor.process_stereo(left, right, sample_rate);
            }
        }
    }

    /// Processes a single device slot with optional sidechain input.
    #[inline]
    pub fn process_slot_with_sidechain(
        &mut self,
        slot_index: usize,
        left: &mut [f32],
        right: &mut [f32],
        sidechain_left: Option<&[f32]>,
        sidechain_right: Option<&[f32]>,
        sample_rate: f32,
    ) {
        if let Some(slot) = self.slots.get_mut(slot_index)
            && !slot.is_bypassed
        {
            slot.processor.process_stereo_with_sidechain(
                left,
                right,
                sidechain_left,
                sidechain_right,
                sample_rate,
            );
        }
    }

    /// Resets all device processors (on transport seek / loop reset).
    pub fn reset_all(&mut self) {
        for slot in &mut self.slots {
            slot.processor.reset();
        }
    }

    /// BUG-023 FIX: Updates the cached sample rate and resets all processors.
    /// Must be called when the project sample rate changes (e.g. opening a
    /// project with a different SR). Without this, newly added devices are
    /// initialized with the wrong sample rate, and existing processors use
    /// stale filter coefficients.
    pub fn set_sample_rate(&mut self, sample_rate: f32) {
        if sample_rate > 0.0 && sample_rate.is_finite() {
            self.sample_rate = sample_rate;
            self.reset_all();
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_chain_passthrough() {
        let mut chain = DeviceChain::new(44100.0);
        let mut left = vec![0.5f32; 64];
        let mut right = vec![0.5f32; 64];
        let original = left.clone();
        chain.process_stereo(&mut left, &mut right, 44100.0);
        // Empty chain should not modify signal
        assert_eq!(left, original);
    }

    #[test]
    fn add_and_remove_devices() {
        let mut chain = DeviceChain::new(44100.0);
        assert!(chain.is_empty());

        assert!(chain.add_device(0, BuiltinEffectType::Utility));
        assert_eq!(chain.slot_count(), 1);

        assert!(chain.add_device(1, BuiltinEffectType::Eq));
        assert_eq!(chain.slot_count(), 2);

        assert!(chain.remove_device(0));
        assert_eq!(chain.slot_count(), 1);

        // Chain should have EQ (was at index 1, now shifted to 0)
        assert_eq!(chain.slots[0].effect_type, BuiltinEffectType::Eq);
    }

    #[test]
    fn max_slots_enforced() {
        let mut chain = DeviceChain::new(44100.0);
        for _ in 0..MAX_DEVICE_SLOTS {
            assert!(chain.add_device(0, BuiltinEffectType::Utility));
        }
        assert_eq!(chain.slot_count(), MAX_DEVICE_SLOTS);

        // Should refuse 9th device
        assert!(!chain.add_device(0, BuiltinEffectType::Utility));
        assert_eq!(chain.slot_count(), MAX_DEVICE_SLOTS);
    }

    #[test]
    fn bypass_skips_processing() {
        let mut chain = DeviceChain::new(44100.0);
        chain.add_device(0, BuiltinEffectType::Utility);

        // Set utility gain to -60dB (silence)
        chain.set_param(0, 0, -60.0);
        // Skip smoothing by processing a large buffer
        let mut left = vec![1.0f32; 4096];
        let mut right = vec![1.0f32; 4096];
        chain.process_stereo(&mut left, &mut right, 44100.0);
        // Signal should be near-silent
        let tail_avg: f32 = left[2000..].iter().map(|s| s.abs()).sum::<f32>() / 2096.0;
        assert!(
            tail_avg < 0.1,
            "Gain at -60dB should silence signal: {tail_avg}"
        );

        // Now bypass the utility
        chain.set_bypass(0, true);
        let mut left2 = vec![1.0f32; 64];
        let mut right2 = vec![1.0f32; 64];
        chain.process_stereo(&mut left2, &mut right2, 44100.0);
        // Bypassed — signal should pass through unchanged
        assert_eq!(left2, vec![1.0f32; 64]);
    }

    #[test]
    fn chain_cascade_order() {
        let mut chain = DeviceChain::new(44100.0);
        // Add Utility at slot 0 with -60dB gain (silences signal)
        chain.add_device(0, BuiltinEffectType::Utility);
        chain.set_param(0, 0, -60.0);

        // Add Compressor at slot 1
        chain.add_device(1, BuiltinEffectType::Compressor);

        // Utility runs first → silences → Compressor receives silence
        let mut left = vec![1.0f32; 4096];
        let mut right = vec![1.0f32; 4096];
        chain.process_stereo(&mut left, &mut right, 44100.0);

        let tail_avg: f32 = left[2000..].iter().map(|s| s.abs()).sum::<f32>() / 2096.0;
        assert!(
            tail_avg < 0.1,
            "Cascade: Utility should silence before Compressor"
        );
    }
}
