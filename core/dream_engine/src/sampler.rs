// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Sampler Instrument Engine (Real-Time Voice Pool)
// ═══════════════════════════════════════════════════════════════════════════
//
// A polyphonic sample-playback instrument driven by MIDI note events.
//
// Architecture:
//   - Voice Pool: 16 pre-allocated voices (zero allocation at runtime)
//   - Pitch Shifting: sample rate ratio — no FFT, no rubato dependency
//     ratio = 2^((midi_note - root_note) / 12.0)
//   - ADSR Envelope: per-voice amplitude envelope for clean starts/stops
//   - Stereo: reads from ClipAudio left/right channels
//
// Real-Time Safety:
//   ❌ NO heap allocations
//   ❌ NO locks
//   ❌ NO I/O
//   ✅ Only: f32/f64 math, bounded iteration, pre-allocated arrays
//
// ═══════════════════════════════════════════════════════════════════════════

use dream_clip_engine::pool::ClipAudio;
use dream_dsp::svf::{SvfCoeffs, SvfState};
use std::sync::Arc;

// ── Constants ──────────────────────────────────────────────────────────

/// BUG-47 FIX: Increased from 16 to 32 for complex chord / pad arrangements.
pub const MAX_VOICES: usize = 32;

/// Default root note: C4 (middle C).
pub const DEFAULT_ROOT_NOTE: u8 = 60;

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
            // DEEP-03 FIX: Removed log::warn — Waveform::from_u8 is called from
            // EngineCommand processing on the RT thread. log::warn acquires a global
            // mutex and heap-allocates, violating zero-alloc RT contract.
            _ => Self::Sine,
        }
    }
}

// ── Filter Type ────────────────────────────────────────────────────────

/// SVF filter mode for the synth voice filter.
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

/// LFO modulation target.
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
                self.level = self.sustain_level
                    + (self.level - self.sustain_level) * self.decay_rate;
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

    /// Reset to idle state.
    #[inline]
    pub fn reset(&mut self) {
        self.stage = EnvelopeStage::Idle;
        self.level = 0.0;
    }
}

// ── Sampler Voice ──────────────────────────────────────────────────────

/// A single sampler voice — reads from a sample with pitch shifting.
///
/// Uses a fractional cursor (`f64`) for sub-sample-accurate pitch interp.
/// Linear interpolation between adjacent samples for quality.
#[derive(Debug, Clone)]
pub struct SamplerVoice {
    /// Whether this voice is active (producing sound).
    pub active: bool,

    /// MIDI note number being played.
    pub note: u8,

    /// Velocity (0.0–1.0 normalized from MIDI 0–127).
    pub velocity: f32,

    /// Fractional read position in the source sample (in source frames).
    pub cursor: f64,

    /// Playback speed ratio: 2^((note - root) / 12).
    pub pitch_ratio: f64,

    /// Phase increment per sample (oscillator mode).
    pub phase_increment: f64,

    /// Per-voice ADSR envelope.
    pub envelope: AdsrEnvelope,

    /// Per-voice SVF filter state (reset per note-on for consistent timbre).
    pub filter_state: SvfState,

    /// Per-voice LFO phase (free-running, 0.0..1.0).
    pub lfo_phase: f64,

    sample_rate: f64,
}

impl SamplerVoice {
    /// Creates a new idle voice.
    pub fn new(sample_rate: f64) -> Self {
        Self {
            active: false,
            note: 0,
            velocity: 0.0,
            cursor: 0.0,
            pitch_ratio: 1.0,
            phase_increment: 0.0,
            envelope: AdsrEnvelope::new(sample_rate),
            filter_state: SvfState::default(),
            lfo_phase: 0.0,
            sample_rate,
        }
    }

    /// Start playing a note.
    ///
    /// `sr_ratio` is `source_sample_rate / device_sample_rate` — applied to
    /// `pitch_ratio` so samples play at the correct pitch on any device.
    /// For synth mode (oscillator), pass `1.0` (phase_increment already
    /// accounts for device SR via `freq / sample_rate`).
    #[inline]
    pub fn trigger(&mut self, note: u8, velocity: u8, root_note: u8, sr_ratio: f64) {
        self.active = true;
        self.note = note;
        self.velocity = velocity as f32 / 127.0;
        self.cursor = 0.0;
        // PITCH FIX: Apply source/device SR ratio to pitch_ratio.
        // Without this, a 44100Hz sample on a 48000Hz device plays ~1.5
        // semitones sharp because each output frame is shorter in time
        // but the cursor advances by the same amount.
        self.pitch_ratio = 2.0_f64.powf((note as f64 - root_note as f64) / 12.0) * sr_ratio;
        let freq_hz = 440.0_f64 * 2.0_f64.powf((note as f64 - 69.0) / 12.0);
        self.phase_increment = (freq_hz / self.sample_rate).clamp(0.0, 0.5);
        // DEEP-02 FIX: Gate Nyquist warning behind debug_assertions.
        // log::debug! acquires a global mutex and heap-allocates format strings.
        // This is called during note_on which runs on the RT audio thread.
        #[cfg(debug_assertions)]
        if freq_hz > self.sample_rate * 0.5 {
            log::debug!("[Sampler] Note {} ({:.0}Hz) exceeds Nyquist ({:.0}Hz), clamped", note, freq_hz, self.sample_rate * 0.5);
        }
        self.envelope.note_on();
        self.filter_state.reset(); // Fresh filter state per note
        self.lfo_phase = 0.0; // Restart LFO per note for consistent timbre
    }

    /// Release the note (enters ADSR release phase).
    #[inline]
    pub fn release(&mut self) {
        self.envelope.note_off();
    }

    /// Render this voice into stereo buffers (additive mixing).
    ///
    /// # Arguments
    /// - `left_out`, `right_out`: Output buffers to mix into (not overwrite)
    /// - `sample_left`, `sample_right`: Source audio data
    /// - `sample_len`: Length of source sample in frames
    /// - `frame_count`: Number of frames to render this buffer
    ///
    /// # Real-Time Safety
    /// Zero allocations. Bounded iteration. No I/O.
    #[inline]
    pub fn render(
        &mut self,
        left_out: &mut [f32],
        right_out: &mut [f32],
        sample_left: &[f32],
        sample_right: &[f32],
        sample_len: usize,
        frame_count: usize,
    ) {
        if !self.active || sample_len == 0 {
            return;
        }

        let last_idx = sample_len - 1;

        // BUG-004 FIX: Number of samples for end-of-sample crossfade.
        // Prevents click/pop when the voice reaches the end of the sample.
        const END_FADE_FRAMES: usize = 16;

        for i in 0..frame_count {
            // Envelope
            let env = self.envelope.process();

            if self.envelope.is_idle() {
                self.active = false;
                return;
            }

            // Integer position and fractional part for linear interpolation
            let pos = self.cursor;
            let idx = pos as usize;

            // End of sample — deactivate voice
            if idx >= last_idx {
                self.active = false;
                self.envelope.reset();
                return;
            }

            let frac = (pos - idx as f64) as f32;
            let inv_frac = 1.0 - frac;

            // Linear interpolation — 2 multiplies + 1 add per channel
            let l = sample_left[idx] * inv_frac + sample_left[idx + 1] * frac;
            let r = sample_right[idx] * inv_frac + sample_right[idx + 1] * frac;

            // Apply velocity and envelope
            let mut gain = self.velocity * env;

            // BUG-004 FIX: Apply linear fade-out when approaching end of sample
            // to prevent click/pop. When within END_FADE_FRAMES of the end,
            // linearly ramp gain to zero for a smooth transition.
            let samples_remaining = last_idx.saturating_sub(idx);
            if samples_remaining < END_FADE_FRAMES {
                let fade = samples_remaining as f32 / END_FADE_FRAMES as f32;
                gain *= fade;
            }

            left_out[i] += l * gain;
            right_out[i] += r * gain;

            // Advance cursor by pitch ratio
            self.cursor += self.pitch_ratio;
        }
    }

    /// Hard-reset this voice to idle.
    #[inline]
    pub fn reset(&mut self) {
        self.active = false;
        self.note = 0;
        self.velocity = 0.0;
        self.cursor = 0.0;
        self.phase_increment = 0.0;
        self.envelope.reset();
        self.filter_state.reset();
    }
}

// ── Sampler Engine ─────────────────────────────────────────────────────

/// The Sampler instrument — polyphonic pitched sample playback.
///
/// Holds a reference to the loaded sample (`Arc<ClipAudio>`) and a pool
/// of `MAX_VOICES` pre-allocated voices.
///
/// # Voice Allocation
/// - Note-on: find first idle voice, or steal the oldest
/// - Note-off: release the matching voice (enters ADSR release)
/// - Per-buffer: render all active voices into the track's mix buffers
pub struct SamplerEngine {
    /// The loaded audio sample (shared with ClipPool).
    pub sample: Option<Arc<ClipAudio>>,

    /// Root note — MIDI note at which sample plays at original pitch.
    pub root_note: u8,

    /// Master volume (0.0–2.0).
    pub volume: f32,

    /// Voice pool (pre-allocated, fixed size).
    voices: [SamplerVoice; MAX_VOICES],

    /// ADSR parameters shared across all voices.
    adsr_params: AdsrParams,

    /// Optional oscillator mode (used by basic wave synth instrument).
    oscillator_enabled: bool,
    waveform: Waveform,
    waveform2: Waveform,
    osc_mix: f32,
    detune_cents: f32,
    sub_level: f32,

    /// SVF filter parameters for the oscillator path.
    filter_enabled: bool,
    filter_cutoff: f32,
    filter_resonance: f32,
    filter_type: SynthFilterType,
    /// Pre-computed SVF coefficients (recalculated when cutoff/res change).
    filter_coeffs: SvfCoeffs,

    /// LFO modulation parameters.
    lfo_rate: f32,
    lfo_depth: f32,
    lfo_target: LfoTarget,

    /// Pulse width for square wave (0.05–0.95, default 0.5).
    pulse_width: f32,

    /// Engine/device sample rate (Hz).
    _sample_rate: f64,

    /// Cached ratio: source_sample_rate / device_sample_rate.
    ///
    /// Applied to `pitch_ratio` in sample-mode playback so that samples
    /// recorded at a different SR play at the correct pitch on any device.
    /// E.g., a 44100Hz sample on a 48000Hz device needs ratio = 0.91875
    /// to avoid playing ~1.5 semitones sharp.
    /// Defaults to 1.0 (no compensation) until a sample is loaded.
    sample_sr_ratio: f64,
}

impl SamplerEngine {
    /// Creates a new sampler engine.
    pub fn new(sample_rate: f64) -> Self {
        let voices = std::array::from_fn(|_| SamplerVoice::new(sample_rate));
        Self {
            sample: None,
            root_note: DEFAULT_ROOT_NOTE,
            volume: 1.0,
            voices,
            adsr_params: AdsrParams::default(),
            oscillator_enabled: false,
            waveform: Waveform::Sine,
            waveform2: Waveform::Sine,
            osc_mix: 0.35,
            detune_cents: 0.0,
            sub_level: 0.0,
            filter_enabled: false,
            filter_cutoff: 20000.0,
            filter_resonance: 0.0,
            filter_type: SynthFilterType::Lowpass,
            filter_coeffs: SvfCoeffs::new(20000.0, 0.0, sample_rate),
            lfo_rate: 1.0,
            lfo_depth: 0.0,
            lfo_target: LfoTarget::FilterCutoff,
            pulse_width: 0.5,
            _sample_rate: sample_rate,
            sample_sr_ratio: 1.0,
        }
    }

    /// Load a sample into the engine.
    pub fn set_sample(&mut self, audio: Arc<ClipAudio>) {
        // PITCH FIX: Cache the ratio between the sample's native SR and
        // the device's output SR. This ensures samples play at the correct
        // pitch regardless of which audio device is active.
        // E.g., 44100Hz sample on 48000Hz device → ratio = 0.91875.
        let source_sr = audio.sample_rate as f64;
        if source_sr > 0.0 && self._sample_rate > 0.0 {
            self.sample_sr_ratio = source_sr / self._sample_rate;
        } else {
            self.sample_sr_ratio = 1.0;
        }
        self.sample = Some(audio);
        // Stop all voices when swapping sample to prevent garbage playback
        self.all_notes_off();
    }

    pub fn set_waveform(&mut self, waveform: Waveform) {
        self.waveform = waveform;
        self.oscillator_enabled = true;
    }

    pub fn set_waveform2(&mut self, waveform: Waveform) {
        self.waveform2 = waveform;
        self.oscillator_enabled = true;
    }

    pub fn set_osc_mix(&mut self, mix: f32) {
        self.osc_mix = mix.clamp(0.0, 1.0);
    }

    pub fn set_detune_cents(&mut self, cents: f32) {
        self.detune_cents = cents.clamp(-50.0, 50.0);
    }

    pub fn set_sub_level(&mut self, level: f32) {
        self.sub_level = level.clamp(0.0, 1.0);
    }

    /// Set filter cutoff frequency in Hz (20–20000).
    pub fn set_filter_cutoff(&mut self, cutoff: f32) {
        self.filter_cutoff = cutoff.clamp(20.0, 20000.0);
        self.filter_enabled = self.filter_cutoff < 19999.0 || self.filter_resonance > 0.01;
        self.filter_coeffs = SvfCoeffs::new(
            self.filter_cutoff as f64,
            self.filter_resonance as f64,
            self._sample_rate,
        );
    }

    /// Set filter resonance (0.0–1.0, where 1.0 = self-oscillation).
    pub fn set_filter_resonance(&mut self, resonance: f32) {
        self.filter_resonance = resonance.clamp(0.0, 0.99);
        self.filter_enabled = self.filter_cutoff < 19999.0 || self.filter_resonance > 0.01;
        self.filter_coeffs = SvfCoeffs::new(
            self.filter_cutoff as f64,
            self.filter_resonance as f64,
            self._sample_rate,
        );
    }

    /// Set filter type (0=LP, 1=HP, 2=BP, 3=Notch).
    pub fn set_filter_type(&mut self, filter_type: u8) {
        self.filter_type = SynthFilterType::from_u8(filter_type);
    }

    /// Set LFO rate in Hz (0.01–20.0).
    pub fn set_lfo_rate(&mut self, rate: f32) {
        self.lfo_rate = rate.clamp(0.01, 20.0);
    }

    /// Set LFO depth (0.0–1.0).
    pub fn set_lfo_depth(&mut self, depth: f32) {
        self.lfo_depth = depth.clamp(0.0, 1.0);
    }

    /// Set LFO target (0=Filter, 1=Pitch, 2=Volume).
    pub fn set_lfo_target(&mut self, target: u8) {
        self.lfo_target = LfoTarget::from_u8(target);
    }

    /// Set pulse width for square wave (0.05–0.95).
    pub fn set_pulse_width(&mut self, width: f32) {
        self.pulse_width = width.clamp(0.05, 0.95);
    }

    /// Change the root note.
    pub fn set_root_note(&mut self, note: u8) {
        self.root_note = note.min(127);
    }

    /// Update ADSR parameters.
    pub fn set_adsr(&mut self, params: AdsrParams) {
        self.adsr_params = params;
        for voice in &mut self.voices {
            voice.envelope.set_params(&params);
        }
    }

    /// Trigger a note-on event.
    ///
    /// Finds the first idle voice. If none available, steals the oldest
    /// active voice (simple round-robin voice stealing).
    pub fn note_on(&mut self, note: u8, velocity: u8) {
        if (self.sample.is_none() && !self.oscillator_enabled) || velocity == 0 {
            // Velocity 0 = note-off in MIDI spec
            self.note_off(note);
            return;
        }

        // Prefer re-triggering a releasing voice on the same pitch.
        // When note-off and note-on for the same pitch arrive at the same frame
        // (common in rapid drum patterns and adjacent MIDI notes), re-using the
        // releasing voice avoids wasting a voice slot on a silent release tail.
        let retrigger = self.voices.iter_mut().find(|v| {
            v.active && v.note == note && v.envelope.is_releasing()
        });
        if let Some(voice) = retrigger {
            voice.envelope.set_params(&self.adsr_params);
            voice.trigger(note, velocity, self.root_note, self.sample_sr_ratio);
            return;
        }

        // First: find an idle voice
        let slot = self.voices.iter_mut().find(|v| !v.active);

        if let Some(voice) = slot {
            voice.envelope.set_params(&self.adsr_params);
            voice.trigger(note, velocity, self.root_note, self.sample_sr_ratio);
            return;
        }

        // BUG-10 FIX: Improved voice stealing — prefer releasing voices,
        // then steal the one with the lowest envelope level.
        let steal = self.voices.iter_mut().min_by(|a, b| {
            // Prefer stealing releasing voices over sustained ones
            let a_releasing = a.envelope.is_releasing() as u8;
            let b_releasing = b.envelope.is_releasing() as u8;
            b_releasing.cmp(&a_releasing).then_with(|| {
                a.envelope
                    .level
                    .partial_cmp(&b.envelope.level)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        });

        if let Some(voice) = steal {
            voice.envelope.set_params(&self.adsr_params);
            voice.trigger(note, velocity, self.root_note, self.sample_sr_ratio);
        }
    }

    /// Trigger a note-off event.
    ///
    /// Releases all voices playing the given note (handles unison).
    pub fn note_off(&mut self, note: u8) {
        for voice in &mut self.voices {
            if voice.active && voice.note == note && !voice.envelope.is_releasing() {
                voice.release();
            }
        }
    }

    /// Stop all voices immediately.
    pub fn all_notes_off(&mut self) {
        for voice in &mut self.voices {
            voice.reset();
        }
    }

    /// Render all active voices into stereo output buffers.
    ///
    /// The buffers are SUMMED INTO (not overwritten), allowing mixing
    /// with other audio sources on the same track.
    ///
    /// # Real-Time Safety
    /// Zero allocations. Bounded by MAX_VOICES iterations.
    pub fn render(&mut self, left_out: &mut [f32], right_out: &mut [f32], frame_count: usize) {
        let vol = self.volume;

        if let Some(sample) = &self.sample {
            let sample_left = sample.left();
            let sample_right = sample.right();
            let sample_len = sample.num_frames;

            if sample_len > 0 {
                for voice in &mut self.voices {
                    if !voice.active {
                        continue;
                    }

                    voice.render(
                        left_out,
                        right_out,
                        sample_left,
                        sample_right,
                        sample_len,
                        frame_count,
                    );
                }
            }
        } else if self.oscillator_enabled {
            for voice in &mut self.voices {
                if !voice.active {
                    continue;
                }
                render_oscillator_voice(
                    voice,
                    self.waveform,
                    self.waveform2,
                    self.osc_mix,
                    self.detune_cents,
                    self.sub_level,
                    self.filter_enabled,
                    self.filter_cutoff,
                    self.filter_resonance,
                    &self.filter_coeffs,
                    self.filter_type,
                    self.lfo_rate,
                    self.lfo_depth,
                    self.lfo_target,
                    self.pulse_width,
                    self._sample_rate,
                    left_out,
                    right_out,
                    frame_count,
                );
            }
        }

        // Apply master volume
        if (vol - 1.0_f32).abs() > 0.001 {
            for i in 0..frame_count {
                left_out[i] *= vol;
                right_out[i] *= vol;
            }
        }
    }

    /// Returns the number of currently active voices.
    pub fn active_voice_count(&self) -> usize {
        self.voices.iter().filter(|v| v.active).count()
    }

    /// Returns whether any voice is producing sound.
    pub fn is_active(&self) -> bool {
        self.voices.iter().any(|v| v.active)
    }

    /// Alias for `is_active()` — used by the render pipeline.
    #[inline]
    pub fn has_active_voices(&self) -> bool {
        self.is_active()
    }

    /// Returns whether a sample is loaded.
    pub fn has_sample(&self) -> bool {
        self.sample.is_some()
    }
}

// ── PolyBLEP Anti-Aliased Oscillators ──────────────────────────────────
//
// PolyBLEP (Polynomial Band-Limited Step) corrects waveform discontinuities
// by subtracting a 2nd-order polynomial residual near each transition point.
// This dramatically reduces aliasing for Saw, Square, and Triangle waveforms
// with negligible CPU overhead (~2 extra multiplies per sample).
//
// Reference: Välimäki & Franck, "Polynomial Transition Regions" (2012)

/// PolyBLEP residual — corrects the aliasing at waveform discontinuities.
///
/// `t` = distance from the discontinuity in phase units (0..1).
/// `dt` = phase increment per sample (normalized frequency).
///
/// Returns the correction value to subtract from the naive waveform.
#[inline]
fn poly_blep(t: f64, dt: f64) -> f64 {
    if dt <= 0.0 {
        return 0.0;
    }
    if t < dt {
        // t is just past the discontinuity (0..dt)
        let x = t / dt;
        // 2x - x² - 1
        2.0 * x - x * x - 1.0
    } else if t > 1.0 - dt {
        // t is just before the discontinuity ((1-dt)..1)
        let x = (t - 1.0) / dt;
        // x² + 2x + 1
        x * x + 2.0 * x + 1.0
    } else {
        0.0
    }
}

/// PolyBLEP-corrected oscillator sample with variable pulse width.
///
/// - **Sine**: Already band-limited, no correction needed.
/// - **Saw**: Naive saw minus PolyBLEP at the wrap discontinuity.
/// - **Square**: Variable duty cycle (pulse_width), PolyBLEP at both transitions.
/// - **Triangle**: Leaky-integrated PolyBLEP square (produces band-limited triangle).
#[inline]
fn oscillator_sample_blep(
    waveform: Waveform,
    phase: f64,
    dt: f64,
    tri_state: &mut f64,
    pulse_width: f64,
) -> f32 {
    let p = phase.fract().max(0.0);
    match waveform {
        Waveform::Sine => (p * std::f64::consts::TAU).sin() as f32,
        Waveform::Saw => {
            let naive = 2.0 * p - 1.0;
            let corrected = naive - poly_blep(p, dt);
            corrected as f32
        }
        Waveform::Square => {
            // Variable duty cycle square wave with PolyBLEP at both edges
            let pw = pulse_width.clamp(0.05, 0.95);
            let naive: f64 = if p < pw { 1.0 } else { -1.0 };
            // PolyBLEP correction at rising edge (phase=0) and falling edge (phase=pw)
            let blep_rise = poly_blep(p, dt);
            let blep_fall = poly_blep((p - pw + 1.0) % 1.0, dt);
            let corrected = naive + blep_rise - blep_fall;
            corrected as f32
        }
        Waveform::Triangle => {
            let naive_sq: f64 = if p < 0.5 { 1.0 } else { -1.0 };
            let blep1 = poly_blep(p, dt);
            let blep2 = poly_blep((p + 0.5) % 1.0, dt);
            let sq = naive_sq + blep1 - blep2;
            *tri_state = 0.999 * *tri_state + 4.0 * dt * sq;
            (*tri_state).clamp(-1.0, 1.0) as f32
        }
    }
}

/// Fallback for contexts where we don't track per-osc triangle state
/// (e.g. sub oscillator which is always square).
#[inline]
fn oscillator_sample_blep_stateless(waveform: Waveform, phase: f64, dt: f64) -> f32 {
    let mut dummy = 0.0;
    oscillator_sample_blep(waveform, phase, dt, &mut dummy, 0.5)
}

#[allow(clippy::too_many_arguments)]
fn render_oscillator_voice(
    voice: &mut SamplerVoice,
    waveform: Waveform,
    waveform2: Waveform,
    osc_mix: f32,
    detune_cents: f32,
    sub_level: f32,
    filter_enabled: bool,
    filter_cutoff_base: f32,
    filter_resonance: f32,
    filter_coeffs_base: &SvfCoeffs,
    filter_type: SynthFilterType,
    lfo_rate: f32,
    lfo_depth: f32,
    lfo_target: LfoTarget,
    pulse_width: f32,
    sample_rate: f64,
    left_out: &mut [f32],
    right_out: &mut [f32],
    frame_count: usize,
) {
    let mix2 = osc_mix.clamp(0.0, 1.0);
    let mix1 = 1.0 - mix2;
    // AUD-120 FIX: Use exp2 instead of powf — exp2 is a CPU intrinsic on x86/ARM,
    // while powf(x, y) calls exp(y * ln(x)), which is ~2x slower.
    let detune_ratio = (detune_cents as f64 / 1200.0).exp2();
    let sub = sub_level.clamp(0.0, 1.0);
    let dt = voice.phase_increment;
    let dt2 = dt * detune_ratio;
    let dt_sub = dt * 0.5; // sub oscillator is one octave below
    let pw = pulse_width as f64;
    let lfo_inc = lfo_rate as f64 / sample_rate;

    // DEEP-04 FIX: Pre-compute LFO-modulated filter coefficients once per buffer.
    // Previously `SvfCoeffs::new()` (involves tan() + division) was computed per-sample
    // inside the loop. At 44.1kHz: ~15ns × 512 frames × 32 voices = ~245µs per buffer.
    // LFO rate is max 20Hz, so the modulation changes negligibly within one buffer.
    let lfo_filter_coeffs = if filter_enabled
        && lfo_target == LfoTarget::FilterCutoff
        && lfo_depth > 0.0001
    {
        // Sample the LFO at the voice's current phase for the buffer midpoint.
        let lfo_mid = (voice.lfo_phase * std::f64::consts::TAU).sin() as f32 * lfo_depth;
        let mod_factor = 2.0_f32.powf(lfo_mid * 4.0);
        let modulated_cutoff = (filter_cutoff_base * mod_factor).clamp(20.0, 20000.0);
        SvfCoeffs::new(
            modulated_cutoff.into(),
            filter_resonance.into(),
            sample_rate,
        )
    } else {
        *filter_coeffs_base
    };

    // Per-oscillator triangle integrator state
    let mut tri1 = 0.0_f64;
    let mut tri2 = 0.0_f64;

    for i in 0..frame_count {
        let env = voice.envelope.process();
        if voice.envelope.is_idle() {
            voice.active = false;
            return;
        }

        // ── LFO computation ───────────────────────────────────────────
        let lfo_val = if lfo_depth > 0.0001 {
            let lfo_sample = (voice.lfo_phase * std::f64::consts::TAU).sin() as f32;
            voice.lfo_phase += lfo_inc;
            // BUG-099 FIX: Use fract() instead of subtraction to prevent
            // floating-point precision loss over long playback sessions.
            if voice.lfo_phase >= 1.0 {
                voice.lfo_phase = voice.lfo_phase.fract();
            }
            lfo_sample * lfo_depth
        } else {
            0.0
        };

        // ── Pitch modulation from LFO (vibrato) ──────────────────────
        let (phase1, phase2, sub_phase, dt_mod, dt2_mod) =
            if lfo_target == LfoTarget::Pitch && lfo_val.abs() > 0.0001 {
                // ±2 semitones max vibrato range
                // AUD-121 FIX: Use exp2 instead of powf — native CPU instruction.
                let pitch_mult = (lfo_val as f64 * 2.0 / 12.0).exp2();
                let dt_m = dt * pitch_mult;
                let dt2_m = dt2 * pitch_mult;
                let p1 = voice.cursor;
                let p2 = (voice.cursor * detune_ratio * pitch_mult).fract();
                let sp = (voice.cursor * 0.5 * pitch_mult).fract();
                (p1, p2, sp, dt_m, dt2_m)
            } else {
                let p1 = voice.cursor;
                let p2 = (voice.cursor * detune_ratio).fract();
                let sp = (voice.cursor * 0.5).fract();
                (p1, p2, sp, dt, dt2)
            };

        let osc1 = oscillator_sample_blep(waveform, phase1, dt_mod, &mut tri1, pw);
        let osc2 = oscillator_sample_blep(waveform2, phase2, dt2_mod, &mut tri2, pw);
        let sub_osc = oscillator_sample_blep_stateless(Waveform::Square, sub_phase, dt_sub);

        let mut sample = osc1 * mix1 + osc2 * mix2 + sub_osc * sub;

        // ── Per-voice SVF filter (with optional LFO cutoff modulation) ─
        // DEEP-04 FIX: Use pre-computed coeffs (hoisted before the sample loop).
        // Previously SvfCoeffs::new() was called per-sample here, which involves
        // tan() + division (~15ns × 512 frames × 32 voices = ~245µs per buffer).
        if filter_enabled {
            let c = lfo_filter_coeffs;

            let s = &mut voice.filter_state;
            let input = sample;

            let v3 = input - s.ic2eq;
            let v1 = c.a1 * s.ic1eq + c.a2 * v3;
            let v2 = s.ic2eq + c.a2 * s.ic1eq + c.a3 * v3;

            s.ic1eq = 2.0 * v1 - s.ic1eq;
            s.ic2eq = 2.0 * v2 - s.ic2eq;

            // AUD-124 FIX: Flush denormals in per-voice SVF filter state.
            // The svf.rs SvfFilter::process_all() has this flush, but the inline
            // copy here was missing it — causing 100x CPU slowdown during note
            // release tails when filter state values go below 1e-18.
            if s.ic1eq.abs() < 1e-18 { s.ic1eq = 0.0; }
            if s.ic2eq.abs() < 1e-18 { s.ic2eq = 0.0; }

            sample = match filter_type {
                SynthFilterType::Lowpass => v2,
                SynthFilterType::Highpass => input - c.k * v1 - v2,
                SynthFilterType::Bandpass => v1,
                SynthFilterType::Notch => {
                    let lp = v2;
                    let hp = input - c.k * v1 - v2;
                    lp + hp
                }
            };
        }

        // ── Volume modulation from LFO (tremolo) ─────────────────────
        let gain = if lfo_target == LfoTarget::Volume && lfo_val.abs() > 0.0001 {
            // Map LFO [-depth..+depth] to volume multiplier [1-depth..1]
            let vol_mod = 1.0 - lfo_depth * 0.5 * (1.0 - lfo_val / lfo_depth.max(0.0001));
            voice.velocity * env * vol_mod.clamp(0.0, 1.0)
        } else {
            voice.velocity * env
        };

        left_out[i] += sample * gain;
        right_out[i] += sample * gain;
        voice.cursor += voice.phase_increment;
        if voice.cursor >= 1.0 {
            voice.cursor -= 1.0;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn make_sine_sample(frames: usize, freq: f64, sample_rate: f64) -> Arc<ClipAudio> {
        let mut left = vec![0.0f32; frames];
        for (i, sample) in left.iter_mut().enumerate().take(frames) {
            *sample = (2.0 * std::f64::consts::PI * freq * i as f64 / sample_rate).sin() as f32;
        }
        let right = left.clone();
        Arc::new(ClipAudio::new(
            "test_sine.wav",
            vec![left, right],
            sample_rate as u32,
        ))
    }

    #[test]
    fn voice_renders_at_unity_pitch() {
        let sr = 44100.0;
        let sample = make_sine_sample(44100, 440.0, sr);
        let mut engine = SamplerEngine::new(sr);
        engine.set_sample(sample);

        // Play root note (same pitch as sample)
        engine.note_on(60, 100);
        assert_eq!(engine.active_voice_count(), 1);

        let mut left = vec![0.0f32; 1024];
        let mut right = vec![0.0f32; 1024];
        engine.render(&mut left, &mut right, 1024);

        // Should have non-zero output
        let max_level: f32 = left.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
        assert!(
            max_level > 0.01,
            "Expected audible output, got max={}",
            max_level
        );
    }

    #[test]
    fn voice_pitches_up_one_octave() {
        let sr = 44100.0;
        let sample = make_sine_sample(44100, 440.0, sr);
        let mut engine = SamplerEngine::new(sr);
        engine.set_sample(sample);

        // Play one octave above root
        engine.note_on(72, 100); // C5 = root(60) + 12
        assert_eq!(engine.active_voice_count(), 1);

        let mut left = vec![0.0f32; 1024];
        let mut right = vec![0.0f32; 1024];
        engine.render(&mut left, &mut right, 1024);

        // Voice should consume sample at 2x speed
        let voice = &engine.voices[0];
        if voice.active {
            assert!((voice.pitch_ratio - 2.0).abs() < 0.01);
        }
    }

    #[test]
    fn note_off_releases_voice() {
        let sr = 44100.0;
        let sample = make_sine_sample(44100, 440.0, sr);
        let mut engine = SamplerEngine::new(sr);
        engine.set_sample(sample);

        engine.note_on(60, 100);
        assert_eq!(engine.active_voice_count(), 1);

        engine.note_off(60);
        // Voice is still active during release phase
        assert_eq!(engine.active_voice_count(), 1);

        // Render enough buffers for release to complete
        let mut left = vec![0.0f32; 1024];
        let mut right = vec![0.0f32; 1024];
        for _ in 0..100 {
            engine.render(&mut left, &mut right, 1024);
        }

        // After enough time, voice should be idle
        assert_eq!(engine.active_voice_count(), 0);
    }

    #[test]
    fn polyphony_works() {
        let sr = 44100.0;
        let sample = make_sine_sample(44100, 440.0, sr);
        let mut engine = SamplerEngine::new(sr);
        engine.set_sample(sample);

        // Trigger multiple notes
        engine.note_on(60, 100);
        engine.note_on(64, 100);
        engine.note_on(67, 100);

        assert_eq!(engine.active_voice_count(), 3);
    }

    #[test]
    fn voice_stealing_when_full() {
        let sr = 44100.0;
        let sample = make_sine_sample(44100, 440.0, sr);
        let mut engine = SamplerEngine::new(sr);
        engine.set_sample(sample);

        // Fill all voices
        for i in 0..MAX_VOICES {
            engine.note_on(40 + i as u8, 100);
        }
        assert_eq!(engine.active_voice_count(), MAX_VOICES);

        // One more note should steal a voice
        engine.note_on(100, 127);
        assert_eq!(engine.active_voice_count(), MAX_VOICES);
    }

    #[test]
    fn all_notes_off_silences_engine() {
        let sr = 44100.0;
        let sample = make_sine_sample(44100, 440.0, sr);
        let mut engine = SamplerEngine::new(sr);
        engine.set_sample(sample);

        engine.note_on(60, 100);
        engine.note_on(64, 100);
        assert_eq!(engine.active_voice_count(), 2);

        engine.all_notes_off();
        assert_eq!(engine.active_voice_count(), 0);
    }

    #[test]
    fn no_sample_produces_silence() {
        let sr = 44100.0;
        let mut engine = SamplerEngine::new(sr);

        engine.note_on(60, 100); // No sample loaded
        assert_eq!(engine.active_voice_count(), 0);

        let mut left = vec![0.0f32; 512];
        let mut right = vec![0.0f32; 512];
        engine.render(&mut left, &mut right, 512);

        let sum: f32 = left.iter().map(|s| s.abs()).sum();
        assert!(sum < 0.001);
    }

    #[test]
    fn adsr_envelope_basic_cycle() {
        let sr = 44100.0;
        let mut env = AdsrEnvelope::new(sr);
        env.set_params(&AdsrParams {
            attack: 0.01, // ~441 samples
            decay: 0.01,
            sustain: 0.8,
            release: 0.01,
        });

        // Idle
        assert!(env.is_idle());

        // Attack
        env.note_on();
        let mut max_level = 0.0f32;
        for _ in 0..500 {
            let l = env.process();
            if l > max_level {
                max_level = l;
            }
        }
        assert!(max_level > 0.9, "Attack should reach near 1.0");

        // Sustain phase: run more samples
        for _ in 0..1000 {
            env.process();
        }

        // Release
        env.note_off();
        for _ in 0..5000 {
            env.process();
        }
        assert!(env.is_idle(), "Should be idle after release");
    }
}
