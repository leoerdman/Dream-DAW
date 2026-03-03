import { useEffect, useMemo } from 'react';
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
    // Stable key derived from chain IDs — prevents re-triggering when array ref changes
    const chainKey = useMemo(() => chain.map((d) => d.id).join(','), [chain]);

    useEffect(() => {
        const currentChain = chain;
        setSelectedDeviceIds((prev) => {
            const filtered = prev.filter((id) => currentChain.some((d) => d.id === id));
            return filtered.length === prev.length ? prev : filtered;
        });
        setInlineSettingsOpen((prev) => {
            const ids = new Set(currentChain.map((d) => d.id));
            const next: Record<string, boolean> = {};
            let changed = false;
            for (const [id, isOpen] of Object.entries(prev)) {
                if (ids.has(id) && isOpen) {
                    next[id] = true;
                } else if (isOpen) {
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [chain, chainKey, setSelectedDeviceIds, setInlineSettingsOpen]);

    // ── Close editors when switching tracks ──
    useEffect(() => {
        const prevId = prevTrackIdRef.current;
        prevTrackIdRef.current = selectedTrackId;
        if (prevId === selectedTrackId) return;

        const prevSlots = openEditorsByTrack[prevId];
        if (prevSlots && prevSlots.size > 0 && prevId) {
            for (const slotId of prevSlots) {
                engineApi.closePluginWindowForSlot(prevId, slotId).catch((err) =>
                    console.warn('[Dream] close editor on track leave failed:', err),
                );
            }
            useEngineStore.setState((s) => ({
                openEditorsByTrack: { ...s.openEditorsByTrack, [prevId]: new Set<string>() },
            }));
        }
    }, [selectedTrackId, openEditorsByTrack, prevTrackIdRef]);

    // BUG-S05 FIX: Cleanup gestures ONLY after track changes — not on every render.
    // This prevents losing pending gesture commits.
    useEffect(() => {
        cleanupGestures();
    }, [selectedTrackId, cleanupGestures]);
}
