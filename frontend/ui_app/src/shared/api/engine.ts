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
import { clampMidiPitch, clampMidiVelocity, clamp01, MIN_MIDI_NOTE_DURATION_FRAMES, MIN_BPM, MAX_BPM } from '@/shared/lib/audioMath';
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

/**
 * Enterprise IPC wrapper: wraps `invoke()` with centralized error logging.
 * On failure, logs the error to the Rust backend and re-throws so callers
 * that DO have `.catch()` still receive the error. Unhandled failures are
 * caught by the global promise rejection handler and logged.
 */
function safeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const promise = args ? invoke<T>(command, args) : invoke<T>(command);
    return promise.catch((err) => {
        // Log to backend — fire-and-forget (don't await, don't recurse)
        const msg = err instanceof Error ? err.message : String(err);
        invoke<void>('log_frontend_error', {
            module: 'ipc',
            error: `${command}: ${msg}`,
            stack: err instanceof Error ? err.stack ?? null : null,
        }).catch(() => { /* avoid infinite recursion */ });
        throw err; // re-throw for callers that handle errors
    });
}

export const play = () => safeInvoke<void>('play');
/** ENTERPRISE FIX: Atomic seek-and-play — eliminates the 1-buffer stutter
 *  caused by separate togglePlayback() + seekToBeat() IPC calls. */
export const playFromBeat = (beat: number) =>
    safeInvoke<void>('play_from_beat', { beat });
export const stop = () => safeInvoke<void>('stop');
export const togglePlayback = () => safeInvoke<boolean>('toggle_playback');
export const seek = (positionFrames: number) =>
    safeInvoke<void>('seek', { positionFrames });
export const seekSeconds = (seconds: number) =>
    safeInvoke<void>('seek_seconds', { seconds });
export const seekToBeat = (beat: number) =>
    safeInvoke<void>('seek_to_beat', { beat });
// BUG-025 FIX: Clamp BPM at API boundary — prevents NaN/Infinity/0/negative from reaching backend.
export const setBpm = (bpm: number) => {
    const safe = Number.isFinite(bpm) ? Math.max(MIN_BPM, Math.min(MAX_BPM, bpm)) : MIN_BPM;
    return safeInvoke<void>('set_bpm', { bpm: safe });
};
export const setBpmWithDeltas = (bpm: number) => {
    const safe = Number.isFinite(bpm) ? Math.max(MIN_BPM, Math.min(MAX_BPM, bpm)) : MIN_BPM;
    return safeInvoke<DeltaMutationResponse>('set_bpm_with_deltas', { bpm: safe });
};
export const setTimeSignature = (numerator: number, denominator: number) =>
    safeInvoke<void>('set_time_signature', { numerator, denominator });
export const setTimeSignatureWithDeltas = (numerator: number, denominator: number) =>
    safeInvoke<DeltaMutationResponse>('set_time_signature_with_deltas', { numerator, denominator });
// BUG-026 FIX: Validate loop frame values at API boundary.
export const setLoop = (enabled: boolean, startFrames: number, endFrames: number) => {
    const s = Number.isFinite(startFrames) ? Math.max(0, Math.round(startFrames)) : 0;
    const e = Number.isFinite(endFrames) ? Math.max(s + 1, Math.round(endFrames)) : s + 1;
    return safeInvoke<void>('set_loop', { enabled, startFrames: s, endFrames: e });
};
export const setLoopWithDeltas = (enabled: boolean, startFrames: number, endFrames: number) => {
    const s = Number.isFinite(startFrames) ? Math.max(0, Math.round(startFrames)) : 0;
    const e = Number.isFinite(endFrames) ? Math.max(s + 1, Math.round(endFrames)) : s + 1;
    return safeInvoke<DeltaMutationResponse>('set_loop_with_deltas', { enabled, startFrames: s, endFrames: e });
};
export const setTrackVolume = (trackIndex: number, volume: number) =>
    safeInvoke<void>('set_track_volume', { trackIndex, volume });
export const setTrackVolumeWithDeltas = (trackIndex: number, volume: number) =>
    safeInvoke<DeltaMutationResponse>('set_track_volume_with_deltas', { trackIndex, volume });
export const setTrackPan = (trackIndex: number, pan: number) =>
    safeInvoke<void>('set_track_pan', { trackIndex, pan });
export const setTrackPanWithDeltas = (trackIndex: number, pan: number) =>
    safeInvoke<DeltaMutationResponse>('set_track_pan_with_deltas', { trackIndex, pan });
export const setMasterVolume = (volume: number) =>
    safeInvoke<void>('set_master_volume', { volume });
export const setTrackDisabled = (trackIndex: number, disabled: boolean) =>
    safeInvoke<void>('set_track_disabled', { trackIndex, disabled });
export const setTrackDisabledWithDeltas = (trackIndex: number, disabled: boolean) =>
    safeInvoke<DeltaMutationResponse>('set_track_disabled_with_deltas', { trackIndex, disabled });
export const setTrackSolo = (trackIndex: number, soloed: boolean) =>
    safeInvoke<void>('set_track_solo', { trackIndex, soloed });
export const setTrackSoloWithDeltas = (trackIndex: number, soloed: boolean) =>
    safeInvoke<DeltaMutationResponse>('set_track_solo_with_deltas', { trackIndex, soloed });
export const setTrackSendLevel = (trackIndex: number, send: 'A' | 'B', value: number) =>
    safeInvoke<void>('set_track_send_level', { trackIndex, send, value });
export const setTrackSendLevelWithDeltas = (trackIndex: number, send: 'A' | 'B', value: number) =>
    safeInvoke<DeltaMutationResponse>('set_track_send_level_with_deltas', { trackIndex, send, value });
export const previewSamplerNoteOn = (trackIndex: number, pitch: number, velocity: number = 100) =>
    safeInvoke<void>('preview_sampler_note_on_cmd', {
        trackIndex: Math.max(0, Math.round(trackIndex)),
        pitch: clampMidiPitch(pitch),
        velocity: clampMidiVelocity(velocity),
    });
export const previewSamplerNoteOff = (trackIndex: number, pitch: number) =>
    safeInvoke<void>('preview_sampler_note_off_cmd', {
        trackIndex: Math.max(0, Math.round(trackIndex)),
        pitch: clampMidiPitch(pitch),
    });
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
};
export const addDevice = (trackIndex: number, slotIndex: number, effectType: BuiltinEffectType) =>
    safeInvoke<void>('add_device_cmd', { trackIndex, slotIndex, effectType });
export const removeDevice = (trackIndex: number, slotIndex: number) =>
    safeInvoke<void>('remove_device_cmd', { trackIndex, slotIndex });
export const bypassDevice = (trackIndex: number, slotIndex: number, bypassed: boolean) =>
    safeInvoke<void>('bypass_device_cmd', { trackIndex, slotIndex, bypassed });
export const setSlotBypass = (trackId: string, slotId: string, bypassed: boolean) =>
    safeInvoke<void>('set_slot_bypass_cmd', { trackId, slotId, bypassed });
export const setSlotBypassWithDeltas = (trackId: string, slotId: string, bypassed: boolean) =>
    safeInvoke<DeltaMutationResponse>('set_slot_bypass_with_deltas_cmd', { trackId, slotId, bypassed });
export const moveEffectSlot = (trackId: string, slotId: string, targetIndex: number) =>
    safeInvoke<void>('move_effect_slot_cmd', { trackId, slotId, targetIndex });
export const moveEffectSlotWithDeltas = (trackId: string, slotId: string, targetIndex: number) =>
    safeInvoke<DeltaMutationResponse>('move_effect_slot_with_deltas_cmd', { trackId, slotId, targetIndex });
export const setDeviceParam = (trackIndex: number, slotIndex: number, paramIndex: number, value: number) =>
    safeInvoke<void>('set_device_param_cmd', { trackIndex, slotIndex, paramIndex, value });
export const setDeviceParamRuntime = (trackIndex: number, slotIndex: number, paramIndex: number, value: number) =>
    safeInvoke<void>('set_device_param_runtime_cmd', { trackIndex, slotIndex, paramIndex, value });
export type RuntimeDeviceParamUpdate = {
    paramIndex: number;
    value: number;
};
export const setDeviceParamsRuntime = (
    trackIndex: number,
    slotIndex: number,
    updates: RuntimeDeviceParamUpdate[],
) => safeInvoke<void>('set_device_params_runtime_cmd', { trackIndex, slotIndex, updates });
export const updateTrack = (update: TrackStateUpdate) =>
    safeInvoke<void>('update_track', { update });
export const addTrack = (name?: string, inheritFromTrackId?: string | null) =>
    safeInvoke<void>('add_track_cmd', {
        name: name ?? null,
        trackType: 'audio',
        insertAfterIndex: null,
        inheritFromTrackId: inheritFromTrackId ?? null,
    });
export const addTrackWithDeltas = (name?: string, inheritFromTrackId?: string | null) =>
    safeInvoke<DeltaMutationResponse>('add_track_with_deltas_cmd', {
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
    safeInvoke<void>('add_track_cmd', {
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
    safeInvoke<DeltaMutationResponse>('add_track_with_deltas_cmd', {
        name: name ?? null,
        trackType,
        insertAfterIndex: insertAfterIndex ?? null,
        inheritFromTrackId: inheritFromTrackId ?? null,
    });
export const deleteTrack = (trackIndex: number) =>
    safeInvoke<void>('delete_track_cmd', { index: trackIndex });
export const deleteTrackWithDeltas = (trackIndex: number) =>
    safeInvoke<DeltaMutationResponse>('delete_track_with_deltas_cmd', { index: trackIndex });
export const deleteTracks = (trackIds: string[]) =>
    safeInvoke<void>('delete_tracks_cmd', { trackIds });
export const renameTrack = (index: number, name: string) =>
    safeInvoke<void>('rename_track_cmd', { index, name });
export const renameTrackWithDeltas = (index: number, name: string) =>
    safeInvoke<DeltaMutationResponse>('rename_track_with_deltas_cmd', { index, name });
export const setTrackHeight = (trackId: string, height: number) =>
    safeInvoke<void>('set_track_height_cmd', { trackId, height });
export const setTrackHeightWithDeltas = (trackId: string, height: number) =>
    safeInvoke<DeltaMutationResponse>('set_track_height_with_deltas_cmd', { trackId, height });
export const setTrackColor = (trackId: string, colorHex: string) =>
    safeInvoke<void>('set_track_color_cmd', { trackId, colorHex });
export const setTrackColorWithDeltas = (trackId: string, colorHex: string) =>
    safeInvoke<DeltaMutationResponse>('set_track_color_with_deltas_cmd', { trackId, colorHex });
export const createGroup = (trackIds: string[], groupName?: string) =>
    safeInvoke<string>('create_group_cmd', {
        trackIds,
        groupName: groupName ?? null,
    });
export interface CreateGroupWithDeltasResponse {
    group_id: string;
    deltas: ProjectDelta[];
}
export const createGroupWithDeltas = (trackIds: string[], groupName?: string) =>
    safeInvoke<CreateGroupWithDeltasResponse>('create_group_with_deltas_cmd', {
        trackIds,
        groupName: groupName ?? null,
    });
export const setGroupExpanded = (groupId: string, expanded: boolean) =>
    safeInvoke<void>('set_group_expanded_cmd', { groupId, expanded });
export const setGroupExpandedWithDeltas = (groupId: string, expanded: boolean) =>
    safeInvoke<DeltaMutationResponse>('set_group_expanded_with_deltas_cmd', { groupId, expanded });
export const moveTrackToIndex = (trackId: string, targetIndex: number) =>
    safeInvoke<void>('move_track_to_index_cmd', { trackId, targetIndex });
export const moveTrackToIndexWithDeltas = (trackId: string, targetIndex: number) =>
    safeInvoke<DeltaMutationResponse>('move_track_to_index_with_deltas_cmd', { trackId, targetIndex });
export const moveTrackWithParent = (
    trackId: string,
    targetIndex: number,
    targetParentGroupId?: string | null,
) =>
    safeInvoke<void>('move_track_with_parent_cmd', {
        trackId,
        targetIndex,
        targetParentGroupId: targetParentGroupId ?? null,
    });
export const moveTrackWithParentWithDeltas = (
    trackId: string,
    targetIndex: number,
    targetParentGroupId?: string | null,
) =>
    safeInvoke<DeltaMutationResponse>('move_track_with_parent_with_deltas_cmd', {
        trackId,
        targetIndex,
        targetParentGroupId: targetParentGroupId ?? null,
    });
export const setTrackGroup = (trackId: string, groupId?: string | null) =>
    safeInvoke<void>('set_track_group_cmd', {
        trackId,
        groupId: groupId ?? null,
    });
export const setTrackGroupWithDeltas = (trackId: string, groupId?: string | null) =>
    safeInvoke<DeltaMutationResponse>('set_track_group_with_deltas_cmd', {
        trackId,
        groupId: groupId ?? null,
    });
export const ungroupTrack = (groupId: string) =>
    safeInvoke<void>('ungroup_track_cmd', { groupId });
export const ungroupTrackWithDeltas = (groupId: string) =>
    safeInvoke<DeltaMutationResponse>('ungroup_track_with_deltas_cmd', { groupId });
export const moveTrackBlockToIndex = (rootTrackId: string, targetIndex: number) =>
    safeInvoke<void>('move_track_block_to_index_cmd', { rootTrackId, targetIndex });
export const moveTrackBlockToIndexWithDeltas = (rootTrackId: string, targetIndex: number) =>
    safeInvoke<DeltaMutationResponse>('move_track_block_to_index_with_deltas_cmd', {
        rootTrackId,
        targetIndex,
    });
export const duplicateTracks = (trackIds: string[]) =>
    safeInvoke<void>('duplicate_tracks_cmd', { trackIds });
export const duplicateTracksWithDeltas = (trackIds: string[]) =>
    safeInvoke<DeltaMutationResponse>('duplicate_tracks_with_deltas_cmd', { trackIds });
export const getState = () => safeInvoke<EngineState>('get_state');
export const getTransport = () => safeInvoke<TransportState>('get_transport');
export const getMeters = () => safeInvoke<MeteringSnapshot>('get_meters');
type BinaryInvokePayload = ArrayBuffer | Uint8Array | number[];
function toUint8Array(payload: BinaryInvokePayload): Uint8Array {
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    return new Uint8Array(payload);
}
export const getMetersBinary = async (): Promise<Uint8Array> => {
    const raw = await safeInvoke<BinaryInvokePayload>('get_meters_binary');
    const bytes = toUint8Array(raw);
    return bytes;
};
export const getProjectHistory = (options?: { limit?: number; sinceSeq?: number }) =>
    safeInvoke<ProjectHistoryEvent[]>('get_project_history', {
        limit: options?.limit,
        sinceSeq: options?.sinceSeq,
    });
export const getPdcDebugSnapshot = () =>
    safeInvoke<PdcDebugSnapshot>('get_pdc_debug_snapshot');
export const getRtDebugSnapshot = () =>
    safeInvoke<RtDebugSnapshot>('get_rt_debug_snapshot');
export const setRtDebugEnabled = (enabled: boolean) =>
    safeInvoke<void>('set_rt_debug_enabled', { enabled });
export const setFrequency = (freq: number) =>
    safeInvoke<void>('set_frequency', { freq });
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
    safeInvoke<ImportAudioResponse>('import_audio_file', {
        path,
        trackIndex,
        positionFrames: positionFrames ?? null,
    });
export const importAudioFileWithDeltas = (path: string, trackIndex: number, positionFrames?: number) =>
    safeInvoke<ImportAudioWithDeltasResponse>('import_audio_file_with_deltas', {
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
    safeInvoke<CreateMidiClipResponse>('create_midi_clip_cmd', {
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
    safeInvoke<CreateMidiClipWithDeltasResponse>('create_midi_clip_with_deltas_cmd', {
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
    safeInvoke<void>('update_midi_clip_cmd', {
        clipId,
        push_undo_step: options?.pushUndoStep ?? true,
        notes: notes.map((n) => ({
            pitch: clampMidiPitch(n.pitch),
            velocity: clampMidiVelocity(n.velocity),
            start_frames: Math.max(0, Math.round(n.startFrames)),
            // BUG-001 FIX: SSOT — both updateMidiClip and updateMidiClipWithDeltas
            // use the same MIN_MIDI_NOTE_DURATION_FRAMES constant.
            duration_frames: Math.max(MIN_MIDI_NOTE_DURATION_FRAMES, Math.round(n.durationFrames)),
        })),
    });
export const updateMidiClipWithDeltas = (
    clipId: string,
    notes: MidiClipNoteUpdate[],
    options?: { pushUndoStep?: boolean },
) =>
    safeInvoke<DeltaMutationResponse>('update_midi_clip_with_deltas_cmd', {
        clipId,
        push_undo_step: options?.pushUndoStep ?? true,
        notes: notes.map((n) => ({
            pitch: clampMidiPitch(n.pitch),
            velocity: clampMidiVelocity(n.velocity),
            start_frames: Math.max(0, Math.round(n.startFrames)),
            // SSOT FIX: Must match updateMidiClip's minimum (480 frames ≈ 10ms).
            // Previously used Math.max(1, ...) — 1-frame notes are inaudible clicks.
            duration_frames: Math.max(MIN_MIDI_NOTE_DURATION_FRAMES, Math.round(n.durationFrames)),
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
    safeInvoke<void>('set_midi_clip_envelopes_cmd', {
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
    safeInvoke<{ notes: MidiVariationNote[] }>('generate_midi_variation_cmd', { request: input })
        .then((res) => res.notes);
export const getMidiInputs = () =>
    safeInvoke<MidiInputPort[]>('get_midi_inputs');
export const connectMidiInput = (portName: string) =>
    safeInvoke<void>('connect_midi_input', { portName });
export const generateDemoSamples = () =>
    safeInvoke<number>('generate_demo_samples_cmd');
export const previewAudioFile = (path: string) =>
    safeInvoke<void>('preview_audio_file_cmd', { path });
export const stopPreview = () =>
    safeInvoke<void>('stop_preview_cmd');
export const getAudioFileDuration = (path: string) =>
    safeInvoke<number>('get_audio_file_duration', { path });
export const closeSplashscreen = () => safeInvoke<void>('close_splashscreen');
export const getActiveProjectId = () => safeInvoke<string>('get_active_project_id');
export const newProject = () => safeInvoke<DeltaMutationResponse>('new_project');
export const saveProject = () => safeInvoke<string>('save_project');
export const saveProjectAs = (path: string) =>
    safeInvoke<string>('save_project_as', { path });
export const openProject = (path: string) =>
    safeInvoke<DeltaMutationResponse>('open_project', { path });
export const importAbletonProject = (path: string) =>
    safeInvoke<DeltaMutationResponse>('import_ableton_project', { path });
export const eagerActivateExternalPlugins = () =>
    safeInvoke<{ total: number; loaded: number; failed: number; skipped: number }>(
        'eager_activate_external_plugins',
    );
export const getRecentProjects = () =>
    safeInvoke<RecentProject[]>('get_recent_projects');
export const getProjectStatus = () => safeInvoke<ProjectStatus>('get_project_status');

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
    safeInvoke<CreateProjectTabResponse>('create_project_tab');
export const switchProjectTab = (id: string) =>
    safeInvoke<DeltaMutationResponse>('switch_project_tab', { id });
export const closeProjectTab = (id: string) =>
    safeInvoke<CloseProjectTabResponse>('close_project_tab', { id });
export const listOpenProjects = () =>
    safeInvoke<ProjectTabInfo[]>('list_open_projects');

// ── Cross-Project Global Clipboard ──
export const copyClipsToGlobalClipboard = (clipIds: string[]) =>
    safeInvoke<number>('copy_clips_to_global_clipboard', { clipIds });
export const pasteClipsFromGlobalClipboard = (trackIndex: number, positionFrames: number) =>
    safeInvoke<DeltaMutationResponse>('paste_clips_from_global_clipboard', { trackIndex, positionFrames });
export const copyTrackToGlobalClipboard = (trackIndex: number) =>
    safeInvoke<string>('copy_track_to_global_clipboard', { trackIndex });
export const pasteTrackFromGlobalClipboard = (insertIndex?: number) =>
    safeInvoke<DeltaMutationResponse>('paste_track_from_global_clipboard', { insertIndex: insertIndex ?? null });
export interface ArrangementViewportState {
    pixels_per_beat: number | null;
    scroll_left: number | null;
    scroll_top?: number | null;
}
export const setArrangementViewport = (pixelsPerBeat: number, scrollLeft: number, scrollTop?: number) =>
    safeInvoke<void>('set_arrangement_viewport_cmd', {
        pixelsPerBeat,
        scrollLeft,
        scrollTop,
    });
export const getArrangementViewport = () =>
    safeInvoke<ArrangementViewportState>('get_arrangement_viewport_cmd');
export const createBackup = () => safeInvoke<string>('create_backup_cmd');
export interface AutoSaveResult {
    saved: boolean;
    reason?: string;
    path?: string;
}
export const autoSaveIfDirty = () => safeInvoke<AutoSaveResult>('auto_save_if_dirty');
export const markDirty = () => safeInvoke<void>('mark_dirty_cmd');
export const syncTitle = () => safeInvoke<void>('sync_title_cmd');
export const getProjectNotes = () => safeInvoke<string>('get_project_notes');
export const setProjectNotes = (text: string) => safeInvoke<void>('set_project_notes', { text });
export const setArrangementGrid = (
    numerator: number,
    denominator: number,
    ntoles: number,
    snapToGrid: boolean,
    fixed: boolean,
) =>
    safeInvoke<void>('set_arrangement_grid_cmd', {
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
    safeInvoke<DeltaMutationResponse>('set_arrangement_grid_with_deltas_cmd', {
        numerator,
        denominator,
        ntoles,
        snapToGrid,
        fixed,
    });
export const setKeySignature = (enabled: boolean, tonic: string, mode: string) =>
    safeInvoke<void>('set_key_signature_cmd', { enabled, tonic, mode });
export const setKeySignatureWithDeltas = (enabled: boolean, tonic: string, mode: string) =>
    safeInvoke<DeltaMutationResponse>('set_key_signature_with_deltas_cmd', { enabled, tonic, mode });
export const getSettings = () => safeInvoke<AppSettings>('get_settings');
export const updateSettings = (newSettings: AppSettings) =>
    safeInvoke<void>('update_settings', { newSettings });
export interface AudioFileEntry {
    name: string;
    path: string;
    size_bytes: number;
    modified_at: string;
    format: string;
    duration_seconds?: number | null;
}
export const scanAudioFolder = (path: string) =>
    safeInvoke<AudioFileEntry[]>('scan_audio_folder', { path });
export const scanAllAudioSources = () =>
    safeInvoke<AudioFileEntry[]>('scan_all_audio_sources');
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
    safeInvoke<BrowserFileEntry[]>('scan_folder_all', { path });
export const scanPluginFolders = () =>
    safeInvoke<BrowserFileEntry[]>('scan_plugin_folders');
export const getBrowserFolders = () =>
    safeInvoke<string[]>('get_browser_folders');
export const addBrowserFolder = () =>
    safeInvoke<string[]>('add_browser_folder');
export const removeBrowserFolder = (path: string) =>
    safeInvoke<string[]>('remove_browser_folder', { path });
export const getSamplesPath = () =>
    safeInvoke<string>('get_samples_path');
export const pickFolder = () =>
    safeInvoke<string | null>('pick_folder');
export const pickProjectFile = () =>
    safeInvoke<string | null>('pick_project_file');
export const saveProjectDialog = () =>
    safeInvoke<string | null>('save_project_dialog');
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
    safeInvoke<WaveformPeaks>('get_waveform_peaks', { filePath });
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
    const raw = await safeInvoke<WaveformPeaksBinaryResponse>(
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
    const raw = await safeInvoke<BinaryInvokePayload>('get_waveform_peaks_lod_binary', {
        filePath,
        lodLevel,
    });
    return toUint8Array(raw);
}
export async function getPeaksByClipId(clipId: string, lodLevel: number): Promise<Uint8Array> {
    const raw = await safeInvoke<BinaryInvokePayload>('get_peaks_by_clip_id', {
        clipId,
        lodLevel,
    });
    return toUint8Array(raw);
}
export async function getPeaks(clipId: string, lodLevel: number): Promise<Uint8Array> {
    const raw = await safeInvoke<BinaryInvokePayload>('get_peaks_binary', { clipId, lodLevel });
    return toUint8Array(raw);
}
export const moveClip = (clipId: string, newTrackIndex: number, newPositionFrames: number) =>
    safeInvoke<void>('move_clip_cmd', { clipId, newTrackIndex, newPositionFrames });
export const moveClipWithDeltas = (clipId: string, newTrackIndex: number, newPositionFrames: number) =>
    safeInvoke<DeltaMutationResponse>('move_clip_with_deltas_cmd', { clipId, newTrackIndex, newPositionFrames });

export const moveMultipleClipsWithDeltas = (
    requests: Array<{ id: string; newTrackIndex: number; newPositionFrames: number }>
) => safeInvoke<DeltaMutationResponse>('move_multiple_clips_with_deltas_cmd', { requests });
export const resizeClip = (clipId: string, newPositionFrames: number, newDurationFrames: number, allowStretch: boolean = false) =>
    safeInvoke<void>('resize_clip_cmd', { clipId, newPositionFrames, newDurationFrames, allowStretch });
export const resizeClipWithDeltas = (clipId: string, newPositionFrames: number, newDurationFrames: number, allowStretch: boolean = false) =>
    safeInvoke<DeltaMutationResponse>('resize_clip_with_deltas_cmd', { clipId, newPositionFrames, newDurationFrames, allowStretch });
export const splitClip = (clipId: string, splitFrame: number) =>
    safeInvoke<SplitClipResponse>('split_clip_cmd', { clipId, splitFrame });
export const splitClipWithDeltas = (clipId: string, splitFrame: number) =>
    safeInvoke<SplitClipWithDeltasResponse>('split_clip_with_deltas_cmd', { clipId, splitFrame });
export const duplicateClip = (clipId: string, newPositionFrames?: number, targetTrackIndex?: number) =>
    safeInvoke<DuplicateClipResponse>('duplicate_clip_cmd', {
        clipId,
        newPositionFrames: newPositionFrames ?? null,
        targetTrackIndex: targetTrackIndex ?? null,
    });
export const duplicateClipWithDeltas = (clipId: string, newPositionFrames?: number, targetTrackIndex?: number) =>
    safeInvoke<DuplicateClipWithDeltasResponse>('duplicate_clip_with_deltas_cmd', {
        clipId,
        newPositionFrames: newPositionFrames ?? null,
        targetTrackIndex: targetTrackIndex ?? null,
    });

export const duplicateMultipleClipsWithDeltas = (
    requests: Array<{ id: string; newPositionFrames?: number; targetTrackIndex?: number }>
) => safeInvoke<DuplicateClipWithDeltasResponse>('duplicate_multiple_clips_with_deltas_cmd', { requests });
export const mergeClips = (clipIds: string[]) =>
    safeInvoke<MergeClipsResponse>('merge_clips_cmd', { clipIds });
export const mergeClipsWithDeltas = (clipIds: string[]) =>
    safeInvoke<MergeClipsWithDeltasResponse>('merge_clips_with_deltas_cmd', { clipIds });
export const deleteClip = (clipId: string) =>
    safeInvoke<void>('delete_clip_cmd', { clipId });
export const deleteClipWithDeltas = (clipId: string) =>
    safeInvoke<DeltaMutationResponse>('delete_clip_with_deltas_cmd', { clipId });
export const setClipMuted = (clipId: string, muted: boolean) =>
    safeInvoke<void>('set_clip_muted_cmd', { clipId, muted });
export const setClipMutedWithDeltas = (clipId: string, muted: boolean) =>
    safeInvoke<DeltaMutationResponse>('set_clip_muted_with_deltas_cmd', { clipId, muted });
export const setClipsMuted = (clipIds: string[], muted: boolean) =>
    safeInvoke<number>('set_clips_muted_cmd', { clipIds, muted });
export const setClipsMutedWithDeltas = (clipIds: string[], muted: boolean) =>
    safeInvoke<DeltaMutationResponse>('set_clips_muted_with_deltas_cmd', { clipIds, muted });
export const paintTrackClipsWithTrackColor = (trackId: string) =>
    safeInvoke<void>('paint_track_clips_with_track_color_cmd', { trackId });
export const paintTrackClipsWithTrackColorWithDeltas = (trackId: string) =>
    safeInvoke<DeltaMutationResponse>('paint_track_clips_with_track_color_with_deltas_cmd', { trackId });
export interface AudioDevices {
    outputs: string[];
    inputs: string[];
}
export const getAudioDevices = () =>
    safeInvoke<AudioDevices>('get_audio_devices');
export const setAudioDevice = (deviceName: string) =>
    safeInvoke<string>('set_audio_device', { deviceName });
export const restartAudioEngine = (deviceName: string) =>
    safeInvoke<string>('restart_audio_engine', { deviceName });
export const openPluginWindow = (pluginId: string) =>
    safeInvoke<void>('open_plugin_window', { pluginId });
export const openPluginWindowForSlot = (trackId: string, slotId: string) =>
    safeInvoke<void>('open_plugin_window_for_slot', { trackId, slotId });
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
    safeInvoke<PluginEditorCapability>('can_open_plugin_editor', { pluginId });
export const canOpenPluginEditorForSlot = (trackId: string, slotId: string) =>
    safeInvoke<PluginEditorCapability>('can_open_plugin_editor_for_slot', { trackId, slotId });
export const getPluginSlotRuntimeStatus = (trackId: string, slotId: string) =>
    safeInvoke<PluginSlotRuntimeStatus>('get_plugin_slot_runtime_status_cmd', { trackId, slotId });
export const ensurePluginSlotActive = (trackId: string, slotId: string) =>
    safeInvoke<void>('ensure_plugin_slot_active_cmd', { trackId, slotId });
export const unloadPluginSlot = (trackId: string, slotId: string) =>
    safeInvoke<void>('unload_plugin_slot_cmd', { trackId, slotId });
export const replaceMissingPluginSlot = (
    trackId: string,
    slotId: string,
    replacementPluginId: string,
    replacementPluginName?: string,
) =>
    safeInvoke<void>('replace_missing_plugin_slot_cmd', {
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
    safeInvoke<DeltaMutationResponse>('replace_missing_plugin_slot_with_deltas_cmd', {
        payload: {
            trackId,
            slotId,
            replacementPluginId,
            replacementPluginName: replacementPluginName ?? null,
        },
    });
export const autoResolveMissingPluginsWithDeltas = () =>
    safeInvoke<DeltaMutationResponse>('auto_resolve_missing_plugins_with_deltas_cmd');

export interface AutoResolveMissingPluginsReport {
    deltas: ProjectDelta[];
    missing_before: number;
    missing_after: number;
    resolved_internal: number;
    resolved_external: number;
    unresolved_labels: string[];
}

export const autoResolveMissingPluginsReportWithDeltas = () =>
    safeInvoke<AutoResolveMissingPluginsReport>('auto_resolve_missing_plugins_report_with_deltas_cmd');
export const closePluginWindow = (pluginId: string) =>
    safeInvoke<void>('close_plugin_window_cmd', { pluginId });
export const closePluginWindowForSlot = (trackId: string, slotId: string) =>
    safeInvoke<void>('close_plugin_window_for_slot', { trackId, slotId });
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
    safeInvoke<PluginSandboxSnapshot>('get_plugin_sandbox_runtime');
export const setPluginSandboxEnabled = (enabled: boolean) =>
    safeInvoke<PluginSandboxSnapshot>('set_plugin_sandbox_enabled', { enabled });
export const tickPluginSandboxWatchdog = () =>
    safeInvoke<PluginSandboxSnapshot>('tick_plugin_sandbox_watchdog');
export const reloadPluginSandboxInstance = (instanceId: string) =>
    safeInvoke<PluginSandboxSnapshot>('reload_plugin_sandbox_instance', { instanceId });
export const reloadUnhealthyPluginSandboxes = () =>
    safeInvoke<ReloadSandboxInstancesResponse>('reload_unhealthy_plugin_sandboxes');
export const logFrontendError = (module: string, error: string, stack?: string) =>
    safeInvoke<void>('log_frontend_error', { module, error, stack: stack ?? null });
export interface RoutingTarget {
    trackId: string;
    trackName: string;
    trackType: string;
}
export const getRoutingTargets = (trackId: string) =>
    safeInvoke<RoutingTarget[]>('get_routing_targets', { trackId });
export const setTrackRouting = (trackId: string, targetId: string) =>
    safeInvoke<void>('set_track_routing_cmd', { trackId, targetId });
export const setTrackRoutingWithDeltas = (trackId: string, targetId: string) =>
    safeInvoke<DeltaMutationResponse>('set_track_routing_with_deltas_cmd', { trackId, targetId });
export const setTrackInput = (trackId: string, inputId: string) =>
    safeInvoke<void>('set_track_input_cmd', { trackId, inputId });
export const setTrackInputWithDeltas = (trackId: string, inputId: string) =>
    safeInvoke<DeltaMutationResponse>('set_track_input_with_deltas_cmd', { trackId, inputId });
export const setPluginSidechainSource = (
    trackId: string,
    slotId: string,
    sourceTrackId: string,
) =>
    safeInvoke<void>('set_plugin_sidechain_source_cmd', { trackId, slotId, sourceTrackId });
export const setPluginSidechainSourceWithDeltas = (
    trackId: string,
    slotId: string,
    sourceTrackId: string,
) =>
    safeInvoke<DeltaMutationResponse>('set_plugin_sidechain_source_with_deltas_cmd', {
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
    safeInvoke<void>('add_plugin_to_track_cmd', {
        payload: { trackId, pluginId, pluginName, slot, insertIndex: insertIndex ?? null },
    });
export const addPluginToTrackWithDeltas = (
    trackId: string,
    pluginId: string,
    pluginName: string,
    slot: 'instrument' | 'effect' | 'auto' = 'auto',
    insertIndex?: number,
) =>
    safeInvoke<DeltaMutationResponse>('add_plugin_to_track_with_deltas_cmd', {
        payload: { trackId, pluginId, pluginName, slot, insertIndex: insertIndex ?? null },
    });
export const removePluginFromTrack = (trackId: string, slotId: string) =>
    safeInvoke<void>('remove_plugin_from_track_cmd', {
        payload: { trackId, slotId },
    });
export const removePluginFromTrackWithDeltas = (trackId: string, slotId: string) =>
    safeInvoke<DeltaMutationResponse>('remove_plugin_from_track_with_deltas_cmd', {
        payload: { trackId, slotId },
    });
export const copyDeviceFromTrack = (trackId: string, deviceId: string) =>
    safeInvoke<string>('copy_device_from_track_cmd', { trackId, deviceId });
export const pasteDeviceToTrack = (
    trackId: string,
    slotHint: 'instrument' | 'effect' | 'auto' = 'auto',
) =>
    safeInvoke<void>('paste_device_to_track_cmd', { trackId, slotHint });
export const pasteDeviceToTrackWithDeltas = (
    trackId: string,
    slotHint: 'instrument' | 'effect' | 'auto' = 'auto',
) =>
    safeInvoke<DeltaMutationResponse>('paste_device_to_track_with_deltas_cmd', { trackId, slotHint });
export const setInternalPluginParam = (
    trackId: string,
    slotId: string,
    paramId: string,
    value: number,
    options?: { pushUndoStep?: boolean },
) =>
    safeInvoke<void>('set_internal_plugin_param_cmd', {
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
    safeInvoke<DeltaMutationResponse>('set_internal_plugin_param_with_deltas_cmd', {
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
    safeInvoke<void>('set_external_plugin_param_cmd', {
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
    safeInvoke<void>('set_external_plugin_param_for_slot_cmd', {
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
    safeInvoke<void>('set_external_plugin_param_for_slot_runtime_cmd', {
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
    safeInvoke<DeltaMutationResponse>('set_external_plugin_param_for_slot_with_deltas_cmd', {
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
    safeInvoke<ExternalPluginParamInfo[]>('get_external_plugin_params', { pluginId });
export const getExternalPluginParamsForSlot = (trackId: string, slotId: string) =>
    safeInvoke<ExternalPluginParamInfo[]>('get_external_plugin_params_for_slot', { trackId, slotId });
export const setSamplerSample = (
    trackId: string,
    samplePath: string,
    rootNote?: number,
) =>
    safeInvoke<void>('set_sampler_sample_cmd', {
        payload: { trackId, samplePath, rootNote: rootNote ?? null },
    });
export const setSamplerSampleWithDeltas = (
    trackId: string,
    samplePath: string,
    rootNote?: number,
) =>
    safeInvoke<DeltaMutationResponse>('set_sampler_sample_with_deltas_cmd', {
        payload: { trackId, samplePath, rootNote: rootNote ?? null },
    });
export const setSampleRackPadSample = (
    trackId: string,
    padIndex: number,
    samplePath: string,
) =>
    safeInvoke<void>('set_sample_rack_pad_sample_cmd', {
        trackId, padIndex, samplePath
    });
export const setSampleRackPadSampleWithDeltas = (
    trackId: string,
    padIndex: number,
    samplePath: string,
) =>
    safeInvoke<DeltaMutationResponse>('set_sample_rack_pad_sample_with_deltas_cmd', {
        trackId, padIndex, samplePath
    });
export const setSampleRackPadVolumeCmd = (trackId: string, padIndex: number, volume: number) =>
    safeInvoke<void>('set_sample_rack_pad_volume_cmd', { trackId, padIndex, volume });
export const setSampleRackPadVolumeWithDeltasCmd = (trackId: string, padIndex: number, volume: number) =>
    safeInvoke<DeltaMutationResponse>('set_sample_rack_pad_volume_with_deltas_cmd', { trackId, padIndex, volume });
export const setSampleRackPadMuteCmd = (trackId: string, padIndex: number, muted: boolean) =>
    safeInvoke<void>('set_sample_rack_pad_mute_cmd', { trackId, padIndex, muted });
export const setSampleRackPadMuteWithDeltasCmd = (trackId: string, padIndex: number, muted: boolean) =>
    safeInvoke<DeltaMutationResponse>('set_sample_rack_pad_mute_with_deltas_cmd', { trackId, padIndex, muted });
export const setSampleRackPadSoloCmd = (trackId: string, padIndex: number, soloed: boolean) =>
    safeInvoke<void>('set_sample_rack_pad_solo_cmd', { trackId, padIndex, soloed });
export const setSampleRackPadSoloWithDeltasCmd = (trackId: string, padIndex: number, soloed: boolean) =>
    safeInvoke<DeltaMutationResponse>('set_sample_rack_pad_solo_with_deltas_cmd', { trackId, padIndex, soloed });
export const setSampleRackPadAdsrCmd = (trackId: string, padIndex: number, attack: number, decay: number, sustain: number, release: number) =>
    safeInvoke<void>('set_sample_rack_pad_adsr_cmd', { trackId, padIndex, attack, decay, sustain, release });
export const setSampleRackPadAdsrWithDeltasCmd = (trackId: string, padIndex: number, attack: number, decay: number, sustain: number, release: number) =>
    safeInvoke<DeltaMutationResponse>('set_sample_rack_pad_adsr_with_deltas_cmd', { trackId, padIndex, attack, decay, sustain, release });
export const setSampleRackPadFilterCutoffCmd = (trackId: string, padIndex: number, cutoff: number) =>
    safeInvoke<void>('set_sample_rack_pad_filter_cutoff_cmd', { trackId, padIndex, cutoff });
export const setSampleRackPadFilterCutoffWithDeltasCmd = (trackId: string, padIndex: number, cutoff: number) =>
    safeInvoke<DeltaMutationResponse>('set_sample_rack_pad_filter_cutoff_with_deltas_cmd', { trackId, padIndex, cutoff });
// BUG-027 FIX: Validate fade frame values — no negative or NaN.
export const setClipFades = (clipId: string, fadeInFrames: number, fadeOutFrames: number) => {
    const fi = Number.isFinite(fadeInFrames) ? Math.max(0, Math.round(fadeInFrames)) : 0;
    const fo = Number.isFinite(fadeOutFrames) ? Math.max(0, Math.round(fadeOutFrames)) : 0;
    return safeInvoke<void>('set_clip_fades_cmd', { clipId, fadeInFrames: fi, fadeOutFrames: fo });
};
export const setClipFadesWithDeltas = (clipId: string, fadeInFrames: number, fadeOutFrames: number) => {
    const fi = Number.isFinite(fadeInFrames) ? Math.max(0, Math.round(fadeInFrames)) : 0;
    const fo = Number.isFinite(fadeOutFrames) ? Math.max(0, Math.round(fadeOutFrames)) : 0;
    return safeInvoke<DeltaMutationResponse>('set_clip_fades_with_deltas_cmd', { clipId, fadeInFrames: fi, fadeOutFrames: fo });
};
export const setClipSourceOffset = (clipId: string, sourceOffsetFrames: number) =>
    safeInvoke<void>('set_clip_source_offset_cmd', { clipId, sourceOffsetFrames });
export const setClipSourceOffsetWithDeltas = (clipId: string, sourceOffsetFrames: number) =>
    safeInvoke<DeltaMutationResponse>('set_clip_source_offset_with_deltas_cmd', { clipId, sourceOffsetFrames });
export interface SetClipWarpPayload {
    clipId: string;
    isWarped?: boolean;
    warpMode?: number | null;
    warpBaseBpm?: number | null;
}
export const setClipWarp = (payload: SetClipWarpPayload) =>
    safeInvoke<void>('set_clip_warp_cmd', { payload });
export const setClipWarpWithDeltas = (payload: SetClipWarpPayload) =>
    safeInvoke<DeltaMutationResponse>('set_clip_warp_with_deltas_cmd', { payload });
export const setClipPitch = (payload: {
    clipId: string;
    pitchShiftSemitones: number;
}) =>
    safeInvoke<void>('set_clip_pitch_cmd', { payload });
export const setClipPitchWithDeltas = (payload: {
    clipId: string;
    pitchShiftSemitones: number;
}) =>
    safeInvoke<DeltaMutationResponse>('set_clip_pitch_with_deltas_cmd', { payload });
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
    safeInvoke<string>('export_mix_cmd', { settings });
export const cancelExport = () =>
    safeInvoke<void>('cancel_export_cmd');
export const listBackgroundJobs = () =>
    safeInvoke<BackgroundJobSnapshot[]>('list_background_jobs_cmd');
export const cancelBackgroundJob = (jobId: string) =>
    safeInvoke<void>('cancel_background_job_cmd', { jobId });
export const clearFinishedBackgroundJobs = () =>
    safeInvoke<number>('clear_finished_background_jobs_cmd');
export interface BounceSelectionToTrackPayload {
    clipIds?: string[];
    rangeStartFrames?: number;
    rangeEndFrames?: number;
    startTrackIndex?: number;
    endTrackIndex?: number;
}
export const bounceSelectionToTrack = (payload: BounceSelectionToTrackPayload) =>
    safeInvoke<void>('bounce_selection_to_track_cmd', { payload });
export const bounceSelectionToTrackWithDeltas = (payload: BounceSelectionToTrackPayload) =>
    safeInvoke<DeltaMutationResponse>('bounce_selection_to_track_with_deltas_cmd', { payload });
export const bounceTrack = (trackId: string) =>
    safeInvoke<void>('bounce_track_cmd', { trackId });
export const bounceTrackWithDeltas = (trackId: string) =>
    safeInvoke<DeltaMutationResponse>('bounce_track_with_deltas_cmd', { trackId });
export const bounceGroup = (groupTrackId: string) =>
    safeInvoke<void>('bounce_group_cmd', { groupTrackId });
export const bounceGroupWithDeltas = (groupTrackId: string) =>
    safeInvoke<DeltaMutationResponse>('bounce_group_with_deltas_cmd', { groupTrackId });
export const consolidateSelection = (payload: BounceSelectionToTrackPayload) =>
    safeInvoke<void>('consolidate_selection_cmd', { payload });
export const consolidateSelectionWithDeltas = (payload: BounceSelectionToTrackPayload) =>
    safeInvoke<DeltaMutationResponse>('consolidate_selection_with_deltas_cmd', { payload });
export const splitTrackToStems = (trackId: string) =>
    safeInvoke<void>('split_track_to_stems_cmd', {
        payload: { trackId },
    });
export const splitTrackToStemsWithDeltas = (trackId: string) =>
    safeInvoke<DeltaMutationResponse>('split_track_to_stems_with_deltas_cmd', {
        payload: { trackId },
    });
export const undo = () => safeInvoke<void>('undo_cmd');
export const undoWithDeltas = () =>
    safeInvoke<DeltaMutationResponse>('undo_with_deltas_cmd');
export const redo = () => safeInvoke<void>('redo_cmd');
export const redoWithDeltas = () =>
    safeInvoke<DeltaMutationResponse>('redo_with_deltas_cmd');
export const armTrack = (trackIndex: number, armed: boolean) =>
    safeInvoke<void>('arm_track_cmd', { trackIndex, armed });
export const armTrackWithDeltas = (trackIndex: number, armed: boolean) =>
    safeInvoke<DeltaMutationResponse>('arm_track_with_deltas_cmd', { trackIndex, armed });
export const startRecording = () =>
    safeInvoke<void>('start_recording_cmd');
export const stopRecording = () =>
    safeInvoke<void>('stop_recording_cmd');
export const resolveMissingFile = (clipId: string, newPath: string) =>
    safeInvoke<void>('resolve_missing_file_cmd', { clipId, newPath });
export const resolveMissingFileWithDeltas = (clipId: string, newPath: string) =>
    safeInvoke<DeltaMutationResponse>('resolve_missing_file_with_deltas_cmd', { clipId, newPath });
export interface AutomationPoint {
    beat: number;
    value: number;
    curveType: 'linear' | 'bezier' | 'step';
    tension?: number;
}
export const setAutomationPoints = (trackId: string, paramId: string, points: AutomationPoint[]) =>
    safeInvoke<void>('set_automation_points_cmd', { trackId, paramId, points });
export const setAutomationPointsWithDeltas = (trackId: string, paramId: string, points: AutomationPoint[]) =>
    safeInvoke<DeltaMutationResponse>('set_automation_points_with_deltas_cmd', { trackId, paramId, points });
export const createRackFromDevices = (
    trackId: string,
    deviceIds: string[],
    rackName?: string,
    rackType?: 'audio_effect' | 'instrument' | 'drum' | 'midi_effect',
) =>
    safeInvoke<string>('create_rack_from_devices_cmd', {
        payload: { trackId, deviceIds, rackName: rackName ?? null, rackType: rackType ?? null },
    });
export const addChainToRack = (
    trackId: string,
    rackId: string,
    chainName?: string,
) =>
    safeInvoke<string>('add_chain_to_rack_cmd', {
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
    safeInvoke<string>('add_device_to_rack_chain_cmd', {
        payload: { trackId, rackId, chainId, pluginId, pluginName, insertIndex: insertIndex ?? null },
    });
export const removeDeviceFromRack = (
    trackId: string,
    rackId: string,
    deviceId: string,
    autoDissolve = false,
) =>
    safeInvoke<void>('remove_device_from_rack_cmd', {
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
    safeInvoke<string>('save_device_preset_cmd', {
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
    safeInvoke<string>('load_device_preset_cmd', {
        payload: { trackId, presetPath, insertIndex: insertIndex ?? null },
    });
export const setFlowEnabled = (trackIndex: number, enabled: boolean) =>
    safeInvoke<void>('set_flow_enabled_cmd', { trackIndex, enabled });

export const syncFlowGraph = (
    trackIndex: number,
    nodes: [number, string, [string, string][]][],
    connections: [number, number, number, number][],
) =>
    safeInvoke<void>('sync_flow_graph_cmd', { trackIndex, nodes, connections });
