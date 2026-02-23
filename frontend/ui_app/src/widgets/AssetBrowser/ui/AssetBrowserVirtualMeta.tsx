import React, { memo } from 'react';
import { BrowserGlyph } from './AssetBrowserPrimitives';

export const VirtualListHeader = memo(function VirtualListHeader({
    showTypeColumn,
    showSizeColumn,
    setColumnMenuPos,
}: {
    showTypeColumn: boolean;
    showSizeColumn: boolean;
    setColumnMenuPos: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
}) {
    return (
        <div
            onContextMenu={(e) => {
                e.preventDefault();
                setColumnMenuPos({ x: e.clientX, y: e.clientY });
            }}
            style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: 'var(--space-0-5) var(--space-2)', background: 'var(--color-bg-header)',
                borderBottom: 'var(--space-px) solid var(--color-divider-light)', color: 'var(--color-text-secondary)',
                fontSize: 'var(--font-size-2xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
                position: 'sticky', top: 0, zIndex: 'var(--z-local-raised)' as unknown as number,
            }}
        >
            <button
                onClick={(e) => {
                    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                    setColumnMenuPos((prev) => (prev ? null : { x: rect.left, y: rect.bottom + 2 }));
                }}
                style={{
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--color-text-secondary)',
                    display: 'inline-flex', alignItems: 'center', flexShrink: 0,
                }}
                title="Column visility"
            >
                <BrowserGlyph name="settings" size={10} />
            </button>
            <span style={{ flex: 1, minWidth: 0 }}>Name</span>
            {showTypeColumn && <span style={{ minWidth: 52, textAlign: 'left', flexShrink: 0 }}>Type</span>}
            {showSizeColumn && <span style={{ minWidth: 44, textAlign: 'right', flexShrink: 0 }}>Size</span>}
        </div>
    );
});

export const ScanStatus = memo(function ScanStatus({ scanLoading, scanError }: { scanLoading: boolean; scanError: string | null }) {
    if (scanLoading) {
        return (
            <div style={{ padding: 'var(--space-3) var(--space-2-5)', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-xs)' }}>
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                    <BrowserGlyph name="hourglass" size={11} />
                    Scanning…
                </span>
            </div>
        );
    }
    if (!scanError) return null;
    return (
        <div style={{ padding: 'var(--space-2) var(--space-2-5)', color: 'var(--color-status-error)', fontSize: 'var(--font-size-xs)' }}>
            <span>⚠ Scan error</span>
            <span style={{ opacity: 0.7, fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-2xs)' }}>{scanError}</span>
        </div>
    );
});

export const EmptyAssetState = memo(function EmptyAssetState({
    scanLoading,
    itemsLength,
    selectedCategoryId,
    query,
}: {
    scanLoading: boolean;
    itemsLength: number;
    selectedCategoryId: string;
    query: string;
}) {
    if (scanLoading || itemsLength > 0) return null;
    const message = selectedCategoryId === 'plugins'
        ? 'No plug-ins found. Try importing a VST folder.'
        : selectedCategoryId.startsWith('collection-')
            ? 'Collection is empty. Right-click items to add them.'
            : selectedCategoryId === 'drums'
                ? 'No drum samples found.'
                : query.trim()
                    ? `No results for "${query.trim()}"`
                    : 'No items found';

    return (
        <div style={{ padding: 'var(--space-5) var(--space-3)', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-xs)' }}>
            {message}
        </div>
    );
});
