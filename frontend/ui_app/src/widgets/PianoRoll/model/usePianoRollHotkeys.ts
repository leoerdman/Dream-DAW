import { useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
    genNoteId,
    HIGHEST_PITCH,
    LOWEST_PITCH,
    MIN_NOTE_BEATS,
    type MidiNote,
} from '@/widgets/PianoRoll/model/pianoRollConfig';

interface UsePianoRollHotkeysParams {
    isEditorFocused: boolean;
    selectedNotes: Set<string>;
    notes: MidiNote[];
    onNotesChange: (notes: MidiNote[]) => void;
    currentGridInterval: number;
    clipBeats: number;
    duplicateSelection: () => void;
    quantizeAllNotesToGrid: (amountPct?: number) => void;
    quantizeAmount: number;
    humanizeSelection: () => void;
    applyLegato: () => void;
    copySelection: () => void;
    pasteClipboard: () => void;
    selectSamePitch: () => void;
    stepInputOctave: number;
    setStepInputOctave: Dispatch<SetStateAction<number>>;
    stepInputCursorBeat: number;
    setStepInputCursorBeat: Dispatch<SetStateAction<number>>;
    pixelsPerBeat: number;
    snapBeat: (beat: number, beatsPerBar: number, pixelsPerBeat: number) => number;
    beatsPerBar: number;
    auditionNote: (pitch: number, velocity?: number, durationMs?: number) => void;
    enforceNoOverlap: (input: MidiNote[], aggressorIds: Set<string>) => MidiNote[];
    setSelectedNotes: Dispatch<SetStateAction<Set<string>>>;
    editorRootRef: RefObject<HTMLDivElement | null>;
    setClipTranspose: Dispatch<SetStateAction<number>>;
}

export function usePianoRollHotkeys({
    isEditorFocused,
    selectedNotes,
    notes,
    onNotesChange,
    currentGridInterval,
    clipBeats,
    duplicateSelection,
    quantizeAllNotesToGrid,
    quantizeAmount,
    humanizeSelection,
    applyLegato,
    copySelection,
    pasteClipboard,
    selectSamePitch,
    stepInputOctave,
    setStepInputOctave,
    stepInputCursorBeat,
    setStepInputCursorBeat,
    pixelsPerBeat,
    snapBeat,
    beatsPerBar,
    auditionNote,
    enforceNoOverlap,
    setSelectedNotes,
    editorRootRef,
    setClipTranspose,
}: UsePianoRollHotkeysParams) {
    useEffect(() => {
        if (!isEditorFocused) return;

        const onKeyDown = (e: KeyboardEvent) => {
            const active = document.activeElement as HTMLElement | null;
            if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
            if (active?.closest?.('[data-assistant-chat]')) return;

            const hasSelected = selectedNotes.size > 0;
            const stepBeatRaw = currentGridInterval;
            const stepBeat = stepBeatRaw > 0 ? stepBeatRaw : 0.25;

            if (e.key === 'Escape') {
                e.preventDefault();
                setSelectedNotes(new Set());
                return;
            }

            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (!hasSelected) return;
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                onNotesChange(notes.filter((n) => !selectedNotes.has(n.id)));
                setSelectedNotes(new Set());
                return;
            }

            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyX') {
                e.preventDefault();
                e.stopPropagation();
                copySelection();
                if (selectedNotes.size > 0) {
                    onNotesChange(notes.filter((n) => !selectedNotes.has(n.id)));
                    setSelectedNotes(new Set());
                }
                return;
            }

            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC') {
                e.preventDefault();
                e.stopPropagation();
                copySelection();
                return;
            }

            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') {
                e.preventDefault();
                e.stopPropagation();
                pasteClipboard();
                return;
            }

            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyA') {
                e.preventDefault();
                e.stopPropagation();
                setSelectedNotes(new Set(notes.map((n) => n.id)));
                return;
            }

            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyD') {
                e.preventDefault();
                e.stopPropagation();
                duplicateSelection();
                return;
            }

            if (!e.ctrlKey && !e.metaKey && e.code === 'KeyQ') {
                e.preventDefault();
                e.stopPropagation();
                quantizeAllNotesToGrid(e.shiftKey ? 100 : quantizeAmount);
                return;
            }

            if (!e.ctrlKey && !e.metaKey && e.code === 'KeyH') {
                e.preventDefault();
                e.stopPropagation();
                humanizeSelection();
                return;
            }

            if (!e.ctrlKey && !e.metaKey && e.code === 'KeyL') {
                e.preventDefault();
                e.stopPropagation();
                applyLegato();
                return;
            }

            if (e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyP') {
                e.preventDefault();
                e.stopPropagation();
                selectSamePitch();
                return;
            }

            if (!e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'BracketLeft') {
                e.preventDefault();
                setStepInputOctave((prev) => Math.max(0, prev - 1));
                return;
            }

            if (!e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'BracketRight') {
                e.preventDefault();
                setStepInputOctave((prev) => Math.min(9, prev + 1));
                return;
            }

            if (!e.ctrlKey && !e.metaKey && !e.altKey && !hasSelected && document.activeElement === editorRootRef.current) {
                const keyToSemitone: Record<string, number> = {
                    KeyA: 0,
                    KeyW: 1,
                    KeyS: 2,
                    KeyE: 3,
                    KeyD: 4,
                    KeyF: 5,
                    KeyT: 6,
                    KeyG: 7,
                    KeyY: 8,
                    KeyH: 9,
                    KeyU: 10,
                    KeyJ: 11,
                    KeyK: 12,
                };
                if (Object.prototype.hasOwnProperty.call(keyToSemitone, e.code)) {
                    e.preventDefault();
                    e.stopPropagation();
                    const semitone = keyToSemitone[e.code];
                    const pitch = Math.max(LOWEST_PITCH, Math.min(HIGHEST_PITCH, stepInputOctave * 12 + semitone));
                    const step = currentGridInterval > 0 ? currentGridInterval : 0.25;
                    const beat = Math.max(0, Math.min(clipBeats - step, snapBeat(stepInputCursorBeat, beatsPerBar, pixelsPerBeat)));
                    if (beat >= clipBeats) return;
                    const newNote: MidiNote = {
                        id: genNoteId(),
                        pitch,
                        startBeat: beat,
                        durationBeats: Math.min(step, clipBeats - beat),
                        velocity: 100,
                    };
                    onNotesChange(enforceNoOverlap([...notes, newNote], new Set([newNote.id])));
                    setSelectedNotes(new Set([newNote.id]));
                    setStepInputCursorBeat((prev) => Math.min(clipBeats, prev + step));
                    auditionNote(pitch, 100, 170);
                    return;
                }
            }

            if (!hasSelected) return;
            if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;

            e.preventDefault();
            e.stopPropagation();

            const beatStep = stepBeat;
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                const pitchStep = e.shiftKey ? 12 : 1;
                const direction = e.key === 'ArrowUp' ? 1 : -1;
                const delta = pitchStep * direction;
                const moved = notes.map((n) => {
                    if (!selectedNotes.has(n.id)) return n;
                    return { ...n, pitch: Math.max(LOWEST_PITCH, Math.min(HIGHEST_PITCH, n.pitch + delta)) };
                });
                setClipTranspose((prev) => Math.max(-24, Math.min(24, prev + delta)));
                onNotesChange(enforceNoOverlap(moved, selectedNotes));
                return;
            }

            const moved = notes.map((n) => {
                if (!selectedNotes.has(n.id)) return n;
                if (e.shiftKey && e.key === 'ArrowLeft') {
                    return { ...n, durationBeats: Math.max(MIN_NOTE_BEATS, n.durationBeats - beatStep) };
                }
                if (e.shiftKey && e.key === 'ArrowRight') {
                    const maxDur = clipBeats - n.startBeat;
                    return { ...n, durationBeats: Math.min(maxDur, n.durationBeats + beatStep) };
                }
                if (e.key === 'ArrowLeft') {
                    return { ...n, startBeat: Math.max(0, n.startBeat - beatStep) };
                }
                return { ...n, startBeat: Math.min(clipBeats - MIN_NOTE_BEATS, n.startBeat + beatStep) };
            });
            onNotesChange(enforceNoOverlap(moved, selectedNotes));
        };

        const editorRoot = editorRootRef.current;
        if (!editorRoot) return;
        editorRoot.addEventListener('keydown', onKeyDown, { capture: true });
        return () => editorRoot.removeEventListener('keydown', onKeyDown, { capture: true });
    }, [
        isEditorFocused,
        selectedNotes,
        notes,
        onNotesChange,
        currentGridInterval,
        clipBeats,
        duplicateSelection,
        quantizeAllNotesToGrid,
        quantizeAmount,
        humanizeSelection,
        applyLegato,
        copySelection,
        pasteClipboard,
        selectSamePitch,
        stepInputOctave,
        stepInputCursorBeat,
        pixelsPerBeat,
        snapBeat,
        beatsPerBar,
        auditionNote,
        enforceNoOverlap,
        setSelectedNotes,
        editorRootRef,
        setStepInputOctave,
        setStepInputCursorBeat,
        setClipTranspose,
    ]);
}
