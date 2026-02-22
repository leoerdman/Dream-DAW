import React, { memo } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useDragStore } from '@/shared/stores/useDragStore';
import { BrowserGlyph, TypeIcon } from './AssetBrowserPrimitives';
import type { BrowserItem } from '@/widgets/AssetBrowser/model/useAssetBrowserLogic';

// ── Shared Helpers ──────────────────────────────────────────

export function renderHighlightedMatch(name: string, query: string): React.ReactNode {
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

// ── Props & Shared Logic ────────────────────────────────────

interface RowBaseProps {
    item: BrowserItem;
    isSelected: boolean;
    debouncedQuery: string;
    showTypeColumn: boolean;
    showSizeColumn: boolean;
    audioDurationSecRef: React.RefObject<Record<string, number>>;
    isPreviewPlayingRef: React.RefObject<boolean>;
    itemRowRefs: React.RefObject<Record<string, HTMLDivElement | null>>;
    setSelectedItemId: (id: string | null) => void;
    syncPreviewForItem: (item: BrowserItem | null) => void;
    setContextMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; item: BrowserItem } | null>>;
    fileListRef: React.RefObject<HTMLDivElement | null>;
}

// ── Components ──────────────────────────────────────────────

export const AssetListItemRow = memo(function AssetListItemRow({
    item,
    absIdx,
    ROW_HEIGHT,
    HEADER_HEIGHT,
    isSelected,
    debouncedQuery,
    showTypeColumn,
    showSizeColumn,
    audioDurationSecRef,
    isPreviewPlayingRef,
    itemRowRefs,
    setSelectedItemId,
    syncPreviewForItem,
    setContextMenu,
    navigateInto,
    fileListRef,
}: RowBaseProps & {
    absIdx: number;
    ROW_HEIGHT: number;
    HEADER_HEIGHT: number;
    navigateInto: (path: string) => void;
}) {
    const isAudio = item.type === 'audio';
    const isPlugin = item.type === 'plugin';
    const isDraggable = isAudio || isPlugin;

    const pluginTypeLabel = item.pluginSource === 'internal' ? 'Internal'
        : item.pluginSource === 'vst3' ? 'VST3'
            : item.pluginSource === 'vst2' ? 'VST2'
                : item.pluginSource === 'au' ? 'AU'
                    : (item.format || 'Plugin');

    const typeLabel = item.isDirectory ? 'Folder'
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
            ref={(el) => { itemRowRefs.current[item.id] = el; }}
            onClick={() => {
                setContextMenu(null);
                if (item.isDirectory && item.path) {
                    navigateInto(item.path);
                    return;
                }
                if (isSelected) {
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
                if (item.path) setContextMenu({ x: e.clientX, y: e.clientY, item });
            }}
            onMouseDown={(e) => {
                if (!isDraggable || !item.path || e.button !== 0) return;
                const startX = e.clientX;
                const startY = e.clientY;
                const DRAG_THRESHOLD = 8;
                let dragStarted = false;
                let cancelled = false;

                const cleanup = () => {
                    if (cancelled) return;
                    cancelled = true;
                    if (fileListRef.current) {
                        fileListRef.current.style.pointerEvents = '';
                        fileListRef.current.style.overflow = '';
                    }
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
                display: 'flex', alignItems: 'center', gap: 8,
                padding: `4px 8px 4px ${8 + (item._depth ?? 0) * 14}px`,
                cursor: isDraggable ? 'grab' : (item.isDirectory ? 'pointer' : 'default'),
                position: 'absolute', top: absIdx * ROW_HEIGHT + HEADER_HEIGHT,
                left: 0, right: 0, height: ROW_HEIGHT, boxSizing: 'border-box',
                background: isSelected ? 'var(--color-bg-selected)' : 'transparent',
                borderBottom: '1px solid var(--color-divider-light)',
            }}
        >
            {item.isDirectory && (
                <svg width="9" height="9" viewBox="0 0 9 9" style={{ flexShrink: 0, opacity: 0.6 }}>
                    <polyline points={item._expanded ? '1,2 4.5,6 8,2' : '2,1 6,4.5 2,8'}
                        fill="none" stroke="currentColor" strokeWidth="1.4"
                        strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            )}
            {item._loading && <span style={{ fontSize: 'var(--font-size-2xs)', opacity: 0.5 }}>⏳</span>}
            <TypeIcon type={item.type} item={item} />
            <span style={{
                color: 'var(--color-text-primary)', fontSize: 'var(--font-size-base)',
                fontWeight: 'var(--font-weight-medium)' as unknown as number,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                flex: 1, minWidth: 0,
            }}>
                {debouncedQuery.trim() ? renderHighlightedMatch(item.name, debouncedQuery) : item.name}
            </span>
            {isAudio && item.path && audioDurationSecRef.current[item.path] != null && (
                <span style={{
                    minWidth: 26, color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-2xs)',
                    fontFamily: 'var(--font-mono)', textAlign: 'right', flexShrink: 0,
                }}>
                    {`${Math.round(audioDurationSecRef.current[item.path])}s`}
                </span>
            )}
            {showTypeColumn && (
                <span style={{
                    minWidth: 52, maxWidth: 74, color: 'var(--color-text-secondary)',
                    fontSize: 'var(--font-size-xs)', textAlign: 'left', whiteSpace: 'nowrap',
                    overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0,
                }}>
                    {typeLabel}
                </span>
            )}
            {showSizeColumn && (
                <span style={{
                    minWidth: 44, maxWidth: 56, color: 'var(--color-text-secondary)',
                    fontSize: 'var(--font-size-xs)', textAlign: 'right', whiteSpace: 'nowrap', flexShrink: 0,
                }}>
                    {sizeLabel}
                </span>
            )}
            {item.isDirectory && (
                <span style={{
                    color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-2xs)',
                    display: 'inline-flex', alignItems: 'center', marginLeft: 2, flexShrink: 0,
                }}>
                    <BrowserGlyph name="chevron-right" size={10} />
                </span>
            )}
        </div>
    );
});

export const PluginGroupHeaderRow = memo(function PluginGroupHeaderRow({
    title, count
}: { title: string; count: number }) {
    return (
        <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 8, padding: '4px 8px',
            background: 'color-mix(in srgb, var(--color-bg-header) 84%, var(--surface-1))',
            borderBottom: '1px solid var(--color-divider-light)',
            borderTop: '1px solid var(--color-divider-light)',
            position: 'sticky', top: 24, zIndex: 'var(--z-local)' as unknown as number,
        }}>
            <span style={{
                color: 'var(--color-text-primary)', fontSize: 'var(--font-size-xs)',
                fontWeight: 'var(--font-weight-bold)' as unknown as number,
                textTransform: 'uppercase', letterSpacing: '0.04em',
            }}>
                {title}
            </span>
            <span style={{
                color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-2xs)',
                fontFamily: 'var(--font-mono)',
            }}>
                {count}
            </span>
        </div>
    );
});

export const PluginGroupItemRow = memo(function PluginGroupItemRow({
    item, ROW_HEIGHT,
    isSelected, debouncedQuery, showTypeColumn, showSizeColumn,
    audioDurationSecRef, isPreviewPlayingRef, itemRowRefs,
    setSelectedItemId, syncPreviewForItem, setContextMenu, fileListRef,
}: RowBaseProps & { ROW_HEIGHT: number }) {
    const isAudio = item.type === 'audio';
    const isPlugin = item.type === 'plugin';
    const isDraggable = isAudio || isPlugin;

    const pluginTypeLabel = item.pluginSource === 'internal' ? 'Internal'
        : item.pluginSource === 'vst3' ? 'VST3'
            : item.pluginSource === 'vst2' ? 'VST2'
                : item.pluginSource === 'au' ? 'AU'
                    : (item.format || 'Plugin');

    const typeLabel = item.isDirectory ? 'Folder'
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
            ref={(el) => { itemRowRefs.current[item.id] = el; }}
            onClick={() => {
                setContextMenu(null);
                if (isSelected) {
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
                if (item.path) setContextMenu({ x: e.clientX, y: e.clientY, item });
            }}
            onMouseDown={(e) => {
                if (!isDraggable || !item.path || e.button !== 0) return;
                const startX = e.clientX;
                const startY = e.clientY;
                const DRAG_THRESHOLD = 8;
                let dragStarted = false;
                let cancelled = false;

                const cleanup = () => {
                    if (cancelled) return;
                    cancelled = true;
                    if (fileListRef.current) {
                        fileListRef.current.style.pointerEvents = '';
                        fileListRef.current.style.overflow = '';
                    }
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
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '4px 8px', cursor: isDraggable ? 'grab' : 'default',
                background: isSelected ? 'var(--color-bg-selected)' : 'transparent',
                borderBottom: '1px solid var(--color-divider-light)',
                height: ROW_HEIGHT, boxSizing: 'border-box',
            }}
        >
            <TypeIcon type={item.type} item={item} />
            <span style={{
                color: 'var(--color-text-primary)', fontSize: 'var(--font-size-base)',
                fontWeight: 'var(--font-weight-medium)' as unknown as number,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                flex: 1, minWidth: 0,
            }}>
                {debouncedQuery.trim() ? renderHighlightedMatch(item.name, debouncedQuery) : item.name}
            </span>
            {showTypeColumn && (
                <span style={{
                    minWidth: 52, maxWidth: 74, color: 'var(--color-text-secondary)',
                    fontSize: 'var(--font-size-xs)', textAlign: 'left', whiteSpace: 'nowrap',
                    overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0,
                }}>
                    {typeLabel}
                </span>
            )}
            {showSizeColumn && (
                <span style={{
                    minWidth: 44, maxWidth: 56, color: 'var(--color-text-secondary)',
                    fontSize: 'var(--font-size-xs)', textAlign: 'right', whiteSpace: 'nowrap', flexShrink: 0,
                }}>
                    {sizeLabel}
                </span>
            )}
        </div>
    );
});
