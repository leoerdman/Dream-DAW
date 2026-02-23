import { invoke } from '@tauri-apps/api/core';
import type {
    DeltaMutationResponse,
    DuplicateClipResponse,
    DuplicateClipWithDeltasResponse,
    MergeClipsResponse,
    MergeClipsWithDeltasResponse,
    ProjectDelta,
    SplitClipResponse,
    SplitClipWithDeltasResponse,
} from './projectDelta';
import type {
    AppSettings,
    EngineState,
    MeteringSnapshot,
    MidiInputPort,
    PdcDebugSnapshot,
    ProjectHistoryEvent,
    ProjectStatus,
    RecentProject,
    RtDebugSnapshot,
    TrackStateUpdate,
    TransportState,
} from './engine.types';
export type {
    AppSettings,
    EngineState,
    MeterReading,
    MeteringSnapshot,
    MidiInputPort,
    PdcDebugSnapshot,
    PdcEdgeDebug,
    PdcNodeDebug,
    ProjectHistoryEvent,
    ProjectStatus,
    RecentProject,
    RtDebugSnapshot,
    TrackStateUpdate,
    TransportState,
} from './engine.types';
export type {
    DeltaMutationResponse,
    DuplicateClipResponse,
    DuplicateClipWithDeltasResponse,
    MergeClipsResponse,
    MergeClipsWithDeltasResponse,
    ProjectDelta,
    SplitClipResponse,
    SplitClipWithDeltasResponse,
} from './projectDelta';
export const play = () => invoke<void>('play');
export const stop = () => invoke<void>('stop');
export const togglePlayback = () => invoke<boolean>('toggle_playback');

export const seek = (positionFrames: number) =>
    invoke<void>('seek', { positionFrames });

export const seekSeconds = (seconds: number) =>
    invoke<void>('seek_seconds', { seconds });

export const seekToBeat = (beat: number) =>
    invoke<void>('seek_to_beat', { beat });

export const setBpm = (bpm: number) => invoke<void>('set_bpm', { bpm });
export const setBpmWithDeltas = (bpm: number) =>
    invoke<DeltaMutationResponse>('set_bpm_with_deltas', { bpm });

export const setLoop = (enabled: boolean, startFrames: number, endFrames: number) =>
    invoke<void>('set_loop', { enabled, startFrames, endFrames });
export const setLoopWithDeltas = (enabled: boolean, startFrames: number, endFrames: number) =>
    invoke<DeltaMutationResponse>('set_loop_with_deltas', { enabled, startFrames, endFrames });

export const setTrackVolume = (trackIndex: number, volume: number) =>
    invoke<void>('set_track_volume', { trackIndex, volume });

export const setTrackVolumeWithDeltas = (trackIndex: number, volume: number) =>
    invoke<DeltaMutationResponse>('set_track_volume_with_deltas', { trackIndex, volume });

export const setTrackPan = (trackIndex: number, pan: number) =>
    invoke<void>('set_track_pan', { trackIndex, pan });

export const setTrackPanWithDeltas = (trackIndex: number, pan: number) =>
    invoke<DeltaMutationResponse>('set_track_pan_with_deltas', { trackIndex, pan });

export const setMasterVolume = (volume: number) =>
    invoke<void>('set_master_volume', { volume });

export const setTrackMute = (trackIndex: number, muted: boolean) =>
    invoke<void>('set_track_mute', { trackIndex, muted });

export const setTrackMuteWithDeltas = (trackIndex: number, muted: boolean) =>
    invoke<DeltaMutationResponse>('set_track_mute_with_deltas', { trackIndex, muted });

export const setTrackSolo = (trackIndex: number, soloed: boolean) =>
    invoke<void>('set_track_solo', { trackIndex, soloed });

export const setTrackSoloWithDeltas = (trackIndex: number, soloed: boolean) =>
    invoke<DeltaMutationResponse>('set_track_solo_with_deltas', { trackIndex, soloed });

export const previewSamplerNoteOn = (trackIndex: number, pitch: number, velocity: number = 100) =>
    invoke<void>('preview_sampler_note_on_cmd', {
        trackIndex,
        pitch: Math.max(0, Math.min(127, Math.round(pitch))),
        velocity: Math.max(1, Math.min(127, Math.round(velocity))),
    });

export const previewSamplerNoteOff = (trackIndex: number, pitch: number) =>
    invoke<void>('preview_sampler_note_off_cmd', {
        trackIndex,
        pitch: Math.max(0, Math.min(127, Math.round(pitch))),
    });

export type BuiltinEffectType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;
export const BuiltinEffectType: {
    Eq: BuiltinEffectType;
    Compressor: BuiltinEffectType;
    Delay: BuiltinEffectType;
    Reverb: BuiltinEffectType;
    Chorus: BuiltinEffectType;
    Utility: BuiltinEffectType;
    Saturator: BuiltinEffectType;
    Limiter: BuiltinEffectType;
    Gate: BuiltinEffectType;
    AutoFilter: BuiltinEffectType;
    Phaser: BuiltinEffectType;
    Flanger: BuiltinEffectType;
    Distortion: BuiltinEffectType;
    Bitcrusher: BuiltinEffectType;
    NoiseMachine: BuiltinEffectType;
    AutoPan: BuiltinEffectType;
} = {
    Eq: 0,
    Compressor: 1,
    Delay: 2,
    Reverb: 3,
    Chorus: 4,
    Utility: 5,
    Saturator: 6,
    Limiter: 7,
    Gate: 8,
    AutoFilter: 9,
    Phaser: 10,
    Flanger: 11,
    Distortion: 12,
    Bitcrusher: 13,
    NoiseMachine: 14,
    AutoPan: 15,
};

export const addDevice = (trackIndex: number, slotIndex: number, effectType: BuiltinEffectType) =>
    invoke<void>('add_device_cmd', { trackIndex, slotIndex, effectType });

export const removeDevice = (trackIndex: number, slotIndex: number) =>
    invoke<void>('remove_device_cmd', { trackIndex, slotIndex });

export const bypassDevice = (trackIndex: number, slotIndex: number, bypassed: boolean) =>
    invoke<void>('bypass_device_cmd', { trackIndex, slotIndex, bypassed });

export const setSlotBypass = (trackId: string, slotId: string, bypassed: boolean) =>
    invoke<void>('set_slot_bypass_cmd', { trackId, slotId, bypassed });
export const setSlotBypassWithDeltas = (trackId: string, slotId: string, bypassed: boolean) =>
    invoke<DeltaMutationResponse>('set_slot_bypass_with_deltas_cmd', { trackId, slotId, bypassed });

export const moveEffectSlot = (trackId: string, slotId: string, targetIndex: number) =>
    invoke<void>('move_effect_slot_cmd', { trackId, slotId, targetIndex });
export const moveEffectSlotWithDeltas = (trackId: string, slotId: string, targetIndex: number) =>
    invoke<DeltaMutationResponse>('move_effect_slot_with_deltas_cmd', { trackId, slotId, targetIndex });

export const setDeviceParam = (trackIndex: number, slotIndex: number, paramIndex: number, value: number) =>
    invoke<void>('set_device_param_cmd', { trackIndex, slotIndex, paramIndex, value });

export const setDeviceParamRuntime = (trackIndex: number, slotIndex: number, paramIndex: number, value: number) =>
    invoke<void>('set_device_param_runtime_cmd', { trackIndex, slotIndex, paramIndex, value });

export type RuntimeDeviceParamUpdate = {
    paramIndex: number;
    value: number;
};

export const setDeviceParamsRuntime = (
    trackIndex: number,
    slotIndex: number,
    updates: RuntimeDeviceParamUpdate[],
) => invoke<void>('set_device_params_runtime_cmd', { trackIndex, slotIndex, updates });

export const updateTrack = (update: TrackStateUpdate) =>
    invoke<void>('update_track', { update });

export const addTrack = (name?: string, inheritFromTrackId?: string | null) =>
    invoke<void>('add_track_cmd', {
        name: name ?? null,
        trackType: 'audio',
        insertAfterIndex: null,
        inheritFromTrackId: inheritFromTrackId ?? null,
    });

export const addTrackWithDeltas = (name?: string, inheritFromTrackId?: string | null) =>
    invoke<DeltaMutationResponse>('add_track_with_deltas_cmd', {
        name: name ?? null,
        trackType: 'audio',
        insertAfterIndex: null,
        inheritFromTrackId: inheritFromTrackId ?? null,
    });

export type TrackCreateType = 'audio' | 'midi' | 'group';

export const addTrackAdvanced = (
    trackType: TrackCreateType,
    insertAfterIndex?: number | null,
    name?: string,
    inheritFromTrackId?: string | null,
) =>
    invoke<void>('add_track_cmd', {
        name: name ?? null,
        trackType,
        insertAfterIndex: insertAfterIndex ?? null,
        inheritFromTrackId: inheritFromTrackId ?? null,
    });

export const addTrackWithDeltasAdvanced = (
    trackType: TrackCreateType,
    insertAfterIndex?: number | null,
    name?: string,
    inheritFromTrackId?: string | null,
) =>
    invoke<DeltaMutationResponse>('add_track_with_deltas_cmd', {
        name: name ?? null,
        trackType,
        insertAfterIndex: insertAfterIndex ?? null,
        inheritFromTrackId: inheritFromTrackId ?? null,
    });

export const deleteTrack = (trackIndex: number) =>
    invoke<void>('delete_track_cmd', { index: trackIndex });

export const deleteTrackWithDeltas = (trackIndex: number) =>
    invoke<DeltaMutationResponse>('delete_track_with_deltas_cmd', { index: trackIndex });

export const deleteTracks = (trackIds: string[]) =>
    invoke<void>('delete_tracks_cmd', { trackIds });

export const renameTrack = (index: number, name: string) =>
    invoke<void>('rename_track_cmd', { index, name });

export const renameTrackWithDeltas = (index: number, name: string) =>
    invoke<DeltaMutationResponse>('rename_track_with_deltas_cmd', { index, name });

export const setTrackHeight = (trackId: string, height: number) =>
    invoke<void>('set_track_height_cmd', { trackId, height });
export const setTrackHeightWithDeltas = (trackId: string, height: number) =>
    invoke<DeltaMutationResponse>('set_track_height_with_deltas_cmd', { trackId, height });

export const setTrackColor = (trackId: string, colorHex: string) =>
    invoke<void>('set_track_color_cmd', { trackId, colorHex });
export const setTrackColorWithDeltas = (trackId: string, colorHex: string) =>
    invoke<DeltaMutationResponse>('set_track_color_with_deltas_cmd', { trackId, colorHex });

export const createGroup = (trackIds: string[], groupName?: string) =>
    invoke<string>('create_group_cmd', {
        trackIds,
        groupName: groupName ?? null,
    });
export interface CreateGroupWithDeltasResponse {
    group_id: string;
    deltas: ProjectDelta[];
}
export const createGroupWithDeltas = (trackIds: string[], groupName?: string) =>
    invoke<CreateGroupWithDeltasResponse>('create_group_with_deltas_cmd', {
        trackIds,
        groupName: groupName ?? null,
    });

export const setGroupExpanded = (groupId: string, expanded: boolean) =>
    invoke<void>('set_group_expanded_cmd', { groupId, expanded });
export const setGroupExpandedWithDeltas = (groupId: string, expanded: boolean) =>
    invoke<DeltaMutationResponse>('set_group_expanded_with_deltas_cmd', { groupId, expanded });

export const moveTrackToIndex = (trackId: string, targetIndex: number) =>
    invoke<void>('move_track_to_index_cmd', { trackId, targetIndex });

export const moveTrackToIndexWithDeltas = (trackId: string, targetIndex: number) =>
    invoke<DeltaMutationResponse>('move_track_to_index_with_deltas_cmd', { trackId, targetIndex });

export const moveTrackWithParent = (
    trackId: string,
    targetIndex: number,
    targetParentGroupId?: string | null,
) =>
    invoke<void>('move_track_with_parent_cmd', {
        trackId,
        targetIndex,
        targetParentGroupId: targetParentGroupId ?? null,
    });
export const moveTrackWithParentWithDeltas = (
    trackId: string,
    targetIndex: number,
    targetParentGroupId?: string | null,
) =>
    invoke<DeltaMutationResponse>('move_track_with_parent_with_deltas_cmd', {
        trackId,
        targetIndex,
        targetParentGroupId: targetParentGroupId ?? null,
    });

export const setTrackGroup = (trackId: string, groupId?: string | null) =>
    invoke<void>('set_track_group_cmd', {
        trackId,
        groupId: groupId ?? null,
    });
export const setTrackGroupWithDeltas = (trackId: string, groupId?: string | null) =>
    invoke<DeltaMutationResponse>('set_track_group_with_deltas_cmd', {
        trackId,
        groupId: groupId ?? null,
    });

export const ungroupTrack = (groupId: string) =>
    invoke<void>('ungroup_track_cmd', { groupId });
export const ungroupTrackWithDeltas = (groupId: string) =>
    invoke<DeltaMutationResponse>('ungroup_track_with_deltas_cmd', { groupId });

export const moveTrackBlockToIndex = (rootTrackId: string, targetIndex: number) =>
    invoke<void>('move_track_block_to_index_cmd', { rootTrackId, targetIndex });
export const moveTrackBlockToIndexWithDeltas = (rootTrackId: string, targetIndex: number) =>
    invoke<DeltaMutationResponse>('move_track_block_to_index_with_deltas_cmd', {
        rootTrackId,
        targetIndex,
    });

export const duplicateTracks = (trackIds: string[]) =>
    invoke<void>('duplicate_tracks_cmd', { trackIds });
export const duplicateTracksWithDeltas = (trackIds: string[]) =>
    invoke<DeltaMutationResponse>('duplicate_tracks_with_deltas_cmd', { trackIds });

export const getState = () => invoke<EngineState>('get_state');

export const getTransport = () => invoke<TransportState>('get_transport');

export const getMeters = () => invoke<MeteringSnapshot>('get_meters');
type BinaryInvokePayload = ArrayBuffer | Uint8Array | number[];

function toUint8Array(payload: BinaryInvokePayload): Uint8Array {
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    return new Uint8Array(payload);
}

export const getMetersBinary = async (): Promise<Uint8Array> => {
    const raw = await invoke<BinaryInvokePayload>('get_meters_binary');
    const bytes = toUint8Array(raw);
    return bytes;
};

export const getProjectHistory = (options?: { limit?: number; sinceSeq?: number }) =>
    invoke<ProjectHistoryEvent[]>('get_project_history', {
        limit: options?.limit,
        sinceSeq: options?.sinceSeq,
    });

export const getPdcDebugSnapshot = () =>
    invoke<PdcDebugSnapshot>('get_pdc_debug_snapshot');

export const getRtDebugSnapshot = () =>
    invoke<RtDebugSnapshot>('get_rt_debug_snapshot');

export const setRtDebugEnabled = (enabled: boolean) =>
    invoke<void>('set_rt_debug_enabled', { enabled });

export const setFrequency = (freq: number) =>
    invoke<void>('set_frequency', { freq });

export interface ImportAudioResponse {
    clip_id: string;
    clip_name: string;
    duration_seconds: number;
    sample_rate: number;
    channels: number;
    frames: number;
}

export interface ImportAudioWithDeltasResponse extends ImportAudioResponse {
    deltas: ProjectDelta[];
}

export const importAudioFile = (path: string, trackIndex: number, positionFrames?: number) =>
    invoke<ImportAudioResponse>('import_audio_file', {
        path,
        trackIndex,
        positionFrames: positionFrames ?? null,
    });
export const importAudioFileWithDeltas = (path: string, trackIndex: number, positionFrames?: number) =>
    invoke<ImportAudioWithDeltasResponse>('import_audio_file_with_deltas', {
        path,
        trackIndex,
        positionFrames: positionFrames ?? null,
    });

interface CreateMidiClipResponse {
    clip_id: string;
    clip_name: string;
    position_frames: number;
    duration_frames: number;
}
interface CreateMidiClipWithDeltasResponse extends CreateMidiClipResponse {
    deltas: ProjectDelta[];
}

export interface MidiClipNoteUpdate {
    pitch: number;
    velocity: number;
    startFrames: number;
    durationFrames: number;
}

export interface MidiVariationNote {
    pitch: number;
    velocity: number;
    startBeat: number;
    durationBeats: number;
}

export interface MidiVariationTrackContext {
    trackName: string;
    trackType: string;
    instrumentName: string | null;
    effectNames: string[];
    samplerSamplePath: string | null;
}

export interface GenerateMidiVariationInput {
    bpm: number;
    beatsPerBar: number;
    clipName: string;
    clipDurationBeats: number;
    notes: MidiVariationNote[];
    trackContext: MidiVariationTrackContext;
    model?: string;
}

export const createMidiClip = (
    trackIndex: number,
    positionFrames: number,
    durationFrames: number,
    name?: string,
) =>
    invoke<CreateMidiClipResponse>('create_midi_clip_cmd', {
        trackIndex,
        positionFrames,
        durationFrames,
        name: name ?? null,
    });
export const createMidiClipWithDeltas = (
    trackIndex: number,
    positionFrames: number,
    durationFrames: number,
    name?: string,
) =>
    invoke<CreateMidiClipWithDeltasResponse>('create_midi_clip_with_deltas_cmd', {
        trackIndex,
        positionFrames,
        durationFrames,
        name: name ?? null,
    });

export const updateMidiClip = (
    clipId: string,
    notes: MidiClipNoteUpdate[],
    options?: { pushUndoStep?: boolean },
) =>
    invoke<void>('update_midi_clip_cmd', {
        clipId,
        push_undo_step: options?.pushUndoStep ?? true,
        notes: notes.map((n) => ({
            pitch: Math.max(0, Math.min(127, Math.round(n.pitch))),
            velocity: Math.max(1, Math.min(127, Math.round(n.velocity))),
            start_frames: Math.max(0, Math.round(n.startFrames)),
            duration_frames: Math.max(1, Math.round(n.durationFrames)),
        })),
    });

export const updateMidiClipWithDeltas = (
    clipId: string,
    notes: MidiClipNoteUpdate[],
    options?: { pushUndoStep?: boolean },
) =>
    invoke<DeltaMutationResponse>('update_midi_clip_with_deltas_cmd', {
        clipId,
        push_undo_step: options?.pushUndoStep ?? true,
        notes: notes.map((n) => ({
            pitch: Math.max(0, Math.min(127, Math.round(n.pitch))),
            velocity: Math.max(1, Math.min(127, Math.round(n.velocity))),
            start_frames: Math.max(0, Math.round(n.startFrames)),
            duration_frames: Math.max(1, Math.round(n.durationFrames)),
        })),
    });

export interface MidiClipEnvelopePointUpdate {
    beat: number;
    value: number;
}

export interface MidiClipEnvelopeUpdate {
    paramId: string;
    points: MidiClipEnvelopePointUpdate[];
}

export const setMidiClipEnvelopes = (
    clipId: string,
    envelopes: MidiClipEnvelopeUpdate[],
    options?: { pushUndoStep?: boolean },
) =>
    invoke<void>('set_midi_clip_envelopes_cmd', {
        clipId,
        push_undo_step: options?.pushUndoStep ?? true,
        envelopes: envelopes.map((env) => ({
            param_id: env.paramId,
            points: env.points.map((p) => ({
                beat: Math.max(0, Number(p.beat || 0)),
                value: Math.max(0, Math.min(1, Number(p.value || 0))),
            })),
        })),
    });

export const generateMidiVariation = (input: GenerateMidiVariationInput) =>
    invoke<{ notes: MidiVariationNote[] }>('generate_midi_variation_cmd', { request: input })
        .then((res) => res.notes);

export const getMidiInputs = () =>
    invoke<MidiInputPort[]>('get_midi_inputs');

export const connectMidiInput = (portName: string) =>
    invoke<void>('connect_midi_input', { portName });

export const generateDemoSamples = () =>
    invoke<number>('generate_demo_samples_cmd');

export const previewAudioFile = (path: string) =>
    invoke<void>('preview_audio_file_cmd', { path });

export const stopPreview = () =>
    invoke<void>('stop_preview_cmd');

export const getAudioFileDuration = (path: string) =>
    invoke<number>('get_audio_file_duration', { path });

export const expandWindow = () => invoke<void>('expand_window');

export const maximizeWindow = () => invoke<void>('maximize_window');

export const newProject = () => invoke<DeltaMutationResponse>('new_project');

export const saveProject = () => invoke<string>('save_project');

export const saveProjectAs = (path: string) =>
    invoke<string>('save_project_as', { path });

export const openProject = (path: string) =>
    invoke<DeltaMutationResponse>('open_project', { path });

export const importAbletonProject = (path: string) =>
    invoke<DeltaMutationResponse>('import_ableton_project', { path });

export const eagerActivateExternalPlugins = () =>
    invoke<{ total: number; loaded: number; failed: number; skipped: number }>(
        'eager_activate_external_plugins',
    );

export const getRecentProjects = () =>
    invoke<RecentProject[]>('get_recent_projects');

export const getProjectStatus = () => invoke<ProjectStatus>('get_project_status');

export interface ArrangementViewportState {
    pixels_per_beat: number | null;
    scroll_left: number | null;
    scroll_top?: number | null;
}

export const setArrangementViewport = (pixelsPerBeat: number, scrollLeft: number, scrollTop?: number) =>
    invoke<void>('set_arrangement_viewport_cmd', {
        // Keep both casings for cross-version compatibility of Tauri arg mapping.
        pixelsPerBeat,
        scrollLeft,
        scrollTop,
        pixels_per_beat: pixelsPerBeat,
        scroll_left: scrollLeft,
        scroll_top: scrollTop,
    });

export const getArrangementViewport = () =>
    invoke<ArrangementViewportState>('get_arrangement_viewport_cmd');

export const createBackup = () => invoke<string>('create_backup_cmd');

export interface AutoSaveResult {
    saved: boolean;
    reason?: string;
    path?: string;
}

export const autoSaveIfDirty = () => invoke<AutoSaveResult>('auto_save_if_dirty');

export const markDirty = () => invoke<void>('mark_dirty_cmd');

export const syncTitle = () => invoke<void>('sync_title_cmd');

export const setArrangementGrid = (
    numerator: number,
    denominator: number,
    ntoles: number,
    snapToGrid: boolean,
    fixed: boolean,
) =>
    invoke<void>('set_arrangement_grid_cmd', {
        numerator,
        denominator,
        ntoles,
        snapToGrid,
        fixed,
    });
export const setArrangementGridWithDeltas = (
    numerator: number,
    denominator: number,
    ntoles: number,
    snapToGrid: boolean,
    fixed: boolean,
) =>
    invoke<DeltaMutationResponse>('set_arrangement_grid_with_deltas_cmd', {
        numerator,
        denominator,
        ntoles,
        snapToGrid,
        fixed,
    });

export const setKeySignature = (enabled: boolean, tonic: string, mode: string) =>
    invoke<void>('set_key_signature_cmd', { enabled, tonic, mode });
export const setKeySignatureWithDeltas = (enabled: boolean, tonic: string, mode: string) =>
    invoke<DeltaMutationResponse>('set_key_signature_with_deltas_cmd', { enabled, tonic, mode });

export const getSettings = () => invoke<AppSettings>('get_settings');

export const updateSettings = (newSettings: AppSettings) =>
    invoke<void>('update_settings', { newSettings });

export interface AudioFileEntry {
    name: string;
    path: string;
    size_bytes: number;
    modified_at: string;
    format: string;
    duration_seconds?: number | null;
}

export const scanAudioFolder = (path: string) =>
    invoke<AudioFileEntry[]>('scan_audio_folder', { path });

export const scanAllAudioSources = () =>
    invoke<AudioFileEntry[]>('scan_all_audio_sources');

export interface BrowserFileEntry {
    name: string;
    path: string;
    size_bytes: number;
    modified_at: string;
    extension: string;
    file_type: string;
    is_directory: boolean;
    duration_seconds?: number | null;
}

export const scanFolderAll = (path: string) =>
    invoke<BrowserFileEntry[]>('scan_folder_all', { path });

export const scanPluginFolders = () =>
    invoke<BrowserFileEntry[]>('scan_plugin_folders');

export const getBrowserFolders = () =>
    invoke<string[]>('get_browser_folders');

export const addBrowserFolder = () =>
    invoke<string[]>('add_browser_folder');

export const removeBrowserFolder = (path: string) =>
    invoke<string[]>('remove_browser_folder', { path });

export const getSamplesPath = () =>
    invoke<string>('get_samples_path');

export const pickFolder = () =>
    invoke<string | null>('pick_folder');

export const pickProjectFile = () =>
    invoke<string | null>('pick_project_file');

export const saveProjectDialog = () =>
    invoke<string | null>('save_project_dialog');

export interface PeakPair {
    min: number;
    max: number;
}

export interface PeakMipLevel {
    samples_per_peak: number;
    peaks: PeakPair[];
}

export interface WaveformPeaks {
    source_id: string;
    sample_rate: number;
    total_samples: number;
    mip_levels: PeakMipLevel[];
}

export const getWaveformPeaks = (filePath: string) =>
    invoke<WaveformPeaks>('get_waveform_peaks', { filePath });

interface WaveformPeaksBinaryResponse {
    source_id: string;
    sample_rate: number;
    total_samples: number;
    mip_levels: Array<{
        samples_per_peak: number;
        peak_count: number;
        float_offset: number;
    }>;
    peaks_bytes: number[];
}

export async function getWaveformPeaksBinary(filePath: string): Promise<WaveformPeaks> {
    const raw = await invoke<WaveformPeaksBinaryResponse>(
        'get_waveform_peaks_binary',
        { filePath },
    );
    const bytes = new Uint8Array(raw.peaks_bytes);
    const floats = new Float32Array(bytes.buffer);
    const mip_levels: PeakMipLevel[] = raw.mip_levels.map((meta) => {
        const peaks: PeakPair[] = new Array(meta.peak_count);
        for (let i = 0; i < meta.peak_count; i++) {
            const idx = meta.float_offset + i * 2;
            peaks[i] = { min: floats[idx], max: floats[idx + 1] };
        }
        return {
            samples_per_peak: meta.samples_per_peak,
            peaks,
        };
    });

    return {
        source_id: raw.source_id,
        sample_rate: raw.sample_rate,
        total_samples: raw.total_samples,
        mip_levels,
    };
}

export async function getWaveformPeaksLodBinary(filePath: string, lodLevel: number): Promise<Uint8Array> {
    const raw = await invoke<BinaryInvokePayload>('get_waveform_peaks_lod_binary', {
        filePath,
        lodLevel,
    });
    return toUint8Array(raw);
}

export async function getPeaksByClipId(clipId: string, lodLevel: number): Promise<Uint8Array> {
    const raw = await invoke<BinaryInvokePayload>('get_peaks_by_clip_id', {
        clipId,
        lodLevel,
    });
    return toUint8Array(raw);
}

export async function getPeaks(clipId: string, lodLevel: number): Promise<Uint8Array> {
    const raw = await invoke<BinaryInvokePayload>('get_peaks_binary', { clipId, lodLevel });
    return toUint8Array(raw);
}

export const moveClip = (clipId: string, newTrackIndex: number, newPositionFrames: number) =>
    invoke<void>('move_clip_cmd', { clipId, newTrackIndex, newPositionFrames });
export const moveClipWithDeltas = (clipId: string, newTrackIndex: number, newPositionFrames: number) =>
    invoke<DeltaMutationResponse>('move_clip_with_deltas_cmd', { clipId, newTrackIndex, newPositionFrames });
export const resizeClip = (clipId: string, newPositionFrames: number, newDurationFrames: number) =>
    invoke<void>('resize_clip_cmd', { clipId, newPositionFrames, newDurationFrames });
export const resizeClipWithDeltas = (clipId: string, newPositionFrames: number, newDurationFrames: number) =>
    invoke<DeltaMutationResponse>('resize_clip_with_deltas_cmd', { clipId, newPositionFrames, newDurationFrames });
export const splitClip = (clipId: string, splitFrame: number) =>
    invoke<SplitClipResponse>('split_clip_cmd', { clipId, splitFrame });
export const splitClipWithDeltas = (clipId: string, splitFrame: number) =>
    invoke<SplitClipWithDeltasResponse>('split_clip_with_deltas_cmd', { clipId, splitFrame });
export const duplicateClip = (clipId: string, newPositionFrames?: number) =>
    invoke<DuplicateClipResponse>('duplicate_clip_cmd', {
        clipId,
        newPositionFrames: newPositionFrames ?? null,
    });
export const duplicateClipWithDeltas = (clipId: string, newPositionFrames?: number) =>
    invoke<DuplicateClipWithDeltasResponse>('duplicate_clip_with_deltas_cmd', {
        clipId,
        newPositionFrames: newPositionFrames ?? null,
    });
export const mergeClips = (clipIds: string[]) =>
    invoke<MergeClipsResponse>('merge_clips_cmd', { clipIds });
export const mergeClipsWithDeltas = (clipIds: string[]) =>
    invoke<MergeClipsWithDeltasResponse>('merge_clips_with_deltas_cmd', { clipIds });
export const deleteClip = (clipId: string) =>
    invoke<void>('delete_clip_cmd', { clipId });
export const deleteClipWithDeltas = (clipId: string) =>
    invoke<DeltaMutationResponse>('delete_clip_with_deltas_cmd', { clipId });
export const setClipMuted = (clipId: string, muted: boolean) =>
    invoke<void>('set_clip_muted_cmd', { clipId, muted });
export const setClipMutedWithDeltas = (clipId: string, muted: boolean) =>
    invoke<DeltaMutationResponse>('set_clip_muted_with_deltas_cmd', { clipId, muted });
export const setClipsMuted = (clipIds: string[], muted: boolean) =>
    invoke<number>('set_clips_muted_cmd', { clipIds, muted });
export const setClipsMutedWithDeltas = (clipIds: string[], muted: boolean) =>
    invoke<DeltaMutationResponse>('set_clips_muted_with_deltas_cmd', { clipIds, muted });

export const paintTrackClipsWithTrackColor = (trackId: string) =>
    invoke<void>('paint_track_clips_with_track_color_cmd', { trackId });
export const paintTrackClipsWithTrackColorWithDeltas = (trackId: string) =>
    invoke<DeltaMutationResponse>('paint_track_clips_with_track_color_with_deltas_cmd', { trackId });

export interface AudioDevices {
    outputs: string[];
    inputs: string[];
}

export const getAudioDevices = () =>
    invoke<AudioDevices>('get_audio_devices');

export const setAudioDevice = (deviceName: string) =>
    invoke<string>('set_audio_device', { deviceName });

export const restartAudioEngine = (deviceName: string) =>
    invoke<string>('restart_audio_engine', { deviceName });

export const openPluginWindow = (pluginId: string) =>
    invoke<void>('open_plugin_window', { pluginId });

export const openPluginWindowForSlot = (trackId: string, slotId: string) =>
    invoke<void>('open_plugin_window_for_slot', { trackId, slotId });

export interface PluginEditorCapability {
    supported: boolean;
    reason?: string | null;
}

export interface PluginSlotRuntimeStatus {
    loaded: boolean;
    editorSupported: boolean;
    runtime: string;
    sidechainReady: boolean;
    latencyFrames?: number | null;
    message?: string | null;
}

export const canOpenPluginEditor = (pluginId: string) =>
    invoke<PluginEditorCapability>('can_open_plugin_editor', { pluginId });

export const canOpenPluginEditorForSlot = (trackId: string, slotId: string) =>
    invoke<PluginEditorCapability>('can_open_plugin_editor_for_slot', { trackId, slotId });

export const getPluginSlotRuntimeStatus = (trackId: string, slotId: string) =>
    invoke<PluginSlotRuntimeStatus>('get_plugin_slot_runtime_status_cmd', { trackId, slotId });

export const ensurePluginSlotActive = (trackId: string, slotId: string) =>
    invoke<void>('ensure_plugin_slot_active_cmd', { trackId, slotId });

export const unloadPluginSlot = (trackId: string, slotId: string) =>
    invoke<void>('unload_plugin_slot_cmd', { trackId, slotId });

export const replaceMissingPluginSlot = (
    trackId: string,
    slotId: string,
    replacementPluginId: string,
    replacementPluginName?: string,
) =>
    invoke<void>('replace_missing_plugin_slot_cmd', {
        payload: {
            trackId,
            slotId,
            replacementPluginId,
            replacementPluginName: replacementPluginName ?? null,
        },
    });
export const replaceMissingPluginSlotWithDeltas = (
    trackId: string,
    slotId: string,
    replacementPluginId: string,
    replacementPluginName?: string,
) =>
    invoke<DeltaMutationResponse>('replace_missing_plugin_slot_with_deltas_cmd', {
        payload: {
            trackId,
            slotId,
            replacementPluginId,
            replacementPluginName: replacementPluginName ?? null,
        },
    });

export const closePluginWindow = (pluginId: string) =>
    invoke<void>('close_plugin_window_cmd', { pluginId });

export const closePluginWindowForSlot = (trackId: string, slotId: string) =>
    invoke<void>('close_plugin_window_for_slot', { trackId, slotId });

export type PluginSandboxStatus = 'spawning' | 'running' | 'timed_out' | 'crashed' | 'stopped';

export interface PluginSandboxRuntimeInfo {
    plugin_instance_id: string;
    plugin_name: string;
    plugin_path: string;
    status: PluginSandboxStatus;
    crash_count: number;
    restart_count: number;
    bypass_requested: boolean;
    last_error?: string | null;
}

export interface PluginCrashEvent {
    instance_id: string;
    plugin_name: string;
    plugin_path: string;
    reason: string;
    crash_count: number;
    auto_restarted: boolean;
}

export interface PluginRecoveryEvent {
    instance_id: string;
    plugin_name: string;
    plugin_path: string;
    restart_count: number;
    crash_count: number;
}

export interface PluginSandboxSnapshot {
    enabled: boolean;
    heartbeat_timeout_ms: number;
    instances: PluginSandboxRuntimeInfo[];
}

export interface ReloadSandboxInstancesResponse {
    snapshot: PluginSandboxSnapshot;
    restarted_instances: number;
    changed_slots: number;
    errors: string[];
}

export const getPluginSandboxRuntime = () =>
    invoke<PluginSandboxSnapshot>('get_plugin_sandbox_runtime');

export const setPluginSandboxEnabled = (enabled: boolean) =>
    invoke<PluginSandboxSnapshot>('set_plugin_sandbox_enabled', { enabled });

export const tickPluginSandboxWatchdog = () =>
    invoke<PluginSandboxSnapshot>('tick_plugin_sandbox_watchdog');

export const reloadPluginSandboxInstance = (instanceId: string) =>
    invoke<PluginSandboxSnapshot>('reload_plugin_sandbox_instance', { instanceId });

export const reloadUnhealthyPluginSandboxes = () =>
    invoke<ReloadSandboxInstancesResponse>('reload_unhealthy_plugin_sandboxes');

export const logFrontendError = (module: string, error: string, stack?: string) =>
    invoke<void>('log_frontend_error', { module, error, stack: stack ?? null });

export interface RoutingTarget {
    trackId: string;
    trackName: string;
    trackType: string;
}

export const getRoutingTargets = (trackId: string) =>
    invoke<RoutingTarget[]>('get_routing_targets', { trackId });

export const setTrackRouting = (trackId: string, targetId: string) =>
    invoke<void>('set_track_routing_cmd', { trackId, targetId });
export const setTrackRoutingWithDeltas = (trackId: string, targetId: string) =>
    invoke<DeltaMutationResponse>('set_track_routing_with_deltas_cmd', { trackId, targetId });

export const setTrackInput = (trackId: string, inputId: string) =>
    invoke<void>('set_track_input_cmd', { trackId, inputId });
export const setTrackInputWithDeltas = (trackId: string, inputId: string) =>
    invoke<DeltaMutationResponse>('set_track_input_with_deltas_cmd', { trackId, inputId });

export const setPluginSidechainSource = (
    trackId: string,
    slotId: string,
    sourceTrackId: string,
) =>
    invoke<void>('set_plugin_sidechain_source_cmd', { trackId, slotId, sourceTrackId });
export const setPluginSidechainSourceWithDeltas = (
    trackId: string,
    slotId: string,
    sourceTrackId: string,
) =>
    invoke<DeltaMutationResponse>('set_plugin_sidechain_source_with_deltas_cmd', {
        trackId,
        slotId,
        sourceTrackId,
    });

export const addPluginToTrack = (
    trackId: string,
    pluginId: string,
    pluginName: string,
    slot: 'instrument' | 'effect' | 'auto' = 'auto',
) =>
    invoke<void>('add_plugin_to_track_cmd', {
        payload: { trackId, pluginId, pluginName, slot },
    });
export const addPluginToTrackWithDeltas = (
    trackId: string,
    pluginId: string,
    pluginName: string,
    slot: 'instrument' | 'effect' | 'auto' = 'auto',
) =>
    invoke<DeltaMutationResponse>('add_plugin_to_track_with_deltas_cmd', {
        payload: { trackId, pluginId, pluginName, slot },
    });

export const removePluginFromTrack = (trackId: string, slotId: string) =>
    invoke<void>('remove_plugin_from_track_cmd', {
        payload: { trackId, slotId },
    });
export const removePluginFromTrackWithDeltas = (trackId: string, slotId: string) =>
    invoke<DeltaMutationResponse>('remove_plugin_from_track_with_deltas_cmd', {
        payload: { trackId, slotId },
    });

export const copyDeviceFromTrack = (trackId: string, deviceId: string) =>
    invoke<string>('copy_device_from_track_cmd', { trackId, deviceId });

export const pasteDeviceToTrack = (
    trackId: string,
    slotHint: 'instrument' | 'effect' | 'auto' = 'auto',
) =>
    invoke<void>('paste_device_to_track_cmd', { trackId, slotHint });
export const pasteDeviceToTrackWithDeltas = (
    trackId: string,
    slotHint: 'instrument' | 'effect' | 'auto' = 'auto',
) =>
    invoke<DeltaMutationResponse>('paste_device_to_track_with_deltas_cmd', { trackId, slotHint });

export const setInternalPluginParam = (
    trackId: string,
    slotId: string,
    paramId: string,
    value: number,
    options?: { pushUndoStep?: boolean },
) =>
    invoke<void>('set_internal_plugin_param_cmd', {
        payload: {
            trackId,
            slotId,
            paramId,
            value,
            pushUndoStep: options?.pushUndoStep,
        },
    });
export const setInternalPluginParamWithDeltas = (
    trackId: string,
    slotId: string,
    paramId: string,
    value: number,
    options?: { pushUndoStep?: boolean },
) =>
    invoke<DeltaMutationResponse>('set_internal_plugin_param_with_deltas_cmd', {
        payload: {
            trackId,
            slotId,
            paramId,
            value,
            pushUndoStep: options?.pushUndoStep,
        },
    });

export const setExternalPluginParam = (
    pluginId: string,
    paramIndex: number,
    value: number,
) =>
    invoke<void>('set_external_plugin_param_cmd', {
        pluginId,
        paramIndex,
        value,
    });

export const setExternalPluginParamForSlot = (
    trackId: string,
    slotId: string,
    paramIndex: number,
    value: number,
    options?: { pushUndoStep?: boolean },
) =>
    invoke<void>('set_external_plugin_param_for_slot_cmd', {
        trackId,
        slotId,
        paramIndex,
        value,
        pushUndoStep: options?.pushUndoStep,
    });
export const setExternalPluginParamForSlotWithDeltas = (
    trackId: string,
    slotId: string,
    paramIndex: number,
    value: number,
    options?: { pushUndoStep?: boolean },
) =>
    invoke<DeltaMutationResponse>('set_external_plugin_param_for_slot_with_deltas_cmd', {
        trackId,
        slotId,
        paramIndex,
        value,
        pushUndoStep: options?.pushUndoStep,
    });

export interface ExternalPluginParamInfo {
    index: number;
    name: string;
    min: number;
    max: number;
    step: number;
    value: number;
}

export const getExternalPluginParams = (pluginId: string) =>
    invoke<ExternalPluginParamInfo[]>('get_external_plugin_params', { pluginId });

export const getExternalPluginParamsForSlot = (trackId: string, slotId: string) =>
    invoke<ExternalPluginParamInfo[]>('get_external_plugin_params_for_slot', { trackId, slotId });

export const setSamplerSample = (
    trackId: string,
    samplePath: string,
    rootNote?: number,
) =>
    invoke<void>('set_sampler_sample_cmd', {
        payload: { trackId, samplePath, rootNote: rootNote ?? null },
    });
export const setSamplerSampleWithDeltas = (
    trackId: string,
    samplePath: string,
    rootNote?: number,
) =>
    invoke<DeltaMutationResponse>('set_sampler_sample_with_deltas_cmd', {
        payload: { trackId, samplePath, rootNote: rootNote ?? null },
    });

export const setSampleRackPadSample = (
    trackId: string,
    padIndex: number,
    samplePath: string,
) =>
    invoke<void>('set_sample_rack_pad_sample_cmd', {
        trackId, padIndex, samplePath
    });
export const setSampleRackPadSampleWithDeltas = (
    trackId: string,
    padIndex: number,
    samplePath: string,
) =>
    invoke<DeltaMutationResponse>('set_sample_rack_pad_sample_with_deltas_cmd', {
        trackId, padIndex, samplePath
    });

export const setSampleRackPadVolumeCmd = (trackId: string, padIndex: number, volume: number) =>
    invoke<void>('set_sample_rack_pad_volume_cmd', { trackId, padIndex, volume });
export const setSampleRackPadVolumeWithDeltasCmd = (trackId: string, padIndex: number, volume: number) =>
    invoke<DeltaMutationResponse>('set_sample_rack_pad_volume_with_deltas_cmd', { trackId, padIndex, volume });

export const setSampleRackPadMuteCmd = (trackId: string, padIndex: number, muted: boolean) =>
    invoke<void>('set_sample_rack_pad_mute_cmd', { trackId, padIndex, muted });
export const setSampleRackPadMuteWithDeltasCmd = (trackId: string, padIndex: number, muted: boolean) =>
    invoke<DeltaMutationResponse>('set_sample_rack_pad_mute_with_deltas_cmd', { trackId, padIndex, muted });

export const setSampleRackPadSoloCmd = (trackId: string, padIndex: number, soloed: boolean) =>
    invoke<void>('set_sample_rack_pad_solo_cmd', { trackId, padIndex, soloed });
export const setSampleRackPadSoloWithDeltasCmd = (trackId: string, padIndex: number, soloed: boolean) =>
    invoke<DeltaMutationResponse>('set_sample_rack_pad_solo_with_deltas_cmd', { trackId, padIndex, soloed });

export const setSampleRackPadAdsrCmd = (trackId: string, padIndex: number, attack: number, decay: number, sustain: number, release: number) =>
    invoke<void>('set_sample_rack_pad_adsr_cmd', { trackId, padIndex, attack, decay, sustain, release });
export const setSampleRackPadAdsrWithDeltasCmd = (trackId: string, padIndex: number, attack: number, decay: number, sustain: number, release: number) =>
    invoke<DeltaMutationResponse>('set_sample_rack_pad_adsr_with_deltas_cmd', { trackId, padIndex, attack, decay, sustain, release });

export const setSampleRackPadFilterCutoffCmd = (trackId: string, padIndex: number, cutoff: number) =>
    invoke<void>('set_sample_rack_pad_filter_cutoff_cmd', { trackId, padIndex, cutoff });
export const setSampleRackPadFilterCutoffWithDeltasCmd = (trackId: string, padIndex: number, cutoff: number) =>
    invoke<DeltaMutationResponse>('set_sample_rack_pad_filter_cutoff_with_deltas_cmd', { trackId, padIndex, cutoff });

export const setClipFades = (clipId: string, fadeInFrames: number, fadeOutFrames: number) =>
    invoke<void>('set_clip_fades_cmd', { clipId, fadeInFrames, fadeOutFrames });
export const setClipFadesWithDeltas = (clipId: string, fadeInFrames: number, fadeOutFrames: number) =>
    invoke<DeltaMutationResponse>('set_clip_fades_with_deltas_cmd', { clipId, fadeInFrames, fadeOutFrames });

export const setClipSourceOffset = (clipId: string, sourceOffsetFrames: number) =>
    invoke<void>('set_clip_source_offset_cmd', { clipId, sourceOffsetFrames });
export const setClipSourceOffsetWithDeltas = (clipId: string, sourceOffsetFrames: number) =>
    invoke<DeltaMutationResponse>('set_clip_source_offset_with_deltas_cmd', { clipId, sourceOffsetFrames });

export interface SetClipWarpPayload {
    clipId: string;
    isWarped?: boolean;
    warpMode?: number | null;
    warpBaseBpm?: number | null;
}

export const setClipWarp = (payload: SetClipWarpPayload) =>
    invoke<void>('set_clip_warp_cmd', { payload });
export const setClipWarpWithDeltas = (payload: SetClipWarpPayload) =>
    invoke<DeltaMutationResponse>('set_clip_warp_with_deltas_cmd', { payload });

export const setClipPitch = (payload: {
    clipId: string;
    pitchShiftSemitones: number;
}) =>
    invoke<void>('set_clip_pitch_cmd', { payload });
export const setClipPitchWithDeltas = (payload: {
    clipId: string;
    pitchShiftSemitones: number;
}) =>
    invoke<DeltaMutationResponse>('set_clip_pitch_with_deltas_cmd', { payload });

export interface ExportSettings {
    outputPath: string;
    sampleRate: 44100 | 48000 | 96000;
    bitDepth: 16 | 24 | 32;
    range: 'full' | 'loop' | 'selected';
    normalize: boolean;
    tailMs: number;
    format: 'wav' | 'mp3';
    startFrame?: number;
    endFrame?: number;
}

export interface BackgroundJobSnapshot {
    id: string;
    kind: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled' | string;
    progress: number;
    phase: string;
    startedAtMs: number;
    finishedAtMs?: number | null;
    error?: string | null;
    cancellable: boolean;
}

export const exportMix = (settings: ExportSettings) =>
    invoke<string>('export_mix_cmd', { settings });

export const cancelExport = () =>
    invoke<void>('cancel_export_cmd');

export const listBackgroundJobs = () =>
    invoke<BackgroundJobSnapshot[]>('list_background_jobs_cmd');

export const cancelBackgroundJob = (jobId: string) =>
    invoke<void>('cancel_background_job_cmd', { jobId });

export const clearFinishedBackgroundJobs = () =>
    invoke<number>('clear_finished_background_jobs_cmd');

export interface BounceSelectionToTrackPayload {
    clipIds?: string[];
    rangeStartFrames?: number;
    rangeEndFrames?: number;
    startTrackIndex?: number;
    endTrackIndex?: number;
}

export const bounceSelectionToTrack = (payload: BounceSelectionToTrackPayload) =>
    invoke<void>('bounce_selection_to_track_cmd', { payload });
export const bounceSelectionToTrackWithDeltas = (payload: BounceSelectionToTrackPayload) =>
    invoke<DeltaMutationResponse>('bounce_selection_to_track_with_deltas_cmd', { payload });

export const bounceTrack = (trackId: string) =>
    invoke<void>('bounce_track_cmd', { trackId });
export const bounceTrackWithDeltas = (trackId: string) =>
    invoke<DeltaMutationResponse>('bounce_track_with_deltas_cmd', { trackId });

export const bounceGroup = (groupTrackId: string) =>
    invoke<void>('bounce_group_cmd', { groupTrackId });
export const bounceGroupWithDeltas = (groupTrackId: string) =>
    invoke<DeltaMutationResponse>('bounce_group_with_deltas_cmd', { groupTrackId });

export const splitTrackToStems = (trackId: string) =>
    invoke<void>('split_track_to_stems_cmd', {
        payload: { trackId },
    });
export const splitTrackToStemsWithDeltas = (trackId: string) =>
    invoke<DeltaMutationResponse>('split_track_to_stems_with_deltas_cmd', {
        payload: { trackId },
    });

export const undo = () => invoke<void>('undo_cmd');
export const undoWithDeltas = () =>
    invoke<DeltaMutationResponse>('undo_with_deltas_cmd');

export const redo = () => invoke<void>('redo_cmd');
export const redoWithDeltas = () =>
    invoke<DeltaMutationResponse>('redo_with_deltas_cmd');

export const armTrack = (trackIndex: number, armed: boolean) =>
    invoke<void>('arm_track_cmd', { trackIndex, armed });
export const armTrackWithDeltas = (trackIndex: number, armed: boolean) =>
    invoke<DeltaMutationResponse>('arm_track_with_deltas_cmd', { trackIndex, armed });

export const startRecording = () =>
    invoke<void>('start_recording_cmd');

export const stopRecording = () =>
    invoke<void>('stop_recording_cmd');

export const resolveMissingFile = (clipId: string, newPath: string) =>
    invoke<void>('resolve_missing_file_cmd', { clipId, newPath });
export const resolveMissingFileWithDeltas = (clipId: string, newPath: string) =>
    invoke<DeltaMutationResponse>('resolve_missing_file_with_deltas_cmd', { clipId, newPath });

export interface AutomationPoint {
    beat: number;
    value: number;
    curveType: 'linear' | 'bezier' | 'step';
    tension?: number;
}

export const setAutomationPoints = (trackId: string, paramId: string, points: AutomationPoint[]) =>
    invoke<void>('set_automation_points_cmd', { trackId, paramId, points });
export const setAutomationPointsWithDeltas = (trackId: string, paramId: string, points: AutomationPoint[]) =>
    invoke<DeltaMutationResponse>('set_automation_points_with_deltas_cmd', { trackId, paramId, points });

export const createRackFromDevices = (
    trackId: string,
    deviceIds: string[],
    rackName?: string,
    rackType?: 'audio_effect' | 'instrument' | 'drum' | 'midi_effect',
) =>
    invoke<string>('create_rack_from_devices_cmd', {
        payload: { trackId, deviceIds, rackName: rackName ?? null, rackType: rackType ?? null },
    });

export const addChainToRack = (
    trackId: string,
    rackId: string,
    chainName?: string,
) =>
    invoke<string>('add_chain_to_rack_cmd', {
        payload: { trackId, rackId, chainName: chainName ?? null },
    });

export const addDeviceToRackChain = (
    trackId: string,
    rackId: string,
    chainId: string,
    pluginId: string,
    pluginName: string,
    insertIndex?: number,
) =>
    invoke<string>('add_device_to_rack_chain_cmd', {
        payload: { trackId, rackId, chainId, pluginId, pluginName, insertIndex: insertIndex ?? null },
    });

export const removeDeviceFromRack = (
    trackId: string,
    rackId: string,
    deviceId: string,
    autoDissolve = false,
) =>
    invoke<void>('remove_device_from_rack_cmd', {
        payload: { trackId, rackId, deviceId, autoDissolve },
    });

export const saveDevicePreset = (
    trackId: string,
    deviceId: string,
    outputPath: string,
    presetName?: string,
    tags?: string[],
    description?: string,
) =>
    invoke<string>('save_device_preset_cmd', {
        payload: {
            trackId,
            deviceId,
            outputPath,
            presetName: presetName ?? null,
            tags: tags ?? null,
            description: description ?? null,
        },
    });

export const loadDevicePreset = (
    trackId: string,
    presetPath: string,
    insertIndex?: number,
) =>
    invoke<string>('load_device_preset_cmd', {
        payload: { trackId, presetPath, insertIndex: insertIndex ?? null },
    });
