import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { AudioFileEntry, BrowserFileEntry, PeakPair } from '@/shared/api/engine';
import { useDragStore } from '@/shared/stores/useDragStore';

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

interface BrowserCategory {
    id: string;
    title: string;
    icon: string;
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
}

// ── Static Categories ────────────────────────────────────

const STATIC_CATEGORIES: BrowserCategory[] = [
    { id: 'sec-collections', title: 'Collections', icon: '★', kind: 'section' },
    { id: 'favorites', title: 'Favorites', icon: '★', kind: 'leaf' },

    { id: 'sec-library', title: 'Library', icon: '📁', kind: 'section' },
    { id: 'all', title: 'All', icon: '≡', kind: 'leaf' },
    { id: 'samples', title: 'Samples', icon: '♫', kind: 'leaf' },
    { id: 'sounds', title: 'Sounds', icon: '♪', kind: 'leaf' },
    { id: 'drums', title: 'Drums', icon: '▪', kind: 'leaf' },
    { id: 'instruments', title: 'Instruments', icon: '🎹', kind: 'leaf' },
    { id: 'plugins', title: 'Plug-Ins', icon: '🧩', kind: 'leaf' },
    { id: 'audioEffects', title: 'Audio Eff…', icon: '✦', kind: 'leaf' },
    { id: 'clips', title: 'Clips', icon: '🎬', kind: 'leaf' },
    { id: 'grooves', title: 'Grooves', icon: '∿', kind: 'leaf' },
];

const SOURCE_FILTERS = ['Source: All', 'Source: Library', 'Source: Samples', 'Source: Plug-ins'] as const;
const FORMAT_FILTERS = ['Format: All', 'WAV', 'AIFF', 'MP3', 'FLAC'] as const;
const AUDIO_FILTERS = ['Audio: All', 'Loops', 'One Shot', 'Drums', 'Vocals'] as const;

const INTERNAL_INSTRUMENT_ITEMS: BrowserItem[] = [
    {
        id: 'internal-inst-simple-sine',
        name: 'Simple Sine Synth',
        type: 'plugin',
        meta: 'Internal Instrument',
        path: 'internal://instrument/simple-sine-synth',
        slotHint: 'instrument',
    },
    {
        id: 'internal-inst-sampler',
        name: 'Sampler',
        type: 'plugin',
        meta: 'Internal Instrument',
        path: 'internal://instrument/sampler',
        slotHint: 'instrument',
    },
];

const INTERNAL_EFFECT_ITEMS: BrowserItem[] = [
    { id: 'internal-fx-eq8', name: 'EQ Eight', type: 'plugin', meta: 'Internal Audio FX', path: 'internal://effect/eq-eight', slotHint: 'effect' },
    { id: 'internal-fx-compressor', name: 'Compressor', type: 'plugin', meta: 'Internal Audio FX', path: 'internal://effect/compressor', slotHint: 'effect' },
    { id: 'internal-fx-delay', name: 'Delay', type: 'plugin', meta: 'Internal Audio FX', path: 'internal://effect/delay', slotHint: 'effect' },
    { id: 'internal-fx-reverb', name: 'Reverb', type: 'plugin', meta: 'Internal Audio FX', path: 'internal://effect/reverb', slotHint: 'effect' },
    { id: 'internal-fx-utility', name: 'Utility', type: 'plugin', meta: 'Internal Audio FX', path: 'internal://effect/utility', slotHint: 'effect' },
];

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

// ── Component ──────────────────────────────────────────

export const AssetBrowser = () => {
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategoryId, setSelectedCategoryId] = useState('samples');
    const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
    const [sourceFilter, setSourceFilter] = useState(0);
    const [formatFilter, setFormatFilter] = useState(0);
    const [audioFilter, setAudioFilter] = useState(0);
    const [previewEnabled, setPreviewEnabled] = useState(true);
    const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

    // Preview waveform state
    const [previewPeaks, setPreviewPeaks] = useState<PeakPair[] | null>(null);
    const [previewFileName, setPreviewFileName] = useState<string>('');
    const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);

    // ── User folders (PLACES section) ──
    const [userFolders, setUserFolders] = useState<string[]>([]);

    // ── Folder navigation stack (for browsing into subfolders) ──
    const [folderStack, setFolderStack] = useState<string[]>([]);

    const searchRef = useRef<HTMLInputElement>(null);

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
                title: name.length > 10 ? name.slice(0, 9) + '…' : name,
                icon: '📁',
                kind: 'leaf' as const,
                folderPath: p,
                removable: true,
            };
        });

        return [
            ...STATIC_CATEGORIES,
            { id: 'sec-places', title: 'Places', icon: '💾', kind: 'section' as const },
            { id: 'packs', title: 'Packs', icon: '📦', kind: 'leaf' as const },
            { id: 'userLibrary', title: 'User Lib…', icon: '👤', kind: 'leaf' as const },
            { id: 'currentProject', title: 'Current…', icon: '📋', kind: 'leaf' as const },
            ...folderCats,
            { id: 'addFolder', title: 'Add Fol…', icon: '＋', kind: 'leaf' as const },
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

    const isSamplesCategory = ['samples', 'all', 'sounds', 'drums', 'clips'].includes(selectedCategoryId);

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
                meta: f.is_directory ? 'Folder' : `${f.extension} · ${sizeLabel}`,
                path: f.path,
                isDirectory: f.is_directory,
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
                    // "All" shows EVERYTHING: samples + instruments + effects + plugins, merged & sorted
                    base = [
                        ...realBrowserItems,
                        ...INTERNAL_INSTRUMENT_ITEMS,
                        ...INTERNAL_EFFECT_ITEMS,
                        ...pluginBrowserItems,
                    ].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
                    break;
                case 'samples':
                case 'sounds':
                case 'drums':
                case 'clips':
                    base = realBrowserItems;
                    break;
                case 'plugins':
                    base = pluginBrowserItems;
                    break;
                case 'audioEffects':
                    base = [...INTERNAL_EFFECT_ITEMS, ...pluginBrowserItems];
                    break;
                case 'instruments':
                    base = [
                        ...INTERNAL_INSTRUMENT_ITEMS,
                        ...pluginBrowserItems.filter(p =>
                            /synth|sampl|piano|organ|drum|instrument/i.test(p.name)
                        ),
                    ];
                    if (base.length === INTERNAL_INSTRUMENT_ITEMS.length) {
                        base = [...INTERNAL_INSTRUMENT_ITEMS, ...pluginBrowserItems];
                    }
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

        return base;
    }, [selectedCategoryId, searchQuery, realBrowserItems, pluginBrowserItems, folderBrowserItems, activeCategory, folderStack]);

    // ── Progressive rendering: show items in batches to avoid 10K DOM nodes ──
    const RENDER_BATCH = 200;
    const [visibleCount, setVisibleCount] = useState(RENDER_BATCH);

    const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);
    const hasMore = visibleCount < items.length;

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

    // Track current section for collapse logic
    let currentSection: string | null = null;

    return (
        <div style={{
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
                        setSearchQuery(e.target.value);
                        setVisibleCount(RENDER_BATCH);
                    }}
                    style={{
                        width: '100%',
                        padding: '4px 8px',
                        background: 'var(--color-bg-input)',
                        color: 'var(--color-text-primary)',
                        border: '1px solid var(--color-border-subtle)',
                        borderRadius: 'var(--radius-xs)',
                        fontSize: 'var(--font-size-xs)',
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
            }}>
                {/* ── LEFT PANE: Category Tree ── */}
                <div
                    className="scrollbar-hide"
                    style={{
                        width: 95,
                        minWidth: 85,
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
                                        color: 'var(--color-text-secondary)',
                                        fontSize: 9,
                                        fontWeight: 700,
                                        textTransform: 'uppercase',
                                        letterSpacing: '0.04em',
                                        cursor: 'pointer',
                                    }}
                                >
                                    <span style={{
                                        fontSize: 7,
                                        transform: collapsed ? 'rotate(-90deg)' : 'rotate(0)',
                                        transition: 'transform 0.15s',
                                    }}>▼</span>
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
                                        fontSize: 10,
                                        textAlign: 'left',
                                        cursor: 'pointer',
                                        transition: 'background var(--transition-fast)',
                                        lineHeight: 1.6,
                                        opacity: 0.8,
                                    }}
                                >
                                    <span style={{ width: 13, textAlign: 'center', fontSize: 12, flexShrink: 0 }}>{cat.icon}</span>
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
                                    fontSize: 10,
                                    textAlign: 'left',
                                    cursor: 'pointer',
                                    transition: 'background var(--transition-fast)',
                                    lineHeight: 1.6,
                                }}
                            >
                                <span style={{ width: 13, textAlign: 'center', fontSize: 10, flexShrink: 0 }}>{cat.icon}</span>
                                <span style={{
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                }}>{cat.title}</span>
                            </button>
                        );
                    })}
                </div>

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
                                ← Back
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
                            📁 {folderStack[folderStack.length - 1]?.split('/').pop()}
                        </div>
                    )}

                    {/* File List */}
                    <div className="scrollbar-hide" onScroll={handleFileListScroll} style={{
                        flex: 1,
                        overflowY: 'auto',
                        overflowX: 'hidden',
                    }}>
                        {/* Scan Status */}
                        {scanLoading && (
                            <div style={{
                                padding: '12px 10px',
                                textAlign: 'center',
                                color: 'var(--color-text-tertiary)',
                                fontSize: 10,
                                animation: 'pulse 1.5s ease-in-out infinite',
                            }}>
                                ⏳ Scanning…
                            </div>
                        )}
                        {scanError && !scanLoading && (
                            <div style={{
                                padding: '8px 10px',
                                color: 'var(--color-error, #ff6b6b)',
                                fontSize: 10,
                                lineHeight: 1.4,
                            }}>
                                ⚠️ Could not scan folder<br />
                                <span style={{ opacity: 0.7, fontFamily: 'var(--font-mono)', fontSize: 9 }}>{scanError}</span>
                            </div>
                        )}
                        {visibleItems.map(item => {
                            const isSelected = selectedItemId === item.id;
                            const isAudio = item.type === 'audio';
                            const isPlugin = item.type === 'plugin';
                            const isDraggable = isAudio || isPlugin;

                            return (
                                <div
                                    key={item.id}
                                    onClick={() => {
                                        // Folder navigation
                                        if (item.isDirectory && item.path) {
                                            navigateInto(item.path);
                                            return;
                                        }

                                        setSelectedItemId(prev => {
                                            const newId = prev === item.id ? null : item.id;
                                            // Audio preview
                                            if (previewEnabled && isAudio && item.path && newId) {
                                                setIsPreviewPlaying(true);
                                                setPreviewFileName(item.name);
                                                engineApi.previewAudioFile(item.path)
                                                    .catch(err => {
                                                        console.warn('[Preview]', err);
                                                        setIsPreviewPlaying(false);
                                                    });
                                                // Fetch waveform peaks for preview panel
                                                engineApi.getWaveformPeaks(item.path)
                                                    .then(peaks => {
                                                        const level = peaks.mip_levels[peaks.mip_levels.length - 1];
                                                        setPreviewPeaks(level?.peaks ?? null);
                                                    })
                                                    .catch(() => setPreviewPeaks(null));
                                            } else {
                                                engineApi.stopPreview().catch(() => { });
                                                setIsPreviewPlaying(false);
                                                setPreviewPeaks(null);
                                                setPreviewFileName('');
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
                                                });
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
                                        flexDirection: 'column',
                                        padding: '2px 6px',
                                        cursor: item.isDirectory ? 'pointer' : (isDraggable ? 'grab' : 'default'),
                                        background: isSelected ? 'var(--color-bg-selected)' : 'transparent',
                                        borderBottom: '1px solid var(--color-divider-light)',
                                        transition: 'background var(--transition-fast)',
                                    }}
                                >
                                    <div style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 5,
                                    }}>
                                        {item.isDirectory ? (
                                            <span style={{ fontSize: 10, flexShrink: 0 }}>📁</span>
                                        ) : (
                                            <TypeDot type={item.type} />
                                        )}
                                        <span style={{
                                            color: 'var(--color-text-primary)',
                                            fontSize: 10,
                                            fontWeight: 400,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}>
                                            {item.name}
                                        </span>
                                        {item.isDirectory && (
                                            <span style={{
                                                marginLeft: 'auto',
                                                color: 'var(--color-text-tertiary)',
                                                fontSize: 9,
                                            }}>›</span>
                                        )}
                                    </div>
                                    {item.meta && !item.isDirectory && (
                                        <span style={{
                                            color: 'var(--color-text-tertiary)',
                                            fontSize: 9,
                                            paddingLeft: 14,
                                        }}>
                                            {item.meta}
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
                {/* Waveform Preview Area */}
                {previewEnabled && isPreviewPlaying && previewPeaks && (
                    <div style={{
                        padding: '4px 8px 2px',
                    }}>
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            marginBottom: 2,
                        }}>
                            <span style={{
                                fontSize: 9,
                                color: 'var(--color-text-secondary)',
                                fontWeight: 500,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                maxWidth: '70%',
                            }}>
                                ▶ {previewFileName}
                            </span>
                            <button
                                onClick={() => {
                                    engineApi.stopPreview().catch(() => { });
                                    setIsPreviewPlaying(false);
                                    setPreviewPeaks(null);
                                    setPreviewFileName('');
                                    setSelectedItemId(null);
                                }}
                                style={{
                                    background: 'transparent',
                                    border: 'none',
                                    color: 'var(--color-text-tertiary)',
                                    cursor: 'pointer',
                                    fontSize: 10,
                                    padding: '0 2px',
                                }}
                                title="Stop preview"
                            >
                                ■
                            </button>
                        </div>
                        <PreviewWaveform peaks={previewPeaks} height={48} />
                    </div>
                )}

                {/* Footer bar: count + toggle */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '4px 8px',
                    fontSize: 'var(--font-size-2xs)',
                    color: 'var(--color-text-tertiary)',
                }}>
                    <span>{items.length} items</span>

                    <button
                        onClick={() => {
                            const next = !previewEnabled;
                            setPreviewEnabled(next);
                            if (!next) {
                                engineApi.stopPreview().catch(() => { });
                                setIsPreviewPlaying(false);
                                setPreviewPeaks(null);
                                setPreviewFileName('');
                            }
                        }}
                        title="Toggle Preview"
                        style={{
                            background: previewEnabled ? 'var(--color-accent-primary-dim)' : 'transparent',
                            border: 'none',
                            color: previewEnabled ? 'var(--color-accent-primary)' : 'var(--color-text-tertiary)',
                            borderRadius: 'var(--radius-xs)',
                            padding: '2px 6px',
                            cursor: 'pointer',
                            fontSize: 'var(--font-size-2xs)',
                        }}
                    >
                        🎧 Preview
                    </button>
                </div>
            </div>
        </div>
    );
};

// ── Sub-components ──────────────────────────────────────

const TypeDot = ({ type }: { type: BrowserItem['type'] }) => {
    const colorMap: Record<string, string> = {
        audio: 'var(--color-browser-audio)',
        instrument: 'var(--color-browser-midi)',
        audioEffect: 'var(--color-browser-plugin)',
        midiEffect: 'var(--color-browser-preset)',
        plugin: 'var(--color-browser-plugin)',
        project: '#6ecf9f',
        preset: '#c4a7e7',
        folder: '#b7934c',
        other: 'var(--color-text-tertiary)',
    };
    return (
        <span style={{
            width: 5, height: 5,
            borderRadius: '50%',
            background: colorMap[type] || 'var(--color-text-tertiary)',
            flexShrink: 0,
        }} />
    );
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
            background: value > 0 ? 'var(--color-accent-primary-dim)' : 'var(--color-control-bg)',
            color: value > 0 ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)',
            border: 'none',
            borderRadius: 'var(--radius-xs)',
            padding: '2px 5px',
            fontSize: 9,
            cursor: 'pointer',
            fontWeight: 500,
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
