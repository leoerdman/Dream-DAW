import { useEffect } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { TrackData } from '@/widgets/TrackInspector/model/trackModels';

interface UseTrackInspectorKeyboardShortcutsArgs {
    selectedTrackId: string;
    selectedTrackIdSet: Set<string>;
    tracks: TrackData[];
    renamingTrackId: string | null;
    handleRenameStart: (trackId: string) => void;
    handleGroupTrack: (trackId: string) => void;
    handleDeleteSelectedTracks: () => void;
    handleDuplicateSelectedTracks: () => void;
    debouncedFetchProject: (reason: string) => void;
}

export function useTrackInspectorKeyboardShortcuts({
    selectedTrackId,
    selectedTrackIdSet,
    tracks,
    renamingTrackId,
    handleRenameStart,
    handleGroupTrack,
    handleDeleteSelectedTracks,
    handleDuplicateSelectedTracks,
    debouncedFetchProject,
}: UseTrackInspectorKeyboardShortcutsArgs): void {
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
    }, [
        selectedTrackId,
        selectedTrackIdSet,
        tracks,
        renamingTrackId,
        handleRenameStart,
        handleGroupTrack,
        handleDeleteSelectedTracks,
        handleDuplicateSelectedTracks,
        debouncedFetchProject,
    ]);
}
