import { memo } from 'react';
import { useDragStore } from '@/shared/stores/useDragStore';
import { TypeIcon } from './AssetBrowserPrimitives';
import { renderHighlightedMatch } from './AssetBrowserRowUtils';
import type { RowBaseProps } from './AssetBrowserRows';

export const PluginGroupHeaderRow = memo(function PluginGroupHeaderRow({
    title, count,
}: { title: string; count: number }) {
    return (
        <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 8, padding: 'var(--space-1) var(--space-2)',
            background: 'color-mix(in srgb, var(--color-bg-header) 84%, var(--surface-1))',
            borderBottom: 'var(--space-px) solid var(--color-divider-light)', borderTop: 'var(--space-px) solid var(--color-divider-light)',
            position: 'sticky', top: 24, zIndex: 'var(--z-local)',
        }}>
            <span style={{
                color: 'var(--color-text-primary)', fontSize: 'var(--font-size-xs)',
                fontWeight: 'var(--font-weight-bold)',
                textTransform: 'uppercase', letterSpacing: '0.04em',
            }}>{title}</span>
            <span style={{ color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-2xs)', fontFamily: 'var(--font-role-data)' }}>{count}</span>
        </div>
    );
});

export const PluginGroupItemRow = memo(function PluginGroupItemRow({
    item, ROW_HEIGHT, isSelected, debouncedQuery, showTypeColumn, showSizeColumn,
    getAudioDurationSec, isPreviewPlayingRef, bindItemRowRef, setSelectedItemId, syncPreviewForItem, setContextMenu, fileListRef,
}: RowBaseProps & { ROW_HEIGHT: number }) {
    const isAudio = item.type === 'audio';
    const isPlugin = item.type === 'plugin';
    const isDraggable = isAudio || isPlugin;
    const pluginTypeLabel = item.pluginSource === 'internal' ? 'Internal' : item.pluginSource === 'vst3' ? 'VST3' : item.pluginSource === 'vst2' ? 'VST2' : item.pluginSource === 'au' ? 'AU' : (item.format || 'Plugin');
    const typeLabel = item.isDirectory ? 'Folder' : (item.type === 'audio' ? (item.format || 'Audio').toUpperCase() : (item.type === 'plugin' ? pluginTypeLabel : (item.format || item.type)));
    const sizeLabel = item.sizeBytes && !item.isDirectory ? (item.sizeBytes >= 1024 * 1024 ? `${(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(item.sizeBytes / 1024)} KB`) : '';
    void getAudioDurationSec;

    return (
        <div
            ref={(el) => bindItemRowRef(item.id, el)}
            onClick={() => {
                setContextMenu(null);
                if (isSelected) {
                    if (item.type === 'audio' && item.path) {
                        if (isPreviewPlayingRef.current) {
                            isPreviewPlayingRef.current = false;
                            syncPreviewForItem(null);
                        } else {
                            isPreviewPlayingRef.current = true;
                            syncPreviewForItem(item);
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
                    // Only restore styles if we actually changed them during drag
                    if (dragStarted && fileListRef.current) {
                        fileListRef.current.style.pointerEvents = '';
                        fileListRef.current.style.overflow = '';
                        fileListRef.current.style.overflowY = 'auto';
                        fileListRef.current.style.overflowX = 'hidden';
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
                        // Lock scroll only when drag actually begins
                        if (fileListRef.current) {
                            fileListRef.current.style.overflow = 'hidden';
                            fileListRef.current.style.pointerEvents = 'none';
                        }
                        useDragStore.getState().startDrag({
                            id: item.id, name: item.name, type: isPlugin ? 'plugin' : 'audio', path: item.path!, slotHint: item.slotHint ?? 'auto',
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
                display: 'flex', alignItems: 'center', gap: 8, padding: 'var(--space-1) var(--space-2)', cursor: isDraggable ? 'grab' : 'default',
                background: isSelected ? 'var(--color-bg-selected)' : 'transparent',
                borderBottom: 'var(--space-px) solid var(--color-divider-light)', height: ROW_HEIGHT, boxSizing: 'border-box',
            }}
        >
            <TypeIcon type={item.type} item={item} />
            <span style={{
                color: 'var(--color-text-primary)', fontSize: 'var(--font-size-base)',
                fontWeight: 'var(--font-weight-medium)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
            }}>{debouncedQuery.trim() ? renderHighlightedMatch(item.name, debouncedQuery) : item.name}</span>
            {showTypeColumn && <span style={{ minWidth: 52, maxWidth: 74, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0 }}>{typeLabel}</span>}
            {showSizeColumn && <span style={{ minWidth: 44, maxWidth: 56, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', textAlign: 'right', whiteSpace: 'nowrap', flexShrink: 0 }}>{sizeLabel}</span>}
        </div>
    );
});
