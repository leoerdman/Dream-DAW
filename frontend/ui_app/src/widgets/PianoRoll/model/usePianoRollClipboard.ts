import { useCallback, useRef } from 'react';
import {
    genNoteId,
    type MidiNote,
} from '@/widgets/PianoRoll/model/pianoRollConfig';

interface UsePianoRollClipboardArgs {
    notes: MidiNote[];
    selectedNotes: Set<string>;
    playheadBeat: number;
    clipBeats: number;
    onNotesChange: (notes: MidiNote[]) => void;
    setSelectedNotes: React.Dispatch<React.SetStateAction<Set<string>>>;
    enforceNoOverlap: (input: MidiNote[], aggressorIds: Set<string>) => MidiNote[];
}

export function usePianoRollClipboard({
    notes,
    selectedNotes,
    playheadBeat,
    clipBeats,
    onNotesChange,
    setSelectedNotes,
    enforceNoOverlap,
}: UsePianoRollClipboardArgs) {
    const clipboardRef = useRef<MidiNote[]>([]);

    const copySelection = useCallback(() => {
        const targets = notes.filter((note) => selectedNotes.has(note.id));
        if (targets.length === 0) return;
        clipboardRef.current = targets.map((note) => ({ ...note }));
    }, [notes, selectedNotes]);

    const pasteClipboard = useCallback(() => {
        if (clipboardRef.current.length === 0) return;
        let minBeat = Infinity;
        let maxEnd = -Infinity;
        for (const note of clipboardRef.current) {
            if (note.startBeat < minBeat) minBeat = note.startBeat;
            const end = note.startBeat + note.durationBeats;
            if (end > maxEnd) maxEnd = end;
        }

        const pasteAt = playheadBeat != null
            ? playheadBeat
            : Math.max(0, ...notes.map((note) => note.startBeat + note.durationBeats));
        let offset = pasteAt - minBeat;
        const groupDuration = maxEnd - minBeat;
        const maxOffset = Math.max(0, clipBeats - groupDuration);
        offset = Math.max(-minBeat, Math.min(maxOffset, offset));

        const pasted = clipboardRef.current.map((note) => ({
            ...note,
            id: genNoteId(),
            startBeat: Math.max(0, note.startBeat + offset),
        }));

        onNotesChange(enforceNoOverlap([...notes, ...pasted], new Set(pasted.map((note) => note.id))));
        setSelectedNotes(new Set(pasted.map((note) => note.id)));
    }, [clipBeats, enforceNoOverlap, notes, onNotesChange, playheadBeat, setSelectedNotes]);

    return { copySelection, pasteClipboard };
}
