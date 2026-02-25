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

use crate::instrument_core::{AdsrEnvelope, AdsrParams};
use crate::synth_types::{LfoTarget, SynthFilterType, Waveform};
use crate::oscillator::oscillator_sample_blep;
use dream_dsp::svf::SvfState;

// ── Constants ──────────────────────────────────────────────────────────

/// Maximum number of simultaneous voices for the Essence synth.
pub const ESSENCE_MAX_VOICES: usize = 32;

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
        self.active = true;
        self.note = note;
        self.velocity = velocity as f32 / 127.0;
        self.phase_1 = 0.0;
        self.phase_2 = 0.0;
        self.phase_sub = 0.0;
        let freq_hz = 440.0_f64 * 2.0_f64.powf((note as f64 - 69.0) / 12.0);
        self.phase_increment = (freq_hz / self.sample_rate).clamp(0.0, 0.5);
        self.envelope.note_on();
        self.filter_state.reset();
        self.lfo_phase = 0.0;
        self.tri_state_1 = 0.0;
        self.tri_state_2 = 0.0;
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

    // ── Global Parameters ──
    /// ADSR envelope parameters.
    adsr_params: AdsrParams,
    /// Master volume (0.0–2.0).
    pub volume: f32,

    // ── Oscillator Parameters ──
    /// OSC 1 waveform.
    waveform_1: Waveform,
    /// OSC 2 waveform.
    waveform_2: Waveform,
    /// OSC 1 volume (0.0–1.0).
    osc1_volume: f32,
    /// OSC 2 volume (0.0–1.0).
    osc2_volume: f32,
    /// OSC 1 enabled.
    osc1_enabled: bool,
    /// OSC 2 enabled.
    osc2_enabled: bool,
    /// Detune in cents between OSC 1 and OSC 2.
    detune_cents: f32,
    /// Sub oscillator level (0.0–1.0).
    sub_level: f32,
    /// Pulse width for square/pulse waves (0.05–0.95).
    pulse_width: f32,

    // ── Filter Parameters ──
    /// Filter cutoff frequency in Hz (20–20000).
    filter_cutoff: f32,
    /// Filter resonance (0.0–0.99).
    filter_resonance: f32,
    /// Filter type (LP, HP, BP, Notch).
    filter_type: SynthFilterType,

    // ── LFO Parameters ──
    /// LFO rate in Hz.
    lfo_rate: f32,
    /// LFO depth (0.0–1.0).
    lfo_depth: f32,
    /// LFO modulation target.
    lfo_target: LfoTarget,

    // ── Engine State ──
    sample_rate: f64,
}

impl EssenceSynthEngine {
    /// Creates a new Essence synth engine at the given sample rate.
    pub fn new(sample_rate: f64) -> Self {
        let voices = std::array::from_fn(|_| EssenceVoice::new(sample_rate));
        Self {
            voices,
            adsr_params: AdsrParams {
                attack: 0.01,
                decay: 0.2,
                sustain: 0.7,
                release: 0.3,
            },
            volume: 0.8,
            waveform_1: Waveform::Saw,
            waveform_2: Waveform::Square,
            osc1_volume: 1.0,
            osc2_volume: 0.0,
            osc1_enabled: true,
            osc2_enabled: false,
            detune_cents: 0.0,
            sub_level: 0.0,
            pulse_width: 0.5,
            filter_cutoff: 8000.0,
            filter_resonance: 0.0,
            filter_type: SynthFilterType::Lowpass,
            lfo_rate: 1.0,
            lfo_depth: 0.0,
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
        self.osc1_volume = volume.clamp(0.0, 1.0);
    }

    pub fn set_osc2_volume(&mut self, volume: f32) {
        self.osc2_volume = volume.clamp(0.0, 1.0);
    }

    pub fn set_osc1_enabled(&mut self, enabled: bool) {
        self.osc1_enabled = enabled;
    }

    pub fn set_osc2_enabled(&mut self, enabled: bool) {
        self.osc2_enabled = enabled;
    }

    pub fn set_detune_cents(&mut self, cents: f32) {
        self.detune_cents = cents.clamp(-100.0, 100.0);
    }

    pub fn set_sub_level(&mut self, level: f32) {
        self.sub_level = level.clamp(0.0, 1.0);
    }

    pub fn set_pulse_width(&mut self, width: f32) {
        self.pulse_width = width.clamp(0.05, 0.95);
    }

    pub fn set_filter_cutoff(&mut self, cutoff: f32) {
        self.filter_cutoff = cutoff.clamp(20.0, 20000.0);
    }

    pub fn set_filter_resonance(&mut self, resonance: f32) {
        self.filter_resonance = resonance.clamp(0.0, 0.99);
    }

    pub fn set_filter_type(&mut self, filter_type: u8) {
        self.filter_type = SynthFilterType::from_u8(filter_type);
    }

    pub fn set_lfo_rate(&mut self, rate: f32) {
        self.lfo_rate = rate.clamp(0.01, 40.0);
    }

    pub fn set_lfo_depth(&mut self, depth: f32) {
        self.lfo_depth = depth.clamp(0.0, 1.0);
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
        self.volume = volume.clamp(0.0, 2.0);
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

    /// Release all active notes immediately.
    pub fn all_notes_off(&mut self) {
        for voice in &mut self.voices {
            if voice.active {
                voice.reset();
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

    /// Whether this synth is active (always true — Essence is always available).
    pub fn is_active(&self) -> bool {
        true
    }

    // ── Render Pipeline ────────────────────────────────────────────────

    /// Render all active voices into stereo output buffers (additive mix).
    ///
    /// # Real-Time Safety
    /// Zero allocations. Bounded iteration. No I/O. No locks.
    pub fn render(&mut self, left_out: &mut [f32], right_out: &mut [f32], frame_count: usize) {
        let sr = self.sample_rate;
        let vol = self.volume;
        let wf1 = self.waveform_1;
        let wf2 = self.waveform_2;
        let osc1_vol = if self.osc1_enabled { self.osc1_volume } else { 0.0 };
        let osc2_vol = if self.osc2_enabled { self.osc2_volume } else { 0.0 };
        let detune_ratio = 2.0_f64.powf(self.detune_cents as f64 / 1200.0);
        let sub_lev = self.sub_level;
        let pw = self.pulse_width as f64;
        let cutoff = self.filter_cutoff as f64;
        let resonance = self.filter_resonance as f64;
        let filter_type = self.filter_type;
        let lfo_rate = self.lfo_rate as f64;
        let lfo_depth = self.lfo_depth as f64;
        let lfo_target = self.lfo_target;
        let lfo_dt = lfo_rate / sr;

        for voice in &mut self.voices {
            if !voice.active {
                continue;
            }

            let dt = voice.phase_increment;
            let dt2 = dt * detune_ratio;
            let dt_sub = dt * 0.5; // sub oscillator at -1 octave

            for i in 0..frame_count {
                // ── Envelope ──
                let env = voice.envelope.process();
                if voice.envelope.is_idle() {
                    voice.active = false;
                    break;
                }

                // ── LFO ──
                let lfo_val = (voice.lfo_phase * std::f64::consts::TAU).sin() * lfo_depth;
                voice.lfo_phase += lfo_dt;
                if voice.lfo_phase >= 1.0 {
                    voice.lfo_phase -= 1.0;
                }

                // ── LFO Modulation Targets ──
                let pitch_mod = if matches!(lfo_target, LfoTarget::Pitch) {
                    2.0_f64.powf(lfo_val * 2.0 / 12.0) // ±2 semitones
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
                let mod_cutoff = (cutoff * cutoff_mod).clamp(20.0, 20000.0);
                let g = (std::f64::consts::PI * mod_cutoff / sr).tan() as f32;
                let k = (2.0 * (1.0 - resonance.clamp(0.0, 0.99))) as f32;

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

                // Denormal flush
                if voice.filter_state.ic1eq.abs() < 1e-18 {
                    voice.filter_state.ic1eq = 0.0;
                }
                if voice.filter_state.ic2eq.abs() < 1e-18 {
                    voice.filter_state.ic2eq = 0.0;
                }

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
                let out = filtered * env * voice.velocity * vol * volume_mod;
                left_out[i] += out;
                right_out[i] += out;

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
