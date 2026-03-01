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

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicUsize};

use arc_swap::ArcSwap;
use dream_plugins::MidiEvent;

use dream_clip_engine::pool::ClipPool;
use dream_dsp::device_chain::DeviceChain;
use dream_dsp::dsp_processor::BuiltinEffectType;
use dream_ipc::metering::{MeterBank, linear_to_db, peak_decay_for_block};
use dream_ipc::{EngineCommand, MasterClock};
#[cfg(test)]
use dream_models::project::AudioClip;

use crate::render_callback::{MAX_BUFFER_FRAMES, MAX_TRACKS, RenderContext};
use crate::sampler::{SampleRackEngine, SamplerEngine};
#[path = "driver/automation.rs"]
pub(crate) mod automation;
#[path = "driver/cpal_backend.rs"]
mod cpal_backend;
#[path = "driver/executor.rs"]
mod executor;
#[path = "driver/graph_topology.rs"]
mod graph_topology;
#[path = "driver/midi_dispatcher.rs"]
pub mod midi_dispatcher;
#[path = "driver/rt_debug.rs"]
mod rt_debug;
#[path = "driver/snapshots.rs"]
mod snapshots;
pub use automation::{ExternalParamTarget, parse_external_param_target};
pub(crate) use automation::{apply_external_plugin_param_automation_block, apply_track_mixer_automation_sample_accurate};
#[cfg(test)]
use automation::apply_gain_pan_automation_sample_accurate;
use cpal_backend::{list_audio_devices_backend, resolve_output_setup};
pub use graph_topology::{
    PreparedGraphSnapshot, SharedPreparedGraphSnapshot, prepare_graph_snapshot_for_routing,
    resolve_master_runtime_slots,
};
use midi_dispatcher::MidiNoteMapState;
pub use rt_debug::{RtDebugSnapshot, SharedRtDebugStats};

// ── Shared Clip Snapshot (LOCK-FREE) ───────────────────────────────────
pub use snapshots::{
    AutomationPoint, ExternalPluginRuntimeSlot, ExternalParamAutomationLane, MidiFxRuntimeConfig,
    MidiTrackRuntime, PluginInstanceArc, SharedAutomationSnapshot, SharedClipSnapshot,
    SharedDiskStreamers, SharedExternalPluginSnapshot, SharedMidiSnapshot, SharedPluginRegistry,
    SharedRoutingSnapshot, SharedSampleRackSamples, SharedSamplerSamples, SharedSidechainSnapshot,
    TrackAutomationState,
};

// ── Constants ───────────────────────────────────────────────────────────

/// Default test tone frequency (A4 = 440 Hz).
#[cfg(test)]
const DEFAULT_FREQUENCY: f32 = 440.0;
/// Test tone amplitude for RT sanity checks in driver tests.
#[cfg(test)]
const TEST_TONE_AMPLITUDE: f32 = 0.25;

// AUD-049: FREQ_SMOOTHING removed — replaced with sample-rate-dependent
// coefficient computed at usage site (see AUD-010 fix).

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
pub struct AudioSharedState {
    pub clock: Arc<MasterClock>,
    pub meter_bank: Arc<MeterBank>,
    pub clip_pool: Arc<ArcSwap<ClipPool>>,
    pub clip_snapshot: Arc<SharedClipSnapshot>,
    pub midi_snapshot: Arc<SharedMidiSnapshot>,
    pub routing_snapshot: Arc<SharedRoutingSnapshot>,
    pub sidechain_snapshot: Arc<SharedSidechainSnapshot>,
    pub external_fx_snapshot: Arc<SharedExternalPluginSnapshot>,
    pub automation_snapshot: Arc<SharedAutomationSnapshot>,
    pub sampler_samples: Arc<SharedSamplerSamples>,
    pub sample_rack_samples: Arc<SharedSampleRackSamples>,
    pub prepared_graph_snapshot: Arc<SharedPreparedGraphSnapshot>,
    pub rt_debug_stats: Arc<SharedRtDebugStats>,
    pub plugin_registry: Arc<SharedPluginRegistry>,
    pub preview_buffer: Arc<ArcSwap<Option<Vec<f32>>>>,
    pub preview_cursor: Arc<AtomicUsize>,
    pub preview_source_sr: Arc<AtomicU32>,
    pub disk_streamers: Arc<SharedDiskStreamers>,
}

#[allow(clippy::too_many_arguments)]
pub fn start_audio_thread(
    consumer: rtrb::Consumer<EngineCommand>,
    prealloc_consumer: rtrb::Consumer<dream_ipc::prealloc_queue::PrebuiltDevice>,
    shared_state: AudioSharedState,
) -> Result<AudioStreamHandle, AudioDriverError> {
    start_audio_thread_on_device(
        consumer,
        prealloc_consumer,
        shared_state,
        None,
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
    consumer: rtrb::Consumer<EngineCommand>,
    prealloc_consumer: rtrb::Consumer<dream_ipc::prealloc_queue::PrebuiltDevice>,
    shared_state: AudioSharedState,
    preferred_output_device: Option<&str>,
    stream_error_tx: Option<std::sync::mpsc::SyncSender<String>>,
    preferred_buffer_size: Option<u32>,
) -> Result<AudioStreamHandle, AudioDriverError> {
    executor::start_audio_thread_on_device_impl(
        consumer,
        prealloc_consumer,
        shared_state,
        preferred_output_device,
        stream_error_tx,
        preferred_buffer_size,
    )
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
    list_audio_devices_backend()
}

#[cfg(test)]
#[path = "driver/tests.rs"]
mod tests;
