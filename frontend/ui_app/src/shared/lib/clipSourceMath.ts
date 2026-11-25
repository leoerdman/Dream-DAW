import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { TimelineClipData } from '@/shared/lib/CanvasClipRenderer.types';

type SourceAwareClip = Pick<
    TimelineClip | TimelineClipData,
    'durationSamples' | 'sourceOffset' | 'isWarped' | 'warpSourceDurationFrames' | 'sourceFileTotalFrames' | 'numFrames' | 'pitchShiftSemitones' | 'sampleRate'
>;

export function getClipPitchMultiplier(clip: SourceAwareClip): number {
    const pitchSemitones = clip.pitchShiftSemitones ?? 0;
    if (pitchSemitones === 0) return 1;
    return Math.pow(2, Math.max(-36, Math.min(36, pitchSemitones)) / 12);
}

function getClipSourceRateRatio(clip: SourceAwareClip, projectSampleRate?: number): number {
    const sourceSampleRate = clip.sampleRate;
    if (
        typeof sourceSampleRate === 'number' && Number.isFinite(sourceSampleRate) && sourceSampleRate > 0 &&
        typeof projectSampleRate === 'number' && Number.isFinite(projectSampleRate) && projectSampleRate > 0
    ) {
        return Math.max(1e-9, sourceSampleRate / projectSampleRate);
    }
    return 1.0;
}

export function getClipSourceWindowFrames(clip: SourceAwareClip, projectSampleRate?: number): number {
    if (clip.isWarped && (clip.warpSourceDurationFrames ?? 0) > 0) {
        return Math.max(1, clip.warpSourceDurationFrames ?? 1);
    }
    return Math.max(1, Math.round(
        Math.max(1, clip.durationSamples ?? 1)
        * getClipPitchMultiplier(clip)
        * getClipSourceRateRatio(clip, projectSampleRate),
    ));
}

export function getClipSourcePerTimelineFrame(clip: SourceAwareClip, projectSampleRate?: number): number {
    if (clip.isWarped && (clip.warpSourceDurationFrames ?? 0) > 0 && (clip.durationSamples ?? 0) > 0) {
        return Math.max(1e-9, (clip.warpSourceDurationFrames ?? 1) / Math.max(1, clip.durationSamples ?? 1));
    }
    return Math.max(1e-9, getClipPitchMultiplier(clip) * getClipSourceRateRatio(clip, projectSampleRate));
}

export function getClipSourceWindowFramesForTimelineFrames(
    clip: SourceAwareClip,
    timelineFrames: number,
    projectSampleRate?: number,
): number {
    return Math.max(1, Math.round(Math.max(1, timelineFrames) * getClipSourcePerTimelineFrame(clip, projectSampleRate)));
}

export function getClipSourceTotalFrames(clip: SourceAwareClip, projectSampleRate?: number): number {
    const explicitTotal = clip.numFrames ?? clip.sourceFileTotalFrames;
    if (typeof explicitTotal === 'number' && Number.isFinite(explicitTotal) && explicitTotal > 0) {
        return Math.max(1, explicitTotal);
    }
    const sourceOffset = Math.max(0, clip.sourceOffset ?? 0);
    return Math.max(1, sourceOffset + getClipSourceWindowFrames(clip, projectSampleRate));
}

export function getClipAvailableSourceFrames(clip: SourceAwareClip, projectSampleRate?: number): number {
    return Math.max(1, getClipSourceTotalFrames(clip, projectSampleRate) - Math.max(0, clip.sourceOffset ?? 0));
}
