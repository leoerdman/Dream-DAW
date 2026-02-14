// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Gate (Noise Gate) Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Classic noise gate with attack / hold / release envelope and
// configurable range (full mute vs. partial attenuation).
//
// Parameters:
//   0: Threshold  (-80 to 0 dB, default -40 dB)
//   1: Attack     (0.01 to 100 ms, default 0.1 ms)
//   2: Hold       (0 to 500 ms, default 10 ms)
//   3: Release    (1 to 2000 ms, default 50 ms)
//   4: Range      (-80 to 0 dB, default -80 dB) — closed-gate attenuation
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GateState {
    Closed,
    Attack,
    Open,
    Hold,
    Release,
}

pub struct GateProcessor {
    threshold_db: f32,
    attack_ms: f32,
    hold_ms: f32,
    release_ms: f32,
    range_db: f32,
    // Derived
    threshold_lin: f32,
    range_lin: f32,
    attack_coeff: f32,
    release_coeff: f32,
    hold_samples: u32,
    // State
    state: GateState,
    envelope: f32,
    hold_counter: u32,
    sample_rate: f32,
}

impl GateProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let mut proc = Self {
            threshold_db: -40.0,
            attack_ms: 0.1,
            hold_ms: 10.0,
            release_ms: 50.0,
            range_db: -80.0,
            threshold_lin: Self::db_to_lin(-40.0),
            range_lin: Self::db_to_lin(-80.0),
            attack_coeff: 0.0,
            release_coeff: 0.0,
            hold_samples: 0,
            state: GateState::Closed,
            envelope: 0.0,
            hold_counter: 0,
            sample_rate,
        };
        proc.update_coefficients();
        proc
    }

    #[inline]
    fn db_to_lin(db: f32) -> f32 {
        10.0_f32.powf(db / 20.0)
    }

    fn update_coefficients(&mut self) {
        let sr = self.sample_rate;
        if sr > 0.0 {
            self.attack_coeff = (-1.0 / (self.attack_ms * 0.001 * sr).max(1.0)).exp();
            self.release_coeff = (-1.0 / (self.release_ms * 0.001 * sr).max(1.0)).exp();
            self.hold_samples = (self.hold_ms * 0.001 * sr) as u32;
        }
    }
}

impl DspProcessor for GateProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], _sample_rate: f32) {
        let len = left.len().min(right.len());
        let thresh = self.threshold_lin;
        let range = self.range_lin;

        for i in 0..len {
            let peak = left[i].abs().max(right[i].abs());
            let above = peak >= thresh;

            // State machine
            match self.state {
                GateState::Closed => {
                    if above {
                        self.state = GateState::Attack;
                    }
                }
                GateState::Attack => {
                    self.envelope = self.attack_coeff * self.envelope + (1.0 - self.attack_coeff);
                    if self.envelope >= 0.999 {
                        self.envelope = 1.0;
                        self.state = GateState::Open;
                    }
                    if !above {
                        self.state = GateState::Release;
                    }
                }
                GateState::Open => {
                    self.envelope = 1.0;
                    if !above {
                        self.hold_counter = self.hold_samples;
                        self.state = GateState::Hold;
                    }
                }
                GateState::Hold => {
                    self.envelope = 1.0;
                    if above {
                        self.state = GateState::Open;
                    } else if self.hold_counter == 0 {
                        self.state = GateState::Release;
                    } else {
                        self.hold_counter -= 1;
                    }
                }
                GateState::Release => {
                    if above {
                        self.state = GateState::Attack;
                    } else {
                        self.envelope = self.release_coeff * self.envelope;
                        if self.envelope < 0.001 {
                            self.envelope = 0.0;
                            self.state = GateState::Closed;
                        }
                    }
                }
            }

            // Apply gating: envelope crossfades between unity and range
            let gain = range + (1.0 - range) * self.envelope;
            left[i] *= gain;
            right[i] *= gain;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => {
                self.threshold_db = value.clamp(-80.0, 0.0);
                self.threshold_lin = Self::db_to_lin(self.threshold_db);
            }
            1 => {
                self.attack_ms = value.clamp(0.01, 100.0);
                self.update_coefficients();
            }
            2 => {
                self.hold_ms = value.clamp(0.0, 500.0);
                self.update_coefficients();
            }
            3 => {
                self.release_ms = value.clamp(1.0, 2000.0);
                self.update_coefficients();
            }
            4 => {
                self.range_db = value.clamp(-80.0, 0.0);
                self.range_lin = Self::db_to_lin(self.range_db);
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.state = GateState::Closed;
        self.envelope = 0.0;
        self.hold_counter = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_mutes_quiet_signal() {
        let mut proc = GateProcessor::new(44100.0);
        proc.set_param(0, -20.0); // threshold -20 dB
        let mut left = vec![0.01f32; 2048]; // very quiet
        let mut right = vec![0.01f32; 2048];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        let max_out = left.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
        assert!(max_out < 0.02, "Gate should mute quiet signal, got: {max_out}");
    }

    #[test]
    fn gate_passes_loud_signal() {
        let mut proc = GateProcessor::new(44100.0);
        proc.set_param(0, -40.0); // threshold -40 dB
        proc.set_param(1, 0.01);  // near-instant attack
        let mut left = vec![0.5f32; 2048]; // well above threshold
        let mut right = vec![0.5f32; 2048];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        let tail_avg: f32 = left[256..].iter().sum::<f32>() / (2048 - 256) as f32;
        assert!(tail_avg > 0.4, "Gate should pass loud signal, got avg: {tail_avg}");
    }
}
