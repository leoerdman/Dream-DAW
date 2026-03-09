import type { AutomationBreakpoint, AutomationLane as LaneData } from '@/shared/stores/useAutomationStore';
import { clamp01 } from '@/shared/lib/audioMath';
import type { MouseEvent, PointerEvent, RefObject } from 'react';

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
    onLineMouseDown: (e: PointerEvent, bpId: string) => void;
    onBpMouseDown: (e: PointerEvent, bpId: string) => void;
    onBpDblClick: (e: MouseEvent, bpId: string) => void;
    onBpCurveToggle: (bpId: string) => void;
    onHoverChange: (bpId: string | null) => void;
    automationItems: Array<{ itemId: string; startBeat: number; endBeat: number }>;
    onItemDragStart: (e: PointerEvent, itemId: string) => void;
    onItemResizeStart: (e: PointerEvent, itemId: string) => void;
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
    // ── ENTERPRISE: Default value computation ──────────────────────────
    // When there are no breakpoints, show a dashed line at the default value
    // for the parameter (Volume=1.0 top, Pan=0.5 center, others=0.5 center).
    const paramNameLower = lane.paramName.toLowerCase();
    const defaultValue = paramNameLower === 'volume' ? 1.0
        : paramNameLower === 'pan' ? 0.5
            : paramNameLower.includes('send') ? 0.0
                : 0.5;
    const defaultY = valueToPxY(defaultValue);
    const hasBreakpoints = bps.length > 0;

    return (
        <svg
            ref={svgRef}
            width={width}
            height={height}
            onClick={onSvgClick}
            onDoubleClick={onSvgDoubleClick}
            style={{
                position: 'absolute', top: 0, left: 0,
                cursor: 'crosshair', // Still useful if they hover a line
                /* ENTERPRISE FIX: Completely transparent to pointer events at the root.
                   This enables perfect 120fps native trackpad pan/scroll bypassing JS entirely.
                   Individual interactable lines and points opt back in with pointerEvents: 'all'. */
                pointerEvents: 'none',
            }}
        >
            {/* ── Value Range Labels ──────────────────────────────────── */}
            <text
                x={6} y={10}
                fill={lane.color} fontSize={8} fontWeight={600} opacity={0.35}
                style={{ pointerEvents: 'none', userSelect: 'none' }}
            >
                100%
            </text>
            <text
                x={6} y={height - 4}
                fill={lane.color} fontSize={8} fontWeight={600} opacity={0.35}
                style={{ pointerEvents: 'none', userSelect: 'none' }}
            >
                0%
            </text>

            {/* ── Default Line (when no breakpoints) ─────────────────── */}
            {!hasBreakpoints && (
                <>
                    {/* Invisible hit target for default line — allows double clicking to start automation */}
                    <line
                        x1={0} y1={defaultY}
                        x2={width} y2={defaultY}
                        stroke="transparent"
                        strokeWidth={14}
                        style={{ pointerEvents: 'all', cursor: 'crosshair' }}
                        onDoubleClick={(e) => {
                            // Synthesize an onLineMouseDown-style or onSvgDoubleClick event
                            onSvgDoubleClick(e);
                        }}
                    />
                    <line
                        x1={0} y1={defaultY}
                        x2={width} y2={defaultY}
                        stroke={lane.color}
                        strokeWidth={1.5}
                        strokeDasharray="6 3"
                        opacity={0.5}
                        style={{ pointerEvents: 'none' }}
                    />
                    {/* Subtle fill below default line */}
                    <rect
                        x={0} y={defaultY}
                        width={width} height={height - defaultY}
                        fill={lane.color}
                        opacity={0.04}
                        style={{ pointerEvents: 'none' }}
                    />
                    {/* Default value label */}
                    <text
                        x={width - 6} y={defaultY - 4}
                        fill={lane.color} fontSize={8} fontWeight={600} opacity={0.45}
                        textAnchor="end"
                        style={{ pointerEvents: 'none', userSelect: 'none' }}
                    >
                        {defaultValue === 1.0 ? '100%' : defaultValue === 0.0 ? '0%' : `${Math.round(defaultValue * 100)}%`}
                    </text>
                </>
            )}
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
                            style={{ cursor: 'grab', pointerEvents: 'all' }}
                            onPointerDown={(e) => onItemDragStart(e, item.itemId)}
                        />
                        <rect
                            x={x + w - 5}
                            y={2}
                            width={4}
                            height={Math.max(8, height - 4)}
                            rx={2}
                            fill={lane.color}
                            opacity={0.75}
                            style={{ cursor: 'ew-resize', pointerEvents: 'all' }}
                            onPointerDown={(e) => onItemResizeStart(e, item.itemId)}
                        />
                    </g>
                );
            })}

            {fillPath && <path d={fillPath} fill={lane.color} opacity={fillOpacity} />}

            {linePath && (
                <>
                    {/* Invisible wide hit area for line — easy to grab */}
                    <path
                        d={linePath}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={14}
                        strokeLinecap="round"
                        style={{ pointerEvents: 'all', cursor: 'crosshair' }}
                        onDoubleClick={(e) => onSvgDoubleClick(e)}
                        onPointerDown={(e) => {
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
                    {/* Visible thin line */}
                    <path
                        d={linePath}
                        fill="none"
                        stroke={lane.color}
                        strokeWidth={lineWidth}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ pointerEvents: 'none' }}
                    />
                </>
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
                            style={{ cursor: 'ns-resize', pointerEvents: 'all' }}
                            onPointerDown={(e) => onLineMouseDown(e, bp.id)}
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
                const isStep = bp.curve === 'step';

                return (
                    <g key={bp.id}>
                        {/* ── INVISIBLE HIT TARGET — r=14 for easy clicking ── */}
                        <circle
                            cx={x}
                            cy={y}
                            r={14}
                            fill="transparent"
                            style={{ cursor: 'grab', pointerEvents: 'all' }}
                            onPointerDown={(e) => onBpMouseDown(e, bp.id)}
                            onDoubleClick={(e) => onBpDblClick(e, bp.id)}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                onBpCurveToggle(bp.id);
                            }}
                            onMouseEnter={() => onHoverChange(bp.id)}
                            onMouseLeave={() => onHoverChange(null)}
                        />
                        {/* ── ENTERPRISE: Step curve indicator (square) ── */}
                        {isStep ? (
                            <rect
                                x={x - r}
                                y={y - r}
                                width={r * 2}
                                height={r * 2}
                                rx={1.5}
                                fill={isSelected ? 'var(--token-color-hex-ffffff)' : lane.color}
                                stroke={isSelected ? lane.color : 'var(--color-overlay-medium)'}
                                strokeWidth={isSelected ? 2 : 1}
                                style={{
                                    cursor: 'grab',
                                    filter: isHover ? `drop-shadow(0 0 var(--space-1) ${lane.color})` : undefined,
                                    opacity: curveDragBp === bp.id ? 0.9 : 1,
                                    pointerEvents: 'none',
                                }}
                            />
                        ) : (
                            <circle
                                cx={x}
                                cy={y}
                                r={r}
                                fill={isSelected ? 'var(--token-color-hex-ffffff)' : lane.color}
                                stroke={isSelected ? lane.color : 'var(--color-overlay-medium)'}
                                strokeWidth={isSelected ? 2 : 1}
                                style={{
                                    cursor: 'grab',
                                    filter: isHover ? `drop-shadow(0 0 var(--space-1) ${lane.color})` : undefined,
                                    opacity: curveDragBp === bp.id ? 0.9 : 1,
                                    pointerEvents: 'none',
                                }}
                            />
                        )}
                        {/* ── ENTERPRISE: Hover value tooltip ── */}
                        {isHover && (
                            <g style={{ pointerEvents: 'none' }}>
                                <rect
                                    x={x - 18} y={y - 22}
                                    width={36} height={16}
                                    rx={4}
                                    fill="var(--color-bg-panel)"
                                    opacity={0.92}
                                    stroke={lane.color}
                                    strokeWidth={0.5}
                                    strokeOpacity={0.6}
                                />
                                <text
                                    x={x} y={y - 10}
                                    textAnchor="middle"
                                    fill={lane.color}
                                    fontSize={9}
                                    fontWeight={700}
                                    fontFamily="system-ui"
                                >
                                    {`${Math.round(bp.value * 100)}%`}
                                </text>
                            </g>
                        )}
                    </g>
                );
            })}
        </svg>
    );
}
