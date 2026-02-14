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
use std::sync::Arc;

// ── Constants ──────────────────────────────────────────────────────────

/// Maximum polyphony — pre-allocated voice count.
pub const MAX_VOICES: usize = 16;

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
            1 => Self::Triangle,
            2 => Self::Saw,
            3 => Self::Square,
            _ => Self::Sine,
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
        let decay_samples = params.decay.max(0.001) * sr;
        let release_samples = params.release.max(0.001) * sr;

        self.attack_rate = 1.0 / attack_samples;
        self.decay_rate = 1.0 / decay_samples;
        self.sustain_level = params.sustain.clamp(0.0, 1.0);
        self.release_rate = 1.0 / release_samples;
    }

    /// Trigger note-on — starts the attack phase.
    #[inline]
    pub fn note_on(&mut self) {
        self.stage = EnvelopeStage::Attack;
        // Don't reset level to 0 — allows legato re-triggers without clicks
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
                self.level = 0.0;
            }
            EnvelopeStage::Attack => {
                self.level += self.attack_rate;
                if self.level >= 1.0 {
                    self.level = 1.0;
                    self.stage = EnvelopeStage::Decay;
                }
            }
            EnvelopeStage::Decay => {
                self.level -= self.decay_rate * (self.level - self.sustain_level);
                if self.level <= self.sustain_level + 0.0001 {
                    self.level = self.sustain_level;
                    self.stage = EnvelopeStage::Sustain;
                }
            }
            EnvelopeStage::Sustain => {
                self.level = self.sustain_level;
            }
            EnvelopeStage::Release => {
                self.level -= self.release_rate * self.level;
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
            sample_rate,
        }
    }

    /// Start playing a note.
    #[inline]
    pub fn trigger(&mut self, note: u8, velocity: u8, root_note: u8) {
        self.active = true;
        self.note = note;
        self.velocity = velocity as f32 / 127.0;
        self.cursor = 0.0;
        self.pitch_ratio = 2.0_f64.powf((note as f64 - root_note as f64) / 12.0);
        let freq_hz = 440.0_f64 * 2.0_f64.powf((note as f64 - 69.0) / 12.0);
        self.phase_increment = (freq_hz / self.sample_rate).clamp(0.0, 0.5);
        self.envelope.note_on();
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
            let gain = self.velocity * env;

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

    /// Engine sample rate (stored for future use, e.g. resampling).
    _sample_rate: f64,
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
            _sample_rate: sample_rate,
        }
    }

    /// Load a sample into the engine.
    pub fn set_sample(&mut self, audio: Arc<ClipAudio>) {
        self.sample = Some(audio);
        // Stop all voices when swapping sample to prevent garbage playback
        self.all_notes_off();
    }

    pub fn set_waveform(&mut self, waveform: Waveform) {
        self.waveform = waveform;
        self.oscillator_enabled = true;
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

        // First: find an idle voice
        let slot = self.voices.iter_mut().find(|v| !v.active);

        if let Some(voice) = slot {
            voice.envelope.set_params(&self.adsr_params);
            voice.trigger(note, velocity, self.root_note);
            return;
        }

        // No idle voice — steal the one with the lowest envelope level
        let steal = self.voices.iter_mut().min_by(|a, b| {
            a.envelope
                .level
                .partial_cmp(&b.envelope.level)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        if let Some(voice) = steal {
            voice.envelope.set_params(&self.adsr_params);
            voice.trigger(note, velocity, self.root_note);
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
                render_oscillator_voice(voice, self.waveform, left_out, right_out, frame_count);
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

#[inline]
fn oscillator_sample(waveform: Waveform, phase: f64) -> f32 {
    let p = phase.fract();
    match waveform {
        Waveform::Sine => (p * std::f64::consts::TAU).sin() as f32,
        Waveform::Triangle => {
            let v = 4.0 * (p - 0.5).abs() - 1.0;
            (-v) as f32
        }
        Waveform::Saw => (2.0 * p - 1.0) as f32,
        Waveform::Square => {
            if p < 0.5 { 1.0 } else { -1.0 }
        }
    }
}

fn render_oscillator_voice(
    voice: &mut SamplerVoice,
    waveform: Waveform,
    left_out: &mut [f32],
    right_out: &mut [f32],
    frame_count: usize,
) {
    for i in 0..frame_count {
        let env = voice.envelope.process();
        if voice.envelope.is_idle() {
            voice.active = false;
            return;
        }
        let sample = oscillator_sample(waveform, voice.cursor);
        let gain = voice.velocity * env;
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
