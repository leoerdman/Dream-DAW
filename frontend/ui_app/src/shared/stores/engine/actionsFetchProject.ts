import type { StoreApi } from 'zustand';
import * as engine from '@/shared/api/engine';
import { frameToBeat, resolveSampleRate } from '@/shared/lib/audioMath';
import { adaptTrack, resolveTrackColor } from '@/shared/lib/trackAdapter';
import { useGridStore } from '@/shared/stores/useGridStore';
import { DEBUG_PROJECT_FETCH, mergeProjectHistory, toEntityState } from '@/shared/stores/engine/storeHelpers';
import type { EngineStore } from '@/shared/stores/useEngineStore';

let projectFetchSeq = 0;
let isFetchingProject = false;

type ProjectClipSnapshot = {
    id: string;
    name: string;
    file_path: string;
    position: { sample_frame: number };
    duration: { sample_frame: number };
    source_offset?: { sample_frame: number };
    is_warped?: boolean;
    warp_mode?: number | null;
    warp_base_bpm?: number;
    warp_source_duration_frames?: number;
    color_override?: unknown;
    color_hex?: string | null;
    is_offline?: boolean;
    is_muted?: boolean;
    fade_in_frames?: number;
    fade_out_frames?: number;
};

type MidiNoteSnapshot = {
    pitch: number;
    velocity: number;
    start_frame: number;
    duration_frames: number;
};

type MidiClipSnapshot = {
    id: string;
    name: string;
    position: { sample_frame: number };
    duration: { sample_frame: number };
    notes?: MidiNoteSnapshot[];
    color_override?: unknown;
    color_hex?: string | null;
    is_muted?: boolean;
    fade_in_frames?: number;
    fade_out_frames?: number;
};

type ProjectTrackSnapshot = {
    id: string;
    name: string;
    track_type: string;
    clips: ProjectClipSnapshot[];
    midi_clips?: MidiClipSnapshot[];
};

type ProjectSnapshot = {
    tracks: ProjectTrackSnapshot[];
    pulse_map?: { tempo_events?: Array<{ bpm: number }> };
    sample_rate: number;
    arrangement_grid_numerator?: number;
    arrangement_grid_denominator?: number;
    arrangement_grid_ntoles?: number;
    arrangement_snap_to_grid?: boolean;
    arrangement_grid_fixed?: boolean;
    key_sig_enabled?: boolean;
    key_sig_tonic?: string;
    key_sig_mode?: string;
};

const toFiniteNumber = (value: unknown, fallback = 0): number => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    if (typeof value === 'bigint') return Number(value);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

export function createFetchProjectAction(
    set: StoreApi<EngineStore>['setState'],
    get: StoreApi<EngineStore>['getState'],
): Pick<EngineStore, 'fetchProject' | 'syncProjectHistory'> {
    return {
        fetchProject: async (reason: string = 'manual') => {
            if (isFetchingProject) return;
            isFetchingProject = true;
            const requestSeq = ++projectFetchSeq;
            try {
                const historyCursor = get().projectHistoryCursor;
                const [project, projectHistoryDelta] = await Promise.all([
                    engine.getProject() as Promise<ProjectSnapshot>,
                    engine.getProjectHistory({ limit: 256, sinceSeq: historyCursor > 0 ? historyCursor : undefined }),
                ]);
                if (requestSeq !== projectFetchSeq) return;

                const bpm = project.pulse_map?.tempo_events?.[0]?.bpm || get().transport.bpm || 120;
                const sr = resolveSampleRate(project.sample_rate, get().transport.sample_rate);

                useGridStore.getState().applyProjectGrid({
                    numerator: project.arrangement_grid_numerator ?? 1,
                    denominator: project.arrangement_grid_denominator ?? 16,
                    ntoles: project.arrangement_grid_ntoles ?? 2,
                    snapToGrid: project.arrangement_snap_to_grid ?? true,
                    fixed: project.arrangement_grid_fixed ?? false,
                });

                const timelineClips = [] as EngineStore['timelineClips'];
                const projectTracks = [] as EngineStore['projectTracks'];
                for (let trackIdx = 0; trackIdx < project.tracks.length; trackIdx++) {
                    const track = project.tracks[trackIdx];
                    const adapted = adaptTrack(track as Parameters<typeof adaptTrack>[0]);
                    projectTracks.push(adapted);
                    const trackColor = adapted.color;
                    const isMidiTrack = adapted.track_type.toLowerCase() === 'midi';

                    for (const clip of track.clips) {
                        const posFrames = toFiniteNumber(clip.position.sample_frame, 0);
                        const durFrames = Math.max(1, toFiniteNumber(clip.duration.sample_frame, 1));
                        const clipColor = resolveTrackColor(clip.color_hex ?? clip.color_override);
                        timelineClips.push({
                            id: clip.id,
                            name: clip.name,
                            trackIndex: trackIdx,
                            startBeat: frameToBeat(posFrames, bpm, sr),
                            durationBeats: frameToBeat(durFrames, bpm, sr),
                            type: isMidiTrack ? 'midi' : 'audio',
                            color: clipColor !== '#667788' ? clipColor : trackColor,
                            filePath: isMidiTrack ? undefined : clip.file_path,
                            durationSamples: durFrames,
                            isWarped: Boolean(clip.is_warped ?? false),
                            warpMode: clip.warp_mode ?? null,
                            warpBaseBpm: Math.max(20, toFiniteNumber(clip.warp_base_bpm, bpm)),
                            warpSourceDurationFrames: Math.max(1, toFiniteNumber(clip.warp_source_duration_frames, durFrames)),
                            sourceOffset: Math.max(0, toFiniteNumber(clip.source_offset?.sample_frame ?? 0, 0)),
                            fadeIn: Math.max(0, toFiniteNumber((clip as Record<string, unknown>).fade_in_frames ?? 0, 0)),
                            fadeOut: Math.max(0, toFiniteNumber((clip as Record<string, unknown>).fade_out_frames ?? 0, 0)),
                            isOffline: isMidiTrack ? false : (clip.file_path?.trim().length ? (clip.is_offline ?? false) : false),
                            muted: Boolean((clip as Record<string, unknown>).is_muted ?? false),
                        });
                    }

                    for (const clip of track.midi_clips ?? []) {
                        const posFrames = toFiniteNumber(clip.position.sample_frame, 0);
                        const durFrames = Math.max(1, toFiniteNumber(clip.duration.sample_frame, 1));
                        const midiClipColor = resolveTrackColor(clip.color_hex ?? clip.color_override);
                        timelineClips.push({
                            id: clip.id,
                            name: clip.name,
                            trackIndex: trackIdx,
                            startBeat: frameToBeat(posFrames, bpm, sr),
                            durationBeats: frameToBeat(durFrames, bpm, sr),
                            type: 'midi',
                            color: midiClipColor !== '#667788' ? midiClipColor : trackColor,
                            durationSamples: durFrames,
                            sourceOffset: 0,
                            fadeIn: Math.max(0, toFiniteNumber((clip as Record<string, unknown>).fade_in_frames ?? 0, 0)),
                            fadeOut: Math.max(0, toFiniteNumber((clip as Record<string, unknown>).fade_out_frames ?? 0, 0)),
                            muted: Boolean((clip as Record<string, unknown>).is_muted ?? false),
                            midiNotes: (clip.notes ?? []).map((note: MidiNoteSnapshot, idx: number) => ({
                                id: `${clip.id}:${idx}:${note.pitch}:${note.start_frame}`,
                                pitch: note.pitch,
                                startBeat: frameToBeat(note.start_frame, bpm, sr),
                                durationBeats: frameToBeat(note.duration_frames, bpm, sr),
                                velocity: note.velocity,
                            })),
                            midiEnvelopes: [],
                        });
                    }
                }

                if (requestSeq === projectFetchSeq) {
                    set((s) => {
                        const tracks = toEntityState(projectTracks);
                        const clips = toEntityState(timelineClips);
                        const merged = mergeProjectHistory(s.projectHistory, s.projectHistoryCursor, projectHistoryDelta);
                        return {
                            projectHistory: merged.history,
                            projectHistoryCursor: merged.cursor,
                            timelineClips,
                            projectTracks,
                            tracksById: tracks.byId,
                            tracks,
                            clipsById: clips.byId,
                            clips,
                            projectSampleRate: sr,
                            projectBpm: bpm,
                            keySigEnabled: project.key_sig_enabled ?? false,
                            keySigTonic: project.key_sig_tonic || 'C',
                            keySigMode: project.key_sig_mode || 'Major',
                            transport: { ...s.transport, bpm },
                        };
                    });
                    if (DEBUG_PROJECT_FETCH) {
                        console.debug(`[ProjectFetch] apply #${requestSeq} reason=${reason} tracks=${projectTracks.length} clips=${timelineClips.length} bpm=${bpm}`);
                    }
                }
            } catch (e) {
                console.error('[Engine] fetchProject failed:', e);
            } finally {
                isFetchingProject = false;
            }
        },

        syncProjectHistory: async () => {
            try {
                const cursor = get().projectHistoryCursor;
                const delta = await engine.getProjectHistory({ limit: 256, sinceSeq: cursor > 0 ? cursor : undefined });
                if (delta.length === 0) return;
                set((s) => {
                    const merged = mergeProjectHistory(s.projectHistory, s.projectHistoryCursor, delta);
                    return { projectHistory: merged.history, projectHistoryCursor: merged.cursor };
                });
            } catch (e) {
                console.warn('[Engine] syncProjectHistory failed:', e);
            }
        },
    };
}
