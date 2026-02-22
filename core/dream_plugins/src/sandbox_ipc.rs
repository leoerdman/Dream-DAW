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
    /// Delivers MIDI events for the next process() cycle.
    ///
    /// Events are compact tuples: (sample_offset, channel, raw_data[3]).
    /// The daemon converts these to format-specific events before calling
    /// the plugin's process() method.
    SendMidiEvents {
        instance_id: Uuid,
        events: Vec<(i32, u8, [u8; 3])>,
    },
    /// LAZARUS PROTOCOL: Request daemon to serialize and return plugin state.
    /// The daemon responds with PluginHostEventMessage::StateSaved.
    SaveState {
        instance_id: Uuid,
    },
    /// LAZARUS PROTOCOL: Restore a previously cached state blob after daemon respawn.
    /// The `state_blob` is the exact byte sequence returned by a previous StateSaved.
    RestoreState {
        instance_id: Uuid,
        /// Base64-encoded plugin state binary.
        state_blob_b64: String,
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
    /// LAZARUS PROTOCOL: Daemon returns serialized plugin state (base64-encoded).
    /// Host caches this for use in RestoreState after respawn.
    StateSaved {
        instance_id: Uuid,
        /// Base64-encoded plugin state binary.
        state_blob_b64: String,
    },
}
