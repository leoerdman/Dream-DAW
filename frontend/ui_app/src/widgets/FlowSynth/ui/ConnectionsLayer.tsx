import { useEffect, useMemo, useRef } from 'react';
import { useFlowSynthStore } from '../model/useFlowSynthStore';
import { viewportProxy } from '../lib/ViewportProxy';
import {
    PORT_REGISTRY,
    FLOW_NODE_HEADER_HEIGHT,
    FLOW_CONNECTION_SNAP_DIST,
    portCenterY,
    type SynthNodeType,
} from '../model/portRegistry';
import { FLOW_NODE_WIDTH } from './SynthNodeComponent';
import { FlowConnectionComponent } from './FlowConnectionComponent';
import { signalColor } from './FlowNodeStyles';

export function ConnectionsLayer({ viewportRef }: { viewportRef: React.RefObject<HTMLDivElement | null> }) {
    const connections = useFlowSynthStore((state) => state.connections);
    const nodes = useFlowSynthStore((state) => state.nodes);
    const pendingConnection = useFlowSynthStore((state) => state.pendingConnection);
    const commitConnection = useFlowSynthStore((state) => state.commitConnection);
    const cancelConnectionDrag = useFlowSynthStore((state) => state.cancelConnectionDrag);
    const connectionPulseById = useFlowSynthStore((state) => state.connectionPulseById);
    const selectedConnectionId = useFlowSynthStore((state) => state.selectedConnectionId);
    const selectConnection = useFlowSynthStore((state) => state.selectConnection);
    const deleteConnection = useFlowSynthStore((state) => state.deleteConnection);
    const layerRef = useRef<SVGSVGElement>(null);
    const pendingPathRef = useRef<SVGPathElement>(null);

    useEffect(() => {
        return viewportProxy.subscribe((vp) => {
            if (layerRef.current) {
                layerRef.current.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
            }
        });
    }, []);

    // ── Pending connection drag handler ──────────────────────────────
    useEffect(() => {
        if (!pendingConnection) return;

        const updatePath = (endX: number, endY: number) => {
            if (!pendingPathRef.current) return;
            const startX = pendingConnection.startX;
            const startY = pendingConnection.startY;
            const dx = Math.abs(endX - startX);
            const distance = Math.sqrt(dx * dx + (endY - startY) ** 2);
            const cpOffset = Math.min(200, Math.max(30, distance / 3));
            const d = `M ${startX} ${startY} C ${startX + cpOffset} ${startY}, ${endX - cpOffset} ${endY}, ${endX} ${endY}`;
            pendingPathRef.current.setAttribute('d', d);
        };

        // Render initial position at the start point
        updatePath(pendingConnection.startX, pendingConnection.startY);

        function toWorld(clientX: number, clientY: number): { x: number; y: number } {
            const canvas = viewportRef.current;
            if (!canvas) return { x: 0, y: 0 };
            const rect = canvas.getBoundingClientRect();
            const vp = viewportProxy.getViewport();
            return {
                x: (clientX - rect.left - vp.x) / vp.zoom,
                y: (clientY - rect.top - vp.y) / vp.zoom,
            };
        }

        const findSnapTarget = (worldX: number, worldY: number) => {
            const { nodes: liveNodes, connections: liveConns } = useFlowSynthStore.getState();
            const occupiedInputs = new Set(liveConns.map((c) => `${c.toNode}:${c.toPort}`));
            let best: { nodeId: string; signalType: 'audio' | 'midi' | 'control' | 'gate' | 'phase'; toPort: string; x: number; y: number; occupied: boolean } | null = null;
            let bestDist = Infinity;
            for (const node of liveNodes) {
                if (node.id === pendingConnection.fromNode) continue;
                if (!node.position) continue;
                const config = PORT_REGISTRY[node.type as SynthNodeType];
                if (!config || config.inputs.length === 0) continue;
                for (let pi = 0; pi < config.inputs.length; pi++) {
                    const portDef = config.inputs[pi];
                    const signalType: 'audio' | 'midi' | 'control' | 'gate' | 'phase' =
                        portDef.type === 'midi' ? 'midi'
                            : portDef.type === 'control' ? 'control'
                                : portDef.type === 'gate' ? 'gate'
                                    : portDef.type === 'phase' ? 'phase'
                                        : 'audio';
                    if (signalType !== pendingConnection.signalType) continue;
                    const toPort = portDef.id;
                    const x = node.position.x;
                    const y = node.position.y + FLOW_NODE_HEADER_HEIGHT + portCenterY(pi);
                    const ddx = worldX - x;
                    const ddy = worldY - y;
                    const dist = Math.sqrt(ddx * ddx + ddy * ddy);
                    if (dist >= FLOW_CONNECTION_SNAP_DIST) continue;
                    const occupied = occupiedInputs.has(`${node.id}:${toPort}`);
                    if (!best || (best.occupied && !occupied) || (best.occupied === occupied && dist < bestDist)) {
                        bestDist = dist;
                        best = { nodeId: node.id, signalType, toPort, x, y, occupied };
                    }
                }
            }
            return best;
        };

        const onPointerMove = (e: PointerEvent) => {
            const world = toWorld(e.clientX, e.clientY);
            const snap = findSnapTarget(world.x, world.y);
            const endX = snap ? snap.x : world.x;
            const endY = snap ? snap.y : world.y;
            requestAnimationFrame(() => updatePath(endX, endY));
        };

        const onPointerUp = (e: PointerEvent) => {
            const world = toWorld(e.clientX, e.clientY);
            const snap = findSnapTarget(world.x, world.y);
            if (snap) {
                commitConnection(snap.nodeId, snap.toPort, snap.signalType);
            } else {
                cancelConnectionDrag();
            }
        };

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp, { once: true });
        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
        };
    }, [pendingConnection, commitConnection, cancelConnectionDrag, viewportRef]);

    // O(1) node lookup
    const nodePositionData = useMemo(
        () => nodes.map(n => ({ id: n.id, type: n.type, x: n.position?.x ?? 0, y: n.position?.y ?? 0 })),
        [nodes]
    );
    const nodeMap = useMemo(() => new Map(nodePositionData.map(n => [n.id, n])), [nodePositionData]);

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

    // Deterministic port offset from PORT_REGISTRY — no proxy timing dependency.
    const getPortOffsetY = (nodeId: string, portId: string, side: 'in' | 'out') => {
        const node = nodeMap.get(nodeId);
        if (!node) return FLOW_NODE_HEADER_HEIGHT;
        const config = PORT_REGISTRY[node.type as SynthNodeType];
        if (!config) return FLOW_NODE_HEADER_HEIGHT;
        const portList = side === 'in' ? config.inputs : config.outputs;
        const portIndex = portList.findIndex((p) => p.id === portId);
        const idx = portIndex >= 0 ? portIndex : 0;
        return FLOW_NODE_HEADER_HEIGHT + portCenterY(idx);
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
                const fromPortOffsetY = getPortOffsetY(conn.fromNode, conn.fromPort, 'out');
                const toPortOffsetY = getPortOffsetY(conn.toNode, conn.toPort, 'in');
                const isSelected = selectedConnectionId === conn.id;
                const pulseTs = connectionPulseById[conn.id] ?? 0;
                return (
                    <FlowConnectionComponent
                        key={conn.id}
                        conn={conn}
                        initialStart={initialStart}
                        initialEnd={initialEnd}
                        fromPortOffsetY={fromPortOffsetY}
                        toPortOffsetY={toPortOffsetY}
                        isSelected={isSelected}
                        pulseTs={pulseTs}
                        selectConnection={selectConnection}
                        deleteConnection={deleteConnection}
                    />
                );
            })}
            {/* Pending cable — rendered inline in the same SVG coordinate space
                as committed connections. Uses imperative ref updates to avoid
                React reconciliation on every pointer move. */}
            {pendingConnection && (
                <path
                    ref={pendingPathRef}
                    fill="none"
                    stroke={signalColor(pendingConnection.signalType)}
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    opacity={0.9}
                    pointerEvents="none"
                />
            )}
        </svg>
    );
}
