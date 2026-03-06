use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

/// Distortion Node — Waveshaper with multiple distortion modes.
///
/// ENTERPRISE: Full-featured distortion with 5 industry-standard modes:
/// - Soft Clip (tanh): Warm, tube-like saturation
/// - Hard Clip: Aggressive digital clipping
/// - Foldback: Bitwig-style wavefolding
/// - Bitcrush: Bit depth reduction for lo-fi effects
/// - Asymmetric: Valve-style asymmetric saturation
///
/// Bitwig Grid equivalent: Distortion / Waveshaper / Wavefolder modules.
pub struct DistortionNode {
    mode: DistortionMode,
    drive: f32,      // 1.0 = unity, higher = more distortion
    mix: f32,        // Dry/Wet balance 0..1
}

#[derive(Clone, Copy, PartialEq)]
enum DistortionMode {
    SoftClip,   // tanh saturation
    HardClip,   // digital hard clip at ±1
    Foldback,   // wavefolding
    Bitcrush,   // quantization
    Asymmetric, // tube-style asymmetric
}

impl DistortionNode {
    pub fn new() -> Self {
        Self {
            mode: DistortionMode::SoftClip,
            drive: 1.0,
            mix: 1.0,
        }
    }

    pub fn set_mode_by_float(&mut self, val: f32) {
        self.mode = match val as i32 {
            0 => DistortionMode::SoftClip,
            1 => DistortionMode::HardClip,
            2 => DistortionMode::Foldback,
            3 => DistortionMode::Bitcrush,
            4 => DistortionMode::Asymmetric,
            _ => DistortionMode::SoftClip,
        };
    }

    pub fn set_drive(&mut self, drive: f32) {
        self.drive = drive.clamp(0.1, 100.0);
    }

    pub fn set_mix(&mut self, mix: f32) {
        self.mix = mix.clamp(0.0, 1.0);
    }

    /// Apply the selected distortion algorithm to a single sample.
    #[inline]
    fn distort(&self, input: f32) -> f32 {
        let driven = input * self.drive;
        match self.mode {
            DistortionMode::SoftClip => {
                // tanh saturation — warm, musical, never exceeds ±1
                driven.tanh()
            }
            DistortionMode::HardClip => {
                // Brick-wall clip at ±1
                driven.clamp(-1.0, 1.0)
            }
            DistortionMode::Foldback => {
                // Wavefolding: fold back when exceeding ±1
                // This creates rich harmonic content (Buchla-style)
                let mut s = driven;
                // Iterative fold — handles extreme drive gracefully
                for _ in 0..4 {
                    if s > 1.0 {
                        s = 2.0 - s;
                    } else if s < -1.0 {
                        s = -2.0 - s;
                    } else {
                        break;
                    }
                }
                s.clamp(-1.0, 1.0)
            }
            DistortionMode::Bitcrush => {
                // Quantize to reduced bit depth
                // drive maps 1..100 → 256..4 steps (higher drive = more crush)
                let steps = (256.0 / self.drive).max(2.0);
                (driven * steps).round() / steps
            }
            DistortionMode::Asymmetric => {
                // Tube-style asymmetric saturation
                // Positive half saturates softer, negative half harder
                if driven >= 0.0 {
                    1.0 - (-driven).exp()
                } else {
                    -(1.0 - driven.exp()) * 0.7
                }
            }
        }
    }
}

impl Default for DistortionNode {
    fn default() -> Self { Self::new() }
}

impl FlowNode for DistortionNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        // Input 0: Audio signal
        // Input 1: Drive CV (optional modulation)
        let input = inputs.first().and_then(|s| s.as_float()).unwrap_or(0.0);
        let drive_mod = inputs.get(1).and_then(|s| s.as_float());

        // Save original drive, apply CV modulation if connected
        if let Some(cv) = drive_mod {
            // CV adds to base drive multiplicatively
            let modulated_drive = (self.drive * cv.max(0.0)).clamp(0.1, 100.0);
            let driven_input = input * modulated_drive;
            let wet = self.distort_raw(driven_input);
            let out = input * (1.0 - self.mix) + wet * self.mix;
            // ENTERPRISE: NaN guard
            outputs[0] = FlowSignal::Audio(if out.is_finite() { out } else { 0.0 });
        } else {
            let wet = self.distort(input);
            let out = input * (1.0 - self.mix) + wet * self.mix;
            outputs[0] = FlowSignal::Audio(if out.is_finite() { out } else { 0.0 });
        }
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}

impl DistortionNode {
    /// Raw distort without internal drive multiplication (for external CV-modulated drive).
    #[inline]
    fn distort_raw(&self, driven: f32) -> f32 {
        match self.mode {
            DistortionMode::SoftClip => driven.tanh(),
            DistortionMode::HardClip => driven.clamp(-1.0, 1.0),
            DistortionMode::Foldback => {
                let mut s = driven;
                for _ in 0..4 {
                    if s > 1.0 { s = 2.0 - s; }
                    else if s < -1.0 { s = -2.0 - s; }
                    else { break; }
                }
                s.clamp(-1.0, 1.0)
            }
            DistortionMode::Bitcrush => {
                let steps = (256.0 / self.drive).max(2.0);
                (driven * steps).round() / steps
            }
            DistortionMode::Asymmetric => {
                if driven >= 0.0 { 1.0 - (-driven).exp() }
                else { -(1.0 - driven.exp()) * 0.7 }
            }
        }
    }
}
