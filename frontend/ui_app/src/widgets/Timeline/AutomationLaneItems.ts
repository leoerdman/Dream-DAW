import { useCallback, useEffect, useRef, type RefObject } from 'react';

interface ItemHandlersArgs {
    svgRef: RefObject<SVGSVGElement | null>;
    automationItems: Array<{ itemId: string; startBeat: number; endBeat: number }>;
    laneId: string;
    pixelsPerBeat: number;
    scrollOffsetBeats: number;
    moveAutomationItem: (laneId: string, itemId: string, newStartBeat: number) => boolean;
    stretchAutomationItem: (laneId: string, itemId: string, newLengthBeats: number) => boolean;
    flushPointsToEngine: () => void;
    pushPointsImmediate: () => void;
    pushPointsThrottled: { cancel: () => void };
}

export function useAutomationLaneItemHandlers({
    svgRef,
    automationItems,
    laneId,
    pixelsPerBeat,
    scrollOffsetBeats,
    moveAutomationItem,
    stretchAutomationItem,
    flushPointsToEngine,
    pushPointsImmediate,
    pushPointsThrottled,
}: ItemHandlersArgs) {
    // ENTERPRISE FIX (BUG-W5-001): Cleanup ref for active drag listeners.
    // If component unmounts during an active drag, useEffect cleanup calls
    // the stored cleanup function to remove window listeners.
    const dragCleanupRef = useRef<(() => void) | null>(null);

    useEffect(() => () => {
        dragCleanupRef.current?.();
        dragCleanupRef.current = null;
    }, []);

    const handleItemDragStart = useCallback((e: React.MouseEvent, itemId: string) => {
        e.preventDefault();
        e.stopPropagation();
        const svg = svgRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const item = automationItems.find((i) => i.itemId === itemId);
        if (!item) return;
        const startMouseBeat = (e.clientX - rect.left) / pixelsPerBeat + scrollOffsetBeats;
        const anchorOffset = startMouseBeat - item.startBeat;
        const onMove = (ev: MouseEvent) => {
            const beat = (ev.clientX - rect.left) / pixelsPerBeat + scrollOffsetBeats;
            const newStart = Math.max(0, beat - anchorOffset);
            moveAutomationItem(laneId, itemId, newStart);
            flushPointsToEngine();
        };
        const onUp = () => {
            pushPointsThrottled.cancel();
            pushPointsImmediate();
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            dragCleanupRef.current = null;
        };
        dragCleanupRef.current?.();
        dragCleanupRef.current = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [
        automationItems,
        flushPointsToEngine,
        laneId,
        moveAutomationItem,
        pixelsPerBeat,
        pushPointsImmediate,
        pushPointsThrottled,
        scrollOffsetBeats,
        svgRef,
    ]);

    const handleItemResizeStart = useCallback((e: React.MouseEvent, itemId: string) => {
        e.preventDefault();
        e.stopPropagation();
        const svg = svgRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const item = automationItems.find((i) => i.itemId === itemId);
        if (!item) return;
        const onMove = (ev: MouseEvent) => {
            const beat = (ev.clientX - rect.left) / pixelsPerBeat + scrollOffsetBeats;
            const newLength = Math.max(0.125, beat - item.startBeat);
            stretchAutomationItem(laneId, itemId, newLength);
            flushPointsToEngine();
        };
        const onUp = () => {
            pushPointsThrottled.cancel();
            pushPointsImmediate();
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            dragCleanupRef.current = null;
        };
        dragCleanupRef.current?.();
        dragCleanupRef.current = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [
        automationItems,
        flushPointsToEngine,
        laneId,
        pixelsPerBeat,
        pushPointsImmediate,
        pushPointsThrottled,
        scrollOffsetBeats,
        stretchAutomationItem,
        svgRef,
    ]);

    return { handleItemDragStart, handleItemResizeStart };
}
