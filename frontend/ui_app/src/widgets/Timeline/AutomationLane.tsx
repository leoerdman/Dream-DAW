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

import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import throttle from 'lodash.throttle';
import {
    useAutomationStore,
    type AutomationLane as LaneData,
    type AutomationBreakpoint,
} from '@/shared/stores/useAutomationStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import * as engineApi from '@/shared/api/engine';

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
const CURVE_TENSION_DEFAULT = 0.35;

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
    const setBreakpointCurve = useAutomationStore((s) => s.setBreakpointCurve);
    const setBreakpointTension = useAutomationStore((s) => s.setBreakpointTension);
    const removeBreakpoint = useAutomationStore((s) => s.removeBreakpoint);
    const selectBreakpoint = useAutomationStore((s) => s.selectBreakpoint);
    const selectedBreakpoints = useAutomationStore((s) => s.selectedBreakpoints);

    const svgRef = useRef<SVGSVGElement>(null);
    const [hoveredBp, setHoveredBp] = useState<string | null>(null);
    const [draggingBp, setDraggingBp] = useState<string | null>(null);
    const [curveDragBp, setCurveDragBp] = useState<string | null>(null);

    const pushPointsThrottled = useMemo(
        () =>
            throttle((points: engineApi.AutomationPoint[]) => {
                engineApi
                    .setAutomationPointsWithDeltas(lane.trackId, lane.paramKey, points)
                    .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'automation:throttle'))
                    .catch((err) => console.error('[AutomationLane] setAutomationPoints failed:', err));
            }, 16),
        [lane.trackId, lane.paramKey],
    );

    useEffect(() => {
        return () => {
            pushPointsThrottled.cancel();
        };
    }, [pushPointsThrottled]);

    const buildEnginePoints = useCallback((): engineApi.AutomationPoint[] => {
        const latest = useAutomationStore.getState().lanes[lane.id];
        return (latest?.breakpoints ?? lane.breakpoints).map((bp) => ({
            beat: bp.beat,
            value: bp.value,
            curveType: bp.curve === 'step' ? 'step' : bp.curve === 'bezier' ? 'bezier' : 'linear',
            tension: bp.curve === 'bezier' ? (bp.tension ?? 0.5) : undefined,
        }));
    }, [lane.id, lane.breakpoints]);

    const flushPointsToEngine = useCallback(() => {
        const points = buildEnginePoints();
        pushPointsThrottled(points);
    }, [buildEnginePoints, pushPointsThrottled]);

    const pushPointsImmediate = useCallback(() => {
        const points = buildEnginePoints();
        engineApi
            .setAutomationPointsWithDeltas(lane.trackId, lane.paramKey, points)
            .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'automation:flush'))
            .catch((err) => console.error('[AutomationLane] setAutomationPoints final push failed:', err));
    }, [buildEnginePoints, lane.trackId, lane.paramKey]);

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
                tension: bp.tension,
            }));

            let d = `M ${points[0].x} ${points[0].y}`;

            for (let i = 1; i < points.length; i++) {
                const prev = points[i - 1];
                const curr = points[i];

                if (prev.curve === 'step') {
                    d += ` L ${curr.x} ${prev.y} L ${curr.x} ${curr.y}`;
                } else if (prev.curve === 'bezier') {
                    const dx = curr.x - prev.x;
                    const t = Math.max(0.05, Math.min(0.95, prev.tension ?? CURVE_TENSION_DEFAULT));
                    const cp1x = prev.x + dx * t;
                    const cp2x = curr.x - dx * t;
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
            if (!e.shiftKey) return;
            const { beat, value } = pxToCoords(e.clientX, e.clientY);
            addBreakpoint(lane.id, beat, value);
            flushPointsToEngine();
        },
        [pxToCoords, addBreakpoint, lane.id, draggingBp, flushPointsToEngine],
    );

    const handleBpMouseDown = useCallback(
        (e: React.MouseEvent, bpId: string) => {
            e.stopPropagation();
            selectBreakpoint(bpId, e.shiftKey);
            setDraggingBp(bpId);

            const onMove = (ev: MouseEvent) => {
                const { beat, value } = pxToCoords(ev.clientX, ev.clientY);
                moveBreakpoint(lane.id, bpId, beat, value);
                flushPointsToEngine();
            };

            const onUp = () => {
                setDraggingBp(null);
                pushPointsThrottled.cancel();
                pushPointsImmediate();
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };

            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        },
        [
            selectBreakpoint,
            moveBreakpoint,
            pxToCoords,
            lane.id,
            flushPointsToEngine,
            pushPointsThrottled,
            pushPointsImmediate,
        ],
    );

    const handleBpDblClick = useCallback(
        (e: React.MouseEvent, bpId: string) => {
            e.stopPropagation();
            removeBreakpoint(lane.id, bpId);
            flushPointsToEngine();
        },
        [removeBreakpoint, lane.id, flushPointsToEngine],
    );

    const handleLineMouseDown = useCallback(
        (e: React.MouseEvent, bpId: string) => {
            e.stopPropagation();
            setCurveDragBp(bpId);
            setBreakpointCurve(lane.id, bpId, 'bezier');

            const startY = e.clientY;
            const latest = useAutomationStore.getState().lanes[lane.id];
            const initial = latest?.breakpoints.find((bp) => bp.id === bpId)?.tension ?? 0.5;
            const onMove = (ev: MouseEvent) => {
                const dy = ev.clientY - startY;
                const next = Math.max(0.05, Math.min(0.95, initial - dy * 0.004));
                setBreakpointTension(lane.id, bpId, next);
                flushPointsToEngine();
            };
            const onUp = () => {
                setCurveDragBp(null);
                pushPointsThrottled.cancel();
                pushPointsImmediate();
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        },
        [
            lane.id,
            setBreakpointCurve,
            setBreakpointTension,
            flushPointsToEngine,
            pushPointsThrottled,
            pushPointsImmediate,
        ],
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
                    onMouseDown={(e) => {
                        const localX = e.nativeEvent.offsetX;
                        const localY = e.nativeEvent.offsetY;
                        let bestIdx = -1;
                        let bestDist = Number.POSITIVE_INFINITY;
                        for (let i = 0; i < bps.length - 1; i++) {
                            const x1 = beatToX(bps[i].beat);
                            const x2 = beatToX(bps[i + 1].beat);
                            if (localX < Math.min(x1, x2) - 8 || localX > Math.max(x1, x2) + 8) continue;
                            const t = Math.abs(x2 - x1) < 1e-6 ? 0 : (localX - x1) / (x2 - x1);
                            const y1 = valueToPxY(bps[i].value);
                            const y2 = valueToPxY(bps[i + 1].value);
                            const y = y1 + (y2 - y1) * Math.max(0, Math.min(1, t));
                            const dist = Math.abs(localY - y);
                            if (dist < bestDist) {
                                bestDist = dist;
                                bestIdx = i;
                            }
                        }
                        if (bestIdx >= 0) {
                            handleLineMouseDown(e, bps[bestIdx].id);
                        }
                    }}
                />
            )}

            {/* Bézier segment tension handles */}
            {bps.map((bp, idx) => {
                if (bp.curve !== 'bezier') return null;
                const next = bps[idx + 1];
                if (!next) return null;
                const x1 = beatToX(bp.beat);
                const y1 = valueToPxY(bp.value);
                const x2 = beatToX(next.beat);
                const y2 = valueToPxY(next.value);
                const t = Math.max(0.05, Math.min(0.95, bp.tension ?? 0.5));
                const mx = x1 + (x2 - x1) * t;
                const my = y1 + (y2 - y1) * 0.5;
                const active = curveDragBp === bp.id;
                return (
                    <g key={`curve-handle-${bp.id}`}>
                        <line
                            x1={x1}
                            y1={y1}
                            x2={mx}
                            y2={my}
                            stroke={lane.color}
                            strokeOpacity={active ? 0.9 : 0.45}
                            strokeWidth={1}
                            strokeDasharray="3 2"
                        />
                        <circle
                            cx={mx}
                            cy={my}
                            r={active ? 5.2 : 4}
                            fill={active ? '#ffffff' : lane.color}
                            fillOpacity={active ? 1 : 0.85}
                            stroke={lane.color}
                            strokeWidth={1}
                            style={{ cursor: 'ns-resize' }}
                            onMouseDown={(e) => handleLineMouseDown(e, bp.id)}
                        />
                    </g>
                );
            })}

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
                        stroke={isSelected ? lane.color : 'var(--color-overlay-medium)'}
                        strokeWidth={isSelected ? 2 : 1}
                        style={{
                            cursor: 'grab',
                            transition: `r var(--transition-micro)`,
                            filter: isHover
                                ? `drop-shadow(0 0 4px ${lane.color})`
                                : undefined,
                            opacity: curveDragBp === bp.id ? 0.9 : 1,
                        }}
                        onMouseDown={(e) => handleBpMouseDown(e, bp.id)}
                        onDoubleClick={(e) => handleBpDblClick(e, bp.id)}
                        onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const next =
                                bp.curve === 'linear'
                                    ? 'bezier'
                                    : bp.curve === 'bezier'
                                        ? 'step'
                                        : 'linear';
                            setBreakpointCurve(lane.id, bp.id, next);
                            flushPointsToEngine();
                        }}
                        onMouseEnter={() => setHoveredBp(bp.id)}
                        onMouseLeave={() => setHoveredBp(null)}
                    />
                );
            })}
        </svg>
    );
});

export default AutomationLane;
