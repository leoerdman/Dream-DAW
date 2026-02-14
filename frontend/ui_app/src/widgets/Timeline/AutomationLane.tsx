// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — AutomationLane (SVG Breakpoint Editor)
// ═══════════════════════════════════════════════════════════════════════════
//
// Renders automation breakpoints as an SVG overlay on each track row.
// Supports:
//   - Linear, Bézier, and step interpolation curves
//   - Click-to-add breakpoints
//   - Drag-to-move breakpoints
//   - Visual feedback for selection and hover
//   - Translucent fill below the curve
//
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useRef, useState, memo } from 'react';
import {
    useAutomationStore,
    type AutomationLane as LaneData,
    type AutomationBreakpoint,
} from '@/shared/stores/useAutomationStore';

// ── Types ────────────────────────────────────────────────────────────────

interface AutomationLaneProps {
    /** Lane data from the automation store. */
    lane: LaneData;
    /** Width of the visible timeline area in pixels. */
    width: number;
    /** Height of the track row in pixels. */
    height: number;
    /** Pixels per beat (zoom level). */
    pixelsPerBeat: number;
    /** Scroll offset in beats. */
    scrollOffsetBeats: number;
}

// ── Constants ────────────────────────────────────────────────────────────

const BP_RADIUS = 5;
const BP_RADIUS_HOVER = 7;
const LINE_WIDTH = 1.5;
const FILL_OPACITY = 0.12;
const CURVE_TENSION = 0.35; // Bézier control point tension

// ── Component ────────────────────────────────────────────────────────────

export const AutomationLane = memo(function AutomationLane({
    lane,
    width,
    height,
    pixelsPerBeat,
    scrollOffsetBeats,
}: AutomationLaneProps) {
    const addBreakpoint = useAutomationStore((s) => s.addBreakpoint);
    const moveBreakpoint = useAutomationStore((s) => s.moveBreakpoint);
    const removeBreakpoint = useAutomationStore((s) => s.removeBreakpoint);
    const selectBreakpoint = useAutomationStore((s) => s.selectBreakpoint);
    const selectedBreakpoints = useAutomationStore((s) => s.selectedBreakpoints);

    const svgRef = useRef<SVGSVGElement>(null);
    const [hoveredBp, setHoveredBp] = useState<string | null>(null);
    const [draggingBp, setDraggingBp] = useState<string | null>(null);

    // ── Coordinate Conversion ──────────────────────────────────────

    const beatToX = useCallback(
        (beat: number) => (beat - scrollOffsetBeats) * pixelsPerBeat,
        [scrollOffsetBeats, pixelsPerBeat],
    );

    const valueToPxY = useCallback(
        (value: number) => height - value * height, // 0=bottom, 1=top
        [height],
    );

    const pxToCoords = useCallback(
        (clientX: number, clientY: number): { beat: number; value: number } => {
            const svg = svgRef.current;
            if (!svg) return { beat: 0, value: 0 };
            const rect = svg.getBoundingClientRect();
            const x = clientX - rect.left;
            const y = clientY - rect.top;
            const beat = x / pixelsPerBeat + scrollOffsetBeats;
            const value = Math.max(0, Math.min(1, 1 - y / height));
            return { beat: Math.max(0, beat), value };
        },
        [pixelsPerBeat, scrollOffsetBeats, height],
    );

    // ── Path Builder ────────────────────────────────────────────────

    const buildPath = useCallback(
        (bps: AutomationBreakpoint[], forFill: boolean): string => {
            if (bps.length === 0) return '';

            const points = bps.map((bp) => ({
                x: beatToX(bp.beat),
                y: valueToPxY(bp.value),
                curve: bp.curve,
            }));

            let d = `M ${points[0].x} ${points[0].y}`;

            for (let i = 1; i < points.length; i++) {
                const prev = points[i - 1];
                const curr = points[i];

                if (prev.curve === 'step') {
                    d += ` L ${curr.x} ${prev.y} L ${curr.x} ${curr.y}`;
                } else if (prev.curve === 'bezier') {
                    const dx = curr.x - prev.x;
                    const cp1x = prev.x + dx * CURVE_TENSION;
                    const cp2x = curr.x - dx * CURVE_TENSION;
                    d += ` C ${cp1x} ${prev.y} ${cp2x} ${curr.y} ${curr.x} ${curr.y}`;
                } else {
                    d += ` L ${curr.x} ${curr.y}`;
                }
            }

            if (forFill) {
                d += ` L ${points[points.length - 1].x} ${height} L ${points[0].x} ${height} Z`;
            }

            return d;
        },
        [beatToX, valueToPxY, height],
    );

    // ── Event Handlers ──────────────────────────────────────────────

    const handleSvgClick = useCallback(
        (e: React.MouseEvent) => {
            if (draggingBp) return;
            const { beat, value } = pxToCoords(e.clientX, e.clientY);
            addBreakpoint(lane.id, beat, value);
        },
        [pxToCoords, addBreakpoint, lane.id, draggingBp],
    );

    const handleBpMouseDown = useCallback(
        (e: React.MouseEvent, bpId: string) => {
            e.stopPropagation();
            selectBreakpoint(bpId, e.shiftKey);
            setDraggingBp(bpId);

            const onMove = (ev: MouseEvent) => {
                const { beat, value } = pxToCoords(ev.clientX, ev.clientY);
                moveBreakpoint(lane.id, bpId, beat, value);
            };

            const onUp = () => {
                setDraggingBp(null);
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };

            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        },
        [selectBreakpoint, moveBreakpoint, pxToCoords, lane.id],
    );

    const handleBpDblClick = useCallback(
        (e: React.MouseEvent, bpId: string) => {
            e.stopPropagation();
            removeBreakpoint(lane.id, bpId);
        },
        [removeBreakpoint, lane.id],
    );

    // ── Render ──────────────────────────────────────────────────────

    if (!lane.visible) return null;

    const bps = lane.breakpoints;
    const linePath = buildPath(bps, false);
    const fillPath = buildPath(bps, true);

    return (
        <svg
            ref={svgRef}
            width={width}
            height={height}
            onClick={handleSvgClick}
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                cursor: 'crosshair',
                pointerEvents: 'all',
            }}
        >
            {/* Fill below curve */}
            {fillPath && (
                <path
                    d={fillPath}
                    fill={lane.color}
                    opacity={FILL_OPACITY}
                />
            )}

            {/* Curve line */}
            {linePath && (
                <path
                    d={linePath}
                    fill="none"
                    stroke={lane.color}
                    strokeWidth={LINE_WIDTH}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            )}

            {/* Breakpoint dots */}
            {bps.map((bp) => {
                const x = beatToX(bp.beat);
                const y = valueToPxY(bp.value);
                const isSelected = selectedBreakpoints.has(bp.id);
                const isHover = hoveredBp === bp.id;
                const r = isHover ? BP_RADIUS_HOVER : BP_RADIUS;

                return (
                    <circle
                        key={bp.id}
                        cx={x}
                        cy={y}
                        r={r}
                        fill={isSelected ? '#fff' : lane.color}
                        stroke={isSelected ? lane.color : 'rgba(0,0,0,0.4)'}
                        strokeWidth={isSelected ? 2 : 1}
                        style={{
                            cursor: 'grab',
                            transition: 'r 0.1s ease',
                            filter: isHover
                                ? `drop-shadow(0 0 4px ${lane.color})`
                                : undefined,
                        }}
                        onMouseDown={(e) => handleBpMouseDown(e, bp.id)}
                        onDoubleClick={(e) => handleBpDblClick(e, bp.id)}
                        onMouseEnter={() => setHoveredBp(bp.id)}
                        onMouseLeave={() => setHoveredBp(null)}
                    />
                );
            })}
        </svg>
    );
});

export default AutomationLane;
