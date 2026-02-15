use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Control-plane messages between DAW and external plugin host process.
///
/// Data-plane audio buffers are expected to travel via shared memory.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum PluginHostControlMessage {
    Hello {
        protocol_version: u32,
        host_name: String,
    },
    LoadPlugin {
        instance_id: Uuid,
        plugin_path: String,
        sample_rate: f64,
        max_block_size: u32,
    },
    UnloadPlugin {
        instance_id: Uuid,
    },
    SetParameter {
        instance_id: Uuid,
        index: u32,
        value: f64,
    },
    OpenEditor {
        instance_id: Uuid,
    },
    CloseEditor {
        instance_id: Uuid,
    },
    Heartbeat {
        seq: u64,
    },
    Shutdown,
}

/// Shared-memory descriptor for the audio bridge.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SharedAudioRegion {
    /// Shared region identifier (file path or OS mapping name).
    pub map_name: String,
    pub num_inputs: u16,
    pub num_outputs: u16,
    pub max_frames: u32,
    pub total_bytes: usize,
}

/// Responses/events emitted by external host process.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum PluginHostEventMessage {
    Ready {
        protocol_version: u32,
        shared_region: Option<SharedAudioRegion>,
    },
    Loaded {
        instance_id: Uuid,
        latency_samples: u32,
        supports_editor: bool,
    },
    EditorOpened {
        instance_id: Uuid,
    },
    EditorClosed {
        instance_id: Uuid,
    },
    Crashed {
        instance_id: Option<Uuid>,
        reason: String,
    },
    Error {
        instance_id: Option<Uuid>,
        message: String,
    },
    HeartbeatAck {
        seq: u64,
    },
}
