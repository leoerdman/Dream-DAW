import { useCallback, useEffect, useMemo, useState } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { ProjectDelta } from '@/shared/api/engine';

type BottomPanelMode = 'rack' | 'clip';

type Args = {
    projectTracks: ProjectTrack[];
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
    projectTracks,
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

    useEffect(() => {
        if (projectTracks.length === 0) {
            if (selectedTrackId !== 'master') setSelectedTrackId('master');
            return;
        }
        const exists = projectTracks.some((track) => track.id === selectedTrackId);
        if (!exists) {
            setSelectedTrackId(projectTracks[0].id);
        }
    }, [projectTracks, selectedTrackId, setSelectedTrackId]);

    useEffect(() => {
        const key = selectedTrackId && selectedTrackId.length > 0 ? selectedTrackId : 'master';
        const saved = bottomPanelModeByTrack[key] ?? 'rack';
        setBottomPanelMode((prev) => (prev === saved ? prev : saved));
    }, [selectedTrackId, bottomPanelModeByTrack, setBottomPanelMode]);

    useEffect(() => {
        window.__dreamSelectedTrackId = selectedTrackId;
        return () => {
            if (window.__dreamSelectedTrackId === selectedTrackId) {
                delete window.__dreamSelectedTrackId;
            }
        };
    }, [selectedTrackId]);

    const panelInfo = useMemo(() => {
        const selected = selectedTrackId === 'master'
            ? null
            : (projectTracks.find((track) => track.id === selectedTrackId) ?? null);
        const name = selectedTrackId === 'master' ? 'Master' : (selected?.name || 'No Track');
        const deviceCount = selected ? ((selected.instrument ? 1 : 0) + (selected.effects?.length ?? 0)) : 0;
        return `${name} · ${deviceCount} devices`;
    }, [projectTracks, selectedTrackId]);

    const baseCollapsedGroups = useMemo(() => {
        const collapsed = new Set<string>();
        for (const track of projectTracks) {
            const normalized = (track.track_type ?? '').toLowerCase();
            if (normalized === 'group' && track.is_expanded === false) {
                collapsed.add(track.id);
            }
        }
        return collapsed;
    }, [projectTracks]);

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
                console.error('[DawShell] setGroupExpanded failed:', err);
            });
    }, [applyProjectDeltas, collapsedGroups]);

    const trackIds = useMemo(() => projectTracks.map((track) => track.id), [projectTracks]);
    const hiddenTrackIndices = useMemo(() => {
        const hidden = new Set<number>();
        if (collapsedGroups.size === 0) return hidden;

        const trackById = new Map(projectTracks.map((track) => [track.id, track]));
        const isAncestorCollapsed = (trackId: string): boolean => {
            let parentId = trackById.get(trackId)?.parent_track_id;
            while (parentId) {
                if (collapsedGroups.has(parentId)) return true;
                parentId = trackById.get(parentId)?.parent_track_id;
            }
            return false;
        };

        for (let i = 0; i < projectTracks.length; i++) {
            if (isAncestorCollapsed(projectTracks[i].id)) {
                hidden.add(i);
            }
        }
        return hidden;
    }, [projectTracks, collapsedGroups]);

    const trackCountRaw = Math.max(projectTracks.length, 1);
    const trackCount = Math.max(trackCountRaw - hiddenTrackIndices.size, 1);

    const selectedTrackIndex = useMemo(() => {
        if (!selectedTrackId || selectedTrackId === 'master') return -1;
        const rawIndex = projectTracks.findIndex((track) => track.id === selectedTrackId);
        if (rawIndex >= 0 && hiddenTrackIndices.has(rawIndex)) {
            for (let i = rawIndex - 1; i >= 0; i--) {
                if (!hiddenTrackIndices.has(i)) return i;
            }
            for (let i = rawIndex + 1; i < projectTracks.length; i++) {
                if (!hiddenTrackIndices.has(i)) return i;
            }
        }
        return rawIndex;
    }, [projectTracks, selectedTrackId, hiddenTrackIndices]);

    const selectedTrackIndices = useMemo(() => {
        const byId = new Map(projectTracks.map((track, index) => [track.id, index] as const));
        const out: number[] = [];
        for (const id of selectedTrackIds) {
            const idx = byId.get(id);
            if (typeof idx === 'number' && idx >= 0) out.push(idx);
        }
        return out;
    }, [projectTracks, selectedTrackIds]);

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
