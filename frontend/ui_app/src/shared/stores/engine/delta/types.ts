import type { ProjectDelta, TransportState } from '@/shared/api/engine';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { ProjectTrack } from '@/shared/lib/trackAdapter';

export interface EntityState<T> {
    byId: Record<string, T>;
    allIds: string[];
}

export interface DeltaApplyState {
    timelineClips: TimelineClip[];
    clipsById: Record<string, TimelineClip>;
    clips: EntityState<TimelineClip>;
    projectTracks: ProjectTrack[];
    tracksById: Record<string, ProjectTrack>;
    tracks: EntityState<ProjectTrack>;
    projectBpm: number;
    projectSampleRate: number;
    transport: TransportState;
}

export interface SnapshotProjectMeta {
    bpm: number;
    sampleRate: number;
    keySigEnabled: boolean;
    keySigTonic: string;
    keySigMode: string;
    loopEnabled: boolean;
    loopStartFrames: number;
    loopEndFrames: number;
    grid: {
        numerator: number;
        denominator: number;
        ntoles: number;
        snapToGrid: boolean;
        fixed: boolean;
    };
    viewport?: {
        pixelsPerBeat?: number;
        scrollLeft?: number;
    };
}

export interface DeltaApplyResult {
    nextState: Pick<
        DeltaApplyState,
        'timelineClips' | 'clipsById' | 'clips' | 'projectTracks' | 'tracksById' | 'tracks'
    > | null;
    snapshotMeta?: SnapshotProjectMeta | null;
}

export interface DeltaWorkingState {
    timelineClips: TimelineClip[];
    clipsById: Record<string, TimelineClip>;
    projectTracks: ProjectTrack[];
    tracksById: Record<string, ProjectTrack>;
    changed: boolean;
}

export interface DeltaEnv {
    bpm: number;
    sampleRate: number;
    reason: string;
}

export type DeltaHandler = (state: DeltaWorkingState, delta: ProjectDelta, env: DeltaEnv) => boolean;
