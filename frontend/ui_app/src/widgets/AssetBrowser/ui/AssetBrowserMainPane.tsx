import React from 'react';
import {
    BrowserGlyph,
    FilterPill,
    PreviewWaveform,
} from './AssetBrowserPrimitives';
import { VirtualFileList } from './AssetBrowserVirtualFileList';
import {
    INTERNAL_EFFECT_ITEMS,
    INTERNAL_INSTRUMENT_ITEMS,
    SOURCE_FILTERS,
    FORMAT_FILTERS,
    AUDIO_FILTERS,
    SORT_FILTERS,
    SIZE_FILTERS,
} from '../model/useAssetBrowserLogic';
import type { AssetBrowserLogic } from '../model/assetBrowserTypes';

export function AssetBrowserMainPane({ logic }: { logic: AssetBrowserLogic }) {
    return (
        <div style={mainPaneStyle}>
            <div style={filtersToolbarStyle}>
                {logic.selectedCategoryId === 'plugins' ? (
                    <>
                        <FilterPill
                            options={['Source: All', 'Source: Internal', 'Source: VST3', 'Source: VST2', 'Source: AU', 'Source: External']}
                            value={{ all: 0, internal: 1, vst3: 2, vst2: 3, au: 4, external: 5 }[logic.pluginSourceFilter as 'all' | 'internal' | 'vst3' | 'vst2' | 'au' | 'external']}
                            onChange={(idx) => {
                                const next = (['all', 'internal', 'vst3', 'vst2', 'au', 'external'] as const)[idx] ?? 'all';
                                logic.setPluginSourceFilter(next);
                            }}
                        />
                        <button onClick={logic.triggerPluginScan} style={pluginActionButtonStyle} title="Rescan installed plugins">Rescan</button>
                        <button onClick={() => { void logic.handleSetPluginFolder('vst2Path'); }} style={pluginActionButtonStyle} title="Select VST2 folder">Import VST2 Folder</button>
                        <button onClick={() => { void logic.handleSetPluginFolder('vst3Path'); }} style={pluginActionButtonStyle} title="Select VST3 folder">Import VST3 Folder</button>
                    </>
                ) : (
                    <>
                        <FilterPill options={SOURCE_FILTERS as unknown as string[]} value={logic.sourceFilter} onChange={logic.setSourceFilter} />
                        <FilterPill options={FORMAT_FILTERS as unknown as string[]} value={logic.formatFilter} onChange={logic.setFormatFilter} />
                        <FilterPill options={AUDIO_FILTERS as unknown as string[]} value={logic.audioFilter} onChange={logic.setAudioFilter} />
                    </>
                )}
                <FilterPill options={SORT_FILTERS as unknown as string[]} value={logic.sortFilter} onChange={logic.setSortFilter} />
                <FilterPill options={SIZE_FILTERS as unknown as string[]} value={logic.sizeFilter} onChange={logic.setSizeFilter} />
            </div>

            {logic.selectedCategoryId === 'plugins' && (
                <div style={pluginStatsRowStyle}>
                    <span>INT: {INTERNAL_INSTRUMENT_ITEMS.length + INTERNAL_EFFECT_ITEMS.length}</span>
                    <span>EXT: {logic.pluginBrowserItems.length}</span>
                    <span style={pathStatStyle}>VST2: {logic.settings.vst2Path || 'not set'}</span>
                    <span style={pathStatStyle}>VST3: {logic.settings.vst3Path || 'not set'}</span>
                </div>
            )}

            <div style={listContainerStyle}>
                {logic.selectedCategoryId === 'plugins' && logic.pluginLetterAnchors.letters.length > 0 && (
                    <div className="scrollbar-hide" style={letterAnchorRowStyle}>
                        {logic.pluginLetterAnchors.letters.map((letter) => (
                            <button
                                key={letter}
                                onClick={() => {
                                    logic.jumpToPluginLetter(letter);
                                    logic.focusResults();
                                }}
                                style={{
                                    ...letterAnchorButtonStyle,
                                    background: logic.selectedPluginLetter === letter ? 'var(--color-control-bg-active)' : 'var(--color-control-bg)',
                                    color: logic.selectedPluginLetter === letter ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                                }}
                                title={`Jump to ${letter}`}
                            >
                                {letter}
                            </button>
                        ))}
                    </div>
                )}

                <VirtualFileList
                    items={logic.items}
                    selectedCategoryId={logic.selectedCategoryId}
                    selectedItemId={logic.selectedItemId}
                    setSelectedItemId={logic.setSelectedItemId}
                    syncPreviewForItem={logic.syncPreviewForItem}
                    isPreviewPlayingRef={logic.isPreviewPlayingRef}
                    setContextMenu={logic.setContextMenu}
                    navigateInto={logic.navigateInto}
                    showTypeColumn={logic.showTypeColumn}
                    showSizeColumn={logic.showSizeColumn}
                    debouncedQuery={logic.debouncedQuery}
                    getAudioDurationSec={logic.getAudioDurationSec}
                    setItemRowRef={logic.setItemRowRef}
                    fileListRef={logic.fileListRef}
                    handleBrowserKeyDown={logic.handleBrowserKeyDown}
                    pluginGroupedRows={logic.pluginGroupedRows}
                    scanLoading={logic.scanLoading}
                    scanError={logic.scanError}
                    setColumnMenuPos={logic.setColumnMenuPos}
                />
            </div>

            <div style={previewRootStyle}>
                <div style={previewControlsRowStyle}>
                    <div style={previewWaveContainerStyle}>
                        {logic.previewPeaks ? <PreviewWaveform peaks={logic.previewPeaks} height={12} /> : <div style={previewPlaceholderStyle} />}
                    </div>
                    <button
                        onClick={() => {
                            const next = !logic.previewEnabled;
                            logic.setPreviewEnabled(next);
                            if (!next) {
                                logic.setPreviewPlaying(false);
                                logic.engineApi.stopPreview().catch((err) => {
                                    console.warn('[AssetBrowser] stopPreview(toggle) failed:', err);
                                });
                                return;
                            }
                            const selected = logic.items.find((i) => i.id === logic.selectedItemId);
                            if (selected?.type === 'audio' && selected.path) {
                                logic.setPreviewPlaying(true);
                                logic.engineApi.previewAudioFile(selected.path).catch((err) => {
                                    console.warn('[AssetBrowser] previewAudioFile(toggle) failed:', err);
                                });
                            }
                        }}
                        title={logic.previewEnabled ? 'Preview on' : 'Preview off'}
                        style={{
                            ...previewToggleStyle,
                            background: logic.previewEnabled ? 'var(--color-control-bg-active)' : 'var(--color-control-bg)',
                            color: logic.previewEnabled ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                        }}
                        aria-pressed={logic.previewEnabled}
                    >
                        <BrowserGlyph name="headphones" size={9} />
                    </button>
                </div>
            </div>
        </div>
    );
}

const mainPaneStyle: React.CSSProperties = {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    display: 'grid',
    gridTemplateRows: 'auto minmax(0, 1fr) auto',
    overflow: 'hidden',
    background: 'var(--color-bg-secondary)',
};

const filtersToolbarStyle: React.CSSProperties = {
    gridRow: 1,
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    padding: 'var(--space-1) var(--space-1-5)',
    background: 'var(--color-bg-header)',
};

const pluginActionButtonStyle: React.CSSProperties = {
    background: 'var(--color-control-bg)',
    color: 'var(--color-text-secondary)',
    border: 'var(--space-px) solid var(--color-divider)',
    borderRadius: 'var(--radius-xs)',
    padding: 'var(--token-size-px-3) var(--token-size-px-7)',
    fontSize: 'var(--font-size-xs)',
    cursor: 'pointer',
    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
    whiteSpace: 'nowrap',
};

const pluginStatsRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: 'var(--space-0-5) var(--space-2)',
    borderBottom: 'var(--space-px) solid var(--color-divider-light)',
    background: 'var(--color-bg-header)',
    fontSize: 'var(--font-size-2xs)',
    color: 'var(--color-text-tertiary)',
    fontFamily: 'var(--font-role-data)',
};

const pathStatStyle: React.CSSProperties = {
    opacity: 0.7,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
};

const listContainerStyle: React.CSSProperties = {
    gridRow: 2,
    minHeight: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
};

const letterAnchorRowStyle: React.CSSProperties = {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    padding: 'var(--space-1) var(--space-2)',
    overflowX: 'auto',
    borderBottom: 'var(--space-px) solid var(--color-divider-light)',
    background: 'color-mix(in srgb, var(--color-bg-header) 95%, transparent)',
};

const letterAnchorButtonStyle: React.CSSProperties = {
    minWidth: 18,
    height: 16,
    borderRadius: 'var(--radius-md)',
    border: 'var(--space-px) solid var(--color-divider)',
    fontSize: 'var(--font-size-2xs)',
    fontWeight: 'var(--font-weight-bold)' as unknown as number,
    fontFamily: 'var(--font-role-data)',
    cursor: 'pointer',
    padding: 0,
    flexShrink: 0,
};

const previewRootStyle: React.CSSProperties = {
    gridRow: 3,
    flexShrink: 0,
    borderTop: 'var(--space-0-5) solid var(--color-divider)',
    background: 'var(--color-bg-secondary)',
    position: 'relative',
    zIndex: 10,
};

const previewControlsRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    padding: 'var(--space-1) var(--space-2)',
    gap: 5,
    fontSize: 'var(--font-size-2xs)',
    color: 'var(--color-text-secondary)',
};

const previewWaveContainerStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    height: 16,
    borderRadius: 'var(--radius-md)',
    border: 'var(--space-px) solid var(--color-border-subtle)',
    background: 'color-mix(in srgb, var(--token-color-hex-000000) 18%, transparent)',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    padding: '0 var(--space-1)',
};

const previewPlaceholderStyle: React.CSSProperties = {
    width: '100%',
    height: 8,
    borderRadius: 'var(--radius-xs)',
    background: 'color-mix(in srgb, var(--color-text-primary) 4%, transparent)',
};

const previewToggleStyle: React.CSSProperties = {
    width: 16,
    height: 16,
    minWidth: 16,
    borderRadius: '50%',
    border: 'var(--space-px) solid var(--color-border-subtle)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 'var(--font-size-2xs)',
};
