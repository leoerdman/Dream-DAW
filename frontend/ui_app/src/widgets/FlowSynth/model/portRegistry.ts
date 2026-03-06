/**
 * Flow Synth — Port Registry
 *
 * Defines named input/output ports for each node type.
 * Ports map to backend indices by their order in the array.
 */
export interface PortFaderConfig {
    min: number;
    max: number;
    step: number;
    dataKey: string;
    unit?: string;
    /** Default value when node.data has no stored value. Falls back to `min` if omitted. */
    default?: number;
}

export interface PortDefinition {
    id: string;
    label: string;
    type: 'audio' | 'control' | 'midi' | 'gate' | 'phase';
    /** Optional inline fader for control-type input ports (Bitwig Grid attenuator) */
    fader?: PortFaderConfig;
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
    | 'audioIn'
    | 'lfo'
    | 'noise'
    | 'add'
    | 'multiply'
    | 'sampleHold'
    | 'delay'
    | 'mixer'
    | 'vca'
    | 'pitch'
    | 'utility'
    | 'distortion'
    | 'vst3';

export const PORT_REGISTRY: Record<SynthNodeType, NodePortConfig> = {
    midiIn: {
        title: 'MIDI In',
        color: 'var(--color-signal-midi)',
        inputs: [],
        outputs: [
            { id: 'freq', label: 'Freq', type: 'control' },
            { id: 'velocity', label: 'Vel', type: 'control' },
            { id: 'gate', label: 'Gate', type: 'gate' },
        ],
    },
    oscillator: {
        title: 'Oscillator',
        color: 'var(--color-synth-osc)',
        inputs: [
            { id: 'freq', label: 'Freq', type: 'control', fader: { min: 20, max: 20000, step: 1, dataKey: 'frequency', unit: 'Hz' } },
            { id: 'pw', label: 'PW', type: 'control', fader: { min: 0, max: 1, step: 0.01, dataKey: 'pulseWidth' } },
            { id: 'fm', label: 'FM', type: 'audio' },
            { id: 'pm', label: 'PM', type: 'audio' },
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
            { id: 'cutoff', label: 'Cut', type: 'control', fader: { min: 20, max: 20000, step: 1, dataKey: 'cutoff', unit: 'Hz' } },
            { id: 'resonance', label: 'Res', type: 'control', fader: { min: 0, max: 1, step: 0.01, dataKey: 'resonance' } },
        ],
        outputs: [
            { id: 'audio', label: 'Out', type: 'audio' },
        ],
    },
    envelope: {
        title: 'Envelope',
        color: 'var(--color-synth-env)',
        inputs: [
            { id: 'gate', label: 'Gate', type: 'gate' },
            { id: 'attack', label: 'Atk', type: 'control', fader: { min: 0.001, max: 5, step: 0.001, dataKey: 'attack', unit: 's' } },
            { id: 'decay', label: 'Dec', type: 'control', fader: { min: 0.001, max: 5, step: 0.001, dataKey: 'decay', unit: 's' } },
            { id: 'sustain', label: 'Sus', type: 'control', fader: { min: 0, max: 1, step: 0.01, dataKey: 'sustain' } },
            { id: 'release', label: 'Rel', type: 'control', fader: { min: 0.001, max: 8, step: 0.001, dataKey: 'release', unit: 's' } },
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
            { id: 'low_gain', label: 'Low', type: 'control', fader: { min: -12, max: 12, step: 0.1, dataKey: 'lowGain', unit: 'dB', default: 0 } },
            { id: 'mid_gain', label: 'Mid', type: 'control', fader: { min: -12, max: 12, step: 0.1, dataKey: 'midGain', unit: 'dB', default: 0 } },
            { id: 'high_gain', label: 'High', type: 'control', fader: { min: -12, max: 12, step: 0.1, dataKey: 'highGain', unit: 'dB', default: 0 } },
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
            { id: 'cutoff', label: 'Cut', type: 'control', fader: { min: 20, max: 20000, step: 1, dataKey: 'cutoff', unit: 'Hz' } },
            { id: 'resonance', label: 'Res', type: 'control', fader: { min: 0, max: 1, step: 0.01, dataKey: 'resonance' } },
            { id: 'rate', label: 'Rate', type: 'control', fader: { min: 0.01, max: 20, step: 0.01, dataKey: 'rate', unit: 'Hz' } },
            { id: 'depth', label: 'Depth', type: 'control', fader: { min: 0, max: 1, step: 0.01, dataKey: 'depth' } },
            { id: 'envFollow', label: 'Env', type: 'control', fader: { min: 0, max: 1, step: 0.01, dataKey: 'envDepth' } },
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
        // Signal flows to AudioOutNode input 0 (left) — mono→stereo fallback handles right channel.
        inputs: [
            { id: 'audio', label: 'In', type: 'audio' },
        ],
        outputs: [],
    },

    // ── Phase 1: New Modular Nodes ──────────────────────────────────────

    lfo: {
        title: 'LFO',
        color: 'var(--color-synth-lfo)',
        inputs: [
            { id: 'rate_mod', label: 'Rate', type: 'control', fader: { min: 0.01, max: 20, step: 0.01, dataKey: 'rate', unit: 'Hz' } },
            { id: 'reset', label: 'Reset', type: 'gate' },
        ],
        outputs: [
            { id: 'signal', label: 'CV', type: 'control' },
            { id: 'phase', label: 'Phase', type: 'phase' },
        ],
    },
    noise: {
        title: 'Noise',
        color: 'var(--color-synth-noise)',
        inputs: [],
        outputs: [
            { id: 'audio', label: 'Out', type: 'audio' },
        ],
    },
    add: {
        title: 'Add',
        color: 'var(--color-synth-math)',
        inputs: [
            { id: 'a', label: 'A', type: 'audio' },
            { id: 'b', label: 'B', type: 'audio' },
        ],
        outputs: [
            { id: 'sum', label: 'Out', type: 'audio' },
        ],
    },
    multiply: {
        title: 'Multiply',
        color: 'var(--color-synth-math)',
        inputs: [
            { id: 'a', label: 'A', type: 'audio' },
            { id: 'b', label: 'B', type: 'audio' },
        ],
        outputs: [
            { id: 'product', label: 'Out', type: 'audio' },
        ],
    },
    sampleHold: {
        title: 'S&H',
        color: 'var(--color-synth-math)',
        inputs: [
            { id: 'signal', label: 'In', type: 'control' },
            { id: 'trigger', label: 'Trig', type: 'gate' },
        ],
        outputs: [
            { id: 'held', label: 'Out', type: 'control' },
        ],
    },
    delay: {
        title: 'Delay',
        color: 'var(--color-synth-delay)',
        inputs: [
            { id: 'audio', label: 'In', type: 'audio' },
            { id: 'time_mod', label: 'Time', type: 'control', fader: { min: 1, max: 2000, step: 1, dataKey: 'time', unit: 'ms' } },
            { id: 'feedback_mod', label: 'FB', type: 'control', fader: { min: 0, max: 0.99, step: 0.01, dataKey: 'feedback' } },
        ],
        outputs: [
            { id: 'audio', label: 'Out', type: 'audio' },
        ],
    },
    mixer: {
        title: 'Mixer',
        color: 'var(--color-synth-mixer)',
        inputs: [
            { id: 'in_1', label: 'Ch1', type: 'audio', fader: { min: 0, max: 2, step: 0.01, dataKey: 'gain1' } },
            { id: 'in_2', label: 'Ch2', type: 'audio', fader: { min: 0, max: 2, step: 0.01, dataKey: 'gain2' } },
            { id: 'in_3', label: 'Ch3', type: 'audio', fader: { min: 0, max: 2, step: 0.01, dataKey: 'gain3' } },
            { id: 'in_4', label: 'Ch4', type: 'audio', fader: { min: 0, max: 2, step: 0.01, dataKey: 'gain4' } },
        ],
        outputs: [
            { id: 'audio', label: 'Out', type: 'audio' },
        ],
    },
    vca: {
        title: 'VCA',
        color: 'var(--color-synth-vca)',
        inputs: [
            { id: 'audio', label: 'In', type: 'audio' },
            { id: 'cv', label: 'CV', type: 'control', fader: { min: 0, max: 1, step: 0.01, dataKey: 'bias' } },
        ],
        outputs: [
            { id: 'audio', label: 'Out', type: 'audio' },
        ],
    },
    pitch: {
        title: 'Pitch',
        color: 'var(--color-synth-ctrl)',
        inputs: [
            { id: 'freq', label: 'Freq', type: 'control' },
            { id: 'octave', label: 'Octave', type: 'control', fader: { min: -4, max: 4, step: 1, dataKey: 'octaveOffset', default: 0 } },
        ],
        outputs: [
            { id: 'freq_out', label: 'Out', type: 'control' },
        ],
    },
    utility: {
        title: 'Utility',
        color: 'var(--color-synth-fx)',
        inputs: [
            { id: 'audio', label: 'In', type: 'audio' },
            { id: 'gain', label: 'Gain', type: 'control', fader: { min: 0, max: 4, step: 0.01, dataKey: 'gain', default: 1, unit: 'x' } },
            { id: 'pan', label: 'Pan', type: 'control', fader: { min: -1, max: 1, step: 0.01, dataKey: 'pan', default: 0 } },
        ],
        outputs: [
            { id: 'audio', label: 'Out', type: 'audio' },
        ],
    },
    distortion: {
        title: 'Distortion',
        color: 'var(--color-synth-fx)',
        inputs: [
            { id: 'audio', label: 'In', type: 'audio' },
            { id: 'drive', label: 'Drive', type: 'control', fader: { min: 0, max: 1, step: 0.01, dataKey: 'drive', default: 0.5 } },
            { id: 'mix', label: 'Mix', type: 'control', fader: { min: 0, max: 1, step: 0.01, dataKey: 'mix', default: 1 } },
        ],
        outputs: [
            { id: 'audio', label: 'Out', type: 'audio' },
        ],
    },
    vst3: {
        title: 'VST3',
        color: 'var(--color-accent-tertiary)',
        inputs: [
            { id: 'audio', label: 'In', type: 'audio' },
            { id: 'midi', label: 'MIDI', type: 'midi' },
        ],
        outputs: [
            { id: 'audio', label: 'Out', type: 'audio' },
        ],
    },
};

/**
 * Row layout constants matching the reference project architecture.
 * Each port occupies one row slot.
 */
export const FLOW_PORT_SIZE = 8;
export const FLOW_PORT_ROW_HEIGHT = 32;
export const FLOW_NODE_HEADER_HEIGHT = 42;
export const FLOW_NODE_BODY_PADDING = 12;

/**
 * Calculate Y center of a port given its index within the port list.
 */
export function portCenterY(portIndex: number): number {
    return FLOW_PORT_ROW_HEIGHT * portIndex + FLOW_PORT_ROW_HEIGHT / 2;
}

/**
 * Number of inline control rows per node type.
 * Stateless nodes (add, sampleHold, audioIn, midiIn, noise with selector only) get 0.
 * This drives nodeHeight so the body is never clipped or oversized.
 */
const CONTROL_ROWS: Partial<Record<SynthNodeType, number>> = {
    oscillator: 1,   // waveform select only
    filter: 1,       // filter type select only
    envelope: 1,     // ADSR visualizer (compact)
    eq: 2,           // crossover frequency knobs (band gain via inline faders)
    autofilter: 1,   // filter type select only
    reverse: 3,
    midiIn: 1,
    lfo: 2,          // shape + mode selects
    noise: 2,
    delay: 3,        // time + feedback + mix
    mixer: 4,        // ch1-4 gain sliders
    vca: 1,          // bias
    multiply: 1,     // scale
    distortion: 1,   // mode selector
    vst3: 2,         // plugin selector
};

const CONTROL_ROW_HEIGHT = 28;

/**
 * Calculate total node height based on port count and control row count.
 */
export function nodeHeight(nodeType: SynthNodeType, hasControls: boolean): number {
    const config = PORT_REGISTRY[nodeType];
    const maxPorts = Math.max(config.inputs.length, config.outputs.length, 1);
    const portsHeight = maxPorts * FLOW_PORT_ROW_HEIGHT;
    const controlRows = hasControls ? (CONTROL_ROWS[nodeType] ?? 0) : 0;
    const controlsHeight = controlRows > 0 ? controlRows * CONTROL_ROW_HEIGHT + 16 : 0;
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
