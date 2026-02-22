import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { BrowserItem, PluginGroupedRow } from '@/widgets/AssetBrowser/model/useAssetBrowserLogic';
import { useDragStore } from '@/shared/stores/useDragStore';
import { BrowserGlyph } from './AssetBrowserPrimitives';
import { AssetListItemRow, PluginGroupHeaderRow, PluginGroupItemRow } from './AssetBrowserRows';

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
                padding: '4px 8px',
                background: 'var(--color-input-bg)',
                border: '1px solid var(--color-border-subtle)',
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
    isPreviewPlayingRef: React.RefObject<boolean>;
    setContextMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; item: BrowserItem } | null>>;
    navigateInto: (path: string) => void;
    showTypeColumn: boolean;
    showSizeColumn: boolean;
    debouncedQuery: string;
    audioDurationSecRef: React.RefObject<Record<string, number>>;
    itemRowRefs: React.RefObject<Record<string, HTMLDivElement | null>>;
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

    const handleFileListScroll = useCallback(() => {
        const el = fileListRef.current;
        if (el) setScrollTop(el.scrollTop);
    }, [fileListRef]);

    // BUG-14 FIX: Reset scroll when items change to prevent stale offset
    // showing items from wrong range.
    const prevItemsRef = useRef(items);
    useEffect(() => {
        if (prevItemsRef.current !== items) {
            prevItemsRef.current = items;
            queueMicrotask(() => {
                setScrollTop(0);
            });
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
                    gap: 6,
                    padding: '2px 8px',
                    background: 'var(--color-bg-header)',
                    borderBottom: '1px solid var(--color-divider-light)',
                    color: 'var(--color-text-secondary)',
                    fontSize: 'var(--font-size-2xs)',
                    fontWeight: 600,
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
                            : { x: rect.left, y: rect.bottom + 2 });
                    }}
                    style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        color: 'var(--color-text-secondary)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        flexShrink: 0,
                    }}
                    title="Column visility"
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
                }}>
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
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
                    }}>
                        <span>⚠ Scan error</span>
                        <span style={{ opacity: 0.7, fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-2xs)' }}>{scanError}</span>
                    </div>
                )
            }
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
                                audioDurationSecRef={audioDurationSecRef}
                                isPreviewPlayingRef={isPreviewPlayingRef}
                                itemRowRefs={itemRowRefs}
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
                                    audioDurationSecRef={audioDurationSecRef}
                                    isPreviewPlayingRef={isPreviewPlayingRef}
                                    itemRowRefs={itemRowRefs}
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


/**
 * AssetBrowser — Ableton-style two-pane vertical-split sidebar browser.
 *
 * All state management and business logic delegated to useAssetBrowserLogic hook.
 * This component is purely rendering / presentational.
 */
