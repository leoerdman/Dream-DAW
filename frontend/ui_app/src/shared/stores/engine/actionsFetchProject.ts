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
                    if (merged.history.length > MAX_HISTORY) {
                        const trimCount = merged.history.length - MAX_HISTORY;
                        const history = merged.history.slice(trimCount);
                        // ENTERPRISE FIX: Adjust cursor relative to the trimmed entries.
                        // Previously used `merged.cursor` directly, but after slicing
                        // the first N entries, the cursor must shift by the same amount.
                        const cursor = Math.max(0, merged.cursor - trimCount);
                        return { projectHistory: history, projectHistoryCursor: cursor };
                    }
                    return { projectHistory: merged.history, projectHistoryCursor: merged.cursor };
                });
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.warn('[Dream] syncProjectHistory failed:', e);
                // ENTERPRISE FIX: Use synchronous require() instead of async import()
                // to avoid the same race condition as Bug 7 — async import in catch
                // may resolve after additional state changes, applying the error
                // message against stale state.
                try {
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    const { useStatusStore: statusStore } = require('@/shared/stores/useStatusStore');
                    statusStore.getState().setError(`History sync failed: ${msg}`);
                } catch {
                    // Fallback for ESM-only environments
                    import('@/shared/stores/useStatusStore').then(({ useStatusStore: statusStore }) => {
                        statusStore.getState().setError(`History sync failed: ${msg}`);
                    }).catch(() => { /* ignore import failure in test/SSR */ });
                }
            }
        },
    };
}
