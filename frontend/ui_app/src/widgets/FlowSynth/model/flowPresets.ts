/**
 * Flow Synth — Factory Presets
 *
 * Embedded preset definitions for the Flow modular synthesizer.
 * Each preset is a complete graph snapshot (nodes + connections).
 *
 * Layout convention: FLOW_NODE_WIDTH = 260, minimum gap = 120px.
 * Column step = 380px. Row step ≥ 220px for vertical separation.
 */

import type { SynthNode, SynthConnection } from './useFlowSynthStore';

export interface FlowPreset {
    name: string;
    nodes: SynthNode[];
    connections: SynthConnection[];
}

// ── Init Patch ─────────────────────────────────────────────────────────
// MidiIn → Oscillator (Sine) → Output
const INIT_PATCH: FlowPreset = {
    name: 'Init Patch',
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
            position: { x: 500, y: 280 },
            data: { label: 'Oscillator', waveform: 'sine', frequency: 440 },
        },
        {
            id: 'node-out-1',
            type: 'output',
            position: { x: 920, y: 280 },
            data: { label: 'Audio Out', gain: 0.8, muted: false },
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
};

// ── Warm Pad ───────────────────────────────────────────────────────────
// MidiIn → Oscillator (Saw) → Filter (LP 1200Hz) + Envelope → Output
const WARM_PAD: FlowPreset = {
    name: 'Warm Pad',
    nodes: [
        {
            id: 'node-midi-in-1',
            type: 'midiIn',
            position: { x: 80, y: 220 },
            data: { label: 'Track MIDI In' },
        },
        {
            id: 'node-osc-1',
            type: 'oscillator',
            position: { x: 500, y: 160 },
            data: { label: 'Oscillator', waveform: 'saw', frequency: 440 },
        },
        {
            id: 'node-env-1',
            type: 'envelope',
            position: { x: 500, y: 440 },
            data: { attack: 0.3, decay: 0.2, sustain: 0.7, release: 0.8 },
        },
        {
            id: 'node-filter-1',
            type: 'filter',
            position: { x: 920, y: 220 },
            data: { label: 'Filter', cutoff: 1200, resonance: 0.3 },
        },
        {
            id: 'node-out-1',
            type: 'output',
            position: { x: 1340, y: 240 },
            data: { label: 'Audio Out', gain: 0.7, muted: false },
        },
    ],
    connections: [
        {
            id: 'conn-midi-freq-osc',
            fromNode: 'node-midi-in-1',
            fromPort: 'freq',
            toNode: 'node-osc-1',
            toPort: 'freq',
            signalType: 'control',
        },
        {
            id: 'conn-midi-gate-env',
            fromNode: 'node-midi-in-1',
            fromPort: 'gate',
            toNode: 'node-env-1',
            toPort: 'gate',
            signalType: 'gate',
        },
        {
            id: 'conn-osc-to-filter',
            fromNode: 'node-osc-1',
            fromPort: 'audio',
            toNode: 'node-filter-1',
            toPort: 'audio',
            signalType: 'audio',
        },
        {
            id: 'conn-env-to-filter-cut',
            fromNode: 'node-env-1',
            fromPort: 'cv',
            toNode: 'node-filter-1',
            toPort: 'cutoff',
            signalType: 'control',
        },
        {
            id: 'conn-filter-to-out',
            fromNode: 'node-filter-1',
            fromPort: 'audio',
            toNode: 'node-out-1',
            toPort: 'audio',
            signalType: 'audio',
        },
    ],
};

// ── Pluck ──────────────────────────────────────────────────────────────
// MidiIn → Oscillator (Square) → Filter (LP 3000Hz) + Envelope (fast decay) → Output
const PLUCK: FlowPreset = {
    name: 'Pluck',
    nodes: [
        {
            id: 'node-midi-in-1',
            type: 'midiIn',
            position: { x: 80, y: 220 },
            data: { label: 'Track MIDI In' },
        },
        {
            id: 'node-osc-1',
            type: 'oscillator',
            position: { x: 500, y: 160 },
            data: { label: 'Oscillator', waveform: 'square', frequency: 440 },
        },
        {
            id: 'node-env-1',
            type: 'envelope',
            position: { x: 500, y: 460 },
            data: { attack: 0.005, decay: 0.15, sustain: 0.0, release: 0.1 },
        },
        {
            id: 'node-filter-1',
            type: 'filter',
            position: { x: 920, y: 220 },
            data: { label: 'Filter', cutoff: 3000, resonance: 0.5 },
        },
        {
            id: 'node-out-1',
            type: 'output',
            position: { x: 1340, y: 240 },
            data: { label: 'Audio Out', gain: 0.8, muted: false },
        },
    ],
    connections: [
        {
            id: 'conn-midi-freq-osc',
            fromNode: 'node-midi-in-1',
            fromPort: 'freq',
            toNode: 'node-osc-1',
            toPort: 'freq',
            signalType: 'control',
        },
        {
            id: 'conn-midi-gate-env',
            fromNode: 'node-midi-in-1',
            fromPort: 'gate',
            toNode: 'node-env-1',
            toPort: 'gate',
            signalType: 'gate',
        },
        {
            id: 'conn-osc-to-filter',
            fromNode: 'node-osc-1',
            fromPort: 'audio',
            toNode: 'node-filter-1',
            toPort: 'audio',
            signalType: 'audio',
        },
        {
            id: 'conn-env-to-filter-cut',
            fromNode: 'node-env-1',
            fromPort: 'cv',
            toNode: 'node-filter-1',
            toPort: 'cutoff',
            signalType: 'control',
        },
        {
            id: 'conn-filter-to-out',
            fromNode: 'node-filter-1',
            fromPort: 'audio',
            toNode: 'node-out-1',
            toPort: 'audio',
            signalType: 'audio',
        },
    ],
};

// ── Ambient Pad (Phase 1) ─────────────────────────────────────────────
// MidiIn → Osc (Saw) → Filter ← LFO (Sine 0.3Hz) → Delay → Output
const AMBIENT_PAD: FlowPreset = {
    name: 'Ambient Pad',
    nodes: [
        { id: 'node-midi-1', type: 'midiIn', position: { x: 80, y: 220 }, data: { label: 'Track MIDI In' } },
        { id: 'node-osc-1', type: 'oscillator', position: { x: 500, y: 160 }, data: { label: 'Oscillator', waveform: 'saw', frequency: 440 } },
        { id: 'node-lfo-1', type: 'lfo', position: { x: 500, y: 500 }, data: { rate: 0.3, shape: 'sine', bipolar: true } },
        { id: 'node-filter-1', type: 'filter', position: { x: 920, y: 220 }, data: { label: 'Filter', cutoff: 1800, resonance: 0.4 } },
        { id: 'node-delay-1', type: 'delay', position: { x: 1340, y: 220 }, data: { time: 400, feedback: 0.55, mix: 0.35 } },
        { id: 'node-out-1', type: 'output', position: { x: 1760, y: 240 }, data: { label: 'Audio Out', gain: 0.65, muted: false } },
    ],
    connections: [
        { id: 'c-midi-freq', fromNode: 'node-midi-1', fromPort: 'freq', toNode: 'node-osc-1', toPort: 'freq', signalType: 'control' },
        { id: 'c-osc-flt', fromNode: 'node-osc-1', fromPort: 'audio', toNode: 'node-filter-1', toPort: 'audio', signalType: 'audio' },
        { id: 'c-lfo-cut', fromNode: 'node-lfo-1', fromPort: 'signal', toNode: 'node-filter-1', toPort: 'cutoff', signalType: 'control' },
        { id: 'c-flt-dly', fromNode: 'node-filter-1', fromPort: 'audio', toNode: 'node-delay-1', toPort: 'audio', signalType: 'audio' },
        { id: 'c-dly-out', fromNode: 'node-delay-1', fromPort: 'audio', toNode: 'node-out-1', toPort: 'audio', signalType: 'audio' },
    ],
};

// ── Noise Percussion (Phase 1) ────────────────────────────────────────
// Noise → VCA ← Envelope (fast AD) → Filter (HP) → Output
const NOISE_PERC: FlowPreset = {
    name: 'Noise Percussion',
    nodes: [
        { id: 'node-midi-1', type: 'midiIn', position: { x: 80, y: 220 }, data: { label: 'Track MIDI In' } },
        { id: 'node-noise-1', type: 'noise', position: { x: 480, y: 120 }, data: { color: 'white', level: 1.0 } },
        { id: 'node-env-1', type: 'envelope', position: { x: 480, y: 440 }, data: { attack: 0.001, decay: 0.08, sustain: 0.0, release: 0.05 } },
        { id: 'node-vca-1', type: 'vca', position: { x: 900, y: 200 }, data: { bias: 1.0 } },
        { id: 'node-filter-1', type: 'filter', position: { x: 1300, y: 220 }, data: { label: 'Filter', cutoff: 5000, resonance: 0.2 } },
        { id: 'node-out-1', type: 'output', position: { x: 1700, y: 240 }, data: { label: 'Audio Out', gain: 0.8, muted: false } },
    ],
    connections: [
        { id: 'c-midi-gate', fromNode: 'node-midi-1', fromPort: 'gate', toNode: 'node-env-1', toPort: 'gate', signalType: 'gate' },
        { id: 'c-noise-vca', fromNode: 'node-noise-1', fromPort: 'audio', toNode: 'node-vca-1', toPort: 'audio', signalType: 'audio' },
        { id: 'c-env-vca', fromNode: 'node-env-1', fromPort: 'cv', toNode: 'node-vca-1', toPort: 'cv', signalType: 'control' },
        { id: 'c-vca-flt', fromNode: 'node-vca-1', fromPort: 'audio', toNode: 'node-filter-1', toPort: 'audio', signalType: 'audio' },
        { id: 'c-flt-out', fromNode: 'node-filter-1', fromPort: 'audio', toNode: 'node-out-1', toPort: 'audio', signalType: 'audio' },
    ],
};

// ── FM Bass (Phase 1) ─────────────────────────────────────────────────
// MidiIn → Osc1 (Sine carrier) + Osc2 (Sine mod) → Multiply → VCA ← Envelope → Output
const FM_BASS: FlowPreset = {
    name: 'FM Bass',
    nodes: [
        { id: 'node-midi-1', type: 'midiIn', position: { x: 80, y: 260 }, data: { label: 'Track MIDI In' } },
        { id: 'node-osc-carrier', type: 'oscillator', position: { x: 500, y: 120 }, data: { label: 'Carrier', waveform: 'sine', frequency: 440 } },
        { id: 'node-osc-mod', type: 'oscillator', position: { x: 500, y: 420 }, data: { label: 'Modulator', waveform: 'sine', frequency: 880 } },
        { id: 'node-mul-1', type: 'multiply', position: { x: 920, y: 200 }, data: { scale: 0.8 } },
        { id: 'node-env-1', type: 'envelope', position: { x: 920, y: 500 }, data: { attack: 0.005, decay: 0.2, sustain: 0.4, release: 0.15 } },
        { id: 'node-vca-1', type: 'vca', position: { x: 1340, y: 220 }, data: { bias: 1.0 } },
        { id: 'node-out-1', type: 'output', position: { x: 1760, y: 240 }, data: { label: 'Audio Out', gain: 0.75, muted: false } },
    ],
    connections: [
        { id: 'c-midi-freq-c', fromNode: 'node-midi-1', fromPort: 'freq', toNode: 'node-osc-carrier', toPort: 'freq', signalType: 'control' },
        { id: 'c-midi-freq-m', fromNode: 'node-midi-1', fromPort: 'freq', toNode: 'node-osc-mod', toPort: 'freq', signalType: 'control' },
        { id: 'c-midi-gate', fromNode: 'node-midi-1', fromPort: 'gate', toNode: 'node-env-1', toPort: 'gate', signalType: 'gate' },
        { id: 'c-carrier-mul', fromNode: 'node-osc-carrier', fromPort: 'audio', toNode: 'node-mul-1', toPort: 'a', signalType: 'audio' },
        { id: 'c-mod-mul', fromNode: 'node-osc-mod', fromPort: 'audio', toNode: 'node-mul-1', toPort: 'b', signalType: 'audio' },
        { id: 'c-mul-vca', fromNode: 'node-mul-1', fromPort: 'product', toNode: 'node-vca-1', toPort: 'audio', signalType: 'audio' },
        { id: 'c-env-vca', fromNode: 'node-env-1', fromPort: 'cv', toNode: 'node-vca-1', toPort: 'cv', signalType: 'control' },
        { id: 'c-vca-out', fromNode: 'node-vca-1', fromPort: 'audio', toNode: 'node-out-1', toPort: 'audio', signalType: 'audio' },
    ],
};

/**
 * All factory presets, indexed by their position in the list.
 * The first preset ("Init Patch") is the default loaded into new graphs.
 */
export const FACTORY_PRESETS: FlowPreset[] = [
    INIT_PATCH,
    WARM_PAD,
    PLUCK,
    AMBIENT_PAD,
    NOISE_PERC,
    FM_BASS,
];

/**
 * Deep-clone a preset so loaded state is mutation-safe.
 */
export function clonePreset(preset: FlowPreset): FlowPreset {
    return {
        name: preset.name,
        nodes: preset.nodes.map((n) => ({
            ...n,
            position: { ...n.position },
            data: { ...(n.data ?? {}) },
        })),
        connections: preset.connections.map((c) => ({ ...c })),
    };
}
