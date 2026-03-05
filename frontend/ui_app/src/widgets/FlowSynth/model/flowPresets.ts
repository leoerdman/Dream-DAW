/**
 * Flow Synth — Factory Presets
 *
 * Embedded preset definitions for the Flow modular synthesizer.
 * Each preset is a complete graph snapshot (nodes + connections).
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
            position: { x: 80, y: 260 },
            data: { label: 'Track MIDI In' },
        },
        {
            id: 'node-osc-1',
            type: 'oscillator',
            position: { x: 380, y: 260 },
            data: { label: 'Oscillator', waveform: 'sine', frequency: 440 },
        },
        {
            id: 'node-out-1',
            type: 'output',
            position: { x: 720, y: 260 },
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
            position: { x: 60, y: 200 },
            data: { label: 'Track MIDI In' },
        },
        {
            id: 'node-osc-1',
            type: 'oscillator',
            position: { x: 300, y: 160 },
            data: { label: 'Oscillator', waveform: 'saw', frequency: 440 },
        },
        {
            id: 'node-env-1',
            type: 'envelope',
            position: { x: 300, y: 360 },
            data: { attack: 0.3, decay: 0.2, sustain: 0.7, release: 0.8 },
        },
        {
            id: 'node-filter-1',
            type: 'filter',
            position: { x: 560, y: 200 },
            data: { label: 'Filter', cutoff: 1200, resonance: 0.3 },
        },
        {
            id: 'node-out-1',
            type: 'output',
            position: { x: 820, y: 220 },
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
            signalType: 'control',
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
            position: { x: 60, y: 200 },
            data: { label: 'Track MIDI In' },
        },
        {
            id: 'node-osc-1',
            type: 'oscillator',
            position: { x: 300, y: 160 },
            data: { label: 'Oscillator', waveform: 'square', frequency: 440 },
        },
        {
            id: 'node-env-1',
            type: 'envelope',
            position: { x: 300, y: 380 },
            data: { attack: 0.005, decay: 0.15, sustain: 0.0, release: 0.1 },
        },
        {
            id: 'node-filter-1',
            type: 'filter',
            position: { x: 560, y: 200 },
            data: { label: 'Filter', cutoff: 3000, resonance: 0.5 },
        },
        {
            id: 'node-out-1',
            type: 'output',
            position: { x: 820, y: 220 },
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
            signalType: 'control',
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

/**
 * All factory presets, indexed by their position in the list.
 * The first preset ("Init Patch") is the default loaded into new graphs.
 */
export const FACTORY_PRESETS: FlowPreset[] = [
    INIT_PATCH,
    WARM_PAD,
    PLUCK,
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
