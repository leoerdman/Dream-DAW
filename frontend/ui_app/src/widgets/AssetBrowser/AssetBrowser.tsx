import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { AudioFileEntry, BrowserFileEntry, PeakPair } from '@/shared/api/engine';
import { useDragStore } from '@/shared/stores/useDragStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import {
    INTERNAL_EFFECT_PLUGINS,
    INTERNAL_INSTRUMENT_PLUGINS,
} from '@/shared/lib/internalPlugins';

/**
 * AssetBrowser — Ableton-style two-pane vertical-split sidebar browser.
 *
 * Ported from BrowserSidebarView.swift (1639 lines).
 *
 * Layout (LEFT panel | RIGHT panel):
 *   ┌──────────────────────────────────────────┐
 *   │ 🔎 Search (Cmd+F)                        │
 *   ├────────────┬─────────────────────────────┤
 *   │ COLLECTIONS│ Source: All   Format: All   │
 *   │  ★ Fav…    │ Audio: All                  │
 *   │           │──────────────────────────────│
 *   │ LIBRARY    │  Real audio files from disk │
 *   │  ≡ All     │  Real plugins from system   │
 *   │  ♫ Samples │  User-added folder contents │
 *   │  🧩 Plug…  │  ...                        │
 *   │           │                             │
 *   │ PLACES     │                             │
 *   │  📁 MyDir  │  (user-added, removable)    │
 *   │  ＋ Add…   │                             │
 *   └──────────────────────────────────────────┘
 */

// ── Types ──────────────────────────────────────────────────

type BrowserIconName =
    | 'star'
    | 'search'
    | 'folder-tree'
    | 'grid'
    | 'wave'
    | 'wave-bars'
    | 'music'
    | 'drum'
    | 'piano'
    | 'plug'
    | 'sliders'
    | 'clapper'
    | 'sine'
    | 'hard-drive'
    | 'package'
    | 'user'
    | 'file'
    | 'folder'
    | 'folder-plus'
    | 'chevron-right'
    | 'chevron-down'
    | 'arrow-left'
    | 'hourglass'
    | 'triangle-alert'
    | 'headphones'
    | 'settings';

interface BrowserCategory {
    id: string;
    title: string;
    icon: BrowserIconName;
    kind: 'section' | 'leaf';
    markerColor?: string;
    /** For user-added folders — the absolute path */
    folderPath?: string;
    /** Whether this folder can be removed (user-added) */
    removable?: boolean;
}

interface BrowserItem {
    id: string;
    name: string;
    type: 'audio' | 'instrument' | 'audioEffect' | 'midiEffect' | 'plugin' | 'folder' | 'project' | 'preset' | 'other';
    format?: string;
    meta?: string;
    favorite?: boolean;
    /** Absolute path to file on disk (for drag-and-drop import). */
    path?: string;
    /** Whether this is a navigable directory */
    isDirectory?: boolean;
    slotHint?: 'instrument' | 'effect' | 'auto';
    durationSeconds?: number;
    sizeBytes?: number;
    pluginSource?: 'internal' | 'vst2' | 'vst3' | 'au' | 'external';
}

// ── Static Categories ────────────────────────────────────

const STATIC_CATEGORIES: BrowserCategory[] = [
    { id: 'sec-collections', title: 'Browser', icon: 'search', kind: 'section' },
    { id: 'collection-red', title: 'Collection', icon: 'star', markerColor: '#ef4444', kind: 'leaf' },
    { id: 'collection-yellow', title: 'Collection', icon: 'star', markerColor: '#f59e0b', kind: 'leaf' },
    { id: 'collection-green', title: 'Collection', icon: 'star', markerColor: '#22c55e', kind: 'leaf' },

    { id: 'sec-library', title: 'Library', icon: 'folder-tree', kind: 'section' },
    { id: 'all', title: 'All', icon: 'grid', kind: 'leaf' },
    { id: 'samples', title: 'Samples', icon: 'wave-bars', kind: 'leaf' },
    { id: 'sounds', title: 'Sounds', icon: 'music', kind: 'leaf' },
    { id: 'drums', title: 'Drums', icon: 'drum', kind: 'leaf' },
    { id: 'instruments', title: 'Instruments', icon: 'piano', kind: 'leaf' },
    { id: 'plugins', title: 'Plug-Ins', icon: 'plug', kind: 'leaf' },
    { id: 'audioEffects', title: 'Audio Eff…', icon: 'sliders', kind: 'leaf' },
];

const SOURCE_FILTERS = ['Source: All', 'Source: Library', 'Source: Samples', 'Source: Plug-ins'] as const;
const FORMAT_FILTERS = ['Format: All', 'WAV', 'AIFF', 'MP3', 'FLAC'] as const;
const AUDIO_FILTERS = ['Audio: All', 'Loops', 'One Shot', 'Drums', 'Vocals'] as const;
const SORT_FILTERS = ['Sort: Name ↑', 'Sort: Name ↓', 'Sort: Size ↑', 'Sort: Size ↓'] as const;
const SIZE_FILTERS = ['Filter: All', '< 1 MB', '≥ 1 MB'] as const;

const INTERNAL_INSTRUMENT_ITEMS: BrowserItem[] = INTERNAL_INSTRUMENT_PLUGINS.map((plugin) => ({
    id: `internal-inst-${plugin.name.toLowerCase().replace(/\\s+/g, '-')}`,
    name: plugin.name,
    type: 'plugin',
    meta: 'Internal Instrument',
    path: plugin.id,
    slotHint: plugin.slotHint,
    pluginSource: 'internal',
}));

const INTERNAL_EFFECT_ITEMS: BrowserItem[] = INTERNAL_EFFECT_PLUGINS.map((plugin) => ({
    id: `internal-fx-${plugin.name.toLowerCase().replace(/\\s+/g, '-')}`,
    name: plugin.name,
    type: 'plugin',
    meta: 'Internal Audio FX',
    path: plugin.id,
    slotHint: plugin.slotHint,
    pluginSource: 'internal',
}));

function detectPluginSource(raw: string): BrowserItem['pluginSource'] {
    const norm = raw.toLowerCase();
    if (norm.includes('internal://')) return 'internal';
    if (norm.includes('.vst3') || norm.includes('vst3')) return 'vst3';
    if (norm.includes('.vst') || norm.includes('vst2') || norm.includes(' vst ')) return 'vst2';
    if (norm.includes('.component') || norm.includes(' audio unit') || norm.includes(' au ')) return 'au';
    return 'external';
}

function isLikelyInstrumentPlugin(item: BrowserItem): boolean {
    const text = `${item.name} ${item.meta ?? ''} ${item.format ?? ''}`.toLowerCase();
    return (
        text.includes('synth')
        || text.includes('serum')
        || text.includes('piano')
        || text.includes('sampler')
        || text.includes('kontakt')
        || text.includes('instrument')
    );
}

function isLikelyDrumAudio(item: BrowserItem): boolean {
    const text = item.name.toLowerCase();
    return (
        text.includes('kick')
        || text.includes('snare')
        || text.includes('clap')
        || text.includes('hihat')
        || text.includes('hat')
        || text.includes('drum')
        || text.includes('perc')
    );
}

const PLUGIN_SOURCE_ORDER: Array<NonNullable<BrowserItem['pluginSource']>> = [
    'internal',
    'vst3',
    'vst2',
    'au',
    'external',
];

const PLUGIN_SOURCE_LABEL: Record<NonNullable<BrowserItem['pluginSource']>, string> = {
    internal: 'Internal',
    vst3: 'VST3',
    vst2: 'VST2',
    au: 'Audio Unit',
    external: 'External',
};

// ── File type helpers ───────────────────────────────────

function fileTypeToItemType(ft: string): BrowserItem['type'] {
    switch (ft) {
        case 'audio': return 'audio';
        case 'plugin': return 'plugin';
        case 'project': return 'project';
        case 'preset': return 'preset';
        case 'folder': return 'folder';
        default: return 'other';
    }
}

function selectBestPeakLevel(levels: { peaks: PeakPair[] }[]): PeakPair[] | null {
    for (let i = levels.length - 1; i >= 0; i -= 1) {
        const peaks = levels[i]?.peaks;
        if (peaks && peaks.length > 0) return peaks;
    }
    for (let i = 0; i < levels.length; i += 1) {
        const peaks = levels[i]?.peaks;
        if (peaks && peaks.length > 0) return peaks;
    }
    return null;
}

function fuzzyScore(text: string, query: string): number | null {
    const t = text.toLowerCase();
    const q = query.toLowerCase().trim();
    if (!q) return 0;

    if (t === q) return 0;

    const starts = t.startsWith(q);
    if (starts) {
        return 1 + (t.length - q.length) * 0.02;
    }

    const wordMatch = t.match(new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    if (wordMatch) {
        const idx = wordMatch.index ?? 0;
        return 6 + idx * 0.2 + (t.length - q.length) * 0.02;
    }

    const idx = t.indexOf(q);
    if (idx >= 0) {
        return 12 + idx * 0.35 + (t.length - q.length) * 0.03;
    }

    // Subsequence fallback: good for short fuzzy typing like "zbr" -> "Zebra".
    let ti = 0;
    let qi = 0;
    let first = -1;
    let last = -1;
    while (ti < t.length && qi < q.length) {
        if (t[ti] === q[qi]) {
            if (first < 0) first = ti;
            last = ti;
            qi += 1;
        }
        ti += 1;
    }
    if (qi !== q.length) return null;
    const span = Math.max(1, last - first + 1);
    const gaps = span - q.length;
    return 40 + gaps * 1.8 + first * 0.3 + (t.length - q.length) * 0.04;
}

function renderHighlightedMatch(name: string, query: string) {
    const q = query.trim();
    if (!q) return name;

    const lowerName = name.toLowerCase();
    const lowerQuery = q.toLowerCase();

    const contiguousIdx = lowerName.indexOf(lowerQuery);
    if (contiguousIdx >= 0) {
        const before = name.slice(0, contiguousIdx);
        const match = name.slice(contiguousIdx, contiguousIdx + q.length);
        const after = name.slice(contiguousIdx + q.length);
        return (
            <>
                {before}
                <span style={{ color: 'var(--color-accent-primary)', fontWeight: 700 }}>{match}</span>
                {after}
            </>
        );
    }

    // Fallback for fuzzy-subsequence matches.
    const hitPositions = new Set<number>();
    let ni = 0;
    for (let qi = 0; qi < lowerQuery.length; qi += 1) {
        const ch = lowerQuery[qi];
        const pos = lowerName.indexOf(ch, ni);
        if (pos < 0) return name;
        hitPositions.add(pos);
        ni = pos + 1;
    }

    return (
        <>
            {name.split('').map((ch, idx) => (
                hitPositions.has(idx)
                    ? <span key={`${ch}-${idx}`} style={{ color: 'var(--color-accent-primary)', fontWeight: 700 }}>{ch}</span>
                    : <span key={`${ch}-${idx}`}>{ch}</span>
            ))}
        </>
    );
}

// ── Component ──────────────────────────────────────────

export const AssetBrowser = () => {
    const settings = useSettingsStore((s) => s.settings);
    const settingsLoaded = useSettingsStore((s) => s.loaded);
    const updateAllSettings = useSettingsStore((s) => s.updateAllSettings);

    const [searchQuery, setSearchQuery] = useState('');
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
    const [collectionLabels, setCollectionLabels] = useState<Record<string, string>>({
        'collection-red': 'Collection',
        'collection-yellow': 'Collection',
        'collection-green': 'Collection',
    });
    const [previewEnabled, setPreviewEnabled] = useState(true);
    const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
    const [leftPaneWidth, setLeftPaneWidth] = useState(settings.browserLeftPaneWidth);
    const projectTracks = useEngineStore((s) => s.projectTracks);

    // Preview waveform state
    const [previewPeaks, setPreviewPeaks] = useState<PeakPair[] | null>(null);
    const audioDurationSecRef = useRef<Record<string, number>>({});

    // ── User folders (PLACES section) ──
    const [userFolders, setUserFolders] = useState<string[]>([]);

    // ── Folder navigation stack (for browsing into subfolders) ──
    const [folderStack, setFolderStack] = useState<string[]>([]);

    const searchRef = useRef<HTMLInputElement>(null);
    const fileListRef = useRef<HTMLDivElement>(null);
    const splitRootRef = useRef<HTMLDivElement>(null);
    const leftPaneWidthRef = useRef(leftPaneWidth);
    const itemRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const columnMenuRef = useRef<HTMLDivElement>(null);
    const [currentProjectFolder, setCurrentProjectFolder] = useState<string | null>(null);

    useEffect(() => {
        leftPaneWidthRef.current = leftPaneWidth;
    }, [leftPaneWidth]);

    // ── Load user folders on mount ──
    useEffect(() => {
        engineApi.getBrowserFolders()
            .then(folders => setUserFolders(folders))
            .catch(err => console.warn('[Browser] Failed to load folders:', err));
    }, []);

    // Build dynamic categories (static + user folders)
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
            return {
                ...cat,
                title: collectionLabels[cat.id] ?? cat.title,
            };
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

    // Keyboard shortcut
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

    useEffect(() => {
        const focusBrowserSearch = (evt: Event) => {
            const detail = (evt as CustomEvent<{ categoryId?: string }>).detail;
            if (detail?.categoryId) {
                setSelectedCategoryId(detail.categoryId);
                setFolderStack([]);
            }
            searchRef.current?.focus();
            searchRef.current?.select();
        };
        const setBrowserSearch = (evt: Event) => {
            const detail = (evt as CustomEvent<{ query?: string; categoryId?: string }>).detail;
            if (detail?.categoryId) {
                setSelectedCategoryId(detail.categoryId);
                setFolderStack([]);
            }
            if (typeof detail?.query === 'string') {
                setSearchQuery(detail.query);
            }
            searchRef.current?.focus();
        };
        window.addEventListener('dream:browser-focus-search', focusBrowserSearch as EventListener);
        window.addEventListener('dream:browser-set-search', setBrowserSearch as EventListener);
        return () => {
            window.removeEventListener('dream:browser-focus-search', focusBrowserSearch as EventListener);
            window.removeEventListener('dream:browser-set-search', setBrowserSearch as EventListener);
        };
    }, []);

    useEffect(() => {
        if (selectedCategoryId !== 'currentProject') return;
        let mounted = true;
        void engineApi.getProjectStatus()
            .then((status) => {
                if (!mounted) return;
                setCurrentProjectFolder(status.projectFolder ?? null);
            })
            .catch(() => {
                if (!mounted) return;
                setCurrentProjectFolder(null);
            });
        return () => {
            mounted = false;
        };
    }, [selectedCategoryId]);

    useEffect(() => {
        if (!settingsLoaded) return;
        setShowSizeColumn(settings.browserShowSizeColumn);
        setShowTypeColumn(settings.browserShowTypeColumn);
        setLeftPaneWidth(Math.max(84, Math.min(180, settings.browserLeftPaneWidth || 92)));
    }, [
        settingsLoaded,
        settings.browserShowSizeColumn,
        settings.browserShowTypeColumn,
        settings.browserLeftPaneWidth,
    ]);

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

    // ── Real file scanning (samples) ──
    const [realFiles, setRealFiles] = useState<AudioFileEntry[]>([]);
    const [scanLoading, setScanLoading] = useState(false);
    const [scanError, setScanError] = useState<string | null>(null);
    const scanTriggeredRef = useRef(false);

    const isSamplesCategory = ['samples', 'all', 'sounds', 'drums'].includes(selectedCategoryId);

    useEffect(() => {
        if (!isSamplesCategory || scanTriggeredRef.current) return;
        scanTriggeredRef.current = true;

        let cancelled = false;
        const timerId = setTimeout(() => {
            if (cancelled) return;
            setScanLoading(true);
            setScanError(null);

            // Generate demo samples (idempotent, skips if marker exists),
            // then scan ALL audio sources (samples_path + browser_folders) unified.
            engineApi.generateDemoSamples()
                .catch(err => console.warn('[AssetBrowser] Demo sample generation skipped:', err))
                .then(() => {
                    if (cancelled) return Promise.reject('cancelled');
                    return engineApi.scanAllAudioSources();
                })
                .then(files => {
                    if (!cancelled) {
                        setRealFiles(files);
                        setScanLoading(false);
                    }
                })
                .catch(err => {
                    if (!cancelled && err !== 'cancelled') {
                        console.warn('[AssetBrowser] Scan failed:', err);
                        setScanError(String(err));
                        setScanLoading(false);
                    }
                });
        }, 300);

        return () => {
            cancelled = true;
            clearTimeout(timerId);
            scanTriggeredRef.current = false;
        };
    }, [isSamplesCategory]);

    // ── Plugin scanning ──
    const [pluginFiles, setPluginFiles] = useState<BrowserFileEntry[]>([]);
    const [pluginScanNonce, setPluginScanNonce] = useState(0);
    const [pluginScanned, setPluginScanned] = useState(false);

    const triggerPluginScan = useCallback(() => {
        setPluginScanNonce((prev) => prev + 1);
    }, []);

    useEffect(() => {
        const needsPluginCatalog = selectedCategoryId === 'plugins'
            || selectedCategoryId === 'all'
            || selectedCategoryId === 'instruments'
            || selectedCategoryId === 'audioEffects';
        if (!needsPluginCatalog) return;

        const forceRescan = selectedCategoryId === 'plugins' || pluginScanNonce > 0;
        if (pluginScanned && !forceRescan) return;

        let cancelled = false;
        Promise.resolve().then(() => {
            if (cancelled) return;
            setScanError(null);
            setScanLoading(true);
        });

        engineApi.scanPluginFolders()
            .then(files => {
                if (cancelled) return;
                setPluginFiles(files);
                setPluginScanned(true);
                setScanLoading(false);
            })
            .catch(err => {
                if (cancelled) return;
                console.warn('[Browser] Plugin scan failed:', err);
                setScanError(String(err));
                setScanLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [selectedCategoryId, pluginScanNonce, pluginScanned]);

    const handleSetPluginFolder = useCallback(async (target: 'vst2Path' | 'vst3Path') => {
        try {
            const picked = await engineApi.pickFolder();
            if (!picked) return;
            await updateAllSettings({ ...settings, [target]: picked });
            setScanError(null);
            triggerPluginScan();
        } catch (err) {
            console.warn('[Browser] Failed to set plugin folder:', err);
            setScanError(String(err));
        }
    }, [settings, updateAllSettings, triggerPluginScan]);

    // ── User folder scanning ──
    const [folderItems, setFolderItems] = useState<BrowserFileEntry[]>([]);
    const [folderScanPath, setFolderScanPath] = useState<string | null>(null);

    const activeCategory = categories.find(c => c.id === selectedCategoryId);
    const userLibraryFolder = settings.userFolderPath?.trim() || null;
    const activeFolderPath = folderStack.length > 0
        ? folderStack[folderStack.length - 1]
        : selectedCategoryId === 'currentProject'
            ? currentProjectFolder
            : selectedCategoryId === 'userLibrary'
                ? userLibraryFolder
                : activeCategory?.folderPath || null;

    useEffect(() => {
        if (!activeFolderPath || activeFolderPath === folderScanPath) return;
        Promise.resolve().then(() => {
            setFolderScanPath(activeFolderPath);
            setScanLoading(true);
        });

        engineApi.scanFolderAll(activeFolderPath)
            .then(files => {
                setFolderItems(files);
                setScanLoading(false);
            })
            .catch(err => {
                console.warn('[Browser] Folder scan failed:', err);
                setScanError(String(err));
                setScanLoading(false);
            });
    }, [activeFolderPath, folderScanPath]);

    // Reset folder state when category changes
    useEffect(() => {
        Promise.resolve().then(() => {
            setFolderStack([]);
            setFolderScanPath(null);
            setFolderItems([]);
        });
    }, [selectedCategoryId]);

    // Convert real audio files to BrowserItems
    const realBrowserItems: BrowserItem[] = useMemo(() => {
        return realFiles.map((f, i) => {
            const sizeKb = Math.round(f.size_bytes / 1024);
            const sizeMb = (f.size_bytes / (1024 * 1024)).toFixed(1);
            const sizeLabel = sizeKb > 1024 ? `${sizeMb} MB` : `${sizeKb} KB`;
            return {
                id: `real-${i}`,
                name: f.name,
                type: 'audio' as const,
                format: f.format,
                meta: sizeLabel,
                path: f.path,
                durationSeconds: f.duration_seconds ?? undefined,
                sizeBytes: f.size_bytes,
            };
        });
    }, [realFiles]);

    // Convert plugin files to BrowserItems
    const pluginBrowserItems: BrowserItem[] = useMemo(() => {
        return pluginFiles.map((f, i) => ({
            id: `plugin-${i}`,
            name: f.name,
            type: 'plugin' as const,
            format: f.extension,
            meta: f.extension,
            path: f.path,
            slotHint: 'auto' as const,
            sizeBytes: f.size_bytes,
            pluginSource: detectPluginSource(`${f.extension ?? ''} ${f.path ?? ''} ${f.name ?? ''}`),
        }));
    }, [pluginFiles]);

    // Convert folder scan to BrowserItems
    const folderBrowserItems: BrowserItem[] = useMemo(() => {
        return folderItems.map((f, i) => {
            const sizeKb = Math.round(f.size_bytes / 1024);
            const sizeMb = (f.size_bytes / (1024 * 1024)).toFixed(1);
            const sizeLabel = f.is_directory ? '' : (sizeKb > 1024 ? `${sizeMb} MB` : `${sizeKb} KB`);
            return {
                id: `folder-${i}`,
                name: f.name,
                type: fileTypeToItemType(f.file_type),
                format: f.extension || undefined,
                meta: f.is_directory ? 'Folder' : sizeLabel,
                path: f.path,
                isDirectory: f.is_directory,
                durationSeconds: f.duration_seconds ?? undefined,
                sizeBytes: f.size_bytes,
            };
        });
    }, [folderItems]);

    // Get items based on selected category
    const items = useMemo(() => {
        let base: BrowserItem[] = [];
        const pluginSearchMode = selectedCategoryId === 'plugins' && searchQuery.trim().length > 0;

        // Check if this is a user-folder category
        if (activeCategory?.folderPath || folderStack.length > 0) {
            base = folderBrowserItems;
        } else {
            switch (selectedCategoryId) {
                case 'all':
                    base = [
                        ...realBrowserItems,
                        ...INTERNAL_INSTRUMENT_ITEMS,
                        ...INTERNAL_EFFECT_ITEMS,
                        ...pluginBrowserItems,
                    ].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
                    break;
                case 'samples':
                    base = realBrowserItems;
                    break;
                case 'sounds':
                    base = realBrowserItems.filter((i) => !isLikelyDrumAudio(i));
                    break;
                case 'drums':
                    base = realBrowserItems.filter((i) => isLikelyDrumAudio(i));
                    break;
                case 'plugins':
                    base = [...INTERNAL_INSTRUMENT_ITEMS, ...INTERNAL_EFFECT_ITEMS, ...pluginBrowserItems];
                    break;
                case 'audioEffects':
                    base = [...INTERNAL_EFFECT_ITEMS, ...pluginBrowserItems.filter((p) => !isLikelyInstrumentPlugin(p))];
                    break;
                case 'instruments':
                    base = [...INTERNAL_INSTRUMENT_ITEMS, ...pluginBrowserItems.filter((p) => isLikelyInstrumentPlugin(p))];
                    break;
                case 'collection-red':
                case 'collection-yellow':
                case 'collection-green':
                    base = realBrowserItems.filter(i => i.favorite);
                    break;
                case 'currentProject':
                case 'userLibrary':
                    base = folderBrowserItems;
                    break;
                default:
                    base = realBrowserItems;
            }
        }

        if (selectedCategoryId === 'all') {
            base = base.filter((i) => i.type !== 'project');
        }

        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            if (selectedCategoryId === 'plugins') {
                base = base
                    .map((item) => {
                        const sourceHint = item.pluginSource ? ` ${item.pluginSource}` : '';
                        const score = fuzzyScore(`${item.name} ${item.format ?? ''} ${item.meta ?? ''}${sourceHint}`, q);
                        return { item, score };
                    })
                    .filter((entry) => entry.score !== null)
                    .sort((a, b) => {
                        if (a.score !== b.score) return (a.score ?? 0) - (b.score ?? 0);
                        return a.item.name.toLowerCase().localeCompare(b.item.name.toLowerCase());
                    })
                    .map((entry) => entry.item);
            } else {
                base = base.filter(i => i.name.toLowerCase().includes(q));
            }
        }

        if (selectedCategoryId === 'plugins' && pluginSourceFilter !== 'all') {
            base = base.filter((i) => i.type === 'plugin' && i.pluginSource === pluginSourceFilter);
        }

        if (sizeFilter === 1) {
            base = base.filter((i) => (i.sizeBytes ?? 0) < 1024 * 1024);
        } else if (sizeFilter === 2) {
            base = base.filter((i) => (i.sizeBytes ?? 0) >= 1024 * 1024);
        }

        if (pluginSearchMode) {
            return base;
        }

        if (sortFilter === 0) {
            base = [...base].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
        } else if (sortFilter === 1) {
            base = [...base].sort((a, b) => b.name.toLowerCase().localeCompare(a.name.toLowerCase()));
        } else if (sortFilter === 2) {
            base = [...base].sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0));
        } else {
            base = [...base].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
        }

        return base;
    }, [selectedCategoryId, searchQuery, realBrowserItems, pluginBrowserItems, folderBrowserItems, activeCategory, folderStack, sizeFilter, sortFilter, pluginSourceFilter]);

    const pluginGroupedRows = useMemo(() => {
        if (selectedCategoryId !== 'plugins') return [] as Array<
            | { kind: 'header'; id: string; title: string; count: number }
            | { kind: 'item'; id: string; item: BrowserItem }
        >;

        const rows: Array<
            | { kind: 'header'; id: string; title: string; count: number }
            | { kind: 'item'; id: string; item: BrowserItem }
        > = [];

        for (const source of PLUGIN_SOURCE_ORDER) {
            const sourceItems = items.filter((it) => it.type === 'plugin' && (it.pluginSource ?? 'external') === source);
            if (sourceItems.length === 0) continue;
            rows.push({
                kind: 'header',
                id: `plugin-group-${source}`,
                title: PLUGIN_SOURCE_LABEL[source],
                count: sourceItems.length,
            });
            for (const item of sourceItems) {
                rows.push({
                    kind: 'item',
                    id: `plugin-item-${item.id}`,
                    item,
                });
            }
        }

        return rows;
    }, [selectedCategoryId, items]);

    const pluginLetterAnchors = useMemo(() => {
        const itemByLetter: Record<string, string> = {};
        if (selectedCategoryId !== 'plugins') {
            return { letters: [] as string[], itemByLetter };
        }

        for (const row of pluginGroupedRows) {
            if (row.kind !== 'item') continue;
            const firstChar = row.item.name.trim().charAt(0).toUpperCase();
            const letter = /^[A-Z]$/.test(firstChar) ? firstChar : '#';
            if (!itemByLetter[letter]) {
                itemByLetter[letter] = row.item.id;
            }
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

    // ── Virtual scrolling: only render items visible in viewport ──
    // ROW_HEIGHT must match the actual rendered row height (padding + content).
    const ROW_HEIGHT = 28;
    const OVERSCAN = 8; // extra rows above/below viewport for smooth scroll
    const [scrollTop, setScrollTop] = useState(0);
    const [containerHeight, setContainerHeight] = useState(400);

    // Compute visible window
    const totalHeight = items.length * ROW_HEIGHT;
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const endIdx = Math.min(items.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN);
    const visibleItems = useMemo(() => items.slice(startIdx, endIdx), [items, startIdx, endIdx]);

    useEffect(() => {
        let cancelled = false;
        if (items.length === 0) {
            queueMicrotask(() => {
                if (!cancelled) setSelectedItemId(null);
            });
            return;
        }
        if (!selectedItemId || !items.some((it) => it.id === selectedItemId)) {
            const nextId = items[0].id;
            queueMicrotask(() => {
                if (!cancelled) setSelectedItemId(nextId);
            });
        }
        return () => {
            cancelled = true;
        };
    }, [items, selectedItemId]);

    useEffect(() => {
        const onMouseDown = (e: MouseEvent) => {
            if (!columnMenuRef.current) return;
            if (!columnMenuRef.current.contains(e.target as Node)) {
                setColumnMenuPos(null);
            }
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setColumnMenuPos(null);
        };
        window.addEventListener('mousedown', onMouseDown);
        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('keydown', onKeyDown);
        };
    }, []);

    // Measure container height on mount and resize
    useEffect(() => {
        const el = fileListRef.current;
        if (!el) return;
        const ro = new ResizeObserver(entries => {
            for (const entry of entries) {
                setContainerHeight(entry.contentRect.height);
            }
        });
        ro.observe(el);
        setContainerHeight(el.clientHeight);
        return () => ro.disconnect();
    }, []);

    const handleFileListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        setScrollTop(e.currentTarget.scrollTop);
    }, []);

    // ── Handle Add Folder ──
    const handleAddFolder = useCallback(() => {
        engineApi.addBrowserFolder()
            .then(folders => {
                setUserFolders(folders);
                // Select the newly added folder
                const newIdx = folders.length - 1;
                if (newIdx >= 0) setSelectedCategoryId(`user-folder-${newIdx}`);
            })
            .catch(err => {
                if (!String(err).includes('Cancelled')) {
                    console.error('[Browser] Add folder failed:', err);
                }
            });
    }, []);

    // ── Handle Remove Folder ──
    const handleRemoveFolder = useCallback((path: string) => {
        engineApi.removeBrowserFolder(path)
            .then(folders => {
                setUserFolders(folders);
                setSelectedCategoryId('samples');
            })
            .catch(err => console.error('[Browser] Remove folder failed:', err));
    }, []);

    // ── Navigate into subfolder ──
    const navigateInto = useCallback((path: string) => {
        setFolderStack(prev => [...prev, path]);
        setFolderScanPath(null); // Force re-scan
    }, []);

    // ── Navigate back to parent ──
    const navigateBack = useCallback(() => {
        setFolderStack(prev => prev.slice(0, -1));
        setFolderScanPath(null); // Force re-scan
    }, []);

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

        const track = resolveSelectedTrack();
        if (!track) return;

        try {
            if (item.type === 'plugin') {
                const primary: 'instrument' | 'effect' | 'auto' = item.slotHint ?? 'auto';
                const fallbackSlot: 'instrument' | 'effect' =
                    primary === 'instrument' ? 'effect' : 'instrument';
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
                    } catch (err) {
                        lastErr = err;
                    }
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
                    await engineApi.addPluginToTrack(
                        track.id,
                        'internal://instrument/sampler',
                        'Sampler',
                        'instrument',
                    );
                }
                await engineApi.setSamplerSample(track.id, item.path);
                await useEngineStore.getState().fetchProject();
                return;
            }

            const trackIndex = projectTracks.findIndex((t) => t.id === track.id);
            if (trackIndex < 0) return;
            const store = useEngineStore.getState();
            const bpm = store.projectBpm || store.transport.bpm || 120;
            const sampleRate = store.projectSampleRate || store.transport.sample_rate || 44100;
            const posSeconds = (store.transport.position_beats ?? 0) / (bpm / 60);
            const positionFrames = Math.max(0, Math.round(posSeconds * sampleRate));
            await engineApi.importAudioFile(item.path, trackIndex, positionFrames);
            await store.fetchProject();
        } catch (err) {
            console.error('[AssetBrowser] Enter action failed:', err);
        }
    }, [resolveSelectedTrack, projectTracks]);

    const syncPreviewForItem = useCallback((item: BrowserItem | null) => {
        if (item?.type === 'audio' && item.path) {
            engineApi.getWaveformPeaks(item.path)
                .then(peaks => {
                    setPreviewPeaks(selectBestPeakLevel(peaks.mip_levels));
                    if (peaks.sample_rate > 0 && peaks.total_samples > 0) {
                        audioDurationSecRef.current[item.path!] = peaks.total_samples / peaks.sample_rate;
                    }
                })
                .catch(() => setPreviewPeaks(null));

            if (previewEnabled) {
                engineApi.previewAudioFile(item.path)
                    .catch(err => {
                        console.warn('[Preview]', err);
                    });
            } else {
                engineApi.stopPreview().catch(() => { });
            }
            return;
        }

        engineApi.stopPreview().catch(() => { });
        setPreviewPeaks(null);
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

    const scrollSelectedIntoView = useCallback((itemId: string | null) => {
        if (!itemId) return;
        const row = itemRowRefs.current[itemId];
        row?.scrollIntoView({ block: 'nearest' });
    }, []);

    useEffect(() => {
        scrollSelectedIntoView(selectedItemId);
    }, [selectedItemId, scrollSelectedIntoView]);

    const moveSelection = useCallback((delta: number) => {
        if (items.length === 0) return;
        const currentIndex = selectedItemId
            ? items.findIndex((it) => it.id === selectedItemId)
            : -1;
        const fallbackIndex = delta >= 0 ? 0 : items.length - 1;
        const rawNextIndex = currentIndex < 0 ? fallbackIndex : currentIndex + delta;
        const nextIndex = Math.max(0, Math.min(items.length - 1, rawNextIndex));
        const next = items[nextIndex];
        if (!next) return;
        setSelectedItemId(next.id);
        syncPreviewForItem(next);
        if (selectedCategoryId === 'plugins') {
            queueMicrotask(() => {
                itemRowRefs.current[next.id]?.scrollIntoView({ block: 'nearest' });
            });
            return;
        }
        // Scroll into view for virtual scrolling
        const el = fileListRef.current;
        if (el) {
            const itemTop = nextIndex * ROW_HEIGHT;
            const itemBottom = itemTop + ROW_HEIGHT;
            // Account for sticky header (approx 24px)
            const headerOffset = 24;
            if (itemTop < el.scrollTop + headerOffset) {
                el.scrollTop = itemTop - headerOffset;
            } else if (itemBottom > el.scrollTop + el.clientHeight) {
                el.scrollTop = itemBottom - el.clientHeight;
            }
        }
    }, [items, selectedItemId, selectedCategoryId, syncPreviewForItem]);

    const focusResults = useCallback(() => {
        fileListRef.current?.focus();
    }, []);

    const handleBrowserKeyDown = useCallback((e: React.KeyboardEvent) => {
        const activeEl = document.activeElement;
        if (e.key === 'Escape') {
            if (activeEl === searchRef.current && searchQuery.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                setSearchQuery('');
                setScrollTop(0);
                if (fileListRef.current) fileListRef.current.scrollTop = 0;
            }
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            moveSelection(1);
            focusResults();
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            moveSelection(-1);
            focusResults();
            return;
        }
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
        const selected = items.find((it) => it.id === selectedItemId) ?? visibleItems[0] ?? null;
        if (!selected) return;

        if (activeEl === searchRef.current) {
            if (!selectedItemId) setSelectedItemId(selected.id);
            focusResults();
            return;
        }
        void handleItemEnter(selected);
    }, [focusResults, handleItemEnter, items, jumpToPluginLetter, moveSelection, pluginLetterAnchors, searchQuery.length, selectedCategoryId, selectedItemId, visibleItems]);

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
            if (rafId === null) {
                rafId = window.requestAnimationFrame(flushWidth);
            }
        };
        const onUp = () => {
            if (rafId !== null) {
                window.cancelAnimationFrame(rafId);
                rafId = null;
            }
            flushWidth();
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            const finalWidth = Math.max(84, Math.min(180, leftPaneWidthRef.current));
            persistBrowserPrefs({ browserLeftPaneWidth: finalWidth });
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [persistBrowserPrefs]);

    // Track current section for collapse logic
    let currentSection: string | null = null;

    return (
        <div data-testid="asset-browser" style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            background: 'var(--color-bg-panel)',
            fontSize: 'var(--font-size-xs)',
        }}>

            {/* ── Search ────────── */}
            <div style={{
                padding: '6px 8px',
                borderBottom: '1px solid var(--color-divider)',
                background: 'var(--color-bg-header)',
            }}>
                <input
                    ref={searchRef}
                    type="text"
                    placeholder="Search… (⌘F)"
                    value={searchQuery}
                    onChange={e => {
                        const nextQuery = e.target.value;
                        setSearchQuery(nextQuery);
                        if (nextQuery.trim().length > 0 && selectedCategoryId !== 'all') {
                            setSelectedCategoryId('all');
                        }
                        setScrollTop(0); if (fileListRef.current) fileListRef.current.scrollTop = 0;
                    }}
                    onKeyDown={handleBrowserKeyDown}
                    style={{
                        width: '100%',
                        padding: '6px 10px',
                        background: 'var(--color-bg-input)',
                        color: 'var(--color-text-primary)',
                        border: '1px solid var(--color-border-subtle)',
                        borderRadius: 'var(--radius-xs)',
                        fontSize: 'var(--font-size-sm)',
                        fontFamily: 'var(--font-mono)',
                        outline: 'none',
                    }}
                />
            </div>

            {/* ══════════════════════════════════════════════
                TWO-PANE VERTICAL SPLIT (Ableton-style)
               ══════════════════════════════════════════════ */}
            <div style={{
                flex: 1,
                display: 'flex',
                overflow: 'hidden',
            }} ref={splitRootRef}>
                {/* ── LEFT PANE: Category Tree ── */}
                <div
                    className="scrollbar-hide"
                    style={{
                        width: leftPaneWidth,
                        minWidth: 88,
                        flexShrink: 0,
                        overflowY: 'auto',
                        borderRight: '1px solid var(--color-divider)',
                        background: 'var(--color-bg-panel)',
                    }}
                >
                    {categories.map(cat => {
                        // Section header
                        if (cat.kind === 'section') {
                            const collapsed = cat.id === 'sec-collections' ? false : collapsedSections.has(cat.id);
                            currentSection = cat.id;
                            const addTopGap = cat.id === 'sec-library' || cat.id === 'sec-folders';
                            const isBrowserSection = cat.id === 'sec-collections';
                            return (
                                <div key={cat.id} style={{ marginTop: addTopGap ? 10 : 0 }}>
                                    <button
                                        onClick={isBrowserSection ? undefined : () => toggleSection(cat.id)}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 4,
                                            width: '100%',
                                            padding: '3px 6px 3px 12px',
                                            background: 'none',
                                            border: 'none',
                                            color: '#ffffff',
                                            fontSize: 'var(--font-size-sm)',
                                            fontWeight: 700,
                                            textTransform: 'uppercase',
                                            letterSpacing: '0.04em',
                                            cursor: isBrowserSection ? 'default' : 'pointer',
                                            opacity: 0.9,
                                        }}
                                    >
                                        <span style={{ width: 14, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
                                            <BrowserGlyph name={cat.icon} size={11} />
                                        </span>
                                        <span style={{
                                            flex: 1,
                                            minWidth: 0,
                                            textAlign: 'left',
                                        }}>
                                            {cat.title}
                                        </span>
                                        {!isBrowserSection && (
                                            <svg
                                                width="9"
                                                height="9"
                                                viewBox="0 0 9 9"
                                                style={{
                                                    flexShrink: 0,
                                                    opacity: 0.78,
                                                }}
                                                aria-hidden
                                            >
                                                <polyline
                                                    points={collapsed ? '2,1 6,4.5 2,8' : '1,2 4.5,6 8,2'}
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="1.4"
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                />
                                            </svg>
                                        )}
                                    </button>
                                </div>
                            );
                        }

                        // Leaf item — hidden if parent section collapsed
                        const parentSectionId = currentSection;
                        if (parentSectionId && collapsedSections.has(parentSectionId)) return null;

                        const isSelected = selectedCategoryId === cat.id;

                        // Special: Add Folder button
                        if (cat.id === 'addFolder') {
                            return (
                                <button
                                    key={cat.id}
                                    onClick={handleAddFolder}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 4,
                                        width: '100%',
                                        padding: '2px 4px 2px 12px',
                                        background: 'transparent',
                                        border: 'none',
                                        color: '#ffffff',
                                        fontSize: 'var(--font-size-base)',
                                        fontWeight: 600,
                                        textAlign: 'left',
                                        cursor: 'pointer',
                                        transition: 'background var(--transition-fast)',
                                        lineHeight: 1.9,
                                        opacity: 0.95,
                                    }}
                                >
                                    <span style={{ width: 14, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
                                        <BrowserGlyph name={cat.icon} size={12} />
                                    </span>
                                    <span>Add Fol…</span>
                                </button>
                            );
                        }

                        return (
                            <button
                                key={cat.id}
                                onClick={() => {
                                    setSelectedCategoryId(cat.id);
                                    setScrollTop(0); if (fileListRef.current) fileListRef.current.scrollTop = 0;
                                }}
                                onContextMenu={cat.removable ? (e) => {
                                    e.preventDefault();
                                    if (cat.folderPath && confirm(`Remove "${cat.title}" from browser?`)) {
                                        handleRemoveFolder(cat.folderPath);
                                    }
                                } : (cat.id.startsWith('collection-') ? (e) => {
                                    e.preventDefault();
                                    const next = window.prompt('Rename collection', cat.title)?.trim();
                                    if (!next) return;
                                    setCollectionLabels((prev) => ({
                                        ...prev,
                                        [cat.id]: next,
                                    }));
                                } : undefined)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    width: '100%',
                                    padding: '2px 4px 2px 12px',
                                    background: isSelected ? 'var(--color-bg-selected)' : 'transparent',
                                    border: 'none',
                                    color: '#ffffff',
                                    fontSize: 'var(--font-size-base)',
                                    fontWeight: isSelected ? 600 : 500,
                                    textAlign: 'left',
                                    cursor: 'pointer',
                                    transition: 'background var(--transition-fast)',
                                    lineHeight: 1.9,
                                }}
                            >
                                <span style={{ width: 14, display: 'inline-flex', justifyContent: 'center', alignItems: 'center', flexShrink: 0, color: '#ffffff' }}>
                                    {cat.markerColor ? (
                                        <span
                                            style={{
                                                width: 7,
                                                height: 7,
                                                borderRadius: '50%',
                                                background: cat.markerColor,
                                                boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.28)',
                                            }}
                                        />
                                    ) : (
                                        <BrowserGlyph name={cat.icon} size={12} />
                                    )}
                                </span>
                                <span style={{
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                }}>{cat.title}</span>
                            </button>
                        );
                    })}
                </div>
                <div
                    onMouseDown={beginSplitResize}
                    style={{
                        width: 6,
                        cursor: 'ew-resize',
                        background: 'transparent',
                        flexShrink: 0,
                    }}
                />

                {/* ── RIGHT PANE: Filters + File List ── */}
                <div style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    background: 'var(--color-bg-secondary)',
                }}>
                    {/* Filters Toolbar */}
                    <div style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 4,
                        padding: '4px 6px',
                        borderBottom: '1px solid var(--color-divider)',
                        background: 'var(--color-bg-header)',
                    }}>
                        {/* Breadcrumb for folder navigation */}
                        {folderStack.length > 0 ? (
                            <button
                                onClick={navigateBack}
                                style={{
                                    background: 'var(--color-accent-primary-dim)',
                                    color: 'var(--color-accent-primary)',
                                    border: 'none',
                                    borderRadius: 'var(--radius-xs)',
                                    padding: '2px 6px',
                                    fontSize: 'var(--font-size-2xs)',
                                    cursor: 'pointer',
                                    fontWeight: 600,
                                }}
                            >
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                    <BrowserGlyph name="arrow-left" size={10} />
                                    Back
                                </span>
                            </button>
                        ) : (
                            <>
                                {selectedCategoryId === 'plugins' ? (
                                    <>
                                        <FilterPill
                                            options={[
                                                'Source: All',
                                                'Source: Internal',
                                                'Source: VST3',
                                                'Source: VST2',
                                                'Source: AU',
                                                'Source: External',
                                            ]}
                                            value={{ all: 0, internal: 1, vst3: 2, vst2: 3, au: 4, external: 5 }[pluginSourceFilter]}
                                            onChange={(idx) => {
                                                const next = (['all', 'internal', 'vst3', 'vst2', 'au', 'external'] as const)[idx] ?? 'all';
                                                setPluginSourceFilter(next);
                                            }}
                                        />
                                        <button
                                            onClick={triggerPluginScan}
                                            style={pluginActionButtonStyle}
                                            title="Rescan installed plugins"
                                        >
                                            Rescan
                                        </button>
                                        <button
                                            onClick={() => { void handleSetPluginFolder('vst2Path'); }}
                                            style={pluginActionButtonStyle}
                                            title="Select VST2 folder"
                                        >
                                            Import VST2 Folder
                                        </button>
                                        <button
                                            onClick={() => { void handleSetPluginFolder('vst3Path'); }}
                                            style={pluginActionButtonStyle}
                                            title="Select VST3 folder"
                                        >
                                            Import VST3 Folder
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        <FilterPill
                                            options={SOURCE_FILTERS as unknown as string[]}
                                            value={sourceFilter}
                                            onChange={setSourceFilter}
                                        />
                                        <FilterPill
                                            options={FORMAT_FILTERS as unknown as string[]}
                                            value={formatFilter}
                                            onChange={setFormatFilter}
                                        />
                                        <FilterPill
                                            options={AUDIO_FILTERS as unknown as string[]}
                                            value={audioFilter}
                                            onChange={setAudioFilter}
                                        />
                                    </>
                                )}
                                <FilterPill
                                    options={SORT_FILTERS as unknown as string[]}
                                    value={sortFilter}
                                    onChange={setSortFilter}
                                />
                                <FilterPill
                                    options={SIZE_FILTERS as unknown as string[]}
                                    value={sizeFilter}
                                    onChange={setSizeFilter}
                                />
                            </>
                        )}
                    </div>

                    {selectedCategoryId === 'plugins' && folderStack.length === 0 && (
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '2px 8px',
                            borderBottom: '1px solid var(--color-divider-light)',
                            background: 'var(--color-bg-header)',
                            fontSize: 'var(--font-size-2xs)',
                            color: 'var(--color-text-tertiary)',
                            fontFamily: 'var(--font-mono)',
                        }}>
                            <span>INT: {INTERNAL_INSTRUMENT_ITEMS.length + INTERNAL_EFFECT_ITEMS.length}</span>
                            <span>EXT: {pluginBrowserItems.length}</span>
                            <span style={{ opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                VST2: {settings.vst2Path || 'not set'}
                            </span>
                            <span style={{ opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                VST3: {settings.vst3Path || 'not set'}
                            </span>
                        </div>
                    )}

                    {selectedCategoryId === 'plugins' && folderStack.length === 0 && pluginLetterAnchors.letters.length > 0 && (
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '3px 8px',
                            borderBottom: '1px solid var(--color-divider-light)',
                            background: 'var(--color-bg-header)',
                            overflowX: 'auto',
                        }}>
                            {pluginLetterAnchors.letters.map((letter) => (
                                <button
                                    key={letter}
                                    onClick={() => jumpToPluginLetter(letter)}
                                    style={{
                                        minWidth: 18,
                                        height: 16,
                                        borderRadius: 'var(--radius-md)',
                                        border: '1px solid var(--color-divider)',
                                        background: selectedPluginLetter === letter
                                            ? 'var(--color-control-bg-active)'
                                            : 'var(--color-control-bg)',
                                        color: selectedPluginLetter === letter
                                            ? 'var(--color-text-primary)'
                                            : 'var(--color-text-secondary)',
                                        fontSize: 'var(--font-size-2xs)',
                                        fontWeight: 700,
                                        fontFamily: 'var(--font-mono)',
                                        cursor: 'pointer',
                                        padding: 0,
                                        flexShrink: 0,
                                    }}
                                    title={`Jump to ${letter}`}
                                >
                                    {letter}
                                </button>
                            ))}
                        </div>
                    )}

                    {/* Folder path indicator */}
                    {folderStack.length > 0 && (
                        <div style={{
                            padding: '2px 6px',
                            fontSize: 'var(--font-size-2xs)',
                            color: 'var(--color-text-tertiary)',
                            borderBottom: '1px solid var(--color-divider-light)',
                            fontFamily: 'var(--font-mono)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <BrowserGlyph name="folder" size={10} />
                                {folderStack[folderStack.length - 1]?.split('/').pop()}
                            </span>
                        </div>
                    )}

                    {/* File List */}
                    <div
                        ref={fileListRef}
                        className="scrollbar-hide"
                        onScroll={handleFileListScroll}
                        onKeyDown={handleBrowserKeyDown}
                        tabIndex={0}
                        style={{
                            flex: 1,
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            outline: 'none',
                        }}>
                        <div
                            onContextMenu={(e) => {
                                e.preventDefault();
                                setColumnMenuPos({ x: e.clientX, y: e.clientY });
                            }}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                padding: '3px 8px',
                                borderBottom: '1px solid var(--color-divider-light)',
                                background: 'var(--color-bg-header)',
                                color: 'var(--color-text-tertiary)',
                                fontSize: 'var(--font-size-xs)',
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                letterSpacing: '0.04em',
                                position: 'sticky',
                                top: 0,
                                zIndex: 'var(--z-local-raised)' as unknown as number,
                            }}>
                            <button
                                onClick={(e) => {
                                    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                                    setColumnMenuPos((prev) => prev
                                        ? null
                                        : { x: Math.round(rect.right - 8), y: Math.round(rect.bottom + 6) });
                                }}
                                style={{
                                    width: 14,
                                    minWidth: 14,
                                    background: 'transparent',
                                    color: columnMenuPos ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                                    border: 'none',
                                    borderRadius: 'var(--radius-xs)',
                                    padding: 0,
                                    fontSize: 'var(--font-size-xs)',
                                    cursor: 'pointer',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    flexShrink: 0,
                                }}
                                title="Columns"
                            >
                                <BrowserGlyph name="settings" size={10} />
                            </button>
                            <span style={{ flex: 1, minWidth: 0 }}>Name</span>
                            {showTypeColumn && (
                                <span style={{ minWidth: 52, textAlign: 'left', flexShrink: 0 }}>Type</span>
                            )}
                            {showSizeColumn && (
                                <span style={{ minWidth: 44, textAlign: 'right', flexShrink: 0 }}>Size</span>
                            )}
                        </div>
                        {/* Scan Status */}
                        {scanLoading && (
                            <div style={{
                                padding: '12px 10px',
                                textAlign: 'center',
                                color: 'var(--color-text-tertiary)',
                                fontSize: 'var(--font-size-xs)',
                                animation: 'pulse 1.5s ease-in-out infinite',
                            }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                    <BrowserGlyph name="hourglass" size={11} />
                                    Scanning…
                                </span>
                            </div>
                        )}
                        {scanError && !scanLoading && (
                            <div style={{
                                padding: '8px 10px',
                                color: 'var(--color-status-error)',
                                fontSize: 'var(--font-size-xs)',
                                lineHeight: 1.4,
                            }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                                    <BrowserGlyph name="triangle-alert" size={11} />
                                    {selectedCategoryId === 'plugins' ? 'Could not scan plug-ins' : 'Could not scan folder'}
                                </span>
                                <br />
                                <span style={{ opacity: 0.7, fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-2xs)' }}>{scanError}</span>
                            </div>
                        )}
                        {/* Virtual scroll container */}
                        {selectedCategoryId !== 'plugins' ? (
                            <div style={{ height: totalHeight, position: 'relative' }}>
                                {visibleItems.map((item, vi) => {
                                    const absIdx = startIdx + vi;
                                    const isSelected = selectedItemId === item.id;
                                    const isAudio = item.type === 'audio';
                                    const isPlugin = item.type === 'plugin';
                                    const isDraggable = isAudio || isPlugin;
                                    const pluginTypeLabel = item.pluginSource === 'internal'
                                        ? 'Internal'
                                        : item.pluginSource === 'vst3'
                                            ? 'VST3'
                                            : item.pluginSource === 'vst2'
                                                ? 'VST2'
                                                : item.pluginSource === 'au'
                                                    ? 'AU'
                                                    : (item.format || 'Plugin');
                                    const typeLabel = item.isDirectory
                                        ? 'Folder'
                                        : (item.type === 'audio'
                                            ? (item.format || 'Audio').toUpperCase()
                                            : (item.type === 'plugin' ? pluginTypeLabel : (item.format || item.type)));
                                    const sizeLabel = item.sizeBytes && !item.isDirectory
                                        ? (item.sizeBytes >= 1024 * 1024
                                            ? `${(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                                            : `${Math.round(item.sizeBytes / 1024)} KB`)
                                        : '';

                                    return (
                                        <div
                                            key={item.id}
                                            ref={(el) => {
                                                itemRowRefs.current[item.id] = el;
                                            }}
                                            onClick={() => {
                                                if (item.isDirectory && item.path) {
                                                    navigateInto(item.path);
                                                    return;
                                                }

                                                const nextId = selectedItemId === item.id ? null : item.id;
                                                setSelectedItemId(nextId);
                                                syncPreviewForItem(nextId ? item : null);
                                            }}
                                            onMouseDown={(e) => {
                                                if (!isDraggable || !item.path || e.button !== 0) return;

                                                const startX = e.clientX;
                                                const startY = e.clientY;
                                                const DRAG_THRESHOLD = 5;
                                                let dragStarted = false;
                                                let cancelled = false;

                                                const onMove = (me: MouseEvent) => {
                                                    const dx = me.clientX - startX;
                                                    const dy = me.clientY - startY;
                                                    if (!dragStarted && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
                                                        dragStarted = true;
                                                        const knownDuration = isAudio
                                                            ? item.durationSeconds
                                                            ?? audioDurationSecRef.current[item.path!]
                                                            ?? undefined
                                                            : undefined;
                                                        useDragStore.getState().startDrag({
                                                            id: item.id,
                                                            name: item.name,
                                                            type: isPlugin ? 'plugin' : 'audio',
                                                            path: item.path!,
                                                            slotHint: item.slotHint ?? 'auto',
                                                            durationSeconds: knownDuration,
                                                        }, me.clientX, me.clientY);

                                                        if (isAudio && knownDuration === undefined) {
                                                            void engineApi.getAudioFileDuration(item.path!)
                                                                .then((durationSeconds) => {
                                                                    audioDurationSecRef.current[item.path!] = durationSeconds;
                                                                    if (cancelled) return;
                                                                    useDragStore.getState().updateDraggingItem({ durationSeconds });
                                                                })
                                                                .catch(() => {
                                                                    // Keep drag active even if duration probe fails.
                                                                });
                                                        }
                                                    }
                                                };
                                                const onUp = () => {
                                                    cancelled = true;
                                                    window.removeEventListener('mousemove', onMove);
                                                    window.removeEventListener('mouseup', onUp);
                                                };
                                                window.addEventListener('mousemove', onMove);
                                                window.addEventListener('mouseup', onUp);
                                            }}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: 8,
                                                padding: '4px 8px',
                                                cursor: item.isDirectory ? 'pointer' : (isDraggable ? 'grab' : 'default'),
                                                background: isSelected ? 'var(--color-bg-selected)' : 'transparent',
                                                borderBottom: '1px solid var(--color-divider-light)',
                                                position: 'absolute',
                                                top: absIdx * ROW_HEIGHT,
                                                left: 0,
                                                right: 0,
                                                height: ROW_HEIGHT,
                                                boxSizing: 'border-box',
                                            }}
                                        >
                                            {item.isDirectory ? (
                                                <span style={{ display: 'inline-flex', flexShrink: 0 }}>
                                                    <BrowserGlyph name="folder" size={11} />
                                                </span>
                                            ) : (
                                                <TypeIcon type={item.type} item={item} />
                                            )}
                                            <span style={{
                                                color: 'var(--color-text-primary)',
                                                fontSize: 'var(--font-size-base)',
                                                fontWeight: 500,
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                                flex: 1,
                                                minWidth: 0,
                                            }}>
                                                {searchQuery.trim()
                                                    ? renderHighlightedMatch(item.name, searchQuery)
                                                    : item.name}
                                            </span>
                                            {showTypeColumn && (
                                                <span style={{
                                                    minWidth: 52,
                                                    maxWidth: 74,
                                                    color: 'var(--color-text-secondary)',
                                                    fontSize: 'var(--font-size-xs)',
                                                    textAlign: 'left',
                                                    whiteSpace: 'nowrap',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    flexShrink: 0,
                                                }}>
                                                    {typeLabel}
                                                </span>
                                            )}
                                            {showSizeColumn && (
                                                <span style={{
                                                    minWidth: 44,
                                                    maxWidth: 56,
                                                    color: 'var(--color-text-secondary)',
                                                    fontSize: 'var(--font-size-xs)',
                                                    textAlign: 'right',
                                                    whiteSpace: 'nowrap',
                                                    flexShrink: 0,
                                                }}>
                                                    {sizeLabel}
                                                </span>
                                            )}
                                            {item.isDirectory && (
                                                <span style={{
                                                    color: 'var(--color-text-tertiary)',
                                                    fontSize: 'var(--font-size-2xs)',
                                                    display: 'inline-flex',
                                                    alignItems: 'center',
                                                    marginLeft: 2,
                                                    flexShrink: 0,
                                                }}>
                                                    <BrowserGlyph name="chevron-right" size={10} />
                                                </span>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div>
                                {pluginGroupedRows.map((row) => {
                                    if (row.kind === 'header') {
                                        return (
                                            <div
                                                key={row.id}
                                                style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'space-between',
                                                    gap: 8,
                                                    padding: '4px 8px',
                                                    background: 'color-mix(in srgb, var(--color-bg-header) 84%, var(--surface-1))',
                                                    borderBottom: '1px solid var(--color-divider-light)',
                                                    borderTop: '1px solid var(--color-divider-light)',
                                                    position: 'sticky',
                                                    top: 24,
                                                    zIndex: 'var(--z-local)' as unknown as number,
                                                }}
                                            >
                                                <span style={{
                                                    color: 'var(--color-text-primary)',
                                                    fontSize: 'var(--font-size-xs)',
                                                    fontWeight: 700,
                                                    textTransform: 'uppercase',
                                                    letterSpacing: '0.04em',
                                                }}>
                                                    {row.title}
                                                </span>
                                                <span style={{
                                                    color: 'var(--color-text-tertiary)',
                                                    fontSize: 'var(--font-size-2xs)',
                                                    fontFamily: 'var(--font-mono)',
                                                }}>
                                                    {row.count}
                                                </span>
                                            </div>
                                        );
                                    }

                                    const item = row.item;
                                    const isSelected = selectedItemId === item.id;
                                    const isAudio = item.type === 'audio';
                                    const isPlugin = item.type === 'plugin';
                                    const isDraggable = isAudio || isPlugin;
                                    const pluginTypeLabel = item.pluginSource === 'internal'
                                        ? 'Internal'
                                        : item.pluginSource === 'vst3'
                                            ? 'VST3'
                                            : item.pluginSource === 'vst2'
                                                ? 'VST2'
                                                : item.pluginSource === 'au'
                                                    ? 'AU'
                                                    : (item.format || 'Plugin');
                                    const typeLabel = item.isDirectory
                                        ? 'Folder'
                                        : (item.type === 'audio'
                                            ? (item.format || 'Audio').toUpperCase()
                                            : (item.type === 'plugin' ? pluginTypeLabel : (item.format || item.type)));
                                    const sizeLabel = item.sizeBytes && !item.isDirectory
                                        ? (item.sizeBytes >= 1024 * 1024
                                            ? `${(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                                            : `${Math.round(item.sizeBytes / 1024)} KB`)
                                        : '';

                                    return (
                                        <div
                                            key={row.id}
                                            ref={(el) => {
                                                itemRowRefs.current[item.id] = el;
                                            }}
                                            onClick={() => {
                                                const nextId = selectedItemId === item.id ? null : item.id;
                                                setSelectedItemId(nextId);
                                                syncPreviewForItem(nextId ? item : null);
                                            }}
                                            onMouseDown={(e) => {
                                                if (!isDraggable || !item.path || e.button !== 0) return;

                                                const startX = e.clientX;
                                                const startY = e.clientY;
                                                const DRAG_THRESHOLD = 5;
                                                let dragStarted = false;

                                                const onMove = (me: MouseEvent) => {
                                                    const dx = me.clientX - startX;
                                                    const dy = me.clientY - startY;
                                                    if (!dragStarted && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
                                                        dragStarted = true;
                                                        useDragStore.getState().startDrag({
                                                            id: item.id,
                                                            name: item.name,
                                                            type: isPlugin ? 'plugin' : 'audio',
                                                            path: item.path!,
                                                            slotHint: item.slotHint ?? 'auto',
                                                            durationSeconds: isAudio ? (item.durationSeconds ?? undefined) : undefined,
                                                        }, me.clientX, me.clientY);
                                                    }
                                                };
                                                const onUp = () => {
                                                    window.removeEventListener('mousemove', onMove);
                                                    window.removeEventListener('mouseup', onUp);
                                                };
                                                window.addEventListener('mousemove', onMove);
                                                window.addEventListener('mouseup', onUp);
                                            }}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: 8,
                                                padding: '4px 8px',
                                                cursor: isDraggable ? 'grab' : 'default',
                                                background: isSelected ? 'var(--color-bg-selected)' : 'transparent',
                                                borderBottom: '1px solid var(--color-divider-light)',
                                                height: ROW_HEIGHT,
                                                boxSizing: 'border-box',
                                            }}
                                        >
                                            <TypeIcon type={item.type} item={item} />
                                            <span style={{
                                                color: 'var(--color-text-primary)',
                                                fontSize: 'var(--font-size-base)',
                                                fontWeight: 500,
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                                flex: 1,
                                                minWidth: 0,
                                            }}>
                                                {item.name}
                                            </span>
                                            {showTypeColumn && (
                                                <span style={{
                                                    minWidth: 52,
                                                    maxWidth: 74,
                                                    color: 'var(--color-text-secondary)',
                                                    fontSize: 'var(--font-size-xs)',
                                                    textAlign: 'left',
                                                    whiteSpace: 'nowrap',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    flexShrink: 0,
                                                }}>
                                                    {typeLabel}
                                                </span>
                                            )}
                                            {showSizeColumn && (
                                                <span style={{
                                                    minWidth: 44,
                                                    maxWidth: 56,
                                                    color: 'var(--color-text-secondary)',
                                                    fontSize: 'var(--font-size-xs)',
                                                    textAlign: 'right',
                                                    whiteSpace: 'nowrap',
                                                    flexShrink: 0,
                                                }}>
                                                    {sizeLabel}
                                                </span>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        {!scanLoading && items.length === 0 && (
                            <div style={{
                                padding: '20px 12px',
                                textAlign: 'center',
                                color: 'var(--color-text-tertiary)',
                                fontSize: 'var(--font-size-xs)',
                            }}>
                                No items found
                            </div>
                        )}
                    </div>

                    {/* ── Footer: Preview Panel (RIGHT pane only) ────────── */}
                    <div style={{
                        borderTop: '1px solid var(--color-divider)',
                        background: 'var(--color-bg-header)',
                    }}>
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            padding: '4px 8px',
                            gap: 5,
                            fontSize: 'var(--font-size-2xs)',
                            color: 'var(--color-text-secondary)',
                        }}>
                            <div style={{
                                flex: 1,
                                minWidth: 0,
                                height: 16,
                                borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--color-border-subtle)',
                                background: 'color-mix(in srgb, #000 18%, transparent)',
                                overflow: 'hidden',
                                display: 'flex',
                                alignItems: 'center',
                                padding: '0 4px',
                            }}>
                                {previewPeaks ? (
                                    <PreviewWaveform peaks={previewPeaks} height={12} />
                                ) : (
                                    <div style={{
                                        width: '100%',
                                        height: 8,
                                        borderRadius: 'var(--radius-xs)',
                                        background: 'color-mix(in srgb, var(--color-text-primary) 4%, transparent)',
                                    }} />
                                )}
                            </div>

                            <button
                                onClick={() => {
                                    const next = !previewEnabled;
                                    setPreviewEnabled(next);
                                    if (!next) {
                                        engineApi.stopPreview().catch(() => { });
                                        return;
                                    }
                                    const selected = items.find(i => i.id === selectedItemId);
                                    if (selected?.type === 'audio' && selected.path) {
                                        engineApi.previewAudioFile(selected.path).catch(() => { });
                                    }
                                }}
                                title={previewEnabled ? 'Preview on' : 'Preview off'}
                                style={{
                                    width: 16,
                                    height: 16,
                                    minWidth: 16,
                                    borderRadius: '50%',
                                    border: '1px solid var(--color-border-subtle)',
                                    background: previewEnabled ? 'var(--color-control-bg-active)' : 'var(--color-control-bg)',
                                    color: previewEnabled ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                                    cursor: 'pointer',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: 'var(--font-size-2xs)',
                                }}
                                aria-pressed={previewEnabled}
                            >
                                <BrowserGlyph name="headphones" size={9} />
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {columnMenuPos && (
                <div
                    ref={columnMenuRef}
                    style={{
                        position: 'fixed',
                        left: Math.max(8, columnMenuPos.x - 140),
                        top: Math.max(8, columnMenuPos.y),
                        width: 150,
                        background: 'var(--surface-2)',
                        border: '1px solid var(--color-border-subtle)',
                        borderRadius: 'var(--radius-xl)',
                        boxShadow: 'var(--shadow-panel)',
                        padding: 6,
                        zIndex: 'var(--z-drag-overlay)' as unknown as number,
                    }}
                >
                    <button
                        onClick={toggleSizeColumn}
                        style={columnMenuItemStyle}
                    >
                        <span style={columnMenuCheckStyle}>{showSizeColumn ? '✓' : ''}</span>
                        Size
                    </button>
                    <button
                        onClick={toggleTypeColumn}
                        style={columnMenuItemStyle}
                    >
                        <span style={columnMenuCheckStyle}>{showTypeColumn ? '✓' : ''}</span>
                        Type
                    </button>
                </div>
            )}

        </div>
    );
};

// ── Sub-components ──────────────────────────────────────

const itemTypeToIcon: Record<BrowserItem['type'], BrowserIconName> = {
    audio: 'wave-bars',
    instrument: 'piano',
    audioEffect: 'sliders',
    midiEffect: 'music',
    plugin: 'plug',
    folder: 'folder',
    project: 'file',
    preset: 'star',
    other: 'grid',
};

const itemTypeToColor: Record<BrowserItem['type'], string> = {
    audio: 'var(--color-text-primary)',
    instrument: 'var(--color-text-primary)',
    audioEffect: 'var(--color-text-primary)',
    midiEffect: 'var(--color-text-primary)',
    plugin: 'var(--color-text-primary)',
    folder: 'var(--color-text-primary)',
    project: 'var(--color-text-primary)',
    preset: 'var(--color-text-primary)',
    other: 'var(--color-text-secondary)',
};

const pluginVersionBadge = (item?: BrowserItem): '2' | '3' | null => {
    if (!item || item.type !== 'plugin') return null;
    if (item.pluginSource === 'internal') return null;
    const raw = `${item.format ?? ''} ${item.meta ?? ''} ${item.name ?? ''} ${item.path ?? ''}`.toLowerCase();
    if (raw.includes('vst3') || raw.endsWith('.vst3')) return '3';
    if (raw.includes('vst2') || raw.endsWith('.vst') || raw.includes(' vst ')) return '2';
    return null;
};

const TypeIcon = ({ type, item }: { type: BrowserItem['type']; item?: BrowserItem }) => {
    const badge = pluginVersionBadge(item);
    return (
        <span style={{ position: 'relative', display: 'inline-flex', color: itemTypeToColor[type] }}>
            <BrowserGlyph name={itemTypeToIcon[type]} size={11} />
            {badge && (
                <span style={{
                    position: 'absolute',
                    right: -4,
                    bottom: -5,
                    minWidth: 9,
                    height: 9,
                    borderRadius: 'var(--radius-full)',
                    background: 'var(--color-bg-header)',
                    border: '1px solid var(--color-divider)',
                    color: 'var(--color-text-secondary)',
                    fontSize: 'var(--font-size-micro)',
                    fontWeight: 700,
                    lineHeight: '9px',
                    textAlign: 'center',
                    fontFamily: 'var(--font-mono)',
                    pointerEvents: 'none',
                }}>
                    {badge}
                </span>
            )}
        </span>
    );
};

const BrowserGlyph = ({
    name,
    size = 12,
    color = 'currentColor',
    stroke = 1.8,
}: {
    name: BrowserIconName;
    size?: number;
    color?: string;
    stroke?: number;
}) => {
    const commonProps = {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: color,
        strokeWidth: stroke,
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
    };

    switch (name) {
        case 'star':
            return <svg {...commonProps}><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z" /></svg>;
        case 'search':
            return <svg {...commonProps}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
        case 'folder-tree':
            return <svg {...commonProps}><path d="M3 19h7M3 12h7M3 5h7M10 12h4v7h7" /><path d="M14 19h7" /></svg>;
        case 'grid':
            return <svg {...commonProps}><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>;
        case 'wave':
            return <svg {...commonProps}><path d="M2 12c2.2 0 2.2-6 4.4-6s2.2 12 4.4 12 2.2-12 4.4-12 2.2 6 4.4 6 2.2-6 4.4-6" /></svg>;
        case 'wave-bars':
            return <svg {...commonProps}><path d="M4 18V8M8 20V6M12 16V10M16 19V7M20 14v-4" /></svg>;
        case 'music':
            return <svg {...commonProps}><path d="M9 18V6l10-2v12" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="16" r="2" /></svg>;
        case 'drum':
            return <svg {...commonProps}><ellipse cx="12" cy="8" rx="8" ry="3" /><path d="M4 8v7c0 1.7 3.6 3 8 3s8-1.3 8-3V8" /></svg>;
        case 'piano':
            return <svg {...commonProps}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 4v10M12 4v10M16 4v10" /></svg>;
        case 'plug':
            return <svg {...commonProps}><path d="M7 9h10v4a5 5 0 0 1-5 5 5 5 0 0 1-5-5Z" /><path d="M10 5v4M14 5v4M12 18v3" /></svg>;
        case 'sliders':
            return <svg {...commonProps}><path d="M4 21v-7M4 10V3M12 21v-4M12 13V3M20 21v-9M20 8V3" /><path d="M2 14h4M10 13h4M18 8h4" /></svg>;
        case 'clapper':
            return <svg {...commonProps}><rect x="3" y="8" width="18" height="13" rx="2" /><path d="m3 8 3-5h15v5M8 3l-3 5M13 3l-3 5M18 3l-3 5" /></svg>;
        case 'sine':
            return <svg {...commonProps}><path d="M2 12c2.7 0 2.7-6 5.4-6s2.7 12 5.4 12 2.7-12 5.4-12S21 12 22 12" /></svg>;
        case 'hard-drive':
            return <svg {...commonProps}><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M3 13h18M8 16h.01M12 16h.01" /></svg>;
        case 'package':
            return <svg {...commonProps}><path d="m12 3 8 4-8 4-8-4 8-4Z" /><path d="M4 7v10l8 4 8-4V7" /><path d="M12 11v10" /></svg>;
        case 'user':
            return <svg {...commonProps}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
        case 'file':
            return <svg {...commonProps}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6" /></svg>;
        case 'folder':
            return <svg {...commonProps}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>;
        case 'folder-plus':
            return <svg {...commonProps}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M12 10v6M9 13h6" /></svg>;
        case 'chevron-right':
            return <svg {...commonProps}><path d="m9 6 6 6-6 6" /></svg>;
        case 'chevron-down':
            return <svg {...commonProps}><path d="m6 9 6 6 6-6" /></svg>;
        case 'arrow-left':
            return <svg {...commonProps}><path d="M19 12H5M12 19l-7-7 7-7" /></svg>;
        case 'hourglass':
            return <svg {...commonProps}><path d="M6 3h12M6 21h12M8 3c0 4 8 4 8 9s-8 5-8 9M16 3c0 4-8 4-8 9s8 5 8 9" /></svg>;
        case 'triangle-alert':
            return <svg {...commonProps}><path d="M12 3 2 21h20L12 3Z" /><path d="M12 9v5M12 18h.01" /></svg>;
        case 'headphones':
            return <svg {...commonProps}><path d="M4 12a8 8 0 0 1 16 0v6a2 2 0 0 1-2 2h-2v-6h4M4 14h4v6H6a2 2 0 0 1-2-2z" /></svg>;
        case 'settings':
            return <svg {...commonProps}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 1 1-4 0v-.2a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a2 2 0 1 1 0-4h.2a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2 1 1 0 0 0 .6-.9V4a2 2 0 1 1 4 0v.2a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1 1 1 0 0 0 .9.6h.2a2 2 0 1 1 0 4h-.2a1 1 0 0 0-.9.6Z" /></svg>;
        default:
            return <svg {...commonProps}><circle cx="12" cy="12" r="4" /></svg>;
    }
};

const columnMenuItemStyle: React.CSSProperties = {
    width: '100%',
    background: 'transparent',
    border: 'none',
    color: 'var(--color-text-primary)',
    padding: '5px 6px',
    borderRadius: 'var(--radius-md)',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 'var(--font-size-sm)',
    textAlign: 'left',
    cursor: 'pointer',
};

const columnMenuCheckStyle: React.CSSProperties = {
    width: 12,
    textAlign: 'center',
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-accent-primary)',
};

const pluginActionButtonStyle: React.CSSProperties = {
    background: 'var(--color-control-bg)',
    color: 'var(--color-text-secondary)',
    border: '1px solid var(--color-divider)',
    borderRadius: 'var(--radius-xs)',
    padding: '3px 7px',
    fontSize: 'var(--font-size-xs)',
    cursor: 'pointer',
    fontWeight: 600,
    whiteSpace: 'nowrap',
};

const FilterPill = ({
    options, value, onChange,
}: {
    options: string[];
    value: number;
    onChange: (v: number) => void;
}) => (
    <button
        onClick={() => onChange((value + 1) % options.length)}
        style={{
            background: value > 0 ? 'var(--color-control-bg-active)' : 'var(--color-control-bg)',
            color: value > 0 ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
            border: 'none',
            borderRadius: 'var(--radius-xs)',
            padding: '3px 6px',
            fontSize: 'var(--font-size-xs)',
            cursor: 'pointer',
            fontWeight: 600,
            whiteSpace: 'nowrap',
        }}
    >
        {options[value]}
    </button>
);

// ── Preview Waveform Canvas ──────────────────────────

/** Canvas-rendered waveform for the browser preview panel. */
const PreviewWaveform = ({ peaks, height = 48 }: { peaks: PeakPair[]; height?: number }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container || peaks.length === 0) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Measure real pixel width
        const rect = container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.floor(rect.width);
        const h = height;

        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        ctx.scale(dpr, dpr);

        // Clear
        ctx.clearRect(0, 0, w, h);

        // Background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.beginPath();
        ctx.roundRect(0, 0, w, h, 4);
        ctx.fill();

        // Center line
        const mid = h / 2;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(w, mid);
        ctx.stroke();

        // Draw peaks as vertical bars
        const peakCount = peaks.length;
        const barWidth = w / peakCount;

        // Gradient for the waveform
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, 'rgba(74, 158, 255, 0.9)');
        gradient.addColorStop(0.45, 'rgba(74, 158, 255, 0.6)');
        gradient.addColorStop(0.55, 'rgba(74, 158, 255, 0.6)');
        gradient.addColorStop(1, 'rgba(74, 158, 255, 0.9)');
        ctx.fillStyle = gradient;

        for (let i = 0; i < peakCount; i++) {
            const { min, max } = peaks[i];
            const x = i * barWidth;
            // Map [-1, 1] to [h, 0]
            const yMax = mid - max * mid;
            const yMin = mid - min * mid;
            const barH = Math.max(1, yMin - yMax);
            ctx.fillRect(x, yMax, Math.max(0.8, barWidth - 0.3), barH);
        }
    }, [peaks, height]);

    return (
        <div ref={containerRef} style={{ width: '100%', overflow: 'hidden', borderRadius: 'var(--radius-md)' }}>
            <canvas
                ref={canvasRef}
                style={{
                    display: 'block',
                    width: '100%',
                    height,
                }}
            />
        </div>
    );
};
