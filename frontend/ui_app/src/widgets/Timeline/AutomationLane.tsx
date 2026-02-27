import { useCallback, useMemo, useRef, useState, memo } from 'react';
import {
    useAutomationStore,
    type AutomationLane as LaneData,
    type AutomationBreakpoint,
} from '@/shared/stores/useAutomationStore';
import { clamp01 } from '@/shared/lib/audioMath';
import { AutomationLaneSvg } from './AutomationLaneSvg';
import { useAutomationLaneSync } from './AutomationLaneSync';
import { useAutomationLaneItemHandlers } from './AutomationLaneItems';

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

const BP_RADIUS = 5;
const BP_RADIUS_HOVER = 7;
const LINE_WIDTH = 1.5;
const FILL_OPACITY = 0.12;
const CURVE_TENSION_DEFAULT = 0.35;

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
    const moveAutomationItem = useAutomationStore((s) => s.moveAutomationItem);
    const stretchAutomationItem = useAutomationStore((s) => s.stretchAutomationItem);

    const svgRef = useRef<SVGSVGElement>(null);
    const [hoveredBp, setHoveredBp] = useState<string | null>(null);
    const [draggingBp, setDraggingBp] = useState<string | null>(null);
    const [curveDragBp, setCurveDragBp] = useState<string | null>(null);

    const { flushPointsToEngine, pushPointsImmediate, pushPointsThrottled } = useAutomationLaneSync(lane);


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
            const value = clamp01(1 - y / height);
            return { beat: Math.max(0, beat), value };
        },
        [pixelsPerBeat, scrollOffsetBeats, height],
    );


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


    const handleSvgDoubleClick = useCallback(
        (e: React.MouseEvent) => {
            if (draggingBp) return;
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

    const automationItems = useMemo(() => {
        const groups = new Map<string, AutomationBreakpoint[]>();
        for (const bp of lane.breakpoints) {
            if (!bp.itemId) continue;
            const bucket = groups.get(bp.itemId) ?? [];
            bucket.push(bp);
            groups.set(bp.itemId, bucket);
        }
        return Array.from(groups.entries())
            .map(([itemId, points]) => {
                const sorted = [...points].sort((a, b) => a.beat - b.beat);
                const startBeat = sorted[0]?.beat ?? 0;
                const endBeat = sorted[sorted.length - 1]?.beat ?? startBeat;
                return { itemId, startBeat, endBeat };
            })
            .filter((item) => item.endBeat - item.startBeat > 0.0001);
    }, [lane.breakpoints]);

    const { handleItemDragStart, handleItemResizeStart } = useAutomationLaneItemHandlers({
        svgRef,
        automationItems,
        laneId: lane.id,
        pixelsPerBeat,
        scrollOffsetBeats,
        moveAutomationItem,
        stretchAutomationItem,
        flushPointsToEngine,
        pushPointsImmediate,
        pushPointsThrottled,
    });

    if (!lane.visible) return null;

    const bps = lane.breakpoints;
    const linePath = buildPath(bps, false);
    const fillPath = buildPath(bps, true);

    return (
        <AutomationLaneSvg
            svgRef={svgRef}
            lane={lane}
            width={width}
            height={height}
            bps={bps}
            fillPath={fillPath}
            linePath={linePath}
            selectedBreakpoints={selectedBreakpoints}
            hoveredBp={hoveredBp}
            curveDragBp={curveDragBp}
            beatToX={beatToX}
            valueToPxY={valueToPxY}
            bpRadius={BP_RADIUS}
            bpRadiusHover={BP_RADIUS_HOVER}
            lineWidth={LINE_WIDTH}
            fillOpacity={FILL_OPACITY}
            onSvgClick={() => { }} // Disabled single click background, strictly handles line tracking / node grabbing
            onSvgDoubleClick={handleSvgDoubleClick}
            onLineMouseDown={handleLineMouseDown}
            onBpMouseDown={handleBpMouseDown}
            onBpDblClick={handleBpDblClick}
            onBpCurveToggle={(bpId) => {
                const bp = bps.find((item) => item.id === bpId);
                if (!bp) return;
                const next = bp.curve === 'linear' ? 'bezier' : bp.curve === 'bezier' ? 'step' : 'linear';
                setBreakpointCurve(lane.id, bp.id, next);
                flushPointsToEngine();
            }}
            onHoverChange={setHoveredBp}
            automationItems={automationItems}
            onItemDragStart={handleItemDragStart}
            onItemResizeStart={handleItemResizeStart}
        />
    );
});

export default AutomationLane;
