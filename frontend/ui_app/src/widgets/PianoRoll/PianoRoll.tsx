import { memo, useEffect } from 'react';
import { PianoRollToolbar } from '@/widgets/PianoRoll/ui/PianoRollToolbar';
import { PianoRollSidebarPanel } from '@/widgets/PianoRoll/ui/PianoRollSidebar';
import { PianoKeyboard } from '@/widgets/PianoRoll/ui/PianoKeyboard';
import { PianoRollGridViewport } from '@/widgets/PianoRoll/ui/PianoRollGridViewport';
import { usePianoRollLogic } from '@/widgets/PianoRoll/model/usePianoRollLogic';
import { useFocusPanelStore } from '@/shared/stores/useFocusPanelStore';
import type { PianoRollProps } from '@/widgets/PianoRoll/model/pianoRollTypes';

export type { MidiNote, PianoRollTool } from '@/widgets/PianoRoll/model/pianoRollConfig';

export const PianoRoll = memo(function PianoRoll(props: PianoRollProps) {
    const {
        scrollRef,
        noteCanvasRef,
        gridViewportRef,
        keyboardScrollRef,
        editorRootRef,
        tool,
        setTool,
        selectedNotes,
        selectionRect,
        noteHeight,
        setNoteHeight,
        setIsEditorFocused,
        highlightScale,
        setHighlightScale,
        rootNote,
        setRootNote,
        scaleName,
        setScaleName,
        quantizeAmount,
        setQuantizeAmount,
        foldToUsedNotes,
        setFoldToUsedNotes,
        stepInputOctave,
        setStepInputOctave,
        stepInputCursorBeat,
        drumMode,
        setDrumMode,
        noteAuditionEnabled,
        setNoteAuditionEnabled,
        activeLane,
        setActiveLane,
        ratchetCount,
        setRatchetCount,
        hoveredNoteEdge,
        setHoveredNoteEdge,
        zoomOverrideH,
        setZoomOverrideH,
        pixelsPerBeat,
        clipBeats,
        canvasWidth,
        canvasHeight,
        visiblePitches,
        scaleSet,
        gridLines,
        rulerBeatLabels,
        pianoKeys,
        clipDurationLabel,
        pitchToY,
        handleGridClick,
        handleGridDoubleClick,
        handleGridMouseDown,
        handleNoteClick,
        handleNoteDrag,
        handleNoteMouseMove,
        handleVelocityMouseDown,
        quantizeAllNotesToGrid,
        duplicateSelection,
        humanizeSelection,
        applyLegato,
        applyRatchet,
        selectSamePitch,
        readLaneValue,
        auditionNote,
        stopAudition,
        notes,
        color,
        onNotesChange,
        onGenerateVariation,
        aiVariationBusy,
        trackIndex,
        clipStartBeat,
        gridDivision,
        gridTriplet,
        setGridDivision,
    } = usePianoRollLogic(props);

    useEffect(() => {
        requestAnimationFrame(() => {
            const active = document.activeElement as HTMLElement | null;
            const editorRoot = editorRootRef.current;
            if (!editorRoot) return;
            if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
            if (active && editorRoot.contains(active)) return;
            editorRoot.focus({ preventScroll: true });
        });
    }, [editorRootRef, trackIndex, clipStartBeat, clipBeats]);

    return (
        <div
            ref={(el) => { editorRootRef.current = el; }}
            tabIndex={0}
            data-testid="piano-roll"
            data-keyboard-scope="piano-roll"
            data-selected-notes={selectedNotes.size}
            onFocus={() => setIsEditorFocused(true)}
            onBlur={() => setIsEditorFocused(false)}
            onPointerDown={() => { useFocusPanelStore.getState().setActivePanel('piano-roll'); editorRootRef.current?.focus(); }}
            style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', background: 'var(--color-bg-base)', fontFamily: 'var(--font-role-body)', fontSize: 'var(--font-size-xs)' }}
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
                noteAuditionEnabled={noteAuditionEnabled}
                setNoteAuditionEnabled={setNoteAuditionEnabled}
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
                    stopAudition={stopAudition}
                />

                <PianoRollGridViewport
                    scrollRef={scrollRef}
                    gridViewportRef={gridViewportRef}
                    noteCanvasRef={noteCanvasRef}
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
                    clipStartBeat={clipStartBeat}
                    stepInputCursorBeat={stepInputCursorBeat}
                    activeLane={activeLane}
                    readLaneValue={readLaneValue}
                    onLaneMouseDown={handleVelocityMouseDown}
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
