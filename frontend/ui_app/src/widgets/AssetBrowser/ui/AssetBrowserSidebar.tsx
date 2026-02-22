import React from 'react';
import { BrowserGlyph } from './AssetBrowserPrimitives';
import type { AssetBrowserLogic } from '../model/assetBrowserTypes';

export function AssetBrowserSidebar({ logic }: { logic: AssetBrowserLogic }) {
    let currentSection: string | null = null;
    return (
        <div className="scrollbar-hide" style={sidebarStyle}>
            {logic.categories.map((cat) => {
                if (cat.kind === 'section') {
                    const collapsed = cat.id === 'sec-collections' ? false : logic.collapsedSections.has(cat.id);
                    currentSection = cat.id;
                    const addTopGap = cat.id === 'sec-library' || cat.id === 'sec-folders';
                    const isBrowserSection = cat.id === 'sec-collections';
                    return (
                        <div key={cat.id} style={{ marginTop: addTopGap ? 10 : 0 }}>
                            <button onClick={isBrowserSection ? undefined : () => logic.toggleSection(cat.id)} style={{ ...sectionButtonStyle, cursor: isBrowserSection ? 'default' : 'pointer' }}>
                                <span style={sectionIconCellStyle}><BrowserGlyph name={cat.icon} size={11} /></span>
                                <span style={sectionTitleStyle}>{cat.title}</span>
                                {!isBrowserSection && (
                                    <svg width="9" height="9" viewBox="0 0 9 9" style={{ flexShrink: 0, opacity: 0.78 }} aria-hidden>
                                        <polyline points={collapsed ? '2,1 6,4.5 2,8' : '1,2 4.5,6 8,2'} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                )}
                            </button>
                        </div>
                    );
                }

                const parentSectionId = currentSection;
                if (parentSectionId && logic.collapsedSections.has(parentSectionId)) return null;
                const isSelected = logic.selectedCategoryId === cat.id;

                if (cat.id === 'addFolder') {
                    return (
                        <button key={cat.id} onClick={logic.handleAddFolder} style={addFolderButtonStyle}>
                            <span style={sectionIconCellStyle}><BrowserGlyph name={cat.icon} size={12} /></span>
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
                            if (cat.folderPath && confirm(`Remove "${cat.title}" from browser?`)) logic.handleRemoveFolder(cat.folderPath);
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
                        style={{ ...categoryButtonStyle, background: isSelected ? 'var(--color-bg-selected)' : 'transparent', fontWeight: isSelected ? 600 : 500 }}
                    >
                        <span style={categoryIconStyle}>
                            {cat.markerColor ? <span style={markerDotStyle(cat.markerColor)} /> : <BrowserGlyph name={cat.icon} size={12} />}
                        </span>
                        <span style={categoryLabelStyle}>{cat.title}</span>
                    </button>
                );
            })}
        </div>
    );
}

const sidebarStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    overflowY: 'auto',
    borderRight: '1px solid var(--color-divider)',
    background: 'var(--color-bg-panel)',
};

const sectionButtonStyle: React.CSSProperties = {
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
    opacity: 0.9,
};

const sectionIconCellStyle: React.CSSProperties = {
    width: 14,
    display: 'inline-flex',
    justifyContent: 'center',
    flexShrink: 0,
};

const sectionTitleStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    textAlign: 'left',
};

const addFolderButtonStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    width: '100%',
    padding: '2px 4px 2px 12px',
    background: 'transparent',
    border: 'none',
    color: '#ffffff',
    fontSize: 'var(--font-size-base)',
    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
    textAlign: 'left',
    cursor: 'pointer',
    transition: 'background var(--transition-fast)',
    lineHeight: 1.9,
    opacity: 0.95,
};

const categoryButtonStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    width: '100%',
    padding: '2px 4px 2px 12px',
    border: 'none',
    color: '#ffffff',
    fontSize: 'var(--font-size-base)',
    textAlign: 'left',
    cursor: 'pointer',
    transition: 'background var(--transition-fast)',
    lineHeight: 1.9,
};

const categoryIconStyle: React.CSSProperties = {
    width: 14,
    display: 'inline-flex',
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
    color: '#ffffff',
};

const categoryLabelStyle: React.CSSProperties = {
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
};

const markerDotStyle = (markerColor: string): React.CSSProperties => ({
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: markerColor,
    boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.28)',
});
