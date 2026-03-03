use serde::{Deserialize, Serialize};

// ── IPC Response Types ─────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct DeltaMutationResponse {
    pub deltas: Vec<dream_models::delta::ProjectDelta>,
}

/// Full engine state snapshot returned to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct EngineStateResponse {
    pub is_playing: bool,
    pub bpm: f64,
    pub test_tone_freq: f32,
    pub frames_rendered: i64,
    pub sample_rate: f64,
}

/// Per-channel meter reading (dB scale).
#[derive(Debug, Clone, Serialize)]
pub struct MeterReading {
    pub rms: f32,
    pub peak: f32,
    pub clipping: bool,
}

/// Full metering snapshot — all tracks + master.
#[derive(Debug, Clone, Serialize)]
pub struct MeteringSnapshot {
    pub tracks: Vec<(MeterReading, MeterReading)>, // (left, right) per track
    pub master_left: MeterReading,
    pub master_right: MeterReading,
}

/// Transport state returned to frontend for UI synchronization.
#[derive(Debug, Clone, Serialize)]
pub struct TransportState {
    pub is_playing: bool,
    pub position_frames: i64,
    pub position_seconds: f64,
    pub position_beats: f64,
    pub bpm: f64,
    pub sample_rate: f64,
    pub loop_enabled: bool,
    pub loop_start: i64,
    pub loop_end: i64,
    pub output_latency_frames: u32,
    pub telemetry_timestamp_ms: f64,
    pub time_sig_numerator: u32,
    pub time_sig_denominator: u32,
}

/// Track state returned to frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackStateUpdate {
    pub track_index: u16,
    pub volume: Option<f32>,
    pub pan: Option<f32>,
    pub disabled: Option<bool>,
    pub soloed: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddPluginToTrackPayload {
    pub track_id: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub slot: String, // "instrument" | "effect" | "auto"
    #[serde(default)]
    pub insert_index: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovePluginFromTrackPayload {
    pub track_id: String,
    pub slot_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalPluginParamPayload {
    pub track_id: String,
    pub slot_id: String,
    pub param_id: String,
    pub value: f64,
    #[serde(default)]
    pub push_undo_step: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalPluginParamUpdate {
    pub param_id: String,
    pub value: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalPluginParamBatchPayload {
    pub track_id: String,
    pub slot_id: String,
    pub updates: Vec<InternalPluginParamUpdate>,
    #[serde(default)]
    pub push_undo_step: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSamplerSamplePayload {
    pub track_id: String,
    pub sample_path: String,
    pub root_note: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettingsPayload {
    pub output_path: String,
    pub sample_rate: u32,
    pub bit_depth: u16,
    pub range: String,
    pub normalize: bool,
    pub tail_ms: u32,
    #[serde(default = "default_export_format")]
    pub format: String,
    #[serde(default)]
    pub start_frame: Option<i64>,
    #[serde(default)]
    pub end_frame: Option<i64>,
}

pub fn default_export_format() -> String {
    "wav".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationPointPayload {
    pub beat: f64,
    pub value: f64,
    pub curve_type: String,
    pub tension: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingTarget {
    pub track_id: String,
    pub track_name: String,
    pub track_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEditorCapability {
    pub supported: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSlotRuntimeStatus {
    pub loaded: bool,
    pub editor_supported: bool,
    pub runtime: String,
    pub sidechain_ready: bool,
    pub latency_frames: Option<u32>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPluginParamInfo {
    pub index: u32,
    pub name: String,
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub default_value: Option<f64>,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiInputPortInfo {
    pub name: String,
    pub connected: bool,
}

// ── Device Rack Payloads ───────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRackPayload {
    pub track_id: String,
    pub device_ids: Vec<String>,
    pub rack_name: Option<String>,
    pub rack_type: Option<String>, // "audio_effect" | "instrument" | "drum" | "midi_effect"
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddChainToRackPayload {
    pub track_id: String,
    pub rack_id: String,
    pub chain_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddDeviceToRackChainPayload {
    pub track_id: String,
    pub rack_id: String,
    pub chain_id: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub insert_index: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveDeviceFromRackPayload {
    pub track_id: String,
    pub rack_id: String,
    pub device_id: String,
    pub auto_dissolve: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDevicePresetPayload {
    pub track_id: String,
    pub device_id: String,
    pub output_path: String,
    pub preset_name: Option<String>,
    pub tags: Option<Vec<String>>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadDevicePresetPayload {
    pub track_id: String,
    pub preset_path: String,
    pub insert_index: Option<usize>,
}
