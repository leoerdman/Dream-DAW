import { create } from 'zustand';
import type { ViewportState } from '../lib/ViewportProxy';
import { viewportProxy } from '../lib/ViewportProxy';

export type SynthNodeType = 'midiIn' | 'oscillator' | 'filter' | 'envelope' | 'output';
export const FLOW_NODE_WIDTH = 260;
export const FLOW_NODE_HEADER_HEIGHT = 48;
export const FLOW_NODE_BODY_MIN_HEIGHT = 100;
export const FLOW_NODE_PORT_CENTER_Y = FLOW_NODE_HEADER_HEIGHT + FLOW_NODE_BODY_MIN_HEIGHT / 2;

export interface SynthNode {
    id: string;
    type: SynthNodeType;
    position: { x: number; y: number };
    data: any;
}

export interface SynthConnection {
    id: string;
    fromNode: string;
    fromPort: string;
    toNode: string;
    toPort: string;
    signalType?: 'audio' | 'midi';
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
    connectionPulseById: Record<string, number>;
    graphsByDeviceId: Record<string, FlowGraph>;

    openFlowEditor: (deviceId: string, trackId: string) => void;
    closeFlowEditor: () => void;

    addNode: (node: SynthNode) => void;
    updateNodePosition: (id: string, x: number, y: number) => void;
    setNodes: (nodes: SynthNode[]) => void;
    setConnections: (connections: SynthConnection[]) => void;
    pulseFromNode: (nodeId: string, signalType?: 'audio' | 'midi') => void;
    pulseConnection: (connectionId: string) => void;
}

const DEFAULT_FLOW_GRAPH: FlowGraph = {
    nodes: [
        {
            id: 'node-midi-in-1',
            type: 'midiIn',
            position: { x: 80, y: 280 },
            data: { label: 'Track MIDI In' },
        },
        {
            id: 'node-osc-1',
            type: 'oscillator',
            position: { x: 380, y: 280 },
            data: { label: 'Oscillator (free-run + MIDI)' },
        },
        {
            id: 'node-out-1',
            type: 'output',
            position: { x: 720, y: 280 },
            data: { label: 'Audio Out' },
        },
    ],
    connections: [
        {
            id: 'conn-midi-in-1',
            fromNode: 'node-midi-in-1',
            fromPort: 'midi-out',
            toNode: 'node-osc-1',
            toPort: 'midi-in',
            signalType: 'midi',
        },
        {
            id: 'conn-audio-out-1',
            fromNode: 'node-osc-1',
            fromPort: 'audio-out',
            toNode: 'node-out-1',
            toPort: 'audio-in',
            signalType: 'audio',
        },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
};

function cloneDefaultGraph(): FlowGraph {
    return {
        nodes: DEFAULT_FLOW_GRAPH.nodes.map((n) => ({
            ...n,
            position: { ...n.position },
            data: n.data ? { ...n.data } : undefined,
        })),
        connections: DEFAULT_FLOW_GRAPH.connections.map((c) => ({ ...c })),
        viewport: { ...DEFAULT_FLOW_GRAPH.viewport },
    };
}

export const useFlowSynthStore = create<FlowSynthState>()((set) => ({
    isOpen: false,
    activeDeviceId: null,
    activeTrackId: null,

    nodes: cloneDefaultGraph().nodes,
    connections: cloneDefaultGraph().connections,
    connectionPulseById: {},
    graphsByDeviceId: {},

    openFlowEditor: (deviceId, trackId) => set((state) => {
        const graph = state.graphsByDeviceId[deviceId] ?? cloneDefaultGraph();
        viewportProxy.setViewport(graph.viewport ?? DEFAULT_FLOW_GRAPH.viewport);
        return {
            isOpen: true,
            activeDeviceId: deviceId,
            activeTrackId: trackId,
            nodes: graph.nodes,
            connections: graph.connections,
            graphsByDeviceId: state.graphsByDeviceId[deviceId]
                ? state.graphsByDeviceId
                : { ...state.graphsByDeviceId, [deviceId]: graph },
        };
    }),

    closeFlowEditor: () => set((state) => {
        if (!state.activeDeviceId) {
            viewportProxy.reset();
            return {
                isOpen: false,
                activeDeviceId: null,
                activeTrackId: null,
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
            graphsByDeviceId: nextGraphs,
        };
    }),

    addNode: (node) => set((state) => {
        if (node.type === 'output' && state.nodes.some((n) => n.type === 'output')) {
            return {};
        }
        const hasDuplicateId = state.nodes.some((n) => n.id === node.id);
        const safeNode = hasDuplicateId
            ? { ...node, id: `${node.id}-${Math.random().toString(36).slice(2, 8)}` }
            : node;
        const nextNodes = [...state.nodes, safeNode];
        if (!state.activeDeviceId) return { nodes: nextNodes };
        return {
            nodes: nextNodes,
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

    updateNodePosition: (id, x, y) => set((state) => ({
        nodes: state.nodes.map((n) => {
            if (n.id !== id) return n;
            const safeX = Number.isFinite(x) ? x : n.position.x;
            const safeY = Number.isFinite(y) ? y : n.position.y;
            return { ...n, position: { x: safeX, y: safeY } };
        }),
        graphsByDeviceId: state.activeDeviceId
            ? {
                ...state.graphsByDeviceId,
                [state.activeDeviceId]: {
                    nodes: state.nodes.map((n) => {
                        if (n.id !== id) return n;
                        const safeX = Number.isFinite(x) ? x : n.position.x;
                        const safeY = Number.isFinite(y) ? y : n.position.y;
                        return { ...n, position: { x: safeX, y: safeY } };
                    }),
                    connections: state.connections,
                    viewport: viewportProxy.getViewport(),
                },
            }
            : state.graphsByDeviceId,
    })),

    setNodes: (nodes) => set((state) => ({
        nodes,
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
    })),

    setConnections: (connections) => set((state) => ({
        connections,
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
    })),

    pulseFromNode: (nodeId, signalType = 'audio') => set((state) => {
        const now = Date.now();
        const pulsePatch: Record<string, number> = {};
        for (const conn of state.connections) {
            if (conn.fromNode !== nodeId) continue;
            const connSignal = conn.signalType ?? 'audio';
            if (connSignal !== signalType) continue;
            pulsePatch[conn.id] = now;
        }
        if (Object.keys(pulsePatch).length === 0) return {};
        return { connectionPulseById: { ...state.connectionPulseById, ...pulsePatch } };
    }),

    pulseConnection: (connectionId) => set((state) => ({
        connectionPulseById: {
            ...state.connectionPulseById,
            [connectionId]: Date.now(),
        },
    })),
}));
