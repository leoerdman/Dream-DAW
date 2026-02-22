import type { ProjectDelta } from '@/shared/api/engine';
import type { ProjectTrack } from '@/shared/lib/trackAdapter';
import type { DeltaEnv, DeltaWorkingState } from './types';
import { colorForTrackIndex, normalizeTrackType } from './trackDeltaUtils';

function patchTrack(state: DeltaWorkingState, id: string, patch: Partial<ProjectTrack>): void {
    const track = state.tracksById[id];
    if (!track) return;
    const next = { ...track, ...patch };
    state.projectTracks = state.projectTracks.map((t) => (t.id === id ? next : t));
    state.tracksById = { ...state.tracksById, [id]: next };
    state.changed = true;
}

function rebuildChildTrackIds(state: DeltaWorkingState): void {
    const childrenByParent: Record<string, string[]> = {};
    for (const track of state.projectTracks) {
        const parentId = track.parent_track_id ?? null;
        if (!parentId) continue;
        if (!childrenByParent[parentId]) childrenByParent[parentId] = [];
        childrenByParent[parentId].push(track.id);
    }

    const nextTracks = state.projectTracks.map((track) => ({
        ...track,
        child_track_ids: childrenByParent[track.id] ?? [],
    }));
    state.projectTracks = nextTracks;
    state.tracksById = Object.fromEntries(nextTracks.map((track) => [track.id, track]));
    state.changed = true;
}

function patchSampleRackPad(
    state: DeltaWorkingState,
    trackId: string,
    padIndex: number,
    patch: Record<string, unknown>,
): boolean {
    const track = state.tracksById[trackId];
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

export function applyTrackDelta(state: DeltaWorkingState, delta: ProjectDelta, _env: DeltaEnv): boolean {
    if (delta.kind === 'TrackVolumeChanged') {
        patchTrack(state, delta.data.track_id, { volume: delta.data.volume });
        return true;
    }
    if (delta.kind === 'TrackPanChanged') {
        patchTrack(state, delta.data.track_id, { pan: delta.data.pan });
        return true;
    }
    if (delta.kind === 'TrackMuteChanged') {
        patchTrack(state, delta.data.track_id, { is_mute: delta.data.muted });
        return true;
    }
    if (delta.kind === 'TrackSoloChanged') {
        patchTrack(state, delta.data.track_id, { is_solo: delta.data.soloed });
        return true;
    }
    if (delta.kind === 'TrackArmChanged') {
        const track = state.projectTracks[delta.data.track_index];
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
        const track = state.tracksById[delta.data.track_id];
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
            is_muted: delta.data.muted,
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
    if (delta.kind === 'AutomationPointsChanged') {
        const track = state.tracksById[delta.data.track_id];
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
        patchTrack(state, delta.data.track_id, { automation_lanes: nextLanes });
        return true;
    }

    if (delta.kind === 'TrackAdded') {
        const insertIndex = Math.max(0, Math.min(delta.data.track_index, state.projectTracks.length));
        const nextTrack: ProjectTrack = {
            id: delta.data.track_id,
            name: delta.data.name,
            track_type: normalizeTrackType(delta.data.track_type),
            color: colorForTrackIndex(insertIndex),
            volume: 1,
            pan: 0,
            is_mute: false,
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
        const tracks = state.projectTracks.slice();
        tracks.splice(insertIndex, 0, nextTrack);
        state.projectTracks = tracks;
        state.tracksById = { ...state.tracksById, [nextTrack.id]: nextTrack };

        state.timelineClips = state.timelineClips.map((clip) => (
            clip.trackIndex >= insertIndex ? { ...clip, trackIndex: clip.trackIndex + 1 } : clip
        ));
        const nextClips: typeof state.clipsById = {};
        for (const clip of state.timelineClips) nextClips[clip.id] = clip;
        state.clipsById = nextClips;
        state.changed = true;
        return true;
    }

    if (delta.kind === 'TrackRemoved') {
        const hintedIndex = delta.data.track_index;
        const removeIndex = (hintedIndex >= 0
            && hintedIndex < state.projectTracks.length
            && state.projectTracks[hintedIndex]?.id === delta.data.track_id)
            ? hintedIndex
            : state.projectTracks.findIndex((t) => t.id === delta.data.track_id);
        if (removeIndex < 0) return true;
        state.projectTracks = state.projectTracks.filter((_, i) => i !== removeIndex);
        const nextTracks = { ...state.tracksById };
        delete nextTracks[delta.data.track_id];
        state.tracksById = nextTracks;

        const nextTimeline = state.timelineClips
            .filter((clip) => clip.trackIndex !== removeIndex)
            .map((clip) => (clip.trackIndex > removeIndex ? { ...clip, trackIndex: clip.trackIndex - 1 } : clip));
        const nextClips: typeof state.clipsById = {};
        for (const clip of nextTimeline) nextClips[clip.id] = clip;
        state.timelineClips = nextTimeline;
        state.clipsById = nextClips;
        state.changed = true;
        return true;
    }

    if (delta.kind === 'TrackMoved') {
        const tracksLen = state.projectTracks.length;
        if (tracksLen === 0) return true;
        const hintedOld = delta.data.old_index;
        const oldIndex = (hintedOld >= 0
            && hintedOld < tracksLen
            && state.projectTracks[hintedOld]?.id === delta.data.track_id)
            ? hintedOld
            : state.projectTracks.findIndex((t) => t.id === delta.data.track_id);
        if (oldIndex < 0) return true;
        const newIndex = Math.max(0, Math.min(delta.data.new_index, tracksLen - 1));
        if (oldIndex === newIndex) return true;

        const tracks = state.projectTracks.slice();
        const [moved] = tracks.splice(oldIndex, 1);
        tracks.splice(newIndex, 0, moved);
        state.projectTracks = tracks;

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
        for (const clip of state.timelineClips) nextClips[clip.id] = clip;
        state.clipsById = nextClips;
        state.changed = true;
        return true;
    }

    if (delta.kind === 'TrackParentChanged') {
        const track = state.tracksById[delta.data.track_id];
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
