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

export interface TimelineEnvelopePoint {
    beat: number;
    value: number;
    curveType?: string;
}

export interface TimelineClipEnvelope {
    paramId: string;
    points: TimelineEnvelopePoint[];
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
    isWarped?: boolean;
    warpMode?: number | null;
    warpBaseBpm?: number;
    warpSourceDurationFrames?: number;
    pitchShiftSemitones?: number;
    muted?: boolean;
    isOffline?: boolean;
    midiNotes?: TimelineMidiNote[];
    midiEnvelopes?: TimelineClipEnvelope[];
    /** Audio file sample rate (e.g. 44100, 48000). MIDI clips will be undefined. */
    sampleRate?: number;
    /** Audio file channel count (1=mono, 2=stereo). MIDI clips will be undefined. */
    channels?: number;
    /** Total frames in the source audio file. MIDI clips will be undefined. */
    numFrames?: number;
}
