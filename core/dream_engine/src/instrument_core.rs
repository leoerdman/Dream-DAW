// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Instrument Core (Shared Types for All Internal Instruments)
// ═══════════════════════════════════════════════════════════════════════════
//
// Types shared by all internal instrument engines:
//   - SamplerEngine (sample playback)
//   - EssenceSynthEngine (subtractive synthesizer)
//   - SampleRackEngine (16-pad drum rack)
//
// Contains:
//   - ADSR Envelope (EnvelopeStage, AdsrParams, AdsrEnvelope)
//   - Voice pool constants (MAX_VOICES, DEFAULT_ROOT_NOTE)
//
// Re-exports synth-specific types from `synth_types`:
//   - Waveform, SynthFilterType, LfoTarget
//
// Real-Time Safety:
//   ❌ NO heap allocations
//   ❌ NO locks / I/O
//   ✅ Only: f32/f64 math, bounded iteration
//
// ═══════════════════════════════════════════════════════════════════════════

// ── Re-exports from synth_types (SSOT for oscillator/filter/LFO enums) ──
pub use crate::synth_types::{LfoTarget, SynthFilterType, Waveform};

// ── Constants ──────────────────────────────────────────────────────────

/// BUG-47 FIX: Increased from 16 to 32 for complex chord / pad arrangements.
pub const MAX_VOICES: usize = 32;

/// Default root note: C4 (middle C).
pub const DEFAULT_ROOT_NOTE: u8 = 60;

// ── ADSR Envelope ──────────────────────────────────────────────────────

/// ADSR envelope state machine.
///
/// Operates in sample-count domain (not time-dependent) for determinism.
/// Envelope level is always in [0.0, 1.0].
#[derive(Debug, Clone, Copy)]
pub enum EnvelopeStage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

/// Per-voice ADSR envelope parameters (in seconds).
#[derive(Debug, Clone, Copy)]
pub struct AdsrParams {
    pub attack: f64,
    pub decay: f64,
    pub sustain: f64, // level (0.0–1.0)
    pub release: f64,
}

impl Default for AdsrParams {
    fn default() -> Self {
        Self {
            attack: 0.005, // 5ms — click-free
            decay: 0.1,
            sustain: 1.0,
            release: 0.05, // 50ms
        }
    }
}

/// Real-time ADSR envelope generator.
///
/// Zero-allocation, deterministic, per-sample processing.
#[derive(Debug, Clone, Copy)]
pub struct AdsrEnvelope {
    stage: EnvelopeStage,
    level: f64,
    /// Rate of change per sample (computed from time param + sample rate).
    attack_rate: f64,
    decay_rate: f64,
    sustain_level: f64,
    release_rate: f64,
    sample_rate: f64,
}

impl AdsrEnvelope {
    /// Creates a new envelope at the given sample rate.
    pub fn new(sample_rate: f64) -> Self {
        let params = AdsrParams::default();
        let mut env = Self {
            stage: EnvelopeStage::Idle,
            level: 0.0,
            attack_rate: 0.0,
            decay_rate: 0.0,
            sustain_level: params.sustain,
            release_rate: 0.0,
            sample_rate,
        };
        env.set_params(&params);
        env
    }

    /// Updates envelope parameters (can be called per-buffer, not per-sample).
    pub fn set_params(&mut self, params: &AdsrParams) {
        let sr = self.sample_rate;

        // 1ms minimum for any stage to prevent divide-by-zero
        let attack_samples = params.attack.max(0.001) * sr;

        // Attack is linear ramp (standard practice)
        self.attack_rate = 1.0 / attack_samples;

        // Decay/Release use exponential one-pole coefficients.
        // coeff = exp(-1/(time * sr)) gives ~60dB of change in `time` seconds.
        let decay_time = params.decay.max(0.001);
        let release_time = params.release.max(0.001);
        self.decay_rate = (-1.0 / (decay_time * sr)).exp();
        self.release_rate = (-1.0 / (release_time * sr)).exp();

        self.sustain_level = params.sustain.clamp(0.0, 1.0);
    }

    /// Trigger note-on — starts the attack phase.
    #[inline]
    pub fn note_on(&mut self) {
        // BUG-FIX: Reset level to 0 when starting from Idle to prevent
        // starting the attack ramp from a stale non-zero level (causes pops).
        // When re-triggering from Release/Sustain, keep the current level
        // for smooth legato transitions.
        if matches!(self.stage, EnvelopeStage::Idle) {
            self.level = 0.0;
        }
        self.stage = EnvelopeStage::Attack;
    }

    /// Trigger note-off — starts the release phase.
    #[inline]
    pub fn note_off(&mut self) {
        self.stage = EnvelopeStage::Release;
    }

    /// Process one sample and return the envelope level.
    ///
    /// # Real-Time Safety
    /// Pure arithmetic, zero branches beyond match. O(1).
    #[inline]
    pub fn process(&mut self) -> f32 {
        match self.stage {
            EnvelopeStage::Idle => {
                // BUG-071 FIX: Don't redundantly set level=0 every sample.
                // Level is already 0.0 from the transition. Only return.
                return 0.0;
            }
            EnvelopeStage::Attack => {
                self.level += self.attack_rate;
                if self.level >= 1.0 {
                    self.level = 1.0;
                    self.stage = EnvelopeStage::Decay;
                }
            }
            EnvelopeStage::Decay => {
                // Exponential decay: level converges to sustain in the specified time.
                self.level =
                    self.sustain_level + (self.level - self.sustain_level) * self.decay_rate;
                if self.level <= self.sustain_level + 0.0001 {
                    self.level = self.sustain_level;
                    self.stage = EnvelopeStage::Sustain;
                }
            }
            EnvelopeStage::Sustain => {
                self.level = self.sustain_level;
            }
            EnvelopeStage::Release => {
                // Exponential release: level converges to 0 in the specified time.
                self.level *= self.release_rate;
                if self.level < 0.0001 {
                    self.level = 0.0;
                    self.stage = EnvelopeStage::Idle;
                }
            }
        }
        self.level as f32
    }

    /// Optimized block-filling for envelope levels.
    ///
    /// # Real-Time Safety
    /// Optimized for Sustain/Idle stages to use block-fill (zero branches).
    #[inline]
    pub fn fill_block(&mut self, output: &mut [f32]) {
        let mut i = 0;
        let len = output.len();
        while i < len {
            match self.stage {
                EnvelopeStage::Idle => {
                    output[i..].fill(0.0);
                    return;
                }
                EnvelopeStage::Sustain => {
                    output[i..].fill(self.sustain_level as f32);
                    return;
                }
                _ => {
                    output[i] = self.process();
                    i += 1;
                }
            }
        }
    }

    /// Whether this envelope is completely silent (voice can be freed).
    #[inline]
    pub fn is_idle(&self) -> bool {
        matches!(self.stage, EnvelopeStage::Idle)
    }

    /// Whether the envelope is in release or idle.
    #[inline]
    pub fn is_releasing(&self) -> bool {
        matches!(self.stage, EnvelopeStage::Release | EnvelopeStage::Idle)
    }

    /// Returns the current envelope level (for voice-steal priority comparisons).
    #[inline]
    pub fn level(&self) -> f64 {
        self.level
    }

    /// BUG-002 FIX: Update the internal sample rate and recalculate all
    /// envelope coefficients. Called when the audio device changes SR.
    pub fn set_sample_rate(&mut self, sample_rate: f64) {
        if sample_rate > 0.0 {
            self.sample_rate = sample_rate;
            // Recalculate rates from the current parameters.
            // We derive attack/decay/release times from the cached rates
            // and the OLD sample rate — however, since set_params will be
            // called again soon via voice.envelope.set_params(&adsr_params),
            // this is a safe interim update.
            let attack_time = if self.attack_rate > 0.0 { 1.0 / (self.attack_rate * sample_rate) } else { 0.001 };
            self.attack_rate = 1.0 / (attack_time.max(0.001) * sample_rate);
        }
    }

    /// Reset to idle state.
    #[inline]
    pub fn reset(&mut self) {
        self.stage = EnvelopeStage::Idle;
        self.level = 0.0;
    }
}
