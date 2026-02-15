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

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use log::info;

use dream_clip_engine::pool::ClipPool;
use dream_clip_engine::scheduler::LoopRegion as ClipLoopRegion;
use dream_io::mp3_writer::Mp3Writer;
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

    /// Bit depth: 16, 24, or 32 (float). Ignored for MP3.
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

    /// Output format: "wav" or "mp3". Defaults to "wav" if unset.
    pub format: String,
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

    fn create_render_ctx(
        &self,
        project: &Project,
        loop_region: Option<&ClipLoopRegion>,
        sample_rate: f64,
    ) -> RenderContext {
        let meter_bank = Arc::new(MeterBank::new(project.tracks.len().max(1)));
        let mut render_ctx = RenderContext::new(
            project.tracks.len().max(1),
            sample_rate,
            OFFLINE_CHANNELS,
            meter_bank,
        );
        render_ctx.loop_region = loop_region.cloned();
        render_ctx.playhead.seek(self.config.start_frame);
        render_ctx.playhead.set_advancing(true);
        render_ctx
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

        // ── Prepare per-track clip slices ────────────────────────
        // Build the same structure that driver.rs uses for RenderContext::render().
        let clips_per_track: Vec<Vec<AudioClip>> = project
            .tracks
            .iter()
            .map(|track| track.clips.clone())
            .collect();
        let is_mp3 = self.config.format.eq_ignore_ascii_case("mp3");

        if is_mp3 {
            // MP3 path: streaming encode to avoid full-render RAM growth.
            let mut render_ctx = self.create_render_ctx(project, loop_region, sample_rate);

            let mut interleaved_buf = vec![0.0f32; OFFLINE_BUFFER_FRAMES * OFFLINE_CHANNELS];
            let mut frames_rendered = 0usize;
            let mut last_progress = -1.0f32;

            let gain = if self.config.normalize {
                let mut peak = 0.0f32;
                while frames_rendered < total_frames {
                    if self.cancel_flag.load(Ordering::SeqCst) {
                        let _ = std::fs::remove_file(&self.config.output_path);
                        return Err(BounceError::RenderError(
                            "Bounce cancelled by user".to_string(),
                        ));
                    }

                    let remaining = total_frames - frames_rendered;
                    let chunk_frames = remaining.min(OFFLINE_BUFFER_FRAMES);
                    let chunk_samples = chunk_frames * OFFLINE_CHANNELS;
                    interleaved_buf[..chunk_samples].fill(0.0);

                    render_ctx.render(
                        &mut interleaved_buf[..chunk_samples],
                        &clips_per_track,
                        clip_pool,
                    );

                    for &s in &interleaved_buf[..chunk_samples] {
                        peak = peak.max(s.abs());
                    }

                    frames_rendered += chunk_frames;
                    let progress = 0.5 * (frames_rendered as f32 / total_frames as f32);
                    if progress - last_progress >= 0.01 {
                        progress_callback(progress.min(1.0));
                        last_progress = progress;
                    }
                }

                if peak > 0.0 && peak != 1.0 {
                    let g = 1.0 / peak;
                    info!(
                        "[Bounce] Normalizing MP3 path: peak={:.4}, gain={:.4}dB",
                        peak,
                        20.0 * g.log10()
                    );
                    g
                } else {
                    1.0
                }
            } else {
                1.0
            };

            // Recreate render context for encode pass when normalization scanned first.
            let mut render_ctx = self.create_render_ctx(project, loop_region, sample_rate);
            frames_rendered = 0;
            last_progress = -1.0;
            let mut mp3_writer =
                Mp3Writer::create_streaming(&self.config.output_path, self.config.sample_rate)
                    .map_err(|e| BounceError::WriteError(e.to_string()))?;

            while frames_rendered < total_frames {
                if self.cancel_flag.load(Ordering::SeqCst) {
                    let _ = std::fs::remove_file(&self.config.output_path);
                    return Err(BounceError::RenderError(
                        "Bounce cancelled by user".to_string(),
                    ));
                }

                let remaining = total_frames - frames_rendered;
                let chunk_frames = remaining.min(OFFLINE_BUFFER_FRAMES);
                let chunk_samples = chunk_frames * OFFLINE_CHANNELS;
                interleaved_buf[..chunk_samples].fill(0.0);

                render_ctx.render(
                    &mut interleaved_buf[..chunk_samples],
                    &clips_per_track,
                    clip_pool,
                );

                let mut left = Vec::with_capacity(chunk_frames);
                let mut right = Vec::with_capacity(chunk_frames);
                for i in 0..chunk_frames {
                    let base = i * OFFLINE_CHANNELS;
                    let l = interleaved_buf[base] * gain;
                    let r = interleaved_buf[base + 1] * gain;
                    left.push(l);
                    right.push(r);
                }

                mp3_writer
                    .write_chunk(&left, &right)
                    .map_err(|e| BounceError::WriteError(e.to_string()))?;

                frames_rendered += chunk_frames;
                let progress = if self.config.normalize {
                    0.5 + 0.5 * (frames_rendered as f32 / total_frames as f32)
                } else {
                    frames_rendered as f32 / total_frames as f32
                };
                if progress - last_progress >= 0.01 {
                    progress_callback(progress.min(1.0));
                    last_progress = progress;
                }
            }

            mp3_writer
                .finalize()
                .map_err(|e| BounceError::WriteError(e.to_string()))?;
        } else {
            info!(
                "[Bounce] Writing WAV (streaming): {}-bit, {}",
                self.config.bit_depth, self.config.output_path
            );

            let mut interleaved_buf = vec![0.0f32; OFFLINE_BUFFER_FRAMES * OFFLINE_CHANNELS];

            let gain = if self.config.normalize {
                // Pass 1: peak scan.
                let mut render_ctx = self.create_render_ctx(project, loop_region, sample_rate);
                let mut frames_rendered = 0usize;
                let mut peak = 0.0f32;
                let mut last_progress = -1.0f32;

                while frames_rendered < total_frames {
                    if self.cancel_flag.load(Ordering::SeqCst) {
                        let _ = std::fs::remove_file(&self.config.output_path);
                        return Err(BounceError::RenderError(
                            "Bounce cancelled by user".to_string(),
                        ));
                    }
                    let remaining = total_frames - frames_rendered;
                    let chunk_frames = remaining.min(OFFLINE_BUFFER_FRAMES);
                    let chunk_samples = chunk_frames * OFFLINE_CHANNELS;
                    interleaved_buf[..chunk_samples].fill(0.0);

                    render_ctx.render(
                        &mut interleaved_buf[..chunk_samples],
                        &clips_per_track,
                        clip_pool,
                    );
                    for &s in &interleaved_buf[..chunk_samples] {
                        peak = peak.max(s.abs());
                    }

                    frames_rendered += chunk_frames;
                    let progress = 0.5 * (frames_rendered as f32 / total_frames as f32);
                    if progress - last_progress >= 0.01 {
                        progress_callback(progress.min(1.0));
                        last_progress = progress;
                    }
                }

                if peak > 0.0 && peak != 1.0 {
                    let g = 1.0 / peak;
                    info!(
                        "[Bounce] Normalizing WAV path: peak={:.4}, gain={:.4}dB",
                        peak,
                        20.0 * g.log10()
                    );
                    g
                } else {
                    1.0
                }
            } else {
                1.0
            };

            // Pass 2 (or only pass when normalize=false): render + stream-write.
            let mut render_ctx = self.create_render_ctx(project, loop_region, sample_rate);
            let mut writer = WavWriter::create_streaming(
                &self.config.output_path,
                self.config.sample_rate,
                OFFLINE_CHANNELS as u16,
                self.config.bit_depth,
            )
            .map_err(|e| BounceError::WriteError(e.to_string()))?;

            let mut frames_rendered = 0usize;
            let mut last_progress = -1.0f32;
            while frames_rendered < total_frames {
                if self.cancel_flag.load(Ordering::SeqCst) {
                    let _ = std::fs::remove_file(&self.config.output_path);
                    return Err(BounceError::RenderError(
                        "Bounce cancelled by user".to_string(),
                    ));
                }

                let remaining = total_frames - frames_rendered;
                let chunk_frames = remaining.min(OFFLINE_BUFFER_FRAMES);
                let chunk_samples = chunk_frames * OFFLINE_CHANNELS;
                interleaved_buf[..chunk_samples].fill(0.0);

                render_ctx.render(
                    &mut interleaved_buf[..chunk_samples],
                    &clips_per_track,
                    clip_pool,
                );

                if gain != 1.0 {
                    for s in &mut interleaved_buf[..chunk_samples] {
                        *s *= gain;
                    }
                }

                writer
                    .write_interleaved_chunk(&interleaved_buf[..chunk_samples])
                    .map_err(|e| BounceError::WriteError(e.to_string()))?;

                frames_rendered += chunk_frames;
                let progress = if self.config.normalize {
                    0.5 + 0.5 * (frames_rendered as f32 / total_frames as f32)
                } else {
                    frames_rendered as f32 / total_frames as f32
                };
                if progress - last_progress >= 0.01 {
                    progress_callback(progress.min(1.0));
                    last_progress = progress;
                }
            }

            writer
                .finalize()
                .map_err(|e| BounceError::WriteError(e.to_string()))?;
        }

        // Final progress
        progress_callback(1.0);

        info!(
            "[Bounce] Complete: {} [{}] ({:.1}s @ {}Hz)",
            self.config.output_path,
            self.config.format,
            total_frames as f64 / sample_rate,
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
            format: "wav".to_string(),
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
            format: "wav".to_string(),
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
            format: "wav".to_string(),
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
            format: "wav".to_string(),
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
            format: "wav".to_string(),
        };

        let bouncer = OfflineBouncer::new(config);
        let project = make_test_project();
        let pool = ClipPool::new();

        let result = bouncer.bounce(&project, &pool, None, |_| {});
        assert!(result.is_ok());

        let _ = std::fs::remove_file(&out_path);
    }
}
