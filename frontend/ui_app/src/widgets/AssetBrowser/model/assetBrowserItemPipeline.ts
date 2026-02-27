import type { AudioFileEntry, BrowserFileEntry } from '@/shared/api/engine';
import type { CollectionId } from './assetBrowserUtils';
import {
    detectPluginSource,
    fileTypeToItemType,
    fuzzyScore,
    isLikelyDrumAudio,
    isLikelyInstrumentPlugin,
} from './assetBrowserUtils';
import {
    INTERNAL_EFFECT_ITEMS,
    INTERNAL_INSTRUMENT_ITEMS,
    INTERNAL_MIDI_EFFECT_ITEMS,
    PLUGIN_SOURCE_LABEL,
    PLUGIN_SOURCE_ORDER,
    type BrowserItem,
    type PluginGroupedRow,
} from './assetBrowserSchema';

// ── Format group → extension mapping (mirrors settingsPanelBrowserTab) ──
const FORMAT_GROUP_EXTENSIONS: Record<string, string[]> = {
    wav: ['wav', 'wave'],
    aiff: ['aiff', 'aif', 'aifc'],
    mp3: ['mp3'],
    flac: ['flac'],
    ogg: ['ogg', 'oga', 'opus'],
    m4a: ['m4a', 'mp4', 'aac'],
    caf: ['caf'],
    wma: ['wma'],
    webm: ['webm'],
};

/** Build a Set of lowercased extensions that belong to any of the excluded format groups. */
function buildExcludedExtensionSet(excludedGroups: string[]): Set<string> {
    const set = new Set<string>();
    for (const gid of excludedGroups) {
        const exts = FORMAT_GROUP_EXTENSIONS[gid];
        if (exts) for (const ext of exts) set.add(ext);
    }
    return set;
}

export function mapRealBrowserItems(realFiles: AudioFileEntry[]): BrowserItem[] {
    return realFiles.map((f) => {
        const sizeKb = Math.round(f.size_bytes / 1024);
        const sizeMb = (f.size_bytes / (1024 * 1024)).toFixed(1);
        const sizeLabel = sizeKb > 1024 ? `${sizeMb} MB` : `${sizeKb} KB`;
        return {
            // BUG-97 FIX: path-based IDs for stable React keys
            id: `real-${f.path}`,
            name: f.name,
            type: 'audio',
            format: f.format,
            meta: sizeLabel,
            path: f.path,
            durationSeconds: f.duration_seconds ?? undefined,
            sizeBytes: f.size_bytes,
        };
    });
}

export function mapPluginBrowserItems(pluginFiles: BrowserFileEntry[]): BrowserItem[] {
    return pluginFiles.map((f) => ({
        // BUG-97 FIX: path-based IDs for stable React keys
        id: `plugin-${f.path}`,
        name: f.name,
        type: 'plugin',
        format: f.extension,
        meta: f.extension,
        path: f.path,
        slotHint: 'auto',
        sizeBytes: f.size_bytes,
        pluginSource: detectPluginSource(`${f.extension ?? ''} ${f.path ?? ''} ${f.name ?? ''}`),
    }));
}

export function flattenFolderBrowserItems(params: {
    folderItems: BrowserFileEntry[];
    expandedFolders: Set<string>;
    folderChildrenCache: Map<string, BrowserItem[]>;
    loadingFolders: Set<string>;
}): BrowserItem[] {
    const { folderItems, expandedFolders, folderChildrenCache, loadingFolders } = params;
    const rootItems: BrowserItem[] = folderItems.map((f, i) => {
        const sizeKb = Math.round(f.size_bytes / 1024);
        const sizeMb = (f.size_bytes / (1024 * 1024)).toFixed(1);
        const sizeLabel = f.is_directory ? '' : (sizeKb > 1024 ? `${sizeMb} MB` : `${sizeKb} KB`);
        const stablePathKey = f.path || `${f.name}-${i}`;
        return {
            id: `folder-${stablePathKey}`,
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
    const result: BrowserItem[] = [];
    // BUG-092: Limit recursion depth to prevent stack overflow on deeply nested folders.
    const MAX_FOLDER_DEPTH = 10;
    const insertWithChildren = (items: BrowserItem[], depth: number) => {
        if (depth > MAX_FOLDER_DEPTH) return;
        for (const item of items) {
            const isExpanded = item.isDirectory && item.path ? expandedFolders.has(item.path) : false;
            const isLoading = item.isDirectory && item.path ? loadingFolders.has(item.path) : false;
            result.push({ ...item, _depth: depth, _expanded: isExpanded, _loading: isLoading });
            if (isExpanded && item.path) {
                const children = folderChildrenCache.get(item.path);
                if (children) insertWithChildren(children, depth + 1);
            }
        }
    };
    insertWithChildren(rootItems, 0);
    return result;
}

export function computeBrowserItems(params: {
    selectedCategoryId: string;
    debouncedQuery: string;
    realBrowserItems: BrowserItem[];
    pluginBrowserItems: BrowserItem[];
    folderBrowserItems: BrowserItem[];
    activeFolderCategoryPath?: string;
    sizeFilter: number;
    sortFilter: number;
    pluginSourceFilter: 'all' | 'internal' | 'vst3' | 'vst2' | 'au' | 'clap' | 'external';
    collectionItems: Record<CollectionId, Set<string>>;
    formatFilter: number;
    audioFilter: number;
    sourceFilter: number;
    excludedFormats: string[];
}): BrowserItem[] {
    const {
        selectedCategoryId, debouncedQuery, realBrowserItems, pluginBrowserItems, folderBrowserItems,
        activeFolderCategoryPath, sizeFilter, sortFilter, pluginSourceFilter, collectionItems, formatFilter,
        audioFilter, sourceFilter, excludedFormats,
    } = params;
    const internalAudioEffectItems = INTERNAL_EFFECT_ITEMS.filter((item) =>
        !(item.path ?? '').startsWith('internal://midi-fx/'),
    );

    let base: BrowserItem[] = [];
    const pluginSearchMode = selectedCategoryId === 'plugins' && debouncedQuery.trim().length > 0;
    if (activeFolderCategoryPath) {
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
            case 'audioEffects': base = [...internalAudioEffectItems]; break;
            case 'midiEffects': base = [...INTERNAL_MIDI_EFFECT_ITEMS]; break;
            case 'instruments': base = [...INTERNAL_INSTRUMENT_ITEMS, ...pluginBrowserItems.filter((p) => isLikelyInstrumentPlugin(p))]; break;
            case 'collection-red':
            case 'collection-yellow':
            case 'collection-green': {
                const collId = selectedCategoryId as CollectionId;
                const memberPaths = collectionItems[collId];
                const allKnown = [...realBrowserItems, ...INTERNAL_INSTRUMENT_ITEMS, ...INTERNAL_EFFECT_ITEMS, ...pluginBrowserItems];
                base = allKnown.filter((i) => i.path && memberPaths.has(i.path));
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
    if (selectedCategoryId === 'all') base = base.filter((i) => i.type !== 'project');

    // ── Format exclusion (from Settings → Browser → Format Indexing) ──
    if (excludedFormats.length > 0) {
        const excludedExts = buildExcludedExtensionSet(excludedFormats);
        base = base.filter((i) => {
            if (i.type !== 'audio') return true;
            const fmt = (i.format ?? '').toLowerCase();
            return !excludedExts.has(fmt);
        });
    }

    if (debouncedQuery.trim()) {
        const q = debouncedQuery.trim();
        base = base
            .map((item) => {
                const fullText = `${item.name} ${item.format ?? ''} ${item.meta ?? ''}${item.pluginSource ? ` ${item.pluginSource}` : ''}`;
                const fullScore = fuzzyScore(fullText, q);
                if (fullScore === null) return null;

                // Score against name alone — name matches are the most relevant.
                const nameScore = fuzzyScore(item.name, q);
                // If the query matches the name directly, use a halved name score
                // (massive bonus). Otherwise fall back to the full-text score.
                const effectiveScore = nameScore !== null
                    ? nameScore * 0.5
                    : fullScore + 20; // penalty for meta-only matches

                // Tiny length penalty: shorter names = tighter match = higher rank
                const lengthPenalty = item.name.length * 0.01;

                return { item, score: effectiveScore + lengthPenalty };
            })
            .filter((entry): entry is { item: BrowserItem; score: number } => entry !== null)
            .sort((a, b) => {
                if (a.score !== b.score) return a.score - b.score;
                return a.item.name.toLowerCase().localeCompare(b.item.name.toLowerCase());
            })
            .map((entry) => entry.item);
    }
    const isLibraryCategory = ['samples', 'all', 'drums', 'plugins', 'instruments', 'audioEffects', 'midiEffects', 'collection-red', 'collection-yellow', 'collection-green'].includes(selectedCategoryId)
        && !activeFolderCategoryPath;
    if (isLibraryCategory) {
        if (sourceFilter === 1) base = base.filter((i) => i.type === 'audio' || i.pluginSource === 'internal');
        else if (sourceFilter === 2) base = base.filter((i) => i.type === 'audio');
        else if (sourceFilter === 3) base = base.filter((i) => i.type === 'plugin');
    }
    if (isLibraryCategory) {
        if (formatFilter > 0) {
            const formatNames = ['', 'wav', 'aiff', 'mp3', 'flac'];
            const wanted = formatNames[formatFilter];
            if (wanted) base = base.filter((i) => {
                if (!i.format) return false;
                const fmt = i.format.toLowerCase();
                // AIF and AIFF are the same container — match both
                if (wanted === 'aiff') return fmt === 'aiff' || fmt === 'aif';
                return fmt === wanted;
            });
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
    if (activeFolderCategoryPath && !isSearchActive && sortFilter === 0) return base;
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
}

export function buildPluginGroupedRows(selectedCategoryId: string, items: BrowserItem[]): PluginGroupedRow[] {
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
}

export function buildPluginLetterAnchors(selectedCategoryId: string, pluginGroupedRows: PluginGroupedRow[]) {
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
}
