/**
 * Flow Synth — Port Registry
 *
 * Defines named input/output ports for each node type.
 * Ports map to backend indices by their order in the array.
 */
export interface PortDefinition {
    id: string;
    label: string;
    type: 'audio' | 'control' | 'midi';
}

export interface NodePortConfig {
    title: string;
    color: string;
    inputs: PortDefinition[];
    outputs: PortDefinition[];
}

export type SynthNodeType =
    | 'midiIn'
    | 'oscillator'
    | 'filter'
    | 'envelope'
    | 'output'
    | 'eq'
    | 'autofilter'
    | 'reverse'
    | 'audioIn';

export const PORT_REGISTRY: Record<SynthNodeType, NodePortConfig> = {
    midiIn: {
        title: 'MIDI In',
        color: 'var(--color-signal-midi)',
        inputs: [],
        outputs: [
            { id: 'freq', label: 'Freq', type: 'control' },
            { id: 'velocity', label: 'Vel', type: 'control' },
            { id: 'gate', label: 'Gate', type: 'control' },
        ],
    },
    oscillator: {
        title: 'Oscillator',
        color: 'var(--color-synth-osc)',
        inputs: [
            { id: 'freq', label: 'Freq', type: 'control' },
            { id: 'pw', label: 'PW', type: 'control' },
            { id: 'fm', label: 'FM', type: 'control' },
            { id: 'pm', label: 'PM', type: 'control' },
        ],
        outputs: [
            { id: 'audio', label: 'Out', type: 'audio' },
        ],
    },
    filter: {
        title: 'Filter',
        color: 'var(--color-synth-filter)',
        inputs: [
            { id: 'audio', label: 'In', type: 'audio' },
            { id: 'cutoff', label: 'Cut', type: 'control' },
            { id: 'resonance', label: 'Res', type: 'control' },
        ],
        outputs: [
            { id: 'audio', label: 'Out', type: 'audio' },
        ],
    },
    envelope: {
        title: 'Envelope',
        color: 'var(--color-synth-env)',
        inputs: [
            { id: 'gate', label: 'Gate', type: 'control' },
            { id: 'attack', label: 'Atk', type: 'control' },
            { id: 'decay', label: 'Dec', type: 'control' },
            { id: 'sustain', label: 'Sus', type: 'control' },
            { id: 'release', label: 'Rel', type: 'control' },
        ],
        outputs: [
            { id: 'cv', label: 'CV', type: 'control' },
        ],
    },
    eq: {
        title: 'EQ',
        color: 'var(--color-signal-audio)',
        inputs: [
            { id: 'audio', label: 'In', type: 'audio' },
        ],
        outputs: [
            { id: 'audio', label: 'Out', type: 'audio' },
        ],
    },
    autofilter: {
        title: 'Auto Filter',
        color: 'var(--color-synth-filter)',
        inputs: [
            { id: 'audio', label: 'In', type: 'audio' },
            { id: 'cutoff', label: 'Cut', type: 'control' },
            { id: 'resonance', label: 'Res', type: 'control' },
            { id: 'rate', label: 'Rate', type: 'control' },
            { id: 'depth', label: 'Depth', type: 'control' },
            { id: 'envFollow', label: 'Env', type: 'control' },
        ],
        outputs: [
            { id: 'audio', label: 'Out', type: 'audio' },
        ],
    },
    reverse: {
        title: 'Reverse',
        color: 'var(--color-accent-primary)',
        inputs: [
            { id: 'audio', label: 'In', type: 'audio' },
        ],
        outputs: [
            { id: 'audio', label: 'Out', type: 'audio' },
        ],
    },
    audioIn: {
        title: 'Audio In',
        color: 'var(--color-signal-audio)',
        inputs: [],
        outputs: [
            { id: 'audio', label: 'Out', type: 'audio' },
        ],
    },
    output: {
        title: 'Output',
        color: 'var(--color-synth-out)',
        inputs: [
            { id: 'audio', label: 'In', type: 'audio' },
        ],
        outputs: [],
    },
};

/**
 * Row layout constants matching the reference project architecture.
 * Each port occupies one row slot.
 */
export const FLOW_PORT_SIZE = 12;
export const FLOW_PORT_ROW_HEIGHT = 28;
export const FLOW_NODE_HEADER_HEIGHT = 42;
export const FLOW_NODE_BODY_PADDING = 12;

/**
 * Calculate Y center of a port given its index within the port list.
 */
export function portCenterY(portIndex: number): number {
    return FLOW_PORT_ROW_HEIGHT * portIndex + FLOW_PORT_ROW_HEIGHT / 2;
}

/**
 * Calculate total node height based on port count.
 */
export function nodeHeight(nodeType: SynthNodeType, hasControls: boolean): number {
    const config = PORT_REGISTRY[nodeType];
    const maxPorts = Math.max(config.inputs.length, config.outputs.length, 1);
    const portsHeight = maxPorts * FLOW_PORT_ROW_HEIGHT;
    const controlsHeight = hasControls ? 72 : 0;
    return FLOW_NODE_HEADER_HEIGHT + portsHeight + controlsHeight + FLOW_NODE_BODY_PADDING;
}

/**
 * Convert a named port to its backend index (= position in the port array).
 */
export function portNameToIndex(nodeType: SynthNodeType, portId: string, side: 'in' | 'out'): number {
    const config = PORT_REGISTRY[nodeType];
    const list = side === 'in' ? config.inputs : config.outputs;
    const idx = list.findIndex((p) => p.id === portId);
    return idx >= 0 ? idx : 0;
}
