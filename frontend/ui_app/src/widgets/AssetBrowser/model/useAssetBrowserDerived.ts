import { useMemo } from 'react';
import { STATIC_CATEGORIES } from './assetBrowserSchema';
import type { BrowserCategory, BrowserItem, PluginGroupedRow } from './assetBrowserSchema';
import {
    buildPluginGroupedRows,
    buildPluginLetterAnchors,
    computeBrowserItems,
    flattenFolderBrowserItems,
    mapPluginBrowserItems,
    mapRealBrowserItems,
} from './assetBrowserItemPipeline';

interface UseAssetBrowserDerivedParams {
    selectedCategoryId: string;
    selectedItemId: string | null;
    userFolders: string[];
    collectionLabels: Record<string, string>;
    settingsUserFolderPath: string | undefined;
    currentProjectFolder: string | null;
    debouncedQuery: string;
    realFiles: import('@/shared/api/engine').AudioFileEntry[];
    pluginFiles: import('@/shared/api/engine').BrowserFileEntry[];
    folderItems: import('@/shared/api/engine').BrowserFileEntry[];
    expandedFolders: Set<string>;
    folderChildrenCache: Map<string, BrowserItem[]>;
    loadingFolders: Set<string>;
    sizeFilter: number;
    sortFilter: number;
    pluginSourceFilter: 'all' | 'internal' | 'vst3' | 'vst2' | 'au' | 'clap' | 'external';
    collectionItems: Record<string, Set<string>>;
    formatFilter: number;
    audioFilter: number;
    sourceFilter: number;
    excludedFormats: string[];
}

export function useAssetBrowserDerived(params: UseAssetBrowserDerivedParams) {
    const categories = useMemo<BrowserCategory[]>(() => {
        const folderCats: BrowserCategory[] = params.userFolders.map((p, i) => ({
            id: `user-folder-${i}`,
            title: p.split('/').pop() || p,
            icon: 'folder',
            kind: 'leaf',
            folderPath: p,
            removable: true,
        }));
        const staticWithCollections = STATIC_CATEGORIES.map((cat) => (
            cat.id.startsWith('collection-') ? { ...cat, title: params.collectionLabels[cat.id] ?? cat.title } : cat
        ));
        return [
            ...staticWithCollections,
            { id: 'sec-folders', title: 'Folders', icon: 'hard-drive', kind: 'section' },
            { id: 'userLibrary', title: 'User Library', icon: 'user', kind: 'leaf' },
            { id: 'currentProject', title: 'Current Project', icon: 'file', kind: 'leaf' },
            ...folderCats,
            { id: 'addFolder', title: 'Add Folder', icon: 'folder-plus', kind: 'leaf' },
        ];
    }, [params.collectionLabels, params.userFolders]);

    // BUG-31 FIX: memoize activeCategory
    const activeCategory = useMemo(
        () => categories.find((c) => c.id === params.selectedCategoryId),
        [categories, params.selectedCategoryId],
    );
    const userLibraryFolder = params.settingsUserFolderPath?.trim() || null;
    const activeFolderPath = params.selectedCategoryId === 'currentProject'
        ? params.currentProjectFolder
        : params.selectedCategoryId === 'userLibrary'
            ? userLibraryFolder
            : activeCategory?.folderPath || null;

    const realBrowserItems = useMemo(() => mapRealBrowserItems(params.realFiles), [params.realFiles]);
    const pluginBrowserItems = useMemo(() => mapPluginBrowserItems(params.pluginFiles), [params.pluginFiles]);
    const folderBrowserItems = useMemo(
        () => flattenFolderBrowserItems({
            folderItems: params.folderItems,
            expandedFolders: params.expandedFolders,
            folderChildrenCache: params.folderChildrenCache,
            loadingFolders: params.loadingFolders,
        }),
        [params.expandedFolders, params.folderChildrenCache, params.folderItems, params.loadingFolders],
    );

    const items = useMemo(() => computeBrowserItems({
        selectedCategoryId: params.selectedCategoryId,
        debouncedQuery: params.debouncedQuery,
        realBrowserItems,
        pluginBrowserItems,
        folderBrowserItems,
        activeFolderCategoryPath: activeCategory?.folderPath,
        sizeFilter: params.sizeFilter,
        sortFilter: params.sortFilter,
        pluginSourceFilter: params.pluginSourceFilter,
        collectionItems: params.collectionItems,
        formatFilter: params.formatFilter,
        audioFilter: params.audioFilter,
        sourceFilter: params.sourceFilter,
        excludedFormats: params.excludedFormats,
    }), [
        params.audioFilter,
        params.collectionItems,
        params.debouncedQuery,
        params.formatFilter,
        params.pluginSourceFilter,
        params.selectedCategoryId,
        params.sizeFilter,
        params.sortFilter,
        params.sourceFilter,
        params.excludedFormats,
        activeCategory,
        folderBrowserItems,
        pluginBrowserItems,
        realBrowserItems,
    ]);

    const pluginGroupedRows = useMemo<PluginGroupedRow[]>(
        () => buildPluginGroupedRows(params.selectedCategoryId, items),
        [items, params.selectedCategoryId],
    );

    const pluginLetterAnchors = useMemo(
        () => buildPluginLetterAnchors(params.selectedCategoryId, pluginGroupedRows),
        [params.selectedCategoryId, pluginGroupedRows],
    );

    const selectedPluginLetter = useMemo(() => {
        if (params.selectedCategoryId !== 'plugins' || !params.selectedItemId) return null;
        const selected = items.find((it) => it.id === params.selectedItemId);
        if (!selected || selected.type !== 'plugin') return null;
        const firstChar = selected.name.trim().charAt(0).toUpperCase();
        return /^[A-Z]$/.test(firstChar) ? firstChar : '#';
    }, [items, params.selectedCategoryId, params.selectedItemId]);

    return {
        categories,
        activeCategory,
        activeFolderPath,
        pluginBrowserItems,
        items,
        pluginGroupedRows,
        pluginLetterAnchors,
        selectedPluginLetter,
    };
}
