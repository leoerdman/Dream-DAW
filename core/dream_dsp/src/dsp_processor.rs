// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Built-in DSP Processor Trait
// ═══════════════════════════════════════════════════════════════════════════
//
// Unified trait for all built-in audio effect processors.
// Every implementation MUST be real-time safe:
//   - Zero allocations during `process_stereo()`
//   - Zero locks, zero I/O, zero syscalls
//   - Bounded execution time
//
// ═══════════════════════════════════════════════════════════════════════════

/// Trait for all built-in DSP processors.
///
/// Implementors process stereo audio in-place with zero allocations.
/// Parameters are set via `set_param()` which enqueues changes
/// applied at the next `process_stereo()` call.
///
/// # Thread Safety
/// Processors live on the audio thread. `Send` is required for
/// initial transfer from the UI thread during setup.
pub trait DspProcessor: Send {
    /// Processes stereo audio buffers in-place.
    ///
    /// # Arguments
    /// - `left`: Left channel samples (modified in-place).
    /// - `right`: Right channel samples (modified in-place).
    /// - `sample_rate`: Current sample rate in Hz.
    ///
    /// # Real-Time Safety
    /// MUST be O(N) where N = buffer length. Zero allocations.
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32);

    /// Processes stereo audio with optional external sidechain signal.
    ///
    /// Default behavior ignores sidechain and falls back to `process_stereo`.
    #[allow(unused_variables)]
    fn process_stereo_with_sidechain(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        sidechain_left: Option<&[f32]>,
        sidechain_right: Option<&[f32]>,
        sample_rate: f32,
    ) {
        self.process_stereo(left, right, sample_rate);
    }

    /// Sets a parameter by index.
    ///
    /// # Arguments
    /// - `index`: Parameter index (0-based, meaning depends on processor type).
    /// - `value`: New parameter value (raw units, not normalized).
    ///
    /// # Real-Time Safety
    /// Must be O(1). Called from the audio thread via command dispatch.
    fn set_param(&mut self, index: u8, value: f32);

    /// Resets internal state (delay lines, filter history, etc.).
    ///
    /// Called on transport seek or loop boundary to prevent artifacts.
    fn reset(&mut self);

    /// Returns the processor's latency in samples (for PDC compensation).
    ///
    /// Processors with lookahead buffers (Compressor, Limiter) must report
    /// their internal delay so the host can align tracks correctly.
    /// Default: 0 (no latency).
    fn latency_samples(&self) -> usize {
        0
    }
}

const MAX_SMOOTHED_PARAMS: usize = 64;
const PARAM_SMOOTH_TIME_SEC: f32 = 0.010;

struct SmoothedProcessor {
    inner: Box<dyn DspProcessor>,
    effect_type: BuiltinEffectType,
    sample_rate: f32,
    current: [f32; MAX_SMOOTHED_PARAMS],
    target: [f32; MAX_SMOOTHED_PARAMS],
    initialized: [bool; MAX_SMOOTHED_PARAMS],
    active: [bool; MAX_SMOOTHED_PARAMS],
}

impl SmoothedProcessor {
    fn new(effect_type: BuiltinEffectType, inner: Box<dyn DspProcessor>, sample_rate: f32) -> Self {
        Self {
            inner,
            effect_type,
            sample_rate,
            current: [0.0; MAX_SMOOTHED_PARAMS],
            target: [0.0; MAX_SMOOTHED_PARAMS],
            initialized: [false; MAX_SMOOTHED_PARAMS],
            active: [false; MAX_SMOOTHED_PARAMS],
        }
    }

    #[inline]
    fn should_smooth(&self, index: usize) -> bool {
        !matches!(
            (self.effect_type, index),
            // EQ enable/type toggles
            (BuiltinEffectType::Eq, 3 | 7 | 11 | 15 | 19 | 23 | 27 | 31)
                | (BuiltinEffectType::Eq, 33..=40)
                // Compressor toggles
                | (BuiltinEffectType::Compressor, 8 | 9)
                // Delay toggle
                | (BuiltinEffectType::Delay, 5)
                // Reverb toggle
                | (BuiltinEffectType::Reverb, 8)
                // Chorus voices (discrete)
                | (BuiltinEffectType::Chorus, 4)
                // Utility mono
                | (BuiltinEffectType::Utility, 3)
                // Saturator mode
                | (BuiltinEffectType::Saturator, 3)
                // Limiter auto-release
                | (BuiltinEffectType::Limiter, 4)
                // Gate duck mode
                | (BuiltinEffectType::Gate, 7)
                // AutoFilter type/shape
                | (BuiltinEffectType::AutoFilter, 5 | 7)
                // Phaser stages/shape
                | (BuiltinEffectType::Phaser, 3 | 7)
                // Flanger shape/TZ
                | (BuiltinEffectType::Flanger, 6 | 8)
                // Distortion mode/cab
                | (BuiltinEffectType::Distortion, 3 | 5)
                // Bitcrusher stereo mode
                | (BuiltinEffectType::Bitcrusher, 6)
                // Noise machine type
                | (BuiltinEffectType::NoiseMachine, 1)
                // Auto-pan shape
                | (BuiltinEffectType::AutoPan, 3)
                // Analyzer reset trigger
                | (BuiltinEffectType::Analyzer, 0)
        )
    }

    #[inline]
    fn sync_sample_rate(&mut self, sample_rate: f32) {
        if sample_rate.is_finite()
            && sample_rate > 1000.0
            && (sample_rate - self.sample_rate).abs() > 0.5
        {
            self.sample_rate = sample_rate;
        }
    }

    #[inline]
    fn apply_smoothing(&mut self, block_len: usize) {
        if block_len == 0 {
            return;
        }
        let coeff =
            (-(block_len as f32) / (PARAM_SMOOTH_TIME_SEC * self.sample_rate.max(1.0))).exp();
        let blend = 1.0 - coeff;

        for i in 0..MAX_SMOOTHED_PARAMS {
            if !self.active[i] {
                continue;
            }
            let c = self.current[i];
            let t = self.target[i];
            let next = coeff * c + blend * t;
            // AUD-207 FIX: Check convergence BEFORE calling set_param.
            // Processors like Compressor/Gate/Limiter recalculate coefficients
            // inside set_param() — calling it with the same converged value is
            // redundant and wastes CPU (multiple exp() calls per buffer).
            if (next - t).abs() < 1.0e-6 {
                if (self.current[i] - t).abs() > 1.0e-6 {
                    // Final call to reach exact target value
                    self.current[i] = t;
                    self.inner.set_param(i as u8, t);
                }
                self.active[i] = false;
            } else {
                self.current[i] = next;
                self.inner.set_param(i as u8, next);
            }
        }
    }
}

impl DspProcessor for SmoothedProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        self.sync_sample_rate(sample_rate);
        self.apply_smoothing(left.len().min(right.len()));
        self.inner.process_stereo(left, right, sample_rate);
    }

    fn process_stereo_with_sidechain(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        sidechain_left: Option<&[f32]>,
        sidechain_right: Option<&[f32]>,
        sample_rate: f32,
    ) {
        self.sync_sample_rate(sample_rate);
        self.apply_smoothing(left.len().min(right.len()));
        self.inner.process_stereo_with_sidechain(
            left,
            right,
            sidechain_left,
            sidechain_right,
            sample_rate,
        );
    }

    fn set_param(&mut self, index: u8, value: f32) {
        let idx = index as usize;
        if idx >= MAX_SMOOTHED_PARAMS || !self.should_smooth(idx) {
            self.inner.set_param(index, value);
            if idx < MAX_SMOOTHED_PARAMS {
                self.current[idx] = value;
                self.target[idx] = value;
                self.initialized[idx] = true;
                self.active[idx] = false;
            }
            return;
        }

        if !self.initialized[idx] {
            // First write preserves plugin default behavior and avoids startup ramps.
            self.current[idx] = value;
            self.target[idx] = value;
            self.initialized[idx] = true;
            self.active[idx] = false;
            self.inner.set_param(index, value);
            return;
        }

        self.target[idx] = value;
        self.active[idx] = true;
    }

    fn reset(&mut self) {
        self.inner.reset();
        self.active.fill(false);
        // Keep current/target so post-reset parameter continuity remains smooth.
    }

    fn latency_samples(&self) -> usize {
        self.inner.latency_samples()
    }
}

/// Enumeration of built-in effect types.
///
/// The `u8` discriminant is sent over the lock-free command queue
/// to identify which processor to instantiate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum BuiltinEffectType {
    Eq = 0,
    Compressor = 1,
    Delay = 2,
    Reverb = 3,
    Chorus = 4,
    Utility = 5,
    Saturator = 6,
    // Wave 1 — Essential Effects
    Limiter = 7,
    Gate = 8,
    AutoFilter = 9,
    Phaser = 10,
    Flanger = 11,
    Distortion = 12,
    Bitcrusher = 13,
    NoiseMachine = 14,
    AutoPan = 15,
    // Wave 2 — Metering & Analysis
    Analyzer = 16,
}

impl BuiltinEffectType {
    /// Converts a raw `u8` to an effect type. Returns `None` for invalid values.
    pub fn from_u8(val: u8) -> Option<Self> {
        match val {
            0 => Some(Self::Eq),
            1 => Some(Self::Compressor),
            2 => Some(Self::Delay),
            3 => Some(Self::Reverb),
            4 => Some(Self::Chorus),
            5 => Some(Self::Utility),
            6 => Some(Self::Saturator),
            7 => Some(Self::Limiter),
            8 => Some(Self::Gate),
            9 => Some(Self::AutoFilter),
            10 => Some(Self::Phaser),
            11 => Some(Self::Flanger),
            12 => Some(Self::Distortion),
            13 => Some(Self::Bitcrusher),
            14 => Some(Self::NoiseMachine),
            15 => Some(Self::AutoPan),
            16 => Some(Self::Analyzer),
            _ => None,
        }
    }

    /// Creates a new processor instance for this effect type.
    ///
    /// All processors are pre-allocated with maximum buffer sizes.
    pub fn create_processor(&self, sample_rate: f32) -> Box<dyn DspProcessor> {
        let inner: Box<dyn DspProcessor> = match self {
            Self::Utility => Box::new(super::processors::utility::UtilityProcessor::new(
                sample_rate,
            )),
            Self::Eq => Box::new(super::processors::eq::EqProcessor::new(sample_rate as f64)),
            Self::Compressor => Box::new(super::processors::compressor::CompressorProcessor::new(
                sample_rate,
            )),
            Self::Delay => Box::new(super::processors::delay::DelayProcessor::new(sample_rate)),
            Self::Reverb => Box::new(super::processors::reverb::ReverbProcessor::new(sample_rate)),
            Self::Chorus => Box::new(super::processors::chorus::ChorusProcessor::new(sample_rate)),
            Self::Saturator => Box::new(super::processors::saturator::SaturatorProcessor::new(
                sample_rate,
            )),
            // Wave 1
            Self::Limiter => Box::new(super::processors::limiter::LimiterProcessor::new(
                sample_rate,
            )),
            Self::Gate => Box::new(super::processors::gate::GateProcessor::new(sample_rate)),
            Self::AutoFilter => Box::new(super::processors::auto_filter::AutoFilterProcessor::new(
                sample_rate,
            )),
            Self::Phaser => Box::new(super::processors::phaser::PhaserProcessor::new(sample_rate)),
            Self::Flanger => Box::new(super::processors::flanger::FlangerProcessor::new(
                sample_rate,
            )),
            Self::Distortion => Box::new(super::processors::distortion::DistortionProcessor::new(
                sample_rate,
            )),
            Self::Bitcrusher => Box::new(super::processors::bitcrusher::BitcrusherProcessor::new(
                sample_rate,
            )),
            Self::NoiseMachine => {
                Box::new(super::processors::noise_machine::NoiseMachineProcessor::new(sample_rate))
            }
            Self::AutoPan => Box::new(super::processors::auto_pan::AutoPanProcessor::new(
                sample_rate,
            )),
            Self::Analyzer => Box::new(super::processors::analyzer::AnalyzerProcessor::new(
                sample_rate,
            )),
        };
        Box::new(SmoothedProcessor::new(*self, inner, sample_rate))
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_effect_type_roundtrip() {
        for i in 0..=16u8 {
            let ty = BuiltinEffectType::from_u8(i).unwrap();
            assert_eq!(ty as u8, i);
        }
        assert!(BuiltinEffectType::from_u8(17).is_none());
        assert!(BuiltinEffectType::from_u8(255).is_none());
    }

    #[test]
    fn create_all_processors() {
        let sr = 44100.0;
        for i in 0..=16u8 {
            let ty = BuiltinEffectType::from_u8(i).unwrap();
            let mut proc = ty.create_processor(sr);
            // Process silence — should produce silence
            let mut left = vec![0.0f32; 512];
            let mut right = vec![0.0f32; 512];
            proc.process_stereo(&mut left, &mut right, sr);
        }
    }
}
