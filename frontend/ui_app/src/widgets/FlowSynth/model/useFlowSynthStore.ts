import { create } from 'zustand';
import * as engine from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { viewportProxy, type ViewportState } from '../lib/ViewportProxy';
import { nodeMotionProxy } from '../lib/NodeMotionProxy';
import { portNameToIndex, FLOW_NODE_HEADER_HEIGHT, type SynthNodeType } from './portRegistry';
import { FLOW_NODE_WIDTH } from '../ui/SynthNodeComponent';
import { FACTORY_PRESETS, clonePreset, type FlowPreset } from './flowPresets';

export type { SynthNodeType };
export type { FlowPreset };

export interface SynthNode {
    id: string;
    type: SynthNodeType;
    position: { x: number; y: number };
    /** AUDIT FIX: Replaced `any` with typed Record — enforces type narrowing at usage sites. */
    data: Record<string, unknown>;
}

export interface SynthConnection {
    id: string;
    fromNode: string;
    fromPort: string;
    toNode: string;
    toPort: string;
    signalType?: 'audio' | 'midi' | 'control' | 'gate' | 'phase';
}

export interface PendingConnection {
    fromNode: string;
    fromPort: string;
    signalType: 'audio' | 'midi' | 'control' | 'gate' | 'phase';
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
}

interface FlowGraph {
    nodes: SynthNode[];
    connections: SynthConnection[];
    viewport: ViewportState;
}

interface FlowSynthState {
    isOpen: boolean;
    activeDeviceId: string | null;
    activeTrackId: string | null;

    nodes: SynthNode[];
    connections: SynthConnection[];
    selectedNodeIds: string[];
    selectedConnectionId: string | null;
    connectionPulseById: Record<string, number>;
    pendingConnection: PendingConnection | null;
    graphsByDeviceId: Record<string, FlowGraph>;

    // ── Preset state ───────────────────────────────────────────────────
    presetName: string;
    presetIndex: number;

    openFlowEditor: (deviceId: string, trackId: string) => void;
    closeFlowEditor: () => void;

    addNode: (node: SynthNode) => void;
    selectNode: (id: string, multi?: boolean) => void;
    selectConnection: (id: string | null) => void;
    clearSelection: () => void;
    removeNode: (id: string) => void;
    updateNodeData: (id: string, patch: Record<string, unknown>) => void;
    deleteSelectedNodes: () => void;
    setSelectionBox: (box: { x: number; y: number; width: number; height: number } | null) => void;
    deleteConnection: (id: string) => void;
    updateNodePosition: (id: string, x: number, y: number) => void;
    setNodes: (nodes: SynthNode[]) => void;
    setConnections: (connections: SynthConnection[]) => void;
    startConnectionDrag: (connection: Omit<PendingConnection, 'currentX' | 'currentY'>) => void;
    updatePendingConnection: (x: number, y: number) => void;
    commitConnection: (toNode: string, toPort: string, signalType: 'audio' | 'midi' | 'control' | 'gate' | 'phase') => void;
    cancelConnectionDrag: () => void;
    pulseFromNode: (nodeId: string, signalType?: 'audio' | 'midi' | 'control' | 'gate' | 'phase') => void;
    pulseConnection: (connectionId: string) => void;
    syncFlowGraphToEngine: () => Promise<void>;

    // ── Preset actions ─────────────────────────────────────────────────
    loadPreset: (index: number) => void;
    nextPreset: () => void;
    prevPreset: () => void;
}



const DEFAULT_FLOW_GRAPH: FlowGraph = {
    nodes: [
        {
            id: 'node-midi-in-1',
            type: 'midiIn',
            position: { x: 80, y: 260 },
            data: { label: 'Track MIDI In' },
        },
        {
            id: 'node-osc-1',
            type: 'oscillator',
            position: { x: 380, y: 260 },
            data: { label: 'Oscillator' },
        },
        {
            id: 'node-out-1',
            type: 'output',
            position: { x: 720, y: 260 },
            data: { label: 'Audio Out' },
        },
    ],
    connections: [
        {
            id: 'conn-midi-freq-to-osc',
            fromNode: 'node-midi-in-1',
            fromPort: 'freq',
            toNode: 'node-osc-1',
            toPort: 'freq',
            signalType: 'control',
        },
        {
            id: 'conn-osc-to-out',
            fromNode: 'node-osc-1',
            fromPort: 'audio',
            toNode: 'node-out-1',
            toPort: 'audio',
            signalType: 'audio',
        },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
};

function stableNodeNumericId(nodeId: string): number {
    let hash = 2166136261 >>> 0;
    for (let i = 0; i < nodeId.length; i += 1) {
        hash ^= nodeId.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return (hash || 1) >>> 0;
}

// ENTERPRISE SSOT: Module-level ID map populated by syncFlowGraphToEngine.
// This is the SINGLE source of truth for string→numeric node ID mapping.
// updateNodeData reads from this map to ensure collision-resolved IDs match.
const _nodeIdMap = new Map<string, number>();

function resolvePortIndex(nodeId: string, portId: string, side: 'in' | 'out', nodesState: SynthNode[]): number {
    const node = nodesState.find((n) => n.id === nodeId);
    if (!node) return 0;
    return portNameToIndex(node.type as SynthNodeType, portId, side);
}

function cloneDefaultGraph(): FlowGraph {
    return {
        nodes: DEFAULT_FLOW_GRAPH.nodes.map((n) => ({
            ...n,
            position: { ...n.position },
            data: { ...(n.data ?? {}) },
        })),
        connections: DEFAULT_FLOW_GRAPH.connections.map((c) => ({ ...c })),
        viewport: { ...DEFAULT_FLOW_GRAPH.viewport },
    };
}

// BUG-N03 FIX: Module-level debounce guard for syncFlowGraphToEngine.
// Coalesces multiple mutations per microtask frame into a single sync call.
let _syncScheduled = false;
function _scheduleSyncFlowGraph(get: () => FlowSynthState): void {
    if (_syncScheduled) return;
    _syncScheduled = true;
    queueMicrotask(() => {
        _syncScheduled = false;
        get().syncFlowGraphToEngine();
    });
}

/**
 * ENTERPRISE SSOT: Single function to serialize FlowSynth config JSON.
 * Eliminates duplicate serialization in syncFlowGraphToEngine and _scheduleSaveConfig.
 */
function buildFlowConfigJson(state: FlowSynthState): string {
    return JSON.stringify({
        nodes: state.nodes.map(n => {
            const stringifiedData: Record<string, string> = {};
            if (n.data) {
                for (const [k, v] of Object.entries(n.data)) {
                    if (v !== null && v !== undefined) {
                        stringifiedData[k] = String(v);
                    }
                }
            }
            return {
                id: n.id,
                type: n.type,
                position_x: n.position.x,
                position_y: n.position.y,
                data: stringifiedData
            };
        }),
        connections: state.connections.map(c => ({
            id: c.id,
            from_node: c.fromNode,
            from_port: c.fromPort,
            to_node: c.toNode,
            to_port: c.toPort,
            signal_type: c.signalType ?? 'audio'
        })),
        viewport: viewportProxy.getViewport()
    });
}

// ENTERPRISE: Aggressively debounced disk-save (1.5 seconds).
// Separates the fast RT-safe parameter modulation from disk I/O serialization.
let _saveTimeout: number | null = null;
function _scheduleSaveConfig(get: () => FlowSynthState): void {
    // ENTERPRISE FIX (#11): Capture activeTrackId NOW to prevent writing
    // track A's data to track B if the user switches within the 1.5s debounce.
    const capturedTrackId = get().activeTrackId;
    if (_saveTimeout !== null) {
        window.clearTimeout(_saveTimeout);
    }
    _saveTimeout = window.setTimeout(async () => {
        _saveTimeout = null;
        if (!capturedTrackId) return;
        const state = get();
        // Double-check: if user switched tracks, abort this stale save.
        if (state.activeTrackId !== capturedTrackId) return;
        const trackIndex = useEngineStore.getState().tracks.allIds.indexOf(capturedTrackId);
        if (trackIndex < 0) return;
        await engine.saveFlowSynthConfig(trackIndex, buildFlowConfigJson(state));
    }, 1500);
}

export const useFlowSynthStore = create<FlowSynthState>()((set, get) => ({
    isOpen: false,
    activeDeviceId: null,
    activeTrackId: null,

    // AUDIT FIX: Single cloneDefaultGraph() call instead of two separate calls.
    ...(() => {
        const graph = cloneDefaultGraph();
        return { nodes: graph.nodes, connections: graph.connections };
    })(),
    selectedNodeIds: [],
    selectedConnectionId: null,
    connectionPulseById: {},
    pendingConnection: null,
    graphsByDeviceId: {},

    // ── Preset initial state ───────────────────────────────────────────
    presetName: FACTORY_PRESETS[0].name,
    presetIndex: 0,

    openFlowEditor: (deviceId, trackId) => set((state) => {
        let graph = state.graphsByDeviceId[deviceId];
        if (!graph) {
            // Enterprise Fix: Hydrate from SSOT project model first, fallback to default
            const track = useEngineStore.getState().tracks.byId[trackId];
            if (track?.flow_synth) {
                graph = {
                    nodes: track.flow_synth.nodes.map((n: any) => ({
                        id: n.id,
                        type: n.type as SynthNodeType,
                        position: { x: n.position_x, y: n.position_y },
                        data: n.data ?? {}
                    })),
                    connections: track.flow_synth.connections.map((c: any) => ({
                        id: c.id,
                        fromNode: c.from_node,
                        fromPort: c.from_port,
                        toNode: c.to_node,
                        // ENTERPRISE MIGRATION: audioL/audioR → audio (single stereo input)
                        toPort: (c.to_port === 'audioL' || c.to_port === 'audioR') ? 'audio' : c.to_port,
                        signalType: c.signal_type ?? 'audio'
                    })),
                    viewport: {
                        x: track.flow_synth.viewport?.x ?? 0,
                        y: track.flow_synth.viewport?.y ?? 0,
                        zoom: track.flow_synth.viewport?.zoom ?? 1
                    }
                };
            } else {
                graph = cloneDefaultGraph();
            }
        }

        viewportProxy.setViewport(graph.viewport ?? DEFAULT_FLOW_GRAPH.viewport);

        // CRITICAL: Sync graph to engine on editor open so the Rust backend
        // receives the graph and enables Flow processing for this track.
        _scheduleSyncFlowGraph(get);

        return {
            isOpen: true,
            activeDeviceId: deviceId,
            activeTrackId: trackId,
            nodes: graph.nodes,
            connections: graph.connections,
            selectedNodeIds: [],
            selectedConnectionId: null,
            pendingConnection: null,
            graphsByDeviceId: state.graphsByDeviceId[deviceId]
                ? state.graphsByDeviceId
                : { ...state.graphsByDeviceId, [deviceId]: graph },
        };
    }),

    closeFlowEditor: () => set((state: FlowSynthState) => {
        if (!state.activeDeviceId) {
            viewportProxy.reset();
            return {
                isOpen: false,
                activeDeviceId: null,
                activeTrackId: null,
                selectedNodeIds: [],
                selectedConnectionId: null,
                pendingConnection: null,
            };
        }
        const activeDeviceId = state.activeDeviceId;
        const nextGraphs = {
            ...state.graphsByDeviceId,
            [activeDeviceId]: {
                nodes: state.nodes,
                connections: state.connections,
                viewport: viewportProxy.getViewport(),
            },
        };
        viewportProxy.reset();
        return {
            isOpen: false,
            activeDeviceId: null,
            activeTrackId: null,
            selectedNodeIds: [],
            selectedConnectionId: null,
            pendingConnection: null,
            graphsByDeviceId: nextGraphs,
        };
    }),

    addNode: (node: SynthNode) => set((state: FlowSynthState) => {
        if (node.type === 'output' && state.nodes.some((n: SynthNode) => n.type === 'output')) {
            return {};
        }
        const hasDuplicateId = state.nodes.some((n: SynthNode) => n.id === node.id);
        const safeNode = hasDuplicateId
            ? { ...node, id: `${node.id}-${Math.random().toString(36).slice(2, 8)}` }
            : node;
        const nextNodes = [...state.nodes, safeNode];

        // Trigger sync
        _scheduleSyncFlowGraph(get);

        if (!state.activeDeviceId) return { nodes: nextNodes };
        return {
            nodes: nextNodes,
            selectedNodeIds: [safeNode.id],
            selectedConnectionId: null,
            graphsByDeviceId: {
                ...state.graphsByDeviceId,
                [state.activeDeviceId]: {
                    nodes: nextNodes,
                    connections: state.connections,
                    viewport: viewportProxy.getViewport(),
                },
            },
        };
    }),

    selectNode: (id: string, multi = false) => set((state) => {
        if (!multi) return { selectedNodeIds: [id], selectedConnectionId: null };
        const exists = state.selectedNodeIds.includes(id);
        return {
            selectedNodeIds: exists
                ? state.selectedNodeIds.filter((nodeId) => nodeId !== id)
                : [...state.selectedNodeIds, id],
            selectedConnectionId: null,
        };
    }),

    selectConnection: (id) => set({
        selectedConnectionId: id,
        selectedNodeIds: [],
    }),

    clearSelection: () => set({ selectedNodeIds: [], selectedConnectionId: null }),

    // FIX #3: removeNode — cascading connection cleanup + graph persistence
    removeNode: (id) => set((state) => {
        const nextNodes = state.nodes.filter((n) => n.id !== id);
        const nextConnections = state.connections.filter(
            (c) => c.fromNode !== id && c.toNode !== id,
        );

        // ENTERPRISE FIX (#7): Clean up proxy position data to prevent memory leaks.
        nodeMotionProxy.removeNode(id);

        // Trigger sync
        _scheduleSyncFlowGraph(get);

        return {
            nodes: nextNodes,
            connections: nextConnections,
            selectedNodeIds: state.selectedNodeIds.filter((nodeId) => nodeId !== id),
            selectedConnectionId: state.selectedConnectionId && nextConnections.some((c) => c.id === state.selectedConnectionId)
                ? state.selectedConnectionId
                : null,
            graphsByDeviceId: state.activeDeviceId
                ? {
                    ...state.graphsByDeviceId,
                    [state.activeDeviceId]: {
                        nodes: nextNodes,
                        connections: nextConnections,
                        viewport: viewportProxy.getViewport(),
                    },
                }
                : state.graphsByDeviceId,
        };
    }),

    updateNodeData: (id, patch) => {
        // ENTERPRISE: Do not re-sync the entire graph topology!
        // Just dispatch O(1) parameter updates into the audio engine queue.
        const state = get();
        const activeTrackId = state.activeTrackId;
        if (activeTrackId) {
            const trackIndex = useEngineStore.getState().tracks.allIds.indexOf(activeTrackId);
            if (trackIndex >= 0) {
                // ENTERPRISE SSOT: Read from the shared _nodeIdMap populated by syncFlowGraphToEngine.
                // This guarantees collision-resolved IDs match between full sync and param updates.
                const numericId = _nodeIdMap.get(id);
                if (numericId !== undefined && numericId > 0) {
                    for (const [key, val] of Object.entries(patch)) {
                        if (val !== null && val !== undefined) {
                            engine.updateFlowNodeParam(trackIndex, numericId, key, String(val)).catch((err: any) => {
                                console.warn('[FlowSynth] Failed to update param:', err);
                            });
                        }
                    }
                }
            }
        }

        // Schedule a slow, delayed write to the project `.dream` JSON file.
        _scheduleSaveConfig(get);

        return set((state) => {
            const nextNodes = state.nodes.map((node) => {
                if (node.id !== id) return node;
                return {
                    ...node,
                    data: {
                        ...(node.data ?? {}),
                        ...patch,
                    },
                };
            });
            return {
                nodes: nextNodes,
                graphsByDeviceId: state.activeDeviceId
                    ? {
                        ...state.graphsByDeviceId,
                        [state.activeDeviceId]: {
                            nodes: nextNodes,
                            connections: state.connections,
                            viewport: viewportProxy.getViewport(),
                        },
                    }
                    : state.graphsByDeviceId,
            };
        });
    },

    deleteSelectedNodes: () => set((state) => {
        if (state.selectedNodeIds.length === 0) return {};
        const selected = new Set(state.selectedNodeIds);
        const nextNodes = state.nodes.filter((node) => !selected.has(node.id));
        const nextConnections = state.connections.filter((conn) =>
            !selected.has(conn.fromNode) && !selected.has(conn.toNode),
        );

        // ENTERPRISE FIX (#7): Clean up proxy position data for all deleted nodes.
        selected.forEach((nodeId) => nodeMotionProxy.removeNode(nodeId));

        // Trigger sync
        _scheduleSyncFlowGraph(get);

        return {
            nodes: nextNodes,
            connections: nextConnections,
            selectedNodeIds: [],
            selectedConnectionId: null,
            graphsByDeviceId: state.activeDeviceId
                ? {
                    ...state.graphsByDeviceId,
                    [state.activeDeviceId]: {
                        nodes: nextNodes,
                        connections: nextConnections,
                        viewport: viewportProxy.getViewport(),
                    },
                }
                : state.graphsByDeviceId,
        };
    }),

    setSelectionBox: (box) => set((state) => {
        if (!box) return {};
        const selectedIds = state.nodes
            .filter((node) => {
                const left = node.position.x;
                const right = node.position.x + FLOW_NODE_WIDTH;
                const top = node.position.y;
                const bottom = node.position.y + FLOW_NODE_HEADER_HEIGHT + 100;
                return right >= box.x
                    && left <= box.x + box.width
                    && bottom >= box.y
                    && top <= box.y + box.height;
            })
            .map((node) => node.id);
        return { selectedNodeIds: selectedIds, selectedConnectionId: null };
    }),

    // FIX #3: deleteConnection — targeted removal
    deleteConnection: (id) => set((state) => {
        const nextConnections = state.connections.filter((c) => c.id !== id);

        // Trigger sync
        _scheduleSyncFlowGraph(get);

        return {
            connections: nextConnections,
            selectedConnectionId: state.selectedConnectionId === id ? null : state.selectedConnectionId,
            graphsByDeviceId: state.activeDeviceId
                ? {
                    ...state.graphsByDeviceId,
                    [state.activeDeviceId]: {
                        nodes: state.nodes,
                        connections: nextConnections,
                        viewport: viewportProxy.getViewport(),
                    },
                }
                : state.graphsByDeviceId,
        };
    }),

    // FIX #4: Map nodes ONCE, reuse for both `nodes` and `graphsByDeviceId`.
    updateNodePosition: (id, x, y) => set((state) => {
        const nextNodes = state.nodes.map((n) => {
            if (n.id !== id) return n;
            const safeX = Number.isFinite(x) ? x : n.position.x;
            const safeY = Number.isFinite(y) ? y : n.position.y;
            return { ...n, position: { x: safeX, y: safeY } };
        });
        return {
            nodes: nextNodes,
            graphsByDeviceId: state.activeDeviceId
                ? {
                    ...state.graphsByDeviceId,
                    [state.activeDeviceId]: {
                        nodes: nextNodes,
                        connections: state.connections,
                        viewport: viewportProxy.getViewport(),
                    },
                }
                : state.graphsByDeviceId,
        };
    }),

    setNodes: (nodes) => {
        _scheduleSyncFlowGraph(get);
        return set((state) => ({
            nodes,
            selectedNodeIds: state.selectedNodeIds.filter((id) => nodes.some((node) => node.id === id)),
            selectedConnectionId: state.selectedConnectionId && state.connections.some((c) => c.id === state.selectedConnectionId)
                ? state.selectedConnectionId
                : null,
            graphsByDeviceId: state.activeDeviceId
                ? {
                    ...state.graphsByDeviceId,
                    [state.activeDeviceId]: {
                        nodes,
                        connections: state.connections,
                        viewport: viewportProxy.getViewport(),
                    },
                }
                : state.graphsByDeviceId,
        }));
    },

    setConnections: (connections) => {
        _scheduleSyncFlowGraph(get);
        return set((state) => ({
            connections,
            selectedConnectionId: state.selectedConnectionId && connections.some((c) => c.id === state.selectedConnectionId)
                ? state.selectedConnectionId
                : null,
            graphsByDeviceId: state.activeDeviceId
                ? {
                    ...state.graphsByDeviceId,
                    [state.activeDeviceId]: {
                        nodes: state.nodes,
                        connections,
                        viewport: viewportProxy.getViewport(),
                    },
                }
                : state.graphsByDeviceId,
        }));
    },

    startConnectionDrag: (connection) => set({
        selectedConnectionId: null,
        pendingConnection: {
            ...connection,
            currentX: connection.startX,
            currentY: connection.startY,
        },
    }),

    updatePendingConnection: (x, y) => set((state) => {
        if (!state.pendingConnection) return {};
        return {
            pendingConnection: {
                ...state.pendingConnection,
                currentX: Number.isFinite(x) ? x : state.pendingConnection.currentX,
                currentY: Number.isFinite(y) ? y : state.pendingConnection.currentY,
            },
        };
    }),

    commitConnection: (toNode: string, toPort: string, signalType: 'audio' | 'midi' | 'control' | 'gate' | 'phase') => set((state: FlowSynthState) => {
        const pending = state.pendingConnection;
        if (!pending) return {};
        if (pending.fromNode === toNode) return { pendingConnection: null };
        if (pending.signalType !== signalType) return { pendingConnection: null };
        // Guard: exact duplicate
        const exists = state.connections.some((conn: SynthConnection) =>
            conn.fromNode === pending.fromNode
            && conn.fromPort === pending.fromPort
            && conn.toNode === toNode
            && conn.toPort === toPort,
        );
        if (exists) return { pendingConnection: null };
        // FIX #2 ENTERPRISE: Single-input guard — an input port accepts only one cable.
        // Multiple inputs require an explicit merge/mix node.
        const inputOccupied = state.connections.some(
            (conn: SynthConnection) => conn.toNode === toNode && conn.toPort === toPort,
        );
        if (inputOccupied) {
            console.warn(`[FlowSynth] Input port ${toPort} on node ${toNode} already connected. Use a merge node for multiple inputs.`);
            return { pendingConnection: null };
        }
        const newConnection: SynthConnection = {
            id: `conn-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`,
            fromNode: pending.fromNode,
            fromPort: pending.fromPort,
            toNode,
            toPort,
            signalType,
        };
        const nextConnections = [...state.connections, newConnection];

        // Trigger sync
        _scheduleSyncFlowGraph(get);

        return {
            connections: nextConnections,
            pendingConnection: null,
            graphsByDeviceId: state.activeDeviceId
                ? {
                    ...state.graphsByDeviceId,
                    [state.activeDeviceId]: {
                        nodes: state.nodes,
                        connections: nextConnections,
                        viewport: viewportProxy.getViewport(),
                    },
                }
                : state.graphsByDeviceId,
        };
    }),

    cancelConnectionDrag: () => set({ pendingConnection: null }),

    pulseFromNode: (nodeId, signalType = 'audio') => set((state) => {
        const now = Date.now();
        const nextPulseById = { ...state.connectionPulseById };

        // Phase 9.2: Memory Leak Garbage Collection
        Object.keys(nextPulseById).forEach((key) => {
            if (now - nextPulseById[key] > 1000) delete nextPulseById[key];
        });

        const pulsePatch: Record<string, number> = {};
        for (const conn of state.connections) {
            if (conn.fromNode !== nodeId) continue;
            const connSignal = conn.signalType ?? 'audio';
            if (connSignal !== signalType) continue;
            pulsePatch[conn.id] = now;
        }
        if (Object.keys(pulsePatch).length === 0) return { connectionPulseById: nextPulseById };
        return { connectionPulseById: { ...nextPulseById, ...pulsePatch } };
    }),

    pulseConnection: (connectionId) => set((state) => {
        const now = Date.now();
        const nextPulseById = { ...state.connectionPulseById };

        // Phase 9.2: Memory Leak Garbage Collection
        Object.keys(nextPulseById).forEach((key) => {
            if (now - nextPulseById[key] > 1000) delete nextPulseById[key];
        });

        nextPulseById[connectionId] = now;
        return { connectionPulseById: nextPulseById };
    }),

    syncFlowGraphToEngine: async () => {
        const state = useFlowSynthStore.getState();
        const activeTrackId = state.activeTrackId;
        if (!activeTrackId) return;

        const engineState = useEngineStore.getState();
        const trackIndex = engineState.tracks.allIds.indexOf(activeTrackId);
        if (trackIndex < 0) return;

        // Safety: enable Flow only on tracks that actually host a Flow instrument.
        const track = engineState.tracks.byId[activeTrackId];
        const hasFlowOnTrack =
            (track?.instrument?.plugin_id === 'internal://instrument/flow')
            || !!track?.effects?.some((slot) => slot.plugin_id === 'internal://instrument/flow');
        if (!hasFlowOnTrack) return;

        const idMap = new Map<string, number>();
        const used = new Set<number>();
        const mapNode = (id: string) => {
            if (idMap.has(id)) return idMap.get(id)!;
            let numeric = stableNodeNumericId(id);
            while (used.has(numeric)) numeric = (numeric + 1) >>> 0;
            used.add(numeric);
            idMap.set(id, numeric);
            return numeric;
        };

        // ENTERPRISE SSOT: Populate the module-level shared map so that
        // updateNodeData can reuse the exact collision-resolved IDs.
        state.nodes.forEach((n) => mapNode(n.id));
        _nodeIdMap.clear();
        idMap.forEach((v, k) => _nodeIdMap.set(k, v));

        const encodeNodeParams = (data: Record<string, unknown> | undefined): [string, string][] => {
            if (!data) return [];
            const out: [string, string][] = [];
            for (const [k, v] of Object.entries(data)) {
                if (v === null || v === undefined) continue;
                if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                    out.push([k, String(v)]);
                }
            }
            return out;
        };

        const nodes: [number, string, [string, string][]][] = state.nodes.map((n) => {
            const numericId = mapNode(n.id);
            return [numericId, n.type, encodeNodeParams(n.data)];
        });
        const connections: [number, number, number, number][] = state.connections.map((c) => {
            const fromId = mapNode(c.fromNode);
            const toId = mapNode(c.toNode);
            return [
                fromId,
                resolvePortIndex(c.fromNode, c.fromPort, 'out', state.nodes),
                toId,
                resolvePortIndex(c.toNode, c.toPort, 'in', state.nodes),
            ];
        });

        // Phase 7.3: Project Persistence (SSOT)
        // ENTERPRISE: Use shared buildFlowConfigJson to avoid divergent serialization.
        const configJson = buildFlowConfigJson(state);

        // ENTERPRISE FIX: Sequential awaits — setFlowEnabled MUST complete before
        // syncFlowGraph. The engine must be enabled before it processes graph data,
        // otherwise the graph sync arrives while the engine is still in disabled
        // state and may be silently dropped or cause state inconsistency.
        await engine.setFlowEnabled(trackIndex, true);
        await Promise.all([
            engine.syncFlowGraph(trackIndex, nodes, connections),
            engine.saveFlowSynthConfig(trackIndex, configJson)
        ]);
    },

    // ── Preset Actions ─────────────────────────────────────────────────
    loadPreset: (index: number) => {
        const total = FACTORY_PRESETS.length;
        if (total === 0) return;
        const safeIndex = ((index % total) + total) % total;
        const preset = clonePreset(FACTORY_PRESETS[safeIndex]);

        set({
            nodes: preset.nodes,
            connections: preset.connections,
            presetName: preset.name,
            presetIndex: safeIndex,
            selectedNodeIds: [],
            selectedConnectionId: null,
            pendingConnection: null,
        });

        // Sync new graph to engine + save to disk
        _scheduleSyncFlowGraph(get);
        _scheduleSaveConfig(get);
    },

    nextPreset: () => {
        const { presetIndex, loadPreset } = get();
        loadPreset(presetIndex + 1);
    },

    prevPreset: () => {
        const { presetIndex, loadPreset } = get();
        loadPreset(presetIndex - 1);
    },
}));
