import { create } from 'zustand';
import { z } from 'zod';
import * as engine from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { viewportProxy, type ViewportState } from '../lib/ViewportProxy';
import { nodeMotionProxy } from '../lib/NodeMotionProxy';
import {
    portNameToIndex,
    PORT_REGISTRY,
    FLOW_NODE_HEADER_HEIGHT,
    FLOW_PULSE_GC_MS,
    FLOW_SELECTION_PADDING_Y,
    type SynthNodeType,
    type PortDefinition
} from './portRegistry';
import { FLOW_NODE_WIDTH } from '../ui/SynthNodeComponent';
import { FACTORY_PRESETS, clonePreset, type FlowPreset } from './flowPresets';

export type { SynthNodeType };
export type { FlowPreset };

export const FLOW_SYNTH_PLUGIN_ID = 'internal://instrument/flow';
export const FLOW_AUTO_SAVE_DEBOUNCE_MS = 1500;
export const FLOW_ENGINE_SETTLE_MS = 500;

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

    // Per-device caches — survives close/open cycles within a session
    viewportByDeviceId: Record<string, { x: number; y: number; zoom: number }>;
    graphsByDeviceId: Record<string, { nodes: SynthNode[]; connections: SynthConnection[] }>;

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
    startConnectionDrag: (connection: PendingConnection) => void;
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

export function stableNodeNumericId(nodeId: string): number {
    // ENTERPRISE GUARD: Prevent crash when nodeId is undefined/null
    // (can happen during project hydration with corrupt/partial FlowSynth data)
    if (!nodeId) return 1;
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

// ENTERPRISE FIX: Strict scalar coercion
const flowNumber = z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v === 'string') {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    }
    if (typeof v === 'number') return v;
    return undefined;
}, z.number().optional());

const flowBoolean = z.preprocess((v) => {
    if (v === 'true' || v === true) return true;
    if (v === 'false' || v === false) return false;
    return undefined;
}, z.boolean().optional());

const flowString = z.preprocess((v) => {
    if (v === undefined || v === null) return undefined;
    return String(v);
}, z.string().optional());

// ENTERPRISE FIX: Exhaustive schema definitions per node type preventing arbitrary unhandled data keys
const NodeSchemas: Record<SynthNodeType, z.ZodObject<any>> = {
    oscillator: z.object({ label: flowString, waveform: flowString, frequency: flowNumber, pulseWidth: flowNumber }),
    filter: z.object({ label: flowString, filterType: flowString, cutoff: flowNumber, resonance: flowNumber }),
    envelope: z.object({ label: flowString, attack: flowNumber, decay: flowNumber, sustain: flowNumber, release: flowNumber }),
    eq: z.object({ label: flowString, lowFreq: flowNumber, highFreq: flowNumber, lowGain: flowNumber, midGain: flowNumber, highGain: flowNumber, eqLow: flowNumber, eqMid: flowNumber, eqHigh: flowNumber }),
    autofilter: z.object({ label: flowString, filterType: flowString, cutoff: flowNumber, resonance: flowNumber, rate: flowNumber, depth: flowNumber, envDepth: flowNumber }),
    reverse: z.object({ label: flowString, windowMs: flowNumber, feedback: flowNumber, mix: flowNumber }),
    audioIn: z.object({ label: flowString }),
    midiIn: z.object({ label: flowString, channel: flowString, transpose: flowNumber }),
    output: z.object({ label: flowString, gain: flowNumber, muted: flowBoolean }),
    lfo: z.object({ label: flowString, shape: flowString, bipolar: flowBoolean, rate: flowNumber, phaseOffset: flowNumber }),
    noise: z.object({ label: flowString, color: flowString, level: flowNumber }),
    delay: z.object({ label: flowString, time: flowNumber, feedback: flowNumber, mix: flowNumber }),
    mixer: z.object({ label: flowString, gain1: flowNumber, gain2: flowNumber, gain3: flowNumber, gain4: flowNumber }),
    vca: z.object({ label: flowString, bias: flowNumber }),
    pitch: z.object({ label: flowString, octaveOffset: flowNumber }),
    utility: z.object({ label: flowString, phaseInvert: flowBoolean, gain: flowNumber, pan: flowNumber }),
    distortion: z.object({ label: flowString, mode: flowString, drive: flowNumber, mix: flowNumber }),
    vst3: z.object({ label: flowString, pluginName: flowString }),
    add: z.object({ label: flowString }),
    multiply: z.object({ label: flowString, scale: flowNumber }),
    sampleHold: z.object({ label: flowString }),
};

/**
 * ENTERPRISE FIX: Re-parse Rust HashMap<String,String> values to proper JS types
 * using strict Zod schemas for robust Enterprise-grade hydration and fault tolerance.
 */
function _rehydrateData(type: SynthNodeType, data: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!data) return {};

    const cleanData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
        if (v !== null && v !== undefined) cleanData[k] = v;
    }

    const schema = NodeSchemas[type];
    if (schema) {
        const parsed = schema.safeParse(cleanData);
        if (parsed.success) {
            return parsed.data as Record<string, unknown>;
        }
        // ENTERPRISE BUG-16 FIX: On schema mismatch, do a partial parse
        // instead of dropping ALL data. Keep valid fields, filter only corrupt ones.
        console.warn(`[FlowSynth] Zod partial mismatch for ${type}:`, parsed.error.issues.length, 'issues');
        const partialResult: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(cleanData)) {
            const fieldSchema = (schema.shape as Record<string, z.ZodTypeAny>)[k];
            if (fieldSchema) {
                const fieldParsed = fieldSchema.safeParse(v);
                if (fieldParsed.success) {
                    partialResult[k] = fieldParsed.data;
                }
            }
        }
        return partialResult;
    }

    // Fallback security zero-trust
    return {};
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
    // Mark project dirty immediately so the unsaved-changes star appears
    useEngineStore.getState().markDirty();
    queueMicrotask(() => {
        _syncScheduled = false;
        get().syncFlowGraphToEngine();
    });
}

/**
 * ENTERPRISE SSOT: Single function to serialize FlowSynth config JSON.
 * Eliminates duplicate serialization in syncFlowGraphToEngine and _scheduleSaveConfig.
 */
function buildFlowConfigJson(state: FlowSynthState, viewportX: number, viewportY: number, viewportZoom: number): string {
    return JSON.stringify({
        nodes: state.nodes
            .filter(n => n && n.id && n.type) // ENTERPRISE GUARD: Skip corrupt nodes
            .map(n => {
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
                    // ENTERPRISE GUARD: Safe position access — defaults to (0,0)
                    position_x: n.position?.x ?? 0,
                    position_y: n.position?.y ?? 0,
                    data: stringifiedData
                };
            }),
        // ENTERPRISE GUARD: Filter out connections with missing node refs (corrupt data)
        connections: state.connections
            .filter(c => c && c.id && c.fromNode && c.toNode && c.fromPort && c.toPort)
            .map(c => ({
                id: c.id,
                from_node: c.fromNode,
                from_port: c.fromPort,
                to_node: c.toNode,
                to_port: c.toPort,
                // ENTERPRISE FIX: Rust struct uses #[serde(rename = "signalType")] — must match
                signalType: c.signalType ?? 'audio'
            })),
        viewport: { x: viewportX, y: viewportY, zoom: viewportZoom }
    });
}

function _forceSaveConfig(state: FlowSynthState) {
    if (_saveTimeout !== null) {
        window.clearTimeout(_saveTimeout);
        _saveTimeout = null;
    }
    const capturedTrackId = state.activeTrackId;
    if (!capturedTrackId) return;
    const vp = viewportProxy.getViewport();
    const jsonStr = buildFlowConfigJson(state, vp.x, vp.y, vp.zoom);
    const trackIndex = useEngineStore.getState().tracks.allIds.indexOf(capturedTrackId);
    if (trackIndex < 0) return;
    engine.saveFlowSynthConfig(trackIndex, jsonStr).then(response => {
        if (response?.deltas?.length) {
            useEngineStore.getState().applyProjectDeltas(response.deltas, 'saveFlowSynthConfig').catch(console.error);
        }
    }).catch(console.error);
}

// ENTERPRISE: Aggressively debounced disk-save.
// Separates the fast RT-safe parameter modulation from disk I/O serialization.
let _saveTimeout: number | null = null;
function _scheduleSaveConfig(get: () => FlowSynthState): void {
    const capturedTrackId = get().activeTrackId;
    const capturedDeviceId = get().activeDeviceId;
    if (!capturedTrackId || !capturedDeviceId) return;

    if (_saveTimeout !== null) {
        window.clearTimeout(_saveTimeout);
    }

    _saveTimeout = window.setTimeout(async () => {
        _saveTimeout = null;
        let state = get();
        let jsonStr = "";

        // ENTERPRISE FIX: If the user closed the editor or switched tracks BEFORE the debounce fired,
        // activeTrackId no longer matches capturedTrackId.
        // In that case, we MUST NOT abort the save, otherwise their work is permanently lost from the disk file!
        // But since we removed the stale cache, the sync save should ALREADY be triggered by closeFlowEditor!
        // So we only save here if we are still on the same track.
        if (state.activeTrackId !== capturedTrackId) return;

        const vp = viewportProxy.getViewport();
        jsonStr = buildFlowConfigJson(state, vp.x, vp.y, vp.zoom);

        const trackIndex = useEngineStore.getState().tracks.allIds.indexOf(capturedTrackId);
        if (trackIndex < 0) return;
        const response = await engine.saveFlowSynthConfig(trackIndex, jsonStr);
        // ENTERPRISE FIX: Apply returned delta so useEngineStore.tracks.byId[trackId].flow_synth
        // is populated. Without this, the frontend store never learns about the saved config.
        if (response?.deltas?.length) {
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'saveFlowSynthConfig');
        }
    }, FLOW_AUTO_SAVE_DEBOUNCE_MS);
}

/**
 * ENTERPRISE FIX: Converts legacy project port IDs to the unified Modular standard
 */
function migrateLegacyPortName(portName: string): string {
    if (portName === 'audioL' || portName === 'audioR') return 'audio';
    return portName;
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

    // Per-device caches
    viewportByDeviceId: {},
    graphsByDeviceId: {},

    // ── Preset initial state ───────────────────────────────────────────
    presetName: FACTORY_PRESETS[0].name,
    presetIndex: 0,

    openFlowEditor: (deviceId, trackId) => set((state) => {
        // Save previous track state before switching context
        if (state.activeTrackId && state.activeTrackId !== trackId) {
            _forceSaveConfig(state);
            if (state.activeDeviceId) {
                const currentVp = viewportProxy.getViewport();
                state.viewportByDeviceId[state.activeDeviceId] = { x: currentVp.x, y: currentVp.y, zoom: currentVp.zoom };
                state.graphsByDeviceId[state.activeDeviceId] = { nodes: state.nodes, connections: state.connections };
            }
        }

        // ── 1) Check if SAME context (editor already open for this device) ──
        const isSameContext = state.activeDeviceId === deviceId && state.activeTrackId === trackId && state.nodes.length > 0;
        if (isSameContext) {
            // Already open, do nothing — keep current state:
            return { isOpen: true };
        }

        // ── 2) Check per-device cache (survives close/reopen) ──
        const cachedGraph = state.graphsByDeviceId[deviceId];
        if (cachedGraph && cachedGraph.nodes.length > 0) {
            const savedViewport = state.viewportByDeviceId[deviceId];
            viewportProxy.setViewport(savedViewport ?? DEFAULT_FLOW_GRAPH.viewport);
            // Skip engine sync — engine already has this graph from last time
            return {
                isOpen: true,
                activeDeviceId: deviceId,
                activeTrackId: trackId,
                nodes: cachedGraph.nodes,
                connections: cachedGraph.connections,
                selectedNodeIds: [],
                selectedConnectionId: null,
                pendingConnection: null,
            };
        }

        // ── 3) Hydrate from project model (first open) ──
        let graph: FlowGraph;
        const track = useEngineStore.getState().tracks.byId[trackId];
        if (track?.flow_synth) {
            const nodeTypeMap = new Map<string, string>();
            for (const n of track.flow_synth.nodes) {
                nodeTypeMap.set(n.id, n.type);
            }
            graph = {
                nodes: track.flow_synth.nodes.map((n: any) => ({
                    id: n.id,
                    type: n.type as SynthNodeType,
                    position: { x: n.position_x, y: n.position_y },
                    data: _rehydrateData(n.type as SynthNodeType, n.data)
                })),
                connections: track.flow_synth.connections.map((c: any) => {
                    const toPort = migrateLegacyPortName(c.to_port ?? '');
                    let signalType = c.signalType ?? c.signal_type ?? null;
                    if (!signalType) {
                        const fromNodeType = nodeTypeMap.get(c.from_node);
                        if (fromNodeType) {
                            const reg = PORT_REGISTRY[fromNodeType as SynthNodeType];
                            if (reg) {
                                const port = reg.outputs.find((p: PortDefinition) => p.id === c.from_port);
                                signalType = port?.type ?? 'audio';
                            }
                        }
                        if (!signalType) signalType = 'audio';
                    }
                    return {
                        id: c.id,
                        fromNode: c.from_node,
                        fromPort: c.from_port,
                        toNode: c.to_node,
                        toPort,
                        signalType
                    };
                }),
                viewport: {
                    x: track.flow_synth.viewport?.x ?? 0,
                    y: track.flow_synth.viewport?.y ?? 0,
                    zoom: track.flow_synth.viewport?.zoom ?? 1
                }
            };
        } else {
            graph = cloneDefaultGraph();
        }

        const savedViewport = state.viewportByDeviceId[deviceId];
        viewportProxy.setViewport(savedViewport ?? graph.viewport ?? DEFAULT_FLOW_GRAPH.viewport);

        // First open — sync graph to engine
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

        // Save config to project model
        _forceSaveConfig(state);

        // Cache graph + viewport for this device (survives close/reopen)
        const currentVp = viewportProxy.getViewport();
        const updatedViewports = {
            ...state.viewportByDeviceId,
            [state.activeDeviceId]: { x: currentVp.x, y: currentVp.y, zoom: currentVp.zoom },
        };
        const updatedGraphs = {
            ...state.graphsByDeviceId,
            [state.activeDeviceId]: { nodes: state.nodes, connections: state.connections },
        };

        viewportProxy.reset();
        return {
            isOpen: false,
            activeDeviceId: null,
            activeTrackId: null,
            selectedNodeIds: [],
            selectedConnectionId: null,
            pendingConnection: null,
            viewportByDeviceId: updatedViewports,
            graphsByDeviceId: updatedGraphs,
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
        };
    }),

    setSelectionBox: (box) => set((state) => {
        if (!box) return {};
        const selectedIds = state.nodes
            .filter((node) => {
                if (!node.position) return false;
                const left = node.position.x;
                const right = node.position.x + FLOW_NODE_WIDTH;
                const top = node.position.y;
                const bottom = node.position.y + FLOW_NODE_HEADER_HEIGHT + FLOW_SELECTION_PADDING_Y;
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
        };
    }),

    // FIX #4: Map nodes ONCE, reuse for both `nodes` and `graphsByDeviceId`.
    updateNodePosition: (id, x, y) => set((state) => {
        const nextNodes = state.nodes.map((n) => {
            if (n.id !== id) return n;
            const px = n.position?.x ?? 0;
            const py = n.position?.y ?? 0;
            const safeX = Number.isFinite(x) ? x : px;
            const safeY = Number.isFinite(y) ? y : py;
            return { ...n, position: { x: safeX, y: safeY } };
        });
        return {
            nodes: nextNodes,
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
        }));
    },

    setConnections: (connections) => {
        _scheduleSyncFlowGraph(get);
        return set((state) => ({
            connections,
            selectedConnectionId: state.selectedConnectionId && connections.some((c) => c.id === state.selectedConnectionId)
                ? state.selectedConnectionId
                : null,
        }));
    },

    startConnectionDrag: (connection) => set({
        selectedConnectionId: null,
        pendingConnection: connection,
    }),

    commitConnection: (toNode: string, toPort: string, signalType: 'audio' | 'midi' | 'control' | 'gate' | 'phase') => set((state: FlowSynthState) => {
        const pending = state.pendingConnection;
        if (!pending) return {};
        if (pending.fromNode === toNode) return { pendingConnection: null };
        // ENTERPRISE: Signal type compatibility matrix.
        // control accepts gate/phase/control. audio-to-audio, midi-to-midi only.
        const typesCompatible = (from: string, to: string) => {
            if (from === to) return true;
            if (to === 'control' && (from === 'gate' || from === 'phase' || from === 'control')) return true;
            if (from === 'control' && (to === 'gate' || to === 'phase')) return true;
            return false;
        };
        if (!typesCompatible(pending.signalType, signalType)) return { pendingConnection: null };
        // Guard: exact duplicate
        const exists = state.connections.some((conn: SynthConnection) =>
            conn.fromNode === pending.fromNode
            && conn.fromPort === pending.fromPort
            && conn.toNode === toNode
            && conn.toPort === toPort,
        );
        if (exists) return { pendingConnection: null };
        // ENTERPRISE: Auto-replace — if the input port is already occupied,
        // remove the existing connection (Bitwig Grid pattern: last cable wins).
        const baseConnections = state.connections.filter(
            (conn: SynthConnection) => !(conn.toNode === toNode && conn.toPort === toPort),
        );
        const newConnection: SynthConnection = {
            id: `conn-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`,
            fromNode: pending.fromNode,
            fromPort: pending.fromPort,
            toNode,
            toPort,
            // BUG-19 FIX: Store the FROM port's signalType — the cable carries the source signal type.
            signalType: pending.signalType,
        };
        const nextConnections = [...baseConnections, newConnection];

        // Trigger sync
        _scheduleSyncFlowGraph(get);

        return {
            connections: nextConnections,
            pendingConnection: null,
        };
    }),

    cancelConnectionDrag: () => set({ pendingConnection: null }),

    pulseFromNode: (nodeId, signalType = 'audio') => set((state) => {
        const now = Date.now();
        const nextPulseById = { ...state.connectionPulseById };

        // Phase 9.2: Memory Leak Garbage Collection
        Object.keys(nextPulseById).forEach((key) => {
            if (now - nextPulseById[key] > FLOW_PULSE_GC_MS) delete nextPulseById[key];
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
            if (now - nextPulseById[key] > FLOW_PULSE_GC_MS) delete nextPulseById[key];
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
            (track?.instrument?.plugin_id === FLOW_SYNTH_PLUGIN_ID)
            || !!track?.effects?.some((slot) => slot.plugin_id === FLOW_SYNTH_PLUGIN_ID);
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
        // ENTERPRISE GUARD: Filter out orphaned connections where fromNode/toNode
        // is undefined/null (corrupt project data or hydration mismatch).
        const validConnections = state.connections.filter(
            (c) => c.fromNode && c.toNode,
        );
        const connections: [number, number, number, number][] = validConnections.map((c) => {
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
        const vp = viewportProxy.getViewport();
        const configJson = buildFlowConfigJson(state, vp.x, vp.y, vp.zoom);

        // ENTERPRISE FIX: Sequential awaits — setFlowEnabled MUST complete before
        // syncFlowGraph. The engine must be enabled before it processes graph data,
        // otherwise the graph sync arrives while the engine is still in disabled
        // state and may be silently dropped or cause state inconsistency.
        await engine.setFlowEnabled(trackIndex, true);
        const [, saveResponse] = await Promise.all([
            engine.syncFlowGraph(trackIndex, nodes, connections),
            engine.saveFlowSynthConfig(trackIndex, configJson)
        ]);
        // ENTERPRISE FIX: Apply save response deltas to sync track.flow_synth in frontend store.
        if (saveResponse?.deltas?.length) {
            await useEngineStore.getState().applyProjectDeltas(saveResponse.deltas, 'syncFlowGraphSave');
        }
    },

    // ── Preset Actions ─────────────────────────────────────────────────
    loadPreset: (index: number) => {
        const total = FACTORY_PRESETS.length;
        if (total === 0) return;
        const safeIndex = ((index % total) + total) % total;
        const preset = clonePreset(FACTORY_PRESETS[safeIndex]);

        // Clear stale node positions but NOT subscribers.
        // Subscribers are owned by mounted FlowConnectionComponents —
        // destroying them kills real-time connection-follows-drag.
        nodeMotionProxy.clearPositions();

        set((state) => {
            // Invalidate the per-device graph cache for the current device
            // so the new preset is what gets cached on next close.
            const updatedGraphs = { ...state.graphsByDeviceId };
            if (state.activeDeviceId) {
                delete updatedGraphs[state.activeDeviceId];
            }

            return {
                nodes: preset.nodes,
                connections: preset.connections,
                presetName: preset.name,
                presetIndex: safeIndex,
                selectedNodeIds: [],
                selectedConnectionId: null,
                pendingConnection: null,
                graphsByDeviceId: updatedGraphs,
            };
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

// ═══════════════════════════════════════════════════════════════════════════
// ENTERPRISE: Project-Load Flow Engine Initialization
//
// FlowSynthEngine on the audio thread starts DISABLED by default.
// This function iterates all tracks, finds Flow instruments, hydrates
// their graphs from the project model, and syncs to the audio engine
// so Flow plays immediately on project load — no manual editor open required.
// ═══════════════════════════════════════════════════════════════════════════

export async function initFlowEnginesFromProject(): Promise<void> {
    const engineState = useEngineStore.getState();

    for (let trackIdx = 0; trackIdx < engineState.tracks.allIds.length; trackIdx++) {
        const trackId = engineState.tracks.allIds[trackIdx];
        const track = engineState.tracks.byId[trackId];
        if (!track) continue;

        // Check if this track has a Flow instrument
        const hasFlow =
            track.instrument?.plugin_id === FLOW_SYNTH_PLUGIN_ID
            || track.effects?.some((slot: any) => slot.plugin_id === FLOW_SYNTH_PLUGIN_ID);
        if (!hasFlow) continue;

        // Hydrate graph from SSOT
        let graph: FlowGraph | null = null;
        if (track.flow_synth) {
            interface RustFlowNode {
                id?: string; type?: string; node_type?: string;
                position?: { x: number; y: number }; position_x?: number; position_y?: number;
                data?: Record<string, string>;
            }
            interface RustFlowConnection {
                id?: string; fromNode?: string; from_node?: string; fromPort?: string; from_port?: string;
                toNode?: string; to_node?: string; toPort?: string; to_port?: string;
                signalType?: string; signal_type?: string;
            }
            interface RustFlowConfig { nodes?: RustFlowNode[]; connections?: RustFlowConnection[]; viewport?: { x: number; y: number; zoom: number }; }

            const typedConfig = track.flow_synth as RustFlowConfig;

            graph = {
                nodes: (typedConfig.nodes ?? []).map((n) => ({
                    id: n.id ?? '',
                    type: (n.type ?? n.node_type ?? 'oscillator') as SynthNodeType,
                    position: n.position ?? { x: n.position_x ?? 0, y: n.position_y ?? 0 },
                    // BUG-15 FIX: Rust data is HashMap<String,String> — re-parse via typed Zod schema
                    data: _rehydrateData((n.type ?? n.node_type ?? 'oscillator') as SynthNodeType, n.data),
                })),
                connections: (typedConfig.connections ?? []).map((c) => {
                    let signalType = c.signalType ?? c.signal_type ?? null;
                    if (!signalType) {
                        const fromNode = (typedConfig.nodes ?? []).find((n) => n.id === (c.fromNode ?? c.from_node));
                        if (fromNode) {
                            const reg = PORT_REGISTRY[(fromNode.type ?? fromNode.node_type ?? 'oscillator') as SynthNodeType];
                            if (reg) {
                                const port = reg.outputs.find((p: PortDefinition) => p.id === (c.fromPort ?? c.from_port));
                                signalType = port?.type ?? 'audio';
                            }
                        }
                        if (!signalType) signalType = 'audio';
                    }
                    return {
                        id: c.id ?? '',
                        fromNode: c.fromNode ?? c.from_node ?? '',
                        fromPort: c.fromPort ?? c.from_port ?? '',
                        toNode: c.toNode ?? c.to_node ?? '',
                        toPort: migrateLegacyPortName(c.toPort ?? c.to_port ?? ''),
                        signalType: signalType as ('audio' | 'midi' | 'control' | 'gate' | 'phase'),
                    };
                }),
                viewport: {
                    x: typedConfig.viewport?.x ?? 0,
                    y: typedConfig.viewport?.y ?? 0,
                    zoom: typedConfig.viewport?.zoom ?? 1,
                },
            };
        }
        if (!graph) continue;

        // Build engine-compatible node/connection arrays
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
        graph.nodes.forEach((n: SynthNode) => mapNode(n.id));

        const nodes: [number, string, [string, string][]][] = graph.nodes.map((n: SynthNode) => {
            const params: [string, string][] = n.data
                ? Object.entries(n.data)
                    .filter(([, v]) => v !== null && v !== undefined)
                    .map(([k, v]) => [k, String(v)])
                : [];
            return [mapNode(n.id), n.type, params];
        });

        const connections: [number, number, number, number][] = graph.connections
            .map((c: SynthConnection) => {
                const fromNode = graph!.nodes.find((n: SynthNode) => n.id === c.fromNode);
                const toNode = graph!.nodes.find((n: SynthNode) => n.id === c.toNode);
                if (!fromNode || !toNode) return null;
                const fromId = mapNode(c.fromNode);
                const toId = mapNode(c.toNode);
                return [
                    fromId,
                    portNameToIndex(fromNode.type as SynthNodeType, c.fromPort, 'out'),
                    toId,
                    portNameToIndex(toNode.type as SynthNodeType, c.toPort, 'in'),
                ] as [number, number, number, number];
            })
            .filter((c): c is [number, number, number, number] => c !== null);

        // Enable engine + sync graph
        await engine.setFlowEnabled(trackIdx, true);
        await engine.syncFlowGraph(trackIdx, nodes, connections);
    }
}

/**
 * Disables a FlowEngine for a given track when the Flow instrument is removed.
 * Must be called AFTER the device is removed from the project model.
 */
export async function disableFlowEngine(trackId: string): Promise<void> {
    const engineState = useEngineStore.getState();
    const trackIndex = engineState.tracks.allIds.indexOf(trackId);
    if (trackIndex < 0) return;
    await engine.setFlowEnabled(trackIndex, false);
}

// ═══════════════════════════════════════════════════════════════════════════
// ENTERPRISE: Auto-init Flow engines on project load via Zustand subscription
// BUG-1 FIX: Removed _flowInitDone guard — it prevented re-init when switching
// directly from Project A to Project B (both non-null). The _prevProjectId
// guard is sufficient to prevent duplicate init for the same project.
// ═══════════════════════════════════════════════════════════════════════════
let _prevProjectId: string | null = null;
useEngineStore.subscribe((state) => {
    const projectId = state.activeProjectId;
    if (projectId === _prevProjectId) return;
    _prevProjectId = projectId;

    if (projectId) {
        // Defer 500ms so engine store + audio engine are fully settled
        setTimeout(() => initFlowEnginesFromProject().catch(console.error), 500);
    }
});

// Subscribe to global Undo/Redo track config changes. 
// When the Orchestrator pops an undo delta, it patches `track.flow_synth` in `useEngineStore`.
// We need to reflect that in `useFlowSynthStore` if the track is active.
let _prevFlowSynthConfigObj: unknown = null;
useEngineStore.subscribe((state) => {
    const activeTrackId = useFlowSynthStore.getState().activeTrackId;
    if (!activeTrackId) return;
    const track = state.tracks.byId[activeTrackId];
    if (!track) return;

    // Check if the object reference changed (Zustand updates it on Delta patch)
    const currentConfig = track.flow_synth;
    if (currentConfig === _prevFlowSynthConfigObj) return;
    _prevFlowSynthConfigObj = currentConfig;

    if (currentConfig) {
        // ENTERPRISE FIX: Strict typings for Rust IPC to prevent silent undefined crashes
        interface RustFlowNode {
            id?: string; type?: string; node_type?: string;
            position?: { x: number; y: number }; position_x?: number; position_y?: number;
            data?: Record<string, string>;
        }
        interface RustFlowConnection {
            id?: string; fromNode?: string; from_node?: string; fromPort?: string; from_port?: string;
            toNode?: string; to_node?: string; toPort?: string; to_port?: string;
            signalType?: string; signal_type?: string;
        }
        interface RustFlowConfig { nodes?: RustFlowNode[]; connections?: RustFlowConnection[]; }

        const typedConfig = currentConfig as RustFlowConfig;

        const mappedNodes: SynthNode[] = (typedConfig.nodes ?? [])
            .filter((n) => n && (n.id || n.node_type || n.type))
            .map((n) => ({
                id: n.id ?? '',
                type: (n.type ?? n.node_type ?? 'oscillator') as SynthNodeType,
                position: n.position ?? { x: n.position_x ?? 0, y: n.position_y ?? 0 },
                data: _rehydrateData((n.type ?? n.node_type ?? 'oscillator') as SynthNodeType, n.data),
            }));
        const mappedConnections: SynthConnection[] = (typedConfig.connections ?? [])
            .filter((c) => c && (c.fromNode || c.from_node) && (c.toNode || c.to_node))
            .map((c) => ({
                id: c.id ?? '',
                fromNode: c.fromNode ?? c.from_node ?? '',
                fromPort: c.fromPort ?? c.from_port ?? '',
                toNode: c.toNode ?? c.to_node ?? '',
                toPort: migrateLegacyPortName(c.toPort ?? c.to_port ?? ''),
                signalType: (c.signalType ?? c.signal_type ?? 'audio') as ('audio' | 'midi' | 'control' | 'gate' | 'phase'),
            }));

        useFlowSynthStore.setState((s) => ({
            nodes: mappedNodes.length > 0 ? mappedNodes : s.nodes,
            connections: mappedConnections,
        }));
    } else {
        // Fallback to default if config was wiped
        const defaultGraph = cloneDefaultGraph();
        useFlowSynthStore.setState({
            nodes: defaultGraph.nodes,
            connections: defaultGraph.connections,
        });
    }
    // BUG-2 FIX: Re-sync the DSP engine after undo/redo delta changes the graph.
    // Without this, the UI shows the undone graph but audio stays on the old one.
    _scheduleSyncFlowGraph(() => useFlowSynthStore.getState());
});

