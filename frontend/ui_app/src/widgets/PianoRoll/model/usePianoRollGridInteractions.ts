import { useCallback, useEffect, useRef } from 'react';
import { MIN_NOTE_BEATS, genNoteId, type MidiNote, type PianoRollTool } from './pianoRollConfig';

interface UsePianoRollGridInteractionsArgs {
    tool: PianoRollTool;
    pianoPencilMode: boolean;
    editorRootRef: React.RefObject<HTMLDivElement | null>;
    isDragInProgressRef: React.RefObject<boolean>;
    notesRef: React.RefObject<MidiNote[]>;
    notes: MidiNote[];
    pixelsPerBeat: number;
    clipBeats: number;
    currentGridInterval: number;
    canvasWidth: number;
    canvasHeight: number;
    noteHeight: number;
    yToPitch: (y: number) => number;
    pitchToY: (pitch: number) => number;
    snapToCellStart: (rawBeat: number) => number;
    onNotesChange: (notes: MidiNote[]) => void;
    enforceNoOverlap: (input: MidiNote[], aggressorIds: Set<string>) => MidiNote[];
    auditionNote: (pitch: number, velocity?: number, durationMs?: number) => void;
    setSelectionRect: React.Dispatch<React.SetStateAction<{ x1: number; y1: number; x2: number; y2: number } | null>>;
    setSelectedNotes: React.Dispatch<React.SetStateAction<Set<string>>>;
}

export function usePianoRollGridInteractions({
    tool,
    pianoPencilMode,
    editorRootRef,
    isDragInProgressRef,
    notesRef,
    notes,
    pixelsPerBeat,
    clipBeats,
    currentGridInterval,
    canvasWidth,
    canvasHeight,
    noteHeight,
    yToPitch,
    pitchToY,
    snapToCellStart,
    onNotesChange,
    enforceNoOverlap,
    auditionNote,
    setSelectionRect,
    setSelectedNotes,
}: UsePianoRollGridInteractionsArgs) {
    const lastInsertPosRef = useRef<{ x: number; y: number; t: number } | null>(null);
    const isDragSelectingRef = useRef(false);
    const pointerCleanupRef = useRef<(() => void) | null>(null);

    useEffect(() => () => {
        pointerCleanupRef.current?.();
        pointerCleanupRef.current = null;
    }, []);

    const insertNoteFromPointer = useCallback((clientX: number, clientY: number, target: HTMLElement) => {
        const rect = target.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        const pitch = yToPitch(y);
        const beat = snapToCellStart(x / pixelsPerBeat);
        if (beat >= clipBeats) return;
        const gridStep = currentGridInterval > 0 ? currentGridInterval : 0.25;
        const duration = Math.max(MIN_NOTE_BEATS, Math.min(gridStep, clipBeats - beat));
        const newNote: MidiNote = { id: genNoteId(), pitch, startBeat: beat, durationBeats: duration, velocity: 100 };
        const currentNotes = notesRef.current;
        onNotesChange(enforceNoOverlap([...currentNotes, newNote], new Set([newNote.id])));
        auditionNote(pitch, 100, 160);
    }, [clipBeats, currentGridInterval, notesRef, onNotesChange, pixelsPerBeat, snapToCellStart, yToPitch, enforceNoOverlap, auditionNote]);

    const toggleNoteAtPointer = useCallback((clientX: number, clientY: number, target: HTMLElement) => {
        const rect = target.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        const pitch = yToPitch(y);
        const beat = snapToCellStart(x / pixelsPerBeat);
        if (beat >= clipBeats) return;
        const gridStep = currentGridInterval > 0 ? currentGridInterval : 0.25;
        const candidate = notesRef.current.find((note) => (
            note.pitch === pitch
            && beat >= note.startBeat - 1e-6
            && beat < (note.startBeat + note.durationBeats) + 1e-6
        ));
        if (candidate) {
            onNotesChange(notesRef.current.filter((note) => note.id !== candidate.id));
            setSelectedNotes((prev) => {
                const next = new Set(prev);
                next.delete(candidate.id);
                return next;
            });
            return;
        }
        const duration = Math.max(MIN_NOTE_BEATS, Math.min(gridStep, clipBeats - beat));
        const newNote: MidiNote = { id: genNoteId(), pitch, startBeat: beat, durationBeats: duration, velocity: 100 };
        onNotesChange(enforceNoOverlap([...notesRef.current, newNote], new Set([newNote.id])));
        setSelectedNotes(new Set([newNote.id]));
        auditionNote(pitch, 100, 160);
    }, [clipBeats, currentGridInterval, notesRef, onNotesChange, pixelsPerBeat, setSelectedNotes, snapToCellStart, yToPitch, enforceNoOverlap, auditionNote]);

    const handleGridClick = useCallback((event: React.MouseEvent) => {
        editorRootRef.current?.focus();
        if (event.button !== 0) return;
        if (tool === 'paint') return;
        if (!pianoPencilMode) return;
        if (isDragSelectingRef.current || isDragInProgressRef.current) return;
        const now = Date.now();
        const last = lastInsertPosRef.current;
        const tooClose = last && now - last.t < 250 && Math.abs(event.clientX - last.x) < 6 && Math.abs(event.clientY - last.y) < 6;
        if (tooClose) return;
        lastInsertPosRef.current = { x: event.clientX, y: event.clientY, t: now };
        toggleNoteAtPointer(event.clientX, event.clientY, event.currentTarget as HTMLElement);
    }, [editorRootRef, isDragInProgressRef, pianoPencilMode, toggleNoteAtPointer, tool]);

    const handleGridDoubleClick = useCallback((event: React.MouseEvent) => {
        editorRootRef.current?.focus();
        if (event.button !== 0) return;
        if (tool !== 'cursor' || pianoPencilMode || isDragInProgressRef.current) return;
        lastInsertPosRef.current = { x: event.clientX, y: event.clientY, t: Date.now() };
        insertNoteFromPointer(event.clientX, event.clientY, event.currentTarget as HTMLElement);
    }, [editorRootRef, insertNoteFromPointer, isDragInProgressRef, pianoPencilMode, tool]);

    const handleGridPaintStart = useCallback((event: React.MouseEvent) => {
        if (tool !== 'paint') return;
        if (event.button !== 0) return;
        editorRootRef.current?.focus();
        event.preventDefault();
        event.stopPropagation();
        const target = event.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        const step = currentGridInterval > 0 ? currentGridInterval : 0.25;
        const duration = Math.max(MIN_NOTE_BEATS, step);
        const beatKey = (beat: number) => Math.round(beat * 10000);
        let workingNotes = notesRef.current;
        // Bug #8 fix: Build occupied set from ALL pitches, not just the initial click pitch.
        const occupied = new Set(workingNotes.map((note) => `${note.pitch}:${beatKey(note.startBeat)}`));
        const paintAt = (clientX: number, clientY: number) => {
            const x = clientX - rect.left;
            const y = clientY - rect.top;
            const drawPitch = yToPitch(y);
            const beat = Math.max(0, Math.min(clipBeats - duration, snapToCellStart(x / pixelsPerBeat)));
            const key = `${drawPitch}:${beatKey(beat)}`;
            if (occupied.has(key)) return;
            const hasOverlap = workingNotes.some((note) => note.pitch === drawPitch && note.startBeat < beat + duration && note.startBeat + note.durationBeats > beat);
            if (hasOverlap) return;
            occupied.add(key);
            const newNote: MidiNote = { id: genNoteId(), pitch: drawPitch, startBeat: beat, durationBeats: duration, velocity: 100 };
            workingNotes = enforceNoOverlap([...workingNotes, newNote], new Set([newNote.id]));
            onNotesChange(workingNotes);
            auditionNote(drawPitch, 100, 95);
        };
        paintAt(event.clientX, event.clientY);
        // ENTERPRISE FIX (Phase 33): Pointer events for interrupt safety.
        const onMove = (moveEvent: PointerEvent) => paintAt(moveEvent.clientX, moveEvent.clientY);
        const cleanup = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            pointerCleanupRef.current = null;
        };
        const onUp = () => { cleanup(); };
        pointerCleanupRef.current?.();
        pointerCleanupRef.current = cleanup;
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    }, [tool, editorRootRef, currentGridInterval, notesRef, yToPitch, clipBeats, snapToCellStart, pixelsPerBeat, enforceNoOverlap, onNotesChange, auditionNote]);

    const handleGridSelectionStart = useCallback((event: React.MouseEvent) => {
        if (tool === 'paint') return;
        if (event.button !== 0) return;
        editorRootRef.current?.focus();
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const startX = event.clientX - rect.left;
        const startY = event.clientY - rect.top;
        setSelectionRect({ x1: startX, y1: startY, x2: startX, y2: startY });
        isDragSelectingRef.current = false;
        const keepExisting = event.shiftKey;
        if (!keepExisting) setSelectedNotes(new Set());
        // ENTERPRISE FIX (Phase 33): Pointer events for interrupt safety.
        const onMove = (moveEvent: PointerEvent) => {
            isDragSelectingRef.current = true;
            const x = Math.max(0, Math.min(canvasWidth, moveEvent.clientX - rect.left));
            const y = Math.max(0, Math.min(canvasHeight, moveEvent.clientY - rect.top));
            setSelectionRect({ x1: startX, y1: startY, x2: x, y2: y });
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            pointerCleanupRef.current = null;
            isDragSelectingRef.current = false;
            setSelectionRect((current) => {
                if (!current) return null;
                const minX = Math.min(current.x1, current.x2);
                const maxX = Math.max(current.x1, current.x2);
                const minY = Math.min(current.y1, current.y2);
                const maxY = Math.max(current.y1, current.y2);
                if (Math.abs(maxX - minX) < 6 && Math.abs(maxY - minY) < 6) return null;
                const hits = new Set<string>();
                // BUG-PR02 FIX: Read fresh notes from ref instead of stale closure.
                const currentNotes = notesRef.current;
                for (const note of currentNotes) {
                    const nx = note.startBeat * pixelsPerBeat;
                    const rawNy = pitchToY(note.pitch);
                    if (rawNy < 0) continue;
                    const ny = rawNy + 1;
                    const nw = Math.max(4, note.durationBeats * pixelsPerBeat - 1);
                    const nh = noteHeight - 2;
                    if (nx < maxX && nx + nw > minX && ny < maxY && ny + nh > minY) hits.add(note.id);
                }
                setSelectedNotes((prev) => keepExisting ? new Set([...prev, ...hits]) : hits);
                return null;
            });
        };
        pointerCleanupRef.current?.();
        pointerCleanupRef.current = onUp;
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    }, [tool, editorRootRef, setSelectionRect, setSelectedNotes, canvasWidth, canvasHeight, notes, pixelsPerBeat, pitchToY, noteHeight]);

    const handleGridMouseDown = useCallback((event: React.MouseEvent) => {
        if (tool === 'paint') {
            handleGridPaintStart(event);
            return;
        }
        if (pianoPencilMode) return;
        handleGridSelectionStart(event);
    }, [tool, pianoPencilMode, handleGridPaintStart, handleGridSelectionStart]);

    return {
        handleGridClick,
        handleGridDoubleClick,
        handleGridMouseDown,
    };
}
