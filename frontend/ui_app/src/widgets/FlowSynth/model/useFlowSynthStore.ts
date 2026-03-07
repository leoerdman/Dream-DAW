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
    FLOW_GRID_SNAP,
    type SynthNodeType,
    type PortDefinition
} from './portRegistry';
import { FLOW_NODE_WIDTH } from '../ui/SynthNodeComponent';
import { FACTORY_PRESETS, clonePreset, type FlowPreset } from './flowPresets';
import { flowModuleClipboard, setFlowModuleClipboard } from './flowSynthClipboard';

export type { SynthNodeType };
export type { FlowPreset };

export const FLOW_SYNTH_PLUGIN_ID = 'internal://instrument/flow';
/**
 * BUG-059 FIX: Debounce interval for persisting FlowSynth config to disk.
 * 1500ms chosen as a balance between:
 * - Too low (e.g. 300ms): excess disk I/O during rapid node editing / fader sweeps
 * - Too high (e.g. 5000ms): risk of data loss on unexpected crash
 * This aligns with typical DAW auto-save intervals (1-3s for config, 3-5min for project).
 */
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
    /** ENTERPRISE: Display mode — 'inline' replaces timeline, 'floating' is a draggable window. */
    displayMode: 'inline' | 'floating';

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
    /** ENTERPRISE: Hide Flow without removing from openEditorsByTrack (for track switches). */
    hideFlowEditor: () => void;
    setDisplayMode: (mode: 'inline' | 'floating') => void;

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

    // BUG-034 FIX: Remove stale cache entries when a device/track is deleted.
    cleanupDeviceCache: (deviceId: string) => void;

    // ── Clipboard actions ──────────────────────────────────────────────
    copySelectedNodes: () => void;
    cutSelectedNodes: () => void;
    duplicateSelectedNodes: (deep?: boolean) => void;
    pasteNodes: (deep?: boolean) => void;

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

/**
 * P0-2 FIX: Monotonically increasing counter. Incremented on every local edit
 * (updateNodeData). The Undo/Redo subscription reads this to avoid overwriting
 * edits that are in-flight between the user and the debounced save.
 */
let _localEditSequence = 0;

/**
 * P0-2 FIX: Synchronously populate _nodeIdMap from a set of nodes.
 * Called both from syncFlowGraphToEngine (full sync) and from openFlowEditor
 * (so params sent before first sync are never silently dropped).
 */
function _populateNodeIdMap(nodes: SynthNode[]): void {
    const idMap = new Map<string, number>();
    const used = new Set<number>();
    for (const n of nodes) {
        let numeric = stableNodeNumericId(n.id);
        while (used.has(numeric)) numeric = (numeric + 1) >>> 0;
        used.add(numeric);
        idMap.set(n.id, numeric);
    }
    _nodeIdMap.clear();
    idMap.forEach((v, k) => _nodeIdMap.set(k, v));
}

// ── ENTERPRISE: Module-level IPC type interfaces (used across hydration sites) ──
// Eliminates P3 `any` casts at lines 502, 508, 1278, 1284-1294.
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
interface RustFlowConfig {
    nodes?: RustFlowNode[]; connections?: RustFlowConnection[];
    viewport?: { x: number; y: number; zoom: number };
}

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
    number: z.object({ label: flowString, value: flowNumber }),
    quantize: z.object({ label: flowString, scaleMode: flowNumber, rootNote: flowNumber }),
    midiToFreq: z.object({ label: flowString }),
    freqToMidi: z.object({ label: flowString }),
    abs: z.object({ label: flowString }),
    negate: z.object({ label: flowString }),
    map: z.object({ label: flowString, minIn: flowNumber, maxIn: flowNumber }),
    clamp: z.object({ label: flowString, min: flowNumber, max: flowNumber }),
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

    // Fallback: Preserve data for node types not yet in NodeSchemas.
    // This makes the system forward-compatible — new node types added to
    // the catalog don't lose their data until a schema is defined.
    return cleanData;
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

// BUG-007 FIX: Track in-flight save to prevent concurrent saves racing.
let _saveInFlight = false;

function _forceSaveConfig(state: FlowSynthState): Promise<void> {
    if (_saveTimeout !== null) {
        window.clearTimeout(_saveTimeout);
        _saveTimeout = null;
    }
    const capturedTrackId = state.activeTrackId;
    if (!capturedTrackId) return Promise.resolve();
    // BUG-007 FIX: Prevent concurrent saves — skip if one is already in-flight.
    if (_saveInFlight) return Promise.resolve();
    _saveInFlight = true;
    const vp = viewportProxy.getViewport();
    const jsonStr = buildFlowConfigJson(state, vp.x, vp.y, vp.zoom);
    const trackIndex = useEngineStore.getState().tracks.allIds.indexOf(capturedTrackId);
    if (trackIndex < 0) { _saveInFlight = false; return Promise.resolve(); }
    return engine.saveFlowSynthConfig(trackIndex, jsonStr).then(response => {
        if (response?.deltas?.length) {
            return useEngineStore.getState().applyProjectDeltas(response.deltas, 'saveFlowSynthConfig').catch(console.error);
        }
    }).catch(console.error).finally(() => { _saveInFlight = false; });
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

/**
 * P1-1 FIX: Shared close/hide helper — saves config, caches graph + viewport,
 * resets proxy, and returns the closed-state partial. Extracted from the
 * previously duplicated closeFlowEditor/hideFlowEditor logic.
 */
function _cacheAndCloseState(state: FlowSynthState): Partial<FlowSynthState> {
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
}

export const useFlowSynthStore = create<FlowSynthState>()((set, get) => ({
    isOpen: false,
    activeDeviceId: null,
    activeTrackId: null,
    displayMode: 'inline' as const,

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
        // ── 0) Save previous track state before switching context ──
        // IMPORTANT: Do NOT mutate state.* fields directly — zustand is vanilla (no Immer).
        // All cache updates must be included in the returned partial state object.
        let prevViewportUpdate: Record<string, { x: number; y: number; zoom: number }> | null = null;
        let prevGraphUpdate: Record<string, { nodes: SynthNode[]; connections: SynthConnection[] }> | null = null;

        if (state.activeTrackId && state.activeTrackId !== trackId && state.activeDeviceId) {
            _forceSaveConfig(state);
            const currentVp = viewportProxy.getViewport();
            prevViewportUpdate = {
                ...state.viewportByDeviceId,
                [state.activeDeviceId]: { x: currentVp.x, y: currentVp.y, zoom: currentVp.zoom },
            };
            prevGraphUpdate = {
                ...state.graphsByDeviceId,
                [state.activeDeviceId]: { nodes: state.nodes, connections: state.connections },
            };
        }

        // ── 1) Check if SAME context (editor already open for this device) ──
        const isSameContext = state.activeDeviceId === deviceId && state.activeTrackId === trackId && state.nodes.length > 0;
        if (isSameContext) {
            return { isOpen: true };
        }

        // Use updated caches if we saved previous state, otherwise use existing
        const vpCache = prevViewportUpdate ?? state.viewportByDeviceId ?? {};
        const graphCache = prevGraphUpdate ?? state.graphsByDeviceId ?? {};

        // ── 2) Check per-device cache (survives close/reopen) ──
        const cachedGraph = graphCache[deviceId];
        if (cachedGraph && cachedGraph.nodes.length > 0) {
            const savedViewport = vpCache[deviceId];
            viewportProxy.setViewport(savedViewport ?? DEFAULT_FLOW_GRAPH.viewport);
            return {
                isOpen: true,
                activeDeviceId: deviceId,
                activeTrackId: trackId,
                nodes: cachedGraph.nodes,
                connections: cachedGraph.connections,
                selectedNodeIds: [],
                selectedConnectionId: null,
                pendingConnection: null,
                viewportByDeviceId: vpCache,
                graphsByDeviceId: graphCache,
            };
        }

        // ── 3) Hydrate from project model (first open) ──
        let graph: FlowGraph;
        const track = useEngineStore.getState().tracks.byId[trackId];
        if (track?.flow_synth) {
            const typedConfig = track.flow_synth as RustFlowConfig;
            const nodeTypeMap = new Map<string, string>();
            for (const n of (typedConfig.nodes ?? [])) {
                nodeTypeMap.set(n.id ?? '', n.type ?? n.node_type ?? '');
            }
            graph = {
                nodes: (typedConfig.nodes ?? []).map((n: RustFlowNode) => ({
                    id: n.id ?? '',
                    type: (n.type ?? n.node_type ?? 'oscillator') as SynthNodeType,
                    position: n.position ?? { x: n.position_x ?? 0, y: n.position_y ?? 0 },
                    data: _rehydrateData((n.type ?? n.node_type ?? 'oscillator') as SynthNodeType, n.data)
                })),
                connections: (typedConfig.connections ?? []).map((c: RustFlowConnection) => {
                    const toPort = migrateLegacyPortName(c.to_port ?? c.toPort ?? '');
                    const fromPort = migrateLegacyPortName(c.from_port ?? c.fromPort ?? '');
                    let signalType = c.signalType ?? c.signal_type ?? null;
                    if (!signalType) {
                        const fromNodeType = nodeTypeMap.get(c.from_node ?? c.fromNode ?? '');
                        if (fromNodeType) {
                            const reg = PORT_REGISTRY[fromNodeType as SynthNodeType];
                            if (reg) {
                                const port = reg.outputs.find((p: PortDefinition) => p.id === fromPort);
                                signalType = port?.type ?? 'audio';
                            }
                        }
                        if (!signalType) signalType = 'audio';
                    }
                    return {
                        id: c.id ?? '',
                        fromNode: c.from_node ?? c.fromNode ?? '',
                        fromPort,
                        toNode: c.to_node ?? c.toNode ?? '',
                        toPort,
                        signalType
                    } as SynthConnection;
                }),
                viewport: {
                    x: typedConfig.viewport?.x ?? 0,
                    y: typedConfig.viewport?.y ?? 0,
                    zoom: typedConfig.viewport?.zoom ?? 1
                }
            };
        } else {
            graph = cloneDefaultGraph();
        }

        const savedViewport = vpCache[deviceId];
        viewportProxy.setViewport(savedViewport ?? graph.viewport ?? DEFAULT_FLOW_GRAPH.viewport);

        // P0-2 FIX: Populate _nodeIdMap synchronously so that any knob twist
        // BEFORE the async syncFlowGraphToEngine resolves is not silently dropped.
        _populateNodeIdMap(graph.nodes);

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
            viewportByDeviceId: vpCache,
            graphsByDeviceId: graphCache,
        };
    }),

    closeFlowEditor: () => set((state: FlowSynthState) => {
        // ENTERPRISE: Sync openEditorsByTrack — remove Flow device from eye button tracking
        if (state.activeDeviceId && state.activeTrackId) {
            const trackId = state.activeTrackId;
            const deviceId = state.activeDeviceId;
            useEngineStore.setState((s) => {
                const trackSet = new Set(s.openEditorsByTrack[trackId] ?? []);
                trackSet.delete(deviceId);
                return { openEditorsByTrack: { ...s.openEditorsByTrack, [trackId]: trackSet } };
            });
        }
        return _cacheAndCloseState(state);
    }),

    /**
     * ENTERPRISE P1-1 FIX: Hide Flow editor (for track switches).
     * Caches viewport + graph like closeFlowEditor but does NOT modify openEditorsByTrack.
     * This keeps the eye button green while the user is on another track.
     */
    hideFlowEditor: () => set((state: FlowSynthState) => _cacheAndCloseState(state)),

    setDisplayMode: (mode) => set({ displayMode: mode }),

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
        // P0-3 FIX: Increment local edit sequence so Undo subscription
        // does not overwrite in-flight user edits.
        _localEditSequence++;

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
                            engine.updateFlowNodeParam(trackIndex, numericId, key, String(val)).catch((err: unknown) => {
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

    // ── Clipboard Operations (Bitwig Grid Pattern) ─────────────────────
    copySelectedNodes: () => set((state) => {
        if (state.selectedNodeIds.length === 0) return {};
        const selected = new Set(state.selectedNodeIds);
        const copiedNodes = state.nodes.filter((n) => selected.has(n.id)).map((n) => JSON.parse(JSON.stringify(n)) as SynthNode);

        let minX = Infinity;
        let minY = Infinity;
        for (const node of copiedNodes) {
            if (node.position.x < minX) minX = node.position.x;
            if (node.position.y < minY) minY = node.position.y;
        }

        const internalConnections = state.connections.filter((c) => selected.has(c.fromNode) && selected.has(c.toNode)).map((c) => ({ ...c }));
        // Deep copy payload: Connections from outside the selection INTO the selection
        const incomingConnections = state.connections.filter((c) => !selected.has(c.fromNode) && selected.has(c.toNode)).map((c) => ({ ...c }));

        setFlowModuleClipboard({
            nodes: copiedNodes,
            internalConnections,
            incomingConnections,
            anchorX: minX,
            anchorY: minY,
        });
        return {};
    }),

    cutSelectedNodes: () => {
        get().copySelectedNodes();
        get().deleteSelectedNodes();
    },

    duplicateSelectedNodes: (deep = false) => {
        get().copySelectedNodes();
        get().pasteNodes(deep);
    },

    pasteNodes: (deep = false) => set((state) => {
        if (!flowModuleClipboard || flowModuleClipboard.nodes.length === 0) return {};
        const cb = flowModuleClipboard;

        // ENTERPRISE GUARD: Only one 'output' node is allowed per graph.
        // Filter out output nodes from paste if one already exists.
        const hasOutputNode = state.nodes.some((n) => n.type === 'output');
        const candidateNodes = hasOutputNode
            ? cb.nodes.filter((n) => n.type !== 'output')
            : cb.nodes;
        if (candidateNodes.length === 0) return {};

        // Build set of surviving candidate IDs (for connection filtering)
        const candidateIdSet = new Set(candidateNodes.map((n) => n.id));

        const idMap = new Map<string, string>();
        const newNodes: SynthNode[] = [];
        const baseOffset = FLOW_GRID_SNAP * 2;

        let totalOffsetX = 0;
        let totalOffsetY = 0;

        // Group-level collision detection to maintain relative spacing
        if (candidateNodes.length > 0) {
            const firstNode = candidateNodes[0];
            let testX = firstNode.position.x + baseOffset;
            let testY = firstNode.position.y + baseOffset;
            let iterations = 0;

            while (
                state.nodes.some((n) => Math.abs(n.position.x - testX) < 5 && Math.abs(n.position.y - testY) < 5) &&
                iterations < 20
            ) {
                testX += baseOffset;
                testY += baseOffset;
                iterations++;
            }
            totalOffsetX = testX - firstNode.position.x;
            totalOffsetY = testY - firstNode.position.y;
        }

        for (const node of candidateNodes) {
            const newId = `node-copy-${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 8))}`;
            idMap.set(node.id, newId);

            newNodes.push({
                ...node,
                id: newId,
                position: { x: node.position.x + totalOffsetX, y: node.position.y + totalOffsetY },
                // ENTERPRISE: Deep clone data to prevent shared references between original and pasted nodes
                data: JSON.parse(JSON.stringify(node.data)),
            });
        }

        const newConnections: SynthConnection[] = [];

        // Internal connections remap both ends
        // ENTERPRISE: Only include connections where BOTH nodes survived the output filter
        for (const conn of cb.internalConnections) {
            if (!candidateIdSet.has(conn.fromNode) || !candidateIdSet.has(conn.toNode)) continue;
            const mappedFrom = idMap.get(conn.fromNode);
            const mappedTo = idMap.get(conn.toNode);
            if (mappedFrom && mappedTo) {
                newConnections.push({
                    ...conn,
                    id: `conn-copy-${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 8))}`,
                    fromNode: mappedFrom,
                    toNode: mappedTo,
                });
            }
        }

        // Deep paste: remap only the sink (toNode), keeping the source identical
        if (deep) {
            // ENTERPRISE: To prevent conflicting multiple sources to the same sink, 
            // if we deep duplicate while existing source cables are intact, the backend engine
            // replaces the connection if ports overlap. It works cleanly due to the last-writer-wins pattern.
            for (const conn of cb.incomingConnections) {
                if (!candidateIdSet.has(conn.toNode)) continue;
                // ENTERPRISE: Verify source node still exists in the graph before creating the deep connection
                const sourceExists = state.nodes.some((n) => n.id === conn.fromNode);
                const mappedTo = idMap.get(conn.toNode);
                if (mappedTo && sourceExists) {
                    newConnections.push({
                        ...conn,
                        id: `conn-deep-${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 8))}`,
                        fromNode: conn.fromNode,
                        toNode: mappedTo,
                    });
                }
            }
        }

        const nextNodes = [...state.nodes, ...newNodes];
        const nextConnections = [...state.connections, ...newConnections];
        const newSelection = newNodes.map((n) => n.id);

        // Seed the proxy immediately for instantaneous zero-latency render of cables
        for (const nn of newNodes) {
            nodeMotionProxy.syncInitial(nn.id, nn.position.x, nn.position.y);
        }

        _scheduleSyncFlowGraph(get);

        return {
            nodes: nextNodes,
            connections: nextConnections,
            selectedNodeIds: newSelection,
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

        // P2-4 FIX: Use shared _populateNodeIdMap instead of duplicating the ID resolution algorithm.
        _populateNodeIdMap(state.nodes);

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
            const numericId = _nodeIdMap.get(n.id) ?? stableNodeNumericId(n.id);
            return [numericId, n.type, encodeNodeParams(n.data)];
        });
        // ENTERPRISE GUARD: Filter out orphaned connections where fromNode/toNode
        // is undefined/null (corrupt project data or hydration mismatch).
        const validConnections = state.connections.filter(
            (c) => c.fromNode && c.toNode,
        );
        const connections: [number, number, number, number][] = validConnections.map((c) => {
            const fromId = _nodeIdMap.get(c.fromNode) ?? stableNodeNumericId(c.fromNode);
            const toId = _nodeIdMap.get(c.toNode) ?? stableNodeNumericId(c.toNode);
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
        // BUG-LOOP-001 FIX: Guard against re-entrant subscription fire.
        // applyProjectDeltas creates a new track.flow_synth object ref, which would
        // trigger the Undo/Redo subscription to re-sync — causing an infinite loop.
        // BUG-LOOP-001b FIX: Wrap in try/finally — if applyProjectDeltas throws,
        // the guard MUST be cleared or undo/redo sync is permanently disabled.
        if (saveResponse?.deltas?.length) {
            _undoRedoSyncInProgress = true;
            try {
                await useEngineStore.getState().applyProjectDeltas(saveResponse.deltas, 'syncFlowGraphSave');
                // Update the reference so the subscription skips the change we just caused.
                const t = useEngineStore.getState().tracks.byId[state.activeTrackId ?? ''];
                if (t) _prevFlowSynthConfigObj = t.flow_synth;
            } finally {
                _undoRedoSyncInProgress = false;
            }
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

            // BUG-018 FIX: Validate preset connections — strip any that reference
            // non-existent nodes or ports to prevent undefined behavior in audio engine.
            const nodeIds = new Set(preset.nodes.map((n: SynthNode) => n.id));
            const validConnections = preset.connections.filter((conn: SynthConnection) => {
                if (!nodeIds.has(conn.fromNode) || !nodeIds.has(conn.toNode)) {
                    console.warn(`[FlowSynth] Preset "${preset.name}": stripped invalid connection from node "${conn.fromNode}" to "${conn.toNode}" — one or both nodes missing.`);
                    return false;
                }
                return true;
            });

            return {
                nodes: preset.nodes,
                connections: validConnections,
                presetName: preset.name,
                presetIndex: safeIndex,
                selectedNodeIds: [],
                selectedConnectionId: null,
                pendingConnection: null,
                graphsByDeviceId: updatedGraphs,
            };
        });

        // BUG-C FIX: Immediately seed the proxy with all new node positions.
        // After clearPositions() + set(), ConnectionsLayer will re-render and
        // FlowConnectionComponent will subscribe to the proxy. Without seeding,
        // the proxy has no positions → subscriptions never fire → connections
        // render at stale initialStart/initialEnd (or get skipped by BUG-A fix).
        for (const n of preset.nodes) {
            if (n.position) {
                nodeMotionProxy.syncInitial(n.id, n.position.x, n.position.y);
            }
        }

        // Sync new graph to engine + save to disk
        _scheduleSyncFlowGraph(get);
        _scheduleSaveConfig(get);
    },

    /**
     * BUG-034 FIX: Remove cached graph + viewport for a deleted device.
     * Called from deleteTrack to prevent unbounded cache growth.
     */
    cleanupDeviceCache: (deviceId: string) => set((state: FlowSynthState) => {
        const { [deviceId]: _g, ...remainingGraphs } = state.graphsByDeviceId;
        const { [deviceId]: _v, ...remainingViewports } = state.viewportByDeviceId;
        return {
            graphsByDeviceId: remainingGraphs,
            viewportByDeviceId: remainingViewports,
        };
    }),

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
        // P3 FIX: Replaced `(slot: any)` with typed access.
        const hasFlow =
            track.instrument?.plugin_id === FLOW_SYNTH_PLUGIN_ID
            || track.effects?.some((slot: { plugin_id?: string }) => slot.plugin_id === FLOW_SYNTH_PLUGIN_ID);
        if (!hasFlow) continue;

        // Hydrate graph from SSOT
        let graph: FlowGraph | null = null;
        if (track.flow_synth) {
            // P3 FIX: Use module-level RustFlow* interfaces instead of duplicating them.
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
        // P3 FIX: Use named constant instead of magic number 500.
        setTimeout(() => initFlowEnginesFromProject().catch(console.error), FLOW_ENGINE_SETTLE_MS);
    }
});

// Subscribe to global Undo/Redo track config changes. 
// When the Orchestrator pops an undo delta, it patches `track.flow_synth` in `useEngineStore`.
// We need to reflect that in `useFlowSynthStore` if the track is active.
let _prevFlowSynthConfigObj: unknown = null;
// BUG-LOOP-001 FIX: Guard flag to prevent re-entrant sync.
// When this subscription updates the store from backend data, it must NOT
// re-sync back to the engine. That would cause: subscribe → setState →
// syncToEngine → saveConfig → applyProjectDeltas → new flow_synth obj ref →
// subscribe fires again → INFINITE LOOP ("Maximum update depth exceeded").
let _undoRedoSyncInProgress = false;
useEngineStore.subscribe((state) => {
    // BUG-LOOP-001 FIX: If WE triggered this change via syncFlowGraphToEngine's
    // applyProjectDeltas, skip to break the cycle.
    if (_undoRedoSyncInProgress) return;

    const activeTrackId = useFlowSynthStore.getState().activeTrackId;
    if (!activeTrackId) return;
    const track = state.tracks.byId[activeTrackId];
    if (!track) return;

    // Check if the object reference changed (Zustand updates it on Delta patch)
    const currentConfig = track.flow_synth;
    if (currentConfig === _prevFlowSynthConfigObj) return;
    _prevFlowSynthConfigObj = currentConfig;

    if (currentConfig) {
        // P0-3 FIX: Capture the edit sequence BEFORE mapping.
        // If the user has edited since this delta was dispatched, skip the overwrite.
        const editSeqAtDelta = _localEditSequence;

        // P3 FIX: Use module-level RustFlow* interfaces.
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

        // P0-3 FIX: If the user edited a parameter between the delta dispatch and now,
        // skip overwriting nodes to avoid discarding their in-flight changes.
        if (_localEditSequence !== editSeqAtDelta) {
            // Only update connections (topology) — preserve user's node data edits.
            useFlowSynthStore.setState({ connections: mappedConnections });
        } else {
            useFlowSynthStore.setState((s) => ({
                nodes: mappedNodes.length > 0 ? mappedNodes : s.nodes,
                connections: mappedConnections,
            }));
        }
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
    // BUG-LOOP-001 FIX: Set guard to prevent the sync response deltas from
    // re-triggering this subscription and causing an infinite loop.
    // BUG-LOOP-001b FIX: Replaced fragile setTimeout(0) with async IIFE + try/finally.
    // The previous approach had two bugs:
    //  1. setTimeout(0) fires AFTER the macrotask boundary — but syncFlowGraphToEngine
    //     is async and may complete AFTER the timeout, leaving the guard cleared too early.
    //  2. If syncFlowGraphToEngine rejects, the guard was never cleared.
    // Now the guard is set synchronously, the sync is awaited, and finally always clears it.
    _undoRedoSyncInProgress = true;
    void (async () => {
        try {
            await useFlowSynthStore.getState().syncFlowGraphToEngine();
        } catch (err) {
            console.error('[FlowSynth] Undo/redo sync failed:', err);
        } finally {
            _undoRedoSyncInProgress = false;
            // Update the reference to the CURRENT config so that the subscribe
            // doesn't fire again when the sync response delta updates the object.
            const t = useEngineStore.getState().tracks.byId[useFlowSynthStore.getState().activeTrackId ?? ''];
            if (t) _prevFlowSynthConfigObj = t.flow_synth;
        }
    })();
});

