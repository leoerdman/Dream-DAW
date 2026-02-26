import { useMemo } from 'react';
import { usePianoRollCanvasEngine } from './usePianoRollCanvasEngine';
import { usePianoRollHotkeys } from './usePianoRollHotkeys';
import { usePianoRollTransforms } from './usePianoRollTransforms';
import { usePianoRollWebGPUCanvasEngine } from './usePianoRollWebGPUCanvasEngine';
import type { MidiNote } from './pianoRollConfig';
import { formatBeatsAsBBS } from '@/shared/lib/audioMath';

interface UsePianoRollEditorPipelineArgs {
    notes: MidiNote[];
    ghostNotes: MidiNote[];
    selectedNotes: Set<string>;
    ratchetCount: number;
    currentGridInterval: number;
    quantizeAmount: number;
    clipBeats: number;
    beatsPerBar: number;
    pixelsPerBeat: number;
    snapBeat: (beat: number, beatsPerBar?: number, pixelsPerBeat?: number) => number;
    onNotesChange: (notes: MidiNote[]) => void;
    enforceNoOverlap: (input: MidiNote[], aggressorIds: Set<string>) => MidiNote[];
    setSelectedNotes: React.Dispatch<React.SetStateAction<Set<string>>>;
    setClipTranspose: React.Dispatch<React.SetStateAction<number>>;
    isEditorFocused: boolean;
    stepInputOctave: number;
    setStepInputOctave: React.Dispatch<React.SetStateAction<number>>;
    stepInputCursorBeat: number;
    setStepInputCursorBeat: React.Dispatch<React.SetStateAction<number>>;
    auditionNote: (pitch: number, velocity?: number, durationMs?: number) => void;
    editorRootRef: React.RefObject<HTMLDivElement | null>;
    color: string;
    canvasWidth: number;
    canvasHeight: number;
    noteHeight: number;
    pitchToY: (pitch: number) => number;
    copySelection: () => void;
    pasteClipboard: () => void;
}

export function usePianoRollEditorPipeline({
    notes,
    ghostNotes,
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
    isEditorFocused,
    stepInputOctave,
    setStepInputOctave,
    stepInputCursorBeat,
    setStepInputCursorBeat,
    auditionNote,
    editorRootRef,
    color,
    canvasWidth,
    canvasHeight,
    noteHeight,
    pitchToY,
    copySelection,
    pasteClipboard,
}: UsePianoRollEditorPipelineArgs) {
    const {
        applyRatchet,
        transposeNotes,
        quantizeAllNotesToGrid,
        duplicateSelection,
        selectSamePitch,
        humanizeSelection,
        applyLegato,
    } = usePianoRollTransforms({
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
    });

    const { gpuCanvasRef, webGpuActive } = usePianoRollWebGPUCanvasEngine({
        notes,
        ghostNotes,
        selectedNotes,
        canvasWidth,
        canvasHeight,
        pixelsPerBeat,
        noteHeight,
        color,
        pitchToY,
    });

    const { noteCanvasRef: cpuCanvasRef } = usePianoRollCanvasEngine({
        notes,
        ghostNotes,
        selectedNotes,
        canvasWidth,
        canvasHeight,
        pixelsPerBeat,
        noteHeight,
        color,
        pitchToY,
        disabled: webGpuActive,
    });
    const noteCanvasRef = webGpuActive ? gpuCanvasRef : cpuCanvasRef;

    usePianoRollHotkeys({
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
    });

    const clipDurationLabel = useMemo(() => {
        return formatBeatsAsBBS(clipBeats, beatsPerBar);
    }, [clipBeats, beatsPerBar]);

    return {
        noteCanvasRef,
        applyRatchet,
        transposeNotes,
        quantizeAllNotesToGrid,
        duplicateSelection,
        selectSamePitch,
        humanizeSelection,
        applyLegato,
        clipDurationLabel,
    };
}
