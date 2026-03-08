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

// This function used to rebuild clipsById from timelineClips.
// It's no longer necessary with EntityState, replacing with a robust sync of allIds.

// BUG-P001 FIX: Mutate working state in-place instead of O(n) spread copies.
// DeltaWorkingState is a mutable working copy — safe to mutate directly.
function upsertClip(state: DeltaWorkingState, clip: TimelineClip): void {
    if (!isValidClipId(clip.id)) return;
    const existing = state.clips.byId[clip.id];
    if (!existing) {
        state.clips.allIds.push(clip.id);
    }
    state.clips.byId[clip.id] = clip;
}

// BUG-P002 FIX: Direct mutation instead of O(n) spread for cache warming.
function resolveClip(state: DeltaWorkingState, clipId: string): TimelineClip | null {
    if (!isValidClipId(clipId)) return null;
    return state.clips.byId[clipId] ?? null;
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
        // BUG-TRIM-03 FIX: For warped clips, `durationSamples` represents the source
        // material window (which DIFFERS from timeline duration). `delta.data.new_duration`
        // is timeline duration in frames. Writing it as `durationSamples` would break the
        // waveform window size for warped clips. The subsequent `ClipWarpChanged` delta
        // or `ProjectSnapshotReplaced` will provide the correct `warpSourceDurationFrames`.
        // For non-warped clips, `durationSamples` === timeline duration, so direct copy is safe.
        const nextDurationSamples = clip.isWarped
            ? clip.durationSamples  // Keep — will be corrected by ClipWarpChanged/Snapshot
            : delta.data.new_duration;
        const next = {
            ...clip,
            startBeat: frameToBeat(delta.data.new_position, env.bpm, env.sampleRate),
            durationBeats: frameToBeat(delta.data.new_duration, env.bpm, env.sampleRate),
            durationSamples: nextDurationSamples,
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
        // SSOT FIX: Apply new_track_index and new_duration from delta data.
        // Prevents ghost clip rendering on the wrong track while waiting for snapshot.
        const nextClip: TimelineClip = {
            ...sourceClip,
            id: delta.data.new_clip_id,
            startBeat: frameToBeat(delta.data.new_position, env.bpm, env.sampleRate),
            trackIndex: delta.data.new_track_index ?? sourceClip.trackIndex,
            durationBeats: delta.data.new_duration != null
                ? frameToBeat(delta.data.new_duration, env.bpm, env.sampleRate)
                : sourceClip.durationBeats,
            durationSamples: delta.data.new_duration ?? sourceClip.durationSamples,
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
            midiNotes: clip.type === 'midi' && Array.isArray(clip.midiNotes)
                // BUG-036 FIX: Use exclusive boundary for left clip to prevent notes from appearing in both clips.
                // Previously, notes within 2e-9 of the split boundary appeared in BOTH left and right clips.
                ? clip.midiNotes.filter((n) => n.startBeat + n.durationBeats <= splitOffsetBeats)
                : clip.midiNotes,
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
                // BUG-036 FIX: Use strict exclusive boundary — notes starting AT the split go to right clip only.
                ? clip.midiNotes.filter((n) => n.startBeat >= splitOffsetBeats).map((n) => ({ ...n, startBeat: Math.max(0, n.startBeat - splitOffsetBeats) }))
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
        const nextById: Record<string, TimelineClip> = {};
        const nextAllIds: string[] = [];

        for (const id of state.clips.allIds) {
            if (!sourceSet.has(id)) {
                nextById[id] = state.clips.byId[id];
                nextAllIds.push(id);
            }
        }

        nextById[mergedClip.id] = mergedClip;
        nextAllIds.push(mergedClip.id);

        state.clips = { byId: nextById, allIds: nextAllIds };
        state.changed = true;
        return true;
    }

    if (delta.kind === 'ClipDeleted') {
        if (state.clips.byId[delta.data.clip_id]) {
            delete state.clips.byId[delta.data.clip_id];
            state.clips.allIds = state.clips.allIds.filter((id) => id !== delta.data.clip_id);
            state.changed = true;
        }
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
                // BUG-F011 FIX: Use pitch+startBeat for stable ID generation instead of array index.
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

    // SSOT FIX: Handle clip rename deltas for immediate UI update.
    if (delta.kind === 'ClipRenamed') {
        const clip = resolveClip(state, delta.data.clip_id);
        if (!clip) return false;
        const trimmedName = typeof delta.data.new_name === 'string' ? delta.data.new_name.trim() : '';
        const next = {
            ...clip,
            name: trimmedName || clip.name,
        };
        upsertClip(state, next);
        state.changed = true;
        return true;
    }

    return false;
}
