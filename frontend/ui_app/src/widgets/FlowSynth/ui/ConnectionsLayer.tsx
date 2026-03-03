import { useEffect, useMemo, useRef, useState } from 'react';
import { useFlowSynthStore } from '../model/useFlowSynthStore';
import { viewportProxy } from '../lib/ViewportProxy';
import {
    PORT_REGISTRY,
    FLOW_NODE_HEADER_HEIGHT,
    portCenterY,
    type SynthNodeType,
} from '../model/portRegistry';
import { FLOW_NODE_WIDTH } from './SynthNodeComponent';

const PULSE_DURATION_MS = 520;

function cubicBezierAt(t: number, p0: number, p1: number, p2: number, p3: number): number {
    const mt = 1 - t;
    return (mt ** 3) * p0 + 3 * (mt ** 2) * t * p1 + 3 * mt * (t ** 2) * p2 + (t ** 3) * p3;
}

export function ConnectionsLayer() {
    const connections = useFlowSynthStore((state) => state.connections);
    const nodes = useFlowSynthStore((state) => state.nodes);
    const pendingConnection = useFlowSynthStore((state) => state.pendingConnection);
    const connectionPulseById = useFlowSynthStore((state) => state.connectionPulseById);
    const selectedConnectionId = useFlowSynthStore((state) => state.selectedConnectionId);
    const selectConnection = useFlowSynthStore((state) => state.selectConnection);
    const deleteConnection = useFlowSynthStore((state) => state.deleteConnection);
    const layerRef = useRef<SVGSVGElement>(null);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        return viewportProxy.subscribe((vp) => {
            if (layerRef.current) {
                layerRef.current.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
            }
        });
    }, []);

    useEffect(() => {
        const hasActive = Object.values(connectionPulseById).some((pulseTs) => (Date.now() - pulseTs) < PULSE_DURATION_MS);
        if (!hasActive) return;

        let raf = 0;
        const tick = () => {
            const ts = Date.now();
            setNow(ts);
            const pulseMap = useFlowSynthStore.getState().connectionPulseById;
            const stillActive = Object.values(pulseMap).some((pulseTs) => (ts - pulseTs) < PULSE_DURATION_MS);
            if (stillActive) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => {
            cancelAnimationFrame(raf);
        };
    }, [connectionPulseById]);

    // O(1) node lookup
    const nodeMap = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);

    // Calculate port position with multi-port support
    const getPortPosition = (nodeId: string, portId: string, side: 'in' | 'out') => {
        const node = nodeMap.get(nodeId);
        if (!node) return { x: 0, y: 0 };

        const config = PORT_REGISTRY[node.type as SynthNodeType];
        if (!config) return { x: node.position.x, y: node.position.y + FLOW_NODE_HEADER_HEIGHT };

        const portList = side === 'in' ? config.inputs : config.outputs;
        const portIndex = portList.findIndex((p) => p.id === portId);
        const idx = portIndex >= 0 ? portIndex : 0;

        const cy = FLOW_NODE_HEADER_HEIGHT + portCenterY(idx);
        const x = side === 'in' ? node.position.x : node.position.x + FLOW_NODE_WIDTH;
        return { x, y: node.position.y + cy };
    };

    return (
        <svg
            ref={layerRef}
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                overflow: 'visible',
                transformOrigin: '0 0',
                pointerEvents: 'auto',
                willChange: 'transform',
                zIndex: 1,
            }}
        >
            {connections.map((conn) => {
                const start = getPortPosition(conn.fromNode, conn.fromPort, 'out');
                const end = getPortPosition(conn.toNode, conn.toPort, 'in');

                const dx = Math.abs(end.x - start.x);
                const c1x = start.x + Math.max(dx / 2, 50);
                const c1y = start.y;
                const c2x = end.x - Math.max(dx / 2, 50);
                const c2y = end.y;

                const pathData = `M ${start.x} ${start.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${end.x} ${end.y}`;
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
                const pulseTs = connectionPulseById[conn.id] ?? 0;
                const elapsed = Math.max(0, now - pulseTs);
                const pulseActive = elapsed < PULSE_DURATION_MS;
                const pulseT = Math.min(1, elapsed / PULSE_DURATION_MS);
                const pulseX = cubicBezierAt(pulseT, start.x, c1x, c2x, end.x);
                const pulseY = cubicBezierAt(pulseT, start.y, c1y, c2y, end.y);
                const isSelected = selectedConnectionId === conn.id;

                return (
                    <g key={conn.id}>
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
            })}
            {pendingConnection && (() => {
                const start = { x: pendingConnection.startX, y: pendingConnection.startY };
                const end = { x: pendingConnection.currentX, y: pendingConnection.currentY };
                const dx = Math.abs(end.x - start.x);
                const distance = Math.sqrt(dx * dx + (end.y - start.y) ** 2);
                const cpOffset = Math.min(250, Math.max(50, distance / 2.5));
                const c1x = start.x + cpOffset;
                const c1y = start.y;
                const c2x = end.x - cpOffset;
                const c2y = end.y;
                const pathData = `M ${start.x} ${start.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${end.x} ${end.y}`;
                const baseColor = pendingConnection.signalType === 'midi'
                    ? 'var(--color-signal-midi)'
                    : pendingConnection.signalType === 'control'
                        ? 'var(--color-signal-control, #f59e0b)'
                        : 'var(--color-signal-audio)';
                return (
                    <path
                        d={pathData}
                        fill="none"
                        stroke={baseColor}
                        strokeWidth={2}
                        opacity={0.9}
                        strokeDasharray="6 4"
                        pointerEvents="none"
                    />
                );
            })()}
        </svg>
    );
}
