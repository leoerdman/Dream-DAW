// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Project Delta (Event Sourcing)
// ═══════════════════════════════════════════════════════════════════════════
//
// Instead of returning the entire `Project` JSON after every mutation,
// commands return `Vec<ProjectDelta>`. The frontend applies each delta
// pointwise to a normalized Zustand store → O(1) updates, zero re-renders.
//
// This is the backbone of the Delta IPC protocol:
//   Rust Command → Vec<ProjectDelta> → Tauri emit → Frontend applyDeltas()
//
// Each variant is named after the mutation it represents, carries only
// the fields that changed, and is serializable to JSON for Tauri IPC.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::project::Project;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MidiNoteDelta {
    pub pitch: u8,
    pub velocity: u8,
    pub start_beat: f64,
    pub duration_beats: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationPointDelta {
    pub beat: f64,
    pub value: f64,
    pub curve_type: String,
    pub tension: Option<f64>,
}

// ── Project Delta ───────────────────────────────────────────────────────

/// A single atomic change to the project state.
///
/// Commands return `Vec<ProjectDelta>` — the transport layer forwards them
/// to the frontend which applies them in order. This eliminates the need
/// to serialize/deserialize the entire project on every mutation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum ProjectDelta {
    // ── Clip Mutations ──────────────────────────────────────────────────
    /// A clip was moved to a new track and/or position.
    ClipMoved {
        clip_id: Uuid,
        old_track_index: usize,
        new_track_index: usize,
        new_position: i64,
    },

    /// A new audio clip was added.
    ClipAdded {
        clip_id: Uuid,
        track_index: usize,
        name: String,
        clip_type: String,
        file_path: Option<String>,
        position: i64,
        duration: i64,
    },

    /// A clip was resized (position and/or duration changed).
    ClipResized {
        clip_id: Uuid,
        new_position: i64,
        new_duration: i64,
    },

    /// A clip was split into two parts.
    ClipSplit {
        original_clip_id: Uuid,
        left_id: Uuid,
        right_id: Uuid,
        split_frame: i64,
    },

    /// A clip was deleted.
    ClipDeleted { clip_id: Uuid, track_index: usize },

    /// A clip was duplicated.
    ClipDuplicated {
        source_clip_id: Uuid,
        new_clip_id: Uuid,
        new_position: i64,
    },

    /// A clip's mute state changed.
    ClipMuteChanged { clip_id: Uuid, muted: bool },

    /// Full MIDI note list for a clip was replaced.
    MidiClipNotesReplaced {
        clip_id: Uuid,
        notes: Vec<MidiNoteDelta>,
    },

    /// Source offset for an audio clip changed.
    ClipSourceOffsetChanged { clip_id: Uuid, source_offset: i64 },

    /// Clip fade lengths changed.
    ClipFadesChanged {
        clip_id: Uuid,
        fade_in_frames: i64,
        fade_out_frames: i64,
    },

    /// Warp state for an audio clip changed.
    ClipWarpChanged {
        clip_id: Uuid,
        is_warped: bool,
        warp_mode: Option<i32>,
        warp_base_bpm: f64,
        warp_source_duration_frames: i64,
    },

    /// Pitch shift for an audio clip changed.
    ClipPitchChanged {
        clip_id: Uuid,
        pitch_shift_semitones: f64,
    },

    /// A clip's color was changed.
    ClipColorChanged {
        clip_id: Uuid,
        color: Option<String>,
    },

    /// Audio clip media path/offline state was updated (missing file resolved).
    ClipFilePathChanged {
        clip_id: Uuid,
        file_path: String,
        is_offline: bool,
    },

    /// A clip's name was changed.
    ClipRenamed { clip_id: Uuid, new_name: String },

    /// Clips were merged into a single clip.
    ClipsMerged {
        source_clip_ids: Vec<Uuid>,
        new_clip_id: Uuid,
    },

    // ── Track Mutations ─────────────────────────────────────────────────
    /// A track's volume changed.
    TrackVolumeChanged { track_id: Uuid, volume: f32 },

    /// A track's pan changed.
    TrackPanChanged { track_id: Uuid, pan: f32 },

    /// A track was muted/unmuted.
    TrackMuteChanged { track_id: Uuid, muted: bool },

    /// A track was soloed/unsoloed.
    TrackSoloChanged { track_id: Uuid, soloed: bool },

    /// A track was armed/disarmed for recording.
    TrackArmChanged { track_index: usize, armed: bool },

    /// Track output destination changed (`None` means master).
    TrackRoutingChanged {
        track_id: Uuid,
        output_destination_id: Option<Uuid>,
    },

    /// Track input source changed (`None` means no explicit input).
    TrackInputChanged {
        track_id: Uuid,
        input_source_id: Option<String>,
    },

    /// Track sampler sample path changed.
    TrackSamplerSampleChanged { track_id: Uuid, sample_path: String },

    /// Sample Rack pad sample path changed.
    SampleRackPadSampleChanged {
        track_id: Uuid,
        pad_index: u8,
        sample_path: String,
    },

    /// Sample Rack pad volume changed.
    SampleRackPadVolumeChanged {
        track_id: Uuid,
        pad_index: u8,
        volume: f32,
    },

    /// Sample Rack pad mute changed.
    SampleRackPadMuteChanged {
        track_id: Uuid,
        pad_index: u8,
        muted: bool,
    },

    /// Sample Rack pad solo changed.
    SampleRackPadSoloChanged {
        track_id: Uuid,
        pad_index: u8,
        soloed: bool,
    },

    /// Sample Rack pad ADSR changed.
    SampleRackPadAdsrChanged {
        track_id: Uuid,
        pad_index: u8,
        attack: f32,
        decay: f32,
        sustain: f32,
        release: f32,
    },

    /// Sample Rack pad filter cutoff changed.
    SampleRackPadFilterCutoffChanged {
        track_id: Uuid,
        pad_index: u8,
        cutoff: f32,
    },

    /// A track was renamed.
    TrackRenamed { track_id: Uuid, new_name: String },

    /// A track's color changed.
    TrackColorChanged { track_id: Uuid, color: String },

    /// A track's UI height changed.
    TrackHeightChanged { track_id: Uuid, height: f64 },

    /// A group track was expanded/collapsed.
    TrackGroupExpandedChanged { track_id: Uuid, expanded: bool },

    /// A new track was added.
    TrackAdded {
        track_index: usize,
        track_id: Uuid,
        name: String,
        track_type: String,
    },

    /// A track was removed.
    TrackRemoved { track_id: Uuid, track_index: usize },

    /// Track order changed (drag reorder).
    TrackMoved {
        track_id: Uuid,
        old_index: usize,
        new_index: usize,
    },

    /// Track parent/group assignment changed (`None` means top-level).
    TrackParentChanged {
        track_id: Uuid,
        parent_track_id: Option<Uuid>,
    },

    // ── Plugin Mutations ────────────────────────────────────────────────
    /// A plugin was added to a track.
    PluginAdded {
        track_id: Uuid,
        slot_id: Uuid,
        slot_index: usize,
        is_instrument: bool,
        plugin_name: String,
        plugin_uid: String,
    },

    /// A plugin was removed from a track.
    PluginRemoved { track_id: Uuid, slot_id: Uuid },

    /// A plugin was bypassed/enabled.
    PluginBypassChanged {
        track_id: Uuid,
        slot_id: Uuid,
        bypassed: bool,
    },

    /// Plugin order changed (drag reorder in device rack).
    PluginMoved {
        track_id: Uuid,
        slot_id: Uuid,
        old_slot_index: usize,
        new_slot_index: usize,
    },

    /// Internal plugin parameter changed.
    InternalPluginParamChanged {
        track_id: Uuid,
        slot_id: Uuid,
        param_id: String,
        value: f64,
    },

    /// External (VST) plugin parameter changed.
    ExternalPluginParamChanged {
        track_id: Uuid,
        slot_id: Uuid,
        param_index: u32,
        value: f64,
    },

    /// Sidechain source for a plugin slot changed.
    PluginSidechainChanged {
        track_id: Uuid,
        slot_id: Uuid,
        source_track_id: Option<Uuid>,
    },

    // ── Automation ──────────────────────────────────────────────────────
    /// Automation points were updated for a parameter lane on a track.
    AutomationPointsChanged {
        track_id: Uuid,
        param_id: String,
        points: Vec<AutomationPointDelta>,
    },

    // ── Transport/Project ───────────────────────────────────────────────
    /// Tempo changed.
    TempoChanged { bpm: f64 },

    /// Time signature changed.
    TimeSignatureChanged { numerator: u32, denominator: u32 },

    /// Arrangement/editor grid settings changed.
    ArrangementGridChanged {
        numerator: u16,
        denominator: u16,
        ntoles: u8,
        snap_to_grid: bool,
        fixed: bool,
    },

    /// Key signature changed.
    KeySignatureChanged {
        enabled: bool,
        tonic: String,
        mode: String,
    },

    /// Project was renamed.
    ProjectRenamed { new_name: String },

    /// Loop region changed.
    LoopRegionChanged { start: i64, end: i64, enabled: bool },

    /// Full project snapshot replacement (used by undo/redo snapshot jumps).
    ProjectSnapshotReplaced { project: Box<Project> },
}

// ── Delta Event (with metadata) ─────────────────────────────────────────

/// A timestamped delta event for the event log.
///
/// Wraps `ProjectDelta` with a monotonic sequence number so the frontend
/// can detect gaps (missed events) and request a full refresh.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaEvent {
    /// Monotonically increasing sequence number.
    pub seq: u64,

    /// Timestamp in milliseconds since UNIX epoch.
    pub timestamp_ms: u128,

    /// The actual change.
    pub delta: ProjectDelta,
}

/// A batch of delta events returned by commands.
///
/// Includes a sequence range so the frontend can detect if it missed
/// any events and needs a full refresh.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaBatch {
    /// Deltas in this batch, in order.
    pub deltas: Vec<ProjectDelta>,

    /// Sequence number of the first delta in this batch.
    pub first_seq: u64,

    /// Sequence number of the last delta in this batch.
    pub last_seq: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delta_serializes_with_tag() {
        let delta = ProjectDelta::TrackVolumeChanged {
            track_id: Uuid::nil(),
            volume: 0.75,
        };
        let json = serde_json::to_string(&delta).unwrap();
        assert!(json.contains("\"kind\":\"TrackVolumeChanged\""));
        assert!(json.contains("\"volume\":0.75"));
    }

    #[test]
    fn delta_batch_serializes() {
        let batch = DeltaBatch {
            deltas: vec![
                ProjectDelta::TempoChanged { bpm: 140.0 },
                ProjectDelta::ClipMuteChanged {
                    clip_id: Uuid::new_v4(),
                    muted: true,
                },
            ],
            first_seq: 1,
            last_seq: 2,
        };
        let json = serde_json::to_string(&batch).unwrap();
        assert!(json.contains("TempoChanged"));
        assert!(json.contains("ClipMuteChanged"));
        assert!(json.contains("\"firstSeq\":1"));
    }
}
