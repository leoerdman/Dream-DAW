import { beatDurationToFrames, beatToFrame, frameToBeat } from '@/shared/lib/audioMath';
import type { ProjectDelta } from '@/shared/api/engine';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { DeltaEnv, DeltaWorkingState } from './types';
import { getTrackByIndex } from './trackStateOps';

// BUG-D004 FIX: Import canonical default track color instead of hardcoded hex.
import { DEFAULT_TRACK_COLOR } from '@/shared/lib/trackAdapter';

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

// BUG-P001 FIX: Mutate working state in-place instead of O(n) spread copies.
// DeltaWorkingState is a mutable working copy — safe to mutate directly.
function upsertClip(state: DeltaWorkingState, clip: TimelineClip): void {
    if (!isValidClipId(clip.id)) return;
    const existing = state.clipsById[clip.id];
    if (existing) {
        const idx = state.timelineClips.indexOf(existing);
        if (idx >= 0) {
            state.timelineClips[idx] = clip;
        } else {
            const fallbackIdx = state.timelineClips.findIndex((c) => c.id === clip.id);
            if (fallbackIdx >= 0) {
                state.timelineClips[fallbackIdx] = clip;
            } else {
                state.timelineClips.push(clip);
            }
        }
    } else {
        state.timelineClips.push(clip);
    }
    // BUG-P001 FIX: Direct property assignment instead of O(n) spread.
    state.clipsById[clip.id] = clip;
}

// BUG-P002 FIX: Direct mutation instead of O(n) spread for cache warming.
function resolveClip(state: DeltaWorkingState, clipId: string): TimelineClip | null {
    if (!isValidClipId(clipId)) return null;
    const fromMap = state.clipsById[clipId];
    if (fromMap) return fromMap;
    const fromTimeline = state.timelineClips.find((c) => c.id === clipId) ?? null;
    if (fromTimeline) {
        state.clipsById[clipId] = fromTimeline;
    }
    return fromTimeline;
}

export function applyClipDelta(state: DeltaWorkingState, delta: ProjectDelta, env: DeltaEnv): boolean {
    if (delta.kind === 'ClipAdded') {
        if (!isValidClipId(delta.data.clip_id)) return true;
        const track = getTrackByIndex(state, delta.data.track_index);
        // BUG-I001 FIX: Trim whitespace from clip name.
        const clipName = typeof delta.data.name === 'string' ? delta.data.name.trim() : '';
        // BUG-F004 FIX: Initialize warp/pitch properties from delta data when available.
        const nextClip: TimelineClip = {
            id: delta.data.clip_id,
            name: clipName || 'Untitled',
            trackIndex: delta.data.track_index,
            startBeat: frameToBeat(delta.data.position, env.bpm, env.sampleRate),
            durationBeats: frameToBeat(delta.data.duration, env.bpm, env.sampleRate),
            durationSamples: delta.data.duration,
            type: delta.data.clip_type === 'midi' ? 'midi' : 'audio',
            // BUG-H10 FIX: Prefer color from delta data (backend may send custom clip color).
            // Falls back to track color, then DEFAULT_TRACK_COLOR if track not found.
            color: (typeof (delta.data as Record<string, unknown>).color === 'string'
                ? (delta.data as Record<string, unknown>).color as string
                : null) ?? track?.color ?? DEFAULT_TRACK_COLOR,
            filePath: delta.data.file_path ?? undefined,
            sourceOffset: delta.data.source_offset ?? 0,
            muted: false,
            midiNotes: delta.data.clip_type === 'midi' ? [] : undefined,
            // BUG-F004 FIX: Carry over warp/pitch if provided by backend.
            isWarped: delta.data.is_warped ?? false,
            warpMode: delta.data.warp_mode ?? undefined,
            warpBaseBpm: delta.data.warp_base_bpm ?? undefined,
            warpSourceDurationFrames: delta.data.warp_source_duration_frames ?? undefined,
            pitchShiftSemitones: delta.data.pitch_shift_semitones ?? 0,
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
        // BUG-F009 FIX: Also update sourceOffset when the backend provides it
        // (left-edge resize changes both position and source_offset).
        const next = {
            ...clip,
            startBeat: frameToBeat(delta.data.new_position, env.bpm, env.sampleRate),
            durationBeats: frameToBeat(delta.data.new_duration, env.bpm, env.sampleRate),
            durationSamples: delta.data.new_duration,
            ...(delta.data.new_source_offset != null ? { sourceOffset: delta.data.new_source_offset } : {}),
        };
        upsertClip(state, next);
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipDuplicated') {
        if (!isValidClipId(delta.data.new_clip_id)) return true;
        const sourceClip = resolveClip(state, delta.data.source_clip_id);
        if (!sourceClip) return false;
        // BUG-F002 FIX: Carry over duration/sourceOffset from delta if provided,
        // ensuring duplicated clip reflects server-side modifications.
        const nextClip: TimelineClip = {
            ...sourceClip,
            id: delta.data.new_clip_id,
            startBeat: frameToBeat(delta.data.new_position, env.bpm, env.sampleRate),
            ...(delta.data.new_duration != null ? {
                durationBeats: frameToBeat(delta.data.new_duration, env.bpm, env.sampleRate),
                durationSamples: delta.data.new_duration,
            } : {}),
            ...(delta.data.new_source_offset != null ? { sourceOffset: delta.data.new_source_offset } : {}),
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
        // BUG-F001 FIX: Convert durations to frames before clamping against frame-based fades.
        // fadeIn/fadeOut are in sample frames, leftDuration/rightDuration are in beats — incompatible units.
        const leftDurationFrames = beatDurationToFrames(leftDuration, env.bpm, env.sampleRate);
        const rightDurationFrames = beatDurationToFrames(rightDuration, env.bpm, env.sampleRate);
        const leftFadeIn = Math.min(clip.fadeIn ?? 0, leftDurationFrames);
        const leftFadeOut = 0; // Split edge has no fade out
        const rightFadeIn = 0; // Split edge has no fade in
        const rightFadeOut = Math.min(clip.fadeOut ?? 0, rightDurationFrames);
        const leftClip: TimelineClip = {
            ...clip,
            durationBeats: leftDuration,
            durationSamples: clip.durationSamples != null ? Math.max(1, Math.round(beatDurationToFrames(leftDuration, env.bpm, env.sampleRate))) : clip.durationSamples,
            fadeIn: leftFadeIn,
            fadeOut: leftFadeOut,
            midiNotes: clip.type === 'midi' && Array.isArray(clip.midiNotes) ? clip.midiNotes.filter((n) => n.startBeat + n.durationBeats <= splitOffsetBeats + 1e-9) : clip.midiNotes,
        };
        const rightClip: TimelineClip = {
            ...clip,
            id: delta.data.right_id,
            startBeat: splitBeat,
            durationBeats: rightDuration,
            durationSamples: clip.durationSamples != null ? Math.max(1, Math.round(beatDurationToFrames(rightDuration, env.bpm, env.sampleRate))) : clip.durationSamples,
            sourceOffset: Math.max(0, (clip.sourceOffset ?? 0) + splitOffsetFrames),
            fadeIn: rightFadeIn,
            fadeOut: rightFadeOut,
            midiNotes: clip.type === 'midi' && Array.isArray(clip.midiNotes)
                ? clip.midiNotes.filter((n) => n.startBeat >= splitOffsetBeats - 1e-9).map((n) => ({ ...n, startBeat: Math.max(0, n.startBeat - splitOffsetBeats) }))
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
        // BUG-F003 FIX: Preserve sourceOffset from the earliest clip (the one whose
        // audio content starts first), not force to 0 which breaks trimmed clips.
        const earliestClip = sourceClips.reduce((a, b) => a.startBeat <= b.startBeat ? a : b);
        const mergedClip: TimelineClip = {
            ...representative,
            id: delta.data.new_clip_id,
            name: representative.name || 'Merged Clip',
            startBeat: mergedStart,
            durationBeats: mergedDuration,
            durationSamples: representative.durationSamples != null ? Math.max(1, Math.round(beatDurationToFrames(mergedDuration, env.bpm, env.sampleRate))) : representative.durationSamples,
            sourceOffset: earliestClip.sourceOffset ?? 0,
            fadeIn: 0,
            fadeOut: 0,
            midiNotes: representative.type === 'midi'
                ? sourceClips.flatMap((c) => (c.midiNotes ?? []).map((n) => ({ ...n, startBeat: c.startBeat - mergedStart + n.startBeat })))
                : representative.midiNotes,
        };
        // BUG-P001 FIX: Mutate in-place instead of spread + filter.
        const nextClips: TimelineClip[] = [];
        for (const c of state.timelineClips) {
            if (!sourceSet.has(c.id)) nextClips.push(c);
        }
        nextClips.push(mergedClip);
        state.timelineClips = nextClips;
        syncClipMapFromTimeline(state);
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipDeleted') {
        // BUG-P001 FIX: Direct delete instead of spread copy.
        delete state.clipsById[delta.data.clip_id];
        state.timelineClips = state.timelineClips.filter((c) => c.id !== delta.data.clip_id);
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

        const existingNotes = clip.midiNotes ?? [];
        const usedExistingIndices = new Set<number>();

        const next = {
            ...clip,
            midiNotes: delta.data.notes.map((n: { start_beat: number; pitch: number; velocity: number; duration_beats: number }) => {
                const startBeat = n.start_beat;
                const pitch = n.pitch;
                let matchedId: string | undefined;
                const tolerance = 1e-6;
                for (let i = 0; i < existingNotes.length; i++) {
                    if (usedExistingIndices.has(i)) continue;
                    const existing = existingNotes[i];
                    if (existing.pitch === pitch && Math.abs(existing.startBeat - startBeat) < tolerance) {
                        matchedId = existing.id;
                        usedExistingIndices.add(i);
                        break;
                    }
                }
                // BUG-F008 FIX: Use pitch+startBeat for stable ID generation instead of array index.
                // Array index changes when notes are reordered on the backend.
                return {
                    id: matchedId ?? `${delta.data.clip_id}:n${pitch}:${startBeat.toFixed(6)}`,
                    pitch,
                    velocity: n.velocity,
                    startBeat,
                    durationBeats: n.duration_beats,
                };
            }),
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
