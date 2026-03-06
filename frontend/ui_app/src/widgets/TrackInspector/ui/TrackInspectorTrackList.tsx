import { useRef, useEffect, useCallback } from 'react';
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

/**
 * ═══════════════════════════════════════════════════════════════════════
 * Enterprise SSOT Scroll — Virtual-scroll track list
 * ═══════════════════════════════════════════════════════════════════════
 *
 * CRITICAL DESIGN: This component does NOT use native DOM overflow scroll.
 * Instead, it uses `overflow: hidden` + `translateY(-scrollY)` driven by
 * the global `scrollSync` singleton. This ensures:
 *
 *   1. Identical scroll range as the Timeline canvas (ViewportMatrix SSOT)
 *   2. No macOS rubber-band overscroll physics mismatch
 *   3. Pixel-perfect synchronization at all times
 *   4. Wheel events on this panel go through ViewportMatrix for clamping
 *
 * The wheel handler here pushes deltas to scrollSync as 'inspector',
 * which propagates to the Timeline engine. The ViewportMatrix clamps
 * the scroll position and fires back via onScrollYChange → scrollSync,
 * which then updates our translateY via the subscription in
 * useTrackInspectorLogic.
 */
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

    // ── Virtual scroll wheel handler ─────────────────────────────────
    // Instead of native overflowY scroll, we capture wheel events and
    // push deltas through scrollSync → ViewportMatrix (SSOT).
    const containerRef = useRef<HTMLDivElement>(null);

    const handleWheel = useCallback((e: WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const lineHeight = Math.max(1, trackHeight);
        const pageHeight = Math.max(lineHeight, containerRef.current?.clientHeight ?? lineHeight);
        const normalizedDelta = e.deltaMode === 1
            ? e.deltaY * lineHeight
            : e.deltaMode === 2
                ? e.deltaY * pageHeight
                : e.deltaY;
        // Push DELTA to ViewportMatrix (the SSOT) via scrollSync.pushScrollDelta.
        // ViewportMatrix clamps and fires _onScrollYChange →
        // scrollSync.setScrollY('timeline') → our subscriber updates translateY.
        scrollSync.pushScrollDelta(normalizedDelta);
    }, [trackHeight]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        el.addEventListener('wheel', handleWheel, { passive: false });
        return () => el.removeEventListener('wheel', handleWheel);
    }, [handleWheel]);

    // ── Expose containerRef via scrollRef for drag-drop auto-scroll ──
    // The scrollRef is still used by useTrackInspectorDragDrop for
    // bounding rect calculations. We sync it here.
    useEffect(() => {
        (logic.scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = containerRef.current;
    }, [logic.scrollRef]);

    // ── Expose innerRef for direct DOM transform manipulation ──
    const innerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        (logic.innerScrollRef as React.MutableRefObject<HTMLDivElement | null>).current = innerRef.current;
        // Apply current scroll position immediately on mount
        if (innerRef.current) {
            innerRef.current.style.transform = `translateY(${-logic.virtualScrollYRef.current}px)`;
        }
    }, [logic.innerScrollRef, logic.virtualScrollYRef]);

    return (
        <div
            ref={containerRef}
            className="scrollbar-hide"
            style={{
                flex: 1,
                overflow: 'hidden',
                paddingRight: 2,
                boxSizing: 'border-box',
                position: 'relative',
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
            {/* Virtual scroll inner container — transform set directly by scrollSync subscriber */}
            <div
                ref={innerRef}
                style={{
                    willChange: 'transform',
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
                                baseHeight={defaultRowHeight}
                                displayNum={displayNum}
                                isSelected={logic.selectedTrackIdSet.has(track.id)}
                                isHeaderSelected={logic.headerSelectedTrackIdSet.has(track.id)}
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
                                    logic.clearHeaderSelection();
                                    if (e.shiftKey) {
                                        const anchorId =
                                            logic.lastHeaderClickedTrackId && logic.lastHeaderClickedTrackId !== 'master'
                                                ? logic.lastHeaderClickedTrackId
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
                                onHeaderClick={(e) => {
                                    if (logic.suppressNextClickRef.current) {
                                        logic.suppressNextClickRef.current = false;
                                        e.preventDefault();
                                        return;
                                    }
                                    e.stopPropagation();
                                    if (e.shiftKey) {
                                        let anchorId: string | null = null;
                                        if (logic.lastHeaderClickedTrackId && logic.lastHeaderClickedTrackId !== 'master') {
                                            anchorId = logic.lastHeaderClickedTrackId;
                                        } else if (selectedTrackId && selectedTrackId !== 'master') {
                                            anchorId = selectedTrackId;
                                        } else {
                                            const selectedHeaderIds = Array.from(logic.headerSelectedTrackIdSet);
                                            if (selectedHeaderIds.length > 0) anchorId = selectedHeaderIds[0];
                                        }
                                        const anchorIndex = anchorId ? (logic.visibleTrackIndexById.get(anchorId) ?? -1) : -1;
                                        const currentIndex = logic.visibleTrackIndexById.get(track.id) ?? -1;
                                        if (anchorIndex >= 0 && currentIndex >= 0) {
                                            const start = Math.min(anchorIndex, currentIndex);
                                            const end = Math.max(anchorIndex, currentIndex);
                                            const rangeIds = logic.visibleTracks.slice(start, end + 1).map((t: TrackData) => t.id);
                                            logic.applySelection(rangeIds, track.id, { preserveCursor: true });
                                            logic.applyHeaderSelection(rangeIds);
                                        } else {
                                            logic.applySelection([track.id], track.id, { preserveCursor: true });
                                            logic.applyHeaderSelection([track.id]);
                                        }
                                    } else if (e.metaKey || e.ctrlKey) {
                                        const next = new Set(logic.headerSelectedTrackIdSet);
                                        if (next.has(track.id)) next.delete(track.id);
                                        else next.add(track.id);
                                        const nextIds = Array.from(next);
                                        const nextPrimaryId = nextIds.includes(track.id)
                                            ? track.id
                                            : (nextIds[nextIds.length - 1] ?? track.id);
                                        logic.applySelection(nextIds, nextPrimaryId, { preserveCursor: true });
                                        logic.applyHeaderSelection(nextIds);

                                        const preservedAnchor =
                                            logic.lastHeaderClickedTrackId && nextIds.includes(logic.lastHeaderClickedTrackId)
                                                ? logic.lastHeaderClickedTrackId
                                                : (nextIds[0] ?? null);
                                        logic.setLastHeaderClickedTrackId(preservedAnchor);
                                        logic.setLastClickedTrackId(preservedAnchor);
                                        return;
                                    } else {
                                        logic.applySelection([track.id], track.id, { preserveCursor: true });
                                        logic.applyHeaderSelection([track.id]);
                                    }
                                    logic.setLastClickedTrackId(track.id);
                                    logic.setLastHeaderClickedTrackId(track.id);
                                }}
                                onToggleDisabled={() => logic.toggleDisabled(track.id)}
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
                                onVolumeContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    logic.setAutoCtxMenu({ x: e.clientX, y: e.clientY, trackId: track.id, paramName: 'Volume' });
                                }}
                                onPanContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    logic.setAutoCtxMenu({ x: e.clientX, y: e.clientY, trackId: track.id, paramName: 'Pan' });
                                }}
                                onParamSelectorClick={(x, y, laneId) => {
                                    logic.setParamSelectorCtxMenu({ x, y, trackId: track.id, laneId });
                                }}
                                onHeaderPointerDown={(e) => logic.beginHeaderPointerDrag(e, track.id)}
                                isGroupDropTarget={logic.groupDropTargetId === track.id}
                                groupAncestorColors={logic.getGroupAncestorColors(track)}
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
        </div>
    );
}
