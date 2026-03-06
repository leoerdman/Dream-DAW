import { useCallback, useEffect, useRef, useState } from 'react';
import { LOWEST_PITCH, MIN_NOTE_BEATS, TOTAL_KEYS, genNoteId, type MidiNote, type PianoRollTool } from './pianoRollConfig';

interface UsePianoRollNoteInteractionsArgs {
    tool: PianoRollTool;
    pianoPencilMode: boolean;
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
    pianoPencilMode,
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
    const dragCleanupRef = useRef<(() => void) | null>(null);

    useEffect(() => () => {
        dragCleanupRef.current?.();
        dragCleanupRef.current = null;
    }, []);

    const handleNoteClick = useCallback((event: React.MouseEvent, noteId: string) => {
        if (tool === 'paint') return;
        event.stopPropagation();
        editorRootRef.current?.focus();
        const target = notes.find((note) => note.id === noteId);
        if (pianoPencilMode) {
            onNotesChange(notes.filter((note) => note.id !== noteId));
            setSelectedNotes((prev) => {
                const next = new Set(prev);
                next.delete(noteId);
                return next;
            });
            lastClickedNoteIdRef.current = null;
            return;
        }
        const deleteOnSecondClick = !event.shiftKey
            && selectedNotes.has(noteId)
            && lastClickedNoteIdRef.current === noteId;
        if (deleteOnSecondClick) {
            onNotesChange(notes.filter((note) => note.id !== noteId));
            setSelectedNotes((prev) => {
                const next = new Set(prev);
                next.delete(noteId);
                return next;
            });
            lastClickedNoteIdRef.current = null;
            return;
        }
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
                setSelectedNotes((prev) => new Set([...prev, ...rangeIds]));
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
    }, [auditionNote, editorRootRef, notes, onNotesChange, pianoPencilMode, selectedNotes, setSelectedNotes, tool]);

    const handleNoteDrag = useCallback((event: React.MouseEvent, noteId: string) => {
        if (tool === 'paint' || pianoPencilMode) return;
        if (event.button !== 0) return;
        event.stopPropagation();
        event.preventDefault();
        editorRootRef.current?.focus();
        const startX = event.clientX;
        const startY = event.clientY;
        const notesAtStart = notesRef.current;
        const note = notesAtStart.find((n) => n.id === noteId);
        if (!note) return;
        isDragInProgressRef.current = true;
        const target = event.currentTarget as HTMLElement;
        const targetRect = target.getBoundingClientRect();
        const localX = event.clientX - targetRect.left;
        const edgeThreshold = Math.max(4, Math.min(6, targetRect.width * 0.25));
        const mode = localX >= targetRect.width - edgeThreshold ? 'resize-right' : localX <= edgeThreshold ? 'resize-left' : 'move';
        const selectedIds = selectedNotes.has(noteId) ? new Set(selectedNotes) : new Set([noteId]);
        if (!selectedNotes.has(noteId)) setSelectedNotes(new Set([noteId]));

        // ALT+DRAG COPY: When Alt (Option on Mac) is held at drag start,
        // clone selected notes and drag the clones — originals stay in place.
        const isAltCopy = event.altKey;
        let cloneMap: Map<string, string> | null = null; // originalId → cloneId
        if (isAltCopy && mode === 'move') {
            cloneMap = new Map();
            const clones: MidiNote[] = [];
            for (const n of notesAtStart) {
                if (!selectedIds.has(n.id)) continue;
                const cloneId = genNoteId();
                cloneMap.set(n.id, cloneId);
                clones.push({ ...n, id: cloneId });
            }
            // Insert clones into the note array immediately
            const merged = [...notesAtStart, ...clones];
            onNotesChange(merged);
            // Replace selectedIds with clone IDs — drag will move clones, not originals
            selectedIds.clear();
            const cloneIds = new Set<string>();
            for (const [, cloneId] of cloneMap) {
                selectedIds.add(cloneId);
                cloneIds.add(cloneId);
            }
            setSelectedNotes(cloneIds);
        }

        const startStates = new Map(
            (isAltCopy ? [...notesAtStart, ...(cloneMap ? Array.from(cloneMap.entries()).map(([origId, cloneId]) => {
                const orig = notesAtStart.find(n => n.id === origId);
                return orig ? { ...orig, id: cloneId } : null;
            }).filter(Boolean) as MidiNote[] : [])] : notesAtStart)
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
                const currentRow = visiblePitches.indexOf(original.pitch);
                if (currentRow >= 0 && pitchDelta !== 0) {
                    const nextRow = Math.max(0, Math.min(visiblePitches.length - 1, currentRow - pitchDelta));
                    newPitch = visiblePitches[nextRow];
                } else {
                    newPitch = Math.max(LOWEST_PITCH, Math.min(LOWEST_PITCH + TOTAL_KEYS - 1, original.pitch + pitchDelta));
                }
                return { ...n, startBeat: newBeat, pitch: newPitch };
            });
            // FIX #5: During drag, only update positions WITHOUT enforceNoOverlap.
            // This prevents notes from being deleted when dragging through them.
            // Overlap enforcement is deferred to mouseUp (drop).
            onNotesChange(updated);
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
            dragCleanupRef.current = null;
            // FIX #5: Apply enforceNoOverlap only on drop (mouseUp),
            // not during drag. This resolves final note positions.
            const finalNotes = notesRef.current;
            onNotesChange(enforceNoOverlap(finalNotes, selectedIds));
            requestAnimationFrame(() => {
                isDragInProgressRef.current = false;
            });
        };
        dragCleanupRef.current?.();
        dragCleanupRef.current = onUp;
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [auditionNote, beatsPerBar, clipBeats, drumMode, editorRootRef, enforceNoOverlap, isMac, noteHeight, notesRef, onNotesChange, pianoPencilMode, pixelsPerBeatRef, selectedNotes, setSelectedNotes, snapBeat, snapEnabled, tool, visiblePitches]);

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
