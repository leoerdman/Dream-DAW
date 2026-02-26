import { create } from 'zustand';
import * as engine from '@/shared/api/engine';
import { applyProjectDeltasToState, extractSnapshotProjectMeta } from '@/shared/stores/engine/applyProjectDeltas';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useTimelineStore } from '@/shared/stores/useTimelineStore';
import { createTransportActions } from '@/shared/stores/engine/actionsTransport';
import { createTrackProjectActions } from '@/shared/stores/engine/actionsTrackProject';
import { createFetchProjectAction } from '@/shared/stores/engine/actionsFetchProject';
import { sanitizeProjectDeltas } from '@/shared/stores/engine/validateProjectDeltas';
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
// ── BUG-042: Viewport restore epsilon constants ────────────────────────
const VIEWPORT_POSITION_EPSILON = 0.5;
const VIEWPORT_ZOOM_EPSILON = 0.0001;

export interface EngineStore {
    telemetryRunning: boolean;
    connected: boolean;
    /** BUG-001: Project dirty flag — true when unsaved changes exist. */
    isDirty: boolean;
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
    timeSigNumerator: number;
    timeSigDenominator: number;
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
    /** BUG-001: Mark the project as having unsaved changes. */
    markDirty: () => void;
    /** BUG-001: Clear the dirty flag (called after save). */
    clearDirty: () => void;
    togglePlay: () => Promise<void>;
    play: () => Promise<void>;
    stop: () => Promise<void>;
    setBpm: (bpm: number) => Promise<void>;
    setTimeSignature: (numerator: number, denominator: number) => Promise<void>;
    seekSeconds: (seconds: number) => Promise<void>;
    seekToBeat: (beat: number) => Promise<void>;
    setLoop: (enabled: boolean, startFrames: number, endFrames: number) => Promise<void>;
    setFrequency: (freq: number) => Promise<void>;
    setTrackVolume: (trackIndex: number, volume: number) => Promise<void>;
    setTrackPan: (trackIndex: number, pan: number) => Promise<void>;
    setTrackSendLevel: (trackIndex: number, send: 'A' | 'B', value: number) => Promise<void>;
    setMasterVolume: (volume: number) => Promise<void>;
    flushTrackControlFinals: () => Promise<void>;
    setTrackDisabled: (trackIndex: number, disabled: boolean) => Promise<void>;
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
    time_sig_numerator: 4,
    time_sig_denominator: 4,
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
    // Deny-list: only skip viewport restore for NEW projects (blank canvas).
    // All other reasons (open, open-recent, last-project, auto-recovery:resync, etc.)
    // should restore the viewport from the project file.
    const isNewProject = reason.endsWith(':new') || reason.includes(':new-project');
    return !isNewProject;
}
export const useEngineStore = create<EngineStore>((set, get) => ({
    telemetryRunning: false,
    connected: false,
    isDirty: false, // BUG-001: Project dirty flag
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
    timeSigNumerator: 4,
    timeSigDenominator: 4,
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
    // BUG-001: Dirty flag actions
    markDirty: () => set((s) => s.isDirty ? s : { isDirty: true }),
    clearDirty: () => set({ isDirty: false }),
    ...createTransportActions(set, get, markBpmPending),
    ...createTrackProjectActions(set, get),
    ...createFetchProjectAction(set, get),
    ...createTelemetryActions(set, get),
    applyProjectDeltas: async (deltas: ProjectDelta[], reason: string = 'delta') => {
        try { // BUG-010: Error boundary wrapping entire delta application
            const sanitizedDeltas = sanitizeProjectDeltas(deltas);
            if (sanitizedDeltas.length === 0) return;
            if (sanitizedDeltas.length !== deltas.length) {
                // BUG-041: Downgrade to warn — dropped deltas are not unrecoverable errors.
                console.warn('[engine-store] dropped malformed deltas', {
                    reason,
                    received: deltas.length,
                    accepted: sanitizedDeltas.length,
                });
            }
            let unhandledDeltaKinds: string[] = [];
            const snapshotMeta = extractSnapshotProjectMeta(sanitizedDeltas, get().transport);
            // BUG-C017 FIX: Apply grid only ONCE from the authoritative source.
            // Previously, ArrangementGridChanged deltas were applied here AND again
            // from snapshotMeta, causing grid settings to flicker on full snapshots.
            // Now: snapshot grid wins (it's more recent), then individual deltas
            // override if present (they are newer than any snapshot).
            if (snapshotMeta) {
                useGridStore.getState().applyProjectGrid({
                    numerator: snapshotMeta.grid.numerator,
                    denominator: snapshotMeta.grid.denominator,
                    ntoles: snapshotMeta.grid.ntoles,
                    snapToGrid: snapshotMeta.grid.snapToGrid,
                    fixed: snapshotMeta.grid.fixed,
                });
            }
            for (const delta of sanitizedDeltas) {
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
                let nextProjectBpm = snapshotMeta?.bpm ?? s.projectBpm;
                const nextProjectSampleRate = snapshotMeta?.sampleRate ?? s.projectSampleRate;
                let nextTransport = s.transport;
                let nextTimeSigNumerator = snapshotMeta?.timeSigNumerator ?? s.timeSigNumerator;
                let nextTimeSigDenominator = snapshotMeta?.timeSigDenominator ?? s.timeSigDenominator;
                let nextKeySigEnabled = snapshotMeta?.keySigEnabled ?? s.keySigEnabled;
                let nextKeySigTonic = snapshotMeta?.keySigTonic ?? s.keySigTonic;
                let nextKeySigMode = snapshotMeta?.keySigMode ?? s.keySigMode;
                if (snapshotMeta) {
                    // BUG-034: If loopEnd <= loopStart, enforce a minimum 1-frame loop
                    // instead of creating a zero-length loop that produces empty buffers.
                    const loopEnd = snapshotMeta.loopEndFrames > snapshotMeta.loopStartFrames
                        ? snapshotMeta.loopEndFrames
                        : snapshotMeta.loopStartFrames + 1;
                    nextTransport = {
                        ...nextTransport,
                        bpm: snapshotMeta.bpm,
                        sample_rate: snapshotMeta.sampleRate,
                        loop_enabled: snapshotMeta.loopEnabled,
                        loop_start: snapshotMeta.loopStartFrames,
                        loop_end: loopEnd,
                        time_sig_numerator: snapshotMeta.timeSigNumerator,
                        time_sig_denominator: snapshotMeta.timeSigDenominator,
                    };
                }
                // BUG-016 FIX: Accumulate transport mutations into a single mutable
                // patch. Previously, each TempoChanged/LoopRegionChanged/TimeSignatureChanged
                // delta created a new spread object — N deltas = N intermediate objects.
                let transportPatched = false;
                const transportPatch: Record<string, unknown> = {};
                for (const delta of sanitizedDeltas) {
                    if (delta.kind === 'TempoChanged') {
                        nextProjectBpm = delta.data.bpm;
                        transportPatch.bpm = delta.data.bpm;
                        transportPatched = true;
                    } else if (delta.kind === 'LoopRegionChanged') {
                        transportPatch.loop_enabled = delta.data.enabled;
                        transportPatch.loop_start = delta.data.start;
                        transportPatch.loop_end = delta.data.end;
                        transportPatched = true;
                    } else if (delta.kind === 'KeySignatureChanged') {
                        nextKeySigEnabled = delta.data.enabled;
                        nextKeySigTonic = delta.data.tonic;
                        nextKeySigMode = delta.data.mode;
                    } else if (delta.kind === 'TimeSignatureChanged') {
                        nextTimeSigNumerator = Math.max(1, Math.min(32, delta.data.numerator));
                        nextTimeSigDenominator = Math.max(1, Math.min(32, delta.data.denominator));
                        transportPatch.time_sig_numerator = nextTimeSigNumerator;
                        transportPatch.time_sig_denominator = nextTimeSigDenominator;
                        transportPatched = true;
                    }
                }
                if (transportPatched) {
                    nextTransport = { ...nextTransport, ...transportPatch };
                }
                const { nextState, unhandledDeltaKinds: nextUnhandledDeltaKinds = [] } = applyProjectDeltasToState(s, sanitizedDeltas, reason);
                if (nextUnhandledDeltaKinds.length > 0) {
                    unhandledDeltaKinds = nextUnhandledDeltaKinds;
                }
                if (!nextState) {
                    if (
                        nextProjectBpm !== s.projectBpm
                        || nextProjectSampleRate !== s.projectSampleRate
                        || nextTransport !== s.transport
                        || nextTimeSigNumerator !== s.timeSigNumerator
                        || nextTimeSigDenominator !== s.timeSigDenominator
                        || nextKeySigEnabled !== s.keySigEnabled
                        || nextKeySigTonic !== s.keySigTonic
                        || nextKeySigMode !== s.keySigMode
                    ) {
                        return {
                            projectBpm: nextProjectBpm,
                            projectSampleRate: nextProjectSampleRate,
                            transport: nextTransport,
                            timeSigNumerator: nextTimeSigNumerator,
                            timeSigDenominator: nextTimeSigDenominator,
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
                    timeSigNumerator: nextTimeSigNumerator,
                    timeSigDenominator: nextTimeSigDenominator,
                    keySigEnabled: nextKeySigEnabled,
                    keySigTonic: nextKeySigTonic,
                    keySigMode: nextKeySigMode,
                };
            });
            // BUG-001: Mark project dirty for any mutation-type delta.
            // Snapshot replacements (project open) reset dirty; everything else marks dirty.
            const isSnapshotReason = reason.startsWith('open') || reason.startsWith('last-project') || reason.endsWith(':new') || reason.includes(':new-project');
            if (!isSnapshotReason) {
                get().markDirty();
            } else {
                set({ isDirty: false });
            }
            if (unhandledDeltaKinds.length > 0) {
                // BUG-041: Downgrade to warn — unhandled deltas are non-fatal.
                console.warn('[engine-store] unhandled project deltas', {
                    reason,
                    unhandledDeltaKinds,
                });
            }
            if (snapshotMeta?.viewport && shouldApplyViewportRestore(reason)) {
                const timeline = useTimelineStore.getState();
                const requestedPixelsPerBeat = snapshotMeta.viewport.pixelsPerBeat ?? timeline.pixelsPerBeat;
                const requestedScrollLeft = snapshotMeta.viewport.scrollLeft ?? timeline.scrollLeft;
                const requestedScrollTop = snapshotMeta.viewport.scrollTop ?? timeline.scrollTop;
                const viewportDeltaPx = Math.abs((timeline.scrollLeft ?? 0) - requestedScrollLeft);
                const viewportDeltaZoom = Math.abs((timeline.pixelsPerBeat ?? 20) - requestedPixelsPerBeat);
                const viewportDeltaY = Math.abs((timeline.scrollTop ?? 0) - requestedScrollTop);
                // BUG-042: Use named constants instead of magic numbers.
                if (viewportDeltaPx > VIEWPORT_POSITION_EPSILON || viewportDeltaY > VIEWPORT_POSITION_EPSILON || viewportDeltaZoom > VIEWPORT_ZOOM_EPSILON) {
                    timeline.requestViewportRestore(requestedPixelsPerBeat, requestedScrollLeft, requestedScrollTop);
                }
            }
        } catch (err) {
            // BUG-010: Error boundary — catch and report any crash in delta application.
            console.error('[engine-store] CRITICAL: applyProjectDeltas crashed', err);
            set({ lastError: `Delta application failed: ${err instanceof Error ? err.message : String(err)}` });
        }
    },
}));
