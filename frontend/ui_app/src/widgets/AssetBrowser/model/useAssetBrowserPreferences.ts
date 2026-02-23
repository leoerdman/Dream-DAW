import { useCallback } from 'react';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';

interface UseAssetBrowserPreferencesArgs {
    setShowSizeColumn: React.Dispatch<React.SetStateAction<boolean>>;
    setShowTypeColumn: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useAssetBrowserPreferences({
    setShowSizeColumn,
    setShowTypeColumn,
}: UseAssetBrowserPreferencesArgs) {
    const updateAllSettings = useSettingsStore((s) => s.updateAllSettings);

    const persistBrowserPrefs = useCallback((patch: {
        browserShowSizeColumn?: boolean;
        browserShowTypeColumn?: boolean;
        browserLeftPaneWidth?: number;
    }) => {
        const current = useSettingsStore.getState().settings;
        void updateAllSettings({ ...current, ...patch });
    }, [updateAllSettings]);

    const toggleSizeColumn = useCallback(() => {
        setShowSizeColumn((prev) => {
            const next = !prev;
            persistBrowserPrefs({ browserShowSizeColumn: next });
            return next;
        });
    }, [persistBrowserPrefs, setShowSizeColumn]);

    const toggleTypeColumn = useCallback(() => {
        setShowTypeColumn((prev) => {
            const next = !prev;
            persistBrowserPrefs({ browserShowTypeColumn: next });
            return next;
        });
    }, [persistBrowserPrefs, setShowTypeColumn]);

    return {
        persistBrowserPrefs,
        toggleSizeColumn,
        toggleTypeColumn,
    };
}
