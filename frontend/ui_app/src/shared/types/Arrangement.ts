export interface TimelineClipNote {
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
    selected?: boolean;
    filePath?: string;
    durationSamples?: number;
    sourceOffset?: number;
    fadeIn?: number;
    fadeOut?: number;
    isOffline?: boolean;
    midiNotes?: TimelineClipNote[];
}

export interface BrowserDragItem {
    id: string;
    name: string;
    type: 'audio' | 'midi' | 'preset' | 'plugin' | string;
    path: string;
    durationSeconds?: number;
    slotHint?: 'instrument' | 'effect' | 'auto';
}

