import React, { useEffect, useRef, useState } from 'react';
import { nodeMotionProxy } from '../lib/NodeMotionProxy';
import { FLOW_NODE_WIDTH } from './SynthNodeComponent';
import { signalColor, signalGlowColor } from './FlowNodeStyles';
import type { SynthConnection } from '../model/useFlowSynthStore';

const PULSE_DURATION_MS = 520;

function cubicBezierAt(t: number, p0: number, p1: number, p2: number, p3: number): number {
    const mt = 1 - t;
    return (mt ** 3) * p0 + 3 * (mt ** 2) * t * p1 + 3 * mt * (t ** 2) * p2 + (t ** 3) * p3;
}

interface Props {
    conn: SynthConnection;
    initialStart: { x: number; y: number };
    initialEnd: { x: number; y: number };
    isSelected: boolean;
    pulseTs: number;
    now: number;
    selectConnection: (id: string) => void;
    deleteConnection: (id: string) => void;
}

// Phase 11 & ENTERPRISE: Individual memoized connection components that hook into the zero-React motion proxy.
export const FlowConnectionComponent = React.memo(function FlowConnectionComponent({
    conn,
    initialStart,
    initialEnd,
    isSelected,
    pulseTs,
    now,
    selectConnection,
    deleteConnection
}: Props) {
    const [start, setStart] = useState(initialStart);
    const [end, setEnd] = useState(initialEnd);
    // Hover tracking: use a ref+timeout to avoid flicker when mouse moves from cable to delete button
    const [isHovered, setIsHovered] = useState(false);
    const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ENTERPRISE FIX (#3+#4): Store the port-relative Y offset as a ref.
    // The port Y position = nodePosition.y + portRelativeY.
    // We compute portRelativeY once from initial props and use absolute math thereafter.
    const startPortOffsetY = useRef(0);
    const endPortOffsetY = useRef(0);

    // Compute port offsets from the initial positions.
    // initialStart.y = initialNodePosition.y + portRelativeY.
    // We can derive nodePosition from the proxy or from initial positions.
    useEffect(() => {
        const fromNodePos = nodeMotionProxy.getPosition(conn.fromNode);
        const toNodePos = nodeMotionProxy.getPosition(conn.toNode);
        // portRelativeY = initialStart.y - node.y
        startPortOffsetY.current = fromNodePos ? initialStart.y - fromNodePos.y : 0;
        endPortOffsetY.current = toNodePos ? initialEnd.y - toNodePos.y : 0;
    }, [conn.fromNode, conn.toNode, initialStart.y, initialEnd.y]);

    useEffect(() => {
        let isDisposed = false;

        const unsubStart = nodeMotionProxy.subscribe(conn.fromNode, (pos) => {
            if (isDisposed) return;
            // ENTERPRISE FIX: Absolute positioning — no prev-dependent accumulation.
            // Output port X = node.x + FLOW_NODE_WIDTH (right edge)
            setStart({ x: pos.x + FLOW_NODE_WIDTH, y: pos.y + startPortOffsetY.current });
        });

        const unsubEnd = nodeMotionProxy.subscribe(conn.toNode, (pos) => {
            if (isDisposed) return;
            // Input port X = node.x (left edge)
            setEnd({ x: pos.x, y: pos.y + endPortOffsetY.current });
        });

        return () => {
            isDisposed = true;
            unsubStart();
            unsubEnd();
        };
    }, [conn.fromNode, conn.toNode]);

    // ENTERPRISE FIX: Only sync from props when actual VALUES change (not object references).
    // ConnectionsLayer creates new objects every render → old useEffect fired on every frame,
    // overwriting nodeMotionProxy positions mid-drag and causing cables to "jump".
    const prevInitStart = useRef(initialStart);
    const prevInitEnd = useRef(initialEnd);
    useEffect(() => {
        const sameStart = prevInitStart.current.x === initialStart.x && prevInitStart.current.y === initialStart.y;
        const sameEnd = prevInitEnd.current.x === initialEnd.x && prevInitEnd.current.y === initialEnd.y;
        if (!sameStart || !sameEnd) {
            prevInitStart.current = initialStart;
            prevInitEnd.current = initialEnd;
            setStart(initialStart);
            setEnd(initialEnd);
        }
    }, [initialStart.x, initialStart.y, initialEnd.x, initialEnd.y]);

    const signalType = conn.signalType ?? 'audio';
    const baseColor = signalColor(signalType);
    const glowColor = signalGlowColor(signalType);

    const elapsed = Math.max(0, now - pulseTs);
    const pulseActive = elapsed < PULSE_DURATION_MS;
    const pulseT = Math.min(1, elapsed / PULSE_DURATION_MS);

    // Calculate dynamic bezier path
    const dx = Math.abs(end.x - start.x);
    const distance = Math.sqrt(dx * dx + (end.y - start.y) ** 2);
    // ENTERPRISE: Less aggressive curves for short connections
    const cpOffset = Math.min(200, Math.max(30, distance / 3));
    const c1x = start.x + cpOffset;
    const c1y = start.y;
    const c2x = end.x - cpOffset;
    const c2y = end.y;
    const pathData = `M ${start.x} ${start.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${end.x} ${end.y}`;

    // ENTERPRISE: All cables solid, uniform width. Color differentiates signal types.
    const coreStrokeWidth = isSelected ? 3 : 2.5;

    const pulseX = cubicBezierAt(pulseT, start.x, c1x, c2x, end.x);
    const pulseY = cubicBezierAt(pulseT, start.y, c1y, c2y, end.y);

    return (
        <g>
            {/* Hit test zone */}
            <path
                data-flow-connection-hit="true"
                d={pathData}
                fill="none"
                stroke="transparent"
                strokeWidth={24}
                pointerEvents="stroke"
                style={{ cursor: 'pointer' }}
                onPointerEnter={() => {
                    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
                    setIsHovered(true);
                }}
                onPointerLeave={() => {
                    // Delay unhover so mouse can transit to delete button
                    hoverTimeoutRef.current = setTimeout(() => setIsHovered(false), 120);
                }}
                onPointerDown={(e) => {
                    e.stopPropagation();
                    selectConnection(conn.id);
                }}
            />
            {/* Glow */}
            <path
                d={pathData}
                fill="none"
                stroke={glowColor}
                strokeWidth={isSelected ? 8 : 4}
                opacity={isSelected ? 0.35 : 0.14}
                pointerEvents="none"
                style={{ filter: 'none', transition: 'stroke-width 0.15s, opacity 0.15s' }}
            />
            {/* Core path — solid for audio/midi/gate, dashed for control/phase (Bitwig Grid pattern) */}
            <path
                d={pathData}
                fill="none"
                stroke={isSelected ? 'color-mix(in srgb, white 32%, var(--color-accent-primary))' : baseColor}
                strokeWidth={coreStrokeWidth}
                strokeLinecap="round"
                strokeDasharray={(signalType === 'control' || signalType === 'phase') ? '8 4' : 'none'}
                opacity={1.0}
                pointerEvents="none"
            />
            {/* Flow highlight */}
            <path
                d={pathData}
                fill="none"
                stroke="rgba(255, 255, 255, 0.35)"
                strokeWidth={1}
                strokeDasharray="20 180"
                pointerEvents="none"
                style={{
                    animation: 'flow-cable 4s linear infinite',
                    filter: 'blur(0.5px)',
                }}
            />
            {pulseActive && (
                <circle
                    cx={pulseX}
                    cy={pulseY}
                    r={signalType === 'midi' ? 4 : 3.5}
                    fill={`color-mix(in srgb, ${baseColor} 80%, white)`}
                    opacity={1 - pulseT * 0.35}
                    pointerEvents="none"
                />
            )}
            {/* 100x UX: Inline Delete Button (appears on selection) */}
            {(isSelected || isHovered) && (() => {
                const midX = cubicBezierAt(0.5, start.x, c1x, c2x, end.x);
                const midY = cubicBezierAt(0.5, start.y, c1y, c2y, end.y);
                return (
                    <g
                        transform={`translate(${midX}, ${midY})`}
                        style={{ cursor: 'pointer', pointerEvents: 'auto' }}
                        onPointerEnter={() => {
                            if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
                            setIsHovered(true);
                        }}
                        onPointerLeave={() => {
                            hoverTimeoutRef.current = setTimeout(() => setIsHovered(false), 120);
                        }}
                        onPointerDown={(e) => {
                            e.stopPropagation();
                            deleteConnection(conn.id);
                        }}
                    >
                        <circle cx="0" cy="0" r="12" fill="var(--color-bg-elevated)" stroke={baseColor} strokeWidth="1.5" />
                        <path
                            d="M-3.5 -3.5 L3.5 3.5 M3.5 -3.5 L-3.5 3.5"
                            stroke="var(--color-text-primary)"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                        />
                        {/* Expanded hit area */}
                        <circle cx="0" cy="0" r="18" fill="transparent" />
                    </g>
                );
            })()}
        </g>
    );
});
