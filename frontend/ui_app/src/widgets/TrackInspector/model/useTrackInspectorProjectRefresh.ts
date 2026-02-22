import { useCallback } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';

let inspectorFetchTimer: ReturnType<typeof setTimeout> | null = null;
const INSPECTOR_FETCH_DEBOUNCE_MS = 100;

export function useTrackInspectorProjectRefresh() {
    return useCallback((reason: string) => {
        if (inspectorFetchTimer) clearTimeout(inspectorFetchTimer);
        inspectorFetchTimer = setTimeout(
            () => void useEngineStore.getState().syncProjectSnapshotDelta(reason),
            INSPECTOR_FETCH_DEBOUNCE_MS,
        );
    }, []);
}
