// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Plugin Sandbox: Public Types and Configuration
// ═══════════════════════════════════════════════════════════════════════════
//
// Extracted from sandbox_host.rs to keep the supervisor implementation
// below the 1000-line architecture budget.
//
// Public API surface: PluginSandboxStatus, PluginSandboxRuntimeInfo,
// PluginSandboxSnapshot, PluginCrashEvent, PluginSandboxConfig.
// ═══════════════════════════════════════════════════════════════════════════

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::sandbox_ipc::SharedAudioRegion;

// ── Status ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginSandboxStatus {
    Spawning,
    Running,
    TimedOut,
    Crashed,
    Stopped,
}

// ── Runtime info (serialisable snapshot for the UI) ──────────────────────

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

// ── Snapshot (aggregate for IPC / Tauri) ─────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PluginSandboxSnapshot {
    pub enabled: bool,
    pub heartbeat_timeout_ms: u64,
    pub instances: Vec<PluginSandboxRuntimeInfo>,
}

// ── Crash event ───────────────────────────────────────────────────────────

/// Event emitted when a sandboxed plugin crashes or times out.
/// The Tauri layer drains these via `drain_crash_events()` and emits
/// them as IPC events so the frontend can display crash indicators.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginCrashEvent {
    pub instance_id: Uuid,
    pub plugin_name: String,
    pub plugin_path: String,
    pub reason: String,
    pub crash_count: u32,
    pub auto_restarted: bool,
}

/// Event emitted when a sandboxed plugin instance has actually recovered
/// and reached a running state after prior instability.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginRecoveryEvent {
    pub instance_id: Uuid,
    pub plugin_name: String,
    pub plugin_path: String,
    pub restart_count: u32,
    pub crash_count: u32,
}

// ── Configuration ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PluginSandboxConfig {
    pub host_binary: PathBuf,
    /// Ongoing heartbeat timeout for Running instances.
    /// If no HeartbeatAck is received within this window, the instance is
    /// considered unhealthy. Default: 2000ms (enterprise-grade, avoids false
    /// positives during heavy DSP or UI redraws).
    pub heartbeat_timeout: Duration,
    /// Grace period for Spawning instances (initial load).
    /// Plugin initialization involves disk I/O, VST3 factory creation,
    /// component scanning, and UI setup — can take 1-15 seconds for complex
    /// plugins (Serum, Kontakt, etc.). Default: 15000ms.
    pub initial_grace_period: Duration,
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
            .unwrap_or(2000);
        let initial_grace_ms = std::env::var("DREAM_DAW_PLUGIN_INITIAL_GRACE_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(15_000);
        Some(Self {
            host_binary,
            heartbeat_timeout: Duration::from_millis(heartbeat_timeout_ms),
            initial_grace_period: Duration::from_millis(initial_grace_ms),
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
        // 3) Common temp target dirs used in local dev tooling
        let tmp_candidates = [
            PathBuf::from("/tmp/dreamdaw-target/debug/plugin_host_daemon"),
            PathBuf::from("/tmp/dream-daw-target/debug/plugin_host_daemon"),
        ];
        tmp_candidates
            .into_iter()
            .find(|candidate| candidate.exists())
    }
}

