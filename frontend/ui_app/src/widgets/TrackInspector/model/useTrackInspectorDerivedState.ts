import { useCallback, useMemo } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { isTrackActive } from '@/shared/utils/routing';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import type { MeteringSnapshot } from '@/shared/api/engine';
import type { TrackData, TrackRowLayoutMetrics } from '@/widgets/TrackInspector/model/trackModels';
import { mapProjectTrack } from '@/widgets/TrackInspector/model/trackModels';

interface UseTrackInspectorDerivedStateArgs {
    trackIds: string[];
    tracksByIdState: Record<string, ProjectTrack>;
    meters: MeteringSnapshot;
    masterVolume: number;
    trackHeight: number;
    mixerFocusMode: boolean;
    localOverrides: Record<string, Partial<TrackData>>;
    rowHeightOverrides: Record<string, number>;
    localCollapsedGroups: Set<string> | null;
    setLocalCollapsedGroups: React.Dispatch<React.SetStateAction<Set<string> | null>>;
    collapsedGroupsProp?: Set<string>;
    onToggleGroupCollapseProp?: (groupId: string) => void;
}

export function useTrackInspectorDerivedState({
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
}: UseTrackInspectorDerivedStateArgs) {
    const orderedTracks = useMemo(
        () => trackIds
            .map((id) => tracksByIdState[id])
            .filter((track): track is NonNullable<typeof track> => Boolean(track)),
        [trackIds, tracksByIdState],
    );

    const trackActiveStates = useMemo(() => orderedTracks.map((_t, i, arr) => isTrackActive(i, arr)), [orderedTracks]);

    const liveTracks = useMemo((): TrackData[] => {
        const mapped = orderedTracks.map((pt, idx) => mapProjectTrack(pt, idx, meters.tracks[idx]));
        for (const t of mapped) {
            if (t.type !== 'group') continue;
            let maxL = -Infinity;
            let maxR = -Infinity;
            for (const child of mapped) {
                if (child.groupId !== t.id) continue;
                if (child.vuLevelL > maxL) maxL = child.vuLevelL;
                if (child.vuLevelR > maxR) maxR = child.vuLevelR;
            }
            if (maxL > -Infinity) {
                t.vuLevelL = maxL;
                t.vuLevelR = maxR;
                t.vuLevel = Math.max(maxL, maxR);
            }
        }
        return mapped;
    }, [orderedTracks, meters]);

    const masterTrack = useMemo((): TrackData => {
        const masterVuL = meters.master_left.peak;
        const masterVuR = meters.master_right.peak;
        return {
            id: 'master',
            name: 'Master',
            type: 'master',
            color: 'var(--token-color-hex-3a3a3a)',
            volume: masterVolume,
            pan: 0,
            isMuted: false,
            isSoloed: false,
            isArmed: false,
            vuLevel: Math.max(masterVuL, masterVuR),
            vuLevelL: masterVuL,
            vuLevelR: masterVuR,
            routing: '',
            sends: [],
            input: '',
            output: 'Main',
            height: trackHeight,
        };
    }, [meters, masterVolume, trackHeight]);

    const tracks = useMemo(() => liveTracks.map((t) => ({ ...t, ...(localOverrides[t.id] || {}) })), [liveTracks, localOverrides]);

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

    const backendCollapsedGroups = useMemo(() => {
        const collapsed = new Set<string>();
        for (const pt of orderedTracks) {
            const normalized = (pt.track_type ?? '').toLowerCase();
            if (normalized === 'group' && pt.is_expanded === false) collapsed.add(pt.id);
        }
        return collapsed;
    }, [orderedTracks]);

    const collapsedGroups = collapsedGroupsProp ?? localCollapsedGroups ?? backendCollapsedGroups;

    const toggleGroupCollapse = useCallback((groupId: string) => {
        if (onToggleGroupCollapseProp) {
            onToggleGroupCollapseProp(groupId);
            return;
        }
        setLocalCollapsedGroups((prev) => {
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
            void engineApi
                .setGroupExpandedWithDeltas(groupId, expanded)
                .then((response) =>
                    useEngineStore
                        .getState()
                        .applyProjectDeltas(response.deltas, 'track-inspector:set-group-expanded'),
                )
                .catch((err) => {
                    console.error('[TrackInspector] setGroupExpanded failed:', err);
                });
            return next;
        });
    }, [onToggleGroupCollapseProp, backendCollapsedGroups, setLocalCollapsedGroups]);

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

    const visibleTracks = useMemo(() => tracks.filter((t) => !isAncestorCollapsed(t)), [tracks, isAncestorCollapsed]);

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

    const getDepth = useCallback((track: TrackData): number => depthByTrackId.get(track.id) ?? 0, [depthByTrackId]);

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
            muteSoloColWidth + faderColWidth + armColWidth + meterColWidth + mixerColumnGapPx * 3 + mixerPaddingX * 2;

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

    return {
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
    };
}
