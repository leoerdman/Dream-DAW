import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
    DEFAULT_NOTE_HEIGHT,
    type MidiNote,
    type PianoLaneType,
    type PianoRollTool,
    type RootNote,
    type ScaleName,
} from './pianoRollConfig';

interface UsePianoRollStateArgs {
    notes: MidiNote[];
    clipLengthBeats?: number;
    clipStartBeat: number;
    trackIndex?: number;
}

export function usePianoRollState({
    notes,
    clipLengthBeats,
    clipStartBeat,
    trackIndex,
}: UsePianoRollStateArgs) {
    const [tool, setTool] = useState<PianoRollTool>('cursor');
    const [selectionRect, setSelectionRect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
    const [containerWidth, setContainerWidth] = useState(0);
    const [zoomOverrideH, setZoomOverrideH] = useState<number | null>(null);
    const [noteHeight, setNoteHeight] = useState(DEFAULT_NOTE_HEIGHT);
    const [isEditorFocused, setIsEditorFocused] = useState(false);
    const [highlightScale, setHighlightScale] = useState(false);
    const [rootNote, setRootNote] = useState<RootNote>('C');
    const [scaleName, setScaleName] = useState<ScaleName>('Major');
    const clipResetKey = `${clipLengthBeats ?? 'na'}:${clipStartBeat}:${trackIndex ?? -1}`;
    const clipTransposeStateKeyRef = useRef(clipResetKey);
    const [clipTransposeStateValue, setClipTransposeStateValue] = useState(0);

    // BUG-009 FIX: Moved from render-time setState to useEffect to avoid
    // double renders in React 18 Strict Mode. Render-time setState triggers
    // synchronous re-render which is wasteful and causes React warnings.
    useEffect(() => {
        if (clipTransposeStateKeyRef.current !== clipResetKey) {
            clipTransposeStateKeyRef.current = clipResetKey;
            setClipTransposeStateValue(0);
        }
    }, [clipResetKey]);
    const [quantizeAmount, setQuantizeAmount] = useState(100);
    const [foldToUsedNotes, setFoldToUsedNotes] = useState(false);
    const [stepInputOctave, setStepInputOctave] = useState(4);
    const [stepInputCursorBeat, setStepInputCursorBeat] = useState(0);
    const [drumMode, setDrumMode] = useState(false);
    const [noteAuditionEnabled, setNoteAuditionEnabled] = useState(true);
    const [activeLane, setActiveLane] = useState<PianoLaneType>('velocity');
    const [ratchetCount, setRatchetCount] = useState(2);
    const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(new Set());

    const notesRef = useRef(notes);
    const pixelsPerBeatRef = useRef(0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const gridViewportRef = useRef<HTMLDivElement>(null);
    const keyboardScrollRef = useRef<HTMLDivElement>(null);
    const editorRootRef = useRef<HTMLDivElement>(null);

    const clipTranspose = clipTransposeStateValue;
    const setClipTranspose = useCallback<Dispatch<SetStateAction<number>>>((next) => {
        setClipTransposeStateValue((prev) => {
            return typeof next === 'function'
                ? (next as (value: number) => number)(prev)
                : next;
        });
    }, []);

    const selectedNotes = useMemo(() => {
        const noteIdSet = new Set(notes.map((note) => note.id));
        let changed = false;
        const pruned = new Set<string>();
        for (const id of selectedNoteIds) {
            if (noteIdSet.has(id)) pruned.add(id);
            else changed = true;
        }
        return changed ? pruned : selectedNoteIds;
    }, [notes, selectedNoteIds]);

    useEffect(() => {
        if (selectedNotes === selectedNoteIds) return;
        // BUG-R4-044 FIX: queueMicrotask for guaranteed microtask-level deferral.
        queueMicrotask(() => setSelectedNoteIds(selectedNotes));
    }, [selectedNoteIds, selectedNotes]);

    const setSelectedNotes = useCallback<Dispatch<SetStateAction<Set<string>>>>((next) => {
        // BUG-PR03 FIX: Read notes from ref, not stale closure, so newly created
        // note IDs are not filtered out during rapid paint/paste operations.
        const noteIdSet = new Set(notesRef.current.map((note) => note.id));
        setSelectedNoteIds((prev) => {
            const candidate = typeof next === 'function'
                ? (next as (value: Set<string>) => Set<string>)(prev)
                : next;
            const normalized = new Set<string>();
            for (const id of candidate) if (noteIdSet.has(id)) normalized.add(id);
            return normalized;
        });
    }, [notesRef]);

    return useMemo(() => ({
        tool, setTool,
        selectedNotes, setSelectedNotes,
        selectionRect, setSelectionRect,
        containerWidth, setContainerWidth,
        zoomOverrideH, setZoomOverrideH,
        noteHeight, setNoteHeight,
        isEditorFocused, setIsEditorFocused,
        highlightScale, setHighlightScale,
        rootNote, setRootNote,
        scaleName, setScaleName,
        clipTranspose, setClipTranspose,
        quantizeAmount, setQuantizeAmount,
        foldToUsedNotes, setFoldToUsedNotes,
        stepInputOctave, setStepInputOctave,
        stepInputCursorBeat, setStepInputCursorBeat,
        drumMode, setDrumMode,
        noteAuditionEnabled, setNoteAuditionEnabled,
        activeLane, setActiveLane,
        ratchetCount, setRatchetCount,
        notesRef,
        pixelsPerBeatRef,
        scrollRef,
        gridViewportRef,
        keyboardScrollRef,
        editorRootRef,
    }), [
        tool, selectedNotes, setSelectedNotes, selectionRect,
        containerWidth, zoomOverrideH, noteHeight, isEditorFocused,
        highlightScale, rootNote, scaleName, clipTranspose, setClipTranspose,
        quantizeAmount, foldToUsedNotes, stepInputOctave, stepInputCursorBeat,
        drumMode, noteAuditionEnabled, activeLane, ratchetCount
    ]);
}
