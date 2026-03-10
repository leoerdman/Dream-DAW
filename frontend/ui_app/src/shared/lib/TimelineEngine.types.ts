import type { LoopRegion, TimelineClipData } from './CanvasClipRenderer';
import type { ViewportConfig } from './ViewportMatrix';

import { HEADER_HEIGHT, DEFAULT_FADE_CURVE as _DEFAULT_FADE_CURVE } from './CanvasClipRenderer.constants';

export interface TimelineEngineConfig {
    beatsPerBar: number;
    bpm: number;
    sampleRate: number;
    viewport: ViewportConfig;
    snapBeats?: number;
    snapEnabled?: boolean;
    automationVisible?: boolean;
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
    selectedCount?: number;
}

export interface TrimPreviewState {
    clipId: string;
    startBeat: number;
    durationBeats: number;
    edge: 'left' | 'right';
    allowStretch: boolean;
    originalStartBeat: number;
    originalDurationBeats: number;
}

export const EDGE_GRIP_PX = 8;
/** SSOT: Re-exported from CanvasClipRenderer.constants.HEADER_HEIGHT */
export const CLIP_HEADER_HEIGHT_PX = HEADER_HEIGHT;
export const DEFAULT_TRACK_HEIGHT_PX = 80;
export const MIN_LOOP_BEATS = 4;
export const FADE_HANDLE_HOTSPOT_PX = 12;
export const FADE_CURVE_HANDLE_RADIUS_PX = 6;
export const FADE_CURVE_PRESETS = [0.2, 0.35, _DEFAULT_FADE_CURVE, 0.65, 0.8] as const;
/** SSOT: Re-exported from CanvasClipRenderer.constants.DEFAULT_FADE_CURVE */
export const DEFAULT_FADE_CURVE = _DEFAULT_FADE_CURVE;
export const CLIP_DRAG_START_THRESHOLD_PX = 4;
export const MIN_RESIZE_DURATION_BEATS = 0.25; // SSOT: Minimum clip duration during resize
export const CURSOR_BLINK_MS = 500;
export const WAVEFORM_PREFETCH_BUFFER_BEATS = 10;
export const BEAT_COMMIT_THRESHOLD = 0.05;
export const TRACK_COMMIT_THRESHOLD = 0.5;
export const FALLBACK_SAMPLES_PER_BEAT = 1024;
export const RESIZE_BOUNDARY_EPS = 0.001; // SSOT: Epsilon for clip boundary collision during resize
export const CURVE_X_WEIGHT = 0.7; // SSOT: Horizontal weight in fade curve blend
export const CURVE_Y_WEIGHT = 0.3; // SSOT: Vertical weight in fade curve blend
export const EDGE_WIDTH_FIXED_PX = 3; // SSOT: Fixed edge grip width in px (enterprise — predictable UX)
// SSOT: Fine-factor multipliers for fade/fadeCurve drag precision
export const FINE_FACTOR_ALT_SHIFT = 0.08;
export const FINE_FACTOR_ALT = 0.14;
export const FINE_FACTOR_SHIFT = 0.28;
export const FINE_FACTOR_CURVE_ALT = 0.12;
export const FINE_FACTOR_CURVE_SHIFT = 0.22;

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
    clipResizeAllowStretch?: boolean;
    coMoverOrigins?: Map<string, { beat: number; track: number }>;
    deferSingleSelectOnMouseUp?: boolean;
    /** Content-Y at the start of a marquee drag (px in content space, ruler excluded). */
    startContentY?: number;
    /** BUG-055 FIX: Cached bounding rect to avoid reflows during drag sequences. */
    canvasRect?: DOMRect;
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
