use arc_swap::ArcSwap;
use std::sync::{Arc, Mutex};

use dream_clip_engine::pool::ClipPool;
use dream_engine::driver::{
    SharedAutomationSnapshot, SharedClipSnapshot, SharedDiskStreamers, SharedExternalPluginSnapshot,
    SharedPreparedGraphSnapshot, SharedRoutingSnapshot, SharedRtDebugStats,
    SharedSidechainSnapshot,
};
use dream_ipc::metering::MeterBank;
use dream_ipc::{EngineCommand, MasterClock};
use dream_models::PlaybackState;
use dream_plugins::PluginHost;

// ── Audio Engine State ─────────────────────────────────────────────────

/// Thread-safe handle to the audio engine's command producer.
///
/// Wrapped in `Mutex` only for the UI-thread side (Tauri command handlers).
/// The actual audio callback uses the consumer end lock-free via `rtrb`.
pub struct AudioEngineHandle {
    /// Producer end of the lock-free command queue.
    pub producer: Mutex<rtrb::Producer<EngineCommand>>,

    /// Atomic master clock (read from any thread).
    pub master_clock: Arc<MasterClock>,

    /// Current playback state (UI mirror, NOT the audio thread's state).
    /// Updated when commands are sent, read by `get_state`.
    pub playback_state: Mutex<PlaybackState>,

    /// Lock-free meter bank — written by audio thread, read by UI.
    pub meter_bank: Arc<MeterBank>,

    /// Handle to the audio stream (kept alive to prevent drop).
    pub _stream: Mutex<Option<Box<dyn std::any::Any + Send>>>,

    /// Preview buffer — interleaved stereo f32 samples for browser audition.
    pub preview_buffer: Arc<ArcSwap<Option<Vec<f32>>>>,

    /// Preview playback cursor (frame index × 2 for stereo interleaved).
    pub preview_cursor: Arc<std::sync::atomic::AtomicUsize>,

    /// SSOT-FIX: Source sample rate of the preview audio.
    /// Used by the RT callback to compute fractional cursor advancement
    /// so preview pitch matches the original file regardless of device SR.
    /// Stored as u32 (e.g. 44100, 48000). 0 means "same as device" (legacy fallback).
    pub preview_source_sr: Arc<std::sync::atomic::AtomicU32>,

    /// Export cancel flag - set to true to abort offline bounce.
    pub export_cancel: Arc<std::sync::atomic::AtomicBool>,

    /// Shared clip pool snapshot (lock-free) for restarting audio stream.
    pub clip_pool: Arc<ArcSwap<ClipPool>>,
    pub clip_snapshot: Arc<SharedClipSnapshot>,
    pub midi_snapshot: Arc<dream_engine::driver::SharedMidiSnapshot>,
    pub routing_snapshot: Arc<SharedRoutingSnapshot>,
    pub prepared_graph_snapshot: Arc<SharedPreparedGraphSnapshot>,
    pub sidechain_snapshot: Arc<SharedSidechainSnapshot>,
    pub external_fx_snapshot: Arc<SharedExternalPluginSnapshot>,
    pub automation_snapshot: Arc<SharedAutomationSnapshot>,
    pub sampler_samples: Arc<dream_engine::driver::SharedSamplerSamples>,
    pub sample_rack_samples: Arc<dream_engine::driver::SharedSampleRackSamples>,
    pub _plugin_host: Arc<parking_lot::Mutex<PluginHost>>,
    pub plugin_registry: Arc<dream_engine::driver::SharedPluginRegistry>,
    pub rt_debug_stats: Arc<SharedRtDebugStats>,

    /// Shared container for disk streaming handles (OOM prevention).
    /// Files > 50 MB are streamed from disk instead of loaded into RAM.
    /// The audio callback drains pending chunks via try_lock() (non-blocking).
    pub disk_streamers: Arc<SharedDiskStreamers>,

    /// BUG-8 FIX: Shared internal effect latency snapshot for device hot-swap.
    pub internal_latency_snapshot: Arc<dream_engine::render_callback::SharedInternalLatencySnapshot>,

    /// Estimated hardware output latency in sample frames.
    /// Captured from cpal at stream init. Passed to frontend so the
    /// visual playhead can be offset to match actual speaker output.
    pub output_latency_frames: u32,

    /// Event channel for RT stream errors (device disconnect, backend failures).
    pub stream_error_tx: std::sync::mpsc::SyncSender<String>,

    /// Global shutdown flag (BUG-14)
    pub is_shutting_down: Arc<std::sync::atomic::AtomicBool>,

    /// ENTERPRISE: Frontend-ready gate — background threads skip event emission
    /// until the frontend JS signals it has initialized Tauri event listeners.
    /// Prevents `listeners[eventId].handlerId` crash in Tauri's WebView bridge.
    pub frontend_ready: Arc<std::sync::atomic::AtomicBool>,

    /// Pre-allocation queue producer — for transferring pre-constructed DSP
    /// processors from the IPC thread to the audio thread without `malloc()`
    /// on the real-time thread. Enterprise RT-safety pattern.
    pub prealloc_producer: Mutex<rtrb::Producer<dream_ipc::prealloc_queue::PrebuiltDevice>>,
}

// ── Spectrum Analyzer State ────────────────────────────────────────────

/// Inner mutable state for the spectrum analyzer (protected by Mutex).
pub struct SpectrumStateInner {
    /// Lock-free consumer of mono master output samples from the audio thread
    pub consumer: rtrb::Consumer<f32>,
    /// FFT analyzer — accumulates samples and computes spectrum
    pub analyzer: dream_dsp::spectrum_analyzer::SpectrumAnalyzer,
    /// Cached last magnitudes for when no new data is available
    pub last_magnitudes: Vec<f32>,
}

/// Per-track spectrum analyzer inner state.
pub struct TrackSpectrumInner {
    /// Lock-free consumer of per-track mono post-FX audio
    pub consumer: rtrb::Consumer<f32>,
    /// Per-track FFT analyzer
    pub analyzer: dream_dsp::spectrum_analyzer::SpectrumAnalyzer,
    /// Cached last magnitudes
    pub last_magnitudes: Vec<f32>,
}

/// Thread-safe Tauri managed state for the real-time spectrum analyzer.
/// Supports both master spectrum and per-track spectrum for EQ display.
pub struct SpectrumState {
    pub inner: Mutex<SpectrumStateInner>,
    /// Per-track spectrum analyzers (index = track index).
    pub tracks: Vec<Mutex<TrackSpectrumInner>>,
}

impl AudioEngineHandle {
    /// Load an interleaved stereo buffer for preview playback.
    /// Uses ArcSwap::store() — lock-free, never blocks the audio thread.
    ///
    /// SSOT-FIX: Now accepts `source_sr` so the RT callback can advance
    /// the cursor at the correct rate (source_sr / device_sr) for pitch-correct preview.
    pub fn set_preview_buffer(&self, buffer: Vec<f32>, source_sr: u32) {
        self.preview_cursor
            .store(0, std::sync::atomic::Ordering::SeqCst);
        self.preview_source_sr
            .store(source_sr, std::sync::atomic::Ordering::Release);
        self.preview_buffer.store(Arc::new(Some(buffer)));
    }

    /// Stop preview and discard the buffer.
    pub fn clear_preview_buffer(&self) {
        self.preview_buffer.store(Arc::new(None));
        self.preview_cursor
            .store(0, std::sync::atomic::Ordering::SeqCst);
        self.preview_source_sr
            .store(0, std::sync::atomic::Ordering::Relaxed);
    }
}
