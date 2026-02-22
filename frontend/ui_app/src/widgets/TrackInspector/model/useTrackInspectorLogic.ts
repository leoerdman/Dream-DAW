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
import * as engineApi from '@/shared/api/engine';
import { scrollSync } from '@/shared/lib/useScrollSync';
import { isTrackActive } from '@/shared/utils/routing';
import type { TrackData, TrackRowLayoutMetrics } from '@/widgets/TrackInspector/model/trackModels';
import { mapProjectTrack } from '@/widgets/TrackInspector/model/trackModels';
import { useTrackInspectorContextActions } from '@/widgets/TrackInspector/model/useTrackInspectorContextActions';
import { useTrackInspectorTrackActions } from '@/widgets/TrackInspector/model/useTrackInspectorTrackActions';
import { useTrackInspectorResize } from '@/widgets/TrackInspector/model/useTrackInspectorResize';
import { useTrackInspectorKeyboardShortcuts } from '@/widgets/TrackInspector/model/useTrackInspectorKeyboardShortcuts';
import { useTrackInspectorDragDrop } from '@/widgets/TrackInspector/model/useTrackInspectorDragDrop';

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

    const projectTracks = useMemo(
        () => trackIds
            .map((id) => tracksByIdState[id])
            .filter((track): track is NonNullable<typeof track> => Boolean(track)),
        [trackIds, tracksByIdState],
    );

    const trackActiveStates = useMemo(() => {
        return projectTracks.map((_t, i, arr) => isTrackActive(i, arr));
    }, [projectTracks]);

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

    // ── Computed: tracks ────────────────────────────────────────────
    const liveTracks = useMemo((): TrackData[] => {
        const mapped = projectTracks.map((pt, idx) =>
            mapProjectTrack(pt, idx, meters.tracks[idx]),
        );
        for (const t of mapped) {
            if (t.type === 'group') {
                let maxL = -Infinity;
                let maxR = -Infinity;
                for (const child of mapped) {
                    if (child.groupId === t.id) {
                        if (child.vuLevelL > maxL) maxL = child.vuLevelL;
                        if (child.vuLevelR > maxR) maxR = child.vuLevelR;
                    }
                }
                if (maxL > -Infinity) {
                    t.vuLevelL = maxL;
                    t.vuLevelR = maxR;
                    t.vuLevel = Math.max(maxL, maxR);
                }
            }
        }
        return mapped;
    }, [projectTracks, meters]);

    const masterTrack = useMemo((): TrackData => {
        const masterVuL = meters.master_left.peak;
        const masterVuR = meters.master_right.peak;
        const masterTrackColor = 'var(--color-panel-master)';
        return {
            id: 'master', name: 'Master', type: 'master', color: masterTrackColor,
            volume: masterVolume, pan: 0, isMuted: false, isSoloed: false, isArmed: false,
            vuLevel: Math.max(masterVuL, masterVuR),
            vuLevelL: masterVuL,
            vuLevelR: masterVuR,
            routing: '', sends: [], input: '', output: 'Main',
            height: trackHeight,
        };
    }, [meters, masterVolume, trackHeight]);

    const tracks = useMemo(() => {
        return liveTracks.map(t => ({ ...t, ...(localOverrides[t.id] || {}) }));
    }, [liveTracks, localOverrides]);

    const trackById = useMemo(() => {
        const map = new Map<string, TrackData>();
        for (const t of tracks) map.set(t.id, t);
        return map;
    }, [tracks]);

    const liveTrackIndexById = useMemo(() => {
        const map = new Map<string, number>();
        for (let i = 0; i < liveTracks.length; i += 1) map.set(liveTracks[i].id, i);
        return map;
    }, [liveTracks]);

    const getTrackIndex = useCallback((id: string) => liveTrackIndexById.get(id) ?? -1, [liveTrackIndexById]);

    // ── Collapse ────────────────────────────────────────────────────
    const backendCollapsedGroups = useMemo(() => {
        const collapsed = new Set<string>();
        for (const pt of projectTracks) {
            const normalized = (pt.track_type ?? '').toLowerCase();
            if (normalized === 'group' && pt.is_expanded === false) {
                collapsed.add(pt.id);
            }
        }
        return collapsed;
    }, [projectTracks]);

    const collapsedGroups = collapsedGroupsProp ?? localCollapsedGroups ?? backendCollapsedGroups;

    const toggleGroupCollapse = useCallback((groupId: string) => {
        if (onToggleGroupCollapseProp) {
            onToggleGroupCollapseProp(groupId);
            return;
        }
        setLocalCollapsedGroups(prev => {
            const base = prev ?? backendCollapsedGroups;
            const next = new Set(base);
            let expanded = true;
            if (next.has(groupId)) {
                next.delete(groupId);
                expanded = true;
            } else {
                next.add(groupId);
                expanded = false;
            }
            void engineApi.setGroupExpanded(groupId, expanded).catch((err) => {
                console.error('[TrackInspector] setGroupExpanded failed:', err);
            });
            return next;
        });
    }, [onToggleGroupCollapseProp, backendCollapsedGroups]);

    const rowHeightsByTrackId = useMemo(() => {
        const next: Record<string, number> = {};
        for (const track of liveTracks) {
            if (track.type === 'master') {
                next[track.id] = rowHeightOverrides[track.id] ?? trackHeight;
                continue;
            }
            const persisted = Number.isFinite(track.height) ? track.height : trackHeight;
            const resolved = Math.max(24, Math.min(120, Math.round(persisted)));
            next[track.id] = rowHeightOverrides[track.id] ?? resolved;
        }
        next.master = rowHeightOverrides.master ?? trackHeight;
        return next;
    }, [liveTracks, rowHeightOverrides, trackHeight]);

    const isAncestorCollapsed = useCallback((track: TrackData): boolean => {
        let groupId = track.groupId;
        while (groupId) {
            if (collapsedGroups.has(groupId)) return true;
            groupId = trackById.get(groupId)?.groupId;
        }
        return false;
    }, [collapsedGroups, trackById]);

    const visibleTracks = useMemo(() => tracks.filter(t => !isAncestorCollapsed(t)), [tracks, isAncestorCollapsed]);

    const visibleTrackIndexById = useMemo(() => {
        const map = new Map<string, number>();
        for (let i = 0; i < visibleTracks.length; i += 1) map.set(visibleTracks[i].id, i);
        return map;
    }, [visibleTracks]);

    // ── Depth computation ───────────────────────────────────────────
    const depthByTrackId = useMemo(() => {
        const memo = new Map<string, number>();
        const visit = (id: string): number => {
            const cached = memo.get(id);
            if (cached != null) return cached;
            const t = trackById.get(id);
            if (!t?.groupId) {
                memo.set(id, 0);
                return 0;
            }
            const parentDepth = visit(t.groupId);
            const depth = parentDepth + 1;
            memo.set(id, depth);
            return depth;
        };
        for (const t of tracks) visit(t.id);
        return memo;
    }, [tracks, trackById]);

    const getDepth = useCallback((track: TrackData): number => {
        return depthByTrackId.get(track.id) ?? 0;
    }, [depthByTrackId]);

    // ── Layout metrics ──────────────────────────────────────────────
    const rowLayout = useMemo<TrackRowLayoutMetrics>(() => {
        const maxDepth = visibleTracks.reduce((acc, t) => Math.max(acc, getDepth(t)), 0);
        const headerColWidth = mixerFocusMode ? 112 : 100;
        const routingColWidth = mixerFocusMode ? 104 : 92;
        const groupStripeWidthPx = 6;
        const indentStepPx = 10;
        const maxIndentPx = Math.min(30, Math.max(0, maxDepth * indentStepPx));

        const muteSoloColWidth = mixerFocusMode ? 34 : 36;
        const faderColWidth = mixerFocusMode ? 84 : 62;
        const armColWidth = 16;
        const meterColWidth = 10;
        const mixerColumnGapPx = 6;
        const mixerPaddingX = 4;
        const mixerPaddingY = 4;
        const mixerSectionWidthPx =
            muteSoloColWidth
            + faderColWidth
            + armColWidth
            + meterColWidth
            + mixerColumnGapPx * 3
            + mixerPaddingX * 2;

        return {
            headerColWidth,
            routingColWidth,
            groupStripeWidthPx,
            indentStepPx,
            maxIndentPx,
            muteSoloColWidth,
            faderColWidth,
            armColWidth,
            meterColWidth,
            mixerColumnGapPx,
            mixerPaddingX,
            mixerPaddingY,
            mixerSectionWidthPx,
        };
    }, [visibleTracks, getDepth, mixerFocusMode]);

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
        masterColor,
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
