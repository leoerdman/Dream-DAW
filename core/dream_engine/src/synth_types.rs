// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Synth Types (Shared Oscillator / Filter / Modulation Enums)
// ═══════════════════════════════════════════════════════════════════════════
//
// These types define the parameter space for synthesizer engines
// (EssenceSynthEngine, future synths). They are NOT used by
// SamplerEngine — the sampler only plays back pre-loaded PCM data.
//
// ═══════════════════════════════════════════════════════════════════════════

// ── Oscillator Waveform ────────────────────────────────────────────────

/// Oscillator waveform shape for synth engines.
///
/// Used by `EssenceSynthEngine` for dual-oscillator subtractive synthesis.
/// Not relevant to `SamplerEngine` (which reads PCM samples, not waveforms).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waveform {
    Sine = 0,
    Triangle = 1,
    Saw = 2,
    Square = 3,
}

impl Waveform {
    pub fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::Sine,
            1 => Self::Triangle,
            2 => Self::Saw,
            3 => Self::Square,
            // Safe fallback — no logging on RT thread (zero-alloc contract).
            _ => Self::Sine,
        }
    }
}

// ── Filter Type ────────────────────────────────────────────────────────

/// SVF filter mode for synth voice filters.
///
/// Controls the spectral shaping of the oscillator output
/// via a State Variable Filter (SVF).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SynthFilterType {
    Lowpass = 0,
    Highpass = 1,
    Bandpass = 2,
    Notch = 3,
}

impl SynthFilterType {
    pub fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Highpass,
            2 => Self::Bandpass,
            3 => Self::Notch,
            _ => Self::Lowpass,
        }
    }
}

// ── LFO Target ─────────────────────────────────────────────────────────

/// LFO modulation target for synth engines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LfoTarget {
    /// LFO modulates filter cutoff frequency.
    FilterCutoff = 0,
    /// LFO modulates oscillator pitch (vibrato).
    Pitch = 1,
    /// LFO modulates output volume (tremolo).
    Volume = 2,
}

impl LfoTarget {
    pub fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::FilterCutoff,
            1 => Self::Pitch,
            2 => Self::Volume,
            _ => Self::FilterCutoff,
        }
    }
}
