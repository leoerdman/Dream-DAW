export type BrowserItemType = 'audio' | 'midi' | 'plugin' | 'preset';

export interface BrowserDragItem {
    id: string;
    name: string;
    type: BrowserItemType;
    path: string;
    format?: string;
    slotHint?: 'instrument' | 'effect' | 'auto';
    durationSeconds?: number;
}

export interface TimelineMidiNote {
    id?: string;
    pitch: number;
    startBeat: number;
    durationBeats: number;
    velocity: number;
}

export interface TimelineClip {
    id: string;
    name: string;
    trackIndex: number;
    startBeat: number;
    durationBeats: number;
    type: 'audio' | 'midi';
    color: string;
    filePath?: string;
    durationSamples?: number;
    sourceOffset?: number;
    fadeIn?: number;
    fadeOut?: number;
    fadeInCurve?: number;
    fadeOutCurve?: number;
    muted?: boolean;
    isOffline?: boolean;
    midiNotes?: TimelineMidiNote[];
}
