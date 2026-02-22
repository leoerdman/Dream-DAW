import { beatDurationToFrames, beatToFrame, frameToBeat, resolveSampleRate } from '@/shared/lib/audioMath';
import type { ProjectDelta, TransportState } from '@/shared/api/engine';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { ProjectTrack } from '@/shared/lib/trackAdapter';

export interface DeltaApplyState {
    timelineClips: TimelineClip[];
    clipsById: Record<string, TimelineClip>;
    projectTracks: ProjectTrack[];
    tracksById: Record<string, ProjectTrack>;
    projectBpm: number;
    projectSampleRate: number;
    transport: TransportState;
}

export interface DeltaApplyResult {
    nextState: Pick<DeltaApplyState, 'timelineClips' | 'clipsById' | 'projectTracks' | 'tracksById'> | null;
    fallbackReason: string | null;
}

export function applyProjectDeltasToState(
    state: DeltaApplyState,
    deltas: ProjectDelta[],
    reason: string,
): DeltaApplyResult {
    const bpm = state.projectBpm || state.transport.bpm || 120;
    const sr = resolveSampleRate(state.projectSampleRate, state.transport.sample_rate);

    let timelineClips = state.timelineClips;
    let clipsById = state.clipsById;
    let projectTracks = state.projectTracks;
    let tracksById = state.tracksById;
    let changed = false;
    let fallbackReason: string | null = null;

    // Lazily-built index maps — built once per batch and invalidated by structural edits.
    let clipIdxMap: Map<string, number> | null = null;
    let trackIdxMap: Map<string, number> | null = null;
    let clipsArrayCopied = false;
    let tracksArrayCopied = false;

    const getClipIdx = (id: string): number => {
        if (!clipIdxMap) {
            clipIdxMap = new Map();
            for (let i = 0; i < timelineClips.length; i++) {
                clipIdxMap.set(timelineClips[i].id, i);
            }
        }
        return clipIdxMap.get(id) ?? -1;
    };

    const getTrackIdx = (id: string): number => {
        if (!trackIdxMap) {
            trackIdxMap = new Map();
            for (let i = 0; i < projectTracks.length; i++) {
                trackIdxMap.set(projectTracks[i].id, i);
            }
        }
        return trackIdxMap.get(id) ?? -1;
    };

    const spliceClip = (nextClip: TimelineClip): void => {
        const idx = getClipIdx(nextClip.id);
        if (idx !== -1) {
            if (!clipsArrayCopied) {
                timelineClips = timelineClips.slice();
                clipsArrayCopied = true;
            }
            timelineClips[idx] = nextClip;
        }
        clipsById = { ...clipsById, [nextClip.id]: nextClip };
        changed = true;
    };

    const spliceTrack = (nextTrack: ProjectTrack): void => {
        const idx = getTrackIdx(nextTrack.id);
        if (idx !== -1) {
            if (!tracksArrayCopied) {
                projectTracks = projectTracks.slice();
                tracksArrayCopied = true;
            }
            projectTracks[idx] = nextTrack;
        }
        tracksById = { ...tracksById, [nextTrack.id]: nextTrack };
        changed = true;
    };

    for (const delta of deltas) {
        if (delta.kind === 'ClipMoved') {
            const clip = clipsById[delta.data.clip_id];
            if (!clip) continue;
            spliceClip({
                ...clip,
                trackIndex: delta.data.new_track_index,
                startBeat: frameToBeat(delta.data.new_position, bpm, sr),
            });
            continue;
        }

        if (delta.kind === 'ClipResized') {
            const clip = clipsById[delta.data.clip_id];
            if (!clip) continue;
            spliceClip({
                ...clip,
                startBeat: frameToBeat(delta.data.new_position, bpm, sr),
                durationBeats: frameToBeat(delta.data.new_duration, bpm, sr),
                durationSamples: delta.data.new_duration,
            });
            continue;
        }

        if (delta.kind === 'ClipDuplicated') {
            const sourceClip = clipsById[delta.data.source_clip_id];
            if (!sourceClip) {
                fallbackReason = `${reason}-duplicate-missing-source`;
                break;
            }
            const nextClip: TimelineClip = {
                ...sourceClip,
                id: delta.data.new_clip_id,
                startBeat: frameToBeat(delta.data.new_position, bpm, sr),
            };
            if (!clipsArrayCopied) {
                timelineClips = timelineClips.slice();
                clipsArrayCopied = true;
            }
            timelineClips.push(nextClip);
            if (clipIdxMap) clipIdxMap.set(nextClip.id, timelineClips.length - 1);
            clipsById = { ...clipsById, [nextClip.id]: nextClip };
            changed = true;
            continue;
        }

        if (delta.kind === 'ClipSplit') {
            const clip = clipsById[delta.data.original_clip_id];
            if (!clip) {
                fallbackReason = `${reason}-split-missing-source`;
                break;
            }
            const splitBeat = frameToBeat(delta.data.split_frame, bpm, sr);
            const clipEnd = clip.startBeat + clip.durationBeats;
            const leftDuration = splitBeat - clip.startBeat;
            const rightDuration = clipEnd - splitBeat;
            if (leftDuration <= 0 || rightDuration <= 0) {
                fallbackReason = `${reason}-split-invalid-range`;
                break;
            }

            const splitOffsetBeats = splitBeat - clip.startBeat;
            const splitOffsetFrames = Math.max(
                0,
                delta.data.split_frame - Math.round(beatToFrame(clip.startBeat, bpm, sr)),
            );

            const leftClip: TimelineClip = {
                ...clip,
                durationBeats: leftDuration,
                durationSamples:
                    clip.durationSamples != null
                        ? Math.max(1, Math.round(beatDurationToFrames(leftDuration, bpm, sr)))
                        : clip.durationSamples,
                midiNotes:
                    clip.type === 'midi' && Array.isArray(clip.midiNotes)
                        ? clip.midiNotes.filter((n) => n.startBeat + n.durationBeats <= splitOffsetBeats + 1e-9)
                        : clip.midiNotes,
            };

            const rightClip: TimelineClip = {
                ...clip,
                id: delta.data.right_id,
                startBeat: splitBeat,
                durationBeats: rightDuration,
                durationSamples:
                    clip.durationSamples != null
                        ? Math.max(1, Math.round(beatDurationToFrames(rightDuration, bpm, sr)))
                        : clip.durationSamples,
                sourceOffset: Math.max(0, (clip.sourceOffset ?? 0) + splitOffsetFrames),
                midiNotes:
                    clip.type === 'midi' && Array.isArray(clip.midiNotes)
                        ? clip.midiNotes
                            .filter((n) => n.startBeat + n.durationBeats > splitOffsetBeats + 1e-9)
                            .map((n) => ({ ...n, startBeat: Math.max(0, n.startBeat - splitOffsetBeats) }))
                        : clip.midiNotes,
            };

            spliceClip(leftClip);
            if (!clipsArrayCopied) {
                timelineClips = timelineClips.slice();
                clipsArrayCopied = true;
            }
            timelineClips.push(rightClip);
            if (clipIdxMap) clipIdxMap.set(rightClip.id, timelineClips.length - 1);
            clipsById = { ...clipsById, [rightClip.id]: rightClip };
            continue;
        }

        if (delta.kind === 'ClipsMerged') {
            const sourceClips = delta.data.source_clip_ids
                .map((id: string) => clipsById[id])
                .filter((c): c is TimelineClip => Boolean(c));
            if (sourceClips.length === 0) {
                fallbackReason = `${reason}-merge-missing-sources`;
                break;
            }

            const representative = sourceClips[0];
            const mergedStart = Math.min(...sourceClips.map((c) => c.startBeat));
            const mergedEnd = Math.max(...sourceClips.map((c) => c.startBeat + c.durationBeats));
            const mergedDuration = Math.max(0.0001, mergedEnd - mergedStart);
            const sourceSet = new Set(delta.data.source_clip_ids);

            const mergedClip: TimelineClip = {
                ...representative,
                id: delta.data.new_clip_id,
                name: 'Merged Clip',
                startBeat: mergedStart,
                durationBeats: mergedDuration,
                durationSamples:
                    representative.durationSamples != null
                        ? Math.max(1, Math.round(beatDurationToFrames(mergedDuration, bpm, sr)))
                        : representative.durationSamples,
                sourceOffset: representative.type === 'audio' ? 0 : representative.sourceOffset,
                fadeIn: 0,
                fadeOut: 0,
                midiNotes:
                    representative.type === 'midi'
                        ? sourceClips.flatMap((clipItem) =>
                            (clipItem.midiNotes ?? []).map((note) => ({
                                ...note,
                                startBeat: clipItem.startBeat - mergedStart + note.startBeat,
                            })),
                        )
                        : representative.midiNotes,
            };

            timelineClips = timelineClips.filter((c) => !sourceSet.has(c.id));
            timelineClips = [...timelineClips, mergedClip];
            clipsArrayCopied = true;
            clipIdxMap = null;

            const nextClipsById: Record<string, TimelineClip> = { ...clipsById };
            for (const id of sourceSet) {
                delete nextClipsById[id];
            }
            nextClipsById[mergedClip.id] = mergedClip;
            clipsById = nextClipsById;
            changed = true;
            continue;
        }

        if (delta.kind === 'ClipDeleted') {
            timelineClips = timelineClips.filter((c) => c.id !== delta.data.clip_id);
            clipsArrayCopied = true;
            clipIdxMap = null;
            const { [delta.data.clip_id]: _removed, ...rest } = clipsById;
            clipsById = rest;
            changed = true;
            continue;
        }

        if (delta.kind === 'ClipMuteChanged') {
            const clip = clipsById[delta.data.clip_id];
            if (!clip) continue;
            spliceClip({ ...clip, muted: delta.data.muted });
            continue;
        }

        if (delta.kind === 'TrackVolumeChanged') {
            const track = tracksById[delta.data.track_id];
            if (!track) continue;
            spliceTrack({ ...track, volume: delta.data.volume });
            continue;
        }

        if (delta.kind === 'TrackPanChanged') {
            const track = tracksById[delta.data.track_id];
            if (!track) continue;
            spliceTrack({ ...track, pan: delta.data.pan });
            continue;
        }

        if (delta.kind === 'TrackMuteChanged') {
            const track = tracksById[delta.data.track_id];
            if (!track) continue;
            spliceTrack({ ...track, is_mute: delta.data.muted });
            continue;
        }

        if (delta.kind === 'TrackSoloChanged') {
            const track = tracksById[delta.data.track_id];
            if (!track) continue;
            spliceTrack({ ...track, is_solo: delta.data.soloed });
        }
    }

    if (!changed) {
        return { nextState: null, fallbackReason };
    }

    return {
        nextState: { timelineClips, clipsById, projectTracks, tracksById },
        fallbackReason,
    };
}
