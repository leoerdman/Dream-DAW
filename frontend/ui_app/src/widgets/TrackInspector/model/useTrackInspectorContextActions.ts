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
    onSelectTrack?: (id: string, options?: { preserveCursor?: boolean }) => void;
    onSelectTracks?: (ids: string[], primaryId: string, options?: { preserveCursor?: boolean }) => void;
    renameTrackAction: (index: number, name: string) => Promise<void> | void;
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
    const [masterColor, setMasterColor] = useState('var(--surface-elevated)');
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
        void engineApi.addTrackWithDeltasAdvanced(trackType, resolvedInsertAfter, undefined, contextMenu?.trackId ?? null)
            .then(async (response) => {
                await useEngineStore.getState().applyProjectDeltas(response.deltas, `track-inspector:add-${trackType}`);
            })
            .catch((err) => {
                console.error(`[Dream] add ${trackType} track failed:`, err);
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
        })().catch(err => console.error('[Dream] deleteTrack failed:', err));
        setContextMenu(null);
    }, [getTrackIndex, liveTracks, onSelectTrack, onSelectTracks, selectedTrackIdsProp, setLocalSelectedTrackIds, setLocalOverrides]);

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
        })().catch((err) => {
            console.error('[Dream] delete selected tracks failed:', err);
        }).finally(() => {
            deletionInFlightRef.current = false;
        });
    }, [selectedTrackIdSet, getTrackIndex, liveTracks, onSelectTracks, onSelectTrack, selectedTrackIdsProp, setLocalSelectedTrackIds, setLocalOverrides]);

    const handleDuplicateSelectedTracks = useCallback(() => {
        const ids = Array.from(selectedTrackIdSet);
        if (ids.length === 0) return;
        // Capture pre-duplication track IDs for diff-based auto-select.
        const preTrackIds = new Set(useEngineStore.getState().tracks.allIds);
        void engineApi.duplicateTracksWithDeltas(ids).then(async (response) => {
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:duplicate-selected');
            // ENTERPRISE FIX: Backend now sends ProjectSnapshotReplaced (full project clone)
            // instead of minimal TrackAdded deltas. Diff pre/post track IDs to find new ones.
            const postTrackIds = useEngineStore.getState().tracks.allIds;
            const newTrackIds = postTrackIds.filter(id => !preTrackIds.has(id));
            if (newTrackIds.length > 0) {
                if (onSelectTracks) {
                    onSelectTracks(newTrackIds, newTrackIds[0], { preserveCursor: true });
                } else {
                    setLocalSelectedTrackIds(new Set(newTrackIds));
                }
                if (onSelectTrack) onSelectTrack(newTrackIds[0], { preserveCursor: true });
            }
        }).catch((err) => {
            console.error('[Dream] duplicate selected tracks failed:', err);
        });
    }, [selectedTrackIdSet, onSelectTracks, onSelectTrack, setLocalSelectedTrackIds]);

    const handleGroupTrack = useCallback((trackId: string) => {
        // Capture source track color before group creation
        const sourceTrack = tracks.find((t) => t.id === trackId);
        // ENTERPRISE: Always use a valid hex color — fallback if color is falsy or CSS var
        const sourceColor = sourceTrack?.color && sourceTrack.color.startsWith('#') ? sourceTrack.color : '#808080';
        void engineApi.createGroupWithDeltas([trackId]).then(async (response) => {
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:create-group');
            // ENTERPRISE: Inherit the source track's color on the newly created group
            if (response.group_id) {
                try {
                    const colorResp = await engineApi.setTrackColorWithDeltas(response.group_id, sourceColor);
                    await useEngineStore.getState().applyProjectDeltas(colorResp.deltas, 'track-inspector:group-inherit-color');
                } catch (err) {
                    console.warn('[Dream] group color inherit failed:', err);
                }
            }
        }).catch((err) => {
            console.error('[Dream] createGroup failed:', err);
        });
        setContextMenu(null);
    }, [tracks]);

    const handleUngroupTrack = useCallback((trackId: string) => {
        const target = tracks.find((t) => t.id === trackId);
        if (target?.type === 'group') {
            // Dissolve the entire group
            void engineApi.ungroupTrackWithDeltas(trackId).then(async (response) => {
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:ungroup');
            }).catch((err) => {
                console.error('[Dream] ungroup failed:', err);
            });
        } else {
            // Remove single track from its group
            const oldGroupId = target?.groupId ?? null;
            void engineApi.setTrackGroupWithDeltas(trackId, null).then(async (response) => {
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:ungroup');
                // ENTERPRISE: Auto-delete empty group after removing last child.
                if (oldGroupId) {
                    const freshTracks = useEngineStore.getState().tracks;
                    const groupTrack = freshTracks.byId[oldGroupId];
                    if (groupTrack) {
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
                            }
                        }
                    }
                }
            }).catch((err) => {
                console.error('[Dream] ungroup failed:', err);
            });
        }
        setContextMenu(null);
    }, [tracks]);

    const handleOpenColorPicker = useCallback((trackId: string, x: number, y: number) => {
        setColorPickerState({ trackId, x, y });
        // NOTE: Context menu stays open — color picker appears as submenu
    }, []);

    const handleColorSelect = useCallback((trackId: string, color: string) => {
        // Resolve the actual backend track ID.
        // The UI uses 'master' as a sentinel, but the backend needs the real UUID.
        let resolvedTrackId = trackId;
        if (trackId === 'master') {
            const masterTrack = tracks.find((t) => t.type === 'master');
            if (!masterTrack) {
                console.warn('[Dream] Master track not found — cannot set color');
                setColorPickerState(null);
                return;
            }
            resolvedTrackId = masterTrack.id;
            setMasterColor(color);
        }
        setLocalOverrides(prev => ({ ...prev, [resolvedTrackId]: { ...prev[resolvedTrackId], color } }));
        void engineApi.setTrackColorWithDeltas(resolvedTrackId, color)
            .then(async (response) => {
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:track-color-change');
            })
            .catch((err) => {
                console.error('[Dream] setTrackColor failed:', err);
            });
        setColorPickerState(null);
    }, [setLocalOverrides, tracks]);

    const handlePaintClipsWithTrackColor = useCallback((trackId: string) => {
        void engineApi.paintTrackClipsWithTrackColorWithDeltas(trackId)
            .then(async (response) => {
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:paint-clips-with-track-color');
            })
            .catch((err) => {
                console.error('[Dream] paintTrackClipsWithTrackColor failed:', err);
            });
        setContextMenu(null);
    }, []);

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
            })
            .catch((err) => {
                console.error('[Dream] paintGroupColor failed:', err);
            });
        setContextMenu(null);
    }, [tracks]);

    const handleBounceTrack = useCallback((trackId: string) => {
        void engineApi.bounceTrackWithDeltas(trackId)
            .then(async (response) => {
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:bounce-track');
            })
            .catch((err) => {
                console.error('[Dream] bounceTrack failed:', err);
            });
        setContextMenu(null);
    }, []);

    const handleBounceGroup = useCallback((groupTrackId: string) => {
        void engineApi.bounceGroupWithDeltas(groupTrackId)
            .then(async (response) => {
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-context:bounce-group');
            })
            .catch((err) => {
                console.error('[Dream] bounceGroup failed:', err);
            });
        setContextMenu(null);
    }, []);

    const handleSplitTrackToStems = useCallback((trackId: string) => {
        void engineApi.splitTrackToStemsWithDeltas(trackId)
            .then(async (response) => {
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-context:split-to-stems');
            })
            .catch((err) => {
                console.error('[Dream] splitTrackToStems failed:', err);
            });
        setContextMenu(null);
    }, []);

    return { contextMenu, colorPickerState, renamingTrackId, renameValue, masterColor, setRenameValue, setContextMenu, setColorPickerState, handleContextMenu, handleAddTrackFromContext, handleRenameStart, handleRenameCommit, handleRenameCancel, handleDeleteTrack, handleDeleteSelectedTracks, handleDuplicateSelectedTracks, handleGroupTrack, handleUngroupTrack, handleOpenColorPicker, handleColorSelect, handlePaintClipsWithTrackColor, handlePaintGroupColor, handleBounceTrack, handleBounceGroup, handleSplitTrackToStems };
}
