import React, { memo } from 'react';
import {
    COLLECTION_ICONS,
    COLLECTION_IDS,
    COLLECTION_LABELS_DEFAULT,
    type CollectionId,
} from '../model/assetBrowserUtils';
import type { BrowserItem } from '../model/useAssetBrowserLogic';

interface AssetBrowserOverlaysProps {
    columnMenuPos: { x: number; y: number } | null;
    columnMenuRef: React.RefObject<HTMLDivElement | null>;
    toggleSizeColumn: () => void;
    toggleTypeColumn: () => void;
    showSizeColumn: boolean;
    showTypeColumn: boolean;
    contextMenu: { x: number; y: number; item: BrowserItem } | null;
    contextMenuRef: React.RefObject<HTMLDivElement | null>;
    collectionItems: Record<CollectionId, Set<string>>;
    selectedCategoryId: string;
    saveCollections: (collections: Record<CollectionId, Set<string>>) => void;
    setCollectionItems: React.Dispatch<React.SetStateAction<Record<CollectionId, Set<string>>>>;
    setContextMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; item: BrowserItem } | null>>;
    collectionLabels: Record<string, string>;
}

// BUG-41 FIX: wrapped in memo
export const AssetBrowserOverlays = memo(function AssetBrowserOverlays({
    columnMenuPos,
    columnMenuRef,
    toggleSizeColumn,
    toggleTypeColumn,
    showSizeColumn,
    showTypeColumn,
    contextMenu,
    contextMenuRef,
    collectionItems,
    selectedCategoryId,
    saveCollections,
    setCollectionItems,
    setContextMenu,
    collectionLabels,
}: AssetBrowserOverlaysProps) {
    return (
        <>
            {columnMenuPos && (
                <div
                    ref={columnMenuRef}
                    style={columnMenuContainerStyle(columnMenuPos.x, columnMenuPos.y)}
                >
                    <button onClick={toggleSizeColumn} style={columnMenuItemStyle}>
                        <span style={columnMenuCheckStyle}>{showSizeColumn ? '✓' : ''}</span>
                        Size
                    </button>
                    <button onClick={toggleTypeColumn} style={columnMenuItemStyle}>
                        <span style={columnMenuCheckStyle}>{showTypeColumn ? '✓' : ''}</span>
                        Type
                    </button>
                </div>
            )}

            {contextMenu && contextMenu.item.path && (
                <div
                    ref={contextMenuRef}
                    onClick={(e) => e.stopPropagation()}
                    style={contextMenuStyle(contextMenu.x, contextMenu.y)}
                >
                    {COLLECTION_IDS.map((collId) => {
                        const path = contextMenu.item.path!;
                        const isInCollection = collectionItems[collId].has(path);
                        const isInCollectionView = selectedCategoryId === collId;
                        return (
                            <button
                                key={collId}
                                onClick={() => {
                                    setCollectionItems((prev) => {
                                        const next = {
                                            'collection-red': new Set(prev['collection-red']),
                                            'collection-yellow': new Set(prev['collection-yellow']),
                                            'collection-green': new Set(prev['collection-green']),
                                        };
                                        if (isInCollection) next[collId].delete(path);
                                        else next[collId].add(path);
                                        saveCollections(next);
                                        return next;
                                    });
                                    setContextMenu(null);
                                }}
                                style={contextMenuItemStyle}
                                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-hover)'; }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                            >
                                <span>{COLLECTION_ICONS[collId]}</span>
                                <span>
                                    {(() => {
                                        const label = collectionLabels[collId] ?? COLLECTION_LABELS_DEFAULT[collId];
                                        return isInCollection
                                            ? (isInCollectionView ? `Remove from ${label}` : `✓ In ${label}`)
                                            : `Add to ${label}`;
                                    })()}
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}
        </>
    );
});

const columnMenuContainerStyle = (x: number, y: number): React.CSSProperties => ({
    position: 'fixed',
    left: Math.max(8, x - 140),
    top: Math.max(8, y),
    width: 150,
    background: 'var(--surface-2)',
    border: 'var(--space-px) solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-xl)',
    boxShadow: 'var(--shadow-panel)',
    padding: 6,
    zIndex: 'var(--z-drag-overlay)' as unknown as number,
});

const columnMenuItemStyle: React.CSSProperties = {
    width: '100%',
    background: 'transparent',
    border: 'none',
    color: 'var(--color-text-primary)',
    padding: 'var(--token-size-px-5) var(--space-1-5)',
    borderRadius: 'var(--radius-md)',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 'var(--font-size-sm)',
    textAlign: 'left',
    cursor: 'pointer',
};

const columnMenuCheckStyle: React.CSSProperties = {
    width: 12,
    textAlign: 'center',
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-accent-primary)',
};

const contextMenuStyle = (x: number, y: number): React.CSSProperties => ({
    position: 'fixed',
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - 180),
    background: 'var(--color-bg-elevated)',
    border: 'var(--space-px) solid var(--color-divider)',
    borderRadius: 'var(--radius-md)',
    padding: 4,
    zIndex: 'var(--z-drag-overlay)' as unknown as number,
    minWidth: 180,
    boxShadow: '0 var(--space-2) var(--space-6) var(--color-overlay-dark)',
});

const contextMenuItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: 'var(--space-1-5) var(--space-2-5)',
    background: 'transparent',
    border: 'none',
    color: 'var(--color-text-primary)',
    fontSize: 'var(--font-size-xs)',
    cursor: 'pointer',
    borderRadius: 'var(--radius-sm)',
    textAlign: 'left',
};
