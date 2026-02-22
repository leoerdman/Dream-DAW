import React, { useState, useCallback, useMemo, useRef, useEffect, memo } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { PeakPair } from '@/shared/api/engine';
import { useDragStore } from '@/shared/stores/useDragStore';
import {
    BrowserGlyph,
    type BrowserGlyphName,
    FilterPill,
    PreviewWaveform,
    TypeIcon,
} from './ui/AssetBrowserPrimitives';
import {
    COLLECTION_ICONS,
    COLLECTION_IDS,
    COLLECTION_LABELS_DEFAULT,
    type CollectionId,
} from './model/assetBrowserUtils';
import {
    useAssetBrowserLogic,
    type BrowserCategory,
    type BrowserItem,
    type PluginGroupedRow,
    INTERNAL_INSTRUMENT_ITEMS,
    INTERNAL_EFFECT_ITEMS,
    SOURCE_FILTERS,
    FORMAT_FILTERS,
    AUDIO_FILTERS,
    SORT_FILTERS,
    SIZE_FILTERS,
} from './model/useAssetBrowserLogic';

// ── File type helpers ───────────────────────────────────

function renderHighlightedMatch(name: string, query: string): React.ReactNode {
    if (!query.trim()) return name;
    const q = query.trim().toLowerCase();
    const lower = name.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx < 0) {
        const initials = q.split('');
        const parts: React.ReactNode[] = [];
        let cursor = 0;
        for (const ch of initials) {
            const pos = lower.indexOf(ch, cursor);
            if (pos < 0) return name;
            if (pos > cursor) parts.push(name.slice(cursor, pos));
            parts.push(
                <span key={pos} style={{ color: 'var(--color-accent-primary)', fontWeight: 700 }}>
                    {name[pos]}
                </span>,
            );
            cursor = pos + 1;
        }
        if (cursor < name.length) parts.push(name.slice(cursor));
        return <>{parts}</>;
    }
    return (
        <>
            {name.slice(0, idx)}
            <span style={{ color: 'var(--color-accent-primary)', fontWeight: 700 }}>
                {name.slice(idx, idx + q.length)}
            </span>
            {name.slice(idx + q.length)}
        </>
    );
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
                        {visibleItems.map((item, vi) => {
                            const absIdx = startIdx + vi;
                            const isSelected = selectedItemId === item.id;
                            const isAudio = item.type === 'audio';
                            const isPlugin = item.type === 'plugin';
                            const isDraggable = isAudio || isPlugin;
                            const pluginTypeLabel = item.pluginSource === 'internal'
                                ? 'Internal'
                                : item.pluginSource === 'vst3' ? 'VST3'
                                    : item.pluginSource === 'vst2' ? 'VST2'
                                        : item.pluginSource === 'au' ? 'AU'
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
                                        padding: `4px 8px 4px ${8 + (item._depth ?? 0) * 14}px`,
                                        cursor: isDraggable ? 'grab' : (item.isDirectory ? 'pointer' : 'default'),
                                        position: 'absolute',
                                        top: absIdx * ROW_HEIGHT + HEADER_HEIGHT,
                                        left: 0,
                                        right: 0,
                                        height: ROW_HEIGHT,
                                        boxSizing: 'border-box',
                                        background: isSelected ? 'var(--color-bg-selected)' : 'transparent',
                                        borderBottom: '1px solid var(--color-divider-light)',
                                    }}
                                >
                                    {item.isDirectory && (
                                        <svg width="9" height="9" viewBox="0 0 9 9" style={{ flexShrink: 0, opacity: 0.6 }}>
                                            <polyline
                                                points={item._expanded ? '1,2 4.5,6 8,2' : '2,1 6,4.5 2,8'}
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="1.4"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                            />
                                        </svg>
                                    )}
                                    {item._loading && (
                                        <span style={{ fontSize: 'var(--font-size-2xs)', opacity: 0.5 }}>⏳</span>
                                    )}
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
                                        {debouncedQuery.trim()
                                            ? renderHighlightedMatch(item.name, debouncedQuery)
                                            : item.name}
                                    </span>
                                    {isAudio && item.path && audioDurationSecRef.current[item.path] != null && (
                                        <span style={{
                                            minWidth: 26,
                                            color: 'var(--color-text-tertiary)',
                                            fontSize: 'var(--font-size-2xs)',
                                            fontFamily: 'var(--font-mono)',
                                            textAlign: 'right',
                                            flexShrink: 0,
                                        }}>
                                            {`${Math.round(audioDurationSecRef.current[item.path])}s`}
                                        </span>
                                    )}
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


/**
 * AssetBrowser — Ableton-style two-pane vertical-split sidebar browser.
 *
 * All state management and business logic delegated to useAssetBrowserLogic hook.
 * This component is purely rendering / presentational.
 */
export const AssetBrowser = () => {
    const logic = useAssetBrowserLogic();

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
                    debouncedQuery={logic.debouncedQuery}
                    setDebouncedQuery={logic.setDebouncedQuery}
                    searchRef={logic.searchRef}
                    handleBrowserKeyDown={logic.handleBrowserKeyDown}
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
            }} ref={logic.splitRootRef}>
                {/* ── LEFT PANE: Category Tree ── */}
                <div
                    className="scrollbar-hide"
                    style={{
                        width: logic.leftPaneWidth,
                        minWidth: 88,
                        flexShrink: 0,
                        overflowY: 'auto',
                        borderRight: '1px solid var(--color-divider)',
                        background: 'var(--color-bg-panel)',
                    }}
                >
                    {logic.categories.map(cat => {
                        // Section header
                        if (cat.kind === 'section') {
                            const collapsed = cat.id === 'sec-collections' ? false : logic.collapsedSections.has(cat.id);
                            currentSection = cat.id;
                            const addTopGap = cat.id === 'sec-library' || cat.id === 'sec-folders';
                            const isBrowserSection = cat.id === 'sec-collections';
                            return (
                                <div key={cat.id} style={{ marginTop: addTopGap ? 10 : 0 }}>
                                    <button
                                        onClick={isBrowserSection ? undefined : () => logic.toggleSection(cat.id)}
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
                                        <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                                            {cat.title}
                                        </span>
                                        {!isBrowserSection && (
                                            <svg width="9" height="9" viewBox="0 0 9 9" style={{ flexShrink: 0, opacity: 0.78 }} aria-hidden>
                                                <polyline
                                                    points={collapsed ? '2,1 6,4.5 2,8' : '1,2 4.5,6 8,2'}
                                                    fill="none" stroke="currentColor" strokeWidth="1.4"
                                                    strokeLinecap="round" strokeLinejoin="round"
                                                />
                                            </svg>
                                        )}
                                    </button>
                                </div>
                            );
                        }

                        // Leaf item — hidden if parent section collapsed
                        const parentSectionId = currentSection;
                        if (parentSectionId && logic.collapsedSections.has(parentSectionId)) return null;
                        const isSelected = logic.selectedCategoryId === cat.id;

                        // Special: Add Folder button
                        if (cat.id === 'addFolder') {
                            return (
                                <button key={cat.id} onClick={logic.handleAddFolder}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: 4,
                                        width: '100%', padding: '2px 4px 2px 12px',
                                        background: 'transparent', border: 'none', color: '#ffffff',
                                        fontSize: 'var(--font-size-base)',
                                        fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                                        textAlign: 'left', cursor: 'pointer',
                                        transition: 'background var(--transition-fast)',
                                        lineHeight: 1.9, opacity: 0.95,
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
                                    logic.setSelectedCategoryId(cat.id);
                                    if (logic.fileListRef.current) logic.fileListRef.current.scrollTop = 0;
                                }}
                                onContextMenu={cat.removable ? (e) => {
                                    e.preventDefault();
                                    if (cat.folderPath && confirm(`Remove "${cat.title}" from browser?`)) {
                                        logic.handleRemoveFolder(cat.folderPath);
                                    }
                                } : (cat.id.startsWith('collection-') ? (e) => {
                                    e.preventDefault();
                                    const next = window.prompt('Rename collection', cat.title)?.trim();
                                    if (!next) return;
                                    logic.setCollectionLabels((prev) => {
                                        const next2 = { ...prev, [cat.id]: next };
                                        logic.saveCollectionLabels(next2);
                                        return next2;
                                    });
                                } : undefined)}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 4,
                                    width: '100%', padding: '2px 4px 2px 12px',
                                    background: isSelected ? 'var(--color-bg-selected)' : 'transparent',
                                    border: 'none', color: '#ffffff',
                                    fontSize: 'var(--font-size-base)',
                                    fontWeight: isSelected ? 600 : 500,
                                    textAlign: 'left', cursor: 'pointer',
                                    transition: 'background var(--transition-fast)',
                                    lineHeight: 1.9,
                                }}
                            >
                                <span style={{ width: 14, display: 'inline-flex', justifyContent: 'center', alignItems: 'center', flexShrink: 0, color: '#ffffff' }}>
                                    {cat.markerColor ? (
                                        <span style={{
                                            width: 7, height: 7, borderRadius: '50%',
                                            background: cat.markerColor,
                                            boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.28)',
                                        }} />
                                    ) : (
                                        <BrowserGlyph name={cat.icon} size={12} />
                                    )}
                                </span>
                                <span style={{
                                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                }}>{cat.title}</span>
                            </button>
                        );
                    })}
                </div>
                <div
                    onMouseDown={logic.beginSplitResize}
                    style={{ width: 6, cursor: 'ew-resize', background: 'transparent', flexShrink: 0 }}
                />

                {/* ── RIGHT PANE: Filters + File List ── */}
                <div style={{
                    flex: 1, minHeight: 0, minWidth: 0,
                    display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto',
                    overflow: 'hidden', background: 'var(--color-bg-secondary)',
                }}>
                    {/* ── ROW 1: Filters Toolbar ── */}
                    <div style={{
                        gridRow: 1, display: 'flex', flexWrap: 'wrap', gap: 4,
                        padding: '4px 6px', borderBottom: '1px solid var(--color-divider)',
                        background: 'var(--color-bg-header)',
                    }}>
                        {logic.selectedCategoryId === 'plugins' ? (
                            <>
                                <FilterPill
                                    options={[
                                        'Source: All', 'Source: Internal', 'Source: VST3',
                                        'Source: VST2', 'Source: AU', 'Source: External',
                                    ]}
                                    value={{ all: 0, internal: 1, vst3: 2, vst2: 3, au: 4, external: 5 }[logic.pluginSourceFilter]}
                                    onChange={(idx) => {
                                        const next = (['all', 'internal', 'vst3', 'vst2', 'au', 'external'] as const)[idx] ?? 'all';
                                        logic.setPluginSourceFilter(next);
                                    }}
                                />
                                <button onClick={logic.triggerPluginScan} style={pluginActionButtonStyle} title="Rescan installed plugins">
                                    Rescan
                                </button>
                                <button onClick={() => { void logic.handleSetPluginFolder('vst2Path'); }} style={pluginActionButtonStyle} title="Select VST2 folder">
                                    Import VST2 Folder
                                </button>
                                <button onClick={() => { void logic.handleSetPluginFolder('vst3Path'); }} style={pluginActionButtonStyle} title="Select VST3 folder">
                                    Import VST3 Folder
                                </button>
                            </>
                        ) : (
                            <>
                                <FilterPill options={SOURCE_FILTERS as unknown as string[]} value={logic.sourceFilter} onChange={logic.setSourceFilter} />
                                <FilterPill options={FORMAT_FILTERS as unknown as string[]} value={logic.formatFilter} onChange={logic.setFormatFilter} />
                                <FilterPill options={AUDIO_FILTERS as unknown as string[]} value={logic.audioFilter} onChange={logic.setAudioFilter} />
                            </>
                        )}
                        <FilterPill options={SORT_FILTERS as unknown as string[]} value={logic.sortFilter} onChange={logic.setSortFilter} />
                        <FilterPill options={SIZE_FILTERS as unknown as string[]} value={logic.sizeFilter} onChange={logic.setSizeFilter} />
                    </div>

                    {logic.selectedCategoryId === 'plugins' && (
                        <div style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '2px 8px', borderBottom: '1px solid var(--color-divider-light)',
                            background: 'var(--color-bg-header)',
                            fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-tertiary)',
                            fontFamily: 'var(--font-mono)',
                        }}>
                            <span>INT: {INTERNAL_INSTRUMENT_ITEMS.length + INTERNAL_EFFECT_ITEMS.length}</span>
                            <span>EXT: {logic.pluginBrowserItems.length}</span>
                            <span style={{ opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                VST2: {logic.settings.vst2Path || 'not set'}
                            </span>
                            <span style={{ opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                VST3: {logic.settings.vst3Path || 'not set'}
                            </span>
                        </div>
                    )}

                    {/* ── ROW 2: Virtual Scroll List ── */}
                    <div style={{
                        gridRow: 2, minHeight: 0, overflow: 'hidden',
                        display: 'flex', flexDirection: 'column',
                    }}>
                        {/* Plugin Search Alphabet Anchors */}
                        {logic.selectedCategoryId === 'plugins' && logic.pluginLetterAnchors.letters.length > 0 && (
                            <div className="scrollbar-hide" style={{
                                flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2,
                                padding: '4px 8px', overflowX: 'auto',
                                borderBottom: '1px solid var(--color-divider-light)',
                                background: 'color-mix(in srgb, var(--color-bg-header) 95%, transparent)',
                            }}>
                                {logic.pluginLetterAnchors.letters.map((letter) => (
                                    <button
                                        key={letter}
                                        onClick={() => {
                                            logic.jumpToPluginLetter(letter);
                                            logic.focusResults();
                                        }}
                                        style={{
                                            minWidth: 18, height: 16,
                                            borderRadius: 'var(--radius-md)',
                                            border: '1px solid var(--color-divider)',
                                            background: logic.selectedPluginLetter === letter
                                                ? 'var(--color-control-bg-active)' : 'var(--color-control-bg)',
                                            color: logic.selectedPluginLetter === letter
                                                ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                                            fontSize: 'var(--font-size-2xs)',
                                            fontWeight: 'var(--font-weight-bold)' as unknown as number,
                                            fontFamily: 'var(--font-mono)',
                                            cursor: 'pointer', padding: 0, flexShrink: 0,
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
                            items={logic.items}
                            selectedCategoryId={logic.selectedCategoryId}
                            selectedItemId={logic.selectedItemId}
                            setSelectedItemId={logic.setSelectedItemId}
                            syncPreviewForItem={logic.syncPreviewForItem}
                            isPreviewPlayingRef={logic.isPreviewPlayingRef}
                            setContextMenu={logic.setContextMenu}
                            navigateInto={logic.navigateInto}
                            showTypeColumn={logic.showTypeColumn}
                            showSizeColumn={logic.showSizeColumn}
                            debouncedQuery={logic.debouncedQuery}
                            audioDurationSecRef={logic.audioDurationSecRef}
                            itemRowRefs={logic.itemRowRefs}
                            fileListRef={logic.fileListRef}
                            handleBrowserKeyDown={logic.handleBrowserKeyDown}
                            pluginGroupedRows={logic.pluginGroupedRows}
                            scanLoading={logic.scanLoading}
                            scanError={logic.scanError}
                            columnMenuPos={logic.columnMenuPos}
                            setColumnMenuPos={logic.setColumnMenuPos}
                        />
                    </div>

                    {/* ── ROW 3: Footer Preview Panel ────────── */}
                    <div style={{
                        gridRow: 3, flexShrink: 0,
                        borderTop: '2px solid var(--color-divider)',
                        background: 'var(--color-bg-secondary)',
                        position: 'relative', zIndex: 10,
                    }}>
                        <div style={{
                            display: 'flex', alignItems: 'center', padding: '4px 8px',
                            gap: 5, fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)',
                        }}>
                            <div style={{
                                flex: 1, minWidth: 0, height: 16,
                                borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--color-border-subtle)',
                                background: 'color-mix(in srgb, #000 18%, transparent)',
                                overflow: 'hidden', display: 'flex', alignItems: 'center', padding: '0 4px',
                            }}>
                                {logic.previewPeaks ? (
                                    <PreviewWaveform peaks={logic.previewPeaks} height={12} />
                                ) : (
                                    <div style={{
                                        width: '100%', height: 8,
                                        borderRadius: 'var(--radius-xs)',
                                        background: 'color-mix(in srgb, var(--color-text-primary) 4%, transparent)',
                                    }} />
                                )}
                            </div>

                            <button
                                onClick={() => {
                                    const next = !logic.previewEnabled;
                                    logic.setPreviewEnabled(next);
                                    if (!next) {
                                        logic.isPreviewPlayingRef.current = false;
                                        logic.engineApi.stopPreview().catch((err) => {
                                            console.warn('[AssetBrowser] stopPreview(toggle) failed:', err);
                                        });
                                        return;
                                    }
                                    const selected = logic.items.find(i => i.id === logic.selectedItemId);
                                    if (selected?.type === 'audio' && selected.path) {
                                        logic.isPreviewPlayingRef.current = true;
                                        logic.engineApi.previewAudioFile(selected.path).catch((err) => {
                                            console.warn('[AssetBrowser] previewAudioFile(toggle) failed:', err);
                                        });
                                    }
                                }}
                                title={logic.previewEnabled ? 'Preview on' : 'Preview off'}
                                style={{
                                    width: 16, height: 16, minWidth: 16,
                                    borderRadius: '50%',
                                    border: '1px solid var(--color-border-subtle)',
                                    background: logic.previewEnabled ? 'var(--color-control-bg-active)' : 'var(--color-control-bg)',
                                    color: logic.previewEnabled ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                                    cursor: 'pointer', display: 'inline-flex',
                                    alignItems: 'center', justifyContent: 'center',
                                    fontSize: 'var(--font-size-2xs)',
                                }}
                                aria-pressed={logic.previewEnabled}
                            >
                                <BrowserGlyph name="headphones" size={9} />
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {
                logic.columnMenuPos && (
                    <div
                        ref={logic.columnMenuRef}
                        style={{
                            position: 'fixed',
                            left: Math.max(8, logic.columnMenuPos.x - 140),
                            top: Math.max(8, logic.columnMenuPos.y),
                            width: 150,
                            background: 'var(--surface-2)',
                            border: '1px solid var(--color-border-subtle)',
                            borderRadius: 'var(--radius-xl)',
                            boxShadow: 'var(--shadow-panel)',
                            padding: 6,
                            zIndex: 'var(--z-drag-overlay)' as unknown as number,
                        }}
                    >
                        <button onClick={logic.toggleSizeColumn} style={columnMenuItemStyle}>
                            <span style={columnMenuCheckStyle}>{logic.showSizeColumn ? '✓' : ''}</span>
                            Size
                        </button>
                        <button onClick={logic.toggleTypeColumn} style={columnMenuItemStyle}>
                            <span style={columnMenuCheckStyle}>{logic.showTypeColumn ? '✓' : ''}</span>
                            Type
                        </button>
                    </div>
                )
            }

            {/* ── Context Menu for Collections ────────── */}
            {
                logic.contextMenu && logic.contextMenu.item.path && (
                    <div
                        ref={logic.contextMenuRef}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            position: 'fixed',
                            left: Math.min(logic.contextMenu.x, window.innerWidth - 200),
                            top: Math.min(logic.contextMenu.y, window.innerHeight - 180),
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
                            const path = logic.contextMenu!.item.path!;
                            const isInCollection = logic.collectionItems[collId].has(path);
                            const isInCollectionView = logic.selectedCategoryId === collId;
                            return (
                                <button
                                    key={collId}
                                    onClick={() => {
                                        logic.setCollectionItems((prev) => {
                                            const next = {
                                                'collection-red': new Set(prev['collection-red']),
                                                'collection-yellow': new Set(prev['collection-yellow']),
                                                'collection-green': new Set(prev['collection-green']),
                                            };
                                            if (isInCollection) next[collId].delete(path);
                                            else next[collId].add(path);
                                            logic.saveCollections(next);
                                            return next;
                                        });
                                        logic.setContextMenu(null);
                                    }}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: 8,
                                        width: '100%', padding: '6px 10px',
                                        background: 'transparent', border: 'none',
                                        color: 'var(--color-text-primary)',
                                        fontSize: 'var(--font-size-xs)',
                                        cursor: 'pointer', borderRadius: 'var(--radius-sm)',
                                        textAlign: 'left',
                                    }}
                                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-hover)'; }}
                                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
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

// ── Style constants ─────────────────────────────────────

const columnMenuItemStyle: React.CSSProperties = {
    width: '100%', background: 'transparent', border: 'none',
    color: 'var(--color-text-primary)', padding: '5px 6px',
    borderRadius: 'var(--radius-md)', display: 'flex',
    alignItems: 'center', gap: 6, fontSize: 'var(--font-size-sm)',
    textAlign: 'left', cursor: 'pointer',
};

const columnMenuCheckStyle: React.CSSProperties = {
    width: 12, textAlign: 'center',
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
