import { memo, useState, useCallback, useEffect } from 'react';
import { TOTAL_KEYS, ROOT_NOTES } from '@/widgets/PianoRoll/model/pianoRollConfig';
import { PianoRollToolbar } from '@/widgets/PianoRoll/ui/PianoRollToolbar';
import { PianoRollSidebarPanel } from '@/widgets/PianoRoll/ui/PianoRollSidebar';
import { PianoKeyboard } from '@/widgets/PianoRoll/ui/PianoKeyboard';
import { PianoRollGridViewport } from '@/widgets/PianoRoll/ui/PianoRollGridViewport';
import { usePianoRollLogic } from '@/widgets/PianoRoll/model/usePianoRollLogic';
import { usePianoRollGPU } from '@/widgets/PianoRoll/model/usePianoRollGPU';
import type { PianoRollProps } from '@/widgets/PianoRoll/model/pianoRollTypes';

export type { MidiNote, PianoRollTool } from '@/widgets/PianoRoll/model/pianoRollConfig';

export const PianoRoll = memo(function PianoRoll(props: PianoRollProps) {
    const {
        scrollRef,
        noteCanvasRef,
        gridViewportRef,
        keyboardScrollRef,
        editorRootRef,
        isDragInProgressRef,
        tool,
        setTool,
        selectedNotes,
        setSelectedNotes,
        selectionRect,
        containerWidth,
        noteHeight,
        setNoteHeight,
        isEditorFocused,
        setIsEditorFocused,
        highlightScale,
        setHighlightScale,
        rootNote,
        setRootNote,
        scaleName,
        setScaleName,
        clipTranspose,
        setClipTranspose,
        quantizeAmount,
        setQuantizeAmount,
        foldToUsedNotes,
        setFoldToUsedNotes,
        stepInputOctave,
        setStepInputOctave,
        stepInputCursorBeat,
        drumMode,
        setDrumMode,
        activeLane,
        setActiveLane,
        ratchetCount,
        setRatchetCount,
        laneValuesByNote,
        hoveredNoteEdge,
        setHoveredNoteEdge,
        zoomOverrideH,
        setZoomOverrideH,
        playheadBeat,
        pixelsPerBeat,
        totalBeats,
        clipBeats,
        canvasWidth,
        canvasHeight,
        visiblePitches,
        pitchRowIndex,
        scaleSet,
        gridLines,
        rulerBeatLabels,
        pianoKeys,
        currentGridInterval,
        beatsPerBar,
        clipDurationLabel,
        pitchToY,
        yToPitch,
        handleGridClick,
        handleGridDoubleClick,
        handleGridMouseDown,
        handleNoteClick,
        handleNoteDrag,
        handleNoteMouseMove,
        handleVelocityMouseDown,
        transposeNotes,
        quantizeAllNotesToGrid,
        duplicateSelection,
        humanizeSelection,
        applyLegato,
        applyRatchet,
        selectSamePitch,
        copySelection,
        pasteClipboard,
        readLaneValue,
        auditionNote,
        notes,
        ghostNotes,
        color,
        timeSignature,
        onNotesChange,
        onGenerateVariation,
        aiVariationBusy,
        trackIndex,
        clipStartBeat,
        snapBeat,
        pianoPencilMode,
        snapEnabled,
        gridDivision,
        gridTriplet,
        setGridDivision,
    } = usePianoRollLogic(props);

    void isDragInProgressRef;
    void setSelectedNotes;
    void containerWidth;
    void isEditorFocused;
    void clipTranspose;
    void setClipTranspose;
    void laneValuesByNote;
    void totalBeats;
    void pitchRowIndex;
    void currentGridInterval;
    void beatsPerBar;
    void yToPitch;
    void copySelection;
    void pasteClipboard;
    void timeSignature;
    void trackIndex;
    void clipStartBeat;
    void snapBeat;
    void pianoPencilMode;
    void snapEnabled;

    const [scrollX, setScrollX] = useState(0);
    const [scrollY, setScrollY] = useState(0);

    const handleGridScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        setScrollX(el.scrollLeft);
        setScrollY(el.scrollTop);
    }, [scrollRef]);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.addEventListener('scroll', handleGridScroll, { passive: true });
        handleGridScroll();
        return () => el.removeEventListener('scroll', handleGridScroll);
    }, [handleGridScroll, scrollRef]);

    const { gpuCanvasRef, gpuAvailable } = usePianoRollGPU({
        notes,
        ghostNotes,
        selectedNotes,
        canvasWidth,
        canvasHeight,
        pixelsPerBeat,
        noteHeight,
        color,
        scrollX,
        scrollY,
        beatsPerBar,
        gridInterval: currentGridInterval > 0 ? currentGridInterval : 0.25,
        totalBeats,
        totalPitches: TOTAL_KEYS,
        highlightScale,
        scaleRoot: ROOT_NOTES.indexOf(rootNote),
        playheadBeat,
        clipBeats,
    });

    return (
        <div
            ref={(el) => { editorRootRef.current = el; }}
            tabIndex={0}
            data-keyboard-scope="piano-roll"
            data-selected-notes={selectedNotes.size}
            onFocus={() => setIsEditorFocused(true)}
            onBlur={() => setIsEditorFocused(false)}
            onMouseDown={() => editorRootRef.current?.focus()}
            style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', background: 'var(--color-bg-base)', fontFamily: 'var(--font-family)', fontSize: 'var(--font-size-xs)' }}
        >
            <PianoRollToolbar
                editorRootRef={editorRootRef}
                tool={tool}
                setTool={setTool}
                color={color}
                gridDivision={gridDivision}
                setGridDivision={setGridDivision}
                highlightScale={highlightScale}
                setHighlightScale={setHighlightScale}
                rootNote={rootNote}
                setRootNote={setRootNote}
                scaleName={scaleName}
                setScaleName={setScaleName}
                clipDurationLabel={clipDurationLabel}
                duplicateSelection={duplicateSelection}
                quantizeAllNotesToGrid={quantizeAllNotesToGrid}
                selectSamePitch={selectSamePitch}
                quantizeAmount={quantizeAmount}
                setQuantizeAmount={setQuantizeAmount}
                applyLegato={applyLegato}
                humanizeSelection={humanizeSelection}
                ratchetCount={ratchetCount}
                setRatchetCount={setRatchetCount}
                applyRatchet={applyRatchet}
                foldToUsedNotes={foldToUsedNotes}
                setFoldToUsedNotes={setFoldToUsedNotes}
                drumMode={drumMode}
                setDrumMode={setDrumMode}
                stepInputOctave={stepInputOctave}
                setStepInputOctave={setStepInputOctave}
                stepInputCursorBeat={stepInputCursorBeat}
                activeLane={activeLane}
                setActiveLane={setActiveLane}
                onGenerateVariation={onGenerateVariation}
                aiVariationBusy={aiVariationBusy}
                zoomOverrideH={zoomOverrideH}
                noteHeight={noteHeight}
                setZoomOverrideH={setZoomOverrideH}
                setNoteHeight={setNoteHeight}
                selectedCount={selectedNotes.size}
                noteCount={notes.length}
            />

            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                <PianoRollSidebarPanel
                    clipDurationLabel={clipDurationLabel}
                    gridDivision={gridDivision}
                    gridTriplet={gridTriplet}
                    transposeNotes={transposeNotes}
                    clipTranspose={clipTranspose}
                    quantizeAllNotesToGrid={quantizeAllNotesToGrid}
                    setZoomOverrideH={setZoomOverrideH}
                    selectedNotes={selectedNotes}
                    notes={notes}
                    onNotesChange={onNotesChange}
                />

                <PianoKeyboard
                    keyboardScrollRef={keyboardScrollRef}
                    canvasHeight={canvasHeight}
                    pianoKeys={pianoKeys}
                    highlightScale={highlightScale}
                    drumMode={drumMode}
                    noteHeight={noteHeight}
                    auditionNote={auditionNote}
                />

                <PianoRollGridViewport
                    scrollRef={scrollRef}
                    gridViewportRef={gridViewportRef}
                    noteCanvasRef={noteCanvasRef}
                    gpuCanvasRef={gpuCanvasRef}
                    gpuAvailable={gpuAvailable}
                    canvasWidth={canvasWidth}
                    canvasHeight={canvasHeight}
                    clipBeats={clipBeats}
                    pixelsPerBeat={pixelsPerBeat}
                    color={color}
                    rulerBeatLabels={rulerBeatLabels}
                    gridLines={gridLines}
                    visiblePitches={visiblePitches}
                    noteHeight={noteHeight}
                    scaleSet={scaleSet}
                    highlightScale={highlightScale}
                    rootNote={rootNote}
                    notes={notes}
                    selectedNotes={selectedNotes}
                    tool={tool}
                    hoveredNoteEdge={hoveredNoteEdge}
                    setHoveredNoteEdge={setHoveredNoteEdge}
                    selectionRect={selectionRect}
                    playheadBeat={playheadBeat}
                    stepInputCursorBeat={stepInputCursorBeat}
                    activeLane={activeLane}
                    readLaneValue={readLaneValue}
                    onLaneMouseDown={handleVelocityMouseDown}
                    onGridScroll={handleGridScroll}
                    handleGridClick={handleGridClick}
                    handleGridDoubleClick={handleGridDoubleClick}
                    handleGridMouseDown={handleGridMouseDown}
                    handleNoteClick={handleNoteClick}
                    handleNoteDrag={handleNoteDrag}
                    handleNoteMouseMove={handleNoteMouseMove}
                    pitchToY={pitchToY}
                />
            </div>
        </div>
    );
});

export default PianoRoll;
