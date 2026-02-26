import React, { memo, useMemo } from 'react';
import { BrowserGlyph } from './AssetBrowserPrimitives';
import type { BrowserCategory } from '../model/useAssetBrowserLogic';

interface AssetBrowserSidebarProps {
    categories: BrowserCategory[];
    collapsedSections: Set<string>;
    selectedCategoryId: string;
    toggleSection: (sectionId: string) => void;
    handleAddFolder: () => void;
    setSelectedCategoryId: (categoryId: string) => void;
    fileListRef: React.RefObject<HTMLDivElement | null>;
    handleRemoveFolder: (folderPath: string) => void;
    setCollectionLabels: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    saveCollectionLabels: (labels: Record<string, string>) => void;
    onReselectCategory?: (categoryId: string) => void;
}

// BUG-39 FIX: wrapped in memo
export const AssetBrowserSidebar = memo(function AssetBrowserSidebar({
    categories,
    collapsedSections,
    selectedCategoryId,
    toggleSection,
    handleAddFolder,
    setSelectedCategoryId,
    fileListRef,
    handleRemoveFolder,
    setCollectionLabels,
    saveCollectionLabels,
    onReselectCategory,
}: AssetBrowserSidebarProps) {
    // BUG-98 FIX: memoize section map
    const parentSectionByCategory = useMemo(() => {
        const map = new Map<string, string | null>();
        let activeSection: string | null = null;
        for (const category of categories) {
            if (category.kind === 'section') {
                activeSection = category.id;
            } else {
                map.set(category.id, activeSection);
            }
        }
        return map;
    }, [categories]);

    return (
        <div style={sidebarStyle}>
            {categories.map((cat) => {
                if (cat.kind === 'section') {
                    const collapsed = cat.id === 'sec-collections' ? false : collapsedSections.has(cat.id);
                    const addTopGap = cat.id === 'sec-library' || cat.id === 'sec-folders';
                    const isBrowserSection = cat.id === 'sec-collections';
                    return (
                        <div key={cat.id} style={{ marginTop: addTopGap ? 10 : 0 }}>
                            <button onClick={isBrowserSection ? undefined : () => toggleSection(cat.id)} style={{ ...sectionButtonStyle, cursor: isBrowserSection ? 'default' : 'pointer' }}>
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

                const parentSectionId = parentSectionByCategory.get(cat.id);
                if (parentSectionId && collapsedSections.has(parentSectionId)) return null;
                const isSelected = selectedCategoryId === cat.id;

                if (cat.id === 'addFolder') {
                    return (
                        <button key={cat.id} onClick={handleAddFolder} style={addFolderButtonStyle}>
                            <span style={sectionIconCellStyle}><BrowserGlyph name={cat.icon} size={12} /></span>
                            <span>{cat.title}</span>
                        </button>
                    );
                }

                return (
                    <button
                        key={cat.id}
                        onClick={() => {
                            if (isSelected) {
                                onReselectCategory?.(cat.id);
                            } else {
                                setSelectedCategoryId(cat.id);
                            }
                            if (fileListRef.current) fileListRef.current.scrollTop = 0;
                        }}
                        onContextMenu={cat.removable ? (e) => {
                            e.preventDefault();
                            if (cat.folderPath && confirm(`Remove "${cat.title}" from browser?`)) handleRemoveFolder(cat.folderPath);
                        } : (cat.id.startsWith('collection-') ? (e) => {
                            e.preventDefault();
                            const next = window.prompt('Rename collection', cat.title)?.trim();
                            if (!next) return;
                            setCollectionLabels((prev) => {
                                const next2 = { ...prev, [cat.id]: next };
                                saveCollectionLabels(next2);
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
});

const sidebarStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    overflowY: 'auto',
    borderRight: 'var(--space-px) solid var(--color-divider)',
    background: 'var(--color-bg-panel)',
};

const sectionButtonStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    width: '100%',
    padding: 'var(--token-size-px-3) var(--space-1-5) var(--token-size-px-3) var(--space-3)',
    background: 'none',
    border: 'none',
    color: 'var(--color-text-primary)',
    fontSize: 'var(--font-size-sm)',
    fontWeight: 'var(--font-weight-bold)',
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
    padding: 'var(--space-0-5) var(--space-1) var(--space-0-5) var(--space-3)',
    background: 'transparent',
    border: 'none',
    color: 'var(--color-text-primary)',
    fontSize: 'var(--font-size-base)',
    fontWeight: 'var(--font-weight-semibold)',
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
    padding: 'var(--space-0-5) var(--space-1) var(--space-0-5) var(--space-3)',
    border: 'none',
    color: 'var(--color-text-primary)',
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
    color: 'var(--color-text-primary)',
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
    boxShadow: '0 0 0 var(--space-px) var(--token-color-rgba-0-0-0-0d28)',
});
