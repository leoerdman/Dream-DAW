import { create } from 'zustand';
import throttle from 'lodash.throttle';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import * as engine from '@/shared/api/engine';
import { frameToBeat, resolveSampleRate } from '@/shared/lib/audioMath';
import { adaptTrack, resolveTrackColor } from '@/shared/lib/trackAdapter';
import type { ProjectTrack } from '@/shared/lib/trackAdapter';
import { applyProjectDeltasToState } from '@/shared/stores/engine/applyProjectDeltas';
import {
    DEBUG_PROJECT_FETCH,
    METER_STATE_UPDATE_EVERY_TICKS,
    mergeProjectHistory,
    patchSandboxInstancesById,
    PROJECT_HISTORY_SYNC_EVERY_TICKS,
    PROJECT_HISTORY_WINDOW,
    toEntityState,
    type EntityState,
} from '@/shared/stores/engine/storeHelpers';
import type {
    TransportState,
    MeteringSnapshot,
    ImportAudioResponse,
    ProjectHistoryEvent,
    ProjectDelta,
    PluginSandboxSnapshot,
    PluginCrashEvent,
    PluginRecoveryEvent,
} from '@/shared/api/engine';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import { useGridStore } from '@/shared/stores/useGridStore';

export type { ProjectTrack } from '@/shared/lib/trackAdapter';

const throttledVolumeSends = new Map<number, (volume: number) => void>();
const throttledPanSends = new Map<number, (pan: number) => void>();
const pendingVolumeValues = new Map<number, number>();
const pendingPanValues = new Map<number, number>();
let pendingMasterVolume: number | null = null;
let projectFetchSeq = 0;
/** Re-entry guard for recursive fetches. */
let _isFetchingProject = false;
/** Module-level guard for startTelemetryLoop re-entry. */
let _telemetryStarted = false;
/** Timestamp (ms) until which telemetry BPM updates are suppressed. */
let _bpmPendingUntil = 0;
/** Push meter data to React every N ticks; raw data remains in `_latestMeters`. */
let _meterFrameCounter = 0;
/** Latest raw meter snapshot (30fps), bypasses React state for perf. */
let _latestMeters: MeteringSnapshot | null = null;
/** rAF batching: pending Zustand updates coalesced across multiple Tauri ticks. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pendingUpdate: Record<string, any> = {};
let _rafPending = false;
type StoreSetFn = (partial: Partial<EngineStore>) => void;

function flushPendingStoreUpdate(set: StoreSetFn): void {
    _rafPending = false;
    const update = _pendingUpdate;
    _pendingUpdate = {};
    if (Object.keys(update).length > 0) {
        set(update as Partial<EngineStore>);
    }
}

function enqueuePendingStoreUpdate(set: StoreSetFn, partial: Partial<EngineStore>): void {
    _pendingUpdate = { ..._pendingUpdate, ...partial };
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(() => flushPendingStoreUpdate(set));
}
/** Get the latest meter snapshot without causing React re-renders. */
export function getMetersRef(): MeteringSnapshot {
    return _latestMeters ?? useEngineStore.getState().meters;
}
const throttledMasterVolumeSend = throttle((volume: number) => {
    void engine.setMasterVolume(volume);
}, 16);

interface SandboxSlotUpdateEvent {
    instanceId?: string;
    instanceIds?: string[];
    slotIds?: string[];
    changedSlots?: number;
}

interface EngineStore {
    telemetryRunning: boolean;
    connected: boolean;
    transport: TransportState;
    meters: MeteringSnapshot;
    timelineClips: TimelineClip[];
    projectTracks: ProjectTrack[];
    tracksById: Record<string, ProjectTrack>;
    tracks: EntityState<ProjectTrack>;
    clipsById: Record<string, TimelineClip>;
    clips: EntityState<TimelineClip>;
    projectSampleRate: number;
    projectBpm: number;
    keySigEnabled: boolean;
    keySigTonic: string;
    keySigMode: string;
    lastError: string | null;
    projectHistory: ProjectHistoryEvent[];
    projectHistoryCursor: number;
    masterVolume: number;
    pluginSandbox: PluginSandboxSnapshot | null;
    openEditorsByTrack: Record<string, Set<string>>;
    togglePlay: () => Promise<void>;
    play: () => Promise<void>;
    stop: () => Promise<void>;
    setBpm: (bpm: number) => Promise<void>;
    seekSeconds: (seconds: number) => Promise<void>;
    seekToBeat: (beat: number) => Promise<void>;
    setLoop: (enabled: boolean, startFrames: number, endFrames: number) => Promise<void>;
    setFrequency: (freq: number) => Promise<void>;
    setTrackVolume: (trackIndex: number, volume: number) => Promise<void>;
    setTrackPan: (trackIndex: number, pan: number) => Promise<void>;
    setMasterVolume: (volume: number) => Promise<void>;
    flushTrackControlFinals: () => Promise<void>;
    setTrackMute: (trackIndex: number, muted: boolean) => Promise<void>;
    setTrackSolo: (trackIndex: number, soloed: boolean) => Promise<void>;
    addTrack: (name?: string) => Promise<void>;
    deleteTrack: (index: number) => Promise<void>;
    renameTrack: (index: number, name: string) => Promise<void>;
    importFile: (path: string, trackIndex: number, positionFrames?: number) => Promise<ImportAudioResponse | null>;
    createMidiClip: (trackIndex: number, positionFrames: number, durationFrames: number) => Promise<void>;
    applyProjectDeltas: (deltas: ProjectDelta[], reason?: string) => Promise<void>;
    fetchProject: (reason?: string) => Promise<void>;
    syncProjectHistory: () => Promise<void>;
    expandWindow: () => Promise<void>;
    startTelemetryLoop: () => void;
    stopTelemetryLoop: () => void;
    reloadCrashedSandboxPlugins: () => Promise<void>;
    togglePluginEditor: (trackId: string, slotId: string) => Promise<void>;
    closeAllPluginEditors: () => Promise<void>;
}

const DEFAULT_TRANSPORT: TransportState = {
    is_playing: false,
    position_frames: 0,
    position_seconds: 0,
    position_beats: 0,
    bpm: 120,
    sample_rate: 44100,
    loop_enabled: false,
    loop_start: 0,
    loop_end: 0,
    output_latency_frames: 0,
    telemetry_timestamp_ms: 0,
};

const DEFAULT_METER: engine.MeterReading = {
    rms: -160,
    peak: -160,
    clipping: false,
};

const DEFAULT_METERS: MeteringSnapshot = {
    tracks: [],
    master_left: { ...DEFAULT_METER },
    master_right: { ...DEFAULT_METER },
};

let _telemetryUnlisten: UnlistenFn | null = null;
let _pluginSandboxUnlisten: UnlistenFn | null = null;
let _pluginSandboxCrashUnlisten: UnlistenFn | null = null;
let _pluginSandboxRecoveredUnlisten: UnlistenFn | null = null;
let _pluginSandboxAutoBypassUnlisten: UnlistenFn | null = null;
let _pluginSandboxAutoRecoveredUnlisten: UnlistenFn | null = null;
let _pluginSandboxReloadedUnlisten: UnlistenFn | null = null;

export const useEngineStore = create<EngineStore>((set, get) => ({
    telemetryRunning: false,
    connected: false,
    transport: { ...DEFAULT_TRANSPORT },
    meters: { ...DEFAULT_METERS },
    timelineClips: [],
    projectTracks: [],
    tracksById: {},
    tracks: { byId: {}, allIds: [] },
    clipsById: {},
    clips: { byId: {}, allIds: [] },
    projectSampleRate: 44100,
    projectBpm: 120,
    keySigEnabled: false,
    keySigTonic: 'C',
    keySigMode: 'Major',
    lastError: null,
    projectHistory: [],
    projectHistoryCursor: 0,
    masterVolume: 1.0,
    pluginSandbox: null,
    openEditorsByTrack: {},


    togglePlay: async () => {
        try {
            const isPlaying = await engine.togglePlayback();
            set((s) => ({
                transport: { ...s.transport, is_playing: isPlaying },
                lastError: null,
            }));
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    play: async () => {
        try {
            await engine.play();
            set((s) => ({
                transport: { ...s.transport, is_playing: true },
                lastError: null,
            }));
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    stop: async () => {
        try {
            await engine.stop();
            set((s) => ({
                transport: { ...s.transport, is_playing: false },
                lastError: null,
            }));
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    setBpm: async (bpm: number) => {
        // Optimistic update — UI responds instantly.
        // Keep transport + project tempo in sync to avoid frame↔beat mismatches
        // during drag/move/loop calculations before the next project refresh.
        set((s) => ({ transport: { ...s.transport, bpm }, projectBpm: bpm }));
        _bpmPendingUntil = Date.now() + 500;
        try {
            await engine.setBpmWithDeltas(bpm);
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    seekSeconds: async (seconds: number) => {
        try {
            await engine.seekSeconds(seconds);
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    seekToBeat: async (beat: number) => {
        try {
            await engine.seekToBeat(beat);
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    setLoop: async (enabled: boolean, startFrames: number, endFrames: number) => {
        set((s) => ({
            transport: { ...s.transport, loop_enabled: enabled, loop_start: startFrames, loop_end: endFrames },
        }));
        try {
            const response = await engine.setLoopWithDeltas(enabled, startFrames, endFrames);
            await get().applyProjectDeltas(response.deltas, 'setLoop');
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    setFrequency: async (freq: number) => {
        try {
            await engine.setFrequency(freq);
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },


    setTrackVolume: async (trackIndex: number, volume: number) => {
        try {
            pendingVolumeValues.set(trackIndex, volume);
            if (!throttledVolumeSends.has(trackIndex)) {
                throttledVolumeSends.set(
                    trackIndex,
                    throttle((nextVolume: number) => {
                        void engine
                            .setTrackVolumeWithDeltas(trackIndex, nextVolume)
                            .then((response) => get().applyProjectDeltas(response.deltas, 'setTrackVolume'))
                            .catch((e) => {
                                set({ lastError: String(e) });
                            });
                    }, 16),
                );
            }
            throttledVolumeSends.get(trackIndex)?.(volume);
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    setTrackPan: async (trackIndex: number, pan: number) => {
        try {
            pendingPanValues.set(trackIndex, pan);
            if (!throttledPanSends.has(trackIndex)) {
                throttledPanSends.set(
                    trackIndex,
                    throttle((nextPan: number) => {
                        void engine
                            .setTrackPanWithDeltas(trackIndex, nextPan)
                            .then((response) => get().applyProjectDeltas(response.deltas, 'setTrackPan'))
                            .catch((e) => {
                                set({ lastError: String(e) });
                            });
                    }, 16),
                );
            }
            throttledPanSends.get(trackIndex)?.(pan);
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    setMasterVolume: async (volume: number) => {
        try {
            const clamped = Math.max(0, Math.min(2, volume));
            pendingMasterVolume = clamped;
            set({ masterVolume: clamped });
            throttledMasterVolumeSend(clamped);
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    flushTrackControlFinals: async () => {
        try {
            const volumeEntries = Array.from(pendingVolumeValues.entries());
            const panEntries = Array.from(pendingPanValues.entries());

            await Promise.all([
                ...volumeEntries.map(async ([trackIndex, volume]) => {
                    const response = await engine.setTrackVolumeWithDeltas(trackIndex, volume);
                    await get().applyProjectDeltas(response.deltas, 'flushTrackControlFinals-volume');
                }),
                ...panEntries.map(async ([trackIndex, pan]) => {
                    const response = await engine.setTrackPanWithDeltas(trackIndex, pan);
                    await get().applyProjectDeltas(response.deltas, 'flushTrackControlFinals-pan');
                }),
            ]);
            if (pendingMasterVolume != null) {
                await engine.setMasterVolume(pendingMasterVolume);
            }

            pendingVolumeValues.clear();
            pendingPanValues.clear();
            pendingMasterVolume = null;
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    setTrackMute: async (trackIndex: number, muted: boolean) => {
        // Optimistic O(1) update — no .map() over entire array.
        set((s) => {
            const track = s.projectTracks[trackIndex];
            if (!track || track.is_mute === muted) return s;
            const updated = { ...track, is_mute: muted };
            const nextTracks = [...s.projectTracks];
            nextTracks[trackIndex] = updated;
            return {
                projectTracks: nextTracks,
                tracksById: { ...s.tracksById, [track.id]: updated },
                tracks: {
                    byId: { ...s.tracks.byId, [track.id]: updated },
                    allIds: s.tracks.allIds,
                },
            };
        });
        try {
            const response = await engine.setTrackMuteWithDeltas(trackIndex, muted);
            await get().applyProjectDeltas(response.deltas, 'setTrackMute');
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    setTrackSolo: async (trackIndex: number, soloed: boolean) => {
        // Optimistic O(1) update — no .map() over entire array.
        set((s) => {
            const track = s.projectTracks[trackIndex];
            if (!track || track.is_solo === soloed) return s;
            const updated = { ...track, is_solo: soloed };
            const nextTracks = [...s.projectTracks];
            nextTracks[trackIndex] = updated;
            return {
                projectTracks: nextTracks,
                tracksById: { ...s.tracksById, [track.id]: updated },
                tracks: {
                    byId: { ...s.tracks.byId, [track.id]: updated },
                    allIds: s.tracks.allIds,
                },
            };
        });
        try {
            const response = await engine.setTrackSoloWithDeltas(trackIndex, soloed);
            await get().applyProjectDeltas(response.deltas, 'setTrackSolo');
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },


    addTrack: async (name?: string) => {
        try {
            const response = await engine.addTrackWithDeltas(name);
            // Topology change invalidates index-keyed throttle closures.
            throttledVolumeSends.clear();
            throttledPanSends.clear();
            pendingVolumeValues.clear();
            pendingPanValues.clear();
            await get().applyProjectDeltas(response.deltas, 'addTrack');
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    deleteTrack: async (index: number) => {
        try {
            const response = await engine.deleteTrackWithDeltas(index);

            throttledVolumeSends.clear();
            throttledPanSends.clear();
            pendingVolumeValues.clear();
            pendingPanValues.clear();
            await get().applyProjectDeltas(response.deltas, 'deleteTrack');
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    renameTrack: async (index: number, name: string) => {
        try {
            const response = await engine.renameTrackWithDeltas(index, name);
            await get().applyProjectDeltas(response.deltas, 'renameTrack');
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    importFile: async (path: string, trackIndex: number, positionFrames?: number) => {
        try {
            const response = await engine.importAudioFileWithDeltas(path, trackIndex, positionFrames);
            console.log(
                `[Engine] Imported '${response.clip_name}' → track ${trackIndex} (${response.duration_seconds.toFixed(1)}s)`,
            );
            await get().applyProjectDeltas(response.deltas, 'importFile');
            return response;
        } catch (err) {
            const msg = `Import failed: ${err}`;
            console.error(`[Engine] ${msg}`);
            set({ lastError: msg });
            return null;
        }
    },

    createMidiClip: async (trackIndex: number, positionFrames: number, durationFrames: number) => {
        try {
            const response = await engine.createMidiClipWithDeltas(trackIndex, positionFrames, durationFrames);
            console.log(
                `[Engine] Created MIDI clip '${response.clip_name}' → track ${trackIndex} @ frame ${positionFrames}`,
            );
            await get().applyProjectDeltas(response.deltas, 'createMidiClip');
        } catch (err) {
            const msg = `Create MIDI clip failed: ${err}`;
            console.error(`[Engine] ${msg}`);
            set({ lastError: msg });
        }
    },

    applyProjectDeltas: async (deltas: ProjectDelta[], reason: string = 'delta') => {
        if (!Array.isArray(deltas) || deltas.length === 0) return;

        for (const delta of deltas) {
            if (delta.kind === 'ArrangementGridChanged') {
                useGridStore.getState().applyProjectGrid({
                    numerator: delta.data.numerator,
                    denominator: delta.data.denominator,
                    ntoles: delta.data.ntoles,
                    snapToGrid: delta.data.snap_to_grid,
                    fixed: delta.data.fixed,
                });
            }
        }

        set((s) => {
            let nextProjectBpm = s.projectBpm;
            let nextTransport = s.transport;
            let nextKeySigEnabled = s.keySigEnabled;
            let nextKeySigTonic = s.keySigTonic;
            let nextKeySigMode = s.keySigMode;

            for (const delta of deltas) {
                if (delta.kind === 'TempoChanged') {
                    nextProjectBpm = delta.data.bpm;
                    nextTransport = { ...nextTransport, bpm: delta.data.bpm };
                } else if (delta.kind === 'LoopRegionChanged') {
                    nextTransport = {
                        ...nextTransport,
                        loop_enabled: delta.data.enabled,
                        loop_start: delta.data.start,
                        loop_end: delta.data.end,
                    };
                } else if (delta.kind === 'KeySignatureChanged') {
                    nextKeySigEnabled = delta.data.enabled;
                    nextKeySigTonic = delta.data.tonic;
                    nextKeySigMode = delta.data.mode;
                }
            }

            const { nextState } =
                applyProjectDeltasToState(s, deltas, reason);
            if (!nextState) {
                if (
                    nextProjectBpm !== s.projectBpm
                    || nextTransport !== s.transport
                    || nextKeySigEnabled !== s.keySigEnabled
                    || nextKeySigTonic !== s.keySigTonic
                    || nextKeySigMode !== s.keySigMode
                ) {
                    return {
                        projectBpm: nextProjectBpm,
                        transport: nextTransport,
                        keySigEnabled: nextKeySigEnabled,
                        keySigTonic: nextKeySigTonic,
                        keySigMode: nextKeySigMode,
                    };
                }
                return s;
            }

            return {
                ...nextState,
                projectBpm: nextProjectBpm,
                transport: nextTransport,
                keySigEnabled: nextKeySigEnabled,
                keySigTonic: nextKeySigTonic,
                keySigMode: nextKeySigMode,
            };
        });
    },


    fetchProject: async (reason: string = 'manual') => {
        if (_isFetchingProject) {
            console.debug(`[fetchProject] BLOCKED re-entry reason="${reason}" — already in progress`);
            return;
        }
        _isFetchingProject = true;
        const requestSeq = ++projectFetchSeq;
        console.debug(`[fetchProject] START #${requestSeq} reason="${reason}"`);
        if (DEBUG_PROJECT_FETCH) {
            console.debug(`[ProjectFetch] start #${requestSeq} reason=${reason}`);
        }
        try {
            const historyCursor = get().projectHistoryCursor;
            const [project, projectHistoryDelta] = await Promise.all([
                engine.getProject() as Promise<{
                    name?: string;
                    tracks: Array<{
                        id: string;
                        name: string;
                        track_type: string;
                        color: unknown;
                        color_hex?: string | null;
                        volume: number;
                        pan: number;
                        is_mute: boolean;
                        is_solo: boolean;
                        output_destination_id?: string | null;
                        input_source_id?: string | null;
                        parent_track_id?: string | null;
                        child_track_ids?: string[];
                        is_expanded?: boolean;
                        effects?: Array<{
                            id: string;
                            name: string;
                            plugin_id: string;
                            is_bypassed: boolean;
                        }>;
                        instrument?: {
                            id: string;
                            name: string;
                            plugin_id: string;
                            is_bypassed: boolean;
                        } | null;
                        clips: Array<{
                            id: string;
                            name: string;
                            file_path: string;
                            position: { sample_frame: number };
                            duration: { sample_frame: number };
                            source_offset: { sample_frame: number };
                            is_warped?: boolean;
                            warp_mode?: number | null;
                            warp_base_bpm?: number;
                            warp_source_duration_frames?: number;
                            color_override: unknown;
                            color_hex?: string | null;
                            is_offline?: boolean;
                        }>;
                        midi_clips?: Array<{
                            id: string;
                            name: string;
                            position: { sample_frame: number };
                            duration: { sample_frame: number };
                            notes?: Array<{
                                pitch: number;
                                velocity: number;
                                start_frame: number;
                                duration_frames: number;
                            }>;
                            color_override?: unknown;
                            color_hex?: string | null;
                        }>;
                    }>;
                    sample_rate: number;
                    pulse_map: { tempo_events: Array<{ bpm: number }>; sample_rate: number };
                    arrangement_grid_numerator?: number;
                    arrangement_grid_denominator?: number;
                    arrangement_grid_ntoles?: number;
                    arrangement_snap_to_grid?: boolean;
                    arrangement_grid_fixed?: boolean;
                    key_sig_enabled?: boolean;
                    key_sig_tonic?: string;
                    key_sig_mode?: string;
                }>,
                engine.getProjectHistory({
                    limit: PROJECT_HISTORY_WINDOW,
                    sinceSeq: historyCursor > 0 ? historyCursor : undefined,
                }),
            ]);

            // Ignore stale/out-of-order responses (e.g. startup fetch resolving
            // after Open Project fetch). Latest invocation always wins.
            if (requestSeq !== projectFetchSeq) {
                console.debug(`[fetchProject] STALE #${requestSeq} reason="${reason}" latest=${projectFetchSeq} tracks=${project.tracks?.length ?? '?'} — DISCARDED`);
                if (DEBUG_PROJECT_FETCH) {
                    console.debug(`[ProjectFetch] stale #${requestSeq} reason=${reason} latest=${projectFetchSeq}`);
                }
                return;
            }
            console.debug(`[fetchProject] ACCEPTED #${requestSeq} reason="${reason}" tracks=${project.tracks?.length ?? '?'} name="${project.name ?? '?'}"`);

            const bpm = project.pulse_map?.tempo_events?.[0]?.bpm || get().transport.bpm || 120;
            const sr = resolveSampleRate(project.sample_rate, get().transport.sample_rate);
            const toFiniteNumber = (value: unknown, fallback = 0): number => {
                if (typeof value === 'number') {
                    return Number.isFinite(value) ? value : fallback;
                }
                if (typeof value === 'bigint') {
                    return Number(value);
                }
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : fallback;
            };

            useGridStore.getState().applyProjectGrid({
                numerator: project.arrangement_grid_numerator ?? 1,
                denominator: project.arrangement_grid_denominator ?? 16,
                ntoles: project.arrangement_grid_ntoles ?? 2,
                snapToGrid: project.arrangement_snap_to_grid ?? true,
                fixed: project.arrangement_grid_fixed ?? false,
            });

            // Convert all clips from sample frames → beats
            const timelineClips: TimelineClip[] = [];
            const projectTracks: ProjectTrack[] = [];

            for (let trackIdx = 0; trackIdx < project.tracks.length; trackIdx++) {
                const track = project.tracks[trackIdx];
                const adapted = adaptTrack(track as Parameters<typeof adaptTrack>[0]);
                projectTracks.push(adapted);
                const trackColor = adapted.color;
                const isMidiTrack = adapted.track_type.toLowerCase() === 'midi';

                for (const clip of track.clips) {
                    const posFrames = toFiniteNumber(clip.position.sample_frame, 0);
                    const durFrames = Math.max(1, toFiniteNumber(clip.duration.sample_frame, 1));
                    const isWarped = Boolean(clip.is_warped ?? false);
                    const warpBaseBpm = Math.max(20, toFiniteNumber(clip.warp_base_bpm, bpm));
                    const warpSourceDurationFrames = Math.max(1, toFiniteNumber(clip.warp_source_duration_frames, durFrames));
                    const sourceOffsetFrames = Math.max(0, toFiniteNumber(clip.source_offset?.sample_frame ?? 0, 0));
                    const fadeInFrames = Math.max(0, toFiniteNumber((clip as Record<string, unknown>).fade_in_frames ?? ((clip as Record<string, unknown>).fadeIn ?? 0), 0));
                    const fadeOutFrames = Math.max(0, toFiniteNumber((clip as Record<string, unknown>).fade_out_frames ?? ((clip as Record<string, unknown>).fadeOut ?? 0), 0));
                    const hasAudioPath = !!(clip.file_path && clip.file_path.trim().length > 0);
                    const treatAsMidi = isMidiTrack;
                    const clipColor = resolveTrackColor(clip.color_hex ?? clip.color_override);

                    timelineClips.push({
                        id: clip.id,
                        name: clip.name,
                        trackIndex: trackIdx,
                        startBeat: frameToBeat(posFrames, bpm, sr),
                        durationBeats: frameToBeat(durFrames, bpm, sr),
                        // Editor mode must follow track type:
                        // MIDI tracks -> piano roll, Audio tracks -> sample editor.
                        type: treatAsMidi ? 'midi' : 'audio',
                        color: clipColor !== '#667788' ? clipColor : trackColor,
                        filePath: treatAsMidi ? undefined : clip.file_path,
                        durationSamples: durFrames,
                        isWarped,
                        warpMode: clip.warp_mode ?? null,
                        warpBaseBpm,
                        warpSourceDurationFrames,
                        sourceOffset: sourceOffsetFrames,
                        fadeIn: fadeInFrames,
                        fadeOut: fadeOutFrames,
                        isOffline: treatAsMidi ? false : (hasAudioPath ? (clip.is_offline ?? false) : false),
                        muted: Boolean((clip as Record<string, unknown>).is_muted ?? false),
                    });
                }

                for (const clip of track.midi_clips ?? []) {
                    const posFrames = toFiniteNumber(clip.position.sample_frame, 0);
                    const durFrames = Math.max(1, toFiniteNumber(clip.duration.sample_frame, 1));
                    const fadeInFrames = Math.max(0, toFiniteNumber((clip as Record<string, unknown>).fade_in_frames ?? ((clip as Record<string, unknown>).fadeIn ?? 0), 0));
                    const fadeOutFrames = Math.max(0, toFiniteNumber((clip as Record<string, unknown>).fade_out_frames ?? ((clip as Record<string, unknown>).fadeOut ?? 0), 0));
                    const midiClipColor = resolveTrackColor(clip.color_hex ?? clip.color_override);
                    timelineClips.push({
                        id: clip.id,
                        name: clip.name,
                        trackIndex: trackIdx,
                        startBeat: frameToBeat(posFrames, bpm, sr),
                        durationBeats: frameToBeat(durFrames, bpm, sr),
                        type: 'midi',
                        color: midiClipColor !== '#667788' ? midiClipColor : trackColor,
                        durationSamples: durFrames,
                        sourceOffset: 0,
                        fadeIn: fadeInFrames,
                        fadeOut: fadeOutFrames,
                        muted: Boolean((clip as Record<string, unknown>).is_muted ?? false),
                        midiNotes: (clip.notes ?? []).map((note, idx) => ({
                            id: `${clip.id}:${idx}:${note.pitch}:${note.start_frame}`,
                            pitch: note.pitch,
                            startBeat: frameToBeat(note.start_frame, bpm, sr),
                            durationBeats: frameToBeat(note.duration_frames, bpm, sr),
                            velocity: note.velocity,
                        })),
                        midiEnvelopes: (((clip as Record<string, unknown>).envelopes as Array<Record<string, unknown>> | undefined) ?? []).map((env) => ({
                            paramId: String(env.param_id ?? env.paramId ?? ''),
                            points: ((env.points as Array<Record<string, unknown>> | undefined) ?? []).map((p) => ({
                                beat: Number(p.beat ?? 0),
                                value: Number(p.value ?? 0),
                                curveType: String(p.curve_type ?? p.curveType ?? 'linear'),
                            })),
                        })),
                    });
                }
            }

            if (requestSeq === projectFetchSeq) {
                set((s) => {
                    const tracks = toEntityState(projectTracks);
                    const clips = toEntityState(timelineClips);
                    return ({
                    // Append incremental delta from backend history journal.
                    // Backend falls back to full slice when cursor becomes stale
                    // (e.g. after new/open project reset).
                    ...(() => {
                        const merged = mergeProjectHistory(
                            s.projectHistory,
                            s.projectHistoryCursor,
                            projectHistoryDelta,
                        );
                        return {
                            projectHistory: merged.history,
                            projectHistoryCursor: merged.cursor,
                        };
                    })(),
                    timelineClips,
                    projectTracks,
                    tracksById: tracks.byId,
                    tracks,
                    clipsById: clips.byId,
                    clips,
                    projectSampleRate: sr,
                    projectBpm: bpm,
                    keySigEnabled: project.key_sig_enabled ?? false,
                    keySigTonic: project.key_sig_tonic || 'C',
                    keySigMode: project.key_sig_mode || 'Major',
                    // Keep transport.bpm in sync so TransportBar/StatusBar
                    // show correct BPM immediately, even before next telemetry tick.
                    transport: { ...s.transport, bpm },
                });
                });
                if (DEBUG_PROJECT_FETCH) {
                    console.debug(
                        `[ProjectFetch] apply #${requestSeq} reason=${reason} tracks=${projectTracks.length} clips=${timelineClips.length} bpm=${bpm}`,
                    );
                }

                const validTrackIndices = new Set(projectTracks.map((_, i) => i));
                for (const key of throttledVolumeSends.keys()) {
                    if (!validTrackIndices.has(key)) throttledVolumeSends.delete(key);
                }
                for (const key of throttledPanSends.keys()) {
                    if (!validTrackIndices.has(key)) throttledPanSends.delete(key);
                }
                for (const key of pendingVolumeValues.keys()) {
                    if (!validTrackIndices.has(key)) pendingVolumeValues.delete(key);
                }
                for (const key of pendingPanValues.keys()) {
                    if (!validTrackIndices.has(key)) pendingPanValues.delete(key);
                }
            }
        } catch (e) {
            console.debug(`[fetchProject] ERROR #${requestSeq} reason="${reason}":`, e);
            console.error('[Engine] fetchProject failed:', e);
            if (DEBUG_PROJECT_FETCH) {
                console.debug(`[ProjectFetch] error #${requestSeq} reason=${reason}`);
            }
        } finally {
            _isFetchingProject = false;
        }
    },

    syncProjectHistory: async () => {
        try {
            const cursor = get().projectHistoryCursor;
            const delta = await engine.getProjectHistory({
                limit: PROJECT_HISTORY_WINDOW,
                sinceSeq: cursor > 0 ? cursor : undefined,
            });
            if (delta.length === 0) return;
            set((s) => {
                const merged = mergeProjectHistory(
                    s.projectHistory,
                    s.projectHistoryCursor,
                    delta,
                );
                return {
                    projectHistory: merged.history,
                    projectHistoryCursor: merged.cursor,
                };
            });
        } catch (e) {
            // Non-critical. Keep timeline responsive even if history sync hiccups.
            console.warn('[Engine] syncProjectHistory failed:', e);
        }
    },


    expandWindow: async () => {
        try {
            await engine.expandWindow();
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    startTelemetryLoop: () => {
        if (_telemetryStarted) return;
        _telemetryStarted = true;

        queueMicrotask(() => {
            set({ telemetryRunning: true });
            void get().fetchProject('telemetry-startup');
        });
        let tickCounter = 0;

        void (async () => {
            try {
                _telemetryUnlisten = await listen<{
                    transport: TransportState;
                    meters: MeteringSnapshot;
                }>('telemetry_tick', (event) => {
                    tickCounter++;
                    if (tickCounter % PROJECT_HISTORY_SYNC_EVERY_TICKS === 0) {
                        void get().syncProjectHistory();
                    }
                    const nextTransport = event.payload.transport;
                    const nextMeters = event.payload.meters;
                    const prev = get().transport;

                    const bpmProtected = Date.now() < _bpmPendingUntil;
                    const effectiveTransport = bpmProtected
                        ? { ...nextTransport, bpm: prev.bpm }
                        : nextTransport;

                    const transportChanged =
                        prev.is_playing !== effectiveTransport.is_playing ||
                        prev.position_beats !== effectiveTransport.position_beats ||
                        prev.position_frames !== effectiveTransport.position_frames ||
                        prev.bpm !== effectiveTransport.bpm ||
                        prev.loop_enabled !== effectiveTransport.loop_enabled ||
                        prev.loop_start !== effectiveTransport.loop_start ||
                        prev.loop_end !== effectiveTransport.loop_end;

                    _latestMeters = nextMeters;
                    _meterFrameCounter++;
                    const shouldUpdateMeterState = _meterFrameCounter % METER_STATE_UPDATE_EVERY_TICKS === 0;

                    if (transportChanged) {
                        _pendingUpdate.transport = effectiveTransport;
                        _pendingUpdate.connected = true;
                        _pendingUpdate.lastError = null;
                    }
                    if (shouldUpdateMeterState) {
                        _pendingUpdate.meters = nextMeters;
                        if (!get().connected) {
                            _pendingUpdate.connected = true;
                            _pendingUpdate.lastError = null;
                        }
                    }
                    if (!get().connected && !_pendingUpdate.connected) {
                        _pendingUpdate.connected = true;
                        _pendingUpdate.lastError = null;
                    }

                    // Schedule single rAF flush (idempotent — only one pending at a time)
                    enqueuePendingStoreUpdate(set, {});
                });
                _pluginSandboxUnlisten = await listen<PluginSandboxSnapshot>(
                    'plugin_sandbox_tick',
                    (event) => {
                        enqueuePendingStoreUpdate(set, { pluginSandbox: event.payload });
                    },
                );
                _pluginSandboxCrashUnlisten = await listen<PluginCrashEvent>(
                    'plugin_sandbox_crashed',
                    (event) => {
                        const crash = event.payload;
                        const state = get();
                        const nextSandbox = state.pluginSandbox
                            ? {
                                ...state.pluginSandbox,
                                instances: state.pluginSandbox.instances.map((inst) =>
                                    inst.plugin_instance_id === crash.instance_id
                                        ? {
                                            ...inst,
                                            status: 'crashed',
                                            bypass_requested: true,
                                            crash_count: Math.max(inst.crash_count, crash.crash_count),
                                            last_error: crash.reason,
                                        }
                                        : inst,
                                ),
                            }
                            : state.pluginSandbox;
                        enqueuePendingStoreUpdate(set, {
                            pluginSandbox: nextSandbox,
                            lastError: `Plugin crashed: ${crash.plugin_name} (${crash.reason})`,
                        });
                    },
                );
                _pluginSandboxRecoveredUnlisten = await listen<PluginRecoveryEvent>(
                    'plugin_sandbox_recovered',
                    (event) => {
                        const recovery = event.payload;
                        const state = get();
                        const nextSandbox = patchSandboxInstancesById(
                            state.pluginSandbox,
                            new Set([recovery.instance_id]),
                            (inst) => ({
                                ...inst,
                                status: 'running',
                                bypass_requested: false,
                                crash_count: Math.max(inst.crash_count, recovery.crash_count),
                                restart_count: Math.max(inst.restart_count, recovery.restart_count),
                                last_error: null,
                            }),
                        );
                        enqueuePendingStoreUpdate(set, {
                            pluginSandbox: nextSandbox,
                            lastError: null,
                        });
                    },
                );
                _pluginSandboxAutoBypassUnlisten = await listen<SandboxSlotUpdateEvent>(
                    'plugin_sandbox_auto_bypass',
                    (event) => {
                        const instanceIds = new Set(event.payload.instanceIds ?? []);
                        const state = get();
                        const nextSandbox = patchSandboxInstancesById(
                            state.pluginSandbox,
                            instanceIds,
                            (inst) => ({
                                ...inst,
                                bypass_requested: true,
                                status: inst.status === 'running' ? 'crashed' : inst.status,
                            }),
                        );
                        enqueuePendingStoreUpdate(set, { pluginSandbox: nextSandbox });
                    },
                );
                _pluginSandboxAutoRecoveredUnlisten = await listen<SandboxSlotUpdateEvent>(
                    'plugin_sandbox_auto_recovered',
                    (event) => {
                        const instanceIds = new Set(event.payload.instanceIds ?? []);
                        const state = get();
                        const nextSandbox = patchSandboxInstancesById(
                            state.pluginSandbox,
                            instanceIds,
                            (inst) => ({
                                ...inst,
                                bypass_requested: false,
                                status: 'running',
                                last_error: null,
                            }),
                        );
                        enqueuePendingStoreUpdate(set, {
                            pluginSandbox: nextSandbox,
                            lastError: null,
                        });
                    },
                );
                _pluginSandboxReloadedUnlisten = await listen<SandboxSlotUpdateEvent>(
                    'plugin_sandbox_reloaded',
                    (event) => {
                        const instanceIds = new Set([
                            ...(event.payload.instanceIds ?? []),
                            ...(event.payload.instanceId ? [event.payload.instanceId] : []),
                        ]);
                        const state = get();
                        const nextSandbox = patchSandboxInstancesById(
                            state.pluginSandbox,
                            instanceIds,
                            (inst) => ({
                                ...inst,
                                // Reload means restart request accepted, not full recovery.
                                // Runtime is expected to pass through Spawning before Ready.
                                status: 'spawning',
                            }),
                        );
                        enqueuePendingStoreUpdate(set, { pluginSandbox: nextSandbox });
                    },
                );
            } catch (e) {
                const msg = String(e);
                console.error('[Telemetry] listen() failed — resetting guard for retry:', msg);
                _telemetryStarted = false;
                if (get().lastError !== msg) {
                    set({ lastError: msg, connected: false, telemetryRunning: false });
                }
            }
        })();
    },

    stopTelemetryLoop: () => {
        _telemetryStarted = false;
        set({ telemetryRunning: false });
        if (_telemetryUnlisten) {
            _telemetryUnlisten();
            _telemetryUnlisten = null;
        }
        if (_pluginSandboxUnlisten) {
            _pluginSandboxUnlisten();
            _pluginSandboxUnlisten = null;
        }
        if (_pluginSandboxCrashUnlisten) {
            _pluginSandboxCrashUnlisten();
            _pluginSandboxCrashUnlisten = null;
        }
        if (_pluginSandboxRecoveredUnlisten) {
            _pluginSandboxRecoveredUnlisten();
            _pluginSandboxRecoveredUnlisten = null;
        }
        if (_pluginSandboxAutoBypassUnlisten) {
            _pluginSandboxAutoBypassUnlisten();
            _pluginSandboxAutoBypassUnlisten = null;
        }
        if (_pluginSandboxAutoRecoveredUnlisten) {
            _pluginSandboxAutoRecoveredUnlisten();
            _pluginSandboxAutoRecoveredUnlisten = null;
        }
        if (_pluginSandboxReloadedUnlisten) {
            _pluginSandboxReloadedUnlisten();
            _pluginSandboxReloadedUnlisten = null;
        }
    },

    reloadCrashedSandboxPlugins: async () => {
        const snapshot = get().pluginSandbox;
        if (!snapshot || !snapshot.enabled) return;

        const hasUnhealthy = snapshot.instances.some(
            (inst) => inst.status === 'crashed' || inst.status === 'timed_out' || inst.bypass_requested,
        );
        if (!hasUnhealthy) return;

        try {
            const response = await engine.reloadUnhealthyPluginSandboxes();
            set({
                pluginSandbox: response.snapshot,
                lastError: response.errors.length > 0
                    ? `Sandbox reload failed: ${response.errors.join('; ')}`
                    : null,
            });
        } catch (e) {
            set({ lastError: `Sandbox reload failed: ${String(e)}` });
        }
    },

    togglePluginEditor: async (trackId: string, slotId: string) => {
        const { openEditorsByTrack } = get();
        const trackSet = openEditorsByTrack[trackId] || new Set<string>();
        const isOpen = trackSet.has(slotId);

        try {
            if (isOpen) {
                await engine.closePluginWindowForSlot(trackId, slotId);
                const nextSet = new Set(trackSet);
                nextSet.delete(slotId);
                set((s) => ({
                    openEditorsByTrack: { ...s.openEditorsByTrack, [trackId]: nextSet },
                }));
            } else {
                await engine.openPluginWindowForSlot(trackId, slotId);
                const nextSet = new Set(trackSet);
                nextSet.add(slotId);
                set((s) => ({
                    openEditorsByTrack: { ...s.openEditorsByTrack, [trackId]: nextSet },
                }));
            }
            set({ lastError: null });
        } catch (e) {
            console.error('[EngineStore] togglePluginEditor failed:', e);
            set({ lastError: String(e) });
        }
    },

    closeAllPluginEditors: async () => {
        const { openEditorsByTrack } = get();
        for (const [trackId, slots] of Object.entries(openEditorsByTrack)) {
            for (const slotId of slots) {
                try {
                    await engine.closePluginWindowForSlot(trackId, slotId);
                } catch (e) {
                    console.warn(`[EngineStore] Failed to close editor ${slotId} on track ${trackId}:`, e);
                }
            }
        }
        set({ openEditorsByTrack: {} });
    },
}));
