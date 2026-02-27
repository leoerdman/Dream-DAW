// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Live Input Recording (Microphone Capture)
// ═══════════════════════════════════════════════════════════════════════════
//
// THE PROBLEM:
//   A DAW needs to record audio from microphones and line-in sources.
//   Recording must be sample-accurate and synchronized with playback.
//
// THE SOLUTION:
//   Two-stage lock-free pipeline:
//     1. cpal input callback → rtrb ring buffer (zero-alloc hot path)
//     2. RecordingWorker thread → .tmp.wav file (background I/O)
//
// ARCHITECTURE:
//   ┌─────────────┐    ┌──────────────┐    ┌─────────────────┐
//   │ cpal input   │    │ rtrb ring    │    │ RecordingWorker  │
//   │ callback     │───▸│ (lock-free)  │───▸│ (background)     │
//   │ (RT-safe)    │    │ 64K samples  │    │ writes .tmp.wav  │
//   └─────────────┘    └──────────────┘    └─────────────────┘
//
// REAL-TIME SAFETY:
//   - Input callback: only `rtrb::Producer::push()` — lock-free, bounded
//   - All I/O happens on the worker thread
//   - Peak metering via AtomicU32 (f32 bit-cast)
//
// ═══════════════════════════════════════════════════════════════════════════

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::thread;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use log::{error, info, warn};

// ── Constants ──────────────────────────────────────────────────────────

/// Ring buffer capacity in samples.
/// At 48kHz stereo, 65536 samples ≈ 680ms of headroom.
/// This must be large enough to absorb OS scheduling jitter.
const RING_BUFFER_CAPACITY: usize = 65536;

/// Worker poll interval when ring buffer is empty.
const WORKER_POLL_MS: u64 = 5;

// ── Recording State ─────────────────────────────────────────────────────

/// Shared atomic flags between the input callback, worker, and controller.
#[derive(Debug)]
pub struct RecordingState {
    /// True while recording is active.
    pub is_recording: Arc<AtomicBool>,

    /// Peak level (left channel) — f32 bit-cast to u32 for atomics.
    pub peak_left: Arc<AtomicU32>,

    /// Peak level (right channel).
    pub peak_right: Arc<AtomicU32>,

    /// Total frames captured so far.
    pub frames_captured: Arc<std::sync::atomic::AtomicU64>,

    /// BUG-006 FIX: Total samples dropped due to ring buffer overflow.
    /// Non-zero value indicates audio gaps in the recording.
    pub samples_dropped: Arc<std::sync::atomic::AtomicU64>,
}

impl RecordingState {
    pub fn new() -> Self {
        Self {
            is_recording: Arc::new(AtomicBool::new(false)),
            peak_left: Arc::new(AtomicU32::new(0)),
            peak_right: Arc::new(AtomicU32::new(0)),
            frames_captured: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            samples_dropped: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    /// Stores a peak value atomically (f32 → u32 bit-cast).
    #[inline]
    pub fn store_peak(atom: &AtomicU32, value: f32) {
        atom.store(value.to_bits(), Ordering::Release);
    }

    /// Loads a peak value atomically (u32 → f32 bit-cast).
    #[inline]
    pub fn load_peak(atom: &AtomicU32) -> f32 {
        f32::from_bits(atom.load(Ordering::Acquire))
    }

    /// Returns the current peak levels (left, right).
    pub fn peaks(&self) -> (f32, f32) {
        (
            Self::load_peak(&self.peak_left),
            Self::load_peak(&self.peak_right),
        )
    }

    /// Returns total frames captured.
    pub fn total_frames(&self) -> u64 {
        self.frames_captured.load(Ordering::Relaxed)
    }

    /// BUG-006 FIX: Returns total samples dropped due to ring buffer overflow.
    pub fn total_dropped(&self) -> u64 {
        self.samples_dropped.load(Ordering::Relaxed)
    }
}

impl Default for RecordingState {
    fn default() -> Self {
        Self::new()
    }
}

// ── Recording Error ─────────────────────────────────────────────────────

/// Errors during recording operations.
#[derive(Debug)]
pub enum RecordingError {
    /// No input device found.
    NoInputDevice,

    /// Failed to query device configuration.
    ConfigError(String),

    /// Failed to build input stream.
    StreamError(String),

    /// I/O error writing WAV file.
    IoError(String),
}

impl std::fmt::Display for RecordingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoInputDevice => write!(f, "No audio input device found"),
            Self::ConfigError(e) => write!(f, "Input config error: {e}"),
            Self::StreamError(e) => write!(f, "Input stream error: {e}"),
            Self::IoError(e) => write!(f, "Recording I/O error: {e}"),
        }
    }
}

impl std::error::Error for RecordingError {}

// ── Recording Session ──────────────────────────────────────────────────

/// A live recording session.
///
/// Owns the cpal input stream, the ring buffer, and the background
/// worker thread that writes samples to disk.
///
/// # Lifecycle
/// 1. `RecordingSession::start()` — opens input device, starts capture.
/// 2. Samples flow: cpal callback → rtrb → worker → .tmp.wav
/// 3. `session.stop()` — stops capture, finalizes WAV, returns output path.
///
/// # Drop Safety
/// Dropping `RecordingSession` stops recording and cleans up resources.
pub struct RecordingSession {
    /// The live cpal input stream handle.
    _stream: cpal::Stream,

    /// Shared recording state (atomics for cross-thread communication).
    state: RecordingState,

    /// Handle to the background worker thread.
    worker_handle: Option<thread::JoinHandle<Result<PathBuf, RecordingError>>>,

    /// Temporary output file path (kept for diagnostics).
    _tmp_path: PathBuf,

    /// Final output file path (kept for diagnostics).
    _final_path: PathBuf,

    /// Sample rate of the input stream.
    sample_rate: u32,

    /// Number of input channels.
    channels: usize,

    /// Playhead position at recording start (for clip alignment).
    start_frame: i64,
}

impl RecordingSession {
    /// Starts a new recording session.
    ///
    /// Opens the default input device, creates a ring buffer, spawns
    /// the worker thread, and begins capturing audio.
    ///
    /// # Arguments
    /// - `output_dir`: Directory where the final WAV will be saved.
    /// - `file_name`: Base name for the output file (e.g., "recording_001").
    /// - `start_frame`: Current playhead position for clip alignment.
    ///
    /// # Returns
    /// A `RecordingSession` handle. Call `.stop()` to finalize.
    pub fn start(
        output_dir: &Path,
        file_name: &str,
        start_frame: i64,
    ) -> Result<Self, RecordingError> {
        // ── 1. Open input device ─────────────────────────────────
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or(RecordingError::NoInputDevice)?;

        // BUG-4 fix: cpal::Device exposes `.name()` → Result<String>.
        // Newer cpal versions deprecate it in favour of `.description()`,
        // but for compatibility we suppress the warning and use `.name()`.
        #[allow(deprecated)]
        let device_name = device.name().unwrap_or_else(|_| "Unknown".to_string());
        info!("[Recording] Input device: {}", device_name);

        let default_config = device
            .default_input_config()
            .map_err(|e| RecordingError::ConfigError(e.to_string()))?;

        let supported_config = if default_config.sample_format() == cpal::SampleFormat::F32 {
            default_config
        } else {
            let fallback = device
                .supported_input_configs()
                .ok()
                .and_then(|mut ranges| {
                    ranges.find_map(|range| {
                        if range.sample_format() != cpal::SampleFormat::F32 {
                            return None;
                        }
                        let desired_rate = default_config.sample_rate();
                        let clamped_rate =
                            desired_rate.clamp(range.min_sample_rate(), range.max_sample_rate());
                        Some(range.with_sample_rate(clamped_rate))
                    })
                });

            if let Some(cfg) = fallback {
                warn!(
                    "Default input sample format {:?} unsupported by recorder, using f32 fallback",
                    default_config.sample_format()
                );
                cfg
            } else {
                return Err(RecordingError::ConfigError(
                    "No f32 input stream config available for selected device".to_string(),
                ));
            }
        };

        let sample_rate = supported_config.sample_rate();
        let channels = supported_config.channels() as usize;
        // BUG-003 FIX: Guard against 0-channel device configuration.
        // `data.chunks(0)` panics with division by zero, and downstream
        // `total_samples_written / channels` also divides by zero.
        if channels == 0 {
            return Err(RecordingError::ConfigError(
                "Audio input device reported 0 channels".to_string(),
            ));
        }
        let config: cpal::StreamConfig = supported_config.into();

        info!("[Recording] Config: {}Hz, {}ch", sample_rate, channels);

        // ── 2. Create ring buffer ────────────────────────────────
        let (producer, consumer) = rtrb::RingBuffer::<f32>::new(RING_BUFFER_CAPACITY);

        // ── 3. Create shared state ───────────────────────────────
        let state = RecordingState::new();
        state.is_recording.store(true, Ordering::Release);

        // ── 4. Create file paths ─────────────────────────────────
        std::fs::create_dir_all(output_dir).map_err(|e| RecordingError::IoError(e.to_string()))?;

        let tmp_path = output_dir.join(format!("{file_name}.tmp.wav"));
        let final_path = output_dir.join(format!("{file_name}.wav"));

        // ── 5. Spawn worker thread ───────────────────────────────
        let worker_state = RecordingState {
            is_recording: Arc::clone(&state.is_recording),
            peak_left: Arc::clone(&state.peak_left),
            peak_right: Arc::clone(&state.peak_right),
            frames_captured: Arc::clone(&state.frames_captured),
            samples_dropped: Arc::clone(&state.samples_dropped),
        };

        let worker_tmp_path = tmp_path.clone();
        let worker_final_path = final_path.clone();
        let worker_sample_rate = sample_rate;
        let worker_channels = channels;

        let worker_handle = thread::Builder::new()
            .name("dream-recording-worker".to_string())
            .spawn(move || {
                recording_worker(
                    consumer,
                    worker_state,
                    worker_tmp_path,
                    worker_final_path,
                    worker_sample_rate,
                    worker_channels,
                )
            })
            .map_err(|e| RecordingError::StreamError(format!("Failed to spawn worker: {e}")))?;

        // ── 6. Build input stream ────────────────────────────────
        let is_rec = Arc::clone(&state.is_recording);
        let peak_l = Arc::clone(&state.peak_left);
        let peak_r = Arc::clone(&state.peak_right);
        let dropped_counter = Arc::clone(&state.samples_dropped);
        let mut producer = producer;

        let stream = device
            .build_input_stream(
                &config,
                move |data: &[f32], _info: &cpal::InputCallbackInfo| {
                    // ── RT-SAFE HOT PATH ──────────────────────
                    // Only lock-free ring buffer push — no alloc, no I/O.
                    if !is_rec.load(Ordering::Relaxed) {
                        return;
                    }

                    // Compute peaks for live metering
                    let mut max_l: f32 = 0.0;
                    let mut max_r: f32 = 0.0;

                    for chunk in data.chunks(channels) {
                        if let Some(&l) = chunk.first() {
                            max_l = max_l.max(l.abs());
                            if channels == 1 {
                                max_r = max_r.max(l.abs());
                            }
                        }
                        if channels > 1
                            && let Some(&r) = chunk.get(1)
                        {
                            max_r = max_r.max(r.abs());
                        }
                    }

                    RecordingState::store_peak(&peak_l, max_l);
                    RecordingState::store_peak(&peak_r, max_r);

                    // Push all samples into ring buffer
                    // BUG-006 FIX: Track dropped samples instead of silently ignoring
                    let mut drops = 0u64;
                    for &sample in data {
                        if producer.push(sample).is_err() {
                            drops += 1;
                        }
                    }
                    if drops > 0 {
                        dropped_counter.fetch_add(drops, Ordering::Relaxed);
                    }
                },
                move |err| {
                    error!("[Recording] Input stream error: {}", err);
                },
                None,
            )
            .map_err(|e| RecordingError::StreamError(e.to_string()))?;

        stream
            .play()
            .map_err(|e| RecordingError::StreamError(e.to_string()))?;

        info!("[Recording] Started capturing to {}", tmp_path.display());

        Ok(Self {
            _stream: stream,
            state,
            worker_handle: Some(worker_handle),
            _tmp_path: tmp_path,
            _final_path: final_path,
            sample_rate,
            channels,
            start_frame,
        })
    }

    /// Stops recording and finalizes the WAV file.
    ///
    /// Returns the path to the finalized WAV file and metadata needed
    /// to create an `AudioClip`.
    pub fn stop(mut self) -> Result<RecordingResult, RecordingError> {
        // Signal the worker to stop
        self.state.is_recording.store(false, Ordering::Release);

        let total_frames = self.state.total_frames();

        // Wait for worker to flush and finalize
        if let Some(handle) = self.worker_handle.take() {
            match handle.join() {
                Ok(Ok(path)) => {
                    info!(
                        "[Recording] Finalized: {} ({} frames, {:.1}s)",
                        path.display(),
                        total_frames,
                        total_frames as f64 / self.sample_rate as f64
                    );
                    Ok(RecordingResult {
                        file_path: path,
                        sample_rate: self.sample_rate,
                        channels: self.channels as u16,
                        total_frames,
                        start_frame: self.start_frame,
                    })
                }
                Ok(Err(e)) => Err(e),
                Err(_) => Err(RecordingError::StreamError(
                    "Worker thread panicked".to_string(),
                )),
            }
        } else {
            Err(RecordingError::StreamError(
                "Worker already stopped".to_string(),
            ))
        }
    }

    /// Returns a reference to the shared recording state (for UI metering).
    pub fn state(&self) -> &RecordingState {
        &self.state
    }
}

// BUG-051 FIX: Ensure the worker thread is cleanly stopped on drop.
//
// If `stop()` was called, `worker_handle` is already `None` (taken via `.take()`),
// so `Drop` is a no-op. If `stop()` was never called (e.g., the caller panicked
// or forgot), this ensures the worker is signalled and joined, preventing:
//   - Orphaned background threads writing to disk indefinitely.
//   - Open file handles leaking.
//   - The cpal input stream (`_stream`) dropping without the worker flushing remaining data.
impl Drop for RecordingSession {
    fn drop(&mut self) {
        // Signal the worker to stop (idempotent — may already be false).
        self.state.is_recording.store(false, Ordering::Release);

        // Join the worker thread to ensure it flushes and finalizes.
        if let Some(handle) = self.worker_handle.take() {
            match handle.join() {
                Ok(Ok(path)) => {
                    log::info!(
                        "[Recording] Drop: Worker finalized safely at {}",
                        path.display()
                    );
                }
                Ok(Err(e)) => {
                    log::warn!("[Recording] Drop: Worker failed during cleanup: {e}");
                }
                Err(_) => {
                    log::error!("[Recording] Drop: Worker thread panicked during cleanup");
                }
            }
        }
    }
}

impl RecordingSession {
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

/// Result of a completed recording session.
#[derive(Debug, Clone)]
pub struct RecordingResult {
    /// Path to the finalized WAV file.
    pub file_path: PathBuf,

    /// Sample rate of the recording.
    pub sample_rate: u32,

    /// Number of channels.
    pub channels: u16,

    /// Total frames captured.
    pub total_frames: u64,

    /// Playhead frame where recording started (for clip alignment).
    pub start_frame: i64,
}

// ── Recording Worker (Background Thread) ──────────────────────────────

/// WAV header constants.
const WAV_HEADER_SIZE: u64 = 44;

/// Writes the 44-byte WAV header to the file at its current position.
///
/// `data_size` should be the total number of audio data bytes written so far.
/// This function can be called multiple times — it seeks to position 0 and
/// overwrites the header with the current sizes.
fn write_wav_header(
    file: &mut std::fs::File,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    data_size: u64,
) -> std::io::Result<()> {
    use std::io::{Seek, SeekFrom, Write};

    let block_align = channels * (bits_per_sample / 8);
    let byte_rate = sample_rate * block_align as u32;
    
    // BUG-006 FIX: Handle >4GB files. Standard WAV limits data chunk to 4GB.
    // Clamp to u32::MAX to avoid integer overflow which corrupts the file structure.
    let safe_data_size = data_size.min(0xFFFF_FFD0) as u32;
    let chunk_size = 36 + safe_data_size; // "RIFF" chunk size = 36 + data size

    file.seek(SeekFrom::Start(0))?;

    // RIFF header
    file.write_all(b"RIFF")?;
    file.write_all(&chunk_size.to_le_bytes())?;
    file.write_all(b"WAVE")?;

    // fmt sub-chunk
    file.write_all(b"fmt ")?;
    file.write_all(&16u32.to_le_bytes())?; // SubChunk1Size (16 for PCM/float)
    file.write_all(&3u16.to_le_bytes())?; // AudioFormat (3 = IEEE float)
    file.write_all(&channels.to_le_bytes())?; // NumChannels
    file.write_all(&sample_rate.to_le_bytes())?; // SampleRate
    file.write_all(&byte_rate.to_le_bytes())?; // ByteRate
    file.write_all(&block_align.to_le_bytes())?; // BlockAlign
    file.write_all(&bits_per_sample.to_le_bytes())?; // BitsPerSample

    // data sub-chunk
    file.write_all(b"data")?;
    file.write_all(&safe_data_size.to_le_bytes())?;

    Ok(())
}

/// Flush interval: rewrite WAV header every this many samples.
/// At 48kHz stereo, 96000 samples ≈ 1 second of audio.
const HEADER_FLUSH_INTERVAL: u64 = 96_000;

/// The background worker that drains the ring buffer and writes to WAV.
///
/// CRASH-SAFE: The WAV header is periodically updated with the current
/// data size. If the process crashes, the .tmp.wav file is always a valid
/// WAV with at most ~1 second of missing audio at the tail.
///
/// This runs on a dedicated thread — NOT on the audio thread.
fn recording_worker(
    mut consumer: rtrb::Consumer<f32>,
    state: RecordingState,
    tmp_path: PathBuf,
    final_path: PathBuf,
    sample_rate: u32,
    channels: usize,
) -> Result<PathBuf, RecordingError> {
    use std::io::{Seek, SeekFrom, Write};

    let ch = channels as u16;
    let bits_per_sample: u16 = 32; // IEEE float 32-bit

    // Create file and write initial WAV header with zero data size
    let mut file = std::fs::File::create(&tmp_path).map_err(|e| {
        RecordingError::IoError(format!("Failed to create {}: {e}", tmp_path.display()))
    })?;

    write_wav_header(&mut file, sample_rate, ch, bits_per_sample, 0)
        .map_err(|e| RecordingError::IoError(format!("Failed to write WAV header: {e}")))?;
    // BUG-046 FIX: Flush initial header to disk immediately.
    // Without this, a crash before the first HEADER_FLUSH_INTERVAL
    // leaves a file with no valid WAV header, making recovery impossible.
    file.sync_all()
        .map_err(|e| RecordingError::IoError(format!("Failed to sync WAV header: {e}")))?;

    info!(
        "[RecordingWorker] Writing to {} (crash-safe mode)",
        tmp_path.display()
    );

    // BUG-028 FIX: Warn if recording sample rate seems unusual.
    // Common project rates: 44100, 48000, 88200, 96000, 176400, 192000.
    const STANDARD_RATES: [u32; 6] = [44100, 48000, 88200, 96000, 176400, 192000];
    if !STANDARD_RATES.contains(&sample_rate) {
        log::warn!(
            "[RecordingWorker] Non-standard sample rate {} Hz detected. \
             Playback may sound wrong if project expects a different rate.",
            sample_rate
        );
    }

    let mut total_samples_written: u64 = 0;
    let mut samples_since_last_flush: u64 = 0;

    // BUG-002 FIX: Maximum samples we can write before hitting the 4GB
    // WAV data chunk limit.  WAV uses a u32 for data_size (bytes).
    // Each sample is 4 bytes (f32), so max_samples = u32::MAX / 4.
    let max_samples_before_4gb: u64 = (u32::MAX as u64) / 4;

    // ── Drain loop ──────────────────────────────────────────────
    loop {
        // BUG-006 FIX: Acquire ordering ensures this thread sees all writes
        // that happened-before the controller stored false (Release/SeqCst).
        let is_active = state.is_recording.load(Ordering::Acquire);
        let mut drained = 0usize;

        // Drain all available samples from ring buffer
        while let Ok(sample) = consumer.pop() {
            // BUG-002 FIX: Stop writing before exceeding 4GB WAV limit.
            // This prevents corrupted WAV files where the header declares
            // a smaller size than the actual data on disk.
            if total_samples_written + drained as u64 >= max_samples_before_4gb {
                log::warn!(
                    "[RecordingWorker] Reached 4GB WAV limit ({} samples). \
                     Stopping recording to prevent file corruption. \
                     Consider splitting into multiple files.",
                    total_samples_written + drained as u64
                );
                // Signal the recording to stop
                state.is_recording.store(false, Ordering::Release);
                break;
            }

            // Write f32 sample as raw little-endian bytes
            file.write_all(&sample.to_le_bytes())
                .map_err(|e| RecordingError::IoError(e.to_string()))?;
            drained += 1;
        }

        if drained > 0 {
            total_samples_written += drained as u64;
            samples_since_last_flush += drained as u64;

            let frames_written = total_samples_written / channels as u64;
            state
                .frames_captured
                .store(frames_written, Ordering::Relaxed);

            // ── CRASH-SAFE HEADER FLUSH ─────────────────────────
            // Every ~1 second of audio, rewrite the WAV header with
            // current data size. If the process crashes between flushes,
            // we lose at most ~1 second of audio instead of everything.
            if samples_since_last_flush >= HEADER_FLUSH_INTERVAL {
                let data_bytes = total_samples_written * 4; // 4 bytes per f32 sample
                let current_pos = WAV_HEADER_SIZE + data_bytes;

                // Seek to header, rewrite sizes, seek back to end
                write_wav_header(
                    &mut file,
                    sample_rate,
                    ch,
                    bits_per_sample,
                    // Cap at u32::MAX to prevent silent overflow corruption.
                    // WAV spec uses u32 for data chunk size (~4GB max).
                    data_bytes.min(u32::MAX as u64),
                )
                .map_err(|e| RecordingError::IoError(format!("Header flush failed: {e}")))?;

                // Seek back to end of data to continue writing
                file.seek(SeekFrom::Start(current_pos))
                    .map_err(|e| RecordingError::IoError(format!("Seek failed: {e}")))?;

                // Flush OS buffers to disk for maximum crash safety
                file.sync_data()
                    .map_err(|e| RecordingError::IoError(format!("Sync failed: {e}")))?;

                samples_since_last_flush = 0;
            }
        }

        // If recording stopped AND buffer is fully drained, exit
        if !is_active && drained == 0 {
            break;
        }

        // Don't busy-spin — sleep briefly when no data available
        if drained == 0 {
            thread::sleep(std::time::Duration::from_millis(WORKER_POLL_MS));
        }
    }

    // ── Finalize ────────────────────────────────────────────────
    // Write final header with exact data size
    let final_data_bytes = total_samples_written * 4;
    if final_data_bytes > u32::MAX as u64 {
        log::warn!(
            "[RecordingWorker] Recording data exceeds 4GB WAV limit ({} bytes). \
             Consider using a shorter recording or splitting files.",
            final_data_bytes
        );
    }
    write_wav_header(
        &mut file,
        sample_rate,
        ch,
        bits_per_sample,
        final_data_bytes.min(u32::MAX as u64),
    )
    .map_err(|e| RecordingError::IoError(format!("Final header write failed: {e}")))?;

    file.sync_all()
        .map_err(|e| RecordingError::IoError(format!("Final sync failed: {e}")))?;

    drop(file);

    info!(
        "[RecordingWorker] Finalized {} ({} frames, crash-safe)",
        tmp_path.display(),
        total_samples_written / channels as u64
    );

    // Rename .tmp.wav → .wav (atomic on most filesystems)
    std::fs::rename(&tmp_path, &final_path).map_err(|e| {
        RecordingError::IoError(format!(
            "Failed to rename {} → {}: {e}",
            tmp_path.display(),
            final_path.display()
        ))
    })?;

    Ok(final_path)
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_state_defaults() {
        let state = RecordingState::new();
        assert!(!state.is_recording.load(Ordering::Relaxed));
        assert_eq!(state.total_frames(), 0);

        let (pl, pr) = state.peaks();
        assert_eq!(pl, 0.0);
        assert_eq!(pr, 0.0);
    }

    #[test]
    fn peak_atomics_roundtrip() {
        let atom = AtomicU32::new(0);
        RecordingState::store_peak(&atom, 0.75);
        let loaded = RecordingState::load_peak(&atom);
        assert!((loaded - 0.75).abs() < f32::EPSILON);
    }

    #[test]
    fn peak_atomics_negative() {
        let atom = AtomicU32::new(0);
        RecordingState::store_peak(&atom, -0.5);
        let loaded = RecordingState::load_peak(&atom);
        assert!((loaded - (-0.5)).abs() < f32::EPSILON);
    }

    #[test]
    fn recording_worker_writes_wav() {
        let unique = format!(
            "dream_rec_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let dir = std::env::temp_dir().join(unique);
        let tmp_path = dir.join("test_rec.tmp.wav");
        let final_path = dir.join("test_rec.wav");
        let _ = std::fs::create_dir_all(&dir);

        // Create a ring buffer and push some test data
        let (mut producer, consumer) = rtrb::RingBuffer::<f32>::new(1024);

        // Push 100 stereo frames (200 samples)
        for i in 0..200 {
            let _ = producer.push((i as f32) / 200.0);
        }

        let state = RecordingState::new();
        // Don't set is_recording — worker will drain and exit immediately

        let result = recording_worker(
            consumer,
            state,
            tmp_path.clone(),
            final_path.clone(),
            44100,
            2, // stereo
        );

        assert!(result.is_ok());
        assert!(final_path.exists());

        // Verify the WAV file is valid
        let reader = hound::WavReader::open(&final_path)
            .expect("Test failed: WavReader could not open final_path");
        assert_eq!(reader.spec().sample_rate, 44100);
        assert_eq!(reader.spec().channels, 2);
        assert_eq!(reader.spec().bits_per_sample, 32);
        assert_eq!(reader.len(), 200); // 200 samples total

        // Clean up
        let _ = std::fs::remove_dir_all(&dir);
    }
}
