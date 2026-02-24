import { scrollSync } from '@/shared/lib/useScrollSync';
import { clampTrackHeightPx } from '@/shared/config/layoutConstants';
import type { TrackData } from '@/widgets/TrackInspector/model/trackModels';
import type { TrackInspectorLogicState } from '@/widgets/TrackInspector/model/useTrackInspectorLogic';
import { TrackRow } from '@/widgets/TrackInspector/ui/TrackRow';

interface TrackInspectorTrackListProps {
    logic: TrackInspectorLogicState;
    selectedTrackId: string;
    trackHeight: number;
    mixerFocusMode: boolean;
}

export function TrackInspectorTrackList({
    logic,
    selectedTrackId,
    trackHeight,
    mixerFocusMode,
}: TrackInspectorTrackListProps) {
    let trackNum = 0;
    const trailingEmptySlotHeight = clampTrackHeightPx(trackHeight);
    const routingTargets = logic.tracks
        .filter((track) => track.type !== 'master')
        .map((track) => ({ id: track.id, name: track.name }));
    const anySoloed = logic.tracks.some((track) => track.isSoloed);

    return (
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
                if (
                    logic.lastProgrammaticScrollRef.current !== null &&
                    Math.abs(pos - logic.lastProgrammaticScrollRef.current) < 1
                ) {
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
            {logic.dropInsertIndex === 0 && <div className="track-drop-insert-line" />}
            {logic.visibleTracks.map((track) => {
                const isGroup = track.type === 'group';
                if (track.type !== 'master') trackNum++;
                const displayNum = track.type === 'master' ? undefined : trackNum;
                const isCollapsed = isGroup ? logic.collapsedGroups.has(track.id) : false;
                const depth = logic.getDepth(track);
                const trackIndex = logic.getTrackIndex(track.id);
                const defaultRowHeight = clampTrackHeightPx(Number.isFinite(track.height) ? track.height : trackHeight);
                const resolvedRowHeight =
                    track.type === 'master'
                        ? (logic.rowHeightsByTrackId[track.id] ?? trackHeight)
                        : (logic.rowHeightsByTrackId[track.id] ?? defaultRowHeight);
                const visibleIndex = logic.visibleTrackIndexById.get(track.id) ?? -1;

                return (
                    <div key={track.id} ref={(el) => { logic.trackRowRefs.current[track.id] = el; }}>
                        <TrackRow
                            trackId={track.id}
                            trackSnapshot={track}
                            routingTargets={routingTargets}
                            anySoloed={anySoloed}
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
                                    const anchorId =
                                        logic.lastClickedTrackId && logic.lastClickedTrackId !== 'master'
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
                        {logic.dropInsertIndex === visibleIndex + 1 && <div className="track-drop-insert-line" />}
                    </div>
                );
            })}
            <div
                aria-hidden="true"
                style={{
                    height: trailingEmptySlotHeight,
                    minHeight: trailingEmptySlotHeight,
                }}
            />
        </div>
    );
}
