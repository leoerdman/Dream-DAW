import type { ProjectTrack } from '@/shared/lib/trackAdapter';
import type { DeltaWorkingState } from './types';

export function getTrackIdByIndex(state: DeltaWorkingState, index: number): string | null {
    if (index < 0 || index >= state.projectTracks.length) return null;
    return state.projectTracks[index]?.id ?? null;
}

export function getTrackCount(state: DeltaWorkingState): number {
    return state.projectTracks.length;
}

export function findTrackIndexById(state: DeltaWorkingState, trackId: string): number {
    return state.projectTracks.findIndex((track) => track.id === trackId);
}

export function getTrackByIndex(state: DeltaWorkingState, index: number): ProjectTrack | null {
    const trackId = getTrackIdByIndex(state, index);
    if (!trackId) return null;
    return state.tracks.byId[trackId] ?? null;
}

export function syncTrackCollections(state: DeltaWorkingState): void {
    state.projectTracks = state.projectTracks
        .map((track) => state.tracks.byId[track.id] ?? track)
        .filter((track): track is ProjectTrack => Boolean(track));
    state.tracks = {
        byId: { ...state.tracks.byId },
        allIds: state.projectTracks.map((track) => track.id),
    };
}

export function patchTrackById(
    state: DeltaWorkingState,
    trackId: string,
    patch: Partial<ProjectTrack>,
): void {
    const current = state.tracks.byId[trackId];
    if (!current) return;
    const next = { ...current, ...patch };
    state.tracks = {
        byId: { ...state.tracks.byId, [trackId]: next },
        allIds: state.tracks.allIds,
    };
    syncTrackCollections(state);
    state.changed = true;
}

export function insertTrackAt(
    state: DeltaWorkingState,
    index: number,
    track: ProjectTrack,
): void {
    const nextTracks = state.projectTracks.slice();
    const insertIndex = Math.max(0, Math.min(index, nextTracks.length));
    nextTracks.splice(insertIndex, 0, track);
    state.projectTracks = nextTracks;
    state.tracks = {
        byId: { ...state.tracks.byId, [track.id]: track },
        allIds: nextTracks.map((t) => t.id),
    };
    state.changed = true;
}

export function removeTrackById(
    state: DeltaWorkingState,
    trackId: string,
): number {
    const removeIndex = state.projectTracks.findIndex((track) => track.id === trackId);
    if (removeIndex < 0) return -1;
    state.projectTracks = state.projectTracks.filter((track) => track.id !== trackId);
    const nextById = { ...state.tracks.byId };
    delete nextById[trackId];
    state.tracks = {
        byId: nextById,
        allIds: state.projectTracks.map((track) => track.id),
    };
    state.changed = true;
    return removeIndex;
}

export function moveTrackById(
    state: DeltaWorkingState,
    trackId: string,
    newIndex: number,
): { oldIndex: number; newIndex: number } | null {
    const oldIndex = state.projectTracks.findIndex((track) => track.id === trackId);
    if (oldIndex < 0) return null;
    const tracksLen = state.projectTracks.length;
    if (tracksLen === 0) return null;
    const boundedNewIndex = Math.max(0, Math.min(newIndex, tracksLen - 1));
    if (oldIndex === boundedNewIndex) return { oldIndex, newIndex: boundedNewIndex };

    const nextTracks = state.projectTracks.slice();
    const [moved] = nextTracks.splice(oldIndex, 1);
    nextTracks.splice(boundedNewIndex, 0, moved);
    state.projectTracks = nextTracks;
    state.changed = true;
    return { oldIndex, newIndex: boundedNewIndex };
}

export function rebuildChildTrackIds(state: DeltaWorkingState): void {
    const childrenByParent: Record<string, string[]> = {};
    for (const track of state.projectTracks) {
        const parentId = track.parent_track_id ?? null;
        if (!parentId) continue;
        if (!childrenByParent[parentId]) childrenByParent[parentId] = [];
        childrenByParent[parentId].push(track.id);
    }

    const nextById: Record<string, ProjectTrack> = { ...state.tracks.byId };
    for (const track of state.projectTracks) {
        const nextChildIds = childrenByParent[track.id] ?? [];
        const current = nextById[track.id];
        if (!current) continue;
        nextById[track.id] = {
            ...current,
            child_track_ids: nextChildIds,
        };
    }

    state.tracks = {
        byId: nextById,
        allIds: state.projectTracks.map((track) => track.id),
    };
    syncTrackCollections(state);
    state.changed = true;
}
