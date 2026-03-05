import type { ProjectDelta } from '@/shared/api/engine';
import type { ProjectTrack } from '@/shared/lib/trackAdapter';
import type { DeltaEnv, DeltaWorkingState } from './types';
import { clamp01 } from '@/shared/lib/audioMath';
import { colorForTrackIndex, normalizeTrackType } from './trackDeltaUtils';
import {
    findTrackIndexById,
    getTrackByIndex,
    getTrackCount,
    getTrackIdByIndex,
    insertTrackAt,
    moveTrackById,
    patchTrackById,
    rebuildChildTrackIds,
    removeTrackById,
} from './trackStateOps';

function patchTrack(state: DeltaWorkingState, id: string, patch: Partial<ProjectTrack>): void {
    patchTrackById(state, id, patch);
}

function patchSampleRackPad(
    state: DeltaWorkingState,
    trackId: string,
    padIndex: number,
    patch: Record<string, unknown>,
): boolean {
    const track = state.tracks.byId[trackId];
    if (!track || !track.sample_rack || !Array.isArray(track.sample_rack.pads)) return false;
    if (padIndex < 0 || padIndex >= track.sample_rack.pads.length) return false;
    const nextPads = track.sample_rack.pads.slice();
    nextPads[padIndex] = { ...nextPads[padIndex], ...patch };
    patchTrack(state, trackId, {
        sample_rack: {
            ...track.sample_rack,
            pads: nextPads,
        },
    });
    return true;
}

export function applyTrackDelta(state: DeltaWorkingState, delta: ProjectDelta, env: DeltaEnv): boolean {
    void env;
    if (delta.kind === 'TrackVolumeChanged') {
        patchTrack(state, delta.data.track_id, { volume: delta.data.volume });
        return true;
    }
    if (delta.kind === 'TrackPanChanged') {
        patchTrack(state, delta.data.track_id, { pan: delta.data.pan });
        return true;
    }
    if (delta.kind === 'TrackDisabledChanged') {
        // BUG-H11 FIX: Proper type narrowing instead of fragile dual-cast.
        // Backend schema migrated from `muted` → `disabled`. Support both
        // with explicit fallback and deprecation warning for old field.
        const data = delta.data as Record<string, unknown>;
        let nextDisabled: boolean;
        if ('disabled' in data && typeof data.disabled === 'boolean') {
            nextDisabled = data.disabled;
        } else if ('muted' in data && typeof data.muted === 'boolean') {
            nextDisabled = data.muted;
        } else {
            // BUG-H11 FIX: Neither field present — log warning and skip.
            // Previously defaulted to `false`, silently un-disabling the track.
            console.warn('[TrackDelta] TrackDisabledChanged: neither `disabled` nor `muted` field found — skipping.');
            return true;
        }
        patchTrack(state, delta.data.track_id, { is_disabled: nextDisabled });
        return true;
    }
    if (delta.kind === 'TrackSoloChanged') {
        patchTrack(state, delta.data.track_id, { is_solo: delta.data.soloed });
        return true;
    }
    if (delta.kind === 'TrackArmChanged') {
        const track = getTrackByIndex(state, delta.data.track_index);
        if (!track) return true;
        patchTrack(state, track.id, { is_armed: delta.data.armed });
        return true;
    }
    if (delta.kind === 'TrackRoutingChanged') {
        patchTrack(state, delta.data.track_id, { output: delta.data.output_destination_id ?? 'master' });
        return true;
    }
    if (delta.kind === 'TrackInputChanged') {
        patchTrack(state, delta.data.track_id, { input: delta.data.input_source_id ?? 'none' });
        return true;
    }
    if (delta.kind === 'TrackSamplerSampleChanged') {
        const track = state.tracks.byId[delta.data.track_id];
        if (!track) return true;
        patchTrack(state, delta.data.track_id, {
            sampler: {
                sample_path: delta.data.sample_path,
                root_note: track.sampler?.root_note ?? 60,
                volume: track.sampler?.volume ?? 1,
                attack: track.sampler?.attack ?? 0.01,
                decay: track.sampler?.decay ?? 0.2,
                sustain: track.sampler?.sustain ?? 0.8,
                release: track.sampler?.release ?? 0.3,
                osc2_waveform: track.sampler?.osc2_waveform,
                osc_mix: track.sampler?.osc_mix,
                detune_cents: track.sampler?.detune_cents,
                sub_level: track.sampler?.sub_level,
            },
        });
        return true;
    }
    if (delta.kind === 'SampleRackPadSampleChanged') {
        patchSampleRackPad(state, delta.data.track_id, delta.data.pad_index, {
            sample_path: delta.data.sample_path,
        });
        return true;
    }
    if (delta.kind === 'SampleRackPadVolumeChanged') {
        patchSampleRackPad(state, delta.data.track_id, delta.data.pad_index, {
            volume: delta.data.volume,
        });
        return true;
    }
    if (delta.kind === 'SampleRackPadMuteChanged') {
        patchSampleRackPad(state, delta.data.track_id, delta.data.pad_index, {
            is_disabled: delta.data.muted,
        });
        return true;
    }
    if (delta.kind === 'SampleRackPadSoloChanged') {
        patchSampleRackPad(state, delta.data.track_id, delta.data.pad_index, {
            is_soloed: delta.data.soloed,
        });
        return true;
    }
    if (delta.kind === 'SampleRackPadAdsrChanged') {
        patchSampleRackPad(state, delta.data.track_id, delta.data.pad_index, {
            attack: delta.data.attack,
            decay: delta.data.decay,
            sustain: delta.data.sustain,
            release: delta.data.release,
        });
        return true;
    }
    if (delta.kind === 'SampleRackPadFilterCutoffChanged') {
        patchSampleRackPad(state, delta.data.track_id, delta.data.pad_index, {
            filter_cutoff: delta.data.cutoff,
        });
        return true;
    }
    if (delta.kind === 'TrackRenamed') {
        patchTrack(state, delta.data.track_id, { name: delta.data.new_name });
        return true;
    }
    if (delta.kind === 'TrackColorChanged') {
        patchTrack(state, delta.data.track_id, { color: delta.data.color });
        return true;
    }
    if (delta.kind === 'TrackHeightChanged') {
        patchTrack(state, delta.data.track_id, { height: delta.data.height });
        return true;
    }
    if (delta.kind === 'TrackGroupExpandedChanged') {
        patchTrack(state, delta.data.track_id, { is_expanded: delta.data.expanded });
        return true;
    }
    if (delta.kind === 'TrackFlowSynthConfigChanged') {
        patchTrack(state, delta.data.track_id, { flow_synth: delta.data.config });
        return true;
    }
    if (delta.kind === 'AutomationPointsChanged') {
        const track = state.tracks.byId[delta.data.track_id];
        if (!track) return true;
        const lanePoints = delta.data.points.map((point) => ({
            beat: point.beat,
            value: point.value,
            curve_type: point.curve_type,
            tension: point.tension ?? undefined,
        }));
        const nextLanes = track.automation_lanes.some((lane) => lane.param_id === delta.data.param_id)
            ? track.automation_lanes
                .map((lane) => lane.param_id === delta.data.param_id
                    ? { ...lane, points: lanePoints }
                    : lane)
                .filter((lane) => lane.points.length > 0)
            : (lanePoints.length > 0
                ? [...track.automation_lanes, { param_id: delta.data.param_id, points: lanePoints }]
                : track.automation_lanes);
        const nextPatch: Partial<ProjectTrack> = { automation_lanes: nextLanes };
        const param = (delta.data.param_id ?? '').toLowerCase();
        if (param === 'send.a') {
            nextPatch.send_a = clamp01(delta.data.points.at(-1)?.value ?? 0);
        } else if (param === 'send.b') {
            nextPatch.send_b = clamp01(delta.data.points.at(-1)?.value ?? 0);
        }
        patchTrack(state, delta.data.track_id, nextPatch);
        return true;
    }

    if (delta.kind === 'TrackAdded') {
        const insertIndex = Math.max(0, Math.min(delta.data.track_index, getTrackCount(state)));
        const nextTrack: ProjectTrack = {
            id: delta.data.track_id,
            name: delta.data.name,
            track_type: normalizeTrackType(delta.data.track_type),
            color: colorForTrackIndex(insertIndex),
            volume: 1,
            pan: 0,
            send_a: 0,
            send_b: 0,
            is_disabled: false,
            is_solo: false,
            is_armed: false,
            height: 80,
            output: 'master',
            input: 'none',
            parent_track_id: null,
            child_track_ids: [],
            is_expanded: true,
            effects: [],
            instrument: null,
            sampler: null,
            sample_rack: null,
            automation_lanes: [],
        };
        insertTrackAt(state, insertIndex, nextTrack);

        state.timelineClips = state.timelineClips.map((clip) => (
            clip.trackIndex >= insertIndex ? { ...clip, trackIndex: clip.trackIndex + 1 } : clip
        ));
        const nextClips: typeof state.clipsById = {};
        const nextAllIds: string[] = [];
        for (const clip of state.timelineClips) {
            nextClips[clip.id] = clip;
            nextAllIds.push(clip.id);
        }
        state.clipsById = nextClips;
        // AUDIT FIX: Use typed `state.clips` instead of unsafe `(state as any).clips`.
        // DeltaWorkingState now has proper `clips: EntityState<TimelineClip>` field.
        state.clips = { byId: nextClips, allIds: nextAllIds };
        state.changed = true;
        return true;
    }

    if (delta.kind === 'TrackRemoved') {
        const hintedIndex = delta.data.track_index;
        const hintedTrackId = getTrackIdByIndex(state, hintedIndex);
        const expectedIndex = hintedTrackId === delta.data.track_id
            ? hintedIndex
            : findTrackIndexById(state, delta.data.track_id);
        if (expectedIndex < 0) return true;
        const removeIndex = removeTrackById(state, delta.data.track_id);
        if (removeIndex < 0) return true;

        const nextTimeline = state.timelineClips
            .filter((clip) => clip.trackIndex !== removeIndex)
            .map((clip) => (clip.trackIndex > removeIndex ? { ...clip, trackIndex: clip.trackIndex - 1 } : clip));
        const nextClips: typeof state.clipsById = {};
        const nextAllIds: string[] = [];
        for (const clip of nextTimeline) {
            nextClips[clip.id] = clip;
            nextAllIds.push(clip.id);
        }
        state.timelineClips = nextTimeline;
        state.clipsById = nextClips;
        // AUDIT FIX: Use typed `state.clips` instead of unsafe `(state as any).clips`.
        state.clips = { byId: nextClips, allIds: nextAllIds };
        state.changed = true;
        return true;
    }

    if (delta.kind === 'TrackMoved') {
        const moveResult = moveTrackById(state, delta.data.track_id, delta.data.new_index);
        if (!moveResult) return true;
        const oldIndex = moveResult.oldIndex;
        const newIndex = moveResult.newIndex;
        if (oldIndex === newIndex) return true;

        state.timelineClips = state.timelineClips.map((clip) => {
            if (clip.trackIndex === oldIndex) return { ...clip, trackIndex: newIndex };
            if (oldIndex < newIndex && clip.trackIndex > oldIndex && clip.trackIndex <= newIndex) {
                return { ...clip, trackIndex: clip.trackIndex - 1 };
            }
            if (oldIndex > newIndex && clip.trackIndex >= newIndex && clip.trackIndex < oldIndex) {
                return { ...clip, trackIndex: clip.trackIndex + 1 };
            }
            return clip;
        });
        const nextClips: typeof state.clipsById = {};
        const nextAllIds: string[] = [];
        for (const clip of state.timelineClips) {
            nextClips[clip.id] = clip;
            nextAllIds.push(clip.id);
        }
        state.clipsById = nextClips;
        // AUDIT FIX: Use typed `state.clips` instead of unsafe `(state as any).clips`.
        state.clips = { byId: nextClips, allIds: nextAllIds };
        state.changed = true;
        return true;
    }

    if (delta.kind === 'TrackParentChanged') {
        const track = state.tracks.byId[delta.data.track_id];
        if (!track) return true;
        patchTrack(state, delta.data.track_id, {
            parent_track_id: delta.data.parent_track_id,
            output: delta.data.parent_track_id ?? 'master',
        });
        rebuildChildTrackIds(state);
        return true;
    }

    return false;
}
