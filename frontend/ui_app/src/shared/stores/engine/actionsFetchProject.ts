import type { StoreApi } from 'zustand';
import * as engine from '@/shared/api/engine';
import { mergeProjectHistory } from '@/shared/stores/engine/storeHelpers';
import type { EngineStore } from '@/shared/stores/useEngineStore';

// BUG-024: Throttle guard — prevents IPC flood during rapid undo/redo.
let lastSyncMs = 0;
const SYNC_THROTTLE_MS = 500;

export function createFetchProjectAction(
    set: StoreApi<EngineStore>['setState'],
    get: StoreApi<EngineStore>['getState'],
): Pick<EngineStore, 'syncProjectHistory'> {
    return {
        syncProjectHistory: async () => {
            // BUG-024: Skip if called within throttle window.
            const now = performance.now();
            if (now - lastSyncMs < SYNC_THROTTLE_MS) return;
            lastSyncMs = now;
            try {
                const cursor = get().projectHistoryCursor;
                const delta = await engine.getProjectHistory({ limit: 256, sinceSeq: cursor > 0 ? cursor : undefined });
                if (delta.length === 0) return;
                set((s) => {
                    const merged = mergeProjectHistory(s.projectHistory, s.projectHistoryCursor, delta);
                    // BUG-007: Cap history at 500 entries to prevent unbounded memory growth.
                    const MAX_HISTORY = 500;
                    const history = merged.history.length > MAX_HISTORY
                        ? merged.history.slice(merged.history.length - MAX_HISTORY)
                        : merged.history;
                    return { projectHistory: history, projectHistoryCursor: merged.cursor };
                });
            } catch (e) {
                console.warn('[Engine] syncProjectHistory failed:', e);
            }
        },
    };
}
