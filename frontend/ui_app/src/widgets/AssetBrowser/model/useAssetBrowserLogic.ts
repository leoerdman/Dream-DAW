import { useCallback } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
export type { BrowserCategory, BrowserItem, PluginGroupedRow } from './assetBrowserSchema';
export {
    AUDIO_FILTERS,
    FORMAT_FILTERS,
    INTERNAL_EFFECT_ITEMS,
    INTERNAL_INSTRUMENT_ITEMS,
    SIZE_FILTERS,
    SORT_FILTERS,
    SOURCE_FILTERS,
} from './assetBrowserSchema';
import { saveCollectionLabels, saveCollections } from './assetBrowserUtils';
import { useFolderTreeActions, useItemEnterAction } from './useAssetBrowserActions';
import { useAssetBrowserDerived } from './useAssetBrowserDerived';
import { useKeyboardInteractions, usePreviewSync, useSplitResize } from './useAssetBrowserInteractions';
import { useAssetBrowserRuntimeEffects } from './useAssetBrowserRuntimeEffects';
import { useAssetBrowserState } from './useAssetBrowserState';



export function useAssetBrowserLogic() {
    const settings = useSettingsStore((s) => s.settings);
    const settingsLoaded = useSettingsStore((s) => s.loaded);
    const updateAllSettings = useSettingsStore((s) => s.updateAllSettings);
    const tracks = useEngineStore((s) => s.tracks);

    const state = useAssetBrowserState(settings);
    const {
        debouncedQuery,
        selectedCategoryId,
        selectedItemId,
        userFolders,
        collectionLabels,
        currentProjectFolder,
        realFiles,
        pluginFiles,
        folderItems,
        expandedFolders,
        folderChildrenCache,
        folderChildrenCacheRef,
        loadingFolders,
        sizeFilter,
        sortFilter,
        pluginSourceFilter,
        collectionItems,
        formatFilter,
        audioFilter,
        sourceFilter,
        setShowSizeColumn,
        setShowTypeColumn,
        setCollapsedSections,
        setPluginScanNonce,
        setLibraryScanNonce,
        setPluginScanError,
        setExpandedFolders,
        setLoadingFolders,
        setFolderChildrenCache,
        setUserFolders,
        setSelectedCategoryId,
        scanTriggeredRef,
        enterNonceRef,
        previewEnabled,
        previewRequestToken,
        audioDurationSecRef,
        isPreviewPlayingRef,
        previewCommandQueueRef,
        setPreviewPeaks,
        fileListRef,
        searchRef,
        itemRowRefs,
        setSelectedItemId,
        setDebouncedQuery,
        splitRootRef,
        leftPaneWidthRef,
        setLeftPaneWidth,
        setItemRowRef,
        getAudioDurationSec,
        setPreviewPlaying,
    } = state;

    const {
        categories,
        activeCategory,
        activeFolderPath,
        pluginBrowserItems,
        items,
        pluginGroupedRows,
        pluginLetterAnchors,
        selectedPluginLetter,
    } = useAssetBrowserDerived({
        selectedCategoryId,
        selectedItemId,
        userFolders,
        collectionLabels,
        settingsUserFolderPath: settings.userFolderPath,
        currentProjectFolder,
        debouncedQuery,
        realFiles,
        pluginFiles,
        folderItems,
        expandedFolders,
        folderChildrenCache,
        loadingFolders,
        sizeFilter,
        sortFilter,
        pluginSourceFilter,
        collectionItems: collectionItems as Record<string, Set<string>>,
        formatFilter,
        audioFilter,
        sourceFilter,
        excludedFormats: settings.browserExcludedFormats ?? [],
    });

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

    const toggleSection = useCallback((id: string) => {
        setCollapsedSections((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, [setCollapsedSections]);

    const triggerPluginScan = useCallback(() => {
        setPluginScanNonce((prev) => prev + 1);
    }, [setPluginScanNonce]);

    const triggerLibraryScan = useCallback(() => {
        scanTriggeredRef.current = false;
        setLibraryScanNonce((prev) => prev + 1);
    }, [scanTriggeredRef, setLibraryScanNonce]);

    const handleSetPluginFolder = useCallback(async (target: 'vst2Path' | 'vst3Path') => {
        try {
            const picked = await engineApi.pickFolder();
            if (!picked) return;
            // BUG-18 FIX: read latest settings from store to avoid stale closure
            const latestSettings = useSettingsStore.getState().settings;
            await updateAllSettings({ ...latestSettings, [target]: picked });
            setPluginScanError(null);
            triggerPluginScan();
        } catch (err) {
            console.warn('[Browser] Failed to set plugin folder:', err);
            setPluginScanError(String(err));
        }
    }, [setPluginScanError, triggerPluginScan, updateAllSettings]);

    const { navigateInto, handleAddFolder, handleRemoveFolder } = useFolderTreeActions({
        setExpandedFolders,
        setLoadingFolders,
        setFolderChildrenCache,
        folderChildrenCacheRef,
        setUserFolders,
        setSelectedCategoryId,
        onFoldersChanged: triggerLibraryScan,
    });

    const { handleItemEnter } = useItemEnterAction({ tracks, enterNonceRef });

    const syncPreviewForItem = usePreviewSync({
        previewEnabled,
        previewRequestTokenRef: previewRequestToken,
        audioDurationSecRef,
        isPreviewPlayingRef,
        previewCommandQueueRef,
        setPreviewPeaks,
    });

    const { jumpToPluginLetter, focusResults, handleBrowserKeyDown } = useKeyboardInteractions({
        items,
        selectedItemId,
        selectedCategoryId,
        pluginLetterAnchors,
        previewEnabled,
        fileListRef,
        searchRef,
        itemRowRefs,
        setSelectedItemId,
        setDebouncedQuery,
        syncPreviewForItem,
        handleItemEnter,
    });

    const beginSplitResize = useSplitResize({
        splitRootRef,
        leftPaneWidthRef,
        setLeftPaneWidth,
        persistBrowserPrefs,
    });

    useAssetBrowserRuntimeEffects({
        state,
        settingsLoaded,
        settings,
        activeFolderPath,
        items,
    });

    return {
        ...state,
        categories,
        activeCategory,
        items,
        pluginGroupedRows,
        pluginLetterAnchors,
        selectedPluginLetter,
        settings,
        toggleSection,
        toggleSizeColumn,
        toggleTypeColumn,
        handleAddFolder,
        handleRemoveFolder,
        handleSetPluginFolder,
        navigateInto,
        syncPreviewForItem,
        jumpToPluginLetter,
        handleBrowserKeyDown,
        beginSplitResize,
        handleItemEnter,
        pluginBrowserItems,
        triggerPluginScan,
        triggerLibraryScan,
        focusResults,
        setItemRowRef,
        getAudioDurationSec,
        setPreviewPlaying,
        saveCollections,
        saveCollectionLabels,
        engineApi,
    };
}
