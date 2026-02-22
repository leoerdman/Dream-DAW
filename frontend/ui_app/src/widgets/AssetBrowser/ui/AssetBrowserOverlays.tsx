import React from 'react';
import {
    COLLECTION_ICONS,
    COLLECTION_IDS,
    COLLECTION_LABELS_DEFAULT,
} from '../model/assetBrowserUtils';
import type { AssetBrowserLogic } from '../model/assetBrowserTypes';

export function AssetBrowserOverlays({ logic }: { logic: AssetBrowserLogic }) {
    return (
        <>
            {logic.columnMenuPos && (
                <div
                    ref={logic.columnMenuRef}
                    style={columnMenuContainerStyle(logic.columnMenuPos.x, logic.columnMenuPos.y)}
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
            )}

            {logic.contextMenu && logic.contextMenu.item.path && (
                <div
                    ref={logic.contextMenuRef}
                    onClick={(e) => e.stopPropagation()}
                    style={contextMenuStyle(logic.contextMenu.x, logic.contextMenu.y)}
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
                                style={contextMenuItemStyle}
                                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-hover)'; }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                            >
                                <span>{COLLECTION_ICONS[collId]}</span>
                                <span>
                                    {isInCollection
                                        ? (isInCollectionView ? `Remove from ${COLLECTION_LABELS_DEFAULT[collId]}` : `✓ In ${COLLECTION_LABELS_DEFAULT[collId]}`)
                                        : `Add to ${COLLECTION_LABELS_DEFAULT[collId]}`}
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}
        </>
    );
}

const columnMenuContainerStyle = (x: number, y: number): React.CSSProperties => ({
    position: 'fixed',
    left: Math.max(8, x - 140),
    top: Math.max(8, y),
    width: 150,
    background: 'var(--surface-2)',
    border: '1px solid var(--color-border-subtle)',
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
    padding: '5px 6px',
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
    border: '1px solid var(--color-divider)',
    borderRadius: 'var(--radius-md)',
    padding: 4,
    zIndex: 'var(--z-drag-overlay)' as unknown as number,
    minWidth: 180,
    boxShadow: '0 8px 24px var(--color-overlay-dark)',
});

const contextMenuItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '6px 10px',
    background: 'transparent',
    border: 'none',
    color: 'var(--color-text-primary)',
    fontSize: 'var(--font-size-xs)',
    cursor: 'pointer',
    borderRadius: 'var(--radius-sm)',
    textAlign: 'left',
};

