import { useEffect, useState, useRef } from 'react';
import { useDragStore } from '@/shared/stores/useDragStore';
import * as engineApi from '@/shared/api/engineApi';
import { canDropInZone } from '@/shared/lib/dndMatrix';
import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';

export function useDeviceRackDnD(
    rackRef: React.RefObject<HTMLDivElement | null>,
    selectedTrack: any,
    onDropPluginToTrack?: (item: BrowserDragItem, trackId: string) => Promise<void>,
    fetchProject?: () => Promise<void>,
    statusClear?: () => void,
    statusError?: (msg: string) => void
) {
    const [isDropActive, setIsDropActive] = useState(false);
    const draggingItem = useDragStore((s) => s.draggingItem);

    const dropTargetTrackRef = useRef<any>(selectedTrack);
    const onDropPluginToTrackRef = useRef(onDropPluginToTrack);
    const fetchProjectRef = useRef(fetchProject);
    const statusClearRef = useRef(statusClear);
    const statusErrorRef = useRef(statusError);

    useEffect(() => { dropTargetTrackRef.current = selectedTrack; }, [selectedTrack]);
    useEffect(() => { onDropPluginToTrackRef.current = onDropPluginToTrack; }, [onDropPluginToTrack]);
    useEffect(() => {
        fetchProjectRef.current = fetchProject;
        statusClearRef.current = statusClear;
        statusErrorRef.current = statusError;
    }, [fetchProject, statusClear, statusError]);

    useEffect(() => {
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
                e.clientX >= rect.left && e.clientX <= rect.right &&
                e.clientY >= rect.top && e.clientY <= rect.bottom;
            setIsDropActive(inside);
        };

        const onMouseUp = async (e: MouseEvent) => {
            const dragging = useDragStore.getState().draggingItem;
            const targetTrack = dropTargetTrackRef.current;
            if (!dragging || !targetTrack || !canDropInZone(dragging, 'device-rack').allowed) return;
            const rect = rackRef.current?.getBoundingClientRect();
            if (!rect) return;
            const inside =
                e.clientX >= rect.left && e.clientX <= rect.right &&
                e.clientY >= rect.top && e.clientY <= rect.bottom;
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
                    await engineApi.addPluginToTrack(targetTrack.id, dragging.path, dragging.name, slot);
                    if (fetchProjectRef.current) await fetchProjectRef.current();
                }
                if (statusClearRef.current) statusClearRef.current();
            } catch (err) {
                console.error('[DeviceRack] addPluginToTrack failed:', err);
                if (statusErrorRef.current) statusErrorRef.current('Failed to add plugin to track.');
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
    }, [rackRef]);

    return {
        isDropActive,
        draggingItem,
    };
}
