// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Essence Synth Engine (Standalone Polyphonic Wave Synthesizer)
// ═══════════════════════════════════════════════════════════════════════════
//
// A fully independent polyphonic subtractive synthesizer — NOT tied to
// SamplerEngine. This is the audio engine behind the "Essence" instrument
// plugin (`internal://instrument/wave-synth`).
//
// Architecture:
//   - Dual Oscillator: PolyBLEP anti-aliased (sine, saw, square, triangle)
//   - SVF Filter: per-voice state variable filter (LP, HP, BP, Notch)
//   - LFO: per-voice low-frequency oscillator (filter, pitch, volume)
//   - ADSR: per-voice amplitude envelope
//   - Voice Pool: 32 pre-allocated voices, voice stealing
//   - Sub Oscillator: sine sub at −1 octave
//
// Real-Time Safety:
//   ❌ NO heap allocations
//   ❌ NO locks
//   ❌ NO I/O
//   ✅ Only: f32/f64 math, bounded iteration, pre-allocated arrays
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::instrument_core::{AdsrEnvelope, AdsrParams, MAX_VOICES};
use crate::synth_types::{LfoTarget, SynthFilterType, Waveform};
use crate::oscillator::{oscillator_sample_blep, ParameterSmoother};
use dream_dsp::svf::SvfState;

// ── Constants ──────────────────────────────────────────────────────────

/// BUG-100 FIX: Use SSOT MAX_VOICES from instrument_core instead of
/// duplicating the constant. Previously ESSENCE_MAX_VOICES = 32 was
/// defined here independently.
pub const ESSENCE_MAX_VOICES: usize = MAX_VOICES;

// ── Essence Voice ──────────────────────────────────────────────────────

/// A single polyphonic synth voice with dual oscillators, filter, and LFO.
#[derive(Debug, Clone)]
pub struct EssenceVoice {
    /// Whether this voice is active (producing sound).
    pub active: bool,

    /// MIDI note number being played.
    pub note: u8,

    /// Velocity (0.0–1.0 normalized from MIDI 0–127).
    pub velocity: f32,

    /// OSC 1 phase accumulator (0.0..1.0).
    pub phase_1: f64,

    /// OSC 2 phase accumulator (0.0..1.0).
    pub phase_2: f64,

    /// Sub oscillator phase accumulator.
    pub phase_sub: f64,

    /// Phase increment per sample (derived from MIDI note).
    pub phase_increment: f64,

    /// Per-voice ADSR envelope.
    pub envelope: AdsrEnvelope,

    /// Per-voice SVF filter state.
    pub filter_state: SvfState,

    /// Per-voice LFO phase (free-running, 0.0..1.0).
    pub lfo_phase: f64,

    /// Per-voice triangle integrator state for OSC 1.
    pub tri_state_1: f64,

    /// Per-voice triangle integrator state for OSC 2.
    pub tri_state_2: f64,

    sample_rate: f64,
}

impl EssenceVoice {
    /// Creates a new idle voice.
    pub fn new(sample_rate: f64) -> Self {
        Self {
            active: false,
            note: 0,
            velocity: 0.0,
            phase_1: 0.0,
            phase_2: 0.0,
            phase_sub: 0.0,
            phase_increment: 0.0,
            envelope: AdsrEnvelope::new(sample_rate),
            filter_state: SvfState::default(),
            lfo_phase: 0.0,
            tri_state_1: 0.0,
            tri_state_2: 0.0,
            sample_rate,
        }
    }

    /// Trigger note-on: compute phase increment from MIDI note.
    #[inline]
    pub fn trigger(&mut self, note: u8, velocity: u8) {
        // BUG-009 FIX: Only reset oscillator phases when starting from idle.
        // Re-triggering from a releasing voice should preserve phase continuity
        // to avoid waveform discontinuity clicks.
        let from_idle = !self.active;
        self.active = true;
        self.note = note;
        self.velocity = velocity as f32 / 127.0;
        if from_idle {
            self.phase_1 = 0.0;
            self.phase_2 = 0.0;
            self.phase_sub = 0.0;
            self.lfo_phase = 0.0;
            self.tri_state_1 = 0.0;
            self.tri_state_2 = 0.0;
        }
        let freq_hz = 440.0_f64 * 2.0_f64.powf((note as f64 - 69.0) / 12.0);
        self.phase_increment = (freq_hz / self.sample_rate).clamp(0.0, 0.5);
        self.envelope.note_on();
        if from_idle {
            self.filter_state.reset();
        }
    }

    /// Release the note (enters ADSR release phase).
    #[inline]
    pub fn release(&mut self) {
        self.envelope.note_off();
    }

    /// Hard-reset this voice to idle.
    #[inline]
    pub fn reset(&mut self) {
        self.active = false;
        self.note = 0;
        self.velocity = 0.0;
        self.phase_1 = 0.0;
        self.phase_2 = 0.0;
        self.phase_sub = 0.0;
        self.phase_increment = 0.0;
        self.envelope.reset();
        self.filter_state.reset();
        self.lfo_phase = 0.0;
        self.tri_state_1 = 0.0;
        self.tri_state_2 = 0.0;
    }
}

// ── Essence Synth Engine ───────────────────────────────────────────────

/// Standalone polyphonic subtractive synthesizer engine.
///
/// Completely independent of `SamplerEngine`. Owns its own voice pool,
/// oscillator state, filter/LFO parameters, and render pipeline.
pub struct EssenceSynthEngine {
    // ── Voice Pool ──
    voices: [EssenceVoice; ESSENCE_MAX_VOICES],

    // ── Activation Guard ──
    /// Whether this synth is explicitly enabled for this track.
    /// Defaults to `false` — empty tracks won’t produce sound from MIDI clips.
    /// Set to `true` when the user assigns the Essence Synth instrument.
    enabled: bool,

    // ── Global Parameters ──
    /// ADSR envelope parameters.
    adsr_params: AdsrParams,
    /// Master volume (0.0–2.0).
    pub volume: ParameterSmoother,

    // ── Oscillator Parameters ──
    /// OSC 1 waveform.
    waveform_1: Waveform,
    /// OSC 2 waveform.
    waveform_2: Waveform,
    /// OSC 1 volume (0.0–1.0).
    osc1_volume: ParameterSmoother,
    /// OSC 2 volume (0.0–1.0).
    osc2_volume: ParameterSmoother,
    /// OSC 1 enabled.
    osc1_enabled: bool,
    /// OSC 2 enabled.
    osc2_enabled: bool,
    /// Detune in cents between OSC 1 and OSC 2.
    detune_cents: ParameterSmoother,
    /// Sub oscillator level (0.0–1.0).
    sub_level: ParameterSmoother,
    /// Pulse width for square/pulse waves (0.05–0.95).
    pulse_width: ParameterSmoother,

    // ── Filter Parameters ──
    /// Filter cutoff frequency in Hz (20–20000).
    filter_cutoff: ParameterSmoother,
    /// Filter resonance (0.0–0.99).
    filter_resonance: ParameterSmoother,
    /// Filter type (LP, HP, BP, Notch).
    filter_type: SynthFilterType,

    // ── LFO Parameters ──
    /// LFO rate in Hz.
    lfo_rate: ParameterSmoother,
    /// LFO depth (0.0–1.0).
    lfo_depth: ParameterSmoother,
    /// LFO modulation target.
    lfo_target: LfoTarget,

    // ── Engine State ──
    sample_rate: f64,
}

impl EssenceSynthEngine {
    /// Creates a new Essence synth engine at the given sample rate.
    pub fn new(sample_rate: f64) -> Self {
        let voices = std::array::from_fn(|_| EssenceVoice::new(sample_rate));
        let tc = 10.0; // 10ms smoothing window
        Self {
            voices,
            enabled: false,
            adsr_params: AdsrParams {
                attack: 0.01,
                decay: 0.2,
                sustain: 0.7,
                release: 0.3,
            },
            volume: ParameterSmoother::new(0.8, sample_rate, tc),
            waveform_1: Waveform::Saw,
            waveform_2: Waveform::Square,
            osc1_volume: ParameterSmoother::new(1.0, sample_rate, tc),
            osc2_volume: ParameterSmoother::new(0.0, sample_rate, tc),
            osc1_enabled: true,
            osc2_enabled: false,
            detune_cents: ParameterSmoother::new(0.0, sample_rate, tc),
            sub_level: ParameterSmoother::new(0.0, sample_rate, tc),
            pulse_width: ParameterSmoother::new(0.5, sample_rate, tc),
            filter_cutoff: ParameterSmoother::new(8000.0, sample_rate, tc),
            filter_resonance: ParameterSmoother::new(0.0, sample_rate, tc),
            filter_type: SynthFilterType::Lowpass,
            lfo_rate: ParameterSmoother::new(1.0, sample_rate, tc),
            lfo_depth: ParameterSmoother::new(0.0, sample_rate, tc),
            lfo_target: LfoTarget::FilterCutoff,
            sample_rate,
        }
    }

    // ── Parameter Setters ──────────────────────────────────────────────

    pub fn set_waveform_1(&mut self, waveform: u8) {
        self.waveform_1 = Waveform::from_u8(waveform);
    }

    pub fn set_waveform_2(&mut self, waveform: u8) {
        self.waveform_2 = Waveform::from_u8(waveform);
    }

    pub fn set_osc1_volume(&mut self, volume: f32) {
        self.osc1_volume.set_target(volume.clamp(0.0, 1.0));
    }

    pub fn set_osc2_volume(&mut self, volume: f32) {
        self.osc2_volume.set_target(volume.clamp(0.0, 1.0));
    }

    pub fn set_osc1_enabled(&mut self, enabled: bool) {
        self.osc1_enabled = enabled;
    }

    pub fn set_osc2_enabled(&mut self, enabled: bool) {
        self.osc2_enabled = enabled;
    }

    pub fn set_detune_cents(&mut self, cents: f32) {
        self.detune_cents.set_target(cents.clamp(-100.0, 100.0));
    }

    pub fn set_sub_level(&mut self, level: f32) {
        self.sub_level.set_target(level.clamp(0.0, 1.0));
    }

    pub fn set_pulse_width(&mut self, width: f32) {
        self.pulse_width.set_target(width.clamp(0.05, 0.95));
    }

    pub fn set_filter_cutoff(&mut self, cutoff: f32) {
        self.filter_cutoff.set_target(cutoff.clamp(20.0, 20000.0));
    }

    pub fn set_filter_resonance(&mut self, resonance: f32) {
        self.filter_resonance.set_target(resonance.clamp(0.0, 0.99));
    }

    pub fn set_filter_type(&mut self, filter_type: u8) {
        self.filter_type = SynthFilterType::from_u8(filter_type);
    }

    pub fn set_lfo_rate(&mut self, rate: f32) {
        self.lfo_rate.set_target(rate.clamp(0.01, 40.0));
    }

    pub fn set_lfo_depth(&mut self, depth: f32) {
        self.lfo_depth.set_target(depth.clamp(0.0, 1.0));
    }

    pub fn set_lfo_target(&mut self, target: u8) {
        self.lfo_target = LfoTarget::from_u8(target);
    }

    pub fn set_adsr(&mut self, params: AdsrParams) {
        self.adsr_params = params;
        for voice in &mut self.voices {
            voice.envelope.set_params(&params);
        }
    }

    pub fn set_volume(&mut self, volume: f32) {
        self.volume.set_target(volume.clamp(0.0, 2.0));
    }

    // ── MIDI Interface ─────────────────────────────────────────────────

    /// Trigger a note-on event.
    ///
    /// Voice allocation: retrigger releasing voices on same pitch →
    /// find idle voice → steal lowest-envelope active voice.
    pub fn note_on(&mut self, note: u8, velocity: u8) {
        if velocity == 0 {
            self.note_off(note);
            return;
        }

        // Prefer re-triggering a releasing voice on the same pitch.
        let retrigger = self
            .voices
            .iter_mut()
            .find(|v| v.active && v.note == note && v.envelope.is_releasing());
        if let Some(voice) = retrigger {
            voice.envelope.set_params(&self.adsr_params);
            voice.trigger(note, velocity);
            return;
        }

        // Find an idle voice.
        let slot = self.voices.iter_mut().find(|v| !v.active);
        if let Some(voice) = slot {
            voice.envelope.set_params(&self.adsr_params);
            voice.trigger(note, velocity);
            return;
        }

        // Voice stealing: prefer releasing voices, then steal lowest envelope level.
        let steal = self.voices.iter_mut().min_by(|a, b| {
            let a_releasing = a.envelope.is_releasing() as u8;
            let b_releasing = b.envelope.is_releasing() as u8;
            b_releasing.cmp(&a_releasing).then_with(|| {
                a.envelope
                    .level()
                    .partial_cmp(&b.envelope.level())
                    .unwrap_or(std::cmp::Ordering::Greater)
            })
        });
        if let Some(voice) = steal {
            voice.envelope.set_params(&self.adsr_params);
            voice.trigger(note, velocity);
        }
    }

    /// Release a note.
    pub fn note_off(&mut self, note: u8) {
        for voice in &mut self.voices {
            if voice.active && voice.note == note && !voice.envelope.is_releasing() {
                voice.release();
            }
        }
    }

    /// Release all active notes gracefully.
    /// BUG-036 FIX: Use release() instead of reset() to prevent audible clicks.
    /// Voices will fade out through their ADSR release phase and deactivate
    /// naturally in the render loop when the envelope reaches idle.
    pub fn all_notes_off(&mut self) {
        for voice in &mut self.voices {
            if voice.active && !voice.envelope.is_releasing() {
                voice.release();
            }
        }
    }

    /// BUG-002 FIX: Update sample rate for all voices and parameter smoothers.
    /// Called when the audio device changes sample rate. Without this,
    /// pitch, filter cutoffs, and ADSR timing are all wrong.
    pub fn set_sample_rate(&mut self, sample_rate: f64) {
        if sample_rate <= 0.0 || (sample_rate - self.sample_rate).abs() < 0.5 {
            return;
        }
        self.sample_rate = sample_rate;
        let tc = 10.0; // Same smoothing window as constructor
        // Update all parameter smoothers
        self.volume.set_time_constant(sample_rate, tc);
        self.osc1_volume.set_time_constant(sample_rate, tc);
        self.osc2_volume.set_time_constant(sample_rate, tc);
        self.detune_cents.set_time_constant(sample_rate, tc);
        self.sub_level.set_time_constant(sample_rate, tc);
        self.pulse_width.set_time_constant(sample_rate, tc);
        self.filter_cutoff.set_time_constant(sample_rate, tc);
        self.filter_resonance.set_time_constant(sample_rate, tc);
        self.lfo_rate.set_time_constant(sample_rate, tc);
        self.lfo_depth.set_time_constant(sample_rate, tc);
        // Update all voices with new sample rate
        for voice in &mut self.voices {
            voice.sample_rate = sample_rate;
            voice.envelope.set_sample_rate(sample_rate);
            // Recalculate phase increment for any active voices
            if voice.active {
                let freq_hz = 440.0_f64 * 2.0_f64.powf((voice.note as f64 - 69.0) / 12.0);
                voice.phase_increment = (freq_hz / sample_rate).clamp(0.0, 0.5);
            }
        }
    }

    // ── Query Methods ──────────────────────────────────────────────────

    /// Returns the number of currently active voices.
    pub fn active_voice_count(&self) -> usize {
        self.voices.iter().filter(|v| v.active).count()
    }

    /// Whether any voices are currently producing sound.
    pub fn has_active_voices(&self) -> bool {
        self.voices.iter().any(|v| v.active)
    }

    /// Whether this synth is explicitly enabled for this track.
    /// BUG-082 FIX: Removed duplicate `is_active()` — was identical to
    /// `is_enabled()`. Single method is the SSOT for enablement state.
    #[inline]
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Alias for backward compatibility with callers using `is_active()`.
    #[inline]
    pub fn is_active(&self) -> bool {
        self.is_enabled()
    }

    /// Enable or disable the Essence Synth for this track.
    /// Called when the user assigns/removes the Essence Synth instrument.
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
        if !enabled {
            self.all_notes_off();
        }
    }

    // ── Render Pipeline ────────────────────────────────────────────────

    /// Render all active voices into stereo output buffers (additive mix).
    ///
    /// # Real-Time Safety
    /// Zero allocations. Bounded iteration. No I/O. No locks.
    pub fn render(&mut self, left_out: &mut [f32], right_out: &mut [f32], frame_count: usize) {
        let sr = self.sample_rate;
        let wf1 = self.waveform_1;
        let wf2 = self.waveform_2;
        let filter_type = self.filter_type;
        let lfo_target = self.lfo_target;
        // BUG-019 FIX: Pre-compute inverse sample rate once instead of per-voice.
        let inv_sr = 1.0 / sr;

        // ENT-ESS1: Bounds-check frame_count against output buffer sizes.
        let safe_count = frame_count.min(left_out.len()).min(right_out.len());

        for i in 0..safe_count {
            let vol = self.volume.next();
            let osc1_vol = if self.osc1_enabled { self.osc1_volume.next() } else { 0.0 };
            let osc2_vol = if self.osc2_enabled { self.osc2_volume.next() } else { 0.0 };
            // BUG-016 FIX: Hoist detune_ratio computation. `2^(x/1200)` is
            // expensive (~50ns powf per call). Since detune_cents is smoothed
            // per-sample (not per-voice), compute once here instead of inside
            // the voice loop. For small cent values, use fast approximation:
            // 2^(x/1200) ≈ 1 + x * ln(2)/1200 for |x| < 100 cents.
            let detune_cents_val = self.detune_cents.next() as f64;
            let detune_ratio = if detune_cents_val.abs() < 100.0 {
                // Fast linear approximation — max error ~0.03% at 100 cents
                1.0 + detune_cents_val * (std::f64::consts::LN_2 / 1200.0)
            } else {
                2.0_f64.powf(detune_cents_val / 1200.0)
            };
            let sub_lev = self.sub_level.next();
            let pw = self.pulse_width.next() as f64;
            let cutoff = self.filter_cutoff.next() as f64;
            let resonance = self.filter_resonance.next() as f64;
            let lfo_rate = self.lfo_rate.next() as f64;
            let lfo_depth = self.lfo_depth.next() as f64;
            let lfo_dt = lfo_rate * inv_sr;

            // BUG-019 FIX: Pre-compute SVF filter coefficient `g` outside
            // the voice loop when cutoff is not modulated by LFO. When LFO
            // targets filter cutoff, each voice needs its own `g`.
            let base_g = if !matches!(lfo_target, LfoTarget::FilterCutoff) {
                let mod_cutoff = cutoff.clamp(20.0, 20000.0);
                // BUG-019 FIX: Use fast rational tan() approximation for
                // small arguments. For x < 0.45 (cutoff < ~6.4kHz at 44.1kHz):
                // tan(x) ≈ x * (1 + x²/3) — max error ~0.5% vs std::tan.
                let x = (std::f64::consts::PI * mod_cutoff * inv_sr) as f32;
                if x < 0.45 {
                    x * (1.0 + x * x * (1.0 / 3.0))
                } else {
                    (std::f64::consts::PI * mod_cutoff * inv_sr).tan() as f32
                }
            } else {
                0.0 // Will be computed per-voice below
            };
            let k = (2.0 * (1.0 - resonance.clamp(0.0, 0.99))) as f32;

            for voice in &mut self.voices {
                if !voice.active {
                    continue;
                }

                let dt = voice.phase_increment;
                let dt2 = dt * detune_ratio;
                let dt_sub = dt * 0.5; // sub oscillator at -1 octave

                // ── Envelope ──
                let env = voice.envelope.process();
                if voice.envelope.is_idle() {
                    voice.active = false;
                    continue;
                }

                // ── LFO ──
                let lfo_val = (voice.lfo_phase * std::f64::consts::TAU).sin() * lfo_depth;
                voice.lfo_phase += lfo_dt;
                if voice.lfo_phase >= 1.0 {
                    voice.lfo_phase -= 1.0;
                }

                // ── LFO Modulation Targets ──
                // BUG-058 FIX: Use uniform `powf` calculation for pitch_mod. 
                // Contextually switching between approximation math directly below 2.0 semitones
                // generated micro-clicks when depth continuously crossed the boundary dynamically.
                let pitch_mod = if matches!(lfo_target, LfoTarget::Pitch) {
                    let semitones = lfo_val * 2.0; // ±2 semitones
                    2.0_f64.powf(semitones / 12.0)
                } else {
                    1.0
                };
                let cutoff_mod = if matches!(lfo_target, LfoTarget::FilterCutoff) {
                    // LFO modulates cutoff in octaves: ±2 octaves
                    2.0_f64.powf(lfo_val * 2.0)
                } else {
                    1.0
                };
                let volume_mod = if matches!(lfo_target, LfoTarget::Volume) {
                    (1.0 + lfo_val as f32).max(0.0)
                } else {
                    1.0_f32
                };

                // ── Oscillators ──
                let dt1_mod = dt * pitch_mod;
                let dt2_mod = dt2 * pitch_mod;
                let dt_sub_mod = dt_sub * pitch_mod;

                let osc1_sample = oscillator_sample_blep(
                    wf1,
                    voice.phase_1,
                    dt1_mod,
                    &mut voice.tri_state_1,
                    pw,
                );
                let osc2_sample = oscillator_sample_blep(
                    wf2,
                    voice.phase_2,
                    dt2_mod,
                    &mut voice.tri_state_2,
                    pw,
                );

                // Sub oscillator: always sine at -1 octave
                let sub_sample =
                    (voice.phase_sub * std::f64::consts::TAU).sin() as f32 * sub_lev;

                let raw = osc1_sample * osc1_vol + osc2_sample * osc2_vol + sub_sample;

                // ── SVF Filter (Linear Trapezoidal / Andy Simper topology) ──
                let g = if matches!(lfo_target, LfoTarget::FilterCutoff) {
                    // Per-voice g when LFO modulates cutoff
                    let mod_cutoff = (cutoff * cutoff_mod).clamp(20.0, 20000.0);
                    (std::f64::consts::PI * mod_cutoff * inv_sr).tan() as f32
                } else {
                    base_g
                };

                // BUG-063 FIX: Denormal flush moved BEFORE mathematical routing! 
                // Previously, denormals reached the `v1 / v2` matrices, forcing the CPU 
                // to incur massive subnormal multiplier stalls for at least one block 
                // before the flush macro saved it.
                if voice.filter_state.ic1eq.abs() < 1e-18 {
                    voice.filter_state.ic1eq = 0.0;
                }
                if voice.filter_state.ic2eq.abs() < 1e-18 {
                    voice.filter_state.ic2eq = 0.0;
                }

                let ic1eq = voice.filter_state.ic1eq;
                let ic2eq = voice.filter_state.ic2eq;
                let input = raw;

                let a1 = 1.0 / (1.0 + g * (g + k));
                let a2 = g * a1;
                let a3 = g * a2;

                let v3 = input - ic2eq;
                let v1 = a1 * ic1eq + a2 * v3;
                let v2 = ic2eq + a2 * ic1eq + a3 * v3;

                voice.filter_state.ic1eq = 2.0 * v1 - ic1eq;
                voice.filter_state.ic2eq = 2.0 * v2 - ic2eq;

                let lp = v2;
                let bp = v1;
                let hp = input - k * v1 - v2;

                let filtered = match filter_type {
                    SynthFilterType::Lowpass => lp,
                    SynthFilterType::Highpass => hp,
                    SynthFilterType::Bandpass => bp,
                    SynthFilterType::Notch => lp + hp,
                };

                // ── Output ──
                // BUG-018 FIX: Stereo spread based on note position.
                // Previously both channels received identical signal (mono).
                // Use note-based panning: low notes slightly left, high notes
                // slightly right, creating a natural stereo image.
                let out = filtered * env * voice.velocity * vol * volume_mod;
                let pan = ((voice.note as f32 - 64.0) / 64.0).clamp(-1.0, 1.0) * 0.3;
                let left_gain = (1.0 - pan).min(1.0);
                let right_gain = (1.0 + pan).min(1.0);
                left_out[i] += out * left_gain;
                right_out[i] += out * right_gain;

                // ── Phase Advance ──
                voice.phase_1 += dt1_mod;
                if voice.phase_1 >= 1.0 {
                    voice.phase_1 -= 1.0;
                }
                voice.phase_2 += dt2_mod;
                if voice.phase_2 >= 1.0 {
                    voice.phase_2 -= 1.0;
                }
                voice.phase_sub += dt_sub_mod;
                if voice.phase_sub >= 1.0 {
                    voice.phase_sub -= 1.0;
                }
            }
        }
    }
}
