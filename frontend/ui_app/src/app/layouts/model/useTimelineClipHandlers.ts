import { useCallback } from 'react';
import * as engineApi from '@/shared/api/engine';
import { beatDurationToFrames, beatToFrame, DEFAULT_TIME_SIG_NUMERATOR } from '@/shared/lib/audioMath';
import { normalizeTimelineClips } from '@/shared/lib/clipNormalization';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { ProjectDelta } from '@/shared/api/engine';

type BottomPanelMode = 'rack' | 'clip';

type Args = {
    projectBpm: number;
    transportBpm: number;
    projectSampleRate: number;
    timelineClipsForView: TimelineClip[];
    selectedClipIds: string[];
    trackCountRaw: number;
    hiddenTrackIndices: Set<number>;
    createMidiClip: (trackIndex: number, positionFrames: number, durationFrames: number) => Promise<void>;
    applyProjectDeltas: (deltas: ProjectDelta[], reason?: string) => Promise<void>;
    setSelectedClipIds: React.Dispatch<React.SetStateAction<string[]>>;
    setBottomPanelModeForActiveTrack: (mode: BottomPanelMode) => void;
};

type Result = {
    handleDoubleClickTrack: (trackIndex: number, beat: number) => void;
    handleClipMove: (clipId: string, newStartBeat: number, newTrackIndex: number) => void;
    handleClipDuplicate: (clipId: string, newStartBeat: number, newTrackIndex: number) => void;
    handleClipResize: (clipId: string, newStartBeat: number, newDurationBeats: number, allowStretch: boolean) => void;
    handleClipFades: (clipId: string, fadeInFrames: number, fadeOutFrames: number) => void;
    handleOpenMidiClip: (clipId: string) => void;
};

export function useTimelineClipHandlers({
    projectBpm,
    projectSampleRate,
    timelineClipsForView,
    selectedClipIds,
    trackCountRaw,
    hiddenTrackIndices,
    createMidiClip,
    applyProjectDeltas,
    setSelectedClipIds,
    setBottomPanelModeForActiveTrack,
}: Args): Result {
    const isClipNotFoundError = (err: unknown): boolean => {
        const message = err instanceof Error ? err.message : String(err);
        return /clip/i.test(message) && /(not\s+found|unknown|does\s+not\s+exist|missing)/i.test(message);
    };

    const pruneGhostClip = useCallback((clipId: string) => {
        if (!clipId) return;
        useEngineStore.setState((s) => {
            const canonicalById = Object.keys(s.clips.byId).length > 0 ? s.clips.byId : s.clipsById;
            if (!canonicalById[clipId]) return s;

            const nextClipIds = s.clips.allIds.filter((id) => id !== clipId);
            const nextClipsEntityById = { ...canonicalById };
            delete nextClipsEntityById[clipId];
            const nextTimelineClips = normalizeTimelineClips(
                nextClipIds
                    .map((id) => nextClipsEntityById[id])
                    .filter((clip): clip is TimelineClip => Boolean(clip)),
            );
            const nextClipsById = Object.fromEntries(nextTimelineClips.map((clip) => [clip.id, clip]));

            return {
                timelineClips: nextTimelineClips,
                clipsById: nextClipsById,
                clips: {
                    byId: nextClipsById,
                    allIds: nextTimelineClips.map((clip) => clip.id),
                },
            };
        });
        setSelectedClipIds((prev) => prev.filter((id) => id !== clipId));
    }, [setSelectedClipIds]);

    const handleDoubleClickTrack = useCallback((trackIndex: number, beat: number) => {
        // BUG-026: Use projectBpm as single source of truth — transportBpm can diverge during pending changes.
        const bpm = Math.max(1, projectBpm ?? 120);
        const sampleRate = projectSampleRate;
        const storeState = useEngineStore.getState();
        // BUG-005: Derive beatsPerBar from timeSigNumerator instead of unsafe `as` cast.
        const beatsPerBar = storeState.timeSigNumerator ?? DEFAULT_TIME_SIG_NUMERATOR;
        const positionFrames = beatToFrame(beat, bpm, sampleRate);
        const durationFrames = beatDurationToFrames(beatsPerBar, bpm, sampleRate);
        void createMidiClip(trackIndex, positionFrames, durationFrames);
    }, [createMidiClip, projectBpm, projectSampleRate]);

    const handleClipMove = useCallback((clipId: string, newStartBeat: number, newTrackIndex: number) => {
        // BUG-026: Use projectBpm as single source of truth.
        const bpm = Math.max(1, projectBpm ?? 120);
        const sampleRate = projectSampleRate;
        const liveState = useEngineStore.getState();
        const liveClip = liveState.clips.byId[clipId] ?? liveState.clipsById[clipId];
        const liveExists = Boolean(liveClip);
        if (!liveExists) {
            pruneGhostClip(clipId);
            return;
        }

        const dragged = liveClip ?? timelineClipsForView.find((clip) => clip.id === clipId);
        if (!dragged) {
            pruneGhostClip(clipId);
            return;
        }

        const selectedSet = new Set(selectedClipIds);
        const moveAsGroup = selectedSet.size > 1 && selectedSet.has(clipId);

        const snapToVisibleTrack = (targetTrack: number, preferredDirection: -1 | 0 | 1): number => {
            const clamped = Math.max(0, Math.min(trackCountRaw - 1, targetTrack));
            if (!hiddenTrackIndices.has(clamped)) return clamped;

            if (preferredDirection >= 0) {
                for (let i = clamped + 1; i < trackCountRaw; i += 1) {
                    if (!hiddenTrackIndices.has(i)) return i;
                }
            }
            if (preferredDirection <= 0) {
                for (let i = clamped - 1; i >= 0; i -= 1) {
                    if (!hiddenTrackIndices.has(i)) return i;
                }
            }

            for (let radius = 1; radius < trackCountRaw; radius += 1) {
                const up = clamped - radius;
                const down = clamped + radius;
                if (up >= 0 && !hiddenTrackIndices.has(up)) return up;
                if (down < trackCountRaw && !hiddenTrackIndices.has(down)) return down;
            }
            return clamped;
        };

        const moveOne = async (id: string, targetBeat: number, targetTrack: number) => {
            const positionFrames = beatToFrame(Math.max(0, targetBeat), bpm, sampleRate);
            const safeTrack = snapToVisibleTrack(targetTrack, 0);
            try {
                return await engineApi.moveClipWithDeltas(id, safeTrack, positionFrames);
            } catch (err) {
                if (isClipNotFoundError(err)) {
                    pruneGhostClip(id);
                    return null;
                }
                throw err;
            }
        };

        const run = async () => {
            if (!moveAsGroup) {
                const response = await moveOne(clipId, newStartBeat, newTrackIndex);
                if (!response) return;
                await applyProjectDeltas(response.deltas, 'clip-move');
                return;
            }

            const deltaBeat = newStartBeat - dragged.startBeat;
            const deltaTrack = newTrackIndex - dragged.trackIndex;
            const seen = new Set<string>();
            const selectedClips = selectedClipIds
                .map((id) => liveState.clips.byId[id] ?? liveState.clipsById[id])
                .filter((clip): clip is TimelineClip => Boolean(clip))
                .filter((clip) => {
                    if (!selectedSet.has(clip.id)) return false;
                    if (seen.has(clip.id)) return false;
                    seen.add(clip.id);
                    return true;
                });
            const moveErrors: string[] = [];
            for (const clip of selectedClips) {
                const targetBeat = Math.max(0, clip.startBeat + deltaBeat);
                const targetTrack = snapToVisibleTrack(
                    Math.max(0, Math.min(trackCountRaw - 1, clip.trackIndex + deltaTrack)),
                    deltaTrack > 0 ? 1 : (deltaTrack < 0 ? -1 : 0),
                );
                try {
                    const response = await moveOne(clip.id, targetBeat, targetTrack);
                    if (!response) continue;
                    // Apply per-clip deltas immediately to keep UI consistent even if
                    // later clips in the same group fail validation/not-found checks.
                    await applyProjectDeltas(response.deltas, 'clip-move-group');
                } catch (err) {
                    if (isClipNotFoundError(err)) {
                        pruneGhostClip(clip.id);
                        continue;
                    }
                    moveErrors.push(err instanceof Error ? err.message : String(err));
                }
            }
            if (moveErrors.length > 0) {
                throw new Error(`Group move completed with ${moveErrors.length} error(s): ${moveErrors.join('; ')}`);
            }
        };

        void run()
            .then(() => {
                // Hot-path interaction: avoid console I/O on every drag commit.
            })
            .catch((err) => {
                console.error('[DawShell] moveClip failed:', err);
                if (isClipNotFoundError(err)) return;
                useStatusStore.getState().setError(`Clip move failed: ${err instanceof Error ? err.message : String(err)}`);
            });
    }, [
        applyProjectDeltas,
        hiddenTrackIndices,
        projectBpm,
        projectSampleRate,
        pruneGhostClip,
        selectedClipIds,
        timelineClipsForView,
        trackCountRaw,
    ]);

    const handleClipResize = useCallback((clipId: string, newStartBeat: number, newDurationBeats: number, allowStretch: boolean) => {
        // BUG-008: Validate inputs before IPC — reject negative, NaN, zero-duration.
        if (!Number.isFinite(newStartBeat) || newStartBeat < 0) return;
        if (!Number.isFinite(newDurationBeats) || newDurationBeats <= 0) return;
        const liveState = useEngineStore.getState();
        const liveExists = Boolean(liveState.clips.byId[clipId] ?? liveState.clipsById[clipId]);
        if (!liveExists) {
            pruneGhostClip(clipId);
            return;
        }
        // BUG-026: Use projectBpm as single source of truth.
        const bpm = Math.max(1, projectBpm ?? 120);
        const sampleRate = projectSampleRate;
        const newPositionFrames = beatToFrame(newStartBeat, bpm, sampleRate);
        const newDurationFrames = Math.max(128, beatDurationToFrames(newDurationBeats, bpm, sampleRate));

        void engineApi.resizeClipWithDeltas(clipId, newPositionFrames, newDurationFrames, allowStretch)
            .then(async (response) => {
                await applyProjectDeltas(response.deltas, 'clip-resize');
            })
            .catch((err) => {
                if (isClipNotFoundError(err)) {
                    pruneGhostClip(clipId);
                    return;
                }
                console.error('[DawShell] resizeClip failed:', err);
                useStatusStore.getState().setError(`Clip resize failed: ${err instanceof Error ? err.message : String(err)}`);
            });
    }, [applyProjectDeltas, projectBpm, projectSampleRate, pruneGhostClip]);

    const handleClipFades = useCallback((clipId: string, fadeInFrames: number, fadeOutFrames: number) => {
        const liveState = useEngineStore.getState();
        const liveExists = Boolean(liveState.clips.byId[clipId] ?? liveState.clipsById[clipId]);
        if (!liveExists) {
            pruneGhostClip(clipId);
            return;
        }
        void engineApi
            .setClipFadesWithDeltas(clipId, Math.max(0, Math.round(fadeInFrames)), Math.max(0, Math.round(fadeOutFrames)))
            .then(async (response) => {
                await applyProjectDeltas(response.deltas, 'clip-fades');
            })
            .catch((err) => {
                if (isClipNotFoundError(err)) {
                    pruneGhostClip(clipId);
                    return;
                }
                console.error('[DawShell] setClipFades failed:', err);
                // BUG-062: Surface error to user via status store.
                useStatusStore.getState().setError(`Clip fades failed: ${err instanceof Error ? err.message : String(err)}`);
            });
    }, [applyProjectDeltas, pruneGhostClip]);

    // ────────────────────────────────────────────────────────────────────────
    // ENTERPRISE: Cmd+Drag duplicate — duplicates clips to target position/track.
    // Supports multi-clip selection: all selected clips are duplicated with
    // the same relative offset that the primary clip was dragged by.
    // ────────────────────────────────────────────────────────────────────────
    const handleClipDuplicate = useCallback((clipId: string, newStartBeat: number, newTrackIndex: number) => {
        const bpm = Math.max(1, projectBpm ?? 120);
        const sampleRate = projectSampleRate;
        const liveState = useEngineStore.getState();
        const liveClip = liveState.clips.byId[clipId] ?? liveState.clipsById[clipId];
        if (!liveClip) {
            pruneGhostClip(clipId);
            return;
        }

        const dragged = liveClip;

        const selectedSet = new Set(selectedClipIds);
        const duplicateAsGroup = selectedSet.size > 1 && selectedSet.has(clipId);

        const snapToVisibleTrack = (targetTrack: number): number => {
            const clamped = Math.max(0, Math.min(trackCountRaw - 1, targetTrack));
            if (!hiddenTrackIndices.has(clamped)) return clamped;
            for (let radius = 1; radius < trackCountRaw; radius += 1) {
                const up = clamped - radius;
                const down = clamped + radius;
                if (up >= 0 && !hiddenTrackIndices.has(up)) return up;
                if (down < trackCountRaw && !hiddenTrackIndices.has(down)) return down;
            }
            return clamped;
        };

        const duplicateOne = async (id: string, targetBeat: number, targetTrack: number): Promise<string | null> => {
            const positionFrames = beatToFrame(Math.max(0, targetBeat), bpm, sampleRate);
            const safeTrack = snapToVisibleTrack(targetTrack);
            try {
                // Step 1: Duplicate the clip at the target position
                const dupResponse = await engineApi.duplicateClipWithDeltas(id, positionFrames);
                await applyProjectDeltas(dupResponse.deltas, 'clip-duplicate-drag');
                const newId = dupResponse.new_id;

                // Step 2: If the target track differs from the source, move the new clip
                const sourceClip = liveState.clips.byId[id] ?? liveState.clipsById[id];
                const sourceTrack = sourceClip?.trackIndex ?? 0;
                if (safeTrack !== sourceTrack) {
                    const moveResponse = await engineApi.moveClipWithDeltas(newId, safeTrack, positionFrames);
                    await applyProjectDeltas(moveResponse.deltas, 'clip-duplicate-drag-move');
                }
                return newId;
            } catch (err) {
                console.error('[DawShell] duplicateClip (Cmd+Drag) failed:', err);
                useStatusStore.getState().setError(
                    `Clip duplicate failed: ${err instanceof Error ? err.message : String(err)}`,
                );
                return null;
            }
        };

        const run = async () => {
            if (!duplicateAsGroup) {
                const newId = await duplicateOne(clipId, newStartBeat, newTrackIndex);
                if (newId) {
                    setSelectedClipIds([newId]);
                }
                return;
            }

            // Multi-clip: compute delta from the primary clip's drag
            const deltaBeat = newStartBeat - dragged.startBeat;
            const deltaTrack = newTrackIndex - dragged.trackIndex;
            const newIds: string[] = [];
            const seen = new Set<string>();

            const selectedClips = selectedClipIds
                .map((id) => liveState.clips.byId[id] ?? liveState.clipsById[id])
                .filter((clip): clip is TimelineClip => Boolean(clip))
                .filter((clip) => {
                    if (!selectedSet.has(clip.id)) return false;
                    if (seen.has(clip.id)) return false;
                    seen.add(clip.id);
                    return true;
                });

            for (const clip of selectedClips) {
                const targetBeat = Math.max(0, clip.startBeat + deltaBeat);
                const targetTrack = Math.max(0, Math.min(trackCountRaw - 1, clip.trackIndex + deltaTrack));
                const newId = await duplicateOne(clip.id, targetBeat, targetTrack);
                if (newId) newIds.push(newId);
            }

            if (newIds.length > 0) {
                setSelectedClipIds(newIds);
            }
        };

        void run().catch((err) => {
            console.error('[DawShell] Cmd+Drag duplicate failed:', err);
        });
    }, [
        applyProjectDeltas,
        hiddenTrackIndices,
        projectBpm,
        projectSampleRate,
        pruneGhostClip,
        selectedClipIds,
        setSelectedClipIds,
        trackCountRaw,
    ]);

    const handleOpenMidiClip = useCallback((clipId: string) => {
        setSelectedClipIds([clipId]);
        setBottomPanelModeForActiveTrack('clip');
    }, [setBottomPanelModeForActiveTrack, setSelectedClipIds]);

    return {
        handleDoubleClickTrack,
        handleClipMove,
        handleClipDuplicate,
        handleClipResize,
        handleClipFades,
        handleOpenMidiClip,
    };
}
