import { useEffect } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { BrowserItem } from './assetBrowserSchema';

interface UseAssetBrowserUiEffectsParams {
    leftPaneWidth: number;
    leftPaneWidthRef: React.RefObject<number>;
    setUserFolders: React.Dispatch<React.SetStateAction<string[]>>;
    prevCategoryRef: React.RefObject<string>;
    selectedCategoryId: string;
    setSelectedCategoryId: React.Dispatch<React.SetStateAction<string>>;
    setExpandedFolders: React.Dispatch<React.SetStateAction<Set<string>>>;
    setFolderChildrenCache: React.Dispatch<React.SetStateAction<Map<string, BrowserItem[]>>>;
    searchRef: React.RefObject<HTMLInputElement | null>;
    setDebouncedQuery: React.Dispatch<React.SetStateAction<string>>;
    fileListRef: React.RefObject<HTMLDivElement | null>;
    contextMenu: { x: number; y: number; item: BrowserItem } | null;
    contextMenuRef: React.RefObject<HTMLDivElement | null>;
    setContextMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; item: BrowserItem } | null>>;
    columnMenuPos: { x: number; y: number } | null;
    columnMenuRef: React.RefObject<HTMLDivElement | null>;
    setColumnMenuPos: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
    prevCatForPreviewRef: React.RefObject<string>;
    isPreviewPlayingRef: React.RefObject<boolean>;
    selectedItemId: string | null;
    items: BrowserItem[];
    itemRowRefs: React.RefObject<Record<string, HTMLDivElement | null>>;
}

export function useAssetBrowserUiEffects({
    leftPaneWidth,
    leftPaneWidthRef,
    setUserFolders,
    prevCategoryRef,
    selectedCategoryId,
    setSelectedCategoryId,
    setExpandedFolders,
    setFolderChildrenCache,
    searchRef,
    setDebouncedQuery,
    fileListRef,
    contextMenu,
    contextMenuRef,
    setContextMenu,
    columnMenuPos,
    columnMenuRef,
    setColumnMenuPos,
    prevCatForPreviewRef,
    isPreviewPlayingRef,
    selectedItemId,
    items,
    itemRowRefs,
}: UseAssetBrowserUiEffectsParams): void {
    useEffect(() => {
        leftPaneWidthRef.current = leftPaneWidth;
    }, [leftPaneWidth, leftPaneWidthRef]);

    useEffect(() => {
        engineApi.getBrowserFolders()
            .then((folders) => setUserFolders(folders))
            .catch((err) => console.warn('[Browser] Failed to load folders:', err));
    }, [setUserFolders]);

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
    }, [searchRef]);

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
    }, [searchRef, setDebouncedQuery, setSelectedCategoryId, setExpandedFolders, setFolderChildrenCache]);

    useEffect(() => {
        if (!contextMenu) return;
        const onClick = (e: MouseEvent) => {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) setContextMenu(null);
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
    }, [contextMenu, contextMenuRef, setContextMenu]);

    useEffect(() => {
        if (!columnMenuPos) return;
        const onMouseDown = (e: MouseEvent) => {
            if (!columnMenuRef.current) return;
            if (!columnMenuRef.current.contains(e.target as Node)) setColumnMenuPos(null);
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
    }, [columnMenuPos, columnMenuRef, setColumnMenuPos]);

    useEffect(() => {
        if (prevCatForPreviewRef.current !== selectedCategoryId) {
            prevCatForPreviewRef.current = selectedCategoryId;
            engineApi.stopPreview().catch(() => { /* ignore */ });
            isPreviewPlayingRef.current = false;
        }
    }, [selectedCategoryId, prevCatForPreviewRef, isPreviewPlayingRef]);

    useEffect(() => {
        if (!selectedItemId) return;
        if (selectedCategoryId === 'plugins') {
            itemRowRefs.current[selectedItemId]?.scrollIntoView({ block: 'nearest' });
            return;
        }
        const index = items.findIndex((it) => it.id === selectedItemId);
        if (index === -1) return;
        const el = fileListRef.current;
        if (!el) return;
        const rowHeight = 28;
        const headerOffset = 24;
        const itemTop = index * rowHeight;
        const itemBottom = itemTop + rowHeight;
        if (itemTop < el.scrollTop + headerOffset) el.scrollTop = itemTop - headerOffset;
        else if (itemBottom > el.scrollTop + el.clientHeight) el.scrollTop = itemBottom - el.clientHeight;
    }, [selectedItemId, items, selectedCategoryId, itemRowRefs, fileListRef]);
}
