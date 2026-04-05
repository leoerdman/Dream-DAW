import { useCallback, useEffect, useMemo } from 'react';
import * as engineApi from '@/shared/api/engine';
import { scrollSync } from '@/shared/lib/useScrollSync';
import {
    TIMELINE_RULER_HEIGHT_PX,
    TRACK_HEIGHT_DEFAULT_PX,
    AUTOMATION_LANE_HEIGHT_PX,
    clampTrackHeightPx,
} from '@/shared/config/layoutConstants';
import {
    snapToTrackHeightLevel,
    nextTrackHeightLevel,
} from '@/shared/config/trackHeightLevels';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { buildTrackStatePatch } from '@/shared/stores/engine/storeHelpers';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import type { ProjectDelta } from '@/shared/api/engine';
import type { EntityState } from '@/shared/stores/engine/storeHelpers';
import type { AutomationLane } from '@/shared/stores/useAutomationStore';

type Args = {
    tracksEntitySnapshot: EntityState<ProjectTrack>;
    hiddenTrackIndices: Set<number>;
    selectedTrackIdRef: React.MutableRefObject<string>;
    selectedTrackIdsRef: React.MutableRefObject<string[]>;
    applyProjectDeltas: (deltas: ProjectDelta[], reason?: string) => Promise<void>;
    automationVisible: boolean;
    lanes: Record<string, AutomationLane>;
};

type Result = {
    trackHeightBase: number;
    timelineTrackHeights: number[];
    resetTrackHeights: () => void;
};

const TRACK_HEIGHT_BASE = TRACK_HEIGHT_DEFAULT_PX;

export function useTrackHeightControls({
    tracksEntitySnapshot,
    hiddenTrackIndices,
    selectedTrackIdRef,
    selectedTrackIdsRef,
    applyProjectDeltas,
    automationVisible,
    lanes,
}: Args): Result {
    const trackIdsSnapshot = tracksEntitySnapshot.allIds;
    const tracksByIdSnapshot = tracksEntitySnapshot.byId;

    const clampTrackHeight = useCallback((height: number) => {
        return snapToTrackHeightLevel(height).height;
    }, []);

    const resolveHeightTargetTrackIds = useCallback((target: EventTarget | null, clientY?: number) => {
        const element = target instanceof Element ? target : null;

        const inspectorRow = element?.closest?.('[data-track-row="true"][data-track-id]') as HTMLElement | null;
        const inspectorTrackId = inspectorRow?.getAttribute('data-track-id');
        if (inspectorTrackId && inspectorTrackId !== 'master') {
            return [inspectorTrackId];
        }

        const state = useEngineStore.getState();
        const tracks = state.tracks.allIds
            .map((trackId) => state.tracks.byId[trackId])
            .filter((track): track is ProjectTrack => Boolean(track));
        const selectedTrackIds = selectedTrackIdsRef.current;
        const selectedTrackId = selectedTrackIdRef.current;

        const timelineRoot = element?.closest?.('[data-testid="timeline-view"]') as HTMLElement | null;
        if (timelineRoot && Number.isFinite(clientY)) {
            const rect = timelineRoot.getBoundingClientRect();
            const yInViewport = (clientY as number) - rect.top;
            const yInTracks = yInViewport - TIMELINE_RULER_HEIGHT_PX + scrollSync.scrollY;
            if (yInTracks >= 0) {
                let acc = 0;
                for (let i = 0; i < tracks.length; i += 1) {
                    if (hiddenTrackIndices.has(i)) continue;
                    const track = tracks[i];
                    if (!track?.id || track.id === 'master') continue;
                    const h = clampTrackHeight(typeof track.height === 'number' ? track.height : TRACK_HEIGHT_DEFAULT_PX);
                    const nextAcc = acc + h;
                    if (yInTracks < nextAcc) return [track.id];
                    acc = nextAcc;
                }
            }
        }

        const selected = selectedTrackIds.filter((id) => id && id !== 'master');
        if (selected.length > 0) return [selected[selected.length - 1]];
        if (selectedTrackId && selectedTrackId !== 'master') return [selectedTrackId];
        return [];
    }, [clampTrackHeight, hiddenTrackIndices, selectedTrackIdRef, selectedTrackIdsRef]);

    const applyTrackHeightsOptimistic = useCallback((trackIds: string[], height: number) => {
        if (trackIds.length === 0) return;
        useEngineStore.setState((state) => {
            const nextById = { ...state.tracks.byId };
            for (const trackId of trackIds) {
                const track = nextById[trackId];
                if (!track) continue;
                nextById[trackId] = { ...track, height };
            }
            return buildTrackStatePatch(state.tracks.allIds, nextById);
        });
    }, []);

    useEffect(() => {
        const WHEEL_STEP_THRESHOLD = 40;
        let wheelAccumulator = 0;
        let wheelRafId = 0;
        let lastWheelEventTarget: EventTarget | null = null;
        let lastWheelClientY = 0;

        const flushWheelZoom = () => {
            wheelRafId = 0;
            const steps = Math.floor(Math.abs(wheelAccumulator) / WHEEL_STEP_THRESHOLD);
            if (steps <= 0) return;

            const direction = wheelAccumulator < 0 ? 1 : -1;
            wheelAccumulator -= Math.sign(wheelAccumulator) * steps * WHEEL_STEP_THRESHOLD;

            const trackIds = resolveHeightTargetTrackIds(lastWheelEventTarget, lastWheelClientY);
            if (trackIds.length === 0) return;
            const current = tracksByIdSnapshot[trackIds[0]];
            const currentHeight = clampTrackHeight(typeof current?.height === 'number' ? current.height : TRACK_HEIGHT_DEFAULT_PX);

            // Step one level at a time via discrete level snapping
            let targetHeight = currentHeight;
            for (let i = 0; i < steps; i++) {
                targetHeight = nextTrackHeightLevel(targetHeight, direction as 1 | -1);
            }
            if (targetHeight === currentHeight) return;

            applyTrackHeightsOptimistic(trackIds, targetHeight);
            void Promise.all(
                trackIds.map((id) =>
                    engineApi
                        .setTrackHeightWithDeltas(id, targetHeight)
                        .then((response) => applyProjectDeltas(response.deltas, 'daw-shell:set-track-height-wheel')),
                ),
            ).catch((err) => {
                console.warn('[Dream] setTrackHeight failed:', err);
                useStatusStore.getState().setError(`Track height change failed: ${err instanceof Error ? err.message : String(err)}`);
            });
        };

        const onWheel = (e: WheelEvent) => {
            if (!e.altKey) return;
            const target = e.target as HTMLElement | null;
            const inTimeline = !!target?.closest?.('[data-testid="timeline-view"]');
            const inInspector = !!target?.closest?.('[data-testid="track-inspector"]');
            if (!inTimeline && !inInspector) return;
            e.preventDefault();
            e.stopPropagation();

            lastWheelEventTarget = e.target;
            lastWheelClientY = e.clientY;

            wheelAccumulator += e.deltaY;
            if (!wheelRafId) {
                wheelRafId = window.requestAnimationFrame(flushWheelZoom);
            }
        };

        const onKeyDown = (e: KeyboardEvent) => {
            if (!e.altKey || (e.code !== 'Digit0' && e.code !== 'Numpad0')) return;
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName?.toLowerCase();
            const isTextInput = tag === 'input' || tag === 'textarea' || target?.isContentEditable;
            if (isTextInput) return;

            e.preventDefault();
            const trackIds = resolveHeightTargetTrackIds(e.target);
            if (trackIds.length === 0) return;
            const nextHeight = clampTrackHeight(TRACK_HEIGHT_DEFAULT_PX);
            applyTrackHeightsOptimistic(trackIds, nextHeight);
            void Promise.all(
                trackIds.map((id) =>
                    engineApi
                        .setTrackHeightWithDeltas(id, nextHeight)
                        .then((response) => applyProjectDeltas(response.deltas, 'daw-shell:set-track-height-reset-selected')),
                ),
            ).catch((err) => {
                console.warn('[Dream] setTrackHeight reset failed:', err);
                useStatusStore.getState().setError(`Track height reset failed: ${err instanceof Error ? err.message : String(err)}`);
            });
        };

        window.addEventListener('wheel', onWheel, { passive: false, capture: true });
        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => {
            window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
            window.removeEventListener('keydown', onKeyDown, { capture: true } as EventListenerOptions);
            if (wheelRafId) {
                window.cancelAnimationFrame(wheelRafId);
            }
        };
    }, [applyProjectDeltas, applyTrackHeightsOptimistic, clampTrackHeight, tracksByIdSnapshot, resolveHeightTargetTrackIds]);

    const timelineTrackHeights = useMemo(() => {
        // PERF-011: Pre-compute per-track visible lane count ONCE = O(L).
        // Previously did Object.values(lanes).filter(l => l.trackId === trackId)
        // inside the per-track map loop = O(N×L). With 38 tracks × 38 lanes,
        // that's 1,444 iterations per render.
        let visibleLaneCountByTrack: Map<string, number> | null = null;
        if (automationVisible) {
            visibleLaneCountByTrack = new Map();
            for (const lane of Object.values(lanes)) {
                if (!lane.visible) continue;
                visibleLaneCountByTrack.set(
                    lane.trackId,
                    (visibleLaneCountByTrack.get(lane.trackId) ?? 0) + 1,
                );
            }
        }

        return trackIdsSnapshot.map((trackId, idx) => {
            if (hiddenTrackIndices.has(idx)) return 0;
            const track = tracksByIdSnapshot[trackId];
            const persisted = Number.isFinite(track.height) ? track.height : TRACK_HEIGHT_BASE;

            // ENTERPRISE FIX: Add automation lane heights so Timeline perfectly syncs with TrackInspector
            let additionalHeight = 0;
            if (visibleLaneCountByTrack) {
                const count = visibleLaneCountByTrack.get(trackId) ?? 0;
                if (count > 0) {
                    additionalHeight = Math.max(0, count - 1) * AUTOMATION_LANE_HEIGHT_PX;
                }
            }

            return clampTrackHeightPx(persisted) + additionalHeight;
        });
    }, [trackIdsSnapshot, tracksByIdSnapshot, hiddenTrackIndices, automationVisible, lanes]);

    const resetTrackHeights = useCallback(() => {
        const trackIds = trackIdsSnapshot.filter((id) => id && id !== 'master');
        if (trackIds.length === 0) return;
        const nextHeight = clampTrackHeight(TRACK_HEIGHT_DEFAULT_PX);
        applyTrackHeightsOptimistic(trackIds, nextHeight);
        // Notify UI consumers (TrackInspector local row overrides, etc.) to
        // drop transient per-row heights and realign from engine state.
        window.dispatchEvent(new Event('dream:track-heights-reset'));
        void Promise.all(
            trackIds.map((id) =>
                engineApi
                    .setTrackHeightWithDeltas(id, nextHeight)
                    .then((response) => applyProjectDeltas(response.deltas, 'daw-shell:set-track-height-reset-all')),
            ),
        ).catch((err) => {
            console.warn('[Dream] reset track heights failed:', err);
            useStatusStore.getState().setError(`Reset track heights failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }, [applyProjectDeltas, applyTrackHeightsOptimistic, clampTrackHeight, trackIdsSnapshot]);

    return {
        trackHeightBase: TRACK_HEIGHT_BASE,
        timelineTrackHeights,
        resetTrackHeights,
    };
}
