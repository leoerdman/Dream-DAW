import React, { useEffect, useRef, useState } from 'react';
import { nodeMotionProxy } from '../lib/NodeMotionProxy';
import { FLOW_NODE_WIDTH } from './SynthNodeComponent';
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

    // Update refs if props completely change (e.g. initial graph load)
    useEffect(() => {
        setStart(initialStart);
        setEnd(initialEnd);
    }, [initialStart, initialEnd]);

    const signalType = conn.signalType ?? 'audio';
    const baseColor = signalType === 'midi'
        ? 'var(--color-signal-midi)'
        : signalType === 'control'
            ? 'var(--color-signal-control)'
            : 'var(--color-signal-audio)';
    const glowColor = signalType === 'midi'
        ? 'color-mix(in srgb, var(--color-signal-midi) 72%, transparent)'
        : signalType === 'control'
            ? 'color-mix(in srgb, var(--color-signal-control) 72%, transparent)'
            : 'color-mix(in srgb, var(--color-signal-audio) 72%, transparent)';

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

    // ENTERPRISE: Cable type differentiation
    const isControlSignal = signalType === 'control';
    const coreStrokeWidth = isSelected ? 3.5 : (isControlSignal ? 2 : 3);
    const controlDash = isControlSignal ? '8 4' : 'none';

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
            {/* Core path */}
            <path
                d={pathData}
                fill="none"
                stroke={isSelected ? 'color-mix(in srgb, white 32%, var(--color-accent-primary))' : baseColor}
                strokeWidth={coreStrokeWidth}
                strokeDasharray={isSelected ? 'none' : controlDash}
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
                    fill={signalType === 'midi'
                        ? 'color-mix(in srgb, var(--color-signal-midi) 80%, white)'
                        : 'color-mix(in srgb, var(--color-signal-audio) 80%, white)'}
                    opacity={1 - pulseT * 0.35}
                    pointerEvents="none"
                />
            )}
            {/* 100x UX: Inline Delete Button (appears on selection) */}
            {isSelected && (() => {
                const midX = cubicBezierAt(0.5, start.x, c1x, c2x, end.x);
                const midY = cubicBezierAt(0.5, start.y, c1y, c2y, end.y);
                return (
                    <g
                        transform={`translate(${midX}, ${midY})`}
                        style={{ cursor: 'pointer', pointerEvents: 'auto' }}
                        onPointerDown={(e) => {
                            e.stopPropagation();
                            deleteConnection(conn.id);
                        }}
                    >
                        <circle cx="0" cy="0" r="14" fill="var(--color-bg-elevated)" stroke={baseColor} strokeWidth="1.5" />
                        <path
                            d="M-4 -4 L4 4 M4 -4 L-4 4"
                            stroke="var(--color-text-primary)"
                            strokeWidth="2"
                            strokeLinecap="round"
                        />
                        {/* Additional hit area to make it easier to click */}
                        <circle cx="0" cy="0" r="20" fill="transparent" />
                    </g>
                );
            })()}
        </g>
    );
});
