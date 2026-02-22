import type { LoopRegion, TimelineClipData } from './CanvasClipRenderer';
import type { ViewportConfig } from './ViewportMatrix';

export interface TimelineEngineConfig {
    beatsPerBar: number;
    bpm: number;
    sampleRate: number;
    viewport: ViewportConfig;
    snapBeats?: number;
    snapEnabled?: boolean;
}

export interface HitTestResult {
    type: 'clip' | 'ruler' | 'track' | 'empty';
    clipId?: string;
    beat: number;
    trackIndex: number;
    region?: 'header' | 'body';
    edge?: 'left' | 'right';
    fadeHandle?: 'in' | 'out';
    fadeCurveHandle?: 'in' | 'out';
    fadeZone?: 'in' | 'out';
    loopHandle?: 'start' | 'end';
}

export interface MarqueeSelection {
    startBeat: number;
    endBeat: number;
    startTrack: number;
    endTrack: number;
}

export interface TrimPreviewState {
    clipId: string;
    startBeat: number;
    durationBeats: number;
}

export const EDGE_GRIP_PX = 8;
export const CLIP_HEADER_HEIGHT_PX = 22;
export const MIN_LOOP_BEATS = 4;
export const FADE_HANDLE_HOTSPOT_PX = 12;
export const FADE_CURVE_HANDLE_RADIUS_PX = 6;
export const FADE_CURVE_PRESETS = [0.2, 0.35, 0.5, 0.65, 0.8] as const;
export const CLIP_DRAG_START_THRESHOLD_PX = 4;

export type DragMode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;
export const DragMode = {
    None: 0 as const,
    ClipMove: 1 as const,
    ClipMoveArmed: 12 as const,
    RulerScrub: 2 as const,
    MarqueeSelect: 3 as const,
    ClipResizeLeft: 4 as const,
    ClipResizeRight: 5 as const,
    LoopStartMove: 6 as const,
    LoopEndMove: 7 as const,
    ClipFadeIn: 8 as const,
    ClipFadeOut: 9 as const,
    ClipFadeInCurve: 10 as const,
    ClipFadeOutCurve: 11 as const,
    MultiCursorSelect: 13 as const,
};

export interface DragState {
    mode: DragMode;
    clipId: string | null;
    startBeat: number;
    startTrack: number;
    currentBeat: number;
    currentTrack: number;
    clipOriginalBeat: number;
    clipOriginalTrack: number;
    clipOriginalDuration: number;
    startClientX?: number;
    startClientY?: number;
    clipOriginalFadeIn?: number;
    clipOriginalFadeOut?: number;
    clipOriginalFadeInCurve?: number;
    clipOriginalFadeOutCurve?: number;
    coMoverOrigins?: Map<string, { beat: number; track: number }>;
}

export function clipDurationFramesFromTimeline(
    clip: TimelineClipData,
    bpm: number,
    sampleRate: number,
): number {
    if (clip.durationSamples && clip.durationSamples > 0) return clip.durationSamples;
    if (bpm <= 0 || sampleRate <= 0) return 1;
    const beatsToSeconds = 60 / bpm;
    return Math.max(1, Math.round(clip.durationBeats * beatsToSeconds * sampleRate));
}

export function isLoopRegionChanged(current: LoopRegion | null, next: LoopRegion): boolean {
    if (!current) return true;
    return (
        Math.abs(current.start - next.start) > 0.000001
        || Math.abs(current.end - next.end) > 0.000001
        || current.enabled !== next.enabled
    );
}
