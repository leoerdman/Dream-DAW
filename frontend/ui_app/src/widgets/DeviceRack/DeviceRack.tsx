import { Fragment, useMemo, useState, useCallback, useEffect, useRef } from 'react';
import throttle from 'lodash.throttle';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useDragStore } from '@/shared/stores/useDragStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import * as engineApi from '@/shared/api/engine';
import {
    PluginKnob,
    type PluginParam,
} from '@/widgets/DeviceRack/StandardPluginControls';
import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';
import { canDropInZone } from '@/shared/lib/dndMatrix';
import {
    getInternalPluginById,
    normalizeInternalPluginId,
    waveformIndexFromSamplePath,
    waveformLabel,
} from '@/shared/lib/internalPlugins';

/**
 * DeviceRack — Bottom panel: instrument & effects signal chain.
 *
 * Each track has its own Instrument & Effects chain (currently empty until
 * the user drops devices). IN/OUT meters show real-time signal levels
 * from the engine's MeterBank.
 *
 * Layout: [Title Bar] → [IN meter] → [...devices...] → [OUT meter] → [+ Add]
 */

// ── Types ──────────────────────────────────────────────────

interface DeviceSlot {
    id: string;
    name: string;
    effectType:
    | 'eq'
    | 'compressor'
    | 'delay'
    | 'reverb'
    | 'chorus'
    | 'utility'
    | 'limiter'
    | 'gate'
    | 'autoFilter'
    | 'autoPan'
    | 'phaser'
    | 'flanger'
    | 'distortion'
    | 'bitcrusher'
    | 'noiseMachine'
    | 'spectrum'
    | 'midiPitch'
    | 'midiScale'
    | 'midiVelocity'
    | 'midiRandom'
    | 'vst'
    | 'instrument'
    | 'sampler'
    | 'saturator'
    | 'waveSynth'
    | 'rack';
    isEnabled: boolean;
    params: PluginParam[];
    vuLevel: number;
    pluginId: string;
    isVst: boolean;
    source: 'internal' | 'vst' | 'unknown';
    samplePath?: string;
    supportsSidechain?: boolean;
    sidechainSourceTrackId?: string | null;
    guiMode?: string;
}

const INTERNAL_EFFECT_TYPE_BY_PLUGIN_ID: Partial<Record<string, DeviceSlot['effectType']>> = {
    'internal://instrument/wave-synth': 'waveSynth',
    'internal://instrument/sampler': 'sampler',

    'internal://effect/eq-eight': 'eq',
    'internal://effect/channel-eq': 'eq',
    'internal://effect/eq-three': 'eq',

    'internal://effect/compressor': 'compressor',
    'internal://effect/multiband-dynamics': 'compressor',
    'internal://effect/transient-shaper': 'compressor',

    'internal://effect/delay': 'delay',
    'internal://effect/echo': 'delay',
    'internal://effect/grain-delay': 'delay',
    'internal://effect/beat-repeat': 'delay',
    'internal://effect/looper': 'delay',
    'internal://effect/spectral-time': 'delay',

    'internal://effect/reverb': 'reverb',
    'internal://effect/hybrid-reverb': 'reverb',
    'internal://effect/corpus': 'reverb',
    'internal://effect/resonators': 'reverb',
    'internal://effect/spectral-resonator': 'reverb',

    'internal://effect/chorus': 'chorus',
    'internal://effect/saturator': 'saturator',
    'internal://effect/drum-buss': 'saturator',
    'internal://effect/dynamic-tube': 'saturator',

    'internal://effect/utility': 'utility',
    'internal://effect/tuner': 'utility',
    'internal://effect/auto-shift': 'utility',
    'internal://effect/shifter': 'utility',
    'internal://effect/external-audio-effect': 'utility',

    'internal://effect/limiter': 'limiter',
    'internal://effect/gate': 'gate',

    'internal://effect/auto-filter': 'autoFilter',
    'internal://effect/vocoder': 'autoFilter',
    'internal://effect/auto-pan': 'autoPan',
    'internal://effect/phaser': 'phaser',
    'internal://effect/flanger': 'flanger',

    'internal://effect/distortion': 'distortion',
    'internal://effect/amp': 'distortion',
    'internal://effect/cabinet': 'distortion',
    'internal://effect/overdrive': 'distortion',
    'internal://effect/pedal': 'distortion',
    'internal://effect/roar': 'distortion',
    'internal://effect/erosion': 'distortion',
    'internal://effect/bitcrusher': 'bitcrusher',

    'internal://effect/noise-machine': 'noiseMachine',
    'internal://effect/spectrum': 'spectrum',

    'internal://midi-fx/pitch': 'midiPitch',
    'internal://midi-fx/scale': 'midiScale',
    'internal://midi-fx/chord': 'midiScale',
    'internal://midi-fx/velocity': 'midiVelocity',
    'internal://midi-fx/note-length': 'midiVelocity',
    'internal://midi-fx/cc-control': 'midiVelocity',
    'internal://midi-fx/expression-control': 'midiVelocity',
    'internal://midi-fx/random': 'midiRandom',
    'internal://midi-fx/arpeggiator': 'midiRandom',
};

const RUNTIME_PARAM_INDEX_BY_EFFECT: Partial<Record<
    DeviceSlot['effectType'],
    Record<string, number>
>> = {
    eq: {
        lowfreq: 4,
        low: 5,
        lowq: 6,
        midfreq: 12,
        mid: 13,
        midq: 14,
        highfreq: 24,
        high: 25,
        highq: 26,
        out: 32,
    },
    utility: { gain: 0, pan: 1, width: 2, mono: 3 },
    compressor: { thr: 0, ratio: 1, atk: 2, rel: 3 },
    delay: { time: 0, fb: 1, 'dry/wet': 2, mix: 2 },
    reverb: { decay: 0, tone: 1, 'dry/wet': 2, mix: 2 },
    chorus: { rate: 0, depth: 1, mix: 2 },
    saturator: { drive: 0, tone: 1, mix: 2 },
    limiter: { thr: 0, rel: 1, ceil: 2 },
    gate: { thr: 0, atk: 1, hold: 2, rel: 3, range: 4 },
    autoFilter: { cutoff: 0, res: 1, rate: 2, depth: 3, env: 4, type: 5, mix: 6 },
    autoPan: { rate: 0, depth: 1, phase: 2, shape: 3, mix: 4 },
    phaser: { rate: 0, depth: 1, fb: 2, stages: 3, center: 4, mix: 5 },
    flanger: { rate: 0, depth: 1, fb: 2, delay: 3, mix: 4 },
    distortion: { drive: 0, tone: 1, mix: 2, mode: 3 },
    bitcrusher: { bits: 0, down: 1, mix: 2 },
    noiseMachine: { type: 0, level: 1, stereo: 2, lpfreq: 3, hpfreq: 4, pan: 5 },
    midiPitch: { semitones: 0 },
    midiScale: { root: 0, mask: 1 },
    midiVelocity: { gain: 0, offset: 1 },
    midiRandom: { semitones: 0, chance: 1 },
};

const DEVICE_PARAM_PRESETS: Record<
    DeviceSlot['effectType'],
    Array<Omit<PluginParam, 'value'> & { value: number }>
> = {
    eq: [
        { name: 'LowFreq', value: 120, min: 20, max: 1200, suffix: 'Hz', step: 1 },
        { name: 'Low', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'LowQ', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'MidFreq', value: 1800, min: 120, max: 9000, suffix: 'Hz', step: 1 },
        { name: 'Mid', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'MidQ', value: 1.0, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'HighFreq', value: 9500, min: 1200, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'High', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'HighQ', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'Out', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
    ],
    compressor: [
        { name: 'Thr', value: -18, min: -60, max: 0, suffix: 'dB', step: 0.1 },
        { name: 'Ratio', value: 4, min: 1, max: 20, suffix: ':1', step: 0.1 },
        { name: 'Atk', value: 10, min: 0.1, max: 200, suffix: 'ms', step: 0.1 },
        { name: 'Rel', value: 80, min: 10, max: 1000, suffix: 'ms', step: 1 },
    ],
    delay: [
        { name: 'Time', value: 280, min: 1, max: 2000, suffix: 'ms', step: 1 },
        { name: 'Fb', value: 30, min: 0, max: 95, suffix: '%', step: 1 },
        { name: 'Dry/Wet', value: 35, min: 0, max: 100, suffix: '%', step: 1 },
    ],
    reverb: [
        { name: 'Decay', value: 45, min: 0, max: 100, suffix: '%', step: 1 },
        { name: 'Tone', value: 0, min: -100, max: 100, suffix: '%', step: 1 },
        { name: 'Dry/Wet', value: 22, min: 0, max: 100, suffix: '%', step: 1 },
    ],
    chorus: [
        { name: 'Rate', value: 1.2, min: 0.1, max: 10, suffix: 'Hz', step: 0.1 },
        { name: 'Depth', value: 40, min: 0, max: 100, suffix: '%', step: 1 },
        { name: 'Mix', value: 35, min: 0, max: 100, suffix: '%', step: 1 },
    ],
    utility: [
        { name: 'Gain', value: 0, min: -30, max: 30, suffix: 'dB', step: 0.1 },
        { name: 'Pan', value: 0, min: -100, max: 100, suffix: '%', step: 1 },
        { name: 'Width', value: 100, min: 0, max: 200, suffix: '%', step: 1 },
        { name: 'Mono', value: 0, min: 0, max: 1, suffix: '', step: 1 },
    ],
    vst: [],
    instrument: [
        { name: 'Gain', value: 0, min: -24, max: 12, suffix: 'dB', step: 0.1 },
        { name: 'Atk', value: 5, min: 0, max: 2000, suffix: 'ms', step: 1 },
        { name: 'Rel', value: 50, min: 0, max: 4000, suffix: 'ms', step: 1 },
    ],
    sampler: [
        { name: 'Vol', value: 1, min: 0, max: 2, suffix: '', step: 0.01 },
        { name: 'Attack', value: 0.005, min: 0.001, max: 2.0, suffix: 's', step: 0.001 },
        { name: 'Decay', value: 0.1, min: 0.001, max: 4.0, suffix: 's', step: 0.001 },
        { name: 'Sustain', value: 1.0, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Release', value: 0.05, min: 0.001, max: 8.0, suffix: 's', step: 0.001 },
        { name: 'Root', value: 60, min: 0, max: 127, suffix: '', step: 1 },
        { name: 'Cutoff', value: 20000, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'Res', value: 0, min: 0, max: 0.99, suffix: '', step: 0.01 },
        { name: 'FiltType', value: 0, min: 0, max: 3, suffix: '', step: 1 },
        { name: 'LfoRate', value: 1, min: 0.01, max: 20, suffix: 'Hz', step: 0.01 },
        { name: 'LfoDepth', value: 0, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'LfoTarget', value: 0, min: 0, max: 2, suffix: '', step: 1 },
    ],
    waveSynth: [
        { name: 'Osc1Wave', value: 0, min: 0, max: 3, suffix: '', step: 1 },
        { name: 'Osc2Wave', value: 0, min: 0, max: 3, suffix: '', step: 1 },
        { name: 'Mix', value: 0.35, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Detune', value: 0, min: -50, max: 50, suffix: 'ct', step: 0.1 },
        { name: 'Sub', value: 0, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Cutoff', value: 20000, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'Res', value: 0, min: 0, max: 0.99, suffix: '', step: 0.01 },
        { name: 'FiltType', value: 0, min: 0, max: 3, suffix: '', step: 1 },
        { name: 'LfoRate', value: 1, min: 0.01, max: 20, suffix: 'Hz', step: 0.01 },
        { name: 'LfoDepth', value: 0, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'LfoTarget', value: 0, min: 0, max: 2, suffix: '', step: 1 },
        { name: 'PulseWidth', value: 0.5, min: 0.05, max: 0.95, suffix: '', step: 0.01 },
        { name: 'Vol', value: 1, min: 0, max: 2, suffix: '', step: 0.01 },
        { name: 'Attack', value: 0.005, min: 0.001, max: 2.0, suffix: 's', step: 0.001 },
        { name: 'Decay', value: 0.1, min: 0.001, max: 4.0, suffix: 's', step: 0.001 },
        { name: 'Sustain', value: 1.0, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Release', value: 0.05, min: 0.001, max: 8.0, suffix: 's', step: 0.001 },
    ],
    saturator: [
        { name: 'Drive', value: 3, min: 0, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'Tone', value: 0, min: -100, max: 100, suffix: '%', step: 1 },
        { name: 'Mix', value: 100, min: 0, max: 100, suffix: '%', step: 1 },
    ],
    limiter: [
        { name: 'Thr', value: -0.3, min: -30, max: 0, suffix: 'dB', step: 0.1 },
        { name: 'Rel', value: 100, min: 1, max: 1000, suffix: 'ms', step: 1 },
        { name: 'Ceil', value: -0.1, min: -30, max: 0, suffix: 'dB', step: 0.1 },
    ],
    gate: [
        { name: 'Thr', value: -40, min: -80, max: 0, suffix: 'dB', step: 0.1 },
        { name: 'Atk', value: 0.1, min: 0.01, max: 100, suffix: 'ms', step: 0.01 },
        { name: 'Hold', value: 10, min: 0, max: 500, suffix: 'ms', step: 1 },
        { name: 'Rel', value: 50, min: 1, max: 2000, suffix: 'ms', step: 1 },
        { name: 'Range', value: -80, min: -80, max: 0, suffix: 'dB', step: 0.1 },
    ],
    autoFilter: [
        { name: 'Cutoff', value: 1000, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'Res', value: 0.3, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Rate', value: 1, min: 0.01, max: 20, suffix: 'Hz', step: 0.01 },
        { name: 'Depth', value: 0.5, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Env', value: 0, min: -1, max: 1, suffix: '', step: 0.01 },
        { name: 'Type', value: 0, min: 0, max: 3, suffix: '', step: 1 },
        { name: 'Mix', value: 1, min: 0, max: 1, suffix: '', step: 0.01 },
    ],
    autoPan: [
        { name: 'Rate', value: 1, min: 0.01, max: 20, suffix: 'Hz', step: 0.01 },
        { name: 'Depth', value: 70, min: 0, max: 100, suffix: '%', step: 1 },
        { name: 'Phase', value: 180, min: 0, max: 360, suffix: '°', step: 1 },
        { name: 'Shape', value: 0, min: 0, max: 4, suffix: '', step: 1 },
        { name: 'Mix', value: 100, min: 0, max: 100, suffix: '%', step: 1 },
    ],
    phaser: [
        { name: 'Rate', value: 0.5, min: 0.01, max: 10, suffix: 'Hz', step: 0.01 },
        { name: 'Depth', value: 0.6, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Fb', value: 0.5, min: -0.95, max: 0.95, suffix: '', step: 0.01 },
        { name: 'Stages', value: 4, min: 2, max: 8, suffix: '', step: 2 },
        { name: 'Center', value: 1000, min: 100, max: 5000, suffix: 'Hz', step: 1 },
        { name: 'Mix', value: 0.5, min: 0, max: 1, suffix: '', step: 0.01 },
    ],
    flanger: [
        { name: 'Rate', value: 0.3, min: 0.01, max: 10, suffix: 'Hz', step: 0.01 },
        { name: 'Depth', value: 0.7, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Fb', value: 0.5, min: -0.95, max: 0.95, suffix: '', step: 0.01 },
        { name: 'Delay', value: 2, min: 0.1, max: 10, suffix: 'ms', step: 0.1 },
        { name: 'Mix', value: 0.5, min: 0, max: 1, suffix: '', step: 0.01 },
    ],
    distortion: [
        { name: 'Drive', value: 30, min: 0, max: 100, suffix: '', step: 1 },
        { name: 'Tone', value: 0.5, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Mix', value: 1, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Mode', value: 0, min: 0, max: 3, suffix: '', step: 1 },
    ],
    bitcrusher: [
        { name: 'Bits', value: 16, min: 1, max: 32, suffix: '', step: 1 },
        { name: 'Down', value: 1, min: 1, max: 64, suffix: 'x', step: 1 },
        { name: 'Mix', value: 1, min: 0, max: 1, suffix: '', step: 0.01 },
    ],
    noiseMachine: [
        { name: 'Type', value: 0, min: 0, max: 4, suffix: '', step: 1 },
        { name: 'Level', value: -12, min: -60, max: 0, suffix: 'dB', step: 0.5 },
        { name: 'Stereo', value: 1, min: 0, max: 1, suffix: '', step: 1 },
        { name: 'LPFreq', value: 20000, min: 200, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'HPFreq', value: 20, min: 20, max: 5000, suffix: 'Hz', step: 1 },
        { name: 'Pan', value: 0, min: -100, max: 100, suffix: '%', step: 1 },
    ],
    spectrum: [],
    midiPitch: [{ name: 'Semitones', value: 0, min: -48, max: 48, suffix: 'st', step: 1 }],
    midiScale: [
        { name: 'Root', value: 0, min: 0, max: 11, suffix: '', step: 1 },
        { name: 'Mask', value: 4095, min: 1, max: 4095, suffix: '', step: 1 },
    ],
    midiVelocity: [
        { name: 'Gain', value: 1, min: 0, max: 4, suffix: 'x', step: 0.01 },
        { name: 'Offset', value: 0, min: -127, max: 127, suffix: '', step: 1 },
    ],
    midiRandom: [
        { name: 'Semitones', value: 0, min: -24, max: 24, suffix: 'st', step: 1 },
        { name: 'Chance', value: 1, min: 0, max: 1, suffix: '', step: 0.01 },
    ],
    rack: [],
};

// ── VU Meter Helpers ──────────────────────────────────────

/** Normalize a peak dB value (-60..0) to 0..1 for display. */
function vuNorm(peakDb: number): number {
    const minDb = -60;
    const maxDb = 0;
    const clamped = Math.max(minDb, Math.min(maxDb, peakDb));
    return (clamped - minDb) / (maxDb - minDb);
}

function normalizePickedPath(picked: unknown): string | null {
    const rawValue = Array.isArray(picked) ? picked[0] : picked;
    if (typeof rawValue !== 'string') return null;

    let normalized = rawValue.trim();
    if (!normalized) return null;

    if (normalized.startsWith('file://')) {
        try {
            const url = new URL(normalized);
            normalized = decodeURIComponent(url.pathname);
            if (/^\/[A-Za-z]:/.test(normalized)) {
                normalized = normalized.slice(1);
            }
        } catch {
            normalized = decodeURIComponent(normalized.replace(/^file:\/\//, ''));
        }
    }

    return normalized;
}

function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
        const maybeMessage = (err as { message?: unknown }).message;
        if (typeof maybeMessage === 'string') return maybeMessage;
    }
    return 'Unknown error';
}

function internalParamIdForControl(effectType: DeviceSlot['effectType'], controlName: string): string {
    const normalizedName = controlName.toLowerCase();
    if (effectType === 'utility') {
        if (normalizedName === 'gain') return 'plugin.gain';
        if (normalizedName === 'pan') return 'plugin.pan';
        if (normalizedName === 'width') return 'plugin.width';
        if (normalizedName === 'mono') return 'plugin.mono';
        return `utility.${normalizedName}`;
    }
    if (effectType === 'sampler' || effectType === 'instrument' || effectType === 'waveSynth') {
        if (normalizedName === 'vol') return 'sampler.volume';
        if (normalizedName === 'attack') return 'sampler.attack';
        if (normalizedName === 'decay') return 'sampler.decay';
        if (normalizedName === 'sustain') return 'sampler.sustain';
        if (normalizedName === 'release') return 'sampler.release';
        if (normalizedName === 'root') return 'sampler.rootNote';
        return `sampler.${normalizedName}`;
    }
    return `${effectType}.${normalizedName}`;
}

// ── Component ──────────────────────────────────────────

interface DeviceRackProps {
    selectedTrackId: string;
    onDropPluginToTrack?: (item: BrowserDragItem, trackId: string) => Promise<void>;
}

export const DeviceRack = ({
    selectedTrackId,
    onDropPluginToTrack,
}: DeviceRackProps) => {
    const [localBypass, setLocalBypass] = useState<Record<string, boolean>>({});
    const [localParams, setLocalParams] = useState<Record<string, number>>({});
    const [pluginCapability, setPluginCapability] = useState<
        Record<string, { supported: boolean; reason?: string }>
    >({});
    const [pluginRuntimeBySlot, setPluginRuntimeBySlot] = useState<Record<string, engineApi.PluginSlotRuntimeStatus>>({});
    const [externalParamsBySlotId, setExternalParamsBySlotId] = useState<Record<string, PluginParam[]>>({});
    const [inlineSettingsOpen, setInlineSettingsOpen] = useState<Record<string, boolean>>({});
    const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
    const [deviceSearch, setDeviceSearch] = useState('');
    const [deviceFilter, setDeviceFilter] = useState<'all' | 'instrument' | 'effect' | 'vst'>('all');
    const [paramSnapshotsByDevice, setParamSnapshotsByDevice] = useState<
        Record<string, { A?: Record<string, number>; B?: Record<string, number>; active?: 'A' | 'B' }>
    >({});
    const statusError = useStatusStore((s) => s.setError);
    const statusClear = useStatusStore((s) => s.clear);
    const throttledParamSendsRef = useRef<Map<string, (value: number, pushUndoStep: boolean) => void>>(new Map());
    const activeParamGesturesRef = useRef<Set<string>>(new Set());
    const pushedUndoForGestureRef = useRef<Set<string>>(new Set());
    const gestureGroupByParamKeyRef = useRef<Map<string, string>>(new Map());
    const projectTracks = useEngineStore((s) => s.projectTracks);
    const meters = useEngineStore((s) => s.meters);
    const fetchProject = useEngineStore((s) => s.fetchProject);
    const rackRef = useRef<HTMLDivElement>(null);
    const [isDropActive, setIsDropActive] = useState(false);
    const draggingItem = useDragStore((s) => s.draggingItem);

    // ── Automation context menu state ──
    const [autoCtxMenu, setAutoCtxMenu] = useState<{
        x: number;
        y: number;
        paramName: string;
        deviceId: string;
    } | null>(null);
    const addAutomationLane = useAutomationStore((s) => s.addLane);
    const removeAutomationLane = useAutomationStore((s) => s.removeLane);
    const automationLanes = useAutomationStore((s) => s.lanes);
    const toggleGlobalAutomation = useAutomationStore((s) => s.toggleGlobalVisible);

    const handleParamContextMenu = useCallback(
        (e: React.MouseEvent, paramName: string, deviceId: string) => {
            e.preventDefault();
            e.stopPropagation();
            setAutoCtxMenu({ x: e.clientX, y: e.clientY, paramName, deviceId });
        },
        [],
    );

    // Close context menu on click outside
    useEffect(() => {
        if (!autoCtxMenu) return;
        const close = () => setAutoCtxMenu(null);
        window.addEventListener('mousedown', close);
        return () => window.removeEventListener('mousedown', close);
    }, [autoCtxMenu]);

    // Find the track index for meter lookup
    const isMaster = selectedTrackId === 'master';
    const trackIndex = projectTracks.findIndex(
        (t) => t.id === selectedTrackId
    );

    // Get real-time meter levels for the selected track
    const inLevel = isMaster
        ? vuNorm(meters.master_left.peak)
        : trackIndex >= 0 && meters.tracks[trackIndex]
            ? vuNorm(meters.tracks[trackIndex][0].peak)
            : 0;

    const outLevel = isMaster
        ? vuNorm(meters.master_right.peak)
        : trackIndex >= 0 && meters.tracks[trackIndex]
            ? vuNorm(meters.tracks[trackIndex][1].peak)
            : 0;

    const trackName = isMaster
        ? 'Master'
        : trackIndex >= 0
            ? projectTracks[trackIndex].name
            : 'No Track';

    const masterProjectTrack = useMemo(
        () => projectTracks.find((t) => t.track_type === 'Master') ?? null,
        [projectTracks],
    );
    const selectedTrack = isMaster
        ? masterProjectTrack
        : (trackIndex >= 0 ? projectTracks[trackIndex] : null);
    const dropTargetTrack = selectedTrack;
    const dropTargetTrackRef = useRef<typeof dropTargetTrack>(dropTargetTrack);
    const onDropPluginToTrackRef = useRef(onDropPluginToTrack);
    const fetchProjectRef = useRef(fetchProject);
    const statusClearRef = useRef(statusClear);
    const statusErrorRef = useRef(statusError);
    const sidechainOptions = useMemo(
        () => projectTracks
            .filter((t) => t.id !== (selectedTrack?.id ?? ''))
            .map((t) => ({ id: t.id, name: t.name })),
        [projectTracks, selectedTrack?.id],
    );
    const staticLaneValueByParamId = useMemo(() => {
        const map = new Map<string, number>();
        const lanes = ((selectedTrack as unknown as { automation_lanes?: unknown[] } | null)?.automation_lanes) ?? [];
        for (const lane of lanes) {
            const paramId = String((lane as { param_id?: unknown }).param_id ?? '').trim();
            if (!paramId) continue;
            const points = ((lane as { points?: Array<{ value?: number }> }).points ?? []);
            if (points.length === 0) continue;
            const last = points[points.length - 1];
            const value = Number(last?.value ?? 0);
            if (Number.isFinite(value)) map.set(paramId.toLowerCase(), value);
        }
        return map;
    }, [selectedTrack]);

    useEffect(() => {
        dropTargetTrackRef.current = dropTargetTrack;
    }, [dropTargetTrack]);

    useEffect(() => {
        onDropPluginToTrackRef.current = onDropPluginToTrack;
    }, [onDropPluginToTrack]);

    useEffect(() => {
        fetchProjectRef.current = fetchProject;
        statusClearRef.current = statusClear;
        statusErrorRef.current = statusError;
    }, [fetchProject, statusClear, statusError]);
    const chain = useMemo((): DeviceSlot[] => {
        if (!selectedTrack) return [];

        const nodes = [
            ...(selectedTrack.instrument ? [selectedTrack.instrument] : []),
            ...(selectedTrack.effects ?? []),
        ];

        type DeviceNodeShape = {
            id?: string;
            name?: string;
            plugin_id?: string;
            is_bypassed?: boolean;
            external_parameter_count?: number;
            sidechain_source_track_id?: string | null;
            supports_sidechain_input?: boolean | null;
            type?: string;
            rack_type?: string;
        };

        // Helper: convert a single DeviceNode to a DeviceSlot.
        const nodeToSlot = (node: (typeof nodes)[number]): DeviceSlot | null => {
            // Extract common fields based on node type (tagged union from Rust serde).
            const nodeShape = node as unknown as DeviceNodeShape;
            const nodeType = nodeShape.type;
            const isRack = nodeType === 'Rack';

            // For rack nodes, show as a rack container device.
            if (isRack) {
                const rackNode = nodeShape;
                const rackId = rackNode.id ?? '';
                return {
                    id: rackId,
                    name: rackNode.name ?? 'Device Rack',
                    effectType: 'rack' as DeviceSlot['effectType'],
                    isEnabled: !(localBypass[rackId] ?? rackNode.is_bypassed),
                    params: [],
                    vuLevel: outLevel,
                    pluginId: `rack://${rackNode.rack_type}/${rackId}`,
                    isVst: false,
                    source: 'internal',
                };
            }

            // Single plugin node — the PluginSlot fields are at the top level.
            const slot = nodeShape;
            const pluginId: string = slot.plugin_id || slot.id || '';
            const name: string = slot.name || '';
            const id: string = slot.id || '';
            const isBypassed: boolean = slot.is_bypassed ?? false;

            const pluginIdLower = normalizeInternalPluginId(pluginId.toLowerCase());
            const isVst = pluginIdLower.includes('vst3') || pluginIdLower.includes('.vst') || pluginIdLower.includes('vst');
            const isInternal = pluginIdLower.startsWith('internal://');
            const rawExternalParamCount = Math.max(0, Number(slot.external_parameter_count ?? 0) || 0);
            const externalParamCount = isVst
                ? (rawExternalParamCount > 0 ? rawExternalParamCount : 16)
                : 0;

            const normalized = `${name} ${pluginId}`.toLowerCase();
            let effectType: DeviceSlot['effectType'] =
                selectedTrack.instrument?.id === id ? 'instrument' : isVst ? 'vst' : 'utility';
            const internalDef = getInternalPluginById(pluginIdLower);
            const mappedInternalType = internalDef?.id ? INTERNAL_EFFECT_TYPE_BY_PLUGIN_ID[internalDef.id] : undefined;
            if (mappedInternalType) effectType = mappedInternalType;
            else if (normalized.includes('sampler')) effectType = 'sampler';
            else if (
                normalized.includes('eq')
                || normalized.includes('channel eq')
                || normalized.includes('band eq')
            ) effectType = 'eq';
            else if (
                normalized.includes('compressor')
                || normalized.includes('transient shaper')
                || normalized.includes('multiband dynamics')
            ) effectType = 'compressor';
            else if (
                normalized.includes('delay')
                || normalized.includes('echo')
                || normalized.includes('beat repeat')
                || normalized.includes('looper')
                || normalized.includes('spectral time')
            ) effectType = 'delay';
            else if (
                normalized.includes('reverb')
                || normalized.includes('corpus')
                || normalized.includes('resonators')
                || normalized.includes('spectral resonator')
            ) effectType = 'reverb';
            else if (normalized.includes('chorus')) effectType = 'chorus';
            else if (normalized.includes('saturator') || normalized.includes('drum buss') || normalized.includes('dynamic tube')) effectType = 'saturator';
            else if (normalized.includes('limiter')) effectType = 'limiter';
            else if (normalized.includes('gate')) effectType = 'gate';
            else if (normalized.includes('auto pan') || normalized.includes('auto-pan') || normalized.includes('autopan')) effectType = 'autoPan';
            else if (normalized.includes('auto filter') || normalized.includes('auto-filter') || normalized.includes('autofilter') || normalized.includes('vocoder')) effectType = 'autoFilter';
            else if (normalized.includes('phaser') || normalized.includes('phaser-flanger')) effectType = 'phaser';
            else if (normalized.includes('flanger')) effectType = 'flanger';
            else if (
                normalized.includes('distortion')
                || normalized.includes('amp')
                || normalized.includes('cabinet')
                || normalized.includes('overdrive')
                || normalized.includes('pedal')
                || normalized.includes('roar')
            ) effectType = 'distortion';
            else if (normalized.includes('bitcrusher') || normalized.includes('bit-crusher')) effectType = 'bitcrusher';
            else if (normalized.includes('noise-machine') || normalized.includes('noise machine') || normalized.includes('noisemachine')) effectType = 'noiseMachine';
            else if (normalized.includes('spectrum')) effectType = 'spectrum';
            else if (normalized.includes('internal://midi-fx/pitch') || normalized.includes('midipitch')) effectType = 'midiPitch';
            else if (normalized.includes('internal://midi-fx/scale') || normalized.includes('midiscale')) effectType = 'midiScale';
            else if (normalized.includes('internal://midi-fx/velocity') || normalized.includes('midivelocity')) effectType = 'midiVelocity';
            else if (normalized.includes('internal://midi-fx/random') || normalized.includes('midirandom')) effectType = 'midiRandom';
            else if (normalized.includes('arpeggiator')) effectType = 'midiRandom';
            else if (normalized.includes('chord')) effectType = 'midiScale';
            else if (normalized.includes('note length') || normalized.includes('cc control') || normalized.includes('expression control')) effectType = 'midiVelocity';
            else if (selectedTrack.instrument?.id === id && !isVst) effectType = 'instrument';

            const guiMode = internalDef?.id || effectType;

            const defaultParams = (DEVICE_PARAM_PRESETS[effectType] ?? []).map((template) => {
                const key = `${id}:${template.name}`;
                let backendValue = template.value;
                if ((effectType === 'sampler' || effectType === 'instrument' || effectType === 'waveSynth') && selectedTrack.sampler) {
                    const n = template.name.toLowerCase();
                    if (n === 'wave' || n === 'osc1wave') backendValue = waveformIndexFromSamplePath(selectedTrack.sampler.sample_path);
                    else if (n === 'osc2wave') backendValue = Math.max(0, Math.min(3, selectedTrack.sampler.osc2_waveform ?? 0));
                    else if (n === 'mix') backendValue = Math.max(0, Math.min(1, selectedTrack.sampler.osc_mix ?? 0.35));
                    else if (n === 'detune') backendValue = Math.max(-50, Math.min(50, selectedTrack.sampler.detune_cents ?? 0));
                    else if (n === 'sub') backendValue = Math.max(0, Math.min(1, selectedTrack.sampler.sub_level ?? 0));
                    else if (n === 'vol') backendValue = selectedTrack.sampler.volume;
                    else if (n === 'attack') backendValue = selectedTrack.sampler.attack;
                    else if (n === 'decay') backendValue = selectedTrack.sampler.decay;
                    else if (n === 'sustain') backendValue = selectedTrack.sampler.sustain;
                    else if (n === 'release') backendValue = selectedTrack.sampler.release;
                    else if (n === 'root') backendValue = selectedTrack.sampler.root_note;
                }
                if (!(effectType === 'sampler' || effectType === 'instrument' || effectType === 'waveSynth')) {
                    const baseParamId = internalParamIdForControl(effectType, template.name);
                    const scoped = `slot:${id}:${baseParamId}`.toLowerCase();
                    const unscoped = baseParamId.toLowerCase();
                    const fromLane = staticLaneValueByParamId.get(scoped) ?? staticLaneValueByParamId.get(unscoped);
                    if (fromLane != null) backendValue = fromLane;
                }
                return {
                    ...template,
                    value: localParams[key] ?? backendValue,
                };
            });
            const cachedExternalParams = isVst ? (externalParamsBySlotId[id] ?? []) : [];
            const vstParamsFromHost = cachedExternalParams.length > 0
                ? cachedExternalParams.map((p) => {
                    const key = `${id}:${p.name}`;
                    return {
                        ...p,
                        value: localParams[key] ?? p.value,
                    };
                })
                : [];
            const vstParamsFallback = isVst && externalParamCount > 0
                ? Array.from({ length: Math.min(32, externalParamCount) }, (_, idx) => {
                    const name = `Param ${idx + 1}`;
                    const key = `${id}:${name}`;
                    return {
                        name,
                        min: 0,
                        max: 1,
                        step: 0.001,
                        suffix: '',
                        value: localParams[key] ?? 0.5,
                    } as PluginParam;
                })
                : [];
            const vstParams = vstParamsFromHost.length > 0 ? vstParamsFromHost : vstParamsFallback;

            return {
                id,
                name,
                effectType,
                isEnabled: !(localBypass[id] ?? isBypassed),
                params: vstParams.length > 0 ? vstParams : defaultParams,
                vuLevel: outLevel,
                pluginId,
                isVst,
                source: isInternal ? 'internal' : isVst ? 'vst' : 'unknown',
                supportsSidechain: slot.supports_sidechain_input ?? (effectType === 'compressor' || effectType === 'gate'),
                sidechainSourceTrackId: slot.sidechain_source_track_id ?? null,
                guiMode,
                samplePath: effectType === 'sampler' || effectType === 'instrument' || effectType === 'waveSynth'
                    ? (selectedTrack.sampler?.sample_path ?? undefined)
                    : undefined,
            };
        };

        return nodes.map(nodeToSlot).filter((s): s is DeviceSlot => s !== null);
    }, [selectedTrack, localBypass, localParams, outLevel, externalParamsBySlotId, staticLaneValueByParamId]);

    const setPluginSidechainSource = useCallback(async (slotId: string, sourceTrackId: string) => {
        if (!selectedTrack) return;
        try {
            await engineApi.setPluginSidechainSource(selectedTrack.id, slotId, sourceTrackId || 'none');
            await fetchProject();
            statusClear();
        } catch (err) {
            console.error('[DeviceRack] setPluginSidechainSource failed:', err);
            statusError('Failed to set plugin sidechain source.');
        }
    }, [selectedTrack, fetchProject, statusClear, statusError]);

    const toggleDevice = useCallback((device: DeviceSlot) => {
        const currentBypassed = localBypass[device.id] ?? !device.isEnabled;
        const nextBypassed = !currentBypassed;
        setLocalBypass((prev) => ({ ...prev, [device.id]: nextBypassed }));

        // Internal effects are processed by runtime device chain -> keep bypass in sync.
        if (!selectedTrack || device.source !== 'internal') return;
        const trackIdx = projectTracks.findIndex((t) => t.id === selectedTrack.id);
        const slotIdx = selectedTrack.effects.findIndex((fx) => fx.id === device.id);
        if (trackIdx < 0 || slotIdx < 0) return;
        void engineApi.bypassDevice(trackIdx, slotIdx, nextBypassed).catch((err) => {
            console.error('[DeviceRack] bypassDevice failed:', err);
        });
    }, [localBypass, selectedTrack, projectTracks]);

    const setPluginParam = useCallback((deviceId: string, paramName: string, value: number) => {
        setLocalParams((prev) => ({ ...prev, [`${deviceId}:${paramName}`]: value }));
    }, []);

    const sendInternalParam = useCallback(
        (
            device: DeviceSlot,
            paramName: string,
            value: number,
            options?: { gestureKey?: string; forcePushUndo?: boolean },
        ) => {
            if (!selectedTrack) return;
            if (device.source === 'vst') {
                const idxFromList = device.params.findIndex((p) => p.name === paramName);
                const idxFromName = (() => {
                    const m = paramName.match(/(\d+)/);
                    return m ? Number.parseInt(m[1], 10) : -1;
                })();
                const paramIndex = idxFromList >= 0 ? idxFromList : idxFromName;
                if (paramIndex < 0 || !Number.isFinite(paramIndex)) return;

                const paramDef = idxFromList >= 0 ? device.params[idxFromList] : null;
                const normalized = paramDef
                    ? (value - paramDef.min) / Math.max(1e-9, paramDef.max - paramDef.min)
                    : value;
                const clamped = Math.min(1, Math.max(0, normalized));
                void engineApi.setExternalPluginParamForSlot(selectedTrack.id, device.id, paramIndex, clamped).catch((err) => {
                    console.error('[DeviceRack] setExternalPluginParam failed:', err);
                    statusError(`External plugin parameter update failed: ${errorMessage(err)}`);
                });
                return;
            }

            const trackIdx = projectTracks.findIndex((t) => t.id === selectedTrack.id);
            const effectSlotIdx = selectedTrack.effects.findIndex((fx) => fx.id === device.id);
            const pushPluginParam = (paramIndex: number, paramValue: number) => {
                if (trackIdx < 0 || effectSlotIdx < 0) return;
                void engineApi.setDeviceParam(trackIdx, effectSlotIdx, paramIndex, paramValue).catch((err) => {
                    console.error('[DeviceRack] setDeviceParam failed:', err);
                });
            };

            // Runtime DSP path for built-in effects — this is the audible path.
            if (device.source === 'internal') {
                const effectMap = RUNTIME_PARAM_INDEX_BY_EFFECT[device.effectType];
                if (effectMap) {
                    const key = paramName.toLowerCase();
                    const index = effectMap[key];
                    if (index != null) {
                        pushPluginParam(index, value);
                    }
                }
            }

            const paramId = internalParamIdForControl(device.effectType, paramName);

            const scopedParamId = `slot:${device.id}:${paramId}`;
            const key = `${selectedTrack.id}:${device.id}:${scopedParamId}`;
            const effectiveGestureKey = options?.gestureKey
                ? (gestureGroupByParamKeyRef.current.get(options.gestureKey) ?? options.gestureKey)
                : undefined;
            let pushUndoStep = options?.forcePushUndo ?? false;
            if (!options?.forcePushUndo) {
                if (!effectiveGestureKey) {
                    pushUndoStep = true;
                } else if (!pushedUndoForGestureRef.current.has(effectiveGestureKey)) {
                    pushedUndoForGestureRef.current.add(effectiveGestureKey);
                    pushUndoStep = true;
                }
            }

            let sender = throttledParamSendsRef.current.get(key);
            if (!sender) {
                sender = throttle((v: number, pushUndo: boolean) => {
                    void engineApi.setInternalPluginParam(
                        selectedTrack.id,
                        device.id,
                        scopedParamId,
                        v,
                        { pushUndoStep: pushUndo },
                    ).catch((err) => {
                        console.error('[DeviceRack] setInternalPluginParam failed:', err);
                    });
                }, 32);
                throttledParamSendsRef.current.set(key, sender);
            }
            sender(value, pushUndoStep);
        },
        [selectedTrack, projectTracks, statusError],
    );

    const beginParamGesture = useCallback((deviceId: string, paramName: string, gestureGroupId?: string) => {
        if (!selectedTrack) return;
        const gestureKey = `${selectedTrack.id}:${deviceId}:${paramName.toLowerCase()}`;
        activeParamGesturesRef.current.add(gestureKey);
        pushedUndoForGestureRef.current.delete(gestureKey);
        if (gestureGroupId) {
            gestureGroupByParamKeyRef.current.set(gestureKey, gestureGroupId);
            pushedUndoForGestureRef.current.delete(gestureGroupId);
        }
    }, [selectedTrack]);

    const endParamGesture = useCallback((deviceId: string, paramName: string) => {
        if (!selectedTrack) return;
        const gestureKey = `${selectedTrack.id}:${deviceId}:${paramName.toLowerCase()}`;
        const gestureGroupId = gestureGroupByParamKeyRef.current.get(gestureKey);
        activeParamGesturesRef.current.delete(gestureKey);
        pushedUndoForGestureRef.current.delete(gestureKey);
        if (gestureGroupId) {
            pushedUndoForGestureRef.current.delete(gestureGroupId);
            gestureGroupByParamKeyRef.current.delete(gestureKey);
        }
    }, [selectedTrack]);

    const applyParamBatch = useCallback((
        device: DeviceSlot,
        entries: Array<{ paramName: string; value: number }>,
    ) => {
        if (!selectedTrack || entries.length === 0) return;
        const byName = new Map(device.params.map((p) => [p.name.toLowerCase(), p]));
        const normalizedEntries = entries.map((entry) => {
            const def = byName.get(entry.paramName.toLowerCase());
            return {
                paramName: def?.name ?? entry.paramName,
                value: def ? clampAndSnapParamValue(def, entry.value) : entry.value,
            };
        });
        setLocalParams((prev) => {
            const next = { ...prev };
            for (const entry of normalizedEntries) {
                next[`${device.id}:${entry.paramName}`] = entry.value;
            }
            return next;
        });
        normalizedEntries.forEach((entry, idx) => {
            sendInternalParam(device, entry.paramName, entry.value, { forcePushUndo: idx === 0 });
        });
    }, [selectedTrack, sendInternalParam]);

    const storeParamSnapshot = useCallback((device: DeviceSlot, slot: 'A' | 'B') => {
        const snapshot: Record<string, number> = {};
        for (const p of device.params) snapshot[p.name] = p.value;
        setParamSnapshotsByDevice((prev) => ({
            ...prev,
            [device.id]: {
                ...(prev[device.id] ?? {}),
                [slot]: snapshot,
                active: slot,
            },
        }));
    }, []);

    const recallParamSnapshot = useCallback((device: DeviceSlot, slot: 'A' | 'B') => {
        const snapshot = paramSnapshotsByDevice[device.id]?.[slot];
        if (!snapshot) return;
        const entries = Object.entries(snapshot).map(([paramName, value]) => ({ paramName, value }));
        applyParamBatch(device, entries);
        setParamSnapshotsByDevice((prev) => ({
            ...prev,
            [device.id]: {
                ...(prev[device.id] ?? {}),
                active: slot,
            },
        }));
    }, [applyParamBatch, paramSnapshotsByDevice]);

    const toggleParamSnapshot = useCallback((device: DeviceSlot) => {
        const state = paramSnapshotsByDevice[device.id];
        if (!state?.A || !state?.B) return;
        const next: 'A' | 'B' = state.active === 'A' ? 'B' : 'A';
        recallParamSnapshot(device, next);
    }, [paramSnapshotsByDevice, recallParamSnapshot]);

    const applyQuickPreset = useCallback((device: DeviceSlot, preset: QuickPreset) => {
        const entries = resolveQuickPresetParams(device, preset);
        applyParamBatch(device, entries);
    }, [applyParamBatch]);

    const randomizeInternalPluginParams = useCallback((device: DeviceSlot) => {
        const entries = device.params.map((param) => ({ paramName: param.name, value: randomParamValue(param) }));
        applyParamBatch(device, entries);
    }, [applyParamBatch]);

    const resetInternalPluginParams = useCallback((device: DeviceSlot) => {
        const entries = device.params.map((param) => ({ paramName: param.name, value: defaultParamForReset(param) }));
        applyParamBatch(device, entries);
    }, [applyParamBatch]);

    const applyQuickUtilityScene = useCallback((device: DeviceSlot, scene: 'center' | 'mono' | 'wide') => {
        if (device.effectType !== 'utility') return;
        const values = scene === 'mono'
            ? [
                { paramName: 'Pan', value: 0 },
                { paramName: 'Width', value: 0 },
                { paramName: 'Mono', value: 1 },
            ]
            : scene === 'wide'
                ? [
                    { paramName: 'Pan', value: 0 },
                    { paramName: 'Width', value: 150 },
                    { paramName: 'Mono', value: 0 },
                ]
                : [
                    { paramName: 'Pan', value: 0 },
                    { paramName: 'Width', value: 100 },
                    { paramName: 'Mono', value: 0 },
                ];
        applyParamBatch(device, values);
    }, [applyParamBatch]);

    useEffect(() => {
        setSelectedDeviceIds((prev) => prev.filter((id) => chain.some((d) => d.id === id)));
        setInlineSettingsOpen((prev) => {
            const next: Record<string, boolean> = {};
            const ids = new Set(chain.map((d) => d.id));
            for (const [id, isOpen] of Object.entries(prev)) {
                if (ids.has(id) && isOpen) next[id] = true;
            }
            return next;
        });
    }, [chain]);

    useEffect(() => {
        activeParamGesturesRef.current.clear();
        pushedUndoForGestureRef.current.clear();
        gestureGroupByParamKeyRef.current.clear();
    }, [selectedTrackId]);

    useEffect(() => {
        setSelectedDeviceIds([]);
    }, [selectedTrackId]);

    useEffect(() => {
        const onKeyDown = async (e: KeyboardEvent) => {
            if ((e.key !== 'Delete' && e.key !== 'Backspace') || selectedDeviceIds.length === 0) return;
            const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable) return;
            if (!selectedTrack) return;
            e.preventDefault();
            try {
                for (const deviceId of selectedDeviceIds) {
                    await engineApi.removePluginFromTrack(selectedTrack.id, deviceId);
                }
                setInlineSettingsOpen((prev) => {
                    const next = { ...prev };
                    for (const deviceId of selectedDeviceIds) {
                        delete next[deviceId];
                    }
                    return next;
                });
                setSelectedDeviceIds([]);
                await fetchProject();
                statusClear();
            } catch (err) {
                console.error('[DeviceRack] removePluginFromTrack failed:', err);
                statusError('Failed to remove plugin from track.');
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [selectedDeviceIds, selectedTrack, fetchProject, statusClear, statusError]);

    useEffect(() => {
        let cancelled = false;
        const vstDevices = chain.filter((d) => d.isVst);
        if (!selectedTrack) {
            return;
        }
        const missing = vstDevices.filter((d) => pluginCapability[d.id] == null);
        if (missing.length === 0) {
            return;
        }

        (async () => {
            const results = await Promise.all(
                missing.map(async (device) => {
                    try {
                        const cap = await engineApi.canOpenPluginEditorForSlot(selectedTrack.id, device.id);
                        return [device.id, { supported: cap.supported, reason: cap.reason ?? undefined }] as const;
                    } catch (err) {
                        console.error('[DeviceRack] Capability probe failed:', err);
                        return [device.id, { supported: false, reason: 'Capability check failed.' }] as const;
                    }
                })
            );

            if (cancelled) {
                return;
            }
            setPluginCapability((prev) => {
                const next = { ...prev };
                for (const [id, cap] of results) {
                    next[id] = cap;
                }
                return next;
            });
        })();

        return () => {
            cancelled = true;
        };
    }, [chain, pluginCapability, selectedTrack]);

    useEffect(() => {
        let cancelled = false;
        if (!selectedTrack) return;

        const targets = chain.filter((d) => d.isVst);
        if (targets.length === 0) return;

        (async () => {
            const entries = await Promise.all(
                targets.map(async (device) => {
                    try {
                        const status = await engineApi.getPluginSlotRuntimeStatus(selectedTrack.id, device.id);
                        return [device.id, status] as const;
                    } catch (err) {
                        console.error('[DeviceRack] getPluginSlotRuntimeStatus failed:', err);
                        return [device.id, {
                            loaded: false,
                            editorSupported: true,
                            runtime: 'unknown',
                            sidechainReady: false,
                            message: 'Runtime status unavailable',
                        } as engineApi.PluginSlotRuntimeStatus] as const;
                    }
                }),
            );

            if (cancelled) return;
            setPluginRuntimeBySlot((prev) => {
                const next = { ...prev };
                for (const [slotId, status] of entries) {
                    next[slotId] = status;
                }
                return next;
            });
        })();

        return () => {
            cancelled = true;
        };
    }, [chain, selectedTrack]);

    useEffect(() => {
        let cancelled = false;
        if (!selectedTrack) return;

        const vstDevices = chain.filter((d) => d.isVst);
        const missing = vstDevices.filter((d) => !externalParamsBySlotId[d.id]);
        if (missing.length === 0) return;

        (async () => {
            const results = await Promise.all(
                missing.map(async (device) => {
                    try {
                        const params = await engineApi.getExternalPluginParamsForSlot(selectedTrack.id, device.id);
                        const mapped: PluginParam[] = params.map((p) => ({
                            name: p.name,
                            min: p.min,
                            max: p.max,
                            step: p.step,
                            suffix: '',
                            value: p.value,
                        }));
                        return [device.id, mapped] as const;
                    } catch (err) {
                        console.error('[DeviceRack] getExternalPluginParamsForSlot failed:', err);
                        return [device.id, [] as PluginParam[]] as const;
                    }
                }),
            );

            if (cancelled) return;
            setExternalParamsBySlotId((prev) => {
                const next = { ...prev };
                for (const [slotId, params] of results) {
                    next[slotId] = params;
                }
                return next;
            });
        })();

        return () => {
            cancelled = true;
        };
    }, [chain, selectedTrack, externalParamsBySlotId]);

    useEffect(() => {
        const aliveVstSlotIds = new Set(chain.filter((d) => d.isVst).map((d) => d.id));
        setExternalParamsBySlotId((prev) => {
            const next: Record<string, PluginParam[]> = {};
            let changed = false;
            for (const [slotId, params] of Object.entries(prev)) {
                if (aliveVstSlotIds.has(slotId)) next[slotId] = params;
                else changed = true;
            }
            return changed ? next : prev;
        });
    }, [chain]);

    useEffect(() => {
        const onMouseMove = (e: MouseEvent) => {
            const dragging = useDragStore.getState().draggingItem;
            const targetTrack = dropTargetTrackRef.current;
            if (!dragging || !targetTrack || !canDropInZone(dragging, 'device-rack').allowed) {
                setIsDropActive(false);
                return;
            }
            const rect = rackRef.current?.getBoundingClientRect();
            if (!rect) return;
            const inside =
                e.clientX >= rect.left &&
                e.clientX <= rect.right &&
                e.clientY >= rect.top &&
                e.clientY <= rect.bottom;
            setIsDropActive(inside);
        };

        const onMouseUp = async (e: MouseEvent) => {
            const dragging = useDragStore.getState().draggingItem;
            const targetTrack = dropTargetTrackRef.current;
            if (!dragging || !targetTrack || !canDropInZone(dragging, 'device-rack').allowed) return;
            const rect = rackRef.current?.getBoundingClientRect();
            if (!rect) return;
            const inside =
                e.clientX >= rect.left &&
                e.clientX <= rect.right &&
                e.clientY >= rect.top &&
                e.clientY <= rect.bottom;
            if (!inside) {
                setIsDropActive(false);
                return;
            }

            try {
                const dropHandler = onDropPluginToTrackRef.current;
                if (dropHandler) {
                    await dropHandler(dragging, targetTrack.id);
                } else {
                    const hint = dragging.slotHint ?? 'auto';
                    const slot: 'instrument' | 'effect' =
                        hint === 'instrument'
                            ? 'instrument'
                            : hint === 'effect'
                                ? 'effect'
                                : targetTrack.track_type === 'Midi' && !targetTrack.instrument
                                    ? 'instrument'
                                    : 'effect';
                    await engineApi.addPluginToTrack(
                        targetTrack.id,
                        dragging.path,
                        dragging.name,
                        slot,
                    );
                    await fetchProjectRef.current();
                }
                statusClearRef.current();
            } catch (err) {
                console.error('[DeviceRack] addPluginToTrack failed:', err);
                statusErrorRef.current('Failed to add plugin to track.');
            } finally {
                useDragStore.getState().endDrag();
                setIsDropActive(false);
            }
        };

        window.addEventListener('mousemove', onMouseMove, true);
        window.addEventListener('mouseup', onMouseUp, true);
        return () => {
            window.removeEventListener('mousemove', onMouseMove, true);
            window.removeEventListener('mouseup', onMouseUp, true);
        };
    }, []);

    const selectDevice = useCallback((deviceId: string, additive: boolean) => {
        setSelectedDeviceIds((prev) => {
            if (!additive) return [deviceId];
            return prev.includes(deviceId)
                ? prev.filter((id) => id !== deviceId)
                : [...prev, deviceId];
        });
    }, []);

    const visibleChain = useMemo(() => {
        const query = deviceSearch.trim().toLowerCase();
        return chain.filter((d) => {
            const isInstrument = d.effectType === 'instrument' || d.effectType === 'sampler' || d.effectType === 'waveSynth';
            if (deviceFilter === 'vst' && !d.isVst) return false;
            if (deviceFilter === 'instrument' && !isInstrument) return false;
            if (deviceFilter === 'effect' && isInstrument) return false;
            if (!query) return true;
            return (
                d.name.toLowerCase().includes(query)
                || d.effectType.toLowerCase().includes(query)
                || d.pluginId.toLowerCase().includes(query)
            );
        });
    }, [chain, deviceSearch, deviceFilter]);

    const setBypassSelected = useCallback((enabled: boolean) => {
        const selectedSet = new Set(selectedDeviceIds);
        chain
            .filter((d) => selectedSet.has(d.id))
            .forEach((d) => {
                if (d.isEnabled !== enabled) {
                    toggleDevice(d);
                }
            });
    }, [chain, selectedDeviceIds, toggleDevice]);

    const rackContent = (
        <>
            <div
                ref={rackRef}
                tabIndex={0}
                data-keyboard-scope="device-rack"
                data-selected-device-id={selectedDeviceIds[0] ?? ''}
                onMouseDown={() => rackRef.current?.focus()}
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    height: '100%',
                    background: 'var(--color-bg-panel)',
                    position: 'relative',
                    outline: isDropActive ? '2px solid var(--color-accent-primary)' : 'none',
                    boxShadow: isDropActive ? 'inset 0 0 0 1px color-mix(in srgb, var(--color-accent-primary) 35%, transparent)' : 'none',
                }}>

                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    padding: '6px 10px',
                    borderBottom: '1px solid var(--color-divider)',
                    background: 'var(--color-bg-header)',
                    flexShrink: 0,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                        <span style={{
                            fontSize: 'var(--font-size-2xs)',
                            fontWeight: 600,
                            color: 'var(--color-text-secondary)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                        }}>
                            {trackName} - Instrument & Effects Chain - {visibleChain.length}/{chain.length}
                        </span>
                        <div style={{ display: 'flex', gap: 6 }}>
                            <button onClick={() => setBypassSelected(true)} style={headerIconBtnStyle(selectedDeviceIds.length === 0)} disabled={selectedDeviceIds.length === 0}>On</button>
                            <button onClick={() => setBypassSelected(false)} style={headerIconBtnStyle(selectedDeviceIds.length === 0)} disabled={selectedDeviceIds.length === 0}>Byp</button>
                            <button onClick={() => setInlineSettingsOpen({})} style={headerIconBtnStyle(false)}>Fold</button>
                        </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                        <input
                            value={deviceSearch}
                            onChange={(e) => setDeviceSearch(e.target.value)}
                            placeholder="Search plugins..."
                            style={{
                                flex: 1,
                                minWidth: 120,
                                height: 22,
                                borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--color-divider)',
                                background: 'var(--color-bg-panel)',
                                color: 'var(--color-text-primary)',
                                fontSize: 'var(--font-size-2xs)',
                                padding: '0 8px',
                                outline: 'none',
                            }}
                        />
                        {(['all', 'instrument', 'effect', 'vst'] as const).map((f) => (
                            <button
                                key={f}
                                onClick={() => setDeviceFilter(f)}
                                style={headerIconBtnStyle(false, deviceFilter === f)}
                            >
                                {f === 'all' ? 'All' : f === 'instrument' ? 'Inst' : f === 'effect' ? 'FX' : 'VST'}
                            </button>
                        ))}
                    </div>
                </div>

                {/* ── Device Chain (horizontal scroll) ── */}
                <div className="scrollbar-hide" style={{
                    display: 'flex',
                    alignItems: 'stretch',
                    gap: 6,
                    padding: '8px 10px',
                    flex: 1,
                    minHeight: 0,
                    overflowX: 'auto',
                    overflowY: 'hidden',
                }}>

                    {/* Input meter — real data */}
                    <MeterBar level={inLevel} isInput />

                    {/* Device slots */}
                    {visibleChain.length > 0 ? (
                        visibleChain.map((device, idx) => (
                            <Fragment key={device.id}>
                                <DeviceNode
                                    order={idx + 1}
                                    device={device}
                                    isSelected={selectedDeviceIds.includes(device.id)}
                                    editorSupported={pluginCapability[device.id]?.supported ?? true}
                                    editorReason={pluginCapability[device.id]?.reason}
                                    runtimeStatus={pluginRuntimeBySlot[device.id]}
                                    onToggle={() => toggleDevice(device)}
                                    onSelect={(e) => {
                                        selectDevice(device.id, e.shiftKey);
                                        rackRef.current?.focus();
                                        statusClear();
                                    }}
                                    onOpenSettings={() => {
                                        if (device.source === 'internal' && device.effectType === 'utility') {
                                            selectDevice(device.id, false);
                                            statusClear();
                                            return;
                                        }
                                        selectDevice(device.id, false);
                                        setInlineSettingsOpen((prev) => ({
                                            ...prev,
                                            [device.id]: !prev[device.id],
                                        }));
                                        statusClear();
                                    }}
                                    onParamChange={(name, value) => {
                                        setPluginParam(device.id, name, value);
                                        const gestureKey = selectedTrack
                                            ? `${selectedTrack.id}:${device.id}:${name.toLowerCase()}`
                                            : null;
                                        sendInternalParam(device, name, value, {
                                            gestureKey: gestureKey && activeParamGesturesRef.current.has(gestureKey)
                                                ? gestureKey
                                                : undefined,
                                        });
                                    }}
                                    onParamGestureStart={(paramName) => beginParamGesture(device.id, paramName)}
                                    onParamGestureEnd={(paramName) => endParamGesture(device.id, paramName)}
                                    onApplyQuickPreset={(preset) => applyQuickPreset(device, preset)}
                                    onRandomize={() => randomizeInternalPluginParams(device)}
                                    onReset={() => resetInternalPluginParams(device)}
                                    onStoreSnapshot={(slot) => storeParamSnapshot(device, slot)}
                                    onRecallSnapshot={(slot) => recallParamSnapshot(device, slot)}
                                    onToggleSnapshot={() => toggleParamSnapshot(device)}
                                    snapshotState={paramSnapshotsByDevice[device.id]}
                                    onApplyUtilityScene={(scene) => applyQuickUtilityScene(device, scene)}
                                    onParamContextMenu={(e, paramName) => handleParamContextMenu(e, paramName, device.id)}
                                    showSettings={device.effectType === 'utility' ? false : !!inlineSettingsOpen[device.id]}
                                    sidechainSourceTrackId={device.sidechainSourceTrackId ?? 'none'}
                                    sidechainOptions={sidechainOptions}
                                    onSidechainSourceChange={(sourceTrackId) => {
                                        void setPluginSidechainSource(device.id, sourceTrackId);
                                    }}
                                    onEnsureActive={async () => {
                                        if (!selectedTrack) return;
                                        const known = pluginRuntimeBySlot[device.id];
                                        if (known?.runtime === 'unsupported') {
                                            statusError(known.message ?? 'This plugin format is not supported by runtime in this build.');
                                            return;
                                        }
                                        try {
                                            await engineApi.ensurePluginSlotActive(selectedTrack.id, device.id);
                                            const status = await engineApi.getPluginSlotRuntimeStatus(selectedTrack.id, device.id);
                                            setPluginRuntimeBySlot((prev) => ({ ...prev, [device.id]: status }));
                                            statusClear();
                                        } catch (err) {
                                            console.error('[DeviceRack] ensurePluginSlotActive failed:', err);
                                            statusError(`Failed to activate plugin: ${errorMessage(err)}`);
                                        }
                                    }}
                                    onDropSample={async (samplePath) => {
                                        if (!selectedTrack) return;
                                        try {
                                            const normalizedPath = normalizePickedPath(samplePath);
                                            if (!normalizedPath) {
                                                statusError('Failed to load sampler sample: invalid file path.');
                                                return;
                                            }
                                            await engineApi.setSamplerSample(selectedTrack.id, normalizedPath);
                                            selectDevice(device.id, false);
                                            statusClear();
                                            await fetchProject();
                                        } catch (err) {
                                            console.error('[DeviceRack] sampler device drop failed:', err);
                                            statusError(`Failed to load sampler sample: ${errorMessage(err)}`);
                                        }
                                    }}
                                    onLoadSample={async () => {
                                        if (!selectedTrack) return;
                                        try {
                                            const { open } = await import('@tauri-apps/plugin-dialog');
                                            const picked = await open({
                                                multiple: false,
                                                title: 'Load Sampler Sample',
                                                filters: [{ name: 'Audio', extensions: ['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg', 'm4a', 'aac'] }],
                                            });
                                            const normalizedPath = normalizePickedPath(picked);
                                            if (normalizedPath) {
                                                await engineApi.setSamplerSample(selectedTrack.id, normalizedPath);
                                                statusClear();
                                                await fetchProject();
                                            }
                                        } catch (err) {
                                            console.error('[DeviceRack] setSamplerSample failed:', err);
                                            statusError(`Failed to load sampler sample: ${errorMessage(err)}`);
                                        }
                                    }}
                                    onOpenGUI={async () => {
                                        selectDevice(device.id, false);
                                        if (device.source === 'internal') {
                                            setInlineSettingsOpen((prev) => ({
                                                ...prev,
                                                [device.id]: !prev[device.id],
                                            }));
                                            statusClear();
                                            return;
                                        }
                                        if (!selectedTrack) return;
                                        const known = pluginRuntimeBySlot[device.id];
                                        if (known?.runtime === 'unsupported') {
                                            statusError(known.message ?? 'This plugin format is not supported by runtime in this build.');
                                            return;
                                        }
                                        try {
                                            await engineApi.ensurePluginSlotActive(selectedTrack.id, device.id);
                                            const status = await engineApi.getPluginSlotRuntimeStatus(selectedTrack.id, device.id);
                                            setPluginRuntimeBySlot((prev) => ({ ...prev, [device.id]: status }));
                                            setInlineSettingsOpen((prev) => ({
                                                ...prev,
                                                [device.id]: !prev[device.id],
                                            }));
                                            statusClear();
                                        } catch (err) {
                                            console.error('[DeviceRack] Failed to activate inline plugin view:', err);
                                            statusError(`Plugin activation failed: ${errorMessage(err)}`);
                                        }
                                    }}
                                />
                                <MeterBar level={device.vuLevel} />
                            </Fragment>
                        ))
                    ) : (
                        /* ── Empty State ── */
                        <div style={{
                            flex: 1,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 8,
                            minHeight: 80,
                            color: 'var(--color-text-tertiary)',
                        }}>
                            <span style={{
                                fontSize: 'var(--font-size-2xl)',
                                opacity: 0.3,
                            }}>♪</span>
                            <span style={{
                                fontSize: 'var(--font-size-xs)',
                                fontWeight: 500,
                                letterSpacing: '0.03em',
                            }}>
                                {chain.length > 0 ? 'No plugins match current filter' : 'Drop Files and Devices Here'}
                            </span>
                        </div>
                    )}

                    {/* Add device button */}
                    <button
                        onClick={() => {
                            window.dispatchEvent(new CustomEvent('dream:browser-focus-search', {
                                detail: { categoryId: 'plugins' },
                            }));
                            statusClear();
                        }}
                        style={{
                            width: 64,
                            minWidth: 64,
                            height: '100%',
                            minHeight: 100,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 6,
                            background: 'transparent',
                            border: '1px dashed var(--color-border-subtle)',
                            borderRadius: 'var(--radius-sm)',
                            cursor: 'pointer',
                            color: 'var(--color-text-tertiary)',
                            fontSize: 'var(--font-size-2xs)',
                            fontWeight: 500,
                            flexShrink: 0,
                            transition: 'all var(--transition-fast)',
                        }}
                        onMouseEnter={e => {
                            e.currentTarget.style.borderColor = 'var(--color-accent-primary)';
                            e.currentTarget.style.color = 'var(--color-accent-primary)';
                        }}
                        onMouseLeave={e => {
                            e.currentTarget.style.borderColor = 'var(--color-border-subtle)';
                            e.currentTarget.style.color = 'var(--color-text-tertiary)';
                        }}
                    >
                        <span style={{ fontSize: 'var(--font-size-2xl)', lineHeight: 1 }}>+</span>
                        Add Device
                    </button>
                </div>

                {isDropActive && draggingItem?.type === 'plugin' && (
                    <div
                        style={{
                            position: 'absolute',
                            right: 10,
                            top: 10,
                            zIndex: 'var(--z-header)' as unknown as number,
                            border: '1px solid color-mix(in srgb, var(--color-accent-primary) 65%, #ffffff22)',
                            borderRadius: 'var(--radius-lg)',
                            padding: '5px 8px',
                            background: 'color-mix(in srgb, var(--color-bg-panel) 72%, var(--color-accent-primary) 28%)',
                            color: 'var(--color-text-primary)',
                            fontSize: 'var(--font-size-xs)',
                            fontWeight: 700,
                            letterSpacing: '0.03em',
                            pointerEvents: 'none',
                            textTransform: 'uppercase',
                        }}
                    >
                        Drop Plugin: {draggingItem.name}
                    </div>
                )}

            </div>
        </>
    );

    // ── Automation context menu popup ──
    const renderCtxMenuPopup = () => {
        if (!autoCtxMenu) return null;
        const existingLane = Object.values(automationLanes).find(
            (l) =>
                l.trackId === selectedTrackId &&
                l.paramKey === `${autoCtxMenu.deviceId}:${autoCtxMenu.paramName}`,
        );

        return (
            <div
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                    position: 'fixed',
                    left: autoCtxMenu.x,
                    top: autoCtxMenu.y,
                    zIndex: 'var(--z-menu)' as unknown as number,
                    background: 'var(--color-bg-elevated)',
                    border: '1px solid var(--color-divider)',
                    borderRadius: 'var(--radius-sm)',
                    padding: 4,
                    minWidth: 200,
                    boxShadow: '0 8px 24px var(--color-overlay-dark)',
                }}
            >
                <div
                    style={{
                        fontSize: 'var(--font-size-xs)',
                        color: 'var(--color-text-tertiary)',
                        padding: '4px 8px',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                    }}
                >
                    Automation: {autoCtxMenu.paramName}
                </div>
                {existingLane ? (
                    <button
                        onClick={() => {
                            removeAutomationLane(existingLane.id);
                            setAutoCtxMenu(null);
                        }}
                        style={autoCtxMenuItemStyle}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'var(--color-bg-hover)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                        }}
                    >
                        ✕ Remove Automation Lane
                    </button>
                ) : (
                    <button
                        onClick={() => {
                            addAutomationLane(
                                selectedTrackId,
                                autoCtxMenu.paramName,
                                `${autoCtxMenu.deviceId}:${autoCtxMenu.paramName}`,
                            );
                            // Ensure automation is visible
                            if (!useAutomationStore.getState().globalVisible) {
                                toggleGlobalAutomation();
                            }
                            setAutoCtxMenu(null);
                        }}
                        style={autoCtxMenuItemStyle}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'var(--color-bg-hover)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                        }}
                    >
                        ⊕ Add Automation Lane
                    </button>
                )}
            </div>
        );
    };

    return (
        <>
            {rackContent}
            {renderCtxMenuPopup()}
        </>
    );
};

// ── DeviceNode ──────────────────────────────────────────

const autoCtxMenuItemStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '5px 8px',
    border: 'none',
    background: 'transparent',
    color: 'var(--color-text-primary)',
    fontSize: 'var(--font-size-sm)',
    fontWeight: 500,
    textAlign: 'left',
    cursor: 'pointer',
    borderRadius: 'var(--radius-sm)',
    transition: 'background var(--transition-fast)',
};

const DeviceNode = ({
    order,
    device, onToggle, onOpenGUI,
    isSelected,
    showSettings,
    onSelect,
    onOpenSettings,
    onParamChange,
    onParamGestureStart,
    onParamGestureEnd,
    onApplyQuickPreset,
    onRandomize,
    onReset,
    onStoreSnapshot,
    onRecallSnapshot,
    onToggleSnapshot,
    snapshotState,
    onApplyUtilityScene,
    onDropSample,
    onLoadSample,
    editorSupported, editorReason,
    runtimeStatus,
    onParamContextMenu,
    sidechainSourceTrackId,
    sidechainOptions,
    onSidechainSourceChange,
    onEnsureActive,
}: {
    order: number;
    device: DeviceSlot;
    onToggle: () => void;
    isSelected: boolean;
    showSettings: boolean;
    onSelect: (e: React.MouseEvent<HTMLDivElement>) => void;
    onOpenSettings: () => void;
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
    onApplyQuickPreset?: (preset: QuickPreset) => void;
    onRandomize?: () => void;
    onReset?: () => void;
    onStoreSnapshot?: (slot: 'A' | 'B') => void;
    onRecallSnapshot?: (slot: 'A' | 'B') => void;
    onToggleSnapshot?: () => void;
    snapshotState?: { A?: Record<string, number>; B?: Record<string, number>; active?: 'A' | 'B' };
    onApplyUtilityScene?: (scene: 'center' | 'mono' | 'wide') => void;
    onDropSample?: (samplePath: string) => void;
    onLoadSample?: () => void;
    onOpenGUI?: () => void;
    editorSupported?: boolean;
    editorReason?: string;
    runtimeStatus?: engineApi.PluginSlotRuntimeStatus;
    onParamContextMenu?: (e: React.MouseEvent, paramName: string) => void;
    sidechainSourceTrackId?: string;
    sidechainOptions?: Array<{ id: string; name: string }>;
    onSidechainSourceChange?: (sourceTrackId: string) => void;
    onEnsureActive?: () => void;
}) => {
    // Color per device type (matching Ableton's device categories)
    const typeColorMap: Record<string, string> = {
        instrument: '#4a9eff',
        sampler: '#4a9eff',
        waveSynth: '#62d2a2',
        eq: '#d9a625',
        compressor: '#66cc33',
        delay: '#33a6d9',
        reverb: '#8844aa',
        chorus: '#c850a0',
        utility: '#999',
        saturator: '#d97028',
        limiter: '#59d3be',
        gate: '#6cc66d',
        autoFilter: '#3ed1d1',
        autoPan: '#6db3ff',
        phaser: '#8b7bff',
        flanger: '#55a6ff',
        distortion: '#ff844d',
        bitcrusher: '#f0d65c',
        spectrum: '#7cc4d4',
        midiPitch: '#7aa3ff',
        midiScale: '#8bc27a',
        midiVelocity: '#d9a25c',
        midiRandom: '#c58bdd',
        vst: '#4a9eff',
    };
    const typeColor = typeColorMap[device.effectType] || 'var(--color-accent-primary)';
    const baseWidth = device.source === 'internal'
        ? device.effectType === 'waveSynth'
            ? 980
            : device.effectType === 'eq'
                ? 860
                : device.effectType === 'utility'
                    ? 360
                    : 720
        : device.effectType === 'sampler'
            ? 520
            : device.effectType === 'waveSynth'
                ? 560
                : device.effectType === 'instrument'
                    ? 420
                    : device.effectType === 'eq'
                        ? 420
                        : device.effectType === 'autoFilter' || device.effectType === 'autoPan' || device.effectType === 'phaser' || device.effectType === 'flanger'
                            ? 360
                            : device.effectType === 'midiPitch' || device.effectType === 'midiScale' || device.effectType === 'midiVelocity' || device.effectType === 'midiRandom'
                                ? 320
                                : device.effectType === 'gate'
                                    ? 340
                                    : 420; // Increased default VST width to 420 for better visibility
    const settingsWidth = Math.min(1460, Math.max(baseWidth, 280 + device.params.length * 110));
    const rackWidth = showSettings ? settingsWidth : baseWidth;
    const supportsSettingsToggle = device.source === 'vst' || (device.source === 'internal' && device.effectType !== 'utility');

    return (
        <div
            className="device-node"
            data-effect={device.effectType}
            style={{
                minWidth: rackWidth,
                width: rackWidth,
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--color-bg-node)',
                borderRadius: 'var(--radius-sm)',
                border: isSelected ? '1px solid color-mix(in srgb, var(--color-text-primary) 90%, transparent)' : '1px solid var(--color-border-subtle)',
                overflow: 'hidden',
                opacity: device.isEnabled ? 1 : 0.5,
                transition: 'opacity var(--transition-fast)',
                flexShrink: 0,
                height: '100%',
                minHeight: '100%',
                position: 'relative',
                boxShadow: 'none',
            }}
            onMouseUp={() => {
                const dragging = useDragStore.getState().draggingItem;
                const acceptance = dragging ? canDropInZone(dragging, 'sampler-surface') : { allowed: false };
                const isSamplerDevice =
                    device.source === 'internal' &&
                    (device.effectType === 'sampler' || device.effectType === 'instrument');
                if (!isSamplerDevice) return;
                if (dragging?.path && acceptance.allowed) {
                    onDropSample?.(dragging.path);
                    useDragStore.getState().endDrag();
                }
            }}
        >
            {/* Header */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '3px 6px',
                borderBottom: '1px solid var(--color-divider)',
                background: 'var(--color-bg-header)',
                cursor: 'pointer',
            }}
                onClick={(e) => { e.stopPropagation(); onSelect(e); }}
            >
                <button
                    onClick={onToggle}
                    title={device.isEnabled ? 'Disable' : 'Enable'}
                    style={{
                        width: 11, height: 11,
                        borderRadius: '50%',
                        background: device.isEnabled ? typeColor : 'var(--color-text-tertiary)',
                        border: 'none',
                        cursor: 'pointer',
                        flexShrink: 0,
                    }}
                />
                <span style={{
                    fontSize: 'var(--font-size-2xs)',
                    fontWeight: 600,
                    color: 'var(--color-text-primary)',
                    flex: 1,
                    textAlign: 'center',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                }}>
                    {device.name}
                </span>
                <span style={{
                    fontSize: 'var(--font-size-2xs)',
                    color: 'var(--color-text-tertiary)',
                    fontFamily: 'var(--font-mono)',
                    marginRight: 4,
                }}>
                    {order}
                </span>
                {device.source === 'vst' ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        {runtimeStatus && (
                            <span
                                title={runtimeStatus.message ?? `Runtime: ${runtimeStatus.runtime}${runtimeStatus.latencyFrames != null ? ` | latency ${runtimeStatus.latencyFrames} fr` : ''}`}
                                style={{
                                    fontSize: 9,
                                    lineHeight: 1,
                                    padding: '2px 4px',
                                    borderRadius: 4,
                                    border: '1px solid var(--color-divider)',
                                    color: runtimeStatus.loaded ? 'var(--color-text-secondary)' : '#ff9b9b',
                                    background: runtimeStatus.loaded
                                        ? 'color-mix(in srgb, var(--color-bg-header) 80%, #6fd38b33)'
                                        : 'color-mix(in srgb, var(--color-bg-header) 75%, #ff5a5a33)',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.03em',
                                }}
                            >
                                {runtimeStatus.loaded
                                    ? (runtimeStatus.latencyFrames != null
                                        ? `${runtimeStatus.runtime} ${runtimeStatus.latencyFrames}f`
                                        : runtimeStatus.runtime)
                                    : 'offline'}
                            </span>
                        )}
                        {runtimeStatus && !runtimeStatus.loaded && (
                            <button
                                onClick={(e) => { e.stopPropagation(); onEnsureActive?.(); }}
                                title="Recover plugin runtime"
                                style={headerIconBtnStyle(false)}
                            >
                                Fix
                            </button>
                        )}
                        <button
                            onClick={(e) => { e.stopPropagation(); onOpenGUI?.(); }}
                            title={editorSupported === false
                                ? (editorReason ?? 'Plugin editor is unavailable')
                                : 'Open Inline Plugin View'}
                            style={headerIconBtnStyle(false, showSettings)}
                        >
                            View
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); onOpenSettings(); }}
                            title="Plugin Settings / Automatable Params"
                            style={headerIconBtnStyle(false, showSettings)}
                        >
                            🔧
                        </button>
                    </div>
                ) : supportsSettingsToggle ? (
                    <button
                        onClick={(e) => { e.stopPropagation(); onOpenSettings(); }}
                        title="Inline Controls"
                        style={headerIconBtnStyle(false, showSettings)}
                    >
                        🔧
                    </button>
                ) : (
                    <span style={{ width: 24, display: 'inline-block' }} />
                )}
                <span style={{
                    fontSize: 'var(--font-size-micro)',
                    color: device.source === 'vst' ? '#2ecc71' : 'var(--color-text-tertiary)',
                    fontWeight: 700,
                    minWidth: 28,
                    textAlign: 'right',
                }}>
                    {device.source === 'vst' ? 'VST' : 'INT'}
                </span>
            </div>

            {device.source === 'internal' ? (
                <div
                    style={{
                        padding: 6,
                        flex: 1,
                        minHeight: 0,
                        display: 'grid',
                        gridTemplateRows: showSettings && supportsSettingsToggle ? 'minmax(170px, 1fr) auto' : 'minmax(170px, 1fr)',
                        gap: 6,
                        overflow: 'hidden',
                    }}
                >
                    <div style={{ minHeight: 0 }}>
                        <PluginGuiSurface
                            device={device}
                            onParamChange={onParamChange}
                            onParamGestureStart={onParamGestureStart}
                            onParamGestureEnd={onParamGestureEnd}
                            onApplyUtilityScene={onApplyUtilityScene}
                            onDropSample={onDropSample}
                            onLoadSample={onLoadSample}
                            onParamContextMenu={onParamContextMenu}
                        />
                    </div>
                    {showSettings && supportsSettingsToggle && (
                        <div
                            style={{
                                maxHeight: 230,
                                overflow: 'auto',
                                border: '1px solid var(--color-divider)',
                                borderRadius: 'var(--radius-sm)',
                                background: 'var(--color-bg-elevated)',
                                padding: 6,
                            }}
                        >
                            <PluginSettingsPanel
                                device={device}
                                onParamChange={onParamChange}
                                onParamGestureStart={onParamGestureStart}
                                onParamGestureEnd={onParamGestureEnd}
                                onApplyQuickPreset={onApplyQuickPreset}
                                onRandomize={onRandomize}
                                onReset={onReset}
                                onStoreSnapshot={onStoreSnapshot}
                                onRecallSnapshot={onRecallSnapshot}
                                onToggleSnapshot={onToggleSnapshot}
                                snapshotState={snapshotState}
                                onLoadSample={onLoadSample}
                                sidechainSourceTrackId={sidechainSourceTrackId}
                                sidechainOptions={sidechainOptions}
                                onSidechainSourceChange={onSidechainSourceChange}
                                runtimeStatus={runtimeStatus}
                                editorSupported={editorSupported}
                                editorReason={editorReason}
                            />
                        </div>
                    )}
                </div>
            ) : showSettings && supportsSettingsToggle ? (
                <div style={{ padding: 6, flex: 1, minHeight: 0, overflow: 'auto' }}>
                    <PluginSettingsPanel
                        device={device}
                        onParamChange={onParamChange}
                        onParamGestureStart={onParamGestureStart}
                        onParamGestureEnd={onParamGestureEnd}
                        onApplyQuickPreset={onApplyQuickPreset}
                        onRandomize={onRandomize}
                        onReset={onReset}
                        onStoreSnapshot={onStoreSnapshot}
                        onRecallSnapshot={onRecallSnapshot}
                        onToggleSnapshot={onToggleSnapshot}
                        snapshotState={snapshotState}
                        onLoadSample={onLoadSample}
                        sidechainSourceTrackId={sidechainSourceTrackId}
                        sidechainOptions={sidechainOptions}
                        onSidechainSourceChange={onSidechainSourceChange}
                        runtimeStatus={runtimeStatus}
                        editorSupported={editorSupported}
                        editorReason={editorReason}
                    />
                </div>
            ) : (
                <div style={{
                    display: 'grid',
                    gridTemplateRows: 'auto 1fr auto',
                    gap: 6,
                    padding: '8px',
                    flex: 1,
                    minHeight: 0,
                    overflow: 'hidden',
                }}>
                    <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                            {device.source === 'vst' ? 'Native GUI' : 'Internal GUI'}
                        </span>
                        <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-tertiary)' }}>
                            {device.params.length} params
                        </span>
                    </div>
                    {device.source === 'vst' && (
                        <div style={{
                            border: '1px solid var(--color-divider)',
                            borderRadius: 6,
                            background: 'color-mix(in srgb, var(--color-bg-header) 84%, #0c1017)',
                            padding: 6,
                            minHeight: 0,
                            overflow: 'hidden',
                            display: 'grid',
                            gridTemplateRows: '1fr auto',
                            gap: 6,
                        }}>
                            <div style={{ display: 'grid', gap: 4, alignContent: 'start' }}>
                                {device.params.slice(0, 6).map((p) => {
                                    const range = Math.max(1e-9, p.max - p.min);
                                    const fill = Math.max(0, Math.min(1, (p.value - p.min) / range));
                                    return (
                                        <div key={p.name} style={{ display: 'grid', gridTemplateColumns: '70px 1fr auto', gap: 6, alignItems: 'center' }}>
                                            <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {p.name}
                                            </span>
                                            <div style={{ height: 6, borderRadius: 999, background: 'var(--color-bg-panel)', overflow: 'hidden' }}>
                                                <div style={{ width: `${(fill * 100).toFixed(1)}%`, height: '100%', background: 'linear-gradient(90deg, #5aa9ff 0%, #8ec6ff 100%)' }} />
                                            </div>
                                            <span style={{ fontSize: 9, color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                                                {Number.isFinite(p.value) ? p.value.toFixed(2) : '-'}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onOpenSettings(); }}
                                style={{
                                    justifySelf: 'start',
                                    border: '1px solid var(--color-divider)',
                                    borderRadius: 4,
                                    background: 'var(--color-bg-elevated)',
                                    color: 'var(--color-text-secondary)',
                                    fontSize: 10,
                                    fontWeight: 700,
                                    padding: '4px 8px',
                                    cursor: 'pointer',
                                }}
                            >
                                Open Inline Editor
                            </button>
                        </div>
                    )}
                </div>
            )}

        </div>
    );
};

const headerIconBtnStyle = (disabled: boolean, active = false) =>
    ({
        minWidth: 24,
        height: 18,
        padding: '0 6px',
        borderRadius: 'var(--radius-md)',
        border: active ? '1px solid var(--color-accent-primary)' : '1px solid var(--color-divider)',
        background: disabled
            ? 'color-mix(in srgb, var(--color-text-tertiary) 25%, transparent)'
            : active
                ? 'color-mix(in srgb, var(--color-accent-primary) 20%, var(--color-bg-elevated))'
                : 'var(--color-bg-elevated)',
        color: disabled
            ? 'var(--color-text-tertiary)'
            : active
                ? 'var(--color-accent-primary)'
                : 'var(--color-text-secondary)',
        fontSize: 'var(--font-size-2xs)',
        fontWeight: 700,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.65 : 1,
        transition: 'all var(--transition-fast)',
    }) as const;

const pluginPanelLayoutStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateRows: '90px auto',
    gap: 'var(--plugin-grid-gap)',
    height: '100%',
};

const pluginPanelCardBaseStyle: React.CSSProperties = {
    border: '1px solid var(--plugin-card-border)',
    borderRadius: 'var(--plugin-card-radius)',
    padding: 'var(--plugin-card-pad-y) var(--plugin-card-pad-x)',
    display: 'grid',
    gridTemplateRows: '1fr auto',
    gap: 'var(--plugin-card-gap)',
    background: 'var(--plugin-card-bg-main)',
    boxShadow: 'var(--plugin-card-shadow)',
};

const pluginPanelTitleStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--plugin-title-color)',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    fontWeight: 700,
};

const pluginPanelMetaStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 10,
    color: 'var(--plugin-meta-color)',
    fontFamily: 'var(--font-mono)',
};

const pluginPanelKnobGrid = (columns: string): React.CSSProperties => ({
    display: 'grid',
    gridTemplateColumns: columns,
    alignItems: 'center',
    gap: 'var(--plugin-grid-gap)',
});

type QuickPreset = {
    label: string;
    values: Record<string, number>;
};

const QUICK_PRESETS_BY_EFFECT: Partial<Record<DeviceSlot['effectType'], QuickPreset[]>> = {
    eq: [
        { label: 'Flat', values: { low: 0, mid: 0, high: 0, out: 0 } },
        { label: 'Air', values: { low: -1.5, mid: 1.5, high: 4, out: 0 } },
        { label: 'Warm', values: { low: 2.5, mid: -1, high: -1.5, out: -0.5 } },
    ],
    compressor: [
        { label: 'Gentle', values: { thr: -14, ratio: 2.5, atk: 18, rel: 120 } },
        { label: 'Punch', values: { thr: -22, ratio: 5, atk: 6, rel: 70 } },
        { label: 'Glue', values: { thr: -12, ratio: 2, atk: 30, rel: 180 } },
    ],
    delay: [
        { label: 'Slap', values: { time: 95, fb: 18, 'dry/wet': 20 } },
        { label: 'Wide', values: { time: 320, fb: 42, 'dry/wet': 34 } },
        { label: 'Wash', values: { time: 560, fb: 60, 'dry/wet': 48 } },
    ],
    reverb: [
        { label: 'Room', values: { decay: 26, tone: -8, 'dry/wet': 16 } },
        { label: 'Hall', values: { decay: 52, tone: 4, 'dry/wet': 24 } },
        { label: 'Shimmer', values: { decay: 72, tone: 28, 'dry/wet': 34 } },
    ],
    chorus: [
        { label: 'Subtle', values: { rate: 0.8, depth: 24, mix: 18 } },
        { label: 'Wide', values: { rate: 1.2, depth: 44, mix: 35 } },
        { label: 'Vintage', values: { rate: 0.45, depth: 60, mix: 42 } },
    ],
    saturator: [
        { label: 'Soft', values: { drive: 2.4, tone: 8, mix: 80 } },
        { label: 'Warm', values: { drive: 5.5, tone: -4, mix: 88 } },
        { label: 'Hard', values: { drive: 10.5, tone: 14, mix: 92 } },
    ],
    utility: [
        { label: 'Center', values: { gain: 0, pan: 0, width: 100, mono: 0 } },
        { label: 'Mono', values: { gain: 0, pan: 0, width: 0, mono: 1 } },
        { label: 'Wide', values: { gain: 0, pan: 0, width: 150, mono: 0 } },
    ],
    limiter: [
        { label: 'Safety', values: { thr: -2, rel: 120, ceil: -0.8 } },
        { label: 'Loud', values: { thr: -6, rel: 80, ceil: -0.2 } },
        { label: 'Transparent', values: { thr: -1.2, rel: 220, ceil: -0.3 } },
    ],
    gate: [
        { label: 'Clean', values: { thr: -34, atk: 0.3, hold: 22, rel: 80, range: -80 } },
        { label: 'Tight', values: { thr: -26, atk: 0.05, hold: 4, rel: 28, range: -60 } },
        { label: 'Soft', values: { thr: -46, atk: 2.5, hold: 32, rel: 180, range: -48 } },
    ],
    autoFilter: [
        { label: 'Sweep', values: { cutoff: 1800, res: 0.38, rate: 0.8, depth: 0.55, mix: 0.95 } },
        { label: 'Wobble', values: { cutoff: 320, res: 0.52, rate: 3.2, depth: 0.8, mix: 1 } },
        { label: 'Subtle', values: { cutoff: 4200, res: 0.2, rate: 0.3, depth: 0.22, mix: 0.68 } },
    ],
    autoPan: [
        { label: 'Slow', values: { rate: 0.35, depth: 45, phase: 180, mix: 85 } },
        { label: 'Wide', values: { rate: 0.9, depth: 80, phase: 180, mix: 100 } },
        { label: 'Chop', values: { rate: 5.8, depth: 100, phase: 0, mix: 100 } },
    ],
    phaser: [
        { label: 'Classic', values: { rate: 0.7, depth: 0.65, fb: 0.2, mix: 0.6 } },
        { label: 'Deep', values: { rate: 0.24, depth: 0.92, fb: 0.45, mix: 0.72 } },
        { label: 'Fast', values: { rate: 2.5, depth: 0.5, fb: 0.15, mix: 0.48 } },
    ],
    flanger: [
        { label: 'Tape', values: { rate: 0.2, depth: 0.4, fb: 0.22, mix: 0.35 } },
        { label: 'Jet', values: { rate: 0.55, depth: 0.75, fb: 0.48, mix: 0.62 } },
        { label: 'Subtle', values: { rate: 0.16, depth: 0.24, fb: 0.1, mix: 0.28 } },
    ],
    distortion: [
        { label: 'Edge', values: { drive: 22, tone: 0.58, mix: 0.7 } },
        { label: 'Crunch', values: { drive: 38, tone: 0.5, mix: 0.86 } },
        { label: 'Destroy', values: { drive: 64, tone: 0.68, mix: 1 } },
    ],
    bitcrusher: [
        { label: 'Soft', values: { bits: 10, down: 1.4, mix: 0.42 } },
        { label: 'Retro', values: { bits: 7, down: 3.2, mix: 0.64 } },
        { label: 'Crush', values: { bits: 4, down: 8, mix: 0.9 } },
    ],
    noiseMachine: [
        { label: 'Vinyl', values: { type: 0, level: -30, stereo: 0.2 } },
        { label: 'Air', values: { type: 1, level: -34, stereo: 0.65 } },
        { label: 'Storm', values: { type: 2, level: -20, stereo: 0.75 } },
    ],
    midiPitch: [
        { label: '-12', values: { semitones: -12 } },
        { label: '0', values: { semitones: 0 } },
        { label: '+12', values: { semitones: 12 } },
    ],
    midiScale: [
        { label: 'C', values: { root: 0 } },
        { label: 'D', values: { root: 2 } },
        { label: 'A', values: { root: 9 } },
    ],
    midiVelocity: [
        { label: 'Even', values: { gain: 1, offset: 0 } },
        { label: 'Accent', values: { gain: 1.3, offset: 8 } },
        { label: 'Soft', values: { gain: 0.78, offset: -12 } },
    ],
    midiRandom: [
        { label: 'Tight', values: { semitones: 2, chance: 0.15 } },
        { label: 'Playful', values: { semitones: 7, chance: 0.35 } },
        { label: 'Wild', values: { semitones: 12, chance: 0.7 } },
    ],
};

function resolveQuickPresetParams(
    device: DeviceSlot,
    preset: QuickPreset,
): Array<{ paramName: string; value: number }> {
    const byName = new Map(device.params.map((p) => [p.name.toLowerCase(), p.name]));
    const resolved: Array<{ paramName: string; value: number }> = [];
    for (const [rawName, value] of Object.entries(preset.values)) {
        const key = rawName.toLowerCase();
        const canonical =
            byName.get(key)
            ?? byName.get(key.replace(/\s+/g, ''))
            ?? byName.get(key.replace(/\s*\/\s*/g, '/'));
        if (!canonical) continue;
        resolved.push({ paramName: canonical, value });
    }
    return resolved;
}

function defaultParamForReset(param: PluginParam): number {
    const name = param.name.toLowerCase();
    if (param.min <= 0 && param.max >= 0) return 0;
    if (name.includes('mix') || name.includes('width') || name.includes('amount') || name.includes('depth')) {
        return (param.min + param.max) * 0.5;
    }
    if (name.includes('gain') || name.includes('volume') || name === 'vol') {
        return Math.min(param.max, Math.max(param.min, 0));
    }
    return (param.min + param.max) * 0.5;
}

function clampAndSnapParamValue(param: PluginParam, value: number): number {
    const clamped = Math.max(param.min, Math.min(param.max, value));
    const step = param.step ?? 0;
    if (!Number.isFinite(step) || step <= 0) return clamped;
    const steps = Math.round((clamped - param.min) / step);
    const snapped = param.min + steps * step;
    return Math.max(param.min, Math.min(param.max, snapped));
}

function randomParamValue(param: PluginParam): number {
    const range = param.max - param.min;
    if (!Number.isFinite(range) || range <= 0) return param.value;
    const step = param.step && param.step > 0 ? param.step : range / 120;
    const base = param.min + Math.random() * range;
    const snapped = Math.round((base - param.min) / step) * step + param.min;
    return clampAndSnapParamValue(param, snapped);
}

const PluginGuiSurface = ({
    device,
    onParamChange,
    onParamGestureStart,
    onParamGestureEnd,
    onApplyUtilityScene,
    onDropSample,
    onLoadSample,
    onParamContextMenu,
}: {
    device: DeviceSlot;
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
    onApplyUtilityScene?: (scene: 'center' | 'mono' | 'wide') => void;
    onDropSample?: (samplePath: string) => void;
    onLoadSample?: () => void;
    onParamContextMenu?: (e: React.MouseEvent, paramName: string) => void;
}) => {
    const [waveformPeaks, setWaveformPeaks] = useState<engineApi.PeakPair[] | null>(null);
    const eqSurfaceRef = useRef<SVGSVGElement | null>(null);
    const [dragEqBand, setDragEqBand] = useState<'low' | 'mid' | 'high' | null>(null);
    const pluginNameLower = device.name.toLowerCase();
    const guiMode = (device.guiMode || '').toLowerCase();

    useEffect(() => {
        const samplePath = device.samplePath?.trim();
        if (!samplePath) {
            return;
        }
        let cancelled = false;
        engineApi.getWaveformPeaksBinary(samplePath)
            .then((wf) => {
                if (cancelled) return;
                const level = wf.mip_levels[0] ?? wf.mip_levels[wf.mip_levels.length - 1];
                const peaks = level?.peaks ?? [];
                if (peaks.length === 0) {
                    setWaveformPeaks(null);
                    return;
                }
                const targetPointCount = 960;
                if (peaks.length <= targetPointCount) {
                    setWaveformPeaks(peaks);
                    return;
                }
                const reduced: engineApi.PeakPair[] = [];
                const bucket = peaks.length / targetPointCount;
                for (let i = 0; i < targetPointCount; i++) {
                    const start = Math.floor(i * bucket);
                    const end = Math.min(peaks.length, Math.max(start + 1, Math.floor((i + 1) * bucket)));
                    let min = 1;
                    let max = -1;
                    for (let j = start; j < end; j++) {
                        const p = peaks[j];
                        if (p.min < min) min = p.min;
                        if (p.max > max) max = p.max;
                    }
                    reduced.push({ min, max });
                }
                setWaveformPeaks(reduced);
            })
            .catch((err) => {
                if (!cancelled) {
                    console.warn('[DeviceRack] sampler waveform load failed:', err);
                    setWaveformPeaks(null);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [device.samplePath]);

    const samplerWaveformPath = useMemo(() => {
        if (!waveformPeaks || waveformPeaks.length === 0) return null;
        const width = 1000;
        const centerY = 45;
        const amp = 40;
        const n = waveformPeaks.length;
        const top: string[] = [];
        const bottom: string[] = [];
        for (let i = 0; i < n; i++) {
            const x = (i / Math.max(1, n - 1)) * width;
            const p = waveformPeaks[i];
            const maxY = centerY - Math.max(-1, Math.min(1, p.max)) * amp;
            top.push(`${x.toFixed(2)} ${maxY.toFixed(2)}`);
        }
        for (let i = n - 1; i >= 0; i--) {
            const x = (i / Math.max(1, n - 1)) * width;
            const p = waveformPeaks[i];
            const minY = centerY - Math.max(-1, Math.min(1, p.min)) * amp;
            bottom.push(`${x.toFixed(2)} ${minY.toFixed(2)}`);
        }
        return `M ${top.join(' L ')} L ${bottom.join(' L ')} Z`;
    }, [waveformPeaks]);

    const beginEqBandGesture = useCallback((band: 'low' | 'mid' | 'high') => {
        const gestureGroupId = `${device.id}:eq-band:${band}:${Date.now()}`;
        if (band === 'low') {
            onParamGestureStart?.('Low', gestureGroupId);
            onParamGestureStart?.('LowFreq', gestureGroupId);
        } else if (band === 'mid') {
            onParamGestureStart?.('Mid', gestureGroupId);
            onParamGestureStart?.('MidFreq', gestureGroupId);
        } else {
            onParamGestureStart?.('High', gestureGroupId);
            onParamGestureStart?.('HighFreq', gestureGroupId);
        }
    }, [device.id, onParamGestureStart]);

    const endEqBandGesture = useCallback((band: 'low' | 'mid' | 'high') => {
        if (band === 'low') {
            onParamGestureEnd?.('Low');
            onParamGestureEnd?.('LowFreq');
        } else if (band === 'mid') {
            onParamGestureEnd?.('Mid');
            onParamGestureEnd?.('MidFreq');
        } else {
            onParamGestureEnd?.('High');
            onParamGestureEnd?.('HighFreq');
        }
    }, [onParamGestureEnd]);

    useEffect(() => {
        if (!dragEqBand) return;
        const onMove = (e: MouseEvent) => {
            const surface = eqSurfaceRef.current;
            if (!surface) return;
            const rect = surface.getBoundingClientRect();
            const xNorm = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
            const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
            const gainValue = ((rect.height / 2 - y) / (rect.height / 2)) * 24;
            const roundedGain = Math.max(-24, Math.min(24, gainValue));
            const lowFreq = 20 + xNorm * (1200 - 20);
            const midFreq = 120 + xNorm * (9000 - 120);
            const highFreq = 1200 + xNorm * (20000 - 1200);
            if (dragEqBand === 'low') {
                onParamChange('Low', roundedGain);
                onParamChange('LowFreq', Math.round(lowFreq));
            }
            if (dragEqBand === 'mid') {
                onParamChange('Mid', roundedGain);
                onParamChange('MidFreq', Math.round(midFreq));
            }
            if (dragEqBand === 'high') {
                onParamChange('High', roundedGain);
                onParamChange('HighFreq', Math.round(highFreq));
            }
        };
        const onUp = () => {
            if (dragEqBand) endEqBandGesture(dragEqBand);
            setDragEqBand(null);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [dragEqBand, onParamChange, endEqBandGesture]);

    if (device.effectType === 'waveSynth') {
        const osc1 = Math.round(device.params.find((x) => x.name.toLowerCase() === 'osc1wave')?.value ?? 0);
        const osc2 = Math.round(device.params.find((x) => x.name.toLowerCase() === 'osc2wave')?.value ?? 0);
        const mix = device.params.find((x) => x.name.toLowerCase() === 'mix')?.value ?? 0.35;
        const detune = device.params.find((x) => x.name.toLowerCase() === 'detune')?.value ?? 0;
        const sub = device.params.find((x) => x.name.toLowerCase() === 'sub')?.value ?? 0;
        const waveforms = [
            { idx: 0, label: 'Sine' },
            { idx: 1, label: 'Triangle' },
            { idx: 2, label: 'Saw' },
            { idx: 3, label: 'Square' },
        ];
        const wavePath = (waveIndex: number) => {
            switch (waveIndex) {
                case 1:
                    return 'M 0 50 L 12.5 20 L 37.5 80 L 62.5 20 L 87.5 80 L 100 50';
                case 2:
                    return 'M 0 70 L 25 30 L 50 70 L 75 30 L 100 70';
                case 3:
                    return 'M 0 70 L 0 30 L 25 30 L 25 70 L 50 70 L 50 30 L 75 30 L 75 70 L 100 70';
                default:
                    return 'M 0 50 C 8 10, 17 10, 25 50 C 33 90, 42 90, 50 50 C 58 10, 67 10, 75 50 C 83 90, 92 90, 100 50';
            }
        };
        const randomizePatch = () => {
            const randomInRange = (min: number, max: number, step = 0.01) => {
                const raw = min + Math.random() * (max - min);
                return Math.round(raw / step) * step;
            };
            onParamChange('Osc1Wave', Math.floor(Math.random() * 4));
            onParamChange('Osc2Wave', Math.floor(Math.random() * 4));
            onParamChange('Mix', randomInRange(0.1, 0.9, 0.01));
            onParamChange('Detune', randomInRange(-18, 18, 0.1));
            onParamChange('Sub', randomInRange(0, 0.5, 0.01));
            onParamChange('Cutoff', randomInRange(200, 8000, 1));
            onParamChange('Res', randomInRange(0, 0.8, 0.01));
            onParamChange('FiltType', Math.floor(Math.random() * 4));
            onParamChange('Vol', randomInRange(0.7, 1.4, 0.01));
            onParamChange('Attack', randomInRange(0.001, 0.18, 0.001));
            onParamChange('Decay', randomInRange(0.03, 1.8, 0.001));
            onParamChange('Sustain', randomInRange(0.25, 1.0, 0.01));
            onParamChange('Release', randomInRange(0.02, 2.2, 0.001));
        };
        const applyMacroPreset = (preset: 'init' | 'bass' | 'lead' | 'pad' | 'pluck') => {
            const set = (name: string, value: number) => onParamChange(name, value);
            if (preset === 'init') {
                set('Osc1Wave', 0);
                set('Osc2Wave', 2);
                set('Mix', 0.35);
                set('Detune', 0);
                set('Sub', 0);
                set('Cutoff', 20000);
                set('Res', 0);
                set('FiltType', 0);
                set('Vol', 1);
                set('Attack', 0.01);
                set('Decay', 0.1);
                set('Sustain', 1);
                set('Release', 0.05);
                return;
            }
            if (preset === 'bass') {
                set('Osc1Wave', 2);
                set('Osc2Wave', 3);
                set('Mix', 0.58);
                set('Detune', -4.8);
                set('Sub', 0.42);
                set('Cutoff', 980);
                set('Res', 0.26);
                set('FiltType', 0);
                set('Vol', 1.18);
                set('Attack', 0.004);
                set('Decay', 0.2);
                set('Sustain', 0.62);
                set('Release', 0.16);
                return;
            }
            if (preset === 'lead') {
                set('Osc1Wave', 3);
                set('Osc2Wave', 2);
                set('Mix', 0.45);
                set('Detune', 8.5);
                set('Sub', 0.12);
                set('Cutoff', 5200);
                set('Res', 0.34);
                set('FiltType', 1);
                set('Vol', 1.05);
                set('Attack', 0.006);
                set('Decay', 0.22);
                set('Sustain', 0.7);
                set('Release', 0.28);
                return;
            }
            if (preset === 'pad') {
                set('Osc1Wave', 1);
                set('Osc2Wave', 0);
                set('Mix', 0.63);
                set('Detune', 13.2);
                set('Sub', 0.18);
                set('Cutoff', 2600);
                set('Res', 0.2);
                set('FiltType', 0);
                set('Vol', 0.92);
                set('Attack', 0.42);
                set('Decay', 0.72);
                set('Sustain', 0.84);
                set('Release', 1.6);
                return;
            }
            set('Osc1Wave', 2);
            set('Osc2Wave', 3);
            set('Mix', 0.2);
            set('Detune', 2.4);
            set('Sub', 0.06);
            set('Cutoff', 1800);
            set('Res', 0.62);
            set('FiltType', 0);
            set('Vol', 1.08);
            set('Attack', 0.001);
            set('Decay', 0.09);
            set('Sustain', 0.18);
            set('Release', 0.14);
        };
        return (
            <div style={{ ...pluginPanelLayoutStyle, gridTemplateRows: '126px auto' }}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-2) 84%, #133026) 0%, color-mix(in srgb, var(--surface-1) 90%, #0a1612) 100%)',
                    display: 'grid',
                    gridTemplateRows: 'auto auto 1fr',
                    gap: 8,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                        <span style={{ ...pluginPanelTitleStyle, fontSize: 10, color: '#d3efe3' }}>
                            Essence
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 10, color: '#80d7b0', fontFamily: 'var(--font-mono)' }}>
                                OSC Blend {(mix * 100).toFixed(0)}%
                            </span>
                            <button
                                type="button"
                                onClick={randomizePatch}
                                style={{
                                    border: '1px solid #4d7b69',
                                    borderRadius: 'var(--radius-md)',
                                    background: 'rgba(24, 44, 37, 0.72)',
                                    color: '#c9f7df',
                                    fontSize: 'var(--font-size-2xs)',
                                    fontWeight: 700,
                                    letterSpacing: '0.03em',
                                    cursor: 'pointer',
                                    padding: '3px 7px',
                                }}
                            >
                                Random
                            </button>
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {[
                            { id: 'init', label: 'INIT' },
                            { id: 'bass', label: 'BASS' },
                            { id: 'lead', label: 'LEAD' },
                            { id: 'pad', label: 'PAD' },
                            { id: 'pluck', label: 'PLUCK' },
                        ].map((preset) => (
                            <button
                                key={preset.id}
                                type="button"
                                onClick={() => applyMacroPreset(preset.id as 'init' | 'bass' | 'lead' | 'pad' | 'pluck')}
                                style={{
                                    border: '1px solid #446b5d',
                                    borderRadius: 'var(--radius-md)',
                                    background: 'linear-gradient(180deg, rgba(30, 52, 45, 0.85) 0%, rgba(20, 35, 31, 0.9) 100%)',
                                    color: '#c9f7df',
                                    fontSize: 9,
                                    fontWeight: 700,
                                    letterSpacing: '0.03em',
                                    cursor: 'pointer',
                                    padding: '3px 7px',
                                }}
                            >
                                {preset.label}
                            </button>
                        ))}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: 26, opacity: 0.9 }}>
                            <rect x="0" y="0" width="100" height="100" fill="rgba(8, 17, 14, 0.55)" />
                            <path d={wavePath(osc1)} fill="none" stroke="#64e7ad" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: 26, opacity: 0.9 }}>
                            <rect x="0" y="0" width="100" height="100" fill="rgba(8, 17, 14, 0.55)" />
                            <path d={wavePath(osc2)} fill="none" stroke="#8cd1ff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', alignItems: 'center', gap: 6 }}>
                        <div style={{ fontSize: 9, color: '#8fd6b4', fontFamily: 'var(--font-mono)' }}>OSC1 {waveformLabel(osc1)}</div>
                        <div style={{ fontSize: 9, color: '#9bc6ff', fontFamily: 'var(--font-mono)' }}>OSC2 {waveformLabel(osc2)}</div>
                        <div style={{ fontSize: 9, color: '#a4d5c0', fontFamily: 'var(--font-mono)' }}>Detune {detune.toFixed(1)}ct</div>
                        <div style={{ fontSize: 9, color: '#a4d5c0', fontFamily: 'var(--font-mono)' }}>Sub {(sub * 100).toFixed(0)}%</div>
                    </div>
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: 18, opacity: 0.85 }}>
                        <rect x="0" y="0" width="100" height="100" fill="rgba(8, 17, 14, 0.55)" />
                        <path d="M 0 50 C 10 20, 20 80, 30 50 C 40 20, 50 80, 60 50 C 70 20, 80 80, 90 50 C 95 34, 100 60, 100 50" fill="none" stroke="#5be3a7" strokeWidth="2.2" opacity={1 - mix * 0.6} />
                        <path d="M 0 50 C 10 76, 20 24, 30 50 C 40 76, 50 24, 60 50 C 70 76, 80 24, 90 50 C 95 66, 100 40, 100 50" fill="none" stroke="#76baff" strokeWidth="2.2" opacity={0.45 + mix * 0.55} />
                    </svg>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, minmax(0, 1fr))', gap: 6 }}>
                        {waveforms.map((wf) => (
                            <button
                                key={`o1-${wf.idx}`}
                                type="button"
                                onClick={() => onParamChange('Osc1Wave', wf.idx)}
                                style={{
                                    border: wf.idx === osc1 ? '1px solid #5ce0a6' : '1px solid #3e5d53',
                                    borderRadius: 4,
                                    background: wf.idx === osc1 ? 'rgba(92, 224, 166, 0.18)' : 'rgba(24, 44, 37, 0.72)',
                                    color: wf.idx === osc1 ? '#d9ffee' : '#9ac4b2',
                                    fontSize: 10,
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    padding: '6px 4px',
                                }}
                            >
                                1:{wf.label}
                            </button>
                        ))}
                        {waveforms.map((wf) => (
                            <button
                                key={`o2-${wf.idx}`}
                                type="button"
                                onClick={() => onParamChange('Osc2Wave', wf.idx)}
                                style={{
                                    border: wf.idx === osc2 ? '1px solid #7abfff' : '1px solid #3f5671',
                                    borderRadius: 4,
                                    background: wf.idx === osc2 ? 'rgba(122, 191, 255, 0.18)' : 'rgba(26, 38, 53, 0.72)',
                                    color: wf.idx === osc2 ? '#e2f0ff' : '#a8bfd6',
                                    fontSize: 10,
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    padding: '6px 4px',
                                }}
                            >
                                2:{wf.label}
                            </button>
                        ))}
                    </div>
                </div>
                <div style={pluginPanelKnobGrid('repeat(10, minmax(0, 1fr))')}>
                    {device.params.map((p) => (
                        <PluginKnob
                            key={p.name}
                            param={p}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            compact
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'sampler' || device.effectType === 'instrument') {
        const otherSamplerParams = device.params
            .slice(0, 12);
        const sampleName = device.samplePath ? device.samplePath.split('/').pop() : null;
        return (
            <div style={{
                display: 'grid',
                gridTemplateRows: '102px auto',
                height: '100%',
                gap: 4,
                border: pluginPanelCardBaseStyle.border,
                borderRadius: 6,
                background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-3) 84%, #2f4058) 0%, color-mix(in srgb, var(--surface-2) 88%, #1c2735) 100%)',
                overflow: 'hidden',
            }}>
                <div
                    style={{
                        position: 'relative',
                        overflow: 'hidden',
                        borderBottom: '1px solid rgba(90,178,255,0.22)',
                    }}
                    onMouseUp={() => {
                        const dragging = useDragStore.getState().draggingItem;
                        const acceptance = dragging ? canDropInZone(dragging, 'sampler-surface') : { allowed: false };
                        if (dragging?.path && acceptance.allowed) {
                            onDropSample?.(dragging.path);
                            useDragStore.getState().endDrag();
                        }
                    }}
                >
                    <div style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-2) 90%, #0f1622) 0%, color-mix(in srgb, var(--surface-1) 90%, #0a101a) 100%)',
                    }} />
                    <svg
                        viewBox="0 0 1000 90"
                        preserveAspectRatio="none"
                        style={{ position: 'absolute', left: 8, right: 8, top: 18, height: 58, width: 'calc(100% - 16px)' }}
                    >
                        <defs>
                            <linearGradient id="samplerWaveFill" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="#ffcc58" stopOpacity="0.92" />
                                <stop offset="100%" stopColor="#f0a62a" stopOpacity="0.66" />
                            </linearGradient>
                        </defs>
                        <rect x="0" y="0" width="1000" height="90" fill="color-mix(in srgb, var(--surface-1) 90%, #0f1728)" />
                        {Array.from({ length: 18 }).map((_, i) => (
                            <line
                                key={`g-${i}`}
                                x1={(i / 17) * 1000}
                                y1={0}
                                x2={(i / 17) * 1000}
                                y2={90}
                                stroke="rgba(90,178,255,0.09)"
                                strokeWidth="1"
                            />
                        ))}
                        <line x1="0" y1="45" x2="1000" y2="45" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
                        {samplerWaveformPath ? (
                            <>
                                <path d={samplerWaveformPath} fill="url(#samplerWaveFill)" />
                                <path d={samplerWaveformPath} fill="none" stroke="rgba(255,214,110,0.85)" strokeWidth="1" />
                            </>
                        ) : (
                            <path
                                d="M 0 46 C 30 14, 60 78, 90 46 C 120 14, 150 78, 180 46 C 210 14, 240 78, 270 46 C 300 14, 330 78, 360 46 C 390 14, 420 78, 450 46 C 480 14, 510 78, 540 46 C 570 18, 600 74, 630 46 C 660 24, 690 68, 720 46 C 750 30, 780 62, 810 46 C 840 36, 870 56, 900 46 C 930 42, 960 50, 1000 46"
                                fill="none"
                                stroke="#ffbf3c"
                                strokeWidth="2.4"
                                strokeLinecap="round"
                            />
                        )}
                    </svg>
                    <div style={{
                        position: 'absolute',
                        left: 8,
                        top: 4,
                        color: '#d7dce7',
                        fontSize: 9,
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                        fontWeight: 700,
                    }}>
                        Sample
                    </div>
                    <div style={{
                        position: 'absolute',
                        left: 8,
                        right: 88,
                        bottom: 3,
                        color: sampleName ? '#9fb6d9' : '#a8b0bd',
                        fontSize: 9,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}>
                        {sampleName ?? 'Drop sample here or load from disk'}
                    </div>
                    <button
                        type="button"
                        onClick={() => onLoadSample?.()}
                        style={{
                            position: 'absolute',
                            right: 8,
                            top: 4,
                            border: '1px solid #4f668a',
                            borderRadius: 3,
                            background: 'linear-gradient(180deg, #33435b 0%, #27364b 100%)',
                            color: '#dce9ff',
                            fontSize: 9,
                            padding: '3px 7px',
                            cursor: 'pointer',
                        }}
                    >
                        Load
                    </button>
                </div>
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
                    gap: 8,
                    alignItems: 'center',
                    padding: '4px 8px 8px 8px',
                    background: 'rgba(16, 20, 28, 0.55)',
                }}>
                    {otherSamplerParams.map((p) => (
                        <PluginKnob
                            key={p.name}
                            param={p}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            compact
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'eq') {
        const isBandEq = guiMode.includes('eq-three') || pluginNameLower.includes('band eq');
        const eqTitle = isBandEq ? 'Band EQ' : 'EQ';
        const lowFreq = device.params.find((p) => p.name.toLowerCase() === 'lowfreq')?.value ?? 120;
        const low = device.params.find((p) => p.name.toLowerCase() === 'low')?.value ?? 0;
        const midFreq = device.params.find((p) => p.name.toLowerCase() === 'midfreq')?.value ?? 1800;
        const mid = device.params.find((p) => p.name.toLowerCase() === 'mid')?.value ?? 0;
        const highFreq = device.params.find((p) => p.name.toLowerCase() === 'highfreq')?.value ?? 9500;
        const high = device.params.find((p) => p.name.toLowerCase() === 'high')?.value ?? 0;
        const out = device.params.find((p) => p.name.toLowerCase() === 'out')?.value ?? 0;
        const norm = (v: number) => Math.max(-1, Math.min(1, v / 24));
        const normFreq = (freq: number, min: number, max: number) =>
            (Math.log10(Math.max(min, Math.min(max, freq))) - Math.log10(min)) / (Math.log10(max) - Math.log10(min));
        const yFromDb = (v: number) => 46 - norm(v) * 34;
        const xLow = 20 + normFreq(lowFreq, 20, 1200) * 140;
        const xMid = 170 + normFreq(midFreq, 120, 9000) * 150;
        const xHigh = 330 + normFreq(highFreq, 1200, 20000) * 130;
        const yL = yFromDb(low);
        const yM = yFromDb(mid);
        const yH = yFromDb(high);
        const curve = `M 0 ${yL.toFixed(2)} C 40 ${yL.toFixed(2)}, ${xLow - 32} ${yL.toFixed(2)} ${xLow} ${yL.toFixed(2)} C ${xLow + 45} ${yL.toFixed(2)}, ${xMid - 35} ${yM.toFixed(2)} ${xMid} ${yM.toFixed(2)} C ${xMid + 35} ${yM.toFixed(2)}, ${xHigh - 45} ${yH.toFixed(2)} ${xHigh} ${yH.toFixed(2)} C ${xHigh + 35} ${yH.toFixed(2)}, 450 ${yH.toFixed(2)} 480 ${yH.toFixed(2)}`;
        return (
            <div style={{ ...pluginPanelLayoutStyle, gridTemplateRows: '96px auto' }}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-eq)',
                    overflow: 'hidden',
                    padding: 0,
                }}>
                    <svg ref={eqSurfaceRef} width="100%" height="100%" viewBox="0 0 480 92" preserveAspectRatio="none">
                        {Array.from({ length: 12 }).map((_, i) => (
                            <line key={`vx-${i}`} x1={i * 40} y1={0} x2={i * 40} y2={92} stroke="rgba(90,178,255,0.12)" strokeWidth="1" />
                        ))}
                        {Array.from({ length: 5 }).map((_, i) => (
                            <line key={`hx-${i}`} x1={0} y1={i * 23} x2={480} y2={i * 23} stroke="rgba(90,178,255,0.12)" strokeWidth="1" />
                        ))}
                        {isBandEq && (
                            <>
                                <rect x={xLow - 10} y={0} width="2" height="92" fill="rgba(122,191,255,0.4)" />
                                <rect x={xHigh - 10} y={0} width="2" height="92" fill="rgba(255,172,89,0.4)" />
                            </>
                        )}
                        <path d={curve} fill="none" stroke="#d9a625" strokeWidth="3" strokeLinecap="round" />
                        <path d={curve} fill="none" stroke="rgba(217,166,37,0.22)" strokeWidth="10" strokeLinecap="round" />
                        <line x1="0" y1="46" x2="480" y2="46" stroke="rgba(90,178,255,0.18)" strokeWidth="1" />
                        {[
                            { key: 'low', x: xLow, y: yL, color: '#5ab2ff' },
                            { key: 'mid', x: xMid, y: yM, color: '#d9a625' },
                            { key: 'high', x: xHigh, y: yH, color: '#ff8b5b' },
                        ].map((band) => (
                            <g
                                key={band.key}
                                style={{ cursor: 'ns-resize' }}
                                onMouseDown={() => {
                                    const eqBand = band.key as 'low' | 'mid' | 'high';
                                    beginEqBandGesture(eqBand);
                                    setDragEqBand(eqBand);
                                }}
                            >
                                <circle cx={band.x} cy={band.y} r="9" fill="rgba(0,0,0,0.55)" stroke={band.color} strokeWidth="1.5" />
                                <circle cx={band.x} cy={band.y} r="3.2" fill={band.color} />
                            </g>
                        ))}
                    </svg>
                </div>
                <div style={pluginPanelKnobGrid('repeat(10, minmax(0, 1fr))')}>
                    {['LowFreq', 'Low', 'LowQ', 'MidFreq', 'Mid', 'MidQ', 'HighFreq', 'High', 'HighQ', 'Out'].map((name) => {
                        const p = device.params.find((x) => x.name.toLowerCase() === name.toLowerCase());
                        return p ? (
                            <PluginKnob
                                key={p.name}
                                param={p}
                                onChange={onParamChange}
                                onGestureStart={onParamGestureStart}
                                onGestureEnd={onParamGestureEnd}
                                compact
                            />
                        ) : null;
                    })}
                </div>
                <div style={{ ...pluginPanelMetaStyle, alignItems: 'center' }}>
                    <span>{eqTitle}</span>
                    <span>Low {lowFreq.toFixed(0)}Hz</span>
                    <span>Mid {midFreq.toFixed(0)}Hz</span>
                    <span>High {highFreq.toFixed(0)}Hz</span>
                    <span>Out {out.toFixed(1)}dB</span>
                </div>
            </div>
        );
    }

    if (device.effectType === 'utility') {
        const utilityTitle = guiMode.includes('tuner')
            ? 'Tuner'
            : guiMode.includes('external-audio-effect')
                ? 'External Audio Effect'
                : guiMode.includes('auto-shift')
                    ? 'Auto Shift'
                    : guiMode.includes('shifter')
                        ? 'Shifter'
                        : 'Utility';
        const isTuner = guiMode.includes('tuner');
        const isExternalFx = guiMode.includes('external-audio-effect');
        const isAutoShift = guiMode.includes('auto-shift');
        const isShifter = guiMode.includes('shifter');
        const gain = device.params.find((p) => p.name.toLowerCase() === 'gain')?.value ?? 0;
        const pan = device.params.find((p) => p.name.toLowerCase() === 'pan')?.value ?? 0;
        const width = device.params.find((p) => p.name.toLowerCase() === 'width')?.value ?? 100;
        const mono = (device.params.find((p) => p.name.toLowerCase() === 'mono')?.value ?? 0) > 0.5;
        const panPct = Math.max(-1, Math.min(1, pan / 100));
        const widthPct = Math.max(0, Math.min(1, width / 200));
        const shiftAmount = device.params.find((p) => p.name.toLowerCase().includes('shift'))?.value
            ?? device.params.find((p) => p.name.toLowerCase().includes('semitone'))?.value
            ?? 0;
        const hasUtilityCoreParams = device.params.some((p) => ['gain', 'pan', 'width', 'mono'].includes(p.name.toLowerCase()));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-utility)',
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 10,
                    alignItems: 'center',
                }}>
                    {hasUtilityCoreParams ? (
                        <>
                            <div>
                                <div style={{ fontSize: 9, color: '#9fa7b5', marginBottom: 4 }}>Pan</div>
                                <div style={{ position: 'relative', height: 8, borderRadius: 999, background: '#2a2a2a' }}>
                                    <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.2)' }} />
                                    <div style={{
                                        position: 'absolute',
                                        top: -3,
                                        left: `calc(${(panPct * 50 + 50).toFixed(3)}% - 5px)`,
                                        width: 10,
                                        height: 14,
                                        borderRadius: 4,
                                        background: '#56a7ff',
                                        boxShadow: '0 0 6px rgba(86,167,255,0.45)',
                                    }} />
                                </div>
                            </div>
                            <div>
                                <div style={{ fontSize: 9, color: '#9fa7b5', marginBottom: 4 }}>Stereo Width</div>
                                <div style={{ height: 8, borderRadius: 999, background: '#2a2a2a', overflow: 'hidden' }}>
                                    <div style={{
                                        width: `${(widthPct * 100).toFixed(2)}%`,
                                        height: '100%',
                                        background: mono ? '#9b9b9b' : 'linear-gradient(90deg, #2aa6ff 0%, #7dd1ff 100%)',
                                    }} />
                                </div>
                            </div>
                            <div style={{ ...pluginPanelTitleStyle, color: 'var(--color-text-secondary)' }}>
                                {utilityTitle}: <span style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono)' }}>{gain.toFixed(1)} dB</span>
                            </div>
                            <div style={{ ...pluginPanelTitleStyle, color: mono ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' }}>
                                {mono ? 'Mono Enabled' : 'Stereo'}
                            </div>
                            <div style={{ gridColumn: '1 / span 2', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                <button
                                    type="button"
                                    onClick={() => onApplyUtilityScene?.('center')}
                                    style={{ border: '1px solid var(--color-divider)', borderRadius: 4, background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 10, padding: '3px 8px', cursor: 'pointer' }}
                                >Center</button>
                                <button
                                    type="button"
                                    onClick={() => onApplyUtilityScene?.('mono')}
                                    style={{ border: '1px solid var(--color-divider)', borderRadius: 4, background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 10, padding: '3px 8px', cursor: 'pointer' }}
                                >Mono</button>
                                <button
                                    type="button"
                                    onClick={() => onApplyUtilityScene?.('wide')}
                                    style={{ border: '1px solid var(--color-divider)', borderRadius: 4, background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 10, padding: '3px 8px', cursor: 'pointer' }}
                                >Wide</button>
                            </div>
                        </>
                    ) : (
                        <>
                            <div style={{ gridColumn: '1 / span 2', ...pluginPanelTitleStyle, color: '#d9e3f2' }}>{utilityTitle}</div>
                            {isTuner && (
                                <div style={{ gridColumn: '1 / span 2', display: 'grid', gap: 4 }}>
                                    <div style={{ fontSize: 24, color: '#a9d2ff', fontFamily: 'var(--font-mono)', textAlign: 'center' }}>A</div>
                                    <div style={{ height: 8, borderRadius: 999, background: '#1f2a36', position: 'relative' }}>
                                        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: '#7ab6ff' }} />
                                    </div>
                                </div>
                            )}
                            {(isAutoShift || isShifter) && (
                                <div style={{ gridColumn: '1 / span 2', display: 'grid', gap: 4 }}>
                                    <div style={{ fontSize: 10, color: '#a5bed8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Shift</div>
                                    <div style={{ fontSize: 20, color: '#dce9ff', fontFamily: 'var(--font-mono)' }}>{shiftAmount.toFixed(1)} st</div>
                                </div>
                            )}
                            {isExternalFx && (
                                <div style={{ gridColumn: '1 / span 2', fontSize: 10, color: '#c2cfdb', lineHeight: 1.4 }}>
                                    External routing host. Use device params below for send/return balance and compensation.
                                </div>
                            )}
                        </>
                    )}
                </div>
                <div style={pluginPanelKnobGrid('repeat(4, minmax(0, 1fr))')}>
                    {device.params.slice(0, 4).map((p) => (
                        <PluginKnob
                            key={p.name}
                            param={p}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            compact
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (
        device.effectType === 'compressor'
    ) {
        const isTransientShaper = pluginNameLower.includes('transient shaper');
        const thr = device.params.find((p) => p.name.toLowerCase() === 'thr')?.value ?? -18;
        const ratio = device.params.find((p) => p.name.toLowerCase() === 'ratio')?.value ?? 4;
        const pseudoGr = Math.max(0, Math.min(24, ((-thr) / 60) * ratio * 2.4));
        const atkMs = device.params.find((p) => p.name.toLowerCase() === 'atk')?.value
            ?? device.params.find((p) => p.name.toLowerCase().includes('attack'))?.value
            ?? 10;
        const relMs = device.params.find((p) => p.name.toLowerCase() === 'rel')?.value
            ?? device.params.find((p) => p.name.toLowerCase().includes('release'))?.value
            ?? 80;
        const attackNorm = Math.max(0, Math.min(1, Math.log10(Math.max(0.1, atkMs)) / Math.log10(200)));
        const releaseNorm = Math.max(0, Math.min(1, Math.log10(Math.max(1, relMs)) / Math.log10(1000)));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-compressor)',
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    gap: 10,
                    alignItems: 'center',
                }}>
                    {isTransientShaper ? (
                        <div style={{ display: 'grid', gap: 6 }}>
                            <div style={{ ...pluginPanelTitleStyle, color: '#b9d7ff' }}>Transient Shaper</div>
                            <div style={{ height: 8, borderRadius: 999, background: 'rgba(18,26,34,0.9)', overflow: 'hidden' }}>
                                <div style={{ width: `${(attackNorm * 100).toFixed(1)}%`, height: '100%', background: 'linear-gradient(90deg, #53b0ff 0%, #8ecfff 100%)' }} />
                            </div>
                            <div style={{ height: 8, borderRadius: 999, background: 'rgba(18,26,34,0.9)', overflow: 'hidden' }}>
                                <div style={{ width: `${(releaseNorm * 100).toFixed(1)}%`, height: '100%', background: 'linear-gradient(90deg, #78d6ad 0%, #b5f0d5 100%)' }} />
                            </div>
                            <div style={pluginPanelMetaStyle}>
                                <span>Attack {atkMs.toFixed(1)} ms</span>
                                <span>Release {relMs.toFixed(1)} ms</span>
                            </div>
                        </div>
                    ) : (
                        <svg viewBox="0 0 280 86" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                            <rect x="0" y="0" width="280" height="86" fill="rgba(22,24,30,0.65)" />
                            <path d="M 14 70 L 120 70 Q 170 70 235 20 L 260 20" fill="none" stroke="#6ac3ff" strokeWidth="3" strokeLinecap="round" />
                            <line x1="14" y1="20" x2="14" y2="70" stroke="rgba(255,255,255,0.2)" />
                            <line x1="14" y1="70" x2="260" y2="70" stroke="rgba(255,255,255,0.2)" />
                        </svg>
                    )}
                    <div style={{ width: 46, height: 72, borderRadius: 4, background: '#1c1f24', border: '1px solid #3d434d', padding: 3 }}>
                        <div style={{ width: '100%', height: `${(pseudoGr / 24) * 100}%`, marginTop: `${100 - (pseudoGr / 24) * 100}%`, background: 'linear-gradient(180deg, #66cc33 0%, #ffcc1a 60%, #ff3333 100%)', borderRadius: 2 }} />
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.max(1, Math.min(4, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 4).map((p) => (
                        <PluginKnob
                            key={p.name}
                            param={p}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            compact
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'delay') {
        const delayTitle = guiMode.includes('echo')
            ? 'Echo'
            : guiMode.includes('beat-repeat')
                ? 'Beat Repeat'
                : guiMode.includes('looper')
                    ? 'Looper'
                    : guiMode.includes('spectral-time')
                        ? 'Spectral Time'
                        : 'Delay';
        const isBeatRepeat = delayTitle === 'Beat Repeat';
        const isLooper = delayTitle === 'Looper';
        const isSpectralTime = delayTitle === 'Spectral Time';
        const time = device.params.find((p) => p.name.toLowerCase() === 'time')?.value ?? 280;
        const fb = device.params.find((p) => p.name.toLowerCase() === 'fb')?.value ?? 30;
        const mix = device.params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? 35;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-delay)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(14,20,30,0.6)" />
                        {!isLooper && !isSpectralTime && !isBeatRepeat && Array.from({ length: 8 }).map((_, i) => {
                            const x = 16 + i * 36;
                            const h = 24 * Math.pow((fb / 100), i);
                            return <rect key={i} x={x} y={26 - h / 2} width="10" height={h} fill={i === 0 ? '#7cc4ff' : '#4a9eff'} opacity={0.95 - i * 0.08} rx="1.5" />;
                        })}
                        {isBeatRepeat && Array.from({ length: 16 }).map((_, i) => {
                            const x = 10 + i * 18;
                            const on = i % 4 === 0 || i % 7 === 0;
                            return <rect key={i} x={x} y={on ? 12 : 18} width="12" height={on ? 28 : 16} fill={on ? '#78c3ff' : 'rgba(120,170,230,0.35)'} rx="2" />;
                        })}
                        {isLooper && (
                            <>
                                <circle cx="160" cy="26" r="16" fill="none" stroke="rgba(124,196,255,0.45)" strokeWidth="2" />
                                <path d="M 160 10 A 16 16 0 1 1 148 16" fill="none" stroke="#7cc4ff" strokeWidth="3" strokeLinecap="round" />
                            </>
                        )}
                        {isSpectralTime && Array.from({ length: 24 }).map((_, i) => {
                            const x = 6 + i * 13;
                            const h = 8 + (Math.sin(i * 0.8) + 1) * 14;
                            return <rect key={i} x={x} y={26 - h / 2} width="8" height={h} fill="rgba(138,205,255,0.85)" rx="1.5" />;
                        })}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{delayTitle}</span>
                        <span>{time.toFixed(0)}ms</span>
                        <span>FB {fb.toFixed(0)}%</span>
                        <span>Mix {mix.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(6, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 6).map((p) => (
                        <PluginKnob
                            key={p.name}
                            param={p}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            compact
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'reverb') {
        const reverbTitle = guiMode.includes('hybrid-reverb')
            ? 'Hybrid Reverb'
            : guiMode.includes('corpus')
                ? 'Corpus'
                : guiMode.includes('resonators')
                    ? 'Resonators'
                    : guiMode.includes('spectral-resonator')
                        ? 'Spectral Resonator'
                        : 'Reverb';
        const decay = device.params.find((p) => p.name.toLowerCase() === 'decay')?.value ?? 45;
        const tone = device.params.find((p) => p.name.toLowerCase() === 'tone')?.value ?? 0;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-reverb)',
                }}>
                    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 4, background: 'rgba(10,10,12,0.45)' }}>
                        {Array.from({ length: 5 }).map((_, i) => (
                            <div
                                key={i}
                                style={{
                                    position: 'absolute',
                                    left: `${15 + i * 14}%`,
                                    top: '50%',
                                    width: `${24 + i * 12}px`,
                                    height: `${24 + i * 12}px`,
                                    marginTop: `${-(12 + i * 6)}px`,
                                    borderRadius: '50%',
                                    border: '1px solid rgba(192, 145, 255, 0.35)',
                                }}
                            />
                        ))}
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>{reverbTitle}</span>
                        <span>Decay {decay.toFixed(0)}%</span>
                        <span>Tone {tone.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(6, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 6).map((p) => (
                        <PluginKnob
                            key={p.name}
                            param={p}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            compact
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'chorus') {
        const rate = device.params.find((p) => p.name.toLowerCase() === 'rate')?.value ?? 1.2;
        const depth = device.params.find((p) => p.name.toLowerCase() === 'depth')?.value ?? 40;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-chorus)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(12, 11, 18, 0.65)" />
                        <path d="M 0 26 C 40 8, 80 44, 120 26 C 160 8, 200 44, 240 26 C 280 8, 320 44, 320 26" fill="none" stroke="#c867ff" strokeWidth="2.2" />
                        <path d="M 0 26 C 40 44, 80 8, 120 26 C 160 44, 200 8, 240 26 C 280 44, 320 8, 320 26" fill="none" stroke="#4ac0ff" strokeWidth="2.2" opacity="0.9" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{rate.toFixed(1)}Hz</span>
                        <span>Depth {depth.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(5, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 5).map((p) => (
                        <PluginKnob
                            key={p.name}
                            param={p}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            compact
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'saturator') {
        const satTitle = guiMode.includes('drum-buss')
            ? 'Drum Buss'
            : guiMode.includes('dynamic-tube')
                ? 'Dynamic Tube'
                : 'Saturator';
        const drive = device.params.find((p) => p.name.toLowerCase() === 'drive')?.value ?? 3;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-saturator)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(20, 13, 9, 0.7)" />
                        <path d="M 12 46 C 72 46, 112 6, 160 6 C 208 6, 248 46, 308 46" fill="none" stroke="#ffac59" strokeWidth={Math.max(2, 2 + drive / 8)} strokeLinecap="round" />
                    </svg>
                    <div style={pluginPanelMetaStyle}><span>{satTitle}</span><span>Drive {drive.toFixed(1)} dB</span></div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(4, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 4).map((p) => (
                        <PluginKnob
                            key={p.name}
                            param={p}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            compact
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'limiter') {
        const thr = device.params.find((p) => p.name.toLowerCase() === 'thr')?.value ?? -0.3;
        const ceil = device.params.find((p) => p.name.toLowerCase() === 'ceil')?.value ?? -0.1;
        const safety = Math.max(0, Math.min(1, 1 - Math.abs(thr - ceil) / 30));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-limiter)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#a4d9d3' }}>Lookahead Limiter</div>
                    <div style={{ height: 10, borderRadius: 999, background: '#222d2e', overflow: 'hidden' }}>
                        <div style={{ width: `${(safety * 100).toFixed(1)}%`, height: '100%', background: 'linear-gradient(90deg, #4bc4b2 0%, #89f0de 100%)' }} />
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>Thr {thr.toFixed(1)} dB</span>
                        <span>Ceil {ceil.toFixed(1)} dB</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid('repeat(3, minmax(0, 1fr))')}>
                    {device.params.slice(0, 3).map((p) => (
                        <PluginKnob
                            key={p.name}
                            param={p}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            compact
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'gate') {
        const thr = device.params.find((p) => p.name.toLowerCase() === 'thr')?.value ?? -40;
        const range = device.params.find((p) => p.name.toLowerCase() === 'range')?.value ?? -80;
        const openness = Math.max(0, Math.min(1, (80 + thr) / 80));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-gate)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#b8dfad' }}>Noise Gate</div>
                    <div style={{ height: 34, borderRadius: 4, background: '#1b2018', position: 'relative' }}>
                        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(openness * 100).toFixed(1)}%`, background: 'linear-gradient(90deg, #6bc66e 0%, #d2f18b 100%)' }} />
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>Thr {thr.toFixed(1)} dB</span>
                        <span>Range {range.toFixed(1)} dB</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid('repeat(5, minmax(0, 1fr))')}>
                    {device.params.slice(0, 5).map((p) => (
                        <PluginKnob
                            key={p.name}
                            param={p}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            compact
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'autoFilter' || device.effectType === 'autoPan' || device.effectType === 'phaser' || device.effectType === 'flanger') {
        const params = device.params;
        const isVocoder = guiMode.includes('vocoder');
        const title = isVocoder
            ? 'Vocoder'
            : device.effectType === 'autoFilter'
                ? 'Auto Filter'
                : device.effectType === 'autoPan'
                    ? 'Auto Pan'
                    : device.effectType === 'phaser'
                        ? 'Phaser'
                        : 'Flanger';
        const hue = device.effectType === 'autoFilter'
            ? '#4cc9d8'
            : device.effectType === 'autoPan'
                ? '#6db3ff'
                : device.effectType === 'phaser'
                    ? '#998bff'
                    : '#66b3ff';
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-mod)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(8, 10, 14, 0.65)" />
                        {!isVocoder && (
                            <path d="M 0 30 C 32 10, 64 46, 96 26 C 128 6, 160 44, 192 24 C 224 8, 256 42, 288 22 C 304 12, 320 26, 320 26" fill="none" stroke={hue} strokeWidth="2.4" />
                        )}
                        {isVocoder && Array.from({ length: 20 }).map((_, i) => {
                            const x = 8 + i * 15;
                            const h = 8 + ((i * 17) % 34);
                            return <rect key={i} x={x} y={42 - h} width="9" height={h} rx="1.5" fill="rgba(120,200,255,0.9)" />;
                        })}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{title}</span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{params.length} params</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(6, Math.max(3, params.length))}, minmax(0, 1fr))`)}>
                    {params.slice(0, 6).map((p) => (
                        <PluginKnob
                            key={p.name}
                            param={p}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            compact
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'distortion' || device.effectType === 'bitcrusher') {
        const title = device.effectType === 'bitcrusher'
            ? 'Bitcrusher'
            : guiMode.includes('amp')
                ? 'Amp'
                : guiMode.includes('cabinet')
                    ? 'Cabinet'
                    : guiMode.includes('erosion')
                        ? 'Erosion'
                    : guiMode.includes('overdrive')
                        ? 'Overdrive'
                        : guiMode.includes('pedal')
                            ? 'Pedal'
                            : guiMode.includes('roar')
                                ? 'Roar'
                                : 'Distortion';
        const color = device.effectType === 'distortion' ? '#ff965e' : '#f2de72';
        const drive = device.params.find((p) => p.name.toLowerCase() === 'drive')?.value ?? 0;
        const mix = device.params.find((p) => p.name.toLowerCase() === 'mix')?.value ?? 0;
        const tone = device.params.find((p) => p.name.toLowerCase() === 'tone')?.value ?? 0;
        const isAmp = title === 'Amp' || title === 'Cabinet';
        const isErosion = title === 'Erosion';
        const isBit = title === 'Bitcrusher';
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-distortion)',
                }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#d6c1a5' }}>{title}</div>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: 44 }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(20, 13, 9, 0.65)" />
                        {!isAmp && !isErosion && !isBit && (
                            <path d="M 8 44 L 48 12 L 88 44 L 128 12 L 168 44 L 208 12 L 248 44 L 312 16" fill="none" stroke={color} strokeWidth="2.2" />
                        )}
                        {isAmp && (
                            <>
                                {Array.from({ length: 7 }).map((_, i) => (
                                    <line key={i} x1={18 + i * 45} y1={8} x2={18 + i * 45} y2={44} stroke="rgba(255,170,110,0.35)" />
                                ))}
                                <path d="M 6 43 C 52 38, 86 16, 126 18 C 166 20, 210 42, 260 36 C 282 33, 302 29, 316 22" fill="none" stroke="#ffb57a" strokeWidth="2.4" />
                            </>
                        )}
                        {isErosion && (
                            <>
                                {Array.from({ length: 24 }).map((_, i) => {
                                    const x = 8 + i * 13;
                                    const h = 8 + ((i * 19) % 30);
                                    return <rect key={i} x={x} y={42 - h} width="6" height={h} rx="1" fill="rgba(255,156,94,0.82)" />;
                                })}
                            </>
                        )}
                        {isBit && (
                            <>
                                {Array.from({ length: 16 }).map((_, i) => {
                                    const x = 12 + i * 18;
                                    const high = i % 2 === 0 || i % 5 === 0;
                                    return <rect key={i} x={x} y={high ? 14 : 26} width="12" height={high ? 24 : 12} fill="rgba(242,222,114,0.9)" rx="1.5" />;
                                })}
                            </>
                        )}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>Drive {drive.toFixed(1)}</span>
                        <span>Tone {tone.toFixed(2)}</span>
                        <span>Mix {mix.toFixed(2)}</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(4, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 4).map((p) => (
                        <PluginKnob
                            key={p.name}
                            param={p}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            compact
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'noiseMachine') {
        const type = Math.round(device.params.find((p) => p.name.toLowerCase() === 'type')?.value ?? 0);
        const level = device.params.find((p) => p.name.toLowerCase() === 'level')?.value ?? -30;
        const stereo = device.params.find((p) => p.name.toLowerCase() === 'stereo')?.value ?? 0.5;
        const typeLabel = type <= 0 ? 'Vinyl' : type === 1 ? 'Air' : 'Storm';
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-noise)',
                }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#a5d6b0' }}>Noise Machine</div>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: 44 }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(12, 18, 12, 0.65)" />
                        <path d="M 4 26 L 12 10 L 20 38 L 28 18 L 36 42 L 44 14 L 52 34 L 60 8 L 68 40 L 76 20 L 84 36 L 92 12 L 100 44 L 108 16 L 116 38 L 124 22 L 132 40 L 140 10 L 148 34 L 156 18 L 164 42 L 172 14 L 180 36 L 188 8 L 196 40 L 204 20 L 212 38 L 220 12 L 228 44 L 236 16 L 244 34 L 252 22 L 260 40 L 268 10 L 276 38 L 284 18 L 292 42 L 300 14 L 308 36 L 316 26" fill="none" stroke="#72d68a" strokeWidth="1.6" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{typeLabel}</span>
                        <span>Level {level.toFixed(1)} dB</span>
                        <span>Stereo {(stereo * 100).toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(6, device.params.length)}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 6).map((p) => (
                        <PluginKnob
                            key={p.name}
                            param={p}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            compact
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'spectrum' || device.effectType === 'midiPitch' || device.effectType === 'midiScale' || device.effectType === 'midiVelocity' || device.effectType === 'midiRandom') {
        const title = device.effectType === 'spectrum'
            ? 'Spectrum'
            : device.effectType === 'midiPitch'
                ? 'MIDI Pitch'
                : device.effectType === 'midiScale'
                    ? (guiMode.includes('chord') ? 'Chord' : 'MIDI Scale')
                    : device.effectType === 'midiVelocity'
                        ? (guiMode.includes('note-length') ? 'Note Length' : guiMode.includes('cc-control') ? 'CC Control' : guiMode.includes('expression-control') ? 'Expression Control' : 'MIDI Velocity')
                        : (guiMode.includes('arpeggiator') ? 'Arpeggiator' : 'MIDI Random');
        const spectrumBars = Array.from({ length: 24 }).map((_, idx) => {
            const t = idx / 23;
            const h = 18 + Math.sin((idx + 1) * 0.62) * 9 + (1 - Math.abs(0.5 - t) * 2) * 20;
            return { x: 8 + idx * 13, h: Math.max(4, h) };
        });
        const semitones = device.params.find((p) => p.name.toLowerCase() === 'semitones')?.value ?? 0;
        const root = device.params.find((p) => p.name.toLowerCase() === 'root')?.value ?? 0;
        const chance = device.params.find((p) => p.name.toLowerCase() === 'chance')?.value ?? 0;
        const velGain = device.params.find((p) => p.name.toLowerCase() === 'gain')?.value ?? 1;
        const velOffset = device.params.find((p) => p.name.toLowerCase() === 'offset')?.value ?? 0;
        const isNoteLength = guiMode.includes('note-length');
        const isCcControl = guiMode.includes('cc-control');
        const isExpressionControl = guiMode.includes('expression-control');
        const isArp = guiMode.includes('arpeggiator');
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const activeRoot = Math.max(0, Math.min(11, Math.round(root) % 12));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-midi)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#b8c8e8' }}>{title}</div>
                    {device.effectType === 'spectrum' && (
                        <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: 46 }}>
                            <rect x="0" y="0" width="320" height="52" fill="rgba(8, 10, 14, 0.7)" />
                            {spectrumBars.map((bar, idx) => (
                                <rect
                                    key={idx}
                                    x={bar.x}
                                    y={46 - bar.h}
                                    width="8"
                                    height={bar.h}
                                    rx="1.2"
                                    fill={bar.h > 30 ? 'rgba(255,180,102,0.92)' : 'rgba(122,198,255,0.92)'}
                                />
                            ))}
                        </svg>
                    )}
                    {device.effectType === 'midiPitch' && (
                        <div style={{ display: 'grid', placeItems: 'center', height: 46 }}>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 24, color: '#95bdff' }}>
                                {semitones >= 0 ? '+' : ''}{semitones.toFixed(0)} st
                            </div>
                        </div>
                    )}
                    {device.effectType === 'midiScale' && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 3, height: 46, alignItems: 'center' }}>
                            {noteNames.map((n, idx) => (
                                <div
                                    key={n}
                                    style={{
                                        borderRadius: 3,
                                        border: idx === activeRoot ? '1px solid #8bc27a' : '1px solid rgba(255,255,255,0.14)',
                                        background: idx === activeRoot ? 'rgba(139,194,122,0.22)' : 'rgba(160,180,210,0.1)',
                                        color: idx === activeRoot ? '#d9f3d1' : '#a8b7cd',
                                        fontSize: 9,
                                        textAlign: 'center',
                                        padding: '3px 0',
                                    }}
                                >
                                    {n}
                                </div>
                            ))}
                        </div>
                    )}
                    {device.effectType === 'midiVelocity' && (
                        <div style={{ display: 'grid', gap: 6, height: 46 }}>
                            {isNoteLength ? (
                                <>
                                    <div style={{ height: 8, borderRadius: 999, background: '#1e2430', overflow: 'hidden' }}>
                                        <div style={{ width: `${Math.max(0, Math.min(100, velGain * 50)).toFixed(1)}%`, height: '100%', background: 'linear-gradient(90deg, #7ec8ff 0%, #a0e0ff 100%)' }} />
                                    </div>
                                    <div style={{ fontSize: 10, color: '#c5d7ea', fontFamily: 'var(--font-mono)' }}>Gate {(velGain * 100).toFixed(0)}%</div>
                                </>
                            ) : (
                                <>
                                    <div style={{ height: 8, borderRadius: 999, background: '#1e2430', overflow: 'hidden' }}>
                                        <div style={{ width: `${Math.max(0, Math.min(200, velGain * 100)).toFixed(1)}%`, height: '100%', background: 'linear-gradient(90deg, #7ec8ff 0%, #a0e0ff 100%)' }} />
                                    </div>
                                    <div style={{ height: 8, borderRadius: 999, background: '#1e2430', overflow: 'hidden', position: 'relative' }}>
                                        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.2)' }} />
                                        <div style={{
                                            position: 'absolute',
                                            left: `calc(${Math.max(0, Math.min(100, (velOffset + 64) / 128 * 100)).toFixed(1)}% - 5px)`,
                                            top: -2,
                                            width: 10,
                                            height: 12,
                                            borderRadius: 4,
                                            background: isCcControl || isExpressionControl ? '#8ecb7c' : '#d9a25c',
                                        }} />
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                    {device.effectType === 'midiRandom' && (
                        <div style={{ display: 'grid', alignItems: 'center', gap: 4, height: 46 }}>
                            <div style={{ height: 8, borderRadius: 999, background: '#1d1d2e', overflow: 'hidden' }}>
                                <div style={{ width: `${Math.max(0, Math.min(100, chance * 100)).toFixed(1)}%`, height: '100%', background: 'linear-gradient(90deg, #c58bdd 0%, #ecb4ff 100%)' }} />
                            </div>
                            <div style={{ fontSize: 10, color: '#cfa4e6', fontFamily: 'var(--font-mono)' }}>
                                {isArp
                                    ? `Arp Gate ${(chance * 100).toFixed(0)}% | Steps ${Math.max(1, Math.round(Math.abs(semitones) || 8))}`
                                    : `Chance ${(chance * 100).toFixed(0)}% | Range ±${Math.abs(semitones).toFixed(0)} st`}
                            </div>
                        </div>
                    )}
                    <div style={pluginPanelMetaStyle}>
                        <span>{device.effectType === 'spectrum' ? 'Analyzer (native)' : 'MIDI FX (import-compatible)'}</span>
                    </div>
                </div>
                {device.params.length > 0 && (
                    <div style={pluginPanelKnobGrid(`repeat(${Math.min(4, Math.max(2, device.params.length))}, minmax(0, 1fr))`)}>
                        {device.params.map((p) => (
                            <PluginKnob
                                key={p.name}
                                param={p}
                                onChange={onParamChange}
                                onGestureStart={onParamGestureStart}
                                onGestureEnd={onParamGestureEnd}
                                compact
                            />
                        ))}
                    </div>
                )}
            </div>
        );
    }


    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {device.params.map((p) => (
                <PluginKnob
                    key={p.name}
                    param={p}
                    onChange={onParamChange}
                    onGestureStart={onParamGestureStart}
                    onGestureEnd={onParamGestureEnd}
                    onContextMenu={onParamContextMenu}
                />
            ))}
        </div>
    );
};

const PluginSettingsPanel = ({
    device,
    onParamChange,
    onParamGestureStart,
    onParamGestureEnd,
    onApplyQuickPreset,
    onRandomize,
    onReset,
    onStoreSnapshot,
    onRecallSnapshot,
    onToggleSnapshot,
    snapshotState,
    onLoadSample,
    sidechainSourceTrackId = 'none',
    sidechainOptions = [],
    onSidechainSourceChange,
    runtimeStatus,
    editorSupported,
    editorReason,
}: {
    device: DeviceSlot;
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
    onApplyQuickPreset?: (preset: QuickPreset) => void;
    onRandomize?: () => void;
    onReset?: () => void;
    onStoreSnapshot?: (slot: 'A' | 'B') => void;
    onRecallSnapshot?: (slot: 'A' | 'B') => void;
    onToggleSnapshot?: () => void;
    snapshotState?: { A?: Record<string, number>; B?: Record<string, number>; active?: 'A' | 'B' };
    onApplyUtilityScene?: (scene: 'center' | 'mono' | 'wide') => void;
    onLoadSample?: () => void;
    sidechainSourceTrackId?: string;
    sidechainOptions?: Array<{ id: string; name: string }>;
    onSidechainSourceChange?: (sourceTrackId: string) => void;
    runtimeStatus?: engineApi.PluginSlotRuntimeStatus;
    editorSupported?: boolean;
    editorReason?: string;
}) => {
    const quickPresets = device.source === 'internal'
        ? (QUICK_PRESETS_BY_EFFECT[device.effectType] ?? [])
        : [];
    const [paramSearch, setParamSearch] = useState('');
    const filteredParams = useMemo(() => {
        const q = paramSearch.trim().toLowerCase();
        if (!q) return device.params;
        return device.params.filter((p) => p.name.toLowerCase().includes(q));
    }, [device.params, paramSearch]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {device.source === 'vst' && (
            <div style={{
                border: '1px solid var(--color-divider)',
                borderRadius: 'var(--radius-sm)',
                background: 'color-mix(in srgb, var(--color-bg-header) 88%, #0e1117)',
                padding: 8,
                display: 'grid',
                gap: 6,
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>
                        External Plugin
                    </span>
                    <span style={{
                        fontSize: 10,
                        fontWeight: 700,
                        borderRadius: 999,
                        border: '1px solid var(--color-divider)',
                        padding: '2px 7px',
                        color: runtimeStatus?.loaded ? '#7edb90' : '#ff9b9b',
                        background: runtimeStatus?.loaded
                            ? 'color-mix(in srgb, #7edb90 16%, transparent)'
                            : 'color-mix(in srgb, #ff7070 16%, transparent)',
                    }}>
                        {runtimeStatus?.loaded ? (runtimeStatus.runtime || 'loaded') : 'offline'}
                    </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                    <span>{device.params.length} mapped params</span>
                    <span>
                        {runtimeStatus?.latencyFrames != null
                            ? `Latency ${runtimeStatus.latencyFrames} fr`
                            : (editorSupported === false ? 'Native editor unavailable' : 'Inline editor')}
                    </span>
                </div>
                {editorReason && (
                    <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>{editorReason}</div>
                )}
                <input
                    value={paramSearch}
                    onChange={(e) => setParamSearch(e.target.value)}
                    placeholder="Find parameter..."
                    style={{
                        height: 24,
                        borderRadius: 5,
                        border: '1px solid var(--color-divider)',
                        background: 'var(--color-bg-panel)',
                        color: 'var(--color-text-primary)',
                        fontSize: 11,
                        padding: '0 8px',
                        outline: 'none',
                    }}
                />
            </div>
        )}
        {device.supportsSidechain && (
            <div
                style={{
                    display: 'grid',
                    gap: 4,
                    width: 240,
                    maxWidth: '100%',
                }}
            >
                <span
                    style={{
                        fontSize: 10,
                        color: 'var(--color-text-tertiary)',
                        fontWeight: 700,
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                    }}
                >
                    Side Chain
                </span>
                <select
                    value={sidechainSourceTrackId || 'none'}
                    onChange={(e) => onSidechainSourceChange?.(e.target.value)}
                    style={{
                        border: '1px solid var(--color-divider)',
                        borderRadius: 4,
                        background: 'var(--color-bg-header)',
                        color: 'var(--color-text-primary)',
                        fontSize: 11,
                        padding: '5px 7px',
                        outline: 'none',
                    }}
                >
                    <option value="none">None</option>
                    {sidechainOptions.map((track) => (
                        <option key={track.id} value={track.id}>{track.name}</option>
                    ))}
                </select>
            </div>
        )}
        {quickPresets.length > 0 && (
            <div style={{ display: 'grid', gap: 5 }}>
                <span style={{
                    fontSize: 10,
                    color: 'var(--color-text-tertiary)',
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                }}>
                    Quick Presets
                </span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {quickPresets.map((preset) => (
                        <button
                            key={preset.label}
                            type="button"
                            onClick={() => onApplyQuickPreset?.(preset)}
                            style={{
                                border: '1px solid var(--color-divider)',
                                borderRadius: 4,
                                background: 'var(--color-bg-header)',
                                color: 'var(--color-text-secondary)',
                                fontSize: 10,
                                padding: '4px 8px',
                                cursor: 'pointer',
                            }}
                        >
                            {preset.label}
                        </button>
                    ))}
                </div>
            </div>
        )}
        {device.source === 'internal' && (
            <div style={{ display: 'grid', gap: 5 }}>
                <span style={{
                    fontSize: 10,
                    color: 'var(--color-text-tertiary)',
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                }}>
                    Performance
                </span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                        type="button"
                        onClick={() => onRandomize?.()}
                        style={{ border: '1px solid var(--color-divider)', borderRadius: 4, background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 10, padding: '4px 8px', cursor: 'pointer' }}
                    >Random</button>
                    <button
                        type="button"
                        onClick={() => onReset?.()}
                        style={{ border: '1px solid var(--color-divider)', borderRadius: 4, background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 10, padding: '4px 8px', cursor: 'pointer' }}
                    >Reset</button>
                    <button
                        type="button"
                        onClick={() => onStoreSnapshot?.('A')}
                        style={{ border: '1px solid var(--color-divider)', borderRadius: 4, background: snapshotState?.active === 'A' ? 'color-mix(in srgb, var(--color-accent-primary) 25%, var(--color-bg-header))' : 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 10, padding: '4px 8px', cursor: 'pointer' }}
                    >Store A</button>
                    <button
                        type="button"
                        onClick={() => onStoreSnapshot?.('B')}
                        style={{ border: '1px solid var(--color-divider)', borderRadius: 4, background: snapshotState?.active === 'B' ? 'color-mix(in srgb, var(--color-accent-primary) 25%, var(--color-bg-header))' : 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 10, padding: '4px 8px', cursor: 'pointer' }}
                    >Store B</button>
                    <button
                        type="button"
                        onClick={() => onRecallSnapshot?.('A')}
                        disabled={!snapshotState?.A}
                        style={{ border: '1px solid var(--color-divider)', borderRadius: 4, background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 10, padding: '4px 8px', cursor: snapshotState?.A ? 'pointer' : 'not-allowed', opacity: snapshotState?.A ? 1 : 0.55 }}
                    >A</button>
                    <button
                        type="button"
                        onClick={() => onRecallSnapshot?.('B')}
                        disabled={!snapshotState?.B}
                        style={{ border: '1px solid var(--color-divider)', borderRadius: 4, background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 10, padding: '4px 8px', cursor: snapshotState?.B ? 'pointer' : 'not-allowed', opacity: snapshotState?.B ? 1 : 0.55 }}
                    >B</button>
                    <button
                        type="button"
                        onClick={() => onToggleSnapshot?.()}
                        disabled={!snapshotState?.A || !snapshotState?.B}
                        style={{ border: '1px solid var(--color-divider)', borderRadius: 4, background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 10, padding: '4px 8px', cursor: snapshotState?.A && snapshotState?.B ? 'pointer' : 'not-allowed', opacity: snapshotState?.A && snapshotState?.B ? 1 : 0.55 }}
                    >A/B</button>
                </div>
            </div>
        )}
        {device.effectType === 'sampler' && (
            <button
                type="button"
                onClick={() => onLoadSample?.()}
                style={{
                    width: 'fit-content',
                    border: '1px solid var(--color-divider)',
                    borderRadius: 4,
                    background: 'var(--color-bg-header)',
                    color: 'var(--color-text-secondary)',
                    fontSize: 11,
                    padding: '6px 10px',
                    cursor: 'pointer',
                }}
            >
                Load Sample
            </button>
        )}
        {filteredParams.length > 0 ? (
            <div style={pluginPanelKnobGrid(`repeat(${Math.min(10, Math.max(3, filteredParams.length))}, minmax(0, 1fr))`)}>
                {filteredParams.map((p) => (
                    <PluginKnob
                        key={p.name}
                        param={p}
                        onChange={onParamChange}
                        onGestureStart={onParamGestureStart}
                        onGestureEnd={onParamGestureEnd}
                        compact
                    />
                ))}
            </div>
        ) : (
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                border: '1px solid var(--color-divider)',
                borderRadius: 6,
                padding: '8px 10px',
                color: 'var(--color-text-secondary)',
                fontSize: 10,
            }}>
                <span>{device.params.length > 0 ? 'No parameters match filter' : 'No exported params'}</span>
                <span style={{ color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                    {filteredParams.length} params
                </span>
            </div>
        )}
        </div>
    );
};

// ── MeterBar (small vertical signal meter) ──────────────

const MeterBar = ({ level, isInput }: { level: number; isInput?: boolean }) => {
    const h = Math.max(0, Math.min(100, level * 100));
    const meterColor = level > 0.85 ? 'var(--color-meter-clip)' : level > 0.6 ? 'var(--color-meter-hot)' : 'var(--color-meter-normal)';

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            flexShrink: 0,
            alignSelf: 'stretch',
        }}>
            <div style={{
                width: 6,
                flex: 1,
                background: 'var(--color-meter-bg)',
                borderRadius: 1,
                position: 'relative',
                overflow: 'hidden',
            }}>
                <div style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    width: '100%',
                    height: `${h}%`,
                    background: isInput ? 'var(--color-midi-indicator)' : meterColor,
                    borderRadius: 1,
                    transition: 'height 0.08s linear',
                }} />
            </div>
        </div>
    );
};
