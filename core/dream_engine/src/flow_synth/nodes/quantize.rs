use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

/// Musical scale quantizer.
///
/// Snaps an incoming frequency (Hz) to the nearest note in a selected scale.
/// Essential for creating melodic patches from continuous CV sources
/// (LFOs, noise through S&H, etc.).
///
/// Scale modes:
///   0 = Chromatic (all 12 semitones)
///   1 = Major (Ionian)
///   2 = Natural Minor (Aeolian)
///   3 = Pentatonic Major
///   4 = Blues
///   5 = Dorian
///   6 = Mixolydian
pub struct QuantizeNode {
    /// Scale mode index (0–6).
    scale_mode: u8,
    /// Root note as MIDI number (default 60 = C4).
    root_note: u8,
}

impl Default for QuantizeNode {
    fn default() -> Self {
        Self::new()
    }
}

impl QuantizeNode {
    pub fn new() -> Self {
        Self {
            scale_mode: 0,
            root_note: 60,
        }
    }

    pub fn set_scale_mode(&mut self, mode: f32) {
        self.scale_mode = (mode as u8).min(6);
    }

    pub fn set_root_note(&mut self, note: f32) {
        self.root_note = (note as u8).clamp(0, 127);
    }

    /// Returns the scale degree mask for the current mode.
    /// Each bit position N (0–11) corresponds to semitone N above root.
    /// Bit 0 = root (always set for all non-chromatic scales).
    ///
    /// Verification method: for each scale degree D, set bit D.
    /// Example: Major = {0,2,4,5,7,9,11}
    ///   bit 0=1, bit 2=1, bit 4=1, bit 5=1, bit 7=1, bit 9=1, bit 11=1
    ///   = 0b1010_1011_0101 = 0xAB5
    fn scale_mask(&self) -> u16 {
        match self.scale_mode {
            // Chromatic: all 12 semitones
            0 => 0b1111_1111_1111, // {0,1,2,3,4,5,6,7,8,9,10,11}

            // Major (Ionian): W W H W W W H
            1 => 0b1010_1011_0101, // {0,2,4,5,7,9,11} = 0xAB5

            // Natural Minor (Aeolian): W H W W H W W
            2 => 0b0101_0110_1101, // {0,2,3,5,7,8,10} = 0x56D

            // Pentatonic Major: 0,2,4,7,9
            3 => 0b0010_1001_0101, // {0,2,4,7,9} = 0x295

            // Blues: 0,3,5,6,7,10
            4 => 0b0100_1110_1000 | 1, // {0,3,5,6,7,10} = 0x4E9

            // Dorian: W H W W W H W → 0,2,3,5,7,9,10
            5 => 0b0110_1010_1101, // {0,2,3,5,7,9,10} = 0x6AD

            // Mixolydian: W W H W W H W → 0,2,4,5,7,9,10
            6 => 0b0110_1011_0101, // {0,2,4,5,7,9,10} = 0x6B5

            _ => 0b1111_1111_1111, // fallback Chromatic
        }
    }

    /// Convert Hz to MIDI note (fractional).
    #[inline]
    fn freq_to_midi(freq: f64) -> f64 {
        69.0 + 12.0 * (freq / 440.0).log2()
    }

    /// Convert MIDI note to Hz.
    #[inline]
    fn midi_to_freq(note: f64) -> f64 {
        440.0 * 2.0_f64.powf((note - 69.0) / 12.0)
    }

    /// Snap a MIDI note number to the nearest scale degree.
    fn quantize_note(&self, midi_note: f64) -> f64 {
        let mask = self.scale_mask();
        if mask == 0 || mask == 0xFFF {
            return midi_note.round();
        }

        let root = self.root_note as f64;
        let rounded = midi_note.round();
        let mut best = rounded;
        let mut best_dist = f64::MAX;

        // Search ±7 semitones around the rounded note
        for offset in -7i32..=7 {
            let candidate = rounded + offset as f64;
            let degree = ((candidate - root) as i32).rem_euclid(12) as u16;
            if (mask & (1 << degree)) != 0 {
                let dist = (candidate - midi_note).abs();
                if dist < best_dist {
                    best_dist = dist;
                    best = candidate;
                }
            }
        }

        best
    }
}

impl FlowNode for QuantizeNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        let freq = inputs.first().and_then(|s| s.as_float()).unwrap_or(440.0) as f64;

        if freq <= 0.0 {
            outputs[0] = FlowSignal::Control(0.0);
            return;
        }

        let midi = Self::freq_to_midi(freq);
        let quantized_midi = self.quantize_note(midi);
        let quantized_freq = Self::midi_to_freq(quantized_midi);

        outputs[0] = FlowSignal::Control(quantized_freq as f32);
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
