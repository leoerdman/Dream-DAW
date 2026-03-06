/**
 * Flow Synth — Shared snap target finder.
 *
 * ENTERPRISE: Extracted from duplicate implementations in ConnectionsLayer
 * and PendingConnectionLayer to enforce DRY (Don't Repeat Yourself).
 * Single source of truth for connection snap-to-port logic.
 */
import { useFlowSynthStore } from '../model/useFlowSynthStore';
import {
    PORT_REGISTRY,
    FLOW_NODE_HEADER_HEIGHT,
    FLOW_CONNECTION_SNAP_DIST,
    portCenterY,
    type SynthNodeType,
} from '../model/portRegistry';

export interface SnapTarget {
    nodeId: string;
    signalType: 'audio' | 'midi' | 'control' | 'gate' | 'phase';
    toPort: string;
    x: number;
    y: number;
    occupied: boolean;
}

/**
 * Find the best snap target for a pending connection at the given world coordinates.
 *
 * @param worldX — X in canvas world coordinates
 * @param worldY — Y in canvas world coordinates
 * @param fromNodeId — The source node ID to exclude from targets
 * @param requiredSignalType — Only match ports with this signal type
 * @returns The best snap target, or null if none found
 */
export function findSnapTarget(
    worldX: number,
    worldY: number,
    fromNodeId: string,
    requiredSignalType: 'audio' | 'midi' | 'control' | 'gate' | 'phase',
): SnapTarget | null {
    const { nodes, connections } = useFlowSynthStore.getState();
    const occupiedInputs = new Set(
        connections.map((c) => `${c.toNode}:${c.toPort}`),
    );

    let best: SnapTarget | null = null;
    let bestDist = Infinity;

    for (const node of nodes) {
        if (node.id === fromNodeId) continue;
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
            if (signalType !== requiredSignalType) continue;

            const toPort = portDef.id;
            const x = node.position.x;
            const y = node.position.y + FLOW_NODE_HEADER_HEIGHT + portCenterY(pi);
            const dx = worldX - x;
            const dy = worldY - y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist >= FLOW_CONNECTION_SNAP_DIST) continue;

            const occupied = occupiedInputs.has(`${node.id}:${toPort}`);
            // Prefer unoccupied ports; among same-occupancy, prefer closest
            if (!best || (best.occupied && !occupied) || (best.occupied === occupied && dist < bestDist)) {
                bestDist = dist;
                best = { nodeId: node.id, signalType, toPort, x, y, occupied };
            }
        }
    }

    return best;
}
