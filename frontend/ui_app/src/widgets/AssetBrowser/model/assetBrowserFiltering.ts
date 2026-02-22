import { PLUGIN_SOURCE_LABEL, PLUGIN_SOURCE_ORDER } from './assetBrowserSchema';
import type { BrowserCategory, BrowserItem, PluginGroupedRow } from './assetBrowserSchema';
import { fuzzyScore, isLikelyDrumAudio, isLikelyInstrumentPlugin, type CollectionId } from './assetBrowserUtils';

interface FilterItemsParams {
    selectedCategoryId: string;
    debouncedQuery: string;
    realBrowserItems: BrowserItem[];
    pluginBrowserItems: BrowserItem[];
    folderBrowserItems: BrowserItem[];
    activeCategory?: BrowserCategory;
    sizeFilter: number;
    sortFilter: number;
    pluginSourceFilter: 'all' | 'internal' | 'vst3' | 'vst2' | 'au' | 'external';
    collectionItems: Record<CollectionId, Set<string>>;
    formatFilter: number;
    audioFilter: number;
    sourceFilter: number;
    internalInstrumentItems: BrowserItem[];
    internalEffectItems: BrowserItem[];
}

export function filterBrowserItems({
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
    internalInstrumentItems,
    internalEffectItems,
}: FilterItemsParams): BrowserItem[] {
    let base: BrowserItem[] = [];
    const pluginSearchMode = selectedCategoryId === 'plugins' && debouncedQuery.trim().length > 0;

    if (activeCategory?.folderPath) {
        base = folderBrowserItems;
    } else {
        switch (selectedCategoryId) {
            case 'all':
                base = [...realBrowserItems, ...internalInstrumentItems, ...internalEffectItems, ...pluginBrowserItems, ...folderBrowserItems]
                    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
                break;
            case 'samples':
                base = realBrowserItems;
                break;
            case 'drums':
                base = realBrowserItems.filter((i) => isLikelyDrumAudio(i));
                break;
            case 'plugins':
                base = [...internalInstrumentItems, ...internalEffectItems, ...pluginBrowserItems];
                break;
            case 'audioEffects':
                base = [...internalEffectItems, ...pluginBrowserItems.filter((p) => !isLikelyInstrumentPlugin(p))];
                break;
            case 'instruments':
                base = [...internalInstrumentItems, ...pluginBrowserItems.filter((p) => isLikelyInstrumentPlugin(p))];
                break;
            case 'collection-red':
            case 'collection-yellow':
            case 'collection-green': {
                const collId = selectedCategoryId as CollectionId;
                const memberPaths = collectionItems[collId];
                const allKnown = [...realBrowserItems, ...internalInstrumentItems, ...internalEffectItems, ...pluginBrowserItems];
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

    const isLibraryCategory = [
        'samples', 'all', 'drums', 'plugins', 'instruments', 'audioEffects',
        'collection-red', 'collection-yellow', 'collection-green',
    ].includes(selectedCategoryId) && !activeCategory?.folderPath;

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

export function getSelectedPluginLetter(selectedCategoryId: string, selectedItemId: string | null, items: BrowserItem[]) {
    if (selectedCategoryId !== 'plugins' || !selectedItemId) return null;
    const selected = items.find((it) => it.id === selectedItemId);
    if (!selected || selected.type !== 'plugin') return null;
    const firstChar = selected.name.trim().charAt(0).toUpperCase();
    return /^[A-Z]$/.test(firstChar) ? firstChar : '#';
}
