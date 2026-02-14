import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { AudioFileEntry, BrowserFileEntry, PeakPair } from '@/shared/api/engine';
import { useDragStore } from '@/shared/stores/useDragStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
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
    | 'headphones';

interface BrowserCategory {
    id: string;
    title: string;
    icon: BrowserIconName;
    kind: 'section' | 'leaf';
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
}

// ── Static Categories ────────────────────────────────────

const STATIC_CATEGORIES: BrowserCategory[] = [
    { id: 'sec-collections', title: 'Collections', icon: 'star', kind: 'section' },
    { id: 'favorites', title: 'Favorites', icon: 'star', kind: 'leaf' },

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
}));

const INTERNAL_EFFECT_ITEMS: BrowserItem[] = INTERNAL_EFFECT_PLUGINS.map((plugin) => ({
    id: `internal-fx-${plugin.name.toLowerCase().replace(/\\s+/g, '-')}`,
    name: plugin.name,
    type: 'plugin',
    meta: 'Internal Audio FX',
    path: plugin.id,
    slotHint: plugin.slotHint,
}));

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

// ── Component ──────────────────────────────────────────

export const AssetBrowser = () => {
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategoryId, setSelectedCategoryId] = useState('samples');
    const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
    const [sourceFilter, setSourceFilter] = useState(0);
    const [formatFilter, setFormatFilter] = useState(0);
    const [audioFilter, setAudioFilter] = useState(0);
    const [sortFilter, setSortFilter] = useState(0);
    const [sizeFilter, setSizeFilter] = useState(0);
    const [showSizeColumn, setShowSizeColumn] = useState(true);
    const [previewEnabled, setPreviewEnabled] = useState(true);
    const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
    const [leftPaneWidth, setLeftPaneWidth] = useState(108);
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
    const itemRowRefs = useRef<Record<string, HTMLDivElement | null>>({});

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

        return [
            ...STATIC_CATEGORIES,
            { id: 'sec-places', title: 'Places', icon: 'hard-drive', kind: 'section' as const },
            { id: 'packs', title: 'Packs', icon: 'package', kind: 'leaf' as const },
            { id: 'userLibrary', title: 'User Lib…', icon: 'user', kind: 'leaf' as const },
            { id: 'currentProject', title: 'Current…', icon: 'file', kind: 'leaf' as const },
            ...folderCats,
            { id: 'addFolder', title: 'Add Fol…', icon: 'folder-plus', kind: 'leaf' as const },
        ];
    }, [userFolders]);

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
    const [pluginScanDone, setPluginScanDone] = useState(false);

    useEffect(() => {
        if (selectedCategoryId !== 'plugins' || pluginScanDone) return;
        Promise.resolve().then(() => {
            setPluginScanDone(true);
            setScanLoading(true);
        });

        engineApi.scanPluginFolders()
            .then(files => {
                setPluginFiles(files);
                setScanLoading(false);
            })
            .catch(err => {
                console.warn('[Browser] Plugin scan failed:', err);
                setScanError(String(err));
                setScanLoading(false);
            });
    }, [selectedCategoryId, pluginScanDone]);

    // ── User folder scanning ──
    const [folderItems, setFolderItems] = useState<BrowserFileEntry[]>([]);
    const [folderScanPath, setFolderScanPath] = useState<string | null>(null);

    const activeCategory = categories.find(c => c.id === selectedCategoryId);
    const activeFolderPath = folderStack.length > 0
        ? folderStack[folderStack.length - 1]
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

        // Check if this is a user-folder category
        if (activeCategory?.folderPath || folderStack.length > 0) {
            base = folderBrowserItems;
        } else {
            switch (selectedCategoryId) {
                case 'all':
                    // "All" shows library audio + internal plugins only.
                    // Third-party plugins are intentionally isolated in "Plug-Ins".
                    base = [
                        ...realBrowserItems,
                        ...INTERNAL_INSTRUMENT_ITEMS,
                        ...INTERNAL_EFFECT_ITEMS,
                    ].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
                    break;
                case 'samples':
                case 'sounds':
                case 'drums':
                    base = realBrowserItems;
                    break;
                case 'plugins':
                    base = pluginBrowserItems;
                    break;
                case 'audioEffects':
                    base = [...INTERNAL_EFFECT_ITEMS];
                    break;
                case 'instruments':
                    base = [...INTERNAL_INSTRUMENT_ITEMS];
                    break;
                case 'favorites':
                    base = realBrowserItems.filter(i => i.favorite);
                    break;
                default:
                    base = realBrowserItems;
            }
        }

        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            base = base.filter(i => i.name.toLowerCase().includes(q));
        }

        if (sizeFilter === 1) {
            base = base.filter((i) => (i.sizeBytes ?? 0) < 1024 * 1024);
        } else if (sizeFilter === 2) {
            base = base.filter((i) => (i.sizeBytes ?? 0) >= 1024 * 1024);
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
    }, [selectedCategoryId, searchQuery, realBrowserItems, pluginBrowserItems, folderBrowserItems, activeCategory, folderStack, sizeFilter, sortFilter]);

    // ── Progressive rendering: show items in batches to avoid 10K DOM nodes ──
    const RENDER_BATCH = 200;
    const [visibleCount, setVisibleCount] = useState(RENDER_BATCH);

    const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);
    const hasMore = visibleCount < items.length;

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

    const handleFileListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        const el = e.currentTarget;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100 && hasMore) {
            setVisibleCount(prev => Math.min(prev + RENDER_BATCH, items.length));
        }
    }, [hasMore, items.length]);

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
                const slot: 'instrument' | 'effect' | 'auto' = item.slotHint ?? 'auto';
                await engineApi.addPluginToTrack(track.id, item.path, item.name, slot);
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

    const scrollSelectedIntoView = useCallback((itemId: string | null) => {
        if (!itemId) return;
        const row = itemRowRefs.current[itemId];
        row?.scrollIntoView({ block: 'nearest' });
    }, []);

    useEffect(() => {
        scrollSelectedIntoView(selectedItemId);
    }, [selectedItemId, visibleItems.length, scrollSelectedIntoView]);

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
        if (nextIndex >= visibleCount) {
            setVisibleCount((prev) => Math.min(Math.max(prev + RENDER_BATCH, nextIndex + 1), items.length));
        }
    }, [items, selectedItemId, visibleCount]);

    const focusResults = useCallback(() => {
        fileListRef.current?.focus();
    }, []);

    const handleBrowserKeyDown = useCallback((e: React.KeyboardEvent) => {
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
        if (e.key !== 'Enter') return;

        e.preventDefault();
        const selected = items.find((it) => it.id === selectedItemId) ?? visibleItems[0] ?? null;
        if (!selected) return;

        const activeEl = document.activeElement;
        if (activeEl === searchRef.current) {
            if (!selectedItemId) setSelectedItemId(selected.id);
            focusResults();
            return;
        }
        void handleItemEnter(selected);
    }, [focusResults, handleItemEnter, items, moveSelection, selectedItemId, visibleItems]);

    const beginSplitResize = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        const root = splitRootRef.current;
        if (!root) return;
        const rootRect = root.getBoundingClientRect();
        const onMove = (me: MouseEvent) => {
            const nextWidth = Math.max(88, Math.min(220, Math.round(me.clientX - rootRect.left)));
            setLeftPaneWidth(nextWidth);
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, []);

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
                        setVisibleCount(RENDER_BATCH);
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
                            const collapsed = collapsedSections.has(cat.id);
                            currentSection = cat.id;
                            return (
                                <button
                                    key={cat.id}
                                    onClick={() => toggleSection(cat.id)}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 3,
                                        width: '100%',
                                        padding: '5px 6px 3px',
                                        background: 'none',
                                        border: 'none',
                                        color: 'var(--color-text-primary)',
                                        fontSize: 11,
                                        fontWeight: 700,
                                        textTransform: 'uppercase',
                                        letterSpacing: '0.04em',
                                        cursor: 'pointer',
                                        opacity: 0.9,
                                    }}
                                >
                                    <span style={{
                                        fontSize: 7,
                                        transform: collapsed ? 'rotate(-90deg)' : 'rotate(0)',
                                        transition: 'transform 0.15s',
                                    }}>▼</span>
                                    <BrowserGlyph name={cat.icon} size={11} />
                                    {cat.title}
                                </button>
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
                                        color: 'var(--color-accent-primary)',
                                        fontSize: 12,
                                        fontWeight: 600,
                                        textAlign: 'left',
                                        cursor: 'pointer',
                                        transition: 'background var(--transition-fast)',
                                        lineHeight: 1.9,
                                        opacity: 0.95,
                                    }}
                                >
                                    <span style={{ width: 13, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
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
                                    setVisibleCount(RENDER_BATCH);
                                }}
                                onContextMenu={cat.removable ? (e) => {
                                    e.preventDefault();
                                    if (cat.folderPath && confirm(`Remove "${cat.title}" from browser?`)) {
                                        handleRemoveFolder(cat.folderPath);
                                    }
                                } : undefined}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    width: '100%',
                                    padding: '2px 4px 2px 12px',
                                    background: isSelected ? 'var(--color-bg-selected)' : 'transparent',
                                    border: 'none',
                                    color: isSelected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                                    fontSize: 12,
                                    fontWeight: isSelected ? 600 : 500,
                                    textAlign: 'left',
                                    cursor: 'pointer',
                                    transition: 'background var(--transition-fast)',
                                    lineHeight: 1.9,
                                }}
                            >
                                <span style={{ width: 14, display: 'inline-flex', justifyContent: 'center', flexShrink: 0, color: 'var(--color-text-primary)' }}>
                                    <BrowserGlyph name={cat.icon} size={12} />
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
                                    fontSize: 9,
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
                                <button
                                    onClick={() => setShowSizeColumn((prev) => !prev)}
                                    style={{
                                        marginLeft: 'auto',
                                        background: showSizeColumn ? 'var(--color-control-bg-active)' : 'var(--color-control-bg)',
                                        color: showSizeColumn ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                                        border: 'none',
                                        borderRadius: 'var(--radius-xs)',
                                        padding: '3px 6px',
                                        fontSize: 10,
                                        cursor: 'pointer',
                                        fontWeight: 600,
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    Size
                                </button>
                            </>
                        )}
                    </div>

                    {/* Folder path indicator */}
                    {folderStack.length > 0 && (
                        <div style={{
                            padding: '2px 6px',
                            fontSize: 9,
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
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '3px 8px',
                            borderBottom: '1px solid var(--color-divider-light)',
                            color: 'var(--color-text-tertiary)',
                            fontSize: 10,
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            letterSpacing: '0.04em',
                        }}>
                            <span style={{ flex: 1, minWidth: 0 }}>Name</span>
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
                                fontSize: 10,
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
                                color: 'var(--color-error, #ff6b6b)',
                                fontSize: 10,
                                lineHeight: 1.4,
                            }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                                    <BrowserGlyph name="triangle-alert" size={11} />
                                    Could not scan folder
                                </span>
                                <br />
                                <span style={{ opacity: 0.7, fontFamily: 'var(--font-mono)', fontSize: 9 }}>{scanError}</span>
                            </div>
                        )}
                        {visibleItems.map(item => {
                            const isSelected = selectedItemId === item.id;
                            const isAudio = item.type === 'audio';
                            const isPlugin = item.type === 'plugin';
                            const isDraggable = isAudio || isPlugin;
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
                                        // Folder navigation
                                        if (item.isDirectory && item.path) {
                                            navigateInto(item.path);
                                            return;
                                        }

                                        setSelectedItemId(prev => {
                                            const newId = prev === item.id ? null : item.id;
                                            // Selected audio: always fetch waveform for footer line
                                            if (isAudio && item.path && newId) {
                                                engineApi.getWaveformPeaks(item.path)
                                                    .then(peaks => {
                                                        setPreviewPeaks(selectBestPeakLevel(peaks.mip_levels));
                                                        if (peaks.sample_rate > 0 && peaks.total_samples > 0) {
                                                            audioDurationSecRef.current[item.path!] = peaks.total_samples / peaks.sample_rate;
                                                        }
                                                    })
                                                    .catch(() => setPreviewPeaks(null));
                                                // Autoplay depends on preview toggle state
                                                if (previewEnabled) {
                                                    engineApi.previewAudioFile(item.path)
                                                        .catch(err => {
                                                            console.warn('[Preview]', err);
                                                        });
                                                } else {
                                                    engineApi.stopPreview().catch(() => { });
                                                }
                                            } else {
                                                engineApi.stopPreview().catch(() => { });
                                                setPreviewPeaks(null);
                                            }
                                            return newId;
                                        });
                                    }}
                                    onMouseDown={(e) => {
                                        if (!isDraggable || !item.path || e.button !== 0) return;

                                        const startX = e.clientX;
                                        const startY = e.clientY;
                                        const DRAG_THRESHOLD = 5;
                                        let dragStarted = false;
                                        let dragCancelled = false;
                                        let resolving = false;

                                        const onMove = (me: MouseEvent) => {
                                            const dx = me.clientX - startX;
                                            const dy = me.clientY - startY;
                                            if (!dragStarted && !resolving && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
                                                resolving = true;
                                                void (async () => {
                                                    let durationSeconds: number | undefined;
                                                    if (isAudio) {
                                                        durationSeconds =
                                                            item.durationSeconds
                                                            ?? audioDurationSecRef.current[item.path!]
                                                            ?? undefined;
                                                        if (durationSeconds === undefined) {
                                                            try {
                                                                durationSeconds = await engineApi.getAudioFileDuration(item.path!);
                                                                audioDurationSecRef.current[item.path!] = durationSeconds;
                                                            } catch {
                                                                durationSeconds = undefined;
                                                            }
                                                        }
                                                    }
                                                    if (dragCancelled) return;
                                                    dragStarted = true;
                                                    useDragStore.getState().startDrag({
                                                        id: item.id,
                                                        name: item.name,
                                                        type: isPlugin ? 'plugin' : 'audio',
                                                        path: item.path!,
                                                        slotHint: item.slotHint ?? 'auto',
                                                        durationSeconds,
                                                    }, me.clientX, me.clientY);
                                                })();
                                            }
                                        };
                                        const onUp = () => {
                                            dragCancelled = true;
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
                                        transition: 'background var(--transition-fast)',
                                    }}
                                >
                                    {item.isDirectory ? (
                                        <span style={{ display: 'inline-flex', flexShrink: 0 }}>
                                            <BrowserGlyph name="folder" size={11} />
                                        </span>
                                    ) : (
                                        <TypeIcon type={item.type} />
                                    )}
                                    <span style={{
                                        color: 'var(--color-text-primary)',
                                        fontSize: 12,
                                        fontWeight: 500,
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        flex: 1,
                                        minWidth: 0,
                                    }}>
                                        {item.name}
                                    </span>
                                    {showSizeColumn && (
                                        <span style={{
                                            minWidth: 44,
                                            maxWidth: 56,
                                            color: 'var(--color-text-secondary)',
                                            fontSize: 10,
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
                                            fontSize: 9,
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
                        {/* Load more indicator */}
                        {hasMore && (
                            <div style={{
                                padding: '8px 10px',
                                textAlign: 'center',
                                color: 'var(--color-text-tertiary)',
                                fontSize: 9,
                            }}>
                                {items.length - visibleCount} more items — scroll to load
                            </div>
                        )}
                        {!scanLoading && items.length === 0 && (
                            <div style={{
                                padding: '20px 12px',
                                textAlign: 'center',
                                color: 'var(--color-text-tertiary)',
                                fontSize: 10,
                            }}>
                                No items found
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Footer: Preview Panel ────────── */}
            <div style={{
                borderTop: '1px solid var(--color-divider)',
                background: 'var(--color-bg-header)',
            }}>
                {/* Footer bar: count + integrated waveform + round headphone toggle */}
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
                        borderRadius: 4,
                        border: '1px solid var(--color-border-subtle)',
                        background: 'rgba(0,0,0,0.18)',
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
                                borderRadius: 2,
                                background: 'rgba(255,255,255,0.04)',
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
                            fontSize: 9,
                        }}
                        aria-pressed={previewEnabled}
                    >
                        <BrowserGlyph name="headphones" size={9} />
                    </button>
                </div>
            </div>
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

const TypeIcon = ({ type }: { type: BrowserItem['type'] }) => (
    <span style={{ display: 'inline-flex', color: itemTypeToColor[type] }}>
        <BrowserGlyph name={itemTypeToIcon[type]} size={11} />
    </span>
);

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
        default:
            return <svg {...commonProps}><circle cx="12" cy="12" r="4" /></svg>;
    }
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
            fontSize: 10,
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
        <div ref={containerRef} style={{ width: '100%', overflow: 'hidden', borderRadius: 4 }}>
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
