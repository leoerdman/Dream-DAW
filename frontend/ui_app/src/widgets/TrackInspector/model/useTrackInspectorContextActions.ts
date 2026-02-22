import { useCallback, useRef, useState } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { TrackData } from '@/widgets/TrackInspector/model/trackModels';
interface UseTrackInspectorContextActionsParams {
    tracks: TrackData[];
    liveTracks: TrackData[];
    selectedTrackIdSet: Set<string>;
    selectedTrackIdsProp?: string[];
    getTrackIndex: (id: string) => number;
    setLocalOverrides: React.Dispatch<React.SetStateAction<Record<string, Partial<TrackData>>>>;
    setLocalSelectedTrackIds: React.Dispatch<React.SetStateAction<Set<string> | null>>;
    onSelectTrack?: (id: string) => void;
    onSelectTracks?: (ids: string[], primaryId: string) => void;
    renameTrackAction: (index: number, name: string) => Promise<void> | void;
    onRefresh: (reason: string) => void;
}
export function useTrackInspectorContextActions({
    tracks,
    liveTracks,
    selectedTrackIdSet,
    selectedTrackIdsProp,
    getTrackIndex,
    setLocalOverrides,
    setLocalSelectedTrackIds,
    onSelectTrack,
    onSelectTracks,
    renameTrackAction,
    onRefresh,
}: UseTrackInspectorContextActionsParams) {
    const deletionInFlightRef = useRef(false);
    const [contextMenu, setContextMenu] = useState<{
        trackId: string | null; trackIndex: number | null; x: number; y: number;
    } | null>(null);
    const [colorPickerState, setColorPickerState] = useState<{
        trackId: string; x: number; y: number;
    } | null>(null);
    const [renamingTrackId, setRenamingTrackId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [masterColor, setMasterColor] = useState('#2b2f36');
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
        void engineApi.addTrackAdvancedWithSnapshotDelta(trackType, resolvedInsertAfter, undefined, contextMenu?.trackId ?? null)
            .then(async (response) => {
                await useEngineStore.getState().applyProjectDeltas(response.deltas, `track-inspector:add-${trackType}`);
                onRefresh(`track-context:add-${trackType}`);
            })
            .catch((err) => {
                console.error(`[TrackInspector] add ${trackType} track failed:`, err);
            });
        setContextMenu(null);
    }, [contextMenu, onRefresh]);

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
            if (idx >= 0) void renameTrackAction(idx, renameValue.trim());
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
        if (idx < 0) { setContextMenu(null); return; }

        const nonMaster = liveTracks.filter(t => t.type !== 'master');
        const posInNonMaster = nonMaster.findIndex(t => t.id === trackId);
        let nextId: string | null = null;
        if (posInNonMaster >= 0) {
            if (posInNonMaster + 1 < nonMaster.length) nextId = nonMaster[posInNonMaster + 1].id;
            else if (posInNonMaster - 1 >= 0) nextId = nonMaster[posInNonMaster - 1].id;
        }

        void (async () => {
            const response = await engineApi.deleteTrackWithDeltas(idx);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:delete-single');
            setLocalOverrides(prev => {
                if (!(trackId in prev)) return prev;
                const next = { ...prev };
                delete next[trackId];
                return next;
            });
            if (onSelectTrack) onSelectTrack(nextId ?? 'master');
            if (selectedTrackIdsProp) {
                onSelectTracks?.(nextId ? [nextId] : [], nextId ?? 'master');
            } else {
                setLocalSelectedTrackIds(nextId ? new Set([nextId]) : new Set());
            }
            onRefresh('delete-single');
        })().catch(err => console.error('[TrackInspector] deleteTrack failed:', err));
        setContextMenu(null);
    }, [getTrackIndex, liveTracks, onSelectTrack, onSelectTracks, selectedTrackIdsProp, setLocalSelectedTrackIds, setLocalOverrides, onRefresh]);

    const handleDeleteSelectedTracks = useCallback(() => {
        if (deletionInFlightRef.current) return;
        const selected = Array.from(selectedTrackIdSet)
            .map((id) => ({ id, idx: getTrackIndex(id) }))
            .filter((v) => v.idx >= 0)
            .sort((a, b) => b.idx - a.idx);
        if (selected.length === 0) return;
        deletionInFlightRef.current = true;

        const deletedIds = new Set(selected.map((s) => s.id));
        const lowestDeletedIdx = Math.min(...selected.map((s) => s.idx));

        let nextSelectedId: string | null = null;
        for (let i = lowestDeletedIdx - 1; i >= 0; i--) {
            const candidate = liveTracks[i];
            if (candidate && candidate.type !== 'master' && !deletedIds.has(candidate.id)) {
                nextSelectedId = candidate.id;
                break;
            }
        }
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
            for (const item of selected) {
                const response = await engineApi.deleteTrackWithDeltas(item.idx);
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:delete-selected');
            }
            setLocalOverrides(prev => {
                let changed = false;
                const next = { ...prev };
                for (const id of deletedIds) {
                    if (id in next) { delete next[id]; changed = true; }
                }
                return changed ? next : prev;
            });
            if (selectedTrackIdsProp) {
                onSelectTracks?.(nextSelectedId ? [nextSelectedId] : [], nextSelectedId ?? 'master');
            } else {
                setLocalSelectedTrackIds(nextSelectedId ? new Set([nextSelectedId]) : new Set());
            }
            if (onSelectTrack) onSelectTrack(nextSelectedId ?? 'master');
            onRefresh('delete-selected');
        })().catch((err) => {
            console.error('[TrackInspector] delete selected tracks failed:', err);
        }).finally(() => {
            deletionInFlightRef.current = false;
        });
    }, [selectedTrackIdSet, getTrackIndex, liveTracks, onSelectTracks, onSelectTrack, selectedTrackIdsProp, setLocalSelectedTrackIds, setLocalOverrides, onRefresh]);

    const handleDuplicateSelectedTracks = useCallback(() => {
        const ids = Array.from(selectedTrackIdSet);
        if (ids.length === 0) return;
        void engineApi.duplicateTracksWithDeltas(ids).then(async (response) => {
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:duplicate-selected');
            onRefresh('duplicate-selected');
            return;
        }).catch((err) => {
            console.error('[TrackInspector] duplicate selected tracks failed:', err);
        });
    }, [selectedTrackIdSet, onRefresh]);

    const handleGroupTrack = useCallback((trackId: string) => {
        void engineApi.createGroupWithDeltas([trackId]).then(async (response) => {
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:create-group');
            onRefresh('create-group');
        }).catch((err) => {
            console.error('[TrackInspector] createGroup failed:', err);
        });
        setContextMenu(null);
    }, [onRefresh]);

    const handleUngroupTrack = useCallback((trackId: string) => {
        const target = tracks.find((t) => t.id === trackId);
        const op = target?.type === 'group'
            ? engineApi.ungroupTrackWithSnapshotDelta(trackId)
            : engineApi.setTrackGroupWithSnapshotDelta(trackId, null);
        void op.then(async (response) => {
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:ungroup');
            onRefresh('ungroup');
        }).catch((err) => {
            console.error('[TrackInspector] ungroup failed:', err);
        });
        setContextMenu(null);
    }, [tracks, onRefresh]);

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
        void engineApi.setTrackColorWithDeltas(trackId, color)
            .then(async (response) => {
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:track-color-change');
                onRefresh('track-color-change');
            })
            .catch((err) => {
                console.error('[TrackInspector] setTrackColor failed:', err);
            });
        setColorPickerState(null);
    }, [onRefresh, setLocalOverrides]);

    const handlePaintClipsWithTrackColor = useCallback((trackId: string) => {
        void engineApi.paintTrackClipsWithTrackColorWithSnapshotDelta(trackId)
            .then(async (response) => {
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:paint-clips-with-track-color');
                onRefresh('track-context:paint-clips-with-track-color');
            })
            .catch((err) => {
                console.error('[TrackInspector] paintTrackClipsWithTrackColor failed:', err);
            });
        setContextMenu(null);
    }, [onRefresh]);

    const handlePaintGroupColor = useCallback((groupTrackId: string) => {
        const group = tracks.find((t) => t.id === groupTrackId);
        if (!group || group.type !== 'group') return;
        const groupColor = group.color;
        const children = tracks.filter((t) => t.groupId === groupTrackId);
        if (children.length === 0) return;
        void Promise.all(children.map((child) => engineApi.setTrackColorWithDeltas(child.id, groupColor)))
            .then(async (responses) => {
                for (const response of responses) {
                    await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:paint-group-color');
                }
                onRefresh('track-context:paint-group-color');
            })
            .catch((err) => {
                console.error('[TrackInspector] paintGroupColor failed:', err);
            });
        setContextMenu(null);
    }, [tracks, onRefresh]);

    const handleBounceTrack = useCallback((trackId: string) => {
        void engineApi.bounceTrackWithDeltas(trackId)
            .then(async (response) => {
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:bounce-track');
                onRefresh('track-context:bounce-track');
            })
            .catch((err) => {
                console.error('[TrackInspector] bounceTrack failed:', err);
            });
        setContextMenu(null);
    }, [onRefresh]);

    const handleBounceGroup = useCallback((groupTrackId: string) => {
        void engineApi.bounceGroup(groupTrackId)
            .then(() => onRefresh('track-context:bounce-group'))
            .catch((err) => {
                console.error('[TrackInspector] bounceGroup failed:', err);
            });
        setContextMenu(null);
    }, [onRefresh]);

    const handleSplitTrackToStems = useCallback((trackId: string) => {
        void engineApi.splitTrackToStems(trackId)
            .then(() => onRefresh('track-context:split-to-stems'))
            .catch((err) => {
                console.error('[TrackInspector] splitTrackToStems failed:', err);
            });
        setContextMenu(null);
    }, [onRefresh]);

    return { contextMenu, colorPickerState, renamingTrackId, renameValue, masterColor, setRenameValue, setContextMenu, setColorPickerState, handleContextMenu, handleAddTrackFromContext, handleRenameStart, handleRenameCommit, handleRenameCancel, handleDeleteTrack, handleDeleteSelectedTracks, handleDuplicateSelectedTracks, handleGroupTrack, handleUngroupTrack, handleOpenColorPicker, handleColorSelect, handlePaintClipsWithTrackColor, handlePaintGroupColor, handleBounceTrack, handleBounceGroup, handleSplitTrackToStems };
}
