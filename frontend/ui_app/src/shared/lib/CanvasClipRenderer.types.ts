export interface TimelineClipData {
    id: string;
    name: string;
    trackIndex: number;
    startBeat: number;
    durationBeats: number;
    type: 'audio' | 'midi';
    color: string;
    selected?: boolean;
    primarySelected?: boolean;
    hovered?: boolean;
    filePath?: string;
    durationSamples?: number;
    sourceOffset?: number;
    fadeIn?: number;
    fadeOut?: number;
    fadeInCurve?: number;
    fadeOutCurve?: number;
    showFadeInCurvePoint?: boolean;
    showFadeOutCurvePoint?: boolean;
    isOffline?: boolean;
    muted?: boolean;
    trackDisabled?: boolean;
    isWarped?: boolean;
    warpSourceDurationFrames?: number;
    pitchShiftSemitones?: number;
    midiNotes?: Array<{
        pitch: number;
        startBeat: number;
        durationBeats: number;
        velocity: number;
    }>;
    /** When true, this clip is a Cmd+Drag duplicate preview (rendered at 50% alpha). */
    isDuplicateGhost?: boolean;
}

export interface LoopRegion {
    start: number;
    end: number;
    enabled: boolean;
}

export interface GhostClipData {
    trackIndex: number;
    beat: number;
    widthBeats: number;
    name: string;
    type: 'audio' | 'midi';
}

export interface TimelineTheme {
    bg: string;
    rulerBg: string;
    gridLine: string;
    gridBar: string;
    trackDefault: string;
    trackSelected: string;
    playhead: string;
    playheadGlow: string;
    editCursor: string;
    loopFill: string;
    loopBorder: string;
    rulerText: string;
    trackDivider: string;
}
