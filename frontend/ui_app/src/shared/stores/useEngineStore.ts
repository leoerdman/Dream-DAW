import { create } from 'zustand';
import * as engine from '@/shared/api/engine';
import { applyProjectDeltasToState, extractSnapshotProjectMeta } from '@/shared/stores/engine/applyProjectDeltas';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useTimelineStore } from '@/shared/stores/useTimelineStore';
import {
    createTransportActions,
} from '@/shared/stores/engine/actionsTransport';
import {
    createTrackProjectActions,
} from '@/shared/stores/engine/actionsTrackProject';
import {
    createFetchProjectAction,
} from '@/shared/stores/engine/actionsFetchProject';
import {
    createTelemetryActions,
    markBpmPending,
    readLatestMeters,
} from '@/shared/stores/engine/actionsTelemetry';
import type {
    TransportState,
    MeteringSnapshot,
    ImportAudioResponse,
    ProjectHistoryEvent,
    ProjectDelta,
    PluginSandboxSnapshot,
} from '@/shared/api/engine';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { ProjectTrack } from '@/shared/lib/trackAdapter';
import type { EntityState } from '@/shared/stores/engine/storeHelpers';

export type { ProjectTrack } from '@/shared/lib/trackAdapter';

export interface EngineStore {
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
    performance: { cpuUsage: number; ramUsedMb: number; ramTotalMb: number; processMemoryMb: number; dspLoad: number };
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
    setTrackSendLevel: (trackIndex: number, send: 'A' | 'B', value: number) => Promise<void>;
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

export function getMetersRef(): MeteringSnapshot {
    return readLatestMeters(useEngineStore.getState().meters);
}

function shouldApplyViewportRestore(reason: string): boolean {
    if (!reason) return false;
    return (
        reason === 'file-menu:new'
        || reason === 'native-menu:new'
        || reason === 'project-manager:new'
        || reason.includes(':open')
        || reason.includes('open-last-project')
    );
}

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
    performance: { cpuUsage: 0, ramUsedMb: 0, ramTotalMb: 0, processMemoryMb: 0, dspLoad: 0 },
    keySigEnabled: false,
    keySigTonic: 'C',
    keySigMode: 'Major',
    lastError: null,
    projectHistory: [],
    projectHistoryCursor: 0,
    masterVolume: 1.0,
    pluginSandbox: null,
    openEditorsByTrack: {},

    ...createTransportActions(set, get, markBpmPending),
    ...createTrackProjectActions(set, get),
    ...createFetchProjectAction(set, get),
    ...createTelemetryActions(set, get),

    applyProjectDeltas: async (deltas: ProjectDelta[], reason: string = 'delta') => {
        if (!Array.isArray(deltas) || deltas.length === 0) return;
        let unhandledDeltaKinds: string[] = [];

        const snapshotMeta = extractSnapshotProjectMeta(deltas, get().transport);

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
        if (snapshotMeta) {
            useGridStore.getState().applyProjectGrid({
                numerator: snapshotMeta.grid.numerator,
                denominator: snapshotMeta.grid.denominator,
                ntoles: snapshotMeta.grid.ntoles,
                snapToGrid: snapshotMeta.grid.snapToGrid,
                fixed: snapshotMeta.grid.fixed,
            });
        }

        set((s) => {
            let nextProjectBpm = snapshotMeta?.bpm ?? s.projectBpm;
            const nextProjectSampleRate = snapshotMeta?.sampleRate ?? s.projectSampleRate;
            let nextTransport = s.transport;
            let nextKeySigEnabled = snapshotMeta?.keySigEnabled ?? s.keySigEnabled;
            let nextKeySigTonic = snapshotMeta?.keySigTonic ?? s.keySigTonic;
            let nextKeySigMode = snapshotMeta?.keySigMode ?? s.keySigMode;

            if (snapshotMeta) {
                const loopEnd = snapshotMeta.loopEndFrames > snapshotMeta.loopStartFrames
                    ? snapshotMeta.loopEndFrames
                    : snapshotMeta.loopStartFrames;
                nextTransport = {
                    ...nextTransport,
                    bpm: snapshotMeta.bpm,
                    sample_rate: snapshotMeta.sampleRate,
                    loop_enabled: snapshotMeta.loopEnabled,
                    loop_start: snapshotMeta.loopStartFrames,
                    loop_end: loopEnd,
                };
            }

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

            const { nextState, unhandledDeltaKinds: nextUnhandledDeltaKinds = [] } = applyProjectDeltasToState(s, deltas, reason);
            if (nextUnhandledDeltaKinds.length > 0) {
                unhandledDeltaKinds = nextUnhandledDeltaKinds;
            }
            if (!nextState) {
                if (
                    nextProjectBpm !== s.projectBpm
                    || nextProjectSampleRate !== s.projectSampleRate
                    || nextTransport !== s.transport
                    || nextKeySigEnabled !== s.keySigEnabled
                    || nextKeySigTonic !== s.keySigTonic
                    || nextKeySigMode !== s.keySigMode
                ) {
                    return {
                        projectBpm: nextProjectBpm,
                        projectSampleRate: nextProjectSampleRate,
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
                projectSampleRate: nextProjectSampleRate,
                transport: nextTransport,
                keySigEnabled: nextKeySigEnabled,
                keySigTonic: nextKeySigTonic,
                keySigMode: nextKeySigMode,
            };
        });

        if (unhandledDeltaKinds.length > 0) {
            console.error('[engine-store] unhandled project deltas', {
                reason,
                unhandledDeltaKinds,
            });
            // Force convergence to a canonical state when local delta reducers miss kinds.
            if (!reason.includes(':snapshot-recovery')) {
                try {
                    const snapshot = await engine.getProjectSnapshotDelta();
                    if (Array.isArray(snapshot?.deltas) && snapshot.deltas.length > 0) {
                        await get().applyProjectDeltas(snapshot.deltas, `${reason}:snapshot-recovery`);
                    }
                } catch (recoveryError) {
                    console.error('[engine-store] snapshot recovery failed', {
                        reason,
                        unhandledDeltaKinds,
                        recoveryError,
                    });
                }
            }
        }

        if (snapshotMeta?.viewport && shouldApplyViewportRestore(reason)) {
            const timeline = useTimelineStore.getState();
            const requestedPixelsPerBeat = snapshotMeta.viewport.pixelsPerBeat ?? timeline.pixelsPerBeat;
            const requestedScrollLeft = snapshotMeta.viewport.scrollLeft ?? timeline.scrollLeft;
            const requestedScrollTop = snapshotMeta.viewport.scrollTop ?? timeline.scrollTop;
            const viewportDeltaPx = Math.abs((timeline.scrollLeft ?? 0) - requestedScrollLeft);
            const viewportDeltaZoom = Math.abs((timeline.pixelsPerBeat ?? 20) - requestedPixelsPerBeat);
            const viewportDeltaY = Math.abs((timeline.scrollTop ?? 0) - requestedScrollTop);
            if (viewportDeltaPx > 0.5 || viewportDeltaY > 0.5 || viewportDeltaZoom > 0.0001) {
                timeline.requestViewportRestore(requestedPixelsPerBeat, requestedScrollLeft, requestedScrollTop);
            }
        }
    },

}));
