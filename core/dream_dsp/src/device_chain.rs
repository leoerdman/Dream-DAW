// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Unified Device Chain Runtime
// ═══════════════════════════════════════════════════════════════════════════
//
// Manages a per-track chain of device slots.
//
// Every slot holds a `Box<dyn DeviceProcessor>` — the unified trait that
// wraps internal DSP effects, external VST3/CLAP/AU plugins, and device
// groups with parallel chains.
//
// The chain processes audio in-place: Slot 0 → Slot 1 → ... → Slot N.
// One loop. No branching by device type.
//
// # Design
// - Max 16 slots per track (pre-allocated Vec capacity)
// - Slot management (add/remove/reorder) via lock-free engine commands
// - All processing is O(N × slots) with zero allocations
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::device_slot::{
    DeviceProcessor, InternalDeviceSlot, ProcessContext,
};
use crate::dsp_processor::BuiltinEffectType;

/// Default initial capacity for device slots per chain.
/// This is NOT a hard limit — chains grow dynamically as needed.
/// The value 16 is chosen as a reasonable pre-allocation for typical
/// projects, avoiding reallocation in most cases while allowing
/// unlimited growth for power users (100+ effects per track).
pub const DEFAULT_DEVICE_SLOT_CAPACITY: usize = 16;

/// Legacy alias for backward compatibility.
/// Code that referenced MAX_DEVICE_SLOTS for capacity hints still compiles.
/// **This is NOT a hard limit** — use it only as a capacity hint.
pub const MAX_DEVICE_SLOTS: usize = DEFAULT_DEVICE_SLOT_CAPACITY;

/// Per-track device chain.
///
/// Processes audio through all active (non-bypassed) slots in series.
/// Every slot implements `DeviceProcessor` — internal effects, external
/// plugins, and device groups are all processed through the same interface.
pub struct DeviceChain {
    /// Device slots (processed in order, 0 → N).
    slots: Vec<Box<dyn DeviceProcessor>>,
    /// Cached sample rate for new device initialization.
    sample_rate: f32,
}

impl DeviceChain {
    /// Creates a new empty device chain.
    pub fn new(sample_rate: f32) -> Self {
        Self {
            slots: Vec::with_capacity(DEFAULT_DEVICE_SLOT_CAPACITY),
            sample_rate,
        }
    }

    /// Returns the number of active slots.
    pub fn slot_count(&self) -> usize {
        self.slots.len()
    }

    /// Returns the number of device slots in the chain.
    pub fn len(&self) -> usize {
        self.slots.len()
    }

    /// Returns `true` if the chain has no slots.
    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    /// Removes all devices from the chain.
    /// Used by `ClearAllDeviceChains` to atomically reset during rebuild.
    pub fn clear(&mut self) {
        self.slots.clear();
    }

    /// Returns the cached sample rate.
    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    // ── Generic device management ──────────────────────────────────────

    /// Adds any device at the specified slot index.
    ///
    /// If `slot_index` exceeds the current count, the device is appended.
    /// There is **no hard limit** on the number of devices per chain —
    /// the Vec grows dynamically. Enterprise DAWs like Ableton and Reaper
    /// have no per-track effect limits, and neither do we.
    ///
    /// # Returns
    /// `true` always (device is always added successfully).
    pub fn add_device(&mut self, slot_index: usize, device: Box<dyn DeviceProcessor>) -> bool {
        let idx = slot_index.min(self.slots.len());
        self.slots.insert(idx, device);
        true
    }

    /// Adds a built-in effect at the specified slot index.
    ///
    /// Convenience wrapper over `add_device` for internal effects.
    /// This is the entry point used by `EngineCommand::AddDevice` for
    /// built-in effect types.
    ///
    /// # Returns
    /// `true` if the device was added successfully.
    pub fn add_builtin_effect(&mut self, slot_index: usize, effect_type: BuiltinEffectType) -> bool {
        let device = InternalDeviceSlot::new(effect_type, self.sample_rate);
        self.add_device(slot_index, Box::new(device))
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

    /// Reorders a device from one slot to another.
    ///
    /// This is an atomic move (remove + re-insert) that avoids the
    /// audible gap caused by separate Remove + Add commands.
    ///
    /// # Returns
    /// `true` if the reorder was performed.
    pub fn reorder(&mut self, from: usize, to: usize) -> bool {
        if from >= self.slots.len() || to >= self.slots.len() || from == to {
            return false;
        }
        let device = self.slots.remove(from);
        // After removal, indices shift. `to` might need adjustment.
        let target = to.min(self.slots.len());
        self.slots.insert(target, device);
        true
    }

    /// Sets the bypass state of a device slot.
    pub fn set_bypass(&mut self, slot_index: usize, bypassed: bool) {
        if let Some(slot) = self.slots.get_mut(slot_index) {
            slot.set_bypass(bypassed);
        }
    }

    /// Sets a parameter on a specific device slot.
    pub fn set_param(&mut self, slot_index: usize, param_index: u8, value: f32) {
        if let Some(slot) = self.slots.get_mut(slot_index) {
            slot.set_param(param_index as u32, value as f64);
        }
    }

    // ── Processing ─────────────────────────────────────────────────────

    /// Processes stereo audio through all non-bypassed slots in series.
    ///
    /// # Real-Time Safety
    /// Zero allocations. O(N × slot_count).
    #[inline]
    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let ctx = ProcessContext {
            sample_rate,
            ..ProcessContext::default()
        };
        for slot in &mut self.slots {
            // DeviceProcessor::process handles bypass check internally.
            let _ = slot.process(left, right, None, None, &ctx);
        }
    }

    /// Processes stereo audio with a full `ProcessContext`.
    ///
    /// This is the preferred method for the unified pipeline.
    #[inline]
    pub fn process_with_context(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        context: &ProcessContext,
    ) {
        for slot in &mut self.slots {
            let _ = slot.process(left, right, None, None, context);
        }
    }

    /// Processes stereo audio with per-slot sidechain inputs.
    ///
    /// `sidechains` maps slot index to sidechain buffer pair.
    /// Slots without a sidechain entry receive `None`.
    #[inline]
    pub fn process_with_sidechains(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        sidechains: &[(Option<&[f32]>, Option<&[f32]>)],
        context: &ProcessContext,
    ) {
        for (i, slot) in self.slots.iter_mut().enumerate() {
            let (sc_l, sc_r) = sidechains
                .get(i)
                .copied()
                .unwrap_or((None, None));
            let _ = slot.process(left, right, sc_l, sc_r, context);
        }
    }

    /// Processes a single device slot with optional sidechain input.
    ///
    /// Uses a full `ProcessContext` for correct transport propagation.
    #[inline]
    pub fn process_slot_with_sidechain_ctx(
        &mut self,
        slot_index: usize,
        left: &mut [f32],
        right: &mut [f32],
        sidechain_left: Option<&[f32]>,
        sidechain_right: Option<&[f32]>,
        context: &ProcessContext,
    ) {
        if let Some(slot) = self.slots.get_mut(slot_index) {
            let _ = slot.process(left, right, sidechain_left, sidechain_right, context);
        }
    }

    /// Backward-compatible version (deprecated — prefer `process_slot_with_sidechain_ctx`).
    ///
    /// # Warning
    /// This creates a ProcessContext with only sample_rate set; playhead, tempo,
    /// and time signature default to zero/false. Use the `_ctx` variant when
    /// transport metadata is available.
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
        let ctx = ProcessContext {
            sample_rate,
            ..ProcessContext::default()
        };
        self.process_slot_with_sidechain_ctx(
            slot_index, left, right, sidechain_left, sidechain_right, &ctx,
        );
    }

    // ── Lifecycle ──────────────────────────────────────────────────────

    /// Resets all device processors (on transport seek / loop reset).
    pub fn reset_all(&mut self) {
        for slot in &mut self.slots {
            slot.reset();
        }
    }

    /// Updates the cached sample rate, propagates it to all processors,
    /// and resets their state.
    ///
    /// Must be called when the project sample rate changes.
    pub fn set_sample_rate(&mut self, sample_rate: f32) {
        if sample_rate > 0.0 && sample_rate.is_finite() {
            self.sample_rate = sample_rate;
            self.reset_all();
            // Force each processor to sync its internal sample rate
            // by running a 1-sample process pass.
            let ctx = ProcessContext {
                sample_rate,
                ..ProcessContext::default()
            };
            let mut dummy_l = [0.0f32; 1];
            let mut dummy_r = [0.0f32; 1];
            for slot in &mut self.slots {
                let _ = slot.process(&mut dummy_l, &mut dummy_r, None, None, &ctx);
            }
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
        assert_eq!(left, original);
    }

    #[test]
    fn add_and_remove_devices() {
        let mut chain = DeviceChain::new(44100.0);
        assert!(chain.is_empty());

        assert!(chain.add_builtin_effect(0, BuiltinEffectType::Utility));
        assert_eq!(chain.slot_count(), 1);

        assert!(chain.add_builtin_effect(1, BuiltinEffectType::Eq));
        assert_eq!(chain.slot_count(), 2);

        assert!(chain.remove_device(0));
        assert_eq!(chain.slot_count(), 1);
    }

    #[test]
    fn unlimited_slots_growth() {
        let mut chain = DeviceChain::new(44100.0);
        // Enterprise: no hard cap — chains grow beyond DEFAULT_DEVICE_SLOT_CAPACITY.
        let target = DEFAULT_DEVICE_SLOT_CAPACITY * 3; // 48 effects
        for _ in 0..target {
            assert!(chain.add_builtin_effect(0, BuiltinEffectType::Utility));
        }
        assert_eq!(chain.slot_count(), target);
        // Still accepts more:
        assert!(chain.add_builtin_effect(0, BuiltinEffectType::Utility));
        assert_eq!(chain.slot_count(), target + 1);
    }

    #[test]
    fn bypass_skips_processing() {
        let mut chain = DeviceChain::new(44100.0);
        chain.add_builtin_effect(0, BuiltinEffectType::Utility);
        chain.set_param(0, 0, -60.0);

        let mut left = vec![1.0f32; 4096];
        let mut right = vec![1.0f32; 4096];
        chain.process_stereo(&mut left, &mut right, 44100.0);
        let tail_avg: f32 = left[2000..].iter().map(|s| s.abs()).sum::<f32>() / 2096.0;
        assert!(tail_avg < 0.1, "Gain at -60dB should silence: {tail_avg}");

        chain.set_bypass(0, true);
        let mut left2 = vec![1.0f32; 64];
        let mut right2 = vec![1.0f32; 64];
        chain.process_stereo(&mut left2, &mut right2, 44100.0);
        assert_eq!(left2, vec![1.0f32; 64]);
    }

    #[test]
    fn chain_cascade_order() {
        let mut chain = DeviceChain::new(44100.0);
        chain.add_builtin_effect(0, BuiltinEffectType::Utility);
        chain.set_param(0, 0, -60.0);
        chain.add_builtin_effect(1, BuiltinEffectType::Compressor);

        let mut left = vec![1.0f32; 4096];
        let mut right = vec![1.0f32; 4096];
        chain.process_stereo(&mut left, &mut right, 44100.0);
        let tail_avg: f32 = left[2000..].iter().map(|s| s.abs()).sum::<f32>() / 2096.0;
        assert!(tail_avg < 0.1);
    }

    #[test]
    fn reorder_moves_device() {
        let mut chain = DeviceChain::new(44100.0);
        chain.add_builtin_effect(0, BuiltinEffectType::Utility);
        chain.add_builtin_effect(1, BuiltinEffectType::Eq);
        chain.add_builtin_effect(2, BuiltinEffectType::Compressor);
        assert_eq!(chain.slot_count(), 3);

        // Move slot 2 (Compressor) to slot 0.
        assert!(chain.reorder(2, 0));
        assert_eq!(chain.slot_count(), 3);

        // Out-of-bounds should fail.
        assert!(!chain.reorder(5, 0));
        // Same index should fail.
        assert!(!chain.reorder(1, 1));
    }

    #[test]
    fn add_generic_device() {
        let mut chain = DeviceChain::new(44100.0);
        let device = InternalDeviceSlot::new(BuiltinEffectType::Reverb, 44100.0);
        assert!(chain.add_device(0, Box::new(device)));
        assert_eq!(chain.slot_count(), 1);
    }

    #[test]
    fn process_with_context() {
        let mut chain = DeviceChain::new(44100.0);
        chain.add_builtin_effect(0, BuiltinEffectType::Utility);

        let mut left = vec![1.0f32; 64];
        let mut right = vec![1.0f32; 64];
        let ctx = ProcessContext {
            sample_rate: 44100.0,
            is_playing: true,
            ..ProcessContext::default()
        };
        chain.process_with_context(&mut left, &mut right, &ctx);
        assert!(left.iter().all(|s| s.abs() > 0.9));
    }

    #[test]
    fn process_with_sidechains() {
        let mut chain = DeviceChain::new(44100.0);
        chain.add_builtin_effect(0, BuiltinEffectType::Compressor);

        let mut left = vec![1.0f32; 64];
        let mut right = vec![1.0f32; 64];
        let sc_left = vec![0.5f32; 64];
        let sc_right = vec![0.5f32; 64];
        let sidechains = vec![(Some(sc_left.as_slice()), Some(sc_right.as_slice()))];
        let ctx = ProcessContext::default();
        chain.process_with_sidechains(&mut left, &mut right, &sidechains, &ctx);
        // Should process without panic.
    }
}
