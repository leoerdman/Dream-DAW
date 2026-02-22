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
    INTERNAL_EFFECT_PLUGINS,
    INTERNAL_INSTRUMENT_PLUGINS,
} from '@/shared/lib/internalPlugins';
import {
    detectPluginSource,
    fileTypeToItemType,
    fuzzyScore,
    isLikelyDrumAudio,
    isLikelyInstrumentPlugin,
    loadCollectionLabels,
    loadCollections,
    saveCollectionLabels,
    saveCollections,
    selectBestPeakLevel,
    type CollectionId,
} from './assetBrowserUtils';

// ── Re-export types used by the rendering component ─────────

export interface BrowserCategory {
    id: string;
    title: string;
    icon: string;
    kind: 'section' | 'leaf';
    markerColor?: string;
    folderPath?: string;
    removable?: boolean;
}

export interface BrowserItem {
    id: string;
    name: string;
    type: 'audio' | 'instrument' | 'audioEffect' | 'midiEffect' | 'plugin' | 'folder' | 'project' | 'preset' | 'other';
    format?: string;
    meta?: string;
    favorite?: boolean;
    path?: string;
    isDirectory?: boolean;
    slotHint?: 'instrument' | 'effect' | 'auto';
    durationSeconds?: number;
    sizeBytes?: number;
    pluginSource?: 'internal' | 'vst2' | 'vst3' | 'au' | 'external';
    _depth?: number;
    _expanded?: boolean;
    _loading?: boolean;
}

export type PluginGroupedRow =
    | { kind: 'header'; id: string; title: string; count: number }
    | { kind: 'item'; id: string; item: BrowserItem };

// ── Constants ────────────────────────────────────────────────

export const STATIC_CATEGORIES: BrowserCategory[] = [
    { id: 'sec-collections', title: 'Browser', icon: 'search', kind: 'section' },
    { id: 'collection-red', title: 'Collection', icon: 'star', markerColor: '#ef4444', kind: 'leaf' },
    { id: 'collection-yellow', title: 'Collection', icon: 'star', markerColor: '#f59e0b', kind: 'leaf' },
    { id: 'collection-green', title: 'Collection', icon: 'star', markerColor: '#22c55e', kind: 'leaf' },
    { id: 'sec-library', title: 'Library', icon: 'folder-tree', kind: 'section' },
    { id: 'all', title: 'All', icon: 'grid', kind: 'leaf' },
    { id: 'samples', title: 'Samples', icon: 'wave-bars', kind: 'leaf' },
    { id: 'drums', title: 'Drums', icon: 'drum', kind: 'leaf' },
    { id: 'instruments', title: 'Instruments', icon: 'piano', kind: 'leaf' },
    { id: 'plugins', title: 'Plug-Ins', icon: 'plug', kind: 'leaf' },
    { id: 'audioEffects', title: 'Audio Eff…', icon: 'sliders', kind: 'leaf' },
];

export const SOURCE_FILTERS = ['Source: All', 'Source: Library', 'Source: Samples', 'Source: Plug-ins'] as const;
export const FORMAT_FILTERS = ['Format: All', 'WAV', 'AIFF', 'MP3', 'FLAC'] as const;
export const AUDIO_FILTERS = ['Audio: All', 'Loops', 'One Shot', 'Drums', 'Vocals'] as const;
export const SORT_FILTERS = ['Sort: Name ↑', 'Sort: Name ↓', 'Sort: Size ↑', 'Sort: Size ↓'] as const;
export const SIZE_FILTERS = ['Filter: All', '< 1 MB', '≥ 1 MB'] as const;

export const INTERNAL_INSTRUMENT_ITEMS: BrowserItem[] = INTERNAL_INSTRUMENT_PLUGINS.map((plugin) => ({
    id: `internal-inst-${plugin.name.toLowerCase().replace(/\s+/g, '-')}`,
    name: plugin.name,
    type: 'plugin',
    meta: `Internal Instrument ${plugin.tags.join(' ')}`,
    path: plugin.id,
    slotHint: plugin.slotHint,
    pluginSource: 'internal' as const,
}));

export const INTERNAL_EFFECT_ITEMS: BrowserItem[] = INTERNAL_EFFECT_PLUGINS.map((plugin) => ({
    id: `internal-fx-${plugin.name.toLowerCase().replace(/\s+/g, '-')}`,
    name: plugin.name,
    type: 'plugin',
    meta: `Internal Audio FX ${plugin.tags.join(' ')}`,
    path: plugin.id,
    slotHint: plugin.slotHint,
    pluginSource: 'internal' as const,
}));

export const PLUGIN_SOURCE_ORDER: Array<NonNullable<BrowserItem['pluginSource']>> = [
    'internal', 'vst3', 'vst2', 'au', 'external',
];

export const PLUGIN_SOURCE_LABEL: Record<NonNullable<BrowserItem['pluginSource']>, string> = {
    internal: 'Internal',
    vst3: 'VST3',
    vst2: 'VST2',
    au: 'Audio Unit',
    external: 'External',
};

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
    const realBrowserItems: BrowserItem[] = useMemo(() => {
        return realFiles.map((f, i) => {
            const sizeKb = Math.round(f.size_bytes / 1024);
            const sizeMb = (f.size_bytes / (1024 * 1024)).toFixed(1);
            const sizeLabel = sizeKb > 1024 ? `${sizeMb} MB` : `${sizeKb} KB`;
            return {
                id: `real-${i}`, name: f.name, type: 'audio' as const,
                format: f.format, meta: sizeLabel, path: f.path,
                durationSeconds: f.duration_seconds ?? undefined,
                sizeBytes: f.size_bytes,
            };
        });
    }, [realFiles]);

    const pluginBrowserItems: BrowserItem[] = useMemo(() => {
        return pluginFiles.map((f, i) => ({
            id: `plugin-${i}`, name: f.name, type: 'plugin' as const,
            format: f.extension, meta: f.extension, path: f.path,
            slotHint: 'auto' as const, sizeBytes: f.size_bytes,
            pluginSource: detectPluginSource(`${f.extension ?? ''} ${f.path ?? ''} ${f.name ?? ''}`),
        }));
    }, [pluginFiles]);

    const folderBrowserItems: BrowserItem[] = useMemo(() => {
        const rootItems: BrowserItem[] = folderItems.map((f, i) => {
            const sizeKb = Math.round(f.size_bytes / 1024);
            const sizeMb = (f.size_bytes / (1024 * 1024)).toFixed(1);
            const sizeLabel = f.is_directory ? '' : (sizeKb > 1024 ? `${sizeMb} MB` : `${sizeKb} KB`);
            return {
                id: `folder-${i}`, name: f.name,
                type: fileTypeToItemType(f.file_type), format: f.extension || undefined,
                meta: f.is_directory ? 'Folder' : sizeLabel, path: f.path,
                isDirectory: f.is_directory,
                durationSeconds: f.duration_seconds ?? undefined,
                sizeBytes: f.size_bytes, _depth: 0,
            };
        });
        const result: BrowserItem[] = [];
        const insertWithChildren = (items: BrowserItem[], depth: number) => {
            for (const item of items) {
                const isExp = item.isDirectory && item.path ? expandedFolders.has(item.path) : false;
                const isLoad = item.isDirectory && item.path ? loadingFolders.has(item.path) : false;
                result.push({ ...item, _depth: depth, _expanded: isExp, _loading: isLoad });
                if (isExp && item.path) {
                    const children = folderChildrenCache.get(item.path);
                    if (children) insertWithChildren(children, depth + 1);
                }
            }
        };
        insertWithChildren(rootItems, 0);
        return result;
    }, [folderItems, expandedFolders, folderChildrenCache, loadingFolders]);

    // ── Filtered & sorted items ─────────────────────────────
    const items = useMemo(() => {
        let base: BrowserItem[] = [];
        const pluginSearchMode = selectedCategoryId === 'plugins' && debouncedQuery.trim().length > 0;
        if (activeCategory?.folderPath) {
            base = folderBrowserItems;
        } else {
            switch (selectedCategoryId) {
                case 'all':
                    base = [...realBrowserItems, ...INTERNAL_INSTRUMENT_ITEMS, ...INTERNAL_EFFECT_ITEMS, ...pluginBrowserItems, ...folderBrowserItems]
                        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
                    break;
                case 'samples': base = realBrowserItems; break;
                case 'drums': base = realBrowserItems.filter((i) => isLikelyDrumAudio(i)); break;
                case 'plugins': base = [...INTERNAL_INSTRUMENT_ITEMS, ...INTERNAL_EFFECT_ITEMS, ...pluginBrowserItems]; break;
                case 'audioEffects': base = [...INTERNAL_EFFECT_ITEMS, ...pluginBrowserItems.filter((p) => !isLikelyInstrumentPlugin(p))]; break;
                case 'instruments': base = [...INTERNAL_INSTRUMENT_ITEMS, ...pluginBrowserItems.filter((p) => isLikelyInstrumentPlugin(p))]; break;
                case 'collection-red': case 'collection-yellow': case 'collection-green': {
                    const collId = selectedCategoryId as CollectionId;
                    const memberPaths = collectionItems[collId];
                    const allKnown = [...realBrowserItems, ...INTERNAL_INSTRUMENT_ITEMS, ...INTERNAL_EFFECT_ITEMS, ...pluginBrowserItems];
                    base = allKnown.filter(i => i.path && memberPaths.has(i.path));
                    break;
                }
                case 'currentProject': case 'userLibrary': base = folderBrowserItems; break;
                default: base = realBrowserItems;
            }
        }
        if (selectedCategoryId === 'all') base = base.filter((i) => i.type !== 'project');
        if (debouncedQuery.trim()) {
            const q = debouncedQuery.trim();
            base = base
                .map((item) => {
                    const searchText = `${item.name} ${item.format ?? ''} ${item.meta ?? ''}${item.pluginSource ? ` ${item.pluginSource}` : ''}`;
                    return { item, score: fuzzyScore(searchText, q) };
                })
                .filter((entry) => entry.score !== null)
                .sort((a, b) => {
                    if (a.score !== b.score) return (a.score ?? 0) - (b.score ?? 0);
                    return a.item.name.toLowerCase().localeCompare(b.item.name.toLowerCase());
                })
                .map((entry) => entry.item);
        }
        const isLibraryCategory = ['samples', 'all', 'drums', 'plugins', 'instruments', 'audioEffects',
            'collection-red', 'collection-yellow', 'collection-green'].includes(selectedCategoryId)
            && !activeCategory?.folderPath;
        if (isLibraryCategory) {
            if (sourceFilter === 1) base = base.filter((i) => i.type === 'audio' || i.pluginSource === 'internal');
            else if (sourceFilter === 2) base = base.filter((i) => i.type === 'audio');
            else if (sourceFilter === 3) base = base.filter((i) => i.type === 'plugin');
        }
        if (isLibraryCategory) {
            if (formatFilter > 0) {
                const formatNames = ['', 'wav', 'aiff', 'mp3', 'flac'];
                const wanted = formatNames[formatFilter];
                if (wanted) base = base.filter((i) => i.format && i.format.toLowerCase() === wanted);
            }
            if (audioFilter > 0) {
                const audioFilterFns: Record<number, (i: BrowserItem) => boolean> = {
                    1: (i) => /loop|bpm/i.test(i.name + (i.meta ?? '')),
                    2: (i) => /one.?shot|hit|stab/i.test(i.name + (i.meta ?? '')),
                    3: (i) => isLikelyDrumAudio(i),
                    4: (i) => /vocal|vox|voice|acapella/i.test(i.name + (i.meta ?? '')),
                };
                const fn = audioFilterFns[audioFilter];
                if (fn) base = base.filter(fn);
            }
        }
        if (selectedCategoryId === 'plugins' && pluginSourceFilter !== 'all') {
            base = base.filter((i) => i.type === 'plugin' && i.pluginSource === pluginSourceFilter);
        }
        if (isLibraryCategory) {
            if (sizeFilter === 1) base = base.filter((i) => (i.sizeBytes ?? 0) < 1024 * 1024);
            else if (sizeFilter === 2) base = base.filter((i) => (i.sizeBytes ?? 0) >= 1024 * 1024);
        }
        if (pluginSearchMode) return base;
        const isSearchActive = !!debouncedQuery.trim();
        if (activeCategory?.folderPath && !isSearchActive && sortFilter === 0) return base;
        const folderFirst = (a: BrowserItem, b: BrowserItem): number => {
            const aDir = a.isDirectory ? 1 : 0;
            const bDir = b.isDirectory ? 1 : 0;
            return bDir - aDir;
        };
        if (!isSearchActive || sortFilter !== 0) {
            if (sortFilter === 0) base = [...base].sort((a, b) => folderFirst(a, b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
            else if (sortFilter === 1) base = [...base].sort((a, b) => folderFirst(a, b) || b.name.toLowerCase().localeCompare(a.name.toLowerCase()) || a.id.localeCompare(b.id));
            else if (sortFilter === 2) base = [...base].sort((a, b) => folderFirst(a, b) || (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0) || a.id.localeCompare(b.id));
            else base = [...base].sort((a, b) => folderFirst(a, b) || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || a.id.localeCompare(b.id));
        }
        return base;
    }, [selectedCategoryId, debouncedQuery, realBrowserItems, pluginBrowserItems, folderBrowserItems, activeCategory, sizeFilter, sortFilter, pluginSourceFilter, collectionItems, formatFilter, audioFilter, sourceFilter]);

    // ── Plugin grouped rows ─────────────────────────────────
    const pluginGroupedRows = useMemo<PluginGroupedRow[]>(() => {
        if (selectedCategoryId !== 'plugins') return [];
        const rows: PluginGroupedRow[] = [];
        for (const source of PLUGIN_SOURCE_ORDER) {
            const sourceItems = items.filter((it) => it.type === 'plugin' && (it.pluginSource ?? 'external') === source);
            if (sourceItems.length === 0) continue;
            rows.push({ kind: 'header', id: `plugin-group-${source}`, title: PLUGIN_SOURCE_LABEL[source], count: sourceItems.length });
            for (const item of sourceItems) {
                rows.push({ kind: 'item', id: `plugin-item-${item.id}`, item });
            }
        }
        return rows;
    }, [selectedCategoryId, items]);

    const pluginLetterAnchors = useMemo(() => {
        const itemByLetter: Record<string, string> = {};
        if (selectedCategoryId !== 'plugins') return { letters: [] as string[], itemByLetter };
        for (const row of pluginGroupedRows) {
            if (row.kind !== 'item') continue;
            const firstChar = row.item.name.trim().charAt(0).toUpperCase();
            const letter = /^[A-Z]$/.test(firstChar) ? firstChar : '#';
            if (!itemByLetter[letter]) itemByLetter[letter] = row.item.id;
        }
        const letters = Object.keys(itemByLetter).sort((a, b) => {
            if (a === '#') return 1;
            if (b === '#') return -1;
            return a.localeCompare(b);
        });
        return { letters, itemByLetter };
    }, [selectedCategoryId, pluginGroupedRows]);

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
                        await engineApi.addPluginToTrack(track.id, item.path, item.name, attempt);
                        lastErr = null;
                        break;
                    } catch (err) { lastErr = err; }
                }
                if (lastErr) throw lastErr;
                await useEngineStore.getState().fetchProject();
                return;
            }
            if (item.type !== 'audio') return;
            if (track.track_type === 'Midi') {
                const hasSamplerInstrument = !!track.instrument && /sampler/i.test(
                    `${track.instrument.plugin_id} ${track.instrument.name}`,
                );
                if (!hasSamplerInstrument) {
                    await engineApi.addPluginToTrack(track.id, 'internal://instrument/sampler', 'Sampler', 'instrument');
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

    // ── Effects ──────────────────────────────────────────────

    // Sync leftPaneWidth ref
    useEffect(() => { leftPaneWidthRef.current = leftPaneWidth; }, [leftPaneWidth]);

    // Load user folders on mount
    useEffect(() => {
        engineApi.getBrowserFolders()
            .then(folders => setUserFolders(folders))
            .catch(err => console.warn('[Browser] Failed to load folders:', err));
    }, []);

    // BUG-7 FIX: Reset filters when category changes
    useEffect(() => {
        if (prevCategoryRef.current !== selectedCategoryId) {
            prevCategoryRef.current = selectedCategoryId;
            setSourceFilter(0);
            setFormatFilter(0);
            setAudioFilter(0);
            setSizeFilter(0);
            setPluginSourceFilter('all');
        }
    }, [selectedCategoryId]);

    // Keyboard shortcut: Cmd+F
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                searchRef.current?.focus();
                searchRef.current?.select();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, []);

    // Custom event listeners for browser focus/search
    useEffect(() => {
        const focusBrowserSearch = (evt: Event) => {
            const detail = (evt as CustomEvent<{ categoryId?: string }>).detail;
            if (detail?.categoryId) {
                setSelectedCategoryId(detail.categoryId);
                setExpandedFolders(new Set());
                setFolderChildrenCache(new Map());
            }
            searchRef.current?.focus();
            searchRef.current?.select();
        };
        const setBrowserSearch = (evt: Event) => {
            const detail = (evt as CustomEvent<{ query?: string; categoryId?: string }>).detail;
            if (detail?.categoryId) {
                setSelectedCategoryId(detail.categoryId);
                setExpandedFolders(new Set());
                setFolderChildrenCache(new Map());
            }
            if (typeof detail?.query === 'string') setDebouncedQuery(detail.query);
            searchRef.current?.focus();
        };
        window.addEventListener('dream:browser-focus-search', focusBrowserSearch as EventListener);
        window.addEventListener('dream:browser-set-search', setBrowserSearch as EventListener);
        return () => {
            window.removeEventListener('dream:browser-focus-search', focusBrowserSearch as EventListener);
            window.removeEventListener('dream:browser-set-search', setBrowserSearch as EventListener);
        };
    }, []);

    // Close context menu on click-outside or Escape
    useEffect(() => {
        if (!contextMenu) return;
        const onClick = (e: MouseEvent) => {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) setContextMenu(null);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null); };
        window.addEventListener('mousedown', onClick, true);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('mousedown', onClick, true);
            window.removeEventListener('keydown', onKey);
        };
    }, [contextMenu]);

    // Load current project folder
    useEffect(() => {
        if (selectedCategoryId !== 'currentProject') return;
        let mounted = true;
        void engineApi.getProjectStatus()
            .then((status) => { if (mounted) setCurrentProjectFolder(status.projectFolder ?? null); })
            .catch(() => { if (mounted) setCurrentProjectFolder(null); });
        return () => { mounted = false; };
    }, [selectedCategoryId]);

    // Sync settings
    useEffect(() => {
        if (!settingsLoaded) return;
        setShowSizeColumn(settings.browserShowSizeColumn);
        setShowTypeColumn(settings.browserShowTypeColumn);
        setLeftPaneWidth(Math.max(84, Math.min(180, settings.browserLeftPaneWidth || 92)));
    }, [settingsLoaded, settings.browserShowSizeColumn, settings.browserShowTypeColumn, settings.browserLeftPaneWidth]);

    // Sample scanning
    useEffect(() => {
        if (!isSamplesCategory || scanTriggeredRef.current) return;
        let cancelled = false;
        const timerId = setTimeout(() => {
            if (cancelled) return;
            setSampleScanLoading(true);
            setSampleScanError(null);
            engineApi.generateDemoSamples()
                .catch(err => console.warn('[AssetBrowser] Demo sample generation skipped:', err))
                .then(() => {
                    if (cancelled) return Promise.reject('cancelled');
                    return engineApi.scanAllAudioSources();
                })
                .then(files => {
                    if (!cancelled) {
                        scanTriggeredRef.current = true;
                        setRealFiles(files);
                        setSampleScanLoading(false);
                    }
                })
                .catch(err => {
                    if (!cancelled && err !== 'cancelled') {
                        console.warn('[AssetBrowser] Scan failed:', err);
                        setSampleScanError(String(err));
                        setSampleScanLoading(false);
                    }
                });
        }, 300);
        return () => { cancelled = true; clearTimeout(timerId); };
    }, [isSamplesCategory]);

    // Plugin scanning
    useEffect(() => {
        const needsPluginCatalog = selectedCategoryId === 'plugins' || selectedCategoryId === 'all'
            || selectedCategoryId === 'instruments' || selectedCategoryId === 'audioEffects';
        if (!needsPluginCatalog) return;
        const forceRescan = selectedCategoryId === 'plugins' || pluginScanNonce > 0;
        if (pluginScanned && !forceRescan) return;
        let cancelled = false;
        setPluginScanError(null);
        setPluginScanLoading(true);
        engineApi.scanPluginFolders()
            .then(files => {
                if (cancelled) return;
                setPluginFiles(files);
                setPluginScanned(true);
                setPluginScanLoading(false);
            })
            .catch(err => {
                if (cancelled) return;
                console.warn('[Browser] Plugin scan failed:', err);
                setPluginScanError(String(err));
                setPluginScanLoading(false);
            });
        return () => { cancelled = true; };
    }, [selectedCategoryId, pluginScanNonce, pluginScanned]);

    // Folder scanning
    useEffect(() => {
        if (!activeFolderPath || activeFolderPath === folderScanPath) return;
        let cancelled = false;
        setFolderScanPath(activeFolderPath);
        setFolderScanLoading(true);
        setFolderScanError(null);
        engineApi.scanFolderAll(activeFolderPath)
            .then(files => {
                if (cancelled) return;
                setFolderItems(files);
                setFolderScanLoading(false);
            })
            .catch(err => {
                if (cancelled) return;
                console.warn('[Browser] Folder scan failed:', err);
                setFolderScanError(String(err));
                setFolderScanLoading(false);
            });
        return () => { cancelled = true; };
    }, [activeFolderPath, folderScanPath]);

    // Reset folder tree on category change
    useEffect(() => {
        const changed = activeFolderPath !== prevActiveFolderRef.current;
        prevActiveFolderRef.current = activeFolderPath;
        setExpandedFolders(new Set());
        setFolderChildrenCache(new Map());
        setLoadingFolders(new Set());
        if (changed) {
            setFolderScanPath(null);
            setFolderItems([]);
        }
    }, [selectedCategoryId, activeFolderPath]);

    // Auto-select first item
    useEffect(() => {
        if (items.length === 0) { setSelectedItemId(null); return; }
        if (!selectedItemId || !items.some((it) => it.id === selectedItemId)) {
            setSelectedItemId(items[0].id);
        }
    }, [items, selectedItemId]);

    // Column menu dismiss
    useEffect(() => {
        if (!columnMenuPos) return;
        const onMouseDown = (e: MouseEvent) => {
            if (!columnMenuRef.current) return;
            if (!columnMenuRef.current.contains(e.target as Node)) setColumnMenuPos(null);
        };
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setColumnMenuPos(null); };
        window.addEventListener('mousedown', onMouseDown);
        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [columnMenuPos]);

    // Stop preview on category change
    useEffect(() => {
        if (prevCatForPreviewRef.current !== selectedCategoryId) {
            prevCatForPreviewRef.current = selectedCategoryId;
            engineApi.stopPreview().catch(() => { /* ignore */ });
            isPreviewPlayingRef.current = false;
        }
    }, [selectedCategoryId]);

    // Scroll selected item into view
    useEffect(() => {
        if (!selectedItemId) return;
        if (selectedCategoryId === 'plugins') {
            const row = itemRowRefs.current[selectedItemId];
            row?.scrollIntoView({ block: 'nearest' });
            return;
        }
        const index = items.findIndex(it => it.id === selectedItemId);
        if (index === -1) return;
        const el = fileListRef.current;
        if (!el) return;
        const ROW_HEIGHT = 28;
        const headerOffset = 24;
        const itemTop = index * ROW_HEIGHT;
        const itemBottom = itemTop + ROW_HEIGHT;
        if (itemTop < el.scrollTop + headerOffset) el.scrollTop = itemTop - headerOffset;
        else if (itemBottom > el.scrollTop + el.clientHeight) el.scrollTop = itemBottom - el.clientHeight;
    }, [selectedItemId, items, selectedCategoryId]);

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
