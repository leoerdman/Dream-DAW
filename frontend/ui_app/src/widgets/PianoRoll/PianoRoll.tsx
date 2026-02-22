// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — PianoRoll (MIDI Note Editor)
// ═══════════════════════════════════════════════════════════════════════════
// Architecture: Presentational component. All state/effects/callbacks
// delegated to usePianoRollLogic hook.
// ═══════════════════════════════════════════════════════════════════════════

import { memo } from 'react';
import {
    RULER_HEIGHT,
    VELOCITY_LANE_HEIGHT,
    ROOT_NOTES,
    isBlackKey,
} from '@/widgets/PianoRoll/model/pianoRollConfig';
import { PianoRollToolbar } from '@/widgets/PianoRoll/ui/PianoRollToolbar';
import { PianoRollSidebarPanel } from '@/widgets/PianoRoll/ui/PianoRollSidebar';
import { PianoKeyboard } from '@/widgets/PianoRoll/ui/PianoKeyboard';
import { PianoControlLane } from '@/widgets/PianoRoll/ui/PianoControlLane';
import { usePianoRollLogic, type PianoRollProps } from '@/widgets/PianoRoll/model/usePianoRollLogic';
export type { MidiNote, PianoRollTool } from '@/widgets/PianoRoll/model/pianoRollConfig';

export const PianoRoll = memo(function PianoRoll(props: PianoRollProps) {
    const {
        // Refs
        scrollRef, noteCanvasRef, gridViewportRef, keyboardScrollRef,
        editorRootRef, isDragInProgressRef,
        // State
        tool, setTool, selectedNotes, setSelectedNotes,
        selectionRect,
        containerWidth, noteHeight, setNoteHeight,
        isEditorFocused, setIsEditorFocused,
        highlightScale, setHighlightScale,
        rootNote, setRootNote,
        scaleName, setScaleName,
        clipTranspose, setClipTranspose,
        quantizeAmount, setQuantizeAmount,
        foldToUsedNotes, setFoldToUsedNotes,
        stepInputOctave, setStepInputOctave,
        stepInputCursorBeat,
        drumMode, setDrumMode,
        activeLane, setActiveLane,
        ratchetCount, setRatchetCount,
        laneValuesByNote,
        hoveredNoteEdge,
        zoomOverrideH, setZoomOverrideH,
        // Computed
        playheadBeat, pixelsPerBeat, totalBeats, clipBeats,
        canvasWidth, canvasHeight,
        visiblePitches, pitchRowIndex, scaleSet,
        gridLines, rulerBeatLabels, pianoKeys,
        currentGridInterval, beatsPerBar,
        clipDurationLabel,
        // Callbacks
        pitchToY, yToPitch,
        handleGridClick, handleGridDoubleClick,
        handleGridMouseDown,
        handleNoteClick, handleNoteDrag, handleNoteMouseMove,
        handleVelocityMouseDown,
        transposeNotes, quantizeAllNotesToGrid,
        duplicateSelection, humanizeSelection,
        applyLegato, applyRatchet, selectSamePitch,
        copySelection, pasteClipboard,
        readLaneValue, auditionNote,
        // Props passthrough
        notes, ghostNotes, color, timeSignature,
        onNotesChange, onGenerateVariation, aiVariationBusy,
        trackIndex, clipStartBeat,
        snapBeat, pianoPencilMode, snapEnabled,
        gridDivision, gridTriplet, setGridDivision,
    } = usePianoRollLogic(props);

    return (
        <div
            ref={(el) => {
                editorRootRef.current = el;
            }}
            tabIndex={0}
            data-keyboard-scope="piano-roll"
            data-selected-notes={selectedNotes.size}
            onFocus={() => setIsEditorFocused(true)}
            onBlur={() => setIsEditorFocused(false)}
            onMouseDown={() => editorRootRef.current?.focus()}
            style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                width: '100%',
                background: 'var(--color-bg-base)',
                fontFamily: 'var(--font-family)',
                fontSize: 'var(--font-size-xs)',
            }}
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

            {/* ── Main area ── */}
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
                    stopAudition={stopAudition}
                />

                {/* Grid area */}
                <div
                    ref={(el) => {
                        scrollRef.current = el;
                        gridViewportRef.current = el;
                    }}
                    style={{ flex: 1, overflow: 'auto', position: 'relative' }}
                >
                    <div style={{
                        width: canvasWidth,
                        height: RULER_HEIGHT + canvasHeight + VELOCITY_LANE_HEIGHT,
                        position: 'relative',
                    }}>
                        {/* ── Ruler ── */}
                        <div style={{
                            position: 'sticky',
                            top: 0,
                            left: 0,
                            width: canvasWidth,
                            height: RULER_HEIGHT,
                            zIndex: 'var(--z-sticky)' as unknown as number,
                            background: 'var(--color-bg-tertiary)',
                            borderBottom: '1px solid var(--color-divider)',
                            overflow: 'hidden',
                        }}>
                            {/* Clip region bar (Ableton-style colored stripe) */}
                            {/* BUG-11 FIX: Use clipBeats (actual clip duration) not canvasWidth
                                (totalBeats × ppb) which extends beyond the clip when zoomed out. */}
                            <div style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: clipBeats * pixelsPerBeat,
                                height: 3,
                                background: color,
                                opacity: 0.65,
                            }} />

                            {/* Beat labels (1.1, 1.2, 1.3...) */}
                            {rulerBeatLabels.map((label, idx) => (
                                <span
                                    key={`ruler-${idx}`}
                                    style={{
                                        position: 'absolute',
                                        left: label.x + 5,
                                        top: 6,
                                        fontSize: 'var(--font-size-2xs)',
                                        color: label.isBarStart
                                            ? 'var(--color-text-primary)'
                                            : 'var(--color-text-secondary)',
                                        fontWeight: label.isBarStart ? 700 : 500,
                                        fontFamily: 'var(--font-mono)',
                                        pointerEvents: 'none',
                                        userSelect: 'none',
                                    }}
                                >
                                    {label.text}
                                </span>
                            ))}

                            {/* Beat ticks */}
                            {gridLines.map((gl, idx) => (
                                <div
                                    key={`tick-${idx}`}
                                    style={{
                                        position: 'absolute',
                                        left: gl.x,
                                        bottom: 0,
                                        width: 1,
                                        height: gl.isBar ? 10 : 5,
                                        background: gl.isBar
                                            ? 'var(--color-grid-line-major)'
                                            : 'var(--color-grid-line)',
                                    }}
                                />
                            ))}

                            {/* Clip end marker */}
                            {/* BUG-P9 FIX: Use clipBeats * pixelsPerBeat (actual clip end)
                                not canvasWidth (zoom-dependent totalBeats × ppb) which drifts
                                past the real clip boundary when zoomed out. */}
                            <div style={{
                                position: 'absolute',
                                top: 0,
                                left: clipBeats * pixelsPerBeat - 2,
                                width: 2,
                                height: RULER_HEIGHT,
                                background: color,
                                opacity: 0.85,
                            }} />
                        </div>

                        {/* ── Grid (SVG with scale-aware row coloring) ── */}
                        <svg
                            width={canvasWidth}
                            height={canvasHeight}
                            style={{ position: 'absolute', top: RULER_HEIGHT, left: 0, pointerEvents: 'none' }}
                        >
                            {visiblePitches.map((pitch, i) => {
                                const black = isBlackKey(pitch);
                                const inScale = scaleSet ? scaleSet.has(pitch) : true;
                                const isRoot = highlightScale && ((pitch % 12) === ROOT_NOTES.indexOf(rootNote));
                                const isC = pitch % 12 === 0;

                                let fill: string;
                                if (highlightScale) {
                                    if (isRoot) {
                                        // Root note — strongest accent tint
                                        fill = `${color}20`;
                                    } else if (inScale) {
                                        // In-scale — subtle accent
                                        fill = black ? `${color}0c` : `${color}0a`;
                                    } else {
                                        // Out-of-scale — deeply dimmed
                                        fill = black ? '#111111' : '#161616';
                                    }
                                } else {
                                    // Default — use piano grid token colors
                                    // Fix: White key rows should be lighter than black key rows
                                    fill = black ? 'var(--color-piano-black-row)' : 'var(--color-piano-white-row)';
                                }

                                return (
                                    <g key={`row-${i}`}>
                                        <rect
                                            x={0}
                                            y={i * noteHeight}
                                            width={canvasWidth}
                                            height={noteHeight}
                                            fill={fill}
                                        />
                                        {/* Row bottom border */}
                                        <line
                                            x1={0}
                                            y1={(i + 1) * noteHeight}
                                            x2={canvasWidth}
                                            y2={(i + 1) * noteHeight}
                                            stroke={isC
                                                ? 'var(--color-piano-c-line)'
                                                : 'var(--color-border-subtle)'}
                                            strokeWidth={isC ? 1 : 0.5}
                                        />
                                    </g>
                                );
                            })}

                            {/* Vertical beat/bar lines */}
                            {gridLines.map((gl, idx) => (
                                <line
                                    key={`v-${idx}`}
                                    x1={gl.x}
                                    y1={0}
                                    x2={gl.x}
                                    y2={canvasHeight}
                                    stroke={
                                        gl.isBar
                                            ? 'var(--color-piano-bar)'
                                            : gl.isMainBeat
                                                ? 'var(--color-piano-beat)'
                                                : 'var(--color-border-subtle)'
                                    }
                                    strokeWidth={gl.isBar ? 1 : gl.isMainBeat ? 0.65 : 0.45}
                                />
                            ))}
                        </svg>

                        {/* ── Clickable grid ── */}
                        <div
                            onClick={handleGridClick}
                            onDoubleClick={handleGridDoubleClick}
                            onMouseDown={handleGridMouseDown}
                            style={{
                                position: 'absolute',
                                top: RULER_HEIGHT,
                                left: 0,
                                width: canvasWidth,
                                height: canvasHeight,
                                cursor:
                                    tool === 'draw' || tool === 'paint'
                                        ? 'crosshair'
                                        : 'default',
                            }}
                        >
                            <canvas
                                ref={noteCanvasRef}
                                style={{
                                    position: 'absolute',
                                    left: 0,
                                    top: 0,
                                    width: canvasWidth,
                                    height: canvasHeight,
                                    pointerEvents: 'none',
                                }}
                            />
                            {/* Interactive note overlays */}
                            {notes.map((note) => {
                                const x = note.startBeat * pixelsPerBeat;
                                const y = pitchToY(note.pitch);
                                if (y < 0) return null; // Bug #15: pitch not in visible row set
                                const w = note.durationBeats * pixelsPerBeat;
                                const isSelected = selectedNotes.has(note.id);

                                return (
                                    <div
                                        key={note.id}
                                        onClick={(e) => handleNoteClick(e, note.id)}
                                        onMouseDown={(e) => handleNoteDrag(e, note.id)}
                                        onMouseMove={(e) => handleNoteMouseMove(e, note.id)}
                                        onMouseLeave={() => setHoveredNoteEdge(null)}
                                        style={{
                                            position: 'absolute',
                                            left: x,
                                            top: y + 1,
                                            width: Math.max(4, w - 1),
                                            height: noteHeight - 2,
                                            background: 'transparent',
                                            borderRadius: 'var(--radius-xs)',
                                            cursor: tool === 'draw'
                                                ? 'pointer'
                                                : (hoveredNoteEdge === note.id ? 'col-resize' : 'grab'),
                                            zIndex: isSelected ? 5 : 2,
                                            pointerEvents: tool === 'paint' ? 'none' : 'auto',
                                        }}
                                    />
                                );
                            })}
                            {selectionRect && (
                                <div
                                    style={{
                                        position: 'absolute',
                                        left: Math.min(selectionRect.x1, selectionRect.x2),
                                        top: Math.min(selectionRect.y1, selectionRect.y2),
                                        width: Math.abs(selectionRect.x2 - selectionRect.x1),
                                        height: Math.abs(selectionRect.y2 - selectionRect.y1),
                                        background: 'var(--color-accent-primary-dim)',
                                        border: '1px solid color-mix(in srgb, var(--color-accent-primary) 85%, transparent)',
                                        borderRadius: 'var(--radius-xs)',
                                        pointerEvents: 'none',
                                        zIndex: 'var(--z-local-raised)' as unknown as number,
                                    }}
                                />
                            )}
                            {notes.length === 0 && (
                                <div style={{
                                    position: 'absolute',
                                    left: '50%',
                                    top: '50%',
                                    transform: 'translate(-50%, -50%)',
                                    pointerEvents: 'none',
                                    zIndex: 'var(--z-local-raised)' as unknown as number,
                                    textAlign: 'center',
                                    padding: '10px 14px',
                                    borderRadius: 'var(--radius-xl)',
                                    border: '1px solid color-mix(in srgb, var(--color-accent-primary) 35%, var(--color-divider))',
                                    background: 'color-mix(in srgb, var(--color-bg-header) 85%, #0b1525)',
                                    boxShadow: 'var(--shadow-lg)',
                                }}>
                                    <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-primary)', fontWeight: 'var(--font-weight-bold)' as unknown as number, marginBottom: 2 }}>
                                        Draw notes to start
                                    </div>
                                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                                        Draw tool click adds notes. `Q` quantize, `H` humanize, `L` legato.
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* ── Playhead ── */}
                        {/* Bug #38: Clamp playhead display to clip length so it doesn't
                            render past the visible clip boundary when looping. */}
                        {playheadBeat !== undefined && playheadBeat >= 0 && playheadBeat < clipBeats && (
                            <div style={{
                                position: 'absolute',
                                left: Math.min(playheadBeat, clipBeats) * pixelsPerBeat,
                                top: RULER_HEIGHT,
                                width: 2,
                                height: canvasHeight,
                                background: 'rgba(255, 255, 255, 0.95)',
                                zIndex: 'var(--z-header)' as unknown as number,
                                pointerEvents: 'none',
                                boxShadow: '0 0 6px rgba(255,255,255,0.45)',
                            }} />
                        )}

                        {stepInputCursorBeat > 0 && (
                            <div style={{
                                position: 'absolute',
                                left: stepInputCursorBeat * pixelsPerBeat,
                                top: RULER_HEIGHT,
                                width: 1,
                                height: canvasHeight,
                                background: 'color-mix(in srgb, var(--color-accent-primary) 90%, transparent)',
                                zIndex: 'var(--z-ui-overlay)' as unknown as number,
                                pointerEvents: 'none',
                            }} />
                        )}

                        <PianoControlLane
                            topOffset={RULER_HEIGHT}
                            canvasWidth={canvasWidth}
                            canvasHeight={canvasHeight}
                            notes={notes}
                            pixelsPerBeat={pixelsPerBeat}
                            activeLane={activeLane}
                            selectedNotes={selectedNotes}
                            color={color}
                            readLaneValue={readLaneValue}
                            onLaneMouseDown={handleVelocityMouseDown}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
});

export default PianoRoll;

