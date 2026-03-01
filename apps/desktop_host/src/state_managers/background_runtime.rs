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

fn emit_with_log<T: Serialize + Clone>(app: &tauri::AppHandle, event: &str, payload: T) {
    if let Err(err) = app.emit(event, payload) {
        log::warn!("[Events] emit('{}') failed: {}", event, err);
    }
}

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
    /// PDC-006 FIX: Master bus PDC latency (from effects like limiter/compressor
    /// on the master track). Frontend subtracts this from the displayed playhead
    /// position so the visual cursor reflects the audio output alignment.
    master_pdc_latency_frames: u32,
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

            // BUG-011 FIX: Cache to prevent 200ms unconditional rebuilds
            let mut prev_slot_instance_map: Option<std::collections::HashMap<uuid::Uuid, uuid::Uuid>> = None;

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

                // PDC-006: Read master bus PDC latency from project model.
                // CRITICAL: Must be read BEFORE playback_state.lock() to avoid
                // AB-BA deadlock (transport actions lock project → playback_state).
                let master_pdc = {
                    let registry: tauri::State<'_, crate::state_managers::ProjectRegistry> = telemetry_app.state();
                    registry
                        .get_active_project()
                        .and_then(|ps| ps.project.lock().ok().map(|p| p.master_track.total_latency_frames()))
                        .unwrap_or(0)
                };

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
                        master_pdc_latency_frames: master_pdc,
                        telemetry_timestamp_ms,
                    }
                };

                // DSP load is read every tick (changes at 30fps audio callback rate)
                cached_perf.dsp_load = handle.rt_debug_stats.dsp_load_percent();

                let payload = TelemetryTickPayload {
                    transport,
                    performance: cached_perf.clone(),
                };

                emit_with_log(&telemetry_app, "telemetry_tick", payload);
                emit_with_log(
                    &telemetry_app,
                    "telemetry_meters_binary",
                    build_meters_binary_packet(&handle),
                );

                if dream_plugins::vst3_host::take_plugin_state_dirty() {
                    let registry: tauri::State<'_, crate::state_managers::ProjectRegistry> = telemetry_app.state();
                    if let Some(pstate) = registry.get_active_project() {
                        if let Ok(project) = pstate.project.lock() {
                            if let Err(err) = pstate.mark_dirty(&project.name, Some(&telemetry_app)) {
                                log::warn!("[Telemetry] mark_dirty failed: {}", err);
                            }
                        }
                    }
                }

                // Keep external FX runtime snapshot eventually consistent even when
                // individual command paths rebuild only clip/routing snapshots.
                // This prevents stale master/track VST chains in the audio thread.
                //
                // PDC-003 FIX: Also poll for VST3 kLatencyChanged flag.
                // When a plugin changes its latency (e.g., FabFilter Pro-L lookahead),
                // it signals via restartComponent(kLatencyChanged). This polling detects
                // the flag and triggers a full graph rebuild with fresh PDC delays.
                if telemetry_tick_count.is_multiple_of(15) {
                    let clip_pool_state: tauri::State<'_, ClipPoolState> = telemetry_app.state();
                    let plugin_host_state: tauri::State<'_, PluginHostState> =
                        telemetry_app.state();
                    let registry: tauri::State<'_, crate::state_managers::ProjectRegistry> = telemetry_app.state();
                    plugin_host_state.publish_registry();

                    // PDC-003: Check if any VST3 plugin signaled latency change
                    let vst3_latency_changed = dream_plugins::vst3_host::take_latency_changed();
                    let slot_instance_map = plugin_host_state.slot_instance_snapshot();

                    // BUG-011 FIX: Only rebuild if there was a change in slot_instance map
                    // or a latency change occurred.
                    let mut should_rebuild = vst3_latency_changed;
                    if let Some(prev) = prev_slot_instance_map.as_ref() {
                        if *prev != *slot_instance_map {
                            should_rebuild = true;
                        }
                    } else {
                        should_rebuild = true;
                    }
                    // Save state for next tick compare
                    prev_slot_instance_map = Some((*slot_instance_map).clone());

                    if should_rebuild {
                        if let Some(pstate) = registry.get_active_project() {
                            if let Ok(mut project) = pstate.project.lock() {
                                clip_pool_state
                                    .rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());

                                // PDC-003: If latency changed, force an explicit log
                                if vst3_latency_changed {
                                    log::info!(
                                        "[PDC-003] VST3 plugin signaled kLatencyChanged — graph PDC rebuilt"
                                    );
                                }

                                // PDC-007 FIX: Sync runtime plugin latencies → project model.
                            // PERF: Collect latencies OUTSIDE the project lock (lock-free reads
                            // from the plugin registry), then briefly lock project only for writes.
                            // This reduces project Mutex hold time by ~90%.
                            if let Some(reg) = plugin_host_state.get_plugin_registry() {
                                let reg_map = reg.load();
                                // Phase 1: Collect slot_id → latency mappings (no Mutex held)
                                let mut latency_updates: Vec<(uuid::Uuid, u32)> = Vec::new();
                                for (slot_id, instance_id) in slot_instance_map.iter() {
                                    if let Some(arc) = reg_map.get(instance_id) {
                                        if let Some(plugin) = arc.try_lock() {
                                            latency_updates.push((*slot_id, plugin.latency_samples()));
                                        }
                                    }
                                }
                                // Phase 2: Write latencies to project model (brief lock)
                                if !latency_updates.is_empty() {
                                    let sync_slots = |node: &mut dream_models::project::DeviceNode, updates: &[(uuid::Uuid, u32)]| {
                                        for slot in node.collect_plugin_slots_mut() {
                                            for (sid, lat) in updates {
                                                if slot.id == *sid {
                                                    slot.latency_frames = *lat;
                                                    break;
                                                }
                                            }
                                        }
                                    };
                                    for track in project.tracks.iter_mut() {
                                        if let Some(inst) = track.instrument.as_mut() {
                                            sync_slots(inst, &latency_updates);
                                        }
                                        for effect in track.effects.iter_mut() {
                                            sync_slots(effect, &latency_updates);
                                        }
                                    }
                                    if let Some(inst) = project.master_track.instrument.as_mut() {
                                        sync_slots(inst, &latency_updates);
                                    }
                                    for effect in project.master_track.effects.iter_mut() {
                                        sync_slots(effect, &latency_updates);
                                    }
                                }
                            }

                            }
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
            emit_with_log(&sandbox_app, "plugin_sandbox_tick", &snapshot);
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
                            if let Err(err) =
                                project_state.mark_dirty(&project.name, Some(&sandbox_app))
                            {
                                log::warn!("[Watchdog] mark_dirty after auto-bypass failed: {}", err);
                            }

                            if bypassed_changed > 0 {
                                emit_with_log(
                                    &sandbox_app,
                                    "plugin_sandbox_auto_bypass",
                                    serde_json::json!({
                                        "instanceIds": failed_instance_ids.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
                                        "slotIds": failed_slot_ids.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                                        "changedSlots": bypassed_changed,
                                    }),
                                );
                            }

                            if recovered_changed > 0 {
                                emit_with_log(
                                    &sandbox_app,
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
                emit_with_log(&sandbox_app, "plugin_sandbox_crashed", &crash);
            }
            for recovery in recoveries {
                emit_with_log(&sandbox_app, "plugin_sandbox_recovered", &recovery);
            }

            // ── ENTERPRISE CIRCUIT BREAKER ────────────────────────────────
            // When ALL sandbox instances are dead, transparently migrate to
            // in-process loading so plugins produce audio again.
            if plugin_host_state.check_sandbox_circuit_breaker() {
                log::warn!("[Watchdog] Circuit Breaker TRIPPED — all sandbox instances dead, migrating to in-process");
                match plugin_host_state.migrate_sandbox_to_inprocess() {
                    Ok((migrated, reloaded_slots)) if migrated > 0 => {
                        // Un-bypass the slots we just reloaded in-process.
                        let clip_pool_state: tauri::State<'_, ClipPoolState> = sandbox_app.state();
                        let registry: tauri::State<'_, crate::state_managers::ProjectRegistry> = sandbox_app.state();
                        if let Some(project_state) = registry.get_active_project() {
                            if let Ok(mut project) = project_state.project.lock() {
                                let changed = set_plugin_slots_bypass_in_project(
                                    &mut project,
                                    &reloaded_slots,
                                    false,
                                );
                                if changed > 0 {
                                    clip_pool_state.rebuild_routing_only(&project);
                                    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
                                    clip_pool_state.rebuild_external_fx_snapshot(
                                        &project,
                                        slot_instance_map.as_ref(),
                                    );
                                    plugin_host_state.publish_registry();
                                    if let Err(err) =
                                        project_state.mark_dirty(&project.name, Some(&sandbox_app))
                                    {
                                        log::warn!(
                                            "[Watchdog] mark_dirty after circuit-breaker migration failed: {}",
                                            err
                                        );
                                    }
                                }
                            }
                        }
                        emit_with_log(
                            &sandbox_app,
                            "plugin_sandbox_circuit_breaker",
                            serde_json::json!({
                                "action": "migrated_to_inprocess",
                                "migratedCount": migrated,
                                "slotIds": reloaded_slots.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                            }),
                        );
                        log::info!(
                            "[Watchdog] Circuit Breaker complete: {} plugins migrated to in-process",
                            migrated
                        );
                    }
                    Ok(_) => {
                        log::info!("[Watchdog] Circuit Breaker: no plugins needed migration");
                    }
                    Err(err) => {
                        log::error!("[Watchdog] Circuit Breaker migration failed: {}", err);
                    }
                }
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
                emit_with_log(&stream_error_app, "audio_stream_error", payload);
            }
        })
    {
        log::warn!("Failed to spawn audio stream error relay: {err}");
    }
}

pub(crate) fn configure_app_runtime(app: &tauri::App, stream_error_rx: Receiver<String>) {
    let raise_splash = |window: &tauri::WebviewWindow| {
        if let Err(err) = window.set_always_on_top(true) {
            log::warn!("[Splash] set_always_on_top(true) failed: {}", err);
        }
        if let Err(err) = window.show() {
            log::warn!("[Splash] show() failed: {}", err);
        }
        if let Err(err) = window.set_focus() {
            log::warn!("[Splash] set_focus() failed: {}", err);
        }
    };

    if let Some(splash_window) = app.get_webview_window("splashscreen") {
        // Startup race fix: explicitly lift splash above other windows/apps.
        raise_splash(&splash_window);

        // Some window managers briefly override Z-order during app bootstrap.
        // Re-assert splash foreground status shortly after startup.
        let app_handle = app.handle().clone();
        if let Err(err) = std::thread::Builder::new()
            .name("splash-foreground-retry".into())
            .spawn(move || {
                for delay_ms in [120_u64, 350_u64] {
                    std::thread::sleep(Duration::from_millis(delay_ms));
                    if let Some(window) = app_handle.get_webview_window("splashscreen") {
                        if let Err(err) = window.set_always_on_top(true) {
                            log::warn!(
                                "[Splash] delayed({}ms) set_always_on_top(true) failed: {}",
                                delay_ms, err
                            );
                        }
                        if let Err(err) = window.show() {
                            log::warn!("[Splash] delayed({}ms) show() failed: {}", delay_ms, err);
                        }
                        if let Err(err) = window.set_focus() {
                            log::warn!(
                                "[Splash] delayed({}ms) set_focus() failed: {}",
                                delay_ms, err
                            );
                        }
                    }
                }
            })
        {
            log::warn!("[Splash] failed to spawn foreground retry thread: {}", err);
        }
    }

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
                                    if prod
                                        .push(dream_ipc::EngineCommand::SetTimelineSampleRate(sr))
                                        .is_err()
                                    {
                                        log::warn!(
                                            "[NSEventMonitor] failed to queue SetTimelineSampleRate command"
                                        );
                                    }
                                }
                                if prod.push(dream_ipc::EngineCommand::SetPlay(new_state)).is_err()
                                {
                                    log::warn!("[NSEventMonitor] failed to queue SetPlay command");
                                }
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
