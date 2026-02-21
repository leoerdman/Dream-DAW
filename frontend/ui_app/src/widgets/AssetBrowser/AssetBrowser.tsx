import React, { useState, useCallback, useMemo, useRef, useEffect, memo } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { AudioFileEntry, BrowserFileEntry, PeakPair } from '@/shared/api/engine';
import { useDragStore } from '@/shared/stores/useDragStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import { beatToFrame } from '@/shared/lib/audioMath';
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
    /** Tree depth for indentation (0 = root level). */
    _depth?: number;
    /** Whether this folder is currently expanded in tree view. */
    _expanded?: boolean;
    /** Whether children are currently being loaded. */
    _loading?: boolean;
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
    { id: 'drums', title: 'Drums', icon: 'drum', kind: 'leaf' },
    { id: 'instruments', title: 'Instruments', icon: 'piano', kind: 'leaf' },
    { id: 'plugins', title: 'Plug-Ins', icon: 'plug', kind: 'leaf' },
    { id: 'audioEffects', title: 'Audio Eff…', icon: 'sliders', kind: 'leaf' },
];

const COLLECTION_IDS = ['collection-red', 'collection-yellow', 'collection-green'] as const;
type CollectionId = typeof COLLECTION_IDS[number];
const COLLECTION_LABELS_DEFAULT: Record<CollectionId, string> = {
    'collection-red': 'Red',
    'collection-yellow': 'Yellow',
    'collection-green': 'Green',
};
const COLLECTION_ICONS: Record<CollectionId, string> = {
    'collection-red': '🔴',
    'collection-yellow': '🟡',
    'collection-green': '🟢',
};

// ── Collection persistence (localStorage) ──────────────────────
const COLLECTION_STORAGE_KEY = 'dream-daw-browser-collections';

function loadCollections(): Record<CollectionId, Set<string>> {
    try {
        const raw = localStorage.getItem(COLLECTION_STORAGE_KEY);
        if (!raw) return { 'collection-red': new Set(), 'collection-yellow': new Set(), 'collection-green': new Set() };
        const parsed = JSON.parse(raw) as Record<string, string[]>;
        return {
            'collection-red': new Set(parsed['collection-red'] ?? []),
            'collection-yellow': new Set(parsed['collection-yellow'] ?? []),
            'collection-green': new Set(parsed['collection-green'] ?? []),
        };
    } catch {
        return { 'collection-red': new Set(), 'collection-yellow': new Set(), 'collection-green': new Set() };
    }
}

function saveCollections(collections: Record<CollectionId, Set<string>>): void {
    const serializable: Record<string, string[]> = {};
    for (const id of COLLECTION_IDS) {
        serializable[id] = Array.from(collections[id]);
    }
    localStorage.setItem(COLLECTION_STORAGE_KEY, JSON.stringify(serializable));
}

// BUG-4 FIX: Collection labels persistence
const COLLECTION_LABELS_STORAGE_KEY = 'dream-daw-browser-collection-labels';

function loadCollectionLabels(): Record<string, string> {
    try {
        const raw = localStorage.getItem(COLLECTION_LABELS_STORAGE_KEY);
        if (!raw) return {
            'collection-red': 'Collection',
            'collection-yellow': 'Collection',
            'collection-green': 'Collection',
        };
        return JSON.parse(raw) as Record<string, string>;
    } catch {
        return {
            'collection-red': 'Collection',
            'collection-yellow': 'Collection',
            'collection-green': 'Collection',
        };
    }
}

function saveCollectionLabels(labels: Record<string, string>): void {
    localStorage.setItem(COLLECTION_LABELS_STORAGE_KEY, JSON.stringify(labels));
}

const SOURCE_FILTERS = ['Source: All', 'Source: Library', 'Source: Samples', 'Source: Plug-ins'] as const;
const FORMAT_FILTERS = ['Format: All', 'WAV', 'AIFF', 'MP3', 'FLAC'] as const;
const AUDIO_FILTERS = ['Audio: All', 'Loops', 'One Shot', 'Drums', 'Vocals'] as const;
const SORT_FILTERS = ['Sort: Name ↑', 'Sort: Name ↓', 'Sort: Size ↑', 'Sort: Size ↓'] as const;
const SIZE_FILTERS = ['Filter: All', '< 1 MB', '≥ 1 MB'] as const;

const INTERNAL_INSTRUMENT_ITEMS: BrowserItem[] = INTERNAL_INSTRUMENT_PLUGINS.map((plugin) => ({
    id: `internal-inst-${plugin.name.toLowerCase().replace(/\\s+/g, '-')}`,
    name: plugin.name,
    type: 'plugin',
    meta: `Internal Instrument ${plugin.tags.join(' ')}`,
    path: plugin.id,
    slotHint: plugin.slotHint,
    pluginSource: 'internal',
}));

const INTERNAL_EFFECT_ITEMS: BrowserItem[] = INTERNAL_EFFECT_PLUGINS.map((plugin) => ({
    id: `internal-fx-${plugin.name.toLowerCase().replace(/\\s+/g, '-')}`,
    name: plugin.name,
    type: 'plugin',
    meta: `Internal Audio FX ${plugin.tags.join(' ')}`,
    path: plugin.id,
    slotHint: plugin.slotHint,
    pluginSource: 'internal',
}));

function detectPluginSource(raw: string): BrowserItem['pluginSource'] {
    const norm = raw.toLowerCase();
    if (norm.includes('internal://')) return 'internal';
    // BUG-37 FIX: More robust detection patterns
    if (/\.vst3\b/.test(norm) || /\bvst3\b/.test(norm)) return 'vst3';
    if (/\.vst\b/.test(norm) || /\bvst2\b/.test(norm) || /\.vst$/.test(norm)) return 'vst2';
    if (/\.component\b/.test(norm) || /\baudio\s*unit\b/.test(norm) || /\b\.au\b/.test(norm)) return 'au';
    return 'external';
}

function isLikelyInstrumentPlugin(item: BrowserItem): boolean {
    const text = `${item.name} ${item.meta ?? ''} ${item.format ?? ''}`.toLowerCase();
    // BUG-35 FIX: Expanded instrument detection patterns
    return /\b(synth|serum|piano|sampler|kontakt|instrument|organ|rompler|drum\s*machine|electric\s*piano|strings|brass|woodwind|choir)\b/i.test(text);
}

function isLikelyDrumAudio(item: BrowserItem): boolean {
    const text = item.name.toLowerCase();
    // BUG-36 FIX: Use word-boundary matching to avoid false positives like 'cathedral' matching 'hat'
    return /\b(kick|snare|clap|hihat|hi-hat|hi_hat|drum|perc)\b/i.test(text)
        || /\bhat\b/.test(text); // standalone 'hat' only
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

/**
 * Score a single token against text. Lower = better match, null = no match.
 */
function singleTokenScore(t: string, token: string): number | null {
    if (t === token) return 0;
    if (t.startsWith(token)) return 1 + (t.length - token.length) * 0.02;

    const wordMatch = t.match(new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    if (wordMatch) {
        const idx = wordMatch.index ?? 0;
        return 6 + idx * 0.2 + (t.length - token.length) * 0.02;
    }

    const idx = t.indexOf(token);
    if (idx >= 0) return 12 + idx * 0.35 + (t.length - token.length) * 0.03;

    // Subsequence fallback: "zbr" → "Zebra"
    let ti = 0;
    let qi = 0;
    let first = -1;
    let last = -1;
    while (ti < t.length && qi < token.length) {
        if (t[ti] === token[qi]) {
            if (first < 0) first = ti;
            last = ti;
            qi += 1;
        }
        ti += 1;
    }
    if (qi !== token.length) return null;
    const span = Math.max(1, last - first + 1);
    const gaps = span - token.length;
    return 40 + gaps * 1.8 + first * 0.3 + (t.length - token.length) * 0.04;
}

/**
 * Multi-word fuzzy score. Split query into space-separated tokens.
 * ALL tokens must match (AND logic). Final score = sum of individual scores.
 */
function fuzzyScore(text: string, query: string): number | null {
    const t = text.toLowerCase();
    const q = query.toLowerCase().trim();
    if (!q) return 0;

    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return 0;

    let totalScore = 0;
    for (const token of tokens) {
        const s = singleTokenScore(t, token);
        if (s === null) return null; // Any token miss → no match
        totalScore += s;
    }
    return totalScore;
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
                <span style={{ color: 'var(--color-accent-primary)', fontWeight: 'var(--font-weight-bold)' as unknown as number }}>{match}</span>
                {after}
            </>
        );
    }

    // Fallback for fuzzy-subsequence matches.
    const hitPositions = new Set<number>();
    let ni = 0;
    for (let qi = 0; qi < lowerQuery.length; qi += 1) {
        const ch = lowerQuery[qi];
        if (ch === ' ') continue; // Skip spaces to keep highlight clean
        const pos = lowerName.indexOf(ch, ni);
        if (pos < 0) continue; // Skip missing characters to try and highlight remaining matches
        hitPositions.add(pos);
        ni = pos + 1;
    }

    if (hitPositions.size === 0) return name;

    const parts: React.ReactNode[] = [];
    let currentIsHit = hitPositions.has(0);
    let currentChunk = name[0] || '';

    for (let i = 1; i < name.length; i++) {
        const isHit = hitPositions.has(i);
        if (isHit === currentIsHit) {
            currentChunk += name[i];
        } else {
            if (currentIsHit) {
                parts.push(<span key={i} style={{ color: 'var(--color-accent-primary)', fontWeight: 'var(--font-weight-bold)' as unknown as number }}>{currentChunk}</span>);
            } else {
                parts.push(currentChunk);
            }
            currentIsHit = isHit;
            currentChunk = name[i];
        }
    }

    if (currentIsHit) {
        parts.push(<span key="last" style={{ color: 'var(--color-accent-primary)', fontWeight: 'var(--font-weight-bold)' as unknown as number }}>{currentChunk}</span>);
    } else {
        parts.push(currentChunk);
    }

    return <>{parts}</>;
}

// ── Component ──────────────────────────────────────────


const AssetSearchInput = memo(function AssetSearchInput({
    debouncedQuery,
    setDebouncedQuery,
    searchRef,
    handleBrowserKeyDown,
}: {
    debouncedQuery: string;
    setDebouncedQuery: (q: string) => void;
    searchRef: React.RefObject<HTMLInputElement>;
    handleBrowserKeyDown: (e: React.KeyboardEvent) => void;
}) {
    const [localQuery, setLocalQuery] = useState(debouncedQuery);
    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        setLocalQuery(debouncedQuery);
    }, [debouncedQuery]);

    const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const nextQuery = e.target.value;
        setLocalQuery(nextQuery);

        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        searchTimerRef.current = setTimeout(() => {
            setDebouncedQuery(nextQuery);
        }, 150);

        // BUG-3 FIX: Do NOT force the tab to 'all' when the user types.
        // This was resetting the active tab (e.g. Plug-Ins) every keystroke.
        // The search now operates within the currently selected category.
    }, [setDebouncedQuery]);

    return (
        <input
            ref={searchRef}
            type="text"
            placeholder="Search… (⌘F)"
            value={localQuery}
            onChange={handleChange}
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
    );
});

const VirtualFileList = memo(function VirtualFileList({
    items,
    selectedCategoryId,
    selectedItemId,
    setSelectedItemId,
    syncPreviewForItem,
    isPreviewPlayingRef,
    setContextMenu,
    navigateInto,
    showTypeColumn,
    showSizeColumn,
    debouncedQuery,
    audioDurationSecRef,
    itemRowRefs,
    fileListRef,
    handleBrowserKeyDown,
    pluginGroupedRows,
    scanLoading,
    scanError,
    columnMenuPos,
    setColumnMenuPos,
}: {
    items: BrowserItem[];
    selectedCategoryId: string;
    selectedItemId: string | null;
    setSelectedItemId: (id: string | null) => void;
    syncPreviewForItem: (item: BrowserItem | null) => void;
    isPreviewPlayingRef: React.MutableRefObject<boolean>;
    setContextMenu: React.Dispatch<React.SetStateAction<any>>;
    navigateInto: (path: string) => void;
    showTypeColumn: boolean;
    showSizeColumn: boolean;
    debouncedQuery: string;
    audioDurationSecRef: React.MutableRefObject<Record<string, number>>;
    itemRowRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
    fileListRef: React.RefObject<HTMLDivElement>;
    handleBrowserKeyDown: (e: React.KeyboardEvent) => void;
    pluginGroupedRows: any[];
    scanLoading: boolean;
    scanError: string | null;
    columnMenuPos: { x: number; y: number } | null;
    setColumnMenuPos: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
}) {
    const ROW_HEIGHT = 28;
    const OVERSCAN = 8;
    const [scrollTop, setScrollTop] = useState(0);
    const [containerHeight, setContainerHeight] = useState(400);

    useEffect(() => {
        const el = fileListRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) {
                setContainerHeight(entry.contentRect.height);
            }
        });
        ro.observe(el);
        setContainerHeight(el.clientHeight);
        return () => ro.disconnect();
    }, [fileListRef]);

    const handleFileListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        setScrollTop(e.currentTarget.scrollTop);
    }, []);

    // BUG-6 FIX: Reset scroll position when items identity changes (not just length).
    // Uses first+last item IDs to detect true content changes even with same count.
    const prevItemsKeyRef = useRef('');
    useEffect(() => {
        const key = items.length === 0 ? '' : `${items[0].id}|${items[items.length - 1].id}|${items.length}`;
        if (prevItemsKeyRef.current !== key) {
            prevItemsKeyRef.current = key;
            setScrollTop(0);
            if (fileListRef.current) {
                fileListRef.current.scrollTop = 0;
            }
        }
    }, [items, fileListRef]);

    const HEADER_HEIGHT = 24; // BUG-15 FIX: Account for sticky header in virtual scroll
    const totalHeight = items.length * ROW_HEIGHT + HEADER_HEIGHT;
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const endIdx = Math.min(items.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN);
    const visibleItems = useMemo(() => items.slice(startIdx, endIdx), [items, startIdx, endIdx]);

    return (
        <div
            ref={fileListRef}
            className="scrollbar-hide"
            onScroll={handleFileListScroll}
            onKeyDown={handleBrowserKeyDown}
            tabIndex={0}
            style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                overflowX: 'hidden',
                outline: 'none',
            }}
        >
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
                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
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
            {
                scanError && !scanLoading && (
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
                )
            }
            {/* Virtual scroll container */}
            {
                selectedCategoryId !== 'plugins' ? (
                    <div style={{ height: totalHeight + 20, position: 'relative' }}>
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
                                        setContextMenu(null);
                                        if (item.isDirectory && item.path) {
                                            navigateInto(item.path);
                                            return;
                                        }

                                        // BUG-5 FIX: Re-clicking the already-selected audio
                                        // item toggles preview playback (stop/start) instead
                                        // of deselecting the item entirely.
                                        if (selectedItemId === item.id) {
                                            if (item.type === 'audio' && item.path) {
                                                // Toggle: stop if playing, start if stopped
                                                if (isPreviewPlayingRef.current) {
                                                    isPreviewPlayingRef.current = false;
                                                    engineApi.stopPreview().catch(() => { });
                                                } else {
                                                    isPreviewPlayingRef.current = true;
                                                    engineApi.previewAudioFile(item.path).catch(() => { });
                                                }
                                            }
                                            return;
                                        }
                                        setSelectedItemId(item.id);
                                        syncPreviewForItem(item);
                                    }}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        if (item.path) {
                                            setContextMenu({ x: e.clientX, y: e.clientY, item });
                                        }
                                    }}
                                    onMouseDown={(e) => {
                                        if (!isDraggable || !item.path || e.button !== 0) return;

                                        const startX = e.clientX;
                                        const startY = e.clientY;
                                        const DRAG_THRESHOLD = 8;
                                        let dragStarted = false;
                                        let cancelled = false;

                                        const cleanup = () => {
                                            if (cancelled) return;
                                            cancelled = true;
                                            window.removeEventListener('mousemove', onMove);
                                            window.removeEventListener('mouseup', onUp);
                                            window.removeEventListener('blur', cleanup);
                                            document.removeEventListener('visibilitychange', cleanup);
                                        };

                                        const onMove = (me: MouseEvent) => {
                                            if (cancelled) return;
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
                                                        .catch(() => { /* keep drag active */ });
                                                }
                                            }
                                        };
                                        const onUp = () => cleanup();
                                        window.addEventListener('mousemove', onMove);
                                        window.addEventListener('mouseup', onUp);
                                        // BUG-1 FIX: Safety listeners — guarantee cleanup on window blur / tab switch
                                        window.addEventListener('blur', cleanup);
                                        document.addEventListener('visibilitychange', cleanup);
                                    }}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 8,
                                        padding: '4px 8px',
                                        paddingLeft: 8 + (item._depth ?? 0) * 16,
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
                                        <span style={{ display: 'inline-flex', flexShrink: 0, alignItems: 'center', gap: 3 }}>
                                            {item._loading ? (
                                                <BrowserGlyph name="hourglass" size={9} />
                                            ) : (
                                                <BrowserGlyph name={item._expanded ? 'chevron-down' : 'chevron-right'} size={9} />
                                            )}
                                            <BrowserGlyph name="folder" size={11} />
                                        </span>
                                    ) : (
                                        <TypeIcon type={item.type} item={item} />
                                    )}
                                    <span style={{
                                        color: 'var(--color-text-primary)',
                                        fontSize: 'var(--font-size-base)',
                                        fontWeight: 'var(--font-weight-medium)' as unknown as number,
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        flex: 1,
                                        minWidth: 0,
                                    }}>
                                        {debouncedQuery.trim()
                                            ? renderHighlightedMatch(item.name, debouncedQuery)
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
                                            fontWeight: 'var(--font-weight-bold)' as unknown as number,
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
                                        setContextMenu(null);
                                        // BUG-5 FIX: Same toggle logic for plugin grouped list
                                        if (selectedItemId === item.id) {
                                            if (item.type === 'audio' && item.path) {
                                                if (isPreviewPlayingRef.current) {
                                                    isPreviewPlayingRef.current = false;
                                                    engineApi.stopPreview().catch(() => { });
                                                } else {
                                                    isPreviewPlayingRef.current = true;
                                                    engineApi.previewAudioFile(item.path).catch(() => { });
                                                }
                                            }
                                            return;
                                        }
                                        setSelectedItemId(item.id);
                                        syncPreviewForItem(item);
                                    }}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        if (item.path) {
                                            setContextMenu({ x: e.clientX, y: e.clientY, item });
                                        }
                                    }}
                                    onMouseDown={(e) => {
                                        if (!isDraggable || !item.path || e.button !== 0) return;

                                        const startX = e.clientX;
                                        const startY = e.clientY;
                                        const DRAG_THRESHOLD = 8;
                                        let dragStarted = false;
                                        let cancelled = false;

                                        const restoreFileListStyles = () => {
                                            if (fileListRef.current) {
                                                fileListRef.current.style.pointerEvents = '';
                                                fileListRef.current.style.overflow = '';
                                            }
                                        };

                                        const cleanup = () => {
                                            if (cancelled) return;
                                            cancelled = true;
                                            restoreFileListStyles();
                                            window.removeEventListener('mousemove', onMove);
                                            window.removeEventListener('mouseup', onUp);
                                            window.removeEventListener('blur', cleanup);
                                            document.removeEventListener('visibilitychange', cleanup);
                                        };

                                        const onMove = (me: MouseEvent) => {
                                            if (cancelled) return;
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
                                        const onUp = () => cleanup();
                                        window.addEventListener('mousemove', onMove);
                                        window.addEventListener('mouseup', onUp);
                                        window.addEventListener('blur', cleanup);
                                        document.addEventListener('visibilitychange', cleanup);
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
                                        fontWeight: 'var(--font-weight-medium)' as unknown as number,
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        flex: 1,
                                        minWidth: 0,
                                    }}>
                                        {/* BUG-28 FIX: Plugin items now highlight search matches */}
                                        {debouncedQuery.trim()
                                            ? renderHighlightedMatch(item.name, debouncedQuery)
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
                                </div>
                            );
                        })}
                    </div>
                )
            }
            {/* BUG-42 FIX: Contextual empty state messages */}
            {
                !scanLoading && items.length === 0 && (
                    <div style={{
                        padding: '20px 12px',
                        textAlign: 'center',
                        color: 'var(--color-text-tertiary)',
                        fontSize: 'var(--font-size-xs)',
                    }}>
                        {selectedCategoryId === 'plugins'
                            ? 'No plug-ins found. Try importing a VST folder.'
                            : selectedCategoryId.startsWith('collection-')
                                ? 'Collection is empty. Right-click items to add them.'
                                : selectedCategoryId === 'drums'
                                    ? 'No drum samples found.'
                                    : debouncedQuery.trim()
                                        ? `No results for "${debouncedQuery.trim()}"`
                                        : 'No items found'
                        }
                    </div>
                )
            }
        </div >
    );
});

export const AssetBrowser = () => {
    const settings = useSettingsStore((s) => s.settings);
    const settingsLoaded = useSettingsStore((s) => s.loaded);
    const updateAllSettings = useSettingsStore((s) => s.updateAllSettings);

    const [debouncedQuery, setDebouncedQuery] = useState('');

    // ── Collections (localStorage-backed) ──
    const [collectionItems, setCollectionItems] = useState<Record<CollectionId, Set<string>>>(loadCollections);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: BrowserItem } | null>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);
    const [selectedCategoryId, setSelectedCategoryId] = useState('samples');
    const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
    const [sourceFilter, setSourceFilter] = useState(0);
    const [formatFilter, setFormatFilter] = useState(0);
    const [audioFilter, setAudioFilter] = useState(0);
    const [sortFilter, setSortFilter] = useState(0);
    const [sizeFilter, setSizeFilter] = useState(0);
    const [pluginSourceFilter, setPluginSourceFilter] = useState<'all' | 'internal' | 'vst3' | 'vst2' | 'au' | 'external'>('all');

    // BUG-7 FIX: Reset filters when category changes to avoid stale carry-over
    const prevCategoryRef = useRef(selectedCategoryId);
    useEffect(() => {
        if (prevCategoryRef.current !== selectedCategoryId) {
            prevCategoryRef.current = selectedCategoryId;
            setSourceFilter(0);
            setFormatFilter(0);
            setAudioFilter(0);
            setSizeFilter(0);
            setPluginSourceFilter('all');
            // Note: sortFilter intentionally NOT reset — user preference
        }
    }, [selectedCategoryId]);
    const [showSizeColumn, setShowSizeColumn] = useState(settings.browserShowSizeColumn);
    const [showTypeColumn, setShowTypeColumn] = useState(settings.browserShowTypeColumn);
    const [columnMenuPos, setColumnMenuPos] = useState<{ x: number; y: number } | null>(null);
    const [collectionLabels, setCollectionLabels] = useState<Record<string, string>>(loadCollectionLabels);
    const [previewEnabled, setPreviewEnabled] = useState(true);
    const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
    const [leftPaneWidth, setLeftPaneWidth] = useState(settings.browserLeftPaneWidth);
    const projectTracks = useEngineStore((s) => s.projectTracks);

    // Preview waveform state
    const [previewPeaks, setPreviewPeaks] = useState<PeakPair[] | null>(null);
    const audioDurationSecRef = useRef<Record<string, number>>({});

    // ── User folders (PLACES section) ──
    const [userFolders, setUserFolders] = useState<string[]>([]);

    // ── Tree-based folder expansion (enterprise expandable tree view) ──
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
    const [folderChildrenCache, setFolderChildrenCache] = useState<Map<string, BrowserItem[]>>(new Map());
    const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());

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
            if (typeof detail?.query === 'string') {
                setDebouncedQuery(detail.query);
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

    // ── Close collection context menu on click-outside or Escape ──
    useEffect(() => {
        if (!contextMenu) return;
        const onClick = (e: MouseEvent) => {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
                setContextMenu(null);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setContextMenu(null);
        };
        window.addEventListener('mousedown', onClick, true);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('mousedown', onClick, true);
            window.removeEventListener('keydown', onKey);
        };
    }, [contextMenu]);

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

    // ── Scan loading/error: per-type to avoid cross-clobbering (BUG-3 FIX) ──
    const [realFiles, setRealFiles] = useState<AudioFileEntry[]>([]);
    const [sampleScanLoading, setSampleScanLoading] = useState(false);
    const [sampleScanError, setSampleScanError] = useState<string | null>(null);
    const [pluginScanLoading, setPluginScanLoading] = useState(false);
    const [pluginScanError, setPluginScanError] = useState<string | null>(null);
    const [folderScanLoading, setFolderScanLoading] = useState(false);
    const [folderScanError, setFolderScanError] = useState<string | null>(null);
    const scanTriggeredRef = useRef(false);

    // Computed combined state for VirtualFileList
    const scanLoading = sampleScanLoading || pluginScanLoading || folderScanLoading;
    const scanError = sampleScanError || pluginScanError || folderScanError;

    const isSamplesCategory = ['samples', 'all', 'drums'].includes(selectedCategoryId);

    useEffect(() => {
        if (!isSamplesCategory || scanTriggeredRef.current) return;
        // BUG-2 FIX: Do NOT set scanTriggeredRef here — only on SUCCESS

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
                        scanTriggeredRef.current = true; // BUG-2 FIX: Only mark as triggered on success
                        setRealFiles(files);
                        setSampleScanLoading(false);
                    }
                })
                .catch(err => {
                    if (!cancelled && err !== 'cancelled') {
                        console.warn('[AssetBrowser] Scan failed:', err);
                        setSampleScanError(String(err));
                        setSampleScanLoading(false);
                        // BUG-2 FIX: scanTriggeredRef stays false → retry on next mount
                    }
                });
        }, 300);

        return () => {
            cancelled = true;
            clearTimeout(timerId);
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

        return () => {
            cancelled = true;
        };
    }, [selectedCategoryId, pluginScanNonce, pluginScanned]);

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

    // ── User folder scanning ──
    const [folderItems, setFolderItems] = useState<BrowserFileEntry[]>([]);
    const [folderScanPath, setFolderScanPath] = useState<string | null>(null);

    const activeCategory = categories.find(c => c.id === selectedCategoryId);
    const userLibraryFolder = settings.userFolderPath?.trim() || null;
    const activeFolderPath = selectedCategoryId === 'currentProject'
        ? currentProjectFolder
        : selectedCategoryId === 'userLibrary'
            ? userLibraryFolder
            : activeCategory?.folderPath || null;

    useEffect(() => {
        if (!activeFolderPath || activeFolderPath === folderScanPath) return;
        let cancelled = false;

        // BUG-5 FIX: Synchronous state updates — no microtask wrapper
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

        return () => {
            cancelled = true;
        };
    }, [activeFolderPath, folderScanPath]);

    // BUG-4 FIX: Reset folder tree state when category changes, but
    // clear folderScanPath ONLY when activeFolderPath actually changes.
    // Previously, wiping folderScanPath + folderItems on every category
    // switch caused user-folder tabs to appear empty because the scan
    // comparison guard (activeFolderPath === folderScanPath) rejected
    // the re-scan.
    const prevActiveFolderRef = useRef<string | null>(null);
    useEffect(() => {
        const changed = activeFolderPath !== prevActiveFolderRef.current;
        prevActiveFolderRef.current = activeFolderPath;
        // BUG-5 FIX: Direct state updates — no microtask wrapper
        setExpandedFolders(new Set());
        setFolderChildrenCache(new Map());
        setLoadingFolders(new Set());
        if (changed) {
            setFolderScanPath(null);
            setFolderItems([]);
        }
    }, [selectedCategoryId, activeFolderPath]);

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

    // Convert folder scan to BrowserItems — with expandable tree structure
    const folderBrowserItems: BrowserItem[] = useMemo(() => {
        // Convert raw folder entries to BrowserItems (root level, depth=0)
        const rootItems: BrowserItem[] = folderItems.map((f, i) => {
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
                _depth: 0,
            };
        });

        // Build flat tree: for each expanded folder, recursively insert its cached children
        const result: BrowserItem[] = [];
        const insertWithChildren = (items: BrowserItem[], depth: number) => {
            for (const item of items) {
                const isExp = item.isDirectory && item.path ? expandedFolders.has(item.path) : false;
                const isLoad = item.isDirectory && item.path ? loadingFolders.has(item.path) : false;
                result.push({
                    ...item,
                    _depth: depth,
                    _expanded: isExp,
                    _loading: isLoad,
                });
                if (isExp && item.path) {
                    const children = folderChildrenCache.get(item.path);
                    if (children) {
                        insertWithChildren(children, depth + 1);
                    }
                }
            }
        };
        insertWithChildren(rootItems, 0);
        return result;
    }, [folderItems, expandedFolders, folderChildrenCache, loadingFolders]);

    // Get items based on selected category
    const items = useMemo(() => {
        let base: BrowserItem[] = [];
        const pluginSearchMode = selectedCategoryId === 'plugins' && debouncedQuery.trim().length > 0;

        // Check if this is a user-folder category
        if (activeCategory?.folderPath) {
            base = folderBrowserItems;
        } else {
            switch (selectedCategoryId) {
                case 'all':
                    base = [
                        ...realBrowserItems,
                        ...INTERNAL_INSTRUMENT_ITEMS,
                        ...INTERNAL_EFFECT_ITEMS,
                        ...pluginBrowserItems,
                        ...folderBrowserItems, // BUG FIX: Include all user folders and project files for global search
                    ].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
                    break;
                case 'samples':
                    base = realBrowserItems;
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
                case 'collection-green': {
                    const collId = selectedCategoryId as CollectionId;
                    const memberPaths = collectionItems[collId];
                    const allKnown = [
                        ...realBrowserItems,
                        ...INTERNAL_INSTRUMENT_ITEMS,
                        ...INTERNAL_EFFECT_ITEMS,
                        ...pluginBrowserItems,
                    ];
                    base = allKnown.filter(i => i.path && memberPaths.has(i.path));
                    break;
                }
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

        if (debouncedQuery.trim()) {
            const q = debouncedQuery.trim();
            base = base
                .map((item) => {
                    const searchText = `${item.name} ${item.format ?? ''} ${item.meta ?? ''}${item.pluginSource ? ` ${item.pluginSource}` : ''}`;
                    const score = fuzzyScore(searchText, q);
                    return { item, score };
                })
                .filter((entry) => entry.score !== null)
                .sort((a, b) => {
                    if (a.score !== b.score) return (a.score ?? 0) - (b.score ?? 0);
                    return a.item.name.toLowerCase().localeCompare(b.item.name.toLowerCase());
                })
                .map((entry) => entry.item);
        }

        // ── AUDIT FIX: Apply source/format/audio filters ONLY for library categories ──
        // Folder-based views (user folders, currentProject, userLibrary) have items
        // from raw disk scans where type/format metadata may be incomplete.
        // Applying these filters there would hide valid files.
        const isLibraryCategory = ['samples', 'all', 'drums', 'plugins', 'instruments', 'audioEffects',
            'collection-red', 'collection-yellow', 'collection-green'].includes(selectedCategoryId)
            && !activeCategory?.folderPath;

        if (isLibraryCategory) {
            // Source filter: 0=All, 1=Library, 2=Samples, 3=Plug-ins
            if (sourceFilter === 1) {
                base = base.filter((i) => i.type === 'audio' || i.pluginSource === 'internal');
            } else if (sourceFilter === 2) {
                base = base.filter((i) => i.type === 'audio');
            } else if (sourceFilter === 3) {
                base = base.filter((i) => i.type === 'plugin');
            }
        }

        if (isLibraryCategory) {
            // Format filter: WAV/AIFF/MP3/FLAC
            if (formatFilter > 0) {
                const formatNames = ['', 'wav', 'aiff', 'mp3', 'flac'];
                const wanted = formatNames[formatFilter];
                if (wanted) {
                    base = base.filter((i) => {
                        if (!i.format) return false;
                        return i.format.toLowerCase() === wanted;
                    });
                }
            }

            // Audio type filter: Loops/One-Shot/Drums/Vocals
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

        // BUG-26 FIX: Size filter only applies to library categories, not folder views
        // where sizeBytes may be 0 for directories
        if (isLibraryCategory) {
            if (sizeFilter === 1) {
                base = base.filter((i) => (i.sizeBytes ?? 0) < 1024 * 1024);
            } else if (sizeFilter === 2) {
                base = base.filter((i) => (i.sizeBytes ?? 0) >= 1024 * 1024);
            }
        }

        if (pluginSearchMode) {
            return base;
        }

        // Only apply the default alphabetical sort if we are NOT searching.
        // If we ARE searching, the relevance sort applied above will be preserved.
        const isSearchActive = !!debouncedQuery.trim();

        // BUG-7 FIX: Wrap every sort with a folder-first comparator.
        // Directories always appear before files, then secondary sort applies.
        const folderFirst = (a: BrowserItem, b: BrowserItem): number => {
            const aDir = a.isDirectory ? 1 : 0;
            const bDir = b.isDirectory ? 1 : 0;
            return bDir - aDir; // directories first
        };

        if (!isSearchActive || sortFilter !== 0) {
            if (sortFilter === 0) {
                base = [...base].sort((a, b) => folderFirst(a, b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
            } else if (sortFilter === 1) {
                base = [...base].sort((a, b) => folderFirst(a, b) || b.name.toLowerCase().localeCompare(a.name.toLowerCase()) || a.id.localeCompare(b.id));
            } else if (sortFilter === 2) {
                base = [...base].sort((a, b) => folderFirst(a, b) || (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0) || a.id.localeCompare(b.id));
            } else {
                base = [...base].sort((a, b) => folderFirst(a, b) || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || a.id.localeCompare(b.id));
            }
        }

        return base;
    }, [selectedCategoryId, debouncedQuery, realBrowserItems, pluginBrowserItems, folderBrowserItems, activeCategory, sizeFilter, sortFilter, pluginSourceFilter, collectionItems, formatFilter, audioFilter, sourceFilter]);

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



    // BUG-10 FIX: Auto-select first item but do NOT trigger preview — just set selection
    useEffect(() => {
        if (items.length === 0) {
            setSelectedItemId(null);
            return;
        }
        if (!selectedItemId || !items.some((it) => it.id === selectedItemId)) {
            setSelectedItemId(items[0].id);
        }
    }, [items, selectedItemId]);

    useEffect(() => {
        if (!columnMenuPos) return; // BUG-98 FIX: Only add listener when menu is open
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
    // ── Tree view: toggle folder expand/collapse with lazy-load + caching ──
    const toggleFolderExpand = useCallback(async (path: string) => {
        const isExpanded = expandedFolders.has(path);
        setExpandedFolders(prev => {
            const next = new Set(prev);
            if (isExpanded) {
                // Collapse: also collapse all children beneath this folder
                for (const p of next) {
                    if (p.startsWith(path + '/') || p === path) next.delete(p);
                }
            } else {
                next.add(path);
            }
            return next;
        });

        // Lazy-load: only scan if expanding AND not cached
        if (!isExpanded && !folderChildrenCache.has(path)) {
            setLoadingFolders(prev => new Set(prev).add(path));
            try {
                const files = await engineApi.scanFolderAll(path);
                const children: BrowserItem[] = files.map((f, i) => {
                    const sizeKb = Math.round(f.size_bytes / 1024);
                    const sizeMb = (f.size_bytes / (1024 * 1024)).toFixed(1);
                    const sizeLabel = f.is_directory ? '' : (sizeKb > 1024 ? `${sizeMb} MB` : `${sizeKb} KB`);
                    return {
                        id: `tree-${path}-${i}`,
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
                // BUG-6 FIX: Sort tree children with folders first, then alphabetical.
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

    // Legacy shim for old navigateInto / navigateBack usage in JSX
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

    // BUG-81 FIX: Stop preview when category changes to avoid orphaned playback
    const prevCatForPreviewRef = useRef(selectedCategoryId);
    useEffect(() => {
        if (prevCatForPreviewRef.current !== selectedCategoryId) {
            prevCatForPreviewRef.current = selectedCategoryId;
            engineApi.stopPreview().catch(() => { /* ignore */ });
            isPreviewPlayingRef.current = false;
        }
    }, [selectedCategoryId]);

    // BUG-13 FIX: Cancellation nonce to prevent duplicate imports from rapid Enter
    const enterNonceRef = useRef(0);
    const handleItemEnter = useCallback(async (item: BrowserItem | null) => {
        if (!item) return;
        if (!item.path) return;

        const nonce = ++enterNonceRef.current;

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
            const positionFrames = Math.max(0, beatToFrame(store.transport.position_beats ?? 0, bpm, sampleRate));
            if (enterNonceRef.current !== nonce) return; // BUG-13 FIX: Cancelled
            await engineApi.importAudioFile(item.path, trackIndex, positionFrames);
            if (enterNonceRef.current !== nonce) return;
            await store.fetchProject();
        } catch (err) {
            console.error('[AssetBrowser] Enter action failed:', err);
        }
    }, [resolveSelectedTrack, projectTracks]);

    const previewRequestToken = useRef<number>(0);
    const isPreviewPlayingRef = useRef(false);

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
                    if (previewRequestToken.current === token) {
                        setPreviewPeaks(null);
                    }
                });

            if (previewEnabled) {
                isPreviewPlayingRef.current = true;
                engineApi.previewAudioFile(item.path)
                    .catch(err => {
                        console.warn('[Preview]', err);
                    });
            } else {
                isPreviewPlayingRef.current = false;
                engineApi.stopPreview().catch((err) => {
                    console.warn('[AssetBrowser] stopPreview failed:', err);
                });
            }
            return;
        }

        engineApi.stopPreview().catch((err) => {
            console.warn('[AssetBrowser] stopPreview(reset) failed:', err);
        });
        if (previewRequestToken.current === token) {
            setPreviewPeaks(null);
        }
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
        // BUG-12 FIX: Only trigger preview when preview is enabled
        if (previewEnabled) {
            syncPreviewForItem(next);
        }
        if (selectedCategoryId === 'plugins') {
            queueMicrotask(() => {
                itemRowRefs.current[next.id]?.scrollIntoView({ block: 'nearest' });
            });
            return;
        }
        const ROW_HEIGHT = 28;
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
    }, [items, selectedItemId, selectedCategoryId, syncPreviewForItem, previewEnabled]);

    const focusResults = useCallback(() => {
        fileListRef.current?.focus();
    }, []);

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
                <AssetSearchInput
                    debouncedQuery={debouncedQuery}
                    setDebouncedQuery={setDebouncedQuery}
                    searchRef={searchRef as any}
                    handleBrowserKeyDown={handleBrowserKeyDown}
                />
            </div>

            {/* ══════════════════════════════════════════════
                TWO-PANE VERTICAL SPLIT (Ableton-style)
               ══════════════════════════════════════════════ */}
            <div style={{
                flex: 1,
                minHeight: 0,
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
                                            fontWeight: 'var(--font-weight-bold)' as unknown as number,
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
                                        fontWeight: 'var(--font-weight-semibold)' as unknown as number,
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
                                    if (fileListRef.current) fileListRef.current.scrollTop = 0;
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
                                    setCollectionLabels((prev) => {
                                        const next2 = { ...prev, [cat.id]: next };
                                        saveCollectionLabels(next2); // BUG-4 FIX: Persist labels
                                        return next2;
                                    });
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
                    minHeight: 0,
                    minWidth: 0,
                    display: 'grid',
                    gridTemplateRows: 'auto 1fr auto',
                    overflow: 'hidden',
                    background: 'var(--color-bg-secondary)',
                }}>
                    {/* ── ROW 1: Filters Toolbar ── */}
                    <div style={{
                        gridRow: 1,
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 4,
                        padding: '4px 6px',
                        borderBottom: '1px solid var(--color-divider)',
                        background: 'var(--color-bg-header)',
                    }}>
                        {/* Filter pills for non-folder categories */}
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
                    </div>

                    {selectedCategoryId === 'plugins' && (
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

                    {/* ── ROW 2: Virtual Scroll List ── */}
                    <div style={{
                        gridRow: 2,
                        minHeight: 0, // CRITICAL: forces flex child to shrink properly
                        overflow: 'hidden', // Contain the scrolling box
                        display: 'flex', // So VirtualFileList can use \`flex: 1\` or \`height: 100%\`
                        flexDirection: 'column',
                    }}>
                        {/* Plugin Search Alphabet Anchors */}
                        {selectedCategoryId === 'plugins' && pluginLetterAnchors.letters.length > 0 && (
                            <div className="scrollbar-hide" style={{
                                flexShrink: 0,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 2,
                                padding: '4px 8px',
                                overflowX: 'auto',
                                borderBottom: '1px solid var(--color-divider-light)',
                                background: 'color-mix(in srgb, var(--color-bg-header) 95%, transparent)',
                            }}>
                                {pluginLetterAnchors.letters.map((letter) => (
                                    <button
                                        key={letter}
                                        onClick={() => {
                                            jumpToPluginLetter(letter);
                                            focusResults();
                                        }}
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
                                            fontWeight: 'var(--font-weight-bold)' as unknown as number,
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

                        {/* File List */}
                        <VirtualFileList
                            items={items}
                            selectedCategoryId={selectedCategoryId}
                            selectedItemId={selectedItemId}
                            setSelectedItemId={setSelectedItemId}
                            syncPreviewForItem={syncPreviewForItem}
                            isPreviewPlayingRef={isPreviewPlayingRef}
                            setContextMenu={setContextMenu}
                            navigateInto={navigateInto}
                            showTypeColumn={showTypeColumn}
                            showSizeColumn={showSizeColumn}
                            debouncedQuery={debouncedQuery}
                            audioDurationSecRef={audioDurationSecRef}
                            itemRowRefs={itemRowRefs}
                            fileListRef={fileListRef as any}
                            handleBrowserKeyDown={handleBrowserKeyDown}
                            pluginGroupedRows={pluginGroupedRows}
                            scanLoading={scanLoading}
                            scanError={scanError}
                            columnMenuPos={columnMenuPos}
                            setColumnMenuPos={setColumnMenuPos}
                        />
                    </div>

                    {/* ── ROW 3: Footer Preview Panel (RIGHT pane only) ────────── */}
                    <div style={{
                        gridRow: 3,
                        flexShrink: 0,
                        borderTop: '2px solid var(--color-divider)', // Thicker border for clear separation
                        background: 'var(--color-bg-secondary)', // Opaque background prevents list items from bleeding through
                        position: 'relative', // Establish stacking context above relative scrolling list
                        zIndex: 10,
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
                                        // Turning preview OFF — stop any playing preview
                                        isPreviewPlayingRef.current = false;
                                        engineApi.stopPreview().catch((err) => {
                                            console.warn('[AssetBrowser] stopPreview(toggle) failed:', err);
                                        });
                                        return;
                                    }
                                    // Turning preview ON — auto-play the currently selected audio item
                                    const selected = items.find(i => i.id === selectedItemId);
                                    if (selected?.type === 'audio' && selected.path) {
                                        isPreviewPlayingRef.current = true;
                                        engineApi.previewAudioFile(selected.path).catch((err) => {
                                            console.warn('[AssetBrowser] previewAudioFile(toggle) failed:', err);
                                        });
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

            {
                columnMenuPos && (
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
                )
            }

            {/* ── Context Menu for Collections ────────── */}
            {
                contextMenu && contextMenu.item.path && (
                    <div
                        ref={contextMenuRef}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            position: 'fixed',
                            left: Math.min(contextMenu.x, window.innerWidth - 200),
                            top: Math.min(contextMenu.y, window.innerHeight - 180),
                            background: 'var(--color-bg-elevated)',
                            border: '1px solid var(--color-divider)',
                            borderRadius: 'var(--radius-md)',
                            padding: 4,
                            zIndex: 'var(--z-drag-overlay)' as unknown as number,
                            minWidth: 180,
                            boxShadow: '0 8px 24px var(--color-overlay-dark)',
                        }}
                    >
                        {COLLECTION_IDS.map((collId) => {
                            const path = contextMenu.item.path!;
                            const isInCollection = collectionItems[collId].has(path);
                            const isInCollectionView = selectedCategoryId === collId;
                            return (
                                <button
                                    key={collId}
                                    onClick={() => {
                                        setCollectionItems((prev) => {
                                            const next = {
                                                'collection-red': new Set(prev['collection-red']),
                                                'collection-yellow': new Set(prev['collection-yellow']),
                                                'collection-green': new Set(prev['collection-green']),
                                            };
                                            if (isInCollection) {
                                                next[collId].delete(path);
                                            } else {
                                                next[collId].add(path);
                                            }
                                            saveCollections(next);
                                            return next;
                                        });
                                        setContextMenu(null);
                                    }}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 8,
                                        width: '100%',
                                        padding: '6px 10px',
                                        background: 'transparent',
                                        border: 'none',
                                        color: 'var(--color-text-primary)',
                                        fontSize: 'var(--font-size-xs)',
                                        cursor: 'pointer',
                                        borderRadius: 'var(--radius-sm)',
                                        textAlign: 'left',
                                    }}
                                    onMouseEnter={(e) => {
                                        (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-hover)';
                                    }}
                                    onMouseLeave={(e) => {
                                        (e.currentTarget as HTMLElement).style.background = 'transparent';
                                    }}
                                >
                                    <span>{COLLECTION_ICONS[collId]}</span>
                                    <span>{isInCollection
                                        ? (isInCollectionView ? `Remove from ${COLLECTION_LABELS_DEFAULT[collId]}` : `✓ In ${COLLECTION_LABELS_DEFAULT[collId]}`)
                                        : `Add to ${COLLECTION_LABELS_DEFAULT[collId]}`
                                    }</span>
                                </button>
                            );
                        })}
                    </div>
                )
            }

        </div >
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
                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
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
    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
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
            fontWeight: 'var(--font-weight-semibold)' as unknown as number,
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

    // BUG-18 FIX: Use ResizeObserver to redraw waveform when container resizes
    const [containerWidth, setContainerWidth] = useState(0);
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) {
                setContainerWidth(Math.floor(entry.contentRect.width));
            }
        });
        ro.observe(container);
        setContainerWidth(Math.floor(container.getBoundingClientRect().width));
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container || peaks.length === 0 || containerWidth <= 0) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const w = containerWidth;
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
    }, [peaks, height, containerWidth]);

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
