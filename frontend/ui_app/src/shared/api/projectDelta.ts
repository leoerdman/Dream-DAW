export interface MidiClipDeltaNote {
    pitch: number;
    velocity: number;
    start_beat: number;
    duration_beats: number;
}

export type ProjectDelta =
    | { kind: 'ClipMoved'; data: { clip_id: string; old_track_index: number; new_track_index: number; new_position: number } }
    | { kind: 'ClipAdded'; data: { clip_id: string; track_index: number; name: string; clip_type: string; file_path: string | null; position: number; duration: number } }
    | { kind: 'ClipResized'; data: { clip_id: string; new_position: number; new_duration: number } }
    | { kind: 'ClipSplit'; data: { original_clip_id: string; left_id: string; right_id: string; split_frame: number } }
    | { kind: 'ClipDeleted'; data: { clip_id: string; track_index: number } }
    | { kind: 'ClipDuplicated'; data: { source_clip_id: string; new_clip_id: string; new_position: number } }
    | { kind: 'ClipsMerged'; data: { source_clip_ids: string[]; new_clip_id: string } }
    | { kind: 'ClipMuteChanged'; data: { clip_id: string; muted: boolean } }
    | { kind: 'MidiClipNotesReplaced'; data: { clip_id: string; notes: MidiClipDeltaNote[] } }
    | { kind: 'ClipSourceOffsetChanged'; data: { clip_id: string; source_offset: number } }
    | { kind: 'ClipFadesChanged'; data: { clip_id: string; fade_in_frames: number; fade_out_frames: number } }
    | { kind: 'ClipWarpChanged'; data: { clip_id: string; is_warped: boolean; warp_mode: number | null; warp_base_bpm: number } }
    | { kind: 'ClipColorChanged'; data: { clip_id: string; color: string | null } }
    | { kind: 'ClipRenamed'; data: { clip_id: string; new_name: string } }
    | { kind: 'TrackVolumeChanged'; data: { track_id: string; volume: number } }
    | { kind: 'TrackPanChanged'; data: { track_id: string; pan: number } }
    | { kind: 'TrackMuteChanged'; data: { track_id: string; muted: boolean } }
    | { kind: 'TrackSoloChanged'; data: { track_id: string; soloed: boolean } }
    | { kind: 'TrackArmChanged'; data: { track_index: number; armed: boolean } }
    | { kind: 'TrackRoutingChanged'; data: { track_id: string; output_destination_id: string | null } }
    | { kind: 'TrackSamplerSampleChanged'; data: { track_id: string; sample_path: string } }
    | { kind: 'SampleRackPadSampleChanged'; data: { track_id: string; pad_index: number; sample_path: string } }
    | { kind: 'SampleRackPadVolumeChanged'; data: { track_id: string; pad_index: number; volume: number } }
    | { kind: 'SampleRackPadMuteChanged'; data: { track_id: string; pad_index: number; muted: boolean } }
    | { kind: 'SampleRackPadSoloChanged'; data: { track_id: string; pad_index: number; soloed: boolean } }
    | { kind: 'SampleRackPadAdsrChanged'; data: { track_id: string; pad_index: number; attack: number; decay: number; sustain: number; release: number } }
    | { kind: 'SampleRackPadFilterCutoffChanged'; data: { track_id: string; pad_index: number; cutoff: number } }
    | { kind: 'TrackColorChanged'; data: { track_id: string; color: string } }
    | { kind: 'TrackAdded'; data: { track_index: number; track_id: string; name: string; track_type: string } }
    | { kind: 'TrackRemoved'; data: { track_id: string; track_index: number } }
    | { kind: 'TrackRenamed'; data: { track_id: string; new_name: string } }
    | { kind: 'TrackMoved'; data: { track_id: string; old_index: number; new_index: number } }
    | { kind: 'TrackParentChanged'; data: { track_id: string; parent_track_id: string | null } }
    | { kind: 'PluginAdded'; data: { track_id: string; slot_id: string; slot_index: number; is_instrument: boolean; plugin_name: string; plugin_uid: string } }
    | { kind: 'PluginRemoved'; data: { track_id: string; slot_id: string } }
    | { kind: 'PluginBypassChanged'; data: { track_id: string; slot_id: string; bypassed: boolean } }
    | { kind: 'PluginMoved'; data: { track_id: string; slot_id: string; old_slot_index: number; new_slot_index: number } }
    | { kind: 'InternalPluginParamChanged'; data: { track_id: string; slot_id: string; param_id: string; value: number } }
    | { kind: 'PluginSidechainChanged'; data: { track_id: string; slot_id: string; source_track_id: string | null } }
    | { kind: 'AutomationPointsChanged'; data: { track_id: string; param_id: string; points: Array<{ beat: number; value: number; curve_type: string; tension: number | null }> } }
    | { kind: 'TempoChanged'; data: { bpm: number } }
    | { kind: 'TimeSignatureChanged'; data: { numerator: number; denominator: number } }
    | { kind: 'ArrangementGridChanged'; data: { numerator: number; denominator: number; ntoles: number; snap_to_grid: boolean; fixed: boolean } }
    | { kind: 'KeySignatureChanged'; data: { enabled: boolean; tonic: string; mode: string } }
    | { kind: 'ProjectRenamed'; data: { new_name: string } }
    | { kind: 'LoopRegionChanged'; data: { start: number; end: number; enabled: boolean } }
    | { kind: 'ProjectSnapshotReplaced'; data: { project: unknown } };

export interface DeltaMutationResponse {
    deltas: ProjectDelta[];
}

export interface SplitClipResponse {
    left_id: string;
    right_id: string;
}

export interface DuplicateClipResponse {
    new_id: string;
}

export interface MergeClipsResponse {
    new_id: string;
}

export interface SplitClipWithDeltasResponse extends SplitClipResponse {
    deltas: ProjectDelta[];
}

export interface DuplicateClipWithDeltasResponse extends DuplicateClipResponse {
    deltas: ProjectDelta[];
}

export interface MergeClipsWithDeltasResponse extends MergeClipsResponse {
    deltas: ProjectDelta[];
}
