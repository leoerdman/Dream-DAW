import { invoke } from '@tauri-apps/api/core';

type InvokeArgs = Record<string, unknown>;

export class IpcCommandError extends Error {
    readonly command: string;
    readonly raw: unknown;

    constructor(command: string, raw: unknown, message: string) {
        super(message);
        this.name = 'IpcCommandError';
        this.command = command;
        this.raw = raw;
    }
}

function extractIpcErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
        const record = error as Record<string, unknown>;
        const message = record.message;
        if (typeof message === 'string' && message.length > 0) return message;
        const nestedError = record.error;
        if (typeof nestedError === 'string' && nestedError.length > 0) return nestedError;
    }
    return String(error);
}
// ENTERPRISE FIX: useStatusStore and useEngineStore are accessed LAZILY
// inside function bodies to break the circular dependency:
//   engine.ts → useEngineStore → engine.ts
// Top-level imports would deadlock ESM module evaluation.

interface InvokeOptions {
    suppressGlobalError?: boolean;
}

async function invokeTauri<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
    // ENTERPRISE FIX: Tauri bridge injection race condition.
    // If the frontend evaluates and calls `invoke` before Tauri completes its async
    // bridge injection, `invoke` throws a non-catchable TypeError leading to unhandled rejections.
    // We poll for up to 8 seconds to ensure the bridge exists.
    let retries = 0;
    while (!window.__TAURI_INTERNALS__ && retries < 80) {
        await new Promise(r => setTimeout(r, 100));
        retries++;
    }
    if (!window.__TAURI_INTERNALS__) {
        const msg = `invokeTauri timeout: Tauri bridge never injected for ${command}`;
        console.error(`[Dream] ${msg}`);
        throw new IpcCommandError(command, null, msg);
    }

    try {
        return await invoke<T>(command, args);
    } catch (error) {
        const message = extractIpcErrorMessage(error);
        const fullMessage = `IPC error (${command}): ${message}`;

        if (!options?.suppressGlobalError) {
            console.error(`[Dream] ${fullMessage}`, error);
            // Push to unified status bar for user visibility
            // LAZY ACCESS: avoids circular import deadlock
            try {
                const { useStatusStore } = await import('@/shared/stores/useStatusStore');
                useStatusStore.getState().setError(fullMessage);
            } catch { /* store not ready yet during early boot */ }
        }

        throw new IpcCommandError(
            command,
            error,
            fullMessage,
        );
    }
}

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
import { clampMidiPitch, clampMidiVelocity, clamp01, getMinMidiNoteDurationFrames, MIN_BPM, MAX_BPM } from '@/shared/lib/audioMath';
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

/** IPC Resilience: Wraps a promise with a timeout to prevent UI hangs. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`IPC Timeout: Command failed to respond within ${ms}ms`));
        }, ms);
    });
    try {
        const result = await Promise.race([promise, timeout]);
        clearTimeout(timeoutId!);
        return result;
    } catch (err) {
        clearTimeout(timeoutId!);
        throw err;
    }
}

export const play = () => invokeTauri<void>('play');
/** ENTERPRISE FIX: Atomic seek-and-play — eliminates the 1-buffer stutter
 *  caused by separate togglePlayback() + seekToBeat() IPC calls. */
export const playFromBeat = (beat: number) =>
    invokeTauri<void>('play_from_beat', { beat });
export const stop = () => invokeTauri<void>('stop');
export const togglePlayback = () => invokeTauri<boolean>('toggle_playback');
export const seek = (positionFrames: number) =>
    invokeTauri<void>('seek', { positionFrames });
export const seekSeconds = (seconds: number) =>
    invokeTauri<void>('seek_seconds', { seconds });
export const seekToBeat = (beat: number) =>
    invokeTauri<void>('seek_to_beat', { beat });
// BUG-025 FIX: Clamp BPM at API boundary — prevents NaN/Infinity/0/negative from reaching backend.
export const setBpm = (bpm: number) => {
    const safe = Number.isFinite(bpm) ? Math.max(MIN_BPM, Math.min(MAX_BPM, bpm)) : MIN_BPM;
    return invokeTauri<void>('set_bpm', { bpm: safe });
};
export const setBpmWithDeltas = (bpm: number) => {
    const safe = Number.isFinite(bpm) ? Math.max(MIN_BPM, Math.min(MAX_BPM, bpm)) : MIN_BPM;
    return invokeTauri<DeltaMutationResponse>('set_bpm_with_deltas', { bpm: safe });
};
export const setTimeSignature = (numerator: number, denominator: number) =>
    invokeTauri<void>('set_time_signature', { numerator, denominator });
export const setTimeSignatureWithDeltas = (numerator: number, denominator: number) =>
    invokeTauri<DeltaMutationResponse>('set_time_signature_with_deltas', { numerator, denominator });
// BUG-026 FIX: Validate loop frame values at API boundary.
export const setLoop = (enabled: boolean, startFrames: number, endFrames: number) => {
    const s = Number.isFinite(startFrames) ? Math.max(0, Math.round(startFrames)) : 0;
    const e = Number.isFinite(endFrames) ? Math.max(s + 1, Math.round(endFrames)) : s + 1;
    return invokeTauri<void>('set_loop', { enabled, startFrames: s, endFrames: e });
};
export const setLoopWithDeltas = (enabled: boolean, startFrames: number, endFrames: number) => {
    const s = Number.isFinite(startFrames) ? Math.max(0, Math.round(startFrames)) : 0;
    const e = Number.isFinite(endFrames) ? Math.max(s + 1, Math.round(endFrames)) : s + 1;
    return invokeTauri<DeltaMutationResponse>('set_loop_with_deltas', { enabled, startFrames: s, endFrames: e });
};
export const setTrackVolume = (trackIndex: number, volume: number) =>
    invokeTauri<void>('set_track_volume', { trackIndex, volume });
export const setTrackVolumeWithDeltas = (trackIndex: number, volume: number) =>
    invokeTauri<DeltaMutationResponse>('set_track_volume_with_deltas', { trackIndex, volume });
export const setTrackPan = (trackIndex: number, pan: number) =>
    invokeTauri<void>('set_track_pan', { trackIndex, pan });
export const setTrackPanWithDeltas = (trackIndex: number, pan: number) =>
    invokeTauri<DeltaMutationResponse>('set_track_pan_with_deltas', { trackIndex, pan });
export const setMasterVolume = (volume: number) =>
    invokeTauri<void>('set_master_volume', { volume });
export const setTrackDisabled = (trackIndex: number, disabled: boolean) =>
    invokeTauri<void>('set_track_disabled', { trackIndex, disabled });
export const setTrackDisabledWithDeltas = (trackIndex: number, disabled: boolean) =>
    invokeTauri<DeltaMutationResponse>('set_track_disabled_with_deltas', { trackIndex, disabled });
export const setTrackSolo = (trackIndex: number, soloed: boolean) =>
    invokeTauri<void>('set_track_solo', { trackIndex, soloed });
export const setTrackSoloWithDeltas = (trackIndex: number, soloed: boolean) =>
    invokeTauri<DeltaMutationResponse>('set_track_solo_with_deltas', { trackIndex, soloed });
export const setTrackSendLevel = (trackIndex: number, send: 'A' | 'B', value: number) =>
    invokeTauri<void>('set_track_send_level', { trackIndex, send, value });
export const setTrackSendLevelWithDeltas = (trackIndex: number, send: 'A' | 'B', value: number) =>
    invokeTauri<DeltaMutationResponse>('set_track_send_level_with_deltas', { trackIndex, send, value });
export const previewSamplerNoteOn = (trackIndex: number, pitch: number, velocity: number = 100) =>
    invokeTauri<void>('preview_sampler_note_on_cmd', {
        trackIndex: Math.max(0, Math.round(trackIndex)),
        pitch: clampMidiPitch(pitch),
        velocity: clampMidiVelocity(velocity),
    }, { suppressGlobalError: true });
export const previewSamplerNoteOff = (trackIndex: number, pitch: number) =>
    invokeTauri<void>('preview_sampler_note_off_cmd', {
        trackIndex: Math.max(0, Math.round(trackIndex)),
        pitch: clampMidiPitch(pitch),
    }, { suppressGlobalError: true });
export type BuiltinEffectType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34;
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
    Analyzer: BuiltinEffectType;
    // Wave 3 — Unique Processors
    ChannelEq: BuiltinEffectType;
    Overdrive: BuiltinEffectType;
    TransientShaper: BuiltinEffectType;
    DrumBuss: BuiltinEffectType;
    DynamicTube: BuiltinEffectType;
    PhaserFlanger: BuiltinEffectType;
    Amp: BuiltinEffectType;
    Cabinet: BuiltinEffectType;
    HybridReverb: BuiltinEffectType;
    Erosion: BuiltinEffectType;
    Pedal: BuiltinEffectType;
    Roar: BuiltinEffectType;
    MultibandDynamics: BuiltinEffectType;
    GrainDelay: BuiltinEffectType;
    Corpus: BuiltinEffectType;
    SpectralTime: BuiltinEffectType;
    GlueCompressor: BuiltinEffectType;
    FilterDelay: BuiltinEffectType;
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
    Analyzer: 16,
    // Wave 3 — Unique Processors
    ChannelEq: 17,
    Overdrive: 18,
    TransientShaper: 19,
    DrumBuss: 20,
    DynamicTube: 21,
    PhaserFlanger: 22,
    Amp: 23,
    Cabinet: 24,
    HybridReverb: 25,
    Erosion: 26,
    Pedal: 27,
    Roar: 28,
    MultibandDynamics: 29,
    GrainDelay: 30,
    Corpus: 31,
    SpectralTime: 32,
    GlueCompressor: 33,
    FilterDelay: 34,
} as const;
export const addDevice = (trackIndex: number, slotIndex: number, effectType: BuiltinEffectType) =>
    invokeTauri<void>('add_device_cmd', { trackIndex, slotIndex, effectType });
export const removeDevice = (trackIndex: number, slotIndex: number) =>
    invokeTauri<void>('remove_device_cmd', { trackIndex, slotIndex });
export const bypassDevice = (trackIndex: number, slotIndex: number, bypassed: boolean) =>
    invokeTauri<void>('bypass_device_cmd', { trackIndex, slotIndex, bypassed });
export const setSlotBypass = (trackId: string, slotId: string, bypassed: boolean) =>
    invokeTauri<void>('set_slot_bypass_cmd', { trackId, slotId, bypassed });
export const setSlotBypassWithDeltas = (trackId: string, slotId: string, bypassed: boolean) =>
    invokeTauri<DeltaMutationResponse>('set_slot_bypass_with_deltas_cmd', { trackId, slotId, bypassed });
export const moveEffectSlot = (trackId: string, slotId: string, targetIndex: number) =>
    invokeTauri<void>('move_effect_slot_cmd', { trackId, slotId, targetIndex });
export const moveEffectSlotWithDeltas = (trackId: string, slotId: string, targetIndex: number) =>
    invokeTauri<DeltaMutationResponse>('move_effect_slot_with_deltas_cmd', { trackId, slotId, targetIndex });
export const setDeviceParam = (trackIndex: number, slotIndex: number, paramIndex: number, value: number) =>
    invokeTauri<void>('set_device_param_cmd', { trackIndex, slotIndex, paramIndex, value });
export const setDeviceParamRuntime = (trackIndex: number, slotIndex: number, paramIndex: number, value: number) =>
    invokeTauri<void>('set_device_param_runtime_cmd', { trackIndex, slotIndex, paramIndex, value });
export type RuntimeDeviceParamUpdate = {
    paramIndex: number;
    value: number;
};
export const setDeviceParamsRuntime = (
    trackIndex: number,
    slotIndex: number,
    updates: RuntimeDeviceParamUpdate[],
) => invokeTauri<void>('set_device_params_runtime_cmd', { trackIndex, slotIndex, updates });
export const updateTrack = (update: TrackStateUpdate) =>
    invokeTauri<void>('update_track', { update });
export const addTrack = (name?: string, inheritFromTrackId?: string | null) =>
    invokeTauri<void>('add_track_cmd', {
        name: name ?? null,
        trackType: 'audio',
        insertAfterIndex: null,
        inheritFromTrackId: inheritFromTrackId ?? null,
    });
export const addTrackWithDeltas = (name?: string, inheritFromTrackId?: string | null) =>
    invokeTauri<DeltaMutationResponse>('add_track_with_deltas_cmd', {
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
    invokeTauri<void>('add_track_cmd', {
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
    invokeTauri<DeltaMutationResponse>('add_track_with_deltas_cmd', {
        name: name ?? null,
        trackType,
        insertAfterIndex: insertAfterIndex ?? null,
        inheritFromTrackId: inheritFromTrackId ?? null,
    });
export const deleteTrack = (trackIndex: number) =>
    invokeTauri<void>('delete_track_cmd', { index: trackIndex });
export const deleteTrackWithDeltas = (trackIndex: number) =>
    invokeTauri<DeltaMutationResponse>('delete_track_with_deltas_cmd', { index: trackIndex });
export const deleteTracks = (trackIds: string[]) =>
    invokeTauri<void>('delete_tracks_cmd', { trackIds });
export const renameTrack = (index: number, name: string) =>
    invokeTauri<void>('rename_track_cmd', { index, name });
export const renameTrackWithDeltas = (index: number, name: string) =>
    invokeTauri<DeltaMutationResponse>('rename_track_with_deltas_cmd', { index, name });
export const setTrackHeight = (trackId: string, height: number) =>
    invokeTauri<void>('set_track_height_cmd', { trackId, height });
export const setTrackHeightWithDeltas = (trackId: string, height: number) =>
    invokeTauri<DeltaMutationResponse>('set_track_height_with_deltas_cmd', { trackId, height });
export const setTrackColor = (trackId: string, colorHex: string) =>
    invokeTauri<void>('set_track_color_cmd', { trackId, colorHex });
export const setTrackColorWithDeltas = (trackId: string, colorHex: string) =>
    invokeTauri<DeltaMutationResponse>('set_track_color_with_deltas_cmd', { trackId, colorHex });
export const createGroup = (trackIds: string[], groupName?: string) =>
    invokeTauri<string>('create_group_cmd', {
        trackIds,
        groupName: groupName ?? null,
    });
export interface CreateGroupWithDeltasResponse {
    group_id: string;
    deltas: ProjectDelta[];
}
export const createGroupWithDeltas = (trackIds: string[], groupName?: string) =>
    invokeTauri<CreateGroupWithDeltasResponse>('create_group_with_deltas_cmd', {
        trackIds,
        groupName: groupName ?? null,
    });
export const setGroupExpanded = (groupId: string, expanded: boolean) =>
    invokeTauri<void>('set_group_expanded_cmd', { groupId, expanded });
export const setGroupExpandedWithDeltas = (groupId: string, expanded: boolean) =>
    invokeTauri<DeltaMutationResponse>('set_group_expanded_with_deltas_cmd', { groupId, expanded });
export const moveTrackToIndex = (trackId: string, targetIndex: number) =>
    invokeTauri<void>('move_track_to_index_cmd', { trackId, targetIndex });
export const moveTrackToIndexWithDeltas = (trackId: string, targetIndex: number) =>
    invokeTauri<DeltaMutationResponse>('move_track_to_index_with_deltas_cmd', { trackId, targetIndex });
export const moveTrackWithParent = (
    trackId: string,
    targetIndex: number,
    targetParentGroupId?: string | null,
) =>
    invokeTauri<void>('move_track_with_parent_cmd', {
        trackId,
        targetIndex,
        targetParentGroupId: targetParentGroupId ?? null,
    });
export const moveTrackWithParentWithDeltas = (
    trackId: string,
    targetIndex: number,
    targetParentGroupId?: string | null,
) =>
    invokeTauri<DeltaMutationResponse>('move_track_with_parent_with_deltas_cmd', {
        trackId,
        targetIndex,
        targetParentGroupId: targetParentGroupId ?? null,
    });
export const setTrackGroup = (trackId: string, groupId?: string | null) =>
    invokeTauri<void>('set_track_group_cmd', {
        trackId,
        groupId: groupId ?? null,
    });
export const setTrackGroupWithDeltas = (trackId: string, groupId?: string | null) =>
    invokeTauri<DeltaMutationResponse>('set_track_group_with_deltas_cmd', {
        trackId,
        groupId: groupId ?? null,
    });
export const ungroupTrack = (groupId: string) =>
    invokeTauri<void>('ungroup_track_cmd', { groupId });
export const ungroupTrackWithDeltas = (groupId: string) =>
    invokeTauri<DeltaMutationResponse>('ungroup_track_with_deltas_cmd', { groupId });
export const moveTrackBlockToIndex = (rootTrackId: string, targetIndex: number) =>
    invokeTauri<void>('move_track_block_to_index_cmd', { rootTrackId, targetIndex });
export const moveTrackBlockToIndexWithDeltas = (rootTrackId: string, targetIndex: number) =>
    invokeTauri<DeltaMutationResponse>('move_track_block_to_index_with_deltas_cmd', {
        rootTrackId,
        targetIndex,
    });
export const duplicateTracks = (trackIds: string[]) =>
    invokeTauri<void>('duplicate_tracks_cmd', { trackIds });
export const duplicateTracksWithDeltas = (trackIds: string[]) =>
    invokeTauri<DeltaMutationResponse>('duplicate_tracks_with_deltas_cmd', { trackIds });
export const getState = () => invokeTauri<EngineState>('get_state');
export const getTransport = () => invokeTauri<TransportState>('get_transport');
export const getMeters = () => invokeTauri<MeteringSnapshot>('get_meters');
type BinaryInvokePayload = ArrayBuffer | Uint8Array | number[];
function toUint8Array(payload: BinaryInvokePayload): Uint8Array {
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    return new Uint8Array(payload);
}
export const getMetersBinary = async (): Promise<Uint8Array> => {
    const raw = await invokeTauri<BinaryInvokePayload>('get_meters_binary');
    const bytes = toUint8Array(raw);
    const validLength = bytes.length - (bytes.length % 4);
    return bytes.byteLength === validLength ? bytes : bytes.subarray(0, validLength);
};
export const getProjectHistory = (options?: { limit?: number; sinceSeq?: number }) =>
    invokeTauri<ProjectHistoryEvent[]>('get_project_history', {
        limit: options?.limit,
        sinceSeq: options?.sinceSeq,
    });
export const getPdcDebugSnapshot = () =>
    invokeTauri<PdcDebugSnapshot>('get_pdc_debug_snapshot');
export const getRtDebugSnapshot = () =>
    invokeTauri<RtDebugSnapshot>('get_rt_debug_snapshot');
export const setRtDebugEnabled = (enabled: boolean) =>
    invokeTauri<void>('set_rt_debug_enabled', { enabled });
export const setFrequency = (freq: number) =>
    invokeTauri<void>('set_frequency', { freq });
export const getSpectrumData = () =>
    invokeTauri<number[]>('get_spectrum_data');
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
    invokeTauri<ImportAudioResponse>('import_audio_file', {
        path,
        trackIndex,
        positionFrames: positionFrames ?? null,
    });
export const importAudioFileWithDeltas = (path: string, trackIndex: number, positionFrames?: number) =>
    invokeTauri<ImportAudioWithDeltasResponse>('import_audio_file_with_deltas', {
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
    invokeTauri<CreateMidiClipResponse>('create_midi_clip_cmd', {
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
    invokeTauri<CreateMidiClipWithDeltasResponse>('create_midi_clip_with_deltas_cmd', {
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
    invokeTauri<void>('update_midi_clip_cmd', {
        clipId,
        push_undo_step: options?.pushUndoStep ?? true,
        notes: notes.map((n) => ({
            pitch: clampMidiPitch(n.pitch),
            velocity: clampMidiVelocity(n.velocity),
            start_frames: Math.max(0, Math.round(n.startFrames)),
            // BUG-001 FIX: SSOT — both updateMidiClip and updateMidiClipWithDeltas
            // use the same getMinMidiNoteDurationFrames function.
            duration_frames: Math.max(getMinMidiNoteDurationFrames(), Math.round(n.durationFrames)),
        })),
    });
export const updateMidiClipWithDeltas = (
    clipId: string,
    notes: MidiClipNoteUpdate[],
    options?: { pushUndoStep?: boolean },
) =>
    invokeTauri<DeltaMutationResponse>('update_midi_clip_with_deltas_cmd', {
        clipId,
        push_undo_step: options?.pushUndoStep ?? true,
        notes: notes.map((n) => ({
            pitch: clampMidiPitch(n.pitch),
            velocity: clampMidiVelocity(n.velocity),
            start_frames: Math.max(0, Math.round(n.startFrames)),
            // SSOT FIX: Must match updateMidiClip's minimum (~10ms).
            // Previously used Math.max(1, ...) — 1-frame notes are inaudible clicks.
            duration_frames: Math.max(getMinMidiNoteDurationFrames(), Math.round(n.durationFrames)),
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
    invokeTauri<void>('set_midi_clip_envelopes_cmd', {
        clipId,
        push_undo_step: options?.pushUndoStep ?? true,
        envelopes: envelopes.map((env) => ({
            paramId: env.paramId,
            points: env.points.map((p) => ({
                beat: Math.max(0, Number(p.beat ?? 0)),
                value: clamp01(Number(p.value ?? 0)),
            })),
        })),
    });
export const generateMidiVariation = (input: GenerateMidiVariationInput) =>
    invokeTauri<{ notes: MidiVariationNote[] }>('generate_midi_variation_cmd', { request: input })
        .then((res) => res.notes);
export const getMidiInputs = () =>
    invokeTauri<MidiInputPort[]>('get_midi_inputs');
export const connectMidiInput = (portName: string) =>
    invokeTauri<void>('connect_midi_input', { portName });
export const generateDemoSamples = () =>
    invokeTauri<number>('generate_demo_samples_cmd');
export const previewAudioFile = (path: string) =>
    invokeTauri<void>('preview_audio_file_cmd', { path });
export const stopPreview = () =>
    invokeTauri<void>('stop_preview_cmd', undefined, { suppressGlobalError: true });
export const getAudioFileDuration = (path: string) =>
    invokeTauri<number>('get_audio_file_duration', { path });
export const closeSplashscreen = () => invokeTauri<void>('close_splashscreen');
export const getActiveProjectId = () => invokeTauri<string>('get_active_project_id');
export const newProject = () => invokeTauri<DeltaMutationResponse>('new_project');
export const saveProject = () => invokeTauri<string>('save_project');
export const saveProjectAs = (path: string) =>
    invokeTauri<string>('save_project_as', { path });
export const openProject = (path: string) =>
    invokeTauri<DeltaMutationResponse>('open_project', { path });
export const importAbletonProject = (path: string) =>
    invokeTauri<DeltaMutationResponse>('import_ableton_project', { path });
export const eagerActivateExternalPlugins = () =>
    invokeTauri<{ total: number; loaded: number; failed: number; skipped: number }>(
        'eager_activate_external_plugins',
    );
export const getRecentProjects = () =>
    invokeTauri<RecentProject[]>('get_recent_projects');
export const getProjectStatus = () => invokeTauri<ProjectStatus>('get_project_status', undefined, { suppressGlobalError: true });

// ── Multi-Project Tab Management ──
export interface ProjectTabInfo {
    id: string;
    name: string;
    filePath: string | null;
    isDirty: boolean;
}
export interface CreateProjectTabResponse {
    id: string;
    name: string;
    deltas: ProjectDelta[];
}
export interface CloseProjectTabResponse {
    closedId: string;
    newActiveId: string | null;
    deltas?: ProjectDelta[];
}
export const createProjectTab = () =>
    invokeTauri<CreateProjectTabResponse>('create_project_tab');
export const switchProjectTab = (id: string) =>
    invokeTauri<DeltaMutationResponse>('switch_project_tab', { id });
export const closeProjectTab = (id: string) =>
    invokeTauri<CloseProjectTabResponse>('close_project_tab', { id });
export const listOpenProjects = () =>
    invokeTauri<ProjectTabInfo[]>('list_open_projects');

// ── Cross-Project Global Clipboard ──
export const copyClipsToGlobalClipboard = (clipIds: string[]) =>
    invokeTauri<number>('copy_clips_to_global_clipboard', { clipIds });
export const pasteClipsFromGlobalClipboard = (trackIndex: number, positionFrames: number) =>
    invokeTauri<DeltaMutationResponse>('paste_clips_from_global_clipboard', { trackIndex, positionFrames });
export const copyTrackToGlobalClipboard = (trackIndex: number) =>
    invokeTauri<string>('copy_track_to_global_clipboard', { trackIndex });
export const pasteTrackFromGlobalClipboard = (insertIndex?: number) =>
    invokeTauri<DeltaMutationResponse>('paste_track_from_global_clipboard', { insertIndex: insertIndex ?? null });
export interface ArrangementViewportState {
    pixels_per_beat: number | null;
    scroll_left: number | null;
    scroll_top?: number | null;
}
export const setArrangementViewport = (pixelsPerBeat: number, scrollLeft: number, scrollTop?: number) =>
    invokeTauri<void>('set_arrangement_viewport_cmd', {
        pixelsPerBeat,
        scrollLeft,
        scrollTop,
    });
export const getArrangementViewport = () =>
    invokeTauri<ArrangementViewportState>('get_arrangement_viewport_cmd');
export const createBackup = () => invokeTauri<string>('create_backup_cmd');
export interface AutoSaveResult {
    saved: boolean;
    reason?: string;
    path?: string;
}
export const autoSaveIfDirty = () => invokeTauri<AutoSaveResult>('auto_save_if_dirty');
export const markDirty = () => invokeTauri<void>('mark_dirty_cmd');
export const syncTitle = () => invokeTauri<void>('sync_title_cmd');
export const getProjectNotes = () => invokeTauri<string>('get_project_notes');
export const setProjectNotes = (text: string) => invokeTauri<void>('set_project_notes', { text });
export const setArrangementGrid = (
    numerator: number,
    denominator: number,
    ntoles: number,
    snapToGrid: boolean,
    fixed: boolean,
) =>
    invokeTauri<void>('set_arrangement_grid_cmd', {
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
    invokeTauri<DeltaMutationResponse>('set_arrangement_grid_with_deltas_cmd', {
        numerator,
        denominator,
        ntoles,
        snapToGrid,
        fixed,
    });
export const setKeySignature = (enabled: boolean, tonic: string, mode: string) =>
    invokeTauri<void>('set_key_signature_cmd', { enabled, tonic, mode });
export const setKeySignatureWithDeltas = (enabled: boolean, tonic: string, mode: string) =>
    invokeTauri<DeltaMutationResponse>('set_key_signature_with_deltas_cmd', { enabled, tonic, mode });
export const getSettings = () => invokeTauri<AppSettings>('get_settings');
export const updateSettings = (newSettings: AppSettings) =>
    invokeTauri<void>('update_settings', { newSettings });
export interface AudioFileEntry {
    name: string;
    path: string;
    size_bytes: number;
    modified_at: string;
    format: string;
    duration_seconds?: number | null;
}
export const scanAudioFolder = (path: string) =>
    invokeTauri<AudioFileEntry[]>('scan_audio_folder', { path });
export const scanAllAudioSources = () =>
    invokeTauri<AudioFileEntry[]>('scan_all_audio_sources');
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
    invokeTauri<BrowserFileEntry[]>('scan_folder_all', { path });
export const scanPluginFolders = () =>
    invokeTauri<BrowserFileEntry[]>('scan_plugin_folders');
export const getBrowserFolders = () =>
    invokeTauri<string[]>('get_browser_folders');
export const addBrowserFolder = () =>
    invokeTauri<string[]>('add_browser_folder');
export const removeBrowserFolder = (path: string) =>
    invokeTauri<string[]>('remove_browser_folder', { path });
export const getSamplesPath = () =>
    invokeTauri<string>('get_samples_path');
export const pickFolder = () =>
    invokeTauri<string | null>('pick_folder');
export const pickProjectFile = () =>
    invokeTauri<string | null>('pick_project_file');
export const saveProjectDialog = () =>
    invokeTauri<string | null>('save_project_dialog');
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
    invokeTauri<WaveformPeaks>('get_waveform_peaks', { filePath });
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
    const raw = await invokeTauri<WaveformPeaksBinaryResponse>(
        'get_waveform_peaks_binary',
        { filePath },
    );
    const bytes = new Uint8Array(raw.peaks_bytes);
    // BUG-042 FIX: Ensure 4-byte alignment for Float32Array construction.
    // If the Uint8Array is a view of a sub-buffer, its byteOffset may not
    // be 4-byte aligned, causing RangeError. .slice() creates a fresh,
    // properly aligned ArrayBuffer copy.
    const aligned = bytes.buffer.byteLength === bytes.length
        ? bytes.buffer
        : bytes.slice().buffer;
    const floats = new Float32Array(aligned);
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
    const raw = await invokeTauri<BinaryInvokePayload>('get_waveform_peaks_lod_binary', {
        filePath,
        lodLevel,
    });
    return toUint8Array(raw);
}
export async function getPeaksByClipId(clipId: string, lodLevel: number): Promise<Uint8Array> {
    const raw = await invokeTauri<BinaryInvokePayload>('get_peaks_by_clip_id', {
        clipId,
        lodLevel,
    });
    return toUint8Array(raw);
}
export async function getPeaks(clipId: string, lodLevel: number): Promise<Uint8Array> {
    const raw = await invokeTauri<BinaryInvokePayload>('get_peaks_binary', { clipId, lodLevel });
    return toUint8Array(raw);
}
export const moveClip = (clipId: string, newTrackIndex: number, newPositionFrames: number) =>
    invokeTauri<void>('move_clip_cmd', { clipId, newTrackIndex, newPositionFrames });
export const moveClipWithDeltas = (clipId: string, newTrackIndex: number, newPositionFrames: number) =>
    invokeTauri<DeltaMutationResponse>('move_clip_with_deltas_cmd', { clipId, newTrackIndex, newPositionFrames });

export const moveMultipleClipsWithDeltas = (
    requests: Array<{ id: string; newTrackIndex: number; newPositionFrames: number }>
) => invokeTauri<DeltaMutationResponse>('move_multiple_clips_with_deltas_cmd', { requests });
export const resizeClip = (clipId: string, newPositionFrames: number, newDurationFrames: number, allowStretch: boolean = false) =>
    invokeTauri<void>('resize_clip_cmd', { clipId, newPositionFrames, newDurationFrames, allowStretch });
export const resizeClipWithDeltas = (clipId: string, newPositionFrames: number, newDurationFrames: number, allowStretch: boolean = false) =>
    invokeTauri<DeltaMutationResponse>('resize_clip_with_deltas_cmd', { clipId, newPositionFrames, newDurationFrames, allowStretch });
export const splitClip = (clipId: string, splitFrame: number) =>
    invokeTauri<SplitClipResponse>('split_clip_cmd', { clipId, splitFrame });
export const splitClipWithDeltas = (clipId: string, splitFrame: number) =>
    invokeTauri<SplitClipWithDeltasResponse>('split_clip_with_deltas_cmd', { clipId, splitFrame });
export const duplicateClip = (clipId: string, newPositionFrames?: number, targetTrackIndex?: number) =>
    invokeTauri<DuplicateClipResponse>('duplicate_clip_cmd', {
        clipId,
        newPositionFrames: newPositionFrames ?? null,
        targetTrackIndex: targetTrackIndex ?? null,
    });
export const duplicateClipWithDeltas = (clipId: string, newPositionFrames?: number, targetTrackIndex?: number) =>
    invokeTauri<DuplicateClipWithDeltasResponse>('duplicate_clip_with_deltas_cmd', {
        clipId,
        newPositionFrames: newPositionFrames ?? null,
        targetTrackIndex: targetTrackIndex ?? null,
    });

export const duplicateMultipleClipsWithDeltas = (
    requests: Array<{ id: string; newPositionFrames?: number; targetTrackIndex?: number }>
) => invokeTauri<DuplicateClipWithDeltasResponse>('duplicate_multiple_clips_with_deltas_cmd', { requests });
export const mergeClips = (clipIds: string[]) =>
    invokeTauri<MergeClipsResponse>('merge_clips_cmd', { clipIds });
export const mergeClipsWithDeltas = (clipIds: string[]) =>
    invokeTauri<MergeClipsWithDeltasResponse>('merge_clips_with_deltas_cmd', { clipIds });
export const deleteClip = (clipId: string) =>
    invokeTauri<void>('delete_clip_cmd', { clipId });
export const deleteClipWithDeltas = (clipId: string) =>
    invokeTauri<DeltaMutationResponse>('delete_clip_with_deltas_cmd', { clipId });
export const setClipMuted = (clipId: string, muted: boolean) =>
    invokeTauri<void>('set_clip_muted_cmd', { clipId, muted });
export const setClipMutedWithDeltas = (clipId: string, muted: boolean) =>
    invokeTauri<DeltaMutationResponse>('set_clip_muted_with_deltas_cmd', { clipId, muted });
export const setClipsMuted = (clipIds: string[], muted: boolean) =>
    invokeTauri<number>('set_clips_muted_cmd', { clipIds, muted });
export const setClipsMutedWithDeltas = (clipIds: string[], muted: boolean) =>
    invokeTauri<DeltaMutationResponse>('set_clips_muted_with_deltas_cmd', { clipIds, muted });
export const paintTrackClipsWithTrackColor = (trackId: string) =>
    invokeTauri<void>('paint_track_clips_with_track_color_cmd', { trackId });
export const paintTrackClipsWithTrackColorWithDeltas = (trackId: string) =>
    invokeTauri<DeltaMutationResponse>('paint_track_clips_with_track_color_with_deltas_cmd', { trackId });
export interface AudioDevices {
    outputs: string[];
    inputs: string[];
}
export const getAudioDevices = () =>
    invokeTauri<AudioDevices>('get_audio_devices');
export const setAudioDevice = (deviceName: string) =>
    invokeTauri<string>('set_audio_device', { deviceName });
export const restartAudioEngine = (deviceName: string) =>
    invokeTauri<string>('restart_audio_engine', { deviceName });
export const openPluginWindow = (pluginId: string) =>
    invokeTauri<void>('open_plugin_window', { pluginId });
export const openPluginWindowForSlot = (trackId: string, slotId: string) =>
    invokeTauri<void>('open_plugin_window_for_slot', { trackId, slotId });
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
    invokeTauri<PluginEditorCapability>('can_open_plugin_editor', { pluginId });
export const canOpenPluginEditorForSlot = (trackId: string, slotId: string) =>
    invokeTauri<PluginEditorCapability>('can_open_plugin_editor_for_slot', { trackId, slotId });
export const getPluginSlotRuntimeStatus = (trackId: string, slotId: string) =>
    invokeTauri<PluginSlotRuntimeStatus>('get_plugin_slot_runtime_status_cmd', { trackId, slotId });
export const ensurePluginSlotActive = (trackId: string, slotId: string) =>
    invokeTauri<void>('ensure_plugin_slot_active_cmd', { trackId, slotId });
export const unloadPluginSlot = (trackId: string, slotId: string) =>
    invokeTauri<void>('unload_plugin_slot_cmd', { trackId, slotId });
export const replaceMissingPluginSlot = (
    trackId: string,
    slotId: string,
    replacementPluginId: string,
    replacementPluginName?: string,
) =>
    invokeTauri<void>('replace_missing_plugin_slot_cmd', {
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
    invokeTauri<DeltaMutationResponse>('replace_missing_plugin_slot_with_deltas_cmd', {
        payload: {
            trackId,
            slotId,
            replacementPluginId,
            replacementPluginName: replacementPluginName ?? null,
        },
    });
export const autoResolveMissingPluginsWithDeltas = () =>
    invokeTauri<DeltaMutationResponse>('auto_resolve_missing_plugins_with_deltas_cmd');

export interface AutoResolveMissingPluginsReport {
    deltas: ProjectDelta[];
    missing_before: number;
    missing_after: number;
    resolved_internal: number;
    resolved_external: number;
    unresolved_labels: string[];
}

export const autoResolveMissingPluginsReportWithDeltas = () =>
    invokeTauri<AutoResolveMissingPluginsReport>('auto_resolve_missing_plugins_report_with_deltas_cmd');
export const closePluginWindow = (pluginId: string) =>
    invokeTauri<void>('close_plugin_window_cmd', { pluginId });
export const closePluginWindowForSlot = (trackId: string, slotId: string) =>
    invokeTauri<void>('close_plugin_window_for_slot', { trackId, slotId });
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
    invokeTauri<PluginSandboxSnapshot>('get_plugin_sandbox_runtime');
export const setPluginSandboxEnabled = (enabled: boolean) =>
    invokeTauri<PluginSandboxSnapshot>('set_plugin_sandbox_enabled', { enabled });
export const tickPluginSandboxWatchdog = () =>
    invokeTauri<PluginSandboxSnapshot>('tick_plugin_sandbox_watchdog');
export const reloadPluginSandboxInstance = (instanceId: string) =>
    invokeTauri<PluginSandboxSnapshot>('reload_plugin_sandbox_instance', { instanceId });
export const reloadUnhealthyPluginSandboxes = () =>
    invokeTauri<ReloadSandboxInstancesResponse>('reload_unhealthy_plugin_sandboxes');
export const logFrontendError = (module: string, error: string, stack?: string) =>
    invokeTauri<void>('log_frontend_error', { module, error, stack: stack ?? null });
export interface RoutingTarget {
    trackId: string;
    trackName: string;
    trackType: string;
}
export const getRoutingTargets = (trackId: string) =>
    invokeTauri<RoutingTarget[]>('get_routing_targets', { trackId });
export const setTrackRouting = (trackId: string, targetId: string) =>
    invokeTauri<void>('set_track_routing_cmd', { trackId, targetId });
export const setTrackRoutingWithDeltas = (trackId: string, targetId: string) =>
    invokeTauri<DeltaMutationResponse>('set_track_routing_with_deltas_cmd', { trackId, targetId });
export const setTrackInput = (trackId: string, inputId: string) =>
    invokeTauri<void>('set_track_input_cmd', { trackId, inputId });
export const setTrackInputWithDeltas = (trackId: string, inputId: string) =>
    invokeTauri<DeltaMutationResponse>('set_track_input_with_deltas_cmd', { trackId, inputId });
export const setPluginSidechainSource = (
    trackId: string,
    slotId: string,
    sourceTrackId: string,
) =>
    invokeTauri<void>('set_plugin_sidechain_source_cmd', { trackId, slotId, sourceTrackId });
export const setPluginSidechainSourceWithDeltas = (
    trackId: string,
    slotId: string,
    sourceTrackId: string,
) =>
    invokeTauri<DeltaMutationResponse>('set_plugin_sidechain_source_with_deltas_cmd', {
        trackId,
        slotId,
        sourceTrackId,
    });
export const addPluginToTrack = (
    trackId: string,
    pluginId: string,
    pluginName: string,
    slot: 'instrument' | 'effect' | 'auto' = 'auto',
    insertIndex?: number,
) =>
    invokeTauri<void>('add_plugin_to_track_cmd', {
        payload: { trackId, pluginId, pluginName, slot, insertIndex: insertIndex ?? null },
    });
export const addPluginToTrackWithDeltas = (
    trackId: string,
    pluginId: string,
    pluginName: string,
    slot: 'instrument' | 'effect' | 'auto' = 'auto',
    insertIndex?: number,
) =>
    invokeTauri<DeltaMutationResponse>('add_plugin_to_track_with_deltas_cmd', {
        payload: { trackId, pluginId, pluginName, slot, insertIndex: insertIndex ?? null },
    });
export const removePluginFromTrack = (trackId: string, slotId: string) =>
    invokeTauri<void>('remove_plugin_from_track_cmd', {
        payload: { trackId, slotId },
    });
export const removePluginFromTrackWithDeltas = (trackId: string, slotId: string) =>
    invokeTauri<DeltaMutationResponse>('remove_plugin_from_track_with_deltas_cmd', {
        payload: { trackId, slotId },
    });
export const copyDeviceFromTrack = (trackId: string, deviceId: string) =>
    invokeTauri<string>('copy_device_from_track_cmd', { trackId, deviceId });
export const pasteDeviceToTrack = (
    trackId: string,
    slotHint: 'instrument' | 'effect' | 'auto' = 'auto',
) =>
    invokeTauri<void>('paste_device_to_track_cmd', { trackId, slotHint });
export const pasteDeviceToTrackWithDeltas = (
    trackId: string,
    slotHint: 'instrument' | 'effect' | 'auto' = 'auto',
) =>
    invokeTauri<DeltaMutationResponse>('paste_device_to_track_with_deltas_cmd', { trackId, slotHint });
export const setInternalPluginParam = (
    trackId: string,
    slotId: string,
    paramId: string,
    value: number,
    options?: { pushUndoStep?: boolean },
) =>
    invokeTauri<void>('set_internal_plugin_param_cmd', {
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
    invokeTauri<DeltaMutationResponse>('set_internal_plugin_param_with_deltas_cmd', {
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
    invokeTauri<void>('set_external_plugin_param_cmd', {
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
    invokeTauri<void>('set_external_plugin_param_for_slot_cmd', {
        trackId,
        slotId,
        paramIndex,
        value,
        pushUndoStep: options?.pushUndoStep,
    });
export const setExternalPluginParamForSlotRuntime = (
    slotId: string,
    pluginId: string,
    paramIndex: number,
    value: number,
) =>
    invokeTauri<void>('set_external_plugin_param_for_slot_runtime_cmd', {
        slotId,
        pluginId,
        paramIndex,
        value,
    });
export const setExternalPluginParamForSlotWithDeltas = (
    trackId: string,
    slotId: string,
    paramIndex: number,
    value: number,
    options?: { pushUndoStep?: boolean },
) =>
    invokeTauri<DeltaMutationResponse>('set_external_plugin_param_for_slot_with_deltas_cmd', {
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
    defaultValue?: number;
    value: number;
}
export const getExternalPluginParams = (pluginId: string) =>
    invokeTauri<ExternalPluginParamInfo[]>('get_external_plugin_params', { pluginId });
export const getExternalPluginParamsForSlot = (trackId: string, slotId: string) =>
    invokeTauri<ExternalPluginParamInfo[]>('get_external_plugin_params_for_slot', { trackId, slotId });
export const setSamplerSample = (
    trackId: string,
    samplePath: string,
    rootNote?: number,
) =>
    invokeTauri<void>('set_sampler_sample_cmd', {
        payload: { trackId, samplePath, rootNote: rootNote ?? null },
    });
export const setSamplerSampleWithDeltas = (
    trackId: string,
    samplePath: string,
    rootNote?: number,
) =>
    invokeTauri<DeltaMutationResponse>('set_sampler_sample_with_deltas_cmd', {
        payload: { trackId, samplePath, rootNote: rootNote ?? null },
    });
export const setSampleRackPadSample = (
    trackId: string,
    padIndex: number,
    samplePath: string,
) =>
    invokeTauri<void>('set_sample_rack_pad_sample_cmd', {
        trackId, padIndex, samplePath
    });
export const setSampleRackPadSampleWithDeltas = (
    trackId: string,
    padIndex: number,
    samplePath: string,
) =>
    invokeTauri<DeltaMutationResponse>('set_sample_rack_pad_sample_with_deltas_cmd', {
        trackId, padIndex, samplePath
    });
export const setSampleRackPadVolumeCmd = (trackId: string, padIndex: number, volume: number) =>
    invokeTauri<void>('set_sample_rack_pad_volume_cmd', { trackId, padIndex, volume });
export const setSampleRackPadVolumeWithDeltasCmd = (trackId: string, padIndex: number, volume: number) =>
    invokeTauri<DeltaMutationResponse>('set_sample_rack_pad_volume_with_deltas_cmd', { trackId, padIndex, volume });
export const setSampleRackPadMuteCmd = (trackId: string, padIndex: number, muted: boolean) =>
    invokeTauri<void>('set_sample_rack_pad_mute_cmd', { trackId, padIndex, muted });
export const setSampleRackPadMuteWithDeltasCmd = (trackId: string, padIndex: number, muted: boolean) =>
    invokeTauri<DeltaMutationResponse>('set_sample_rack_pad_mute_with_deltas_cmd', { trackId, padIndex, muted });
export const setSampleRackPadSoloCmd = (trackId: string, padIndex: number, soloed: boolean) =>
    invokeTauri<void>('set_sample_rack_pad_solo_cmd', { trackId, padIndex, soloed });
export const setSampleRackPadSoloWithDeltasCmd = (trackId: string, padIndex: number, soloed: boolean) =>
    invokeTauri<DeltaMutationResponse>('set_sample_rack_pad_solo_with_deltas_cmd', { trackId, padIndex, soloed });
export const setSampleRackPadAdsrCmd = (trackId: string, padIndex: number, attack: number, decay: number, sustain: number, release: number) =>
    invokeTauri<void>('set_sample_rack_pad_adsr_cmd', { trackId, padIndex, attack, decay, sustain, release });
export const setSampleRackPadAdsrWithDeltasCmd = (trackId: string, padIndex: number, attack: number, decay: number, sustain: number, release: number) =>
    invokeTauri<DeltaMutationResponse>('set_sample_rack_pad_adsr_with_deltas_cmd', { trackId, padIndex, attack, decay, sustain, release });
export const setSampleRackPadFilterCutoffCmd = (trackId: string, padIndex: number, cutoff: number) =>
    invokeTauri<void>('set_sample_rack_pad_filter_cutoff_cmd', { trackId, padIndex, cutoff });
export const setSampleRackPadFilterCutoffWithDeltasCmd = (trackId: string, padIndex: number, cutoff: number) =>
    invokeTauri<DeltaMutationResponse>('set_sample_rack_pad_filter_cutoff_with_deltas_cmd', { trackId, padIndex, cutoff });
// BUG-027 FIX: Validate fade frame values — no negative or NaN.
export const setClipFades = (clipId: string, fadeInFrames: number, fadeOutFrames: number) => {
    const fi = Number.isFinite(fadeInFrames) ? Math.max(0, Math.round(fadeInFrames)) : 0;
    const fo = Number.isFinite(fadeOutFrames) ? Math.max(0, Math.round(fadeOutFrames)) : 0;
    return invokeTauri<void>('set_clip_fades_cmd', { clipId, fadeInFrames: fi, fadeOutFrames: fo });
};
export const setClipFadesWithDeltas = (clipId: string, fadeInFrames: number, fadeOutFrames: number) => {
    const fi = Number.isFinite(fadeInFrames) ? Math.max(0, Math.round(fadeInFrames)) : 0;
    const fo = Number.isFinite(fadeOutFrames) ? Math.max(0, Math.round(fadeOutFrames)) : 0;
    return invokeTauri<DeltaMutationResponse>('set_clip_fades_with_deltas_cmd', { clipId, fadeInFrames: fi, fadeOutFrames: fo });
};
export const setClipSourceOffset = (clipId: string, sourceOffsetFrames: number) =>
    invokeTauri<void>('set_clip_source_offset_cmd', { clipId, sourceOffsetFrames });
export const setClipSourceOffsetWithDeltas = (clipId: string, sourceOffsetFrames: number) =>
    invokeTauri<DeltaMutationResponse>('set_clip_source_offset_with_deltas_cmd', { clipId, sourceOffsetFrames });
export interface SetClipWarpPayload {
    clipId: string;
    isWarped?: boolean;
    warpMode?: number | null;
    warpBaseBpm?: number | null;
}
export const setClipWarp = (payload: SetClipWarpPayload) =>
    invokeTauri<void>('set_clip_warp_cmd', { payload });
export const setClipWarpWithDeltas = (payload: SetClipWarpPayload) =>
    invokeTauri<DeltaMutationResponse>('set_clip_warp_with_deltas_cmd', { payload });
export const setClipPitch = (payload: {
    clipId: string;
    pitchShiftSemitones: number;
}) =>
    invokeTauri<void>('set_clip_pitch_cmd', { payload });
export const setClipPitchWithDeltas = (payload: {
    clipId: string;
    pitchShiftSemitones: number;
}) =>
    invokeTauri<DeltaMutationResponse>('set_clip_pitch_with_deltas_cmd', { payload });
export interface ExportSettings {
    outputPath: string;
    sampleRate: number;
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
    invokeTauri<string>('export_mix_cmd', { settings });
export const cancelExport = () =>
    invokeTauri<void>('cancel_export_cmd');
export const listBackgroundJobs = () =>
    invokeTauri<BackgroundJobSnapshot[]>('list_background_jobs_cmd');
export const cancelBackgroundJob = (jobId: string) =>
    invokeTauri<void>('cancel_background_job_cmd', { jobId });
export const clearFinishedBackgroundJobs = () =>
    invokeTauri<number>('clear_finished_background_jobs_cmd');
export interface BounceSelectionToTrackPayload {
    clipIds?: string[];
    rangeStartFrames?: number;
    rangeEndFrames?: number;
    startTrackIndex?: number;
    endTrackIndex?: number;
}
export const bounceSelectionToTrack = (payload: BounceSelectionToTrackPayload) =>
    invokeTauri<void>('bounce_selection_to_track_cmd', { payload });
export const bounceSelectionToTrackWithDeltas = (payload: BounceSelectionToTrackPayload) =>
    invokeTauri<DeltaMutationResponse>('bounce_selection_to_track_with_deltas_cmd', { payload });
export const bounceTrack = (trackId: string) =>
    invokeTauri<void>('bounce_track_cmd', { trackId });
export const bounceTrackWithDeltas = (trackId: string) =>
    invokeTauri<DeltaMutationResponse>('bounce_track_with_deltas_cmd', { trackId });
export const bounceGroup = (groupTrackId: string) =>
    invokeTauri<void>('bounce_group_cmd', { groupTrackId });
export const bounceGroupWithDeltas = (groupTrackId: string) =>
    invokeTauri<DeltaMutationResponse>('bounce_group_with_deltas_cmd', { groupTrackId });
export const consolidateSelection = (payload: BounceSelectionToTrackPayload) =>
    invokeTauri<void>('consolidate_selection_cmd', { payload });
export const consolidateSelectionWithDeltas = (payload: BounceSelectionToTrackPayload) =>
    invokeTauri<DeltaMutationResponse>('consolidate_selection_with_deltas_cmd', { payload });
export const splitTrackToStems = (trackId: string) =>
    invokeTauri<void>('split_track_to_stems_cmd', {
        payload: { trackId },
    });
export const splitTrackToStemsWithDeltas = (trackId: string) =>
    invokeTauri<DeltaMutationResponse>('split_track_to_stems_with_deltas_cmd', {
        payload: { trackId },
    });
export const undo = () => invokeTauri<void>('undo_cmd');
export const undoWithDeltas = () =>
    invokeTauri<DeltaMutationResponse>('undo_with_deltas_cmd');
export const redo = () => invokeTauri<void>('redo_cmd');
export const redoWithDeltas = () =>
    invokeTauri<DeltaMutationResponse>('redo_with_deltas_cmd');
export const armTrack = (trackIndex: number, armed: boolean) =>
    invokeTauri<void>('arm_track_cmd', { trackIndex, armed });
export const armTrackWithDeltas = (trackIndex: number, armed: boolean) =>
    invokeTauri<DeltaMutationResponse>('arm_track_with_deltas_cmd', { trackIndex, armed });
export const startRecording = () =>
    invokeTauri<void>('start_recording_cmd');
export const stopRecording = () =>
    invokeTauri<void>('stop_recording_cmd');
export const resolveMissingFile = (clipId: string, newPath: string) =>
    invokeTauri<void>('resolve_missing_file_cmd', { clipId, newPath });
export const resolveMissingFileWithDeltas = (clipId: string, newPath: string) =>
    invokeTauri<DeltaMutationResponse>('resolve_missing_file_with_deltas_cmd', { clipId, newPath });
export interface AutomationPoint {
    beat: number;
    value: number;
    curveType: 'linear' | 'bezier' | 'step';
    tension?: number;
}
export const setAutomationPoints = (trackId: string, paramId: string, points: AutomationPoint[]) =>
    invokeTauri<void>('set_automation_points_cmd', { trackId, paramId, points });
export const setAutomationPointsWithDeltas = (trackId: string, paramId: string, points: AutomationPoint[]) =>
    invokeTauri<DeltaMutationResponse>('set_automation_points_with_deltas_cmd', { trackId, paramId, points });
export const createRackFromDevices = (
    trackId: string,
    deviceIds: string[],
    rackName?: string,
    rackType?: 'audio_effect' | 'instrument' | 'drum' | 'midi_effect',
) =>
    invokeTauri<string>('create_rack_from_devices_cmd', {
        payload: { trackId, deviceIds, rackName: rackName ?? null, rackType: rackType ?? null },
    });
export const addChainToRack = (
    trackId: string,
    rackId: string,
    chainName?: string,
) =>
    invokeTauri<string>('add_chain_to_rack_cmd', {
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
    invokeTauri<string>('add_device_to_rack_chain_cmd', {
        payload: { trackId, rackId, chainId, pluginId, pluginName, insertIndex: insertIndex ?? null },
    });
export const removeDeviceFromRack = (
    trackId: string,
    rackId: string,
    deviceId: string,
    autoDissolve = false,
) =>
    invokeTauri<void>('remove_device_from_rack_cmd', {
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
    invokeTauri<string>('save_device_preset_cmd', {
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
    invokeTauri<string>('load_device_preset_cmd', {
        payload: { trackId, presetPath, insertIndex: insertIndex ?? null },
    });
export const setFlowEnabled = (trackIndex: number, enabled: boolean) =>
    invokeTauri<void>('set_flow_enabled_cmd', { trackIndex, enabled });

export const syncFlowGraph = (
    trackIndex: number,
    nodes: [number, string, [string, string][]][],
    connections: [number, number, number, number][],
) =>
    invokeTauri<void>('sync_flow_graph_cmd', { trackIndex, nodes, connections });
