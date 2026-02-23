import { useCallback, useMemo } from 'react';
import {
    DEFAULT_FOCUS_PITCH,
    DRUM_LANES,
    HIGHEST_PITCH,
    KEY_NAMES,
    OCTAVE_LABEL_OFFSET,
    TOTAL_KEYS,
    type RootNote,
    type ScaleName,
} from '@/widgets/PianoRoll/model/pianoRollConfig';
import { isBlackKey, isInScale, LOWEST_PITCH } from './pianoRollConfig';

interface UsePianoRollDerivedViewArgs {
    drumMode: boolean;
    foldToUsedNotes: boolean;
    notes: Array<{ id: string; pitch: number; startBeat: number; durationBeats: number }>;
    highlightScale: boolean;
    rootNote: RootNote;
    scaleName: ScaleName;
    noteHeight: number;
    totalBeats: number;
    beatsPerBar: number;
    pixelsPerBeat: number;
    currentGridInterval: number;
}

export function usePianoRollDerivedView({
    drumMode,
    foldToUsedNotes,
    notes,
    highlightScale,
    rootNote,
    scaleName,
    noteHeight,
    totalBeats,
    beatsPerBar,
    pixelsPerBeat,
    currentGridInterval,
}: UsePianoRollDerivedViewArgs) {
    const visiblePitches = useMemo(() => {
        if (drumMode) return DRUM_LANES.map((d) => d.pitch).sort((a, b) => b - a);
        const allPitches = Array.from({ length: TOTAL_KEYS }, (_, i) => HIGHEST_PITCH - i);
        if (!foldToUsedNotes) return allPitches;
        const usedSet = new Set(notes.map((note) => note.pitch));
        const filtered = allPitches.filter((pitch) => usedSet.has(pitch));
        return filtered.length > 0 ? filtered : allPitches;
    }, [drumMode, foldToUsedNotes, notes]);

    const pitchRowIndex = useMemo(() => {
        const map = new Map<number, number>();
        visiblePitches.forEach((pitch, index) => map.set(pitch, index));
        return map;
    }, [visiblePitches]);

    const pitchToY = useCallback((pitch: number) => {
        const rowIndex = pitchRowIndex.get(pitch);
        if (rowIndex === undefined) return -1;
        return rowIndex * noteHeight;
    }, [noteHeight, pitchRowIndex]);

    const yToPitch = useCallback((y: number) => {
        const row = Math.max(0, Math.min(visiblePitches.length - 1, Math.floor(y / noteHeight)));
        return visiblePitches[row] ?? DEFAULT_FOCUS_PITCH;
    }, [noteHeight, visiblePitches]);

    const scaleSet = useMemo(() => {
        if (!highlightScale) return null;
        const set = new Set<number>();
        for (let pitch = LOWEST_PITCH; pitch <= HIGHEST_PITCH; pitch++) {
            if (isInScale(pitch, rootNote, scaleName)) set.add(pitch);
        }
        return set;
    }, [highlightScale, rootNote, scaleName]);

    const gridLines = useMemo(() => {
        const lines: { x: number; isBar: boolean; label?: string; isMainBeat: boolean }[] = [];
        const epsilon = 1e-6;
        const visualStep = currentGridInterval > 0 ? currentGridInterval : 0.25;
        const totalSteps = Math.ceil(totalBeats / visualStep);
        for (let i = 0; i <= totalSteps; i++) {
            const beat = i * visualStep;
            if (beat > totalBeats + epsilon) break;
            const isBar = Math.abs((beat / beatsPerBar) - Math.round(beat / beatsPerBar)) < epsilon;
            const isMainBeat = Math.abs(beat - Math.round(beat)) < epsilon;
            lines.push({
                x: beat * pixelsPerBeat,
                isBar,
                isMainBeat,
                label: isBar ? `${Math.floor(beat / beatsPerBar) + 1}` : undefined,
            });
        }
        return lines;
    }, [beatsPerBar, currentGridInterval, pixelsPerBeat, totalBeats]);

    const rulerBeatLabels = useMemo(() => {
        const labels: Array<{ x: number; text: string; isBarStart: boolean }> = [];
        const maxBeat = Math.ceil(totalBeats + 1e-6);
        for (let beat = 0; beat <= maxBeat; beat += 1) {
            if (beat > totalBeats + 1e-6) break;
            const barIndex = Math.floor(beat / beatsPerBar);
            const beatInBar = (beat % beatsPerBar) + 1;
            labels.push({
                x: beat * pixelsPerBeat,
                text: `${barIndex + 1}.${beatInBar}`,
                isBarStart: beatInBar === 1,
            });
        }
        return labels;
    }, [beatsPerBar, pixelsPerBeat, totalBeats]);

    const pianoKeys = useMemo(() => {
        const drumNameByPitch = new Map(DRUM_LANES.map((d) => [d.pitch, d.name]));
        return visiblePitches.map((pitch) => {
            const note = pitch % 12;
            const octave = Math.floor(pitch / 12) + OCTAVE_LABEL_OFFSET;
            return {
                pitch,
                name: `${KEY_NAMES[note]}${octave}`,
                isBlack: isBlackKey(pitch),
                y: pitchToY(pitch),
                inScale: scaleSet ? scaleSet.has(pitch) : true,
                isC: note === 0,
                drumName: drumNameByPitch.get(pitch),
            };
        });
    }, [pitchToY, scaleSet, visiblePitches]);

    return {
        visiblePitches,
        pitchRowIndex,
        pitchToY,
        yToPitch,
        scaleSet,
        gridLines,
        rulerBeatLabels,
        pianoKeys,
    };
}
