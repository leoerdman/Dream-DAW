import { useCallback } from 'react';
import * as engineApi from '@/shared/api/engine';
import { beatDurationToFrames, beatToFrame, DEFAULT_TIME_SIG_NUMERATOR, resolveBpm } from '@/shared/lib/audioMath';
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
            ) as TimelineClip[];
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
        const bpm = resolveBpm(projectBpm);
        const sampleRate = projectSampleRate;
        const storeState = useEngineStore.getState();
        // BUG-005: Derive beatsPerBar from timeSigNumerator instead of unsafe `as` cast.
        const beatsPerBar = storeState.timeSigNumerator ?? DEFAULT_TIME_SIG_NUMERATOR;
        const positionFrames = Math.round(beatToFrame(beat, bpm, sampleRate));
        const durationFrames = Math.round(beatDurationToFrames(beatsPerBar, bpm, sampleRate));
        void createMidiClip(trackIndex, positionFrames, durationFrames);
    }, [createMidiClip, projectBpm, projectSampleRate]);

    const handleClipMove = useCallback((clipId: string, newStartBeat: number, newTrackIndex: number) => {
        // BUG-026: Use projectBpm as single source of truth.
        const bpm = resolveBpm(projectBpm);
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

        const run = async () => {
            let clipsToMove: TimelineClip[];
            if (moveAsGroup) {
                const seen = new Set<string>();
                clipsToMove = selectedClipIds
                    .map((id) => liveState.clips.byId[id] ?? liveState.clipsById[id])
                    .filter((clip): clip is TimelineClip => Boolean(clip))
                    .filter((clip) => {
                        if (!selectedSet.has(clip.id)) return false;
                        if (seen.has(clip.id)) return false;
                        seen.add(clip.id);
                        return true;
                    });
            } else {
                clipsToMove = [dragged];
            }

            const deltaBeat = newStartBeat - dragged.startBeat;
            const deltaTrack = newTrackIndex - dragged.trackIndex;
            const preferredDirection = deltaTrack > 0 ? 1 : (deltaTrack < 0 ? -1 : 0);

            const requests = clipsToMove.map((clip) => {
                const targetBeat = moveAsGroup ? Math.max(0, clip.startBeat + deltaBeat) : newStartBeat;
                const targetTrack = snapToVisibleTrack(Math.max(0, Math.min(trackCountRaw - 1, moveAsGroup ? clip.trackIndex + deltaTrack : newTrackIndex)), preferredDirection);
                const positionFrames = Math.round(beatToFrame(Math.max(0, targetBeat), bpm, sampleRate));
                return { id: clip.id, newTrackIndex: targetTrack, newPositionFrames: positionFrames };
            });

            try {
                const response = await engineApi.moveMultipleClipsWithDeltas(requests);
                await applyProjectDeltas(response.deltas, moveAsGroup ? 'clip-move-group' : 'clip-move');
            } catch (err) {
                if (isClipNotFoundError(err)) {
                    // Not ideal grouping behavior if one deletes mid-drag, but avoids total failure.
                    for (const req of requests) pruneGhostClip(req.id);
                    return;
                }
                throw err;
            }
        };

        void run()
            .then(() => {
                // Hot-path interaction: avoid console I/O on every drag commit.
            })
            .catch((err) => {
                console.error('[Dream] moveClip failed:', err);
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
        const bpm = resolveBpm(projectBpm);
        const sampleRate = projectSampleRate;
        const newPositionFrames = Math.round(beatToFrame(newStartBeat, bpm, sampleRate));
        const newDurationFrames = Math.round(Math.max(128, beatDurationToFrames(newDurationBeats, bpm, sampleRate)));

        void engineApi.resizeClipWithDeltas(clipId, newPositionFrames, newDurationFrames, allowStretch)
            .then(async (response) => {
                await applyProjectDeltas(response.deltas, 'clip-resize');
            })
            .catch((err) => {
                if (isClipNotFoundError(err)) {
                    pruneGhostClip(clipId);
                    return;
                }
                console.error('[Dream] resizeClip failed:', err);
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
                console.error('[Dream] setClipFades failed:', err);
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
        const bpm = resolveBpm(projectBpm);
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

        const run = async () => {
            let clipsToDuplicate: TimelineClip[];
            if (duplicateAsGroup) {
                const seen = new Set<string>();
                clipsToDuplicate = selectedClipIds
                    .map((id) => liveState.clips.byId[id] ?? liveState.clipsById[id])
                    .filter((clip): clip is TimelineClip => Boolean(clip))
                    .filter((clip) => {
                        if (!selectedSet.has(clip.id)) return false;
                        if (seen.has(clip.id)) return false;
                        seen.add(clip.id);
                        return true;
                    });
            } else {
                clipsToDuplicate = [dragged];
            }

            const deltaBeat = newStartBeat - dragged.startBeat;
            const deltaTrack = newTrackIndex - dragged.trackIndex;

            const requests = clipsToDuplicate.map((clip) => {
                const targetBeat = duplicateAsGroup ? Math.max(0, clip.startBeat + deltaBeat) : newStartBeat;
                const targetTrack = snapToVisibleTrack(Math.max(0, Math.min(trackCountRaw - 1, duplicateAsGroup ? clip.trackIndex + deltaTrack : newTrackIndex)));
                const positionFrames = Math.round(beatToFrame(Math.max(0, targetBeat), bpm, sampleRate));
                return { id: clip.id, newPositionFrames: positionFrames, targetTrackIndex: targetTrack };
            });

            try {
                const response = await engineApi.duplicateMultipleClipsWithDeltas(requests);
                await applyProjectDeltas(response.deltas, 'clip-duplicate-drag');
                const newIds = response.deltas
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    .filter((d) => 'ClipDuplicated' in d).map((d: any) => d.ClipDuplicated.new_clip_id as string);

                if (newIds.length > 0) {
                    setSelectedClipIds(newIds);
                }
            } catch (err) {
                console.error('[Dream] Cmd+Drag duplicate failed:', err);
                useStatusStore.getState().setError(`Clip duplicate failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        };

        void run().catch((err) => {
            console.error('[Dream] Cmd+Drag duplicate failed:', err);
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
