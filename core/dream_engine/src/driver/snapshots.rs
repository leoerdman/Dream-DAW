// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Lock-Free Shared Snapshots
// ═══════════════════════════════════════════════════════════════════════════
//
// ArcSwap-based atomic snapshots for UI→audio communication.
// Every type here is:
//   - Wait-free on load (audio thread)
//   - Lock-free on store/rcu (UI thread)
//   - No mutex, no blocking, no priority inversion

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use arc_swap::ArcSwap;
use uuid::Uuid;

use dream_clip_engine::pool::ClipAudio;
use dream_models::midi::MidiClip;
use dream_models::project::AudioClip;

use super::automation::ExternalParamTarget;

// ═══════════════════════════════════════════════════════════════════════════
// Audio Clip Snapshot
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// MIDI Snapshot
// ═══════════════════════════════════════════════════════════════════════════

/// Per-track MIDI FX configuration for real-time processing.
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

// ═══════════════════════════════════════════════════════════════════════════
// Routing Snapshot
// ═══════════════════════════════════════════════════════════════════════════

/// Atomic snapshot of per-track routing destinations for the audio graph.
///
/// Each entry is an optional destination track index:
/// - `None` => route track to master.
/// - `Some(i)` => route track to track `i` (bus/sidechain style feed).
pub struct SharedRoutingSnapshot {
    inner: ArcSwap<Vec<Option<usize>>>,
    generation: AtomicU64,
}

impl SharedRoutingSnapshot {
    pub fn new() -> Self {
        Self {
            inner: ArcSwap::from_pointee(Vec::new()),
            generation: AtomicU64::new(0),
        }
    }

    pub fn swap(&self, routing: Vec<Option<usize>>) {
        self.inner.store(Arc::new(routing));
        self.generation.fetch_add(1, Ordering::Release);
    }

    pub fn load(&self) -> arc_swap::Guard<Arc<Vec<Option<usize>>>> {
        self.inner.load()
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }
}

impl Default for SharedRoutingSnapshot {
    fn default() -> Self {
        Self::new()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Sidechain Snapshot
// ═══════════════════════════════════════════════════════════════════════════

/// Atomic snapshot of per-track internal device sidechain sources.
///
/// Shape: `[track_index][device_slot_index] -> Option<source_track_index>`.
pub struct SharedSidechainSnapshot {
    inner: ArcSwap<Vec<Vec<Option<usize>>>>,
    generation: AtomicU64,
}

impl SharedSidechainSnapshot {
    pub fn new() -> Self {
        Self {
            inner: ArcSwap::from_pointee(Vec::new()),
            generation: AtomicU64::new(0),
        }
    }

    pub fn swap(&self, sidechains: Vec<Vec<Option<usize>>>) {
        self.inner.store(Arc::new(sidechains));
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

// ═══════════════════════════════════════════════════════════════════════════
// External FX Snapshot
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Copy)]
pub struct ExternalPluginRuntimeSlot {
    pub slot_id: Option<Uuid>,
    pub internal_slot_index: Option<usize>,
    pub instance_id: Option<Uuid>,
    pub sidechain_track_index: Option<usize>,
    /// Sidechain signal tap point: 0 = PreFx, 1 = PostFx, 2 = PostMixer.
    /// Mirrors `dream_models::project::SidechainSendMode::to_u8()`.
    pub sidechain_send_mode: u8,
    /// `true` when this slot originates from `track.instrument` (not `track.effects`).
    /// Used by the audio thread to keep `transport.is_playing = true` even when the
    /// timeline is stopped, so instruments like Serum don't gate MIDI processing.
    pub is_instrument: bool,
    /// `true` when this slot is bypassed. Bypassed slots remain in the snapshot
    /// to preserve slot ordering (so subsequent sidechain indices stay correct),
    /// but the audio callback skips their processing — audio passes through.
    pub is_bypassed: bool,
}

/// Atomic snapshot of per-track external effect runtime instances.
///
/// Shape: `[track_index] -> Vec<fx_steps_in_project_order>`.
pub struct SharedExternalPluginSnapshot {
    inner: ArcSwap<Vec<Vec<ExternalPluginRuntimeSlot>>>,
    generation: AtomicU64,
}

impl SharedExternalPluginSnapshot {
    pub fn new() -> Self {
        Self {
            inner: ArcSwap::from_pointee(Vec::new()),
            generation: AtomicU64::new(0),
        }
    }

    pub fn swap(&self, fx: Vec<Vec<ExternalPluginRuntimeSlot>>) {
        self.inner.store(Arc::new(fx));
        self.generation.fetch_add(1, Ordering::Release);
    }

    pub fn load(&self) -> arc_swap::Guard<Arc<Vec<Vec<ExternalPluginRuntimeSlot>>>> {
        self.inner.load()
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }
}

impl Default for SharedExternalPluginSnapshot {
    fn default() -> Self {
        Self::new()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Plugin Registry
// ═══════════════════════════════════════════════════════════════════════════

pub use dream_plugins::vst3_host::PluginInstanceArc;

/// Atomic snapshot of active VST/CLAP plugin instances.
pub struct SharedPluginRegistry {
    inner: ArcSwap<std::collections::HashMap<Uuid, PluginInstanceArc>>,
    generation: AtomicU64,
}

impl SharedPluginRegistry {
    pub fn new() -> Self {
        Self {
            inner: ArcSwap::from_pointee(std::collections::HashMap::new()),
            generation: AtomicU64::new(0),
        }
    }

    pub fn swap(&self, registry: std::collections::HashMap<Uuid, PluginInstanceArc>) {
        self.inner.store(std::sync::Arc::new(registry));
        self.generation.fetch_add(1, Ordering::Release);
    }

    pub fn load(
        &self,
    ) -> arc_swap::Guard<std::sync::Arc<std::collections::HashMap<Uuid, PluginInstanceArc>>> {
        self.inner.load()
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// Atomically clears the registry and returns the previous `Arc`.
    ///
    /// Used during shutdown to ensure the audio thread releases its reference
    /// to plugin instances before they are dropped on the main thread.
    /// The caller can poll `Arc::strong_count()` on the returned `Arc` to wait
    /// for the audio thread to finish its current processing cycle.
    pub fn clear_and_return_arc(
        &self,
    ) -> Arc<std::collections::HashMap<Uuid, PluginInstanceArc>> {
        let old = self.inner.swap(Arc::new(std::collections::HashMap::new()));
        self.generation.fetch_add(1, Ordering::Release);
        old
    }
}

impl Default for SharedPluginRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Automation Snapshot
// ═══════════════════════════════════════════════════════════════════════════

// ── ENTERPRISE: Automation curve interpolation modes ─────────────────────
// Matches the frontend CurveType enum ('linear' | 'bezier' | 'step').
// These modes control how the audio engine interpolates between breakpoints.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum AutomationCurveMode {
    /// Linear interpolation between points (default, zero-cost).
    #[default]
    Linear,
    /// Hold previous value until next point is reached (step/hold).
    /// Useful for discrete parameter changes (e.g., on/off switches).
    Step,
    /// Cubic bezier S-curve with configurable tension.
    /// Creates smooth, musical-sounding automation transitions.
    Bezier,
}

#[derive(Debug, Clone, Default)]
pub struct AutomationPoint {
    pub sample_frame: i64,
    pub value: f32,
    /// Interpolation mode for the segment FOLLOWING this point.
    pub curve_mode: AutomationCurveMode,
    /// Bezier tension (0.0–1.0): 0.0 = linear, 1.0 = sharp S-curve.
    /// Only used when `curve_mode == Bezier`. Default: 0.5.
    pub tension: f32,
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
    generation: AtomicU64,
}

impl SharedAutomationSnapshot {
    pub fn new() -> Self {
        Self {
            inner: ArcSwap::from_pointee(Vec::new()),
            generation: AtomicU64::new(0),
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

// ═══════════════════════════════════════════════════════════════════════════
// Sampler Samples
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// Sample Rack Samples
// ═══════════════════════════════════════════════════════════════════════════

/// Per-track sample rack samples.
///
/// Holds an array of 16 optional clips for each track's Sample Rack.
/// **Wait-free** via `ArcSwap`.
pub struct SharedSampleRackSamples {
    inner: ArcSwap<Vec<[Option<Arc<ClipAudio>>; 16]>>,
}

pub type SampleRackTrackPads = [Option<Arc<ClipAudio>>; 16];
pub type SampleRackSamples = Vec<SampleRackTrackPads>;
pub type SampleRackSamplesGuard = arc_swap::Guard<Arc<SampleRackSamples>>;

impl SharedSampleRackSamples {
    pub fn new() -> Self {
        Self {
            inner: ArcSwap::from_pointee(Vec::new()),
        }
    }

    pub fn set_track_pad_sample(
        &self,
        track_index: usize,
        pad_index: usize,
        sample: Option<Arc<ClipAudio>>,
    ) {
        if pad_index >= 16 {
            return;
        }
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

    pub fn load(&self) -> SampleRackSamplesGuard {
        self.inner.load()
    }

    pub fn swap(&self, samples: SampleRackSamples) {
        self.inner.store(Arc::new(samples));
    }
}

impl Default for SharedSampleRackSamples {
    fn default() -> Self {
        Self::new()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Disk Streaming Handles (OOM Prevention)
// ═══════════════════════════════════════════════════════════════════════════

/// Shared container for disk streaming handles.
///
/// Files exceeding `RAM_THRESHOLD_BYTES` (~50 MB) are not loaded into the
/// `ClipPool`.  Instead, a `DiskStreamerHandle` spawns a background I/O
/// thread that reads audio ahead of the playhead via an `rtrb` ring buffer.
///
/// **Thread model:**
/// - UI thread: calls `spawn()` during project loading / clip import,
///   and removes handles on clip delete / project close.
/// - Audio thread: calls `try_lock()` (non-blocking) each callback to
///   `drain_into()` pending chunks into `RenderContext::streaming_windows`.
///   If the lock is contended, the callback simply skips the drain — the
///   existing window data remains valid for another buffer cycle.
///
/// The inner `Mutex` is NOT held across any I/O or allocation — only a
/// brief iteration to drain ring buffer consumers.
pub struct SharedDiskStreamers {
    inner: parking_lot::Mutex<Vec<dream_clip_engine::DiskStreamerHandle>>,
}

impl SharedDiskStreamers {
    pub fn new() -> Self {
        Self {
            inner: parking_lot::Mutex::new(Vec::new()),
        }
    }

    /// Adds a new disk streaming handle (called from UI thread).
    pub fn push(&self, handle: dream_clip_engine::DiskStreamerHandle) {
        let mut vec = self.inner.lock();
        vec.push(handle);
    }

    /// Removes all handles matching the given source path.
    pub fn remove_by_path(&self, source_path: &str) {
        let mut vec = self.inner.lock();
        vec.retain(|h| h.source_path != source_path);
    }

    /// Removes ALL handles (project close / clear).
    pub fn clear(&self) {
        let mut vec = self.inner.lock();
        vec.clear();
    }

    /// Drains pending chunks from all handles into the render context's
    /// streaming windows, and updates playhead positions.
    ///
    /// # Real-Time Safety
    /// Uses `try_lock()` — returns immediately if the UI thread holds the
    /// lock.  `rtrb::Consumer::pop()` is wait-free.  Zero allocations
    /// (streaming windows are pre-allocated in `RenderContext`).
    pub fn drain_all_into(
        &self,
        windows: &mut std::collections::HashMap<String, dream_clip_engine::disk_streamer::StreamingWindow>,
        playhead: i64,
    ) {
        let Some(mut handles) = self.inner.try_lock() else {
            return; // UI thread is modifying handles — skip this cycle
        };

        for handle in handles.iter_mut() {
            // Update the I/O thread's playhead so it reads ahead correctly
            handle.set_playhead(playhead);

            // Find or create the streaming window for this source
            let window = windows.entry(handle.source_path.clone()).or_insert_with(|| {
                dream_clip_engine::disk_streamer::StreamingWindow::new(
                    &handle.source_path,
                    handle.total_frames,
                    handle.num_channels,
                    handle.sample_rate,
                )
            });

            // Drain ring buffer chunks (lock-free pop)
            handle.drain_into(window);

            // Evict chunks far behind the playhead to bound memory
            window.evict_behind(playhead);
        }
    }

    /// Returns the number of active disk streamers.
    pub fn len(&self) -> usize {
        self.inner.lock().len()
    }

    /// Returns true if there are no active disk streamers.
    pub fn is_empty(&self) -> bool {
        self.inner.lock().is_empty()
    }
}

impl Default for SharedDiskStreamers {
    fn default() -> Self {
        Self::new()
    }
}
