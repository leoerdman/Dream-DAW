use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

/// Noise Node — White and pink noise generator.
///
/// White noise: xoshiro256++ PRNG with uniform distribution.
/// Pink noise: Voss-McCartney algorithm (3 octave bands) for natural
/// 1/f spectral falloff used in everything from wind to warm textures.
pub struct NoiseNode {
    color: NoiseColor,
    level: f32,
    /// PRNG state (xoshiro256++)
    state: [u64; 4],
    /// Voss-McCartney octave accumulators for pink noise
    pink_rows: [f32; 16],
    pink_running_sum: f32,
    pink_index: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NoiseColor {
    White,
    Pink,
}

impl NoiseNode {
    pub fn new() -> Self {
        Self {
            color: NoiseColor::White,
            level: 1.0,
            state: [
                0x9E37_79B9_7F4A_7C15,
                0x6C62_272E_07BB_0142,
                0xBF58_476D_1CE4_E5B9,
                0x94D0_49BB_1331_11EB,
            ],
            pink_rows: [0.0; 16],
            pink_running_sum: 0.0,
            pink_index: 0,
        }
    }

    pub fn set_color_by_float(&mut self, val: f32) {
        self.color = match val as i32 {
            1 => NoiseColor::Pink,
            _ => NoiseColor::White,
        };
    }

    pub fn set_level(&mut self, level: f32) {
        self.level = level.clamp(0.0, 1.0);
    }

    #[inline]
    fn next_random(&mut self) -> f32 {
        let result = self.state[0].wrapping_add(self.state[3]);
        let t = self.state[1] << 17;
        self.state[2] ^= self.state[0];
        self.state[3] ^= self.state[1];
        self.state[1] ^= self.state[2];
        self.state[0] ^= self.state[3];
        self.state[2] ^= t;
        self.state[3] = self.state[3].rotate_left(45);
        // Scale upper 32 bits to -1..1 (standard float conversion for PRNG)
        let upper = (result >> 32) as u32;
        (upper as f32 / u32::MAX as f32) * 2.0 - 1.0
    }

    #[inline]
    fn next_pink(&mut self) -> f32 {
        // Voss-McCartney: on each sample, update one octave row based on
        // trailing zeros of the counter (gives 1/f distribution)
        let tz = self.pink_index.trailing_zeros().min(15) as usize;
        self.pink_running_sum -= self.pink_rows[tz];
        let new_val = self.next_random();
        self.pink_rows[tz] = new_val;
        self.pink_running_sum += new_val;
        self.pink_index = self.pink_index.wrapping_add(1);

        // ENTERPRISE: Denormal flush for running sum
        if self.pink_running_sum.abs() < 1e-18 { self.pink_running_sum = 0.0; }

        // Normalize (16 rows contribute, each in -1..1, so max sum ~ 16)
        self.pink_running_sum / 16.0
    }
}

impl Default for NoiseNode {
    fn default() -> Self { Self::new() }
}

impl FlowNode for NoiseNode {
    fn process(&mut self, _inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        let sample = match self.color {
            NoiseColor::White => self.next_random(),
            NoiseColor::Pink => self.next_pink(),
        };
        outputs[0] = FlowSignal::Audio(sample * self.level);
    }

    fn reset(&mut self) {
        self.pink_rows = [0.0; 16];
        self.pink_running_sum = 0.0;
        self.pink_index = 0;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
