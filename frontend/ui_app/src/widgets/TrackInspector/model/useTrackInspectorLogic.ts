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
        projectTracks,
        engineSetTrackMute,
        engineSetTrackSolo,
        engineSetTrackVolume,
        engineSetTrackPan,
        engineSetMasterVolume,
        masterVolume,
        renameTrackAction,
        meters,
    } = useEngineStore(useShallow((s) => ({
        projectTracks: s.projectTracks,
        engineSetTrackMute: s.setTrackMute,
        engineSetTrackSolo: s.setTrackSolo,
        engineSetTrackVolume: s.setTrackVolume,
        engineSetTrackPan: s.setTrackPan,
        engineSetMasterVolume: s.setMasterVolume,
        masterVolume: s.masterVolume,
        renameTrackAction: s.renameTrack,
        meters: s.meters,
    })));

    const trackActiveStates = useMemo(() => {
        return projectTracks.map((_t, i, arr) => isTrackActive(i, arr));
    }, [projectTracks]);

    // ── Refs ───────────────────────────────────────────────────────
    const scrollRef = useRef<HTMLDivElement>(null);
    const lastProgrammaticScrollRef = useRef<number | null>(null);
    const resizeStartYRef = useRef(0);
    const resizeStartHeightRef = useRef(0);
    const resizeCurrentHeightRef = useRef(0);
    const dragPointerYRef = useRef<number | null>(null);
    const autoScrollRafRef = useRef<number | null>(null);
    const trackMoveInFlightRef = useRef(false);
    const suppressNextClickRef = useRef(false);
    const trackRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const draggingTrackIdRef = useRef<string | null>(null);

    // ── State ──────────────────────────────────────────────────────
    const [localOverrides, setLocalOverrides] = useState<Record<string, Partial<TrackData>>>({});
    const [localSelectedTrackIds, setLocalSelectedTrackIds] = useState<Set<string> | null>(null);
    const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null);
    const [dropInsertIndex, setDropInsertIndex] = useState<number | null>(null);
    const [groupDropTargetId, setGroupDropTargetId] = useState<string | null>(null);
    const [lastClickedTrackId, setLastClickedTrackId] = useState<string | null>(null);
    const [pointerDrag, setPointerDrag] = useState<{
        trackId: string;
        startX: number;
        startY: number;
        active: boolean;
    } | null>(null);
    const [rowHeightOverrides, setRowHeightOverrides] = useState<Record<string, number>>({});
    const [resizingTrackId, setResizingTrackId] = useState<string | null>(null);
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
        return {
            id: 'master', name: 'Master', type: 'master', color: masterColor,
            volume: masterVolume, pan: 0, isMuted: false, isSoloed: false, isArmed: false,
            vuLevel: Math.max(masterVuL, masterVuR),
            vuLevelL: masterVuL,
            vuLevelR: masterVuR,
            routing: '', sends: [], input: '', output: 'Main',
            height: trackHeight,
        };
    }, [meters, masterVolume, masterColor, trackHeight]);

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

    // ── Track controls ──────────────────────────────────────────────
    const toggleMute = useCallback((id: string) => {
        const track = tracks.find(t => t.id === id);
        if (track) {
            const idx = getTrackIndex(id);
            const newMuted = !track.isMuted;
            if (idx >= 0) engineSetTrackMute(idx, newMuted);
            setLocalOverrides(prev => ({ ...prev, [id]: { ...prev[id], isMuted: newMuted } }));
        }
    }, [tracks, getTrackIndex, engineSetTrackMute]);

    const toggleSolo = useCallback((id: string) => {
        const selected = selectedTrackIdSet.has(id)
            ? Array.from(selectedTrackIdSet)
            : [id];
        const targetIds = selected.length > 0 ? selected : [id];
        const targetSet = new Set(targetIds);

        const targetTracks = tracks.filter((t) => targetSet.has(t.id));
        if (targetTracks.length === 0) return;

        const allTargetsAlreadySolo = targetTracks.every((t) => t.isSoloed);
        const shouldSoloTargets = !allTargetsAlreadySolo;

        const nextSoloById = new Map<string, boolean>();
        for (const track of targetTracks) {
            if (track.type === 'master') continue;
            if (track.isSoloed !== shouldSoloTargets) {
                nextSoloById.set(track.id, shouldSoloTargets);
            }
        }

        if (nextSoloById.size === 0) return;

        for (const [trackId, soloed] of nextSoloById) {
            const idx = getTrackIndex(trackId);
            if (idx >= 0) engineSetTrackSolo(idx, soloed);
        }

        setLocalOverrides((prev) => {
            const next = { ...prev };
            for (const [trackId, soloed] of nextSoloById) {
                next[trackId] = { ...next[trackId], isSoloed: soloed };
            }
            return next;
        });
    }, [tracks, selectedTrackIdSet, getTrackIndex, engineSetTrackSolo]);

    const toggleArm = useCallback((id: string) => {
        const track = tracks.find(t => t.id === id);
        if (track) {
            const idx = getTrackIndex(id);
            const newArmed = !track.isArmed;
            if (idx >= 0) {
                void engineApi.armTrack(idx, newArmed).catch((err) => {
                    console.error('[TrackInspector] armTrack failed:', err);
                });
            }
            setLocalOverrides(prev => ({ ...prev, [id]: { ...prev[id], isArmed: newArmed } }));
        }
    }, [tracks, getTrackIndex]);

    const setTrackOutput = useCallback(async (trackId: string, targetId: string) => {
        try {
            await engineApi.setTrackRouting(trackId, targetId);
            setLocalOverrides(prev => ({ ...prev, [trackId]: { ...prev[trackId], output: targetId } }));
        } catch (err) {
            console.error('[TrackInspector] setTrackRouting failed:', err);
        }
    }, []);

    const setTrackInput = useCallback(async (trackId: string, inputId: string) => {
        try {
            await engineApi.setTrackInput(trackId, inputId);
            setLocalOverrides(prev => ({ ...prev, [trackId]: { ...prev[trackId], input: inputId } }));
        } catch (err) {
            console.error('[TrackInspector] setTrackInput failed:', err);
        }
    }, []);

    // ── Resize ──────────────────────────────────────────────────────
    const clampRowHeight = useCallback((raw: number) => {
        return Math.max(24, Math.min(120, Math.round(raw)));
    }, []);

    const beginRowResize = useCallback((trackId: string, startHeight: number, startY: number) => {
        resizeStartYRef.current = startY;
        resizeStartHeightRef.current = startHeight;
        resizeCurrentHeightRef.current = startHeight;
        setResizingTrackId(trackId);
    }, []);

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
    const isDescendantOf = useCallback((candidateId: string, ancestorId: string): boolean => {
        let current = tracks.find((t) => t.id === candidateId);
        while (current?.groupId) {
            if (current.groupId === ancestorId) return true;
            current = tracks.find((t) => t.id === current?.groupId);
        }
        return false;
    }, [tracks]);

    const findGroupTailInsertIndex = useCallback((groupId: string): number => {
        const groupIndex = tracks.findIndex((t) => t.id === groupId);
        if (groupIndex < 0) return tracks.length;
        let tail = groupIndex + 1;
        while (tail < tracks.length) {
            const candidate = tracks[tail];
            if (!isDescendantOf(candidate.id, groupId)) break;
            tail += 1;
        }
        return tail;
    }, [tracks, isDescendantOf]);

    const canDropTrackIntoGroup = useCallback((trackId: string, groupId: string): boolean => {
        const draggingTrack = tracks.find((t) => t.id === trackId);
        const targetGroup = tracks.find((t) => t.id === groupId);
        if (!draggingTrack || !targetGroup) return false;
        if (targetGroup.type !== 'group') return false;
        if (trackId === groupId) return false;
        if (isDescendantOf(groupId, trackId)) return false;
        return true;
    }, [tracks, isDescendantOf]);

    const computeRawInsertIndex = useCallback((visibleInsertIndex: number): number => {
        if (visibleTracks.length === 0) return 0;
        const fullIds = tracks.map((t) => t.id);
        if (visibleInsertIndex <= 0) {
            const firstVisible = visibleTracks[0];
            const idx = fullIds.indexOf(firstVisible.id);
            return Math.max(0, idx);
        }
        if (visibleInsertIndex >= visibleTracks.length) {
            const lastVisible = visibleTracks[visibleTracks.length - 1];
            const idx = fullIds.indexOf(lastVisible.id);
            return Math.min(tracks.length, idx + 1);
        }
        const nextVisible = visibleTracks[visibleInsertIndex];
        const idx = fullIds.indexOf(nextVisible.id);
        return Math.max(0, idx);
    }, [visibleTracks, tracks]);

    const resolveGroupAtVisibleInsertIndex = useCallback((visibleInsertIndex: number): string | null => {
        const prev = visibleInsertIndex > 0 ? visibleTracks[visibleInsertIndex - 1] : null;
        const next = visibleInsertIndex < visibleTracks.length ? visibleTracks[visibleInsertIndex] : null;
        const prevGroup = prev?.groupId ?? null;
        const nextGroup = next?.groupId ?? null;
        if (prevGroup && nextGroup && prevGroup === nextGroup) return prevGroup;
        if (prev?.type === 'group' && nextGroup === prev.id) return prev.id;
        if (next?.type === 'group' && prevGroup === next.id) return next.id;
        return null;
    }, [visibleTracks]);

    const computeGroupInsertIndex = useCallback((trackId: string, groupId: string, visibleInsertIndex: number | null): number => {
        const groupIndex = tracks.findIndex((t) => t.id === groupId);
        if (groupIndex < 0) return findGroupTailInsertIndex(groupId);
        const dragIndex = tracks.findIndex((t) => t.id === trackId);
        const groupStart = groupIndex + 1;
        let groupTail = findGroupTailInsertIndex(groupId);
        if (dragIndex >= groupStart && dragIndex < groupTail) {
            groupTail -= 1;
        }
        if (visibleInsertIndex == null) {
            return Math.max(groupStart, groupTail);
        }
        const rawInsertIndex = computeRawInsertIndex(visibleInsertIndex);
        const adjustedInsert = dragIndex >= 0 && rawInsertIndex > dragIndex
            ? rawInsertIndex - 1
            : rawInsertIndex;
        return Math.max(groupStart, Math.min(groupTail, adjustedInsert));
    }, [tracks, findGroupTailInsertIndex, computeRawInsertIndex]);

    const commitTrackReorder = useCallback((trackId: string, visibleInsertIndex: number) => {
        const fullIndex = tracks.findIndex((t) => t.id === trackId);
        if (fullIndex < 0) return;
        const rawInsertIndex = computeRawInsertIndex(visibleInsertIndex);
        const adjustedInsert = rawInsertIndex > fullIndex ? rawInsertIndex - 1 : rawInsertIndex;
        const clamped = Math.max(0, Math.min(tracks.length - 1, adjustedInsert));
        if (clamped === fullIndex) return;
        if (trackMoveInFlightRef.current) return;
        trackMoveInFlightRef.current = true;

        void engineApi.moveTrackToIndexWithDeltas(trackId, clamped).then(async (response) => {
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:move-track');
        }).catch((err) => {
            console.error('[TrackInspector] moveTrackToIndexWithDeltas(reorder) failed:', err);
        }).finally(() => {
            trackMoveInFlightRef.current = false;
        });
    }, [tracks, computeRawInsertIndex]);

    const resetTrackDragState = useCallback(() => {
        draggingTrackIdRef.current = null;
        setDropInsertIndex(null);
        setGroupDropTargetId(null);
        setDraggingTrackId(null);
        window.__dreamInAppDrag = false;
    }, []);

    const commitDraggedTrackToVisibleIndex = useCallback((dragId: string, visibleIndex: number) => {
        const draggingTrack = tracks.find((t) => t.id === dragId);
        if (!draggingTrack) return;
        if (draggingTrack.type === 'group') {
            const rawInsertIndex = computeRawInsertIndex(visibleIndex);
            void engineApi.moveTrackBlockToIndex(dragId, rawInsertIndex).then(() => {
                debouncedFetchProject('move-group-block');
            }).catch((err) => {
                console.error('[TrackInspector] moveTrackBlockToIndex failed:', err);
            });
            return;
        }
        commitTrackReorder(dragId, visibleIndex);
    }, [tracks, computeRawInsertIndex, commitTrackReorder]);

    const computeVisibleInsertIndexFromClientY = useCallback((clientY: number) => {
        if (visibleTracks.length === 0) return 0;
        for (let i = 0; i < visibleTracks.length; i += 1) {
            const track = visibleTracks[i];
            const row = trackRowRefs.current[track.id];
            if (!row) continue;
            const rect = row.getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) {
                return i;
            }
        }
        return visibleTracks.length;
    }, [visibleTracks]);

    const resolveDropTargetFromClientY = useCallback((clientY: number, dragId: string) => {
        const draggingTrack = tracks.find((t) => t.id === dragId);
        for (let i = 0; i < visibleTracks.length; i += 1) {
            const track = visibleTracks[i];
            const row = trackRowRefs.current[track.id];
            if (!row) continue;
            const rect = row.getBoundingClientRect();
            if (clientY < rect.top || clientY > rect.bottom) continue;
            const canNestIntoGroup = Boolean(
                draggingTrack
                && track.type === 'group'
                && dragId !== track.id
                && !isDescendantOf(track.id, dragId),
            );
            if (canNestIntoGroup) {
                const edgeZone = Math.max(4, rect.height * 0.12);
                const topZone = rect.top + edgeZone;
                const bottomZone = rect.bottom - edgeZone;
                if (clientY >= topZone && clientY <= bottomZone) {
                    return { groupId: track.id, insertIndex: null as number | null };
                }
            }
            const insertBefore = clientY < rect.top + rect.height / 2;
            const insertIndex = insertBefore ? i : i + 1;
            const boundaryGroupId = resolveGroupAtVisibleInsertIndex(insertIndex);
            if (boundaryGroupId && canDropTrackIntoGroup(dragId, boundaryGroupId)) {
                return { groupId: boundaryGroupId, insertIndex };
            }
            return { groupId: null as string | null, insertIndex };
        }
        const boundaryGroupId = resolveGroupAtVisibleInsertIndex(visibleTracks.length);
        if (boundaryGroupId && canDropTrackIntoGroup(dragId, boundaryGroupId)) {
            return { groupId: boundaryGroupId, insertIndex: visibleTracks.length };
        }
        return { groupId: null as string | null, insertIndex: visibleTracks.length };
    }, [tracks, visibleTracks, isDescendantOf, resolveGroupAtVisibleInsertIndex, canDropTrackIntoGroup]);

    const commitTrackToGroup = useCallback((trackId: string, groupId: string, visibleInsertIndex: number | null = null) => {
        if (!canDropTrackIntoGroup(trackId, groupId)) return;
        if (trackMoveInFlightRef.current) return;
        const draggingTrack = tracks.find((t) => t.id === trackId);
        const targetIndex = computeGroupInsertIndex(trackId, groupId, visibleInsertIndex);
        const dragIndex = tracks.findIndex((t) => t.id === trackId);
        if (dragIndex >= 0) {
            const noOpIndex = targetIndex > dragIndex ? targetIndex - 1 : targetIndex;
            if (dragIndex === noOpIndex && draggingTrack?.groupId === groupId) return;
        }
        trackMoveInFlightRef.current = true;
        void engineApi.moveTrackWithParent(trackId, targetIndex, groupId).then(() => {
            debouncedFetchProject('move-to-group');
        }).catch((err) => {
            console.error('[TrackInspector] moveTrackWithParent(group drop) failed:', err);
        }).finally(() => {
            trackMoveInFlightRef.current = false;
        });
    }, [canDropTrackIntoGroup, computeGroupInsertIndex, tracks]);

    const beginHeaderPointerDrag = useCallback((e: React.PointerEvent<HTMLDivElement>, trackId: string) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement;
        if (target.closest('button,input,select,textarea,[contenteditable="true"]')) return;
        setPointerDrag({
            trackId,
            startX: e.clientX,
            startY: e.clientY,
            active: false,
        });
    }, []);

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

    // Drag event listeners
    useEffect(() => {
        if (!draggingTrackId) return;
        const clearInAppDrag = () => { window.__dreamInAppDrag = false; };
        window.addEventListener('dragend', clearInAppDrag);
        window.addEventListener('drop', clearInAppDrag);
        return () => {
            window.removeEventListener('dragend', clearInAppDrag);
            window.removeEventListener('drop', clearInAppDrag);
        };
    }, [draggingTrackId]);

    // Resize pointer tracking
    useEffect(() => {
        if (!resizingTrackId) return;
        const onPointerMove = (e: PointerEvent) => {
            e.preventDefault();
            const dy = e.clientY - resizeStartYRef.current;
            const nextHeight = clampRowHeight(resizeStartHeightRef.current + dy);
            resizeCurrentHeightRef.current = nextHeight;
            setRowHeightOverrides((prev) => {
                if (resizingTrackId === 'master') {
                    if (prev.master === nextHeight) return prev;
                    return { ...prev, master: nextHeight };
                }
                if (prev[resizingTrackId] === nextHeight) return prev;
                return { ...prev, [resizingTrackId]: nextHeight };
            });
            applyTrackHeightOptimistic(resizingTrackId, nextHeight);
        };
        const onPointerUp = () => {
            const finalTrackId = resizingTrackId;
            const finalHeight = clampRowHeight(resizeCurrentHeightRef.current || resizeStartHeightRef.current);
            setResizingTrackId(null);
            if (finalTrackId && finalTrackId !== 'master') {
                applyTrackHeightOptimistic(finalTrackId, finalHeight);
                void engineApi.setTrackHeight(finalTrackId, finalHeight).catch((err) => {
                    console.error('[TrackInspector] setTrackHeight failed:', err);
                });
            }
        };
        window.addEventListener('pointermove', onPointerMove, { passive: false });
        window.addEventListener('pointerup', onPointerUp);
        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
        };
    }, [resizingTrackId, clampRowHeight, applyTrackHeightOptimistic]);

    // Keyboard shortcuts
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName?.toLowerCase();
            const isTextInput = tag === 'input' || tag === 'textarea' || target?.isContentEditable;
            if (isTextInput || renamingTrackId !== null) return;

            if ((e.metaKey || e.ctrlKey) && e.key === 'r' && selectedTrackId && selectedTrackId !== 'master') {
                e.preventDefault();
                handleRenameStart(selectedTrackId);
            }
            if ((e.metaKey || e.ctrlKey) && e.code === 'KeyG' && selectedTrackId && selectedTrackId !== 'master') {
                e.preventDefault();
                const ids = Array.from(selectedTrackIdSet);
                if (ids.length > 1) {
                    void engineApi.createGroup(ids).then(() => {
                        debouncedFetchProject('create-group-multi');
                    }).catch((err) => {
                        console.error('[TrackInspector] createGroup(multi) failed:', err);
                    });
                } else {
                    handleGroupTrack(selectedTrackId);
                }
            }
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyG' && selectedTrackId && selectedTrackId !== 'master') {
                e.preventDefault();
                const selected = tracks.find((t) => t.id === selectedTrackId);
                const groupToUngroup = selected?.type === 'group' ? selected.id : (selected?.groupId ?? null);
                if (groupToUngroup) {
                    void engineApi.ungroupTrack(groupToUngroup).then(() => {
                        debouncedFetchProject('ungroup-shortcut');
                    }).catch((err) => {
                        console.error('[TrackInspector] ungroupTrack failed:', err);
                    });
                }
            }
            if ((e.metaKey || e.ctrlKey) && e.code === 'KeyD' && selectedTrackIdSet.size > 0) {
                e.preventDefault();
                handleDuplicateSelectedTracks();
            }
            if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTrackIdSet.size > 0) {
                const tgt = e.target as HTMLElement;
                if (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable) return;
                const inDeviceRack = (e.target as HTMLElement | null)?.closest?.('[data-keyboard-scope="device-rack"]');
                if (inDeviceRack) return;
                if (renamingTrackId) return;
                e.preventDefault();
                e.stopPropagation();
                handleDeleteSelectedTracks();
            }
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [selectedTrackId, selectedTrackIdSet, tracks, renamingTrackId, handleRenameStart, handleGroupTrack, handleDeleteSelectedTracks, handleDuplicateSelectedTracks]);

    // Pointer drag tracking
    useEffect(() => {
        if (!pointerDrag) return;
        dragPointerYRef.current = pointerDrag.startY;

        const onPointerMove = (e: PointerEvent) => {
            const dx = e.clientX - pointerDrag.startX;
            const dy = e.clientY - pointerDrag.startY;
            const distance = Math.hypot(dx, dy);
            dragPointerYRef.current = e.clientY;
            if (!pointerDrag.active && distance < 4) return;
            if (!pointerDrag.active) {
                draggingTrackIdRef.current = pointerDrag.trackId;
                setDraggingTrackId(pointerDrag.trackId);
                setPointerDrag((prev) => (prev ? { ...prev, active: true } : prev));
                window.__dreamInAppDrag = true;
            }
            const target = resolveDropTargetFromClientY(e.clientY, pointerDrag.trackId);
            setGroupDropTargetId(target.groupId);
            setDropInsertIndex(target.insertIndex);
            e.preventDefault();
        };

        const runAutoScroll = () => {
            autoScrollRafRef.current = window.requestAnimationFrame(runAutoScroll);
            const y = dragPointerYRef.current;
            if (!pointerDrag.active || y == null) return;
            const listEl = scrollRef.current;
            if (!listEl) return;
            const rect = listEl.getBoundingClientRect();
            const edgeSize = 42;
            let velocity = 0;
            if (y < rect.top + edgeSize) {
                const t = (rect.top + edgeSize - y) / edgeSize;
                velocity = -Math.max(2, Math.min(16, t * 16));
            } else if (y > rect.bottom - edgeSize) {
                const t = (y - (rect.bottom - edgeSize)) / edgeSize;
                velocity = Math.max(2, Math.min(16, t * 16));
            }
            if (velocity === 0) return;
            const maxScroll = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
            const nextScrollTop = Math.max(0, Math.min(maxScroll, listEl.scrollTop + velocity));
            if (nextScrollTop === listEl.scrollTop) return;
            listEl.scrollTop = nextScrollTop;
            const activeDragId = draggingTrackIdRef.current ?? draggingTrackId ?? pointerDrag.trackId;
            if (!activeDragId) return;
            const target = resolveDropTargetFromClientY(y, activeDragId);
            setGroupDropTargetId(target.groupId);
            setDropInsertIndex(target.insertIndex);
        };

        const onPointerUp = (e: PointerEvent) => {
            const activeDragId = draggingTrackIdRef.current ?? draggingTrackId;
            if (pointerDrag.active && activeDragId) {
                if (groupDropTargetId && canDropTrackIntoGroup(activeDragId, groupDropTargetId)) {
                    commitTrackToGroup(activeDragId, groupDropTargetId, dropInsertIndex);
                    suppressNextClickRef.current = true;
                    setPointerDrag(null);
                    resetTrackDragState();
                    return;
                }
                const target = resolveDropTargetFromClientY(e.clientY, activeDragId);
                if (target.groupId && canDropTrackIntoGroup(activeDragId, target.groupId)) {
                    commitTrackToGroup(activeDragId, target.groupId, target.insertIndex);
                } else {
                    const idx = target.insertIndex ?? computeVisibleInsertIndexFromClientY(e.clientY);
                    commitDraggedTrackToVisibleIndex(activeDragId, idx);
                }
                suppressNextClickRef.current = true;
            }
            setPointerDrag(null);
            resetTrackDragState();
        };

        autoScrollRafRef.current = window.requestAnimationFrame(runAutoScroll);
        window.addEventListener('pointermove', onPointerMove, { passive: false });
        window.addEventListener('pointerup', onPointerUp);
        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            if (autoScrollRafRef.current !== null) {
                window.cancelAnimationFrame(autoScrollRafRef.current);
                autoScrollRafRef.current = null;
            }
            dragPointerYRef.current = null;
        };
    }, [
        pointerDrag,
        draggingTrackId,
        computeVisibleInsertIndexFromClientY,
        commitDraggedTrackToVisibleIndex,
        commitTrackToGroup,
        canDropTrackIntoGroup,
        resolveDropTargetFromClientY,
        groupDropTargetId,
        dropInsertIndex,
        resetTrackDragState,
    ]);

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
