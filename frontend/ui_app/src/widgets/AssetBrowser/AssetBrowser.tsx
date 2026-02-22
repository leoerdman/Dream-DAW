import React from 'react';
import { useAssetBrowserLogic } from './model/useAssetBrowserLogic';
import { AssetSearchInput } from './ui/AssetBrowserVirtualFileList';
import { AssetBrowserSidebar } from './ui/AssetBrowserSidebar';
import { AssetBrowserMainPane } from './ui/AssetBrowserMainPane';
import { AssetBrowserOverlays } from './ui/AssetBrowserOverlays';

export const AssetBrowser = () => {
    const logic = useAssetBrowserLogic();

    return (
        <div data-testid="asset-browser" style={rootStyle}>
            <div style={searchBarWrapStyle}>
                <AssetSearchInput
                    debouncedQuery={logic.debouncedQuery}
                    setDebouncedQuery={logic.setDebouncedQuery}
                    searchRef={logic.searchRef}
                    handleBrowserKeyDown={logic.handleBrowserKeyDown}
                />
            </div>

            <div style={splitLayoutStyle} ref={logic.splitRootRef}>
                <div style={{ ...leftPaneWrapStyle, width: logic.leftPaneWidth }}>
                    <AssetBrowserSidebar logic={logic} />
                </div>
                <div onMouseDown={logic.beginSplitResize} style={splitHandleStyle} />
                <AssetBrowserMainPane logic={logic} />
            </div>

            <AssetBrowserOverlays logic={logic} />
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
    padding: '6px 8px',
    borderBottom: '1px solid var(--color-divider)',
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
};

const splitHandleStyle: React.CSSProperties = {
    width: 6,
    cursor: 'ew-resize',
    background: 'transparent',
    flexShrink: 0,
};

