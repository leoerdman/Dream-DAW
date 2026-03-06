import type { GridDivision } from '@/shared/lib/gridSnap';

export interface MidiNote {
    id: string;
    pitch: number;
    startBeat: number;
    durationBeats: number;
    velocity: number;
    selected?: boolean;
}

export type PianoRollTool = 'cursor' | 'paint';

export type ScaleName =
    | 'Major'
    | 'Natural Minor'
    | 'Harmonic Minor'
    | 'Melodic Minor'
    | 'Dorian'
    | 'Phrygian'
    | 'Lydian'
    | 'Mixolydian'
    | 'Locrian'
    | 'Pentatonic Major'
    | 'Pentatonic Minor'
    | 'Blues'
    | 'Chromatic';

export const SCALE_INTERVALS: Record<ScaleName, number[]> = {
    'Major': [0, 2, 4, 5, 7, 9, 11],
    'Natural Minor': [0, 2, 3, 5, 7, 8, 10],
    'Harmonic Minor': [0, 2, 3, 5, 7, 8, 11],
    'Melodic Minor': [0, 2, 3, 5, 7, 9, 11],
    'Dorian': [0, 2, 3, 5, 7, 9, 10],
    'Phrygian': [0, 1, 3, 5, 7, 8, 10],
    'Lydian': [0, 2, 4, 6, 7, 9, 11],
    'Mixolydian': [0, 2, 4, 5, 7, 9, 10],
    'Locrian': [0, 1, 3, 5, 6, 8, 10],
    'Pentatonic Major': [0, 2, 4, 7, 9],
    'Pentatonic Minor': [0, 3, 5, 7, 10],
    'Blues': [0, 3, 5, 6, 7, 10],
    'Chromatic': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export const SCALE_NAMES = Object.keys(SCALE_INTERVALS) as ScaleName[];
export const ROOT_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
export type RootNote = typeof ROOT_NOTES[number];

export function isInScale(pitch: number, rootNote: RootNote, scale: ScaleName): boolean {
    const rootIndex = ROOT_NOTES.indexOf(rootNote);
    const intervals = SCALE_INTERVALS[scale];
    const degree = ((pitch % 12) - rootIndex + 12) % 12;
    return intervals.includes(degree);
}

export const KEYBOARD_WIDTH = 52;
export const DEFAULT_NOTE_HEIGHT = 14;
export const MIN_NOTE_HEIGHT = 4;
export const MAX_NOTE_HEIGHT = 32;
export const VELOCITY_LANE_HEIGHT = 64;
export const RULER_HEIGHT = 22;
export const LOWEST_PITCH = 0;
export const HIGHEST_PITCH = 127;
export const TOTAL_KEYS = HIGHEST_PITCH - LOWEST_PITCH + 1;
export const MIN_PPB = 4;
export const MAX_PPB = 200;
export const MIN_NOTE_BEATS = 0.125;
export const EPS = 1e-6;

export const KEY_NAMES: readonly string[] = ROOT_NOTES;
export const OCTAVE_LABEL_OFFSET = -2;
export const DEFAULT_FOCUS_PITCH = 60;

export const MIDI_GRID_PRESETS: Array<{ label: string; division: GridDivision }> = [
    { label: '1/1', division: '1/1' },
    { label: '1/4', division: '1/4' },
    { label: '1/8', division: '1/8' },
    { label: '1/16', division: '1/16' },
];

export const DRUM_LANES: Array<{ pitch: number; name: string }> = [
    { pitch: 36, name: 'Kick' },
    { pitch: 38, name: 'Snare' },
    { pitch: 42, name: 'Closed Hat' },
    { pitch: 46, name: 'Open Hat' },
    { pitch: 41, name: 'Low Tom' },
    { pitch: 43, name: 'Mid Tom' },
    { pitch: 45, name: 'High Tom' },
    { pitch: 49, name: 'Crash' },
    { pitch: 51, name: 'Ride' },
    { pitch: 37, name: 'Rim' },
    { pitch: 39, name: 'Clap' },
    { pitch: 35, name: 'Sub Kick' },
];

export type PianoLaneType = 'velocity' | 'modWheel' | 'expression';

export const isBlackKey = (pitch: number): boolean => {
    const note = pitch % 12;
    return [1, 3, 6, 8, 10].includes(note);
};

export const genNoteId = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `note_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
};
