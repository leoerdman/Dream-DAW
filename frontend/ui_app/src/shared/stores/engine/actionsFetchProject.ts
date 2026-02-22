import type { StoreApi } from 'zustand';
import * as engine from '@/shared/api/engine';
import { mergeProjectHistory } from '@/shared/stores/engine/storeHelpers';
import type { EngineStore } from '@/shared/stores/useEngineStore';

export function createFetchProjectAction(
    set: StoreApi<EngineStore>['setState'],
    get: StoreApi<EngineStore>['getState'],
): Pick<EngineStore, 'syncProjectHistory'> {
    return {
        syncProjectHistory: async () => {
            try {
                const cursor = get().projectHistoryCursor;
                const delta = await engine.getProjectHistory({ limit: 256, sinceSeq: cursor > 0 ? cursor : undefined });
                if (delta.length === 0) return;
                set((s) => {
                    const merged = mergeProjectHistory(s.projectHistory, s.projectHistoryCursor, delta);
                    return { projectHistory: merged.history, projectHistoryCursor: merged.cursor };
                });
            } catch (e) {
                console.warn('[Engine] syncProjectHistory failed:', e);
            }
        },
    };
}
