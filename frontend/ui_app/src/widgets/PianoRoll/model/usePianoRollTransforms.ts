import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
    MIN_NOTE_BEATS,
    genNoteId,
    type MidiNote,
} from '@/widgets/PianoRoll/model/pianoRollConfig';

interface UsePianoRollTransformsParams {
    notes: MidiNote[];
    selectedNotes: Set<string>;
    ratchetCount: number;
    currentGridInterval: number;
    quantizeAmount: number;
    clipBeats: number;
    beatsPerBar: number;
    pixelsPerBeat: number;
    snapBeat: (beat: number, beatsPerBar: number, pixelsPerBeat: number) => number;
    onNotesChange: (notes: MidiNote[]) => void;
    enforceNoOverlap: (input: MidiNote[], aggressorIds: Set<string>) => MidiNote[];
    setSelectedNotes: Dispatch<SetStateAction<Set<string>>>;
    setClipTranspose: Dispatch<SetStateAction<number>>;
    auditionNote: (pitch: number, velocity?: number, durationMs?: number) => void;
}

export function usePianoRollTransforms({
    notes,
    selectedNotes,
    ratchetCount,
    currentGridInterval,
    quantizeAmount,
    clipBeats,
    beatsPerBar,
    pixelsPerBeat,
    snapBeat,
    onNotesChange,
    enforceNoOverlap,
    setSelectedNotes,
    setClipTranspose,
    auditionNote: _auditionNote,
}: UsePianoRollTransformsParams) {
    const applyRatchet = useCallback(() => {
        const repeats = Math.max(2, Math.min(12, Math.round(ratchetCount)));
        const targets = selectedNotes.size > 0 ? selectedNotes : new Set(notes.map((n) => n.id));
        if (targets.size === 0) return;

        const next: MidiNote[] = [];
        const newSelected = new Set<string>();
        for (const note of notes) {
            if (!targets.has(note.id)) {
                next.push(note);
                continue;
            }
            const sub = Math.max(0.03125, note.durationBeats / repeats);
            for (let i = 0; i < repeats; i++) {
                const subStart = note.startBeat + sub * i;
                if (subStart >= clipBeats) break;
                const id = genNoteId();
                next.push({
                    ...note,
                    id,
                    startBeat: subStart,
                    durationBeats: Math.min(sub, clipBeats - subStart),
                });
                newSelected.add(id);
            }
        }

        onNotesChange(enforceNoOverlap(next, newSelected));
        setSelectedNotes(newSelected);
    }, [ratchetCount, selectedNotes, notes, clipBeats, onNotesChange, enforceNoOverlap, setSelectedNotes]);

    const transposeNotes = useCallback((delta: number) => {
        if (delta === 0 || notes.length === 0 || selectedNotes.size === 0) return;
        const targets = selectedNotes;
        const next = notes.map((n) => {
            if (!targets.has(n.id)) return n;
            return {
                ...n,
                pitch: Math.max(0, Math.min(127, n.pitch + delta)),
            };
        });
        setClipTranspose((prev) => Math.max(-24, Math.min(24, prev + delta)));
        onNotesChange(enforceNoOverlap(next, targets));
    }, [notes, selectedNotes, setClipTranspose, onNotesChange, enforceNoOverlap]);

    const quantizeAllNotesToGrid = useCallback((amountPct = quantizeAmount) => {
        const step = currentGridInterval > 0 ? currentGridInterval : 0.25;
        const amt = Math.max(0, Math.min(1, amountPct / 100));
        if (selectedNotes.size === 0) return;
        const targetIds = selectedNotes;
        const next = notes.map((n) => {
            if (!targetIds.has(n.id)) return n;
            const snappedStart = snapBeat(n.startBeat, beatsPerBar, pixelsPerBeat);
            const snappedDur = Math.max(step, Math.round(n.durationBeats / step) * step);
            const blendedStart = n.startBeat + (snappedStart - n.startBeat) * amt;
            const blendedDur = n.durationBeats + (snappedDur - n.durationBeats) * amt;
            return {
                ...n,
                startBeat: Math.max(0, Math.min(Math.max(0, clipBeats - step), blendedStart)),
                durationBeats: Math.max(step, Math.min(clipBeats - blendedStart, blendedDur)),
            };
        });
        onNotesChange(enforceNoOverlap(next, targetIds));
    }, [
        quantizeAmount,
        currentGridInterval,
        selectedNotes,
        notes,
        snapBeat,
        beatsPerBar,
        pixelsPerBeat,
        clipBeats,
        onNotesChange,
        enforceNoOverlap,
    ]);

    const duplicateSelection = useCallback(() => {
        const targets = selectedNotes.size > 0 ? notes.filter((n) => selectedNotes.has(n.id)) : notes;
        if (targets.length === 0) return;
        const spanStart = Math.min(...targets.map((n) => n.startBeat));
        const spanEnd = Math.max(...targets.map((n) => n.startBeat + n.durationBeats));
        const shift = spanEnd - spanStart;
        const clones = targets.map((n) => ({
            ...n,
            id: genNoteId(),
            startBeat: Math.max(0, Math.min(clipBeats - MIN_NOTE_BEATS, n.startBeat + shift)),
            selected: false,
        }));
        onNotesChange(enforceNoOverlap([...notes, ...clones], new Set(clones.map((n) => n.id))));
        setSelectedNotes(new Set(clones.map((n) => n.id)));
    }, [selectedNotes, notes, clipBeats, onNotesChange, enforceNoOverlap, setSelectedNotes]);

    const selectSamePitch = useCallback(() => {
        if (selectedNotes.size === 0) return;
        const seed = notes.find((n) => selectedNotes.has(n.id));
        if (!seed) return;
        const samePitchIds = notes.filter((n) => n.pitch === seed.pitch).map((n) => n.id);
        setSelectedNotes(new Set(samePitchIds));
    }, [selectedNotes, notes, setSelectedNotes]);

    const humanizeSelection = useCallback(() => {
        if (selectedNotes.size === 0) return;
        const targets = selectedNotes;
        const step = currentGridInterval > 0 ? currentGridInterval : 0.25;
        const next = notes.map((n) => {
            if (!targets.has(n.id)) return n;
            const hashSeed = n.id.split('').reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 0);
            const pseudoRand1 = ((hashSeed & 0x7fffffff) % 997) / 997;
            const pseudoRand2 = (((hashSeed * 127) & 0x7fffffff) % 991) / 991;
            const timing = (pseudoRand1 - 0.5) * step * 0.35;
            const velocity = Math.round((pseudoRand2 - 0.5) * 10);
            return {
                ...n,
                startBeat: Math.max(0, Math.min(clipBeats - MIN_NOTE_BEATS, n.startBeat + timing)),
                velocity: Math.max(1, Math.min(127, n.velocity + velocity)),
            };
        });
        onNotesChange(enforceNoOverlap(next, targets));
    }, [selectedNotes, currentGridInterval, notes, clipBeats, onNotesChange, enforceNoOverlap]);

    const applyLegato = useCallback(() => {
        if (selectedNotes.size === 0) return;
        const targets = selectedNotes;
        const byPitch = new Map<number, MidiNote[]>();
        notes.forEach((n) => {
            if (!targets.has(n.id)) return;
            const arr = byPitch.get(n.pitch) ?? [];
            arr.push(n);
            byPitch.set(n.pitch, arr);
        });
        const durationById = new Map<string, number>();
        byPitch.forEach((arr) => {
            arr.sort((a, b) => a.startBeat - b.startBeat);
            for (let i = 0; i < arr.length; i++) {
                const current = arr[i];
                const next = arr[i + 1];
                const targetEnd = next ? next.startBeat : clipBeats;
                durationById.set(current.id, Math.max(MIN_NOTE_BEATS, targetEnd - current.startBeat));
            }
        });
        if (durationById.size === 0) return;
        onNotesChange(enforceNoOverlap(notes.map((n) => (
            durationById.has(n.id)
                ? { ...n, durationBeats: Math.max(MIN_NOTE_BEATS, Math.min(clipBeats - n.startBeat, durationById.get(n.id) ?? n.durationBeats)) }
                : n
        )), targets));
    }, [selectedNotes, notes, clipBeats, onNotesChange, enforceNoOverlap]);

    return {
        applyRatchet,
        transposeNotes,
        quantizeAllNotesToGrid,
        duplicateSelection,
        selectSamePitch,
        humanizeSelection,
        applyLegato,
    };
}
