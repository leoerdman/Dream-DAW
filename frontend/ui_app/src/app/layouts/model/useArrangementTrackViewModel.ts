import { useCallback, useEffect, useMemo, useState } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import type { EntityState } from '@/shared/stores/engine/storeHelpers';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { ProjectDelta } from '@/shared/api/engine';
import { dreamGlobals } from '@/shared/lib/dreamGlobals';

type BottomPanelMode = 'rack' | 'clip';

type Args = {
    tracksEntity: EntityState<ProjectTrack>;
    selectedTrackId: string;
    selectedTrackIds: string[];
    selectedClipId: string | null;
    timelineClipsForView: TimelineClip[];
    bottomPanelModeByTrack: Record<string, BottomPanelMode>;
    setSelectedTrackId: React.Dispatch<React.SetStateAction<string>>;
    setBottomPanelMode: React.Dispatch<React.SetStateAction<BottomPanelMode>>;
    applyProjectDeltas: (deltas: ProjectDelta[], reason?: string) => Promise<void>;
};

type Result = {
    panelInfo: string;
    collapsedGroups: Set<string>;
    trackIds: string[];
    hiddenTrackIndices: Set<number>;
    trackCountRaw: number;
    trackCount: number;
    selectedTrackIndex: number;
    selectedTrackIndices: number[];
    selectedTimelineClip: TimelineClip | null;
    toggleGroupCollapse: (groupId: string) => void;
};

export function useArrangementTrackViewModel({
    tracksEntity,
    selectedTrackId,
    selectedTrackIds,
    selectedClipId,
    timelineClipsForView,
    bottomPanelModeByTrack,
    setSelectedTrackId,
    setBottomPanelMode,
    applyProjectDeltas,
}: Args): Result {
    const [collapsedOverrides, setCollapsedOverrides] = useState<Record<string, boolean>>({});
    const trackById = tracksEntity.byId;
    const orderedTrackIds = tracksEntity.allIds;
    const trackIndexById = useMemo(
        () => new Map(orderedTrackIds.map((trackId, index) => [trackId, index] as const)),
        [orderedTrackIds],
    );

    useEffect(() => {
        if (orderedTrackIds.length === 0) {
            if (selectedTrackId !== 'master') setSelectedTrackId('master');
            return;
        }
        const exists = Boolean(trackById[selectedTrackId]);
        if (!exists) {
            setSelectedTrackId(orderedTrackIds[0]);
        }
    }, [orderedTrackIds, selectedTrackId, setSelectedTrackId, trackById]);

    useEffect(() => {
        const key = selectedTrackId && selectedTrackId.length > 0 ? selectedTrackId : 'master';
        const saved = bottomPanelModeByTrack[key] ?? 'rack';
        setBottomPanelMode((prev) => (prev === saved ? prev : saved));
    }, [selectedTrackId, bottomPanelModeByTrack, setBottomPanelMode]);

    useEffect(() => {
        dreamGlobals.setSelectedTrackId(selectedTrackId);
        return () => {
            dreamGlobals.clearSelectedTrackId(selectedTrackId);
        };
    }, [selectedTrackId]);

    const panelInfo = useMemo(() => {
        const selected = selectedTrackId === 'master'
            ? null
            : (trackById[selectedTrackId] ?? null);
        const name = selectedTrackId === 'master' ? 'Master' : (selected?.name || 'No Track');
        const deviceCount = selected ? ((selected.instrument ? 1 : 0) + (selected.effects?.length ?? 0)) : 0;
        return `${name} · ${deviceCount} devices`;
    }, [trackById, selectedTrackId]);

    const baseCollapsedGroups = useMemo(() => {
        const collapsed = new Set<string>();
        for (const trackId of orderedTrackIds) {
            const track = trackById[trackId];
            if (!track) continue;
            const normalized = (track.track_type ?? '').toLowerCase();
            if (normalized === 'group' && track.is_expanded === false) {
                collapsed.add(track.id);
            }
        }
        return collapsed;
    }, [orderedTrackIds, trackById]);

    const collapsedGroups = useMemo(() => {
        const merged = new Set(baseCollapsedGroups);
        for (const [groupId, isCollapsed] of Object.entries(collapsedOverrides)) {
            if (isCollapsed) merged.add(groupId);
            else merged.delete(groupId);
        }
        return merged;
    }, [baseCollapsedGroups, collapsedOverrides]);

    const toggleGroupCollapse = useCallback((groupId: string) => {
        const currentlyCollapsed = collapsedGroups.has(groupId);
        const expanded = currentlyCollapsed;
        setCollapsedOverrides((prev) => ({
            ...prev,
            [groupId]: !currentlyCollapsed,
        }));
        void engineApi
            .setGroupExpandedWithDeltas(groupId, expanded)
            .then((response) => applyProjectDeltas(response.deltas, 'daw-shell:set-group-expanded'))
            .catch((err) => {
                console.error('[Dream] setGroupExpanded failed:', err);
            });
    }, [applyProjectDeltas, collapsedGroups]);

    const trackIds = orderedTrackIds;
    const hiddenTrackIndices = useMemo(() => {
        const hidden = new Set<number>();
        if (collapsedGroups.size === 0) return hidden;

        const isAncestorCollapsed = (trackId: string): boolean => {
            let parentId = trackById[trackId]?.parent_track_id;
            while (parentId) {
                if (collapsedGroups.has(parentId)) return true;
                parentId = trackById[parentId]?.parent_track_id;
            }
            return false;
        };

        for (let i = 0; i < orderedTrackIds.length; i++) {
            if (isAncestorCollapsed(orderedTrackIds[i])) {
                hidden.add(i);
            }
        }
        return hidden;
    }, [orderedTrackIds, collapsedGroups, trackById]);

    const trackCountRaw = Math.max(orderedTrackIds.length, 1);
    const trackCount = Math.max(trackCountRaw - hiddenTrackIndices.size, 1);

    const selectedTrackIndex = useMemo(() => {
        if (!selectedTrackId || selectedTrackId === 'master') return -1;
        const rawIndex = trackIndexById.get(selectedTrackId) ?? -1;
        if (rawIndex >= 0 && hiddenTrackIndices.has(rawIndex)) {
            for (let i = rawIndex - 1; i >= 0; i--) {
                if (!hiddenTrackIndices.has(i)) return i;
            }
            for (let i = rawIndex + 1; i < orderedTrackIds.length; i++) {
                if (!hiddenTrackIndices.has(i)) return i;
            }
        }
        return rawIndex;
    }, [orderedTrackIds, selectedTrackId, hiddenTrackIndices, trackIndexById]);

    const selectedTrackIndices = useMemo(() => {
        const out: number[] = [];
        for (const id of selectedTrackIds) {
            const idx = trackIndexById.get(id);
            if (typeof idx === 'number' && idx >= 0) out.push(idx);
        }
        return out;
    }, [selectedTrackIds, trackIndexById]);

    const selectedTimelineClip = useMemo(
        () => timelineClipsForView.find((clip) => clip.id === selectedClipId) ?? null,
        [timelineClipsForView, selectedClipId],
    );

    return {
        panelInfo,
        collapsedGroups,
        trackIds,
        hiddenTrackIndices,
        trackCountRaw,
        trackCount,
        selectedTrackIndex,
        selectedTrackIndices,
        selectedTimelineClip,
        toggleGroupCollapse,
    };
}
