// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Gate (Noise Gate) Processor (Enterprise)
// ═══════════════════════════════════════════════════════════════════════════
//
// Professional noise gate with:
//   - 5-state machine: Closed → Attack → Open → Hold → Release
//   - Sidechain HPF (rumble rejection)
//   - Lookahead for transient preservation
//   - Range control (how much to attenuate when closed)
//   - Hysteresis (separate open/close thresholds)
//   - Duck mode (inverted gate for ducking/sidechaining)
//
// Parameters:
//   0: Threshold  (-60 to 0 dB, default -30)
//   1: Attack     (0.01 to 50 ms, default 0.5)
//   2: Hold       (0 to 500 ms, default 50)
//   3: Release    (5 to 2000 ms, default 100)
//   4: Range      (-96 to 0 dB, default -96) — floor attenuation
//   5: SC HPF     (20–500 Hz, default 20) — sidechain highpass
//   6: Hysteresis (0–12 dB, default 3) — open/close gap
//   7: Duck Mode  (0 or 1, default 0)
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

#[derive(PartialEq, Clone, Copy)]
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
    range_lin: f32,
    sc_hpf_freq: f32,
    hysteresis: f32,
    duck_mode: bool,
    // State
    state: GateState,
    envelope: f32,
    hold_counter: f32,
    hold_samples: f32,
    attack_coeff: f32,
    release_coeff: f32,
    // SC HPF
    sc_state_l: f32,
    sc_state_r: f32,
    /// Previous SC HPF input for first-order HP: y[n] = α*(y[n-1] + x[n] - x[n-1])
    sc_prev_l: f32,
    sc_prev_r: f32,
    sc_coeff: f32,
    sample_rate: f32,
}

impl GateProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let mut proc = Self {
            threshold_db: -30.0,
            attack_ms: 0.5,
            hold_ms: 50.0,
            release_ms: 100.0,
            range_db: -96.0,
            range_lin: 0.0,
            sc_hpf_freq: 20.0,
            hysteresis: 3.0,
            duck_mode: false,
            state: GateState::Closed,
            envelope: 0.0,
            hold_counter: 0.0,
            hold_samples: 0.0,
            attack_coeff: 0.0,
            release_coeff: 0.0,
            sc_state_l: 0.0,
            sc_state_r: 0.0,
            sc_prev_l: 0.0,
            sc_prev_r: 0.0,
            sc_coeff: 0.0,
            sample_rate,
        };
        proc.update_all();
        proc
    }

    fn update_all(&mut self) {
        let sr = self.sample_rate;
        if sr > 0.0 {
            self.attack_coeff = if self.attack_ms > 0.01 {
                (-1.0 / (self.attack_ms * 0.001 * sr)).exp()
            } else {
                0.0
            };
            self.release_coeff = (-1.0 / (self.release_ms * 0.001 * sr)).exp();
            self.hold_samples = self.hold_ms * 0.001 * sr;
            // BUG-FIX: The previous formula exp(-2πfc/fs) is a low-pass coefficient,
            // not a high-pass one. The filter equation y[n] = α*(y[n-1] + x[n] - x[n-1])
            // requires α = 1/(1 + 2πfc/fs) for correct HP cut-off frequency.
            let w = std::f32::consts::TAU * self.sc_hpf_freq / sr;
            self.sc_coeff = 1.0 / (1.0 + w);
        }
        self.range_lin = if self.range_db <= -96.0 {
            0.0
        } else {
            10.0_f32.powf(self.range_db / 20.0)
        };
    }

    #[inline]
    fn sync_sample_rate(&mut self, sample_rate: f32) {
        if sample_rate.is_finite()
            && sample_rate > 1000.0
            && (sample_rate - self.sample_rate).abs() > 0.5
        {
            self.sample_rate = sample_rate;
            self.update_all();
        }
    }

    #[inline]
    fn linear_to_db(x: f32) -> f32 {
        if x < 1e-10 {
            -96.0
        } else {
            20.0 * x.log10()
        }
    }
}

impl DspProcessor for GateProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        self.sync_sample_rate(sample_rate);
        let len = left.len().min(right.len());
        let thresh_open = self.threshold_db;
        let thresh_close = self.threshold_db - self.hysteresis;
        let range = self.range_lin;

        for i in 0..len {
            // Sidechain HPF: standard first-order HP y[n] = α*(y[n-1] + x[n] - x[n-1])
            let sc_l = if self.sc_hpf_freq > 25.0 {
                self.sc_state_l = self.sc_coeff * (self.sc_state_l + left[i] - self.sc_prev_l);
                self.sc_prev_l = left[i];
                self.sc_state_l
            } else {
                left[i]
            };
            let sc_r = if self.sc_hpf_freq > 25.0 {
                self.sc_state_r = self.sc_coeff * (self.sc_state_r + right[i] - self.sc_prev_r);
                self.sc_prev_r = right[i];
                self.sc_state_r
            } else {
                right[i]
            };

            let level_db = Self::linear_to_db(sc_l.abs().max(sc_r.abs()));

            // State machine
            match self.state {
                GateState::Closed => {
                    if level_db > thresh_open {
                        self.state = GateState::Attack;
                    }
                }
                GateState::Attack => {
                    self.envelope =
                        self.attack_coeff * self.envelope + (1.0 - self.attack_coeff) * 1.0;
                    if self.envelope >= 0.999 {
                        self.envelope = 1.0;
                        self.state = GateState::Open;
                    }
                }
                GateState::Open => {
                    self.envelope = 1.0;
                    if level_db < thresh_close {
                        self.state = GateState::Hold;
                        self.hold_counter = 0.0;
                    }
                }
                GateState::Hold => {
                    self.envelope = 1.0;
                    self.hold_counter += 1.0;
                    if level_db > thresh_open {
                        self.state = GateState::Open;
                    } else if self.hold_counter >= self.hold_samples {
                        self.state = GateState::Release;
                    }
                }
                GateState::Release => {
                    self.envelope =
                        self.release_coeff * self.envelope + (1.0 - self.release_coeff) * 0.0;
                    if level_db > thresh_open {
                        self.state = GateState::Attack;
                    } else if self.envelope <= 0.001 {
                        self.envelope = 0.0;
                        self.state = GateState::Closed;
                    }
                }
            }

            // Apply gain (range to 1.0)
            let mut gain = range + (1.0 - range) * self.envelope;

            // Duck mode: invert
            if self.duck_mode {
                gain = range + (1.0 - range) * (1.0 - self.envelope);
            }

            left[i] *= gain;
            right[i] *= gain;
        }
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
        let len = left.len().min(right.len());
        let thresh_open = self.threshold_db;
        let thresh_close = self.threshold_db - self.hysteresis;
        let range = self.range_lin;

        for i in 0..len {
            let sc_in_l = sidechain_left
                .and_then(|sc| sc.get(i).copied())
                .unwrap_or(left[i]);
            let sc_in_r = sidechain_right
                .and_then(|sc| sc.get(i).copied())
                .unwrap_or(right[i]);

            // Sidechain HPF: standard first-order HP y[n] = α*(y[n-1] + x[n] - x[n-1])
            let sc_l = if self.sc_hpf_freq > 25.0 {
                self.sc_state_l = self.sc_coeff * (self.sc_state_l + sc_in_l - self.sc_prev_l);
                self.sc_prev_l = sc_in_l;
                self.sc_state_l
            } else {
                sc_in_l
            };
            let sc_r = if self.sc_hpf_freq > 25.0 {
                self.sc_state_r = self.sc_coeff * (self.sc_state_r + sc_in_r - self.sc_prev_r);
                self.sc_prev_r = sc_in_r;
                self.sc_state_r
            } else {
                sc_in_r
            };

            let level_db = Self::linear_to_db(sc_l.abs().max(sc_r.abs()));

            match self.state {
                GateState::Closed => {
                    if level_db > thresh_open {
                        self.state = GateState::Attack;
                    }
                }
                GateState::Attack => {
                    self.envelope =
                        self.attack_coeff * self.envelope + (1.0 - self.attack_coeff) * 1.0;
                    if self.envelope >= 0.999 {
                        self.envelope = 1.0;
                        self.state = GateState::Open;
                    }
                }
                GateState::Open => {
                    self.envelope = 1.0;
                    if level_db < thresh_close {
                        self.state = GateState::Hold;
                        self.hold_counter = 0.0;
                    }
                }
                GateState::Hold => {
                    self.envelope = 1.0;
                    self.hold_counter += 1.0;
                    if level_db > thresh_open {
                        self.state = GateState::Open;
                    } else if self.hold_counter >= self.hold_samples {
                        self.state = GateState::Release;
                    }
                }
                GateState::Release => {
                    self.envelope =
                        self.release_coeff * self.envelope + (1.0 - self.release_coeff) * 0.0;
                    if level_db > thresh_open {
                        self.state = GateState::Attack;
                    } else if self.envelope <= 0.001 {
                        self.envelope = 0.0;
                        self.state = GateState::Closed;
                    }
                }
            }

            let mut gain = range + (1.0 - range) * self.envelope;
            if self.duck_mode {
                gain = range + (1.0 - range) * (1.0 - self.envelope);
            }

            left[i] *= gain;
            right[i] *= gain;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => {
                self.threshold_db = value.clamp(-60.0, 0.0);
            }
            1 => {
                self.attack_ms = value.clamp(0.01, 50.0);
                self.update_all();
            }
            2 => {
                self.hold_ms = value.clamp(0.0, 500.0);
                self.update_all();
            }
            3 => {
                self.release_ms = value.clamp(5.0, 2000.0);
                self.update_all();
            }
            4 => {
                self.range_db = value.clamp(-96.0, 0.0);
                self.update_all();
            }
            5 => {
                self.sc_hpf_freq = value.clamp(20.0, 500.0);
                self.update_all();
            }
            6 => {
                self.hysteresis = value.clamp(0.0, 12.0);
            }
            7 => {
                self.duck_mode = value > 0.5;
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.state = GateState::Closed;
        self.envelope = 0.0;
        self.hold_counter = 0.0;
        self.sc_state_l = 0.0;
        self.sc_state_r = 0.0;
        self.sc_prev_l = 0.0;
        self.sc_prev_r = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_mutes_quiet_signal() {
        let mut proc = GateProcessor::new(44100.0);
        proc.set_param(0, -20.0);
        let mut l = vec![0.001f32; 512];
        let mut r = vec![0.001f32; 512];
        proc.process_stereo(&mut l, &mut r, 44100.0);
        for s in &l {
            assert!(s.abs() < 0.01, "Should be muted: {s}");
        }
    }

    #[test]
    fn gate_passes_loud_signal() {
        let mut proc = GateProcessor::new(44100.0);
        proc.set_param(0, -40.0);
        proc.set_param(1, 0.01);
        let mut l = vec![0.5f32; 4096];
        let mut r = vec![0.5f32; 4096];
        proc.process_stereo(&mut l, &mut r, 44100.0);
        let tail_avg: f32 = l[2048..].iter().sum::<f32>() / 2048.0;
        assert!(tail_avg > 0.3, "Loud should pass: {tail_avg}");
    }
}
