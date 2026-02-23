import { useCallback, useRef, useState } from 'react';
import { LOWEST_PITCH, MIN_NOTE_BEATS, TOTAL_KEYS, type MidiNote, type PianoRollTool } from './pianoRollConfig';

interface UsePianoRollNoteInteractionsArgs {
    tool: PianoRollTool;
    isMac: boolean;
    snapEnabled: boolean;
    drumMode: boolean;
    noteHeight: number;
    beatsPerBar: number;
    clipBeats: number;
    visiblePitches: number[];
    notes: MidiNote[];
    notesRef: React.RefObject<MidiNote[]>;
    pixelsPerBeatRef: React.RefObject<number>;
    selectedNotes: Set<string>;
    setSelectedNotes: React.Dispatch<React.SetStateAction<Set<string>>>;
    editorRootRef: React.RefObject<HTMLDivElement | null>;
    snapBeat: (beat: number, beatsPerBar?: number, pixelsPerBeat?: number) => number;
    onNotesChange: (notes: MidiNote[]) => void;
    enforceNoOverlap: (input: MidiNote[], aggressorIds: Set<string>) => MidiNote[];
    auditionNote: (pitch: number, velocity?: number, durationMs?: number) => void;
}

export function usePianoRollNoteInteractions({
    tool,
    isMac,
    snapEnabled,
    drumMode,
    noteHeight,
    beatsPerBar,
    clipBeats,
    visiblePitches,
    notes,
    notesRef,
    pixelsPerBeatRef,
    selectedNotes,
    setSelectedNotes,
    editorRootRef,
    snapBeat,
    onNotesChange,
    enforceNoOverlap,
    auditionNote,
}: UsePianoRollNoteInteractionsArgs) {
    const isDragInProgressRef = useRef(false);
    const lastClickedNoteIdRef = useRef<string | null>(null);
    const [hoveredNoteEdge, setHoveredNoteEdge] = useState<string | null>(null);

    const handleNoteClick = useCallback((event: React.MouseEvent, noteId: string) => {
        event.stopPropagation();
        editorRootRef.current?.focus();
        const target = notes.find((note) => note.id === noteId);
        if (target && !event.shiftKey) auditionNote(target.pitch, target.velocity, 120);
        if (event.shiftKey && lastClickedNoteIdRef.current) {
            const anchor = notes.find((note) => note.id === lastClickedNoteIdRef.current);
            if (anchor && target) {
                const minBeat = Math.min(anchor.startBeat, target.startBeat);
                const maxBeat = Math.max(anchor.startBeat + anchor.durationBeats, target.startBeat + target.durationBeats);
                const minPitch = Math.min(anchor.pitch, target.pitch);
                const maxPitch = Math.max(anchor.pitch, target.pitch);
                const rangeIds = new Set<string>();
                for (const note of notes) {
                    const noteEnd = note.startBeat + note.durationBeats;
                    if (note.pitch >= minPitch && note.pitch <= maxPitch && note.startBeat < maxBeat && noteEnd > minBeat) {
                        rangeIds.add(note.id);
                    }
                }
                setSelectedNotes(rangeIds);
                return;
            }
        }
        lastClickedNoteIdRef.current = noteId;
        setSelectedNotes((prev) => {
            const next = new Set(prev);
            if (event.shiftKey) {
                if (next.has(noteId)) next.delete(noteId);
                else next.add(noteId);
            } else {
                next.clear();
                next.add(noteId);
            }
            return next;
        });
    }, [auditionNote, editorRootRef, notes, setSelectedNotes]);

    const handleNoteDrag = useCallback((event: React.MouseEvent, noteId: string) => {
        if (tool === 'paint') return;
        event.stopPropagation();
        event.preventDefault();
        editorRootRef.current?.focus();
        isDragInProgressRef.current = true;
        const startX = event.clientX;
        const startY = event.clientY;
        const notesAtStart = notesRef.current;
        const note = notesAtStart.find((n) => n.id === noteId);
        if (!note) return;
        const target = event.currentTarget as HTMLElement;
        const targetRect = target.getBoundingClientRect();
        const localX = event.clientX - targetRect.left;
        const edgeThreshold = Math.max(4, Math.min(6, targetRect.width * 0.25));
        const mode = localX >= targetRect.width - edgeThreshold ? 'resize-right' : localX <= edgeThreshold ? 'resize-left' : 'move';
        const selectedIds = selectedNotes.has(noteId) ? new Set(selectedNotes) : new Set([noteId]);
        if (!selectedNotes.has(noteId)) setSelectedNotes(new Set([noteId]));
        const startStates = new Map(
            notesAtStart
                .filter((n) => selectedIds.has(n.id))
                .map((n) => [n.id, { startBeat: n.startBeat, pitch: n.pitch, durationBeats: n.durationBeats }] as const),
        );
        let lastAuditionPitch: number | null = null;

        const onMove = (moveEvent: MouseEvent) => {
            const beatDelta = (moveEvent.clientX - startX) / pixelsPerBeatRef.current;
            const pitchDelta = Math.abs(moveEvent.clientY - startY) > noteHeight * 0.5 ? -Math.round((moveEvent.clientY - startY) / noteHeight) : 0;
            const snapOverrideHeld = isMac ? moveEvent.metaKey : moveEvent.ctrlKey;
            const shouldSnap = snapEnabled && !snapOverrideHeld;
            const currentNotes = notesRef.current;
            const updated = currentNotes.map((n) => {
                if (!selectedIds.has(n.id)) return n;
                const original = startStates.get(n.id);
                if (!original) return n;
                if (mode === 'resize-right') {
                    const maxDur = Math.max(MIN_NOTE_BEATS, clipBeats - original.startBeat);
                    const rawDur = original.durationBeats + beatDelta;
                    const finalDur = shouldSnap ? snapBeat(rawDur, beatsPerBar, pixelsPerBeatRef.current) : rawDur;
                    return { ...n, durationBeats: Math.min(maxDur, Math.max(MIN_NOTE_BEATS, finalDur)) };
                }
                if (mode === 'resize-left') {
                    const rawStart = original.startBeat + beatDelta;
                    const noteEnd = original.startBeat + original.durationBeats;
                    const maxStart = noteEnd - MIN_NOTE_BEATS;
                    const snappedBeat = Math.max(0, Math.min(maxStart, shouldSnap ? snapBeat(rawStart, beatsPerBar, pixelsPerBeatRef.current) : rawStart));
                    return { ...n, startBeat: snappedBeat, durationBeats: Math.max(MIN_NOTE_BEATS, noteEnd - snappedBeat) };
                }
                const rawStart = original.startBeat + beatDelta;
                const newBeat = Math.max(0, Math.min(clipBeats - MIN_NOTE_BEATS, shouldSnap ? snapBeat(rawStart, beatsPerBar, pixelsPerBeatRef.current) : rawStart));
                let newPitch: number;
                if (drumMode && pitchDelta !== 0) {
                    const currentRow = visiblePitches.indexOf(original.pitch);
                    newPitch = currentRow < 0
                        ? original.pitch
                        : visiblePitches[Math.max(0, Math.min(visiblePitches.length - 1, currentRow - pitchDelta))];
                } else {
                    newPitch = Math.max(LOWEST_PITCH, Math.min(LOWEST_PITCH + TOTAL_KEYS - 1, original.pitch + pitchDelta));
                }
                return { ...n, startBeat: newBeat, pitch: newPitch };
            });
            onNotesChange(enforceNoOverlap(updated, selectedIds));
            if (mode === 'move') {
                const lead = updated.find((n) => n.id === noteId);
                if (lead && lead.pitch !== lastAuditionPitch) {
                    lastAuditionPitch = lead.pitch;
                    auditionNote(lead.pitch, lead.velocity, 110);
                }
            }
        };

        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            requestAnimationFrame(() => {
                isDragInProgressRef.current = false;
            });
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [auditionNote, beatsPerBar, clipBeats, drumMode, editorRootRef, enforceNoOverlap, isMac, noteHeight, notesRef, onNotesChange, pixelsPerBeatRef, selectedNotes, setSelectedNotes, snapBeat, snapEnabled, tool, visiblePitches]);

    const handleNoteMouseMove = useCallback((event: React.MouseEvent, noteId: string) => {
        const noteDiv = event.currentTarget as HTMLElement;
        const rect = noteDiv.getBoundingClientRect();
        const localX = event.clientX - rect.left;
        const threshold = Math.max(4, Math.min(6, rect.width * 0.25));
        const isEdge = localX >= rect.width - threshold || localX <= threshold;
        setHoveredNoteEdge(isEdge ? noteId : null);
    }, []);

    return {
        isDragInProgressRef,
        hoveredNoteEdge,
        setHoveredNoteEdge,
        handleNoteClick,
        handleNoteDrag,
        handleNoteMouseMove,
    };
}
