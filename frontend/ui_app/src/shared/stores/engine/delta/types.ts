import type { ProjectDelta, TransportState } from '@/shared/api/engine';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { ProjectTrack } from '@/shared/lib/trackAdapter';

export interface EntityState<T> {
    byId: Record<string, T>;
    allIds: string[];
}

export interface DeltaApplyState {
    clips: EntityState<TimelineClip>;
    tracks: EntityState<ProjectTrack>;
    projectBpm: number;
    projectSampleRate: number;
    transport: TransportState;
}

export interface SnapshotProjectMeta {
    bpm: number;
    sampleRate: number;
    timeSigNumerator: number;
    timeSigDenominator: number;
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
        scrollTop?: number;
    };
}

export interface DeltaApplyResult {
    nextState: Pick<
        DeltaApplyState,
        'clips' | 'tracks'
    > | null;
    snapshotMeta?: SnapshotProjectMeta | null;
    unhandledDeltaKinds?: string[];
}

export interface DeltaWorkingState {
    /** BUG-036 FIX: Explicit clips EntityState — previously required unsafe `(state as any).clips` cast. */
    clips: EntityState<TimelineClip>;
    projectTracks: ProjectTrack[];
    tracks: EntityState<ProjectTrack>;
    changed: boolean;
}

export interface DeltaEnv {
    bpm: number;
    sampleRate: number;
    reason: string;
}

export type DeltaHandler = (state: DeltaWorkingState, delta: ProjectDelta, env: DeltaEnv) => boolean;
