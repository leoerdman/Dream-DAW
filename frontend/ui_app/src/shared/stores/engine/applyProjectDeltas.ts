import { frameToBeat, resolveSampleRate } from '@/shared/lib/audioMath';
import { normalizeTimelineClips } from '@/shared/lib/clipNormalization';
import type { ProjectDelta } from '@/shared/api/engine';
import { adaptTrack, resolveTrackColor } from '@/shared/lib/trackAdapter';
import type { Project } from '@bindings/Project';
import { buildTrackStatePatch, toEntityState } from './storeHelpers';
import { applyClipDelta } from './delta/clipDeltaHandlers';
import { applyPluginDelta } from './delta/pluginDeltaHandlers';
import { applyTrackDelta } from './delta/trackDeltaHandlers';
import type {
    DeltaApplyResult,
    DeltaApplyState,
    DeltaWorkingState,
    SnapshotProjectMeta,
} from './delta/types';

export type { DeltaApplyResult, DeltaApplyState } from './delta/types';

function toFiniteNumber(value: unknown, fallback = 0): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    if (typeof value === 'bigint') return Number(value);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function extractSnapshotProjectMeta(
    deltas: ProjectDelta[],
    transport: DeltaApplyState['transport'],
): SnapshotProjectMeta | null {
    const snapshotDelta = deltas.find((delta) => delta.kind === 'ProjectSnapshotReplaced');
    if (!snapshotDelta || !snapshotDelta.data || typeof snapshotDelta.data !== 'object') {
        return null;
    }
    const project = (snapshotDelta.data as { project?: Project }).project;
    if (!project) {
        return null;
    }

    const bpm = toFiniteNumber(project.pulse_map?.tempo_events?.[0]?.bpm, transport.bpm || 120);
    const sampleRate = resolveSampleRate(project.sample_rate, transport.sample_rate);

    const rawViewZoom = toFiniteNumber(
        project.view_zoom_scale ?? project.sequencer_navigator_zoom ?? Number.NaN,
        Number.NaN,
    );
    const rawViewScroll = toFiniteNumber(
        project.view_scroll_position ?? project.sequencer_navigator_scroll_x ?? Number.NaN,
        Number.NaN,
    );
    const rawViewScrollTop = toFiniteNumber(project.sequencer_navigator_scroll_y ?? Number.NaN, Number.NaN);
    const hasViewport = Number.isFinite(rawViewZoom) || Number.isFinite(rawViewScroll) || Number.isFinite(rawViewScrollTop);
    const viewportPixelsPerBeat = Number.isFinite(rawViewZoom)
        ? Math.max(0.5, Math.min(2000, rawViewZoom))
        : undefined;
    const viewportScrollLeft = Number.isFinite(rawViewScroll)
        ? Math.max(0, rawViewScroll)
        : undefined;
    const viewportScrollTop = Number.isFinite(rawViewScrollTop)
        ? Math.max(0, rawViewScrollTop)
        : undefined;

    return {
        bpm,
        sampleRate,
        keySigEnabled: Boolean(project.key_sig_enabled ?? false),
        keySigTonic: String(project.key_sig_tonic ?? 'C'),
        keySigMode: String(project.key_sig_mode ?? 'Major'),
        loopEnabled: Boolean(project.is_looping ?? false),
        loopStartFrames: Math.max(0, toFiniteNumber(project.loop_start_frames ?? 0, 0)),
        loopEndFrames: Math.max(0, toFiniteNumber(project.loop_end_frames ?? 0, 0)),
        grid: {
            numerator: Math.max(1, toFiniteNumber(project.arrangement_grid_numerator ?? 1, 1)),
            denominator: Math.max(1, toFiniteNumber(project.arrangement_grid_denominator ?? 16, 16)),
            ntoles: Math.max(1, toFiniteNumber(project.arrangement_grid_ntoles ?? 1, 1)),
            snapToGrid: Boolean(project.arrangement_snap_to_grid ?? true),
            fixed: Boolean(project.arrangement_grid_fixed ?? false),
        },
        viewport: hasViewport
            ? {
                pixelsPerBeat: viewportPixelsPerBeat,
                scrollLeft: viewportScrollLeft,
                scrollTop: viewportScrollTop,
            }
            : undefined,
    };
}

export function applyProjectDeltasToState(
    state: DeltaApplyState,
    deltas: ProjectDelta[],
    reason: string,
): DeltaApplyResult {
    const snapshotDelta = deltas.find((delta) => delta.kind === 'ProjectSnapshotReplaced');
    if (snapshotDelta && snapshotDelta.data && typeof snapshotDelta.data === 'object') {
        const project = (snapshotDelta.data as { project?: Project }).project;

        if (project && Array.isArray(project.tracks)) {
            const bpm = project.pulse_map?.tempo_events?.[0]?.bpm || state.transport.bpm || 120;
            const sampleRate = resolveSampleRate(project.sample_rate, state.transport.sample_rate);
            const timelineClips: DeltaApplyState['timelineClips'] = [];
            const snapshotTrackIds: string[] = [];
            const snapshotTracksById: DeltaApplyState['tracksById'] = {};

            for (let trackIdx = 0; trackIdx < project.tracks.length; trackIdx++) {
                const track = project.tracks[trackIdx];
                const adapted = adaptTrack(track as Parameters<typeof adaptTrack>[0]);
                snapshotTrackIds.push(adapted.id);
                snapshotTracksById[adapted.id] = adapted;
                const trackColor = adapted.color;
                const isMidiTrack = adapted.track_type.toLowerCase() === 'midi';

                for (const clip of track.clips ?? []) {
                    const posFrames = toFiniteNumber(clip.position?.sample_frame, 0);
                    const durFrames = Math.max(1, toFiniteNumber(clip.duration?.sample_frame, 1));
                    const clipColor = resolveTrackColor(clip.color_hex ?? clip.color_override);
                    const hasClipColorOverride = Boolean(clip.color_hex ?? clip.color_override);
                    const hasAudioPath = !!(clip.file_path && clip.file_path.trim().length > 0);
                    timelineClips.push({
                        id: clip.id,
                        name: clip.name,
                        trackIndex: trackIdx,
                        startBeat: frameToBeat(posFrames, bpm, sampleRate),
                        durationBeats: frameToBeat(durFrames, bpm, sampleRate),
                        type: isMidiTrack ? 'midi' : 'audio',
                        color: hasClipColorOverride ? clipColor : trackColor,
                        filePath: isMidiTrack ? undefined : clip.file_path,
                        durationSamples: durFrames,
                        isWarped: Boolean(clip.is_warped ?? false),
                        warpMode: clip.warp_mode ?? null,
                        warpBaseBpm: Math.max(20, toFiniteNumber(clip.warp_base_bpm, bpm)),
                        warpSourceDurationFrames: Math.max(1, toFiniteNumber(clip.warp_source_duration_frames, durFrames)),
                        sourceOffset: Math.max(0, toFiniteNumber(clip.source_offset?.sample_frame ?? 0, 0)),
                        fadeIn: Math.max(0, toFiniteNumber(clip.fade_in_frames ?? 0, 0)),
                        fadeOut: Math.max(0, toFiniteNumber(clip.fade_out_frames ?? 0, 0)),
                        isOffline: isMidiTrack ? false : (hasAudioPath ? (clip.is_offline ?? false) : false),
                        muted: Boolean(clip.is_muted ?? false),
                    });
                }

                for (const clip of track.midi_clips ?? []) {
                    const posFrames = toFiniteNumber(clip.position?.sample_frame, 0);
                    const durFrames = Math.max(1, toFiniteNumber(clip.duration?.sample_frame, 1));
                    const midiClipColor = resolveTrackColor(clip.color_hex ?? clip.color_override);
                    const hasMidiClipColorOverride = Boolean(clip.color_hex ?? clip.color_override);
                    timelineClips.push({
                        id: clip.id,
                        name: clip.name,
                        trackIndex: trackIdx,
                        startBeat: frameToBeat(posFrames, bpm, sampleRate),
                        durationBeats: frameToBeat(durFrames, bpm, sampleRate),
                        type: 'midi',
                        color: hasMidiClipColorOverride ? midiClipColor : trackColor,
                        durationSamples: durFrames,
                        sourceOffset: 0,
                        fadeIn: Math.max(0, toFiniteNumber(clip.fade_in_frames ?? 0, 0)),
                        fadeOut: Math.max(0, toFiniteNumber(clip.fade_out_frames ?? 0, 0)),
                        muted: Boolean(clip.is_muted ?? false),
                        midiNotes: (clip.notes ?? []).map((note, idx) => ({
                            id: `${clip.id}:${idx}:${note.pitch}:${note.start_frame}`,
                            pitch: note.pitch,
                            startBeat: frameToBeat(toFiniteNumber(note.start_frame, 0), bpm, sampleRate),
                            durationBeats: frameToBeat(toFiniteNumber(note.duration_frames, 1), bpm, sampleRate),
                            velocity: note.velocity,
                        })),
                        midiEnvelopes: [],
                    });
                }
            }

            const snapshotMeta = extractSnapshotProjectMeta(deltas, state.transport);
            const snapshotTrackState = buildTrackStatePatch(
                snapshotTrackIds,
                snapshotTracksById,
            );
            const sanitizedTimelineClips = normalizeTimelineClips(timelineClips);

            return {
                nextState: {
                    timelineClips: sanitizedTimelineClips,
                    clipsById: Object.fromEntries(sanitizedTimelineClips.map((clip) => [clip.id, clip])),
                    clips: toEntityState(sanitizedTimelineClips),
                    ...snapshotTrackState,
                },
                snapshotMeta,
            };
        }
    }

    const bpm = state.projectBpm || state.transport.bpm || 120;
    const sampleRate = resolveSampleRate(state.projectSampleRate, state.transport.sample_rate);

    const working: DeltaWorkingState = {
        timelineClips: state.timelineClips,
        clipsById: state.clipsById,
        projectTracks: state.tracks.allIds
            .map((trackId) => state.tracks.byId[trackId] ?? state.tracksById[trackId])
            .filter((track): track is NonNullable<typeof track> => Boolean(track)),
        tracksById: state.tracksById,
        changed: false,
    };

    for (const delta of deltas) {
        const handledByClip = applyClipDelta(working, delta, { bpm, sampleRate, reason });
        if (handledByClip) {
            continue;
        }

        const handledByTrack = applyTrackDelta(working, delta, { bpm, sampleRate, reason });
        if (handledByTrack) {
            continue;
        }

        const handledByPlugin = applyPluginDelta(working, delta, { bpm, sampleRate, reason });
        if (handledByPlugin) {
            continue;
        }
        // Delta kind intentionally ignored by local reducer. Keep state stable
        // and avoid forcing heavyweight full-project refreshes.
        console.warn(`[Delta] Unhandled delta ignored (${reason}): ${delta.kind}`);
    }

    if (!working.changed) {
        return { nextState: null, snapshotMeta: null };
    }
    const sanitizedTimelineClips = normalizeTimelineClips(working.timelineClips);
    const nextTrackState = buildTrackStatePatch(
        working.projectTracks.map((track) => track.id),
        working.tracksById,
    );

    return {
        nextState: {
            timelineClips: sanitizedTimelineClips,
            clipsById: Object.fromEntries(sanitizedTimelineClips.map((clip) => [clip.id, clip])),
            clips: toEntityState(sanitizedTimelineClips),
            ...nextTrackState,
        },
        snapshotMeta: null,
    };
}
