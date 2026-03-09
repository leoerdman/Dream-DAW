import React from 'react';
import { useAssetBrowserLogic } from './model/useAssetBrowserLogic';
import { AssetSearchInput } from './ui/AssetBrowserVirtualFileList';
import { AssetBrowserSidebar } from './ui/AssetBrowserSidebar';
import { AssetBrowserMainPane } from './ui/AssetBrowserMainPane';
import { AssetBrowserOverlays } from './ui/AssetBrowserOverlays';

export const AssetBrowser = () => {
    const logic = useAssetBrowserLogic();
    const {
        debouncedQuery,
        setDebouncedQuery,
        searchRef,
        handleBrowserKeyDown,
        splitRootRef,
        leftPaneWidth,
        categories,
        collapsedSections,
        selectedCategoryId,
        toggleSection,
        handleAddFolder,
        setSelectedCategoryId,
        fileListRef,
        handleRemoveFolder,
        triggerLibraryScan,
        triggerPluginScan,
        setCollectionLabels,
        saveCollectionLabels,
        beginSplitResize,
        columnMenuPos,
        columnMenuRef,
        toggleSizeColumn,
        toggleTypeColumn,
        showSizeColumn,
        showTypeColumn,
        contextMenu,
        contextMenuRef,
        collectionItems,
        collectionLabels,
        saveCollections,
        setCollectionItems,
        setContextMenu,
    } = logic;

    return (
        <div data-testid="asset-browser" style={rootStyle}>
            <div style={searchBarWrapStyle}>
                <AssetSearchInput
                    debouncedQuery={debouncedQuery}
                    setDebouncedQuery={setDebouncedQuery}
                    searchRef={searchRef}
                    handleBrowserKeyDown={handleBrowserKeyDown}
                />
            </div>

            <div style={splitLayoutStyle} ref={splitRootRef}>
                <div style={{ ...leftPaneWrapStyle, width: leftPaneWidth }}>
                    <AssetBrowserSidebar
                        categories={categories}
                        collapsedSections={collapsedSections}
                        selectedCategoryId={selectedCategoryId}
                        toggleSection={toggleSection}
                        handleAddFolder={handleAddFolder}
                        setSelectedCategoryId={setSelectedCategoryId}
                        fileListRef={fileListRef}
                        handleRemoveFolder={handleRemoveFolder}
                        setCollectionLabels={setCollectionLabels}
                        saveCollectionLabels={saveCollectionLabels}
                        onReselectCategory={(categoryId) => {
                            if (categoryId === 'all') {
                                triggerLibraryScan();
                                triggerPluginScan();
                            }
                        }}
                    />
                </div>
                <div onPointerDown={beginSplitResize} style={splitHandleStyle} />
                <AssetBrowserMainPane logic={logic} />
            </div>

            <AssetBrowserOverlays
                columnMenuPos={columnMenuPos}
                columnMenuRef={columnMenuRef}
                toggleSizeColumn={toggleSizeColumn}
                toggleTypeColumn={toggleTypeColumn}
                showSizeColumn={showSizeColumn}
                showTypeColumn={showTypeColumn}
                contextMenu={contextMenu}
                contextMenuRef={contextMenuRef}
                collectionItems={collectionItems}
                selectedCategoryId={selectedCategoryId}
                saveCollections={saveCollections}
                setCollectionItems={setCollectionItems}
                setContextMenu={setContextMenu}
                collectionLabels={collectionLabels}
            />
        </div>
    );
};

const rootStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--color-bg-panel)',
    fontSize: 'var(--font-size-xs)',
};

const searchBarWrapStyle: React.CSSProperties = {
    padding: 'var(--space-1-5) var(--space-2)',
    borderBottom: 'var(--space-px) solid var(--color-divider)',
    background: 'var(--color-bg-header)',
};

const splitLayoutStyle: React.CSSProperties = {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    overflow: 'hidden',
};

const leftPaneWrapStyle: React.CSSProperties = {
    minWidth: 88,
    flexShrink: 0,
    borderRight: 'var(--space-px) solid var(--color-divider)',
};

const splitHandleStyle: React.CSSProperties = {
    width: 'var(--daw-resize-handle-size)',
    cursor: 'ew-resize',
    background: 'var(--daw-resize-strip-bg)',
    flexShrink: 0,
};
