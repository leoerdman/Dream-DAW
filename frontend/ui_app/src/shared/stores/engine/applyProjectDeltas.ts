import { frameToBeat, resolveBpm, resolveSampleRate, clampTimeSigNumerator, clampTimeSigDenominator, DEFAULT_TIME_SIG_NUMERATOR, DEFAULT_TIME_SIG_DENOMINATOR } from '@/shared/lib/audioMath';
import { normalizeTimelineClips } from '@/shared/lib/clipNormalization';
import type { ProjectDelta } from '@/shared/api/engine';
import { adaptTrack, resolveTrackColor } from '@/shared/lib/trackAdapter';
import type { Project } from '@bindings/Project';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import { buildTrackStatePatch as storeHelpersBuildTrackStatePatch, toEntityState } from './storeHelpers';
import { applyClipDelta } from './delta/clipDeltaHandlers';
import { applyPluginDelta } from './delta/pluginDeltaHandlers';
import { applyTrackDelta } from './delta/trackDeltaHandlers';
// Track control cache reset for project-level operations.
import { clearTrackControlCaches } from './actionsTrackProjectThrottle';
import type {
    DeltaApplyResult,
    DeltaApplyState,
    DeltaWorkingState,
    SnapshotProjectMeta,
} from './delta/types';
import type { TrackStatePatch } from './storeHelpers';
import type { ProjectTrack } from '../useEngineStore';

export type { DeltaApplyResult, DeltaApplyState } from './delta/types';

function toFiniteNumber(value: unknown, fallback = 0): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    if (typeof value === 'bigint') return Number(value);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeMidiNoteStartFrame(
    rawStartFrame: number,
    clipStartFrame: number,
    clipDurationFrame: number,
): number {
    // BUG-011 FIX: Removed `clipStartFrame > 0` guard that skipped note
    // remapping for clips at position 0. The >= checks below correctly
    // handle all positions including 0.
    const clipAbsEnd = clipStartFrame + clipDurationFrame;
    if (rawStartFrame >= clipAbsEnd && rawStartFrame >= clipStartFrame) {
        return Math.max(0, rawStartFrame - clipStartFrame);
    }
    return Math.max(0, rawStartFrame);
}

function buildTrackStatePatch(
    state: DeltaApplyState | DeltaWorkingState,
): TrackStatePatch<ProjectTrack> {
    const byId = state.tracks.byId;
    const allIds = state.tracks.allIds.length > 0
        ? state.tracks.allIds
        : (() => {
            // BUG-A010 FIX: Log when fallback triggers — indicates EntityState desync.
            console.warn('[Delta] buildTrackStatePatch: allIds empty, falling back to Object.keys(byId). Track order may be incorrect.');
            return Object.keys(byId);
        })();

    return storeHelpersBuildTrackStatePatch(allIds, byId);
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

    const bpm = toFiniteNumber(project.pulse_map?.tempo_events?.[0]?.bpm, resolveBpm(transport.bpm));
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
    // BUG-096: Increased max from 2000 to 5000 for detailed MIDI editing.
    const viewportPixelsPerBeat = Number.isFinite(rawViewZoom)
        ? Math.max(0.5, Math.min(5000, rawViewZoom))
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
        timeSigNumerator: clampTimeSigNumerator(toFiniteNumber(project.time_signature?.numerator ?? DEFAULT_TIME_SIG_NUMERATOR, DEFAULT_TIME_SIG_NUMERATOR)),
        timeSigDenominator: clampTimeSigDenominator(toFiniteNumber(project.time_signature?.denominator ?? DEFAULT_TIME_SIG_DENOMINATOR, DEFAULT_TIME_SIG_DENOMINATOR)),
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

        // BUG-009/010 FIX: Clear track control caches that survive project reloads.
        // NOTE: We do NOT call resetTelemetryModuleState() here — that kills all
        // telemetry listeners (transport position, meters, plugin sandbox), which
        // freezes the playhead cursor. Telemetry reset belongs only in full
        // project-switch paths (SplashScreen / explicit project open).
        clearTrackControlCaches();

        if (project && Array.isArray(project.tracks)) {
            const bpm = Math.max(1, project.pulse_map?.tempo_events?.[0]?.bpm ?? resolveBpm(state.transport.bpm));
            // ENTERPRISE FIX: Prefer PulseMap's sample_rate for consistency with backend
            // PulseMap.beats() which uses pulse_map.sample_rate for frame→beat conversion.
            const sampleRate = resolveSampleRate(
                project.pulse_map?.sample_rate ?? project.sample_rate,
                state.transport.sample_rate,
            );
            const snapshotClips: TimelineClip[] = [];
            const snapshotTrackIds: string[] = [];
            const snapshotTracksById: Record<string, ProjectTrack> = {};

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
                    snapshotClips.push({
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
                        // BUG-098: Allow ambient/drone content with very slow tempos.
                        warpBaseBpm: Math.max(1, toFiniteNumber(clip.warp_base_bpm, bpm)),
                        warpSourceDurationFrames: Math.max(1, toFiniteNumber(clip.warp_source_duration_frames, durFrames)),
                        sourceOffset: Math.max(0, toFiniteNumber(clip.source_offset?.sample_frame ?? 0, 0)),
                        // BUG-TRIM-05 FIX: Include pitchShiftSemitones from snapshot.
                        // Previously missing — after EVERY operation (resize/split/move/merge)
                        // that triggers ProjectSnapshotReplaced, pitch shift was silently lost,
                        // causing _drawWaveform to use pitchMultiplier=1.0 (wrong sourceWindowSamples).
                        pitchShiftSemitones: toFiniteNumber(clip.pitch_shift_semitones ?? 0, 0),
                        fadeIn: Math.max(0, toFiniteNumber(clip.fade_in_frames ?? 0, 0)),
                        fadeOut: Math.max(0, toFiniteNumber(clip.fade_out_frames ?? 0, 0)),
                        // BUG-TRIM-06 FIX: Include fade curve shapes from snapshot.
                        // Rust AudioClip stores fade_in_curve_slope / fade_out_curve_slope.
                        // The frontend uses a single `fadeInCurve` / `fadeOutCurve` number
                        // where 0.5 = linear, <0.5 = logarithmic, >0.5 = exponential.
                        // Map slope (-1..1) to curve (0..1) for the rendering pipeline.
                        fadeInCurve: 0.5 + toFiniteNumber(clip.fade_in_curve_slope ?? 0, 0) * 0.5,
                        fadeOutCurve: 0.5 + toFiniteNumber(clip.fade_out_curve_slope ?? 0, 0) * 0.5,
                        isOffline: isMidiTrack ? false : Boolean(clip.is_offline ?? false),
                        muted: Boolean(clip.is_disabled ?? false),
                    });
                }

                for (const clip of track.midi_clips ?? []) {
                    const posFrames = toFiniteNumber(clip.position?.sample_frame, 0);
                    const durFrames = Math.max(1, toFiniteNumber(clip.duration?.sample_frame, 1));
                    const midiClipColor = resolveTrackColor(clip.color_hex ?? clip.color_override);
                    const hasMidiClipColorOverride = Boolean(clip.color_hex ?? clip.color_override);
                    snapshotClips.push({
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
                        muted: Boolean(clip.is_disabled ?? false),
                        midiNotes: (clip.notes ?? []).map((note, idx) => {
                            const rawStartFrame = toFiniteNumber(note.start_frame, 0);
                            const localStartFrame = normalizeMidiNoteStartFrame(rawStartFrame, posFrames, durFrames);
                            return {
                                id: `${clip.id}:${idx}:${note.pitch}:${localStartFrame}`,
                                pitch: note.pitch,
                                startBeat: frameToBeat(localStartFrame, bpm, sampleRate),
                                durationBeats: frameToBeat(Math.max(1, toFiniteNumber(note.duration_frames, 1)), bpm, sampleRate),
                                velocity: note.velocity,
                            };
                        }),
                        midiEnvelopes: [],
                    });
                }
            }

            const snapshotMeta = extractSnapshotProjectMeta(deltas, state.transport);
            const snapshotTrackState = storeHelpersBuildTrackStatePatch<ProjectTrack>(
                snapshotTrackIds,
                snapshotTracksById,
            );
            const sanitizedTimelineClips = normalizeTimelineClips(snapshotClips) as TimelineClip[];

            return {
                nextState: {
                    clips: toEntityState(sanitizedTimelineClips),
                    ...snapshotTrackState,
                },
                snapshotMeta,
                unhandledDeltaKinds: [],
            };
        }
    }

    const bpm = resolveBpm(state.transport.bpm);
    const sampleRate = resolveSampleRate(state.projectSampleRate, state.transport.sample_rate);

    const canonicalTracks = buildTrackStatePatch(state).tracks;
    // BUG-FIX: Zustand freezes state objects. Delta handlers mutate working
    // state in-place (e.g. `state.clips.byId[id] = clip`), so we MUST
    // create shallow clones here to avoid "Attempted to assign to readonly
    // property" TypeError crashes.
    const working: DeltaWorkingState = {
        // BUG-036 FIX: Initialize clips EntityState — enables typed updates in ClipsMerged handler.
        clips: { byId: { ...state.clips.byId }, allIds: [...state.clips.allIds] },
        projectTracks: canonicalTracks.allIds
            .map((trackId) => canonicalTracks.byId[trackId])
            .filter((track): track is NonNullable<typeof track> => Boolean(track)),
        tracks: {
            byId: { ...canonicalTracks.byId },
            allIds: [...canonicalTracks.allIds],
        },
        changed: false,
    };
    const unhandledDeltaKinds: string[] = [];

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

        // ── Transport/Project deltas ─────────────────────────────────────
        // These are always accompanied by a ProjectSnapshotReplaced delta
        // which handles the full state update. We acknowledge them here to
        // prevent noisy "Unhandled delta" console warnings.
        if (
            delta.kind === 'TempoChanged' ||
            delta.kind === 'TimeSignatureChanged' ||
            delta.kind === 'ArrangementGridChanged' ||
            delta.kind === 'KeySignatureChanged' ||
            delta.kind === 'ProjectRenamed' ||
            delta.kind === 'LoopRegionChanged'
        ) {
            // Handled via snapshot — no pointwise state mutation needed.
            continue;
        }

        // Delta kind intentionally ignored by local reducer. Keep state stable
        // but report unhandled kinds so caller can recover via snapshot delta.
        unhandledDeltaKinds.push(delta.kind);
        console.warn(`[Delta] Unhandled delta (${reason}): ${delta.kind}`);
    }

    if (!working.changed) {
        return { nextState: null, snapshotMeta: null, unhandledDeltaKinds };
    }
    const sanitizedTimelineClips = normalizeTimelineClips(working.clips.allIds.map(id => working.clips.byId[id])) as TimelineClip[];
    const nextTrackState = storeHelpersBuildTrackStatePatch<ProjectTrack>(
        working.tracks.allIds,
        working.tracks.byId,
    );

    return {
        nextState: {
            clips: toEntityState(sanitizedTimelineClips),
            ...nextTrackState,
        },
        snapshotMeta: null,
        unhandledDeltaKinds,
    };
}
