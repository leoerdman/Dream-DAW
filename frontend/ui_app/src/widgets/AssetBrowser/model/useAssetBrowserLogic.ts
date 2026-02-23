import { useState, useCallback, useMemo, useRef } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { AudioFileEntry, BrowserFileEntry, PeakPair } from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import { STATIC_CATEGORIES } from './assetBrowserSchema';
import type { BrowserCategory, BrowserItem, PluginGroupedRow } from './assetBrowserSchema';
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
import {
    loadCollectionLabels,
    loadCollections,
    saveCollectionLabels,
    saveCollections,
    type CollectionId,
} from './assetBrowserUtils';
import {
    buildPluginGroupedRows,
    buildPluginLetterAnchors,
    computeBrowserItems,
    flattenFolderBrowserItems,
    mapPluginBrowserItems,
    mapRealBrowserItems,
} from './assetBrowserItemPipeline';
import { useAssetBrowserEffects } from './useAssetBrowserEffects';
import { useFolderTreeActions, useItemEnterAction } from './useAssetBrowserActions';
import { useKeyboardInteractions, usePreviewSync, useSplitResize } from './useAssetBrowserInteractions';
export function useAssetBrowserLogic() {
    const settings = useSettingsStore((s) => s.settings);
    const settingsLoaded = useSettingsStore((s) => s.loaded);
    const updateAllSettings = useSettingsStore((s) => s.updateAllSettings);
    const projectTracks = useEngineStore((s) => s.projectTracks);

    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [collectionItems, setCollectionItems] = useState<Record<CollectionId, Set<string>>>(loadCollections);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: BrowserItem } | null>(null);
    const [selectedCategoryId, setSelectedCategoryId] = useState('samples');
    const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
    const [sourceFilter, setSourceFilter] = useState(0);
    const [formatFilter, setFormatFilter] = useState(0);
    const [audioFilter, setAudioFilter] = useState(0);
    const [sortFilter, setSortFilter] = useState(0);
    const [sizeFilter, setSizeFilter] = useState(0);
    const [pluginSourceFilter, setPluginSourceFilter] = useState<'all' | 'internal' | 'vst3' | 'vst2' | 'au' | 'external'>('all');
    const [showSizeColumn, setShowSizeColumn] = useState(settings.browserShowSizeColumn);
    const [showTypeColumn, setShowTypeColumn] = useState(settings.browserShowTypeColumn);
    const [columnMenuPos, setColumnMenuPos] = useState<{ x: number; y: number } | null>(null);
    const [collectionLabels, setCollectionLabels] = useState<Record<string, string>>(loadCollectionLabels);
    const [previewEnabled, setPreviewEnabled] = useState(true);
    const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
    const [leftPaneWidth, setLeftPaneWidth] = useState(settings.browserLeftPaneWidth);
    const [previewPeaks, setPreviewPeaks] = useState<PeakPair[] | null>(null);
    const [userFolders, setUserFolders] = useState<string[]>([]);
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
    const [folderChildrenCache, setFolderChildrenCache] = useState<Map<string, BrowserItem[]>>(new Map());
    const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());
    const [currentProjectFolder, setCurrentProjectFolder] = useState<string | null>(null);
    const [realFiles, setRealFiles] = useState<AudioFileEntry[]>([]);
    const [sampleScanLoading, setSampleScanLoading] = useState(false);
    const [sampleScanError, setSampleScanError] = useState<string | null>(null);
    const [pluginScanLoading, setPluginScanLoading] = useState(false);
    const [pluginScanError, setPluginScanError] = useState<string | null>(null);
    const [folderScanLoading, setFolderScanLoading] = useState(false);
    const [folderScanError, setFolderScanError] = useState<string | null>(null);
    const [pluginFiles, setPluginFiles] = useState<BrowserFileEntry[]>([]);
    const [pluginScanNonce, setPluginScanNonce] = useState(0);
    const [pluginScanned, setPluginScanned] = useState(false);
    const [folderItems, setFolderItems] = useState<BrowserFileEntry[]>([]);
    const [folderScanPath, setFolderScanPath] = useState<string | null>(null);

    const contextMenuRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const fileListRef = useRef<HTMLDivElement>(null);
    const splitRootRef = useRef<HTMLDivElement>(null);
    const leftPaneWidthRef = useRef(leftPaneWidth);
    const itemRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const columnMenuRef = useRef<HTMLDivElement>(null);
    const audioDurationSecRef = useRef<Record<string, number>>({});
    const prevCategoryRef = useRef(selectedCategoryId);
    const scanTriggeredRef = useRef(false);
    const prevActiveFolderRef = useRef<string | null>(null);
    const prevCatForPreviewRef = useRef(selectedCategoryId);
    const enterNonceRef = useRef(0);
    const previewRequestToken = useRef<number>(0);
    const isPreviewPlayingRef = useRef(false);

    const scanLoading = sampleScanLoading || pluginScanLoading || folderScanLoading;
    const scanError = sampleScanError || pluginScanError || folderScanError;
    const isSamplesCategory = ['samples', 'all', 'drums'].includes(selectedCategoryId);

    const categories = useMemo<BrowserCategory[]>(() => {
        const folderCats: BrowserCategory[] = userFolders.map((p, i) => {
            const name = p.split('/').pop() || p;
            return {
                id: `user-folder-${i}`,
                title: name,
                icon: 'folder',
                kind: 'leaf' as const,
                folderPath: p,
                removable: true,
            };
        });
        const staticWithCollections = STATIC_CATEGORIES.map((cat) => {
            if (!cat.id.startsWith('collection-')) return cat;
            return { ...cat, title: collectionLabels[cat.id] ?? cat.title };
        });
        return [
            ...staticWithCollections,
            { id: 'sec-folders', title: 'Folders', icon: 'hard-drive', kind: 'section' as const },
            { id: 'userLibrary', title: 'User Lib…', icon: 'user', kind: 'leaf' as const },
            { id: 'currentProject', title: 'Current…', icon: 'file', kind: 'leaf' as const },
            ...folderCats,
            { id: 'addFolder', title: 'Add Fol…', icon: 'folder-plus', kind: 'leaf' as const },
        ];
    }, [userFolders, collectionLabels]);

    const activeCategory = categories.find(c => c.id === selectedCategoryId);
    const userLibraryFolder = settings.userFolderPath?.trim() || null;
    const activeFolderPath = selectedCategoryId === 'currentProject'
        ? currentProjectFolder
        : selectedCategoryId === 'userLibrary'
            ? userLibraryFolder
            : activeCategory?.folderPath || null;

    const realBrowserItems: BrowserItem[] = useMemo(
        () => mapRealBrowserItems(realFiles),
        [realFiles],
    );

    const pluginBrowserItems: BrowserItem[] = useMemo(
        () => mapPluginBrowserItems(pluginFiles),
        [pluginFiles],
    );

    const folderBrowserItems: BrowserItem[] = useMemo(
        () => flattenFolderBrowserItems({ folderItems, expandedFolders, folderChildrenCache, loadingFolders }),
        [folderItems, expandedFolders, folderChildrenCache, loadingFolders],
    );

    const items = useMemo(() => computeBrowserItems({
        selectedCategoryId,
        debouncedQuery,
        realBrowserItems,
        pluginBrowserItems,
        folderBrowserItems,
        activeFolderCategoryPath: activeCategory?.folderPath,
        sizeFilter,
        sortFilter,
        pluginSourceFilter,
        collectionItems,
        formatFilter,
        audioFilter,
        sourceFilter,
    }), [
        selectedCategoryId,
        debouncedQuery,
        realBrowserItems,
        pluginBrowserItems,
        folderBrowserItems,
        activeCategory,
        sizeFilter,
        sortFilter,
        pluginSourceFilter,
        collectionItems,
        formatFilter,
        audioFilter,
        sourceFilter,
    ]);

    const pluginGroupedRows = useMemo<PluginGroupedRow[]>(
        () => buildPluginGroupedRows(selectedCategoryId, items),
        [selectedCategoryId, items],
    );

    const pluginLetterAnchors = useMemo(
        () => buildPluginLetterAnchors(selectedCategoryId, pluginGroupedRows),
        [selectedCategoryId, pluginGroupedRows],
    );

    const selectedPluginLetter = useMemo(() => {
        if (selectedCategoryId !== 'plugins' || !selectedItemId) return null;
        const selected = items.find((it) => it.id === selectedItemId);
        if (!selected || selected.type !== 'plugin') return null;
        const firstChar = selected.name.trim().charAt(0).toUpperCase();
        return /^[A-Z]$/.test(firstChar) ? firstChar : '#';
    }, [selectedCategoryId, selectedItemId, items]);

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
    }, [persistBrowserPrefs]);

    const toggleTypeColumn = useCallback(() => {
        setShowTypeColumn((prev) => {
            const next = !prev;
            persistBrowserPrefs({ browserShowTypeColumn: next });
            return next;
        });
    }, [persistBrowserPrefs]);

    const toggleSection = useCallback((id: string) => {
        setCollapsedSections(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const triggerPluginScan = useCallback(() => {
        setPluginScanNonce((prev) => prev + 1);
    }, []);

    const handleSetPluginFolder = useCallback(async (target: 'vst2Path' | 'vst3Path') => {
        try {
            const picked = await engineApi.pickFolder();
            if (!picked) return;
            await updateAllSettings({ ...settings, [target]: picked });
            setPluginScanError(null);
            triggerPluginScan();
        } catch (err) {
            console.warn('[Browser] Failed to set plugin folder:', err);
            setPluginScanError(String(err));
        }
    }, [settings, updateAllSettings, triggerPluginScan]);

    const { navigateInto, handleAddFolder, handleRemoveFolder } = useFolderTreeActions({
        expandedFolders,
        folderChildrenCache,
        setExpandedFolders,
        setLoadingFolders,
        setFolderChildrenCache,
        setUserFolders,
        setSelectedCategoryId,
    });

    const { handleItemEnter } = useItemEnterAction({ projectTracks, enterNonceRef });

    const syncPreviewForItem = usePreviewSync({
        previewEnabled,
        previewRequestToken,
        audioDurationSecRef,
        isPreviewPlayingRef,
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

    const setItemRowRef = useCallback((id: string, element: HTMLDivElement | null) => {
        itemRowRefs.current[id] = element;
    }, []);

    const getAudioDurationSec = useCallback((path: string) => audioDurationSecRef.current[path], []);
    const setPreviewPlaying = useCallback((isPlaying: boolean) => {
        isPreviewPlayingRef.current = isPlaying;
    }, []);

    useAssetBrowserEffects({
        leftPaneWidth,
        leftPaneWidthRef,
        setUserFolders,
        prevCategoryRef,
        selectedCategoryId,
        setSourceFilter,
        setFormatFilter,
        setAudioFilter,
        setSizeFilter,
        setPluginSourceFilter,
        searchRef,
        setDebouncedQuery,
        fileListRef,
        setExpandedFolders,
        setFolderChildrenCache,
        contextMenu,
        contextMenuRef,
        setContextMenu,
        setCurrentProjectFolder,
        settingsLoaded,
        settings,
        setShowSizeColumn,
        setShowTypeColumn,
        setLeftPaneWidth,
        isSamplesCategory,
        scanTriggeredRef,
        setSampleScanLoading,
        setSampleScanError,
        setRealFiles,
        pluginScanNonce,
        pluginScanned,
        setPluginScanError,
        setPluginScanLoading,
        setPluginFiles,
        setPluginScanned,
        activeFolderPath,
        folderScanPath,
        setFolderScanPath,
        setFolderScanLoading,
        setFolderScanError,
        setFolderItems,
        prevActiveFolderRef,
        setLoadingFolders,
        items,
        selectedItemId,
        setSelectedItemId,
        columnMenuPos,
        columnMenuRef,
        setColumnMenuPos,
        prevCatForPreviewRef,
        isPreviewPlayingRef,
        itemRowRefs,
    });

    return {
        // Refs
        contextMenuRef,
        searchRef,
        fileListRef,
        splitRootRef,
        itemRowRefs,
        columnMenuRef,
        audioDurationSecRef,
        isPreviewPlayingRef,

        // State
        debouncedQuery,
        setDebouncedQuery,
        collectionItems,
        setCollectionItems,
        contextMenu,
        setContextMenu,
        selectedCategoryId,
        setSelectedCategoryId,
        collapsedSections,
        sourceFilter,
        setSourceFilter,
        formatFilter,
        setFormatFilter,
        audioFilter,
        setAudioFilter,
        sortFilter,
        setSortFilter,
        sizeFilter,
        setSizeFilter,
        pluginSourceFilter,
        setPluginSourceFilter,
        showSizeColumn,
        showTypeColumn,
        columnMenuPos,
        setColumnMenuPos,
        collectionLabels,
        setCollectionLabels,
        previewEnabled,
        setPreviewEnabled,
        selectedItemId,
        setSelectedItemId,
        leftPaneWidth,
        previewPeaks,
        scanLoading,
        scanError,

        // Computed
        categories,
        activeCategory,
        items,
        pluginGroupedRows,
        pluginLetterAnchors,
        selectedPluginLetter,
        settings,

        // Callbacks
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
        focusResults,
        setItemRowRef,
        getAudioDurationSec,
        setPreviewPlaying,
        saveCollections,
        saveCollectionLabels,
        engineApi,
    };
}
