import { useCallback, useEffect } from 'react';
import { useDragStore } from '@/shared/stores/useDragStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import { canDropInZone } from '@/shared/lib/dndMatrix';
import { secondsToBeat } from '@/shared/lib/audioMath';
import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';
import type { TimelineCommandBus } from '@/shared/lib/TimelineCommandBus';
import type { TimelineEngine } from '@/shared/lib/TimelineEngine';

interface UseTimelineDnDArgs {
    engineRef: React.RefObject<TimelineEngine | null>;
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    commandBusRef: React.RefObject<TimelineCommandBus>;
    bpm: number;
    draggingItem: ReturnType<typeof useDragStore.getState>['draggingItem'];
    dragCursorX: number;
    dragCursorY: number;
}

export function useTimelineDnD({
    engineRef,
    canvasRef,
    commandBusRef,
    bpm,
    draggingItem,
    dragCursorX,
    dragCursorY,
}: UseTimelineDnDArgs) {
    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';

        const engine = engineRef.current;
        const canvas = canvasRef.current;
        if (!engine || !canvas) return;

        const rect = canvas.getBoundingClientRect();
        if (e.clientY < rect.top || e.clientY > rect.bottom) {
            engine.setDropTarget(null);
            return;
        }
        const beat = engine.viewport.screenToBeats(e.clientX, rect);
        const track = engine.viewport.screenToTrack(e.clientY, rect);

        // BUG-H05 FIX: Use snapBeat() for consistent preview position.
        // Previously used Math.round(beat) which snapped to whole beats
        // regardless of grid setting, causing visual mismatch with actual drop.
        const { snapBeat } = useGridStore.getState();
        engine.setDropTarget({ track, beat: Math.max(0, snapBeat(beat)) });
    }, [engineRef, canvasRef]);

    const handleDragLeave = useCallback(() => {
        engineRef.current?.setDropTarget(null);
    }, [engineRef]);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        engineRef.current?.setDropTarget(null);

        const storeDrag = useDragStore.getState().draggingItem;
        const engine = engineRef.current;
        const canvas = canvasRef.current;
        if (!engine || !canvas) return;

        const rect = canvas.getBoundingClientRect();
        if (e.clientY < rect.top || e.clientY > rect.bottom) return;

        const rawBeat = engine.viewport.screenToBeats(e.clientX, rect);
        const { snapBeat } = useGridStore.getState();
        const beat = Math.max(0, snapBeat(rawBeat));
        const track = engine.viewport.screenToTrack(e.clientY, rect);

        if (storeDrag) {
            const acceptance = canDropInZone(storeDrag, 'timeline-track');
            if (!acceptance.allowed) {
                useDragStore.getState().endDrag();
                return;
            }
            const browserItem: BrowserDragItem = {
                id: storeDrag.id,
                name: storeDrag.name,
                type: storeDrag.type ?? 'audio',
                path: storeDrag.path ?? '',
                slotHint: storeDrag.slotHint,
            };
            commandBusRef.current.emit({ type: 'drop', item: browserItem, trackIndex: track, beat });
            useDragStore.getState().endDrag();
            return;
        }

        try {
            const raw = e.dataTransfer.getData('application/json');
            if (raw) {
                const item = JSON.parse(raw) as BrowserDragItem;
                commandBusRef.current.emit({ type: 'drop', item, trackIndex: track, beat });
            }
        } catch (err) {
            console.warn('[TimelineDnD] Invalid drop payload:', err);
        }
    }, [engineRef, canvasRef, commandBusRef]);

    useEffect(() => {
        const engine = engineRef.current;
        const canvas = canvasRef.current;
        if (!engine || !canvas || !draggingItem) return;

        const rect = canvas.getBoundingClientRect();
        const inside =
            dragCursorX >= rect.left &&
            dragCursorX <= rect.right &&
            dragCursorY >= rect.top &&
            dragCursorY <= rect.bottom;

        const acceptance = canDropInZone(draggingItem, 'timeline-track');
        if (inside && acceptance.allowed && (draggingItem.type === 'audio' || draggingItem.type === 'midi')) {
            // BUG-H04 FIX: Use snapBeat() for consistent ghost clip positioning,
            // matching the drop handler and the drag-over handler.
            const { snapBeat } = useGridStore.getState();
            const beat = Math.max(0, snapBeat(engine.viewport.screenToBeats(dragCursorX, rect)));
            const track = engine.viewport.screenToTrack(dragCursorY, rect);
            engine.setDropTarget(null);
            const widthBeats = draggingItem.durationSeconds
                ? Math.max(0.25, secondsToBeat(draggingItem.durationSeconds, bpm))
                : 4;
            engine.setGhostClip({
                trackIndex: track,
                beat,
                widthBeats,
                name: draggingItem.name,
                type: draggingItem.type === 'midi' ? 'midi' : 'audio',
            });
        } else {
            engine.setDropTarget(null);
            engine.setGhostClip(null);
        }
    }, [draggingItem, dragCursorX, dragCursorY, engineRef, canvasRef, bpm]);

    useEffect(() => {
        if (!draggingItem) return;
        if (draggingItem.type !== 'audio' && draggingItem.type !== 'midi') return;

        const onMouseUp = (e: MouseEvent) => {
            const engine = engineRef.current;
            const canvas = canvasRef.current;
            if (!engine || !canvas) {
                requestAnimationFrame(() => {
                    if (useDragStore.getState().draggingItem) useDragStore.getState().endDrag();
                });
                return;
            }

            const rect = canvas.getBoundingClientRect();
            const inside =
                e.clientX >= rect.left &&
                e.clientX <= rect.right &&
                e.clientY >= rect.top &&
                e.clientY <= rect.bottom;

            if (inside) {
                const acceptance = canDropInZone(draggingItem, 'timeline-track');
                if (acceptance.allowed) {
                    const beat = Math.max(0, Math.round(engine.viewport.screenToBeats(e.clientX, rect)));
                    const track = engine.viewport.screenToTrack(e.clientY, rect);
                    commandBusRef.current.emit({
                        type: 'drop',
                        item: {
                            id: draggingItem.id,
                            name: draggingItem.name,
                            type: draggingItem.type,
                            path: draggingItem.path,
                            durationSeconds: draggingItem.durationSeconds,
                            slotHint: draggingItem.slotHint,
                        },
                        trackIndex: track,
                        beat,
                    });
                }
                engine.setDropTarget(null);
                engine.setGhostClip(null);
                useDragStore.getState().endDrag();
            } else {
                engine.setDropTarget(null);
                engine.setGhostClip(null);
                requestAnimationFrame(() => {
                    if (useDragStore.getState().draggingItem) useDragStore.getState().endDrag();
                });
            }
        };

        window.addEventListener('mouseup', onMouseUp, { capture: true });
        return () => {
            window.removeEventListener('mouseup', onMouseUp, { capture: true });
        };
    }, [draggingItem, engineRef, canvasRef, commandBusRef]);

    return {
        handleDragOver,
        handleDragLeave,
        handleDrop,
    };
}
