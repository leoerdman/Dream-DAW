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
            _ => None,
        }
    }

    /// Creates a new processor instance for this effect type.
    ///
    /// All processors are pre-allocated with maximum buffer sizes.
    pub fn create_processor(&self, sample_rate: f32) -> Box<dyn DspProcessor> {
        match self {
            Self::Utility => Box::new(super::processors::utility::UtilityProcessor::new()),
            Self::Eq => Box::new(super::processors::eq::EqProcessor::new(sample_rate as f64)),
            Self::Compressor => Box::new(super::processors::compressor::CompressorProcessor::new(
                sample_rate,
            )),
            Self::Delay => Box::new(super::processors::delay::DelayProcessor::new(sample_rate)),
            Self::Reverb => Box::new(super::processors::reverb::ReverbProcessor::new(sample_rate)),
            Self::Chorus => Box::new(super::processors::chorus::ChorusProcessor::new(sample_rate)),
            Self::Saturator => Box::new(super::processors::saturator::SaturatorProcessor::new(sample_rate)),
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
            Self::Distortion => Box::new(super::processors::distortion::DistortionProcessor::new(sample_rate)),
            Self::Bitcrusher => Box::new(super::processors::bitcrusher::BitcrusherProcessor::new(sample_rate)),
            Self::NoiseMachine => {
                Box::new(super::processors::noise_machine::NoiseMachineProcessor::new(sample_rate))
            }
            Self::AutoPan => Box::new(super::processors::auto_pan::AutoPanProcessor::new(
                sample_rate,
            )),
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
    fn builtin_effect_type_roundtrip() {
        for i in 0..=15u8 {
            let ty = BuiltinEffectType::from_u8(i).unwrap();
            assert_eq!(ty as u8, i);
        }
        assert!(BuiltinEffectType::from_u8(16).is_none());
        assert!(BuiltinEffectType::from_u8(255).is_none());
    }

    #[test]
    fn create_all_processors() {
        let sr = 44100.0;
        for i in 0..=15u8 {
            let ty = BuiltinEffectType::from_u8(i).unwrap();
            let mut proc = ty.create_processor(sr);
            // Process silence — should produce silence
            let mut left = vec![0.0f32; 512];
            let mut right = vec![0.0f32; 512];
            proc.process_stereo(&mut left, &mut right, sr);
        }
    }
}
