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

    const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setLocalQuery(value);
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        searchTimerRef.current = setTimeout(() => {
            setDebouncedQuery(value);
        }, 180);
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
                padding: 'var(--space-1) var(--space-2)',
                background: 'var(--color-input-bg)',
                border: 'var(--space-px) solid var(--color-border-subtle)',
                color: 'var(--color-text-primary)',
                borderRadius: 'var(--radius-xs)',
                fontSize: 'var(--font-size-sm)',
                fontFamily: 'var(--font-mono)',
                outline: 'none',
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
    isPreviewPlayingRef: React.RefObject<boolean>;
    setContextMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; item: BrowserItem } | null>>;
    navigateInto: (path: string) => void;
    showTypeColumn: boolean;
    showSizeColumn: boolean;
    debouncedQuery: string;
    getAudioDurationSec: (path: string) => number | undefined;
    setItemRowRef: (id: string, element: HTMLDivElement | null) => void;
    fileListRef: React.RefObject<HTMLDivElement | null>;
    handleBrowserKeyDown: (e: React.KeyboardEvent) => void;
    pluginGroupedRows: PluginGroupedRow[];
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
        const ro = new ResizeObserver(([entry]) => {
            setContainerHeight(entry.contentRect.height);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [fileListRef]);

    // ── Robust scroll-reset guard ──────────────────────────────────────
    // A monotonic counter tracks "reset epochs". When items change, the
    // epoch bumps and the DOM scrollTop is zeroed in a layout effect
    // (before paint, so no stale scroll events can fire).  The scroll
    // handler skips exactly ONE event per epoch transition, then resumes
    // normal operation — no rAF race, no stuck guard.
    const resetEpochRef = useRef(0);
    const lastHandledEpochRef = useRef(0);
    const prevItemsRef = useRef(items);

    const handleFileListScroll = useCallback(() => {
        const epoch = resetEpochRef.current;
        if (lastHandledEpochRef.current !== epoch) {
            // First scroll event after a reset — absorb it (may carry stale position)
            lastHandledEpochRef.current = epoch;
            setScrollTop(0);
            return;
        }
        const el = fileListRef.current;
        if (el) setScrollTop(el.scrollTop);
    }, [fileListRef]);

    // Reset scroll when items change (e.g. search filter narrows results).
    // useLayoutEffect fires synchronously after DOM mutations and BEFORE
    // the browser paints, so the scrollTop=0 is applied before any scroll
    // events can fire — preventing stale-position ghosts.
    useLayoutEffect(() => {
        if (prevItemsRef.current !== items) {
            prevItemsRef.current = items;
            resetEpochRef.current++;
            if (fileListRef.current) {
                fileListRef.current.scrollTop = 0;
            }
        }
    }, [items, fileListRef]);

    const HEADER_HEIGHT = 24; // Sticky header height (used only for scroll offset calculations)
    const totalHeight = items.length * ROW_HEIGHT;
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const endIdx = Math.min(items.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN);
    const visibleItems = useMemo(() => items.slice(startIdx, endIdx), [items, startIdx, endIdx]);
    void columnMenuPos;

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
            <VirtualListHeader
                showTypeColumn={showTypeColumn}
                showSizeColumn={showSizeColumn}
                setColumnMenuPos={setColumnMenuPos}
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
                                HEADER_HEIGHT={HEADER_HEIGHT}
                                isSelected={selectedItemId === item.id}
                                debouncedQuery={debouncedQuery}
                                showTypeColumn={showTypeColumn}
                                showSizeColumn={showSizeColumn}
                                getAudioDurationSec={getAudioDurationSec}
                                isPreviewPlayingRef={isPreviewPlayingRef}
                                bindItemRowRef={setItemRowRef}
                                setSelectedItemId={setSelectedItemId}
                                syncPreviewForItem={syncPreviewForItem}
                                setContextMenu={setContextMenu}
                                navigateInto={navigateInto}
                                fileListRef={fileListRef}
                            />
                        ))}
                    </div>
                ) : (
                    <div>
                        {pluginGroupedRows.map((row) => {
                            if (row.kind === 'header') {
                                return <PluginGroupHeaderRow key={row.id} title={row.title} count={row.count} />;
                            }
                            return (
                                <PluginGroupItemRow
                                    key={row.id}
                                    item={row.item}
                                    ROW_HEIGHT={ROW_HEIGHT}
                                    isSelected={selectedItemId === row.item.id}
                                    debouncedQuery={debouncedQuery}
                                    showTypeColumn={showTypeColumn}
                                    showSizeColumn={showSizeColumn}
                                    getAudioDurationSec={getAudioDurationSec}
                                    isPreviewPlayingRef={isPreviewPlayingRef}
                                    bindItemRowRef={setItemRowRef}
                                    setSelectedItemId={setSelectedItemId}
                                    syncPreviewForItem={syncPreviewForItem}
                                    setContextMenu={setContextMenu}
                                    fileListRef={fileListRef}
                                />
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
