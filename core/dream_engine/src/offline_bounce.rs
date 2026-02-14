// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Offline Bounce (Mix Export Engine)
// ═══════════════════════════════════════════════════════════════════════════
//
// THE PROBLEM:
//   A DAW without mix export is just a player. Users need to bounce
//   their project to a WAV file for distribution, mastering, or archival.
//
// THE SOLUTION: OfflineBouncer
//   Decoupled from cpal's real-time clock, this engine runs the same
//   RenderContext at maximum CPU speed. Instead of feeding samples to
//   a sound card, it writes them to a WAV file via `hound`.
//
// KEY DIFFERENCES FROM REAL-TIME:
//   - No cpal stream — we drive the render loop ourselves.
//   - No time pressure — we can use larger buffers (4096 frames).
//   - Synchronous I/O — disk reads happen inline (no streaming windows).
//   - Progress reporting — via callback, not metering atomics.
//
// ARCHITECTURE:
//   1. Create a standalone RenderContext (not shared with audio thread).
//   2. Load all clips into ClipPool (synchronous, full decode).
//   3. Loop: render buffer → accumulate into output Vec.
//   4. Write accumulated audio to WAV via WavWriter.
//
// ═══════════════════════════════════════════════════════════════════════════

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use log::info;

use dream_clip_engine::pool::ClipPool;
use dream_clip_engine::scheduler::LoopRegion as ClipLoopRegion;
use dream_io::wav_writer::WavWriter;
use dream_ipc::metering::MeterBank;
use dream_models::project::{AudioClip, Project};

use crate::render_callback::RenderContext;

// ── Constants ──────────────────────────────────────────────────────────

/// Buffer size for offline rendering (larger = fewer loop iterations).
/// Not constrained by real-time deadlines, so we can use big buffers.
const OFFLINE_BUFFER_FRAMES: usize = 4096;

/// Maximum output channels (stereo).
const OFFLINE_CHANNELS: usize = 2;

// ── Bounce Configuration ────────────────────────────────────────────────

/// Configuration for an offline bounce operation.
#[derive(Debug, Clone)]
pub struct BounceConfig {
    /// Output file path (e.g., "/Users/user/Desktop/my_mix.wav").
    pub output_path: String,

    /// Sample rate for the output file (Hz).
    pub sample_rate: u32,

    /// Bit depth: 16, 24, or 32 (float).
    pub bit_depth: u16,

    /// Start frame of the bounce region (0 = project start).
    pub start_frame: i64,

    /// End frame of the bounce region (total project length).
    pub end_frame: i64,

    /// Whether to normalize the output to 0 dBFS.
    pub normalize: bool,

    /// Whether to apply a tail (extra silence at end for reverb tails).
    /// Value in frames.
    pub tail_frames: i64,
}

impl BounceConfig {
    /// Total frames to render (including tail).
    pub fn total_frames(&self) -> i64 {
        (self.end_frame - self.start_frame) + self.tail_frames
    }
}

// ── Bounce Error ───────────────────────────────────────────────────────

/// Errors during the bounce process.
#[derive(Debug)]
pub enum BounceError {
    /// Invalid configuration (e.g., end < start).
    InvalidConfig(String),

    /// WAV write failure.
    WriteError(String),

    /// Render failure.
    RenderError(String),
}

impl std::fmt::Display for BounceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfig(e) => write!(f, "Invalid bounce config: {e}"),
            Self::WriteError(e) => write!(f, "WAV write error: {e}"),
            Self::RenderError(e) => write!(f, "Render error: {e}"),
        }
    }
}

impl std::error::Error for BounceError {}

// ── Offline Bouncer ─────────────────────────────────────────────────────

/// The offline bounce engine.
///
/// Runs the entire render pipeline at maximum CPU speed (not tied to
/// the cpal audio callback) and writes the result to a WAV file.
///
/// # Usage
/// ```ignore
/// let bouncer = OfflineBouncer::new(config);
/// bouncer.bounce(&project, &clip_pool, |progress| {
///     println!("Bounce progress: {:.0}%", progress * 100.0);
/// })?;
/// ```
pub struct OfflineBouncer {
    config: BounceConfig,
    /// Cancellation flag - set to true to abort the bounce.
    /// The bouncer checks this flag during each render iteration.
    pub cancel_flag: Arc<AtomicBool>,
}

impl OfflineBouncer {
    /// Creates a new bouncer with the given configuration.
    pub fn new(config: BounceConfig) -> Self {
        Self {
            config,
            cancel_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Returns a clone of the cancel flag.
    /// Set to `true` from another thread to abort the bounce.
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel_flag)
    }

    /// Resets the cancel flag to false.
    pub fn reset_cancel(&self) {
        self.cancel_flag.store(false, Ordering::SeqCst);
    }

    /// Executes the offline bounce.
    ///
    /// This is a **blocking** operation — call from a background thread
    /// (e.g., `tokio::task::spawn_blocking` or `std::thread::spawn`).
    ///
    /// # Arguments
    /// - `project`: The project to bounce (provides track/clip data).
    /// - `clip_pool`: Pre-loaded audio data for all clips.
    /// - `loop_region`: Optional loop region for the bounce.
    /// - `progress_callback`: Called with progress 0.0–1.0.
    ///
    /// # Returns
    /// `Ok(())` on success. The WAV file is written to `config.output_path`.
    pub fn bounce<F>(
        &self,
        project: &Project,
        clip_pool: &ClipPool,
        loop_region: Option<&ClipLoopRegion>,
        mut progress_callback: F,
    ) -> Result<(), BounceError>
    where
        F: FnMut(f32),
    {
        // ── Validate config ──────────────────────────────────────
        if self.config.end_frame <= self.config.start_frame {
            return Err(BounceError::InvalidConfig(
                "end_frame must be greater than start_frame".to_string(),
            ));
        }

        if self.config.bit_depth != 16 && self.config.bit_depth != 24 && self.config.bit_depth != 32
        {
            return Err(BounceError::InvalidConfig(format!(
                "Unsupported bit depth: {} (use 16, 24, or 32)",
                self.config.bit_depth
            )));
        }

        let total_frames = self.config.total_frames() as usize;
        let sample_rate = self.config.sample_rate as f64;

        info!(
            "[Bounce] Starting: {} frames @ {}Hz, {}-bit, output={}",
            total_frames, self.config.sample_rate, self.config.bit_depth, self.config.output_path
        );

        // ── Create standalone RenderContext ──────────────────────
        // This is completely independent from the audio thread's context.
        let meter_bank = Arc::new(MeterBank::new(project.tracks.len().max(1)));
        let mut render_ctx = RenderContext::new(
            project.tracks.len().max(1),
            sample_rate,
            OFFLINE_CHANNELS,
            meter_bank,
        );

        // Set loop region if provided
        render_ctx.loop_region = loop_region.cloned();

        // Seek to start position
        render_ctx.playhead.seek(self.config.start_frame);
        render_ctx.playhead.set_advancing(true);

        // ── Prepare per-track clip slices ────────────────────────
        // Build the same structure that driver.rs uses for RenderContext::render().
        let clips_per_track: Vec<Vec<AudioClip>> = project
            .tracks
            .iter()
            .map(|track| track.clips.clone())
            .collect();

        // ── Pre-allocate output buffers ──────────────────────────
        let mut output_left: Vec<f32> = Vec::with_capacity(total_frames);
        let mut output_right: Vec<f32> = Vec::with_capacity(total_frames);

        // Scratch buffer for interleaved render output
        let buf_size = OFFLINE_BUFFER_FRAMES * OFFLINE_CHANNELS;
        let mut interleaved_buf = vec![0.0f32; buf_size];

        // ── Render loop ─────────────────────────────────────────
        let mut frames_rendered: usize = 0;
        let mut last_progress: f32 = -1.0;

        while frames_rendered < total_frames {
            // Check cancellation flag
            if self.cancel_flag.load(Ordering::SeqCst) {
                info!(
                    "[Bounce] Cancelled by user at {:.1}%",
                    (frames_rendered as f32 / total_frames as f32) * 100.0
                );
                // Clean up partial file
                let _ = std::fs::remove_file(&self.config.output_path);
                return Err(BounceError::RenderError(
                    "Bounce cancelled by user".to_string(),
                ));
            }

            let remaining = total_frames - frames_rendered;
            let chunk_frames = remaining.min(OFFLINE_BUFFER_FRAMES);
            let chunk_samples = chunk_frames * OFFLINE_CHANNELS;

            // Clear the interleaved buffer
            interleaved_buf[..chunk_samples].fill(0.0);

            // Render one buffer through the full pipeline
            render_ctx.render(
                &mut interleaved_buf[..chunk_samples],
                &clips_per_track,
                clip_pool,
            );

            // De-interleave: [L, R, L, R, ...] → separate L/R channels
            for i in 0..chunk_frames {
                let base = i * OFFLINE_CHANNELS;
                output_left.push(interleaved_buf[base]);
                output_right.push(if base + 1 < chunk_samples {
                    interleaved_buf[base + 1]
                } else {
                    0.0
                });
            }

            frames_rendered += chunk_frames;

            // Report progress (throttled to avoid excessive callbacks)
            let progress = frames_rendered as f32 / total_frames as f32;
            if progress - last_progress >= 0.01 {
                progress_callback(progress.min(1.0));
                last_progress = progress;
            }
        }

        // ── Normalize if requested ──────────────────────────────
        if self.config.normalize {
            let peak = output_left
                .iter()
                .chain(output_right.iter())
                .map(|s| s.abs())
                .fold(0.0f32, f32::max);

            if peak > 0.0 && peak != 1.0 {
                let gain = 1.0 / peak;
                info!(
                    "[Bounce] Normalizing: peak={:.4}, gain={:.4}dB",
                    peak,
                    20.0 * gain.log10()
                );
                for s in output_left.iter_mut() {
                    *s *= gain;
                }
                for s in output_right.iter_mut() {
                    *s *= gain;
                }
            }
        }

        // ── Write WAV file ──────────────────────────────────────
        info!(
            "[Bounce] Writing WAV: {} frames, {}-bit, {}",
            output_left.len(),
            self.config.bit_depth,
            self.config.output_path
        );

        WavWriter::write_channels(
            &self.config.output_path,
            &[&output_left, &output_right],
            self.config.sample_rate,
            self.config.bit_depth,
        )
        .map_err(|e| BounceError::WriteError(e.to_string()))?;

        // Final progress
        progress_callback(1.0);

        info!(
            "[Bounce] Complete: {} ({:.1}s @ {}Hz)",
            self.config.output_path,
            output_left.len() as f64 / sample_rate,
            self.config.sample_rate
        );

        Ok(())
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use dream_models::project::{Project, Track, TrackType};

    fn make_test_project() -> Project {
        let mut project = Project::default();
        let mut track = Track::new("Test Track");
        track.track_type = TrackType::Audio;
        project.tracks.push(track);
        project
    }

    #[test]
    fn bounce_config_total_frames() {
        let config = BounceConfig {
            output_path: "/tmp/test.wav".to_string(),
            sample_rate: 44100,
            bit_depth: 32,
            start_frame: 0,
            end_frame: 44100,
            normalize: false,
            tail_frames: 4410,
        };
        assert_eq!(config.total_frames(), 48510);
    }

    #[test]
    fn bounce_rejects_invalid_range() {
        let config = BounceConfig {
            output_path: "/tmp/test.wav".to_string(),
            sample_rate: 44100,
            bit_depth: 32,
            start_frame: 100,
            end_frame: 50, // end < start
            normalize: false,
            tail_frames: 0,
        };

        let bouncer = OfflineBouncer::new(config);
        let project = make_test_project();
        let pool = ClipPool::new();

        let result = bouncer.bounce(&project, &pool, None, |_| {});
        assert!(matches!(result, Err(BounceError::InvalidConfig(_))));
    }

    #[test]
    fn bounce_rejects_invalid_bit_depth() {
        let config = BounceConfig {
            output_path: "/tmp/test.wav".to_string(),
            sample_rate: 44100,
            bit_depth: 8, // unsupported
            start_frame: 0,
            end_frame: 1000,
            normalize: false,
            tail_frames: 0,
        };

        let bouncer = OfflineBouncer::new(config);
        let project = make_test_project();
        let pool = ClipPool::new();

        let result = bouncer.bounce(&project, &pool, None, |_| {});
        assert!(matches!(result, Err(BounceError::InvalidConfig(_))));
    }

    #[test]
    fn bounce_silence_produces_wav() {
        let out_path = std::env::temp_dir().join("dream_bounce_test.wav");
        let config = BounceConfig {
            output_path: out_path.to_str().unwrap().to_string(),
            sample_rate: 44100,
            bit_depth: 32,
            start_frame: 0,
            end_frame: 4096, // ~93ms
            normalize: false,
            tail_frames: 0,
        };

        let bouncer = OfflineBouncer::new(config);
        let project = make_test_project();
        let pool = ClipPool::new();

        let mut progress_values: Vec<f32> = Vec::new();
        let result = bouncer.bounce(&project, &pool, None, |p| {
            progress_values.push(p);
        });

        assert!(result.is_ok(), "Bounce failed: {:?}", result.err());
        assert!(out_path.exists(), "WAV file not created");

        // Progress should reach 1.0
        assert!(!progress_values.is_empty());
        assert!((progress_values.last().unwrap() - 1.0).abs() < 0.01);

        // Clean up
        let _ = std::fs::remove_file(&out_path);
    }

    #[test]
    fn bounce_with_normalization() {
        let out_path = std::env::temp_dir().join("dream_bounce_norm_test.wav");
        let config = BounceConfig {
            output_path: out_path.to_str().unwrap().to_string(),
            sample_rate: 44100,
            bit_depth: 24,
            start_frame: 0,
            end_frame: 2048,
            normalize: true,
            tail_frames: 0,
        };

        let bouncer = OfflineBouncer::new(config);
        let project = make_test_project();
        let pool = ClipPool::new();

        let result = bouncer.bounce(&project, &pool, None, |_| {});
        assert!(result.is_ok());

        let _ = std::fs::remove_file(&out_path);
    }
}
