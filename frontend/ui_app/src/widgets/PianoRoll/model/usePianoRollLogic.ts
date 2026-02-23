import { useCallback, useEffect, useMemo, type MouseEvent } from 'react';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { divisionToInterval } from '@/shared/lib/gridSnap';
import { MAX_PPB, MIN_PPB } from '@/widgets/PianoRoll/model/pianoRollConfig';
import type { PianoRollProps } from '@/widgets/PianoRoll/model/pianoRollTypes';
import { usePianoRollAudition } from './usePianoRollAudition';
import { usePianoRollClipboard } from './usePianoRollClipboard';
import { usePianoRollLaneValues } from './usePianoRollLaneValues';
import { usePianoRollDerivedView } from './usePianoRollDerivedView';
import { usePianoRollGridInteractions } from './usePianoRollGridInteractions';
import { usePianoRollNoteInteractions } from './usePianoRollNoteInteractions';
import { usePianoRollViewport } from './usePianoRollViewport';
import { usePianoRollNoteMath } from './usePianoRollNoteMath';
import { usePianoRollEditorPipeline } from './usePianoRollEditorPipeline';
import { usePianoRollState } from './usePianoRollState';
import { composePianoRollLogicResult } from './pianoRollLogicResult';
const isMac: boolean = (() => {
    const uad = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
    if (uad?.platform) return uad.platform === 'macOS';
    return /mac/i.test(navigator.userAgent) && !/iphone|ipad/i.test(navigator.userAgent);
})();

export function usePianoRollLogic(props: PianoRollProps) {
    const {
        notes,
        ghostNotes = [],
        trackIndex,
        midiEnvelopes = [],
        onSetMidiEnvelopes,
        onNotesChange,
        onGenerateVariation,
        aiVariationBusy = false,
        color = 'var(--token-color-hex-4a9eff)',
        timeSignature = [4, 4],
        totalBars = 8,
        playheadBeat: playheadBeatProp,
        clipStartBeat = 0,
        clipLengthBeats,
    } = props;

    const storePositionBeats = useEngineStore((s) => s.transport.position_beats ?? 0);
    const playheadBeat = playheadBeatProp ?? (storePositionBeats - clipStartBeat);
    const pianoState = usePianoRollState({
        notes,
        clipLengthBeats,
        clipStartBeat,
        trackIndex,
    });
    const {
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
    } = pianoState;
    const { auditionNote } = usePianoRollAudition(trackIndex, noteAuditionEnabled);

    const { laneValuesByNote, setLaneValuesByNote, readLaneValue, handleVelocityMouseDown } = usePianoRollLaneValues({
        midiEnvelopes,
        notes,
        onSetMidiEnvelopes,
        selectedNotes,
        setSelectedNotes,
        activeLane,
        onNotesChange,
        auditionNote,
    });

    const snapBeat = useGridStore((s) => s.snapBeat);
    const pianoPencilMode = useGridStore((s) => s.pianoPencilMode);
    const gridDivision = useGridStore((s) => s.division);
    const gridTriplet = useGridStore((s) => s.triplet);
    const setGridDivision = useGridStore((s) => s.setDivision);

    const beatsPerBar = timeSignature[0];
    const currentGridInterval = useMemo(
        () => divisionToInterval(gridDivision, beatsPerBar, gridTriplet),
        [gridDivision, beatsPerBar, gridTriplet],
    );
    const clipBeats = Math.max(0.25, clipLengthBeats ?? (totalBars * beatsPerBar));

    const gridAreaWidth = Math.max(100, containerWidth);
    const autoFitPPB = Math.min(MAX_PPB, gridAreaWidth / clipBeats);
    const pixelsPerBeat = zoomOverrideH != null
        ? Math.max(MIN_PPB, Math.min(MAX_PPB, zoomOverrideH))
        : autoFitPPB;
    useEffect(() => {
        notesRef.current = notes;
        pixelsPerBeatRef.current = pixelsPerBeat;
    }, [notes, notesRef, pixelsPerBeat, pixelsPerBeatRef]);
    const totalBeats = Math.max(clipBeats, gridAreaWidth / pixelsPerBeat);

    const { enforceNoOverlap, snapToCellStart } = usePianoRollNoteMath(clipBeats, currentGridInterval);
    const { copySelection, pasteClipboard } = usePianoRollClipboard({
        notes,
        selectedNotes,
        playheadBeat,
        clipBeats,
        onNotesChange,
        setSelectedNotes,
        enforceNoOverlap,
    });

    const {
        visiblePitches,
        pitchRowIndex,
        pitchToY,
        yToPitch,
        scaleSet,
        gridLines,
        rulerBeatLabels,
        pianoKeys,
    } = usePianoRollDerivedView({
        drumMode,
        foldToUsedNotes,
        notes,
        highlightScale,
        rootNote,
        scaleName,
        noteHeight,
        totalBeats,
        beatsPerBar,
        pixelsPerBeat,
        currentGridInterval,
    });

    const canvasWidth = totalBeats * pixelsPerBeat;
    const canvasHeight = visiblePitches.length * noteHeight;

    usePianoRollViewport({
        trackIndex,
        notes,
        clipLengthBeats,
        noteHeight,
        setNoteHeight,
        setZoomOverrideH,
        pixelsPerBeatRef,
        scrollRef,
        keyboardScrollRef,
        gridViewportRef,
        setContainerWidth,
        visiblePitches,
        pitchToY,
    });

    const snapEnabled = useGridStore((s) => s.snapEnabled);
    const {
        isDragInProgressRef,
        hoveredNoteEdge,
        setHoveredNoteEdge,
        handleNoteClick,
        handleNoteDrag,
        handleNoteMouseMove,
    } = usePianoRollNoteInteractions({
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
    });
    const { handleGridClick, handleGridDoubleClick, handleGridMouseDown } = usePianoRollGridInteractions({
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
    });

    const handleVelocityMouseDownWithFocus = useCallback((noteId: string, event: MouseEvent) => {
        editorRootRef.current?.focus();
        handleVelocityMouseDown(noteId, event);
    }, [editorRootRef, handleVelocityMouseDown]);
    const {
        noteCanvasRef,
        applyRatchet,
        transposeNotes,
        quantizeAllNotesToGrid,
        duplicateSelection,
        selectSamePitch,
        humanizeSelection,
        applyLegato,
        clipDurationLabel,
    } = usePianoRollEditorPipeline({
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
    });
    return composePianoRollLogicResult({
        refs: { scrollRef, noteCanvasRef, gridViewportRef, keyboardScrollRef, editorRootRef, isDragInProgressRef },
        state: {
            tool, setTool, selectedNotes, setSelectedNotes, selectionRect, setSelectionRect,
            containerWidth, noteHeight, setNoteHeight, isEditorFocused, setIsEditorFocused,
            highlightScale, setHighlightScale, rootNote, setRootNote, scaleName, setScaleName,
            clipTranspose, setClipTranspose, quantizeAmount, setQuantizeAmount,
            foldToUsedNotes, setFoldToUsedNotes, stepInputOctave, setStepInputOctave,
            stepInputCursorBeat, setStepInputCursorBeat, drumMode, setDrumMode,
            noteAuditionEnabled, setNoteAuditionEnabled,
            activeLane, setActiveLane, ratchetCount, setRatchetCount,
            laneValuesByNote, setLaneValuesByNote, hoveredNoteEdge, setHoveredNoteEdge,
            zoomOverrideH, setZoomOverrideH,
        },
        computed: {
            playheadBeat, pixelsPerBeat, totalBeats, clipBeats, canvasWidth, canvasHeight,
            visiblePitches, pitchRowIndex, scaleSet, gridLines, rulerBeatLabels, pianoKeys,
            currentGridInterval, beatsPerBar, clipDurationLabel,
        },
        callbacks: {
            pitchToY, yToPitch, handleGridClick, handleGridDoubleClick, handleGridMouseDown,
            handleNoteClick, handleNoteDrag, handleNoteMouseMove,
            handleVelocityMouseDown: handleVelocityMouseDownWithFocus,
            transposeNotes, quantizeAllNotesToGrid, duplicateSelection, humanizeSelection,
            applyLegato, applyRatchet, selectSamePitch, copySelection, pasteClipboard,
            readLaneValue, auditionNote,
        },
        passthrough: {
            notes, ghostNotes, color, timeSignature, onNotesChange, onGenerateVariation,
            aiVariationBusy, trackIndex, clipStartBeat, snapBeat, pianoPencilMode,
            snapEnabled, gridDivision, gridTriplet, setGridDivision,
        },
    });
}
