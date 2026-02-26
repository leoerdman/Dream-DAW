import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BrowserItem, PluginGroupedRow } from '@/widgets/AssetBrowser/model/useAssetBrowserLogic';
import { EmptyAssetState, ScanStatus, VirtualListHeader } from './AssetBrowserVirtualMeta';
import { AssetListItemRow } from './AssetBrowserRows';
import { PluginGroupHeaderRow, PluginGroupItemRow } from './AssetBrowserPluginRows';

// ── Component ──────────────────────────────────────────

export const AssetSearchInput = memo(function AssetSearchInput({
    debouncedQuery,
    setDebouncedQuery,
    searchRef,
    handleBrowserKeyDown,
}: {
    debouncedQuery: string;
    setDebouncedQuery: (q: string) => void;
    searchRef: React.RefObject<HTMLInputElement | null>;
    handleBrowserKeyDown: (e: React.KeyboardEvent) => void;
}) {
    const [localQuery, setLocalQuery] = useState(debouncedQuery);
    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        setLocalQuery(debouncedQuery);
    }, [debouncedQuery]);

    // BUG-14 FIX: clear debounce timer on unmount
    useEffect(() => {
        return () => {
            if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        };
    }, []);

    const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setLocalQuery(value);
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        searchTimerRef.current = setTimeout(() => {
            setDebouncedQuery(value);
        }, 180);
    }, [setDebouncedQuery]);

    return (
        <input
            ref={searchRef}
            type="text"
            placeholder="Search… (Ctrl/Cmd+F)"
            value={localQuery}
            onChange={handleChange}
            onKeyDown={handleBrowserKeyDown}
            style={{
                width: '100%',
                padding: 'var(--space-1) var(--space-2)',
                background: 'var(--color-input-bg)',
                border: 'var(--space-px) solid var(--color-border-subtle)',
                color: 'var(--color-text-primary)',
                borderRadius: 'var(--radius-xs)',
                fontSize: 'var(--font-size-sm)',
                fontFamily: 'var(--font-role-data)',
            }}
        />
    );
});

export const VirtualFileList = memo(function VirtualFileList({
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
    getAudioDurationSec,
    setItemRowRef,
    handleItemEnter,
    suppressNextAutoScrollRef,
    fileListRef,
    handleBrowserKeyDown,
    pluginGroupedRows,
    scanLoading,
    scanError,
    setColumnMenuPos,
}: {
    items: BrowserItem[];
    selectedCategoryId: string;
    selectedItemId: string | null;
    setSelectedItemId: (id: string | null) => void;
    syncPreviewForItem: (item: BrowserItem | null) => void;
    isPreviewPlayingRef: React.RefObject<boolean>;
    setContextMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; item: BrowserItem } | null>>;
    navigateInto: (path: string) => void;
    showTypeColumn: boolean;
    showSizeColumn: boolean;
    debouncedQuery: string;
    getAudioDurationSec: (path: string) => number | undefined;
    setItemRowRef: (id: string, element: HTMLDivElement | null) => void;
    handleItemEnter: (item: BrowserItem | null) => Promise<void>;
    suppressNextAutoScrollRef: React.MutableRefObject<boolean>;
    fileListRef: React.RefObject<HTMLDivElement | null>;
    handleBrowserKeyDown: (e: React.KeyboardEvent) => void;
    pluginGroupedRows: PluginGroupedRow[];
    scanLoading: boolean;
    scanError: string | null;
    setColumnMenuPos: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
}) {
    const ROW_HEIGHT = 28;
    const OVERSCAN = 8;
    const PLUGIN_ROW_HEIGHT = 28;
    const PLUGIN_HEADER_HEIGHT = 28;
    const [scrollTop, setScrollTop] = useState(0);
    const [containerHeight, setContainerHeight] = useState(0);

    useEffect(() => {
        const el = fileListRef.current;
        if (!el) return;
        // Initialize immediately to avoid showing 0 items on first render.
        setContainerHeight(el.clientHeight);
        const ro = new ResizeObserver(([entry]) => {
            const h = entry.contentRect.height;
            setContainerHeight(h);
            // Sync scrollTop on resize — after fullscreen transitions
            // the scroll position may be stale, causing visible items
            // to calculate from the wrong offset and appear empty.
            if (el) setScrollTop(el.scrollTop);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [fileListRef]);

    // BUG-3 FIX: replaced epoch guard with ref-based scroll reset that doesn't eat events
    const isResettingRef = useRef(false);
    const prevItemsRef = useRef(items);

    const handleFileListScroll = useCallback(() => {
        const el = fileListRef.current;
        if (!el) return;
        if (isResettingRef.current) {
            isResettingRef.current = false;
            setScrollTop(0);
            return;
        }
        setScrollTop(el.scrollTop);
    }, [fileListRef]);

    // Reset scroll when items change (e.g. search filter narrows results).
    useLayoutEffect(() => {
        if (prevItemsRef.current !== items) {
            prevItemsRef.current = items;
            if (fileListRef.current) {
                isResettingRef.current = true;
                fileListRef.current.scrollTop = 0;
            }
        }
    }, [items, fileListRef]);

    const totalHeight = items.length * ROW_HEIGHT;
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const endIdx = Math.min(items.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN);
    const visibleItems = useMemo(() => items.slice(startIdx, endIdx), [items, startIdx, endIdx]);

    // BUG-23 FIX: virtualize plugin rows too
    const pluginLayout = useMemo(() => {
        const offsets: number[] = new Array(pluginGroupedRows.length);
        let totalHeight = 0;
        for (let i = 0; i < pluginGroupedRows.length; i += 1) {
            offsets[i] = totalHeight;
            totalHeight += pluginGroupedRows[i].kind === 'header' ? PLUGIN_HEADER_HEIGHT : PLUGIN_ROW_HEIGHT;
        }
        return { offsets, totalHeight };
    }, [pluginGroupedRows]);

    const visiblePluginRows = useMemo(() => {
        if (selectedCategoryId !== 'plugins') return [];
        let startI = 0;
        let endI = pluginGroupedRows.length;
        const viewTop = scrollTop;
        const viewBottom = scrollTop + containerHeight;
        const overscanPx = OVERSCAN * PLUGIN_ROW_HEIGHT;
        const startThreshold = Math.max(0, viewTop - overscanPx);
        const endThreshold = viewBottom + overscanPx;

        while (startI < pluginGroupedRows.length) {
            const rowTop = pluginLayout.offsets[startI];
            const rowHeight = pluginGroupedRows[startI].kind === 'header' ? PLUGIN_HEADER_HEIGHT : PLUGIN_ROW_HEIGHT;
            if (rowTop + rowHeight >= startThreshold) break;
            startI += 1;
        }

        endI = startI;
        while (endI < pluginGroupedRows.length) {
            const rowTop = pluginLayout.offsets[endI];
            if (rowTop > endThreshold) break;
            endI += 1;
        }

        return pluginGroupedRows.slice(startI, endI).map((row, localIndex) => ({
            row,
            offsetTop: pluginLayout.offsets[startI + localIndex],
        }));
    }, [PLUGIN_HEADER_HEIGHT, PLUGIN_ROW_HEIGHT, OVERSCAN, containerHeight, pluginGroupedRows, pluginLayout.offsets, scrollTop, selectedCategoryId]);

    return (
        <div
            ref={fileListRef}
            onScroll={handleFileListScroll}
            onKeyDown={handleBrowserKeyDown}
            tabIndex={0}
            style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                overflowX: 'hidden',
            }}
        >
            <VirtualListHeader
                showTypeColumn={showTypeColumn}
                showSizeColumn={showSizeColumn}
                setColumnMenuPos={setColumnMenuPos}
                itemCount={items.length}
            />
            <ScanStatus scanLoading={scanLoading} scanError={scanError} />
            {/* Virtual scroll container */}
            {
                selectedCategoryId !== 'plugins' ? (
                    <div style={{ height: totalHeight + 20, position: 'relative' }}>
                        {visibleItems.map((item, vi) => (
                            <AssetListItemRow
                                key={item.id}
                                item={item}
                                absIdx={startIdx + vi}
                                ROW_HEIGHT={ROW_HEIGHT}
                                isSelected={selectedItemId === item.id}
                                debouncedQuery={debouncedQuery}
                                showTypeColumn={showTypeColumn}
                                showSizeColumn={showSizeColumn}
                                getAudioDurationSec={getAudioDurationSec}
                                isPreviewPlayingRef={isPreviewPlayingRef}
                                bindItemRowRef={setItemRowRef}
                                suppressNextAutoScrollRef={suppressNextAutoScrollRef}
                                setSelectedItemId={setSelectedItemId}
                                syncPreviewForItem={syncPreviewForItem}
                                setContextMenu={setContextMenu}
                                navigateInto={navigateInto}
                                fileListRef={fileListRef}
                                onItemEnter={() => { void handleItemEnter(item); }}
                            />
                        ))}
                    </div>
                ) : (
                    <div style={{ height: pluginLayout.totalHeight + 20, position: 'relative' }}>
                        {visiblePluginRows.map(({ row, offsetTop }) => {
                            if (row.kind === 'header') {
                                return (
                                    <div key={row.id} style={{ position: 'absolute', top: offsetTop, left: 0, right: 0, height: PLUGIN_HEADER_HEIGHT }}>
                                        <PluginGroupHeaderRow title={row.title} count={row.count} />
                                    </div>
                                );
                            }
                            return (
                                <div key={row.id} style={{ position: 'absolute', top: offsetTop, left: 0, right: 0, height: PLUGIN_ROW_HEIGHT }}>
                                    <PluginGroupItemRow
                                        item={row.item}
                                        ROW_HEIGHT={ROW_HEIGHT}
                                        isSelected={selectedItemId === row.item.id}
                                        debouncedQuery={debouncedQuery}
                                        showTypeColumn={showTypeColumn}
                                        showSizeColumn={showSizeColumn}
                                        getAudioDurationSec={getAudioDurationSec}
                                        isPreviewPlayingRef={isPreviewPlayingRef}
                                        bindItemRowRef={setItemRowRef}
                                        suppressNextAutoScrollRef={suppressNextAutoScrollRef}
                                        setSelectedItemId={setSelectedItemId}
                                        syncPreviewForItem={syncPreviewForItem}
                                        setContextMenu={setContextMenu}
                                        fileListRef={fileListRef}
                                        onItemEnter={() => { void handleItemEnter(row.item); }}
                                    />
                                </div>
                            );
                        })}
                    </div>
                )
            }
            <EmptyAssetState
                scanLoading={scanLoading}
                itemsLength={items.length}
                selectedCategoryId={selectedCategoryId}
                query={debouncedQuery}
            />
        </div >
    );
});


/**
 * AssetBrowser — Ableton-style two-pane vertical-split sidebar browser.
 *
 * All state management and business logic delegated to useAssetBrowserLogic hook.
 * This component is purely rendering / presentational.
 */
