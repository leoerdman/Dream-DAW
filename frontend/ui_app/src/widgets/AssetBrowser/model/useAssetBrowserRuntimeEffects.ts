import { useAssetBrowserEffects } from './useAssetBrowserEffects';
import { useAssetBrowserState } from './useAssetBrowserState';
import type { BrowserItem } from './assetBrowserSchema';
import type { UseAssetBrowserEffectsParams } from './useAssetBrowserEffects.types';

interface UseAssetBrowserRuntimeEffectsParams {
    state: ReturnType<typeof useAssetBrowserState>;
    settingsLoaded: boolean;
    settings: UseAssetBrowserEffectsParams['settings'];
    activeFolderPath: string | null;
    items: BrowserItem[];
}

export function useAssetBrowserRuntimeEffects({
    state,
    settingsLoaded,
    settings,
    activeFolderPath,
    items,
}: UseAssetBrowserRuntimeEffectsParams): void {
    useAssetBrowserEffects({
        leftPaneWidth: state.leftPaneWidth,
        leftPaneWidthRef: state.leftPaneWidthRef,
        setUserFolders: state.setUserFolders,
        prevCategoryRef: state.prevCategoryRef,
        selectedCategoryId: state.selectedCategoryId,
        setSourceFilter: state.setSourceFilter,
        setFormatFilter: state.setFormatFilter,
        setAudioFilter: state.setAudioFilter,
        setSizeFilter: state.setSizeFilter,
        setPluginSourceFilter: state.setPluginSourceFilter,
        searchRef: state.searchRef,
        setDebouncedQuery: state.setDebouncedQuery,
        fileListRef: state.fileListRef,
        setExpandedFolders: state.setExpandedFolders,
        setFolderChildrenCache: state.setFolderChildrenCache,
        contextMenu: state.contextMenu,
        contextMenuRef: state.contextMenuRef,
        setContextMenu: state.setContextMenu,
        setCurrentProjectFolder: state.setCurrentProjectFolder,
        settingsLoaded,
        settings,
        setShowSizeColumn: state.setShowSizeColumn,
        setShowTypeColumn: state.setShowTypeColumn,
        setLeftPaneWidth: state.setLeftPaneWidth,
        isSamplesCategory: state.isSamplesCategory,
        scanTriggeredRef: state.scanTriggeredRef,
        setSampleScanLoading: state.setSampleScanLoading,
        setSampleScanError: state.setSampleScanError,
        setRealFiles: state.setRealFiles,
        pluginScanNonce: state.pluginScanNonce,
        pluginScanned: state.pluginScanned,
        setPluginScanError: state.setPluginScanError,
        setPluginScanLoading: state.setPluginScanLoading,
        setPluginFiles: state.setPluginFiles,
        setPluginScanned: state.setPluginScanned,
        activeFolderPath,
        folderScanPath: state.folderScanPath,
        setFolderScanPath: state.setFolderScanPath,
        setFolderScanLoading: state.setFolderScanLoading,
        setFolderScanError: state.setFolderScanError,
        setFolderItems: state.setFolderItems,
        prevActiveFolderRef: state.prevActiveFolderRef,
        setLoadingFolders: state.setLoadingFolders,
        items,
        selectedItemId: state.selectedItemId,
        setSelectedItemId: state.setSelectedItemId,
        columnMenuPos: state.columnMenuPos,
        columnMenuRef: state.columnMenuRef,
        setColumnMenuPos: state.setColumnMenuPos,
        prevCatForPreviewRef: state.prevCatForPreviewRef,
        isPreviewPlayingRef: state.isPreviewPlayingRef,
        itemRowRefs: state.itemRowRefs,
    });
}
