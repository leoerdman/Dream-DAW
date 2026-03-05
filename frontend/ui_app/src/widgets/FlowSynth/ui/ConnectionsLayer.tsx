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
import { FlowConnectionComponent } from './FlowConnectionComponent';
import { signalColor } from './FlowNodeStyles';

const PULSE_DURATION_MS = 520;

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
                const initialStart = getPortPosition(conn.fromNode, conn.fromPort, 'out');
                const initialEnd = getPortPosition(conn.toNode, conn.toPort, 'in');
                const isSelected = selectedConnectionId === conn.id;
                const pulseTs = connectionPulseById[conn.id] ?? 0;

                return (
                    <FlowConnectionComponent
                        key={conn.id}
                        conn={conn}
                        initialStart={initialStart}
                        initialEnd={initialEnd}
                        isSelected={isSelected}
                        pulseTs={pulseTs}
                        now={now}
                        selectConnection={selectConnection}
                        deleteConnection={deleteConnection}
                    />
                );
            })}
            {pendingConnection && (() => {
                const start = { x: pendingConnection.startX, y: pendingConnection.startY };
                const end = { x: pendingConnection.currentX, y: pendingConnection.currentY };
                const dx = Math.abs(end.x - start.x);
                const distance = Math.sqrt(dx * dx + (end.y - start.y) ** 2);
                // ENTERPRISE: Match improved bezier formula from FlowConnectionComponent
                const cpOffset = Math.min(200, Math.max(30, distance / 3));
                const c1x = start.x + cpOffset;
                const c1y = start.y;
                const c2x = end.x - cpOffset;
                const c2y = end.y;
                const pathData = `M ${start.x} ${start.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${end.x} ${end.y}`;
                const baseColor = signalColor(pendingConnection.signalType);
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
