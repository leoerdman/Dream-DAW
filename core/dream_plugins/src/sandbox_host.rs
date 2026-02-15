use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::descriptor::PluginDescriptor;
use crate::instance::PluginError;

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
            .filter(|p| p.exists())?;
        let heartbeat_timeout_ms = std::env::var("DREAM_DAW_PLUGIN_HEARTBEAT_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(100);
        Some(Self {
            host_binary,
            heartbeat_timeout: Duration::from_millis(heartbeat_timeout_ms),
        })
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
    last_heartbeat: Instant,
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
        let mut cmd = Command::new(&config.host_binary);
        cmd.arg("--plugin-host-daemon")
            .arg("--instance-id")
            .arg(instance_id.to_string())
            .arg("--plugin-path")
            .arg(descriptor.path.to_string_lossy().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let child = cmd.spawn().map_err(|e| {
            PluginError::LoadFailed(format!(
                "Failed to spawn plugin host daemon '{}': {e}",
                config.host_binary.display()
            ))
        })?;

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
                last_heartbeat: Instant::now(),
            },
        );
        Ok(instance_id)
    }

    pub fn mark_heartbeat(&mut self, instance_id: Uuid) {
        if let Some(instance) = self.instances.get_mut(&instance_id) {
            instance.last_heartbeat = Instant::now();
            if matches!(
                instance.status,
                PluginSandboxStatus::Spawning | PluginSandboxStatus::TimedOut
            ) {
                instance.status = PluginSandboxStatus::Running;
                instance.bypass_requested = false;
                instance.last_error = None;
            }
        }
    }

    /// Poll running processes and timeouts. Returns instance IDs that should be bypassed.
    pub fn tick_watchdog(&mut self) -> Vec<Uuid> {
        let mut bypass = Vec::new();
        let timeout = self.heartbeat_timeout();
        let now = Instant::now();

        for (id, instance) in &mut self.instances {
            if let Some(child) = instance.process.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        instance.status = PluginSandboxStatus::Crashed;
                        instance.crash_count = instance.crash_count.saturating_add(1);
                        instance.bypass_requested = true;
                        instance.last_error = Some(format!("Plugin host exited: {status}"));
                        bypass.push(*id);
                    }
                    Ok(None) => {
                        if now.saturating_duration_since(instance.last_heartbeat) > timeout {
                            instance.status = PluginSandboxStatus::TimedOut;
                            instance.bypass_requested = true;
                            instance.last_error =
                                Some(format!("Plugin host heartbeat timeout: {}ms", timeout.as_millis()));
                            bypass.push(*id);
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
            if let Some(mut child) = instance.process.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
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
            });
        }
        PluginSandboxSnapshot {
            enabled: self.enabled,
            heartbeat_timeout_ms: self.heartbeat_timeout().as_millis() as u64,
            instances,
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
                last_heartbeat: Instant::now() - Duration::from_secs(10),
            },
        );
        sup.mark_heartbeat(id);
        let snap = sup.snapshot();
        assert_eq!(snap.instances.len(), 1);
        assert_eq!(snap.instances[0].status, PluginSandboxStatus::Running);
    }
}

