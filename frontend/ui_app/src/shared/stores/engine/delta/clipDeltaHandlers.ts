import { beatDurationToFrames, beatToFrame, frameToBeat } from '@/shared/lib/audioMath';
import type { ProjectDelta } from '@/shared/api/engine';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { DeltaEnv, DeltaWorkingState } from './types';
import { getTrackByIndex } from './trackStateOps';

function isValidClipId(id: unknown): id is string {
    return typeof id === 'string' && id.trim().length > 0;
}

function syncClipMapFromTimeline(state: DeltaWorkingState): void {
    const next: Record<string, TimelineClip> = {};
    for (const clip of state.timelineClips) {
        if (!isValidClipId(clip.id)) continue;
        next[clip.id] = clip;
    }
    state.clipsById = next;
}

function upsertClip(state: DeltaWorkingState, clip: TimelineClip): void {
    if (!isValidClipId(clip.id)) return;
    const exists = state.timelineClips.some((c) => c.id === clip.id);
    state.timelineClips = exists
        ? state.timelineClips.map((c) => (c.id === clip.id ? clip : c))
        : [...state.timelineClips, clip];
    state.clipsById = { ...state.clipsById, [clip.id]: clip };
}

function resolveClip(state: DeltaWorkingState, clipId: string): TimelineClip | null {
    if (!isValidClipId(clipId)) return null;
    const fromMap = state.clipsById[clipId];
    if (fromMap) return fromMap;
    const fromTimeline = state.timelineClips.find((c) => c.id === clipId) ?? null;
    if (fromTimeline) {
        state.clipsById = { ...state.clipsById, [clipId]: fromTimeline };
    }
    return fromTimeline;
}

export function applyClipDelta(state: DeltaWorkingState, delta: ProjectDelta, env: DeltaEnv): boolean {
    if (delta.kind === 'ClipAdded') {
        if (!isValidClipId(delta.data.clip_id)) return true;
        const track = getTrackByIndex(state, delta.data.track_index);
        const nextClip: TimelineClip = {
            id: delta.data.clip_id,
            name: delta.data.name,
            trackIndex: delta.data.track_index,
            startBeat: frameToBeat(delta.data.position, env.bpm, env.sampleRate),
            durationBeats: frameToBeat(delta.data.duration, env.bpm, env.sampleRate),
            durationSamples: delta.data.duration,
            type: delta.data.clip_type === 'midi' ? 'midi' : 'audio',
            color: track?.color ?? 'var(--token-color-hex-667788)',
            filePath: delta.data.file_path ?? undefined,
            sourceOffset: 0,
            muted: false,
            midiNotes: delta.data.clip_type === 'midi' ? [] : undefined,
        };
        upsertClip(state, nextClip);
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipMoved') {
        const clip = resolveClip(state, delta.data.clip_id);
        if (!clip) return false;
        const next = { ...clip, trackIndex: delta.data.new_track_index, startBeat: frameToBeat(delta.data.new_position, env.bpm, env.sampleRate) };
        upsertClip(state, next);
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipResized') {
        const clip = resolveClip(state, delta.data.clip_id);
        if (!clip) return false;
        const next = {
            ...clip,
            startBeat: frameToBeat(delta.data.new_position, env.bpm, env.sampleRate),
            durationBeats: frameToBeat(delta.data.new_duration, env.bpm, env.sampleRate),
            durationSamples: delta.data.new_duration,
        };
        upsertClip(state, next);
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipDuplicated') {
        if (!isValidClipId(delta.data.new_clip_id)) return true;
        const sourceClip = resolveClip(state, delta.data.source_clip_id);
        if (!sourceClip) return false;
        const nextClip: TimelineClip = {
            ...sourceClip,
            id: delta.data.new_clip_id,
            startBeat: frameToBeat(delta.data.new_position, env.bpm, env.sampleRate),
        };
        upsertClip(state, nextClip);
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipSplit') {
        if (!isValidClipId(delta.data.right_id)) return true;
        const clip = resolveClip(state, delta.data.original_clip_id);
        if (!clip) return false;
        const splitBeat = frameToBeat(delta.data.split_frame, env.bpm, env.sampleRate);
        const clipEnd = clip.startBeat + clip.durationBeats;
        const leftDuration = splitBeat - clip.startBeat;
        const rightDuration = clipEnd - splitBeat;
        if (leftDuration <= 0 || rightDuration <= 0) return true;

        const splitOffsetBeats = splitBeat - clip.startBeat;
        const splitOffsetFrames = Math.max(0, delta.data.split_frame - Math.round(beatToFrame(clip.startBeat, env.bpm, env.sampleRate)));
        const leftClip: TimelineClip = {
            ...clip,
            durationBeats: leftDuration,
            durationSamples: clip.durationSamples != null ? Math.max(1, Math.round(beatDurationToFrames(leftDuration, env.bpm, env.sampleRate))) : clip.durationSamples,
            midiNotes: clip.type === 'midi' && Array.isArray(clip.midiNotes) ? clip.midiNotes.filter((n) => n.startBeat + n.durationBeats <= splitOffsetBeats + 1e-9) : clip.midiNotes,
        };
        const rightClip: TimelineClip = {
            ...clip,
            id: delta.data.right_id,
            startBeat: splitBeat,
            durationBeats: rightDuration,
            durationSamples: clip.durationSamples != null ? Math.max(1, Math.round(beatDurationToFrames(rightDuration, env.bpm, env.sampleRate))) : clip.durationSamples,
            sourceOffset: Math.max(0, (clip.sourceOffset ?? 0) + splitOffsetFrames),
            midiNotes: clip.type === 'midi' && Array.isArray(clip.midiNotes)
                ? clip.midiNotes.filter((n) => n.startBeat + n.durationBeats > splitOffsetBeats + 1e-9).map((n) => ({ ...n, startBeat: Math.max(0, n.startBeat - splitOffsetBeats) }))
                : clip.midiNotes,
        };
        upsertClip(state, leftClip);
        upsertClip(state, rightClip);
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipsMerged') {
        if (!isValidClipId(delta.data.new_clip_id)) return true;
        const sourceClips = delta.data.source_clip_ids
            .map((id: string) => resolveClip(state, id))
            .filter((c): c is TimelineClip => Boolean(c));
        if (sourceClips.length === 0) return true;
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
            durationSamples: representative.durationSamples != null ? Math.max(1, Math.round(beatDurationToFrames(mergedDuration, env.bpm, env.sampleRate))) : representative.durationSamples,
            sourceOffset: representative.type === 'audio' ? 0 : representative.sourceOffset,
            fadeIn: 0,
            fadeOut: 0,
            midiNotes: representative.type === 'midi'
                ? sourceClips.flatMap((c) => (c.midiNotes ?? []).map((n) => ({ ...n, startBeat: c.startBeat - mergedStart + n.startBeat })))
                : representative.midiNotes,
        };
        state.timelineClips = [...state.timelineClips.filter((c) => !sourceSet.has(c.id)), mergedClip];
        syncClipMapFromTimeline(state);
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipDeleted') {
        const next = { ...state.clipsById };
        delete next[delta.data.clip_id];
        state.timelineClips = state.timelineClips.filter((c) => c.id !== delta.data.clip_id);
        state.clipsById = next;
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipMuteChanged') {
        const clip = resolveClip(state, delta.data.clip_id);
        if (!clip) return false;
        const next = { ...clip, muted: delta.data.muted };
        upsertClip(state, next);
        state.changed = true;
        return true;
    }

    if (delta.kind === 'MidiClipNotesReplaced') {
        const clip = resolveClip(state, delta.data.clip_id);
        if (!clip || clip.type !== 'midi') return false;
        const next = {
            ...clip,
            midiNotes: delta.data.notes.map((n) => ({
                // BUG-019 FIX: Preserve note identity — previously dropped,
                // breaking selection and editing after notes replacement.
                id: (n as { id?: string }).id,
                pitch: n.pitch,
                velocity: n.velocity,
                startBeat: n.start_beat,
                durationBeats: n.duration_beats,
            })),
        };
        upsertClip(state, next);
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipSourceOffsetChanged') {
        const clip = resolveClip(state, delta.data.clip_id);
        if (!clip) return false;
        const next = { ...clip, sourceOffset: delta.data.source_offset };
        upsertClip(state, next);
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipFadesChanged') {
        const clip = resolveClip(state, delta.data.clip_id);
        if (!clip) return false;
        const next = {
            ...clip,
            fadeIn: delta.data.fade_in_frames,
            fadeOut: delta.data.fade_out_frames,
        };
        upsertClip(state, next);
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipWarpChanged') {
        const clip = resolveClip(state, delta.data.clip_id);
        if (!clip) return false;
        const next = {
            ...clip,
            isWarped: delta.data.is_warped,
            warpMode: delta.data.warp_mode,
            warpBaseBpm: delta.data.warp_base_bpm,
            warpSourceDurationFrames: delta.data.warp_source_duration_frames != null
                ? Math.max(1, delta.data.warp_source_duration_frames)
                : clip.warpSourceDurationFrames,
        };
        upsertClip(state, next);
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipPitchChanged') {
        const clip = resolveClip(state, delta.data.clip_id);
        if (!clip) return false;
        const next = {
            ...clip,
            pitchShiftSemitones: delta.data.pitch_shift_semitones,
        };
        upsertClip(state, next);
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipColorChanged') {
        const clip = resolveClip(state, delta.data.clip_id);
        if (!clip) return false;
        const next = {
            ...clip,
            color: delta.data.color ?? clip.color,
        };
        upsertClip(state, next);
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipFilePathChanged') {
        const clip = resolveClip(state, delta.data.clip_id);
        if (!clip) return false;
        const next = {
            ...clip,
            filePath: delta.data.file_path,
            isOffline: delta.data.is_offline,
        };
        upsertClip(state, next);
        state.changed = true;
        return true;
    }

    return false;
}
