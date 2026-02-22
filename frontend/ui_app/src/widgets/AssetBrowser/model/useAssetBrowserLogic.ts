// ═══════════════════════════════════════════════════════════════════════
// useAssetBrowserLogic — extracted state/effects/callbacks from AssetBrowser
// ═══════════════════════════════════════════════════════════════════════
//
// All React hooks (state, refs, effects, callbacks, memos) extracted here.
// AssetBrowser.tsx becomes a pure *rendering* component.
//
// ═══════════════════════════════════════════════════════════════════════

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { AudioFileEntry, BrowserFileEntry, PeakPair } from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import { beatToFrame, resolveSampleRate } from '@/shared/lib/audioMath';
import {
    STATIC_CATEGORIES,
} from './assetBrowserSchema';
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
    fileTypeToItemType,
    loadCollectionLabels,
    loadCollections,
    saveCollectionLabels,
    saveCollections,
    selectBestPeakLevel,
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

// ── Hook ────────────────────────────────────────────────────

export function useAssetBrowserLogic() {
    // ── Store selectors ─────────────────────────────────────
    const settings = useSettingsStore((s) => s.settings);
    const settingsLoaded = useSettingsStore((s) => s.loaded);
    const updateAllSettings = useSettingsStore((s) => s.updateAllSettings);
    const projectTracks = useEngineStore((s) => s.projectTracks);

    // ── State ───────────────────────────────────────────────
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

    // ── Refs ─────────────────────────────────────────────────
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

    // ── Computed: scan state ────────────────────────────────
    const scanLoading = sampleScanLoading || pluginScanLoading || folderScanLoading;
    const scanError = sampleScanError || pluginScanError || folderScanError;
    const isSamplesCategory = ['samples', 'all', 'drums'].includes(selectedCategoryId);

    // ── Dynamic categories ──────────────────────────────────
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

    // ── Browser items ───────────────────────────────────────
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

    // ── Filtered & sorted items ─────────────────────────────
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

    // ── Plugin grouped rows ─────────────────────────────────
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

    // ── Callbacks ───────────────────────────────────────────

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

    const handleAddFolder = useCallback(() => {
        engineApi.addBrowserFolder()
            .then(folders => {
                setUserFolders(folders);
                const newIdx = folders.length - 1;
                if (newIdx >= 0) setSelectedCategoryId(`user-folder-${newIdx}`);
            })
            .catch(err => {
                if (!String(err).includes('Cancelled')) {
                    console.error('[Browser] Add folder failed:', err);
                }
            });
    }, []);

    const handleRemoveFolder = useCallback((path: string) => {
        engineApi.removeBrowserFolder(path)
            .then(folders => {
                setUserFolders(folders);
                setSelectedCategoryId('samples');
            })
            .catch(err => console.error('[Browser] Remove folder failed:', err));
    }, []);

    const toggleFolderExpand = useCallback(async (path: string) => {
        const isExpanded = expandedFolders.has(path);
        setExpandedFolders(prev => {
            const next = new Set(prev);
            if (isExpanded) {
                for (const p of next) {
                    if (p.startsWith(path + '/') || p === path) next.delete(p);
                }
            } else {
                next.add(path);
            }
            return next;
        });
        if (!isExpanded && !folderChildrenCache.has(path)) {
            setLoadingFolders(prev => new Set(prev).add(path));
            try {
                const files = await engineApi.scanFolderAll(path);
                const children: BrowserItem[] = files.map((f, i) => {
                    const sizeKb = Math.round(f.size_bytes / 1024);
                    const sizeMb = (f.size_bytes / (1024 * 1024)).toFixed(1);
                    const sizeLabel = f.is_directory ? '' : (sizeKb > 1024 ? `${sizeMb} MB` : `${sizeKb} KB`);
                    return {
                        id: `tree-${path}-${i}`, name: f.name,
                        type: fileTypeToItemType(f.file_type), format: f.extension || undefined,
                        meta: f.is_directory ? 'Folder' : sizeLabel,
                        path: f.path, isDirectory: f.is_directory,
                        durationSeconds: f.duration_seconds ?? undefined,
                        sizeBytes: f.size_bytes,
                    };
                });
                children.sort((a, b) => {
                    const aDir = a.isDirectory ? 1 : 0;
                    const bDir = b.isDirectory ? 1 : 0;
                    if (aDir !== bDir) return bDir - aDir;
                    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
                });
                setFolderChildrenCache(prev => new Map(prev).set(path, children));
            } catch (err) {
                console.warn('[Browser] Tree scan failed for', path, err);
            } finally {
                setLoadingFolders(prev => {
                    const n = new Set(prev);
                    n.delete(path);
                    return n;
                });
            }
        }
    }, [expandedFolders, folderChildrenCache]);

    const navigateInto = useCallback((path: string) => {
        void toggleFolderExpand(path);
    }, [toggleFolderExpand]);

    const resolveSelectedTrack = useCallback(() => {
        const selected = window.__dreamSelectedTrackId;
        if (selected && selected !== 'master') {
            const selectedTrack = projectTracks.find((t) => t.id === selected);
            if (selectedTrack) return selectedTrack;
        }
        const firstUsable = projectTracks.find((t) => t.track_type !== 'Master');
        return firstUsable ?? null;
    }, [projectTracks]);

    const handleItemEnter = useCallback(async (item: BrowserItem | null) => {
        if (!item) return;
        if (!item.path) return;
        const nonce = ++enterNonceRef.current;
        const track = resolveSelectedTrack();
        if (!track) return;
        try {
            if (item.type === 'plugin') {
                const primary: 'instrument' | 'effect' | 'auto' = item.slotHint ?? 'auto';
                const fallbackSlot: 'instrument' | 'effect' = primary === 'instrument' ? 'effect' : 'instrument';
                let lastErr: unknown = null;
                const attempts: Array<'instrument' | 'effect' | 'auto'> = [];
                for (const slot of [primary, 'auto', fallbackSlot] as const) {
                    if (!attempts.includes(slot)) attempts.push(slot);
                }
                for (const attempt of attempts) {
                    try {
                        const response = await engineApi.addPluginToTrackWithDeltas(track.id, item.path, item.name, attempt);
                        await useEngineStore.getState().applyProjectDeltas(response.deltas, 'asset-browser:add-plugin');
                        lastErr = null;
                        break;
                    } catch (err) { lastErr = err; }
                }
                if (lastErr) throw lastErr;
                return;
            }
            if (item.type !== 'audio') return;
            if (track.track_type === 'Midi') {
                const hasSamplerInstrument = !!track.instrument && /sampler/i.test(
                    `${track.instrument.plugin_id} ${track.instrument.name}`,
                );
                if (!hasSamplerInstrument) {
                    const response = await engineApi.addPluginToTrackWithDeltas(
                        track.id,
                        'internal://instrument/sampler',
                        'Sampler',
                        'instrument',
                    );
                    await useEngineStore.getState().applyProjectDeltas(response.deltas, 'asset-browser:add-sampler');
                }
                await engineApi.setSamplerSample(track.id, item.path);
                await useEngineStore.getState().fetchProject();
                return;
            }
            const trackIndex = projectTracks.findIndex((t) => t.id === track.id);
            if (trackIndex < 0) return;
            const store = useEngineStore.getState();
            const bpm = store.projectBpm || store.transport.bpm || 120;
            const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
            const positionFrames = Math.max(0, beatToFrame(store.transport.position_beats ?? 0, bpm, sampleRate));
            if (enterNonceRef.current !== nonce) return;
            await engineApi.importAudioFile(item.path, trackIndex, positionFrames);
            if (enterNonceRef.current !== nonce) return;
            await store.fetchProject();
        } catch (err) {
            console.error('[AssetBrowser] Enter action failed:', err);
        }
    }, [resolveSelectedTrack, projectTracks]);

    const syncPreviewForItem = useCallback((item: BrowserItem | null) => {
        const token = ++previewRequestToken.current;
        if (item?.type === 'audio' && item.path) {
            engineApi.getWaveformPeaks(item.path)
                .then(peaks => {
                    if (previewRequestToken.current !== token) return;
                    setPreviewPeaks(selectBestPeakLevel(peaks.mip_levels));
                    if (peaks.sample_rate > 0 && peaks.total_samples > 0) {
                        audioDurationSecRef.current[item.path!] = peaks.total_samples / peaks.sample_rate;
                    }
                })
                .catch(() => {
                    if (previewRequestToken.current === token) setPreviewPeaks(null);
                });
            if (previewEnabled) {
                isPreviewPlayingRef.current = true;
                engineApi.previewAudioFile(item.path).catch(err => console.warn('[Preview]', err));
            } else {
                isPreviewPlayingRef.current = false;
                engineApi.stopPreview().catch((err) => console.warn('[AssetBrowser] stopPreview failed:', err));
            }
            return;
        }
        engineApi.stopPreview().catch((err) => console.warn('[AssetBrowser] stopPreview(reset) failed:', err));
        if (previewRequestToken.current === token) setPreviewPeaks(null);
    }, [previewEnabled]);

    const jumpToPluginLetter = useCallback((letter: string) => {
        const targetId = pluginLetterAnchors.itemByLetter[letter];
        if (!targetId) return;
        const targetItem = items.find((it) => it.id === targetId) ?? null;
        setSelectedItemId(targetId);
        syncPreviewForItem(targetItem);
        queueMicrotask(() => {
            itemRowRefs.current[targetId]?.scrollIntoView({ block: 'nearest' });
        });
    }, [items, pluginLetterAnchors, syncPreviewForItem]);

    const moveSelection = useCallback((delta: number) => {
        if (items.length === 0) return;
        const currentIndex = selectedItemId
            ? items.findIndex((it) => it.id === selectedItemId) : -1;
        const fallbackIndex = delta >= 0 ? 0 : items.length - 1;
        const rawNextIndex = currentIndex < 0 ? fallbackIndex : currentIndex + delta;
        const nextIndex = Math.max(0, Math.min(items.length - 1, rawNextIndex));
        const next = items[nextIndex];
        if (!next) return;
        setSelectedItemId(next.id);
        if (previewEnabled) syncPreviewForItem(next);
        if (selectedCategoryId === 'plugins') {
            queueMicrotask(() => {
                itemRowRefs.current[next.id]?.scrollIntoView({ block: 'nearest' });
            });
            return;
        }
        const ROW_HEIGHT = 28;
        const el = fileListRef.current;
        if (el) {
            const itemTop = nextIndex * ROW_HEIGHT;
            const itemBottom = itemTop + ROW_HEIGHT;
            const headerOffset = 24;
            if (itemTop < el.scrollTop + headerOffset) el.scrollTop = itemTop - headerOffset;
            else if (itemBottom > el.scrollTop + el.clientHeight) el.scrollTop = itemBottom - el.clientHeight;
        }
    }, [items, selectedItemId, selectedCategoryId, syncPreviewForItem, previewEnabled]);

    const focusResults = useCallback(() => { fileListRef.current?.focus(); }, []);

    const handleBrowserKeyDown = useCallback((e: React.KeyboardEvent) => {
        const activeEl = document.activeElement;
        if (e.key === 'Escape') {
            if (activeEl === searchRef.current && (searchRef.current?.value.length ?? 0) > 0) {
                e.preventDefault();
                e.stopPropagation();
                setDebouncedQuery('');
                if (searchRef.current) searchRef.current.value = '';
                if (fileListRef.current) fileListRef.current.scrollTop = 0;
            }
            return;
        }
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); focusResults(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); focusResults(); return; }
        if (selectedCategoryId === 'plugins' && activeEl !== searchRef.current && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const upper = e.key.toUpperCase();
            const isLetter = /^[A-Z]$/.test(upper);
            const isHash = e.key === '#';
            if (isLetter || isHash) {
                const target = isHash ? '#' : upper;
                if (pluginLetterAnchors.itemByLetter[target]) {
                    e.preventDefault();
                    jumpToPluginLetter(target);
                    focusResults();
                    return;
                }
            }
        }
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const selected = items.find((it) => it.id === selectedItemId) ?? items[0] ?? null;
        if (!selected) return;
        if (activeEl === searchRef.current) {
            if (!selectedItemId) setSelectedItemId(selected.id);
            focusResults();
            return;
        }
        void handleItemEnter(selected);
    }, [focusResults, handleItemEnter, items, jumpToPluginLetter, moveSelection, pluginLetterAnchors, selectedCategoryId, selectedItemId]);

    const beginSplitResize = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        const root = splitRootRef.current;
        if (!root) return;
        const rootRect = root.getBoundingClientRect();
        let rafId: number | null = null;
        let pendingWidth: number | null = null;
        const flushWidth = () => {
            rafId = null;
            if (pendingWidth === null) return;
            const nextWidth = pendingWidth;
            setLeftPaneWidth((prev) => (prev === nextWidth ? prev : nextWidth));
        };
        const onMove = (me: MouseEvent) => {
            const nextWidth = Math.max(84, Math.min(180, Math.round(me.clientX - rootRect.left)));
            pendingWidth = nextWidth;
            if (rafId === null) rafId = window.requestAnimationFrame(flushWidth);
        };
        const onUp = () => {
            if (rafId !== null) { window.cancelAnimationFrame(rafId); rafId = null; }
            flushWidth();
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            const finalWidth = Math.max(84, Math.min(180, leftPaneWidthRef.current));
            persistBrowserPrefs({ browserLeftPaneWidth: finalWidth });
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [persistBrowserPrefs]);

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

    // ── Return ──────────────────────────────────────────────
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
        saveCollections,
        saveCollectionLabels,
        engineApi,
    };
}
