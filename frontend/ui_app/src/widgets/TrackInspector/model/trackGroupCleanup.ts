import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';

/**
 * ENTERPRISE SSOT: Auto-delete a group track if it has zero remaining children.
 *
 * Called after any operation that removes a track from a group:
 * - Drag-out-of-group (commitTrackReorder)
 * - Move between groups (commitTrackToGroup)
 * - Context menu "Remove from group" (handleUngroupTrack)
 *
 * Must be called AFTER the move/ungroup deltas have been applied to the store
 * so that `useEngineStore.getState().tracks` reflects the current state.
 *
 * @param oldGroupId - ID of the group the track was removed from. If null, no-op.
 */
export async function autoDeleteEmptyGroup(oldGroupId: string | null): Promise<void> {
    if (!oldGroupId) return;

    const freshTracks = useEngineStore.getState().tracks;
    const groupTrack = freshTracks.byId[oldGroupId];
    if (!groupTrack) return; // Group already deleted or doesn't exist

    const childCount = freshTracks.allIds.filter(
        (id) => freshTracks.byId[id]?.parent_track_id === oldGroupId,
    ).length;

    if (childCount === 0) {
        try {
            const ungroupResp = await engineApi.ungroupTrackWithDeltas(oldGroupId);
            await useEngineStore.getState().applyProjectDeltas(
                ungroupResp.deltas,
                'track-inspector:auto-delete-empty-group',
            );
        } catch (err) {
            console.warn('[Dream] auto-delete empty group failed:', err);
            useStatusStore.getState().setError(`Group cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
