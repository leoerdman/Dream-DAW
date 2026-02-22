import { useCallback, useEffect, useRef, useState } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';

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
        return Math.max(24, Math.min(120, Math.round(raw)));
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
            if (finalTrackId && finalTrackId !== 'master') {
                applyTrackHeightOptimistic(finalTrackId, finalHeight);
                void engineApi
                    .setTrackHeightWithDeltas(finalTrackId, finalHeight)
                    .then((response) =>
                        useEngineStore
                            .getState()
                            .applyProjectDeltas(response.deltas, 'track-inspector:resize-track-height'),
                    )
                    .catch((err) => {
                        console.error('[TrackInspector] setTrackHeight failed:', err);
                    });
            }
        };
        window.addEventListener('pointermove', onPointerMove, { passive: false });
        window.addEventListener('pointerup', onPointerUp);
        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
        };
    }, [resizingTrackId, clampRowHeight, applyTrackHeightOptimistic]);

    return {
        resizingTrackId,
        beginRowResize,
    };
}
