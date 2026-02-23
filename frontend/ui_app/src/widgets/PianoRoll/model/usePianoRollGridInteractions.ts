import { useCallback, useRef } from 'react';
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
        onNotesChange(enforceNoOverlap([...notes, newNote], new Set([newNote.id])));
        auditionNote(pitch, 100, 160);
    }, [clipBeats, currentGridInterval, notes, onNotesChange, pixelsPerBeat, snapToCellStart, yToPitch, enforceNoOverlap, auditionNote]);

    const handleGridClick = useCallback((event: React.MouseEvent) => {
        editorRootRef.current?.focus();
        if (tool !== 'draw' || !pianoPencilMode) return;
        if (isDragSelectingRef.current || isDragInProgressRef.current) return;
        const now = Date.now();
        const last = lastInsertPosRef.current;
        const tooClose = last && now - last.t < 250 && Math.abs(event.clientX - last.x) < 6 && Math.abs(event.clientY - last.y) < 6;
        if (tooClose) return;
        lastInsertPosRef.current = { x: event.clientX, y: event.clientY, t: now };
        insertNoteFromPointer(event.clientX, event.clientY, event.currentTarget as HTMLElement);
    }, [editorRootRef, insertNoteFromPointer, isDragInProgressRef, pianoPencilMode, tool]);

    const handleGridDoubleClick = useCallback((event: React.MouseEvent) => {
        editorRootRef.current?.focus();
        if (tool !== 'draw' || pianoPencilMode || isDragInProgressRef.current) return;
        lastInsertPosRef.current = { x: event.clientX, y: event.clientY, t: Date.now() };
        insertNoteFromPointer(event.clientX, event.clientY, event.currentTarget as HTMLElement);
    }, [editorRootRef, insertNoteFromPointer, isDragInProgressRef, pianoPencilMode, tool]);

    const handleGridPaintStart = useCallback((event: React.MouseEvent) => {
        if (tool !== 'paint') return;
        editorRootRef.current?.focus();
        event.preventDefault();
        event.stopPropagation();
        const target = event.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        const step = currentGridInterval > 0 ? currentGridInterval : 0.25;
        const duration = Math.max(MIN_NOTE_BEATS, step);
        const beatKey = (beat: number) => Math.round(beat * 10000);
        let workingNotes = notesRef.current;
        const occupied = new Set(workingNotes.filter((note) => note.pitch === yToPitch(event.clientY - rect.top)).map((note) => `${note.pitch}:${beatKey(note.startBeat)}`));
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
        const onMove = (moveEvent: MouseEvent) => paintAt(moveEvent.clientX, moveEvent.clientY);
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [tool, editorRootRef, currentGridInterval, notesRef, yToPitch, clipBeats, snapToCellStart, pixelsPerBeat, enforceNoOverlap, onNotesChange, auditionNote]);

    const handleGridSelectionStart = useCallback((event: React.MouseEvent) => {
        if (tool === 'paint') return;
        editorRootRef.current?.focus();
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const startX = event.clientX - rect.left;
        const startY = event.clientY - rect.top;
        setSelectionRect({ x1: startX, y1: startY, x2: startX, y2: startY });
        isDragSelectingRef.current = false;
        const keepExisting = event.shiftKey;
        if (!keepExisting) setSelectedNotes(new Set());
        const onMove = (moveEvent: MouseEvent) => {
            isDragSelectingRef.current = true;
            const x = Math.max(0, Math.min(canvasWidth, moveEvent.clientX - rect.left));
            const y = Math.max(0, Math.min(canvasHeight, moveEvent.clientY - rect.top));
            setSelectionRect({ x1: startX, y1: startY, x2: x, y2: y });
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            setTimeout(() => { isDragSelectingRef.current = false; }, 0);
            setSelectionRect((current) => {
                if (!current) return null;
                const minX = Math.min(current.x1, current.x2);
                const maxX = Math.max(current.x1, current.x2);
                const minY = Math.min(current.y1, current.y2);
                const maxY = Math.max(current.y1, current.y2);
                if (Math.abs(maxX - minX) < 6 && Math.abs(maxY - minY) < 6) return null;
                const hits = new Set<string>();
                for (const note of notes) {
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
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [tool, editorRootRef, setSelectionRect, setSelectedNotes, canvasWidth, canvasHeight, notes, pixelsPerBeat, pitchToY, noteHeight]);

    const handleGridMouseDown = useCallback((event: React.MouseEvent) => {
        if (tool === 'paint') {
            handleGridPaintStart(event);
            return;
        }
        handleGridSelectionStart(event);
    }, [tool, handleGridPaintStart, handleGridSelectionStart]);

    return {
        handleGridClick,
        handleGridDoubleClick,
        handleGridMouseDown,
    };
}
