import type { AutomationBreakpoint, AutomationLane as LaneData } from '@/shared/stores/useAutomationStore';
import { clamp01 } from '@/shared/lib/audioMath';
import type { MouseEvent, RefObject } from 'react';

interface AutomationLaneSvgProps {
    svgRef: RefObject<SVGSVGElement | null>;
    lane: LaneData;
    width: number;
    height: number;
    bps: AutomationBreakpoint[];
    fillPath: string;
    linePath: string;
    selectedBreakpoints: Set<string>;
    hoveredBp: string | null;
    curveDragBp: string | null;
    beatToX: (beat: number) => number;
    valueToPxY: (value: number) => number;
    bpRadius: number;
    bpRadiusHover: number;
    lineWidth: number;
    fillOpacity: number;
    onSvgClick: (e: MouseEvent) => void;
    onSvgDoubleClick: (e: MouseEvent) => void;
    onLineMouseDown: (e: MouseEvent, bpId: string) => void;
    onBpMouseDown: (e: MouseEvent, bpId: string) => void;
    onBpDblClick: (e: MouseEvent, bpId: string) => void;
    onBpCurveToggle: (bpId: string) => void;
    onHoverChange: (bpId: string | null) => void;
    automationItems: Array<{ itemId: string; startBeat: number; endBeat: number }>;
    onItemDragStart: (e: MouseEvent, itemId: string) => void;
    onItemResizeStart: (e: MouseEvent, itemId: string) => void;
}

export function AutomationLaneSvg({
    svgRef,
    lane,
    width,
    height,
    bps,
    fillPath,
    linePath,
    selectedBreakpoints,
    hoveredBp,
    curveDragBp,
    beatToX,
    valueToPxY,
    bpRadius,
    bpRadiusHover,
    lineWidth,
    fillOpacity,
    onSvgClick,
    onSvgDoubleClick,
    onLineMouseDown,
    onBpMouseDown,
    onBpDblClick,
    onBpCurveToggle,
    onHoverChange,
    automationItems,
    onItemDragStart,
    onItemResizeStart,
}: AutomationLaneSvgProps) {
    return (
        <svg
            ref={svgRef}
            width={width}
            height={height}
            onClick={onSvgClick}
            onDoubleClick={onSvgDoubleClick}
            style={{ position: 'absolute', top: 0, left: 0, cursor: 'crosshair', pointerEvents: 'all' }}
        >
            {automationItems.map((item) => {
                const x = beatToX(item.startBeat);
                const w = Math.max(8, beatToX(item.endBeat) - x);
                return (
                    <g key={`item-${item.itemId}`}>
                        <rect
                            x={x}
                            y={1}
                            width={w}
                            height={Math.max(8, height - 2)}
                            rx={4}
                            fill={lane.color}
                            opacity={0.08}
                            stroke={lane.color}
                            strokeOpacity={0.35}
                            strokeWidth={1}
                            style={{ cursor: 'grab' }}
                            onMouseDown={(e) => onItemDragStart(e, item.itemId)}
                        />
                        <rect
                            x={x + w - 5}
                            y={2}
                            width={4}
                            height={Math.max(8, height - 4)}
                            rx={2}
                            fill={lane.color}
                            opacity={0.75}
                            style={{ cursor: 'ew-resize' }}
                            onMouseDown={(e) => onItemResizeStart(e, item.itemId)}
                        />
                    </g>
                );
            })}

            {fillPath && <path d={fillPath} fill={lane.color} opacity={fillOpacity} />}

            {linePath && (
                <path
                    d={linePath}
                    fill="none"
                    stroke={lane.color}
                    strokeWidth={lineWidth}
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
                            const y = y1 + (y2 - y1) * clamp01(t);
                            const dist = Math.abs(localY - y);
                            if (dist < bestDist) {
                                bestDist = dist;
                                bestIdx = i;
                            }
                        }
                        if (bestIdx >= 0) onLineMouseDown(e, bps[bestIdx].id);
                    }}
                />
            )}

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
                            fill={active ? 'var(--token-color-hex-ffffff)' : lane.color}
                            fillOpacity={active ? 1 : 0.85}
                            stroke={lane.color}
                            strokeWidth={1}
                            style={{ cursor: 'ns-resize' }}
                            onMouseDown={(e) => onLineMouseDown(e, bp.id)}
                        />
                    </g>
                );
            })}

            {bps.map((bp) => {
                const x = beatToX(bp.beat);
                const y = valueToPxY(bp.value);
                const isSelected = selectedBreakpoints.has(bp.id);
                const isHover = hoveredBp === bp.id;
                const r = isHover ? bpRadiusHover : bpRadius;

                return (
                    <circle
                        key={bp.id}
                        cx={x}
                        cy={y}
                        r={r}
                        fill={isSelected ? 'var(--token-color-hex-ffffff)' : lane.color}
                        stroke={isSelected ? lane.color : 'var(--color-overlay-medium)'}
                        strokeWidth={isSelected ? 2 : 1}
                        style={{
                            cursor: 'grab',
                            transition: 'r var(--transition-micro)',
                            filter: isHover ? `drop-shadow(0 0 var(--space-1) ${lane.color})` : undefined,
                            opacity: curveDragBp === bp.id ? 0.9 : 1,
                        }}
                        onMouseDown={(e) => onBpMouseDown(e, bp.id)}
                        onDoubleClick={(e) => onBpDblClick(e, bp.id)}
                        onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onBpCurveToggle(bp.id);
                        }}
                        onMouseEnter={() => onHoverChange(bp.id)}
                        onMouseLeave={() => onHoverChange(null)}
                    />
                );
            })}
        </svg>
    );
}
