use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use arc_swap::ArcSwap;
use dream_ipc::metering::MeterBank;
use dream_ipc::{EngineCommand, MasterClock};
use dream_models::PlaybackState;

use crate::settings::SettingsState;
use crate::state_managers::{
    AudioEngineHandle, AutomationRuntime, ClipPoolState, MidiInputRuntime, PluginHostState,
    ProjectRegistry, ProjectState, RecordingRuntime, SpectrumState, SpectrumStateInner, TrackSpectrumInner,
};

pub(crate) struct RuntimeBootstrap {
    pub(crate) engine_handle: AudioEngineHandle,
    pub(crate) project_registry: ProjectRegistry,
    pub(crate) clip_pool_state: ClipPoolState,
    pub(crate) settings_state: SettingsState,
    pub(crate) recording_runtime: RecordingRuntime,
    pub(crate) automation_runtime: AutomationRuntime,
    pub(crate) midi_input_runtime: MidiInputRuntime,
    pub(crate) plugin_host_state: PluginHostState,
    pub(crate) spectrum_state: SpectrumState,
    pub(crate) stream_error_rx: std::sync::mpsc::Receiver<String>,
}

pub(crate) fn initialize_runtime() -> Result<RuntimeBootstrap, String> {
    let (mut producer, consumer) = rtrb::RingBuffer::<EngineCommand>::new(4096);
    let (prealloc_producer, prealloc_consumer) =
        dream_ipc::prealloc_queue::new_prealloc_queue();
    let master_clock = Arc::new(MasterClock::new());
    // ENTERPRISE FIX: Allocate meter slots for the maximum number of tracks
    // supported by the engine. Previously was 64, which caused tracks 64+
    // (e.g., in a 71-track Ableton import) to have zero/frozen meters.
    let meter_bank = Arc::new(MeterBank::new(dream_engine::render_callback::MAX_TRACKS));

    let app_data_dir_for_settings = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.dreamdaw.desktop");
    let settings_state = SettingsState::load_from_disk(&app_data_dir_for_settings);
    settings_state.request_save();
    let (host_sample_rate, host_buffer_size) = settings_state
        .settings
        .lock()
        .ok()
        .map(|s| {
            (
                // BUF-013/014 FIX: Validate settings before use to prevent
                // division-by-zero or excessive allocation from corrupted files.
                f64::from(crate::settings::validated_sample_rate(s.sample_rate)),
                usize::try_from(crate::settings::validated_buffer_size(s.buffer_size)).unwrap_or(512),
            )
        })
        .unwrap_or((44_100.0, 512));
    let preferred_buffer_size_for_cpal = Some(host_buffer_size as u32);
    let mut plugin_host_state = PluginHostState::new_with_io(host_sample_rate, host_buffer_size);

    let mut clip_pool_state = ClipPoolState::new();
    let bootstrap_project = dream_models::project::Project::default();
    clip_pool_state.rebuild_snapshot(&bootstrap_project);
    let clip_pool_for_engine = Arc::clone(&clip_pool_state.arc_pool);
    let snapshot_for_engine = Arc::clone(&clip_pool_state.snapshot);

    let midi_snapshot = Arc::new(dream_engine::driver::SharedMidiSnapshot::new());
    let automation_runtime = AutomationRuntime::new();
    let midi_input_runtime = MidiInputRuntime::new();
    crate::state_managers::rebuild_automation_snapshot_from_project(
        &bootstrap_project,
        &automation_runtime,
    );
    let sampler_samples = Arc::new(dream_engine::driver::SharedSamplerSamples::new());
    let sample_rack_samples = Arc::new(dream_engine::driver::SharedSampleRackSamples::new());
    let routing_snapshot_for_engine = Arc::clone(&clip_pool_state.routing_snapshot);
    let prepared_graph_snapshot_for_engine = Arc::clone(&clip_pool_state.prepared_graph_snapshot);
    let sidechain_snapshot_for_engine = Arc::clone(&clip_pool_state.sidechain_snapshot);
    let external_fx_snapshot_for_engine = Arc::clone(&clip_pool_state.external_fx_snapshot);
    let midi_snapshot_for_engine = Arc::clone(&midi_snapshot);
    let automation_snapshot_for_engine = Arc::clone(&automation_runtime.snapshot);
    let sampler_samples_for_engine = Arc::clone(&sampler_samples);
    let sample_rack_samples_for_engine = Arc::clone(&sample_rack_samples);
    let clip_pool_for_handle = Arc::clone(&clip_pool_state.arc_pool);
    let clip_snapshot_for_handle = Arc::clone(&clip_pool_state.snapshot);
    let midi_snapshot_for_handle = Arc::clone(&midi_snapshot);
    let routing_snapshot_for_handle = Arc::clone(&clip_pool_state.routing_snapshot);
    let prepared_graph_snapshot_for_handle = Arc::clone(&clip_pool_state.prepared_graph_snapshot);
    let sidechain_snapshot_for_handle = Arc::clone(&clip_pool_state.sidechain_snapshot);
    let external_fx_snapshot_for_handle = Arc::clone(&clip_pool_state.external_fx_snapshot);
    let automation_snapshot_for_handle = Arc::clone(&automation_runtime.snapshot);
    let sampler_samples_for_handle = Arc::clone(&sampler_samples);
    let sample_rack_samples_for_handle = Arc::clone(&sample_rack_samples);
    let plugin_host_for_handle = Arc::clone(&plugin_host_state.host);
    let plugin_registry = Arc::new(dream_engine::driver::SharedPluginRegistry::new());
    plugin_host_state.set_plugin_registry(Arc::clone(&plugin_registry));
    clip_pool_state.set_plugin_registry(Arc::clone(&plugin_registry));
    // BUG-8 FIX: Create shared internal latency snapshot for PDC.
    // Audio thread publishes per-track internal effect latencies here.
    // Background thread reads during latency polling.
    let internal_latency_snapshot = Arc::new(
        dream_engine::render_callback::SharedInternalLatencySnapshot::new(
            dream_engine::render_callback::MAX_TRACKS,
        ),
    );
    clip_pool_state.set_internal_latency_snapshot(Arc::clone(&internal_latency_snapshot));
    let internal_latency_for_engine = Arc::clone(&internal_latency_snapshot);
    let plugin_registry_for_engine = Arc::clone(&plugin_registry);
    let plugin_registry_for_handle = Arc::clone(&plugin_registry);
    let rt_debug_stats = Arc::new(dream_engine::driver::SharedRtDebugStats::new());
    let rt_debug_stats_for_engine = Arc::clone(&rt_debug_stats);
    let rt_debug_stats_for_handle = Arc::clone(&rt_debug_stats);

    let preview_buffer: Arc<ArcSwap<Option<Vec<f32>>>> = Arc::new(ArcSwap::from_pointee(None));
    let preview_cursor: Arc<std::sync::atomic::AtomicUsize> =
        Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let preview_source_sr: Arc<std::sync::atomic::AtomicU32> =
        Arc::new(std::sync::atomic::AtomicU32::new(0));
    let disk_streamers = Arc::new(dream_engine::driver::SharedDiskStreamers::new());
    let preview_buffer_for_engine = Arc::clone(&preview_buffer);
    let preview_cursor_for_engine = Arc::clone(&preview_cursor);
    let preview_source_sr_for_engine = Arc::clone(&preview_source_sr);
    let disk_streamers_for_engine = Arc::clone(&disk_streamers);

    let preferred_output_device = {
        let settings = settings_state.settings.lock().ok();
        settings
            .as_ref()
            .map(|s| s.output_device.clone())
            .filter(|v| !v.trim().is_empty())
    };
    let (stream_error_tx, stream_error_rx) = std::sync::mpsc::sync_channel::<String>(4);

    let clock_for_engine = Arc::clone(&master_clock);
    let meter_for_engine = Arc::clone(&meter_bank);
    let shared_state = dream_engine::driver::AudioSharedState {
        clock: clock_for_engine,
        meter_bank: meter_for_engine,
        clip_pool: clip_pool_for_engine,
        clip_snapshot: snapshot_for_engine,
        midi_snapshot: midi_snapshot_for_engine,
        routing_snapshot: routing_snapshot_for_engine,
        sidechain_snapshot: sidechain_snapshot_for_engine,
        external_fx_snapshot: external_fx_snapshot_for_engine,
        automation_snapshot: automation_snapshot_for_engine,
        sampler_samples: sampler_samples_for_engine,
        sample_rack_samples: sample_rack_samples_for_engine,
        prepared_graph_snapshot: prepared_graph_snapshot_for_engine,
        rt_debug_stats: rt_debug_stats_for_engine,
        plugin_registry: plugin_registry_for_engine,
        preview_buffer: preview_buffer_for_engine,
        preview_cursor: preview_cursor_for_engine,
        preview_source_sr: preview_source_sr_for_engine,
        disk_streamers: disk_streamers_for_engine,
        internal_latency_snapshot: internal_latency_for_engine,
    };

    let mut stream = dream_engine::driver::start_audio_thread_on_device(
        consumer,
        prealloc_consumer,
        shared_state,
        preferred_output_device.as_deref(),
        Some(stream_error_tx.clone()),
        preferred_buffer_size_for_cpal,
    )
    .map_err(|err| format!("failed to start audio engine: {err}"))?;

    let output_latency_frames = stream.output_latency_frames;
    let resolved_output_device = stream.output_device_name.clone();

    // ── CRITICAL FIX: Sync PluginHost to actual device config ────────────
    // The PluginHostState was initialized with user-settings SR/buffer_size
    // (e.g., 44100/512), but cpal may have resolved a different device config.
    // If plugins are activated with a buffer_size smaller than the device's
    // actual block size, their process() guard (num_frames > max_buffer_size)
    // silently falls through to passthrough — making VST3 FX like FabFilter
    // Pro-Q 4 appear to do nothing, and instruments like Serum2 display
    // "DAW suspended processing".
    //
    // Use the actual device sample rate, and 8192 (MAX_BUFFER_FRAMES) as the
    // plugin buffer size so scratch buffers can handle any device block size.
    {
        let actual_sr = f64::from(stream.sample_rate_hz);
        // Use the canonical MAX_BUFFER_FRAMES constant (single source of truth)
        // to ensure plugin scratch buffers are always large enough for any
        // callback block size.
        let plugin_max_buffer = dream_engine::render_callback::MAX_BUFFER_FRAMES;
        if let Err(e) = plugin_host_state.update_audio_config(actual_sr, plugin_max_buffer) {
            log::warn!(
                "[RuntimeBootstrap] Failed to sync plugin host to device config: {}",
                e
            );
        }
    }

    let spectrum_consumer = stream.spectrum_consumer.take();
    let per_track_consumers = std::mem::take(&mut stream.per_track_spectrum_consumers);

    // Build per-track spectrum analyzers from per-track consumers
    let track_analyzers: Vec<Mutex<TrackSpectrumInner>> = per_track_consumers
        .into_iter()
        .map(|consumer| {
            Mutex::new(TrackSpectrumInner {
                consumer,
                analyzer: dream_dsp::spectrum_analyzer::SpectrumAnalyzer::new(
                    stream.sample_rate_hz as f32,
                ),
                last_magnitudes: vec![
                    dream_dsp::spectrum_analyzer::FLOOR_DB;
                    dream_dsp::spectrum_analyzer::OUTPUT_BINS
                ],
            })
        })
        .collect();

    let spectrum_state = if let Some(consumer) = spectrum_consumer {
        SpectrumState {
            inner: Mutex::new(SpectrumStateInner {
                consumer,
                analyzer: dream_dsp::spectrum_analyzer::SpectrumAnalyzer::new(
                    stream.sample_rate_hz as f32,
                ),
                last_magnitudes: vec![
                    dream_dsp::spectrum_analyzer::FLOOR_DB;
                    dream_dsp::spectrum_analyzer::OUTPUT_BINS
                ],
            }),
            tracks: track_analyzers,
        }
    } else {
        let (_producer, consumer) = rtrb::RingBuffer::<f32>::new(64);
        SpectrumState {
            inner: Mutex::new(SpectrumStateInner {
                consumer,
                analyzer: dream_dsp::spectrum_analyzer::SpectrumAnalyzer::new(
                    stream.sample_rate_hz as f32,
                ),
                last_magnitudes: vec![
                    dream_dsp::spectrum_analyzer::FLOOR_DB;
                    dream_dsp::spectrum_analyzer::OUTPUT_BINS
                ],
            }),
            tracks: track_analyzers,
        }
    };

    let mut should_persist_resolved_output = false;
    {
        if let Ok(mut s) = settings_state.settings.lock()
            && s.output_device != resolved_output_device
        {
            s.output_device = resolved_output_device;
            should_persist_resolved_output = true;
        }
    }
    if should_persist_resolved_output {
        settings_state.request_save();
    }

    let playback_state = PlaybackState {
        sample_rate: bootstrap_project.sample_rate.max(1.0),
        ..PlaybackState::default()
    };
    let _ = producer.push(EngineCommand::SetTimelineSampleRate(
        playback_state.sample_rate,
    ));

    let engine_handle = AudioEngineHandle {
        producer: Mutex::new(producer),
        master_clock,
        playback_state: Mutex::new(playback_state),
        meter_bank,
        _stream: Mutex::new(Some(Box::new(stream))),
        preview_buffer,
        preview_cursor,
        preview_source_sr,
        disk_streamers,
        export_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        clip_pool: clip_pool_for_handle,
        clip_snapshot: clip_snapshot_for_handle,
        midi_snapshot: midi_snapshot_for_handle,
        routing_snapshot: routing_snapshot_for_handle,
        prepared_graph_snapshot: prepared_graph_snapshot_for_handle,
        sidechain_snapshot: sidechain_snapshot_for_handle,
        external_fx_snapshot: external_fx_snapshot_for_handle,
        automation_snapshot: automation_snapshot_for_handle,
        sampler_samples: sampler_samples_for_handle,
        sample_rack_samples: sample_rack_samples_for_handle,
        _plugin_host: plugin_host_for_handle,
        plugin_registry: plugin_registry_for_handle,
        rt_debug_stats: rt_debug_stats_for_handle,
        output_latency_frames,
        stream_error_tx,
        is_shutting_down: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        frontend_ready: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        prealloc_producer: Mutex::new(prealloc_producer),
        internal_latency_snapshot: internal_latency_snapshot,
    };

    let project_registry = ProjectRegistry::new();
    let initial_project = Arc::new(ProjectState::new());
    project_registry.add_project(initial_project.clone());
    project_registry.set_active_project(initial_project.id);
    project_registry.set_audio_active_project(initial_project.id);

    Ok(RuntimeBootstrap {
        engine_handle,
        project_registry,
        clip_pool_state,
        settings_state,
        recording_runtime: RecordingRuntime::new(),
        automation_runtime,
        midi_input_runtime,
        plugin_host_state,
        spectrum_state,
        stream_error_rx,
    })
}
