// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Audio Driver (cpal 0.17 Backend)
// ═══════════════════════════════════════════════════════════════════════════
//
// This module initializes the platform audio subsystem via `cpal` and runs
// the real-time audio callback. The callback is THE HOT PATH — every CPU
// cycle matters here. The rules are absolute:
//
//   ❌ NO heap allocations (no String, no Vec::new(), no Box::new())
//   ❌ NO mutex locks (no Mutex, no RwLock, no condvar)
//   ❌ NO I/O (no println!, no file access, no network)
//   ❌ NO panics (no unwrap(), no expect(), no array bounds violations)
//   ✅ Only: atomic reads, rtrb pops, f32 math, buffer writes
//
// ═══════════════════════════════════════════════════════════════════════════

use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use log::{error, info};

use crate::lock_free::{EngineCommand, MasterClock};

// ── Constants ───────────────────────────────────────────────────────────

/// Default test tone frequency (A4 = 440 Hz).
const DEFAULT_FREQUENCY: f32 = 440.0;

/// Output amplitude (0.0 – 1.0). Kept conservative to protect ears/speakers.
const AMPLITUDE: f32 = 0.25;

/// Exponential smoothing coefficient for frequency transitions.
/// Higher = faster transition, but too high = audible stepping.
/// 0.001 at 48kHz ≈ ~7ms transition time — smooth and click-free.
const FREQ_SMOOTHING: f32 = 0.001;

// ── Audio Stream Handle ─────────────────────────────────────────────────

/// Holds the live cpal stream. Dropping this stops audio output.
///
/// The stream runs on a dedicated OS-managed real-time priority thread.
/// We store it here to prevent it from being dropped prematurely.
pub struct AudioStreamHandle {
    _stream: cpal::Stream,
}

// ── Driver Result ───────────────────────────────────────────────────────

/// Errors that can occur during audio driver initialization (non-RT only).
#[derive(Debug)]
pub enum AudioDriverError {
    /// No audio output device found on this system.
    NoOutputDevice,
    /// Failed to query the device's default output configuration.
    DefaultConfigError(String),
    /// Failed to build the output stream.
    BuildStreamError(String),
    /// Failed to start (play) the stream.
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
/// This function:
/// 1. Selects the default output device via `cpal::default_host()`.
/// 2. Queries the device's default output config (guaranteed f32-compatible).
/// 3. Builds and starts the output stream with our lock-free callback.
///
/// Returns an `AudioStreamHandle` — keep it alive for audio to continue.
/// Dropping the handle gracefully stops the stream.
///
/// # Arguments
/// - `consumer`: The receiving end of the command ring buffer (moved into callback).
/// - `clock`: Shared master clock (audio callback is the sole writer).
///
/// # Errors
/// Returns `AudioDriverError` if no device is found or stream creation fails.
pub fn start_audio_thread(
    mut consumer: rtrb::Consumer<EngineCommand>,
    clock: Arc<MasterClock>,
) -> Result<AudioStreamHandle, AudioDriverError> {
    // ── 1. Host & Device Selection ──────────────────────────────────
    let host = cpal::default_host();
    info!("Audio host: {:?}", host.id());

    let device = host
        .default_output_device()
        .ok_or(AudioDriverError::NoOutputDevice)?;

    // Device name — best-effort, non-critical
    let device_name = device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| String::from("Unknown Device"));
    info!("Output device: {}", device_name);

    // ── 2. Config Selection ─────────────────────────────────────────
    // Use the device's default config. This is the safest path —
    // the OS knows what works best with the current hardware.
    let supported_config = device
        .default_output_config()
        .map_err(|e| AudioDriverError::DefaultConfigError(e.to_string()))?;

    let sample_format = supported_config.sample_format();
    let sample_rate = supported_config.sample_rate();
    let channels = supported_config.channels() as usize;

    // Convert SupportedStreamConfig → StreamConfig (drops format info)
    let config: cpal::StreamConfig = supported_config.into();

    info!(
        "Stream config: {}Hz, {} channels, {:?}",
        sample_rate, channels, sample_format
    );

    // ── 3. Build Output Stream ──────────────────────────────────────
    // All mutable state lives INSIDE the closure — no external locks.
    let mut phase: f64 = 0.0;
    let mut current_freq: f32 = DEFAULT_FREQUENCY;
    let mut target_freq: f32 = DEFAULT_FREQUENCY;
    let mut is_playing: bool = false;
    let sample_rate_f64 = sample_rate as f64;

    let stream = device
        .build_output_stream(
            &config,
            // ┌──────────────────────────────────────────────────────┐
            // │  THE HOT PATH — Real-Time Audio Callback             │
            // │  NO allocations. NO locks. NO I/O. NO panics.        │
            // └──────────────────────────────────────────────────────┘
            move |data: &mut [f32], _info: &cpal::OutputCallbackInfo| {
                // ── A. Drain command queue ───────────────────────
                // Process ALL pending commands before generating audio.
                // This ensures we respond to rapid UI interactions
                // within the same buffer cycle.
                while let Ok(cmd) = consumer.pop() {
                    match cmd {
                        EngineCommand::Play => {
                            is_playing = true;
                        }
                        EngineCommand::Stop => {
                            is_playing = false;
                            phase = 0.0;
                        }
                        EngineCommand::SetTestToneFrequency(freq) => {
                            // Clamp to audible range (20Hz – 20kHz).
                            // Don't set directly — let smoothing handle it.
                            target_freq = freq.clamp(20.0, 20_000.0);
                        }
                    }
                }

                // ── B. Advance master clock ─────────────────────
                // frame_count = total samples / channels
                let frame_count = data.len() / channels;
                clock.advance(frame_count as i64);

                // ── C. Generate audio ───────────────────────────
                if is_playing {
                    for frame in data.chunks_exact_mut(channels) {
                        // Exponential frequency smoothing (per-sample).
                        // Creates a smooth portamento between frequencies,
                        // eliminating the click that would occur from an
                        // instantaneous frequency jump mid-waveform.
                        current_freq += (target_freq - current_freq) * FREQ_SMOOTHING;

                        // Phase increment for current (smoothed) frequency.
                        let phase_increment = current_freq as f64 / sample_rate_f64;

                        // Generate sine sample
                        let sample =
                            (phase * std::f64::consts::TAU).sin() as f32 * AMPLITUDE;

                        // Write to all channels (mono → stereo duplication)
                        for channel_sample in frame.iter_mut() {
                            *channel_sample = sample;
                        }

                        // Advance phase, wrapping at 1.0 to prevent f64
                        // precision loss over extended playback sessions.
                        phase += phase_increment;
                        if phase >= 1.0 {
                            phase -= 1.0;
                        }
                    }
                } else {
                    // ── Silence ──────────────────────────────────
                    // Fill buffer with zeros. No fancy loop needed.
                    for sample in data.iter_mut() {
                        *sample = 0.0;
                    }
                }
            },
            // ── Error callback ──────────────────────────────────────
            move |err| {
                error!("Audio stream error: {}", err);
            },
            None, // No timeout — let cpal manage buffer timing
        )
        .map_err(|e| AudioDriverError::BuildStreamError(e.to_string()))?;

    // ── 4. Start the stream ─────────────────────────────────────────
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
    fn default_frequency_is_a4() {
        assert!((DEFAULT_FREQUENCY - 440.0).abs() < f32::EPSILON);
    }

    #[test]
    fn amplitude_is_safe() {
        assert!(AMPLITUDE > 0.0);
        assert!(AMPLITUDE <= 1.0);
    }

    #[test]
    fn freq_smoothing_is_in_valid_range() {
        assert!(FREQ_SMOOTHING > 0.0);
        assert!(FREQ_SMOOTHING < 1.0);
    }
}
