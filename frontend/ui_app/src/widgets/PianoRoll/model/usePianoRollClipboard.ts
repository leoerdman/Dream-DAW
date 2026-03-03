import { useCallback } from 'react';
import {
    genNoteId,
    type MidiNote,
} from '@/widgets/PianoRoll/model/pianoRollConfig';
import { useEngineStore } from '@/shared/stores/useEngineStore';

interface UsePianoRollClipboardArgs {
    notes: MidiNote[];
    selectedNotes: Set<string>;
    clipBeats: number;
    onNotesChange: (notes: MidiNote[]) => void;
    setSelectedNotes: React.Dispatch<React.SetStateAction<Set<string>>>;
    enforceNoOverlap: (input: MidiNote[], aggressorIds: Set<string>) => MidiNote[];
}

/**
 * Module-level clipboard so copied notes survive across PianoRoll instances.
 * BUG-011 DOC: This is INTENTIONALLY module-level — in a DAW, copy/paste should
 * work across different MIDI clips (select notes in clip A, paste into clip B).
 * The clipboard is isolated per-window via the JS module boundary.
 */
let _moduleClipboard: MidiNote[] = [];

export function usePianoRollClipboard({
    notes,
    selectedNotes,
    clipBeats,
    onNotesChange,
    setSelectedNotes,
    enforceNoOverlap,
}: UsePianoRollClipboardArgs) {

    const copySelection = useCallback(() => {
        const targets = notes.filter((note) => selectedNotes.has(note.id));
        if (targets.length === 0) return;
        _moduleClipboard = targets.map((note) => ({ ...note }));
    }, [notes, selectedNotes]);

    const pasteClipboard = useCallback(() => {
        if (_moduleClipboard.length === 0) return;
        let minBeat = Infinity;
        let maxEnd = -Infinity;
        for (const note of _moduleClipboard) {
            if (note.startBeat < minBeat) minBeat = note.startBeat;
            const end = note.startBeat + note.durationBeats;
            if (end > maxEnd) maxEnd = end;
        }

        const storePositionBeats = useEngineStore.getState().transport.position_beats;
        const playheadBeat = storePositionBeats ?? -1;

        const pasteAt = playheadBeat >= 0
            ? playheadBeat
            : Math.max(0, ...notes.map((note) => note.startBeat + note.durationBeats));
        let offset = pasteAt - minBeat;
        const groupDuration = maxEnd - minBeat;
        // BUG-N07 FIX: Clamp maxOffset to 0 — if the group is wider than the clip,
        // place it at the start rather than before the clip boundary.
        const maxOffset = Math.max(0, clipBeats - groupDuration);
        offset = Math.max(-minBeat, Math.min(maxOffset, offset));

        const pasted = _moduleClipboard.map((note: MidiNote) => ({
            ...note,
            id: genNoteId(),
            startBeat: Math.max(0, note.startBeat + offset),
        }));

        onNotesChange(enforceNoOverlap([...notes, ...pasted], new Set(pasted.map((note: MidiNote) => note.id))));
        setSelectedNotes(new Set(pasted.map((note: MidiNote) => note.id)));
    }, [clipBeats, enforceNoOverlap, notes, onNotesChange, setSelectedNotes]);

    return { copySelection, pasteClipboard };
}
