import type { TrackData } from '@/widgets/TrackInspector/model/trackModels';
import { ContextMenuPopup } from '@/widgets/TrackInspector/ui/ContextMenuPopup';
import { ColorPickerPopup } from '@/widgets/TrackInspector/ui/ColorPickerPopup';
import { TrackRow } from '@/widgets/TrackInspector/ui/TrackRow';
import { scrollSync } from '@/shared/lib/useScrollSync';
import * as engineApi from '@/shared/api/engine';
import { useTrackInspectorLogic } from '@/widgets/TrackInspector/model/useTrackInspectorLogic';

// ── BUG-P4 FIX: Debounced project refresh ──────────────────────────────
import { useEngineStore } from '@/shared/stores/useEngineStore';
let _inspectorFetchTimer: ReturnType<typeof setTimeout> | null = null;
const INSPECTOR_FETCH_DEBOUNCE_MS = 100;
function debouncedFetchProject(reason: string) {
    if (_inspectorFetchTimer) clearTimeout(_inspectorFetchTimer);
    _inspectorFetchTimer = setTimeout(
        () => void useEngineStore.getState().fetchProject(reason),
        INSPECTOR_FETCH_DEBOUNCE_MS,
    );
}


/**
 * TrackInspector — Ableton-style track header panel.
 *
 * Layout per track (two rows):
 *   Row 1:  [icon] [Name]         [#] [M/S] [●] |VU|
 *   Row 2:        [→ Master ◊]  [← No Inp ◊]
 *
 *   • Color stripe (8px min) on the left edge
 *   • Vibrant color-mixed backgrounds (30-50% saturation)
 *   • M (Mute) and S (Solo) stacked vertically
 *   • Right-click → context menu: Rename / Change Color / Paint Clips / Delete
 *   • Cmd+R → inline rename
 *   • Add Track button at bottom of scrollable list
 */

// ── Component ──────────────────────────────────────────

interface TrackInspectorProps {
    selectedTrackId: string;
    /** Optional multi-selection (owned by shell). If omitted, TrackInspector manages local multi-select. */
    selectedTrackIds?: string[];
    onSelectTrack: (id: string) => void;
    /** Optional callback to lift multi-selection to shell. */
    onSelectTracks?: (ids: string[], primaryId: string) => void;
    trackHeight?: number;
    rulerHeight?: number;
    // Scroll sync handled by scrollSync singleton — no props needed.
    mixerFocusMode?: boolean;
    /** Controlled collapsed groups (owned by DawShell for Timeline sync). */
    collapsedGroups?: Set<string>;
    /** Callback to toggle a group's collapsed state (owned by DawShell). */
    onToggleGroupCollapse?: (groupId: string) => void;
}

export const TrackInspector = ({
    selectedTrackId,
    selectedTrackIds: selectedTrackIdsProp,
    onSelectTrack,
    onSelectTracks,
    trackHeight = 48,
    rulerHeight = 24,
    mixerFocusMode = false,
    collapsedGroups: collapsedGroupsProp,
    onToggleGroupCollapse: onToggleGroupCollapseProp,
}: TrackInspectorProps) => {
    const logic = useTrackInspectorLogic({
        selectedTrackId,
        selectedTrackIds: selectedTrackIdsProp,
        onSelectTrack,
        onSelectTracks,
        trackHeight,
        rulerHeight,
        mixerFocusMode,
        collapsedGroups: collapsedGroupsProp,
        onToggleGroupCollapse: onToggleGroupCollapseProp,
    });

    let trackNum = 0;

    return (
        <div data-testid="track-inspector" data-keyboard-scope="track-inspector" style={{
            display: 'flex', flexDirection: 'column', height: '100%',
            background: 'var(--color-bg-panel)', fontSize: 'var(--font-size-xs)',
        }}>
            {/* Ruler spacer */}
            <div style={{
                height: rulerHeight, flexShrink: 0,
                background: 'var(--color-bg-header)',
                borderBottom: '1px solid var(--color-divider)',
                display: 'flex', alignItems: 'center', paddingLeft: 8,
            }}>
                <span style={{
                    fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                    color: 'var(--color-text-secondary)',
                    letterSpacing: '0.5px', textTransform: 'uppercase',
                }}>
                    {mixerFocusMode ? 'Mixer' : 'Tracks'}
                </span>
                {mixerFocusMode && (
                    <span style={{
                        marginLeft: 6,
                        fontSize: 'var(--font-size-micro)',
                        fontWeight: 'var(--font-weight-bold)' as unknown as number,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--color-accent-primary)',
                        background: 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--color-accent-primary) 36%, transparent)',
                        borderRadius: 'var(--radius-sm)',
                        padding: '1px 4px',
                    }}>
                        TAB
                    </span>
                )}
            </div>

            {/* Track List */}
            <div
                ref={logic.scrollRef}
                className="scrollbar-hide"
                style={{
                    flex: 1,
                    overflowY: 'auto',
                    overflowX: 'hidden',
                    paddingRight: 2,
                    boxSizing: 'border-box',
                }}
                onScroll={() => {
                    const el = logic.scrollRef.current;
                    if (!el) return;
                    const pos = el.scrollTop;
                    if (logic.lastProgrammaticScrollRef.current !== null
                        && Math.abs(pos - logic.lastProgrammaticScrollRef.current) < 1) {
                        logic.lastProgrammaticScrollRef.current = null;
                        return;
                    }
                    logic.lastProgrammaticScrollRef.current = null;
                    scrollSync.setScrollY(pos, 'inspector');
                }}
                onContextMenu={(e) => {
                    const target = e.target as HTMLElement | null;
                    if (target?.closest?.('[data-track-row="true"]')) return;
                    e.preventDefault();
                    logic.setContextMenu({ trackId: null, trackIndex: null, x: e.clientX, y: e.clientY });
                }}
                onDragOver={(e) => {
                    const activeDragId = logic.draggingTrackIdRef.current ?? logic.draggingTrackId;
                    if (!activeDragId) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(e) => {
                    const activeDragId = logic.draggingTrackIdRef.current ?? logic.draggingTrackId;
                    if (!activeDragId) return;
                    e.preventDefault();
                    const dragId = activeDragId || e.dataTransfer.getData('text/plain');
                    if (!dragId) {
                        logic.resetTrackDragState();
                        return;
                    }
                    if (logic.groupDropTargetId && logic.canDropTrackIntoGroup(dragId, logic.groupDropTargetId)) {
                        logic.commitTrackToGroup(dragId, logic.groupDropTargetId, logic.dropInsertIndex);
                        Promise.resolve().finally(() => {
                            logic.resetTrackDragState();
                        });
                        return;
                    }
                    const targetVisibleIndex = logic.dropInsertIndex ?? logic.visibleTracks.length;
                    logic.commitDraggedTrackToVisibleIndex(dragId, targetVisibleIndex);
                    logic.resetTrackDragState();
                }}
            >
                {logic.dropInsertIndex === 0 && (
                    <div className="track-drop-insert-line" />
                )}
                {logic.visibleTracks.map((track) => {
                    const isGroup = track.type === 'group';
                    if (track.type !== 'master') trackNum++;
                    const displayNum = track.type === 'master' ? undefined : trackNum;
                    const isCollapsed = isGroup ? logic.collapsedGroups.has(track.id) : false;
                    const depth = logic.getDepth(track);
                    const trackIndex = logic.getTrackIndex(track.id);
                    const defaultRowHeight = Math.max(24, Math.min(120, Math.round(Number.isFinite(track.height) ? track.height : trackHeight)));
                    const resolvedRowHeight = track.type === 'master'
                        ? (logic.rowHeightsByTrackId[track.id] ?? trackHeight)
                        : (logic.rowHeightsByTrackId[track.id] ?? defaultRowHeight);

                    const visibleIndex = logic.visibleTrackIndexById.get(track.id) ?? -1;
                    return (
                        <div
                            key={track.id}
                            ref={(el) => { logic.trackRowRefs.current[track.id] = el; }}
                        >
                            <TrackRow
                                track={track}
                                allTracks={logic.tracks}
                                trackHeight={resolvedRowHeight}
                                displayNum={displayNum}
                                isSelected={logic.selectedTrackIdSet.has(track.id)}
                                isPrimarySelected={selectedTrackId === track.id}
                                isCollapsed={isCollapsed}
                                isActive={logic.trackActiveStates[trackIndex] ?? true}
                                depth={depth}
                                isRenaming={logic.renamingTrackId === track.id}
                                renameValue={logic.renameValue}
                                onRenameChange={logic.setRenameValue}
                                onRenameCommit={logic.handleRenameCommit}
                                onRenameCancel={logic.handleRenameCancel}
                                onClick={(e) => {
                                    if (logic.suppressNextClickRef.current) {
                                        logic.suppressNextClickRef.current = false;
                                        e.preventDefault();
                                        return;
                                    }
                                    if (e.shiftKey) {
                                        const anchorId = logic.lastClickedTrackId && logic.lastClickedTrackId !== 'master'
                                            ? logic.lastClickedTrackId
                                            : (selectedTrackId && selectedTrackId !== 'master' ? selectedTrackId : null);
                                        const anchorIndex = anchorId ? (logic.visibleTrackIndexById.get(anchorId) ?? -1) : -1;
                                        const currentIndex = logic.visibleTrackIndexById.get(track.id) ?? -1;
                                        if (anchorIndex >= 0 && currentIndex >= 0) {
                                            const start = Math.min(anchorIndex, currentIndex);
                                            const end = Math.max(anchorIndex, currentIndex);
                                            const rangeIds = logic.visibleTracks.slice(start, end + 1).map((t: TrackData) => t.id);
                                            logic.applySelection(rangeIds, track.id);
                                        } else {
                                            logic.applySelection([track.id], track.id);
                                        }
                                    } else if (e.metaKey || e.ctrlKey) {
                                        const next = new Set(logic.selectedTrackIdSet);
                                        if (next.has(track.id)) next.delete(track.id);
                                        else next.add(track.id);
                                        logic.applySelection(Array.from(next), track.id);
                                    } else {
                                        logic.applySelection([track.id], track.id);
                                    }
                                    logic.setLastClickedTrackId(track.id);
                                }}
                                onToggleMute={() => logic.toggleMute(track.id)}
                                onToggleSolo={() => logic.toggleSolo(track.id)}
                                onToggleArm={() => logic.toggleArm(track.id)}
                                onToggleCollapse={isGroup ? () => logic.toggleGroupCollapse(track.id) : undefined}
                                onVolumeChange={(gain: number) => {
                                    logic.setLocalOverrides((prev) => ({
                                        ...prev,
                                        [track.id]: { ...prev[track.id], volume: gain },
                                    }));
                                    if (trackIndex >= 0) void logic.engineSetTrackVolume(trackIndex, gain);
                                }}
                                onPanChange={(pan: number) => {
                                    logic.setLocalOverrides((prev) => ({
                                        ...prev,
                                        [track.id]: { ...prev[track.id], pan },
                                    }));
                                    if (trackIndex >= 0) void logic.engineSetTrackPan(trackIndex, pan);
                                }}
                                onOutputChange={(targetId) => { void logic.setTrackOutput(track.id, targetId); }}
                                onInputChange={(inputId) => { void logic.setTrackInput(track.id, inputId); }}
                                onContextMenu={(e) => logic.handleContextMenu(e, track.id, trackIndex)}
                                onHeaderPointerDown={(e) => logic.beginHeaderPointerDrag(e, track.id)}
                                isGroupDropTarget={logic.groupDropTargetId === track.id}
                                groupStripeColor={track.groupId ? (logic.trackById.get(track.groupId)?.color ?? track.color) : track.color}
                                layout={logic.rowLayout}
                                isResizing={logic.resizingTrackId === track.id}
                                onResizeStart={(startY) => logic.beginRowResize(track.id, resolvedRowHeight, startY)}
                                mixerFocusMode={mixerFocusMode}
                            />
                            {logic.dropInsertIndex === visibleIndex + 1 && (
                                <div className="track-drop-insert-line" />
                            )}
                        </div>
                    );
                })}

            </div>

            {/* Master Track — fixed at bottom */}
            {(() => {
                const masterRowHeight = logic.rowHeightsByTrackId.master ?? trackHeight;
                return (
                    <TrackRow
                        track={logic.masterTrack}
                        allTracks={logic.tracks}
                        trackHeight={masterRowHeight}
                        isSelected={selectedTrackId === 'master'}
                        isPrimarySelected={selectedTrackId === 'master'}
                        isCollapsed={false}
                        depth={0}
                        isRenaming={false}
                        renameValue=""
                        onRenameChange={() => { }}
                        onRenameCommit={() => { }}
                        onRenameCancel={() => { }}
                        onClick={() => {
                            logic.applySelection([], 'master');
                        }}
                        onToggleMute={() => { }}
                        onToggleSolo={() => { }}
                        onToggleArm={() => { }}
                        onVolumeChange={(gain: number) => {
                            void logic.engineSetMasterVolume(gain);
                        }}
                        onPanChange={() => { }}
                        onOutputChange={() => { }}
                        onInputChange={() => { }}
                        onContextMenu={(e) => {
                            e.preventDefault();
                            logic.setContextMenu({ trackId: 'master', trackIndex: -1, x: e.clientX, y: e.clientY });
                        }}
                        layout={logic.rowLayout}
                        isResizing={logic.resizingTrackId === 'master'}
                        onResizeStart={(startY) => logic.beginRowResize('master', masterRowHeight, startY)}
                        isMasterFixed
                        mixerFocusMode={mixerFocusMode}
                    />
                );
            })()}

            {/* Context Menu */}
            {logic.contextMenu && (
                <ContextMenuPopup
                    x={logic.contextMenu.x}
                    y={logic.contextMenu.y}
                    showTrackActions={Boolean(logic.contextMenu.trackId)}
                    onAddAudioTrack={() => logic.handleAddTrackFromContext('audio')}
                    onAddMidiTrack={() => logic.handleAddTrackFromContext('midi')}
                    onRename={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handleRenameStart(logic.contextMenu.trackId);
                    }}
                    onDuplicate={() => {
                        if (!logic.contextMenu?.trackId) return;
                        void engineApi.duplicateTracks([logic.contextMenu.trackId]).then(() => {
                            debouncedFetchProject('duplicate-context');
                            return;
                        }).catch((err) => {
                            console.error('[TrackInspector] duplicate track (context menu) failed:', err);
                        });
                        logic.setContextMenu(null);
                    }}
                    onGroup={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handleGroupTrack(logic.contextMenu.trackId);
                    }}
                    onUngroup={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handleUngroupTrack(logic.contextMenu.trackId);
                    }}
                    canUngroup={(() => {
                        if (!logic.contextMenu?.trackId) return false;
                        const ctxTrack = logic.tracks.find((t) => t.id === logic.contextMenu?.trackId);
                        return !!ctxTrack && (ctxTrack.type === 'group' || !!ctxTrack.groupId);
                    })()}
                    canBounceGroup={(() => {
                        if (!logic.contextMenu?.trackId) return false;
                        const ctxTrack = logic.tracks.find((t) => t.id === logic.contextMenu?.trackId);
                        return !!ctxTrack && ctxTrack.type === 'group';
                    })()}
                    onDelete={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handleDeleteTrack(logic.contextMenu.trackId);
                    }}
                    onChangeColor={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handleOpenColorPicker(logic.contextMenu.trackId, logic.contextMenu.x, logic.contextMenu.y);
                    }}
                    onPaintClips={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handlePaintClipsWithTrackColor(logic.contextMenu.trackId);
                    }}
                    onBounceTrack={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handleBounceTrack(logic.contextMenu.trackId);
                    }}
                    onBounceGroup={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handleBounceGroup(logic.contextMenu.trackId);
                    }}
                    onPaintGroupColor={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handlePaintGroupColor(logic.contextMenu.trackId);
                    }}
                    onSplitToStems={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handleSplitTrackToStems(logic.contextMenu.trackId);
                    }}
                    onDismiss={() => logic.setContextMenu(null)}
                />
            )}

            {/* Color Picker */}
            {logic.colorPickerState && (
                <ColorPickerPopup
                    x={logic.colorPickerState.x}
                    y={logic.colorPickerState.y}
                    currentColor={(logic.colorPickerState.trackId === 'master' ? logic.masterTrack.color : logic.tracks.find(t => t.id === logic.colorPickerState?.trackId)?.color) || '#666'}
                    onSelect={(color) => logic.handleColorSelect(logic.colorPickerState!.trackId, color)}
                    onDismiss={() => logic.setColorPickerState(null)}
                />
            )}
        </div>
    );
};
