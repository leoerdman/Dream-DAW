import { memo, type MouseEvent, type MutableRefObject, type RefObject } from 'react';
import {
    RULER_HEIGHT,
    VELOCITY_LANE_HEIGHT,
    ROOT_NOTES,
    isBlackKey,
    type MidiNote,
    type PianoLaneType,
    type RootNote,
} from '@/widgets/PianoRoll/model/pianoRollConfig';
import { PianoControlLane } from '@/widgets/PianoRoll/ui/PianoControlLane';
import { ClipEditorRuler } from '@/widgets/ClipEditor/ClipEditorRuler';
import { PianoRollPlayhead } from '@/widgets/PianoRoll/ui/PianoRollPlayhead';

type SelectionRect = { x1: number; y1: number; x2: number; y2: number } | null;
type GridLine = { x: number; isBar: boolean; isMainBeat: boolean; label?: string };
type RulerLabel = { x: number; text: string; isBarStart: boolean };

interface PianoRollGridViewportProps {
    scrollRef: MutableRefObject<HTMLDivElement | null>;
    gridViewportRef: MutableRefObject<HTMLDivElement | null>;
    noteCanvasRef: RefObject<HTMLCanvasElement | null>;
    canvasWidth: number;
    canvasHeight: number;
    clipBeats: number;
    pixelsPerBeat: number;
    color: string;
    rulerBeatLabels: RulerLabel[];
    gridLines: GridLine[];
    visiblePitches: number[];
    noteHeight: number;
    scaleSet: Set<number> | null;
    highlightScale: boolean;
    rootNote: RootNote;
    notes: MidiNote[];
    selectedNotes: Set<string>;
    tool: 'cursor' | 'paint';
    hoveredNoteEdge: string | null;
    setHoveredNoteEdge: (value: string | null) => void;
    selectionRect: SelectionRect;
    clipStartBeat: number;
    stepInputCursorBeat: number;
    activeLane: PianoLaneType;
    readLaneValue: (note: MidiNote, lane: PianoLaneType) => number;
    onLaneMouseDown: (noteId: string, event: MouseEvent) => void;
    handleGridClick: (event: MouseEvent) => void;
    handleGridDoubleClick: (event: MouseEvent) => void;
    handleGridMouseDown: (event: MouseEvent) => void;
    handleNoteClick: (event: MouseEvent, noteId: string) => void;
    handleNoteDrag: (event: MouseEvent, noteId: string) => void;
    handleNoteMouseMove: (event: MouseEvent, noteId: string) => void;
    pitchToY: (pitch: number) => number;
}

export const PianoRollGridViewport = memo(function PianoRollGridViewport({
    scrollRef,
    gridViewportRef,
    noteCanvasRef,
    canvasWidth,
    canvasHeight,
    clipBeats,
    pixelsPerBeat,
    color,
    rulerBeatLabels,
    gridLines,
    visiblePitches,
    noteHeight,
    scaleSet,
    highlightScale,
    rootNote,
    notes,
    selectedNotes,
    tool,
    hoveredNoteEdge,
    setHoveredNoteEdge,
    selectionRect,
    clipStartBeat,
    stepInputCursorBeat,
    activeLane,
    readLaneValue,
    onLaneMouseDown,
    handleGridClick,
    handleGridDoubleClick,
    handleGridMouseDown,
    handleNoteClick,
    handleNoteDrag,
    handleNoteMouseMove,
    pitchToY,
}: PianoRollGridViewportProps) {
    return (
        <div
            ref={(el) => {
                scrollRef.current = el;
                gridViewportRef.current = el;
            }}
            style={{ flex: 1, overflow: 'auto', position: 'relative' }}
        >
            <div style={{ width: canvasWidth, height: RULER_HEIGHT + canvasHeight + VELOCITY_LANE_HEIGHT, position: 'relative' }}>
                <ClipEditorRuler
                    width={canvasWidth}
                    clipBeats={clipBeats}
                    pixelsPerBeat={pixelsPerBeat}
                    color={color}
                    rulerBeatLabels={rulerBeatLabels}
                    gridLines={gridLines}
                />

                <svg width={canvasWidth} height={canvasHeight} shapeRendering="crispEdges" style={{ position: 'absolute', top: RULER_HEIGHT, left: 0, pointerEvents: 'none' }}>
                    {visiblePitches.map((pitch, i) => {
                        const black = isBlackKey(pitch);
                        const inScale = scaleSet ? scaleSet.has(pitch) : true;
                        const isRoot = highlightScale && ((pitch % 12) === ROOT_NOTES.indexOf(rootNote));
                        const isC = pitch % 12 === 0;
                        let fill: string;
                        if (highlightScale) {
                            if (isRoot) fill = `color-mix(in srgb, ${color} 14%, transparent)`;
                            else if (inScale) fill = black
                                ? `color-mix(in srgb, ${color} 6%, var(--color-piano-black-row))`
                                : `color-mix(in srgb, ${color} 5%, var(--color-piano-white-row))`;
                            else fill = black ? 'var(--token-color-hex-111111)' : 'var(--token-color-hex-161616)';
                        } else {
                            fill = black ? 'var(--color-piano-black-row)' : 'var(--color-piano-white-row)';
                        }
                        return (
                            <g key={`row-${i}`}>
                                <rect x={0} y={i * noteHeight} width={canvasWidth} height={noteHeight} fill={fill} />
                                <line x1={0} y1={(i + 1) * noteHeight} x2={canvasWidth} y2={(i + 1) * noteHeight} stroke={isC ? 'var(--color-piano-c-line)' : 'var(--color-border-subtle)'} strokeWidth={1} />
                            </g>
                        );
                    })}
                    {gridLines.map((gl) => (
                        <line key={`v-${Math.round(gl.x)}`} x1={gl.x} y1={0} x2={gl.x} y2={canvasHeight} stroke={gl.isBar ? 'var(--color-piano-bar)' : gl.isMainBeat ? 'var(--color-piano-beat)' : 'var(--color-border-subtle)'} strokeWidth={1} />
                    ))}
                </svg>

                <div
                    onClick={handleGridClick}
                    onDoubleClick={handleGridDoubleClick}
                    onMouseDown={handleGridMouseDown}
                    style={{ position: 'absolute', top: RULER_HEIGHT, left: 0, width: canvasWidth, height: canvasHeight, cursor: tool === 'paint' ? 'crosshair' : 'default' }}
                >
                    <canvas ref={noteCanvasRef} style={{ position: 'absolute', left: 0, top: 0, width: canvasWidth, height: canvasHeight, pointerEvents: 'none' }} />

                    {notes.map((note) => {
                        const x = note.startBeat * pixelsPerBeat;
                        const y = pitchToY(note.pitch);
                        if (y < 0) return null;
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
                                    top: y,
                                    width: Math.max(4, w),
                                    height: noteHeight,
                                    background: 'transparent',
                                    borderRadius: 'var(--radius-xs)',
                                    border: isSelected
                                        ? '1.5px solid var(--color-text-on-accent)'
                                        : '1px solid color-mix(in srgb, var(--color-text-secondary) 75%, transparent)',
                                    boxShadow: 'none',
                                    cursor: tool === 'paint'
                                        ? 'crosshair'
                                        : (hoveredNoteEdge === note.id ? 'col-resize' : 'grab'),
                                    zIndex: isSelected ? 'var(--z-local-raised)' : 'var(--z-timeline-overlays)',
                                    pointerEvents: tool === 'paint' ? 'none' : 'auto',
                                }}
                            />
                        );
                    })}

                    {selectionRect && (
                        <div style={{ position: 'absolute', left: Math.min(selectionRect.x1, selectionRect.x2), top: Math.min(selectionRect.y1, selectionRect.y2), width: Math.abs(selectionRect.x2 - selectionRect.x1), height: Math.abs(selectionRect.y2 - selectionRect.y1), background: 'var(--color-accent-primary-dim)', border: 'var(--space-px) solid color-mix(in srgb, var(--color-accent-primary) 85%, transparent)', borderRadius: 'var(--radius-xs)', pointerEvents: 'none', zIndex: 'var(--z-local-raised)' }} />
                    )}

                    {notes.length === 0 && (
                        <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', pointerEvents: 'none', zIndex: 'var(--z-local-raised)', textAlign: 'center', padding: 'var(--space-2-5) var(--space-3-5)', borderRadius: 'var(--radius-xl)', border: 'var(--space-px) solid color-mix(in srgb, var(--color-accent-primary) 35%, var(--color-divider))', background: 'color-mix(in srgb, var(--color-bg-header) 85%, var(--token-color-hex-0b1525))', boxShadow: 'none' }}>
                            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-primary)', fontWeight: 'var(--font-weight-bold)', marginBottom: 2 }}>Draw notes to start</div>
                            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>Cursor: double-click to add, click to select, second click to delete. Pencil mode: single-click toggles note. Paint: drag to paint notes.</div>
                        </div>
                    )}
                </div>

                <PianoRollPlayhead
                    clipStartBeat={clipStartBeat}
                    clipBeats={clipBeats}
                    pixelsPerBeat={pixelsPerBeat}
                    canvasHeight={canvasHeight}
                />

                {stepInputCursorBeat >= 0 && (
                    <div style={{ position: 'absolute', left: stepInputCursorBeat * pixelsPerBeat, top: RULER_HEIGHT, width: 1, height: canvasHeight, background: 'color-mix(in srgb, var(--color-accent-primary) 90%, transparent)', zIndex: 'var(--z-ui-overlay)', pointerEvents: 'none' }} />
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
                    onLaneMouseDown={onLaneMouseDown}
                />
            </div>
        </div>
    );
});
