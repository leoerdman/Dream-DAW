import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import * as engineApi from '@/shared/api/engine';
import { scrollSync } from '@/shared/lib/useScrollSync';
import { isTrackActive } from '@/shared/utils/routing';
import { ContextMenuPopup } from '@/widgets/TrackInspector/ui/ContextMenuPopup';
import { ColorPickerPopup } from '@/widgets/TrackInspector/ui/ColorPickerPopup';
import type { TrackData, TrackRowLayoutMetrics } from '@/widgets/TrackInspector/model/trackModels';
import { mapProjectTrack } from '@/widgets/TrackInspector/model/trackModels';
import { TrackRow } from '@/widgets/TrackInspector/ui/TrackRow';

// ── BUG-P4 FIX: Debounced project refresh ──────────────────────────────
// Every context-menu action (color, bounce, stems, reorder) was calling
// fetchProject() directly, triggering full project.clone() + Serde JSON +
// IPC round-trip on each one. Coalesce into a single fetch per 100ms window.
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
    const projectTracks = useEngineStore((s) => s.projectTracks);
    const trackActiveStates = useMemo(() => {
        return projectTracks.map((_t, i, arr) => isTrackActive(i, arr));
    }, [projectTracks]);
    const engineSetTrackMute = useEngineStore((s) => s.setTrackMute);
    const engineSetTrackSolo = useEngineStore((s) => s.setTrackSolo);
    const engineSetTrackVolume = useEngineStore((s) => s.setTrackVolume);
    const engineSetTrackPan = useEngineStore((s) => s.setTrackPan);
    const engineSetMasterVolume = useEngineStore((s) => s.setMasterVolume);
    const masterVolume = useEngineStore((s) => s.masterVolume);
    const [masterColor, setMasterColor] = useState('#2b2f36');
    const renameTrackAction = useEngineStore((s) => s.renameTrack);
    const meters = useEngineStore((s) => s.meters);
    const scrollRef = useRef<HTMLDivElement>(null);
    /**
     * Enterprise scroll sync: subscribe to scrollSync for timeline-originated scroll.
     * Directly sets DOM scrollTop — no React state, no re-renders.
     */
    const lastProgrammaticScrollRef = useRef<number | null>(null);

    useEffect(() => {
        const unsub = scrollSync.subscribe('inspector', (y) => {
            if (scrollRef.current) {
                lastProgrammaticScrollRef.current = y;
                scrollRef.current.scrollTop = y;
            }
        });
        return unsub;
    }, []);

    const liveTracks = useMemo((): TrackData[] => {
        const mapped = projectTracks.map((pt, idx) =>
            mapProjectTrack(pt, idx, meters.tracks[idx]),
        );
        // Enterprise group meter aggregation: groups show the max peak
        // of their children, since the backend doesn't meter group buses.
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

    // Local overrides
    const [localOverrides, setLocalOverrides] = useState<Record<string, Partial<TrackData>>>({});
    const [localSelectedTrackIds, setLocalSelectedTrackIds] = useState<Set<string>>(
        () => new Set(selectedTrackId && selectedTrackId !== 'master' ? [selectedTrackId] : []),
    );

    const effectiveSelectedTrackIds = useMemo(() => (
        selectedTrackIdsProp ?? Array.from(localSelectedTrackIds)
    ), [selectedTrackIdsProp, localSelectedTrackIds]);

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
    const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null);
    const draggingTrackIdRef = useRef<string | null>(null);
    const [dropInsertIndex, setDropInsertIndex] = useState<number | null>(null);
    const [groupDropTargetId, setGroupDropTargetId] = useState<string | null>(null);
    const [lastClickedTrackId, setLastClickedTrackId] = useState<string | null>(null);
    const [pointerDrag, setPointerDrag] = useState<{
        trackId: string;
        startX: number;
        startY: number;
        active: boolean;
    } | null>(null);
    const [rowHeightsByTrackId, setRowHeightsByTrackId] = useState<Record<string, number>>({});
    const [resizingTrackId, setResizingTrackId] = useState<string | null>(null);
    const resizeStartYRef = useRef(0);
    const resizeStartHeightRef = useRef(0);
    const resizeCurrentHeightRef = useRef(0);
    const dragPointerYRef = useRef<number | null>(null);
    const autoScrollRafRef = useRef<number | null>(null);
    const trackMoveInFlightRef = useRef(false);
    const suppressNextClickRef = useRef(false);
    const trackRowRefs = useRef<Record<string, HTMLDivElement | null>>({});

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

    // Context menu
    const [contextMenu, setContextMenu] = useState<{
        trackId: string | null; trackIndex: number | null; x: number; y: number;
    } | null>(null);

    // Color picker (opened from context menu)
    const [colorPickerState, setColorPickerState] = useState<{
        trackId: string; x: number; y: number;
    } | null>(null);

    // Inline rename
    const [renamingTrackId, setRenamingTrackId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');

    useEffect(() => {
        setRowHeightsByTrackId((prev) => {
            const next: Record<string, number> = {};
            let changed = false;
            for (const track of liveTracks) {
                if (track.type === 'master') {
                    next[track.id] = prev[track.id] ?? trackHeight;
                    continue;
                }
                const persisted = Number.isFinite(track.height) ? track.height : trackHeight;
                const resolved = Math.max(24, Math.min(120, Math.round(persisted)));
                if (prev[track.id] !== resolved) changed = true;
                next[track.id] = resolved;
            }
            if (prev.master != null) next.master = prev.master;
            else next.master = trackHeight;
            if (Object.keys(prev).length !== Object.keys(next).length) changed = true;
            if (!changed) return prev;
            return next;
        });
    }, [liveTracks, trackHeight]);

    useEffect(() => {
        if (selectedTrackIdsProp) return; // shell owns selection
        setLocalSelectedTrackIds((prev) => {
            if (!selectedTrackId || selectedTrackId === 'master') {
                return prev.size === 0 ? prev : new Set();
            }
            if (prev.has(selectedTrackId)) return prev;
            return new Set([selectedTrackId]);
        });
    }, [selectedTrackId, selectedTrackIdsProp]);

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

    // ── Collapse state: prefer controlled props from parent (DawShell sync) ──
    const [localCollapsedGroups, setLocalCollapsedGroups] = useState<Set<string>>(new Set());
    const collapsedGroups = collapsedGroupsProp ?? localCollapsedGroups;

    // Sync from backend only when uncontrolled
    useEffect(() => {
        if (collapsedGroupsProp) return; // Parent owns the state
        const collapsed = new Set<string>();
        for (const pt of projectTracks) {
            const normalized = (pt.track_type ?? '').toLowerCase();
            if ((normalized === 'group') && pt.is_expanded === false) {
                collapsed.add(pt.id);
            }
        }
        setLocalCollapsedGroups(collapsed);
    }, [projectTracks, collapsedGroupsProp]);

    const toggleGroupCollapse = useCallback((groupId: string) => {
        if (onToggleGroupCollapseProp) {
            onToggleGroupCollapseProp(groupId);
            return;
        }
        // Fallback: local state management
        setLocalCollapsedGroups(prev => {
            const next = new Set(prev);
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
    }, [onToggleGroupCollapseProp]);

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

    const clampRowHeight = useCallback((raw: number) => {
        const min = 24;
        const max = 120;
        return Math.max(min, Math.min(max, Math.round(raw)));
    }, []);

    const beginRowResize = useCallback((trackId: string, startHeight: number, startY: number) => {
        resizeStartYRef.current = startY;
        resizeStartHeightRef.current = startHeight;
        resizeCurrentHeightRef.current = startHeight;
        setResizingTrackId(trackId);
    }, []);

    const applyTrackHeightOptimistic = useCallback((trackId: string, height: number) => {
        if (!trackId || trackId === 'master') return;
        useEngineStore.setState((state) => ({
            projectTracks: state.projectTracks.map((track) => (
                track.id === trackId ? { ...track, height } : track
            )),
        }));
    }, []);

    useEffect(() => {
        if (!resizingTrackId) return;

        const onPointerMove = (e: PointerEvent) => {
            e.preventDefault();
            const dy = e.clientY - resizeStartYRef.current;
            const nextHeight = clampRowHeight(resizeStartHeightRef.current + dy);
            resizeCurrentHeightRef.current = nextHeight;
            setRowHeightsByTrackId((prev) => {
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

    // ── Context Menu handlers ──
    const handleContextMenu = useCallback((e: React.MouseEvent, trackId: string, trackIndex: number) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ trackId, trackIndex, x: e.clientX, y: e.clientY });
    }, []);

    const handleAddTrackFromContext = useCallback((trackType: 'audio' | 'midi') => {
        const insertAfterIndex = contextMenu?.trackIndex;
        const resolvedInsertAfter = Number.isInteger(insertAfterIndex) && (insertAfterIndex ?? -1) >= 0
            ? (insertAfterIndex as number)
            : null;
        void engineApi.addTrackAdvanced(trackType, resolvedInsertAfter, undefined, contextMenu?.trackId ?? null)
            .then(() => debouncedFetchProject(`track-context:add-${trackType}`))
            .catch((err) => {
                console.error(`[TrackInspector] add ${trackType} track failed:`, err);
            });
        setContextMenu(null);
    }, [contextMenu]);

    const handleRenameStart = useCallback((trackId: string) => {
        const track = tracks.find(t => t.id === trackId);
        if (track) {
            setRenamingTrackId(trackId);
            setRenameValue(track.name);
        }
        setContextMenu(null);
    }, [tracks]);

    const handleRenameCommit = useCallback(() => {
        if (renamingTrackId && renameValue.trim()) {
            const idx = getTrackIndex(renamingTrackId);
            if (idx >= 0) renameTrackAction(idx, renameValue.trim());
        }
        setRenamingTrackId(null);
        setRenameValue('');
    }, [renamingTrackId, renameValue, getTrackIndex, renameTrackAction]);

    const handleRenameCancel = useCallback(() => {
        setRenamingTrackId(null);
        setRenameValue('');
    }, []);

    // BUG-FIX: Single-track delete now selects the adjacent surviving track
    // and prunes stale localOverrides. Previously selected nothing → random.
    const handleDeleteTrack = useCallback((trackId: string) => {
        const idx = getTrackIndex(trackId);
        if (idx < 0) { setContextMenu(null); return; }

        // Pre-compute survivor BEFORE delete
        const nonMaster = liveTracks.filter(t => t.type !== 'master');
        const posInNonMaster = nonMaster.findIndex(t => t.id === trackId);
        let nextId: string | null = null;
        // Try the track below, then above
        if (posInNonMaster >= 0) {
            if (posInNonMaster + 1 < nonMaster.length) nextId = nonMaster[posInNonMaster + 1].id;
            else if (posInNonMaster - 1 >= 0) nextId = nonMaster[posInNonMaster - 1].id;
        }

        void (async () => {
            await engineApi.deleteTrack(idx);
            // BUG-FIX: Prune stale localOverrides for deleted track
            setLocalOverrides(prev => {
                if (!(trackId in prev)) return prev;
                const next = { ...prev };
                delete next[trackId];
                return next;
            });
            // BUG-FIX: Select adjacent surviving track
            if (onSelectTrack) onSelectTrack(nextId ?? 'master');
            if (selectedTrackIdsProp) {
                onSelectTracks?.(nextId ? [nextId] : [], nextId ?? 'master');
            } else {
                setLocalSelectedTrackIds(nextId ? new Set([nextId]) : new Set());
            }
            debouncedFetchProject('delete-single');
        })().catch(err => console.error('[TrackInspector] deleteTrack failed:', err));
        setContextMenu(null);
    }, [getTrackIndex, liveTracks, onSelectTrack, onSelectTracks, selectedTrackIdsProp]);

    // BUG-FIX: Batch delete now uses raw engineApi.deleteTrack to avoid N
    // intermediate fetchProject calls. Single atomic refresh after all deletes.
    // Also fixes: wrong survivor index (used filtered nonMasterTracks instead of
    // liveTracks), localOverrides leak, and missing race guard.
    const deletionInFlightRef = useRef(false);
    const handleDeleteSelectedTracks = useCallback(() => {
        if (deletionInFlightRef.current) return; // Race guard
        const selected = Array.from(selectedTrackIdSet)
            .map((id) => ({ id, idx: getTrackIndex(id) }))
            .filter((v) => v.idx >= 0)
            .sort((a, b) => b.idx - a.idx); // Delete from bottom to top (indices stable)
        if (selected.length === 0) return;
        deletionInFlightRef.current = true;

        // Use liveTracks (engine order) for survivor resolution, not filtered array
        const deletedIds = new Set(selected.map((s) => s.id));
        const lowestDeletedIdx = Math.min(...selected.map((s) => s.idx));

        // Walk backwards from lowest deleted to find first surviving track
        let nextSelectedId: string | null = null;
        for (let i = lowestDeletedIdx - 1; i >= 0; i--) {
            const candidate = liveTracks[i];
            if (candidate && candidate.type !== 'master' && !deletedIds.has(candidate.id)) {
                nextSelectedId = candidate.id;
                break;
            }
        }
        // If nothing above, try first surviving after deleted ones
        if (!nextSelectedId) {
            for (let i = lowestDeletedIdx + 1; i < liveTracks.length; i++) {
                const candidate = liveTracks[i];
                if (candidate && candidate.type !== 'master' && !deletedIds.has(candidate.id)) {
                    nextSelectedId = candidate.id;
                    break;
                }
            }
        }

        void (async () => {
            // BUG-FIX: Call raw engineApi.deleteTrack directly, not store.deleteTrack,
            // to avoid N intermediate fetchProject setTimeout calls per iteration.
            // Indices are sorted descending, so earlier indices remain valid.
            for (const item of selected) {
                await engineApi.deleteTrack(item.idx);
            }

            // BUG-FIX: Prune stale localOverrides for ALL deleted tracks
            setLocalOverrides(prev => {
                let changed = false;
                const next = { ...prev };
                for (const id of deletedIds) {
                    if (id in next) { delete next[id]; changed = true; }
                }
                return changed ? next : prev;
            });

            // Select survivor
            if (selectedTrackIdsProp) {
                onSelectTracks?.(nextSelectedId ? [nextSelectedId] : [], nextSelectedId ?? 'master');
            } else {
                setLocalSelectedTrackIds(nextSelectedId ? new Set([nextSelectedId]) : new Set());
            }
            if (onSelectTrack) onSelectTrack(nextSelectedId ?? 'master');

            // Single atomic project refresh
            debouncedFetchProject('delete-selected');
        })().catch((err) => {
            console.error('[TrackInspector] delete selected tracks failed:', err);
        }).finally(() => {
            deletionInFlightRef.current = false;
        });
    }, [selectedTrackIdSet, getTrackIndex, liveTracks, onSelectTracks, onSelectTrack, selectedTrackIdsProp]);

    const handleDuplicateSelectedTracks = useCallback(() => {
        const ids = Array.from(selectedTrackIdSet);
        if (ids.length === 0) return;
        void engineApi.duplicateTracks(ids).then(() => {
            debouncedFetchProject('duplicate-selected');
            return;
        }).catch((err) => {
            console.error('[TrackInspector] duplicate selected tracks failed:', err);
        });
    }, [selectedTrackIdSet]);

    const handleGroupTrack = useCallback((trackId: string) => {
        void engineApi.createGroup([trackId]).then(() => {
            debouncedFetchProject('create-group');
        }).catch((err) => {
            console.error('[TrackInspector] createGroup failed:', err);
        });
        setContextMenu(null);
    }, []);

    const handleUngroupTrack = useCallback((trackId: string) => {
        const target = tracks.find((t) => t.id === trackId);
        const op = target?.type === 'group'
            ? engineApi.ungroupTrack(trackId)
            : engineApi.setTrackGroup(trackId, null);
        void op.then(() => {
            debouncedFetchProject('ungroup');
        }).catch((err) => {
            console.error('[TrackInspector] ungroup failed:', err);
        });
        setContextMenu(null);
    }, [tracks]);

    const handleOpenColorPicker = useCallback((trackId: string, x: number, y: number) => {
        setColorPickerState({ trackId, x, y });
        setContextMenu(null);
    }, []);

    const handleColorSelect = useCallback((trackId: string, color: string) => {
        if (trackId === 'master') {
            setMasterColor(color);
            setColorPickerState(null);
            return;
        }
        setLocalOverrides(prev => ({ ...prev, [trackId]: { ...prev[trackId], color } }));
        void engineApi.setTrackColor(trackId, color)
            .then(() => debouncedFetchProject('track-color-change'))
            .catch((err) => {
                console.error('[TrackInspector] setTrackColor failed:', err);
            });
        setColorPickerState(null);
    }, []);

    const handlePaintClipsWithTrackColor = useCallback((trackId: string) => {
        void engineApi.paintTrackClipsWithTrackColor(trackId)
            .then(() => debouncedFetchProject('track-context:paint-clips-with-track-color'))
            .catch((err) => {
                console.error('[TrackInspector] paintTrackClipsWithTrackColor failed:', err);
            });
        setContextMenu(null);
    }, []);

    /** Paint all children of a group track with the group's color. */
    const handlePaintGroupColor = useCallback((groupTrackId: string) => {
        const group = tracks.find((t) => t.id === groupTrackId);
        if (!group || group.type !== 'group') return;
        const groupColor = group.color;
        const children = tracks.filter((t) => t.groupId === groupTrackId);
        if (children.length === 0) return;
        void Promise.all(
            children.map((child) => engineApi.setTrackColor(child.id, groupColor)),
        )
            .then(() => debouncedFetchProject('track-context:paint-group-color'))
            .catch((err) => {
                console.error('[TrackInspector] paintGroupColor failed:', err);
            });
        setContextMenu(null);
    }, [tracks]);

    const handleBounceTrack = useCallback((trackId: string) => {
        void engineApi.bounceTrack(trackId)
            .then(() => debouncedFetchProject('track-context:bounce-track'))
            .catch((err) => {
                console.error('[TrackInspector] bounceTrack failed:', err);
            });
        setContextMenu(null);
    }, []);

    const handleBounceGroup = useCallback((groupTrackId: string) => {
        void engineApi.bounceGroup(groupTrackId)
            .then(() => debouncedFetchProject('track-context:bounce-group'))
            .catch((err) => {
                console.error('[TrackInspector] bounceGroup failed:', err);
            });
        setContextMenu(null);
    }, []);

    const handleSplitTrackToStems = useCallback((trackId: string) => {
        void engineApi.splitTrackToStems(trackId)
            .then(() => debouncedFetchProject('track-context:split-to-stems'))
            .catch((err) => {
                console.error('[TrackInspector] splitTrackToStems failed:', err);
            });
        setContextMenu(null);
    }, []);

    // ── Cmd+R keyboard shortcut for rename ──
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName?.toLowerCase();
            const isTextInput =
                tag === 'input' ||
                tag === 'textarea' ||
                target?.isContentEditable;
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
                // Guard: don't delete tracks when typing in text fields
                const tgt = e.target as HTMLElement;
                if (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable) return;
                // Guard: don't delete tracks if a device is focused in DeviceRack
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

    const commitTrackReorder = useCallback((trackId: string, visibleInsertIndex: number) => {
        const fullIndex = tracks.findIndex((t) => t.id === trackId);
        if (fullIndex < 0) return;
        const currentParentGroupId = tracks[fullIndex]?.groupId ?? null;
        const rawInsertIndex = computeRawInsertIndex(visibleInsertIndex);
        const adjustedInsert = rawInsertIndex > fullIndex ? rawInsertIndex - 1 : rawInsertIndex;
        const clamped = Math.max(0, Math.min(tracks.length - 1, adjustedInsert));
        if (clamped === fullIndex) return;
        if (trackMoveInFlightRef.current) return;
        trackMoveInFlightRef.current = true;

        void engineApi.moveTrackWithParent(trackId, clamped, currentParentGroupId).then(() => {
            debouncedFetchProject('move-track');
        }).catch((err) => {
            console.error('[TrackInspector] moveTrackWithParent(reorder) failed:', err);
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
                ref={scrollRef}
                className="scrollbar-hide"
                style={{
                    flex: 1,
                    overflowY: 'auto',
                    overflowX: 'hidden',
                    paddingRight: 2,
                    boxSizing: 'border-box',
                }}
                onScroll={() => {
                    const el = scrollRef.current;
                    if (!el) return;
                    const pos = el.scrollTop;
                    // Suppress echo from programmatic scrollTop assignment
                    if (lastProgrammaticScrollRef.current !== null
                        && Math.abs(pos - lastProgrammaticScrollRef.current) < 1) {
                        lastProgrammaticScrollRef.current = null;
                        return;
                    }
                    lastProgrammaticScrollRef.current = null;
                    scrollSync.setScrollY(pos, 'inspector');
                }}
                onContextMenu={(e) => {
                    const target = e.target as HTMLElement | null;
                    if (target?.closest?.('[data-track-row="true"]')) return;
                    e.preventDefault();
                    setContextMenu({ trackId: null, trackIndex: null, x: e.clientX, y: e.clientY });
                }}
                onDragOver={(e) => {
                    const activeDragId = draggingTrackIdRef.current ?? draggingTrackId;
                    if (!activeDragId) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(e) => {
                    const activeDragId = draggingTrackIdRef.current ?? draggingTrackId;
                    if (!activeDragId) return;
                    e.preventDefault();
                    const dragId = activeDragId || e.dataTransfer.getData('text/plain');
                    if (!dragId) {
                        resetTrackDragState();
                        return;
                    }
                    if (groupDropTargetId && canDropTrackIntoGroup(dragId, groupDropTargetId)) {
                        commitTrackToGroup(dragId, groupDropTargetId, dropInsertIndex);
                        Promise.resolve().finally(() => {
                            resetTrackDragState();
                        });
                        return;
                    }
                    const targetVisibleIndex = dropInsertIndex ?? visibleTracks.length;
                    commitDraggedTrackToVisibleIndex(dragId, targetVisibleIndex);
                    resetTrackDragState();
                }}
            >
                {dropInsertIndex === 0 && (
                    <div className="track-drop-insert-line" />
                )}
                {visibleTracks.map((track) => {
                    const isGroup = track.type === 'group';
                    if (track.type !== 'master') trackNum++;
                    const displayNum = track.type === 'master' ? undefined : trackNum;
                    const isCollapsed = isGroup ? collapsedGroups.has(track.id) : false;
                    const depth = getDepth(track);
                    const trackIndex = getTrackIndex(track.id);
                    const defaultRowHeight = Math.max(24, Math.min(120, Math.round(Number.isFinite(track.height) ? track.height : trackHeight)));
                    const resolvedRowHeight = track.type === 'master'
                        ? (rowHeightsByTrackId[track.id] ?? trackHeight)
                        : (rowHeightsByTrackId[track.id] ?? defaultRowHeight);

                    const visibleIndex = visibleTrackIndexById.get(track.id) ?? -1;
                    return (
                        <div
                            key={track.id}
                            ref={(el) => { trackRowRefs.current[track.id] = el; }}
                        >
                            <TrackRow
                                track={track}
                                allTracks={tracks}
                                trackHeight={resolvedRowHeight}
                                displayNum={displayNum}
                                isSelected={selectedTrackIdSet.has(track.id)}
                                isPrimarySelected={selectedTrackId === track.id}
                                isCollapsed={isCollapsed}
                                isActive={trackActiveStates[trackIndex] ?? true}
                                depth={depth}
                                isRenaming={renamingTrackId === track.id}
                                renameValue={renameValue}
                                onRenameChange={setRenameValue}
                                onRenameCommit={handleRenameCommit}
                                onRenameCancel={handleRenameCancel}
                                onClick={(e) => {
                                    if (suppressNextClickRef.current) {
                                        suppressNextClickRef.current = false;
                                        e.preventDefault();
                                        return;
                                    }
                                    if (e.shiftKey) {
                                        const anchorId = lastClickedTrackId && lastClickedTrackId !== 'master'
                                            ? lastClickedTrackId
                                            : (selectedTrackId && selectedTrackId !== 'master' ? selectedTrackId : null);
                                        const anchorIndex = anchorId ? (visibleTrackIndexById.get(anchorId) ?? -1) : -1;
                                        const currentIndex = visibleTrackIndexById.get(track.id) ?? -1;
                                        if (anchorIndex >= 0 && currentIndex >= 0) {
                                            const start = Math.min(anchorIndex, currentIndex);
                                            const end = Math.max(anchorIndex, currentIndex);
                                            const rangeIds = visibleTracks.slice(start, end + 1).map((t) => t.id);
                                            applySelection(rangeIds, track.id);
                                        } else {
                                            applySelection([track.id], track.id);
                                        }
                                    } else if (e.metaKey || e.ctrlKey) {
                                        const next = new Set(selectedTrackIdSet);
                                        if (next.has(track.id)) next.delete(track.id);
                                        else next.add(track.id);
                                        applySelection(Array.from(next), track.id);
                                    } else {
                                        applySelection([track.id], track.id);
                                    }
                                    setLastClickedTrackId(track.id);
                                }}
                                onToggleMute={() => toggleMute(track.id)}
                                onToggleSolo={() => toggleSolo(track.id)}
                                onToggleArm={() => toggleArm(track.id)}
                                onToggleCollapse={isGroup ? () => toggleGroupCollapse(track.id) : undefined}
                                onVolumeChange={(gain: number) => {
                                    setLocalOverrides((prev) => ({
                                        ...prev,
                                        [track.id]: { ...prev[track.id], volume: gain },
                                    }));
                                    if (trackIndex >= 0) void engineSetTrackVolume(trackIndex, gain);
                                }}
                                onPanChange={(pan: number) => {
                                    setLocalOverrides((prev) => ({
                                        ...prev,
                                        [track.id]: { ...prev[track.id], pan },
                                    }));
                                    if (trackIndex >= 0) void engineSetTrackPan(trackIndex, pan);
                                }}
                                onOutputChange={(targetId) => { void setTrackOutput(track.id, targetId); }}
                                onInputChange={(inputId) => { void setTrackInput(track.id, inputId); }}
                                onContextMenu={(e) => handleContextMenu(e, track.id, trackIndex)}
                                onHeaderPointerDown={(e) => beginHeaderPointerDrag(e, track.id)}
                                isGroupDropTarget={groupDropTargetId === track.id}
                                groupStripeColor={track.groupId ? (trackById.get(track.groupId)?.color ?? track.color) : track.color}
                                layout={rowLayout}
                                isResizing={resizingTrackId === track.id}
                                onResizeStart={(startY) => beginRowResize(track.id, resolvedRowHeight, startY)}
                                mixerFocusMode={mixerFocusMode}
                            />
                            {dropInsertIndex === visibleIndex + 1 && (
                                <div className="track-drop-insert-line" />
                            )}
                        </div>
                    );
                })}

            </div>

            {/* Master Track — fixed at bottom */}
            {(() => {
                const masterRowHeight = rowHeightsByTrackId.master ?? trackHeight;
                return (
                    <TrackRow
                        track={masterTrack}
                        allTracks={tracks}
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
                            applySelection([], 'master');
                        }}
                        onToggleMute={() => { }}
                        onToggleSolo={() => { }}
                        onToggleArm={() => { }}
                        onVolumeChange={(gain: number) => {
                            void engineSetMasterVolume(gain);
                        }}
                        onPanChange={() => { }}
                        onOutputChange={() => { }}
                        onInputChange={() => { }}
                        onContextMenu={(e) => {
                            e.preventDefault();
                            setContextMenu({ trackId: 'master', trackIndex: -1, x: e.clientX, y: e.clientY });
                        }}
                        layout={rowLayout}
                        isResizing={resizingTrackId === 'master'}
                        onResizeStart={(startY) => beginRowResize('master', masterRowHeight, startY)}
                        isMasterFixed
                        mixerFocusMode={mixerFocusMode}
                    />
                );
            })()}

            {/* Context Menu */}
            {contextMenu && (
                <ContextMenuPopup
                    x={contextMenu.x}
                    y={contextMenu.y}
                    showTrackActions={Boolean(contextMenu.trackId)}
                    onAddAudioTrack={() => handleAddTrackFromContext('audio')}
                    onAddMidiTrack={() => handleAddTrackFromContext('midi')}
                    onRename={() => {
                        if (!contextMenu.trackId) return;
                        handleRenameStart(contextMenu.trackId);
                    }}
                    onDuplicate={() => {
                        if (!contextMenu.trackId) return;
                        void engineApi.duplicateTracks([contextMenu.trackId]).then(() => {
                            debouncedFetchProject('duplicate-context');
                            return;
                        }).catch((err) => {
                            console.error('[TrackInspector] duplicate track (context menu) failed:', err);
                        });
                        setContextMenu(null);
                    }}
                    onGroup={() => {
                        if (!contextMenu.trackId) return;
                        handleGroupTrack(contextMenu.trackId);
                    }}
                    onUngroup={() => {
                        if (!contextMenu.trackId) return;
                        handleUngroupTrack(contextMenu.trackId);
                    }}
                    canUngroup={(() => {
                        if (!contextMenu.trackId) return false;
                        const ctxTrack = tracks.find((t) => t.id === contextMenu.trackId);
                        return !!ctxTrack && (ctxTrack.type === 'group' || !!ctxTrack.groupId);
                    })()}
                    canBounceGroup={(() => {
                        if (!contextMenu.trackId) return false;
                        const ctxTrack = tracks.find((t) => t.id === contextMenu.trackId);
                        return !!ctxTrack && ctxTrack.type === 'group';
                    })()}
                    onDelete={() => {
                        if (!contextMenu.trackId) return;
                        handleDeleteTrack(contextMenu.trackId);
                    }}
                    onChangeColor={() => {
                        if (!contextMenu.trackId) return;
                        handleOpenColorPicker(contextMenu.trackId, contextMenu.x, contextMenu.y);
                    }}
                    onPaintClips={() => {
                        if (!contextMenu.trackId) return;
                        handlePaintClipsWithTrackColor(contextMenu.trackId);
                    }}
                    onBounceTrack={() => {
                        if (!contextMenu.trackId) return;
                        handleBounceTrack(contextMenu.trackId);
                    }}
                    onBounceGroup={() => {
                        if (!contextMenu.trackId) return;
                        handleBounceGroup(contextMenu.trackId);
                    }}
                    onPaintGroupColor={() => {
                        if (!contextMenu.trackId) return;
                        handlePaintGroupColor(contextMenu.trackId);
                    }}
                    onSplitToStems={() => {
                        if (!contextMenu.trackId) return;
                        handleSplitTrackToStems(contextMenu.trackId);
                    }}
                    onDismiss={() => setContextMenu(null)}
                />
            )}

            {/* Color Picker */}
            {colorPickerState && (
                <ColorPickerPopup
                    x={colorPickerState.x}
                    y={colorPickerState.y}
                    currentColor={(colorPickerState.trackId === 'master' ? masterTrack.color : tracks.find(t => t.id === colorPickerState.trackId)?.color) || '#666'}
                    onSelect={(color) => handleColorSelect(colorPickerState.trackId, color)}
                    onDismiss={() => setColorPickerState(null)}
                />
            )}
        </div>
    );
};
