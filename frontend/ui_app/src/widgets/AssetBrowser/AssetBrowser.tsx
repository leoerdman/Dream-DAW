import React from 'react';
import {
    BrowserGlyph,
    FilterPill,
    PreviewWaveform,
} from './ui/AssetBrowserPrimitives';
import {
    COLLECTION_ICONS,
    COLLECTION_IDS,
    COLLECTION_LABELS_DEFAULT,
} from './model/assetBrowserUtils';
import {
    useAssetBrowserLogic,
    INTERNAL_INSTRUMENT_ITEMS,
    INTERNAL_EFFECT_ITEMS,
    SOURCE_FILTERS,
    FORMAT_FILTERS,
    AUDIO_FILTERS,
    SORT_FILTERS,
    SIZE_FILTERS,
} from './model/useAssetBrowserLogic';
import { AssetSearchInput, VirtualFileList } from './ui/AssetBrowserVirtualFileList';

// ── File type helpers ───────────────────────────────────

export const AssetBrowser = () => {
    const logic = useAssetBrowserLogic();

    // Track current section for collapse logic
    let currentSection: string | null = null;

    return (
        <div data-testid="asset-browser" style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            background: 'var(--color-bg-panel)',
            fontSize: 'var(--font-size-xs)',
        }}>

            {/* ── Search ────────── */}
            <div style={{
                padding: '6px 8px',
                borderBottom: '1px solid var(--color-divider)',
                background: 'var(--color-bg-header)',
            }}>
                <AssetSearchInput
                    debouncedQuery={logic.debouncedQuery}
                    setDebouncedQuery={logic.setDebouncedQuery}
                    searchRef={logic.searchRef}
                    handleBrowserKeyDown={logic.handleBrowserKeyDown}
                />
            </div>

            {/* ══════════════════════════════════════════════
                TWO-PANE VERTICAL SPLIT (Ableton-style)
               ══════════════════════════════════════════════ */}
            <div style={{
                flex: 1,
                minHeight: 0,
                display: 'flex',
                overflow: 'hidden',
            }} ref={logic.splitRootRef}>
                {/* ── LEFT PANE: Category Tree ── */}
                <div
                    className="scrollbar-hide"
                    style={{
                        width: logic.leftPaneWidth,
                        minWidth: 88,
                        flexShrink: 0,
                        overflowY: 'auto',
                        borderRight: '1px solid var(--color-divider)',
                        background: 'var(--color-bg-panel)',
                    }}
                >
                    {logic.categories.map(cat => {
                        // Section header
                        if (cat.kind === 'section') {
                            const collapsed = cat.id === 'sec-collections' ? false : logic.collapsedSections.has(cat.id);
                            currentSection = cat.id;
                            const addTopGap = cat.id === 'sec-library' || cat.id === 'sec-folders';
                            const isBrowserSection = cat.id === 'sec-collections';
                            return (
                                <div key={cat.id} style={{ marginTop: addTopGap ? 10 : 0 }}>
                                    <button
                                        onClick={isBrowserSection ? undefined : () => logic.toggleSection(cat.id)}
                                        style={{
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
                                            cursor: isBrowserSection ? 'default' : 'pointer',
                                            opacity: 0.9,
                                        }}
                                    >
                                        <span style={{ width: 14, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
                                            <BrowserGlyph name={cat.icon} size={11} />
                                        </span>
                                        <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                                            {cat.title}
                                        </span>
                                        {!isBrowserSection && (
                                            <svg width="9" height="9" viewBox="0 0 9 9" style={{ flexShrink: 0, opacity: 0.78 }} aria-hidden>
                                                <polyline
                                                    points={collapsed ? '2,1 6,4.5 2,8' : '1,2 4.5,6 8,2'}
                                                    fill="none" stroke="currentColor" strokeWidth="1.4"
                                                    strokeLinecap="round" strokeLinejoin="round"
                                                />
                                            </svg>
                                        )}
                                    </button>
                                </div>
                            );
                        }

                        // Leaf item — hidden if parent section collapsed
                        const parentSectionId = currentSection;
                        if (parentSectionId && logic.collapsedSections.has(parentSectionId)) return null;
                        const isSelected = logic.selectedCategoryId === cat.id;

                        // Special: Add Folder button
                        if (cat.id === 'addFolder') {
                            return (
                                <button key={cat.id} onClick={logic.handleAddFolder}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: 4,
                                        width: '100%', padding: '2px 4px 2px 12px',
                                        background: 'transparent', border: 'none', color: '#ffffff',
                                        fontSize: 'var(--font-size-base)',
                                        fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                                        textAlign: 'left', cursor: 'pointer',
                                        transition: 'background var(--transition-fast)',
                                        lineHeight: 1.9, opacity: 0.95,
                                    }}
                                >
                                    <span style={{ width: 14, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
                                        <BrowserGlyph name={cat.icon} size={12} />
                                    </span>
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
                                    if (cat.folderPath && confirm(`Remove "${cat.title}" from browser?`)) {
                                        logic.handleRemoveFolder(cat.folderPath);
                                    }
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
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 4,
                                    width: '100%', padding: '2px 4px 2px 12px',
                                    background: isSelected ? 'var(--color-bg-selected)' : 'transparent',
                                    border: 'none', color: '#ffffff',
                                    fontSize: 'var(--font-size-base)',
                                    fontWeight: isSelected ? 600 : 500,
                                    textAlign: 'left', cursor: 'pointer',
                                    transition: 'background var(--transition-fast)',
                                    lineHeight: 1.9,
                                }}
                            >
                                <span style={{ width: 14, display: 'inline-flex', justifyContent: 'center', alignItems: 'center', flexShrink: 0, color: '#ffffff' }}>
                                    {cat.markerColor ? (
                                        <span style={{
                                            width: 7, height: 7, borderRadius: '50%',
                                            background: cat.markerColor,
                                            boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.28)',
                                        }} />
                                    ) : (
                                        <BrowserGlyph name={cat.icon} size={12} />
                                    )}
                                </span>
                                <span style={{
                                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                }}>{cat.title}</span>
                            </button>
                        );
                    })}
                </div>
                <div
                    onMouseDown={logic.beginSplitResize}
                    style={{ width: 6, cursor: 'ew-resize', background: 'transparent', flexShrink: 0 }}
                />

                {/* ── RIGHT PANE: Filters + File List ── */}
                <div style={{
                    flex: 1, minHeight: 0, minWidth: 0,
                    display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto',
                    overflow: 'hidden', background: 'var(--color-bg-secondary)',
                }}>
                    {/* ── ROW 1: Filters Toolbar ── */}
                    <div style={{
                        gridRow: 1, display: 'flex', flexWrap: 'wrap', gap: 4,
                        padding: '4px 6px', borderBottom: '1px solid var(--color-divider)',
                        background: 'var(--color-bg-header)',
                    }}>
                        {logic.selectedCategoryId === 'plugins' ? (
                            <>
                                <FilterPill
                                    options={[
                                        'Source: All', 'Source: Internal', 'Source: VST3',
                                        'Source: VST2', 'Source: AU', 'Source: External',
                                    ]}
                                    value={{ all: 0, internal: 1, vst3: 2, vst2: 3, au: 4, external: 5 }[logic.pluginSourceFilter]}
                                    onChange={(idx) => {
                                        const next = (['all', 'internal', 'vst3', 'vst2', 'au', 'external'] as const)[idx] ?? 'all';
                                        logic.setPluginSourceFilter(next);
                                    }}
                                />
                                <button onClick={logic.triggerPluginScan} style={pluginActionButtonStyle} title="Rescan installed plugins">
                                    Rescan
                                </button>
                                <button onClick={() => { void logic.handleSetPluginFolder('vst2Path'); }} style={pluginActionButtonStyle} title="Select VST2 folder">
                                    Import VST2 Folder
                                </button>
                                <button onClick={() => { void logic.handleSetPluginFolder('vst3Path'); }} style={pluginActionButtonStyle} title="Select VST3 folder">
                                    Import VST3 Folder
                                </button>
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
                        <div style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '2px 8px', borderBottom: '1px solid var(--color-divider-light)',
                            background: 'var(--color-bg-header)',
                            fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-tertiary)',
                            fontFamily: 'var(--font-mono)',
                        }}>
                            <span>INT: {INTERNAL_INSTRUMENT_ITEMS.length + INTERNAL_EFFECT_ITEMS.length}</span>
                            <span>EXT: {logic.pluginBrowserItems.length}</span>
                            <span style={{ opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                VST2: {logic.settings.vst2Path || 'not set'}
                            </span>
                            <span style={{ opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                VST3: {logic.settings.vst3Path || 'not set'}
                            </span>
                        </div>
                    )}

                    {/* ── ROW 2: Virtual Scroll List ── */}
                    <div style={{
                        gridRow: 2, minHeight: 0, overflow: 'hidden',
                        display: 'flex', flexDirection: 'column',
                    }}>
                        {/* Plugin Search Alphabet Anchors */}
                        {logic.selectedCategoryId === 'plugins' && logic.pluginLetterAnchors.letters.length > 0 && (
                            <div className="scrollbar-hide" style={{
                                flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2,
                                padding: '4px 8px', overflowX: 'auto',
                                borderBottom: '1px solid var(--color-divider-light)',
                                background: 'color-mix(in srgb, var(--color-bg-header) 95%, transparent)',
                            }}>
                                {logic.pluginLetterAnchors.letters.map((letter) => (
                                    <button
                                        key={letter}
                                        onClick={() => {
                                            logic.jumpToPluginLetter(letter);
                                            logic.focusResults();
                                        }}
                                        style={{
                                            minWidth: 18, height: 16,
                                            borderRadius: 'var(--radius-md)',
                                            border: '1px solid var(--color-divider)',
                                            background: logic.selectedPluginLetter === letter
                                                ? 'var(--color-control-bg-active)' : 'var(--color-control-bg)',
                                            color: logic.selectedPluginLetter === letter
                                                ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                                            fontSize: 'var(--font-size-2xs)',
                                            fontWeight: 'var(--font-weight-bold)' as unknown as number,
                                            fontFamily: 'var(--font-mono)',
                                            cursor: 'pointer', padding: 0, flexShrink: 0,
                                        }}
                                        title={`Jump to ${letter}`}
                                    >
                                        {letter}
                                    </button>
                                ))}
                            </div>
                        )}

                        {/* File List */}
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
                            audioDurationSecRef={logic.audioDurationSecRef}
                            itemRowRefs={logic.itemRowRefs}
                            fileListRef={logic.fileListRef}
                            handleBrowserKeyDown={logic.handleBrowserKeyDown}
                            pluginGroupedRows={logic.pluginGroupedRows}
                            scanLoading={logic.scanLoading}
                            scanError={logic.scanError}
                            columnMenuPos={logic.columnMenuPos}
                            setColumnMenuPos={logic.setColumnMenuPos}
                        />
                    </div>

                    {/* ── ROW 3: Footer Preview Panel ────────── */}
                    <div style={{
                        gridRow: 3, flexShrink: 0,
                        borderTop: '2px solid var(--color-divider)',
                        background: 'var(--color-bg-secondary)',
                        position: 'relative', zIndex: 10,
                    }}>
                        <div style={{
                            display: 'flex', alignItems: 'center', padding: '4px 8px',
                            gap: 5, fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)',
                        }}>
                            <div style={{
                                flex: 1, minWidth: 0, height: 16,
                                borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--color-border-subtle)',
                                background: 'color-mix(in srgb, #000 18%, transparent)',
                                overflow: 'hidden', display: 'flex', alignItems: 'center', padding: '0 4px',
                            }}>
                                {logic.previewPeaks ? (
                                    <PreviewWaveform peaks={logic.previewPeaks} height={12} />
                                ) : (
                                    <div style={{
                                        width: '100%', height: 8,
                                        borderRadius: 'var(--radius-xs)',
                                        background: 'color-mix(in srgb, var(--color-text-primary) 4%, transparent)',
                                    }} />
                                )}
                            </div>

                            <button
                                onClick={() => {
                                    const next = !logic.previewEnabled;
                                    logic.setPreviewEnabled(next);
                                    if (!next) {
                                        logic.isPreviewPlayingRef.current = false;
                                        logic.engineApi.stopPreview().catch((err) => {
                                            console.warn('[AssetBrowser] stopPreview(toggle) failed:', err);
                                        });
                                        return;
                                    }
                                    const selected = logic.items.find(i => i.id === logic.selectedItemId);
                                    if (selected?.type === 'audio' && selected.path) {
                                        logic.isPreviewPlayingRef.current = true;
                                        logic.engineApi.previewAudioFile(selected.path).catch((err) => {
                                            console.warn('[AssetBrowser] previewAudioFile(toggle) failed:', err);
                                        });
                                    }
                                }}
                                title={logic.previewEnabled ? 'Preview on' : 'Preview off'}
                                style={{
                                    width: 16, height: 16, minWidth: 16,
                                    borderRadius: '50%',
                                    border: '1px solid var(--color-border-subtle)',
                                    background: logic.previewEnabled ? 'var(--color-control-bg-active)' : 'var(--color-control-bg)',
                                    color: logic.previewEnabled ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                                    cursor: 'pointer', display: 'inline-flex',
                                    alignItems: 'center', justifyContent: 'center',
                                    fontSize: 'var(--font-size-2xs)',
                                }}
                                aria-pressed={logic.previewEnabled}
                            >
                                <BrowserGlyph name="headphones" size={9} />
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {
                logic.columnMenuPos && (
                    <div
                        ref={logic.columnMenuRef}
                        style={{
                            position: 'fixed',
                            left: Math.max(8, logic.columnMenuPos.x - 140),
                            top: Math.max(8, logic.columnMenuPos.y),
                            width: 150,
                            background: 'var(--surface-2)',
                            border: '1px solid var(--color-border-subtle)',
                            borderRadius: 'var(--radius-xl)',
                            boxShadow: 'var(--shadow-panel)',
                            padding: 6,
                            zIndex: 'var(--z-drag-overlay)' as unknown as number,
                        }}
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
                )
            }

            {/* ── Context Menu for Collections ────────── */}
            {
                logic.contextMenu && logic.contextMenu.item.path && (
                    <div
                        ref={logic.contextMenuRef}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            position: 'fixed',
                            left: Math.min(logic.contextMenu.x, window.innerWidth - 200),
                            top: Math.min(logic.contextMenu.y, window.innerHeight - 180),
                            background: 'var(--color-bg-elevated)',
                            border: '1px solid var(--color-divider)',
                            borderRadius: 'var(--radius-md)',
                            padding: 4,
                            zIndex: 'var(--z-drag-overlay)' as unknown as number,
                            minWidth: 180,
                            boxShadow: '0 8px 24px var(--color-overlay-dark)',
                        }}
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
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: 8,
                                        width: '100%', padding: '6px 10px',
                                        background: 'transparent', border: 'none',
                                        color: 'var(--color-text-primary)',
                                        fontSize: 'var(--font-size-xs)',
                                        cursor: 'pointer', borderRadius: 'var(--radius-sm)',
                                        textAlign: 'left',
                                    }}
                                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-hover)'; }}
                                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                                >
                                    <span>{COLLECTION_ICONS[collId]}</span>
                                    <span>{isInCollection
                                        ? (isInCollectionView ? `Remove from ${COLLECTION_LABELS_DEFAULT[collId]}` : `✓ In ${COLLECTION_LABELS_DEFAULT[collId]}`)
                                        : `Add to ${COLLECTION_LABELS_DEFAULT[collId]}`
                                    }</span>
                                </button>
                            );
                        })}
                    </div>
                )
            }

        </div >
    );
};

// ── Style constants ─────────────────────────────────────

const columnMenuItemStyle: React.CSSProperties = {
    width: '100%', background: 'transparent', border: 'none',
    color: 'var(--color-text-primary)', padding: '5px 6px',
    borderRadius: 'var(--radius-md)', display: 'flex',
    alignItems: 'center', gap: 6, fontSize: 'var(--font-size-sm)',
    textAlign: 'left', cursor: 'pointer',
};

const columnMenuCheckStyle: React.CSSProperties = {
    width: 12, textAlign: 'center',
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-accent-primary)',
};

const pluginActionButtonStyle: React.CSSProperties = {
    background: 'var(--color-control-bg)',
    color: 'var(--color-text-secondary)',
    border: '1px solid var(--color-divider)',
    borderRadius: 'var(--radius-xs)',
    padding: '3px 7px',
    fontSize: 'var(--font-size-xs)',
    cursor: 'pointer',
    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
    whiteSpace: 'nowrap',
};
