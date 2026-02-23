import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
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
    const [tool, setTool] = useState<PianoRollTool>('draw');
    const [selectionRect, setSelectionRect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
    const [containerWidth, setContainerWidth] = useState(0);
    const [zoomOverrideH, setZoomOverrideH] = useState<number | null>(null);
    const [noteHeight, setNoteHeight] = useState(DEFAULT_NOTE_HEIGHT);
    const [isEditorFocused, setIsEditorFocused] = useState(false);
    const [highlightScale, setHighlightScale] = useState(false);
    const [rootNote, setRootNote] = useState<RootNote>('C');
    const [scaleName, setScaleName] = useState<ScaleName>('Major');
    const clipResetKey = `${clipLengthBeats ?? 'na'}:${clipStartBeat}:${trackIndex ?? -1}`;
    const [clipTransposeState, setClipTransposeState] = useState<{ key: string; value: number }>({
        key: clipResetKey,
        value: 0,
    });
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

    const clipTranspose = clipTransposeState.key === clipResetKey ? clipTransposeState.value : 0;
    const setClipTranspose = useCallback<Dispatch<SetStateAction<number>>>((next) => {
        setClipTransposeState((prev) => {
            const current = prev.key === clipResetKey ? prev.value : 0;
            const resolved = typeof next === 'function'
                ? (next as (value: number) => number)(current)
                : next;
            return { key: clipResetKey, value: resolved };
        });
    }, [clipResetKey]);

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

    const setSelectedNotes = useCallback<Dispatch<SetStateAction<Set<string>>>>((next) => {
        const noteIdSet = new Set(notes.map((note) => note.id));
        setSelectedNoteIds((prev) => {
            const candidate = typeof next === 'function'
                ? (next as (value: Set<string>) => Set<string>)(prev)
                : next;
            const normalized = new Set<string>();
            for (const id of candidate) if (noteIdSet.has(id)) normalized.add(id);
            return normalized;
        });
    }, [notes]);

    return {
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
    };
}
