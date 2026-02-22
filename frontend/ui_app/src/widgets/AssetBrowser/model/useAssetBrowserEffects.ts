import { useEffect } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { BrowserItem } from './assetBrowserSchema';

type SetState<T> = React.Dispatch<React.SetStateAction<T>>;

export interface UseAssetBrowserEffectsParams {
    leftPaneWidth: number;
    leftPaneWidthRef: React.MutableRefObject<number>;
    setUserFolders: SetState<string[]>;
    prevCategoryRef: React.MutableRefObject<string>;
    selectedCategoryId: string;
    setSourceFilter: SetState<number>;
    setFormatFilter: SetState<number>;
    setAudioFilter: SetState<number>;
    setSizeFilter: SetState<number>;
    setPluginSourceFilter: SetState<'all' | 'internal' | 'vst3' | 'vst2' | 'au' | 'external'>;
    searchRef: React.RefObject<HTMLInputElement | null>;
    setDebouncedQuery: SetState<string>;
    fileListRef: React.RefObject<HTMLDivElement | null>;
    setExpandedFolders: SetState<Set<string>>;
    setFolderChildrenCache: SetState<Map<string, BrowserItem[]>>;
    contextMenu: { x: number; y: number; item: BrowserItem } | null;
    contextMenuRef: React.RefObject<HTMLDivElement | null>;
    setContextMenu: SetState<{ x: number; y: number; item: BrowserItem } | null>;
    setCurrentProjectFolder: SetState<string | null>;
    settingsLoaded: boolean;
    settings: {
        browserShowSizeColumn: boolean;
        browserShowTypeColumn: boolean;
        browserLeftPaneWidth: number;
    };
    setShowSizeColumn: SetState<boolean>;
    setShowTypeColumn: SetState<boolean>;
    setLeftPaneWidth: SetState<number>;
    isSamplesCategory: boolean;
    scanTriggeredRef: React.MutableRefObject<boolean>;
    setSampleScanLoading: SetState<boolean>;
    setSampleScanError: SetState<string | null>;
    setRealFiles: SetState<import('@/shared/api/engine').AudioFileEntry[]>;
    pluginScanNonce: number;
    pluginScanned: boolean;
    setPluginScanError: SetState<string | null>;
    setPluginScanLoading: SetState<boolean>;
    setPluginFiles: SetState<import('@/shared/api/engine').BrowserFileEntry[]>;
    setPluginScanned: SetState<boolean>;
    activeFolderPath: string | null;
    folderScanPath: string | null;
    setFolderScanPath: SetState<string | null>;
    setFolderScanLoading: SetState<boolean>;
    setFolderScanError: SetState<string | null>;
    setFolderItems: SetState<import('@/shared/api/engine').BrowserFileEntry[]>;
    prevActiveFolderRef: React.MutableRefObject<string | null>;
    setLoadingFolders: SetState<Set<string>>;
    items: BrowserItem[];
    selectedItemId: string | null;
    setSelectedItemId: SetState<string | null>;
    columnMenuPos: { x: number; y: number } | null;
    columnMenuRef: React.RefObject<HTMLDivElement | null>;
    setColumnMenuPos: SetState<{ x: number; y: number } | null>;
    prevCatForPreviewRef: React.MutableRefObject<string>;
    isPreviewPlayingRef: React.MutableRefObject<boolean>;
    itemRowRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
}

export function useAssetBrowserEffects(p: UseAssetBrowserEffectsParams): void {
    useEffect(() => { p.leftPaneWidthRef.current = p.leftPaneWidth; }, [p.leftPaneWidth, p.leftPaneWidthRef]);

    useEffect(() => {
        engineApi.getBrowserFolders().then(p.setUserFolders).catch((err) => console.warn('[Browser] Failed to load folders:', err));
    }, [p.setUserFolders]);

    useEffect(() => {
        if (p.prevCategoryRef.current !== p.selectedCategoryId) {
            p.prevCategoryRef.current = p.selectedCategoryId;
            p.setSourceFilter(0);
            p.setFormatFilter(0);
            p.setAudioFilter(0);
            p.setSizeFilter(0);
            p.setPluginSourceFilter('all');
        }
    }, [p.selectedCategoryId, p.prevCategoryRef, p.setAudioFilter, p.setFormatFilter, p.setPluginSourceFilter, p.setSizeFilter, p.setSourceFilter]);

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                p.searchRef.current?.focus();
                p.searchRef.current?.select();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [p.searchRef]);

    useEffect(() => {
        const focusBrowserSearch = (evt: Event) => {
            const detail = (evt as CustomEvent<{ categoryId?: string }>).detail;
            if (detail?.categoryId) {
                p.setExpandedFolders(new Set());
                p.setFolderChildrenCache(new Map());
            }
            p.searchRef.current?.focus();
            p.searchRef.current?.select();
        };
        const setBrowserSearch = (evt: Event) => {
            const detail = (evt as CustomEvent<{ query?: string; categoryId?: string }>).detail;
            if (detail?.categoryId) {
                p.setExpandedFolders(new Set());
                p.setFolderChildrenCache(new Map());
            }
            if (typeof detail?.query === 'string') p.setDebouncedQuery(detail.query);
            p.searchRef.current?.focus();
        };
        window.addEventListener('dream:browser-focus-search', focusBrowserSearch as EventListener);
        window.addEventListener('dream:browser-set-search', setBrowserSearch as EventListener);
        return () => {
            window.removeEventListener('dream:browser-focus-search', focusBrowserSearch as EventListener);
            window.removeEventListener('dream:browser-set-search', setBrowserSearch as EventListener);
        };
    }, [p.searchRef, p.setDebouncedQuery, p.setExpandedFolders, p.setFolderChildrenCache]);

    useEffect(() => {
        if (!p.contextMenu) return;
        const onClick = (e: MouseEvent) => {
            if (p.contextMenuRef.current && !p.contextMenuRef.current.contains(e.target as Node)) p.setContextMenu(null);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') p.setContextMenu(null); };
        window.addEventListener('mousedown', onClick, true);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('mousedown', onClick, true);
            window.removeEventListener('keydown', onKey);
        };
    }, [p.contextMenu, p.contextMenuRef, p.setContextMenu]);

    useEffect(() => {
        if (p.selectedCategoryId !== 'currentProject') return;
        let mounted = true;
        void engineApi.getProjectStatus().then((status) => { if (mounted) p.setCurrentProjectFolder(status.projectFolder ?? null); }).catch(() => { if (mounted) p.setCurrentProjectFolder(null); });
        return () => { mounted = false; };
    }, [p.selectedCategoryId, p.setCurrentProjectFolder]);

    useEffect(() => {
        if (!p.settingsLoaded) return;
        p.setShowSizeColumn(p.settings.browserShowSizeColumn);
        p.setShowTypeColumn(p.settings.browserShowTypeColumn);
        p.setLeftPaneWidth(Math.max(84, Math.min(180, p.settings.browserLeftPaneWidth || 92)));
    }, [p.settingsLoaded, p.settings.browserShowSizeColumn, p.settings.browserShowTypeColumn, p.settings.browserLeftPaneWidth, p.setLeftPaneWidth, p.setShowSizeColumn, p.setShowTypeColumn]);

    useEffect(() => {
        if (!p.isSamplesCategory || p.scanTriggeredRef.current) return;
        let cancelled = false;
        const timerId = setTimeout(() => {
            if (cancelled) return;
            p.setSampleScanLoading(true);
            p.setSampleScanError(null);
            engineApi.generateDemoSamples()
                .catch((err) => console.warn('[AssetBrowser] Demo sample generation skipped:', err))
                .then(() => cancelled ? Promise.reject('cancelled') : engineApi.scanAllAudioSources())
                .then((files) => {
                    if (!cancelled) {
                        p.scanTriggeredRef.current = true;
                        p.setRealFiles(files);
                        p.setSampleScanLoading(false);
                    }
                })
                .catch((err) => {
                    if (!cancelled && err !== 'cancelled') {
                        console.warn('[AssetBrowser] Scan failed:', err);
                        p.setSampleScanError(String(err));
                        p.setSampleScanLoading(false);
                    }
                });
        }, 300);
        return () => { cancelled = true; clearTimeout(timerId); };
    }, [p.isSamplesCategory, p.scanTriggeredRef, p.setRealFiles, p.setSampleScanError, p.setSampleScanLoading]);

    useEffect(() => {
        const needsPluginCatalog = p.selectedCategoryId === 'plugins' || p.selectedCategoryId === 'all' || p.selectedCategoryId === 'instruments' || p.selectedCategoryId === 'audioEffects';
        if (!needsPluginCatalog) return;
        const forceRescan = p.selectedCategoryId === 'plugins' || p.pluginScanNonce > 0;
        if (p.pluginScanned && !forceRescan) return;
        let cancelled = false;
        p.setPluginScanError(null);
        p.setPluginScanLoading(true);
        engineApi.scanPluginFolders().then((files) => {
            if (cancelled) return;
            p.setPluginFiles(files);
            p.setPluginScanned(true);
            p.setPluginScanLoading(false);
        }).catch((err) => {
            if (cancelled) return;
            console.warn('[Browser] Plugin scan failed:', err);
            p.setPluginScanError(String(err));
            p.setPluginScanLoading(false);
        });
        return () => { cancelled = true; };
    }, [p.selectedCategoryId, p.pluginScanNonce, p.pluginScanned, p.setPluginFiles, p.setPluginScanError, p.setPluginScanLoading, p.setPluginScanned]);

    useEffect(() => {
        if (!p.activeFolderPath || p.activeFolderPath === p.folderScanPath) return;
        let cancelled = false;
        p.setFolderScanPath(p.activeFolderPath);
        p.setFolderScanLoading(true);
        p.setFolderScanError(null);
        engineApi.scanFolderAll(p.activeFolderPath).then((files) => {
            if (cancelled) return;
            p.setFolderItems(files);
            p.setFolderScanLoading(false);
        }).catch((err) => {
            if (cancelled) return;
            console.warn('[Browser] Folder scan failed:', err);
            p.setFolderScanError(String(err));
            p.setFolderScanLoading(false);
        });
        return () => { cancelled = true; };
    }, [p.activeFolderPath, p.folderScanPath, p.setFolderItems, p.setFolderScanError, p.setFolderScanLoading, p.setFolderScanPath]);

    useEffect(() => {
        const changed = p.activeFolderPath !== p.prevActiveFolderRef.current;
        p.prevActiveFolderRef.current = p.activeFolderPath;
        p.setExpandedFolders(new Set());
        p.setFolderChildrenCache(new Map());
        p.setLoadingFolders(new Set());
        if (changed) {
            p.setFolderScanPath(null);
            p.setFolderItems([]);
        }
    }, [p.selectedCategoryId, p.activeFolderPath, p.prevActiveFolderRef, p.setExpandedFolders, p.setFolderChildrenCache, p.setFolderItems, p.setFolderScanPath, p.setLoadingFolders]);

    useEffect(() => {
        if (p.items.length === 0) { p.setSelectedItemId(null); return; }
        if (!p.selectedItemId || !p.items.some((it) => it.id === p.selectedItemId)) p.setSelectedItemId(p.items[0].id);
    }, [p.items, p.selectedItemId, p.setSelectedItemId]);

    useEffect(() => {
        if (!p.columnMenuPos) return;
        const onMouseDown = (e: MouseEvent) => {
            if (!p.columnMenuRef.current) return;
            if (!p.columnMenuRef.current.contains(e.target as Node)) p.setColumnMenuPos(null);
        };
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') p.setColumnMenuPos(null); };
        window.addEventListener('mousedown', onMouseDown);
        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [p.columnMenuPos, p.columnMenuRef, p.setColumnMenuPos]);

    useEffect(() => {
        if (p.prevCatForPreviewRef.current !== p.selectedCategoryId) {
            p.prevCatForPreviewRef.current = p.selectedCategoryId;
            engineApi.stopPreview().catch(() => undefined);
            p.isPreviewPlayingRef.current = false;
        }
    }, [p.selectedCategoryId, p.prevCatForPreviewRef, p.isPreviewPlayingRef]);

    useEffect(() => {
        if (!p.selectedItemId) return;
        if (p.selectedCategoryId === 'plugins') {
            p.itemRowRefs.current[p.selectedItemId]?.scrollIntoView({ block: 'nearest' });
            return;
        }
        const index = p.items.findIndex((it) => it.id === p.selectedItemId);
        if (index === -1) return;
        const el = p.fileListRef.current;
        if (!el) return;
        const ROW_HEIGHT = 28;
        const headerOffset = 24;
        const itemTop = index * ROW_HEIGHT;
        const itemBottom = itemTop + ROW_HEIGHT;
        if (itemTop < el.scrollTop + headerOffset) el.scrollTop = itemTop - headerOffset;
        else if (itemBottom > el.scrollTop + el.clientHeight) el.scrollTop = itemBottom - el.clientHeight;
    }, [p.selectedItemId, p.items, p.selectedCategoryId, p.fileListRef, p.itemRowRefs]);
}
