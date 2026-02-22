import { useCallback, useEffect, useMemo } from 'react';
import * as engineApi from '@/shared/api/engine';
import { scrollSync } from '@/shared/lib/useScrollSync';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import type { ProjectDelta } from '@/shared/api/engine';

type Args = {
    projectTracksSnapshot: ProjectTrack[];
    hiddenTrackIndices: Set<number>;
    selectedTrackIdRef: React.MutableRefObject<string>;
    selectedTrackIdsRef: React.MutableRefObject<string[]>;
    applyProjectDeltas: (deltas: ProjectDelta[], reason?: string) => Promise<void>;
};

type Result = {
    trackHeightBase: number;
    timelineTrackHeights: number[];
    resetTrackHeights: () => void;
};

const TRACK_HEIGHT_DEFAULT = 48;
const TRACK_HEIGHT_MIN = 24;
const TRACK_HEIGHT_MAX = 120;
const TRACK_HEIGHT_STEP = 1;
const TRACK_HEIGHT_BASE = TRACK_HEIGHT_DEFAULT;
const RULER_HEIGHT = 28;

export function useTrackHeightControls({
    projectTracksSnapshot,
    hiddenTrackIndices,
    selectedTrackIdRef,
    selectedTrackIdsRef,
    applyProjectDeltas,
}: Args): Result {
    const clampTrackHeight = useCallback((height: number) => {
        const snapped = Math.round(height / TRACK_HEIGHT_STEP) * TRACK_HEIGHT_STEP;
        return Math.max(TRACK_HEIGHT_MIN, Math.min(TRACK_HEIGHT_MAX, snapped));
    }, []);

    const resolveHeightTargetTrackIds = useCallback((target: EventTarget | null, clientY?: number) => {
        const element = target instanceof Element ? target : null;

        const inspectorRow = element?.closest?.('[data-track-row="true"][data-track-id]') as HTMLElement | null;
        const inspectorTrackId = inspectorRow?.getAttribute('data-track-id');
        if (inspectorTrackId && inspectorTrackId !== 'master') {
            return [inspectorTrackId];
        }

        const state = useEngineStore.getState();
        const tracks = state.projectTracks;
        const selectedTrackIds = selectedTrackIdsRef.current;
        const selectedTrackId = selectedTrackIdRef.current;

        const timelineRoot = element?.closest?.('[data-testid="timeline-view"]') as HTMLElement | null;
        if (timelineRoot && Number.isFinite(clientY)) {
            const rect = timelineRoot.getBoundingClientRect();
            const yInViewport = (clientY as number) - rect.top;
            const yInTracks = yInViewport - RULER_HEIGHT + scrollSync.scrollY;
            if (yInTracks >= 0) {
                let acc = 0;
                for (const track of tracks) {
                    if (!track?.id || track.id === 'master') continue;
                    const h = clampTrackHeight(typeof track.height === 'number' ? track.height : TRACK_HEIGHT_DEFAULT);
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
    }, [clampTrackHeight, selectedTrackIdRef, selectedTrackIdsRef]);

    const applyTrackHeightsOptimistic = useCallback((trackIds: string[], height: number) => {
        if (trackIds.length === 0) return;
        const idSet = new Set(trackIds);
        useEngineStore.setState((state) => {
            const nextTracks = state.projectTracks.map((track) => (idSet.has(track.id) ? { ...track, height } : track));
            const nextById = Object.fromEntries(nextTracks.map((t) => [t.id, t]));
            return {
                projectTracks: nextTracks,
                tracksById: nextById,
                tracks: {
                    byId: nextById,
                    allIds: state.tracks.allIds,
                },
            };
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
            const current = projectTracksSnapshot.find((t) => t.id === trackIds[0]);
            const currentHeight = clampTrackHeight(typeof current?.height === 'number' ? current.height : TRACK_HEIGHT_DEFAULT);
            const nextHeight = clampTrackHeight(currentHeight + direction * TRACK_HEIGHT_STEP * steps);
            if (nextHeight === currentHeight) return;

            applyTrackHeightsOptimistic(trackIds, nextHeight);
            void Promise.all(
                trackIds.map((id) =>
                    engineApi
                        .setTrackHeightWithDeltas(id, nextHeight)
                        .then((response) => applyProjectDeltas(response.deltas, 'daw-shell:set-track-height-wheel')),
                ),
            ).catch((err) => {
                console.warn('[DawShell] setTrackHeight failed:', err);
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
            if (!e.altKey || e.key !== '0') return;
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName?.toLowerCase();
            const isTextInput = tag === 'input' || tag === 'textarea' || target?.isContentEditable;
            if (isTextInput) return;

            e.preventDefault();
            const trackIds = resolveHeightTargetTrackIds(e.target);
            if (trackIds.length === 0) return;
            const nextHeight = clampTrackHeight(TRACK_HEIGHT_DEFAULT);
            applyTrackHeightsOptimistic(trackIds, nextHeight);
            void Promise.all(
                trackIds.map((id) =>
                    engineApi
                        .setTrackHeightWithDeltas(id, nextHeight)
                        .then((response) => applyProjectDeltas(response.deltas, 'daw-shell:set-track-height-reset-selected')),
                ),
            ).catch((err) => {
                console.warn('[DawShell] setTrackHeight reset failed:', err);
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
    }, [applyProjectDeltas, applyTrackHeightsOptimistic, clampTrackHeight, projectTracksSnapshot, resolveHeightTargetTrackIds]);

    const timelineTrackHeights = useMemo(() => {
        const clamp = (h: number) => Math.max(TRACK_HEIGHT_MIN, Math.min(TRACK_HEIGHT_MAX, Math.round(h)));
        return projectTracksSnapshot.map((track, idx) => {
            if (hiddenTrackIndices.has(idx)) return 0;
            const persisted = Number.isFinite(track.height) ? track.height : TRACK_HEIGHT_BASE;
            return clamp(persisted);
        });
    }, [projectTracksSnapshot, hiddenTrackIndices]);

    const resetTrackHeights = useCallback(() => {
        const trackIds = projectTracksSnapshot.map((track) => track.id).filter((id) => id && id !== 'master');
        if (trackIds.length === 0) return;
        const nextHeight = clampTrackHeight(TRACK_HEIGHT_DEFAULT);
        applyTrackHeightsOptimistic(trackIds, nextHeight);
        void Promise.all(
            trackIds.map((id) =>
                engineApi
                    .setTrackHeightWithDeltas(id, nextHeight)
                    .then((response) => applyProjectDeltas(response.deltas, 'daw-shell:set-track-height-reset-all')),
            ),
        ).catch((err) => {
            console.warn('[DawShell] reset track heights failed:', err);
        });
    }, [applyProjectDeltas, applyTrackHeightsOptimistic, clampTrackHeight, projectTracksSnapshot]);

    return {
        trackHeightBase: TRACK_HEIGHT_BASE,
        timelineTrackHeights,
        resetTrackHeights,
    };
}
