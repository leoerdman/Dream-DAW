import type { TrackData } from '@/widgets/TrackInspector/model/trackModels';

export function isDescendantOf(
    tracks: TrackData[],
    candidateId: string,
    ancestorId: string,
): boolean {
    let current = tracks.find((t) => t.id === candidateId);
    while (current?.groupId) {
        const nextGroupId = current.groupId;
        if (nextGroupId === ancestorId) return true;
        current = tracks.find((t) => t.id === nextGroupId);
    }
    return false;
}

export function findGroupTailInsertIndex(tracks: TrackData[], groupId: string): number {
    const groupIndex = tracks.findIndex((t) => t.id === groupId);
    if (groupIndex < 0) return tracks.length;
    let tail = groupIndex + 1;
    while (tail < tracks.length) {
        const candidate = tracks[tail];
        if (!isDescendantOf(tracks, candidate.id, groupId)) break;
        tail += 1;
    }
    return tail;
}

export function canDropTrackIntoGroup(
    tracks: TrackData[],
    trackId: string,
    groupId: string,
): boolean {
    const draggingTrack = tracks.find((t) => t.id === trackId);
    const targetGroup = tracks.find((t) => t.id === groupId);
    if (!draggingTrack || !targetGroup) return false;
    if (targetGroup.type !== 'group') return false;
    if (trackId === groupId) return false;
    if (isDescendantOf(tracks, groupId, trackId)) return false;
    return true;
}

export function computeRawInsertIndex(
    tracks: TrackData[],
    visibleTracks: TrackData[],
    visibleInsertIndex: number,
): number {
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
}

export function resolveGroupAtVisibleInsertIndex(
    visibleTracks: TrackData[],
    visibleInsertIndex: number,
): string | null {
    const prev = visibleInsertIndex > 0 ? visibleTracks[visibleInsertIndex - 1] : null;
    const next = visibleInsertIndex < visibleTracks.length ? visibleTracks[visibleInsertIndex] : null;
    const prevGroup = prev?.groupId ?? null;
    const nextGroup = next?.groupId ?? null;
    if (prevGroup && nextGroup && prevGroup === nextGroup) return prevGroup;
    if (prev?.type === 'group' && nextGroup === prev.id) return prev.id;
    if (next?.type === 'group' && prevGroup === next.id) return next.id;
    return null;
}

export function computeGroupInsertIndex(
    tracks: TrackData[],
    trackId: string,
    groupId: string,
    visibleInsertIndex: number | null,
    rawInsertIndexFromVisible: (visibleIndex: number) => number,
): number {
    const groupIndex = tracks.findIndex((t) => t.id === groupId);
    if (groupIndex < 0) return findGroupTailInsertIndex(tracks, groupId);
    const dragIndex = tracks.findIndex((t) => t.id === trackId);
    const groupStart = groupIndex + 1;
    let groupTail = findGroupTailInsertIndex(tracks, groupId);
    if (dragIndex >= groupStart && dragIndex < groupTail) {
        groupTail -= 1;
    }
    if (visibleInsertIndex == null) {
        return Math.max(groupStart, groupTail);
    }
    const rawInsertIndex = rawInsertIndexFromVisible(visibleInsertIndex);
    const adjustedInsert = dragIndex >= 0 && rawInsertIndex > dragIndex
        ? rawInsertIndex - 1
        : rawInsertIndex;
    return Math.max(groupStart, Math.min(groupTail, adjustedInsert));
}

export function computeVisibleInsertIndexFromClientY(
    visibleTracks: TrackData[],
    rowRefs: Record<string, HTMLDivElement | null>,
    clientY: number,
): number {
    if (visibleTracks.length === 0) return 0;
    for (let i = 0; i < visibleTracks.length; i += 1) {
        const track = visibleTracks[i];
        const row = rowRefs[track.id];
        if (!row) continue;
        const rect = row.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
            return i;
        }
    }
    return visibleTracks.length;
}

export function resolveDropTargetFromClientY(
    tracks: TrackData[],
    visibleTracks: TrackData[],
    rowRefs: Record<string, HTMLDivElement | null>,
    clientY: number,
    dragId: string,
): { groupId: string | null; insertIndex: number | null } {
    const draggingTrack = tracks.find((t) => t.id === dragId);
    for (let i = 0; i < visibleTracks.length; i += 1) {
        const track = visibleTracks[i];
        const row = rowRefs[track.id];
        if (!row) continue;
        const rect = row.getBoundingClientRect();
        if (clientY < rect.top || clientY > rect.bottom) continue;
        const canNestIntoGroup = Boolean(
            draggingTrack
            && track.type === 'group'
            && dragId !== track.id
            && !isDescendantOf(tracks, track.id, dragId),
        );
        if (canNestIntoGroup) {
            const edgeZone = Math.max(4, rect.height * 0.12);
            const topZone = rect.top + edgeZone;
            const bottomZone = rect.bottom - edgeZone;
            if (clientY >= topZone && clientY <= bottomZone) {
                return { groupId: track.id, insertIndex: null };
            }
        }
        const insertBefore = clientY < rect.top + rect.height / 2;
        const insertIndex = insertBefore ? i : i + 1;
        const boundaryGroupId = resolveGroupAtVisibleInsertIndex(visibleTracks, insertIndex);
        // ENTERPRISE: If the dragged track already belongs to this group AND the
        // insert position is at the edge (first or last slot), allow the track to
        // LEAVE the group by returning groupId: null. This enables drag-out-of-group.
        if (boundaryGroupId && canDropTrackIntoGroup(tracks, dragId, boundaryGroupId)) {
            if (draggingTrack?.groupId === boundaryGroupId) {
                // Check if inserting at the boundary of the group (first or last visible child).
                const groupChildren = visibleTracks.filter(
                    (t) => t.groupId === boundaryGroupId || t.id === boundaryGroupId,
                );
                const firstChildIdx = visibleTracks.indexOf(groupChildren[0]);
                const lastChildIdx = visibleTracks.indexOf(groupChildren[groupChildren.length - 1]);
                if (insertIndex <= firstChildIdx || insertIndex > lastChildIdx + 1) {
                    return { groupId: null, insertIndex };
                }
            }
            return { groupId: boundaryGroupId, insertIndex };
        }
        return { groupId: null, insertIndex };
    }
    // ENTERPRISE: Bottom-of-list drop — allow tracks to escape groups.
    // If the dragged track's current group is the boundary group, return null.
    const boundaryGroupId = resolveGroupAtVisibleInsertIndex(visibleTracks, visibleTracks.length);
    if (boundaryGroupId && canDropTrackIntoGroup(tracks, dragId, boundaryGroupId)) {
        if (draggingTrack?.groupId === boundaryGroupId) {
            return { groupId: null, insertIndex: visibleTracks.length };
        }
        return { groupId: boundaryGroupId, insertIndex: visibleTracks.length };
    }
    return { groupId: null, insertIndex: visibleTracks.length };
}
