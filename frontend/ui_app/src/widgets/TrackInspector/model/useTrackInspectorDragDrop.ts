import { useCallback, useEffect, useRef, useState } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { scrollSync } from '@/shared/lib/useScrollSync';
import { dreamGlobals } from '@/shared/lib/dreamGlobals';
import type { TrackData } from '@/widgets/TrackInspector/model/trackModels';
import {
    canDropTrackIntoGroup,
    computeGroupInsertIndex,
    computeRawInsertIndex,
    computeVisibleInsertIndexFromClientY,
    resolveDropTargetFromClientY,
} from '@/widgets/TrackInspector/model/trackInspectorDragDropHelpers';
import { autoDeleteEmptyGroup } from '@/widgets/TrackInspector/model/trackGroupCleanup';

interface UseTrackInspectorDragDropArgs {
    tracks: TrackData[];
    visibleTracks: TrackData[];
    scrollRef: React.RefObject<HTMLDivElement | null>;
}

export function useTrackInspectorDragDrop({
    tracks,
    visibleTracks,
    scrollRef,
}: UseTrackInspectorDragDropArgs) {
    const dragPointerYRef = useRef<number | null>(null);
    const autoScrollRafRef = useRef<number | null>(null);
    const trackMoveInFlightRef = useRef(false);
    const suppressNextClickRef = useRef(false);
    const trackRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const draggingTrackIdRef = useRef<string | null>(null);

    const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null);
    const [dropInsertIndex, setDropInsertIndex] = useState<number | null>(null);
    const [groupDropTargetId, setGroupDropTargetId] = useState<string | null>(null);
    const [pointerDrag, setPointerDrag] = useState<{
        trackId: string;
        startX: number;
        startY: number;
        active: boolean;
    } | null>(null);

    const computeRawInsert = useCallback(
        (visibleInsertIndex: number) => computeRawInsertIndex(tracks, visibleTracks, visibleInsertIndex),
        [tracks, visibleTracks],
    );

    const canDropIntoGroup = useCallback(
        (trackId: string, groupId: string) => canDropTrackIntoGroup(tracks, trackId, groupId),
        [tracks],
    );

    const resetTrackDragState = useCallback(() => {
        draggingTrackIdRef.current = null;
        setDropInsertIndex(null);
        setGroupDropTargetId(null);
        setDraggingTrackId(null);
        dreamGlobals.setInAppDrag(false);
    }, []);

    const commitTrackReorder = useCallback((trackId: string, visibleInsertIndex: number) => {
        const draggingTrack = tracks.find((t) => t.id === trackId);
        const fullIndex = tracks.findIndex((t) => t.id === trackId);
        if (fullIndex < 0) return;

        const rawInsertIndex = computeRawInsert(visibleInsertIndex);
        const adjustedInsert = rawInsertIndex > fullIndex ? rawInsertIndex - 1 : rawInsertIndex;
        const clamped = Math.max(0, Math.min(tracks.length - 1, adjustedInsert));
        if (clamped === fullIndex && !draggingTrack?.groupId) return;
        if (trackMoveInFlightRef.current) return;

        const oldGroupId = draggingTrack?.groupId ?? null;
        trackMoveInFlightRef.current = true;

        // ENTERPRISE: When the track has a parent group, use moveTrackWithParent
        // with null parentGroupId to clear the group assignment (drag-out-of-group).
        // When no parent, use the simpler moveTrackToIndex for plain reorder.
        const movePromise = oldGroupId
            ? engineApi.moveTrackWithParentWithDeltas(trackId, clamped, null)
            : engineApi.moveTrackToIndexWithDeltas(trackId, clamped);

        void movePromise
            .then(async (response) => {
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:move-track');
                // SSOT: Auto-delete empty group after drag-out.
                await autoDeleteEmptyGroup(oldGroupId);
            })
            .catch((err) => {
                console.error('[Dream] moveTrack(reorder) failed:', err);
            })
            .finally(() => {
                trackMoveInFlightRef.current = false;
            });
    }, [tracks, computeRawInsert]);

    const commitDraggedTrackToVisibleIndex = useCallback((dragId: string, visibleIndex: number) => {
        const draggingTrack = tracks.find((t) => t.id === dragId);
        if (!draggingTrack) return;

        if (draggingTrack.type === 'group') {
            const rawInsertIndex = computeRawInsert(visibleIndex);
            void engineApi.moveTrackBlockToIndexWithDeltas(dragId, rawInsertIndex)
                .then(async (response) => {
                    await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:move-group-block');
                })
                .catch((err) => {
                    console.error('[Dream] moveTrackBlockToIndex failed:', err);
                });
            return;
        }

        commitTrackReorder(dragId, visibleIndex);
    }, [tracks, computeRawInsert, commitTrackReorder]);

    const commitTrackToGroup = useCallback((trackId: string, groupId: string, visibleInsertIndex: number | null = null) => {
        if (!canDropIntoGroup(trackId, groupId) || trackMoveInFlightRef.current) return;

        const draggingTrack = tracks.find((t) => t.id === trackId);
        const targetIndex = computeGroupInsertIndex(tracks, trackId, groupId, visibleInsertIndex, computeRawInsert);
        const dragIndex = tracks.findIndex((t) => t.id === trackId);

        if (dragIndex >= 0) {
            const noOpIndex = targetIndex > dragIndex ? targetIndex - 1 : targetIndex;
            if (dragIndex === noOpIndex && draggingTrack?.groupId === groupId) return;
        }

        // Capture source group before move for auto-delete check
        const oldGroupId = draggingTrack?.groupId ?? null;
        const isChangingGroup = oldGroupId !== null && oldGroupId !== groupId;

        trackMoveInFlightRef.current = true;
        void engineApi.moveTrackWithParentWithDeltas(trackId, targetIndex, groupId)
            .then(async (response) => {
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:move-to-group');
                // SSOT: Auto-delete empty source group after moving between groups.
                if (isChangingGroup) await autoDeleteEmptyGroup(oldGroupId);
            })
            .catch((err) => {
                console.error('[Dream] moveTrackWithParent(group drop) failed:', err);
            })
            .finally(() => {
                trackMoveInFlightRef.current = false;
            });
    }, [tracks, canDropIntoGroup, computeRawInsert]);

    const beginHeaderPointerDrag = useCallback((e: React.PointerEvent<HTMLDivElement>, trackId: string) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement;
        if (target.closest('button,input,select,textarea,[contenteditable="true"]')) return;

        setPointerDrag({
            trackId,
            startX: e.clientX,
            startY: e.clientY,
            active: false,
        });
    }, []);

    useEffect(() => {
        if (!draggingTrackId) return;
        const clearInAppDrag = () => { dreamGlobals.setInAppDrag(false); };
        window.addEventListener('dragend', clearInAppDrag);
        window.addEventListener('drop', clearInAppDrag);
        return () => {
            window.removeEventListener('dragend', clearInAppDrag);
            window.removeEventListener('drop', clearInAppDrag);
        };
    }, [draggingTrackId]);

    useEffect(() => {
        if (!pointerDrag) return;
        dragPointerYRef.current = pointerDrag.startY;

        const onPointerMove = (e: PointerEvent) => {
            const dx = e.clientX - pointerDrag.startX;
            const dy = e.clientY - pointerDrag.startY;
            const distance = Math.hypot(dx, dy);
            dragPointerYRef.current = e.clientY;

            if (!pointerDrag.active && distance < 4) return;
            if (!pointerDrag.active) {
                draggingTrackIdRef.current = pointerDrag.trackId;
                setDraggingTrackId(pointerDrag.trackId);
                setPointerDrag((prev) => (prev ? { ...prev, active: true } : prev));
                dreamGlobals.setInAppDrag(true);
            }

            const target = resolveDropTargetFromClientY(
                tracks,
                visibleTracks,
                trackRowRefs.current,
                e.clientY,
                pointerDrag.trackId,
            );
            setGroupDropTargetId(target.groupId);
            setDropInsertIndex(target.insertIndex);
            e.preventDefault();
        };

        const runAutoScroll = () => {
            autoScrollRafRef.current = window.requestAnimationFrame(runAutoScroll);
            const y = dragPointerYRef.current;
            if (!pointerDrag.active || y == null) return;

            const listEl = scrollRef.current;
            if (!listEl) return;

            const rect = listEl.getBoundingClientRect();
            const edgeSize = 42;
            let velocity = 0;
            if (y < rect.top + edgeSize) {
                const t = (rect.top + edgeSize - y) / edgeSize;
                velocity = -Math.max(2, Math.min(16, t * 16));
            } else if (y > rect.bottom - edgeSize) {
                const t = (y - (rect.bottom - edgeSize)) / edgeSize;
                velocity = Math.max(2, Math.min(16, t * 16));
            }
            if (velocity === 0) return;

            // SSOT: use pushScrollDelta for auto-scroll during drag.
            // ViewportMatrix clamps and notifies all subscribers.
            scrollSync.pushScrollDelta(velocity);

            const activeDragId = draggingTrackIdRef.current ?? draggingTrackId ?? pointerDrag.trackId;
            if (!activeDragId) return;

            const target = resolveDropTargetFromClientY(tracks, visibleTracks, trackRowRefs.current, y, activeDragId);
            setGroupDropTargetId(target.groupId);
            setDropInsertIndex(target.insertIndex);
        };

        const onPointerUp = (e: PointerEvent) => {
            const activeDragId = draggingTrackIdRef.current ?? draggingTrackId;
            if (pointerDrag.active && activeDragId) {
                if (groupDropTargetId && canDropIntoGroup(activeDragId, groupDropTargetId)) {
                    commitTrackToGroup(activeDragId, groupDropTargetId, dropInsertIndex);
                    suppressNextClickRef.current = true;
                    setPointerDrag(null);
                    resetTrackDragState();
                    return;
                }

                const target = resolveDropTargetFromClientY(tracks, visibleTracks, trackRowRefs.current, e.clientY, activeDragId);
                if (target.groupId && canDropIntoGroup(activeDragId, target.groupId)) {
                    commitTrackToGroup(activeDragId, target.groupId, target.insertIndex);
                } else {
                    const idx = target.insertIndex ?? computeVisibleInsertIndexFromClientY(visibleTracks, trackRowRefs.current, e.clientY);
                    commitDraggedTrackToVisibleIndex(activeDragId, idx);
                }
                suppressNextClickRef.current = true;
            }

            setPointerDrag(null);
            resetTrackDragState();
        };

        autoScrollRafRef.current = window.requestAnimationFrame(runAutoScroll);
        window.addEventListener('pointermove', onPointerMove, { passive: false });
        window.addEventListener('pointerup', onPointerUp);
        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            if (autoScrollRafRef.current !== null) {
                window.cancelAnimationFrame(autoScrollRafRef.current);
                autoScrollRafRef.current = null;
            }
            dragPointerYRef.current = null;
        };
    }, [
        pointerDrag,
        draggingTrackId,
        tracks,
        visibleTracks,
        groupDropTargetId,
        dropInsertIndex,
        canDropIntoGroup,
        commitTrackToGroup,
        commitDraggedTrackToVisibleIndex,
        resetTrackDragState,
        scrollRef,
    ]);

    return {
        draggingTrackId,
        dropInsertIndex,
        groupDropTargetId,
        trackRowRefs,
        suppressNextClickRef,
        draggingTrackIdRef,
        beginHeaderPointerDrag,
        resetTrackDragState,
        commitDraggedTrackToVisibleIndex,
        commitTrackToGroup,
        canDropTrackIntoGroup: canDropIntoGroup,
    };
}
