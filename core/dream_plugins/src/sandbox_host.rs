use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::descriptor::PluginDescriptor;
use crate::instance::PluginError;
use crate::sandbox_ipc::{PluginHostControlMessage, SharedAudioRegion};
use crate::shared_memory::{SharedAudioBufferLayout, SharedAudioBufferRegion};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginSandboxStatus {
    Spawning,
    Running,
    TimedOut,
    Crashed,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginSandboxRuntimeInfo {
    pub plugin_instance_id: Uuid,
    pub plugin_name: String,
    pub plugin_path: String,
    pub status: PluginSandboxStatus,
    pub crash_count: u32,
    pub restart_count: u32,
    pub bypass_requested: bool,
    pub last_error: Option<String>,
    pub shared_region: Option<SharedAudioRegion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PluginSandboxSnapshot {
    pub enabled: bool,
    pub heartbeat_timeout_ms: u64,
    pub instances: Vec<PluginSandboxRuntimeInfo>,
}

#[derive(Debug, Clone)]
pub struct PluginSandboxConfig {
    pub host_binary: PathBuf,
    pub heartbeat_timeout: Duration,
}

impl PluginSandboxConfig {
    pub fn from_env() -> Option<Self> {
        let host_binary = std::env::var("DREAM_DAW_PLUGIN_HOST_BIN")
            .ok()
            .map(PathBuf::from)
            .filter(|p| p.exists())
            .or_else(Self::discover_default_host_binary)?;
        let heartbeat_timeout_ms = std::env::var("DREAM_DAW_PLUGIN_HEARTBEAT_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(100);
        Some(Self {
            host_binary,
            heartbeat_timeout: Duration::from_millis(heartbeat_timeout_ms),
        })
    }

    fn discover_default_host_binary() -> Option<PathBuf> {
        // 1) Beside current executable (packaged app)
        if let Ok(exe) = std::env::current_exe()
            && let Some(dir) = exe.parent()
        {
            let candidate = dir.join("plugin_host_daemon");
            if candidate.exists() {
                return Some(candidate);
            }
        }
        // 2) Dev workspace target output
        let dev_candidate = PathBuf::from("target/debug/plugin_host_daemon");
        if dev_candidate.exists() {
            return Some(dev_candidate);
        }
        None
    }
}

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
}

impl PluginSandboxSupervisor {
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

    fn prime_instance_protocol(instance_id: Uuid, instance: &mut PluginSandboxInstance) -> Result<(), PluginError> {
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
        instance_id: Uuid,
        plugin_path: &std::path::Path,
        heartbeat_file: &std::path::Path,
        shared_region_file: &std::path::Path,
        num_inputs: u16,
        num_outputs: u16,
        max_frames: u32,
    ) -> Result<Child, PluginError> {
        let mut cmd = Command::new(&config.host_binary);
        cmd.arg("--daemon")
            .arg("--instance-id")
            .arg(instance_id.to_string())
            .arg("--plugin-path")
            .arg(plugin_path.to_string_lossy().to_string())
            .arg("--heartbeat-file")
            .arg(heartbeat_file.to_string_lossy().to_string())
            .arg("--shared-region-file")
            .arg(shared_region_file.to_string_lossy().to_string())
            .arg("--num-inputs")
            .arg(num_inputs.to_string())
            .arg("--num-outputs")
            .arg(num_outputs.to_string())
            .arg("--max-frames")
            .arg(max_frames.to_string())
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
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
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
        let heartbeat_file = std::env::temp_dir().join(format!("dream_daw_plugin_host_{instance_id}.hb"));
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
        let child = Self::spawn_daemon_process(
            config,
            instance_id,
            &descriptor.path,
            &heartbeat_file,
            shared_region_owner.path_ref(),
            layout.num_inputs,
            layout.num_outputs,
            layout.max_frames,
        )?;
        let mut child = child;
        let control_stdin = child.stdin.take();

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
        let max_auto_restarts: u32 = 1;

        for (id, instance) in &mut self.instances {
            if let Some(child) = instance.process.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        instance.crash_count = instance.crash_count.saturating_add(1);
                        instance.last_error = Some(format!("Plugin host exited: {status}"));
                        if instance.restart_count < max_auto_restarts
                            && let Some(cfg) = self.config.as_ref()
                        {
                            let _ = fs::write(&instance.heartbeat_file, b"0");
                            match Self::spawn_daemon_process(
                                cfg,
                                *id,
                                    &instance.descriptor.path,
                                    &instance.heartbeat_file,
                                    std::path::Path::new(&instance.shared_region.map_name),
                                    instance.shared_region.num_inputs,
                                    instance.shared_region.num_outputs,
                                    instance.shared_region.max_frames,
                                ) {
                                Ok(mut new_child) => {
                                    instance.control_stdin = new_child.stdin.take();
                                    instance.process = Some(new_child);
                                    instance.status = PluginSandboxStatus::Spawning;
                                    instance.restart_count = instance.restart_count.saturating_add(1);
                                    instance.bypass_requested = false;
                                    let _ = Self::prime_instance_protocol(*id, instance);
                                    continue;
                                }
                                Err(err) => {
                                    instance.last_error = Some(format!("Auto-restart failed: {err}"));
                                }
                            }
                        }
                        instance.status = PluginSandboxStatus::Crashed;
                        instance.bypass_requested = true;
                        bypass.push(*id);
                    }
                    Ok(None) => {
                        let heartbeat_age = fs::metadata(&instance.heartbeat_file)
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .and_then(|modified| now.duration_since(modified).ok());
                        if let Some(age) = heartbeat_age {
                            if age > timeout {
                                if instance.restart_count < max_auto_restarts
                                    && let Some(cfg) = self.config.as_ref()
                                {
                                    let _ = child.kill();
                                    let _ = child.wait();
                                    let _ = fs::write(&instance.heartbeat_file, b"0");
                                    match Self::spawn_daemon_process(
                                        cfg,
                                        *id,
                                            &instance.descriptor.path,
                                            &instance.heartbeat_file,
                                            std::path::Path::new(&instance.shared_region.map_name),
                                            instance.shared_region.num_inputs,
                                            instance.shared_region.num_outputs,
                                            instance.shared_region.max_frames,
                                        ) {
                                        Ok(mut new_child) => {
                                            instance.control_stdin = new_child.stdin.take();
                                            instance.process = Some(new_child);
                                            instance.status = PluginSandboxStatus::Spawning;
                                            instance.restart_count = instance.restart_count.saturating_add(1);
                                            instance.bypass_requested = false;
                                            instance.last_error = Some(format!(
                                                "Recovered after heartbeat timeout ({}ms)",
                                                timeout.as_millis()
                                            ));
                                            let _ = Self::prime_instance_protocol(*id, instance);
                                            continue;
                                        }
                                        Err(err) => {
                                            instance.last_error = Some(format!(
                                                "Restart after timeout failed: {err}"
                                            ));
                                        }
                                    }
                                }
                                instance.status = PluginSandboxStatus::TimedOut;
                                instance.bypass_requested = true;
                                if instance.last_error.is_none() {
                                    instance.last_error = Some(format!(
                                        "Plugin host heartbeat timeout: {}ms",
                                        timeout.as_millis()
                                    ));
                                }
                                bypass.push(*id);
                            } else if instance.status == PluginSandboxStatus::Spawning {
                                instance.status = PluginSandboxStatus::Running;
                            }
                        } else if instance.status == PluginSandboxStatus::Spawning {
                            instance.status = PluginSandboxStatus::Running;
                        }
                    }
                    Err(err) => {
                        instance.status = PluginSandboxStatus::Crashed;
                        instance.crash_count = instance.crash_count.saturating_add(1);
                        instance.bypass_requested = true;
                        instance.last_error = Some(format!("Failed to poll plugin host process: {err}"));
                        bypass.push(*id);
                    }
                }
            }
        }

        bypass
    }

    pub fn remove_instance(&mut self, instance_id: Uuid) {
        if let Some(mut instance) = self.instances.remove(&instance_id) {
            if let Some(stdin) = instance.control_stdin.as_mut() {
                let _ = Self::send_control_message(
                    stdin,
                    &PluginHostControlMessage::UnloadPlugin { instance_id },
                );
                let _ = Self::send_control_message(stdin, &PluginHostControlMessage::Shutdown);
            }
            if let Some(mut child) = instance.process.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            let _ = fs::remove_file(instance.heartbeat_file);
            let _ = fs::remove_file(instance.shared_region.map_name);
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
                last_error: inst.last_error.clone(),
                shared_region: Some(inst.shared_region.clone()),
            });
        }
        PluginSandboxSnapshot {
            enabled: self.enabled,
            heartbeat_timeout_ms: self.heartbeat_timeout().as_millis() as u64,
            instances,
        }
    }

    pub fn shared_region_for_instance(&self, instance_id: Uuid) -> Option<SharedAudioRegion> {
        self.instances.get(&instance_id).map(|i| i.shared_region.clone())
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

    pub fn send_open_editor(&mut self, instance_id: Uuid) -> Result<(), PluginError> {
        let instance = self.instances.get_mut(&instance_id).ok_or_else(|| {
            PluginError::InvalidState(format!("Sandbox instance not found: {instance_id}"))
        })?;
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
        Self::send_control_message(stdin, &PluginHostControlMessage::CloseEditor { instance_id })
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
mod tests {
    use super::*;

    #[test]
    fn supervisor_disabled_without_config() {
        let sup = PluginSandboxSupervisor::new(None);
        assert!(!sup.enabled());
    }

    #[test]
    fn heartbeat_updates_running_state() {
        let mut sup = PluginSandboxSupervisor::new(None);
        // Force enabled flag for pure state test.
        sup.enabled = true;
        let id = Uuid::new_v4();
        sup.instances.insert(
            id,
            PluginSandboxInstance {
                descriptor: PluginDescriptor::new(
                    "Test",
                    "Dream",
                    crate::format::PluginFormat::VST3,
                    crate::format::PluginCategory::Effect,
                    PathBuf::from("/tmp/test.vst3"),
                ),
                process: None,
                status: PluginSandboxStatus::Spawning,
                crash_count: 0,
                restart_count: 0,
                bypass_requested: false,
                last_error: None,
                heartbeat_file: std::env::temp_dir().join("dream_daw_plugin_host_test.hb"),
                shared_region: SharedAudioRegion {
                    map_name: "test".to_string(),
                    num_inputs: 2,
                    num_outputs: 2,
                    max_frames: 64,
                    total_bytes: 0,
                },
                _shared_region_owner: SharedAudioBufferRegion::create(
                    std::env::temp_dir().join(format!(
                        "dream_daw_plugin_host_test_region_{}.bin",
                        Uuid::new_v4()
                    )),
                    SharedAudioBufferLayout {
                        num_inputs: 2,
                        num_outputs: 2,
                        max_frames: 64,
                    },
                )
                .unwrap(),
                control_stdin: None,
            },
        );
        sup.mark_heartbeat(id);
        let snap = sup.snapshot();
        assert_eq!(snap.instances.len(), 1);
        assert_eq!(snap.instances[0].status, PluginSandboxStatus::Running);
    }
}
