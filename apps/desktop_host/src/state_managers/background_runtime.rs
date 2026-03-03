use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::mpsc::Receiver;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager};
use uuid::Uuid;

use crate::plugin_sandbox_recovery::{
    bypass_plugin_slots_in_project, set_plugin_slots_bypass_in_project,
};
use crate::state_managers::{AudioEngineHandle, ClipPoolState, PluginHostState};

#[derive(Clone, Serialize)]
struct TransportTelemetryPayload {
    is_playing: bool,
    position_frames: i64,
    position_seconds: f64,
    position_beats: f64,
    bpm: f64,
    sample_rate: f64,
    loop_enabled: bool,
    loop_start: i64,
    loop_end: i64,
    output_latency_frames: u32,
    telemetry_timestamp_ms: u128,
}

#[derive(Clone, Serialize, Default)]
struct SystemPerformancePayload {
    /// Overall CPU usage percentage (0–100).
    cpu_usage: f32,
    /// Used RAM in megabytes.
    ram_used_mb: u64,
    /// Total system RAM in megabytes.
    ram_total_mb: u64,
    /// Process (Dream DAW) memory in megabytes.
    process_memory_mb: u64,
    /// Audio thread DSP load percentage (0–100). This is THE critical
    /// metric for DAW users — shows how close the session is to dropout.
    dsp_load: f32,
}

#[derive(Clone, Serialize)]
struct TelemetryTickPayload {
    transport: TransportTelemetryPayload,
    performance: SystemPerformancePayload,
}

fn build_meters_binary_packet(handle: &AudioEngineHandle) -> Vec<u8> {
    handle.meter_bank.pack_meters_binary()
}

/// Spawns non-audio background threads used by the desktop host runtime.
///
/// All threads are explicitly detached and terminate when `AudioEngineHandle::is_shutting_down`
/// flips to true.
pub(crate) fn spawn_background_runtime_threads(
    app: &tauri::AppHandle,
    stream_error_rx: Receiver<String>,
) {
    // ── Telemetry Push Thread (30fps) ─────────────────────────
    let telemetry_app = app.clone();
    if let Err(err) = std::thread::Builder::new()
        .name("telemetry-push".into())
        .spawn(move || {
            let mut telemetry_tick_count: u64 = 0;

            // System performance monitoring — refreshed every ~1s (every 30 ticks)
            let mut sys = sysinfo::System::new();
            let mut cached_perf = SystemPerformancePayload::default();

            loop {
                {
                    let handle: tauri::State<'_, AudioEngineHandle> = telemetry_app.state();
                    if handle.is_shutting_down.load(Ordering::Relaxed) {
                        log::info!("[Telemetry] Shutdown signal received, exiting thread.");
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(33)); // ~30fps
                telemetry_tick_count += 1;
                if telemetry_tick_count.is_multiple_of(150) {
                    log::debug!("[Telemetry] heartbeat tick={}", telemetry_tick_count);
                }

                // Refresh expensive system metrics every ~1s (30 ticks × 33ms ≈ 1s)
                if telemetry_tick_count.is_multiple_of(30) {
                    sys.refresh_cpu_usage();
                    sys.refresh_memory();

                    cached_perf.cpu_usage = sys.global_cpu_usage();
                    cached_perf.ram_used_mb = sys.used_memory() / (1024 * 1024);
                    cached_perf.ram_total_mb = sys.total_memory() / (1024 * 1024);

                    // Process memory via sysinfo
                    let pid = sysinfo::Pid::from_u32(std::process::id());
                    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
                    cached_perf.process_memory_mb = sys
                        .process(pid)
                        .map(|p| p.memory() / (1024 * 1024))
                        .unwrap_or(0);
                }

                let handle: tauri::State<'_, AudioEngineHandle> = telemetry_app.state();

                let transport = {
                    let state = match handle.playback_state.lock() {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                    let frames = handle.master_clock.position();
                    let seconds = frames as f64 / state.sample_rate;
                    let beats = seconds * state.bpm / 60.0;
                    let telemetry_timestamp_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0);
                    TransportTelemetryPayload {
                        is_playing: state.is_playing,
                        position_frames: frames,
                        position_seconds: seconds,
                        position_beats: beats,
                        bpm: state.bpm,
                        sample_rate: state.sample_rate,
                        loop_enabled: state.loop_enabled,
                        loop_start: state.loop_start,
                        loop_end: state.loop_end,
                        output_latency_frames: handle.output_latency_frames,
                        telemetry_timestamp_ms,
                    }
                };

                // DSP load is read every tick (changes at 30fps audio callback rate)
                cached_perf.dsp_load = handle.rt_debug_stats.dsp_load_percent();

                let payload = TelemetryTickPayload {
                    transport,
                    performance: cached_perf.clone(),
                };

                let _ = telemetry_app.emit("telemetry_tick", payload);
                let _ = telemetry_app.emit(
                    "telemetry_meters_binary",
                    build_meters_binary_packet(&handle),
                );

                // ENTERPRISE: Check BOTH VST3 and VST2 dirty flags.
                // VST3: IComponentHandler.performEdit / setDirty / restartComponent
                // VST2: audioMasterAutomate / audioMasterUpdateDisplay
                let vst3_dirty = dream_plugins::vst3_host::take_plugin_state_dirty();
                let vst2_dirty = dream_plugins::vst2_host::take_plugin_state_dirty();
                if vst3_dirty || vst2_dirty {
                    let registry: tauri::State<'_, crate::state_managers::ProjectRegistry> = telemetry_app.state();
                    if let Some(pstate) = registry.get_active_project() {
                        if let Ok(project) = pstate.project.lock() {
                            let _ = pstate.mark_dirty(&project.name, Some(&telemetry_app));
                        }
                    }
                }

                // Keep external FX runtime snapshot eventually consistent even when
                // individual command paths rebuild only clip/routing snapshots.
                // This prevents stale master/track VST chains in the audio thread.
                if telemetry_tick_count.is_multiple_of(15) {
                    let clip_pool_state: tauri::State<'_, ClipPoolState> = telemetry_app.state();
                    let plugin_host_state: tauri::State<'_, PluginHostState> =
                        telemetry_app.state();
                    let registry: tauri::State<'_, crate::state_managers::ProjectRegistry> = telemetry_app.state();
                    plugin_host_state.publish_registry();
                    if let Some(pstate) = registry.get_active_project() {
                        if let Ok(project) = pstate.project.lock() {
                            let slot_instance_map = plugin_host_state.slot_instance_snapshot();
                            clip_pool_state
                                .rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
                        }
                    }
                }
            }
        })
    {
        log::warn!("Failed to spawn telemetry thread: {err}");
    }

    // ── Plugin Sandbox Watchdog Thread ────────────────────────
    let sandbox_app = app.clone();
    if let Err(err) = std::thread::Builder::new()
        .name("plugin-sandbox-watchdog".into())
        .spawn(move || loop {
            {
                let sandbox_app_state: tauri::State<'_, AudioEngineHandle> = sandbox_app.state();
                if sandbox_app_state.is_shutting_down.load(Ordering::Relaxed) {
                    log::info!("[Watchdog] Shutdown signal received, exiting thread.");
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(75));
            let plugin_host_state: tauri::State<'_, PluginHostState> = sandbox_app.state();
            let (snapshot, crashes, recoveries) =
                match plugin_host_state.tick_sandbox_watchdog_with_events() {
                    Ok(v) => v,
                    Err(_) => continue,
                };
            let _ = sandbox_app.emit("plugin_sandbox_tick", &snapshot);
            if !crashes.is_empty() || !recoveries.is_empty() {
                let mut failed_instance_ids: HashSet<Uuid> = crashes
                    .iter()
                    .filter(|c| !c.auto_restarted)
                    .map(|c| c.instance_id)
                    .collect();
                let recovered_instance_ids: HashSet<Uuid> =
                    recoveries.iter().map(|r| r.instance_id).collect();

                failed_instance_ids.retain(|id| !recovered_instance_ids.contains(id));

                let failed_slot_ids = plugin_host_state.slot_ids_for_instance_ids(&failed_instance_ids);
                let recovered_slot_ids =
                    plugin_host_state.slot_ids_for_instance_ids(&recovered_instance_ids);

                if !failed_slot_ids.is_empty() || !recovered_slot_ids.is_empty() {
                    let clip_pool_state: tauri::State<'_, ClipPoolState> = sandbox_app.state();
                    let registry: tauri::State<'_, crate::state_managers::ProjectRegistry> = sandbox_app.state();
                    if let Some(project_state) = registry.get_active_project() {
                        if let Ok(mut project) = project_state.project.lock() {
                        let bypassed_changed = if failed_slot_ids.is_empty() {
                            0
                        } else {
                            bypass_plugin_slots_in_project(&mut project, &failed_slot_ids)
                        };
                        let recovered_changed = if recovered_slot_ids.is_empty() {
                            0
                        } else {
                            set_plugin_slots_bypass_in_project(
                                &mut project,
                                &recovered_slot_ids,
                                false,
                            )
                        };

                        if bypassed_changed > 0 || recovered_changed > 0 {
                            clip_pool_state.rebuild_routing_only(&project);
                            let slot_instance_map = plugin_host_state.slot_instance_snapshot();
                            clip_pool_state.rebuild_external_fx_snapshot(
                                &project,
                                slot_instance_map.as_ref(),
                            );
                            let _ = project_state.mark_dirty(&project.name, Some(&sandbox_app));

                            if bypassed_changed > 0 {
                                let _ = sandbox_app.emit(
                                    "plugin_sandbox_auto_bypass",
                                    serde_json::json!({
                                        "instanceIds": failed_instance_ids.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
                                        "slotIds": failed_slot_ids.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                                        "changedSlots": bypassed_changed,
                                    }),
                                );
                            }

                            if recovered_changed > 0 {
                                let _ = sandbox_app.emit(
                                    "plugin_sandbox_auto_recovered",
                                    serde_json::json!({
                                        "instanceIds": recovered_instance_ids.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
                                        "slotIds": recovered_slot_ids.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                                        "changedSlots": recovered_changed,
                                    }),
                                );
                            }
                        }
                    }
                }
            }
            }
            for crash in crashes {
                if recoveries.iter().any(|r| r.instance_id == crash.instance_id) {
                    continue;
                }
                let _ = sandbox_app.emit("plugin_sandbox_crashed", &crash);
            }
            for recovery in recoveries {
                let _ = sandbox_app.emit("plugin_sandbox_recovered", &recovery);
            }

            // ── AUTO-DISABLE: when ALL sandbox instances are bypassed, it means
            // every daemon process failed (e.g. hangs during VST3 load without
            // Cocoa/NSApplication). Fall back to in-process plugin loading for
            // the rest of this session.
            if !snapshot.instances.is_empty()
                && snapshot.instances.iter().all(|i| i.bypass_requested)
                && !plugin_host_state.is_sandbox_disabled_for_session()
            {
                plugin_host_state.disable_sandbox_for_session();

                // Unload all stale sandboxed instances so they can be reloaded
                // in-process on the next ensure_loaded_instance_for_slot call.
                let stale_ids: Vec<Uuid> = snapshot
                    .instances
                    .iter()
                    .map(|i| i.plugin_instance_id)
                    .collect();
                for id in &stale_ids {
                    let _ = plugin_host_state.unload_instance(*id);
                }
                log::warn!(
                    "[PluginSandbox] Evicted {} stale sandbox instance(s); \
                     project reload will use in-process loading",
                    stale_ids.len()
                );

                let _ = sandbox_app.emit(
                    "plugin_sandbox_session_disabled",
                    serde_json::json!({
                        "reason": "All sandbox daemon processes failed to start. Falling back to in-process plugin loading.",
                        "evictedInstanceIds": stale_ids.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
                    }),
                );
            }
        })
    {
        log::warn!("Failed to spawn plugin sandbox watchdog thread: {err}");
    }

    // ── Audio Stream Error Relay (event-driven, zero polling) ─
    let stream_error_app = app.clone();
    if let Err(err) = std::thread::Builder::new()
        .name("audio-stream-error-relay".into())
        .spawn(move || {
            while let Ok(err_msg) = stream_error_rx.recv() {
                let payload = serde_json::json!({
                    "error": err_msg,
                    "at_ms": std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0),
                });
                let _ = stream_error_app.emit("audio_stream_error", payload);
            }
        })
    {
        log::warn!("Failed to spawn audio stream error relay: {err}");
    }
}

pub(crate) fn configure_app_runtime(app: &tauri::App, stream_error_rx: Receiver<String>) {
    spawn_background_runtime_threads(&app.handle(), stream_error_rx);
    install_macos_transport_monitor(&app.handle());
    log::info!(
        "Dream DAW v{} — Audio engine initialized ({} IPC commands registered)",
        app.package_info().version,
        33
    );
}

pub(crate) fn shutdown_plugins_on_exit(app_handle: &tauri::AppHandle, event: tauri::RunEvent) {
    if let tauri::RunEvent::Exit = event {
        log::info!("[Dream DAW] RunEvent::Exit — initiating graceful shutdown");
        let plugin_state: tauri::State<'_, PluginHostState> = app_handle.state();
        plugin_state.shutdown_all_plugins();
        log::info!("[Dream DAW] Graceful shutdown complete, exiting");
    }
}

#[cfg(target_os = "macos")]
fn install_macos_transport_monitor(app_handle: &tauri::AppHandle) {
    use std::os::raw::c_ulong;
    use std::sync::Arc;

    use objc::runtime::{BOOL, Class, Object, YES};
    use objc::{msg_send, sel, sel_impl};

    let transport_app = Arc::new(app_handle.clone());
    // SAFETY: Cocoa local event monitor must be installed through Objective-C runtime APIs.
    unsafe {
        // NSEventMaskKeyDown = 1 << 10
        let mask: c_ulong = 1 << 10;

        let transport_app_clone = Arc::clone(&transport_app);
        let block = objc::rc::autoreleasepool(|| {
            let block = block::ConcreteBlock::new(move |event: *mut Object| -> *mut Object {
                let keycode: u16 = msg_send![event, keyCode];
                if keycode == 49 {
                    let window: *mut Object = msg_send![event, window];
                    if !window.is_null() {
                        let first_responder: *mut Object = msg_send![window, firstResponder];
                        if !first_responder.is_null() {
                            let class_ptr: *const Class = msg_send![first_responder, class];
                            let c_name = objc::runtime::class_getName(class_ptr);
                            let name = std::ffi::CStr::from_ptr(c_name).to_string_lossy();
                            if name.contains("WebView") {
                                return event;
                            }
                        }
                    }

                    let is_repeat: BOOL = msg_send![event, isARepeat];
                    if is_repeat != YES {
                        let app_ref = Arc::clone(&transport_app_clone);
                        let handle: tauri::State<'_, AudioEngineHandle> = app_ref.state();
                        if let Ok(mut state) = handle.playback_state.lock() {
                            let new_state = !state.is_playing;
                            let sr = state.sample_rate;
                            state.is_playing = new_state;
                            drop(state);

                            if let Ok(mut prod) = handle.producer.lock() {
                                if new_state {
                                    let _ = prod
                                        .push(dream_ipc::EngineCommand::SetTimelineSampleRate(sr));
                                }
                                let _ = prod.push(dream_ipc::EngineCommand::SetPlay(new_state));
                            }

                            log::info!(
                                "[NSEventMonitor] Space → {}",
                                if new_state { "play" } else { "stop" }
                            );
                        }
                        return std::ptr::null_mut();
                    }
                }
                event
            });
            block.copy()
        });

        if let Some(ns_event_class) = Class::get("NSEvent") {
            let _: *mut Object = msg_send![
                ns_event_class,
                addLocalMonitorForEventsMatchingMask: mask
                handler: &*block
            ];
            // Must outlive app lifetime.
            std::mem::forget(block);
        } else {
            log::warn!(
                "[NSEventMonitor] NSEvent class unavailable; skipping transport monitor install"
            );
        }
    }
    log::info!("[NSEventMonitor] Installed Space key local monitor for transport control");
}

#[cfg(not(target_os = "macos"))]
fn install_macos_transport_monitor(_app_handle: &tauri::AppHandle) {}
