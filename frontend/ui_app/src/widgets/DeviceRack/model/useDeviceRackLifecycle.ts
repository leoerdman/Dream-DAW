import { useEffect, useMemo, useRef } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';

interface DeviceLike {
    id: string;
}

interface UseDeviceRackLifecycleArgs {
    selectedTrackId: string;
    chain: DeviceLike[];
    prevTrackIdRef: React.MutableRefObject<string>;
    cleanupGestures: () => void;
    setSelectedDeviceIds: React.Dispatch<React.SetStateAction<string[]>>;
    setInlineSettingsOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}

export function useDeviceRackLifecycle({
    selectedTrackId,
    chain,
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

    // ── ENTERPRISE: Track-switch editor hide/restore ──
    // Ref to track FlowSynth open state per track (for restore on return).
    const flowOpenByTrackRef = useRef<Record<string, { deviceId: string; trackId: string }>>({});

    useEffect(() => {
        const prevId = prevTrackIdRef.current;
        prevTrackIdRef.current = selectedTrackId;
        if (prevId === selectedTrackId) return;

        const { hideEditorsForTrack, restoreEditorsForTrack } = useEngineStore.getState();

        // ── 1) HIDE editors on the previous track (preserve open Set) ──
        if (prevId) {
            // Hide VST/AU native windows (Set stays intact for restore)
            void hideEditorsForTrack(prevId);

            // Hide FlowSynth if it was open on the previous track
            void (async () => {
                try {
                    const { useFlowSynthStore } = await import('@/widgets/FlowSynth/model/useFlowSynthStore');
                    const flowState = useFlowSynthStore.getState();
                    if (flowState.isOpen && flowState.activeTrackId === prevId) {
                        // Remember that Flow was open on this track
                        flowOpenByTrackRef.current[prevId] = {
                            deviceId: flowState.activeDeviceId ?? '',
                            trackId: prevId,
                        };
                        // AUDIT FIX: Use hideFlowEditor (not closeFlowEditor) to preserve
                        // openEditorsByTrack — keeps eye button green while on another track.
                        flowState.hideFlowEditor();
                    }
                } catch {
                    // FlowSynth module not loaded — nothing to hide
                }
            })();
        }

        // ── 2) RESTORE editors on the new track ──
        // Restore VST/AU native windows from preserved Set
        void restoreEditorsForTrack(selectedTrackId);

        // Restore FlowSynth if it was previously open on the new track
        const savedFlow = flowOpenByTrackRef.current[selectedTrackId];
        if (savedFlow && savedFlow.deviceId) {
            void (async () => {
                try {
                    const { useFlowSynthStore } = await import('@/widgets/FlowSynth/model/useFlowSynthStore');
                    useFlowSynthStore.getState().openFlowEditor(savedFlow.deviceId, selectedTrackId);
                    // Clean up — editor is now open, no need to track it
                    delete flowOpenByTrackRef.current[selectedTrackId];
                } catch {
                    // FlowSynth module not loaded — skip restore
                }
            })();
        }
    }, [selectedTrackId, prevTrackIdRef]);

    // BUG-S05 FIX: Cleanup gestures ONLY after track changes — not on every render.
    // This prevents losing pending gesture commits.
    // BUG-I01 FIX: Return cleanup function to clear maps on unmount.
    useEffect(() => {
        cleanupGestures();
        return () => {
            cleanupGestures();
        };
    }, [selectedTrackId, cleanupGestures]);
}
