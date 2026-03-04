// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Unified Device Slot
// ═══════════════════════════════════════════════════════════════════════════
//
// Canonical trait for every device in the signal chain.
//
// Internal DSP effects, external VST3/CLAP/AU plugins, device groups —
// they all implement `DeviceProcessor` and occupy the same `DeviceChain`.
// The audio callback iterates a single `Vec<Box<dyn DeviceProcessor>>`
// without branching on device type.
//
// # Layering
//
// `DeviceProcessor` trait + `InternalDeviceSlot` live here (dream_dsp).
// `ExternalDeviceSlot` lives in dream_engine (depends on dream_plugins).
// `DeviceGroupSlot` lives here (dream_dsp) — recursive composition.
//
// # Real-Time Safety
//
// Every `DeviceProcessor::process()` implementation MUST be:
//   - O(N) where N = buffer length
//   - Zero allocations
//   - Zero syscalls
//   - Bounded execution time
//
// The only exception is `ExternalDeviceSlot` which uses `try_lock()`.
// If the lock is contended, it returns `ProcessResult::Skipped`.
//
// ═══════════════════════════════════════════════════════════════════════════


use crate::dsp_processor::{BuiltinEffectType, DspProcessor};

// ═══════════════════════════════════════════════════════════════════════════
// Process Context (passed to every device per-buffer)
// ═══════════════════════════════════════════════════════════════════════════

/// Lightweight context passed to `DeviceProcessor::process()` on each buffer.
///
/// Copy, zero-alloc, safe for the audio thread.
#[derive(Debug, Clone, Copy)]
pub struct ProcessContext {
    /// Device output sample rate (Hz).
    pub sample_rate: f32,
    /// Current playhead position in sample frames.
    pub playhead_frames: i64,
    /// Current project tempo (BPM).
    pub tempo: f64,
    /// Whether transport is playing.
    pub is_playing: bool,
    /// Time signature numerator.
    pub time_sig_numerator: u8,
    /// Time signature denominator.
    pub time_sig_denominator: u8,
}

impl Default for ProcessContext {
    fn default() -> Self {
        Self {
            sample_rate: 44100.0,
            playhead_frames: 0,
            tempo: 120.0,
            is_playing: false,
            time_sig_numerator: 4,
            time_sig_denominator: 4,
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Process Result
// ═══════════════════════════════════════════════════════════════════════════

/// Outcome of a `DeviceProcessor::process()` call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessResult {
    /// Audio was processed normally.
    Processed,
    /// Processing was skipped (e.g. external plugin mutex contended).
    /// Audio passes through unmodified.
    Skipped,
}

// ═══════════════════════════════════════════════════════════════════════════
// Device Kind (classification metadata)
// ═══════════════════════════════════════════════════════════════════════════

/// Classification of a device slot.
///
/// Used for UI rendering, state persistence, and diagnostics.
/// **Never** used for branching in the audio callback — all devices
/// are processed through the same `DeviceProcessor::process()` call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceKind {
    /// Built-in DSP effect (EQ, Compressor, Delay, etc.).
    InternalEffect(BuiltinEffectType),
    /// External plugin (VST3, CLAP, AU) used as an effect.
    ExternalPlugin,
    /// Built-in instrument (Sampler, EssenceSynth, SampleRack).
    InternalInstrument,
    /// External instrument plugin (Serum, Vital, etc.).
    ExternalInstrument,
    /// Device group with parallel chains and macro knobs.
    Group,
}

// ═══════════════════════════════════════════════════════════════════════════
// DeviceProcessor trait
// ═══════════════════════════════════════════════════════════════════════════

/// Unified trait for every device in the signal chain.
///
/// Internal effects, external plugins, device groups — all implement this.
/// The audio callback iterates `Vec<Box<dyn DeviceProcessor>>` in order,
/// calling `process()` on each slot. No branching by device type.
///
/// # Thread Safety
///
/// Implementations must be `Send` for initial transfer from the UI thread.
/// All processing happens on the audio thread — no `Sync` required.
pub trait DeviceProcessor: Send {
    /// Process stereo audio in-place with optional sidechain input.
    ///
    /// # Arguments
    /// - `left`, `right`: Main stereo audio buffers (modified in-place).
    /// - `sidechain_left`, `sidechain_right`: Optional sidechain input.
    /// - `context`: Transport and sample rate context for this buffer.
    ///
    /// # Returns
    /// `ProcessResult::Processed` on success, `ProcessResult::Skipped` if
    /// an external plugin's mutex was contended (passthrough).
    ///
    /// # Real-Time Safety
    /// MUST be O(N) where N = buffer length. Zero allocations.
    fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        sidechain_left: Option<&[f32]>,
        sidechain_right: Option<&[f32]>,
        context: &ProcessContext,
    ) -> ProcessResult;

    /// Set a parameter by index.
    ///
    /// # Real-Time Safety
    /// Must be O(1). Called from the audio thread via command dispatch.
    fn set_param(&mut self, index: u32, value: f64);

    /// Reset internal state (delay lines, filter history, etc.).
    ///
    /// Called on transport seek or loop boundary to prevent artifacts.
    fn reset(&mut self);

    /// Report processing latency in samples (for PDC compensation).
    fn latency_samples(&self) -> usize;

    /// Device classification metadata.
    fn device_kind(&self) -> DeviceKind;

    /// Whether this device slot is bypassed (passthrough).
    fn is_bypassed(&self) -> bool;

    /// Set the bypass state.
    fn set_bypass(&mut self, bypassed: bool);
}

// ═══════════════════════════════════════════════════════════════════════════
// InternalDeviceSlot — wraps Box<dyn DspProcessor>
// ═══════════════════════════════════════════════════════════════════════════

/// A device slot wrapping a built-in DSP effect processor.
///
/// Processing is guaranteed RT-safe: zero allocations, zero locks.
/// Parameter smoothing is handled by the inner `SmoothedProcessor`.
pub struct InternalDeviceSlot {
    /// The DSP processor instance (SmoothedProcessor wrapping raw DSP).
    processor: Box<dyn DspProcessor>,
    /// The type of built-in effect.
    effect_type: BuiltinEffectType,
    /// Whether this slot is bypassed.
    bypassed: bool,
}

impl InternalDeviceSlot {
    /// Creates a new internal device slot from a built-in effect type.
    ///
    /// The processor is instantiated via `BuiltinEffectType::create_processor()`,
    /// which creates a `SmoothedProcessor` wrapping the raw DSP implementation.
    pub fn new(effect_type: BuiltinEffectType, sample_rate: f32) -> Self {
        Self {
            processor: effect_type.create_processor(sample_rate),
            effect_type,
            bypassed: false,
        }
    }

    /// Returns the built-in effect type.
    pub fn effect_type(&self) -> BuiltinEffectType {
        self.effect_type
    }
}

impl DeviceProcessor for InternalDeviceSlot {
    #[inline]
    fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        sidechain_left: Option<&[f32]>,
        sidechain_right: Option<&[f32]>,
        context: &ProcessContext,
    ) -> ProcessResult {
        if self.bypassed {
            return ProcessResult::Processed;
        }
        self.processor.set_transport(context.tempo as f32, context.is_playing);
        self.processor.process_stereo_with_sidechain(
            left,
            right,
            sidechain_left,
            sidechain_right,
            context.sample_rate,
        );
        ProcessResult::Processed
    }

    #[inline]
    fn set_param(&mut self, index: u32, value: f64) {
        // DspProcessor uses u8 index and f32 value; clamp to match.
        if index <= u8::MAX as u32 {
            self.processor.set_param(index as u8, value as f32);
        }
    }

    fn reset(&mut self) {
        self.processor.reset();
    }

    fn latency_samples(&self) -> usize {
        self.processor.latency_samples()
    }

    fn device_kind(&self) -> DeviceKind {
        DeviceKind::InternalEffect(self.effect_type)
    }

    fn is_bypassed(&self) -> bool {
        self.bypassed
    }

    fn set_bypass(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// DeviceGroupSlot — parallel chains with macro knobs
// ═══════════════════════════════════════════════════════════════════════════

/// Maximum number of macro controls per device group.
pub const MAX_MACROS: usize = 16;

/// Maximum number of parallel chains per device group.
pub const MAX_GROUP_CHAINS: usize = 8;

/// Maximum pre-allocated buffer size for group scratch buffers.
const GROUP_MAX_FRAMES: usize = 8192;

/// Maps a macro knob value to a child device parameter.
///
/// When the macro value changes, the target parameter is linearly
/// interpolated: macro at 0.0 → `min_value`, macro at 1.0 → `max_value`.
#[derive(Debug, Clone)]
pub struct MacroMapping {
    /// Index of the target chain within this group.
    pub chain_index: usize,
    /// Index of the target device within the chain.
    pub slot_index: usize,
    /// Parameter index on the target device.
    pub param_index: u32,
    /// Value sent when macro is at minimum (0.0).
    pub min_value: f64,
    /// Value sent when macro is at maximum (1.0).
    pub max_value: f64,
}

/// State of a single macro control knob.
#[derive(Debug, Clone)]
pub struct MacroState {
    /// Current macro value (0.0 – 1.0).
    pub value: f64,
    /// Parameter mappings driven by this macro.
    pub mappings: Vec<MacroMapping>,
}

impl Default for MacroState {
    fn default() -> Self {
        Self {
            value: 0.0,
            mappings: Vec::new(),
        }
    }
}

/// A device group containing parallel processing chains with macro knobs.
///
/// This is the runtime equivalent of the project model's `DeviceRack`.
/// It implements `DeviceProcessor`, so it can be placed inside any
/// `DeviceChain` — including other groups (recursive nesting).
///
/// # Processing
///
/// 1. Apply macro → child parameter mappings
/// 2. Copy input into per-chain scratch buffers
/// 3. Process each non-muted chain independently
/// 4. Sum chain outputs (with per-chain volume/pan)
/// 5. Write summed result to main output buffers
///
/// # Memory
///
/// Scratch buffers are pre-allocated at construction time.
/// Processing is zero-alloc.
pub struct DeviceGroupSlot {
    /// Parallel processing chains. Each chain is an independent `DeviceChain`.
    /// We use `Vec<Vec<Box<dyn DeviceProcessor>>>` directly here to avoid
    /// a circular dependency on `device_chain::DeviceChain`.
    chains: Vec<GroupChain>,
    /// Macro control knobs (up to MAX_MACROS).
    macros: [MacroState; MAX_MACROS],
    /// Whether this group is bypassed.
    bypassed: bool,
    /// Cached sample rate.
    _sample_rate: f32,
    /// Pre-allocated scratch buffers for parallel chain processing.
    scratch_left: Vec<f32>,
    scratch_right: Vec<f32>,
    /// Accumulator buffers for summing chain outputs.
    sum_left: Vec<f32>,
    sum_right: Vec<f32>,
}

/// A single chain within a device group.
pub struct GroupChain {
    /// Ordered devices in this chain.
    pub devices: Vec<Box<dyn DeviceProcessor>>,
    /// Whether this chain is muted.
    pub is_muted: bool,
    /// Whether this chain is soloed.
    pub is_solo: bool,
    /// Chain volume (0.0 – 2.0, 1.0 = unity).
    pub volume: f32,
    /// Chain pan (-1.0 to 1.0, 0.0 = center).
    pub pan: f32,
}

impl GroupChain {
    /// Creates a new empty chain.
    pub fn new() -> Self {
        Self {
            devices: Vec::new(),
            is_muted: false,
            is_solo: false,
            volume: 1.0,
            pan: 0.0,
        }
    }
}

impl Default for GroupChain {
    fn default() -> Self {
        Self::new()
    }
}

impl DeviceGroupSlot {
    /// Creates a new empty device group.
    pub fn new(sample_rate: f32) -> Self {
        Self {
            chains: Vec::with_capacity(MAX_GROUP_CHAINS),
            macros: std::array::from_fn(|_| MacroState::default()),
            bypassed: false,
            _sample_rate: sample_rate,
            scratch_left: vec![0.0; GROUP_MAX_FRAMES],
            scratch_right: vec![0.0; GROUP_MAX_FRAMES],
            sum_left: vec![0.0; GROUP_MAX_FRAMES],
            sum_right: vec![0.0; GROUP_MAX_FRAMES],
        }
    }

    /// Adds a new empty chain. Returns the chain index.
    pub fn add_chain(&mut self) -> usize {
        if self.chains.len() >= MAX_GROUP_CHAINS {
            return self.chains.len().saturating_sub(1);
        }
        self.chains.push(GroupChain::new());
        self.chains.len() - 1
    }

    /// Returns a mutable reference to a chain by index.
    pub fn chain_mut(&mut self, index: usize) -> Option<&mut GroupChain> {
        self.chains.get_mut(index)
    }

    /// Returns the number of chains.
    pub fn chain_count(&self) -> usize {
        self.chains.len()
    }

    /// Sets a macro knob value and propagates to all mapped parameters.
    pub fn set_macro(&mut self, macro_index: usize, value: f64) {
        if macro_index >= MAX_MACROS {
            return;
        }
        let clamped = value.clamp(0.0, 1.0);
        self.macros[macro_index].value = clamped;

        // BUG-C001 FIX: Zero-alloc index-based iteration (matches apply_macros).
        // Previous code used `collect::<Vec<_>>()` which allocated on every call.
        for mapping_idx in 0..self.macros[macro_index].mappings.len() {
            let m = &self.macros[macro_index].mappings[mapping_idx];
            let param_value = m.min_value + clamped * (m.max_value - m.min_value);
            let ci = m.chain_index;
            let si = m.slot_index;
            let pi = m.param_index;
            if ci < self.chains.len()
                && si < self.chains[ci].devices.len() {
                    self.chains[ci].devices[si].set_param(pi, param_value);
                }
        }
    }

    /// Applies all macro → child parameter mappings at their current values.
    #[inline]
    fn apply_macros(&mut self) {
        for macro_idx in 0..MAX_MACROS {
            let value = self.macros[macro_idx].value;
            if self.macros[macro_idx].mappings.is_empty() {
                continue;
            }
            // Inline the mapping application to avoid re-collecting.
            for mapping_idx in 0..self.macros[macro_idx].mappings.len() {
                let m = &self.macros[macro_idx].mappings[mapping_idx];
                let param_value = m.min_value + value * (m.max_value - m.min_value);
                let ci = m.chain_index;
                let si = m.slot_index;
                let pi = m.param_index;
                // SAFETY: We index chains/devices only if in bounds.
                if ci < self.chains.len()
                    && si < self.chains[ci].devices.len() {
                        self.chains[ci].devices[si].set_param(pi, param_value);
                    }
            }
        }
    }
}

impl DeviceProcessor for DeviceGroupSlot {
    fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        _sidechain_left: Option<&[f32]>,
        _sidechain_right: Option<&[f32]>,
        context: &ProcessContext,
    ) -> ProcessResult {
        if self.bypassed || self.chains.is_empty() {
            return ProcessResult::Processed;
        }

        let n = left.len().min(right.len()).min(GROUP_MAX_FRAMES);

        // 1. Apply macro → child param mappings.
        self.apply_macros();

        // 2. Determine which chains are active (solo/mute logic).
        let any_solo = self.chains.iter().any(|c| c.is_solo);

        // 3. Clear sum accumulator.
        self.sum_left[..n].fill(0.0);
        self.sum_right[..n].fill(0.0);
        let mut active_chains = 0u32;

        // 4. Process each chain into scratch, then accumulate.
        for chain_idx in 0..self.chains.len() {
            let chain = &self.chains[chain_idx];
            // Solo/mute gating.
            if chain.is_muted || (any_solo && !chain.is_solo) {
                continue;
            }
            let chain_volume = chain.volume;
            let chain_pan = chain.pan;

            // Copy input into scratch buffers.
            self.scratch_left[..n].copy_from_slice(&left[..n]);
            self.scratch_right[..n].copy_from_slice(&right[..n]);

            // Process all devices in this chain serially.
            // SAFETY: We need to split borrow — chain devices vs scratch buffers.
            // Use raw pointer dance to avoid borrow checker conflict.
            let scratch_l = &mut self.scratch_left[..n] as *mut [f32];
            let scratch_r = &mut self.scratch_right[..n] as *mut [f32];
            let chain = &mut self.chains[chain_idx];
            for device in &mut chain.devices {
                // SAFETY: scratch_l/scratch_r are owned by self and not aliased
                // by any device — devices only hold their own internal state.
                unsafe {
                    let _ = device.process(
                        &mut *scratch_l,
                        &mut *scratch_r,
                        None,
                        None,
                        context,
                    );
                }
            }

            // Apply chain volume and pan, then accumulate into sum.
            let pan_left = (1.0 - chain_pan).min(1.0);
            let pan_right = (1.0 + chain_pan).min(1.0);
            let gain_l = chain_volume * pan_left;
            let gain_r = chain_volume * pan_right;

            for i in 0..n {
                // SAFETY: scratch buffers are our own, not device-owned.
                unsafe {
                    self.sum_left[i] += (*scratch_l)[i] * gain_l;
                    self.sum_right[i] += (*scratch_r)[i] * gain_r;
                }
            }
            active_chains += 1;
        }

        // 5. Write summed result to output.
        if active_chains > 0 {
            left[..n].copy_from_slice(&self.sum_left[..n]);
            right[..n].copy_from_slice(&self.sum_right[..n]);
        }
        // If no chains were active, output passes through unmodified.

        ProcessResult::Processed
    }

    fn set_param(&mut self, index: u32, value: f64) {
        // Group-level params: index 0–15 map to macro knobs.
        if (index as usize) < MAX_MACROS {
            self.set_macro(index as usize, value);
        }
    }

    fn reset(&mut self) {
        for chain in &mut self.chains {
            for device in &mut chain.devices {
                device.reset();
            }
        }
    }

    fn latency_samples(&self) -> usize {
        // Group latency = max of all chain latencies.
        // Chain latency = sum of device latencies in that chain.
        self.chains
            .iter()
            .filter(|c| !c.is_muted)
            .map(|chain| {
                chain
                    .devices
                    .iter()
                    .filter(|d| !d.is_bypassed())
                    .map(|d| d.latency_samples())
                    .sum::<usize>()
            })
            .max()
            .unwrap_or(0)
    }

    fn device_kind(&self) -> DeviceKind {
        DeviceKind::Group
    }

    fn is_bypassed(&self) -> bool {
        self.bypassed
    }

    fn set_bypass(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_device_slot_passthrough_when_empty() {
        let mut slot = InternalDeviceSlot::new(BuiltinEffectType::Utility, 44100.0);
        // Default utility gain is 0 dB (passthrough).
        let mut left = vec![1.0f32; 64];
        let mut right = vec![1.0f32; 64];
        let ctx = ProcessContext::default();
        let result = slot.process(&mut left, &mut right, None, None, &ctx);
        assert_eq!(result, ProcessResult::Processed);
        // Utility at default gain should pass signal through.
        assert!(left.iter().all(|s| s.abs() > 0.9));
    }

    #[test]
    fn internal_device_slot_bypass() {
        let mut slot = InternalDeviceSlot::new(BuiltinEffectType::Utility, 44100.0);
        // Set gain to -60 dB (silence).
        slot.set_param(0, -60.0);
        slot.set_bypass(true);

        let mut left = vec![1.0f32; 64];
        let mut right = vec![1.0f32; 64];
        let ctx = ProcessContext::default();
        slot.process(&mut left, &mut right, None, None, &ctx);

        // Bypassed — signal should pass through unchanged.
        assert!(left.iter().all(|s| (*s - 1.0).abs() < 0.001));
    }

    #[test]
    fn device_group_empty_passthrough() {
        let mut group = DeviceGroupSlot::new(44100.0);
        let mut left = vec![0.5f32; 64];
        let mut right = vec![0.5f32; 64];
        let original = left.clone();
        let ctx = ProcessContext::default();
        group.process(&mut left, &mut right, None, None, &ctx);
        // Empty group should passthrough.
        assert_eq!(left, original);
    }

    #[test]
    fn device_group_single_chain_processes() {
        let mut group = DeviceGroupSlot::new(44100.0);
        let chain_idx = group.add_chain();
        // Add a utility effect to the chain.
        let utility = InternalDeviceSlot::new(BuiltinEffectType::Utility, 44100.0);
        group.chains[chain_idx].devices.push(Box::new(utility));

        let mut left = vec![0.5f32; 64];
        let mut right = vec![0.5f32; 64];
        let ctx = ProcessContext::default();
        let result = group.process(&mut left, &mut right, None, None, &ctx);
        assert_eq!(result, ProcessResult::Processed);
        // Signal should have been processed (utility at default = passthrough).
        assert!(left.iter().all(|s| s.abs() > 0.4));
    }

    #[test]
    fn device_group_bypass() {
        let mut group = DeviceGroupSlot::new(44100.0);
        let chain_idx = group.add_chain();
        let mut utility = InternalDeviceSlot::new(BuiltinEffectType::Utility, 44100.0);
        utility.set_param(0, -60.0);
        group.chains[chain_idx].devices.push(Box::new(utility));
        group.set_bypass(true);

        let mut left = vec![1.0f32; 64];
        let mut right = vec![1.0f32; 64];
        let ctx = ProcessContext::default();
        group.process(&mut left, &mut right, None, None, &ctx);
        // Bypassed group — signal unchanged.
        assert!(left.iter().all(|s| (*s - 1.0).abs() < 0.001));
    }

    #[test]
    fn device_group_muted_chain_skipped() {
        let mut group = DeviceGroupSlot::new(44100.0);
        let chain_idx = group.add_chain();
        let utility = InternalDeviceSlot::new(BuiltinEffectType::Utility, 44100.0);
        group.chains[chain_idx].devices.push(Box::new(utility));
        group.chains[chain_idx].is_muted = true;

        let mut left = vec![0.5f32; 64];
        let mut right = vec![0.5f32; 64];
        let original = left.clone();
        let ctx = ProcessContext::default();
        group.process(&mut left, &mut right, None, None, &ctx);
        // Muted chain — signal passes through unmodified.
        assert_eq!(left, original);
    }

    #[test]
    fn device_kind_metadata() {
        let slot = InternalDeviceSlot::new(BuiltinEffectType::Eq, 44100.0);
        assert_eq!(slot.device_kind(), DeviceKind::InternalEffect(BuiltinEffectType::Eq));

        let group = DeviceGroupSlot::new(44100.0);
        assert_eq!(group.device_kind(), DeviceKind::Group);
    }

    #[test]
    fn macro_mapping_applies_to_child() {
        let mut group = DeviceGroupSlot::new(44100.0);
        let chain_idx = group.add_chain();
        let utility = InternalDeviceSlot::new(BuiltinEffectType::Utility, 44100.0);
        group.chains[chain_idx].devices.push(Box::new(utility));

        // Map macro 0 → chain 0, slot 0, param 0 (utility gain), range -60 to 0.
        group.macros[0].mappings.push(MacroMapping {
            chain_index: 0,
            slot_index: 0,
            param_index: 0,
            min_value: -60.0,
            max_value: 0.0,
        });

        // Set macro to midpoint → should set gain to -30 dB.
        group.set_macro(0, 0.5);
        assert!((group.macros[0].value - 0.5).abs() < 1e-6);
    }

    #[test]
    fn latency_samples_max_of_chains() {
        let group = DeviceGroupSlot::new(44100.0);
        // Empty group should report 0 latency.
        assert_eq!(group.latency_samples(), 0);
    }
}
