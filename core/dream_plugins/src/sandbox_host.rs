#![cfg_attr(test, allow(clippy::expect_used))]
// ── Sandbox supervisor implementation ────────────────────────────────────
//
// Public types (PluginSandboxStatus, PluginSandboxRuntimeInfo,
// PluginSandboxSnapshot, PluginCrashEvent, PluginSandboxConfig)
// are defined in sandbox_types.rs to keep this file within budget.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::{Duration, SystemTime};

use uuid::Uuid;

use crate::descriptor::PluginDescriptor;
use crate::instance::PluginError;
use crate::sandbox_ipc::{PluginHostControlMessage, PluginHostEventMessage, SharedAudioRegion};
pub use crate::sandbox_types::{
    PluginCrashEvent, PluginRecoveryEvent, PluginSandboxConfig, PluginSandboxRuntimeInfo,
    PluginSandboxSnapshot, PluginSandboxStatus,
};
use crate::shared_memory::{SharedAudioBufferLayout, SharedAudioBufferRegion};

struct PluginSandboxInstance {
    descriptor: PluginDescriptor,
    process: Option<Child>,
    status: PluginSandboxStatus,
    crash_count: u32,
    restart_count: u32,
    bypass_requested: bool,
    last_error: Option<String>,
    heartbeat_file: PathBuf,
    shared_region: SharedAudioRegion,
    _shared_region_owner: SharedAudioBufferRegion,
    control_stdin: Option<ChildStdin>,
    event_rx: Option<Receiver<PluginHostEventMessage>>,
    heartbeat_seq: u64,
    heartbeat_seen: bool,
    spawned_at: SystemTime,
    /// LAZARUS PROTOCOL: Cached plugin state blob (base64) for crash recovery.
    /// Updated periodically via SaveState/StateSaved handshake.
    last_known_state_blob: Option<String>,
    /// Tick counter for periodic state save requests.
    ticks_since_last_save: u32,
    /// VST3 ENTERPRISE: Buffer for IPC events received while blocking for synchronous save.
    pending_events: Vec<PluginHostEventMessage>,
    /// VST3 ENTERPRISE: Track if the daemon ever successfully reached the Running state.
    has_reached_running: bool,
}

impl Drop for PluginSandboxInstance {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.heartbeat_file);
    }
}

struct DaemonSpawnSpec<'a> {
    instance_id: Uuid,
    plugin_path: &'a std::path::Path,
    heartbeat_file: &'a std::path::Path,
    shared_region_file: &'a std::path::Path,
    num_inputs: u16,
    num_outputs: u16,
    max_frames: u32,
}

/// Out-of-process plugin sandbox supervisor.
///
/// This manager is control-plane only: it launches and monitors plugin host
/// processes and raises fallback/bypass intent on failure. Audio data transport
/// should use shared memory in the host process implementation.
pub struct PluginSandboxSupervisor {
    enabled: bool,
    config: Option<PluginSandboxConfig>,
    instances: HashMap<Uuid, PluginSandboxInstance>,
    /// Accumulated crash events for the Tauri layer to drain and forward to frontend.
    crash_events: Vec<PluginCrashEvent>,
    /// Accumulated recovery events emitted when an instance reaches Running state.
    recovery_events: Vec<PluginRecoveryEvent>,
    /// LAZARUS PROTOCOL: Shared crash flags wired to `SandboxedPluginInstance.is_crashed`.
    /// The supervisor sets these on crash (true) and recovery (false).
    /// The audio thread reads them lock-free via `Relaxed` ordering.
    crash_flags: HashMap<Uuid, Arc<AtomicBool>>,
    /// VST3 ENTERPRISE: Parameter caches wired to `SandboxedPluginInstance`.
    /// Updated dynamically from `ParameterLayout` and `ParameterChanged` events.
    parameter_caches: HashMap<Uuid, Arc<std::sync::RwLock<Vec<f64>>>>,
    /// VST3 ENTERPRISE: Shared latency reported by the plugin.
    /// Updated dynamically from `LatencyChanged` events.
    latency_samples: HashMap<Uuid, Arc<AtomicU32>>,
}

impl PluginSandboxSupervisor {
    fn spawn_event_reader(
        stdout: ChildStdout,
        stderr: ChildStderr,
    ) -> Receiver<PluginHostEventMessage> {
        let (tx, rx) = mpsc::channel::<PluginHostEventMessage>();

        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(event) = serde_json::from_str::<PluginHostEventMessage>(trimmed)
                    && tx.send(event).is_err()
                {
                    break;
                }
            }
        });

        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                log::warn!("[PluginSandbox][daemon-stderr] {}", line);
            }
        });

        rx
    }

    fn send_control_message(
        control_stdin: &mut ChildStdin,
        msg: &PluginHostControlMessage,
    ) -> Result<(), PluginError> {
        let mut payload = serde_json::to_vec(msg)
            .map_err(|e| PluginError::ProcessError(format!("serialize control message: {e}")))?;
        payload.push(b'\n');
        control_stdin
            .write_all(&payload)
            .and_then(|_| control_stdin.flush())
            .map_err(|e| PluginError::ProcessError(format!("write control message: {e}")))
    }

    fn prime_instance_protocol(
        instance_id: Uuid,
        instance: &mut PluginSandboxInstance,
    ) -> Result<(), PluginError> {
        if let Some(stdin) = instance.control_stdin.as_mut() {
            Self::send_control_message(
                stdin,
                &PluginHostControlMessage::Hello {
                    protocol_version: 1,
                    host_name: "Dream DAW".to_string(),
                },
            )?;
            Self::send_control_message(
                stdin,
                &PluginHostControlMessage::LoadPlugin {
                    instance_id,
                    plugin_path: instance.descriptor.path.to_string_lossy().to_string(),
                    sample_rate: 44_100.0,
                    max_block_size: instance.shared_region.max_frames,
                },
            )?;
        }
        Ok(())
    }

    fn spawn_daemon_process(
        config: &PluginSandboxConfig,
        spec: &DaemonSpawnSpec<'_>,
    ) -> Result<Child, PluginError> {
        let mut cmd = Command::new(&config.host_binary);
        cmd.arg("--daemon")
            .arg("--instance-id")
            .arg(spec.instance_id.to_string())
            .arg("--plugin-path")
            .arg(spec.plugin_path.to_string_lossy().to_string())
            .arg("--heartbeat-file")
            .arg(spec.heartbeat_file.to_string_lossy().to_string())
            .arg("--shared-region-file")
            .arg(spec.shared_region_file.to_string_lossy().to_string())
            .arg("--num-inputs")
            .arg(spec.num_inputs.to_string())
            .arg("--num-outputs")
            .arg(spec.num_outputs.to_string())
            .arg("--max-frames")
            .arg(spec.max_frames.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        cmd.spawn().map_err(|e| {
            PluginError::LoadFailed(format!(
                "Failed to spawn plugin host daemon '{}': {e}",
                config.host_binary.display()
            ))
        })
    }

    pub fn new(config: Option<PluginSandboxConfig>) -> Self {
        Self {
            enabled: config.is_some(),
            config,
            instances: HashMap::new(),
            crash_events: Vec::new(),
            recovery_events: Vec::new(),
            crash_flags: HashMap::new(),
            parameter_caches: HashMap::new(),
            latency_samples: HashMap::new(),
        }
    }

    /// LAZARUS PROTOCOL: Register a shared crash flag for an instance.
    /// The `SandboxedPluginInstance` creates the `Arc<AtomicBool>` and passes it here
    /// so the supervisor can signal crash/recovery to the audio thread without locks.
    pub fn register_crash_flag(&mut self, instance_id: Uuid, flag: Arc<AtomicBool>) {
        self.crash_flags.insert(instance_id, flag);
    }

    /// VST3 ENTERPRISE: Register a shared parameter cache for synchronous DAW reads.
    pub fn register_parameter_cache(
        &mut self,
        instance_id: Uuid,
        cache: Arc<std::sync::RwLock<Vec<f64>>>,
    ) {
        self.parameter_caches.insert(instance_id, cache);
    }

    /// VST3 ENTERPRISE: Register shared latency state for synchronized Delay Compensation.
    pub fn register_latency_state(&mut self, instance_id: Uuid, latency: Arc<AtomicU32>) {
        self.latency_samples.insert(instance_id, latency);
    }

    /// LAZARUS PROTOCOL: Signal crash state via the shared atomic flag.
    fn signal_crash(crash_flags: &HashMap<Uuid, Arc<AtomicBool>>, instance_id: &Uuid) {
        if let Some(flag) = crash_flags.get(instance_id) {
            flag.store(true, Ordering::Release);
        }
    }

    /// LAZARUS PROTOCOL: Clear crash state via the shared atomic flag.
    fn signal_recovery(crash_flags: &HashMap<Uuid, Arc<AtomicBool>>, instance_id: &Uuid) {
        if let Some(flag) = crash_flags.get(instance_id) {
            flag.store(false, Ordering::Release);
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        if enabled && self.config.is_none() {
            self.config = PluginSandboxConfig::from_env();
        }
        self.enabled = enabled && self.config.is_some();
        if !self.enabled {
            for instance in self.instances.values_mut() {
                instance.bypass_requested = true;
            }
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn heartbeat_timeout(&self) -> Duration {
        self.config
            .as_ref()
            .map(|c| c.heartbeat_timeout)
            .unwrap_or_else(|| Duration::from_millis(100))
    }

    pub fn attach_plugin_process(
        &mut self,
        descriptor: PluginDescriptor,
    ) -> Result<Uuid, PluginError> {
        if !self.enabled {
            return Err(PluginError::InvalidState(
                "Plugin sandbox is disabled".to_string(),
            ));
        }
        let config = self.config.as_ref().ok_or_else(|| {
            PluginError::InvalidState("Plugin sandbox host binary is not configured".to_string())
        })?;

        let instance_id = Uuid::new_v4();
        let heartbeat_file =
            std::env::temp_dir().join(format!("dream_daw_plugin_host_{instance_id}.hb"));
        let _ = fs::write(&heartbeat_file, b"0");
        let shared_region_path =
            std::env::temp_dir().join(format!("dream_daw_plugin_audio_{instance_id}.bin"));
        let layout = SharedAudioBufferLayout {
            num_inputs: 2,
            num_outputs: 2,
            max_frames: 2048,
        };
        let shared_region_owner =
            SharedAudioBufferRegion::create(shared_region_path.clone(), layout.clone())
                .map_err(PluginError::LoadFailed)?;
        let shared_region = SharedAudioRegion {
            map_name: shared_region_path.to_string_lossy().to_string(),
            num_inputs: layout.num_inputs,
            num_outputs: layout.num_outputs,
            max_frames: layout.max_frames,
            total_bytes: layout.total_bytes(),
        };
        let spawn_spec = DaemonSpawnSpec {
            instance_id,
            plugin_path: &descriptor.path,
            heartbeat_file: &heartbeat_file,
            shared_region_file: shared_region_owner.path_ref(),
            num_inputs: layout.num_inputs,
            num_outputs: layout.num_outputs,
            max_frames: layout.max_frames,
        };
        let child = Self::spawn_daemon_process(config, &spawn_spec)?;
        let mut child = child;
        let control_stdin = child.stdin.take();
        let event_rx =
            if let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) {
                Some(Self::spawn_event_reader(stdout, stderr))
            } else {
                None
            };

        self.instances.insert(
            instance_id,
            PluginSandboxInstance {
                descriptor,
                process: Some(child),
                status: PluginSandboxStatus::Spawning,
                crash_count: 0,
                restart_count: 0,
                bypass_requested: false,
                last_error: None,
                heartbeat_file,
                shared_region,
                _shared_region_owner: shared_region_owner,
                control_stdin,
                event_rx,
                heartbeat_seq: 0,
                heartbeat_seen: false,
                spawned_at: SystemTime::now(),
                last_known_state_blob: None,
                ticks_since_last_save: 0,
                pending_events: Vec::new(),
                has_reached_running: false,
            },
        );
        if let Some(inst) = self.instances.get_mut(&instance_id) {
            let _ = Self::prime_instance_protocol(instance_id, inst);
        }
        Ok(instance_id)
    }

    pub fn mark_heartbeat(&mut self, instance_id: Uuid) {
        if let Some(instance) = self.instances.get(&instance_id) {
            let _ = fs::write(&instance.heartbeat_file, b"1");
        }
        if let Some(instance) = self.instances.get_mut(&instance_id)
            && matches!(
                instance.status,
                PluginSandboxStatus::Spawning | PluginSandboxStatus::TimedOut
            )
        {
            instance.heartbeat_seen = true;
            instance.status = PluginSandboxStatus::Running;
            instance.bypass_requested = false;
            instance.last_error = None;
        }
    }

    /// Poll running processes and timeouts. Returns instance IDs that should be bypassed.
    pub fn tick_watchdog(&mut self) -> Vec<Uuid> {
        let mut bypass = Vec::new();
        let timeout = self.heartbeat_timeout();
        let now = SystemTime::now();
        let max_auto_restarts: u32 = 3;
        let crash_flags = self.crash_flags.clone();

        for (id, instance) in &mut self.instances {
            if let Some(stdin) = instance.control_stdin.as_mut() {
                instance.heartbeat_seq = instance.heartbeat_seq.wrapping_add(1);
                let _ = Self::send_control_message(
                    stdin,
                    &PluginHostControlMessage::Heartbeat {
                        seq: instance.heartbeat_seq,
                    },
                );
                // LAZARUS: Periodic state save every ~50 ticks (~5s at 100ms tick rate)
                instance.ticks_since_last_save += 1;
                if instance.ticks_since_last_save >= 50
                    && matches!(instance.status, PluginSandboxStatus::Running)
                {
                    instance.ticks_since_last_save = 0;
                    let _ = Self::send_control_message(
                        stdin,
                        &PluginHostControlMessage::SaveState { instance_id: *id },
                    );
                }
            }
            if let Some(rx) = instance.event_rx.as_ref() {
                // Drain pending events that arrived during synchronous blocking calls
                let mut events_to_process = std::mem::take(&mut instance.pending_events);
                loop {
                    match rx.try_recv() {
                        Ok(evt) => events_to_process.push(evt),
                        Err(TryRecvError::Empty) => break,
                        Err(TryRecvError::Disconnected) => {
                            // The process check below will handle the crash
                            break;
                        }
                    }
                }
                
                for evt in events_to_process {
                    match evt {
                            PluginHostEventMessage::Ready { .. } => {
                                let should_emit_recovery =
                                    !matches!(instance.status, PluginSandboxStatus::Running)
                                        && (instance.restart_count > 0 || instance.crash_count > 0);
                                instance.status = PluginSandboxStatus::Running;
                                instance.heartbeat_seen = true;
                                instance.bypass_requested = false;
                                instance.has_reached_running = true;
                                // LAZARUS: Clear crash flag on successful recovery.
                                Self::signal_recovery(&crash_flags, id);
                                if should_emit_recovery {
                                    self.recovery_events.push(PluginRecoveryEvent {
                                        instance_id: *id,
                                        plugin_name: instance.descriptor.name.clone(),
                                        plugin_path: instance
                                            .descriptor
                                            .path
                                            .to_string_lossy()
                                            .to_string(),
                                        restart_count: instance.restart_count,
                                        crash_count: instance.crash_count,
                                    });
                                }
                            }
                            PluginHostEventMessage::HeartbeatAck { .. } => {
                                instance.heartbeat_seen = true;
                                let _ = fs::write(&instance.heartbeat_file, b"ack");
                            }
                            PluginHostEventMessage::Crashed { reason, .. } => {
                                instance.crash_count = instance.crash_count.saturating_add(1);
                                instance.status = PluginSandboxStatus::Crashed;
                                instance.bypass_requested = true;
                                instance.last_error = Some(reason.clone());
                                // LAZARUS: Signal crash to audio thread immediately.
                                Self::signal_crash(&crash_flags, id);
                                self.crash_events.push(PluginCrashEvent {
                                    instance_id: *id,
                                    plugin_name: instance.descriptor.name.clone(),
                                    plugin_path: instance
                                        .descriptor
                                        .path
                                        .to_string_lossy()
                                        .to_string(),
                                    reason,
                                    crash_count: instance.crash_count,
                                    auto_restarted: false,
                                });
                            }
                            PluginHostEventMessage::Error { message, .. } => {
                                instance.last_error = Some(message);
                            }
                            PluginHostEventMessage::Loaded { .. }
                            | PluginHostEventMessage::EditorOpened { .. }
                            | PluginHostEventMessage::EditorClosed { .. } => {}
                            PluginHostEventMessage::ParameterLayout { count, initial_values, .. } => {
                                if let Some(cache) = self.parameter_caches.get(id)
                                    && let Ok(mut lock) = cache.write()
                                {
                                    lock.clear();
                                    lock.resize(count as usize, Default::default());
                                    // Set the values that exist
                                    for (idx, val) in initial_values {
                                        if (idx as usize) < lock.len() {
                                            lock[idx as usize] = val;
                                        }
                                    }
                                }
                            }
                            PluginHostEventMessage::ParameterChanged { index, value, .. } => {
                                if let Some(cache) = self.parameter_caches.get(id)
                                    && let Ok(mut lock) = cache.write()
                                {
                                    if (index as usize) < lock.len() {
                                        lock[index as usize] = value;
                                    }
                                }
                            }
                            PluginHostEventMessage::LatencyChanged { latency_samples, .. } => {
                                if let Some(latency) = self.latency_samples.get(id) {
                                    latency.store(latency_samples, Ordering::Release);
                                }
                            }
                            PluginHostEventMessage::StateDirty { .. } => {
                                // Trigger the global AST asterisk symbol in the DAW title bar.
                                crate::vst3::host_objects::mark_plugin_state_dirty();
                            }
                            PluginHostEventMessage::StateSaved { state_blob_b64, .. } => {
                                instance.last_known_state_blob = Some(state_blob_b64);
                                log::info!(
                                    "[Lazarus] Cached state blob for plugin '{}' ({} bytes b64)",
                                    instance.descriptor.name,
                                    instance
                                        .last_known_state_blob
                                        .as_ref()
                                        .map_or(0, |b| b.len())
                                );
                            }
                        }
                    } // ends for evt in events_to_process
                } // ends if let Some(rx) = instance.event_rx.as_ref()
                
            if let Some(child) = instance.process.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        instance.crash_count = instance.crash_count.saturating_add(1);
                        instance.last_error = Some(format!("Plugin host exited: {status}"));
                        if instance.restart_count < max_auto_restarts
                            && let Some(cfg) = self.config.as_ref()
                        {
                            let _ = fs::write(&instance.heartbeat_file, b"0");
                            let spawn_spec = DaemonSpawnSpec {
                                instance_id: *id,
                                plugin_path: &instance.descriptor.path,
                                heartbeat_file: &instance.heartbeat_file,
                                shared_region_file: std::path::Path::new(
                                    &instance.shared_region.map_name,
                                ),
                                num_inputs: instance.shared_region.num_inputs,
                                num_outputs: instance.shared_region.num_outputs,
                                max_frames: instance.shared_region.max_frames,
                            };
                            match Self::spawn_daemon_process(cfg, &spawn_spec) {
                                Ok(mut new_child) => {
                                    instance.control_stdin = new_child.stdin.take();
                                    instance.event_rx = if let (Some(stdout), Some(stderr)) =
                                        (new_child.stdout.take(), new_child.stderr.take())
                                    {
                                        Some(Self::spawn_event_reader(stdout, stderr))
                                    } else {
                                        None
                                    };
                                    instance.heartbeat_seq = 0;
                                    instance.heartbeat_seen = false;
                                    // Do not reset has_reached_running on restart.
                                    instance.process = Some(new_child);
                                    instance.status = PluginSandboxStatus::Spawning;
                                    instance.restart_count =
                                        instance.restart_count.saturating_add(1);
                                    instance.spawned_at = SystemTime::now();
                                    // Keep bypass active until we receive Ready.
                                    instance.bypass_requested = true;
                                    let _ = Self::prime_instance_protocol(*id, instance);
                                    // LAZARUS: Restore cached state after respawn
                                    if let Some(ref state_blob) = instance.last_known_state_blob
                                        && let Some(ref mut stdin) = instance.control_stdin
                                    {
                                        let _ = Self::send_control_message(
                                            stdin,
                                            &PluginHostControlMessage::RestoreState {
                                                instance_id: *id,
                                                state_blob_b64: state_blob.clone(),
                                            },
                                        );
                                        log::info!(
                                            "[Lazarus] Restored state for '{}' after crash restart #{}",
                                            instance.descriptor.name,
                                            instance.restart_count
                                        );
                                    }
                                    self.crash_events.push(PluginCrashEvent {
                                        instance_id: *id,
                                        plugin_name: instance.descriptor.name.clone(),
                                        plugin_path: instance
                                            .descriptor
                                            .path
                                            .to_string_lossy()
                                            .to_string(),
                                        reason: instance
                                            .last_error
                                            .clone()
                                            .unwrap_or_else(|| "process exited".to_string()),
                                        crash_count: instance.crash_count,
                                        auto_restarted: true,
                                    });
                                    continue;
                                }
                                Err(err) => {
                                    instance.last_error =
                                        Some(format!("Auto-restart failed: {err}"));
                                }
                            }
                        }
                        instance.status = PluginSandboxStatus::Crashed;
                        instance.bypass_requested = true;
                        // LAZARUS: Signal crash to audio thread.
                        Self::signal_crash(&crash_flags, id);
                        self.crash_events.push(PluginCrashEvent {
                            instance_id: *id,
                            plugin_name: instance.descriptor.name.clone(),
                            plugin_path: instance.descriptor.path.to_string_lossy().to_string(),
                            reason: instance.last_error.clone().unwrap_or_default(),
                            crash_count: instance.crash_count,
                            auto_restarted: false,
                        });
                        bypass.push(*id);
                    }
                    Ok(None) => {
                        // FIX: Use HeartbeatAck flag instead of filesystem timestamps.
                        // fs::metadata().modified() has 1-second resolution on macOS APFS,
                        // causing false-positive heartbeat timeouts at 100ms threshold.
                        // The JSON HeartbeatAck round-trip sets heartbeat_seen reliably.
                        if instance.heartbeat_seen {
                            instance.heartbeat_seen = false; // reset for next tick
                            continue;
                        }
                        // Grace period: newly spawned instances need time to start up,
                        // load VST3 binaries, and begin heartbeating.
                        if let Some(age) = now.duration_since(instance.spawned_at).ok()
                            && age <= Duration::from_secs(5)
                        {
                            continue;
                        }

                        // ENTERPRISE: Do NOT auto-restart hanging daemons.
                        // If the daemon process is alive but never sent a heartbeat,
                        // it means the VST3 plugin hanged during initialization
                        // (e.g., needs Cocoa/NSApplication that the daemon lacks).
                        // Restarting would just produce the same hang. Kill it
                        // immediately and let the session auto-disable fall back
                        // to in-process loading.
                        let _ = child.kill();
                        let _ = child.wait();
                        instance.status = PluginSandboxStatus::TimedOut;
                        instance.bypass_requested = true;
                        // LAZARUS: Signal timeout to audio thread.
                        Self::signal_crash(&crash_flags, id);
                        if instance.last_error.is_none() {
                            instance.last_error = Some(format!(
                                "Plugin host heartbeat timeout: {}ms",
                                timeout.as_millis()
                            ));
                        }
                        self.crash_events.push(PluginCrashEvent {
                            instance_id: *id,
                            plugin_name: instance.descriptor.name.clone(),
                            plugin_path: instance.descriptor.path.to_string_lossy().to_string(),
                            reason: instance.last_error.clone().unwrap_or_default(),
                            crash_count: instance.crash_count,
                            auto_restarted: false,
                        });
                        bypass.push(*id);
                    }
                    Err(err) => {
                        let should_emit = !matches!(
                            instance.status,
                            PluginSandboxStatus::Crashed | PluginSandboxStatus::TimedOut
                        );
                        instance.status = PluginSandboxStatus::Crashed;
                        instance.crash_count = instance.crash_count.saturating_add(1);
                        instance.bypass_requested = true;
                        // LAZARUS: Signal poll error to audio thread.
                        Self::signal_crash(&crash_flags, id);
                        instance.last_error =
                            Some(format!("Failed to poll plugin host process: {err}"));
                        if should_emit {
                            self.crash_events.push(PluginCrashEvent {
                                instance_id: *id,
                                plugin_name: instance.descriptor.name.clone(),
                                plugin_path: instance.descriptor.path.to_string_lossy().to_string(),
                                reason: instance.last_error.clone().unwrap_or_default(),
                                crash_count: instance.crash_count,
                                auto_restarted: false,
                            });
                        }
                        bypass.push(*id);
                    }
                }
            }
        }

        bypass
    }

    /// LAZARUS PROTOCOL: Manually restart a crashed/timed-out plugin.
    ///
    /// Called by the Tauri layer when the user clicks "Reload Plugin".
    /// Kills the current daemon (if alive), spawns a fresh process, and
    /// restores the last known plugin state.
    pub fn manual_restart(&mut self, instance_id: Uuid) -> Result<(), PluginError> {
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| {
                PluginError::InvalidState(
                    "Plugin sandbox host binary is not configured".to_string(),
                )
            })?
            .clone();
        let crash_flags = self.crash_flags.clone();

        let instance = self.instances.get_mut(&instance_id).ok_or_else(|| {
            PluginError::InvalidState(format!("Sandbox instance not found: {instance_id}"))
        })?;

        // ENTERPRISE/Lazarus: force passthrough mode while daemon is respawning.
        // This flag is cleared only when we observe an actual Ready event.
        Self::signal_crash(&crash_flags, &instance_id);

        // Kill existing process if still around
        if let Some(mut child) = instance.process.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        instance.control_stdin.take();
        instance.event_rx.take();

        // Reset heartbeat
        let _ = fs::write(&instance.heartbeat_file, b"0");

        // Spawn fresh daemon
        let spawn_spec = DaemonSpawnSpec {
            instance_id,
            plugin_path: &instance.descriptor.path,
            heartbeat_file: &instance.heartbeat_file,
            shared_region_file: std::path::Path::new(&instance.shared_region.map_name),
            num_inputs: instance.shared_region.num_inputs,
            num_outputs: instance.shared_region.num_outputs,
            max_frames: instance.shared_region.max_frames,
        };
        let mut new_child = Self::spawn_daemon_process(&config, &spawn_spec)?;

        instance.control_stdin = new_child.stdin.take();
        instance.event_rx = if let (Some(stdout), Some(stderr)) =
            (new_child.stdout.take(), new_child.stderr.take())
        {
            Some(Self::spawn_event_reader(stdout, stderr))
        } else {
            None
        };
        instance.heartbeat_seq = 0;
        instance.heartbeat_seen = false;
        // Do not reset has_reached_running on manual restart.
        instance.process = Some(new_child);
        instance.status = PluginSandboxStatus::Spawning;
        instance.restart_count = instance.restart_count.saturating_add(1);
        instance.spawned_at = SystemTime::now();
        // Keep bypass active until we receive Ready.
        instance.bypass_requested = true;
        instance.last_error = None;
        instance.crash_count = 0;

        let _ = Self::prime_instance_protocol(instance_id, instance);

        // LAZARUS: Restore cached state if available
        if let Some(ref state_blob) = instance.last_known_state_blob
            && let Some(ref mut stdin) = instance.control_stdin
        {
            let _ = Self::send_control_message(
                stdin,
                &PluginHostControlMessage::RestoreState {
                    instance_id,
                    state_blob_b64: state_blob.clone(),
                },
            );
            log::info!(
                "[Lazarus] Restored state for '{}' after manual restart",
                instance.descriptor.name
            );
        }

        log::info!(
            "[Lazarus] Manual restart staged for '{}' (restart #{}), awaiting Ready to clear bypass",
            instance.descriptor.name,
            instance.restart_count
        );
        Ok(())
    }

    pub fn remove_instance(&mut self, instance_id: Uuid) {
        self.crash_flags.remove(&instance_id);
        if let Some(mut instance) = self.instances.remove(&instance_id) {
            if let Some(stdin) = instance.control_stdin.as_mut() {
                let _ = Self::send_control_message(
                    stdin,
                    &PluginHostControlMessage::UnloadPlugin { instance_id },
                );
                let _ = Self::send_control_message(stdin, &PluginHostControlMessage::Shutdown);
            }
            // Drop stdin to signal EOF to child — this unblocks its stdin reader.
            instance.control_stdin.take();

            // BUG-10 FIX: Wait up to 2 seconds for graceful exit before killing.
            // The child needs time to process UnloadPlugin (state serialization)
            // and Shutdown messages. Previously, kill() was called immediately,
            // causing plugin state loss and potential file corruption.
            if let Some(mut child) = instance.process.take() {
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                loop {
                    match child.try_wait() {
                        Ok(Some(_)) => break, // exited gracefully
                        Ok(None) => {
                            if std::time::Instant::now() >= deadline {
                                log::warn!(
                                    "[PluginSandbox] Instance {instance_id} did not exit within 2s, killing"
                                );
                                let _ = child.kill();
                                let _ = child.wait();
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(50));
                        }
                        Err(_) => {
                            let _ = child.kill();
                            let _ = child.wait();
                            break;
                        }
                    }
                }
            }
            // NOTE: heartbeat_file cleanup is handled by PluginSandboxInstance::Drop
            let _ = fs::remove_file(&instance.shared_region.map_name);
        }
    }

    pub fn snapshot(&self) -> PluginSandboxSnapshot {
        let mut instances = Vec::with_capacity(self.instances.len());
        for (id, inst) in &self.instances {
            instances.push(PluginSandboxRuntimeInfo {
                plugin_instance_id: *id,
                plugin_name: inst.descriptor.name.clone(),
                plugin_path: inst.descriptor.path.to_string_lossy().to_string(),
                status: inst.status,
                crash_count: inst.crash_count,
                restart_count: inst.restart_count,
                bypass_requested: inst.bypass_requested,
                has_reached_running: inst.has_reached_running,
                last_error: inst.last_error.clone(),
                shared_region: Some(inst.shared_region.clone()),
            });
        }
        PluginSandboxSnapshot {
            enabled: self.enabled,
            heartbeat_timeout_ms: u64::try_from(self.heartbeat_timeout().as_millis())
                .unwrap_or(u64::MAX),
            instances,
        }
    }

    pub fn shared_region_for_instance(&self, instance_id: Uuid) -> Option<SharedAudioRegion> {
        self.instances
            .get(&instance_id)
            .map(|i| i.shared_region.clone())
    }

    pub fn send_set_parameter(
        &mut self,
        instance_id: Uuid,
        index: u32,
        value: f64,
    ) -> Result<(), PluginError> {
        let instance = self.instances.get_mut(&instance_id).ok_or_else(|| {
            PluginError::InvalidState(format!("Sandbox instance not found: {instance_id}"))
        })?;
        let stdin = instance.control_stdin.as_mut().ok_or_else(|| {
            PluginError::InvalidState("Sandbox control pipe is not available".to_string())
        })?;
        Self::send_control_message(
            stdin,
            &PluginHostControlMessage::SetParameter {
                instance_id,
                index,
                value,
            },
        )
    }

    pub fn is_instance_healthy(&self, instance_id: Uuid) -> bool {
        self.instances.get(&instance_id).is_some_and(|inst| {
            !inst.bypass_requested
                && matches!(
                    inst.status,
                    PluginSandboxStatus::Running | PluginSandboxStatus::Spawning
                )
        })
    }

    /// Drains accumulated crash events. The Tauri layer should call this
    /// periodically and emit each event as a frontend IPC notification
    /// (e.g., `tauri::Emitter::emit("plugin-crashed", event)`).
    pub fn drain_crash_events(&mut self) -> Vec<PluginCrashEvent> {
        std::mem::take(&mut self.crash_events)
    }

    /// Drains accumulated recovery events. Recovery means the daemon has
    /// actually reached Running state again.
    pub fn drain_recovery_events(&mut self) -> Vec<PluginRecoveryEvent> {
        std::mem::take(&mut self.recovery_events)
    }

    /// Returns true if there are pending crash events to process.
    pub fn has_pending_crash_events(&self) -> bool {
        !self.crash_events.is_empty()
    }

    pub fn has_pending_recovery_events(&self) -> bool {
        !self.recovery_events.is_empty()
    }

    pub fn send_open_editor(&mut self, instance_id: Uuid) -> Result<(), PluginError> {
        let instance = self.instances.get_mut(&instance_id).ok_or_else(|| {
            PluginError::InvalidState(format!("Sandbox instance not found: {instance_id}"))
        })?;
        if instance.bypass_requested
            || matches!(
                instance.status,
                PluginSandboxStatus::Crashed
                    | PluginSandboxStatus::TimedOut
                    | PluginSandboxStatus::Stopped
            )
        {
            return Err(PluginError::InvalidState(format!(
                "Sandbox instance {instance_id} is unhealthy (status={:?}, bypass={})",
                instance.status, instance.bypass_requested
            )));
        }
        let stdin = instance.control_stdin.as_mut().ok_or_else(|| {
            PluginError::InvalidState("Sandbox control pipe is not available".to_string())
        })?;
        Self::send_control_message(stdin, &PluginHostControlMessage::OpenEditor { instance_id })
    }

    pub fn send_close_editor(&mut self, instance_id: Uuid) -> Result<(), PluginError> {
        let instance = self.instances.get_mut(&instance_id).ok_or_else(|| {
            PluginError::InvalidState(format!("Sandbox instance not found: {instance_id}"))
        })?;
        let stdin = instance.control_stdin.as_mut().ok_or_else(|| {
            PluginError::InvalidState("Sandbox control pipe is not available".to_string())
        })?;
        Self::send_control_message(
            stdin,
            &PluginHostControlMessage::CloseEditor { instance_id },
        )
    }

    /// ENTERPRISE: Synchronous state fetch for project saving.
    /// Sends SaveStateAndWait, then blocks the calling thread (up to 500ms) until StateSaved is received.
    /// Any other IPC events received during this block are queued into `pending_events`.
    pub fn request_state_and_wait(
        &mut self,
        instance_id: Uuid,
    ) -> Result<String, PluginError> {
        let timeout = Duration::from_millis(500);
        let start = std::time::Instant::now();

        {
            let instance = self.instances.get_mut(&instance_id).ok_or_else(|| {
                PluginError::InvalidState(format!("Sandbox instance not found: {instance_id}"))
            })?;

            let stdin = instance.control_stdin.as_mut().ok_or_else(|| {
                PluginError::InvalidState("Sandbox control pipe is not available".to_string())
            })?;

            Self::send_control_message(
                stdin,
                &PluginHostControlMessage::SaveStateAndWait { instance_id },
            )?;
        }

        loop {
            if start.elapsed() > timeout {
                return Err(PluginError::ProcessError(
                    "Timeout waiting for synchronous state save from daemon".to_string(),
                ));
            }

            let instance = self.instances.get_mut(&instance_id).ok_or_else(|| {
                PluginError::InvalidState("Sandbox instance disappeared during save state wait".to_string())
            })?;
            let rx = instance.event_rx.as_ref().ok_or_else(|| {
                PluginError::InvalidState("Sandbox event pipe is not available".to_string())
            })?;

            match rx.recv_timeout(Duration::from_millis(10)) {
                Ok(PluginHostEventMessage::StateSaved { state_blob_b64, .. }) => {
                    instance.last_known_state_blob = Some(state_blob_b64.clone());
                    return Ok(state_blob_b64);
                }
                Ok(other_event) => {
                    // Queue background events like ParameterChanged so they aren't dropped
                    instance.pending_events.push(other_event);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    // Keep waiting until total timeout
                    continue;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(PluginError::ProcessError(
                        "Sandbox daemon disconnected while waiting for save state".to_string(),
                    ));
                }
            }
        }
    }
}

impl Drop for PluginSandboxSupervisor {
    fn drop(&mut self) {
        let ids: Vec<Uuid> = self.instances.keys().copied().collect();
        for id in ids {
            self.remove_instance(id);
        }
    }
}

#[cfg(test)]
mod tests;
