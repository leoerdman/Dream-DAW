use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use arc_swap::ArcSwap;
use dream_ipc::metering::MeterBank;
use dream_ipc::{EngineCommand, MasterClock};
use dream_models::PlaybackState;

use crate::settings::SettingsState;
use crate::state_managers::{
    AudioEngineHandle, AutomationRuntime, ClipPoolState, MidiInputRuntime, PluginHostState,
    ProjectState, RecordingRuntime, SpectrumState, SpectrumStateInner,
};

pub(crate) struct RuntimeBootstrap {
    pub(crate) engine_handle: AudioEngineHandle,
    pub(crate) project_state: ProjectState,
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
    let master_clock = Arc::new(MasterClock::new());
    let meter_bank = Arc::new(MeterBank::new(64));
    let mut plugin_host_state = PluginHostState::new();

    let clip_pool_state = ClipPoolState::new();
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

    let app_data_dir_for_settings = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.dreamdaw.desktop");
    let settings_state = SettingsState::load_from_disk(&app_data_dir_for_settings);
    if let Err(e) = settings_state.save_to_user_folder() {
        log::warn!("Failed to create initial settings file: {}", e);
    }

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
    let mut stream = dream_engine::driver::start_audio_thread_on_device(
        consumer,
        clock_for_engine,
        meter_for_engine,
        clip_pool_for_engine,
        snapshot_for_engine,
        midi_snapshot_for_engine,
        routing_snapshot_for_engine,
        sidechain_snapshot_for_engine,
        external_fx_snapshot_for_engine,
        automation_snapshot_for_engine,
        sampler_samples_for_engine,
        sample_rack_samples_for_engine,
        prepared_graph_snapshot_for_engine,
        rt_debug_stats_for_engine,
        plugin_registry_for_engine,
        preview_buffer_for_engine,
        preview_cursor_for_engine,
        preview_source_sr_for_engine,
        disk_streamers_for_engine,
        preferred_output_device.as_deref(),
        Some(stream_error_tx.clone()),
    )
    .map_err(|err| format!("failed to start audio engine: {err}"))?;

    let output_latency_frames = stream.output_latency_frames;
    let resolved_output_device = stream.output_device_name.clone();

    let spectrum_consumer = stream.spectrum_consumer.take();
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
    if should_persist_resolved_output && let Err(e) = settings_state.save_to_user_folder() {
        log::warn!("Failed to persist resolved output device: {}", e);
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
    };

    Ok(RuntimeBootstrap {
        engine_handle,
        project_state: ProjectState::new(),
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
