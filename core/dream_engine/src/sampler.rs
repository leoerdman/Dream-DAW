// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Sampler Instrument Engine (Real-Time Voice Pool)
// ═══════════════════════════════════════════════════════════════════════════
//
// A polyphonic sample-playback instrument driven by MIDI note events.
//
// Architecture:
//   - Voice Pool: 32 pre-allocated voices (zero allocation at runtime)
//   - Pitch Shifting: sample rate ratio — no FFT, no rubato dependency
//     ratio = 2^((midi_note - root_note) / 12.0)
//   - ADSR Envelope: per-voice amplitude envelope for clean starts/stops
//   - Stereo: reads from ClipAudio left/right channels
//
// Shared types (AdsrEnvelope, AdsrParams, EnvelopeStage, etc.) live in
// `instrument_core` — the SSOT for all internal instrument engines.
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

// Import shared instrument types from SSOT
pub use crate::instrument_core::{
    AdsrEnvelope, AdsrParams, EnvelopeStage, DEFAULT_ROOT_NOTE, MAX_VOICES,
};

// ── Sampler Voice ──────────────────────────────────────────────────────

/// A single sampler voice — reads from a pre-loaded sample with pitch shifting.
///
/// Uses a fractional cursor (`f64`) for sub-sample-accurate pitch interpolation.
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

    /// Per-voice ADSR envelope for click-free note starts/stops.
    pub envelope: AdsrEnvelope,
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
            envelope: AdsrEnvelope::new(sample_rate),
        }
    }

    /// Start playing a note.
    ///
    /// `sr_ratio` is `source_sample_rate / device_sample_rate` — applied to
    /// `pitch_ratio` so samples play at the correct pitch on any device.
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
        frame_count: usize,
        master_vol: f32,
    ) {
        let sample_len = sample_left.len().min(sample_right.len());
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

            // Apply velocity, envelope, and master volume
            let gain = self.velocity * env * master_vol;

            // ENT-S1: Denormal flush — when gain is negligibly small,
            // deactivate the voice immediately. Sub-normal float math
            // causes 10–50× CPU spikes on x86 (Intel FTZ/DAZ notwithstanding).
            if gain < 1e-12 && self.envelope.is_releasing() {
                self.active = false;
                self.envelope.reset();
                return;
            }

            // BUG-004 FIX: Apply linear fade-out when approaching end of sample
            // to prevent click/pop. When within END_FADE_FRAMES of the end,
            // linearly ramp gain to zero for a smooth transition.
            let samples_remaining = last_idx.saturating_sub(idx);
            let fade = (samples_remaining as f32 * (1.0 / END_FADE_FRAMES as f32)).min(1.0);
            let final_gain = gain * fade;

            left_out[i] += l * final_gain;
            right_out[i] += r * final_gain;

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

    /// Engine/device sample rate (Hz).
    device_sample_rate: f64,

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
            device_sample_rate: sample_rate,
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
        if source_sr > 0.0 && self.device_sample_rate > 0.0 {
            self.sample_sr_ratio = source_sr / self.device_sample_rate;
        } else {
            self.sample_sr_ratio = 1.0;
        }
        self.sample = Some(audio);
        // Stop all voices when swapping sample to prevent garbage playback
        self.all_notes_off();
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
        // ENT-S4: Early exit when no sample is loaded.
        // No voices can be active without a sample, so skip the
        // 32-voice iteration that note_off would perform.
        if self.sample.is_none() {
            return;
        }
        if velocity == 0 {
            // Velocity 0 = note-off in MIDI spec
            self.note_off(note);
            return;
        }

        // Prefer re-triggering a releasing voice on the same pitch.
        // When note-off and note-on for the same pitch arrive at the same frame
        // (common in rapid drum patterns and adjacent MIDI notes), re-using the
        // releasing voice avoids wasting a voice slot on a silent release tail.
        let retrigger = self
            .voices
            .iter_mut()
            .find(|v| v.active && v.note == note && v.envelope.is_releasing());
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
        // BUG-M16 FIX: Use `Ordering::Greater` for NaN comparison fallback
        // so NaN-level voices are always preferred for stealing.
        let steal = self.voices.iter_mut().min_by(|a, b| {
            // Prefer stealing releasing voices over sustained ones
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
                        frame_count,
                        vol,
                    );
                }
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

// ── Sample Rack Engine ──────────────────────────────────────────────────

/// The Sample Rack instrument — 16 independent simplistic samplers mapped to MIDI C1 (36) - D#2 (51).
///
/// Holds 16 `SamplerEngine` instances internally, acting as a router and additive mixer
/// for Drum Rack functionality on a single track.
pub struct SampleRackEngine {
    pads: [SamplerEngine; 16],
    /// Master volume (0.0–2.0).
    pub volume: f32,
    _device_sample_rate: f64,
}

impl SampleRackEngine {
    /// Creates a new Sample Rack with 16 empty pads.
    pub fn new(sample_rate: f64) -> Self {
        Self {
            pads: std::array::from_fn(|_| SamplerEngine::new(sample_rate)),
            volume: 1.0,
            _device_sample_rate: sample_rate,
        }
    }

    /// Access a specific pad's SamplerEngine directly to configure it.
    #[inline]
    pub fn pad_mut(&mut self, index: usize) -> Option<&mut SamplerEngine> {
        self.pads.get_mut(index)
    }

    /// Returns `true` if ANY pad in the rack has a sample loaded.
    /// Used by instrument exclusion logic to suppress Essence Synth when
    /// the track has a sample-based rack instrument assigned.
    #[inline]
    pub fn has_any_sample(&self) -> bool {
        self.pads.iter().any(|pad| pad.has_sample())
    }

    /// Trigger a note-on event. Routes MIDI pitch to the corresponding pad.
    #[inline]
    pub fn note_on(&mut self, note: u8, velocity: u8) {
        // C1 is note 36. 16 pads = 36 to 51 inclusive.
        if (36..36 + 16).contains(&note) {
            let pad_idx = (note - 36) as usize;
            if let Some(pad) = self.pads.get_mut(pad_idx) {
                // Drum Racks usually play samples at their original pitch,
                // so we trigger the pad at its own configured root_note.
                let root = pad.root_note;
                pad.note_on(root, velocity);
            }
        }
    }

    /// Trigger a note-off event.
    #[inline]
    pub fn note_off(&mut self, note: u8) {
        if (36..36 + 16).contains(&note) {
            let pad_idx = (note - 36) as usize;
            if let Some(pad) = self.pads.get_mut(pad_idx) {
                let root = pad.root_note;
                pad.note_off(root);
            }
        }
    }

    /// Stop all voices immediately across all pads.
    pub fn all_notes_off(&mut self) {
        for pad in &mut self.pads {
            pad.all_notes_off();
        }
    }

    /// Render all active pads into stereo output buffers.
    #[inline]
    pub fn render(&mut self, left_out: &mut [f32], right_out: &mut [f32], frame_count: usize) {
        // BUG-C01 FIX (Enterprise): Compute combined volume locally and pass it
        // to each voice's render() via the master_vol parameter.
        //
        // PREVIOUS PATTERN (UNSAFE):
        //   let saved = pad.volume;
        //   pad.volume = combined_vol;   // ← mutates shared state
        //   pad.render(...);
        //   pad.volume = saved;          // ← restore may never execute if preempted
        //
        // NEW PATTERN: Use the existing master_vol parameter path that already flows
        // through SamplerEngine::render() → SamplerVoice::render(master_vol).
        // pad.volume is never modified, eliminating the preemption race entirely.
        let rack_vol = self.volume;
        for pad in &mut self.pads {
            if pad.is_active() {
                let combined_vol = pad.volume * rack_vol;
                // Render voices with combined volume as master_vol.
                // This avoids mutating pad.volume which was the race condition.
                if let Some(sample) = &pad.sample {
                    let sample_left = sample.left();
                    let sample_right = sample.right();
                    if sample.num_frames > 0 {
                        for voice in &mut pad.voices {
                            if !voice.active {
                                continue;
                            }
                            voice.render(
                                left_out,
                                right_out,
                                sample_left,
                                sample_right,
                                frame_count,
                                combined_vol,
                            );
                        }
                    }
                }
            }
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
