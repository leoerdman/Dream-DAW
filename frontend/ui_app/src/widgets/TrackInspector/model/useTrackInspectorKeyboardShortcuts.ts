import { useEffect } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import type { TrackData } from '@/widgets/TrackInspector/model/trackModels';

interface UseTrackInspectorKeyboardShortcutsArgs {
    selectedTrackId: string;
    selectedTrackIdSet: Set<string>;
    /** Tracks explicitly selected by clicking the track header (not just active). */
    headerSelectedTrackIdSet: Set<string>;
    tracks: TrackData[];
    renamingTrackId: string | null;
    handleRenameStart: (trackId: string) => void;
    handleGroupTrack: (trackId: string) => void;
    handleDeleteSelectedTracks: () => void;
    handleDuplicateSelectedTracks: () => void;
}

export function useTrackInspectorKeyboardShortcuts({
    selectedTrackId,
    selectedTrackIdSet,
    headerSelectedTrackIdSet,
    tracks,
    renamingTrackId,
    handleRenameStart,
    handleGroupTrack,
    handleDeleteSelectedTracks,
    handleDuplicateSelectedTracks,
}: UseTrackInspectorKeyboardShortcutsArgs): void {
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.isComposing) return;
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName?.toLowerCase();
            const isTextInput = tag === 'input' || tag === 'textarea' || target?.isContentEditable;
            if (isTextInput || renamingTrackId !== null) return;

            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === 'KeyR' && selectedTrackId && selectedTrackId !== 'master') {
                e.preventDefault();
                handleRenameStart(selectedTrackId);
            }
            // ENTERPRISE FIX: Only group tracks when headers are explicitly selected.
            if ((e.metaKey || e.ctrlKey) && e.code === 'KeyG' && !e.shiftKey && headerSelectedTrackIdSet.size > 0) {
                e.preventDefault();
                const ids = Array.from(selectedTrackIdSet);
                if (ids.length > 1) {
                    // Capture the first track's color for inheritance
                    const firstTrack = tracks.find((t) => t.id === ids[0]);
                    const sourceColor = firstTrack?.color;
                    void engineApi.createGroupWithDeltas(ids).then(async (response) => {
                        await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:create-group-multi');
                        // ENTERPRISE: Inherit color from the first selected track
                        if (sourceColor && response.group_id) {
                            try {
                                const colorResp = await engineApi.setTrackColorWithDeltas(response.group_id, sourceColor);
                                await useEngineStore.getState().applyProjectDeltas(colorResp.deltas, 'track-inspector:group-inherit-color');
                            } catch (err) {
                                console.warn('[Dream] group color inherit failed:', err);
                            }
                        }
                    }).catch((err) => {
                        console.error('[Dream] createGroup(multi) failed:', err);
                        useStatusStore.getState().setError(`Create group failed: ${err instanceof Error ? err.message : String(err)}`);
                    });
                } else {
                    handleGroupTrack(selectedTrackId);
                }
            }
            // ENTERPRISE FIX: Only ungroup when headers are explicitly selected.
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyG' && headerSelectedTrackIdSet.size > 0 && selectedTrackId && selectedTrackId !== 'master') {
                e.preventDefault();
                const selected = tracks.find((t) => t.id === selectedTrackId);
                const groupToUngroup = selected?.type === 'group' ? selected.id : (selected?.groupId ?? null);
                if (groupToUngroup) {
                    void engineApi.ungroupTrackWithDeltas(groupToUngroup).then(async (response) => {
                        await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:ungroup-shortcut');
                    }).catch((err) => {
                        console.error('[Dream] ungroupTrack failed:', err);
                        useStatusStore.getState().setError(`Ungroup failed: ${err instanceof Error ? err.message : String(err)}`);
                    });
                }
            }
            // ENTERPRISE FIX: Only duplicate tracks when headers are explicitly
            // selected (clicked), not when the track is merely active/focused.
            if ((e.metaKey || e.ctrlKey) && e.code === 'KeyD' && headerSelectedTrackIdSet.size > 0) {
                e.preventDefault();
                handleDuplicateSelectedTracks();
            }
            // ENTERPRISE FIX: Only delete tracks when the header is explicitly
            // selected (clicked), not when the track is merely active/focused
            // from a timeline click. This prevents accidental track deletion
            // when pressing Delete to remove clips or other elements.
            if ((e.key === 'Delete' || e.key === 'Backspace') && headerSelectedTrackIdSet.size > 0) {
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
    }, [
        selectedTrackId,
        selectedTrackIdSet,
        headerSelectedTrackIdSet,
        tracks,
        renamingTrackId,
        handleRenameStart,
        handleGroupTrack,
        handleDeleteSelectedTracks,
        handleDuplicateSelectedTracks,
    ]);
}
