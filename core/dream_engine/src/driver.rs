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
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Instant;

use arc_swap::ArcSwap;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use dream_graph::{
    AudioDag, AudioNode, ExecutionPlan, GraphBuilder, GraphRenderer, LiveGraph, NodeId, NodeKind,
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

use crate::render_callback::{RenderContext, MAX_TRACKS};
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
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    pub fn load(&self) -> arc_swap::Guard<Arc<Vec<Vec<Option<usize>>>>> {
        self.inner.load()
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
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
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    pub fn load(&self) -> arc_swap::Guard<Arc<Vec<Vec<ExternalFxRuntimeSlot>>>> {
        self.inner.load()
    }
}

impl Default for SharedExternalFxSnapshot {
    fn default() -> Self {
        Self::new()
    }
}

/// Lock-free runtime stats written by audio callback for diagnostics.
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

/// Transparent soft-knee limiter for the master bus.
///
/// - Below ±1.0: passes through **unchanged** (0 dB of compression).
/// - Above ±1.0: soft-knee compression that asymptotically approaches ±1.5,
///   preventing hard digital clipping while preserving transient shape.
///
/// This replaces the previous `x / (1 + |x|)` waveshaper which compressed
/// ALL signals (even –6 dBFS content was crushed by 34%).
#[inline]
fn soft_clip(sample: f32) -> f32 {
    let abs = sample.abs();
    if abs <= 1.0 {
        sample // transparent below 0 dBFS
    } else {
        // Soft-knee: 1.0 + 0.5 * tanh(excess)
        // Uses the identity tanh(x) = 1 - 2/(e^(2x)+1) to avoid libm dependency.
        // Clamp excess to prevent exp() overflow → inf/inf = NaN at extreme levels.
        let excess = (abs - 1.0).min(20.0);
        let e2x = (2.0 * excess).exp();
        let tanh_val = (e2x - 1.0) / (e2x + 1.0);
        sample.signum() * (1.0 + 0.5 * tanh_val)
    }
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

    // Reset cursor on backward seek / loop wrap — the cursor only advances
    // forward, so if the requested frame is before the current cursor's segment,
    // we must restart. This is the canonical fix for stale cursors after transport
    // loop-back or manual seek-backward.
    if *cursor > 0 && at_frame < points[*cursor].sample_frame {
        *cursor = 0;
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

    let mut min_v = f32::INFINITY;
    let mut max_v = f32::NEG_INFINITY;
    let mut saw_center_hint = false;
    for p in points {
        let v = p.value;
        min_v = min_v.min(v);
        max_v = max_v.max(v);
        if (v - 0.5).abs() <= 0.08 {
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
        let left_mul = if pan > 0.0 { 1.0 - pan } else { 1.0 };
        let right_mul = if pan < 0.0 { 1.0 + pan } else { 1.0 };
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

        let left_mul = if pan > 0.0 { 1.0 - pan } else { 1.0 };
        let right_mul = if pan < 0.0 { 1.0 + pan } else { 1.0 };

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
        let left_mul = if pan > 0.0 { 1.0 - pan } else { 1.0 };
        let right_mul = if pan < 0.0 { 1.0 + pan } else { 1.0 };
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

        let left_mul = if pan > 0.0 { 1.0 - pan } else { 1.0 };
        let right_mul = if pan < 0.0 { 1.0 + pan } else { 1.0 };

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
    let key = param_key.trim().to_lowercase();
    if key.is_empty() {
        return None;
    }

    // ext:<slot_uuid>:<param_index> (canonical key)
    if let Some(rest) = key.strip_prefix("ext:") {
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
    if let Some(rest) = key.strip_prefix("slot:") {
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
    if let Some(rest) = key.strip_prefix("plugin:") {
        let mut parts = rest.split(':');
        let slot_index = parts.next()?.parse::<usize>().ok()?;
        let _plugin_key = parts.next()?;
        let param_token = parts.collect::<Vec<_>>().join(":");
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

fn build_dag_for_tracks(
    track_count: usize,
    routing: &[Option<usize>],
    sidechains: &[Vec<Option<usize>>],
) -> AudioDag {
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

        // ── Main Routing Edge ──
        if let Some(Some(dest_idx)) = routing.get(track_idx) {
            if *dest_idx < track_count && *dest_idx != track_idx {
                let to = NodeId((*dest_idx as u64) + 1);
                match builder.clone().add_edge(from, to) {
                    Ok(next) => builder = next,
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
                        match builder.clone().add_edge(source_node, from) {
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
    GraphBuilder::new()
        .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
        .build()
        .expect("master-only graph must be valid")
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
        let generation = self
            .generation
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        let snapshot = prepare_graph_snapshot_for_routing(track_count, routing, sidechains, generation);
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

impl Default for MidiNoteMapState {
    fn default() -> Self {
        Self {
            active_notes: Vec::with_capacity(256),
            rng_state: 0xA5A5_1337,
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
            rng_state: 0xB7B7_CAFE,
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
    }

    /// Register a note-off — remove from active tracking.
    fn note_off(&mut self, pitch: u8, channel: u8) {
        if let Some(pos) = self.active.iter().position(|&(p, c)| p == pitch && c == channel) {
            self.active.swap_remove(pos);
        }
    }

    /// Flush all active notes: generates note-off events for every
    /// currently active note + CC 120 (All Sound Off) + CC 123 (All Notes Off)
    /// on channel 0. CC120 immediately kills ALL audio output including reverb
    /// and delay tails — essential for synths like Serum with internal FX.
    fn flush_all(&mut self, out: &mut Vec<MidiEvent>) {
        for &(pitch, channel) in &self.active {
            out.push(MidiEvent::note_off(0, channel, pitch, 0));
        }
        self.active.clear();
        // CC 120 = All Sound Off — immediately silences all audio,
        // including synth tails, reverbs, and delays (enterprise standard).
        out.push(MidiEvent::cc(0, 0, 120, 0));
        // CC 123 = All Notes Off — releases all held notes.
        out.push(MidiEvent::cc(0, 0, 123, 0));
    }

    #[allow(dead_code)]
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
    prepared_graph_snapshot: Arc<SharedPreparedGraphSnapshot>,
    rt_debug_stats: Arc<SharedRtDebugStats>,
    plugin_host: Arc<Mutex<PluginHost>>,
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
        sidechain_snapshot,
        external_fx_snapshot,
        automation_snapshot,
        sampler_samples,
        prepared_graph_snapshot,
        rt_debug_stats,
        plugin_host,
        preview_buffer,
        preview_cursor,
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
    prepared_graph_snapshot: Arc<SharedPreparedGraphSnapshot>,
    rt_debug_stats: Arc<SharedRtDebugStats>,
    plugin_host: Arc<Mutex<PluginHost>>,
    preview_buffer: Arc<ArcSwap<Option<Vec<f32>>>>,
    preview_cursor: Arc<AtomicUsize>,
    preferred_output_device: Option<&str>,
    stream_error_tx: Option<std::sync::mpsc::Sender<String>>,
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
    let mut graph_renderer = GraphRenderer::new(256, 8192);
    let prepared_graph = prepared_graph_snapshot.load();
    let mut graph_dag = prepared_graph.dag.clone();
    let mut graph_plan = prepared_graph.plan.clone();
    let mut graph_out_left = vec![0.0f32; 8192];
    let mut graph_out_right = vec![0.0f32; 8192];
    let mut post_sum_processing_mask = vec![false; MAX_TRACKS];
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
    let mut _bpm: f64 = 120.0;
    let mut master_gain_target: f32 = 1.0;
    let mut master_gain_current: f32 = 1.0;
    // Master gain smoothing coefficient — targets ~5ms time constant,
    // derived from sample rate so behavior is consistent across 44.1–192kHz.
    let master_gain_smooth: f32 = 1.0 - (-1.0_f64 / (0.005 * sample_rate_f64)).exp() as f32;
    // per-track disable/solo state (used for output-enable calculation)
    let mut track_disabled: [bool; MAX_TRACKS] = [false; MAX_TRACKS];
    let mut track_soloed: [bool; MAX_TRACKS] = [false; MAX_TRACKS];
    let mut any_solo: bool = false;

    // ── 6. Per-track sampler engines ─────────────────────────────────
    // Pre-allocated sampler engines (one per track max).
    // Each engine starts with no sample loaded — it becomes active
    // when the user assigns a sample via SharedSamplerSamples.
    let mut sampler_engines: Vec<SamplerEngine> = (0..MAX_TRACKS)
        .map(|_| SamplerEngine::new(sample_rate_f64))
        .collect();
    let mut midi_note_states: Vec<MidiNoteMapState> =
        vec![MidiNoteMapState::default(); MAX_TRACKS];
    // Scratch buffers for sampler output (reused each buffer, zero-alloc)
    let mut external_left = vec![0.0f32; 8192];
    let mut external_right = vec![0.0f32; 8192];
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
    let mut midi_events_scratch: Vec<(usize, u8, u8, u8, u64)> = Vec::with_capacity(16384);
    // Pre-allocated scratch buffer for converting scheduled MIDI events to MidiEvent
    // objects that external VST3 plugins receive.
    let mut vst3_midi_scratch: Vec<MidiEvent> = Vec::with_capacity(4096);
    // Per-track active-note tracking for VST3 plugins (flush on stop/seek).
    let mut vst3_note_trackers: Vec<Vst3NoteTracker> =
        vec![Vst3NoteTracker::default(); MAX_TRACKS];
    // Flag: when true the next graph-render pass injects All-Notes-Off
    // into every VST3 instrument slot before any new events.
    let mut vst3_flush_all_notes = false;
    // Per-track real-time MIDI queue: keyboard/preview NoteOn/Off events
    // are pushed here in the command loop and drained into vst3_midi_scratch
    // during the graph pass so external VST3 instruments (Serum, etc.)
    // receive real-time MIDI alongside clip events.
    let mut vst3_rt_midi_queue: Vec<Vec<MidiEvent>> =
        (0..MAX_TRACKS).map(|_| Vec::with_capacity(32)).collect();
    // Track which samples were last loaded per-track to avoid re-assigning
    let _last_sample_generation: u64 = 0;

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
                        let callback_start = Instant::now();
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
                        #[cfg(target_arch = "aarch64")]
                        unsafe {
                            // ARM FPCR bit 24 = FZ (Flush-to-Zero).
                            // AArch64 has no DAZ equivalent — FZ covers both
                            // input denormals and output denormals.
                            let mut fpcr: u64;
                            std::arch::asm!("mrs {}, fpcr", out(reg) fpcr);
                            fpcr |= 1 << 24; // FZ bit
                            std::arch::asm!("msr fpcr, {}", in(reg) fpcr);
                        }

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
                        const MAX_COMMANDS_PER_CALLBACK: usize = 512;
                        let mut commands_processed = 0usize;
                        let mut pending_track_volume: [Option<f32>; MAX_TRACKS] = [None; MAX_TRACKS];
                        let mut pending_track_pan: [Option<f32>; MAX_TRACKS] = [None; MAX_TRACKS];
                        let mut pending_track_mute: [Option<bool>; MAX_TRACKS] = [None; MAX_TRACKS];
                        let mut pending_track_solo: [Option<bool>; MAX_TRACKS] = [None; MAX_TRACKS];
                        for _ in 0..MAX_COMMANDS_PER_CALLBACK {
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
                                            midi_note_states[idx] = MidiNoteMapState::default();
                                        }
                                        // BUG-1 FIX: Flush VST3 plugin notes on transport stop.
                                        vst3_flush_all_notes = true;
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
                                    clock.set_position(frame);
                                    render_ctx.playhead.seek(frame);
                                    // Prevent stuck/stacked notes after timeline jumps.
                                    for idx in 0..sampler_engines.len() {
                                        sampler_engines[idx].all_notes_off();
                                        midi_note_states[idx] = MidiNoteMapState::default();
                                    }
                                    // BUG-1 FIX: Flush VST3 plugin notes on seek.
                                    vst3_flush_all_notes = true;
                                }
                                EngineCommand::SetBpm(bpm) => {
                                    _bpm = bpm.clamp(20.0, 999.0);
                                }
                                EngineCommand::SetTimelineSampleRate(sample_rate) => {
                                    render_ctx.set_timeline_sample_rate(sample_rate);
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
                                    // Also queue for VST3 instruments on this track.
                                    // The graph pass will drain this into vst3_midi_scratch.
                                    if idx < vst3_rt_midi_queue.len() {
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
                                    // Also queue for VST3 instruments on this track.
                                    if idx < vst3_rt_midi_queue.len() {
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
                                    // BUG-1 FIX: Also flush VST3 instruments when bypassing.
                                    if bypassed {
                                        vst3_flush_all_notes = true;
                                    }
                                }
                                EngineCommand::Shutdown => {
                                    is_playing = false;
                                    test_tone_phase = 0.0;
                                    // Kill all sampler voices on shutdown
                                    for engine in sampler_engines.iter_mut() {
                                        engine.all_notes_off();
                                    }
                                    // BUG-1 FIX: Flush VST3 plugin notes on shutdown.
                                    vst3_flush_all_notes = true;
                                }
                                // ── Device Chain Commands ────────────────────
                                EngineCommand::AddDevice {
                                    track_index,
                                    slot_index,
                                    effect_type,
                                } => {
                                    if deferred_topology.len() >= 1024 {
                                        log::warn!("[RT] deferred_topology full — dropping oldest topology command");
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
                                        log::warn!("[RT] deferred_topology full — dropping oldest topology command");
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
                        if pending_track_solo.iter().any(|v| v.is_some())
                            || pending_track_mute.iter().any(|v| v.is_some())
                        {
                            let active_track_count = render_ctx.track_slots.len().min(MAX_TRACKS);
                            any_solo = track_soloed.iter().take(active_track_count).any(|s| *s);
                            for i in 0..render_ctx.track_slots.len().min(MAX_TRACKS) {
                                let enabled = !track_disabled[i] && (!any_solo || track_soloed[i]);
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
                        let mut plugin_host_guard = if needs_plugin_host {
                            plugin_host.try_lock().ok()
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
                        let routing_now = routing_snapshot.load();
                        for src_idx in 0..track_count {
                            if let Some(Some(dest_idx)) = routing_now.get(src_idx)
                                && *dest_idx < track_count
                            {
                                post_sum_processing_mask[*dest_idx] = true;
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

                            render_ctx.render_tracks_with_post_sum_mask(
                                render_frames,
                                snapshot.as_ref(),
                                &pool_snap,
                                Some(&post_sum_processing_mask[..track_count]),
                            );
                            playhead_advanced_in_render = true;
                        } else {
                            // When stopped or no clips, ensure track buffers start clean.
                            for slot in render_ctx.track_slots.iter_mut() {
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

                            if midi_schedule_scratch.is_empty() && !engine.has_active_voices() {
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
                            midi_events_scratch.sort_by(|a, b| {
                                a.0.cmp(&b.0)
                                    .then_with(|| a.1.cmp(&b.1))
                                    .then_with(|| a.2.cmp(&b.2))
                                    .then_with(|| a.4.cmp(&b.4))
                            });

                            for &(frame, kind, pitch, velocity, event_uid) in &midi_events_scratch {
                                let seg = frame.saturating_sub(cursor).min(fc - cursor);
                                if seg > 0 && engine.has_active_voices() {
                                    engine.render(
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
                                    }

                                    note_state.active_notes.push(ActiveMappedNote {
                                        uid: event_uid,
                                        _src_pitch: pitch,
                                        mapped_pitch,
                                    });
                                    engine.note_on(mapped_pitch, mapped_velocity);
                                }
                            }

                            if cursor < fc && engine.has_active_voices() {
                                let rem = fc - cursor;
                                engine.render(
                                    &mut slot.buf_left[cursor..fc],
                                    &mut slot.buf_right[cursor..fc],
                                    rem,
                                );
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

                        graph_renderer.render(
                            &graph_plan,
                            &graph_dag,
                            n,
                            &mut graph_out_left[..n],
                            &mut graph_out_right[..n],
                            |node, left, right, count| {
                                if node.id.0 == 0 {
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
                                        slot.strip.process_stereo(
                                            &mut left[..c],
                                            &mut right[..c],
                                        );
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
                                                    tempo: _bpm,
                                                    is_playing,
                                                    is_recording: false,
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

                                                // BUG-1 FIX: Flush all active notes on transport stop/seek.
                                                if vst3_flush_all_notes && track_idx < vst3_note_trackers.len() {
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
                                                                    t.active.push((mapped_pitch, 0));
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
                                    let decay = peak_decay_for_block(sample_rate_f64, c);
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
                                        meter_l.store_peak_decay(peak_l, decay);
                                        meter_r.store_peak_decay(peak_r, decay);
                                    }
                                }
                            },
                            |_node, _left, _right, _count| {},
                        );
                        // BUG-1 FIX: Clear the flush flag after all tracks have been
                        // processed — each VST3 slot received its note-off events.
                        vst3_flush_all_notes = false;

                        for i in 0..n {
                            let base = i * channels;
                            if base >= data.len() { break; }
                            if channels == 1 {
                                data[base] = soft_clip((graph_out_left[i] + graph_out_right[i]) * 0.5);
                                continue;
                            }
                            data[base] = soft_clip(graph_out_left[i]);
                            if base + 1 < data.len() {
                                data[base + 1] = soft_clip(graph_out_right[i]);
                            }
                            for ch in 2..channels {
                                let idx = base + ch;
                                if idx < data.len() { data[idx] = 0.0; }
                            }
                        }

                        if test_tone_enabled && !is_playing {
                            // Test tone only when stopped (otherwise clips handle it)
                            for frame in data.chunks_exact_mut(channels) {
                                test_tone_current_freq += (test_tone_target_freq - test_tone_current_freq) * FREQ_SMOOTHING;
                                let phase_inc = test_tone_current_freq as f64 / sample_rate_f64;
                                let sample = (test_tone_phase * std::f64::consts::TAU).sin() as f32 * TEST_TONE_AMPLITUDE;
                                for ch in frame.iter_mut() { *ch = sample; }
                                test_tone_phase += phase_inc;
                                if test_tone_phase >= 1.0 { test_tone_phase -= 1.0; }
                            }
                        }
                        if is_playing && !playhead_advanced_in_render {
                            let transport_loop = render_ctx.loop_region.as_ref().map(|r| {
                                dream_transport::LoopRegion {
                                    start: r.start,
                                    end: r.end,
                                    enabled: true,
                                }
                            });
                            render_ctx
                                .playhead
                                .advance(frame_count, transport_loop.as_ref());
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
                                (master_gain_target - master_gain_current) * master_gain_smooth;
                            *sample = soft_clip(*sample * master_gain_current);
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
                                    .store_peak_decay(linear_to_db(peak_l), peak_decay_for_block(sample_rate_f64, frames));
                                render_ctx
                                    .meter_bank
                                    .master_right()
                                    .store_peak_decay(linear_to_db(peak_r), peak_decay_for_block(sample_rate_f64, frames));
                            }
                        }

                        // ── D. Sync master clock to transport playhead ───
                        if is_playing {
                            clock.set_position(render_ctx.playhead.position());
                        }

                        rt_debug_stats.record_callback(
                            frame_count,
                            commands_processed,
                            callback_start.elapsed().as_micros() as u64,
                            deferred_topology.len(),
                        );
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
        sample_rate_hz: sample_rate,
        output_latency_frames,
        output_device_name: device_name,
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

        apply_plugin_automation_sample_accurate(&mut left, &mut right, 0, Some(&gain_points), None);

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
