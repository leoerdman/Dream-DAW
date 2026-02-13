// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Audio Driver (cpal 0.17 Backend)
// ═══════════════════════════════════════════════════════════════════════════
//
// Initializes the platform audio subsystem and runs the real-time callback.
// The callback is THE HOT PATH. Every CPU cycle matters.
//
// ═══════════════════════════════════════════════════════════════════════════

use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use log::{error, info};

use dream_ipc::{EngineCommand, MasterClock};

// ── Constants ───────────────────────────────────────────────────────────

/// Default test tone frequency (A4 = 440 Hz).
const DEFAULT_FREQUENCY: f32 = 440.0;

/// Output amplitude (0.0 – 1.0). Conservative to protect ears/speakers.
const AMPLITUDE: f32 = 0.25;

/// Exponential smoothing coefficient for frequency transitions.
/// 0.001 at 48kHz ≈ ~7ms transition time — smooth and click-free.
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
///
/// # Returns
/// `AudioStreamHandle` — keep alive for audio to continue. Drop to stop.
pub fn start_audio_thread(
    mut consumer: rtrb::Consumer<EngineCommand>,
    clock: Arc<MasterClock>,
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
        "Stream config: {}Hz, {}ch, {:?}",
        sample_rate, channels, sample_format
    );

    // ── 3. Build Output Stream ──────────────────────────────────────
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
                while let Ok(cmd) = consumer.pop() {
                    match cmd {
                        EngineCommand::SetPlay(play) => {
                            is_playing = play;
                            if !play {
                                phase = 0.0;
                            }
                        }
                        EngineCommand::SetFreq(freq) => {
                            target_freq = freq.clamp(20.0, 20_000.0);
                        }
                    }
                }

                // ── B. Advance master clock ─────────────────────
                let frame_count = data.len() / channels;
                clock.advance(frame_count as i64);

                // ── C. Generate audio ───────────────────────────
                if is_playing {
                    for frame in data.chunks_exact_mut(channels) {
                        // Per-sample exponential frequency smoothing
                        current_freq += (target_freq - current_freq) * FREQ_SMOOTHING;

                        let phase_increment = current_freq as f64 / sample_rate_f64;
                        let sample =
                            (phase * std::f64::consts::TAU).sin() as f32 * AMPLITUDE;

                        for channel_sample in frame.iter_mut() {
                            *channel_sample = sample;
                        }

                        phase += phase_increment;
                        if phase >= 1.0 {
                            phase -= 1.0;
                        }
                    }
                } else {
                    for sample in data.iter_mut() {
                        *sample = 0.0;
                    }
                }
            },
            move |err| {
                error!("Audio stream error: {}", err);
            },
            None,
        )
        .map_err(|e| AudioDriverError::BuildStreamError(e.to_string()))?;

    // ── 4. Start ────────────────────────────────────────────────────
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
        assert!(AMPLITUDE > 0.0 && AMPLITUDE <= 1.0);
        assert!(FREQ_SMOOTHING > 0.0 && FREQ_SMOOTHING < 1.0);
    }
}
