import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useShallow } from 'zustand/react/shallow';
import { scrollSync } from '@/shared/lib/useScrollSync';
import { buildTrackStatePatch } from '@/shared/stores/engine/storeHelpers';
import type { TrackData } from '@/widgets/TrackInspector/model/trackModels';
import { useTrackInspectorContextActions } from '@/widgets/TrackInspector/model/useTrackInspectorContextActions';
import { useTrackInspectorTrackActions } from '@/widgets/TrackInspector/model/useTrackInspectorTrackActions';
import { useTrackInspectorResize } from '@/widgets/TrackInspector/model/useTrackInspectorResize';
import { useTrackInspectorKeyboardShortcuts } from '@/widgets/TrackInspector/model/useTrackInspectorKeyboardShortcuts';
import { useTrackInspectorDragDrop } from '@/widgets/TrackInspector/model/useTrackInspectorDragDrop';
import { useTrackInspectorDerivedState } from '@/widgets/TrackInspector/model/useTrackInspectorDerivedState';
import { useTrackInspectorHeightSync } from '@/widgets/TrackInspector/model/useTrackInspectorHeightSync';
export interface UseTrackInspectorLogicProps {
    selectedTrackId: string;
    selectedTrackIds?: string[];
    onSelectTrack: (id: string, options?: { preserveCursor?: boolean }) => void;
    onSelectTracks?: (ids: string[], primaryId: string, options?: { preserveCursor?: boolean }) => void;
    trackHeight?: number;
    rulerHeight?: number;
    mixerFocusMode?: boolean;
    collapsedGroups?: Set<string>;
    onToggleGroupCollapse?: (groupId: string) => void;
}

export function useTrackInspectorLogic({
    selectedTrackId,
    selectedTrackIds: selectedTrackIdsProp,
    onSelectTrack,
    onSelectTracks,
    trackHeight = 48,
    mixerFocusMode = false,
    collapsedGroups: collapsedGroupsProp,
    onToggleGroupCollapse: onToggleGroupCollapseProp,
}: UseTrackInspectorLogicProps) {
    const {
        trackIds,
        tracksByIdState,
        engineSetTrackDisabled,
        engineSetTrackSolo,
        engineSetTrackVolume,
        engineSetTrackPan,
        engineSetMasterVolume,
        masterVolume,
        renameTrackAction,
        meters,
    } = useEngineStore(useShallow((s) => ({
        trackIds: s.tracks.allIds,
        tracksByIdState: s.tracks.byId,
        engineSetTrackDisabled: s.setTrackDisabled,
        engineSetTrackSolo: s.setTrackSolo,
        engineSetTrackVolume: s.setTrackVolume,
        engineSetTrackPan: s.setTrackPan,
        engineSetMasterVolume: s.setMasterVolume,
        masterVolume: s.masterVolume,
        renameTrackAction: s.renameTrack,
        meters: s.meters,
    })));

    const scrollRef = useRef<HTMLDivElement>(null);
    const lastProgrammaticScrollRef = useRef<number | null>(null);
    /** Direct DOM ref to the inner translateY container — bypasses React for 60fps sync. */
    const innerScrollRef = useRef<HTMLDivElement>(null);
    /** Current virtual scroll Y — ref (not state!) for zero-latency sync. */
    const virtualScrollYRef = useRef(0);

    const [localOverrides, setLocalOverrides] = useState<Record<string, Partial<TrackData>>>({});
    const [localSelectedTrackIds, setLocalSelectedTrackIds] = useState<Set<string> | null>(null);
    const [autoCtxMenu, setAutoCtxMenu] = useState<{ x: number; y: number; trackId: string; paramName: string } | null>(null);
    const [headerSelectedTrackIdSet, setHeaderSelectedTrackIdSet] = useState<Set<string>>(new Set());
    const keepHeaderSelectionOnNextTrackSelectionSyncRef = useRef(false);
    const [lastClickedTrackId, setLastClickedTrackId] = useState<string | null>(null);
    const [lastHeaderClickedTrackId, setLastHeaderClickedTrackId] = useState<string | null>(null);
    const [rowHeightOverrides, setRowHeightOverrides] = useState<Record<string, number>>({});
    const [localCollapsedGroups, setLocalCollapsedGroups] = useState<Set<string> | null>(null);
    const effectiveSelectedTrackIds = useMemo(() => {
        if (selectedTrackIdsProp) return selectedTrackIdsProp;
        if (localSelectedTrackIds) return Array.from(localSelectedTrackIds);
        if (selectedTrackId && selectedTrackId !== 'master') return [selectedTrackId];
        return [];
    }, [selectedTrackIdsProp, localSelectedTrackIds, selectedTrackId]);
    const selectedTrackIdSet = useMemo(() => new Set(effectiveSelectedTrackIds.filter((id) => id && id !== 'master')), [effectiveSelectedTrackIds]);
    const applyHeaderSelection = useCallback((ids: string[]) => {
        const cleaned = Array.from(new Set(ids)).filter((id) => Boolean(id));
        keepHeaderSelectionOnNextTrackSelectionSyncRef.current = true;
        setHeaderSelectedTrackIdSet(new Set(cleaned));
    }, []);
    const clearHeaderSelection = useCallback(() => {
        setHeaderSelectedTrackIdSet((prev) => (prev.size === 0 ? prev : new Set()));
    }, []);
    useEffect(() => {
        const valid = new Set(['master', ...trackIds]);
        setTimeout(() => setHeaderSelectedTrackIdSet((prev) => {
            if (prev.size === 0) return prev;
            const next = new Set<string>();
            for (const id of prev) {
                if (valid.has(id)) next.add(id);
            }
            return next.size === prev.size ? prev : next;
        }), 0);
    }, [trackIds]);
    const trackSelectionSyncSignature = useMemo(
        () => `${selectedTrackId}|${effectiveSelectedTrackIds.join(',')}`,
        [selectedTrackId, effectiveSelectedTrackIds],
    );
    useEffect(() => {
        if (keepHeaderSelectionOnNextTrackSelectionSyncRef.current) {
            keepHeaderSelectionOnNextTrackSelectionSyncRef.current = false;
            return;
        }
        setTimeout(() => clearHeaderSelection(), 0);
    }, [trackSelectionSyncSignature, clearHeaderSelection]);
    useEffect(() => {
        const onWindowPointerDown = (e: PointerEvent) => {
            if (headerSelectedTrackIdSet.size === 0) return;
            const target = e.target as HTMLElement | null;
            if (target?.closest?.('[data-track-header="true"]')) return;
            clearHeaderSelection();
        };
        window.addEventListener('pointerdown', onWindowPointerDown, { capture: true });
        return () => window.removeEventListener('pointerdown', onWindowPointerDown, { capture: true } as EventListenerOptions);
    }, [headerSelectedTrackIdSet.size, clearHeaderSelection]);
    const applySelection = useCallback((ids: string[], primaryId: string, options?: { preserveCursor?: boolean }) => {
        const cleaned = Array.from(new Set(ids)).filter((id) => id && id !== 'master');
        if (onSelectTracks) {
            onSelectTracks(cleaned, primaryId, options);
            return;
        }
        setLocalSelectedTrackIds(new Set(cleaned));
        onSelectTrack(primaryId, options);
    }, [onSelectTrack, onSelectTracks]);
    const {
        trackActiveStates,
        liveTracks,
        masterTrack,
        tracks,
        trackById,
        getTrackIndex,
        collapsedGroups,
        toggleGroupCollapse,
        rowHeightsByTrackId,
        visibleTracks,
        visibleTrackIndexById,
        getDepth,
        rowLayout,
    } = useTrackInspectorDerivedState({
        trackIds,
        tracksByIdState,
        meters,
        masterVolume,
        trackHeight,
        mixerFocusMode,
        localOverrides,
        rowHeightOverrides,
        localCollapsedGroups,
        setLocalCollapsedGroups,
        collapsedGroupsProp,
        onToggleGroupCollapseProp,
    });
    const {
        toggleDisabled,
        toggleSolo,
        toggleArm,
        setTrackOutput,
        setTrackInput,
    } = useTrackInspectorTrackActions({
        tracks,
        selectedTrackIdSet,
        getTrackIndex,
        engineSetTrackDisabled,
        engineSetTrackSolo,
        setLocalOverrides,
    });
    const applyTrackHeightOptimistic = useCallback((trackId: string, height: number) => {
        if (!trackId || trackId === 'master') return;
        useEngineStore.setState((state) => {
            const current = state.tracks.byId[trackId];
            if (!current) return state;
            const nextById = {
                ...state.tracks.byId,
                [trackId]: { ...current, height },
            };
            return buildTrackStatePatch(state.tracks.allIds, nextById);
        });
    }, []);
    const { resizingTrackId, beginRowResize } = useTrackInspectorResize({
        applyTrackHeightOptimistic,
        setRowHeightOverrides,
    });

    useTrackInspectorHeightSync(
        rowHeightOverrides,
        resizingTrackId,
        tracksByIdState,
        trackHeight,
        setRowHeightOverrides,
    );
    const {
        contextMenu,
        colorPickerState,
        renamingTrackId,
        renameValue,
        setRenameValue,
        setContextMenu,
        setColorPickerState,
        handleContextMenu,
        handleAddTrackFromContext,
        handleRenameStart,
        handleRenameCommit,
        handleRenameCancel,
        handleDeleteTrack,
        handleDeleteSelectedTracks,
        handleDuplicateSelectedTracks,
        handleGroupTrack,
        handleUngroupTrack,
        handleOpenColorPicker,
        handleColorSelect,
        handlePaintClipsWithTrackColor,
        handlePaintGroupColor,
        handleBounceTrack,
        handleBounceGroup,
        handleSplitTrackToStems,
    } = useTrackInspectorContextActions({
        tracks,
        liveTracks,
        selectedTrackIdSet,
        selectedTrackIdsProp,
        getTrackIndex,
        setLocalOverrides,
        setLocalSelectedTrackIds,
        onSelectTrack,
        onSelectTracks,
        renameTrackAction,
    });
    const {
        draggingTrackId,
        dropInsertIndex,
        groupDropTargetId,
        trackRowRefs,
        suppressNextClickRef,
        draggingTrackIdRef,
        beginHeaderPointerDrag,
        resetTrackDragState,
        commitDraggedTrackToVisibleIndex,
        commitTrackToGroup,
        canDropTrackIntoGroup,
    } = useTrackInspectorDragDrop({
        tracks,
        visibleTracks,
        scrollRef,
    });
    useEffect(() => {
        const unsub = scrollSync.subscribe('inspector', (y) => {
            virtualScrollYRef.current = y;
            if (innerScrollRef.current) {
                innerScrollRef.current.style.transform = `translateY(${-y}px)`;
            }
        });
        return unsub;
    }, []);
    useTrackInspectorKeyboardShortcuts({
        selectedTrackId,
        selectedTrackIdSet,
        headerSelectedTrackIdSet,
        tracks,
        renamingTrackId,
        handleRenameStart,
        handleGroupTrack,
        handleDeleteSelectedTracks,
        handleDuplicateSelectedTracks,
    });

    return {
        scrollRef,
        lastProgrammaticScrollRef,
        innerScrollRef,
        virtualScrollYRef,
        trackRowRefs,
        suppressNextClickRef,
        draggingTrackIdRef,
        masterTrack,
        tracks,
        liveTracks,
        visibleTracks,
        trackActiveStates,
        trackById,
        visibleTrackIndexById,
        selectedTrackIdSet,
        headerSelectedTrackIdSet,
        collapsedGroups,
        rowHeightsByTrackId,
        contextMenu,
        autoCtxMenu,
        colorPickerState,
        renamingTrackId,
        renameValue,
        draggingTrackId,
        dropInsertIndex,
        groupDropTargetId,
        resizingTrackId,
        lastClickedTrackId,
        rowLayout,
        getTrackIndex,
        getDepth,
        applySelection,
        applyHeaderSelection,
        clearHeaderSelection,
        setLastClickedTrackId,
        lastHeaderClickedTrackId,
        setLastHeaderClickedTrackId,
        setRenameValue,
        setContextMenu,
        setAutoCtxMenu,
        setColorPickerState,
        toggleDisabled,
        toggleSolo,
        toggleArm,
        toggleGroupCollapse,
        setTrackOutput,
        setTrackInput,
        beginRowResize,
        beginHeaderPointerDrag,
        handleContextMenu,
        handleAddTrackFromContext,
        handleRenameStart,
        handleRenameCommit,
        handleRenameCancel,
        handleDeleteTrack,
        handleDeleteSelectedTracks,
        handleDuplicateSelectedTracks,
        handleGroupTrack,
        handleUngroupTrack,
        handleOpenColorPicker,
        handleColorSelect,
        handlePaintClipsWithTrackColor,
        handlePaintGroupColor,
        handleBounceTrack,
        handleBounceGroup,
        handleSplitTrackToStems,
        resetTrackDragState,
        commitDraggedTrackToVisibleIndex,
        commitTrackToGroup,
        canDropTrackIntoGroup,
        engineSetTrackVolume,
        engineSetTrackPan,
        engineSetMasterVolume,
        setLocalOverrides,
    };
}

export type TrackInspectorLogicState = ReturnType<typeof useTrackInspectorLogic>;
