import { useEffect, useRef, useState } from 'react';
import { useFlowSynthStore } from '../model/useFlowSynthStore';
import { viewportProxy } from '../lib/ViewportProxy';
import { FLOW_NODE_PORT_CENTER_Y, FLOW_NODE_WIDTH } from '../model/useFlowSynthStore';

const PULSE_DURATION_MS = 520;

function cubicBezierAt(t: number, p0: number, p1: number, p2: number, p3: number): number {
    const mt = 1 - t;
    return (mt ** 3) * p0 + 3 * (mt ** 2) * t * p1 + 3 * mt * (t ** 2) * p2 + (t ** 3) * p3;
}

export function ConnectionsLayer() {
    const connections = useFlowSynthStore((state) => state.connections);
    const nodes = useFlowSynthStore((state) => state.nodes);
    const connectionPulseById = useFlowSynthStore((state) => state.connectionPulseById);
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

    // Keep connection geometry in sync with actual node dimensions.
    const getPortPosition = (nodeId: string, type: 'in' | 'out') => {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return { x: 0, y: 0 };
        const portY = node.position.y + FLOW_NODE_PORT_CENTER_Y;
        const portX = type === 'in' ? node.position.x : node.position.x + FLOW_NODE_WIDTH;
        return { x: portX, y: portY };
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
                pointerEvents: 'none',
                willChange: 'transform',
                zIndex: 1,
            }}
        >
            {connections.map((conn) => {
                const start = getPortPosition(conn.fromNode, 'out');
                const end = getPortPosition(conn.toNode, 'in');

                // Smooth bezier curve
                const c1x = start.x + Math.max(Math.abs(end.x - start.x) / 2, 50);
                const c1y = start.y;
                const c2x = end.x - Math.max(Math.abs(end.x - start.x) / 2, 50);
                const c2y = end.y;

                const pathData = `M ${start.x} ${start.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${end.x} ${end.y}`;
                const signalType = conn.signalType ?? 'audio';
                const baseColor = signalType === 'midi'
                    ? 'var(--color-signal-midi)'
                    : 'var(--color-signal-audio)';
                const glowColor = signalType === 'midi'
                    ? 'color-mix(in srgb, var(--color-signal-midi) 72%, transparent)'
                    : 'color-mix(in srgb, var(--color-signal-audio) 72%, transparent)';
                const pulseTs = connectionPulseById[conn.id] ?? 0;
                const elapsed = Math.max(0, now - pulseTs);
                const pulseActive = elapsed < PULSE_DURATION_MS;
                const pulseT = Math.min(1, elapsed / PULSE_DURATION_MS);
                const pulseX = cubicBezierAt(pulseT, start.x, c1x, c2x, end.x);
                const pulseY = cubicBezierAt(pulseT, start.y, c1y, c2y, end.y);

                return (
                    <g key={conn.id}>
                        {/* Invisible thicker stroke for easier hover/click interactions later */}
                        <path
                            d={pathData}
                            fill="none"
                            stroke="transparent"
                            strokeWidth={20}
                            pointerEvents="stroke"
                        />
                        {/* Glow layer */}
                        <path
                            d={pathData}
                            fill="none"
                            stroke={glowColor}
                            strokeWidth={6}
                            opacity={0.3}
                            style={{ filter: 'blur(4px)' }}
                        />
                        {/* Core connection path */}
                        <path
                            d={pathData}
                            fill="none"
                            stroke={baseColor}
                            strokeWidth={2.5}
                            opacity={1.0}
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
                            />
                        )}
                    </g>
                );
            })}
        </svg>
    );
}
