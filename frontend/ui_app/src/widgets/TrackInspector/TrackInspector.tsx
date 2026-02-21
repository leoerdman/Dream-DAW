import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import * as engineApi from '@/shared/api/engine';
import { getContrastColor } from '@/shared/lib/colorUtils';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { dbToMeterNorm } from '@/shared/lib/meterManifest';
import { vuNorm } from '@/shared/lib/audioMath';
import { scrollSync } from '@/shared/lib/useScrollSync';
import { isTrackActive } from '@/shared/utils/routing';

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

// ── Types ──────────────────────────────────────────────────
interface TrackData {
    id: string;
    name: string;
    type: 'audio' | 'midi' | 'group' | 'master';
    color: string;
    volume: number;
    pan: number;
    isMuted: boolean;
    isSoloed: boolean;
    isArmed: boolean;
    vuLevel: number;
    vuLevelL: number;
    vuLevelR: number;
    routing: string;
    groupId?: string;
    sends: { name: string; amount: number; color: string }[];
    input?: string;
    output?: string;
    height: number;
}

interface TrackRowLayoutMetrics {
    headerColWidth: number;
    routingColWidth: number;
    groupStripeWidthPx: number;
    indentStepPx: number;
    maxIndentPx: number;
    muteSoloColWidth: number;
    faderColWidth: number;
    armColWidth: number;
    meterColWidth: number;
    mixerColumnGapPx: number;
    mixerPaddingX: number;
    mixerPaddingY: number;
    mixerSectionWidthPx: number;
}

// ── Live Track Mapping ──

/** Convert a ProjectTrack from the engine store to the UI TrackData shape. */
function mapProjectTrack(
    pt: ProjectTrack,
    _index: number,
    meterPair?: [{ peak: number }, { peak: number }],
): TrackData {
    const vuLevelL = meterPair ? meterPair[0].peak : -Infinity;
    const vuLevelR = meterPair ? meterPair[1].peak : -Infinity;
    const vuLevel = Math.max(vuLevelL, vuLevelR);
    const typeMap: Record<string, TrackData['type']> = {
        audio: 'audio', Audio: 'audio',
        midi: 'midi', Midi: 'midi',
        group: 'group', Group: 'group',
        master: 'master', Master: 'master',
    };
    return {
        id: pt.id,
        name: pt.name,
        type: typeMap[pt.track_type] || 'audio',
        color: pt.color,
        volume: pt.volume,
        pan: pt.pan,
        isMuted: pt.is_mute,
        isSoloed: pt.is_solo,
        isArmed: pt.is_armed,
        vuLevel,
        vuLevelL,
        vuLevelR,
        routing: pt.output || 'master',
        sends: [],
        input: pt.input || 'none',
        output: pt.output || 'master',
        height: Number.isFinite(pt.height) ? pt.height : 48,
        groupId: pt.parent_track_id ?? undefined,
    };
}

// vuNorm imported from '@/shared/lib/audioMath'



// ── 16-Color Ableton Palette (from Swift TrackColor enum) ──

const TRACK_PALETTE = [
    { name: 'Coral', hex: '#f05c4d' },
    { name: 'Orange', hex: '#ff8a1a' },
    { name: 'Gold', hex: '#f5ba30' },
    { name: 'Yellow', hex: '#f2e640' },
    { name: 'Lime', hex: '#8cd93b' },
    { name: 'Green', hex: '#38c759' },
    { name: 'Teal', hex: '#29b8a1' },
    { name: 'Cyan', hex: '#1fbfd9' },
    { name: 'Sky', hex: '#3399eb' },
    { name: 'Blue', hex: '#406be0' },
    { name: 'Indigo', hex: '#6b52d9' },
    { name: 'Purple', hex: '#9e4dd9' },
    { name: 'Magenta', hex: '#d140b8' },
    { name: 'Pink', hex: '#eb598c' },
    { name: 'Rose', hex: '#e66673' },
    { name: 'Slate', hex: '#8c949e' },
] as const;

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
    const deleteTrack = useEngineStore((s) => s.deleteTrack);
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

    const handleDeleteTrack = useCallback((trackId: string) => {
        const idx = getTrackIndex(trackId);
        if (idx >= 0) deleteTrack(idx);
        setContextMenu(null);
    }, [getTrackIndex, deleteTrack]);

    const handleDeleteSelectedTracks = useCallback(() => {
        const selected = Array.from(selectedTrackIdSet)
            .map((id) => ({ id, idx: getTrackIndex(id) }))
            .filter((v) => v.idx >= 0)
            .sort((a, b) => b.idx - a.idx);
        if (selected.length === 0) return;

        // Find the track to select after deletion: the one ABOVE the first deleted track.
        const lowestDeletedIdx = Math.min(...selected.map((s) => s.idx));
        const deletedIds = new Set(selected.map((s) => s.id));
        const nonMasterTracks = tracks.filter((t) => t.type !== 'master');

        // Walk backwards from the lowest deleted index to find the first surviving track.
        let nextSelectedId: string | null = null;
        for (let i = lowestDeletedIdx - 1; i >= 0; i--) {
            const candidate = nonMasterTracks[i];
            if (candidate && !deletedIds.has(candidate.id)) {
                nextSelectedId = candidate.id;
                break;
            }
        }
        // If nothing above, try the first surviving track after the deleted ones.
        if (!nextSelectedId) {
            for (let i = lowestDeletedIdx + 1; i < nonMasterTracks.length; i++) {
                const candidate = nonMasterTracks[i];
                if (candidate && !deletedIds.has(candidate.id)) {
                    nextSelectedId = candidate.id;
                    break;
                }
            }
        }

        void (async () => {
            for (const item of selected) {
                await engineApi.deleteTrack(item.idx);
            }
            if (selectedTrackIdsProp) {
                onSelectTracks?.(nextSelectedId ? [nextSelectedId] : [], nextSelectedId ?? 'master');
            } else {
                setLocalSelectedTrackIds(nextSelectedId ? new Set([nextSelectedId]) : new Set());
            }
            if (onSelectTrack && nextSelectedId) onSelectTrack(nextSelectedId);
            else if (onSelectTrack) onSelectTrack('master');
            debouncedFetchProject('delete-selected');
        })().catch((err) => {
            console.error('[TrackInspector] delete selected tracks failed:', err);
        });
    }, [selectedTrackIdSet, getTrackIndex, tracks, onSelectTracks, onSelectTrack, selectedTrackIdsProp]);

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

// ── Context Menu Popup ──────────────────────────────────────────

const ContextMenuPopup = ({
    x, y, showTrackActions,
    onAddAudioTrack, onAddMidiTrack,
    onRename, onDuplicate, onGroup, onUngroup, canUngroup, canBounceGroup, onDelete, onChangeColor, onPaintClips, onBounceTrack, onBounceGroup, onPaintGroupColor, onSplitToStems, onDismiss,
}: {
    x: number; y: number;
    showTrackActions: boolean;
    onAddAudioTrack: () => void;
    onAddMidiTrack: () => void;
    onRename: () => void;
    onDuplicate: () => void;
    onGroup: () => void;
    onUngroup: () => void;
    canUngroup: boolean;
    canBounceGroup: boolean;
    onDelete: () => void;
    onChangeColor: () => void;
    onPaintClips: () => void;
    onBounceTrack: () => void;
    onBounceGroup: () => void;
    onPaintGroupColor: () => void;
    onSplitToStems: () => void;
    onDismiss: () => void;
}) => {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
        };
        const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [onDismiss]);

    const clampedX = Math.min(x, window.innerWidth - 196);
    const menuHeight = showTrackActions
        ? (canBounceGroup ? 414 : 346)
        : 82;
    const clampedY = Math.min(y, window.innerHeight - menuHeight);

    const itemStyle: React.CSSProperties = {
        width: '100%', padding: '6px 12px',
        background: 'none', border: 'none',
        color: 'var(--color-text-primary)', fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-regular)' as unknown as number,
        textAlign: 'left', cursor: 'pointer', borderRadius: 'var(--radius-md)',
        display: 'flex', alignItems: 'center', gap: 8,
    };

    const node = (
        <div ref={ref} style={{
            position: 'fixed', left: clampedX, top: clampedY, width: 188,
            background: 'var(--surface-2)', border: '1px solid var(--color-border-subtle)',
            borderRadius: 'var(--radius-xl)', padding: 4, zIndex: 'var(--z-menu)' as unknown as number,
            boxShadow: 'var(--shadow-panel)',
        }}>
            <button style={itemStyle} onClick={onAddAudioTrack}
                onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🎚</span> Add Audio Track
            </button>
            <button style={itemStyle} onClick={onAddMidiTrack}
                onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🎹</span> Add MIDI Track
            </button>
            {!showTrackActions && null}
            {showTrackActions && (
                <>
                    <div style={{ height: 1, background: 'var(--color-divider)', margin: '2px 8px' }} />
                    <button style={itemStyle} onClick={onRename}
                        onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                        <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>✏️</span> Rename
                    </button>
                    <button style={itemStyle} onClick={onDuplicate}
                        onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                        <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>📋</span> Duplicate Track
                    </button>
                    <button style={itemStyle} onClick={onChangeColor}
                        onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                        <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🎨</span> Change Color
                    </button>
                    <button style={itemStyle} onClick={onPaintClips}
                        onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                        <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🖌</span> Paint Clips As Track
                    </button>
                    <button style={itemStyle} onClick={onBounceTrack}
                        onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                        <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>📀</span> Bounce Track
                    </button>
                    {canBounceGroup && (
                        <button style={itemStyle} onClick={onBounceGroup}
                            onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                            <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>📦</span> Bounce Group
                        </button>
                    )}
                    {canBounceGroup && (
                        <button style={itemStyle} onClick={onPaintGroupColor}
                            onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                            <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🎨</span> Paint Group Color
                        </button>
                    )}
                    <button style={itemStyle} onClick={onSplitToStems}
                        onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                        <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🧪</span> Split To 4 Stems
                    </button>
                    <button style={itemStyle} onClick={onGroup}
                        onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                        <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🧩</span> Group Track
                    </button>
                    {canUngroup && (
                        <button style={itemStyle} onClick={onUngroup}
                            onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                            <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>↗</span> Move To Top Level
                        </button>
                    )}
                    <div style={{ height: 1, background: 'var(--color-divider)', margin: '2px 8px' }} />
                    <button style={{ ...itemStyle, color: 'var(--color-status-error)' }} onClick={onDelete}
                        onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-status-error) 18%, transparent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                        <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🗑</span> Delete Track
                    </button>
                </>
            )}
        </div>
    );

    // Render into <body> so it is never clipped by panel overflow/stacking contexts.
    if (typeof document !== 'undefined' && document.body) {
        return createPortal(node, document.body);
    }
    return node;
};

// ── dB ↔ Linear conversions ──────────────────────────────

/** Linear gain (0..2) → dB. 0 gain → -Infinity. */
function gainToDb(gain: number): number {
    if (gain <= 0) return -Infinity;
    return 20 * Math.log10(gain);
}

/** dB → linear gain. Clamps to [0, ~+6 dB]. */
function dbToGain(db: number): number {
    if (!isFinite(db) || db <= -100) return 0;
    return Math.pow(10, db / 20);
}

/** Format dB for display. */
function formatDb(db: number): string {
    if (!isFinite(db) || db <= -60) return '-∞';
    if (Math.abs(db) < 0.05) return '0';
    return db > 0 ? `+${db.toFixed(1)}` : db.toFixed(1);
}

/** Fader position (0..1) → dB using quasi-log curve. 0 = -inf, ~0.77 = 0dB, 1 = +6dB */
function faderToDb(pos: number): number {
    if (pos <= 0) return -Infinity;
    if (pos >= 1) return 6;
    // Use a log-like curve: map 0..1 to -inf..+6
    // The 0 dB point sits at ~77% of the fader
    const zeroPt = 0.77;
    if (pos <= zeroPt) {
        // Map 0..zeroPt → -60..0 with a power curve
        const t = pos / zeroPt;
        const db = -60 * Math.pow(1 - t, 3);
        return Math.max(-60, db);
    } else {
        // Map zeroPt..1 → 0..+6 linearly
        const t = (pos - zeroPt) / (1 - zeroPt);
        return t * 6;
    }
}

/** dB → fader position (0..1), inverse of faderToDb. */
function dbToFader(db: number): number {
    if (!isFinite(db) || db <= -60) return 0;
    if (db >= 6) return 1;
    const zeroPt = 0.77;
    if (db <= 0) {
        // Inverse of: db = -60 * (1 - t)^3 where t = pos / zeroPt
        const ratio = Math.max(0, db / -60);
        const t = 1 - Math.pow(ratio, 1 / 3);
        return t * zeroPt;
    } else {
        // Inverse of: db = t * 6 where t = (pos - zeroPt) / (1 - zeroPt)
        return zeroPt + (db / 6) * (1 - zeroPt);
    }
}

// ── Volume Fader (Ableton-style rectangular bar) ─────────────────

const VolumeFader = ({
    volumeLinear,
    onVolumeChange,
    compact = false,
    showZeroTick = true,
    controlHeight,
}: {
    volumeLinear: number;
    onVolumeChange: (gain: number) => void;
    compact?: boolean;
    showZeroTick?: boolean;
    controlHeight?: number;
}) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const isDraggingRef = useRef(false);
    const activePointerId = useRef<number | null>(null);
    const dragStartRef = useRef<{ x: number; y: number; startPos: number } | null>(null);
    const db = gainToDb(volumeLinear);
    const faderPos = dbToFader(db);

    const beginDrag = useCallback((clientX: number, clientY: number, startPos: number, pointerId?: number) => {
        isDraggingRef.current = true;
        setIsDragging(true);
        if (typeof pointerId === 'number') activePointerId.current = pointerId;
        dragStartRef.current = { x: clientX, y: clientY, startPos };
    }, []);

    const endDrag = useCallback(() => {
        isDraggingRef.current = false;
        setIsDragging(false);
        activePointerId.current = null;
        dragStartRef.current = null;
        // Force-send final value without throttle.
        void useEngineStore.getState().flushTrackControlFinals();
    }, []);

    useEffect(() => {
        const onPointerMove = (e: PointerEvent) => {
            if (!isDraggingRef.current) return;
            if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
            const dragStart = dragStartRef.current;
            if (!dragStart) return;
            const deltaX = e.clientX - dragStart.x;
            const deltaY = e.clientY - dragStart.y;
            const dragRangePx = compact ? 120 : 144;
            const delta = (deltaX - deltaY) / dragRangePx;
            const nextPos = Math.max(0, Math.min(1, dragStart.startPos + delta));
            const nextDb = faderToDb(nextPos);
            onVolumeChange(dbToGain(nextDb));
        };

        const onPointerUp = (e: PointerEvent) => {
            if (!isDraggingRef.current) return;
            if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
            endDrag();
        };

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
        };
    }, [compact, endDrag, onVolumeChange]);

    const trackHeight = controlHeight ?? (compact ? 18 : 22);
    const trackWidth = compact ? 60 : 108;

    // Zero-dB tick position
    const zeroTickPos = dbToFader(0);

    return (
        <div data-testid="track-volume-fader" style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
            <div
                ref={trackRef}
                onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                    beginDrag(e.clientX, e.clientY, faderPos, e.pointerId);
                }}
                onPointerUp={(e) => {
                    if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
                    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
                    endDrag();
                }}
                onPointerCancel={endDrag}
                onDoubleClick={(e) => {
                    e.stopPropagation();
                    onVolumeChange(1.0); /* reset to 0 dB */
                    void useEngineStore.getState().flushTrackControlFinals();
                }}
                onWheel={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const step = e.shiftKey ? 0.006 : 0.018;
                    const next = Math.max(0, Math.min(2, volumeLinear + (e.deltaY < 0 ? step : -step)));
                    onVolumeChange(next);
                    void useEngineStore.getState().flushTrackControlFinals();
                }}
                style={{
                    position: 'relative',
                    width: trackWidth,
                    height: trackHeight,
                    minWidth: trackWidth,
                    background: 'color-mix(in srgb, var(--surface-elevated) 84%, #000)',
                    border: '1px solid color-mix(in srgb, var(--text-primary) 14%, transparent)',
                    borderRadius: 'var(--radius-xs)',
                    cursor: 'ew-resize',
                    overflow: 'hidden',
                    touchAction: 'none',
                }}
            >
                {/* Zero-dB tick mark */}
                {showZeroTick && (
                    <div style={{
                        position: 'absolute', left: `${zeroTickPos * 100}%`, top: 0, bottom: 0,
                        width: 1, background: 'var(--color-divider-light)', zIndex: 'var(--z-local)' as unknown as number,
                    }} />
                )}
                {/* Fill */}
                <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: `${faderPos * 100}%`,
                    background: faderPos > zeroTickPos
                        ? 'linear-gradient(to right, var(--color-status-info), var(--color-port-audio))'
                        : 'var(--color-status-info)',
                    borderRadius: 'var(--radius-xs)',
                    transition: isDragging ? 'none' : 'width 60ms linear',
                }} />
                <span style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: compact ? 'var(--font-size-2xs)' : 'var(--font-size-xs)',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
                    color: 'var(--color-text-primary)',
                    textShadow: 'var(--text-shadow-subtle)',
                    pointerEvents: 'none',
                    letterSpacing: '0.01em',
                }}>
                    {compact ? formatDb(db) : `${formatDb(db)} dB`}
                </span>
            </div>
        </div>
    );
};

// ── Pan Fader (Ableton-style rectangular bar) ───────────────────────────────

const PanFader = ({
    pan,
    onPanChange,
    compact = false,
    controlHeight,
}: {
    pan: number;
    onPanChange: (pan: number) => void;
    compact?: boolean;
    controlHeight?: number;
}) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const isDraggingRef = useRef(false);
    const activePointerId = useRef<number | null>(null);
    const dragStartRef = useRef<{ x: number; y: number; startNorm: number } | null>(null);
    const panNorm = Math.max(0, Math.min(1, (pan + 1) / 2));

    const endDrag = useCallback(() => {
        isDraggingRef.current = false;
        activePointerId.current = null;
        dragStartRef.current = null;
        void useEngineStore.getState().flushTrackControlFinals();
    }, []);

    useEffect(() => {
        const onPointerMove = (e: PointerEvent) => {
            if (!isDraggingRef.current) return;
            if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
            const dragStart = dragStartRef.current;
            if (!dragStart) return;
            const deltaX = e.clientX - dragStart.x;
            const deltaY = e.clientY - dragStart.y;
            const dragRangePx = compact ? 120 : 144;
            const delta = (deltaX - deltaY) / dragRangePx;
            const nextNorm = Math.max(0, Math.min(1, dragStart.startNorm + delta));
            onPanChange(nextNorm * 2 - 1);
        };

        const onPointerUp = (e: PointerEvent) => {
            if (!isDraggingRef.current) return;
            if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
            endDrag();
        };

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
        };
    }, [compact, endDrag, onPanChange]);

    const panLabel = Math.abs(pan) < 0.02
        ? 'C'
        : `${pan < 0 ? '-' : '+'}${Math.round(Math.abs(pan) * 100)}`;

    const trackHeight = controlHeight ?? (compact ? 18 : 22);
    const trackWidth = compact ? 60 : 88;

    return (
        <div data-testid="track-pan-fader" style={{ display: 'flex', alignItems: 'center', minWidth: trackWidth, flexShrink: 0 }}>
            <div
                ref={trackRef}
                onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                    activePointerId.current = e.pointerId;
                    isDraggingRef.current = true;
                    dragStartRef.current = { x: e.clientX, y: e.clientY, startNorm: panNorm };
                }}
                onPointerUp={(e) => {
                    if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
                    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
                    endDrag();
                }}
                onPointerCancel={endDrag}
                onDoubleClick={(e) => {
                    e.stopPropagation();
                    onPanChange(0);
                    void useEngineStore.getState().flushTrackControlFinals();
                }}
                onWheel={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const step = e.shiftKey ? 0.01 : 0.03;
                    const next = Math.max(-1, Math.min(1, pan + (e.deltaY < 0 ? step : -step)));
                    onPanChange(next);
                    void useEngineStore.getState().flushTrackControlFinals();
                }}
                style={{
                    position: 'relative',
                    width: trackWidth,
                    height: trackHeight,
                    background: 'color-mix(in srgb, var(--surface-elevated) 84%, #000)',
                    border: '1px solid color-mix(in srgb, var(--text-primary) 14%, transparent)',
                    borderRadius: 'var(--radius-xs)',
                    cursor: 'ew-resize',
                    overflow: 'hidden',
                    touchAction: 'none',
                }}
            >
                <div style={{
                    position: 'absolute',
                    top: 0,
                    left: panNorm <= 0.5 ? `${panNorm * 100}%` : '50%',
                    width: `${Math.abs(panNorm - 0.5) * 100}%`,
                    height: '100%',
                    background: 'color-mix(in srgb, var(--color-status-info) 35%, transparent)',
                }} />
                <span style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: compact ? 'var(--font-size-2xs)' : 'var(--font-size-xs)',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
                    color: 'var(--color-text-primary)',
                    textShadow: 'var(--text-shadow-subtle)',
                    pointerEvents: 'none',
                    letterSpacing: '0.01em',
                }}>
                    {panLabel}
                </span>
            </div>
        </div>
    );
};

// ── Tri-Color Stereo VU Meter (vertical, L+R) ──────────────────────────

const TriColorVU = ({
    peakDb,
    peakDbL,
    peakDbR,
    isMidi,
    compact = false,
    isEnabled = true,
    trackHeight,
}: {
    peakDb: number;
    peakDbL?: number;
    peakDbR?: number;
    isMidi: boolean;
    compact?: boolean;
    isEnabled?: boolean;
    trackHeight?: number;
}) => {
    const lDb = peakDbL ?? peakDb;
    const rDb = peakDbR ?? peakDb;
    const normL = dbToMeterNorm(lDb);
    const normR = dbToMeterNorm(rDb);
    const meterHeight = trackHeight ? Math.max(14, trackHeight - 6) : (compact ? 28 : 32);

    return (
        <div style={{
            width: 9,
            height: meterHeight,
            flexShrink: 0,
            position: 'relative',
            filter: isEnabled ? 'none' : 'grayscale(1)',
            opacity: isEnabled ? 1 : 0.5,
            transition: `filter var(--transition-fast), opacity var(--transition-fast)`,
        }}>
            <MeterStrip
                levelL={normL}
                levelR={normR}
                isMidi={isMidi}
                width={9}
                style={{ position: 'absolute', inset: 0 }}
            />
        </div>
    );
};

// ── Vertical Mixer Strip (Tab mixer mode) ─────────────────────────────

const VerticalMixerStrip = ({
    volumeLinear,
    pan,
    peakDb,
    peakDbL,
    peakDbR,
    isMidi,
    onVolumeChange,
    onPanChange,
}: {
    volumeLinear: number;
    pan: number;
    peakDb: number;
    peakDbL?: number;
    peakDbR?: number;
    isMidi: boolean;
    onVolumeChange: (gain: number) => void;
    onPanChange: (pan: number) => void;
}) => {
    const stripRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const activePointerId = useRef<number | null>(null);

    const volNorm = Math.max(0, Math.min(1, dbToFader(gainToDb(volumeLinear))));
    const meterNormL = Math.max(0, Math.min(1, vuNorm(peakDbL ?? peakDb)));
    const meterNormR = Math.max(0, Math.min(1, vuNorm(peakDbR ?? peakDb)));
    const panNorm = Math.max(0, Math.min(1, (pan + 1) / 2));
    const [peakHoldNorm, setPeakHoldNorm] = useState(0);
    const [clipLatched, setClipLatched] = useState(false);
    const holdTimerRef = useRef<number | null>(null);

    useEffect(() => {
        let rafId: number | null = null;
        let clipLatchTimer: number | null = null;
        const meterNorm = Math.max(meterNormL, meterNormR);
        if (meterNorm > peakHoldNorm) {
            rafId = window.requestAnimationFrame(() => {
                setPeakHoldNorm(meterNorm);
            });
        }
        if (peakDb >= 0) {
            clipLatchTimer = window.setTimeout(() => setClipLatched(true), 0);
        }
        if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = window.setTimeout(() => {
            setPeakHoldNorm(meterNorm);
        }, 650);
        return () => {
            if (rafId !== null) window.cancelAnimationFrame(rafId);
            if (clipLatchTimer !== null) window.clearTimeout(clipLatchTimer);
            if (holdTimerRef.current !== null) {
                window.clearTimeout(holdTimerRef.current);
                holdTimerRef.current = null;
            }
        };
    }, [meterNormL, meterNormR, peakDb, peakHoldNorm]);

    const applyVolumeFromY = useCallback((clientY: number) => {
        const el = stripRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const pos = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
        const nextDb = faderToDb(pos);
        onVolumeChange(dbToGain(nextDb));
    }, [onVolumeChange]);

    const endDrag = useCallback(() => {
        setIsDragging(false);
        activePointerId.current = null;
        void useEngineStore.getState().flushTrackControlFinals();
    }, []);

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 86,
            flexShrink: 0,
        }}>
            <div
                ref={stripRef}
                onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                    activePointerId.current = e.pointerId;
                    setIsDragging(true);
                    applyVolumeFromY(e.clientY);
                }}
                onPointerMove={(e) => {
                    if (!isDragging) return;
                    if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
                    applyVolumeFromY(e.clientY);
                }}
                onPointerUp={(e) => {
                    if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
                    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
                    endDrag();
                }}
                onPointerCancel={endDrag}
                onDoubleClick={(e) => {
                    e.stopPropagation();
                    onVolumeChange(1.0);
                    void useEngineStore.getState().flushTrackControlFinals();
                }}
                onClick={(e) => {
                    e.stopPropagation();
                    setClipLatched(false);
                    setPeakHoldNorm(Math.max(meterNormL, meterNormR));
                }}
                onWheel={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const step = e.shiftKey ? 0.006 : 0.018;
                    const next = Math.max(0, Math.min(2, volumeLinear + (e.deltaY < 0 ? step : -step)));
                    onVolumeChange(next);
                    void useEngineStore.getState().flushTrackControlFinals();
                }}
                title="Volume"
                style={{
                    position: 'relative',
                    width: 16,
                    height: 62,
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-elevated)',
                    border: '1px solid color-mix(in srgb, var(--text-primary) 12%, transparent)',
                    overflow: 'hidden',
                    cursor: 'ns-resize',
                    touchAction: 'none',
                }}
            >
                {/* Meter bars — unified MeterStrip layer */}
                <MeterStrip
                    levelL={meterNormL}
                    levelR={meterNormR}
                    isMidi={isMidi}
                    width={16}
                    show0dBLine={true}
                    style={{
                        position: 'absolute',
                        inset: 0,
                        pointerEvents: 'none',
                    }}
                />
                <div style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: `${peakHoldNorm * 100}%`,
                    height: 1,
                    background: 'color-mix(in srgb, var(--color-text-bright) 95%, transparent)',
                    boxShadow: '0 0 2px color-mix(in srgb, var(--color-text-bright) 70%, transparent)',
                    pointerEvents: 'none',
                }} />
                <div style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: `${volNorm * 100}%`,
                    background: 'linear-gradient(to top, var(--color-meter-green-start) 0%, var(--color-meter-green-end) 100%)',
                    opacity: 0.9,
                    pointerEvents: 'none',
                }} />
                <div style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: `calc(${volNorm * 100}% - 1px)`,
                    height: 2,
                    background: 'color-mix(in srgb, var(--color-text-bright) 90%, transparent)',
                    boxShadow: '0 0 4px color-mix(in srgb, var(--color-text-bright) 45%, transparent)',
                    transition: isDragging ? 'none' : 'bottom 60ms linear',
                    pointerEvents: 'none',
                }} />
                {clipLatched && (
                    <div style={{
                        position: 'absolute',
                        top: 1,
                        left: '50%',
                        width: 4,
                        height: 4,
                        marginLeft: -2,
                        borderRadius: '50%',
                        background: 'var(--color-status-record)',
                        boxShadow: '0 0 4px color-mix(in srgb, var(--color-status-record) 85%, transparent)',
                        pointerEvents: 'none',
                    }} />
                )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 54 }}>
                <span style={{
                    fontSize: 'var(--font-size-micro)',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text-secondary)',
                    textAlign: 'right',
                }}>
                    {formatDb(gainToDb(volumeLinear))}
                </span>
                <div
                    onWheel={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        const step = e.shiftKey ? 0.01 : 0.03;
                        const next = Math.max(-1, Math.min(1, pan + (e.deltaY < 0 ? step : -step)));
                        onPanChange(next);
                        void useEngineStore.getState().flushTrackControlFinals();
                    }}
                    title="Pan"
                    style={{
                        position: 'relative',
                        width: 54,
                        height: 8,
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--surface-elevated)',
                        border: '1px solid color-mix(in srgb, var(--text-primary) 10%, transparent)',
                    }}
                >
                    <div style={{
                        position: 'absolute',
                        left: '50%',
                        top: 0,
                        bottom: 0,
                        width: 1,
                        background: 'var(--color-divider-light)',
                    }} />
                    <div style={{
                        position: 'absolute',
                        top: 0,
                        left: `calc(${panNorm * 100}% - 3px)`,
                        width: 6,
                        height: '100%',
                        borderRadius: 'var(--radius-xs)',
                        background: 'var(--text-primary)',
                    }} />
                    <input
                        type="range"
                        min={-1}
                        max={1}
                        step={0.01}
                        value={pan}
                        onChange={(e) => onPanChange(Number(e.target.value))}
                        onDoubleClick={(e) => {
                            e.stopPropagation();
                            onPanChange(0);
                        }}
                        style={{
                            position: 'absolute',
                            inset: 0,
                            width: '100%',
                            height: '100%',
                            opacity: 0,
                            cursor: 'ew-resize',
                        }}
                    />
                </div>
                <span style={{
                    fontSize: 'var(--font-size-micro)',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text-secondary)',
                    textAlign: 'right',
                }}>
                    {Math.abs(pan) < 0.02 ? 'C' : (pan < 0 ? `L${Math.round(Math.abs(pan) * 100)}` : `R${Math.round(Math.abs(pan) * 100)}`)}
                </span>
            </div>
        </div>
    );
};

// ── TrackRow (3-block Ableton-style layout) ──────────────────────────────

const TrackRow = ({
    track, allTracks, trackHeight, displayNum, isSelected, isPrimarySelected = false, isCollapsed, depth,
    isRenaming, renameValue, onRenameChange, onRenameCommit, onRenameCancel,
    onClick, onToggleMute, onToggleSolo, onToggleArm, onToggleCollapse,
    onVolumeChange, onPanChange, onOutputChange, onInputChange, onContextMenu,
    onHeaderPointerDown,
    isGroupDropTarget = false,
    groupStripeColor,
    layout,
    isResizing = false,
    onResizeStart,
    isMasterFixed, mixerFocusMode = false,
    isActive = true,
}: {
    track: TrackData;
    allTracks: TrackData[];
    trackHeight: number;
    displayNum?: number;
    isSelected: boolean;
    isPrimarySelected?: boolean;
    isCollapsed: boolean;
    depth: number;
    isRenaming: boolean;
    renameValue: string;
    onRenameChange: (v: string) => void;
    onRenameCommit: () => void;
    onRenameCancel: () => void;
    onClick: (e: React.MouseEvent<HTMLDivElement>) => void;
    onToggleMute: () => void;
    onToggleSolo: () => void;
    onToggleArm: () => void;
    onToggleCollapse?: () => void;
    onVolumeChange?: (gain: number) => void;
    onPanChange?: (pan: number) => void;
    onOutputChange?: (targetId: string) => void;
    onInputChange?: (inputId: string) => void;
    onContextMenu?: (e: React.MouseEvent) => void;
    onHeaderPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
    isGroupDropTarget?: boolean;
    groupStripeColor?: string;
    layout: TrackRowLayoutMetrics;
    isResizing?: boolean;
    onResizeStart?: (startY: number) => void;
    isMasterFixed?: boolean;
    mixerFocusMode?: boolean;
    isActive?: boolean;
}) => {
    const isMaster = track.type === 'master';
    const isGroup = track.type === 'group';
    const isNestedGroup = isGroup && depth > 0;
    const groupRailColor = isNestedGroup
        ? (groupStripeColor || track.color)
        : isGroup
            ? track.color
            : (groupStripeColor || track.color);
    const renameInputRef = useRef<HTMLInputElement>(null);

    const availableRoutingTargets = allTracks.filter(t => t.id !== track.id && t.type !== 'master');
    const outputValue = track.output && (track.output === 'master' || availableRoutingTargets.some(t => t.id === track.output))
        ? track.output : 'master';
    const inputValue = track.input && (
        track.input === 'none' || track.input === 'ext-1' || track.input === 'ext-2' ||
        availableRoutingTargets.some(t => t.id === track.input)
    ) ? track.input : 'none';

    // Focus rename input
    useEffect(() => {
        if (isRenaming && renameInputRef.current) {
            renameInputRef.current.focus();
            renameInputRef.current.select();
        }
    }, [isRenaming]);

    const showRoutingExpanded = !isMasterFixed;
    const showRoutingCompact = false;

    // Track row dims when either explicitly muted or implicitly muted (due to solos)
    const isEnabled = isActive;
    // Meter dims on both mute AND solo (non-soloed tracks get grey meters)
    const anySoloed = allTracks.some(t => t.isSoloed);
    const isMeterActive = !track.isMuted && (!anySoloed || track.isSoloed || track.type === 'group' || track.type === 'master');
    const compactControlHeight = Math.max(16, Math.min(36, Math.round(trackHeight * 0.38)));
    const [resizeHot, setResizeHot] = useState(false);
    const headerBgColor = track.color;
    const headerContrast = getContrastColor(track.color);
    const headerTextColor = headerContrast === 'black' ? 'var(--glass-bg)' : 'color-mix(in srgb, var(--color-text-primary) 94%, transparent)';

    const indentW = !isMaster && depth > 0 ? Math.min(layout.maxIndentPx, depth * layout.indentStepPx) : 0;
    const stripeW = !isMaster && depth > 0 ? layout.groupStripeWidthPx : 0;

    return (
        <div
            data-track-row="true"
            data-track-id={track.id}
            onClick={onClick}
            onContextMenu={onContextMenu}
            style={{
                display: 'flex', alignItems: 'stretch', height: trackHeight,
                borderBottom: isMasterFixed ? 'none' : '1px solid var(--color-divider)',
                borderTop: 'none',
                background: isGroupDropTarget
                    ? 'color-mix(in srgb, var(--color-accent-primary) 20%, var(--surface-1))'
                    : isPrimarySelected
                        ? 'color-mix(in srgb, var(--color-accent-primary) 14%, var(--surface-1))'
                        : isSelected
                            ? 'color-mix(in srgb, var(--color-accent-primary) 8%, var(--surface-1))'
                            : 'var(--surface-1)',
                cursor: 'default',
                opacity: isEnabled ? 1 : 0.45,
                transition: `background var(--transition-linear), opacity var(--transition-linear)`,
                position: 'relative', flexShrink: 0, boxSizing: 'border-box', width: '100%',
                outline: isGroupDropTarget ? '2px solid color-mix(in srgb, var(--color-accent-primary) 82%, white)' : 'none',
                outlineOffset: isGroupDropTarget ? '-2px' : 0,
                boxShadow: isGroupDropTarget
                    ? 'inset 0 0 0 1px color-mix(in srgb, var(--color-accent-primary) 45%, transparent), 0 0 10px color-mix(in srgb, var(--color-accent-primary) 32%, transparent)'
                    : 'none',
            }}
        >
            {/* ════ BLOCK 1: Track Header (colored) ════ */}
            <div
                onPointerDown={onHeaderPointerDown}
                style={{
                    width: layout.headerColWidth,
                    minWidth: layout.headerColWidth,
                    maxWidth: layout.headerColWidth,
                    display: 'flex',
                    alignItems: 'stretch',
                    borderRight: isMasterFixed ? 'none' : '1px solid var(--color-border-subtle)',
                    boxSizing: 'border-box',
                    cursor: !isMaster ? 'grab' : 'default',
                }}
            >
                {stripeW > 0 && (
                    <div
                        aria-hidden
                        style={{
                            width: stripeW,
                            minWidth: stripeW,
                            background: `color-mix(in srgb, ${groupRailColor} 70%, #000)`,
                            opacity: 1,
                        }}
                    />
                )}
                <div
                    style={{
                        flex: 1,
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        padding: `2px ${mixerFocusMode ? 8 : 6}px 2px ${(mixerFocusMode ? 5 : 4) + indentW}px`,
                        background: headerBgColor,
                        gap: 1,
                        position: 'relative',
                        boxSizing: 'border-box',
                        minWidth: 0,
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        {/* Collapse / Group icon */}
                        {isGroup && onToggleCollapse ? (
                            <button
                                onClick={e => { e.stopPropagation(); onToggleCollapse(); }}
                                style={{
                                    width: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    background: 'none', border: 'none', color: headerTextColor,
                                    fontSize: 'var(--font-size-micro)', cursor: 'pointer', flexShrink: 0, padding: 0,
                                }}
                            >
                                {isCollapsed ? '▶' : '▼'}
                            </button>
                        ) : null}

                        {/* Track Name */}
                        {isRenaming ? (
                            <input
                                ref={renameInputRef}
                                value={renameValue}
                                onChange={e => onRenameChange(e.target.value)}
                                onKeyDown={e => {
                                    e.stopPropagation();
                                    if (e.key === 'Enter') onRenameCommit();
                                    if (e.key === 'Escape') onRenameCancel();
                                }}
                                onBlur={onRenameCommit}
                                onClick={e => e.stopPropagation()}
                                style={{
                                    fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                                    background: headerContrast === 'black'
                                        ? 'rgba(255, 255, 255, 0.42)'
                                        : 'rgba(0, 0, 0, 0.34)',
                                    border: `1px solid ${track.color}`,
                                    borderRadius: 'var(--radius-xs)', color: headerTextColor,
                                    padding: '1px 3px', outline: 'none', minWidth: 0,
                                }}
                            />
                        ) : (
                            <span style={{
                                flex: 1, fontSize: 'var(--font-size-base)',
                                fontWeight: isGroup || isMasterFixed ? 700 : 600,
                                color: headerTextColor,
                                whiteSpace: 'nowrap', overflow: 'hidden',
                                textOverflow: 'ellipsis', minWidth: 0,
                            }}>
                                {track.name}
                            </span>
                        )}
                    </div>

                    {/* ── Type Icon (absolute top-right) ── */}
                    {!isMasterFixed && !isGroup && (
                        <span style={{
                            position: 'absolute',
                            top: 3,
                            right: 4,
                            display: 'inline-flex',
                            alignItems: 'center',
                            opacity: 0.55,
                        }}>
                            {track.type === 'midi' ? (
                                <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                                    <rect x="0" y="1" width="3" height="10" rx="0.5" fill={headerTextColor} />
                                    <rect x="4.5" y="1" width="3" height="10" rx="0.5" fill={headerTextColor} />
                                    <rect x="9" y="1" width="3" height="10" rx="0.5" fill={headerTextColor} />
                                    <rect x="2" y="1" width="2" height="6" rx="0.3" fill={headerContrast === 'black' ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)'} />
                                    <rect x="6.5" y="1" width="2" height="6" rx="0.3" fill={headerContrast === 'black' ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)'} />
                                </svg>
                            ) : (
                                <svg width="9" height="9" viewBox="0 0 14 10" fill="none">
                                    <path d="M1 5 L2.5 2 L4 7 L5.5 1 L7 9 L8.5 3 L10 6 L11.5 4 L13 5" stroke={headerTextColor} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            )}
                        </span>
                    )}
                </div>
            </div>

            {/* ════ BLOCK 2: Routing (gray) ════ */}
            {showRoutingExpanded && (
                <div style={{
                    display: 'flex', flexDirection: 'column', justifyContent: 'center',
                    gap: 4, padding: 4,
                    borderRight: '1px solid var(--color-border-subtle)',
                    width: layout.routingColWidth,
                    minWidth: layout.routingColWidth,
                    maxWidth: layout.routingColWidth,
                    boxSizing: 'border-box',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <div style={{ position: 'relative', display: 'flex', flex: 1, minWidth: 0 }}>
                            <span style={{
                                position: 'absolute',
                                left: 6,
                                top: '50%',
                                transform: 'translateY(-50%)',
                                fontSize: 'var(--font-size-micro)',
                                color: 'var(--color-text-tertiary)',
                                pointerEvents: 'none',
                                zIndex: 'var(--z-local)' as unknown as number,
                            }}>←</span>
                            <select
                                onClick={e => e.stopPropagation()}
                                value={inputValue}
                                onChange={(e) => {
                                    e.stopPropagation();
                                    onInputChange?.(e.target.value);
                                }}
                                title="Audio From"
                                style={{
                                    fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--font-weight-medium)' as unknown as number,
                                    color: 'var(--color-text-primary)',
                                    background: 'var(--color-control-bg)',
                                    border: '1px solid var(--color-control-border)',
                                    borderRadius: 'var(--radius-md)', padding: '0 16px 0 14px', cursor: 'pointer',
                                    minWidth: 0, flexShrink: 1, flex: 1,
                                    appearance: 'auto' as React.CSSProperties['appearance'],
                                    lineHeight: '15px', height: 15,
                                }}
                            >
                                <option value="none">No Input</option>
                                <option value="ext-1">Ext. In 1</option>
                                <option value="ext-2">Ext. In 2</option>
                                {availableRoutingTargets.map(t => (
                                    <option key={t.id} value={t.id}>{t.name}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <div style={{ position: 'relative', display: 'flex', flex: 1, minWidth: 0 }}>
                            <span style={{
                                position: 'absolute',
                                left: 6,
                                top: '50%',
                                transform: 'translateY(-50%)',
                                fontSize: 'var(--font-size-micro)',
                                color: 'var(--color-text-tertiary)',
                                pointerEvents: 'none',
                                zIndex: 'var(--z-local)' as unknown as number,
                            }}>→</span>
                            <select
                                onClick={e => e.stopPropagation()}
                                value={outputValue}
                                onChange={(e) => {
                                    e.stopPropagation();
                                    onOutputChange?.(e.target.value);
                                }}
                                title="Audio To"
                                style={{
                                    fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--font-weight-medium)' as unknown as number,
                                    color: 'var(--color-text-primary)',
                                    background: 'var(--color-control-bg)',
                                    border: '1px solid var(--color-control-border)',
                                    borderRadius: 'var(--radius-md)', padding: '0 16px 0 14px', cursor: 'pointer',
                                    minWidth: 0, flexShrink: 1, flex: 1,
                                    appearance: 'auto' as React.CSSProperties['appearance'],
                                    lineHeight: '15px', height: 15,
                                }}
                            >
                                <option value="master">Master</option>
                                {availableRoutingTargets.map(t => (
                                    <option key={t.id} value={t.id}>{t.name}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                </div>
            )}

            {/* Master I/O labels — static, non-clickable */}
            {isMasterFixed && (
                <div style={{
                    display: 'flex', flexDirection: 'column', justifyContent: 'center',
                    gap: 4, padding: 4,
                    borderRight: '1px solid var(--color-border-subtle)',
                    width: layout.routingColWidth,
                    minWidth: layout.routingColWidth,
                    maxWidth: layout.routingColWidth,
                    boxSizing: 'border-box',
                }}>
                    <div style={{
                        display: 'flex', alignItems: 'center',
                        fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--font-weight-medium)' as unknown as number,
                        color: 'var(--color-text-tertiary)',
                        background: 'var(--color-control-bg)',
                        border: '1px solid var(--color-control-border)',
                        borderRadius: 'var(--radius-md)',
                        padding: '0 8px 0 6px',
                        lineHeight: '15px', height: 15,
                        cursor: 'default', userSelect: 'none',
                    }}>
                        <span style={{ marginRight: 4, fontSize: 'var(--font-size-micro)' }}>←</span>
                        No Input
                    </div>
                    <div style={{
                        display: 'flex', alignItems: 'center',
                        fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--font-weight-medium)' as unknown as number,
                        color: 'var(--color-text-secondary)',
                        background: 'var(--color-control-bg)',
                        border: '1px solid var(--color-control-border)',
                        borderRadius: 'var(--radius-md)',
                        padding: '0 8px 0 6px',
                        lineHeight: '15px', height: 15,
                        cursor: 'default', userSelect: 'none',
                    }}>
                        <span style={{ marginRight: 4, fontSize: 'var(--font-size-micro)' }}>→</span>
                        Out 1-2
                    </div>
                </div>
            )}

            {showRoutingCompact && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 64,
                    maxWidth: 76,
                    borderRight: '1px solid color-mix(in srgb, var(--surface-elevated) 72%, #000)',
                    color: 'var(--text-muted)',
                    fontSize: 'var(--font-size-2xs)',
                    fontFamily: 'var(--font-mono)',
                }}>
                    {outputValue === 'master' ? '→M' : '→T'} · {inputValue === 'none' ? '←∅' : '←IN'}
                </div>
            )}

            {/* ════ BLOCK 3: Mixer (gray background) ════ */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: `${layout.muteSoloColWidth}px ${layout.faderColWidth}px ${layout.armColWidth}px ${layout.meterColWidth}px`,
                alignItems: 'center',
                columnGap: layout.mixerColumnGapPx,
                padding: `${layout.mixerPaddingY}px ${layout.mixerPaddingX}px`,
                width: layout.mixerSectionWidthPx,
                minWidth: layout.mixerSectionWidthPx,
                maxWidth: layout.mixerSectionWidthPx,
                flex: '0 0 auto',
                overflow: 'hidden',
                background: 'color-mix(in srgb, var(--surface-2) 55%, transparent)',
                boxSizing: 'border-box',
            }}>
                {/* Column 1: Enable + Solo */}
                {!isMaster ? (
                    <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        width: layout.muteSoloColWidth,
                        minWidth: layout.muteSoloColWidth,
                    }}>
                        <button
                            onClick={e => { e.stopPropagation(); onToggleMute(); }}
                            title={isEnabled ? 'Disable track' : 'Enable track'}
                            style={{
                                width: layout.muteSoloColWidth,
                                height: compactControlHeight,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: isEnabled ? 'var(--color-status-success)' : 'var(--surface-elevated)',
                                color: isEnabled ? 'var(--color-text-on-color)' : 'var(--text-muted)',
                                border: 'none',
                                borderRadius: 'var(--radius-xs)',
                                fontSize: 'var(--font-size-micro)',
                                fontWeight: 'var(--font-weight-bold)' as unknown as number,
                                fontFamily: 'var(--font-mono)',
                                cursor: 'pointer',
                                padding: 0,
                                transition: `background var(--transition-micro)`,
                            }}
                        >{displayNum ?? '●'}</button>
                        <button
                            onClick={e => { e.stopPropagation(); onToggleSolo(); }}
                            title="Solo"
                            style={{
                                width: layout.muteSoloColWidth,
                                height: compactControlHeight,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: track.isSoloed
                                    ? 'var(--color-accent-primary)'
                                    : 'color-mix(in srgb, var(--color-accent-primary) 8%, var(--surface-elevated))',
                                color: track.isSoloed ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
                                border: track.isSoloed
                                    ? 'none'
                                    : '1px solid color-mix(in srgb, var(--text-primary) 18%, transparent)',
                                borderRadius: 'var(--radius-xs)',
                                fontSize: 'var(--font-size-micro)',
                                fontWeight: 'var(--font-weight-bold)' as unknown as number,
                                cursor: 'pointer',
                                padding: 0,
                                transition: 'background 0.1s ease',
                            }}
                            onMouseEnter={(e) => {
                                if (track.isSoloed) return;
                                e.currentTarget.style.background = 'color-mix(in srgb, var(--color-accent-primary) 12%, var(--surface-elevated))';
                            }}
                            onMouseLeave={(e) => {
                                if (track.isSoloed) return;
                                e.currentTarget.style.background = 'color-mix(in srgb, var(--color-accent-primary) 8%, var(--surface-elevated))';
                            }}
                        >S</button>
                    </div>
                ) : (
                    <div
                        aria-hidden
                        style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 4,
                            width: layout.muteSoloColWidth,
                            minWidth: layout.muteSoloColWidth,
                        }}
                    >
                        <div style={{ width: layout.muteSoloColWidth, height: compactControlHeight }} />
                        <div style={{ width: layout.muteSoloColWidth, height: compactControlHeight }} />
                    </div>
                )}

                {/* Column 2: Faders */}
                {!isGroup && !isMaster && mixerFocusMode && onVolumeChange && onPanChange ? (
                    <VerticalMixerStrip
                        volumeLinear={track.volume}
                        pan={track.pan}
                        peakDb={track.vuLevel}
                        peakDbL={track.vuLevelL}
                        peakDbR={track.vuLevelR}
                        isMidi={false}
                        onVolumeChange={onVolumeChange}
                        onPanChange={onPanChange}
                    />
                ) : (
                    <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        width: layout.faderColWidth,
                        minWidth: layout.faderColWidth,
                        maxWidth: layout.faderColWidth,
                        minHeight: compactControlHeight * 2 + 4,
                        justifyContent: 'center',
                    }}>
                        {onVolumeChange && (
                            <VolumeFader
                                volumeLinear={track.volume}
                                onVolumeChange={onVolumeChange}
                                compact
                                showZeroTick
                                controlHeight={compactControlHeight}
                            />
                        )}
                        {!isMaster && onPanChange && (
                            <PanFader
                                pan={track.pan}
                                onPanChange={onPanChange}
                                compact
                                controlHeight={compactControlHeight}
                            />
                        )}
                    </div>
                )}

                {/* Column 3: Arm + spacer (keeps grid stable) */}
                {!isMaster && !isGroup ? (
                    <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        width: layout.armColWidth,
                        minWidth: layout.armColWidth,
                    }}>
                        <button
                            onClick={(e) => { e.stopPropagation(); onToggleArm(); }}
                            title="Arm for recording"
                            style={{
                                width: layout.armColWidth,
                                height: layout.armColWidth,
                                borderRadius: 'var(--radius-xs)',
                                border: '1px solid color-mix(in srgb, var(--text-primary) 12%, transparent)',
                                background: track.isArmed
                                    ? 'color-mix(in srgb, var(--color-status-record) 55%, transparent)'
                                    : 'var(--surface-elevated)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                padding: 0,
                                cursor: 'pointer',
                            }}
                        >
                            <span style={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: track.isArmed ? 'var(--color-status-record)' : 'color-mix(in srgb, var(--color-control-tint) 38%, transparent)',
                                boxShadow: track.isArmed ? '0 0 6px color-mix(in srgb, var(--color-status-record) 80%, transparent)' : 'none',
                            }} />
                        </button>
                        <div
                            aria-hidden
                            style={{
                                width: layout.armColWidth,
                                height: layout.armColWidth,
                                borderRadius: 'var(--radius-xs)',
                                border: '1px solid color-mix(in srgb, var(--text-primary) 10%, transparent)',
                                background: 'var(--surface-elevated)',
                            }}
                        />
                    </div>
                ) : (
                    <div
                        aria-hidden
                        style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 4,
                            width: layout.armColWidth,
                            minWidth: layout.armColWidth,
                        }}
                    >
                        <div
                            style={{
                                width: layout.armColWidth,
                                height: layout.armColWidth,
                                borderRadius: 'var(--radius-xs)',
                                border: '1px solid color-mix(in srgb, var(--text-primary) 7%, transparent)',
                                background: 'color-mix(in srgb, var(--surface-elevated) 85%, transparent)',
                                opacity: 0.45,
                            }}
                        />
                        <div
                            style={{
                                width: layout.armColWidth,
                                height: layout.armColWidth,
                                borderRadius: 'var(--radius-xs)',
                                border: '1px solid color-mix(in srgb, var(--text-primary) 7%, transparent)',
                                background: 'color-mix(in srgb, var(--surface-elevated) 85%, transparent)',
                                opacity: 0.45,
                            }}
                        />
                    </div>
                )}

                {/* Column 4: VU */}
                <TriColorVU
                    peakDb={track.vuLevel}
                    peakDbL={track.vuLevelL}
                    peakDbR={track.vuLevelR}
                    isMidi={false}
                    compact
                    isEnabled={isMaster ? true : isMeterActive}
                    trackHeight={trackHeight}
                />
            </div>

            {isGroupDropTarget && isGroup && (
                <div style={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    zIndex: 'var(--z-local-raised)' as unknown as number,
                    boxShadow: 'inset 0 0 0 2px color-mix(in srgb, var(--color-text-bright) 78%, transparent), inset 0 0 16px color-mix(in srgb, var(--color-text-bright) 22%, transparent)',
                }} />
            )}

            <div
                role="presentation"
                onPointerEnter={() => setResizeHot(true)}
                onPointerLeave={() => setResizeHot(false)}
                onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onResizeStart?.(e.clientY);
                }}
                style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: -3,
                    height: 7,
                    cursor: 'ns-resize',
                    zIndex: 'var(--z-local)' as unknown as number,
                }}
            />
            {(resizeHot || isResizing) && (
                <div
                    aria-hidden
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        bottom: 0,
                        height: 1,
                        background: 'color-mix(in srgb, var(--color-accent-primary) 76%, white)',
                        boxShadow: '0 0 6px color-mix(in srgb, var(--color-accent-primary) 35%, transparent)',
                        pointerEvents: 'none',
                        zIndex: 'var(--z-local)' as unknown as number,
                    }}
                />
            )}
        </div>
    );
};

// ── Color Picker Popup (16-color grid) ──────────────────

const ColorPickerPopup = ({
    x, y, currentColor, onSelect, onDismiss,
}: {
    x: number; y: number;
    currentColor: string;
    onSelect: (color: string) => void;
    onDismiss: () => void;
}) => {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
        };
        const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [onDismiss]);

    const popupWidth = 148;
    const popupHeight = 160;
    const clampedX = Math.min(x, window.innerWidth - popupWidth - 8);
    const clampedY = Math.min(y, window.innerHeight - popupHeight - 8);

    const node = (
        <div ref={ref} style={{
            position: 'fixed', left: clampedX, top: clampedY, width: popupWidth,
            background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-subtle)',
            borderRadius: 'var(--radius-xl)', padding: 8, zIndex: 'var(--z-menu)' as unknown as number,
            boxShadow: '0 8px 32px var(--color-overlay-dark)',
        }}>
            <div style={{
                fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                color: 'var(--color-text-secondary)',
                textTransform: 'uppercase', letterSpacing: '0.05em',
                marginBottom: 6, textAlign: 'center',
            }}>Track Color</div>

            <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4,
            }}>
                {TRACK_PALETTE.map((c) => {
                    const isActive = currentColor.toLowerCase() === c.hex.toLowerCase();
                    return (
                        <button
                            key={c.hex}
                            title={c.name}
                            onClick={() => onSelect(c.hex)}
                            style={{
                                width: 28, height: 28, borderRadius: 'var(--radius-lg)',
                                background: c.hex,
                                border: isActive ? '2px solid var(--color-text-bright)' : '2px solid transparent',
                                cursor: 'pointer',
                                transition: `transform var(--transition-micro), border-color var(--transition-fast)`,
                                boxShadow: isActive ? `0 0 6px ${c.hex}80` : 'none',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.1)'; }}
                            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
                        />
                    );
                })}
            </div>
        </div>
    );

    if (typeof document !== 'undefined' && document.body) {
        return createPortal(node, document.body);
    }
    return node;
};
