import { useCallback, useEffect, useRef, useState } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { snapToTrackHeightLevel } from '@/shared/config/trackHeightLevels';

interface UseTrackInspectorResizeArgs {
    applyTrackHeightOptimistic: (trackId: string, height: number) => void;
    setRowHeightOverrides: React.Dispatch<React.SetStateAction<Record<string, number>>>;
}

export function useTrackInspectorResize({
    applyTrackHeightOptimistic,
    setRowHeightOverrides,
}: UseTrackInspectorResizeArgs) {
    const resizeStartYRef = useRef(0);
    const resizeStartHeightRef = useRef(0);
    const resizeCurrentHeightRef = useRef(0);
    const [resizingTrackId, setResizingTrackId] = useState<string | null>(null);

    const clampRowHeight = useCallback((raw: number) => {
        return snapToTrackHeightLevel(raw).height;
    }, []);

    const beginRowResize = useCallback((trackId: string, startHeight: number, startY: number) => {
        resizeStartYRef.current = startY;
        resizeStartHeightRef.current = startHeight;
        resizeCurrentHeightRef.current = startHeight;
        setResizingTrackId(trackId);
    }, []);

    useEffect(() => {
        if (!resizingTrackId) return;
        const onPointerMove = (e: PointerEvent) => {
            e.preventDefault();
            const dy = e.clientY - resizeStartYRef.current;
            const nextHeight = clampRowHeight(resizeStartHeightRef.current + dy);
            resizeCurrentHeightRef.current = nextHeight;
            setRowHeightOverrides((prev) => {
                if (resizingTrackId === 'master') {
                    if (prev.master === nextHeight) return prev;
                    return { ...prev, master: nextHeight };
                }
                if (prev[resizingTrackId] === nextHeight) return prev;
                return { ...prev, [resizingTrackId]: nextHeight };
            });
            applyTrackHeightOptimistic(resizingTrackId, nextHeight);
        };
        const onPointerUp = () => {
            const finalTrackId = resizingTrackId;
            const finalHeight = clampRowHeight(resizeCurrentHeightRef.current || resizeStartHeightRef.current);
            setResizingTrackId(null);
            // Release temporary local height override once drag is committed.
            // The persisted store height becomes the single source of truth.
            setRowHeightOverrides((prev) => {
                if (!finalTrackId || !(finalTrackId in prev)) return prev;
                const next = { ...prev };
                delete next[finalTrackId];
                return next;
            });
            if (finalTrackId && finalTrackId !== 'master') {
                applyTrackHeightOptimistic(finalTrackId, finalHeight);
                void engineApi
                    .setTrackHeightWithDeltas(finalTrackId, finalHeight)
                    .then((response) =>
                        useEngineStore
                            .getState()
                            .applyProjectDeltas(response.deltas, 'track-inspector:resize-track-height'),
                    )
                    .catch((err: unknown) => {
                        const msg = err instanceof Error ? err.message : String(err);
                        console.error('[Dream] setTrackHeight failed:', err);
                        useStatusStore.getState().setError(`Track resize failed: ${msg}`);
                    });
            }
        };
        window.addEventListener('pointermove', onPointerMove, { passive: false });
        window.addEventListener('pointerup', onPointerUp);
        // ENTERPRISE: pointercancel fires when the OS interrupts the gesture
        // (system alert, trackpad gesture, etc). Without this, pointermove
        // listeners become orphaned — a memory leak and interaction corruption bug.
        window.addEventListener('pointercancel', onPointerUp);
        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
        };
    }, [resizingTrackId, clampRowHeight, applyTrackHeightOptimistic, setRowHeightOverrides]);

    return {
        resizingTrackId,
        beginRowResize,
    };
}
