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

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::time::Instant;

use arc_swap::ArcSwap;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use dream_graph::{
    AudioDag, AudioEdgeKind, AudioNode, ExecutionPlan, GraphBuilder, GraphRenderer, LiveGraph,
    NodeId, NodeKind,
};
use dream_plugins::{MidiEvent, PluginHost, TransportContext};
use log::{error, info, warn};
use uuid::Uuid;

use dream_clip_engine::midi_scheduler::{MidiScheduler, ScheduledNote};
use dream_clip_engine::pool::ClipAudio;
use dream_clip_engine::pool::ClipPool;
use dream_clip_engine::scheduler::LoopRegion;
use dream_dsp::dsp_processor::BuiltinEffectType;
use dream_ipc::metering::{METER_FLOOR_DB, MeterBank, compute_peak, compute_rms, linear_to_db, peak_decay_for_block};
use dream_ipc::{EngineCommand, MasterClock};
use dream_models::midi::MidiClip;
use dream_models::project::AudioClip;

use crate::render_callback::{RenderContext, MAX_TRACKS, MAX_BUFFER_FRAMES};
use crate::sampler::{AdsrParams, SamplerEngine, SampleRackEngine, Waveform};

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
        // BUG-054 FIX: Release ordering guarantees that the ArcSwap store
        // is visible to any thread that observes the incremented generation.
        self.generation.fetch_add(1, Ordering::Release);
    }

    pub fn load(&self) -> arc_swap::Guard<Arc<Vec<Option<usize>>>> {
        self.inner.load()
    }

    pub fn generation(&self) -> u64 {
        // BUG-FIX: Acquire ordering ensures we see the ArcSwap store that
        // happened-before the Release in fetch_add.
        self.generation.load(Ordering::Acquire)
    }
}

impl Default for SharedRoutingSnapshot {
    fn default() -> Self {
        Self::new()
    }
}

/// Atomic snapshot of per-track internal device sidechain sources.
///
/// Shape: `[track_index][device_slot_index] -> Option<source_track_index>`.
pub struct SharedSidechainSnapshot {
    inner: ArcSwap<Vec<Vec<Option<usize>>>>,
    generation: std::sync::atomic::AtomicU64,
}

impl SharedSidechainSnapshot {
    pub fn new() -> Self {
        Self {
            inner: ArcSwap::from_pointee(Vec::new()),
            generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub fn swap(&self, sidechains: Vec<Vec<Option<usize>>>) {
        self.inner.store(Arc::new(sidechains));
        // BUG-FIX: Release ordering so the ArcSwap store is visible to
        // any thread that observes the incremented generation via Acquire.
        self.generation.fetch_add(1, Ordering::Release);
    }

    pub fn load(&self) -> arc_swap::Guard<Arc<Vec<Vec<Option<usize>>>>> {
        self.inner.load()
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }
}

impl Default for SharedSidechainSnapshot {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ExternalFxRuntimeSlot {
    pub slot_id: Option<Uuid>,
    pub internal_slot_index: Option<usize>,
    pub instance_id: Option<Uuid>,
    pub sidechain_track_index: Option<usize>,
}

/// Atomic snapshot of per-track external effect runtime instances.
///
/// Shape: `[track_index] -> Vec<fx_steps_in_project_order>`.
pub struct SharedExternalFxSnapshot {
    inner: ArcSwap<Vec<Vec<ExternalFxRuntimeSlot>>>,
    generation: std::sync::atomic::AtomicU64,
}

impl SharedExternalFxSnapshot {
    pub fn new() -> Self {
        Self {
            inner: ArcSwap::from_pointee(Vec::new()),
            generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub fn swap(&self, fx: Vec<Vec<ExternalFxRuntimeSlot>>) {
        self.inner.store(Arc::new(fx));
        self.generation.fetch_add(1, Ordering::Release);
    }

    pub fn load(&self) -> arc_swap::Guard<Arc<Vec<Vec<ExternalFxRuntimeSlot>>>> {
        self.inner.load()
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }
}

impl Default for SharedExternalFxSnapshot {
    fn default() -> Self {
        Self::new()
    }
}

/// Lock-free runtime stats written by audio callback for diagnostics.
///
/// AUD-054: All fields use `Relaxed` ordering intentionally. These stats are
/// for diagnostics only — stale reads across fields in a snapshot are acceptable.
/// Using `Acquire/Release` would add unnecessary memory fences on every callback.
pub struct SharedRtDebugStats {
    enabled: AtomicBool,
    callback_count: AtomicU64,
    command_count_total: AtomicU64,
    command_count_last: AtomicU64,
    command_count_max: AtomicU64,
    callback_duration_us_last: AtomicU64,
    callback_duration_us_max: AtomicU64,
    callback_frames_last: AtomicU64,
    plugin_host_lock_miss_total: AtomicU64,
    queue_full_reject_total: AtomicU64,
    deferred_topology_len_last: AtomicU64,
    topology_overflow_total: AtomicU64,
}

impl SharedRtDebugStats {
    pub fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            callback_count: AtomicU64::new(0),
            command_count_total: AtomicU64::new(0),
            command_count_last: AtomicU64::new(0),
            command_count_max: AtomicU64::new(0),
            callback_duration_us_last: AtomicU64::new(0),
            callback_duration_us_max: AtomicU64::new(0),
            callback_frames_last: AtomicU64::new(0),
            plugin_host_lock_miss_total: AtomicU64::new(0),
            queue_full_reject_total: AtomicU64::new(0),
            deferred_topology_len_last: AtomicU64::new(0),
            topology_overflow_total: AtomicU64::new(0),
        }
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn record_queue_full_reject(&self) {
        if !self.is_enabled() {
            return;
        }
        self.queue_full_reject_total.fetch_add(1, Ordering::Relaxed);
    }

    fn record_callback(
        &self,
        frames: usize,
        commands_processed: usize,
        callback_us: u64,
        deferred_topology_len: usize,
    ) {
        if !self.is_enabled() {
            return;
        }
        self.callback_count.fetch_add(1, Ordering::Relaxed);
        self.command_count_total
            .fetch_add(commands_processed as u64, Ordering::Relaxed);
        self.command_count_last
            .store(commands_processed as u64, Ordering::Relaxed);
        self.command_count_max
            .fetch_max(commands_processed as u64, Ordering::Relaxed);
        self.callback_duration_us_last
            .store(callback_us, Ordering::Relaxed);
        self.callback_duration_us_max
            .fetch_max(callback_us, Ordering::Relaxed);
        self.callback_frames_last
            .store(frames as u64, Ordering::Relaxed);
        self.deferred_topology_len_last
            .store(deferred_topology_len as u64, Ordering::Relaxed);
    }

    fn record_plugin_host_lock_miss(&self) {
        if !self.is_enabled() {
            return;
        }
        self.plugin_host_lock_miss_total.fetch_add(1, Ordering::Relaxed);
    }

    /// RT-SAFE topology overflow counter. Replaces log::warn! which
    /// would acquire a global Mutex inside the audio callback.
    fn record_topology_overflow(&self) {
        self.topology_overflow_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> RtDebugSnapshot {
        RtDebugSnapshot {
            enabled: self.is_enabled(),
            callback_count: self.callback_count.load(Ordering::Relaxed),
            command_count_total: self.command_count_total.load(Ordering::Relaxed),
            command_count_last: self.command_count_last.load(Ordering::Relaxed),
            command_count_max: self.command_count_max.load(Ordering::Relaxed),
            callback_duration_us_last: self.callback_duration_us_last.load(Ordering::Relaxed),
            callback_duration_us_max: self.callback_duration_us_max.load(Ordering::Relaxed),
            callback_frames_last: self.callback_frames_last.load(Ordering::Relaxed),
            plugin_host_lock_miss_total: self.plugin_host_lock_miss_total.load(Ordering::Relaxed),
            queue_full_reject_total: self.queue_full_reject_total.load(Ordering::Relaxed),
            deferred_topology_len_last: self.deferred_topology_len_last.load(Ordering::Relaxed),
            topology_overflow_total: self.topology_overflow_total.load(Ordering::Relaxed),
        }
    }
}

impl Default for SharedRtDebugStats {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RtDebugSnapshot {
    pub enabled: bool,
    pub callback_count: u64,
    pub command_count_total: u64,
    pub command_count_last: u64,
    pub command_count_max: u64,
    pub callback_duration_us_last: u64,
    pub callback_duration_us_max: u64,
    pub callback_frames_last: u64,
    pub plugin_host_lock_miss_total: u64,
    pub queue_full_reject_total: u64,
    pub deferred_topology_len_last: u64,
    pub topology_overflow_total: u64,
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
    /// Pre-parsed external plugin automation targets.
    pub external_plugin_params: Vec<ExternalParamAutomationLane>,
}

#[derive(Debug, Clone)]
pub struct ExternalParamAutomationLane {
    pub target: ExternalParamTarget,
    pub points: Vec<AutomationPoint>,
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
        self.generation.fetch_add(1, Ordering::Release);
    }

    pub fn load(&self) -> arc_swap::Guard<Arc<Vec<TrackAutomationState>>> {
        self.inner.load()
    }

    pub fn load_full(&self) -> Arc<Vec<TrackAutomationState>> {
        self.inner.load_full()
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }
}

impl Default for SharedAutomationSnapshot {
    fn default() -> Self {
        Self::new()
    }
}

// BUG-2 FIX: soft_clip is canonically defined in render_callback.rs.
// Import it from there to eliminate SSOT violation.
use crate::render_callback::soft_clip;

// BUG-8/9 FIX: Equal-power (constant-power) pan law.
// pan ∈ [-1.0, 1.0], where -1 = hard left, 0 = center, +1 = hard right.
//
// Uses cos/sin trig for perfect equal-power behaviour:
//   angle = t * π/2, where t = (pan + 1) / 2 ∈ [0, 1]
//   L = cos(angle), R = sin(angle)
// Guarantees L² + R² = 1 everywhere (constant power).
// BUG-006 FIX: Comment now accurately describes the trig implementation.
#[inline]
fn equal_power_pan_gains(pan: f32) -> (f32, f32) {
    let pan = pan.clamp(-1.0, 1.0);
    let t = (pan + 1.0) * 0.5; // t ∈ [0, 1]
    let angle = t * std::f32::consts::FRAC_PI_2; // [0, π/2]
    (angle.cos(), angle.sin())
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

    // BUG-24 FIX: Use binary search for backward seek / loop wrap instead of
    // resetting cursor to 0 (linear scan). With many automation points, this
    // prevents CPU spikes at loop boundaries.
    if *cursor > 0 && at_frame < points[*cursor].sample_frame {
        *cursor = match points.binary_search_by_key(&at_frame, |p| p.sample_frame) {
            Ok(exact) => exact,
            Err(insert_pos) => insert_pos.saturating_sub(1),
        };
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
fn pan_points_use_unit_interval_domain(points: &[AutomationPoint]) -> bool {
    if points.is_empty() {
        return false;
    }

    // AUD-022 FIX: Early-out for all-zero points (common for center pan).
    // Avoids O(n) scan for the overwhelmingly common case.
    if points.len() <= 2 && points.iter().all(|p| p.value.abs() < 0.001) {
        return false;
    }

    let mut min_v = f32::INFINITY;
    let mut max_v = f32::NEG_INFINITY;
    let mut saw_center_hint = false;
    for p in points {
        let v = p.value;
        min_v = min_v.min(v);
        max_v = max_v.max(v);
        // BUG-025 FIX: Tighten center hint to ±0.02 to avoid false positives
        // (e.g. value 0.45 in [-1,1] domain misread as center)
        if (v - 0.5).abs() <= 0.02 {
            saw_center_hint = true;
        }
    }

    if min_v < 0.0 || max_v > 1.0 {
        return false;
    }

    // Treat as [0..1] only when evidence is explicit:
    // - lane contains center-like values (~0.5), or
    // - lane spans near full [0..1] endpoints.
    // This prevents all-zero lanes (common imported center pan) from being
    // misread as hard-left after [0..1] -> [-1..1] conversion.
    saw_center_hint || (min_v <= 0.01 && max_v >= 0.99)
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

    // Fast path: static values (no interpolation needed).
    if gain_points.is_none_or(|p| p.len() <= 1) && pan_points.is_none_or(|p| p.len() <= 1) {
        let gain = gain_points
            .and_then(|p| p.first())
            .map(|p| p.value)
            .unwrap_or(1.0)
            .clamp(0.0, 2.0);
        let raw_pan = pan_points
            .and_then(|p| p.first())
            .map(|p| p.value)
            .unwrap_or(0.0);
        let pan = if pan_points
            .map(pan_points_use_unit_interval_domain)
            .unwrap_or(false)
        {
            raw_pan * 2.0 - 1.0
        } else {
            raw_pan
        }
        .clamp(-1.0, 1.0);
        let (left_mul, right_mul) = equal_power_pan_gains(pan);
        for i in 0..n {
            left[i] *= gain * left_mul;
            right[i] *= gain * right_mul;
        }
        return;
    }

    let pan_is_unit_interval = pan_points
        .map(pan_points_use_unit_interval_domain)
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

        let (left_mul, right_mul) = equal_power_pan_gains(pan);

        left[i] *= gain * left_mul;
        right[i] *= gain * right_mul;
    }
}

#[inline]
fn apply_track_mixer_automation_sample_accurate(
    left: &mut [f32],
    right: &mut [f32],
    buffer_start_frame: i64,
    volume_points: Option<&[AutomationPoint]>,
    pan_points: Option<&[AutomationPoint]>,
) {
    let n = left.len().min(right.len());
    if n == 0 {
        return;
    }
    if volume_points.is_none() && pan_points.is_none() {
        return;
    }

    // Fast path: static values (no interpolation needed).
    if volume_points.is_none_or(|p| p.len() <= 1) && pan_points.is_none_or(|p| p.len() <= 1) {
        let vol = volume_points
            .and_then(|p| p.first())
            .map(|p| p.value)
            .unwrap_or(1.0)
            .clamp(0.0, 2.0);
        let raw_pan = pan_points
            .and_then(|p| p.first())
            .map(|p| p.value)
            .unwrap_or(0.0);
        let pan = if pan_points
            .map(pan_points_use_unit_interval_domain)
            .unwrap_or(false)
        {
            raw_pan * 2.0 - 1.0
        } else {
            raw_pan
        }
        .clamp(-1.0, 1.0);
        let (left_mul, right_mul) = equal_power_pan_gains(pan);
        for i in 0..n {
            left[i] *= vol * left_mul;
            right[i] *= vol * right_mul;
        }
        return;
    }

    let pan_is_unit_interval = pan_points
        .map(pan_points_use_unit_interval_domain)
        .unwrap_or(false);

    let mut volume_cursor = 0usize;
    let mut pan_cursor = 0usize;

    for i in 0..n {
        let frame = buffer_start_frame + i as i64;
        let vol = volume_points
            .and_then(|pts| eval_automation_with_cursor(pts, frame, &mut volume_cursor))
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

        let (left_mul, right_mul) = equal_power_pan_gains(pan);

        left[i] *= vol * left_mul;
        right[i] *= vol * right_mul;
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ExternalParamTarget {
    pub slot_id: Option<Uuid>,
    pub slot_index: Option<usize>,
    pub param_index: u32,
}

pub fn parse_external_param_target(param_key: &str) -> Option<ExternalParamTarget> {
    // AUD-048 FIX: Avoid heap-allocating .to_lowercase(). Use ASCII case-insensitive
    // comparison instead. Automation param keys are ASCII-only (ext:uuid:idx).
    let key = param_key.trim();
    if key.is_empty() {
        return None;
    }

    // ext:<slot_uuid>:<param_index> (canonical key)
    if let Some(rest) = key.strip_prefix("ext:").or_else(|| key.strip_prefix("Ext:")).or_else(|| key.strip_prefix("EXT:")) {
        let mut parts = rest.splitn(2, ':');
        let slot_id_str = parts.next()?;
        let param_index_str = parts.next()?;
        let slot_id = Uuid::parse_str(slot_id_str).ok()?;
        let idx = param_index_str.parse::<u32>().ok()?;
        return Some(ExternalParamTarget {
            slot_id: Some(slot_id),
            slot_index: None,
            param_index: idx,
        });
    }

    // slot:<uuid>:ext_param_<idx>
    if let Some(rest) = key.strip_prefix("slot:").or_else(|| key.strip_prefix("Slot:")).or_else(|| key.strip_prefix("SLOT:")) {
        let mut parts = rest.splitn(2, ':');
        let slot_id_str = parts.next()?;
        let param_token = parts.next()?;
        let slot_id = Uuid::parse_str(slot_id_str).ok()?;

        let idx = if let Some(v) = param_token.strip_prefix("ext_param_") {
            v.parse::<u32>().ok()
        } else if let Some(v) = param_token.strip_prefix("param_id") {
            v.parse::<u32>().ok()
        } else if let Some(v) = param_token.strip_prefix("param") {
            v.parse::<u32>().ok()
        } else {
            None
        }?;

        return Some(ExternalParamTarget {
            slot_id: Some(slot_id),
            slot_index: None,
            param_index: idx,
        });
    }

    // plugin:<slot_index>:<plugin_key>:<param_token_with_optional__idN>
    if let Some(rest) = key.strip_prefix("plugin:").or_else(|| key.strip_prefix("Plugin:")).or_else(|| key.strip_prefix("PLUGIN:")) {
        let mut parts = rest.split(':');
        let slot_index = parts.next()?.parse::<usize>().ok()?;
        let _plugin_key = parts.next()?;
        // AE-002 FIX: Avoid heap-allocating collect+join. Find the remaining
        // substring directly from the source string instead.
        let plugin_key_end = rest.find(':').and_then(|first_colon| {
            rest[first_colon + 1..].find(':').map(|second_colon| first_colon + 1 + second_colon + 1)
        }).unwrap_or(rest.len());
        let param_token = &rest[plugin_key_end.min(rest.len())..];
        if param_token.is_empty() {
            return None;
        }
        if let Some(id_pos) = param_token.rfind("_id") {
            let idx = param_token[(id_pos + 3)..].parse::<u32>().ok()?;
            return Some(ExternalParamTarget {
                slot_id: None,
                slot_index: Some(slot_index),
                param_index: idx,
            });
        }
    }

    None
}

fn apply_external_plugin_param_automation_block(
    host: &mut PluginHost,
    lane: Option<&TrackAutomationState>,
    runtime_slot: &ExternalFxRuntimeSlot,
    runtime_slot_index: usize,
    playhead_pos: i64,
) {
    let Some(instance_id) = runtime_slot.instance_id else {
        return;
    };
    let Some(lane) = lane else {
        return;
    };
    if lane.external_plugin_params.is_empty() {
        return;
    }

    for ext_lane in &lane.external_plugin_params {
        let target = ext_lane.target;
        let points = &ext_lane.points;

        if let Some(target_slot_id) = target.slot_id
            && runtime_slot.slot_id != Some(target_slot_id)
        {
            continue;
        }
        if let Some(target_slot_index) = target.slot_index
            && target_slot_index != runtime_slot_index
        {
            continue;
        }

        let mut cursor = 0usize;
        if let Some(value) = eval_automation_with_cursor(points, playhead_pos, &mut cursor) {
            let normalized = f64::from(value.clamp(0.0, 1.0));
            let _ = host.set_parameter(instance_id, target.param_index, normalized);
        }
    }
}

fn build_linear_dag(track_count: usize) -> AudioDag {
    let mut builder =
        GraphBuilder::new().add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput));
    for track_idx in 0..track_count {
        // AUD-005 FIX: Use empty string instead of format!() to avoid
        // heap allocation. Track names are for debugging only and set
        // separately by the UI thread.
        builder = builder.add_node(AudioNode::new(
            NodeId((track_idx as u64) + 1),
            NodeKind::Track {
                name: String::new(),
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
                return dream_graph::dag::AudioDag::empty();
            }
        };
    }

    builder.build().unwrap_or_else(|_| dream_graph::dag::AudioDag::empty())
}

fn build_dag_for_tracks(
    track_count: usize,
    routing: &[Option<usize>],
    sidechains: &[Vec<Option<usize>>],
) -> AudioDag {
    let mut builder =
        GraphBuilder::new().add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput));

    for track_idx in 0..track_count {
        // BUG-FIX: Avoid heap-allocating format!() in real-time context.
        builder = builder.add_node(AudioNode::new(
            NodeId((track_idx as u64) + 1),
            NodeKind::Track {
                name: String::new(),
            },
        ));
    }

    let mut wired_to_master = vec![false; track_count];
    for (track_idx, wired_master) in wired_to_master.iter_mut().enumerate().take(track_count) {
        let from = NodeId((track_idx as u64) + 1);

        // ── Main Routing Edge ──
        if let Some(Some(dest_idx)) = routing.get(track_idx) {
            if *dest_idx < track_count && *dest_idx != track_idx {
                let to = NodeId((*dest_idx as u64) + 1);
                // AUD-018 FIX: Use add_edge directly instead of clone-then-try.
                // GraphBuilder::clone() deep-copies all nodes/edges (heap allocation)
                // on EVERY edge. Adding directly and falling back on error is much cheaper.
                builder = match builder.add_edge(from, to) {
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
            } else {
                *wired_master = true;
            }
        } else {
            *wired_master = true;
        }

        // ── Sidechain Dependencies ──
        // If track A depends on track B as a sidechain source, B MUST be rendered
        // before A. We add edges B -> A to ensure this topological order.
        if let Some(sources) = sidechains.get(track_idx) {
            for maybe_source in sources {
                if let Some(source_idx) = maybe_source {
                    if *source_idx < track_count && *source_idx != track_idx {
                        let source_node = NodeId((*source_idx as u64) + 1);
                        // Sidechain edges: ordering-only, audio NOT mixed.
                        // NOTE: clone() is required here because the error path
                        // continues (doesn't return), so builder must be preserved.
                        // Unlike routing edges (which return on error), sidechain
                        // failures are non-fatal — we just skip the edge.
                        match builder.clone().add_edge_typed(
                            source_node,
                            from,
                            AudioEdgeKind::Sidechain,
                        ) {
                            Ok(next) => builder = next,
                            Err(err) => {
                                // IMPORTANT: If adding a sidechain edge creates a cycle,
                                // we ignore the sidechain edge to preserve stability.
                                log::warn!(
                                    "[Graph] sidechain edge {} -> {} ignored (cycle/error: {})",
                                    source_idx,
                                    track_idx,
                                    err
                                );
                            }
                        }
                    }
                }
            }
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

fn build_master_only_dag() -> AudioDag {
    dream_graph::dag::AudioDag::empty()
}

#[derive(Debug, Clone)]
pub struct PreparedGraphSnapshot {
    pub dag: AudioDag,
    pub plan: ExecutionPlan,
    pub track_count: usize,
    pub generation: u64,
}

impl PreparedGraphSnapshot {
    fn master_only() -> Self {
        let dag = build_master_only_dag();
        let plan = LiveGraph::from_dag(&dag)
            .map(|live| (*live.load_full()).clone())
            .unwrap_or_else(|_| ExecutionPlan {
                processing_order: Vec::new(),
                delay_compensation: Vec::new(),
                edge_delay_compensation: Vec::new(),
                parallel_stages: Vec::new(),
                parallelism_metrics: dream_graph::dag::ParallelismMetrics::default(),
            });
        Self {
            dag,
            plan,
            track_count: 0,
            generation: 0,
        }
    }
}

pub fn prepare_graph_snapshot_for_routing(
    track_count: usize,
    routing: &[Option<usize>],
    sidechains: &[Vec<Option<usize>>],
    generation: u64,
) -> PreparedGraphSnapshot {
    let safe_track_count = track_count.min(MAX_TRACKS);
    let dag = build_dag_for_tracks(safe_track_count, routing, sidechains);
    let plan = LiveGraph::from_dag(&dag)
        .map(|live| (*live.load_full()).clone())
        .unwrap_or_else(|_| ExecutionPlan {
            processing_order: Vec::new(),
            delay_compensation: Vec::new(),
            edge_delay_compensation: Vec::new(),
            parallel_stages: Vec::new(),
            parallelism_metrics: dream_graph::dag::ParallelismMetrics::default(),
        });

    PreparedGraphSnapshot {
        dag,
        plan,
        track_count: safe_track_count,
        generation,
    }
}

pub struct SharedPreparedGraphSnapshot {
    inner: ArcSwap<PreparedGraphSnapshot>,
    generation: std::sync::atomic::AtomicU64,
}

impl SharedPreparedGraphSnapshot {
    pub fn new() -> Self {
        Self {
            inner: ArcSwap::from_pointee(PreparedGraphSnapshot::master_only()),
            generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub fn rebuild_for_routing(
        &self,
        track_count: usize,
        routing: &[Option<usize>],
        sidechains: &[Vec<Option<usize>>],
    ) {
        // AUD-006 FIX: Use fetch_add for atomic generation increment.
        // The previous load + saturating_add + store was non-atomic — two
        // concurrent calls could read the same generation, causing the
        // audio thread to miss the second snapshot update.
        let generation = self
            .generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
        let snapshot = prepare_graph_snapshot_for_routing(track_count, routing, sidechains, generation);
        // AE-006 FIX: Store snapshot atomically. The ArcSwap::store is already
        // Release-ordered internally. The generation from fetch_add is already
        // published — no need for a second store which created a TOCTOU window
        // where a reader could see incremented generation but stale snapshot.
        self.inner.store(Arc::new(snapshot));
    }

    pub fn load(&self) -> arc_swap::Guard<Arc<PreparedGraphSnapshot>> {
        self.inner.load()
    }
}

impl Default for SharedPreparedGraphSnapshot {
    fn default() -> Self {
        Self::new()
    }
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
    /// BUG-005 FIX: Uses ArcSwap::rcu() for atomic read-copy-update.
    /// The previous load_full()/clone()/store() pattern was NOT atomic —
    /// concurrent Tauri commands could race on the Vec, losing one update.
    pub fn set_track_sample(&self, track_index: usize, sample: Option<Arc<ClipAudio>>) {
        self.inner.rcu(|current| {
            let mut samples = (**current).clone();
            if track_index >= samples.len() {
                samples.resize(track_index + 1, None);
            }
            samples[track_index] = sample.clone();
            Arc::new(samples)
        });
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

// ── Shared Sample Rack Samples (LOCK-FREE) ─────────────────────────────

/// Per-track sample rack samples.
///
/// Holds an array of 16 optional clips for each track's Sample Rack.
/// **Wait-free** via `ArcSwap`.
pub struct SharedSampleRackSamples {
    inner: ArcSwap<Vec<[Option<Arc<ClipAudio>>; 16]>>,
}

impl SharedSampleRackSamples {
    pub fn new() -> Self {
        Self {
            inner: ArcSwap::from_pointee(Vec::new()),
        }
    }

    pub fn set_track_pad_sample(&self, track_index: usize, pad_index: usize, sample: Option<Arc<ClipAudio>>) {
        if pad_index >= 16 { return; }
        self.inner.rcu(|current| {
            let mut samples = (**current).clone();
            if track_index >= samples.len() {
                let empty_pad_array: [Option<Arc<ClipAudio>>; 16] = Default::default();
                samples.resize(track_index + 1, empty_pad_array);
            }
            samples[track_index][pad_index] = sample.clone();
            Arc::new(samples)
        });
    }

    pub fn load(&self) -> arc_swap::Guard<Arc<Vec<[Option<Arc<ClipAudio>>; 16]>>> {
        self.inner.load()
    }

    pub fn swap(&self, samples: Vec<[Option<Arc<ClipAudio>>; 16]>) {
        self.inner.store(Arc::new(samples));
    }
}

impl Default for SharedSampleRackSamples {
    fn default() -> Self {
        Self::new()
    }
}

// ── Constants ───────────────────────────────────────────────────────────

/// Default test tone frequency (A4 = 440 Hz).
const DEFAULT_FREQUENCY: f32 = 440.0;

/// Output amplitude for test tone (0.0 – 1.0). Conservative to protect ears.
const TEST_TONE_AMPLITUDE: f32 = 0.25;

/// AUD-049: FREQ_SMOOTHING removed — replaced with sample-rate-dependent
/// coefficient computed at usage site (see AUD-010 fix).

#[derive(Clone)]
struct MidiNoteMapState {
    active_notes: Vec<ActiveMappedNote>,
    rng_state: u32,
}

#[derive(Clone, Copy)]
struct ActiveMappedNote {
    uid: u64,
    _src_pitch: u8,
    mapped_pitch: u8,
}

/// AUD-051 FIX: Document RNG seed — xorshift32 requires a non-zero odd seed.
/// Value 0xA5A5_1337 chosen for good bit distribution and non-zero guarantee.
impl Default for MidiNoteMapState {
    fn default() -> Self {
        Self {
            active_notes: Vec::with_capacity(128), // AUD-071 FIX: 128 is max polyphony, not 256
            rng_state: 0xA5A5_1337, // xorshift32 seed (must be non-zero)
        }
    }
}

/// Per-track active note tracker for VST3 plugins.
///
/// Unlike the sampler engine which has its own voice management,
/// VST3 plugins need explicit note-off tracking so we can flush
/// all active notes on transport stop/seek.
#[derive(Clone)]
struct Vst3NoteTracker {
    /// Active notes: (mapped_pitch, channel) pairs currently held.
    active: Vec<(u8, u8)>,
    /// RNG state for random MIDI FX (xorshift32, same algorithm as sampler path).
    rng_state: u32,
}

impl Default for Vst3NoteTracker {
    fn default() -> Self {
        Self {
            active: Vec::with_capacity(128),
            // AUD-052 FIX: Document different seed — xorshift32 seeds differ
            // per-tracker so two tracks with identical MIDI FX don't produce
            // the same "random" pitch sequence.
            rng_state: 0xB7B7_CAFE, // xorshift32 seed (must be non-zero, distinct from sampler)
        }
    }
}

impl Vst3NoteTracker {
    /// Register an active note-on. Prevents duplicates by
    /// releasing the previous instance of the same pitch first.
    /// Returns an optional note-off event if a duplicate was found.
    fn note_on(&mut self, pitch: u8, channel: u8) -> Option<MidiEvent> {
        // Duplicate protection: if same pitch is already active, release it first.
        if let Some(pos) = self.active.iter().position(|&(p, c)| p == pitch && c == channel) {
            self.active.swap_remove(pos);
            // Return a note-off for the duplicate so the plugin can clean up.
            Some(MidiEvent::note_off(0, channel, pitch, 0))
        } else {
            None
        }
        // Push is done by the caller after sending the note-on.
        // BUG-S1-06 FIX: Caller must check capacity via can_push() before pushing.
    }

    /// BUG-S1-06 FIX: Guard against unbounded growth. 256 simultaneous
    /// notes per track is already beyond any legitimate polyphony.
    /// Without this, a stuck VST3 or rapid seek could leak entries forever.
    #[inline]
    fn can_push(&self) -> bool {
        self.active.len() < 256
    }

    /// Register a note-off — remove from active tracking.
    fn note_off(&mut self, pitch: u8, channel: u8) {
        if let Some(pos) = self.active.iter().position(|&(p, c)| p == pitch && c == channel) {
            self.active.swap_remove(pos);
        }
    }

    /// Flush all active notes: generates note-off events for every
    /// currently active note + CC 120 (All Sound Off) + CC 123 (All Notes Off)
    /// on ALL channels that had active notes.
    /// CC120 immediately kills ALL audio output including reverb
    /// and delay tails — essential for synths like Serum with internal FX.
    fn flush_all(&mut self, out: &mut Vec<MidiEvent>) {
        // AUD-011 FIX: Collect unique channels to send CC on all active channels,
        // not just channel 0. Notes on channel 1+ would be missed by a channel-0-only flush.
        let mut seen_channels = 0u16; // bitmask of channels 0-15
        for &(pitch, channel) in &self.active {
            out.push(MidiEvent::note_off(0, channel, pitch, 0));
            seen_channels |= 1u16 << (channel as u16 & 0x0F);
        }
        self.active.clear();
        // Always include channel 0 even if no notes were on it.
        seen_channels |= 1;
        for ch in 0..16u8 {
            if (seen_channels & (1u16 << ch)) != 0 {
                // CC 120 = All Sound Off — immediately silences all audio,
                // including synth tails, reverbs, and delays (enterprise standard).
                out.push(MidiEvent::cc(0, ch, 120, 0));
                // CC 123 = All Notes Off — releases all held notes.
                out.push(MidiEvent::cc(0, ch, 123, 0));
            }
        }
    }

    /// Clears all tracked active notes without sending note-off events.
    /// Used when the plugin instance is being destroyed or completely reset.
    fn clear(&mut self) {
        self.active.clear();
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

    /// Resolved stream sample rate (Hz) of the active output device config.
    pub sample_rate_hz: u32,

    /// Estimated output latency in sample frames.
    ///
    /// Derived from the cpal `StreamConfig::buffer_size`. When the OS uses
    /// a "Default" (variable) buffer size, we fall back to a conservative
    /// 512-frame estimate (≈10.7ms at 48kHz, typical macOS CoreAudio default).
    ///
    /// The frontend subtracts this from the MasterClock position so the
    /// visual playhead aligns with the audio actually reaching the speakers.
    pub output_latency_frames: u32,

    /// Resolved output device name that the stream is actually bound to.
    pub output_device_name: String,

    /// Lock-free consumer for spectrum analyzer data.
    /// The audio thread pushes master mono output samples into the paired producer.
    /// The Tauri host reads from this consumer to compute FFT for the EQ display.
    pub spectrum_consumer: Option<rtrb::Consumer<f32>>,
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
    sidechain_snapshot: Arc<SharedSidechainSnapshot>,
    external_fx_snapshot: Arc<SharedExternalFxSnapshot>,
    automation_snapshot: Arc<SharedAutomationSnapshot>,
    sampler_samples: Arc<SharedSamplerSamples>,
    sample_rack_samples: Arc<SharedSampleRackSamples>,
    prepared_graph_snapshot: Arc<SharedPreparedGraphSnapshot>,
    rt_debug_stats: Arc<SharedRtDebugStats>,
    plugin_host: Arc<Mutex<PluginHost>>,
    preview_buffer: Arc<ArcSwap<Option<Vec<f32>>>>,
    preview_cursor: Arc<AtomicUsize>,
    preview_source_sr: Arc<AtomicU32>,
) -> Result<AudioStreamHandle, AudioDriverError> {
    start_audio_thread_on_device(
        consumer,
        clock,
        meter_bank,
        clip_pool,
        clip_snapshot,
        midi_snapshot,
        routing_snapshot,
        sidechain_snapshot,
        external_fx_snapshot,
        automation_snapshot,
        sampler_samples,
        sample_rack_samples,
        prepared_graph_snapshot,
        rt_debug_stats,
        plugin_host,
        preview_buffer,
        preview_cursor,
        preview_source_sr,
        None,
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
    sidechain_snapshot: Arc<SharedSidechainSnapshot>,
    external_fx_snapshot: Arc<SharedExternalFxSnapshot>,
    automation_snapshot: Arc<SharedAutomationSnapshot>,
    sampler_samples: Arc<SharedSamplerSamples>,
    sample_rack_samples: Arc<SharedSampleRackSamples>,
    prepared_graph_snapshot: Arc<SharedPreparedGraphSnapshot>,
    rt_debug_stats: Arc<SharedRtDebugStats>,
    plugin_host: Arc<Mutex<PluginHost>>,
    preview_buffer: Arc<ArcSwap<Option<Vec<f32>>>>,
    preview_cursor: Arc<AtomicUsize>,
    preview_source_sr: Arc<AtomicU32>,
    preferred_output_device: Option<&str>,
    stream_error_tx: Option<std::sync::mpsc::SyncSender<String>>,
) -> Result<AudioStreamHandle, AudioDriverError> {
    // ── 1. Host & Device ────────────────────────────────────────────
    let host = cpal::default_host();
    info!("Audio host: {:?}", host.id());

    let requested_device_name = preferred_output_device.map(str::trim).filter(|s| !s.is_empty());

    let device = if let Some(wanted_name) = requested_device_name {
        if wanted_name.eq_ignore_ascii_case("Default Output") {
            host.default_output_device()
                .ok_or(AudioDriverError::NoOutputDevice)?
        } else {
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
                .or_else(|| {
                    warn!(
                        "Requested output device '{}' not found; falling back to system default",
                        wanted_name
                    );
                    host.default_output_device()
                })
                .ok_or(AudioDriverError::NoOutputDevice)?
        }
    } else {
        host.default_output_device()
            .ok_or(AudioDriverError::NoOutputDevice)?
    };

    let device_name = device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| String::from("Unknown Device"));

    if let Some(wanted) = requested_device_name
        && !wanted.eq_ignore_ascii_case("Default Output")
        && wanted != device_name
    {
        warn!(
            "Output device '{}' resolved to '{}'",
            wanted, device_name
        );
    }

    info!("Output device: {}", device_name);

    // ── 2. Config ───────────────────────────────────────────────────
    let default_config = device
        .default_output_config()
        .map_err(|e| AudioDriverError::DefaultConfigError(e.to_string()))?;

    let supported_config = if default_config.sample_format() == cpal::SampleFormat::F32 {
        default_config
    } else {
        let fallback = device
            .supported_output_configs()
            .ok()
            .and_then(|mut ranges| {
                ranges.find_map(|range| {
                    if range.sample_format() != cpal::SampleFormat::F32 {
                        return None;
                    }
                    let desired_rate = default_config.sample_rate();
                    let clamped_rate = desired_rate
                        .clamp(range.min_sample_rate(), range.max_sample_rate());
                    Some(range.with_sample_rate(clamped_rate))
                })
            });

        if let Some(cfg) = fallback {
            warn!(
                "Default output sample format {:?} unsupported by engine, using f32 fallback",
                default_config.sample_format()
            );
            cfg
        } else {
            return Err(AudioDriverError::DefaultConfigError(format!(
                "No f32 output stream config available for device '{}'. Current engine supports f32 output only.",
                device_name
            )));
        }
    };

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
        MAX_TRACKS,
        sample_rate_f64,
        channels,
        Arc::clone(&meter_bank),
    );

    // ── Spectrum analyzer ring buffer (lock-free: audio thread → UI thread) ──
    let (spectrum_producer, spectrum_consumer) = rtrb::RingBuffer::new(8192);
    render_ctx.spectrum_producer = Some(spectrum_producer);

    // AUD-057/058 FIX: Use named constants instead of hardcoded magic numbers.
    let mut graph_renderer = GraphRenderer::new(MAX_TRACKS, MAX_BUFFER_FRAMES);
    let prepared_graph = prepared_graph_snapshot.load();
    // AUD-016: graph_dag/plan clone() allocates inside the closure that builds
    // the callback — this is OK because it happens BEFORE the first callback
    // fires. Inside the callback, clones only happen on generation change.
    let mut graph_dag = prepared_graph.dag.clone();
    let mut graph_plan = prepared_graph.plan.clone();
    let mut graph_out_left = vec![0.0f32; MAX_BUFFER_FRAMES];
    let mut graph_out_right = vec![0.0f32; MAX_BUFFER_FRAMES];
    let mut post_sum_processing_mask = vec![false; MAX_TRACKS];
    let mut skip_device_chain_mask = vec![false; MAX_TRACKS];
    graph_renderer.update_plan(&graph_plan, &graph_dag);
    let mut graph_last_generation = prepared_graph.generation;
    let mut graph_last_track_count = prepared_graph.track_count;

    // ── 4. Test tone state (fallback when no clips loaded) ──────────
    let mut test_tone_phase: f64 = 0.0;
    let mut test_tone_current_freq: f32 = DEFAULT_FREQUENCY;
    let mut test_tone_target_freq: f32 = DEFAULT_FREQUENCY;
    let mut test_tone_enabled: bool = false;

    // ── 5. Playback state ───────────────────────────────────────────
    let mut is_playing: bool = false;
    // BUG-035 FIX: Removed misleading underscore — BPM IS used in TransportContext.
    let mut bpm: f64 = 120.0;
    let mut master_gain_target: f32 = 1.0;
    let mut master_gain_current: f32 = 1.0;
    // AUD-035/036 FIX: Documented master gain system.
    // master_gain_target: set by EngineCommand::SetMasterGain, clamped [0.0, 2.0].
    // master_gain_current: exponentially smoothed toward target each frame.
    // master_gain_smooth: one-pole coefficient for ~5ms time constant.
    //   Formula: 1.0 - exp(-1/(tau * sr)) where tau = 5ms.
    //   At 44.1kHz: ~0.00455, at 96kHz: ~0.00208.
    let master_gain_smooth: f32 = 1.0 - (-1.0_f64 / (0.005 * sample_rate_f64)).exp() as f32;
    // per-track disable/solo state (used for output-enable calculation)
    let mut track_disabled: [bool; MAX_TRACKS] = [false; MAX_TRACKS];
    let mut track_soloed: [bool; MAX_TRACKS] = [false; MAX_TRACKS];
    let mut any_solo: bool = false;
    // BUG-026 FIX: Persist the last loop region so SetLoopEnabled(true) can restore it.
    let mut last_loop_region: Option<LoopRegion> = None;

    // ── 6. Per-track sampler engines ─────────────────────────────────
    // Pre-allocated sampler engines (one per track max).
    // Each engine starts with no sample loaded — it becomes active
    // when the user assigns a sample via SharedSamplerSamples.
    let mut sampler_engines: Vec<SamplerEngine> = (0..MAX_TRACKS)
        .map(|_| SamplerEngine::new(sample_rate_f64))
        .collect();
    let mut sample_rack_engines: Vec<SampleRackEngine> = (0..MAX_TRACKS)
        .map(|_| SampleRackEngine::new(sample_rate_f64))
        .collect();
    let mut midi_note_states: Vec<MidiNoteMapState> =
        vec![MidiNoteMapState::default(); MAX_TRACKS];
    // Scratch buffers for sampler output (reused each buffer, zero-alloc)
    let mut external_left = vec![0.0f32; MAX_BUFFER_FRAMES];
    let mut external_right = vec![0.0f32; MAX_BUFFER_FRAMES];
    #[derive(Clone, Copy)]
    enum DeferredTopologyCmd {
        Add {
            track_index: u16,
            slot_index: u8,
            effect_type: u8,
        },
        Remove {
            track_index: u16,
            slot_index: u8,
        },
    }
    let mut deferred_topology: VecDeque<DeferredTopologyCmd> = VecDeque::with_capacity(1024);
    let mut midi_schedule_scratch: Vec<ScheduledNote> = Vec::with_capacity(2048);
    let mut midi_schedule_tmp: Vec<ScheduledNote> = Vec::with_capacity(2048);
    // AUD-072 FIX: Reduced from 16384 to 2048. Typical MIDI density is <100
    // events per buffer. 16384 wastes 120KB per Vec allocation.
    let mut midi_events_scratch: Vec<(usize, u8, u8, u8, u64)> = Vec::with_capacity(2048);
    // Pre-allocated scratch buffer for converting scheduled MIDI events to MidiEvent
    // objects that external VST3 plugins receive.
    let mut vst3_midi_scratch: Vec<MidiEvent> = Vec::with_capacity(4096);
    // Per-track active-note tracking for VST3 plugins (flush on stop/seek).
    let mut vst3_note_trackers: Vec<Vst3NoteTracker> =
        vec![Vst3NoteTracker::default(); MAX_TRACKS];
    // BUG-012 FIX: Per-track flush instead of global flag.
    // The previous global flag killed notes on ALL VST3 instruments when only
    // one track needed flushing (e.g. single-track bypass/stop).
    let mut vst3_flush_per_track: [bool; MAX_TRACKS] = [false; MAX_TRACKS];
    // Per-track real-time MIDI queue: keyboard/preview NoteOn/Off events
    // are pushed here in the command loop and drained into vst3_midi_scratch
    // during the graph pass so external VST3 instruments (Serum, etc.)
    // receive real-time MIDI alongside clip events.
    let mut vst3_rt_midi_queue: Vec<Vec<MidiEvent>> =
        (0..MAX_TRACKS).map(|_| Vec::with_capacity(32)).collect();
    // Track which samples were last loaded per-track to avoid re-assigning
    // BUG-068 FIX: Removed dead variable _last_sample_generation (was never read).

    let stream = device
        .build_output_stream(
            &config,
            // RT_CALLBACK_START
            // ┌──────────────────────────────────────────────────────┐
            // │  THE HOT PATH — Real-Time Audio Callback             │
            // │  NO allocations. NO locks (except Arc::clone which   │
            // │  is atomic). NO I/O. NO panics.                      │
            // └──────────────────────────────────────────────────────┘
            move |data: &mut [f32], _info: &cpal::OutputCallbackInfo| {
                let mut run_callback = || {
                        // BUG-050 FIX: Only call Instant::now() when debug stats
                        // are active. mach_absolute_time() is a ~20ns syscall
                        // that's unnecessary overhead in production builds.
                        let callback_start = if rt_debug_stats.is_enabled() {
                            Some(Instant::now())
                        } else {
                            None
                        };
                        // ═══════════════════════════════════════════════════════════════
                        // RT-Armor: Zero-Alloc, Panic-Safe, Denormal-Free Audio Pipeline
                        // ═══════════════════════════════════════════════════════════════

                        // ── A0. Denormal Protection (DAZ/FTZ) ────────────────────────
                        // MEGA-03 FIX: Save original hardware FPU state so we can restore it.
                        // Mutating the OS audio thread's FPU state permanently breaks IEEE-754
                        // for the entire host process (logic pro, bitwig, ableton, etc.)
                        #[cfg(target_arch = "x86_64")]
                        let original_csr = unsafe {
                            use std::arch::x86_64::*;
                            let csr = _mm_getcsr();
                            _mm_setcsr(csr | 0x8040); // DAZ + FTZ bits
                            csr
                        };
                        
                        #[cfg(target_arch = "aarch64")]
                        let original_fpcr = unsafe {
                            let mut fpcr: u64;
                            std::arch::asm!("mrs {}, fpcr", out(reg) fpcr);
                            let orig = fpcr;
                            fpcr |= 1 << 24; // FZ bit
                            std::arch::asm!("msr fpcr, {}", in(reg) fpcr);
                            orig
                        };

                        let frame_count = data.len() / channels.max(1);

                        // Baseline all track meters to silence each callback, with
                        // peak-decay persistence. Active signal paths below will lift
                        // meters back up for tracks that actually output audio.
                        let baseline_decay = peak_decay_for_block(sample_rate_f64, frame_count);
                        for track_idx in 0..render_ctx.meter_bank.track_count() {
                            if let Some((meter_l, meter_r)) = render_ctx.meter_bank.track(track_idx) {
                                meter_l.store_rms(METER_FLOOR_DB);
                                meter_r.store_rms(METER_FLOOR_DB);
                                meter_l.store_peak_decay(METER_FLOOR_DB, baseline_decay);
                                meter_r.store_peak_decay(METER_FLOOR_DB, baseline_decay);
                            }
                        }

                        // ── A1. Drain command queue (bounded) ─────────────────────
                        // Bound per-callback command work so UI command bursts
                        // cannot starve audio rendering and cause dropouts.
                        // BUG-040 FIX: Adaptive command budget based on frame_count.
                        // At 128 frames (2.7ms), original 512 commands could use 18%
                        // of the budget. Now scales: min 64, max 512.
                        let max_commands = (frame_count * 4).clamp(64, 512);
                        let mut commands_processed = 0usize;
                        let mut pending_track_volume: [Option<f32>; MAX_TRACKS] = [None; MAX_TRACKS];
                        let mut pending_track_pan: [Option<f32>; MAX_TRACKS] = [None; MAX_TRACKS];
                        let mut pending_track_mute: [Option<bool>; MAX_TRACKS] = [None; MAX_TRACKS];
                        let mut pending_track_solo: [Option<bool>; MAX_TRACKS] = [None; MAX_TRACKS];
                        for _ in 0..max_commands {
                            let Ok(cmd) = consumer.pop() else {
                                break;
                            };
                            commands_processed += 1;
                            match cmd {
                                EngineCommand::SetPlay(play) => {
                                    is_playing = play;
                                    render_ctx.playhead.set_advancing(play);
                                    if !play {
                                        for idx in 0..sampler_engines.len() {
                                            sampler_engines[idx].all_notes_off();
                                            sample_rack_engines[idx].all_notes_off();
                                            // DEEP-01 FIX: Reuse existing Vec allocation instead of
                                            // constructing a new MidiNoteMapState (which heap-allocates
                                            // Vec::with_capacity(128) and drops the old Vec on the RT thread).
                                            midi_note_states[idx].active_notes.clear();
                                            midi_note_states[idx].rng_state = 0xA5A5_1337;
                                        }
                                        // BUG-012 FIX: Flush all tracks on transport stop.
                                        vst3_flush_per_track.fill(true);
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
                                    // BUG-056 FIX: Clamp negative seek to 0.
                                    let safe_frame = frame.max(0);
                                    clock.set_position(safe_frame);
                                    render_ctx.playhead.seek(safe_frame);
                                    // Prevent stuck/stacked notes after timeline jumps.
                                    for idx in 0..sampler_engines.len() {
                                        sampler_engines[idx].all_notes_off();
                                        sample_rack_engines[idx].all_notes_off();
                                        // DEEP-07 FIX: Same as DEEP-01 — reuse existing Vec allocation.
                                        midi_note_states[idx].active_notes.clear();
                                        midi_note_states[idx].rng_state = 0xA5A5_1337;
                                    }
                                    // BUG-012 FIX: Flush all tracks on seek.
                                    vst3_flush_per_track.fill(true);
                                }
                                EngineCommand::SetBpm(new_bpm) => {
                                    // AUD-088 FIX: Extended BPM range. DAWs support
                                    // extreme tempos for sound design (10 BPM) and
                                    // breakcore/speedcore (999 BPM).
                                    bpm = new_bpm.clamp(10.0, 999.0);
                                }
                                EngineCommand::SetBpmAndLoop {
                                    bpm: new_bpm,
                                    loop_enabled,
                                    loop_region,
                                } => {
                                    bpm = new_bpm.clamp(10.0, 999.0);
                                    if !loop_enabled {
                                        render_ctx.loop_region = None;
                                    } else if let Some((start, end)) = loop_region {
                                        let region = LoopRegion { start, end };
                                        last_loop_region = Some(region.clone());
                                        render_ctx.loop_region = Some(region);
                                    } else if let Some(ref lr) = last_loop_region {
                                        // enabled but no struct given = fallback to last known
                                        render_ctx.loop_region = Some(lr.clone());
                                    }
                                }
                                EngineCommand::SetTimelineSampleRate(sample_rate) => {
                                    render_ctx.set_timeline_sample_rate(sample_rate);
                                }
                                EngineCommand::SetLoopEnabled(enabled) => {
                                    // BUG-026 FIX: Store last loop region so re-enabling
                                    // restores it. Previously SetLoopEnabled(false) destroyed
                                    // the region irreversibly.
                                    if !enabled {
                                        render_ctx.loop_region = None;
                                    } else if let Some(ref lr) = last_loop_region {
                                        render_ctx.loop_region = Some(lr.clone());
                                    }
                                }
                                EngineCommand::SetLoopRegion { start, end } => {
                                    if end > start {
                                        let region = LoopRegion { start, end };
                                        last_loop_region = Some(region.clone());
                                        render_ctx.loop_region = Some(region);
                                    }
                                }
                                EngineCommand::SetTrackVolume {
                                    track_index,
                                    volume,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < MAX_TRACKS {
                                        pending_track_volume[idx] = Some(volume);
                                    }
                                }
                                EngineCommand::SetTrackPan { track_index, pan } => {
                                    let idx = track_index as usize;
                                    if idx < MAX_TRACKS {
                                        pending_track_pan[idx] = Some(pan);
                                    }
                                }
                                EngineCommand::SetMasterVolume { volume } => {
                                    master_gain_target = volume.clamp(0.0, 2.0);
                                }
                                EngineCommand::SetTrackMute { track_index, muted } => {
                                    let idx = track_index as usize;
                                    if idx < MAX_TRACKS {
                                        pending_track_mute[idx] = Some(muted);
                                    }
                                }
                                EngineCommand::SetTrackSolo {
                                    track_index,
                                    soloed,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < MAX_TRACKS {
                                        pending_track_solo[idx] = Some(soloed);
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
                                    if idx < sample_rack_engines.len() {
                                        sample_rack_engines[idx].note_on(pitch, velocity);
                                    }
                                    // Also queue for VST3 instruments on this track.
                                    // The graph pass will drain this into vst3_midi_scratch.
                                    // BUG-S1-02 FIX: Bounded push — drop events beyond 256 per
                                    // buffer to prevent unbounded Vec growth from MIDI storms.
                                    if idx < vst3_rt_midi_queue.len() && vst3_rt_midi_queue[idx].len() < 256 {
                                        vst3_rt_midi_queue[idx].push(
                                            MidiEvent::note_on(0, 0, pitch, velocity),
                                        );
                                    }
                                }
                                EngineCommand::SamplerNoteOff { track_index, pitch } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].note_off(pitch);
                                    }
                                    if idx < sample_rack_engines.len() {
                                        sample_rack_engines[idx].note_off(pitch);
                                    }
                                    // Also queue for VST3 instruments on this track.
                                    // BUG-S1-02 FIX: Same bounded push guard as note-on above.
                                    if idx < vst3_rt_midi_queue.len() && vst3_rt_midi_queue[idx].len() < 256 {
                                        vst3_rt_midi_queue[idx].push(
                                            MidiEvent::note_off(0, 0, pitch, 0),
                                        );
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
                                EngineCommand::SetSamplerWaveform {
                                    track_index,
                                    waveform,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx]
                                            .set_waveform(Waveform::from_u8(waveform));
                                    }
                                }
                                EngineCommand::SetSamplerOsc2Waveform {
                                    track_index,
                                    waveform,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx]
                                            .set_waveform2(Waveform::from_u8(waveform));
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
                                EngineCommand::SetSamplerFilterCutoff {
                                    track_index,
                                    cutoff,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_filter_cutoff(cutoff);
                                    }
                                }
                                EngineCommand::SetSamplerFilterResonance {
                                    track_index,
                                    resonance,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < sampler_engines.len() {
                                        sampler_engines[idx].set_filter_resonance(resonance);
                                    }
                                }
                                EngineCommand::SetSamplerFilterType {
                                    track_index,
                                    filter_type,
                                } => {
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
                                EngineCommand::SetSamplerLfoTarget {
                                    track_index,
                                    target,
                                } => {
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
                                EngineCommand::BypassInstrument {
                                    track_index,
                                    bypassed,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < render_ctx.track_slots.len() {
                                        render_ctx.track_slots[idx].instrument_bypassed = bypassed;
                                    }
                                    // Kill active voices when bypassing so sound stops immediately.
                                    if bypassed && idx < sampler_engines.len() {
                                        sampler_engines[idx].all_notes_off();
                                    }
                                    if bypassed && idx < sample_rack_engines.len() {
                                        sample_rack_engines[idx].all_notes_off();
                                    }
                                    // BUG-012 FIX: Only flush the bypassed track, not all.
                                    if bypassed && idx < MAX_TRACKS {
                                        vst3_flush_per_track[idx] = true;
                                    }
                                }
                                EngineCommand::SetSampleRackPadVolume { track_index, pad_index, volume } => {
                                    if let Some(engine) = sample_rack_engines.get_mut(track_index as usize) {
                                        if let Some(pad) = engine.pad_mut(pad_index as usize) {
                                            pad.volume = volume;
                                        }
                                    }
                                }
                                EngineCommand::SetSampleRackPadMute { track_index, pad_index, muted } => {
                                    // handled via composite volume in host, no-op in engine layer
                                }
                                EngineCommand::SetSampleRackPadSolo { track_index, pad_index, soloed } => {
                                    // handled via composite volume in host, no-op in engine layer
                                }
                                EngineCommand::SetSampleRackPadAdsr { track_index, pad_index, attack, decay, sustain, release } => {
                                    if let Some(engine) = sample_rack_engines.get_mut(track_index as usize) {
                                        if let Some(pad) = engine.pad_mut(pad_index as usize) {
                                            pad.set_adsr(AdsrParams {
                                                attack: attack as f64,
                                                decay: decay as f64,
                                                sustain: sustain as f64,
                                                release: release as f64,
                                            });
                                        }
                                    }
                                }
                                EngineCommand::SetSampleRackPadFilterCutoff { track_index, pad_index, cutoff } => {
                                    if let Some(engine) = sample_rack_engines.get_mut(track_index as usize) {
                                        if let Some(pad) = engine.pad_mut(pad_index as usize) {
                                            pad.set_filter_cutoff(cutoff);
                                        }
                                    }
                                }
                                EngineCommand::Shutdown => {
                                    is_playing = false;
                                    test_tone_phase = 0.0;
                                    // Kill all sampler voices on shutdown
                                    for engine in sampler_engines.iter_mut() {
                                        engine.all_notes_off();
                                    }
                                    // BUG-012 FIX: Flush all tracks on shutdown.
                                    vst3_flush_per_track.fill(true);
                                }
                                // ── Device Chain Commands ────────────────────
                                EngineCommand::AddDevice {
                                    track_index,
                                    slot_index,
                                    effect_type,
                                } => {
                                    if deferred_topology.len() >= 1024 {
                                        // RT-SAFETY: Never log from the audio callback.
                                        // Atomic counter avoids the global Mutex in log backends.
                                        rt_debug_stats.record_topology_overflow();
                                        let _ = deferred_topology.pop_front();
                                    }
                                    deferred_topology.push_back(DeferredTopologyCmd::Add {
                                        track_index,
                                        slot_index,
                                        effect_type,
                                    });
                                }
                                EngineCommand::RemoveDevice {
                                    track_index,
                                    slot_index,
                                } => {
                                    if deferred_topology.len() >= 1024 {
                                        rt_debug_stats.record_topology_overflow();
                                        let _ = deferred_topology.pop_front();
                                    }
                                    deferred_topology.push_back(DeferredTopologyCmd::Remove {
                                        track_index,
                                        slot_index,
                                    });
                                }
                                EngineCommand::BypassDevice {
                                    track_index,
                                    slot_index,
                                    bypassed,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < render_ctx.track_slots.len() {
                                        render_ctx.track_slots[idx]
                                            .device_chain
                                            .set_bypass(slot_index as usize, bypassed);
                                    }
                                }
                                EngineCommand::SetDeviceParam {
                                    track_index,
                                    slot_index,
                                    param_index,
                                    value,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < render_ctx.track_slots.len() {
                                        render_ctx.track_slots[idx].device_chain.set_param(
                                            slot_index as usize,
                                            param_index,
                                            value,
                                        );
                                    }
                                }
                            }
                        }

                        // Apply coalesced high-frequency mixer commands once per callback.
                        for i in 0..render_ctx.track_slots.len().min(MAX_TRACKS) {
                            if let Some(v) = pending_track_volume[i] {
                                render_ctx.track_slots[i].strip.set_volume(v);
                            }
                            if let Some(p) = pending_track_pan[i] {
                                render_ctx.track_slots[i].strip.set_pan(p);
                            }
                            if let Some(m) = pending_track_mute[i] {
                                track_disabled[i] = m;
                            }
                            if let Some(s) = pending_track_solo[i] {
                                track_soloed[i] = s;
                            }
                        }
                        if pending_track_solo.iter().take(render_ctx.track_slots.len()).any(|v| v.is_some())
                            || pending_track_mute.iter().take(render_ctx.track_slots.len()).any(|v| v.is_some())
                        {
                            let active_track_count = render_ctx.track_slots.len().min(MAX_TRACKS);

                            // ── GROUP-AWARE SOLO PROPAGATION ──
                            // Enterprise DAW behavior:
                            // 1. UP PROPAGATION: When a child track inside a group is soloed,
                            //    all parent groups up the routing chain must be implicitly enabled.
                            // 2. DOWN PROPAGATION: When a group track is soloed, all its children
                            //    must be implicitly enabled so the group produces sound.
                            let mut effective_soloed = [false; MAX_TRACKS];
                            effective_soloed[..MAX_TRACKS].copy_from_slice(&track_soloed[..MAX_TRACKS]);

                            let routing_now = routing_snapshot.load();
                            
                            // Pass 1: UP Propagation (Explicit child -> Implicit parents)
                            for child_idx in 0..active_track_count {
                                if !track_soloed[child_idx] {
                                    continue;
                                }
                                let mut visited = [0u64; 4]; // 256-bit bitmask
                                let mut current = child_idx;
                                loop {
                                    let word = current / 64;
                                    let bit = current % 64;
                                    if word >= 4 || (visited[word] & (1u64 << bit)) != 0 {
                                        break; // Cycle detected or out-of-bounds
                                    }
                                    visited[word] |= 1u64 << bit;
                                    match routing_now.get(current) {
                                        Some(Some(parent_idx)) if *parent_idx < active_track_count => {
                                            effective_soloed[*parent_idx] = true;
                                            current = *parent_idx;
                                        }
                                        _ => break, // Reached master or out-of-bounds
                                    }
                                }
                            }

                            // Pass 2: DOWN Propagation (Explicit parent -> Implicit children)
                            for descendant_idx in 0..active_track_count {
                                if effective_soloed[descendant_idx] {
                                    continue;
                                }
                                let mut visited = [0u64; 4];
                                let mut current = descendant_idx;
                                loop {
                                    let word = current / 64;
                                    let bit = current % 64;
                                    if word >= 4 || (visited[word] & (1u64 << bit)) != 0 {
                                        break;
                                    }
                                    visited[word] |= 1u64 << bit;
                                    match routing_now.get(current) {
                                        Some(Some(parent_idx)) if *parent_idx < active_track_count => {
                                            if track_soloed[*parent_idx] {
                                                effective_soloed[descendant_idx] = true;
                                                break;
                                            }
                                            current = *parent_idx;
                                        }
                                        _ => break,
                                    }
                                }
                            }

                            any_solo = effective_soloed.iter().take(active_track_count).any(|s| *s);
                            for i in 0..active_track_count {
                                let enabled = !track_disabled[i] && (!any_solo || effective_soloed[i]);
                                render_ctx.track_slots[i].strip.set_output_enabled(enabled);
                            }
                        }

                        // Apply at most one topology mutation per callback.
                        // This smooths expensive add/remove operations over time and
                        // prevents single-buffer CPU spikes during active playback.
                        if let Some(topology_cmd) = deferred_topology.pop_front() {
                            match topology_cmd {
                                DeferredTopologyCmd::Add {
                                    track_index,
                                    slot_index,
                                    effect_type,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < render_ctx.track_slots.len()
                                        && let Some(etype) = BuiltinEffectType::from_u8(effect_type)
                                    {
                                        render_ctx.track_slots[idx]
                                            .device_chain
                                            .add_device(slot_index as usize, etype);
                                    }
                                }
                                DeferredTopologyCmd::Remove {
                                    track_index,
                                    slot_index,
                                } => {
                                    let idx = track_index as usize;
                                    if idx < render_ctx.track_slots.len() {
                                        render_ctx.track_slots[idx]
                                            .device_chain
                                            .remove_device(slot_index as usize);
                                    }
                                }
                            }
                        }

                        // ── B-1. Prepare track strips for mixer automation ──────────────
                        // If a track has volume/pan automation lanes, we neutralize the
                        // strip mixer controls here and apply absolute sample-accurate
                        // mixer automation later on graph output buffers.
                        let automation = automation_snapshot.load();
                        let _sidechain_map = sidechain_snapshot.load();
                        let external_fx_map = external_fx_snapshot.load();
                        let needs_plugin_host = external_fx_map
                            .iter()
                            .any(|track_slots| track_slots.iter().any(|slot| slot.instance_id.is_some()));
                        // PERF-FIX: Bounded spin-try to reduce plugin host lock misses.
                        // The UI thread typically holds this lock for microseconds (parameter
                        // updates, plugin state capture). A few spin iterations (~100ns total)
                        // are enough to outlast the contention window, preventing the 1-buffer
                        // silence gap that caused audible clicks on every UI action.
                        // MAX_SPIN = 3: each spin_loop is ~ns, 3 iterations add <100ns
                        // worst-case, well within audio budget even at 64-sample buffers.
                        let mut plugin_host_guard = if needs_plugin_host {
                            const MAX_SPIN: usize = 3;
                            let mut guard = None;
                            for _ in 0..MAX_SPIN {
                                match plugin_host.try_lock() {
                                    Ok(g) => { guard = Some(g); break; }
                                    Err(_) => core::hint::spin_loop(),
                                }
                            }
                            guard
                        } else {
                            None
                        };
                        if needs_plugin_host && plugin_host_guard.is_none() {
                            rt_debug_stats.record_plugin_host_lock_miss();
                        }
                        let playhead_pos = render_ctx.playhead.position();
                        for (track_idx, lane) in automation.iter().enumerate() {
                            if track_idx >= render_ctx.track_slots.len() {
                                break;
                            }
                            if !lane.volume.is_empty() {
                                render_ctx.track_slots[track_idx].strip.set_volume(1.0);
                            }
                            if !lane.pan.is_empty() {
                                render_ctx.track_slots[track_idx].strip.set_pan(0.0);
                            }
                        }

                        // ── B0. Rebuild graph on routing/track topology changes ─────────
                        let snapshot = clip_snapshot.load();
                        let track_count = snapshot.len().min(MAX_TRACKS);
                        let prepared = prepared_graph_snapshot.load();
                        if prepared.generation != graph_last_generation
                            || prepared.track_count != graph_last_track_count
                        {
                            graph_dag = prepared.dag.clone();
                            graph_plan = prepared.plan.clone();
                            graph_renderer.update_plan(&graph_plan, &graph_dag);
                            graph_last_generation = prepared.generation;
                            graph_last_track_count = prepared.track_count;
                        }

                        // Tracks that receive routed input should apply strip/device
                        // processing after graph summing (bus/group semantics).
                        post_sum_processing_mask[..track_count].fill(false);
                        skip_device_chain_mask[..track_count].fill(false);
                        let routing_now = routing_snapshot.load();
                        for src_idx in 0..track_count {
                            if let Some(Some(dest_idx)) = routing_now.get(src_idx)
                                && *dest_idx < track_count
                            {
                                post_sum_processing_mask[*dest_idx] = true;
                            }
                        }

                        // When a track has entries in the external FX map,
                        // the graph render callback handles all device slots
                        // (internal + external) in user-defined chain order.
                        // Skip the bulk device_chain.process_stereo() in
                        // render_callback to prevent double-processing.
                        for (track_idx, runtime_slots) in external_fx_map.iter().enumerate() {
                            if track_idx < track_count && !runtime_slots.is_empty() {
                                skip_device_chain_mask[track_idx] = true;
                            }
                        }

                        // ── B. Source render pass (Clips & Samplers) ────
                        // Sync loaded samples from SharedSamplerSamples (once per buffer)
                        let samples_snapshot = sampler_samples.load();
                        for (idx, sample_opt) in samples_snapshot.iter().enumerate() {
                            if idx < sampler_engines.len() {
                                let engine = &mut sampler_engines[idx];
                                match (sample_opt, &engine.sample) {
                                    (Some(new_sample), Some(existing)) => {
                                        if !Arc::ptr_eq(new_sample, existing) {
                                            engine.set_sample(Arc::clone(new_sample));
                                        }
                                    }
                                    (Some(new_sample), None) => {
                                        engine.set_sample(Arc::clone(new_sample));
                                    }
                                    (None, Some(_)) => {
                                        engine.sample = None;
                                    }
                                    (None, None) => {}
                                }
                            }
                        }

                        let rack_samples_snapshot = sample_rack_samples.load();
                        for (idx, rack_opt) in rack_samples_snapshot.iter().enumerate() {
                            if idx < sample_rack_engines.len() {
                                let engine = &mut sample_rack_engines[idx];
                                for p in 0..16 {
                                    if let Some(pad) = engine.pad_mut(p) {
                                        let sample_opt = &rack_opt[p];
                                        match (sample_opt, &pad.sample) {
                                            (Some(new_sample), Some(existing)) => {
                                                if !Arc::ptr_eq(new_sample, existing) {
                                                    pad.set_sample(Arc::clone(new_sample));
                                                }
                                            }
                                            (Some(new_sample), None) => {
                                                pad.set_sample(Arc::clone(new_sample));
                                            }
                                            (None, Some(_)) => {
                                                pad.sample = None;
                                            }
                                            (None, None) => {}
                                        }
                                    }
                                }
                            }
                        }


                        let midi_snap = midi_snapshot.load();

                        let has_clips = !snapshot.is_empty()
                            && snapshot.iter().any(|track_clips| !track_clips.is_empty());

                        // ▸ Capture pre-advance playhead for MIDI scheduling.
                        let midi_playhead_pos = render_ctx.playhead.position();
                        let mut playhead_advanced_in_render = false;
                        if is_playing && has_clips {
                            // Disable test tone automatically when real clips exist
                            test_tone_enabled = false;

                            let pool_snap = clip_pool.load();

                            let render_frames = frame_count
                                .min(graph_out_left.len())
                                .min(graph_out_right.len());

                            render_ctx.read_audio_clips_into_tracks(
                                render_frames,
                                snapshot.as_ref(),
                                &pool_snap,
                            );
                            render_ctx.advance_playhead_by_frames(render_frames);
                            playhead_advanced_in_render = true;
                        } else {
                            // AUD-017 FIX: When stopped or no clips, only clear tracks
                            // that are actually in use. Previously cleared ALL 256 slots.
                            for slot in render_ctx.track_slots[..track_count].iter_mut() {
                                slot.clear(frame_count);
                            }
                        }

                        // ── B1. Sampler Render Pass (Source Generation) ──
                        // This renders internal samplers directly into slot buffers.
                        // This happens BEFORE the FX graph, so FX apply to sampler voices.
                        for track_idx in 0..track_count {
                            if track_idx >= midi_snap.len() || track_idx >= sampler_engines.len() {
                                continue;
                            }

                            // Skip sampler render entirely when instrument is bypassed.
                            // Buffers stay zeroed → no audio leaks to group bus.
                            if track_idx < render_ctx.track_slots.len()
                                && render_ctx.track_slots[track_idx].instrument_bypassed
                            {
                                continue;
                            }

                            let midi_track = &midi_snap[track_idx];
                            let engine = &mut sampler_engines[track_idx];
                            let rack = &mut sample_rack_engines[track_idx];
                            let slot = &mut render_ctx.track_slots[track_idx];

                            // Schedule MIDI clips for this track (gated by transport)
                            let midi_loop_region = render_ctx
                                .loop_region
                                .as_ref()
                                .map(|r| dream_clip_engine::LoopRegion::new(r.start, r.end));

                            midi_schedule_scratch.clear();
                            if is_playing {
                                MidiScheduler::fill_active_looped_with_tmp(
                                    &midi_track.clips,
                                    midi_playhead_pos,
                                    frame_count,
                                    midi_loop_region.as_ref(),
                                    &mut midi_schedule_scratch,
                                    &mut midi_schedule_tmp,
                                );
                            }

                            // TODO: Add real-time monitored MIDI here (bypass transport gate)

                            // Both sampler and rack use the same MIDI schedule buffer
                            let mut rack_active = false;
                            for p in 0..16 {
                                if let Some(pad) = rack.pad_mut(p) {
                                    if pad.has_active_voices() {
                                        rack_active = true;
                                        break;
                                    }
                                }
                            }

                            if midi_schedule_scratch.is_empty() && !engine.has_active_voices() && !rack_active {
                                continue;
                            }

                            let fc = frame_count.min(slot.buf_left.len());
                            let mut cursor = 0usize;
                            let fx = &midi_track.fx;
                            let note_state = &mut midi_note_states[track_idx];

                            // Convert scheduled notes to instantaneous events (NoteOn and NoteOff)
                            midi_events_scratch.clear();
                            for event in &midi_schedule_scratch {
                                if event.is_note_off {
                                    midi_events_scratch.push((
                                        event.buffer_offset_end.min(fc),
                                        0, // Note Off
                                        event.pitch,
                                        event.velocity,
                                        event.note_uid,
                                    ));
                                }
                                if event.is_note_on {
                                    midi_events_scratch.push((
                                        event.buffer_onset.min(fc),
                                        1, // Note On
                                        event.pitch,
                                        event.velocity,
                                        event.note_uid,
                                    ));
                                }
                            }
                            // RT-SAFETY: sort_unstable_by is zero-alloc (pdqsort).
                            // sort_by (merge sort) allocates a temp buffer on the heap.
                            midi_events_scratch.sort_unstable_by(|a, b| {
                                a.0.cmp(&b.0)
                                    .then_with(|| a.1.cmp(&b.1))  // note-off before note-on at same frame
                                    .then_with(|| a.2.cmp(&b.2))  // sort by pitch for determinism
                                    .then_with(|| a.4.cmp(&b.4))  // AUD-012 FIX: sort by UID for stable ordering
                            });

                            for &(frame, kind, pitch, velocity, event_uid) in &midi_events_scratch {
                                let seg = frame.saturating_sub(cursor).min(fc - cursor);
                                if seg > 0 {
                                    if engine.has_active_voices() {
                                        engine.render(
                                            &mut slot.buf_left[cursor..cursor + seg],
                                            &mut slot.buf_right[cursor..cursor + seg],
                                            seg,
                                        );
                                    }
                                    // Rack sums natively into the same buffers
                                    rack.render(
                                        &mut slot.buf_left[cursor..cursor + seg],
                                        &mut slot.buf_right[cursor..cursor + seg],
                                        seg,
                                    );
                                    cursor += seg;
                                } else if frame > cursor {
                                    cursor = frame;
                                }

                                if kind == 0 {
                                    // Note Off: Find the mapped pitch for this UID
                                    let off_pitch = if let Some(pos) = note_state
                                        .active_notes
                                        .iter()
                                        .rposition(|n| n.uid == event_uid)
                                    {
                                        let mapped = note_state.active_notes[pos].mapped_pitch;
                                        note_state.active_notes.swap_remove(pos);
                                        mapped
                                    } else {
                                        pitch
                                    };
                                    engine.note_off(off_pitch);
                                    rack.note_off(off_pitch);
                                } else {
                                    // Note On: Apply MIDI FX
                                    let mut pitch_i16 = pitch as i16;
                                    let mut velocity_i16 = velocity as i16;

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
                                        let mut x = note_state.rng_state;
                                        x ^= x << 13;
                                        x ^= x >> 17;
                                        x ^= x << 5;
                                        note_state.rng_state = x;
                                        let rnd01 = (x as f32) / (u32::MAX as f32);
                                        if rnd01 <= fx.random_chance.clamp(0.0, 1.0) {
                                            let span = fx.random_semitones.abs().max(1) as i16;
                                            let signed =
                                                ((x >> 8) % ((span as u32) * 2 + 1)) as i16 - span;
                                            mapped_pitch =
                                                clamp_midi_pitch(mapped_pitch as i16 + signed);
                                        }
                                    }

                                    if fx.velocity_enabled {
                                        velocity_i16 = ((velocity_i16 as f32) * fx.velocity_gain)
                                            .round()
                                            as i16
                                            + fx.velocity_offset as i16;
                                    }
                                    let mapped_velocity = velocity_i16.clamp(1, 127) as u8;

                                    // Guard against duplicate note-on (release previous if same UID)
                                    if let Some(pos) = note_state
                                        .active_notes
                                        .iter()
                                        .rposition(|n| n.uid == event_uid)
                                    {
                                        let previous = note_state.active_notes.swap_remove(pos);
                                        engine.note_off(previous.mapped_pitch);
                                        rack.note_off(previous.mapped_pitch);
                                    }

                                    note_state.active_notes.push(ActiveMappedNote {
                                        uid: event_uid,
                                        _src_pitch: pitch,
                                        mapped_pitch,
                                    });
                                    engine.note_on(mapped_pitch, mapped_velocity);
                                    rack.note_on(mapped_pitch, mapped_velocity);
                                }
                            }

                            if cursor < fc {
                                let rem = fc - cursor;
                                if engine.has_active_voices() {
                                    engine.render(
                                        &mut slot.buf_left[cursor..fc],
                                        &mut slot.buf_right[cursor..fc],
                                        rem,
                                    );
                                }
                                rack.render(
                                    &mut slot.buf_left[cursor..fc],
                                    &mut slot.buf_right[cursor..fc],
                                    rem,
                                );
                            }

                            // Safety cap: prevent active_notes from leaking unboundedly
                            // if note-off UIDs are missed (e.g., rapid seek edge cases).
                            // 128 simultaneous mapped notes is far beyond any legitimate
                            // polyphony — drain oldest entries if exceeded.
                            if note_state.active_notes.len() > 128 {
                                // AE-018 FIX: Drop the OLDEST notes (front of Vec) to keep
                                // the 128 most recent. Previous truncate(128) kept the oldest
                                // and dropped the newest — wrong priority.
                                let excess = note_state.active_notes.len() - 128;
                                note_state.active_notes.drain(..excess);
                            }

                            // ── Mark slot active so the metering loop in
                            //    render_callback sees MIDI/sampler tracks.
                            slot.active = true;
                        }

                        // Graph pass: route pre-rendered tracks through DAG.
                        // This UNIFIED block handles both playing (clips) and stopped (tails/real-time MIDI) states.
                        let n = frame_count;
                        graph_out_left[..n].fill(0.0);
                        graph_out_right[..n].fill(0.0);

                        // AE-013 FIX: Cache peak_decay_for_block ONCE before the graph
                        // closure. Previously called per-track inside the closure —
                        // exp() is ~5ns × 256 tracks = 1.3μs wasted per buffer.
                        let graph_peak_decay = peak_decay_for_block(sample_rate_f64, n);

                        graph_renderer.render(
                            &graph_plan,
                            &graph_dag,
                            n,
                            &mut graph_out_left[..n],
                            &mut graph_out_right[..n],
                            |node, left, right, count| {
                                // AUD-077 FIX: Named constant for master output node ID.
                                const MASTER_OUTPUT_ID: u64 = 0;
                                if node.id.0 == MASTER_OUTPUT_ID {
                                    return;
                                }
                                let track_idx = (node.id.0 - 1) as usize;
                                if track_idx < render_ctx.track_slots.len() {
                                    let (left_tracks, right_tracks) =
                                        render_ctx.track_slots.split_at_mut(track_idx);
                                    let Some((slot, right_tracks_rest)) =
                                        right_tracks.split_first_mut()
                                    else {
                                        return;
                                    };
                                    let c = count
                                        .min(slot.buf_left.len())
                                        .min(slot.buf_right.len());

                                    let post_sum_processed = post_sum_processing_mask
                                        .get(track_idx)
                                        .copied()
                                        .unwrap_or(false);

                                    if post_sum_processed {
                                        // ── Output gate for group/bus tracks ──────────
                                        // If this group track is muted or excluded by
                                        // solo, silence its contribution so downstream
                                        // graph nodes (MasterOutput) receive zero signal.
                                        // Metering still runs below (shows gray/silent).
                                        if slot.strip.is_output_enabled() {
                                            slot.strip.process_stereo(
                                                &mut left[..c],
                                                &mut right[..c],
                                            );
                                        } else {
                                            left[..c].fill(0.0);
                                            right[..c].fill(0.0);
                                        }
                                    }

                                    // Process external FX chain for ALL tracks
                                    if let Some(runtime_slots) = external_fx_map.get(track_idx) {
                                        let (fx_buf_l, fx_buf_r): (&mut [f32], &mut [f32]) =
                                            if post_sum_processed {
                                                (&mut left[..c], &mut right[..c])
                                            } else {
                                                (
                                                    &mut slot.buf_left[..c],
                                                    &mut slot.buf_right[..c],
                                                )
                                            };

                                        for (runtime_slot_idx, runtime_slot) in runtime_slots.iter().enumerate() {
                                            let source_slot = runtime_slot
                                                .sidechain_track_index
                                                .and_then(|src_idx| {
                                                    if src_idx < track_idx {
                                                        left_tracks.get(src_idx)
                                                    } else if src_idx == track_idx {
                                                        None
                                                    } else {
                                                        right_tracks_rest.get(
                                                            src_idx - track_idx - 1,
                                                        )
                                                    }
                                                });
                                            let (sc_l, sc_r) = source_slot
                                                .map(|src_slot| {
                                                    (
                                                        Some(&src_slot.buf_left[..c]),
                                                        Some(&src_slot.buf_right[..c]),
                                                    )
                                                })
                                                .unwrap_or((None, None));

                                            if let Some(internal_idx) =
                                                runtime_slot.internal_slot_index
                                            {
                                                slot.device_chain
                                                    .process_slot_with_sidechain(
                                                        internal_idx,
                                                        fx_buf_l,
                                                        fx_buf_r,
                                                        sc_l,
                                                        sc_r,
                                                        sample_rate_f64 as f32,
                                                    );
                                                continue;
                                            }

                                            if let Some(instance_id) =
                                                runtime_slot.instance_id
                                                && let Some(host) =
                                                    plugin_host_guard.as_deref_mut()
                                            {
                                                apply_external_plugin_param_automation_block(
                                                    host,
                                                    automation.get(track_idx),
                                                    runtime_slot,
                                                    runtime_slot_idx,
                                                    playhead_pos,
                                                );
                                                external_left[..c]
                                                    .copy_from_slice(fx_buf_l);
                                                external_right[..c]
                                                    .copy_from_slice(fx_buf_r);
                                                let main_inputs: [&[f32]; 2] =
                                                    [&fx_buf_l[..c], &fx_buf_r[..c]];
                                                let sc_pair = source_slot.map(|src| {
                                                    [
                                                        &src.buf_left[..c],
                                                        &src.buf_right[..c],
                                                    ]
                                                });
                                                let transport = TransportContext {
                                                    sample_rate: sample_rate_f64,
                                                    position_samples: playhead_pos,
                                                    tempo: bpm,
                                                    is_playing,
                                                    is_recording: false, // AUD-033: TODO — pass actual recording state when recording is implemented
                                                    // AUD-032: TODO — pass project time signature instead of hardcoded 4/4
                                                    time_sig_numerator: 4,
                                                    time_sig_denominator: 4,
                                                };
                                                let _ = host.set_transport_context(
                                                    instance_id,
                                                    transport,
                                                );

                                                // ENTERPRISE MIDI: Populate scratch with scheduled events for this track.
                                                // BUG-1/2/3 FIX: VST3 path now has:
                                                //   - All-Notes-Off flush on stop/seek/bypass
                                                //   - MIDI FX parity with sampler path
                                                //   - Active note tracking with duplicate protection
                                                vst3_midi_scratch.clear();

                                                // Drain real-time keyboard/preview MIDI into the
                                                // VST3 scratch buffer so instruments receive
                                                // live note events alongside clip MIDI.
                                                if track_idx < vst3_rt_midi_queue.len() {
                                                    vst3_midi_scratch.extend(
                                                        vst3_rt_midi_queue[track_idx].drain(..),
                                                    );
                                                }

                                                // BUG-012 FIX: Per-track flush instead of global flag.
                                                if vst3_flush_per_track.get(track_idx).copied().unwrap_or(false)
                                                    && track_idx < vst3_note_trackers.len() {
                                                    vst3_note_trackers[track_idx].flush_all(&mut vst3_midi_scratch);
                                                }

                                                if is_playing {
                                                    if let Some(midi_track) = midi_snap.get(track_idx) {
                                                        let fx = &midi_track.fx;
                                                        let midi_loop_region = render_ctx
                                                            .loop_region
                                                            .as_ref()
                                                            .map(|r| dream_clip_engine::LoopRegion::new(r.start, r.end));
                                                        midi_schedule_scratch.clear();
                                                        MidiScheduler::fill_active_looped_with_tmp(
                                                            &midi_track.clips,
                                                            midi_playhead_pos,
                                                            frame_count,
                                                            midi_loop_region.as_ref(),
                                                            &mut midi_schedule_scratch,
                                                            &mut midi_schedule_tmp,
                                                        );
                                                        let mut tracker = if track_idx < vst3_note_trackers.len() {
                                                            Some(&mut vst3_note_trackers[track_idx])
                                                        } else {
                                                            None
                                                        };
                                                        for event in &midi_schedule_scratch {
                                                            let offset_on = event.buffer_onset as i32;
                                                            let offset_off = event.buffer_offset_end as i32;

                                                            if event.is_note_off {
                                                                // BUG-2 FIX: Apply same pitch mapping for note-off
                                                                // so the off matches the mapped on.
                                                                let mut off_pitch_i16 = event.pitch as i16;
                                                                if fx.pitch_enabled {
                                                                    off_pitch_i16 += fx.pitch_semitones as i16;
                                                                }
                                                                let off_pitch = clamp_midi_pitch(off_pitch_i16);
                                                                let off_pitch = if fx.scale_enabled {
                                                                    quantize_to_scale(off_pitch, fx.scale_root, fx.scale_mask)
                                                                } else {
                                                                    off_pitch
                                                                };
                                                                vst3_midi_scratch.push(
                                                                    MidiEvent::note_off(offset_off, 0, off_pitch, 0),
                                                                );
                                                                // BUG-3 FIX: Deregister from tracker.
                                                                if let Some(ref mut t) = tracker {
                                                                    t.note_off(off_pitch, 0);
                                                                }
                                                            }

                                                            if event.is_note_on {
                                                                // BUG-2 FIX: Apply MIDI FX (pitch, velocity, scale, random)
                                                                // — same pipeline as sampler path.
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
                                                                    if let Some(ref mut t) = tracker {
                                                                        let mut x = t.rng_state;
                                                                        x ^= x << 13;
                                                                        x ^= x >> 17;
                                                                        x ^= x << 5;
                                                                        t.rng_state = x;
                                                                        let rnd01 = (x as f32) / (u32::MAX as f32);
                                                                        if rnd01 <= fx.random_chance.clamp(0.0, 1.0) {
                                                                            let span = fx.random_semitones.abs().max(1) as i16;
                                                                            let signed =
                                                                                ((x >> 8) % ((span as u32) * 2 + 1)) as i16 - span;
                                                                            mapped_pitch =
                                                                                clamp_midi_pitch(mapped_pitch as i16 + signed);
                                                                        }
                                                                    }
                                                                }

                                                                if fx.velocity_enabled {
                                                                    velocity_i16 = ((velocity_i16 as f32) * fx.velocity_gain)
                                                                        .round()
                                                                        as i16
                                                                        + fx.velocity_offset as i16;
                                                                }
                                                                let mapped_velocity = velocity_i16.clamp(1, 127) as u8;

                                                                // BUG-3 FIX: Duplicate protection + tracking.
                                                                if let Some(ref mut t) = tracker {
                                                                    if let Some(dup_off) = t.note_on(mapped_pitch, 0) {
                                                                        vst3_midi_scratch.push(MidiEvent::note_off(
                                                                            offset_on.saturating_sub(1).max(0),
                                                                            0,
                                                                            mapped_pitch,
                                                                            0,
                                                                        ));
                                                                        let _ = dup_off; // already handled via note_on return
                                                                    }
                                                                    // BUG-S1-06 FIX: Guard against unbounded active note growth.
                                                                    if t.can_push() {
                                                                        t.active.push((mapped_pitch, 0));
                                                                    }
                                                                }

                                                                vst3_midi_scratch.push(
                                                                    MidiEvent::note_on(
                                                                        offset_on,
                                                                        0,
                                                                        mapped_pitch,
                                                                        mapped_velocity,
                                                                    ),
                                                                );
                                                            }
                                                        }
                                                    }
                                                }

                                                // CRITICAL FIX: Sort MIDI events by sample_offset.
                                                // Events were pushed in scheduler iteration order
                                                // (note-off then note-on per ScheduledNote), NOT
                                                // by chronological sample_offset. VST3 plugins
                                                // expect events sorted by offset. Without this,
                                                // consecutive same-pitch notes (e.g. kick drums)
                                                // randomly fail because a note-off at offset 1000
                                                // appears before a note-on at offset 0.
                                                // Tie-break: note-off (0x80) before note-on (0x90)
                                                // at the same offset ensures clean retrigger.
                                                // RT-SAFETY: sort_unstable_by is zero-alloc (pdqsort).
                                                vst3_midi_scratch.sort_unstable_by(|a, b| {
                                                    a.sample_offset.cmp(&b.sample_offset)
                                                        .then_with(|| {
                                                            a.data[0].cmp(&b.data[0])
                                                        })
                                                });

                                                let mut out_slices: [&mut [f32]; 2] = [
                                                    &mut external_left[..c],
                                                    &mut external_right[..c],
                                                ];
                                                let _ = host.process_with_sidechain(
                                                    instance_id,
                                                    &main_inputs,
                                                    sc_pair
                                                        .as_ref()
                                                        .map(|pair| pair.as_slice()),
                                                    &mut out_slices,
                                                    c,
                                                    &vst3_midi_scratch,
                                                );
                                                fx_buf_l.copy_from_slice(
                                                    &external_left[..c],
                                                );
                                                fx_buf_r.copy_from_slice(
                                                    &external_right[..c],
                                                );
                                            } else {
                                                // No instance for this slot — passthrough.
                                                // fx_buf_l/r already contain the input audio.
                                            }
                                        }
                                    }

                                    // ── Output gate ──────────────────────────
                                    if !post_sum_processed {
                                        let route_to_graph = slot.strip.is_output_enabled();
                                        if route_to_graph {
                                            for i in 0..c {
                                                left[i] += slot.buf_left[i];
                                                right[i] += slot.buf_right[i];
                                            }
                                        }
                                    }

                                    if let Some(lane) = automation.get(track_idx) {
                                        apply_track_mixer_automation_sample_accurate(
                                            &mut left[..c],
                                            &mut right[..c],
                                            playhead_pos,
                                            (!lane.volume.is_empty())
                                                .then_some(lane.volume.as_slice()),
                                            (!lane.pan.is_empty())
                                                .then_some(lane.pan.as_slice()),
                                        );
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

                                    // ── Per-track metering (graph pass) ─────
                                    // Post-sum tracks: meter the mixed graph output.
                                    // Source tracks: meter after strip/FX processing
                                    //   (graph output = slot buffer summed into left/right).
                                    // AUD-008 FIX: Cache peak_decay outside the closure via
                                    // sample_rate_f64 captured from outer scope. peak_decay_for_block
                                    // involves exp() which is ~5ns — ~1.3μs overhead for 256 tracks.
                                    // AE-013 FIX: Use pre-cached graph_peak_decay from outer scope.
                                    if let Some((meter_l, meter_r)) =
                                        render_ctx.meter_bank.track(track_idx)
                                    {
                                        let (meter_src_l, meter_src_r): (&[f32], &[f32]) =
                                            if post_sum_processed {
                                                (&left[..c], &right[..c])
                                            } else {
                                                (&slot.buf_left[..c], &slot.buf_right[..c])
                                            };
                                        let rms_l = linear_to_db(compute_rms(meter_src_l));
                                        let rms_r = linear_to_db(compute_rms(meter_src_r));
                                        let peak_l = linear_to_db(compute_peak(meter_src_l));
                                        let peak_r = linear_to_db(compute_peak(meter_src_r));
                                        meter_l.store_rms(rms_l);
                                        meter_r.store_rms(rms_r);
                                        // MEGA-04 FIX: Do not double-decay active tracks inside the graph loop
                                        // since baseline_decay was already applied globally at start of block.
                                        meter_l.store_peak(peak_l.max(meter_l.load_peak()));
                                        meter_r.store_peak(peak_r.max(meter_r.load_peak()));
                                    }
                                }
                            },
                            |_node, _left, _right, _count| {},
                        );
                        // BUG-012 FIX: Clear per-track flush flags after processing.
                        // AUD-009 FIX: Only clear flags for tracks that were actually
                        // processed in this graph pass. Tracks beyond track_count
                        // should retain their flush flag until they become active.
                        vst3_flush_per_track[..track_count.min(MAX_TRACKS)].fill(false);

                        // ── Post-graph master external FX processing ─────────
                        // CRITICAL FIX: External VST3 plugins on the master bus
                        // (e.g. Muse, OTT, limiter) were never processed because:
                        //   1. The graph callback returns early for MASTER_OUTPUT_ID=0
                        //   2. master_track was separate from project.tracks
                        // Now that rebuild_external_fx_snapshot appends master FX
                        // at index track_count, process them on graph_out_left/right
                        // BEFORE interleaving to the output buffer.
                        let master_fx_idx = track_count; // master FX appended after all tracks
                        if let Some(master_slots) = external_fx_map.get(master_fx_idx) {
                            if !master_slots.is_empty() {
                                for runtime_slot in master_slots.iter() {
                                    // Internal effects on master bus (EQ, compressor, etc.)
                                    // are processed via the master's device_chain — skip them here.
                                    if runtime_slot.internal_slot_index.is_some() {
                                        // TODO: If we add per-master DeviceChain, process here.
                                        continue;
                                    }

                                    if let Some(instance_id) = runtime_slot.instance_id
                                        && let Some(host) = plugin_host_guard.as_deref_mut()
                                    {
                                        let c = n;
                                        let main_inputs: [&[f32]; 2] = [
                                            &graph_out_left[..c],
                                            &graph_out_right[..c],
                                        ];
                                        let transport = TransportContext {
                                            sample_rate: sample_rate_f64,
                                            position_samples: playhead_pos,
                                            tempo: bpm,
                                            is_playing,
                                            is_recording: false,
                                            time_sig_numerator: 4,
                                            time_sig_denominator: 4,
                                        };
                                        let _ = host.set_transport_context(
                                            instance_id,
                                            transport,
                                        );

                                        // Master bus plugins don't receive MIDI.
                                        // Use empty slice (zero-alloc) for RT-safety.
                                        let empty_midi: &[MidiEvent] = &[];

                                        let mut out_slices: [&mut [f32]; 2] = [
                                            &mut external_left[..c],
                                            &mut external_right[..c],
                                        ];
                                        let _ = host.process_with_sidechain(
                                            instance_id,
                                            &main_inputs,
                                            None, // No sidechain on master bus
                                            &mut out_slices,
                                            c,
                                            &empty_midi,
                                        );

                                        // Write processed output back to graph_out buffers.
                                        graph_out_left[..c].copy_from_slice(&external_left[..c]);
                                        graph_out_right[..c].copy_from_slice(&external_right[..c]);
                                    }
                                }
                            }
                        }

                        // ── BUG-R4/R5 FIX: Apply master gain to graph_out BEFORE metering ──
                        // Previously master gain was applied after interleave at L3157,
                        // causing: (1) master meters to show pre-fader levels (wrong), and
                        // (2) double soft_clip on hot signals (altered saturation character).
                        // Now master gain is per-sample smoothed into graph_out buffers first,
                        // so metering reflects the true output level.
                        for i in 0..n {
                            master_gain_current +=
                                (master_gain_target - master_gain_current) * master_gain_smooth;
                            graph_out_left[i] *= master_gain_current;
                            graph_out_right[i] *= master_gain_current;
                        }

                        // ── Master bus metering (post-FX, post-master-gain) ──────────
                        {
                            let decay = graph_peak_decay;
                            let rms_l = linear_to_db(compute_rms(&graph_out_left[..n]));
                            let rms_r = linear_to_db(compute_rms(&graph_out_right[..n]));
                            let peak_l = linear_to_db(compute_peak(&graph_out_left[..n]));
                            let peak_r = linear_to_db(compute_peak(&graph_out_right[..n]));
                            render_ctx.meter_bank.master_left().store_rms(rms_l);
                            render_ctx.meter_bank.master_right().store_rms(rms_r);
                            render_ctx.meter_bank.master_left().store_peak_decay(peak_l, decay);
                            render_ctx.meter_bank.master_right().store_peak_decay(peak_r, decay);
                        }



                        // BUG-R5 FIX: Interleave without soft_clip here — final soft_clip
                        // is applied once at the output stage below. Previously signal was
                        // soft-clipped twice (here + master gain loop), altering saturation.
                        for i in 0..n {
                            let base = i * channels;
                            if base >= data.len() { break; }
                            if channels == 1 {
                                // AUD-062 FIX: Equal-power mono fold.
                                data[base] = (graph_out_left[i] + graph_out_right[i]) * std::f32::consts::FRAC_1_SQRT_2;
                                continue;
                            }
                            data[base] = graph_out_left[i];
                            if base + 1 < data.len() {
                                data[base + 1] = graph_out_right[i];
                            }
                            for ch in 2..channels {
                                let idx = base + ch;
                                if idx < data.len() { data[idx] = 0.0; }
                            }
                        }

                        if test_tone_enabled && !is_playing {
                            // Test tone only when stopped (otherwise clips handle it)
                            // AUD-010 FIX: Use sample-rate-dependent smoothing so the
                            // frequency transition time is identical regardless of sample
                            // rate. FREQ_SMOOTHING was a fixed constant producing ~30ms
                            // at 44.1kHz but ~15ms at 96kHz.
                            let freq_smooth_coeff = 1.0 - (-1.0_f64 / (0.03 * sample_rate_f64)).exp() as f32;
                            for frame in data.chunks_exact_mut(channels) {
                                test_tone_current_freq += (test_tone_target_freq - test_tone_current_freq) * freq_smooth_coeff;
                                let phase_inc = test_tone_current_freq as f64 / sample_rate_f64;
                                let sample = (test_tone_phase * std::f64::consts::TAU).sin() as f32 * TEST_TONE_AMPLITUDE;
                                for ch in frame.iter_mut() { *ch = sample; }
                                test_tone_phase += phase_inc;
                                // BUG-014 FIX: Use fract() for safe phase wrapping.
                                // The previous `if >= 1.0 { -= 1.0 }` fails when phase_inc > 1.0
                                // (high frequencies / low sample rates), causing pitch aliasing.
                                test_tone_phase = test_tone_phase.fract();
                            }
                        }

                        if is_playing && !playhead_advanced_in_render {
                            render_ctx.advance_playhead_by_frames(frame_count);
                        }
                        // ── C. Mix preview audio (browser audition) ─────
                        // Preview plays regardless of transport state.
                        // 100% lock-free: ArcSwap::load() is wait-free.
                        // BUG-002 FIX: Preview data is interleaved stereo. Mix it
                        // respecting the actual output channel count to prevent
                        // misalignment on mono or surround devices.
                        //
                        // SSOT-FIX: Fractional cursor advancement for pitch-correct
                        // preview. When source SR ≠ device SR, advancing 1:1 causes
                        // pitch shift. Now advances by (source_sr / device_sr) per
                        // output frame, using linear interpolation for sub-sample positions.
                        let preview_snap = preview_buffer.load();
                        if let Some(ref preview_data) = **preview_snap {
                            let cursor = preview_cursor.load(Ordering::Relaxed);
                            let total = preview_data.len();
                            let preview_channels = 2usize; // preview is always stereo
                            let total_frames = total / preview_channels;
                            if cursor < total {
                                let cursor_frame = cursor / preview_channels;
                                // SSOT-FIX: Compute advancement rate.
                                // source_sr=0 means "same as device" (legacy fallback).
                                let src_sr = preview_source_sr.load(Ordering::Relaxed);
                                let rate = if src_sr > 0 && sample_rate > 0 {
                                    src_sr as f64 / sample_rate as f64
                                } else {
                                    1.0
                                };

                                if (rate - 1.0).abs() < 0.001 {
                                    // Fast path: 1:1 advancement (no interpolation needed)
                                    let preview_frames = total_frames.saturating_sub(cursor_frame);
                                    let mix_frames = preview_frames.min(frame_count);
                                    for f in 0..mix_frames {
                                        let p_idx = cursor + f * preview_channels;
                                        let d_idx = f * channels;
                                        if p_idx + 1 < total && d_idx < data.len() {
                                            let p_left = preview_data[p_idx];
                                            let p_right = preview_data[p_idx + 1];
                                            if channels == 1 {
                                                data[d_idx] += soft_clip((p_left + p_right) * std::f32::consts::FRAC_1_SQRT_2);
                                            } else {
                                                data[d_idx] += soft_clip(p_left);
                                                if d_idx + 1 < data.len() {
                                                    data[d_idx + 1] += soft_clip(p_right);
                                                }
                                            }
                                        }
                                    }
                                    let new_cursor = cursor + mix_frames * preview_channels;
                                    let _ = preview_cursor.compare_exchange(
                                        cursor,
                                        new_cursor,
                                        Ordering::Release,
                                        Ordering::Relaxed,
                                    );
                                } else {
                                    // SR-conversion path: fractional advancement with linear interp
                                    let mut src_pos = cursor_frame as f64;
                                    for f in 0..frame_count {
                                        if src_pos >= (total_frames - 1) as f64 {
                                            break;
                                        }
                                        let i0 = src_pos.floor() as usize;
                                        let i1 = (i0 + 1).min(total_frames - 1);
                                        let frac = (src_pos - i0 as f64) as f32;
                                        let inv = 1.0 - frac;

                                        let l0 = preview_data[i0 * 2];
                                        let l1 = preview_data[i1 * 2];
                                        let r0 = preview_data[i0 * 2 + 1];
                                        let r1 = preview_data[i1 * 2 + 1];

                                        let p_left = l0 * inv + l1 * frac;
                                        let p_right = r0 * inv + r1 * frac;

                                        let d_idx = f * channels;
                                        if d_idx < data.len() {
                                            if channels == 1 {
                                                data[d_idx] += soft_clip((p_left + p_right) * std::f32::consts::FRAC_1_SQRT_2);
                                            } else {
                                                data[d_idx] += soft_clip(p_left);
                                                if d_idx + 1 < data.len() {
                                                    data[d_idx + 1] += soft_clip(p_right);
                                                }
                                            }
                                        }
                                        src_pos += rate;
                                    }
                                    // Convert fractional position back to interleaved cursor
                                    let new_cursor_frame = src_pos.ceil() as usize;
                                    let new_cursor = (new_cursor_frame * preview_channels).min(total);
                                    let _ = preview_cursor.compare_exchange(
                                        cursor,
                                        new_cursor,
                                        Ordering::Release,
                                        Ordering::Relaxed,
                                    );
                                }
                            }
                        }

                        // ── C2. Final safety limiter ─────────────────────
                        // BUG-R4/R5 FIX: Master gain is now applied pre-metering
                        // (to graph_out buffers above). This loop applies only
                        // the final soft_clip limiter to prevent DAC clipping
                        // from preview audio mix-in or accumulated rounding.
                        for sample in data[..n * channels].iter_mut() {
                            *sample = soft_clip(*sample);
                        }

                        // ── BUG-075 FIX: Feed spectrum analyzer POST-fader ──
                        if let Some(producer) = &mut render_ctx.spectrum_producer {
                            let mut drops = 0u32;
                            if channels >= 2 {
                                for frame in data.chunks_exact(channels) {
                                    let mono = (frame[0] + frame[1]) * 0.5;
                                    if producer.push(mono).is_err() {
                                        drops += 1;
                                    }
                                }
                            } else if channels == 1 {
                                for &sample in data.iter() {
                                    if producer.push(sample).is_err() {
                                        drops += 1;
                                    }
                                }
                            }
                            if drops > 0 {
                                crate::render_callback::SPECTRUM_DROP_COUNT
                                    .fetch_add(drops, std::sync::atomic::Ordering::Relaxed);
                            }
                        }

                        // Keep master metering in sync with the real final output,
                        // including sampler and preview contributions.
                        if channels >= 2 {
                            let mut sum_sq_l = 0.0f64;
                            let mut sum_sq_r = 0.0f64;
                            let mut peak_l = 0.0f32;
                            let mut peak_r = 0.0f32;
                            let mut frames = 0usize;

                            for frame in data.chunks_exact(channels) {
                                let l = frame[0];
                                let r = frame[1];
                                sum_sq_l += (l as f64) * (l as f64);
                                sum_sq_r += (r as f64) * (r as f64);
                                peak_l = peak_l.max(l.abs());
                                peak_r = peak_r.max(r.abs());
                                frames += 1;
                            }

                            if frames > 0 {
                                let rms_l = (sum_sq_l / frames as f64).sqrt() as f32;
                                let rms_r = (sum_sq_r / frames as f64).sqrt() as f32;
                                // AUD-037 FIX: Compute master peak_decay once per metering pass.
                                let master_decay = peak_decay_for_block(sample_rate_f64, frames);
                                render_ctx
                                    .meter_bank
                                    .master_left()
                                    .store_rms(linear_to_db(rms_l));
                                render_ctx
                                    .meter_bank
                                    .master_right()
                                    .store_rms(linear_to_db(rms_r));
                                render_ctx
                                    .meter_bank
                                    .master_left()
                                    .store_peak_decay(linear_to_db(peak_l), master_decay);
                                render_ctx
                                    .meter_bank
                                    .master_right()
                                    .store_peak_decay(linear_to_db(peak_r), master_decay);
                            }
                        }

                        // ── D. Sync master clock to transport playhead ───
                        if is_playing {
                            clock.set_position(render_ctx.playhead.position());
                        }

                        rt_debug_stats.record_callback(
                            frame_count,
                            commands_processed,
                            callback_start.map(|s| s.elapsed().as_micros() as u64).unwrap_or(0),
                            deferred_topology.len(),
                        );

                        // MEGA-03 FIX: Restore original FPU semantics for OS audio thread
                        #[cfg(target_arch = "x86_64")]
                        unsafe { std::arch::x86_64::_mm_setcsr(original_csr); }
                        
                        #[cfg(target_arch = "aarch64")]
                        unsafe { std::arch::asm!("msr fpcr, {}", in(reg) original_fpcr); }
                    };

                #[cfg(debug_assertions)]
                {
                    let callback_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                        &mut run_callback,
                    ));
                    if callback_result.is_err() {
                        data.fill(0.0);
                        error!(
                            "[RT] Panic trapped inside audio callback; emitted silence for this buffer"
                        );
                    }
                }
                #[cfg(not(debug_assertions))]
                {
                    run_callback();
                }
            },
            // RT_CALLBACK_END
            move |err| {
                let err_msg = err.to_string();
                error!("Audio stream error: {}", err_msg);
                if let Some(tx) = stream_error_tx.as_ref() {
                    let _ = tx.send(err_msg);
                }
            },
            None,
        )
        .map_err(|e| AudioDriverError::BuildStreamError(e.to_string()))?;

    // ── 6. Estimate output latency ──────────────────────────────────
    // cpal 0.17: StreamConfig.buffer_size may be Default (OS-chosen)
    // or Fixed(n). When Default, we use a conservative 512 frames
    // which matches typical macOS CoreAudio buffer size (~10.7ms @ 48kHz).
    // AUD-086 FIX: Proportional latency estimate based on sample rate.
    // 512 is correct for 48kHz (~10.7ms) but too low for 96kHz (~5.3ms).
    // Use sample_rate/100 to target ~10ms consistently.
    let output_latency_frames: u32 = match config.buffer_size {
        cpal::BufferSize::Fixed(n) => n,
        cpal::BufferSize::Default => (sample_rate / 100).max(256),
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
        sample_rate_hz: sample_rate,
        output_latency_frames,
        output_device_name: device_name,
        spectrum_consumer: Some(spectrum_consumer),
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

    let mut outputs: Vec<String> = host
        .output_devices()
        .map(|devices| {
            devices
                .filter_map(|d| d.description().ok().map(|desc| desc.name().to_string()))
                .collect()
        })
        .unwrap_or_default();

    let mut inputs: Vec<String> = host
        .input_devices()
        .map(|devices| {
            devices
                .filter_map(|d| d.description().ok().map(|desc| desc.name().to_string()))
                .collect()
        })
        .unwrap_or_default();

    outputs.sort();
    outputs.dedup();
    inputs.sort();
    inputs.dedup();

    outputs.insert(0, String::from("Default Output"));
    inputs.insert(0, String::from("Default Input"));

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
    fn realtime_callback_forbidden_ops_guard() {
        let src = include_str!("driver.rs");
        let start_marker = "// RT_CALLBACK_START";
        let end_marker = "// RT_CALLBACK_END";

        let start = src
            .find(start_marker)
            .expect("RT callback start marker must exist");
        let rest = &src[start + start_marker.len()..];
        let end_rel = rest
            .find(end_marker)
            .expect("RT callback end marker must exist");
        let callback_src = &rest[..end_rel];

        // AUD-064 FIX: Expanded forbidden tokens list with .unwrap(), .expect(),
        // panic!(), format!(), HashMap::new() for stricter RT-safety enforcement.
        let forbidden = [
            "std::sync::Mutex",
            "std::sync::RwLock",
            ".lock(",
            "println!(",
            "eprintln!(",
            "dbg!(",
            "std::fs::",
            "File::",
            "std::net::",
            "thread::sleep(",
            "Vec::new(",
            "vec![",
            "String::from(",
            "HashMap::new(",
            "format!(",
        ];

        for token in forbidden {
            assert!(
                !callback_src.contains(token),
                "forbidden token in realtime callback: {token}",
            );
        }
    }

    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn constants_are_valid() {
        assert!((DEFAULT_FREQUENCY - 440.0).abs() < f32::EPSILON);
        assert!(TEST_TONE_AMPLITUDE > 0.0 && TEST_TONE_AMPLITUDE <= 1.0);
        // AUD-049: FREQ_SMOOTHING removed — replaced with sample-rate-dependent
        // coefficient computed at usage site (see AUD-010 fix).
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

        apply_plugin_automation_sample_accurate(&mut left, &mut right, 0, Some(&gain_points), None);

        assert!(left[0] < left[7]);
        assert!(right[0] < right[7]);
        // With equal-power pan at center, gain is multiplied by cos(π/4) ≈ 0.707.
        // So gain=2.0 → left[7] ≈ 2.0 * cos(π/4) ≈ 1.414.
        let expected = 2.0 * std::f32::consts::FRAC_PI_4.cos();
        assert!(
            (left[7] - expected).abs() < 0.05,
            "Expected left[7] ≈ {:.3} (gain=2.0 * cos(π/4)), got {:.3}",
            expected, left[7]
        );
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

        apply_plugin_automation_sample_accurate(&mut left, &mut right, 0, None, Some(&pan_points));

        assert!(left[0] > right[0]);
        assert!(right[3] > left[3]);
    }

    #[test]
    fn sample_accurate_track_pan_all_zero_stays_centered() {
        let mut left = vec![1.0f32; 4];
        let mut right = vec![1.0f32; 4];
        let pan_points = vec![AutomationPoint {
            sample_frame: 0,
            value: 0.0,
        }];

        apply_track_mixer_automation_sample_accurate(
            &mut left,
            &mut right,
            0,
            None,
            Some(&pan_points),
        );

        for i in 0..left.len().min(right.len()) {
            assert!((left[i] - right[i]).abs() <= 1e-6);
        }
    }

    #[test]
    fn sample_accurate_track_mixer_volume_and_pan_change_within_buffer() {
        let mut left = vec![1.0f32; 6];
        let mut right = vec![1.0f32; 6];
        let vol_points = vec![
            AutomationPoint {
                sample_frame: 0,
                value: 0.5,
            },
            AutomationPoint {
                sample_frame: 5,
                value: 1.5,
            },
        ];
        let pan_points = vec![
            AutomationPoint {
                sample_frame: 0,
                value: -1.0,
            },
            AutomationPoint {
                sample_frame: 5,
                value: 1.0,
            },
        ];

        apply_track_mixer_automation_sample_accurate(
            &mut left,
            &mut right,
            0,
            Some(&vol_points),
            Some(&pan_points),
        );

        // Early frames biased left with lower volume; later frames biased right with higher volume.
        assert!(left[0] > right[0]);
        assert!(right[5] > left[5]);
        assert!(left[5] > left[0] || right[5] > right[0]);
    }
}
