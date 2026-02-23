import { useEffect, useState, useRef } from 'react';
import { useDragStore } from '@/shared/stores/useDragStore';
import * as engineApi from '@/shared/api/engine';
import { canDropInZone } from '@/shared/lib/dndMatrix';
import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';
import type { ProjectDelta } from '@/shared/api/engine';

type DeviceRackDropTrack = {
    id: string;
    track_type?: string;
    instrument?: unknown;
} | null;

export function useDeviceRackDnD(
    rackRef: React.RefObject<HTMLDivElement | null>,
    selectedTrack: DeviceRackDropTrack,
    onDropPluginToTrack: ((item: BrowserDragItem, trackId: string) => Promise<void>) | undefined,
    applyProjectDeltas: (deltas: ProjectDelta[], reason?: string) => Promise<void>,
    statusClear?: () => void,
    statusError?: (msg: string) => void,
) {
    const [isDropActive, setIsDropActive] = useState(false);
    const draggingItem = useDragStore((s) => s.draggingItem);

    const dropTargetTrackRef = useRef<DeviceRackDropTrack>(selectedTrack);
    const onDropPluginToTrackRef = useRef(onDropPluginToTrack);
    const applyProjectDeltasRef = useRef(applyProjectDeltas);
    const statusClearRef = useRef(statusClear);
    const statusErrorRef = useRef(statusError);

    useEffect(() => {
        dropTargetTrackRef.current = selectedTrack;
    }, [selectedTrack]);

    useEffect(() => {
        onDropPluginToTrackRef.current = onDropPluginToTrack;
    }, [onDropPluginToTrack]);

    useEffect(() => {
        applyProjectDeltasRef.current = applyProjectDeltas;
        statusClearRef.current = statusClear;
        statusErrorRef.current = statusError;
    }, [applyProjectDeltas, statusClear, statusError]);

    // BUG-81 FIX: Only attach global listeners when a drag operation is active.
    useEffect(() => {
        if (!draggingItem) return;
        const onMouseMove = (e: MouseEvent) => {
            const dragging = useDragStore.getState().draggingItem;
            const targetTrack = dropTargetTrackRef.current;
            if (!dragging || !targetTrack || !canDropInZone(dragging, 'device-rack').allowed) {
                setIsDropActive(false);
                return;
            }

            const rect = rackRef.current?.getBoundingClientRect();
            if (!rect) return;

            const inside =
                e.clientX >= rect.left &&
                e.clientX <= rect.right &&
                e.clientY >= rect.top &&
                e.clientY <= rect.bottom;
            setIsDropActive(inside);
        };

        const onMouseUp = async (e: MouseEvent) => {
            const dragging = useDragStore.getState().draggingItem;
            const targetTrack = dropTargetTrackRef.current;
            if (!dragging || !targetTrack || !canDropInZone(dragging, 'device-rack').allowed) return;

            const rect = rackRef.current?.getBoundingClientRect();
            if (!rect) return;

            const inside =
                e.clientX >= rect.left &&
                e.clientX <= rect.right &&
                e.clientY >= rect.top &&
                e.clientY <= rect.bottom;
            if (!inside) {
                setIsDropActive(false);
                return;
            }

            try {
                const dropHandler = onDropPluginToTrackRef.current;
                if (dropHandler) {
                    await dropHandler(dragging, targetTrack.id);
                } else {
                    const hint = dragging.slotHint ?? 'auto';
                    const slot: 'instrument' | 'effect' =
                        hint === 'instrument'
                            ? 'instrument'
                            : hint === 'effect'
                                ? 'effect'
                                : targetTrack.track_type === 'Midi' && !targetTrack.instrument
                                    ? 'instrument'
                                    : 'effect';

                    const response = await engineApi.addPluginToTrackWithDeltas(
                        targetTrack.id,
                        dragging.path,
                        dragging.name,
                        slot,
                    );
                    await applyProjectDeltasRef.current(response.deltas, 'device-rack:dnd-add-plugin');
                }

                statusClearRef.current?.();
            } catch (err) {
                console.error('[DeviceRack] addPluginToTrack failed:', err);
                statusErrorRef.current?.('Failed to add plugin to track.');
            } finally {
                useDragStore.getState().endDrag();
                setIsDropActive(false);
            }
        };

        window.addEventListener('mousemove', onMouseMove, true);
        window.addEventListener('mouseup', onMouseUp, true);

        return () => {
            window.removeEventListener('mousemove', onMouseMove, true);
            window.removeEventListener('mouseup', onMouseUp, true);
        };
    }, [rackRef, draggingItem]);

    return {
        isDropActive,
        draggingItem,
    };
}
