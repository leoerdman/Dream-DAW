// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Audio Driver (cpal 0.17 Backend)
// ═══════════════════════════════════════════════════════════════════════════
//
// Initializes the platform audio subsystem and runs the real-time callback.
// The callback is THE HOT PATH. Every CPU cycle matters.
//
// Architecture:
//   UI Thread (Tauri) → rtrb::Producer → Audio Callback → cpal output
//
// This driver delegates ALL audio processing to RenderContext, which
// orchestrates ClipScheduler, ClipReader, ChannelStrips, SummingBus,
// and MeterBank. The driver is purely responsible for:
//   1. Platform audio device setup (cpal)
//   2. Command queue drain → RenderContext state updates
//   3. Calling RenderContext::render() per buffer
//
// ═══════════════════════════════════════════════════════════════════════════

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicUsize, Ordering};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use log::{error, info};

use dream_clip_engine::pool::ClipPool;
use dream_clip_engine::scheduler::LoopRegion;
use dream_clip_engine::midi_scheduler::{MidiScheduler, ScheduledNote};
use dream_ipc::metering::MeterBank;
use dream_ipc::{EngineCommand, MasterClock};
use dream_models::project::AudioClip;
use dream_models::midi::MidiClip;

use crate::render_callback::RenderContext;
use crate::sampler::{SamplerEngine, AdsrParams};

// ── Shared Clip Snapshot ────────────────────────────────────────────────

/// Atomic snapshot of per-track clip data for the audio thread.
///
/// The UI thread updates this via `swap()` whenever the project changes.
/// The audio thread reads the current snapshot each buffer via `load()`.
///
/// Uses `arc_swap`-style double-buffering: the audio thread holds an
/// `Arc` clone and never blocks.
pub struct SharedClipSnapshot {
    inner: std::sync::Mutex<Arc<Vec<Vec<AudioClip>>>>,
}

impl SharedClipSnapshot {
    /// Creates a new empty snapshot.
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(Arc::new(Vec::new())),
        }
    }

    /// Atomically replaces the clip snapshot (called from UI thread).
    ///
    /// The audio thread will pick up the new snapshot on the next buffer.
    pub fn swap(&self, new_clips: Vec<Vec<AudioClip>>) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = Arc::new(new_clips);
        }
    }

    /// Gets the current snapshot (called from audio thread).
    ///
    /// Returns an `Arc` clone — the audio thread can hold this without
    /// blocking the UI thread from swapping in a new snapshot.
    pub fn load(&self) -> Arc<Vec<Vec<AudioClip>>> {
        self.inner
            .lock()
            .map(|guard| Arc::clone(&guard))
            .unwrap_or_else(|_| Arc::new(Vec::new()))
    }
}

impl Default for SharedClipSnapshot {
    fn default() -> Self {
        Self::new()
    }
}

// ── Shared MIDI Snapshot ───────────────────────────────────────────────

/// Atomic snapshot of per-track MIDI clip data for the audio thread.
///
/// Follows the same pattern as `SharedClipSnapshot`: the UI thread
/// updates via `swap()`, the audio thread reads via `load()`.
pub struct SharedMidiSnapshot {
    inner: std::sync::Mutex<Arc<Vec<Vec<MidiClip>>>>,
}

impl SharedMidiSnapshot {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(Arc::new(Vec::new())),
        }
    }

    /// Atomically replaces the MIDI snapshot (called from UI thread).
    pub fn swap(&self, new_clips: Vec<Vec<MidiClip>>) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = Arc::new(new_clips);
        }
    }

    /// Gets the current MIDI snapshot (called from audio thread).
    pub fn load(&self) -> Arc<Vec<Vec<MidiClip>>> {
        self.inner
            .lock()
            .map(|guard| Arc::clone(&guard))
            .unwrap_or_else(|_| Arc::new(Vec::new()))
    }
}

impl Default for SharedMidiSnapshot {
    fn default() -> Self {
        Self::new()
    }
}

// ── Shared Sampler Samples ─────────────────────────────────────────────

use dream_clip_engine::pool::ClipAudio;

/// Per-track sampler sample and parameters.
///
/// The UI thread sets this when a user loads a sample onto a track.
/// The audio thread reads it to configure per-track SamplerEngines.
pub struct SharedSamplerSamples {
    inner: std::sync::Mutex<Arc<Vec<Option<Arc<ClipAudio>>>>>,
}

impl SharedSamplerSamples {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(Arc::new(Vec::new())),
        }
    }

    /// Sets the loaded sample for a specific track.
    pub fn set_track_sample(&self, track_index: usize, sample: Option<Arc<ClipAudio>>) {
        if let Ok(mut guard) = self.inner.lock() {
            let mut samples = (**guard).clone();
            if track_index >= samples.len() {
                samples.resize(track_index + 1, None);
            }
            samples[track_index] = sample;
            *guard = Arc::new(samples);
        }
    }

    /// Gets all track samples (called from audio thread).
    pub fn load(&self) -> Arc<Vec<Option<Arc<ClipAudio>>>> {
        self.inner
            .lock()
            .map(|guard| Arc::clone(&guard))
            .unwrap_or_else(|_| Arc::new(Vec::new()))
    }
}

impl Default for SharedSamplerSamples {
    fn default() -> Self {
        Self::new()
    }
}

// ── Constants ───────────────────────────────────────────────────────────

/// Default test tone frequency (A4 = 440 Hz).
const DEFAULT_FREQUENCY: f32 = 440.0;

/// Output amplitude for test tone (0.0 – 1.0). Conservative to protect ears.
const TEST_TONE_AMPLITUDE: f32 = 0.25;

/// Exponential smoothing coefficient for frequency transitions.
const FREQ_SMOOTHING: f32 = 0.001;

// ── Audio Stream Handle ─────────────────────────────────────────────────

/// Holds the live cpal stream. Dropping this stops audio output.
pub struct AudioStreamHandle {
    _stream: cpal::Stream,
}

// ── Error Type ──────────────────────────────────────────────────────────

/// Errors from audio driver initialization (non-RT only).
#[derive(Debug)]
pub enum AudioDriverError {
    NoOutputDevice,
    DefaultConfigError(String),
    BuildStreamError(String),
    PlayStreamError(String),
}

impl std::fmt::Display for AudioDriverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoOutputDevice => write!(f, "No audio output device found"),
            Self::DefaultConfigError(e) => write!(f, "Failed to query default config: {e}"),
            Self::BuildStreamError(e) => write!(f, "Failed to build stream: {e}"),
            Self::PlayStreamError(e) => write!(f, "Failed to play stream: {e}"),
        }
    }
}

impl std::error::Error for AudioDriverError {}

// ── Public API ──────────────────────────────────────────────────────────

/// Starts the real-time audio output thread.
///
/// # Arguments
/// - `consumer`: Receiving end of the command ring buffer (moved into callback).
/// - `clock`: Shared master clock (audio callback is the sole writer).
/// - `meter_bank`: Shared meter bank for lock-free metering.
/// - `clip_pool`: Shared clip pool (pre-loaded audio data). Accessed via `try_lock()`.
/// - `clip_snapshot`: Shared snapshot of project clips.
/// - `preview_buffer`: Arc to the preview audio buffer (set by browser audition).
/// - `preview_cursor`: Arc to the current playback cursor in the preview buffer.
///
/// # Returns
/// `AudioStreamHandle` — keep alive for audio to continue. Drop to stop.
pub fn start_audio_thread(
    mut consumer: rtrb::Consumer<EngineCommand>,
    clock: Arc<MasterClock>,
    meter_bank: Arc<MeterBank>,
    clip_pool: Arc<Mutex<ClipPool>>,
    clip_snapshot: Arc<SharedClipSnapshot>,
    midi_snapshot: Arc<SharedMidiSnapshot>,
    sampler_samples: Arc<SharedSamplerSamples>,
    preview_buffer: Arc<Mutex<Option<Vec<f32>>>>,
    preview_cursor: Arc<AtomicUsize>,
) -> Result<AudioStreamHandle, AudioDriverError> {
    // ── 1. Host & Device ────────────────────────────────────────────
    let host = cpal::default_host();
    info!("Audio host: {:?}", host.id());

    let device = host
        .default_output_device()
        .ok_or(AudioDriverError::NoOutputDevice)?;

    let device_name = device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| String::from("Unknown Device"));
    info!("Output device: {}", device_name);

    // ── 2. Config ───────────────────────────────────────────────────
    let supported_config = device
        .default_output_config()
        .map_err(|e| AudioDriverError::DefaultConfigError(e.to_string()))?;

    let sample_format = supported_config.sample_format();
    let sample_rate = supported_config.sample_rate();
    let channels = supported_config.channels() as usize;
    let config: cpal::StreamConfig = supported_config.into();

    info!(
        "Stream config: {:?}, {}ch, {:?}",
        sample_rate, channels, sample_format
    );

    // ── 3. Build RenderContext ──────────────────────────────────────
    let sample_rate_f64 = config.sample_rate as f64;
    let mut render_ctx = RenderContext::new(
        64,  // MAX_TRACKS pre-allocated
        sample_rate_f64,
        channels,
        Arc::clone(&meter_bank),
    );

    // ── 4. Test tone state (fallback when no clips loaded) ──────────
    let mut test_tone_phase: f64 = 0.0;
    let mut test_tone_current_freq: f32 = DEFAULT_FREQUENCY;
    let mut test_tone_target_freq: f32 = DEFAULT_FREQUENCY;
    let mut test_tone_enabled: bool = false;

    // ── 5. Playback state ───────────────────────────────────────────
    let mut is_playing: bool = false;
    let mut _bpm: f64 = 120.0;
    // per-track mute/solo state (used for effective gain calculation)
    let mut track_muted: [bool; 64] = [false; 64];
    let mut track_soloed: [bool; 64] = [false; 64];
    let mut any_solo: bool = false;

    // ── 6. Per-track sampler engines ─────────────────────────────────
    // Pre-allocated array of 64 engines (one per track max).
    // Each engine starts with no sample loaded — it becomes active
    // when the user assigns a sample via SharedSamplerSamples.
    let mut sampler_engines: Vec<SamplerEngine> = (0..64)
        .map(|_| SamplerEngine::new(sample_rate_f64))
        .collect();
    // Scratch buffers for sampler output (reused each buffer, zero-alloc)
    let mut sampler_left = vec![0.0f32; 8192];
    let mut sampler_right = vec![0.0f32; 8192];
    // Track which samples were last loaded per-track to avoid re-assigning
    let mut last_sample_generation: u64 = 0;

    let stream = device
        .build_output_stream(
            &config,
            // ┌──────────────────────────────────────────────────────┐
            // │  THE HOT PATH — Real-Time Audio Callback             │
            // │  NO allocations. NO locks (except Arc::clone which   │
            // │  is atomic). NO I/O. NO panics.                      │
            // └──────────────────────────────────────────────────────┘
            move |data: &mut [f32], _info: &cpal::OutputCallbackInfo| {
                let frame_count = data.len() / channels;

                // ── A. Drain command queue ───────────────────────
                while let Ok(cmd) = consumer.pop() {
                    match cmd {
                        EngineCommand::SetPlay(play) => {
                            is_playing = play;
                            render_ctx.playhead.set_advancing(play);
                            if !play {
                                test_tone_phase = 0.0;
                                test_tone_enabled = false;
                                // Reset all meters to silence when transport stops
                                // so stale peaks don't stick on the UI.
                                render_ctx.meter_bank.reset_all();
                            }
                        }
                        EngineCommand::SetFreq(freq) => {
                            test_tone_target_freq = freq.clamp(20.0, 20_000.0);
                            test_tone_enabled = true;
                        }
                        EngineCommand::Seek(frame) => {
                            clock.reset();
                            if frame > 0 {
                                clock.advance(frame);
                            }
                            render_ctx.playhead.seek(frame);
                        }
                        EngineCommand::SetBpm(bpm) => {
                            _bpm = bpm.clamp(20.0, 999.0);
                        }
                        EngineCommand::SetLoopEnabled(enabled) => {
                            if !enabled {
                                render_ctx.loop_region = None;
                            }
                        }
                        EngineCommand::SetLoopRegion { start, end } => {
                            if end > start {
                                render_ctx.loop_region = Some(LoopRegion {
                                    start,
                                    end,
                                });
                            }
                        }
                        EngineCommand::SetTrackVolume { track_index, volume } => {
                            let idx = track_index as usize;
                            if idx < render_ctx.track_slots.len() {
                                render_ctx.track_slots[idx].strip.set_volume(volume);
                            }
                        }
                        EngineCommand::SetTrackPan { track_index, pan } => {
                            let idx = track_index as usize;
                            if idx < render_ctx.track_slots.len() {
                                render_ctx.track_slots[idx].strip.set_pan(pan);
                            }
                        }
                        EngineCommand::SetTrackMute { track_index, muted } => {
                            let idx = track_index as usize;
                            if idx < 64 {
                                track_muted[idx] = muted;
                                // Recalculate effective gain
                                if idx < render_ctx.track_slots.len() {
                                    let eff = if muted { 0.0 } else { 1.0 };
                                    render_ctx.track_slots[idx].strip.set_effective_gain(eff);
                                }
                            }
                        }
                        EngineCommand::SetTrackSolo { track_index, soloed } => {
                            let idx = track_index as usize;
                            if idx < 64 {
                                track_soloed[idx] = soloed;
                                any_solo = track_soloed.iter().any(|s| *s);
                                // Recalculate effective gain for ALL tracks
                                for i in 0..render_ctx.track_slots.len().min(64) {
                                    let eff = if track_muted[i] {
                                        0.0
                                    } else if any_solo && !track_soloed[i] {
                                        0.0
                                    } else {
                                        1.0
                                    };
                                    render_ctx.track_slots[i].strip.set_effective_gain(eff);
                                }
                            }
                        }
                        // ── Sampler Commands ────────────────────────
                        EngineCommand::SamplerNoteOn { track_index, pitch, velocity } => {
                            let idx = track_index as usize;
                            if idx < sampler_engines.len() {
                                sampler_engines[idx].note_on(pitch, velocity);
                            }
                        }
                        EngineCommand::SamplerNoteOff { track_index, pitch } => {
                            let idx = track_index as usize;
                            if idx < sampler_engines.len() {
                                sampler_engines[idx].note_off(pitch);
                            }
                        }
                        EngineCommand::SetSamplerRootNote { track_index, root_note } => {
                            let idx = track_index as usize;
                            if idx < sampler_engines.len() {
                                sampler_engines[idx].root_note = root_note;
                            }
                        }
                        EngineCommand::SetSamplerVolume { track_index, volume } => {
                            let idx = track_index as usize;
                            if idx < sampler_engines.len() {
                                sampler_engines[idx].volume = volume;
                            }
                        }
                        EngineCommand::SetSamplerAdsr { track_index, attack, decay, sustain, release } => {
                            let idx = track_index as usize;
                            if idx < sampler_engines.len() {
                                sampler_engines[idx].set_adsr(AdsrParams {
                                    attack: attack as f64,
                                    decay: decay as f64,
                                    sustain: sustain as f64,
                                    release: release as f64,
                                });
                            }
                        }
                        EngineCommand::SamplerAllNotesOff { track_index } => {
                            let idx = track_index as usize;
                            if idx < sampler_engines.len() {
                                sampler_engines[idx].all_notes_off();
                            }
                        }
                        EngineCommand::Shutdown => {
                            is_playing = false;
                            test_tone_phase = 0.0;
                            // Kill all sampler voices on shutdown
                            for engine in sampler_engines.iter_mut() {
                                engine.all_notes_off();
                            }
                        }
                    }
                }

                if !is_playing {
                    // ── Silence when stopped (no transport audio) ──
                    data.fill(0.0);
                    // NOTE: Do NOT return here — preview mixing must
                    // still run below so browser audition works when
                    // transport is stopped.
                } else {
                    // ── B. Load clip snapshot & render ───────────────
                    let snapshot = clip_snapshot.load();
                    let has_clips = !snapshot.is_empty()
                        && snapshot.iter().any(|track_clips| !track_clips.is_empty());

                    if has_clips {
                        // Disable test tone automatically when real clips exist
                        // so the sine never bleeds through.
                        test_tone_enabled = false;

                        // Real clip playback via RenderContext
                        // Use try_lock to get non-blocking access to clip pool.
                        // If UI thread is inserting, we skip this buffer (silence).
                        if let Ok(pool_guard) = clip_pool.try_lock() {
                            let clips_refs: Vec<&[AudioClip]> = snapshot
                                .iter()
                                .map(|v| v.as_slice())
                                .collect();

                            render_ctx.render(data, &clips_refs, &pool_guard);
                        } else {
                            data.fill(0.0);
                        }
                    } else if test_tone_enabled {
                        // Test tone fallback (no clips loaded)
                        for frame in data.chunks_exact_mut(channels) {
                            test_tone_current_freq +=
                                (test_tone_target_freq - test_tone_current_freq) * FREQ_SMOOTHING;

                            let phase_inc = test_tone_current_freq as f64 / sample_rate_f64;
                            let sample = (test_tone_phase * std::f64::consts::TAU).sin()
                                as f32
                                * TEST_TONE_AMPLITUDE;

                            for ch in frame.iter_mut() {
                                *ch = sample;
                            }

                            test_tone_phase += phase_inc;
                            if test_tone_phase >= 1.0 {
                                test_tone_phase -= 1.0;
                            }
                        }
                    } else {
                        // No clips, no test tone → silence
                        data.fill(0.0);
                    }

                    // ── B2. MIDI → Sampler render pass ───────────────
                    // Sync loaded samples from SharedSamplerSamples
                    let samples_snapshot = sampler_samples.load();
                    for (idx, sample_opt) in samples_snapshot.iter().enumerate() {
                        if idx < sampler_engines.len() {
                            // Only update if the sample reference changed
                            let engine = &mut sampler_engines[idx];
                            match (sample_opt, &engine.sample) {
                                (Some(new_sample), Some(existing)) => {
                                    if !Arc::ptr_eq(new_sample, existing) {
                                        engine.sample = Some(Arc::clone(new_sample));
                                    }
                                }
                                (Some(new_sample), None) => {
                                    engine.sample = Some(Arc::clone(new_sample));
                                }
                                (None, Some(_)) => {
                                    engine.sample = None;
                                    engine.all_notes_off();
                                }
                                (None, None) => {}
                            }
                        }
                    }

                    // Load MIDI snapshot and schedule notes
                    let midi_snap = midi_snapshot.load();
                    let playhead_pos = render_ctx.playhead.position();

                    for (track_idx, midi_clips) in midi_snap.iter().enumerate() {
                        if track_idx >= sampler_engines.len() || midi_clips.is_empty() {
                            continue;
                        }

                        let engine = &mut sampler_engines[track_idx];
                        if engine.sample.is_none() {
                            continue; // no sample loaded — skip
                        }

                        // Schedule active notes for this buffer
                        let events = MidiScheduler::find_active(midi_clips, playhead_pos, frame_count);

                        // Process note-on/off events
                        for event in &events {
                            if event.is_note_on {
                                engine.note_on(event.pitch, event.velocity);
                            }
                            if event.is_note_off {
                                engine.note_off(event.pitch);
                            }
                        }

                        // Render sampler output if any voices active
                        if engine.has_active_voices() {
                            let fc = frame_count.min(sampler_left.len());
                            sampler_left[..fc].fill(0.0);
                            sampler_right[..fc].fill(0.0);

                            engine.render(
                                &mut sampler_left[..fc],
                                &mut sampler_right[..fc],
                                fc,
                            );

                            // Mix sampler output into interleaved data
                            for i in 0..fc {
                                let base = i * channels;
                                if base + 1 < data.len() {
                                    data[base] += sampler_left[i];
                                    data[base + 1] += sampler_right[i];
                                }
                            }
                        }
                    }
                }

                // ── C. Mix preview audio (browser audition) ─────
                // Preview plays regardless of transport state
                if let Ok(buf_guard) = preview_buffer.try_lock() {
                    if let Some(ref preview_data) = *buf_guard {
                        let cursor = preview_cursor.load(Ordering::Relaxed);
                        let total = preview_data.len();
                        if cursor < total {
                            let end = (cursor + frame_count * channels).min(total);
                            for i in cursor..end {
                                if i - cursor < data.len() {
                                    data[i - cursor] += preview_data[i];
                                }
                            }
                            preview_cursor.store(end, Ordering::Relaxed);
                        }
                    }
                }

                // ── D. Advance master clock ─────────────────────
                if is_playing {
                    clock.advance(frame_count as i64);

                    // Handle loop wrap on master clock
                    if let Some(ref region) = render_ctx.loop_region {
                        let pos = clock.position();
                        if pos >= region.end {
                            let overshoot = pos - region.end;
                            let loop_len = region.end - region.start;
                            let new_pos = region.start + (overshoot % loop_len);
                            clock.reset();
                            clock.advance(new_pos);
                        }
                    }
                }
            },
            move |err| {
                error!("Audio stream error: {}", err);
            },
            None,
        )
        .map_err(|e| AudioDriverError::BuildStreamError(e.to_string()))?;

    // ── 6. Start ────────────────────────────────────────────────────
    stream
        .play()
        .map_err(|e| AudioDriverError::PlayStreamError(e.to_string()))?;

    info!(
        "🔊 Audio stream started ({}Hz, {}ch, {:?})",
        sample_rate, channels, sample_format
    );

    Ok(AudioStreamHandle { _stream: stream })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_are_valid() {
        assert!((DEFAULT_FREQUENCY - 440.0).abs() < f32::EPSILON);
        assert!(TEST_TONE_AMPLITUDE > 0.0 && TEST_TONE_AMPLITUDE <= 1.0);
        assert!(FREQ_SMOOTHING > 0.0 && FREQ_SMOOTHING < 1.0);
    }

    #[test]
    fn shared_clip_snapshot_swap_and_load() {
        let snapshot = SharedClipSnapshot::new();
        assert!(snapshot.load().is_empty());

        let clips = vec![vec![AudioClip::new(
            "Test",
            "test.wav",
            dream_models::time::AbsoluteTime::ZERO,
            dream_models::time::AbsoluteTime::new(44100),
        )]];
        snapshot.swap(clips);

        let loaded = snapshot.load();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].len(), 1);
        assert_eq!(loaded[0][0].name, "Test");
    }
}
