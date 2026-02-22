import type { ProjectDelta, TransportState } from '@/shared/api/engine';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { ProjectTrack } from '@/shared/lib/trackAdapter';

export interface DeltaApplyState {
    timelineClips: TimelineClip[];
    clipsById: Record<string, TimelineClip>;
    projectTracks: ProjectTrack[];
    tracksById: Record<string, ProjectTrack>;
    projectBpm: number;
    projectSampleRate: number;
    transport: TransportState;
}

export interface DeltaApplyResult {
    nextState: Pick<DeltaApplyState, 'timelineClips' | 'clipsById' | 'projectTracks' | 'tracksById'> | null;
    fallbackReason: string | null;
}

export interface DeltaWorkingState {
    timelineClips: TimelineClip[];
    clipsById: Record<string, TimelineClip>;
    projectTracks: ProjectTrack[];
    tracksById: Record<string, ProjectTrack>;
    changed: boolean;
    fallbackReason: string | null;
}

export interface DeltaEnv {
    bpm: number;
    sampleRate: number;
    reason: string;
}

export type DeltaHandler = (state: DeltaWorkingState, delta: ProjectDelta, env: DeltaEnv) => boolean;
