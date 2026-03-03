import React, { useEffect, useState } from 'react';
import { nodeMotionProxy } from '../lib/NodeMotionProxy';

// Reusing the type structure from the store directly since @entities/flow might not be mapped here
type FlowConnection = {
    id: string;
    fromNode: string;
    fromPort: string;
    toNode: string;
    toPort: string;
    signalType?: 'audio' | 'midi' | 'control';
};

const PULSE_DURATION_MS = 520;

function cubicBezierAt(t: number, p0: number, p1: number, p2: number, p3: number): number {
    const mt = 1 - t;
    return (mt ** 3) * p0 + 3 * (mt ** 2) * t * p1 + 3 * mt * (t ** 2) * p2 + (t ** 3) * p3;
}

interface Props {
    conn: FlowConnection;
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

    // ENTERPRISE: Subscribe purely to the proxy coords. 
    // This allows the connection to deform smoothly while a node is dragged @ 120Hz
    // Without triggering a top-level React re-render of the Graph
    useEffect(() => {
        let isDisposed = false;

        // Try to fetch synchronously first
        const s = nodeMotionProxy.getPosition(conn.fromNode);
        if (s) {
            setStart(prev => ({ x: s.x + 240, y: prev.y }));
        }

        const unsubStart = nodeMotionProxy.subscribe(conn.fromNode, (pos) => {
            if (isDisposed) return;
            // The X moves exactly by node position. The Y moves, but port relative Y is constant.
            // Since we know the delta of the node matching the delta of the port:
            setStart(prev => ({ x: pos.x + 240, y: initialStart.y + (pos.y - (initialStart.y - prev.y)) }));
        });

        const unsubEnd = nodeMotionProxy.subscribe(conn.toNode, (pos) => {
            if (isDisposed) return;
            setEnd(prev => ({ x: pos.x, y: initialEnd.y + (pos.y - (initialEnd.y - prev.y)) }));
        });

        return () => {
            isDisposed = true;
            unsubStart();
            unsubEnd();
        };
    }, [conn.fromNode, conn.toNode, initialStart.x, initialStart.y, initialEnd.x, initialEnd.y]);

    // Update refs if props completely change (e.g. initial graph load)
    useEffect(() => {
        setStart(initialStart);
        setEnd(initialEnd);
    }, [initialStart, initialEnd]);

    const signalType = conn.signalType ?? 'audio';
    const baseColor = signalType === 'midi'
        ? 'var(--color-signal-midi)'
        : signalType === 'control'
            ? 'var(--color-signal-control, #f59e0b)'
            : 'var(--color-signal-audio)';
    const glowColor = signalType === 'midi'
        ? 'color-mix(in srgb, var(--color-signal-midi) 72%, transparent)'
        : signalType === 'control'
            ? 'color-mix(in srgb, var(--color-signal-control, #f59e0b) 72%, transparent)'
            : 'color-mix(in srgb, var(--color-signal-audio) 72%, transparent)';

    const elapsed = Math.max(0, now - pulseTs);
    const pulseActive = elapsed < PULSE_DURATION_MS;
    const pulseT = Math.min(1, elapsed / PULSE_DURATION_MS);

    // Calculate dynamic bezier path
    const dx = Math.abs(end.x - start.x);
    const distance = Math.sqrt(dx * dx + (end.y - start.y) ** 2);
    const cpOffset = Math.min(250, Math.max(50, distance / 2.5));
    const c1x = start.x + cpOffset;
    const c1y = start.y;
    const c2x = end.x - cpOffset;
    const c2y = end.y;
    const pathData = `M ${start.x} ${start.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${end.x} ${end.y}`;

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
                strokeWidth={isSelected ? 3 : 2}
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
