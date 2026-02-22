// ═══════════════════════════════════════════════════════════════════════
// useTrackInspectorLogic — extracted state/effects/callbacks from TrackInspector
// ═══════════════════════════════════════════════════════════════════════
//
// All React hooks (state, refs, effects, callbacks, memos) extracted here.
// TrackInspector.tsx becomes a pure *rendering* component.
//
// ═══════════════════════════════════════════════════════════════════════

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useShallow } from 'zustand/react/shallow';
import { scrollSync } from '@/shared/lib/useScrollSync';
import type { TrackData } from '@/widgets/TrackInspector/model/trackModels';
import { useTrackInspectorContextActions } from '@/widgets/TrackInspector/model/useTrackInspectorContextActions';
import { useTrackInspectorTrackActions } from '@/widgets/TrackInspector/model/useTrackInspectorTrackActions';
import { useTrackInspectorResize } from '@/widgets/TrackInspector/model/useTrackInspectorResize';
import { useTrackInspectorKeyboardShortcuts } from '@/widgets/TrackInspector/model/useTrackInspectorKeyboardShortcuts';
import { useTrackInspectorDragDrop } from '@/widgets/TrackInspector/model/useTrackInspectorDragDrop';
import { useTrackInspectorDerivedState } from '@/widgets/TrackInspector/model/useTrackInspectorDerivedState';

// ── BUG-P4 FIX: Debounced project refresh ──────────────────────────────
let _inspectorFetchTimer: ReturnType<typeof setTimeout> | null = null;
const INSPECTOR_FETCH_DEBOUNCE_MS = 100;
function debouncedFetchProject(reason: string) {
    if (_inspectorFetchTimer) clearTimeout(_inspectorFetchTimer);
    _inspectorFetchTimer = setTimeout(
        () => void useEngineStore.getState().fetchProject(reason),
        INSPECTOR_FETCH_DEBOUNCE_MS,
    );
}

// ── Props ──────────────────────────────────────────────────────────────

export interface UseTrackInspectorLogicProps {
    selectedTrackId: string;
    selectedTrackIds?: string[];
    onSelectTrack: (id: string) => void;
    onSelectTracks?: (ids: string[], primaryId: string) => void;
    trackHeight?: number;
    rulerHeight?: number;
    mixerFocusMode?: boolean;
    collapsedGroups?: Set<string>;
    onToggleGroupCollapse?: (groupId: string) => void;
}

// ── Hook ───────────────────────────────────────────────────────────────

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
        engineSetTrackMute,
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
        engineSetTrackMute: s.setTrackMute,
        engineSetTrackSolo: s.setTrackSolo,
        engineSetTrackVolume: s.setTrackVolume,
        engineSetTrackPan: s.setTrackPan,
        engineSetMasterVolume: s.setMasterVolume,
        masterVolume: s.masterVolume,
        renameTrackAction: s.renameTrack,
        meters: s.meters,
    })));

    // ── Refs ───────────────────────────────────────────────────────
    const scrollRef = useRef<HTMLDivElement>(null);
    const lastProgrammaticScrollRef = useRef<number | null>(null);

    // ── State ──────────────────────────────────────────────────────
    const [localOverrides, setLocalOverrides] = useState<Record<string, Partial<TrackData>>>({});
    const [localSelectedTrackIds, setLocalSelectedTrackIds] = useState<Set<string> | null>(null);
    const [lastClickedTrackId, setLastClickedTrackId] = useState<string | null>(null);
    const [rowHeightOverrides, setRowHeightOverrides] = useState<Record<string, number>>({});
    const [localCollapsedGroups, setLocalCollapsedGroups] = useState<Set<string> | null>(null);

    // ── Computed: selection ─────────────────────────────────────────
    const effectiveSelectedTrackIds = useMemo(() => {
        if (selectedTrackIdsProp) return selectedTrackIdsProp;
        if (localSelectedTrackIds) return Array.from(localSelectedTrackIds);
        if (selectedTrackId && selectedTrackId !== 'master') return [selectedTrackId];
        return [];
    }, [selectedTrackIdsProp, localSelectedTrackIds, selectedTrackId]);

    const selectedTrackIdSet = useMemo(
        () => new Set(effectiveSelectedTrackIds.filter((id) => id && id !== 'master')),
        [effectiveSelectedTrackIds],
    );

    const applySelection = useCallback((ids: string[], primaryId: string) => {
        const cleaned = Array.from(new Set(ids)).filter((id) => id && id !== 'master');
        if (onSelectTracks) onSelectTracks(cleaned, primaryId);
        else setLocalSelectedTrackIds(new Set(cleaned));
        onSelectTrack(primaryId);
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
        toggleMute,
        toggleSolo,
        toggleArm,
        setTrackOutput,
        setTrackInput,
    } = useTrackInspectorTrackActions({
        tracks,
        selectedTrackIdSet,
        getTrackIndex,
        engineSetTrackMute,
        engineSetTrackSolo,
        setLocalOverrides,
    });

    const applyTrackHeightOptimistic = useCallback((trackId: string, height: number) => {
        if (!trackId || trackId === 'master') return;
        useEngineStore.setState((state) => {
            const nextTracks = state.projectTracks.map((track) =>
                track.id === trackId ? { ...track, height } : track
            );
            const nextById = Object.fromEntries(nextTracks.map((t) => [t.id, t]));
            return {
                projectTracks: nextTracks,
                tracksById: nextById,
                tracks: {
                    byId: nextById,
                    allIds: state.tracks.allIds,
                },
            };
        });
    }, []);

    const { resizingTrackId, beginRowResize } = useTrackInspectorResize({
        applyTrackHeightOptimistic,
        setRowHeightOverrides,
    });

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
        onRefresh: debouncedFetchProject,
    });

    // ── Drag & Drop ─────────────────────────────────────────────────
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
        debouncedFetchProject,
    });

    // ── Effects ─────────────────────────────────────────────────────

    // Scroll sync
    useEffect(() => {
        const unsub = scrollSync.subscribe('inspector', (y) => {
            if (scrollRef.current) {
                lastProgrammaticScrollRef.current = y;
                scrollRef.current.scrollTop = y;
            }
        });
        return unsub;
    }, []);

    useTrackInspectorKeyboardShortcuts({
        selectedTrackId,
        selectedTrackIdSet,
        tracks,
        renamingTrackId,
        handleRenameStart,
        handleGroupTrack,
        handleDeleteSelectedTracks,
        handleDuplicateSelectedTracks,
        debouncedFetchProject,
    });

    // ── Return ──────────────────────────────────────────────────────
    return {
        // Refs
        scrollRef,
        lastProgrammaticScrollRef,
        trackRowRefs,
        suppressNextClickRef,
        draggingTrackIdRef,

        // State
        masterTrack,
        tracks,
        liveTracks,
        visibleTracks,
        trackActiveStates,
        trackById,
        visibleTrackIndexById,
        selectedTrackIdSet,
        collapsedGroups,
        rowHeightsByTrackId,
        contextMenu,
        colorPickerState,
        renamingTrackId,
        renameValue,
        draggingTrackId,
        dropInsertIndex,
        groupDropTargetId,
        resizingTrackId,
        lastClickedTrackId,
        rowLayout,

        // Computed
        getTrackIndex,
        getDepth,

        // Actions
        applySelection,
        setLastClickedTrackId,
        setRenameValue,
        setContextMenu,
        setColorPickerState,
        toggleMute,
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

        // Engine actions (for volume/pan inline handlers)
        engineSetTrackVolume,
        engineSetTrackPan,
        engineSetMasterVolume,
        setLocalOverrides,
    };
}
