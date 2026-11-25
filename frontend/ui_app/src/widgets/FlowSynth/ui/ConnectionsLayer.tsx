import { useEffect, useMemo, useRef } from 'react';
import { useFlowSynthStore } from '../model/useFlowSynthStore';
import { viewportProxy } from '../lib/ViewportProxy';
import { findSnapTarget } from '../lib/findSnapTarget';
import {
    PORT_REGISTRY,
    FLOW_NODE_HEADER_HEIGHT,
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

        // ENTERPRISE: Use shared findSnapTarget utility (Single Source of Truth)
        const findSnap = (worldX: number, worldY: number) =>
            findSnapTarget(worldX, worldY, pendingConnection.fromNode, pendingConnection.signalType);

        const onPointerMove = (e: PointerEvent) => {
            const world = toWorld(e.clientX, e.clientY);
            const snap = findSnap(world.x, world.y);
            const endX = snap ? snap.x : world.x;
            const endY = snap ? snap.y : world.y;
            requestAnimationFrame(() => updatePath(endX, endY));
        };

        const cleanup = () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onCancel);
        };

        const onPointerUp = (e: PointerEvent) => {
            cleanup();
            const world = toWorld(e.clientX, e.clientY);
            const snap = findSnap(world.x, world.y);
            if (snap) {
                commitConnection(snap.nodeId, snap.toPort, snap.signalType);
            } else {
                cancelConnectionDrag();
            }
        };

        // ENTERPRISE: Handle pointer cancel (tab switch, system dialog, touch interruption)
        // to prevent orphaned pointermove listeners from leaking.
        const onCancel = () => {
            cleanup();
            cancelConnectionDrag();
        };

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onCancel);
        return cleanup;
    }, [pendingConnection, commitConnection, cancelConnectionDrag, viewportRef]);

    // BUG-007 FIX: Pre-compute port index maps for O(1) lookups instead of O(N) findIndex.
    const portIndexMaps = useMemo(() => {
        const maps = new Map<string, { inputs: Map<string, number>; outputs: Map<string, number> }>();
        for (const n of nodes) {
            const config = PORT_REGISTRY[n.type as SynthNodeType];
            if (!config) continue;
            const inputs = new Map<string, number>();
            const outputs = new Map<string, number>();
            config.inputs.forEach((p, i) => inputs.set(p.id, i));
            config.outputs.forEach((p, i) => outputs.set(p.id, i));
            maps.set(n.id, { inputs, outputs });
        }
        return maps;
    }, [nodes]);

    // O(1) node lookup
    const nodePositionData = useMemo(
        () => nodes.map(n => ({ id: n.id, type: n.type, x: n.position?.x ?? 0, y: n.position?.y ?? 0 })),
        [nodes]
    );
    const nodeMap = useMemo(() => new Map(nodePositionData.map(n => [n.id, n])), [nodePositionData]);

    const getPortPosition = (nodeId: string, portId: string, side: 'in' | 'out'): { x: number; y: number } | null => {
        const node = nodeMap.get(nodeId);
        // BUG-A FIX: Return null instead of (0,0) when node is missing.
        // This prevents connections from visually snapping to top-left corner.
        if (!node) return null;
        const px = node.x;
        const py = node.y;
        // BUG-007 FIX: O(1) port index lookup via pre-computed map.
        const portMaps = portIndexMaps.get(nodeId);
        const portIndex = side === 'in'
            ? portMaps?.inputs.get(portId) ?? 0
            : portMaps?.outputs.get(portId) ?? 0;
        const cy = FLOW_NODE_HEADER_HEIGHT + portCenterY(portIndex);
        const x = side === 'in' ? px : px + FLOW_NODE_WIDTH;
        return { x, y: py + cy };
    };

    // Deterministic port offset from PORT_REGISTRY — no proxy timing dependency.
    const getPortOffsetY = (nodeId: string, portId: string, side: 'in' | 'out') => {
        // BUG-007 FIX: O(1) port index lookup via pre-computed map.
        const portMaps = portIndexMaps.get(nodeId);
        const portIndex = side === 'in'
            ? portMaps?.inputs.get(portId) ?? 0
            : portMaps?.outputs.get(portId) ?? 0;
        return FLOW_NODE_HEADER_HEIGHT + portCenterY(portIndex);
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
                // BUG-A FIX: Skip connections where either endpoint node is missing.
                // This prevents connections from rendering at (0,0) during transitions.
                if (!initialStart || !initialEnd) return null;
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
