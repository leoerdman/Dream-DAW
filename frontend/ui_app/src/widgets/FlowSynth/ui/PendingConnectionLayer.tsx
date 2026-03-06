import { useEffect, useRef } from 'react';
import { useFlowSynthStore } from '../model/useFlowSynthStore';
import { viewportProxy } from '../lib/ViewportProxy';
import {
    PORT_REGISTRY,
    FLOW_NODE_HEADER_HEIGHT,
    FLOW_CONNECTION_SNAP_DIST,
    portCenterY,
    type SynthNodeType
} from '../model/portRegistry';
import { signalColor } from './FlowNodeStyles';

function toWorld(clientX: number, clientY: number, canvas: HTMLElement) {
    const rect = canvas.getBoundingClientRect();
    const vp = viewportProxy.getViewport();
    return {
        x: (clientX - rect.left - vp.x) / vp.zoom,
        y: (clientY - rect.top - vp.y) / vp.zoom,
    };
}

export function PendingConnectionLayer({ viewportRef }: { viewportRef: React.RefObject<HTMLDivElement | null> }) {
    const pendingConnection = useFlowSynthStore((state) => state.pendingConnection);
    const commitConnection = useFlowSynthStore((state) => state.commitConnection);
    const cancelConnectionDrag = useFlowSynthStore((state) => state.cancelConnectionDrag);
    const layerRef = useRef<SVGSVGElement>(null);
    const pathRef = useRef<SVGPathElement>(null);
    const currentPos = useRef({ x: 0, y: 0 });

    useEffect(() => {
        return viewportProxy.subscribe((vp) => {
            if (layerRef.current) {
                layerRef.current.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
            }
        });
    }, []);

    useEffect(() => {
        if (!pendingConnection) return;

        currentPos.current = { x: pendingConnection.startX, y: pendingConnection.startY };

        const updatePath = (endX: number, endY: number) => {
            if (!pathRef.current) return;
            const startX = pendingConnection.startX;
            const startY = pendingConnection.startY;
            const dx = Math.abs(endX - startX);
            const distance = Math.sqrt(dx * dx + (endY - startY) ** 2);
            const cpOffset = Math.min(200, Math.max(30, distance / 3));
            const c1x = startX + cpOffset;
            const c1y = startY;
            const c2x = endX - cpOffset;
            const c2y = endY;
            const d = `M ${startX} ${startY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${endX} ${endY}`;
            pathRef.current.setAttribute('d', d);
        };

        // Initial render
        updatePath(currentPos.current.x, currentPos.current.y);

        const findSnapTarget = (worldX: number, worldY: number) => {
            // Need the latest nodes and connections directly to avoid subscribing and causing re-renders manually
            const { nodes, connections } = useFlowSynthStore.getState();
            const occupiedInputs = new Set(
                connections.map((conn) => `${conn.toNode}:${conn.toPort}`)
            );
            let best: { nodeId: string; signalType: 'audio' | 'midi' | 'control' | 'gate' | 'phase'; toPort: string; x: number; y: number; occupied: boolean } | null = null;
            let bestDist = Infinity;
            for (const node of nodes) {
                if (node.id === pendingConnection.fromNode) continue;
                if (!node.position) continue;
                const config = PORT_REGISTRY[node.type as SynthNodeType];
                if (!config || config.inputs.length === 0) continue;
                for (let pi = 0; pi < config.inputs.length; pi++) {
                    const portDef = config.inputs[pi];
                    // ENTERPRISE BUG-14 FIX: Map ALL signal types including gate and phase
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
                    const dx = worldX - x;
                    const dy = worldY - y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
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
            const canvas = viewportRef.current;
            if (!canvas) return;
            const world = toWorld(e.clientX, e.clientY, canvas);
            const snapTarget = findSnapTarget(world.x, world.y);

            if (snapTarget) {
                currentPos.current = { x: snapTarget.x, y: snapTarget.y };
            } else {
                currentPos.current = { x: world.x, y: world.y };
            }

            // ENTERPRISE: Lock-free DOM update bypassing React reconciliation
            requestAnimationFrame(() => {
                updatePath(currentPos.current.x, currentPos.current.y);
            });
        };

        const onPointerUp = (e: PointerEvent) => {
            const canvas = viewportRef.current;
            if (!canvas) return;
            const world = toWorld(e.clientX, e.clientY, canvas);
            const snapTarget = findSnapTarget(world.x, world.y);
            if (snapTarget) {
                commitConnection(snapTarget.nodeId, snapTarget.toPort, snapTarget.signalType);
                return;
            }
            cancelConnectionDrag();
        };

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp, { once: true });
        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
        };
    }, [pendingConnection, cancelConnectionDrag, commitConnection, viewportRef]);

    if (!pendingConnection) return null;

    const baseColor = signalColor(pendingConnection.signalType);

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
                zIndex: 2,
            }}
        >
            <path
                ref={pathRef}
                fill="none"
                stroke={baseColor}
                strokeWidth={2.5}
                strokeLinecap="round"
                opacity={0.9}
            />
        </svg>
    );
}
