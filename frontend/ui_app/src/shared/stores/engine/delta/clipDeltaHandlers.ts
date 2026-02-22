import { beatDurationToFrames, beatToFrame, frameToBeat } from '@/shared/lib/audioMath';
import type { ProjectDelta } from '@/shared/api/engine';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { DeltaEnv, DeltaWorkingState } from './types';

export function applyClipDelta(state: DeltaWorkingState, delta: ProjectDelta, env: DeltaEnv): boolean {
    if (delta.kind === 'ClipMoved') {
        const clip = state.clipsById[delta.data.clip_id];
        if (!clip) return true;
        const next = { ...clip, trackIndex: delta.data.new_track_index, startBeat: frameToBeat(delta.data.new_position, env.bpm, env.sampleRate) };
        state.timelineClips = state.timelineClips.map((c) => (c.id === next.id ? next : c));
        state.clipsById = { ...state.clipsById, [next.id]: next };
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipResized') {
        const clip = state.clipsById[delta.data.clip_id];
        if (!clip) return true;
        const next = {
            ...clip,
            startBeat: frameToBeat(delta.data.new_position, env.bpm, env.sampleRate),
            durationBeats: frameToBeat(delta.data.new_duration, env.bpm, env.sampleRate),
            durationSamples: delta.data.new_duration,
        };
        state.timelineClips = state.timelineClips.map((c) => (c.id === next.id ? next : c));
        state.clipsById = { ...state.clipsById, [next.id]: next };
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipDuplicated') {
        const sourceClip = state.clipsById[delta.data.source_clip_id];
        if (!sourceClip) return true;
        const nextClip: TimelineClip = {
            ...sourceClip,
            id: delta.data.new_clip_id,
            startBeat: frameToBeat(delta.data.new_position, env.bpm, env.sampleRate),
        };
        state.timelineClips = [...state.timelineClips, nextClip];
        state.clipsById = { ...state.clipsById, [nextClip.id]: nextClip };
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipSplit') {
        const clip = state.clipsById[delta.data.original_clip_id];
        if (!clip) return true;
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
        state.timelineClips = [...state.timelineClips.map((c) => (c.id === leftClip.id ? leftClip : c)), rightClip];
        state.clipsById = { ...state.clipsById, [leftClip.id]: leftClip, [rightClip.id]: rightClip };
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipsMerged') {
        const sourceClips = delta.data.source_clip_ids.map((id: string) => state.clipsById[id]).filter((c): c is TimelineClip => Boolean(c));
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
        const nextClipsById: Record<string, TimelineClip> = { ...state.clipsById };
        for (const id of sourceSet) delete nextClipsById[id];
        nextClipsById[mergedClip.id] = mergedClip;
        state.timelineClips = [...state.timelineClips.filter((c) => !sourceSet.has(c.id)), mergedClip];
        state.clipsById = nextClipsById;
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
        const clip = state.clipsById[delta.data.clip_id];
        if (!clip) return true;
        const next = { ...clip, muted: delta.data.muted };
        state.timelineClips = state.timelineClips.map((c) => (c.id === next.id ? next : c));
        state.clipsById = { ...state.clipsById, [next.id]: next };
        state.changed = true;
        return true;
    }

    return false;
}
