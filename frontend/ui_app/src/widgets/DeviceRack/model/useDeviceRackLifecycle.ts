import { useEffect } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';

interface DeviceLike {
    id: string;
}

interface UseDeviceRackLifecycleArgs {
    selectedTrackId: string;
    chain: DeviceLike[];
    openEditorsByTrack: Record<string, Set<string>>;
    prevTrackIdRef: React.MutableRefObject<string>;
    cleanupGestures: () => void;
    setSelectedDeviceIds: React.Dispatch<React.SetStateAction<string[]>>;
    setInlineSettingsOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}

export function useDeviceRackLifecycle({
    selectedTrackId,
    chain,
    openEditorsByTrack,
    prevTrackIdRef,
    cleanupGestures,
    setSelectedDeviceIds,
    setInlineSettingsOpen,
}: UseDeviceRackLifecycleArgs): void {
    useEffect(() => {
        setSelectedDeviceIds((prev) => prev.filter((id) => chain.some((d) => d.id === id)));
        setInlineSettingsOpen((prev) => {
            const next: Record<string, boolean> = {};
            const ids = new Set(chain.map((d) => d.id));
            for (const [id, isOpen] of Object.entries(prev)) {
                if (ids.has(id) && isOpen) next[id] = true;
            }
            return next;
        });
    }, [chain, setSelectedDeviceIds, setInlineSettingsOpen]);

    useEffect(() => {
        const prevId = prevTrackIdRef.current;
        prevTrackIdRef.current = selectedTrackId;
        if (prevId === selectedTrackId) return;

        const prevSlots = openEditorsByTrack[prevId];
        if (prevSlots && prevSlots.size > 0 && prevId) {
            for (const slotId of prevSlots) {
                engineApi.closePluginWindowForSlot(prevId, slotId).catch((err) =>
                    console.warn('[DeviceRack] close editor on track leave failed:', err),
                );
            }
            useEngineStore.setState((s) => ({
                openEditorsByTrack: { ...s.openEditorsByTrack, [prevId]: new Set<string>() },
            }));
        }
    }, [selectedTrackId, openEditorsByTrack, prevTrackIdRef]);

    useEffect(() => {
        cleanupGestures();
    }, [selectedTrackId, cleanupGestures]);
}
