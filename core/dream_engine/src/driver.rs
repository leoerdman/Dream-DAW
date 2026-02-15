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

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use arc_swap::ArcSwap;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use dream_graph::{AudioDag, AudioNode, GraphBuilder, GraphRenderer, LiveGraph, NodeId, NodeKind};
use log::{error, info};

use dream_clip_engine::midi_scheduler::MidiScheduler;
use dream_clip_engine::pool::ClipAudio;
use dream_clip_engine::pool::ClipPool;
use dream_clip_engine::scheduler::LoopRegion;
use dream_ipc::metering::{compute_peak, compute_rms, linear_to_db, MeterBank};
use dream_ipc::{EngineCommand, MasterClock};
use dream_dsp::dsp_processor::BuiltinEffectType;
use dream_models::midi::MidiClip;
use dream_models::project::AudioClip;

use crate::render_callback::RenderContext;
use crate::sampler::{AdsrParams, SamplerEngine, Waveform};

// ── Shared Clip Snapshot (LOCK-FREE) ───────────────────────────────────

/// Atomic snapshot of per-track clip data for the audio thread.
///
/// Uses `ArcSwap` for **100% wait-free** reads from the audio thread.
/// The UI thread updates via `store()`, the audio thread reads via `load()`.
/// No mutex, no blocking, no priority inversion — ever.
pub struct SharedClipSnapshot {
    inner: ArcSwap<Vec<Vec<AudioClip>>>,
}

impl SharedClipSnapshot {
    /// Creates a new empty snapshot.
    pub fn new() -> Self {
        Self {
            inner: ArcSwap::from_pointee(Vec::new()),
        }
    }

    /// Atomically replaces the clip snapshot (called from UI thread).
    ///
    /// The audio thread will pick up the new snapshot on the next buffer.
    /// This is lock-free — it never blocks the audio thread.
    pub fn swap(&self, new_clips: Vec<Vec<AudioClip>>) {
        self.inner.store(Arc::new(new_clips));
    }

    /// Gets the current snapshot (called from audio thread).
    ///
    /// Returns an `Arc` — **wait-free**, nanosecond atomic load.
    /// The audio thread can hold this reference as long as needed.
    pub fn load(&self) -> arc_swap::Guard<Arc<Vec<Vec<AudioClip>>>> {
        self.inner.load()
    }

    /// Gets a full `Arc` clone (for cases needing owned Arc).
    pub fn load_full(&self) -> Arc<Vec<Vec<AudioClip>>> {
        self.inner.load_full()
    }
}

impl Default for SharedClipSnapshot {
    fn default() -> Self {
        Self::new()
    }
}

// ── Shared MIDI Snapshot (LOCK-FREE) ───────────────────────────────────

/// Atomic snapshot of per-track MIDI clip data for the audio thread.
///
/// Same wait-free architecture as `SharedClipSnapshot`.
#[derive(Debug, Clone)]
pub struct MidiFxRuntimeConfig {
    pub pitch_enabled: bool,
    pub pitch_semitones: i8,
    pub scale_enabled: bool,
    pub scale_root: u8,
    pub scale_mask: u16,
    pub velocity_enabled: bool,
    pub velocity_gain: f32,
    pub velocity_offset: i8,
    pub random_enabled: bool,
    pub random_semitones: i8,
    pub random_chance: f32,
}

impl Default for MidiFxRuntimeConfig {
    fn default() -> Self {
        Self {
            pitch_enabled: false,
            pitch_semitones: 0,
            scale_enabled: false,
            scale_root: 0,
            scale_mask: 0x0FFF,
            velocity_enabled: false,
            velocity_gain: 1.0,
            velocity_offset: 0,
            random_enabled: false,
            random_semitones: 0,
            random_chance: 1.0,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct MidiTrackRuntime {
    pub clips: Vec<MidiClip>,
    pub fx: MidiFxRuntimeConfig,
}

pub struct SharedMidiSnapshot {
    inner: ArcSwap<Vec<MidiTrackRuntime>>,
}

impl SharedMidiSnapshot {
    pub fn new() -> Self {
        Self {
            inner: ArcSwap::from_pointee(Vec::new()),
        }
    }

    /// Atomically replaces the MIDI snapshot (called from UI thread).
    pub fn swap(&self, new_tracks: Vec<MidiTrackRuntime>) {
        self.inner.store(Arc::new(new_tracks));
    }

    /// Gets the current MIDI snapshot (called from audio thread).
    /// **Wait-free** — nanosecond atomic load.
    pub fn load(&self) -> arc_swap::Guard<Arc<Vec<MidiTrackRuntime>>> {
        self.inner.load()
    }

    pub fn load_full(&self) -> Arc<Vec<MidiTrackRuntime>> {
        self.inner.load_full()
    }
}

impl Default for SharedMidiSnapshot {
    fn default() -> Self {
        Self::new()
    }
}

// ── Shared Routing Snapshot (LOCK-FREE) ────────────────────────────────

/// Atomic snapshot of per-track routing destinations for the audio graph.
///
/// Each entry is an optional destination track index:
/// - `None` => route track to master.
/// - `Some(i)` => route track to track `i` (bus/sidechain style feed).
pub struct SharedRoutingSnapshot {
    inner: ArcSwap<Vec<Option<usize>>>,
    generation: std::sync::atomic::AtomicU64,
}

impl SharedRoutingSnapshot {
    pub fn new() -> Self {
        Self {
            inner: ArcSwap::from_pointee(Vec::new()),
            generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub fn swap(&self, routing: Vec<Option<usize>>) {
        self.inner.store(Arc::new(routing));
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    pub fn load(&self) -> arc_swap::Guard<Arc<Vec<Option<usize>>>> {
        self.inner.load()
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }
}

impl Default for SharedRoutingSnapshot {
    fn default() -> Self {
        Self::new()
    }
}

// ── Shared Automation Snapshot (LOCK-FREE) ─────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct AutomationPoint {
    pub sample_frame: i64,
    pub value: f32,
}

#[derive(Debug, Clone, Default)]
pub struct TrackAutomationState {
    pub volume: Vec<AutomationPoint>,
    pub pan: Vec<AutomationPoint>,
    /// Arbitrary automation lanes (e.g. plugin parameter IDs).
    pub plugin_params: BTreeMap<String, Vec<AutomationPoint>>,
}

/// Atomic snapshot of per-track automation lanes.
pub struct SharedAutomationSnapshot {
    inner: ArcSwap<Vec<TrackAutomationState>>,
    generation: std::sync::atomic::AtomicU64,
}

impl SharedAutomationSnapshot {
    pub fn new() -> Self {
        Self {
            inner: ArcSwap::from_pointee(Vec::new()),
            generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub fn swap(&self, lanes: Vec<TrackAutomationState>) {
        self.inner.store(Arc::new(lanes));
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    pub fn load(&self) -> arc_swap::Guard<Arc<Vec<TrackAutomationState>>> {
        self.inner.load()
    }

    pub fn load_full(&self) -> Arc<Vec<TrackAutomationState>> {
        self.inner.load_full()
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }
}

impl Default for SharedAutomationSnapshot {
    fn default() -> Self {
        Self::new()
    }
}

#[inline]
fn soft_clip(sample: f32) -> f32 {
    (sample / (1.0 + sample.abs())).clamp(-1.0, 1.0)
}

#[inline]
fn eval_automation(points: &[AutomationPoint], at_frame: i64) -> Option<f32> {
    if points.is_empty() {
        return None;
    }
    if points.len() == 1 {
        return Some(points[0].value);
    }
    if at_frame <= points[0].sample_frame {
        return Some(points[0].value);
    }

    for window in points.windows(2) {
        let a = &window[0];
        let b = &window[1];
        if at_frame <= b.sample_frame {
            let span = (b.sample_frame - a.sample_frame).max(1) as f32;
            let t = ((at_frame - a.sample_frame) as f32 / span).clamp(0.0, 1.0);
            return Some(a.value + (b.value - a.value) * t);
        }
    }

    points.last().map(|p| p.value)
}

#[inline]
fn eval_automation_with_cursor(
    points: &[AutomationPoint],
    at_frame: i64,
    cursor: &mut usize,
) -> Option<f32> {
    if points.is_empty() {
        return None;
    }
    if points.len() == 1 {
        return Some(points[0].value);
    }
    if at_frame <= points[0].sample_frame {
        *cursor = 0;
        return Some(points[0].value);
    }

    let last_pair = points.len().saturating_sub(2);
    while *cursor < last_pair && at_frame > points[*cursor + 1].sample_frame {
        *cursor += 1;
    }

    let a = &points[*cursor];
    let b = &points[(*cursor + 1).min(points.len() - 1)];
    if at_frame <= b.sample_frame {
        let span = (b.sample_frame - a.sample_frame).max(1) as f32;
        let t = ((at_frame - a.sample_frame) as f32 / span).clamp(0.0, 1.0);
        return Some(a.value + (b.value - a.value) * t);
    }

    points.last().map(|p| p.value)
}

#[inline]
fn apply_plugin_automation_sample_accurate(
    left: &mut [f32],
    right: &mut [f32],
    buffer_start_frame: i64,
    gain_points: Option<&[AutomationPoint]>,
    pan_points: Option<&[AutomationPoint]>,
) {
    let n = left.len().min(right.len());
    if n == 0 {
        return;
    }

    if gain_points.is_none() && pan_points.is_none() {
        return;
    }

    let pan_is_unit_interval = pan_points
        .map(|pts| !pts.is_empty() && pts.iter().all(|p| (0.0..=1.0).contains(&p.value)))
        .unwrap_or(false);

    let mut gain_cursor = 0usize;
    let mut pan_cursor = 0usize;

    for i in 0..n {
        let frame = buffer_start_frame + i as i64;
        let gain = gain_points
            .and_then(|pts| eval_automation_with_cursor(pts, frame, &mut gain_cursor))
            .unwrap_or(1.0)
            .clamp(0.0, 2.0);

        let raw_pan = pan_points
            .and_then(|pts| eval_automation_with_cursor(pts, frame, &mut pan_cursor))
            .unwrap_or(0.0);
        let pan = if pan_is_unit_interval {
            raw_pan * 2.0 - 1.0
        } else {
            raw_pan
        }
        .clamp(-1.0, 1.0);

        let left_mul = if pan > 0.0 { 1.0 - pan } else { 1.0 };
        let right_mul = if pan < 0.0 { 1.0 + pan } else { 1.0 };

        left[i] *= gain * left_mul;
        right[i] *= gain * right_mul;
    }
}

fn build_linear_dag(track_count: usize) -> AudioDag {
    let mut builder =
        GraphBuilder::new().add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput));
    for track_idx in 0..track_count {
        builder = builder.add_node(AudioNode::new(
            NodeId((track_idx as u64) + 1),
            NodeKind::Track {
                name: format!("Track {}", track_idx + 1),
            },
        ));
    }

    for track_idx in 0..track_count {
        let from = NodeId((track_idx as u64) + 1);
        builder = match builder.add_edge(from, NodeId(0)) {
            Ok(next) => next,
            Err(err) => {
                log::warn!(
                    "[Graph] linear edge build failed ({}), fallback to master-only",
                    err
                );
                return GraphBuilder::new()
                    .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
                    .build()
                    .expect("master-only graph must be valid");
            }
        };
    }

    builder.build().unwrap_or_else(|_| {
        GraphBuilder::new()
            .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
            .build()
            .expect("master-only graph must be valid")
    })
}

fn build_dag_for_tracks(track_count: usize, routing: &[Option<usize>]) -> AudioDag {
    let mut builder =
        GraphBuilder::new().add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput));

    for track_idx in 0..track_count {
        builder = builder.add_node(AudioNode::new(
            NodeId((track_idx as u64) + 1),
            NodeKind::Track {
                name: format!("Track {}", track_idx + 1),
            },
        ));
    }

    let mut wired_to_master = vec![false; track_count];
    for (track_idx, wired_master) in wired_to_master.iter_mut().enumerate().take(track_count) {
        let from = NodeId((track_idx as u64) + 1);
        if let Some(Some(dest_idx)) = routing.get(track_idx) {
            if *dest_idx < track_count && *dest_idx != track_idx {
                let to = NodeId((*dest_idx as u64) + 1);
                let next = match builder.add_edge(from, to) {
                    Ok(next) => next,
                    Err(err) => {
                        log::warn!(
                            "[Graph] routing edge {} -> {} rejected ({}), fallback to linear graph",
                            track_idx,
                            dest_idx,
                            err
                        );
                        return build_linear_dag(track_count);
                    }
                };
                builder = next;
            } else {
                *wired_master = true;
            }
        } else {
            *wired_master = true;
        }
    }

    for (track_idx, wired_master) in wired_to_master.iter().enumerate().take(track_count) {
        if *wired_master {
            let from = NodeId((track_idx as u64) + 1);
            builder = match builder.add_edge(from, NodeId(0)) {
                Ok(next) => next,
                Err(err) => {
                    log::warn!(
                        "[Graph] master edge rejected ({}), fallback to linear graph",
                        err
                    );
                    return build_linear_dag(track_count);
                }
            };
        }
    }

    builder.build().unwrap_or_else(|err| {
        log::warn!("[Graph] build failed ({}), fallback to linear graph", err);
        build_linear_dag(track_count)
    })
}

// ── Shared Sampler Samples (LOCK-FREE) ─────────────────────────────────

/// Per-track sampler sample and parameters.
///
/// The UI thread sets this when a user loads a sample onto a track.
/// The audio thread reads it to configure per-track SamplerEngines.
/// **Wait-free** via `ArcSwap` — no locks in the hot path.
pub struct SharedSamplerSamples {
    inner: ArcSwap<Vec<Option<Arc<ClipAudio>>>>,
}

impl SharedSamplerSamples {
    pub fn new() -> Self {
        Self {
            inner: ArcSwap::from_pointee(Vec::new()),
        }
    }

    /// Sets the loaded sample for a specific track (called from UI thread).
    ///
    /// Uses load-modify-store pattern. Safe because only the UI thread writes.
    pub fn set_track_sample(&self, track_index: usize, sample: Option<Arc<ClipAudio>>) {
        let current = self.inner.load_full();
        let mut samples = (*current).clone();
        if track_index >= samples.len() {
            samples.resize(track_index + 1, None);
        }
        samples[track_index] = sample;
        self.inner.store(Arc::new(samples));
    }

    /// Gets all track samples (called from audio thread).
    /// **Wait-free** — nanosecond atomic load.
    pub fn load(&self) -> arc_swap::Guard<Arc<Vec<Option<Arc<ClipAudio>>>>> {
        self.inner.load()
    }

    pub fn load_full(&self) -> Arc<Vec<Option<Arc<ClipAudio>>>> {
        self.inner.load_full()
    }

    /// Atomically replaces all per-track sampler sample bindings.
    pub fn swap(&self, samples: Vec<Option<Arc<ClipAudio>>>) {
        self.inner.store(Arc::new(samples));
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

#[derive(Clone, Copy)]
struct MidiNoteMapState {
    mapped_pitch: [u8; 128],
    active: [bool; 128],
    rng_state: u32,
}

impl Default for MidiNoteMapState {
    fn default() -> Self {
        Self {
            mapped_pitch: [0; 128],
            active: [false; 128],
            rng_state: 0xA5A5_1337,
        }
    }
}

#[inline]
fn clamp_midi_pitch(v: i16) -> u8 {
    v.clamp(0, 127) as u8
}

#[inline]
fn quantize_to_scale(pitch: u8, root: u8, mask: u16) -> u8 {
    let mask = if mask == 0 { 0x0FFF } else { mask };
    let base_oct = (pitch / 12) as i16;
    let root = (root % 12) as i16;

    let mut best_pitch = pitch as i16;
    let mut best_dist = i16::MAX;
    for degree in 0..12i16 {
        if (mask & (1u16 << degree)) == 0 {
            continue;
        }
        let target = (root + degree).rem_euclid(12);
        for oct_off in [-1i16, 0, 1] {
            let cand = ((base_oct + oct_off) * 12 + target).clamp(0, 127);
            let dist = (cand - pitch as i16).abs();
            if dist < best_dist {
                best_dist = dist;
                best_pitch = cand;
            }
        }
    }
    clamp_midi_pitch(best_pitch)
}

// ── Audio Stream Handle ─────────────────────────────────────────────────

/// Holds the live cpal stream. Dropping this stops audio output.
pub struct AudioStreamHandle {
    _stream: cpal::Stream,

    /// Estimated output latency in sample frames.
    ///
    /// Derived from the cpal `StreamConfig::buffer_size`. When the OS uses
    /// a "Default" (variable) buffer size, we fall back to a conservative
    /// 512-frame estimate (≈10.7ms at 48kHz, typical macOS CoreAudio default).
    ///
    /// The frontend subtracts this from the MasterClock position so the
    /// visual playhead aligns with the audio actually reaching the speakers.
    pub output_latency_frames: u32,
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
/// - `clip_pool`: Shared clip pool snapshot (pre-loaded audio data). **Lock-free via ArcSwap.**
/// - `clip_snapshot`: Shared snapshot of project clips. **Lock-free via ArcSwap.**
/// - `midi_snapshot`: Shared MIDI clip snapshot. **Lock-free via ArcSwap.**
/// - `sampler_samples`: Shared sampler samples. **Lock-free via ArcSwap.**
/// - `preview_buffer`: Preview audio buffer. **Lock-free via ArcSwap.**
/// - `preview_cursor`: Atomic cursor in preview buffer.
///
/// # RT-Safety
/// The entire audio callback is 100% lock-free. All shared state
/// uses `ArcSwap::load()` (wait-free, nanosecond atomic load).
/// No `Mutex`, no `try_lock()`, no priority inversion — ever.
///
/// # Returns
/// `AudioStreamHandle` — keep alive for audio to continue. Drop to stop.
#[allow(clippy::too_many_arguments)]
pub fn start_audio_thread(
    consumer: rtrb::Consumer<EngineCommand>,
    clock: Arc<MasterClock>,
    meter_bank: Arc<MeterBank>,
    clip_pool: Arc<ArcSwap<ClipPool>>,
    clip_snapshot: Arc<SharedClipSnapshot>,
    midi_snapshot: Arc<SharedMidiSnapshot>,
    routing_snapshot: Arc<SharedRoutingSnapshot>,
    automation_snapshot: Arc<SharedAutomationSnapshot>,
    sampler_samples: Arc<SharedSamplerSamples>,
    preview_buffer: Arc<ArcSwap<Option<Vec<f32>>>>,
    preview_cursor: Arc<AtomicUsize>,
) -> Result<AudioStreamHandle, AudioDriverError> {
    start_audio_thread_on_device(
        consumer,
        clock,
        meter_bank,
        clip_pool,
        clip_snapshot,
        midi_snapshot,
        routing_snapshot,
        automation_snapshot,
        sampler_samples,
        preview_buffer,
        preview_cursor,
        None,
    )
}

/// Starts the real-time audio thread on a specific output device name.
///
/// If `preferred_output_device` is `None` or the name is not found, the
/// default output device is used.
#[allow(clippy::too_many_arguments)]
pub fn start_audio_thread_on_device(
    mut consumer: rtrb::Consumer<EngineCommand>,
    clock: Arc<MasterClock>,
    meter_bank: Arc<MeterBank>,
    clip_pool: Arc<ArcSwap<ClipPool>>,
    clip_snapshot: Arc<SharedClipSnapshot>,
    midi_snapshot: Arc<SharedMidiSnapshot>,
    routing_snapshot: Arc<SharedRoutingSnapshot>,
    automation_snapshot: Arc<SharedAutomationSnapshot>,
    sampler_samples: Arc<SharedSamplerSamples>,
    preview_buffer: Arc<ArcSwap<Option<Vec<f32>>>>,
    preview_cursor: Arc<AtomicUsize>,
    preferred_output_device: Option<&str>,
) -> Result<AudioStreamHandle, AudioDriverError> {
    // ── 1. Host & Device ────────────────────────────────────────────
    let host = cpal::default_host();
    info!("Audio host: {:?}", host.id());

    let device = if let Some(wanted_name) = preferred_output_device {
        let mut found = None;
        if let Ok(mut outputs) = host.output_devices() {
            found = outputs.find(|dev| {
                dev.description()
                    .map(|d| d.name().to_string())
                    .ok()
                    .as_deref()
                    == Some(wanted_name)
            });
        }
        found
            .or_else(|| host.default_output_device())
            .ok_or(AudioDriverError::NoOutputDevice)?
    } else {
        host.default_output_device()
            .ok_or(AudioDriverError::NoOutputDevice)?
    };

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
    // cpal 0.17: sample_rate() returns u32 directly
    let sample_rate_f64 = config.sample_rate as f64;
    let mut render_ctx = RenderContext::new(
        64, // MAX_TRACKS pre-allocated
        sample_rate_f64,
        channels,
        Arc::clone(&meter_bank),
    );
    let mut graph_renderer = GraphRenderer::new(256, 8192);
    let mut live_graph = LiveGraph::empty();
    let mut graph_dag = GraphBuilder::new()
        .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
        .build()
        .expect("master-only graph must be valid");
    let mut graph_out_left = vec![0.0f32; 8192];
    let mut graph_out_right = vec![0.0f32; 8192];
    let mut post_sum_processing_mask = vec![false; 64];
    let mut graph_last_generation = u64::MAX;
    let mut graph_last_track_count = usize::MAX;

    // ── 4. Test tone state (fallback when no clips loaded) ──────────
    let mut test_tone_phase: f64 = 0.0;
    let mut test_tone_current_freq: f32 = DEFAULT_FREQUENCY;
    let mut test_tone_target_freq: f32 = DEFAULT_FREQUENCY;
    let mut test_tone_enabled: bool = false;

    // ── 5. Playback state ───────────────────────────────────────────
    let mut is_playing: bool = false;
    let mut _bpm: f64 = 120.0;
    let mut master_gain_target: f32 = 1.0;
    let mut master_gain_current: f32 = 1.0;
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
    let mut midi_note_states: [MidiNoteMapState; 64] = [MidiNoteMapState::default(); 64];
    // Scratch buffers for sampler output (reused each buffer, zero-alloc)
    let mut sampler_left = vec![0.0f32; 8192];
    let mut sampler_right = vec![0.0f32; 8192];
    // Track which samples were last loaded per-track to avoid re-assigning
    let _last_sample_generation: u64 = 0;

    let stream = device
        .build_output_stream(
            &config,
            // ┌──────────────────────────────────────────────────────┐
            // │  THE HOT PATH — Real-Time Audio Callback             │
            // │  NO allocations. NO locks (except Arc::clone which   │
            // │  is atomic). NO I/O. NO panics.                      │
            // └──────────────────────────────────────────────────────┘
            move |data: &mut [f32], _info: &cpal::OutputCallbackInfo| {
                let callback_result =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        // ═══════════════════════════════════════════════════════════════
                        // RT-Armor: Zero-Alloc, Panic-Safe, Denormal-Free Audio Pipeline
                        // ═══════════════════════════════════════════════════════════════

                        // ── A0. Denormal Protection (DAZ/FTZ) ────────────────────────
                        // Flush denormals to zero to prevent CPU spikes during reverb tails.
                        #[cfg(target_arch = "x86_64")]
                        unsafe {
                            use std::arch::x86_64::*;
                            let csr = _mm_getcsr();
                            _mm_setcsr(csr | 0x8040); // DAZ + FTZ bits
                        }

                        let frame_count = data.len() / channels;

                        // ── A1. Drain command queue ───────────────────────────────
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
                                    if enabled {
                                        // If region was cleared, we can't recreate it here.
                                        // The IPC always sends SetLoopRegion BEFORE SetLoopEnabled,
                                        // so the region should already exist. This is a no-op guard.
                                    } else {
                                        render_ctx.loop_region = None;
                                    }
                                }
                                EngineCommand::SetLoopRegion { start, end } => {
                                    if end > start {
                                        render_ctx.loop_region = Some(LoopRegion { start, end });
                                    }
                                }
                                EngineCommand::SetTrackVolume {
                                    track_index,
                                    volume,
                                } => {
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
                                EngineCommand::SetMasterVolume { volume } => {
                                    master_gain_target = volume.clamp(0.0, 2.0);
                                }
                                EngineCommand::SetTrackMute { track_index, muted } => {
                                    let idx = track_index as usize;
                                    if idx < 64 {
                                        track_muted[idx] = muted;
                                        // Recalculate effective gain
                                        if idx < render_ctx.track_slots.len() {
                                            let eff = if muted { 0.0 } else { 1.0 };
                                            render_ctx.track_slots[idx]
                                                .strip
                                                .set_effective_gain(eff);
                                        }
                                    }
                                }
                                EngineCommand::SetTrackSolo {
                                    track_index,
                                    soloed,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < 64 {
                                        track_soloed[idx] = soloed;
                                        any_solo = track_soloed.iter().any(|s| *s);
                                        // Recalculate effective gain for ALL tracks
                                        for i in 0..render_ctx.track_slots.len().min(64) {
                                            let eff = if track_muted[i] || (any_solo && !track_soloed[i]) {
                                                0.0
                                            } else {
                                                1.0
                                            };
                                            render_ctx.track_slots[i].strip.set_effective_gain(eff);
                                        }
                                    }
                                }
                                // ── Sampler Commands ────────────────────────
                                EngineCommand::SamplerNoteOn {
                                    track_index,
                                    pitch,
                                    velocity,
                                } => {
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
                                EngineCommand::SetSamplerRootNote {
                                    track_index,
                                    root_note,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].root_note = root_note;
                                    }
                                }
                                EngineCommand::SetSamplerVolume {
                                    track_index,
                                    volume,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].volume = volume;
                                    }
                                }
                                EngineCommand::SetSamplerAdsr {
                                    track_index,
                                    attack,
                                    decay,
                                    sustain,
                                    release,
                                } => {
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
                                EngineCommand::SetSamplerWaveform { track_index, waveform } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_waveform(Waveform::from_u8(waveform));
                                    }
                                }
                                EngineCommand::SetSamplerOsc2Waveform { track_index, waveform } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_waveform2(Waveform::from_u8(waveform));
                                    }
                                }
                                EngineCommand::SetSamplerOscMix { track_index, mix } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_osc_mix(mix);
                                    }
                                }
                                EngineCommand::SetSamplerDetuneCents { track_index, cents } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_detune_cents(cents);
                                    }
                                }
                                EngineCommand::SetSamplerSubLevel { track_index, level } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_sub_level(level);
                                    }
                                }
                                EngineCommand::SetSamplerFilterCutoff { track_index, cutoff } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_filter_cutoff(cutoff);
                                    }
                                }
                                EngineCommand::SetSamplerFilterResonance { track_index, resonance } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_filter_resonance(resonance);
                                    }
                                }
                                EngineCommand::SetSamplerFilterType { track_index, filter_type } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_filter_type(filter_type);
                                    }
                                }
                                EngineCommand::SetSamplerLfoRate { track_index, rate } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_lfo_rate(rate);
                                    }
                                }
                                EngineCommand::SetSamplerLfoDepth { track_index, depth } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_lfo_depth(depth);
                                    }
                                }
                                EngineCommand::SetSamplerLfoTarget { track_index, target } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_lfo_target(target);
                                    }
                                }
                                EngineCommand::SetSamplerPulseWidth { track_index, width } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_pulse_width(width);
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
                                // ── Device Chain Commands ────────────────────
                                EngineCommand::AddDevice { track_index, slot_index, effect_type } => {
                                    let idx = track_index as usize;
                                    if idx < render_ctx.track_slots.len()
                                        && let Some(etype) = BuiltinEffectType::from_u8(effect_type)
                                    {
                                        render_ctx.track_slots[idx]
                                            .device_chain
                                            .add_device(slot_index as usize, etype);
                                    }
                                }
                                EngineCommand::RemoveDevice { track_index, slot_index } => {
                                    let idx = track_index as usize;
                                    if idx < render_ctx.track_slots.len() {
                                        render_ctx.track_slots[idx]
                                            .device_chain
                                            .remove_device(slot_index as usize);
                                    }
                                }
                                EngineCommand::BypassDevice { track_index, slot_index, bypassed } => {
                                    let idx = track_index as usize;
                                    if idx < render_ctx.track_slots.len() {
                                        render_ctx.track_slots[idx]
                                            .device_chain
                                            .set_bypass(slot_index as usize, bypassed);
                                    }
                                }
                                EngineCommand::SetDeviceParam { track_index, slot_index, param_index, value } => {
                                    let idx = track_index as usize;
                                    if idx < render_ctx.track_slots.len() {
                                        render_ctx.track_slots[idx]
                                            .device_chain
                                            .set_param(slot_index as usize, param_index, value);
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
                            // ── B-1. Apply track automation targets (volume/pan) ───────────
                            // ChannelStrip already smooths per-sample, so this remains click-free.
                            let automation = automation_snapshot.load();
                            let playhead_pos = render_ctx.playhead.position();
                            for (track_idx, lane) in automation.iter().enumerate() {
                                if track_idx >= render_ctx.track_slots.len() {
                                    break;
                                }
                                if let Some(v) = eval_automation(&lane.volume, playhead_pos) {
                                    render_ctx.track_slots[track_idx]
                                        .strip
                                        .set_volume(v.max(0.0));
                                }
                                if let Some(p) = eval_automation(&lane.pan, playhead_pos) {
                                    render_ctx.track_slots[track_idx]
                                        .strip
                                        .set_pan(p.clamp(-1.0, 1.0));
                                }
                            }

                            // ── B0. Rebuild graph on routing/track topology changes ─────────
                            let route_gen = routing_snapshot.generation();
                            let snapshot = clip_snapshot.load();
                            let track_count = snapshot.len().min(64);

                            if route_gen != graph_last_generation
                                || track_count != graph_last_track_count
                            {
                                let routing = routing_snapshot.load();
                                let new_dag = build_dag_for_tracks(track_count, &routing);
                                graph_dag = new_dag;
                                if live_graph.swap_graph(&graph_dag).is_err()
                                    && let Ok(new_live) = LiveGraph::from_dag(&graph_dag)
                                {
                                    live_graph = new_live;
                                }
                                let plan = live_graph.load();
                                graph_renderer.update_plan(&plan, &graph_dag);
                                graph_last_generation = route_gen;
                                graph_last_track_count = track_count;
                            }

                            // Tracks that receive routed input should apply strip/device
                            // processing after graph summing (bus/group semantics).
                            if post_sum_processing_mask.len() < track_count {
                                post_sum_processing_mask.resize(track_count, false);
                            }
                            post_sum_processing_mask[..track_count].fill(false);
                            let routing_now = routing_snapshot.load();
                            for src_idx in 0..track_count {
                                if let Some(Some(dest_idx)) = routing_now.get(src_idx)
                                    && *dest_idx < track_count
                                {
                                    post_sum_processing_mask[*dest_idx] = true;
                                }
                            }

                            // ── B. Load clip snapshot & render ───────────────
                            let has_clips = !snapshot.is_empty()
                                && snapshot.iter().any(|track_clips| !track_clips.is_empty());

                            // ▸ Capture pre-advance playhead for MIDI scheduling.
                            //   render_tracks() internally advances the playhead,
                            //   so we must snapshot BEFORE the call.
                            let midi_playhead_pos = render_ctx.playhead.position();
                            let mut playhead_advanced_in_render = false;

                            if has_clips {
                                // Disable test tone automatically when real clips exist
                                // so the sine never bleeds through.
                                test_tone_enabled = false;

                                // Real clip playback via RenderContext
                                // 100% lock-free: ArcSwap::load() is wait-free (nanosecond).
                                let pool_snap = clip_pool.load();

                                // Use render_tracks() (Phase 1 only) — fills track_slots
                                // with strip-processed audio. The graph handles summing
                                // and interleaving, so we skip the master bus path.
                                render_ctx.render_tracks_with_post_sum_mask(
                                    frame_count,
                                    snapshot.as_ref(),
                                    &pool_snap,
                                    Some(&post_sum_processing_mask[..track_count]),
                                );
                                playhead_advanced_in_render = true;

                                // Graph pass: route pre-rendered tracks through DAG.
                                let n = frame_count
                                    .min(graph_out_left.len())
                                    .min(graph_out_right.len());
                                graph_out_left[..n].fill(0.0);
                                graph_out_right[..n].fill(0.0);

                                let plan = live_graph.load();
                                graph_renderer.render(
                                    &plan,
                                    &graph_dag,
                                    n,
                                    &mut graph_out_left[..n],
                                    &mut graph_out_right[..n],
                                    |node, left, right, count| {
                                        if node.id.0 == 0 {
                                            return;
                                        }
                                        let track_idx = (node.id.0 - 1) as usize;
                                        if let Some(slot) = render_ctx.track_slots.get_mut(track_idx) {
                                            let c = count
                                                .min(slot.buf_left.len())
                                                .min(slot.buf_right.len());
                                            for i in 0..c {
                                                left[i] += slot.buf_left[i];
                                                right[i] += slot.buf_right[i];
                                            }

                                            if post_sum_processing_mask
                                                .get(track_idx)
                                                .copied()
                                                .unwrap_or(false)
                                            {
                                                slot.strip.process_stereo(
                                                    &mut left[..c],
                                                    &mut right[..c],
                                                );
                                                if !slot.device_chain.is_empty() {
                                                    slot.device_chain.process_stereo(
                                                        &mut left[..c],
                                                        &mut right[..c],
                                                        sample_rate_f64 as f32,
                                                    );
                                                }
                                                if let Some((meter_l, meter_r)) =
                                                    render_ctx.meter_bank.track(track_idx)
                                                {
                                                    let rms_l = linear_to_db(compute_rms(&left[..c]));
                                                    let rms_r = linear_to_db(compute_rms(&right[..c]));
                                                    let peak_l = linear_to_db(compute_peak(&left[..c]));
                                                    let peak_r = linear_to_db(compute_peak(&right[..c]));
                                                    meter_l.store_rms(rms_l);
                                                    meter_r.store_rms(rms_r);
                                                    meter_l.store_peak_decay(peak_l, 0.99);
                                                    meter_r.store_peak_decay(peak_r, 0.99);
                                                }
                                            }

                                            // Canonicalized in desktop_host:
                                            // __plugin_gain__ => [0..2], __plugin_pan__ => [0..1] or [-1..1].
                                            // Apply sample-accurate values across the current buffer.
                                            if let Some(lane) = automation.get(track_idx) {
                                                apply_plugin_automation_sample_accurate(
                                                    &mut left[..c],
                                                    &mut right[..c],
                                                    playhead_pos,
                                                    lane.plugin_params
                                                        .get("__plugin_gain__")
                                                        .map(|v| v.as_slice()),
                                                    lane.plugin_params
                                                        .get("__plugin_pan__")
                                                        .map(|v| v.as_slice()),
                                                );
                                            }
                                        }
                                    },
                                    |_node, _left, _right, _count| {
                                        // Plugin node processing will be injected here.
                                    },
                                );

                                for i in 0..n {
                                    let base = i * channels;
                                    if base + 1 < data.len() {
                                        data[base] = soft_clip(graph_out_left[i]);
                                        data[base + 1] = soft_clip(graph_out_right[i]);
                                    }
                                }
                            } else if test_tone_enabled {
                                // Test tone fallback (no clips loaded)
                                for frame in data.chunks_exact_mut(channels) {
                                    test_tone_current_freq += (test_tone_target_freq
                                        - test_tone_current_freq)
                                        * FREQ_SMOOTHING;

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
                            // ▸ Use the pre-advance position so MIDI and audio
                            //   share the same timeline window for this buffer.
                            let midi_snap = midi_snapshot.load();

                            for (track_idx, midi_track) in midi_snap.iter().enumerate() {
                                if track_idx >= sampler_engines.len() || midi_track.clips.is_empty() {
                                    continue;
                                }

                                let engine = &mut sampler_engines[track_idx];
                                let note_state = &mut midi_note_states[track_idx];
                                let fx = &midi_track.fx;

                                // Schedule active notes for this buffer
                                // ▸ Loop-aware: splits the buffer at the loop
                                //   boundary so MIDI notes at beat 1 of the
                                //   loop are correctly triggered after wrap.
                                let midi_loop_region = render_ctx.loop_region.as_ref().map(|r| {
                                    dream_clip_engine::LoopRegion::new(r.start, r.end)
                                });
                                let events = MidiScheduler::find_active_looped(
                                    &midi_track.clips,
                                    midi_playhead_pos,
                                    frame_count,
                                    midi_loop_region.as_ref(),
                                );

                                // Process note-on/off events
                                for event in &events {
                                    if event.is_note_on {
                                        let mut pitch_i16 = event.pitch as i16;
                                        let mut velocity_i16 = event.velocity as i16;

                                        if fx.pitch_enabled {
                                            pitch_i16 += fx.pitch_semitones as i16;
                                        }
                                        let mut mapped_pitch = clamp_midi_pitch(pitch_i16);

                                        if fx.scale_enabled {
                                            mapped_pitch = quantize_to_scale(
                                                mapped_pitch,
                                                fx.scale_root,
                                                fx.scale_mask,
                                            );
                                        }

                                        if fx.random_enabled && fx.random_semitones != 0 {
                                            // Xorshift32 deterministic PRNG (RT-safe, no allocations).
                                            let mut x = note_state.rng_state;
                                            x ^= x << 13;
                                            x ^= x >> 17;
                                            x ^= x << 5;
                                            note_state.rng_state = x;
                                            let rnd01 = (x as f32) / (u32::MAX as f32);
                                            if rnd01 <= fx.random_chance.clamp(0.0, 1.0) {
                                                let span = fx.random_semitones.abs().max(1) as i16;
                                                let signed = ((x >> 8) % ((span as u32) * 2 + 1)) as i16 - span;
                                                mapped_pitch = clamp_midi_pitch(mapped_pitch as i16 + signed);
                                            }
                                        }

                                        if fx.velocity_enabled {
                                            velocity_i16 = ((velocity_i16 as f32) * fx.velocity_gain).round() as i16
                                                + fx.velocity_offset as i16;
                                        }
                                        let mapped_velocity = velocity_i16.clamp(1, 127) as u8;

                                        note_state.mapped_pitch[event.pitch as usize] = mapped_pitch;
                                        note_state.active[event.pitch as usize] = true;
                                        engine.note_on(mapped_pitch, mapped_velocity);
                                    }
                                    if event.is_note_off {
                                        let src = event.pitch as usize;
                                        let off_pitch = if note_state.active[src] {
                                            note_state.active[src] = false;
                                            note_state.mapped_pitch[src]
                                        } else {
                                            event.pitch
                                        };
                                        engine.note_off(off_pitch);
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

                            // When there are no audio clips, RenderContext isn't called and
                            // therefore doesn't advance playhead internally. Advance it here
                            // so MIDI scheduling and transport telemetry stay aligned.
                            if is_playing && !playhead_advanced_in_render {
                                let transport_loop = render_ctx.loop_region.as_ref().map(|r| {
                                    dream_transport::LoopRegion {
                                        start: r.start,
                                        end: r.end,
                                        enabled: true,
                                    }
                                });
                                render_ctx.playhead.advance(frame_count, transport_loop.as_ref());
                            }
                        }

                        // ── C. Mix preview audio (browser audition) ─────
                        // Preview plays regardless of transport state
                        // 100% lock-free: ArcSwap::load() is wait-free.
                        let preview_snap = preview_buffer.load();
                        if let Some(ref preview_data) = **preview_snap {
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

                        // ── C2. Master fader + final safety clip ─────────
                        // Smooth target to avoid zipper noise while dragging.
                        for sample in data.iter_mut() {
                            master_gain_current +=
                                (master_gain_target - master_gain_current) * 0.005;
                            *sample = soft_clip(*sample * master_gain_current);
                        }

                        // ── D. Advance master clock ─────────────────────
                        if is_playing {
                            clock.advance(frame_count as i64);

                            // Handle loop wrap on master clock + playhead
                            if let Some(ref region) = render_ctx.loop_region {
                                let pos = clock.position();
                                if pos >= region.end {
                                    let overshoot = pos - region.end;
                                    let loop_len = region.end - region.start;
                                    let new_pos = region.start + (overshoot % loop_len);
                                    clock.reset();
                                    clock.advance(new_pos);

                                    // Sync playhead to wrapped position so clip
                                    // scheduling & MIDI correctly loop as well.
                                    render_ctx.playhead.seek(new_pos);
                                }
                            }
                        }
                    }));
                if callback_result.is_err() {
                    data.fill(0.0);
                    error!(
                        "[RT] Panic trapped inside audio callback; emitted silence for this buffer"
                    );
                }
            },
            move |err| {
                error!("Audio stream error: {}", err);
            },
            None,
        )
        .map_err(|e| AudioDriverError::BuildStreamError(e.to_string()))?;

    // ── 6. Estimate output latency ──────────────────────────────────
    // cpal 0.17: StreamConfig.buffer_size may be Default (OS-chosen)
    // or Fixed(n). When Default, we use a conservative 512 frames
    // which matches typical macOS CoreAudio buffer size (~10.7ms @ 48kHz).
    let output_latency_frames: u32 = match config.buffer_size {
        cpal::BufferSize::Fixed(n) => n,
        cpal::BufferSize::Default => 512,
    };

    // ── 7. Start ────────────────────────────────────────────────────
    stream
        .play()
        .map_err(|e| AudioDriverError::PlayStreamError(e.to_string()))?;

    info!(
        "🔊 Audio stream started ({}Hz, {}ch, {:?}, latency ≈ {} frames)",
        sample_rate, channels, sample_format, output_latency_frames
    );

    Ok(AudioStreamHandle {
        _stream: stream,
        output_latency_frames,
    })
}

// ═══════════════════════════════════════════════════════════════════════
// Audio Device Enumeration
// ═══════════════════════════════════════════════════════════════════════

/// Enumerates all available audio input and output devices on the system.
///
/// Returns `(output_device_names, input_device_names)`.
/// Uses `cpal::default_host()` which maps to CoreAudio on macOS,
/// WASAPI on Windows, and ALSA/PulseAudio on Linux.
pub fn list_audio_devices() -> (Vec<String>, Vec<String>) {
    let host = cpal::default_host();

    let outputs: Vec<String> = host
        .output_devices()
        .map(|devices| devices.filter_map(|d| d.description().ok().map(|desc| desc.name().to_string())).collect())
        .unwrap_or_default();

    let inputs: Vec<String> = host
        .input_devices()
        .map(|devices| devices.filter_map(|d| d.description().ok().map(|desc| desc.name().to_string())).collect())
        .unwrap_or_default();

    info!(
        "Audio devices: {} outputs, {} inputs",
        outputs.len(),
        inputs.len()
    );
    (outputs, inputs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::assertions_on_constants)]
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

    #[test]
    fn sample_accurate_plugin_gain_changes_within_buffer() {
        let mut left = vec![1.0f32; 8];
        let mut right = vec![1.0f32; 8];
        let gain_points = vec![
            AutomationPoint {
                sample_frame: 0,
                value: 0.0,
            },
            AutomationPoint {
                sample_frame: 7,
                value: 2.0,
            },
        ];

        apply_plugin_automation_sample_accurate(
            &mut left,
            &mut right,
            0,
            Some(&gain_points),
            None,
        );

        assert!(left[0] < left[7]);
        assert!(right[0] < right[7]);
        assert!((left[7] - 2.0).abs() < 0.05);
    }

    #[test]
    fn sample_accurate_plugin_pan_unit_interval_maps_correctly() {
        let mut left = vec![1.0f32; 4];
        let mut right = vec![1.0f32; 4];
        // 0.0 -> hard left, 1.0 -> hard right in legacy unit domain.
        let pan_points = vec![
            AutomationPoint {
                sample_frame: 0,
                value: 0.0,
            },
            AutomationPoint {
                sample_frame: 3,
                value: 1.0,
            },
        ];

        apply_plugin_automation_sample_accurate(
            &mut left,
            &mut right,
            0,
            None,
            Some(&pan_points),
        );

        assert!(left[0] > right[0]);
        assert!(right[3] > left[3]);
    }
}
