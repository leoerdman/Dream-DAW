import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { BrowserItem, PluginGroupedRow } from '@/widgets/AssetBrowser/model/useAssetBrowserLogic';
import { useDragStore } from '@/shared/stores/useDragStore';
import { BrowserGlyph, TypeIcon } from './AssetBrowserPrimitives';

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
