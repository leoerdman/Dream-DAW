import { useEffect, useMemo, useRef } from 'react';
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

export function ConnectionsLayer() {
    const connections = useFlowSynthStore((state) => state.connections);
    // Subscribe to the nodes array directly (stable reference from zustand).
    // Derive position-only data in useMemo to avoid re-computing getPortPosition
    // on every unrelated state change. Never use .map() inside a zustand selector
    // without a custom equality comparator — it creates new refs every call.
    const nodes = useFlowSynthStore((state) => state.nodes);
    const nodePositionData = useMemo(
        () => nodes.map(n => ({ id: n.id, type: n.type, x: n.position?.x ?? 0, y: n.position?.y ?? 0 })),
        [nodes]
    );
    const connectionPulseById = useFlowSynthStore((state) => state.connectionPulseById);
    const selectedConnectionId = useFlowSynthStore((state) => state.selectedConnectionId);
    const selectConnection = useFlowSynthStore((state) => state.selectConnection);
    const deleteConnection = useFlowSynthStore((state) => state.deleteConnection);
    const layerRef = useRef<SVGSVGElement>(null);

    useEffect(() => {
        return viewportProxy.subscribe((vp) => {
            if (layerRef.current) {
                layerRef.current.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
            }
        });
    }, []);

    // O(1) node lookup — rebuilds only when positions/IDs change, not on data changes
    const nodeMap = useMemo(() => new Map(nodePositionData.map(n => [n.id, n])), [nodePositionData]);

    // Calculate port position with multi-port support
    const getPortPosition = (nodeId: string, portId: string, side: 'in' | 'out') => {
        const node = nodeMap.get(nodeId);
        if (!node) return { x: 0, y: 0 };

        const config = PORT_REGISTRY[node.type as SynthNodeType];
        const px = node.x;
        const py = node.y;
        if (!config) return { x: px, y: py + FLOW_NODE_HEADER_HEIGHT };

        const portList = side === 'in' ? config.inputs : config.outputs;
        const portIndex = portList.findIndex((p) => p.id === portId);
        const idx = portIndex >= 0 ? portIndex : 0;

        const cy = FLOW_NODE_HEADER_HEIGHT + portCenterY(idx);
        const x = side === 'in' ? px : px + FLOW_NODE_WIDTH;
        return { x, y: py + cy };
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
                        selectConnection={selectConnection}
                        deleteConnection={deleteConnection}
                    />
                );
            })}

        </svg>
    );
}
