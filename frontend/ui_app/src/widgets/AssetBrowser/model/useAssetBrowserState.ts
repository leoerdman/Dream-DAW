import { useCallback, useRef, useState } from 'react';
import type { AudioFileEntry, BrowserFileEntry, PeakPair } from '@/shared/api/engine';
import type { BrowserItem } from './assetBrowserSchema';
import { loadCollectionLabels, loadCollections, type CollectionId } from './assetBrowserUtils';

export function useAssetBrowserState(settings: { browserShowSizeColumn: boolean; browserShowTypeColumn: boolean; browserLeftPaneWidth: number }) {
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
    const previewCommandQueueRef = useRef<Promise<void>>(Promise.resolve());

    const setItemRowRef = useCallback((id: string, element: HTMLDivElement | null) => {
        if (element) {
            itemRowRefs.current[id] = element;
        } else {
            // BUG-12 FIX: clean up ref when element unmounts
            delete itemRowRefs.current[id];
        }
    }, []);

    const getAudioDurationSec = useCallback((path: string) => audioDurationSecRef.current[path], []);

    // BUG-13 FIX: cap audioDurationSecRef to prevent unbounded growth
    const setAudioDuration = useCallback((path: string, duration: number) => {
        const cache = audioDurationSecRef.current;
        cache[path] = duration;
        const keys = Object.keys(cache);
        if (keys.length > 500) {
            // Evict oldest 100 entries
            for (let i = 0; i < 100; i++) delete cache[keys[i]];
        }
    }, []);

    const setPreviewPlaying = useCallback((isPlaying: boolean) => {
        isPreviewPlayingRef.current = isPlaying;
    }, []);

    const scanLoading = sampleScanLoading || pluginScanLoading || folderScanLoading;
    const scanError = sampleScanError || pluginScanError || folderScanError;
    const isSamplesCategory = ['samples', 'all', 'drums'].includes(selectedCategoryId);

    return {
        debouncedQuery, setDebouncedQuery,
        collectionItems, setCollectionItems,
        contextMenu, setContextMenu,
        selectedCategoryId, setSelectedCategoryId,
        collapsedSections, setCollapsedSections,
        sourceFilter, setSourceFilter,
        formatFilter, setFormatFilter,
        audioFilter, setAudioFilter,
        sortFilter, setSortFilter,
        sizeFilter, setSizeFilter,
        pluginSourceFilter, setPluginSourceFilter,
        showSizeColumn, setShowSizeColumn,
        showTypeColumn, setShowTypeColumn,
        columnMenuPos, setColumnMenuPos,
        collectionLabels, setCollectionLabels,
        previewEnabled, setPreviewEnabled,
        selectedItemId, setSelectedItemId,
        leftPaneWidth, setLeftPaneWidth,
        previewPeaks, setPreviewPeaks,
        userFolders, setUserFolders,
        expandedFolders, setExpandedFolders,
        folderChildrenCache, setFolderChildrenCache,
        loadingFolders, setLoadingFolders,
        currentProjectFolder, setCurrentProjectFolder,
        realFiles, setRealFiles,
        sampleScanLoading, setSampleScanLoading,
        sampleScanError, setSampleScanError,
        pluginScanLoading, setPluginScanLoading,
        pluginScanError, setPluginScanError,
        folderScanLoading, setFolderScanLoading,
        folderScanError, setFolderScanError,
        pluginFiles, setPluginFiles,
        pluginScanNonce, setPluginScanNonce,
        pluginScanned, setPluginScanned,
        folderItems, setFolderItems,
        folderScanPath, setFolderScanPath,
        contextMenuRef,
        searchRef,
        fileListRef,
        splitRootRef,
        leftPaneWidthRef,
        itemRowRefs,
        columnMenuRef,
        audioDurationSecRef,
        prevCategoryRef,
        scanTriggeredRef,
        prevActiveFolderRef,
        prevCatForPreviewRef,
        enterNonceRef,
        previewRequestToken,
        isPreviewPlayingRef,
        previewCommandQueueRef,
        setItemRowRef,
        getAudioDurationSec,
        setAudioDuration,
        setPreviewPlaying,
        scanLoading,
        scanError,
        isSamplesCategory,
    };
}
