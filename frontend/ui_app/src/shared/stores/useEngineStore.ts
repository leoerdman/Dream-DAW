import { create } from 'zustand';
import * as engine from '@/shared/api/engine';
import { clampTimeSigNumerator, clampTimeSigDenominator, DEFAULT_BPM, DEFAULT_SAMPLE_RATE } from '@/shared/lib/audioMath';
import { applyProjectDeltasToState, extractSnapshotProjectMeta } from '@/shared/stores/engine/applyProjectDeltas';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useTimelineStore } from '@/shared/stores/useTimelineStore';
import { createTransportActions } from '@/shared/stores/engine/actionsTransport';
import { createTrackProjectActions } from '@/shared/stores/engine/actionsTrackProject';
import { createFetchProjectAction } from '@/shared/stores/engine/actionsFetchProject';
import { sanitizeProjectDeltas } from '@/shared/stores/engine/validateProjectDeltas';

// BUG-A017 FIX: Module-level constant — avoids re-creating a Set on every delta application.
const SNAPSHOT_REASONS = new Set([
    'open', 'open-project', 'last-project', 'last-project:restore',
    'engine:new', 'keyboard:new', 'native-menu:new', 'multi-project:new',
    'auto-recovery:restore', 'project-manager:new-project',
    'multi-project:switch',
]);
import { createTelemetryActions, getLatestMetersSnapshot, setBpmPendingUntil, resetTelemetryPeaks } from '@/shared/stores/engine/actionsTelemetry';
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

export interface ProjectTab {
    id: string;
    name: string;
    filePath: string | null;
    isDirty: boolean; // Tracks unsaved changes per tab
}

export interface EngineStore {
    telemetryRunning: boolean;
    connected: boolean;
    activeProjectId: string | null;
    openProjects: ProjectTab[];
    /** BUG-001: Project dirty flag — true when unsaved changes exist. */
    isDirty: boolean;
    transport: TransportState;
    meters: MeteringSnapshot;
    timelineClips: TimelineClip[];
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
    /** Export/bounce progress from backend `bounce_progress` events. */
    exportProgress: { jobId: string; progress: number; phase: string; status: string } | null;
    performance: { cpuUsage: number; ramUsedMb: number; ramTotalMb: number; processMemoryMb: number; dspLoad: number };
    /** BUG-001: Mark the project as having unsaved changes. */
    markDirty: () => void;
    /** BUG-001: Clear the dirty flag (called after save). */
    clearDirty: () => void;
    setActiveProject: (id: string) => Promise<void>;
    addProjectTab: () => Promise<void>;
    closeProjectTab: (id: string) => Promise<void>;
    setProjectDirtyState: (id: string, isDirty: boolean) => void;
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
    startTelemetryLoop: () => void;
    stopTelemetryLoop: () => void;
    reloadCrashedSandboxPlugins: () => Promise<void>;
    togglePluginEditor: (trackId: string, slotId: string) => Promise<void>;
    closeAllPluginEditors: () => Promise<void>;
    /** Hide native plugin windows for a track (close windows, preserve open set for later restore). */
    hideEditorsForTrack: (trackId: string) => Promise<void>;
    /** Restore native plugin windows for a track (reopen from preserved open set). */
    restoreEditorsForTrack: (trackId: string) => Promise<void>;
    resetMeterPeakHold: (trackIndex: number | 'master') => void;
}
const DEFAULT_TRANSPORT: TransportState = {
    is_playing: false,
    position_frames: 0,
    position_seconds: 0,
    position_beats: 0,
    bpm: DEFAULT_BPM,
    sample_rate: DEFAULT_SAMPLE_RATE,
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
    track_plugin_metrics: [],
    master_left: { ...DEFAULT_METER },
    master_right: { ...DEFAULT_METER },
    master_plugin_metrics: [],
};
export function getMetersRef(): MeteringSnapshot {
    return getLatestMetersSnapshot() ?? useEngineStore.getState().meters;
}
function shouldApplyViewportRestore(reason: string): boolean {
    if (!reason) return false;

    // Allow-list: ONLY restore viewport when actively loading or initializing a project.
    // Normal actions like edit, drag, copy/paste, undo, duplicate should NEVER jump the viewport.
    // ENTERPRISE FIX: Removed 'keyboard-undo', 'keyboard-redo', 'undo', 'redo' —
    // undo/redo restores project STATE but must NOT reset zoom/scroll position.
    const loadPrefixes = [
        'native-menu:new',
        'native-menu:open',
        'native-menu:open-recent',
        'project-manager:new',
        'project-manager:open',
        'engine:init',
        'engine:open',
        'auto-recovery:apply',
        'auto-recovery:resync'
    ];

    return loadPrefixes.some(prefix => reason.startsWith(prefix));
}
export const useEngineStore = create<EngineStore>((set, get) => ({
    telemetryRunning: false,
    connected: false,
    activeProjectId: null,
    openProjects: [], // BUG-051 FIX: Start empty — populated from backend on connect. Old 'default' id mismatched backend UUIDs.
    isDirty: false, // Legacy fallback, to be replaced by tab-specific dirty state
    transport: { ...DEFAULT_TRANSPORT },
    meters: { ...DEFAULT_METERS },
    timelineClips: [],
    clipsById: {},
    clips: { byId: {}, allIds: [] },
    tracks: { byId: {}, allIds: [] },
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
    exportProgress: null,
    // BUG-003 FIX: Avoid O(N) .find() on every markDirty() call.
    // Uses indexed iteration with early-exit instead of full scan.
    markDirty: () => set((s) => {
        if (s.activeProjectId) {
            // First check if already fully dirty
            if (s.isDirty) {
                // Quick check: is the active tab already dirty?
                const byId = s.openProjects;
                let alreadyDirty = false;
                for (let i = 0, len = byId.length; i < len; i++) {
                    if (byId[i].id === s.activeProjectId) {
                        alreadyDirty = byId[i].isDirty;
                        break;
                    }
                }
                if (alreadyDirty) return s; // Both already dirty — no-op
            }
            const tabs = s.openProjects.map(t =>
                t.id === s.activeProjectId ? { ...t, isDirty: true } : t
            );
            return { isDirty: true, openProjects: tabs };
        }
        if (s.isDirty) return s;
        return { isDirty: true };
    }),
    clearDirty: () => set((s) => {
        if (s.activeProjectId) {
            const tabs = s.openProjects.map(t =>
                t.id === s.activeProjectId ? { ...t, isDirty: false } : t
            );
            return { isDirty: false, openProjects: tabs };
        }
        return { isDirty: false };
    }),
    setActiveProject: async (id) => {
        const state = get();
        if (id === state.activeProjectId) return;
        try {
            const response = await engine.switchProjectTab(id);
            // BUG-002 FIX: Set activeProjectId AFTER delta application succeeds.
            // Previously set before — if applyProjectDeltas threw, UI pointed to
            // a tab with no loaded data.
            if (response.deltas?.length) {
                await get().applyProjectDeltas(response.deltas, 'multi-project:switch');
            }
            set({ activeProjectId: id });
        } catch (e) {
            console.error('[MultiProject] switchProjectTab failed:', e);
        }
    },
    addProjectTab: async () => {
        try {
            const response = await engine.createProjectTab();
            const newTab: ProjectTab = {
                id: response.id,
                name: response.name,
                filePath: null,
                isDirty: false,
            };
            set((s) => ({
                openProjects: [...s.openProjects, newTab],
                activeProjectId: response.id,
            }));
            if (response.deltas?.length) {
                await get().applyProjectDeltas(response.deltas, 'multi-project:create');
            }
        } catch (e) {
            console.error('[MultiProject] createProjectTab failed:', e);
        }
    },
    closeProjectTab: async (id) => {
        const state = get();
        if (state.openProjects.length <= 1) return; // Cannot close last tab
        const tab = state.openProjects.find(t => t.id === id);
        // BUG-E007 FIX: Prompt user if trying to close a dirty tab
        // BUG-035 FIX: Use native Tauri dialog instead of window.confirm (enterprise UX).
        if (tab && tab.isDirty) {
            const { ask } = await import('@tauri-apps/plugin-dialog');
            const confirmed = await ask(`Project "${tab.name}" has unsaved changes. Are you sure you want to close it?`, { title: 'Dream DAW', kind: 'warning' });
            if (!confirmed) return;
        }
        try {
            const response = await engine.closeProjectTab(id);
            const remaining = state.openProjects.filter(t => t.id !== id);
            // BUG-004 FIX: `remaining` already excludes `id`, so the .find(t => t.id !== id)
            // was redundant. Just use remaining[0] as first fallback.
            const newActiveId = response.newActiveId
                ?? remaining[0]?.id
                ?? null;
            set({ openProjects: remaining, activeProjectId: newActiveId });
            if (response.deltas?.length) {
                await get().applyProjectDeltas(response.deltas, 'multi-project:close-switch');
            }
        } catch (e) {
            console.error('[MultiProject] closeProjectTab failed:', e);
        }
    },
    setProjectDirtyState: (id, isDirty) => set((s) => ({
        openProjects: s.openProjects.map(t => t.id === id ? { ...t, isDirty } : t)
    })),
    ...createTransportActions(set, get, setBpmPendingUntil),
    ...createTrackProjectActions(set, get),
    ...createFetchProjectAction(set, get),
    ...createTelemetryActions(set, get),
    resetMeterPeakHold: (trackIndex) => resetTelemetryPeaks(trackIndex),
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
            // BUG-017 FIX: Apply grid only ONCE from the most authoritative source.
            // If an ArrangementGridChanged delta exists, it is newer than any
            // snapshot grid — skip the snapshot to prevent double-apply flicker.
            const hasGridDelta = sanitizedDeltas.some(d => d.kind === 'ArrangementGridChanged');
            if (snapshotMeta && !hasGridDelta) {
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
                        // BUG-F010 FIX: SSOT — uses shared clamp functions from audioMath.ts.
                        nextTimeSigNumerator = clampTimeSigNumerator(delta.data.numerator);
                        nextTimeSigDenominator = clampTimeSigDenominator(delta.data.denominator);
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
            // ── ENTERPRISE: Sync AutomationPointsChanged deltas to useAutomationStore ──
            // BUG-FIX: Without this, undo/redo updates the engine store's
            // track.automation_lanes but NOT the automation overlay store,
            // causing the UI to show stale breakpoints.
            const automationDeltas = sanitizedDeltas.filter(
                (d) => d.kind === 'AutomationPointsChanged',
            );
            if (automationDeltas.length > 0) {
                // Lazy import to avoid circular deps and minimize bundle impact.
                import('@/shared/stores/useAutomationStore').then(({ useAutomationStore }) => {
                    const autoState = useAutomationStore.getState();
                    for (const delta of automationDeltas) {
                        const trackId: string = delta.data.track_id;
                        const paramId: string = delta.data.param_id;
                        const deltaPoints: Array<{ beat: number; value: number; curve_type: string; tension: number | null }> = delta.data.points;

                        // Find matching lane in automation store
                        const lane = Object.values(autoState.lanes).find(
                            (l) => l.trackId === trackId && l.paramKey === paramId,
                        );

                        if (lane) {
                            // Update breakpoints from delta
                            const newBreakpoints = deltaPoints.map((p, idx) => ({
                                id: lane.breakpoints[idx]?.id ?? `bp_${Math.random().toString(36).slice(2, 14)}`,
                                beat: p.beat,
                                value: p.value,
                                curve: (p.curve_type === 'step' ? 'step' : p.curve_type === 'bezier' ? 'bezier' : 'linear') as 'linear' | 'bezier' | 'step',
                                tension: p.curve_type === 'bezier' ? (p.tension ?? 0.5) : undefined,
                            }));
                            useAutomationStore.setState((prev) => ({
                                lanes: {
                                    ...prev.lanes,
                                    [lane.id]: {
                                        ...prev.lanes[lane.id],
                                        breakpoints: newBreakpoints,
                                    },
                                },
                            }));
                        }
                    }
                }).catch((err) => {
                    console.error('[engine-store] Failed to sync automation delta to AutomationStore:', err);
                });
            }

            // BUG-001: Mark project dirty for any mutation-type delta.
            // Snapshot replacements (project open) reset dirty; everything else marks dirty.
            // BUG-F015 FIX: Explicit allow-set instead of fragile prefix/suffix matching.
            // BUG-A017 FIX: SNAPSHOT_REASONS is now module-level (zero alloc per call).
            const isSnapshotReason = SNAPSHOT_REASONS.has(reason) || reason.startsWith('multi-project:');
            if (!isSnapshotReason) {
                get().markDirty();
            } else {
                set({ isDirty: false });
            }

            // Sync tab name from snapshot (project open / switch / create)
            // P2 FIX: Reuse snapshotDelta from L530 to avoid duplicate O(N) scan.
            const snapshotDelta = sanitizedDeltas.find(d => d.kind === 'ProjectSnapshotReplaced');
            const snapshotDataObj = snapshotDelta?.data as Record<string, unknown> | undefined;
            const projectObj = snapshotDataObj?.project as { name?: string } | undefined;
            if (projectObj?.name) {
                const activeId = get().activeProjectId;
                if (activeId) {
                    set((s) => ({
                        openProjects: s.openProjects.map(t =>
                            t.id === activeId
                                ? { ...t, name: projectObj!.name!, isDirty: !isSnapshotReason }
                                : t
                        ),
                    }));
                }
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

            // ── ENTERPRISE: Restore automation store lanes from project snapshot ──
            // When a project loads (snapshot replace), automation_lanes from each track
            // need to be synced to useAutomationStore so the UI overlay shows them.
            // P2 FIX: Reuse `snapshotDelta` instead of duplicate O(N) .find() scan.
            if (snapshotDelta) {
                import('@/shared/stores/useAutomationStore').then(({ useAutomationStore }) => {
                    const currentTracks = get().tracks;
                    const newLanes: Record<string, {
                        id: string;
                        trackId: string;
                        paramName: string;
                        paramKey: string;
                        color: string;
                        visible: boolean;
                        breakpoints: Array<{
                            id: string;
                            beat: number;
                            value: number;
                            curve: 'linear' | 'bezier' | 'step';
                            tension?: number;
                            itemId?: string;
                        }>;
                    }> = {};

                    for (const trackId of currentTracks.allIds) {
                        const track = currentTracks.byId[trackId];
                        if (!track || !track.automation_lanes || track.automation_lanes.length === 0) continue;

                        for (const autoLane of track.automation_lanes) {
                            if (!autoLane.points || autoLane.points.length === 0) continue;
                            const laneId = `auto_${trackId.slice(0, 8)}_${autoLane.param_id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`;
                            // Derive a readable param name from the param_id
                            const paramName = autoLane.param_id.charAt(0).toUpperCase() + autoLane.param_id.slice(1).replace(/[._:]/g, ' ');
                            newLanes[laneId] = {
                                id: laneId,
                                trackId,
                                paramName,
                                paramKey: autoLane.param_id,
                                color: track.color || 'var(--token-color-hex-58a6ff)',
                                visible: true,
                                breakpoints: autoLane.points.map((p, idx) => ({
                                    id: `bp_${laneId}_${idx}`,
                                    beat: p.beat,
                                    value: p.value,
                                    curve: (p.curve_type === 'step' ? 'step' : p.curve_type === 'bezier' ? 'bezier' : 'linear') as 'linear' | 'bezier' | 'step',
                                    tension: p.curve_type === 'bezier' ? (p.tension ?? 0.5) : undefined,
                                })),
                            };
                        }
                    }

                    if (Object.keys(newLanes).length > 0) {
                        useAutomationStore.setState({
                            lanes: newLanes,
                            // Don't auto-show — user toggles via "A" key
                        });
                    }
                }).catch((err) => {
                    console.error('[engine-store] Failed to restore automation lanes from snapshot:', err);
                });
            }
        } catch (err) {
            // BUG-010: Error boundary — catch and report any crash in delta application.
            console.error('[engine-store] CRITICAL: applyProjectDeltas crashed', err);
            set({ lastError: `Delta application failed: ${err instanceof Error ? err.message : String(err)}` });
        }
    },
}));
