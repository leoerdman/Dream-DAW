import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { resolvePlugin, formatBadgeColor } from '@/shared/config/pluginManifest';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useDragStore } from '@/shared/stores/useDragStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import * as engineApi from '@/shared/api/engine';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { linearToMeterNorm, dbToMeterNorm } from '@/shared/lib/meterManifest';
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
    vuLevelL: number;
    vuLevelR: number;
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
        // Backend: 8 bands × 4 params (band*4+0=freq, band*4+1=gain, band*4+2=Q, band*4+3=enable) + param 32=output
        b0freq: 0, b0gain: 1, b0q: 2, b0en: 3,       // Band 0: Low Cut (HP)
        b1freq: 4, b1gain: 5, b1q: 6, b1en: 7,       // Band 1: Low Shelf
        b2freq: 8, b2gain: 9, b2q: 10, b2en: 11,     // Band 2: Peaking
        b3freq: 12, b3gain: 13, b3q: 14, b3en: 15,   // Band 3: Peaking
        b4freq: 16, b4gain: 17, b4q: 18, b4en: 19,   // Band 4: Peaking
        b5freq: 20, b5gain: 21, b5q: 22, b5en: 23,   // Band 5: Peaking
        b6freq: 24, b6gain: 25, b6q: 26, b6en: 27,   // Band 6: High Shelf
        b7freq: 28, b7gain: 29, b7q: 30, b7en: 31,   // Band 7: High Cut (LP)
        // Legacy 3-band aliases (for backward compat with existing presets):
        lowfreq: 4, low: 5, lowq: 6,
        midfreq: 12, mid: 13, midq: 14,
        highfreq: 24, high: 25, highq: 26,
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
    noiseMachine: { level: 0, type: 1, stereo: 2, lpfreq: 3, hpfreq: 4, pan: 5 },
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
        // Band 0: Low Cut (Highpass) — disabled by default
        { name: 'B0Freq', value: 30, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'B0Gain', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'B0Q', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'B0En', value: 0, min: 0, max: 1, suffix: '', step: 1 },
        // Band 1: Low Shelf
        { name: 'B1Freq', value: 100, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'B1Gain', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'B1Q', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'B1En', value: 1, min: 0, max: 1, suffix: '', step: 1 },
        // Band 2: Peaking
        { name: 'B2Freq', value: 250, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'B2Gain', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'B2Q', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'B2En', value: 1, min: 0, max: 1, suffix: '', step: 1 },
        // Band 3: Peaking
        { name: 'B3Freq', value: 800, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'B3Gain', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'B3Q', value: 1.0, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'B3En', value: 1, min: 0, max: 1, suffix: '', step: 1 },
        // Band 4: Peaking
        { name: 'B4Freq', value: 2500, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'B4Gain', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'B4Q', value: 1.0, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'B4En', value: 1, min: 0, max: 1, suffix: '', step: 1 },
        // Band 5: Peaking
        { name: 'B5Freq', value: 6000, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'B5Gain', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'B5Q', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'B5En', value: 1, min: 0, max: 1, suffix: '', step: 1 },
        // Band 6: High Shelf
        { name: 'B6Freq', value: 12000, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'B6Gain', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'B6Q', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'B6En', value: 1, min: 0, max: 1, suffix: '', step: 1 },
        // Band 7: High Cut (Lowpass) — disabled by default
        { name: 'B7Freq', value: 18000, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'B7Gain', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'B7Q', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'B7En', value: 0, min: 0, max: 1, suffix: '', step: 1 },
        // Output gain
        { name: 'Out', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        // Legacy aliases (for backward compat)
        { name: 'LowFreq', value: 120, min: 20, max: 1200, suffix: 'Hz', step: 1 },
        { name: 'Low', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'LowQ', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'MidFreq', value: 1800, min: 120, max: 9000, suffix: 'Hz', step: 1 },
        { name: 'Mid', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'MidQ', value: 1.0, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'HighFreq', value: 9500, min: 1200, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'High', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'HighQ', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
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
        { name: 'Tone', value: 40, min: 0, max: 100, suffix: '%', step: 1 },
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
        { name: 'Tone', value: 50, min: 0, max: 100, suffix: '%', step: 1 },
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
        { name: 'Res', value: 30, min: 0, max: 100, suffix: '%', step: 1 },
        { name: 'Rate', value: 1, min: 0.01, max: 20, suffix: 'Hz', step: 0.01 },
        { name: 'Depth', value: 50, min: 0, max: 100, suffix: '%', step: 1 },
        { name: 'Env', value: 0, min: -100, max: 100, suffix: '%', step: 1 },
        { name: 'Type', value: 0, min: 0, max: 3, suffix: '', step: 1 },
        { name: 'Mix', value: 100, min: 0, max: 100, suffix: '%', step: 1 },
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
        { name: 'Depth', value: 60, min: 0, max: 100, suffix: '%', step: 1 },
        { name: 'Fb', value: 50, min: -95, max: 95, suffix: '%', step: 1 },
        { name: 'Stages', value: 4, min: 2, max: 8, suffix: '', step: 2 },
        { name: 'Center', value: 1000, min: 100, max: 5000, suffix: 'Hz', step: 1 },
        { name: 'Mix', value: 50, min: 0, max: 100, suffix: '%', step: 1 },
    ],
    flanger: [
        { name: 'Rate', value: 0.3, min: 0.01, max: 10, suffix: 'Hz', step: 0.01 },
        { name: 'Depth', value: 70, min: 0, max: 100, suffix: '%', step: 1 },
        { name: 'Fb', value: 50, min: -95, max: 95, suffix: '%', step: 1 },
        { name: 'Delay', value: 2, min: 0.1, max: 10, suffix: 'ms', step: 0.1 },
        { name: 'Mix', value: 50, min: 0, max: 100, suffix: '%', step: 1 },
    ],
    distortion: [
        { name: 'Drive', value: 30, min: 0, max: 100, suffix: '', step: 1 },
        { name: 'Tone', value: 50, min: 0, max: 100, suffix: '%', step: 1 },
        { name: 'Mix', value: 100, min: 0, max: 100, suffix: '%', step: 1 },
        { name: 'Mode', value: 0, min: 0, max: 4, suffix: '', step: 1 },
    ],
    bitcrusher: [
        { name: 'Bits', value: 16, min: 1, max: 32, suffix: '', step: 1 },
        { name: 'Down', value: 1, min: 1, max: 64, suffix: 'x', step: 1 },
        { name: 'Mix', value: 100, min: 0, max: 100, suffix: '%', step: 1 },
    ],
    noiseMachine: [
        { name: 'Type', value: 0, min: 0, max: 5, suffix: '', step: 1 },
        { name: 'Level', value: -12, min: -60, max: 0, suffix: 'dB', step: 0.5 },
        { name: 'Stereo', value: 100, min: 0, max: 100, suffix: '%', step: 1 },
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

// vuNorm imported from '@/shared/lib/audioMath'

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
    type AdaptiveSender = {
        send: (value: number, pushUndoStep: boolean) => void;
        cancel: () => void;
    };
    type PendingGestureCommit = {
        source: 'internal' | 'vst';
        trackId: string;
        deviceId: string;
        paramName: string;
        value: number;
        paramIndex?: number;
    };
    const [localBypass, setLocalBypass] = useState<Record<string, boolean>>({});
    const [localParams, setLocalParams] = useState<Record<string, number>>({});
    const [pluginCapability, setPluginCapability] = useState<
        Record<string, { supported: boolean; reason?: string }>
    >({});
    const [pluginRuntimeBySlot, setPluginRuntimeBySlot] = useState<Record<string, engineApi.PluginSlotRuntimeStatus>>({});
    const [externalParamsBySlotId, setExternalParamsBySlotId] = useState<Record<string, PluginParam[]>>({});
    const [inlineSettingsOpen, setInlineSettingsOpen] = useState<Record<string, boolean>>({});
    const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
    // ── Plugin editor window persistence per track ──
    const openEditorsByTrack = useEngineStore((s) => s.openEditorsByTrack);
    const togglePluginEditor = useEngineStore((s) => s.togglePluginEditor);
    // closeAllPluginEditors removed — see cleanup notes at former BUG-012 block
    const prevTrackIdRef = useRef<string>(selectedTrackId);
    const [paramSnapshotsByDevice, setParamSnapshotsByDevice] = useState<
        Record<string, { A?: Record<string, number>; B?: Record<string, number>; active?: 'A' | 'B' }>
    >({});
    const statusError = useStatusStore((s) => s.setError);
    const statusClear = useStatusStore((s) => s.clear);
    const throttledParamSendsRef = useRef<Map<string, AdaptiveSender>>(new Map());
    const throttledExternalParamSendsRef = useRef<Map<string, AdaptiveSender>>(new Map());
    const adaptiveParamIntervalMsRef = useRef<number>(24);
    const pendingGestureCommitsRef = useRef<Map<string, Map<string, PendingGestureCommit>>>(new Map());
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

    // Get real-time stereo meter levels for the selected track
    const meterPair = isMaster ? null : (trackIndex >= 0 ? meters.tracks[trackIndex] : null);
    const inLevelL = isMaster
        ? dbToMeterNorm(meters.master_left.peak)
        : meterPair ? dbToMeterNorm(meterPair[0].peak) : 0;
    const inLevelR = isMaster
        ? dbToMeterNorm(meters.master_right.peak)
        : meterPair ? dbToMeterNorm(meterPair[1].peak) : 0;
    const outLevelL = inLevelL;
    const outLevelR = inLevelR;
    const outLevel = Math.max(outLevelL, outLevelR);

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

    // ── Close native editors on track leave, reopen on track return ──
    useEffect(() => {
        const prevId = prevTrackIdRef.current;
        prevTrackIdRef.current = selectedTrackId;
        if (prevId === selectedTrackId) return;

        // Close editors for the track we are leaving and clear their state.
        // BUG-4 FIX: Do NOT auto-reopen editors on track return, because the
        // macOS red close button can silently close the native window without
        // notifying the frontend. Clearing the state here means the user must
        // toggle the UI button to reopen — the correct UX.
        const prevSlots = openEditorsByTrack[prevId];
        if (prevSlots && prevSlots.size > 0 && prevId) {
            for (const slotId of prevSlots) {
                engineApi.closePluginWindowForSlot(prevId, slotId).catch((err) =>
                    console.warn('[DeviceRack] close editor on track leave failed:', err),
                );
            }
            // Clear the state so editors don't auto-reopen on re-entry.
            useEngineStore.setState((s) => ({
                openEditorsByTrack: { ...s.openEditorsByTrack, [prevId]: new Set<string>() },
            }));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedTrackId]);

    // NOTE: We intentionally do NOT close all plugin editors on DeviceRack
    // unmount. The panel switch (Shift+Tab: rack ↔ clip) unmounts/remounts
    // DeviceRack, and closing editors here would crash because the audio
    // thread is simultaneously calling process() on those plugin instances.
    // Editors are cleaned up by:
    //   - Track switch (useEffect above at line 558)
    //   - Project close (handled by PluginHostState::unload_all_instances)
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
                    vuLevelL: outLevelL,
                    vuLevelR: outLevelR,
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
            const pluginTypeHint = String(slot.type ?? '').toLowerCase();
            const isVst = pluginIdLower.includes('vst3')
                || pluginIdLower.includes('.vst')
                || pluginIdLower.includes('vst')
                || pluginTypeHint.includes('vst3')
                || pluginTypeHint.includes('vst');
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
                    defaultValue: template.value,
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
                        defaultValue: 0.5,
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
                vuLevelL: outLevelL,
                vuLevelR: outLevelR,
                pluginId,
                isVst,
                source: isInternal ? 'internal' : (isVst || pluginTypeHint.includes('vst')) ? 'vst' : 'unknown',
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
            console.log('[DeviceRack] setPluginSidechainSource:', {
                trackId: selectedTrack.id,
                slotId,
                sourceTrackId: sourceTrackId || 'none',
            });
            await engineApi.setPluginSidechainSource(selectedTrack.id, slotId, sourceTrackId || 'none');
            await fetchProject();
            statusClear();
        } catch (err) {
            console.error('[DeviceRack] setPluginSidechainSource failed:', err);
            const msg = err instanceof Error ? err.message : String(err);
            statusError(`Failed to set plugin sidechain source: ${msg}`);
        }
    }, [selectedTrack, fetchProject, statusClear, statusError]);

    const createAdaptiveParamSender = useCallback(
        (emit: (value: number, pushUndoStep: boolean) => Promise<void> | void): AdaptiveSender => {
            let timer: number | null = null;
            let pending: { value: number; pushUndoStep: boolean } | null = null;
            let lastSentAt = 0;

            const schedule = () => {
                if (timer != null || !pending) return;
                const now = performance.now();
                const delay = Math.max(0, adaptiveParamIntervalMsRef.current - (now - lastSentAt));
                timer = window.setTimeout(() => {
                    timer = null;
                    const payload = pending;
                    pending = null;
                    if (!payload) return;

                    const startedAt = performance.now();
                    lastSentAt = startedAt;
                    void Promise.resolve(emit(payload.value, payload.pushUndoStep))
                        .catch(() => {
                            // Errors are handled by caller.
                        })
                        .finally(() => {
                            const elapsed = Math.max(1, performance.now() - startedAt);
                            const target = Math.max(16, Math.min(48, elapsed * 1.25));
                            adaptiveParamIntervalMsRef.current =
                                adaptiveParamIntervalMsRef.current * 0.7 + target * 0.3;
                            if (pending) schedule();
                        });
                }, delay);
            };

            return {
                send: (value: number, pushUndoStep: boolean) => {
                    if (pushUndoStep) {
                        if (timer != null) {
                            window.clearTimeout(timer);
                            timer = null;
                        }
                        pending = null;
                        const startedAt = performance.now();
                        lastSentAt = startedAt;
                        void Promise.resolve(emit(value, true))
                            .catch(() => {
                                // Errors are handled by caller.
                            })
                            .finally(() => {
                                const elapsed = Math.max(1, performance.now() - startedAt);
                                const target = Math.max(16, Math.min(48, elapsed * 1.25));
                                adaptiveParamIntervalMsRef.current =
                                    adaptiveParamIntervalMsRef.current * 0.7 + target * 0.3;
                            });
                        return;
                    }

                    pending = {
                        value,
                        pushUndoStep: pending?.pushUndoStep === true ? true : false,
                    };
                    schedule();
                },
                cancel: () => {
                    if (timer != null) {
                        window.clearTimeout(timer);
                        timer = null;
                    }
                    pending = null;
                },
            };
        },
        [],
    );

    const ensureSlotRuntimeActive = useCallback(async (slotId: string) => {
        if (!selectedTrack) return null;
        const known = pluginRuntimeBySlot[slotId];
        if (known?.runtime === 'unsupported') {
            statusError(known.message ?? 'This plugin format is not supported by runtime in this build.');
            return null;
        }

        const runActivation = async () => {
            await engineApi.ensurePluginSlotActive(selectedTrack.id, slotId);
            const status = await engineApi.getPluginSlotRuntimeStatus(selectedTrack.id, slotId);
            setPluginRuntimeBySlot((prev) => ({ ...prev, [slotId]: status }));
            return status;
        };

        try {
            const status = await runActivation();
            statusClear();
            return status;
        } catch (err) {
            const firstMsg = errorMessage(err).toLowerCase();
            const shouldRescan = firstMsg.includes('cannot find native binary')
                || firstMsg.includes('plugin not found')
                || firstMsg.includes('failed to load plugin');
            if (shouldRescan) {
                try {
                    await engineApi.scanPluginFolders();
                    const status = await runActivation();
                    statusClear();
                    return status;
                } catch (retryErr) {
                    console.error('[DeviceRack] ensureSlotRuntimeActive retry failed:', retryErr);
                    statusError(`Plugin activation failed: ${errorMessage(retryErr)}`);
                    return null;
                }
            }

            console.error('[DeviceRack] ensureSlotRuntimeActive failed:', err);
            statusError(`Plugin activation failed: ${errorMessage(err)}`);
            return null;
        }
    }, [selectedTrack, pluginRuntimeBySlot, statusError, statusClear]);

    const toggleDevice = useCallback((device: DeviceSlot) => {
        const currentBypassed = localBypass[device.id] ?? !device.isEnabled;
        const nextBypassed = !currentBypassed;
        setLocalBypass((prev) => ({ ...prev, [device.id]: nextBypassed }));

        if (!selectedTrack) return;

        // Always update the project model bypass state for every plugin type.
        // This ensures rebuild_external_fx_snapshot respects bypass for external
        // plugins (VSTs), instruments, and internal effects alike.
        void engineApi.setSlotBypass(
            selectedTrack.id.toString(),
            device.id,
            nextBypassed,
        ).catch((err) => {
            console.error('[DeviceRack] setSlotBypass failed:', err);
        });

        // Internal effects also need the runtime device chain bypass sync.
        if (device.source === 'internal') {
            const trackIdx = projectTracks.findIndex((t) => t.id === selectedTrack.id);
            const slotIdx = selectedTrack.effects.findIndex((fx) => fx.id === device.id);
            if (trackIdx >= 0 && slotIdx >= 0) {
                void engineApi.bypassDevice(trackIdx, slotIdx, nextBypassed).catch((err) => {
                    console.error('[DeviceRack] bypassDevice failed:', err);
                });
            }
        }
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

            const effectiveGestureKey = options?.gestureKey
                ? (gestureGroupByParamKeyRef.current.get(options.gestureKey) ?? options.gestureKey)
                : undefined;
            const pushUndoStep = options?.forcePushUndo ?? (!effectiveGestureKey);

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

                const key = `${selectedTrack.id}:${device.id}:${paramIndex}`;
                let sender = throttledExternalParamSendsRef.current.get(key);
                if (!sender) {
                    sender = createAdaptiveParamSender(async (v: number, pushUndo: boolean) => {
                        await engineApi.setExternalPluginParamForSlot(selectedTrack.id, device.id, paramIndex, v, {
                            pushUndoStep: pushUndo,
                        });
                    });
                    throttledExternalParamSendsRef.current.set(key, sender);
                }

                sender.send(clamped, pushUndoStep);
                if (effectiveGestureKey) {
                    const bucket = pendingGestureCommitsRef.current.get(effectiveGestureKey) ?? new Map();
                    bucket.set(`${device.id}:${paramIndex}`, {
                        source: 'vst',
                        trackId: selectedTrack.id,
                        deviceId: device.id,
                        paramName,
                        value: clamped,
                        paramIndex,
                    });
                    pendingGestureCommitsRef.current.set(effectiveGestureKey, bucket);
                }
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

            let sender = throttledParamSendsRef.current.get(key);
            if (!sender) {
                sender = createAdaptiveParamSender(async (v: number, pushUndo: boolean) => {
                    await engineApi.setInternalPluginParam(
                        selectedTrack.id,
                        device.id,
                        scopedParamId,
                        v,
                        { pushUndoStep: pushUndo },
                    );
                });
                throttledParamSendsRef.current.set(key, sender);
            }
            sender.send(value, pushUndoStep);
            if (effectiveGestureKey) {
                const bucket = pendingGestureCommitsRef.current.get(effectiveGestureKey) ?? new Map();
                bucket.set(`${device.id}:${scopedParamId}`, {
                    source: 'internal',
                    trackId: selectedTrack.id,
                    deviceId: device.id,
                    paramName,
                    value,
                });
                pendingGestureCommitsRef.current.set(effectiveGestureKey, bucket);
            }
        },
        [selectedTrack, projectTracks, createAdaptiveParamSender],
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
        const commitKey = gestureGroupId ?? gestureKey;

        const pending = pendingGestureCommitsRef.current.get(commitKey);
        if (pending && pending.size > 0) {
            const entries = Array.from(pending.values());
            pendingGestureCommitsRef.current.delete(commitKey);
            // Final commit at gesture end: one undo/snapshot step per gesture.
            entries.forEach((entry, index) => {
                if (entry.source === 'vst') {
                    if (entry.paramIndex == null) return;
                    void engineApi.setExternalPluginParamForSlot(
                        entry.trackId,
                        entry.deviceId,
                        entry.paramIndex,
                        entry.value,
                        { pushUndoStep: index === 0 },
                    ).catch((err) => {
                        console.error('[DeviceRack] setExternalPluginParam(commit) failed:', err);
                    });
                    return;
                }

                const effectType = chain.find((d) => d.id === entry.deviceId)?.effectType;
                if (!effectType) return;
                const scopedParamId = `slot:${entry.deviceId}:${internalParamIdForControl(effectType, entry.paramName)}`;
                void engineApi.setInternalPluginParam(
                    entry.trackId,
                    entry.deviceId,
                    scopedParamId,
                    entry.value,
                    { pushUndoStep: index === 0 },
                ).catch((err) => {
                    console.error('[DeviceRack] setInternalPluginParam(commit) failed:', err);
                });
            });
        }

        activeParamGesturesRef.current.delete(gestureKey);
        pushedUndoForGestureRef.current.delete(gestureKey);
        if (gestureGroupId) {
            pushedUndoForGestureRef.current.delete(gestureGroupId);
            gestureGroupByParamKeyRef.current.delete(gestureKey);
        }
    }, [selectedTrack, chain]);

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
        pendingGestureCommitsRef.current.clear();
        throttledParamSendsRef.current.forEach((s) => s.cancel());
        throttledExternalParamSendsRef.current.forEach((s) => s.cancel());
        throttledParamSendsRef.current.clear();
        throttledExternalParamSendsRef.current.clear();
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
            e.stopImmediatePropagation();
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
                            defaultValue: (p.min + p.max) * 0.5,
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

    const visibleChain = chain;

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

                {/* ── Device Chain (horizontal scroll) ── */}
                <div className="scrollbar-hide" onClick={(e) => {
                    if (e.target === e.currentTarget) setSelectedDeviceIds([]);
                }} style={{
                    display: 'flex',
                    alignItems: 'stretch',
                    gap: 6,
                    padding: '10px',
                    flex: 1,
                    minHeight: 0,
                    overflowX: 'auto',
                    overflowY: 'hidden',
                }}>

                    {/* Input meter — real data */}
                    <MeterStrip levelL={inLevelL} levelR={inLevelR} isMidi={selectedTrack?.track_type === 'Midi'} />

                    {/* Device slots — drag to reorder */}
                    {visibleChain.length > 0 ? (
                        visibleChain.map((device, deviceIndex) => (
                            <div
                                key={device.id}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = 'move';
                                    // Show drop indicator
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const midX = rect.left + rect.width / 2;
                                    const isLeftHalf = e.clientX < midX;
                                    (e.currentTarget as HTMLElement).style.borderLeft = isLeftHalf ? '3px solid #5ab2ff' : '';
                                    (e.currentTarget as HTMLElement).style.borderRight = !isLeftHalf ? '3px solid #5ab2ff' : '';
                                }}
                                onDragLeave={(e) => {
                                    (e.currentTarget as HTMLElement).style.borderLeft = '';
                                    (e.currentTarget as HTMLElement).style.borderRight = '';
                                }}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    (e.currentTarget as HTMLElement).style.borderLeft = '';
                                    (e.currentTarget as HTMLElement).style.borderRight = '';
                                    const draggedId = e.dataTransfer.getData('application/x-dream-device-id');
                                    const fromIndex = parseInt(e.dataTransfer.getData('application/x-dream-device-index'), 10);
                                    if (!draggedId || isNaN(fromIndex) || fromIndex === deviceIndex) return;
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const midX = rect.left + rect.width / 2;
                                    const isLeftHalf = e.clientX < midX;
                                    let targetIdx = isLeftHalf ? deviceIndex : deviceIndex + 1;
                                    // Compensate for removal of source element
                                    if (fromIndex < targetIdx) targetIdx = Math.max(0, targetIdx - 1);
                                    if (selectedTrack) {
                                        void engineApi.moveEffectSlot(selectedTrack.id, draggedId, targetIdx)
                                            .then(() => fetchProject())
                                            .catch((err) => console.error('[DeviceRack] moveEffectSlot failed:', err));
                                    }
                                }}
                                className="dream-device-drop-indicator"
                                style={{ display: 'flex', flexShrink: 0, height: '100%', transition: 'border 0.1s ease', position: 'relative' }}
                            >
                                <DeviceNode
                                    device={device}
                                    deviceIndex={deviceIndex}
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
                                        await ensureSlotRuntimeActive(device.id);
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
                                    isNativeEditorOpen={!!(selectedTrack && openEditorsByTrack[selectedTrack.id]?.has(device.id))}
                                    onOpenGUI={async () => {
                                        console.log('[DeviceRack] onOpenGUI clicked device:', device.id, 'name:', device.name, 'source:', device.source, 'pluginId:', device.pluginId);
                                        selectDevice(device.id, false);
                                        if (!selectedTrack) {
                                            console.warn('[DeviceRack] onOpenGUI: no selectedTrack, aborting');
                                            return;
                                        }
                                        const trackId = selectedTrack.id;

                                        // BUG-012: Centralize editor toggling in useEngineStore to maintain 
                                        // Single Source of Truth (SSOT) and prevent double-terminate race conditions.
                                        try {
                                            if (device.source !== 'internal') {
                                                await ensureSlotRuntimeActive(device.id);
                                                await togglePluginEditor(trackId, device.id);
                                            } else {
                                                setInlineSettingsOpen((prev) => ({
                                                    ...prev,
                                                    [device.id]: !prev[device.id],
                                                }));
                                            }
                                            statusClear();
                                        } catch (err) {
                                            console.error('[DeviceRack] togglePluginEditor failed:', err);
                                            statusError(`Failed to open native plugin UI: ${errorMessage(err)}`);
                                        }
                                    }}
                                />
                                <MeterStrip levelL={linearToMeterNorm(device.vuLevelL ?? device.vuLevel)} levelR={linearToMeterNorm(device.vuLevelR ?? device.vuLevel)} />
                            </div>
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
                                Drop Files and Devices Here
                            </span>
                        </div>
                    )}

                    {/* Add device button */}
                    <button
                        onClick={() => {
                            window.dispatchEvent(new CustomEvent('dream:browser-set-search', {
                                detail: { categoryId: 'plugins', query: '' },
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
                            fontWeight: 'var(--font-weight-bold)' as unknown as number,
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
                        fontWeight: 'var(--font-weight-semibold)' as unknown as number,
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
    device, onToggle, onOpenGUI,
    deviceIndex,
    isSelected,
    isNativeEditorOpen,
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
    device: DeviceSlot;
    deviceIndex: number;
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
    isNativeEditorOpen?: boolean;
    editorSupported?: boolean;
    editorReason?: string;
    runtimeStatus?: engineApi.PluginSlotRuntimeStatus;
    onParamContextMenu?: (e: React.MouseEvent, paramName: string) => void;
    sidechainSourceTrackId?: string;
    sidechainOptions?: Array<{ id: string; name: string }>;
    onSidechainSourceChange?: (sourceTrackId: string) => void;
    onEnsureActive?: () => void;
}) => {
    // Resolve plugin metadata from centralized manifest (SSOT)
    const isInstrumentSlot = device.effectType === 'instrument' || device.effectType === 'sampler' || device.effectType === 'waveSynth';
    const manifest = resolvePlugin(device.pluginId, device.name, device.source, isInstrumentSlot);

    // Card dimensions — manifest provides the default, expand for settings
    const baseWidth = device.source === 'internal' && device.effectType === 'waveSynth'
        ? 980
        : device.source === 'internal' && device.effectType === 'eq'
            ? 540
            : manifest.cardWidth;
    const settingsWidth = Math.min(1460, Math.max(baseWidth, 280 + device.params.length * 110));
    const rackWidth = showSettings ? settingsWidth : baseWidth;
    const supportsSettingsToggle = manifest.supportsSettings;
    const pluginFormat = manifest.format;
    const showUiButton = manifest.hasEditor;
    const nativeEditorOpen = isNativeEditorOpen ?? false;
    const showRecoverAction = !!runtimeStatus && !runtimeStatus.loaded;

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
                border: isSelected ? '2px solid #ffffff' : '2px solid var(--color-bg-header)',
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
            {/* ── Unified Header: Enable → UI → Wrench → Name → Format ── */}
            <div
                draggable
                onDragStart={(e) => {
                    // Prevent drag when clicking interactive elements (buttons, inputs)
                    const target = e.target as HTMLElement;
                    if (target.closest('button, input, select, [data-no-drag]')) {
                        e.preventDefault();
                        return;
                    }
                    e.dataTransfer.setData('application/x-dream-device-id', device.id);
                    e.dataTransfer.setData('application/x-dream-device-index', String(deviceIndex));
                    e.dataTransfer.effectAllowed = 'move';
                    const slot = (e.currentTarget as HTMLElement).closest('.dream-device-drop-indicator') as HTMLElement | null;
                    if (slot) slot.style.opacity = '0.4';
                }}
                onDragEnd={() => {
                    const slot = document.querySelector('.dream-device-drop-indicator[style*="opacity"]') as HTMLElement | null;
                    if (slot) slot.style.opacity = '1';
                    document.querySelectorAll('.dream-device-drop-indicator').forEach((el) => {
                        (el as HTMLElement).style.borderLeft = '';
                        (el as HTMLElement).style.borderRight = '';
                    });
                }}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '3px 6px',
                    borderBottom: '1px solid var(--color-divider)',
                    background: 'var(--color-bg-header)',
                    cursor: 'grab',
                }}
                onClick={(e) => { e.stopPropagation(); onSelect(e); }}
            >
                {/* ● Enable toggle */}
                <button
                    draggable={false}
                    onClick={onToggle}
                    title={device.isEnabled ? 'Disable' : 'Enable'}
                    style={{
                        width: 11, height: 11,
                        borderRadius: '50%',
                        background: device.isEnabled ? 'var(--color-accent-primary)' : 'var(--color-text-tertiary)',
                        border: 'none',
                        cursor: 'pointer',
                        flexShrink: 0,
                    }}
                />
                {/* UI button — only for plugins with a native editor */}
                {showUiButton && (
                    <button
                        draggable={false}
                        onClick={(e) => { e.stopPropagation(); onOpenGUI?.(); }}
                        title={editorSupported === false
                            ? (editorReason ?? 'Native plugin editor is unavailable; opening inline controls')
                            : 'Open Native Plugin UI'}
                        style={headerIconBtnStyle(false, showSettings || nativeEditorOpen)}
                    >
                        UI
                    </button>
                )}
                {/* Fix button — only when plugin runtime is dead */}
                {showRecoverAction && (
                    <button
                        draggable={false}
                        onClick={(e) => { e.stopPropagation(); onEnsureActive?.(); }}
                        title="Recover plugin runtime"
                        style={headerIconBtnStyle(false)}
                    >
                        Fix
                    </button>
                )}
                {/* 🔧 Wrench — settings / params panel */}
                {supportsSettingsToggle && (
                    <button
                        draggable={false}
                        onClick={(e) => { e.stopPropagation(); onOpenSettings(); }}
                        title="Plugin Settings / Automatable Params"
                        style={headerIconBtnStyle(false, showSettings)}
                    >
                        🔧
                    </button>
                )}
                {/* Name — fills remaining space */}
                <span style={{
                    fontSize: 'var(--font-size-2xs)',
                    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                    color: 'var(--color-text-primary)',
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    textAlign: 'center',
                }}>
                    {device.name}
                </span>
                {/* Format badge */}
                <span style={{
                    fontSize: 'var(--font-size-micro)',
                    color: formatBadgeColor(pluginFormat),
                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
                    minWidth: 28,
                    textAlign: 'right',
                    flexShrink: 0,
                }}>
                    {pluginFormat}
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
                    padding: device.source === 'vst' ? 8 : 0,
                    flex: 1,
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: device.source === 'vst' ? 'flex-start' : 'center',
                    alignItems: 'center',
                    gap: 6,
                }}>
                    {/* Sidechain dropdown — shown for all external VST plugins */}
                    {device.source === 'vst' && (
                        <div style={{
                            display: 'grid',
                            gap: 4,
                            width: '100%',
                        }}>
                            <span style={{
                                fontSize: 'var(--font-size-2xs)',
                                color: 'var(--color-text-tertiary)',
                                fontWeight: 'var(--font-weight-bold)' as unknown as number,
                                letterSpacing: '0.04em',
                                textTransform: 'uppercase',
                            }}>
                                Side Chain
                            </span>
                            <select
                                value={sidechainSourceTrackId || 'none'}
                                onChange={(e) => onSidechainSourceChange?.(e.target.value)}
                                style={{
                                    border: '1px solid var(--color-divider)',
                                    borderRadius: 'var(--radius-md)',
                                    background: 'var(--color-bg-header)',
                                    color: 'var(--color-text-primary)',
                                    fontSize: 'var(--font-size-2xs)',
                                    padding: '4px 6px',
                                    outline: 'none',
                                    width: '100%',
                                }}
                            >
                                <option value="none">None</option>
                                {(sidechainOptions ?? []).map((track) => (
                                    <option key={track.id} value={track.id}>{track.name}</option>
                                ))}
                            </select>
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
        fontWeight: 'var(--font-weight-bold)' as unknown as number,
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
    fontWeight: 'var(--font-weight-bold)' as unknown as number,
};

const pluginPanelMetaStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 'var(--font-size-xs)',
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
        { label: 'Room', values: { decay: 26, tone: 32, 'dry/wet': 16 } },
        { label: 'Hall', values: { decay: 52, tone: 50, 'dry/wet': 24 } },
        { label: 'Shimmer', values: { decay: 72, tone: 76, 'dry/wet': 34 } },
    ],
    chorus: [
        { label: 'Subtle', values: { rate: 0.8, depth: 24, mix: 18 } },
        { label: 'Wide', values: { rate: 1.2, depth: 44, mix: 35 } },
        { label: 'Vintage', values: { rate: 0.45, depth: 60, mix: 42 } },
    ],
    saturator: [
        { label: 'Soft', values: { drive: 2.4, tone: 42, mix: 80 } },
        { label: 'Warm', values: { drive: 5.5, tone: 34, mix: 88 } },
        { label: 'Hard', values: { drive: 10.5, tone: 68, mix: 92 } },
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
        { label: 'Sweep', values: { cutoff: 1800, res: 38, rate: 0.8, depth: 55, mix: 95 } },
        { label: 'Wobble', values: { cutoff: 320, res: 52, rate: 3.2, depth: 80, mix: 100 } },
        { label: 'Subtle', values: { cutoff: 4200, res: 20, rate: 0.3, depth: 22, mix: 68 } },
    ],
    autoPan: [
        { label: 'Slow', values: { rate: 0.35, depth: 45, phase: 180, mix: 85 } },
        { label: 'Wide', values: { rate: 0.9, depth: 80, phase: 180, mix: 100 } },
        { label: 'Chop', values: { rate: 5.8, depth: 100, phase: 0, mix: 100 } },
    ],
    phaser: [
        { label: 'Classic', values: { rate: 0.7, depth: 65, fb: 20, mix: 60 } },
        { label: 'Deep', values: { rate: 0.24, depth: 92, fb: 45, mix: 72 } },
        { label: 'Fast', values: { rate: 2.5, depth: 50, fb: 15, mix: 48 } },
    ],
    flanger: [
        { label: 'Tape', values: { rate: 0.2, depth: 40, fb: 22, mix: 35 } },
        { label: 'Jet', values: { rate: 0.55, depth: 75, fb: 48, mix: 62 } },
        { label: 'Subtle', values: { rate: 0.16, depth: 24, fb: 10, mix: 28 } },
    ],
    distortion: [
        { label: 'Edge', values: { drive: 22, tone: 58, mix: 70 } },
        { label: 'Crunch', values: { drive: 38, tone: 50, mix: 86 } },
        { label: 'Destroy', values: { drive: 64, tone: 68, mix: 100 } },
    ],
    bitcrusher: [
        { label: 'Soft', values: { bits: 10, down: 1.4, mix: 42 } },
        { label: 'Retro', values: { bits: 7, down: 3.2, mix: 64 } },
        { label: 'Crush', values: { bits: 4, down: 8, mix: 90 } },
    ],
    noiseMachine: [
        { label: 'Vinyl', values: { type: 0, level: -30, stereo: 20 } },
        { label: 'Air', values: { type: 1, level: -34, stereo: 65 } },
        { label: 'Storm', values: { type: 2, level: -20, stereo: 75 } },
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
    if (Number.isFinite(param.defaultValue)) {
        return clampAndSnapParamValue(param, param.defaultValue as number);
    }
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

/* ── Module-level EQ filter type cache (persists across component remounts) ── */
const eqFilterTypeCache = new Map<string, string[]>();

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
    const [dragEqBand, setDragEqBand] = useState<number | null>(null);
    const [selectedEqBand, setSelectedEqBand] = useState<number | null>(null);
    const [eqContextMenu, setEqContextMenu] = useState<{ x: number; y: number; bandIdx: number } | null>(null);
    // Persist EQ filter types across component remounts via module-level cache
    const [eqBandFilterTypes, setEqBandFilterTypes] = useState<string[]>(() => {
        const cached = eqFilterTypeCache.get(device.id);
        return cached ?? ['highpass', 'lowshelf', 'peaking', 'peaking', 'peaking', 'peaking', 'highshelf', 'lowpass'];
    });
    useEffect(() => { eqFilterTypeCache.set(device.id, eqBandFilterTypes); }, [device.id, eqBandFilterTypes]);
    const guiMode = (device.guiMode || '').toLowerCase();
    const normalizedInternalId = normalizeInternalPluginId(device.pluginId || guiMode || device.name.toLowerCase());

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

    /* ── 8-band EQ gesture helpers ── */
    const beginEqBandGesture = useCallback((bandIdx: number) => {
        const gestureGroupId = `${device.id}:eq-band:${bandIdx}:${Date.now()}`;
        onParamGestureStart?.(`B${bandIdx}Freq`, gestureGroupId);
        onParamGestureStart?.(`B${bandIdx}Gain`, gestureGroupId);
    }, [device.id, onParamGestureStart]);

    const endEqBandGesture = useCallback((bandIdx: number) => {
        onParamGestureEnd?.(`B${bandIdx}Freq`);
        onParamGestureEnd?.(`B${bandIdx}Gain`);
    }, [onParamGestureEnd]);

    useEffect(() => {
        if (dragEqBand === null) return;
        const bandIdx = dragEqBand;
        const onMove = (e: MouseEvent) => {
            const surface = eqSurfaceRef.current;
            if (!surface) return;
            const rect = surface.getBoundingClientRect();
            const xNorm = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
            const yNorm = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
            const gainValue = ((rect.height / 2 - yNorm) / (rect.height / 2)) * 24;
            const roundedGain = Math.max(-24, Math.min(24, gainValue));
            // Universal logarithmic frequency interpolation 20Hz–20kHz
            const minF = Math.log10(20);
            const maxF = Math.log10(20000);
            const freq = Math.pow(10, minF + xNorm * (maxF - minF));
            onParamChange(`B${bandIdx}Gain`, roundedGain);
            onParamChange(`B${bandIdx}Freq`, Math.round(freq));
        };
        const onUp = () => {
            endEqBandGesture(bandIdx);
            setDragEqBand(null);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [dragEqBand, onParamChange, endEqBandGesture]);

    // Close context menu on click outside
    useEffect(() => {
        if (!eqContextMenu) return;
        const handler = () => setEqContextMenu(null);
        window.addEventListener('mousedown', handler);
        return () => window.removeEventListener('mousedown', handler);
    }, [eqContextMenu]);

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
                        <span style={{ ...pluginPanelTitleStyle, fontSize: 'var(--font-size-xs)', color: '#d3efe3' }}>
                            Essence
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 'var(--font-size-xs)', color: '#80d7b0', fontFamily: 'var(--font-mono)' }}>
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
                                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
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
                                    fontSize: 'var(--font-size-2xs)',
                                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
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
                        <div style={{ fontSize: 'var(--font-size-2xs)', color: '#8fd6b4', fontFamily: 'var(--font-mono)' }}>OSC1 {waveformLabel(osc1)}</div>
                        <div style={{ fontSize: 'var(--font-size-2xs)', color: '#9bc6ff', fontFamily: 'var(--font-mono)' }}>OSC2 {waveformLabel(osc2)}</div>
                        <div style={{ fontSize: 'var(--font-size-2xs)', color: '#a4d5c0', fontFamily: 'var(--font-mono)' }}>Detune {detune.toFixed(1)}ct</div>
                        <div style={{ fontSize: 'var(--font-size-2xs)', color: '#a4d5c0', fontFamily: 'var(--font-mono)' }}>Sub {(sub * 100).toFixed(0)}%</div>
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
                                    borderRadius: 'var(--radius-md)',
                                    background: wf.idx === osc1 ? 'rgba(92, 224, 166, 0.18)' : 'rgba(24, 44, 37, 0.72)',
                                    color: wf.idx === osc1 ? '#d9ffee' : '#9ac4b2',
                                    fontSize: 'var(--font-size-xs)',
                                    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
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
                                    borderRadius: 'var(--radius-md)',
                                    background: wf.idx === osc2 ? 'rgba(122, 191, 255, 0.18)' : 'rgba(26, 38, 53, 0.72)',
                                    color: wf.idx === osc2 ? '#e2f0ff' : '#a8bfd6',
                                    fontSize: 'var(--font-size-xs)',
                                    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
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
                borderRadius: 'var(--radius-lg)',
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
                        fontSize: 'var(--font-size-2xs)',
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                        fontWeight: 'var(--font-weight-bold)' as unknown as number,
                    }}>
                        Sample
                    </div>
                    <div style={{
                        position: 'absolute',
                        left: 8,
                        right: 88,
                        bottom: 3,
                        color: sampleName ? '#9fb6d9' : '#a8b0bd',
                        fontSize: 'var(--font-size-2xs)',
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
                            borderRadius: 'var(--radius-sm)',
                            background: 'linear-gradient(180deg, #33435b 0%, #27364b 100%)',
                            color: '#dce9ff',
                            fontSize: 'var(--font-size-2xs)',
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
        const EQ_FILTER_LABELS: Record<string, string> = {
            highpass: 'HP', lowshelf: 'L.Shelf', peaking: 'Bell',
            highshelf: 'H.Shelf', lowpass: 'LP', notch: 'Notch',
        };
        // Filter type SVG icon paths — properly scaled 12×12 mini-icons
        const EQ_FILTER_ICONS: Record<string, string> = {
            highpass: 'M1 11 C2 11 3 10 4 8 C5 5 6 3 7 3 L11 3',
            lowpass: 'M1 3 L5 3 C6 3 7 5 8 8 C9 10 10 11 11 11',
            lowshelf: 'M1 9 C2 9 3 8 4 7 C5 5 5 3 6 3 L11 3',
            highshelf: 'M1 3 L6 3 C7 3 7 5 8 7 C9 8 10 9 11 9',
            peaking: 'M1 8 C3 8 4 3 6 3 C8 3 9 8 11 8',
            notch: 'M1 3 C3 3 4 3 5 9 C5.5 11 6.5 11 7 9 C8 3 9 3 11 3',
        };
        const EQ_BAND_COLORS = [
            '#e06cf5', '#5ab2ff', '#5cf5e0', '#d9a625', '#ff8b5b', '#7ceb8a', '#ff5c5c', '#f0c430',
        ];
        const eqTitle = normalizedInternalId === 'internal://effect/eq-three' ? 'Band EQ' : 'EQ';

        /* ── Read all 8 bands from device params ── */
        interface EqBand8 { idx: number; freq: number; gain: number; q: number; enabled: boolean; filterType: string; color: string }
        const bands: EqBand8[] = [];
        for (let i = 0; i < 8; i++) {
            const freq = device.params.find((p) => p.name.toLowerCase() === `b${i}freq`)?.value ?? [30, 100, 250, 800, 2500, 6000, 12000, 18000][i];
            const gain = device.params.find((p) => p.name.toLowerCase() === `b${i}gain`)?.value ?? 0;
            const q = device.params.find((p) => p.name.toLowerCase() === `b${i}q`)?.value ?? 0.71;
            const en = device.params.find((p) => p.name.toLowerCase() === `b${i}en`)?.value ?? 0;
            bands.push({ idx: i, freq, gain, q, enabled: en > 0.5, filterType: eqBandFilterTypes[i], color: EQ_BAND_COLORS[i] });
        }
        const out = device.params.find((p) => p.name.toLowerCase() === 'out')?.value ?? 0;
        const activeBandIdx = selectedEqBand ?? dragEqBand ?? 2;

        /* ── Coordinate helpers ── */
        const VB_W = 480;
        const VB_H = 200;
        const MARGIN_L = 8;
        const MARGIN_R = 8;
        const plotW = VB_W - MARGIN_L - MARGIN_R;

        const freqToX = (freq: number) => {
            const minF = Math.log10(20);
            const maxF = Math.log10(20000);
            return MARGIN_L + ((Math.log10(Math.max(20, Math.min(20000, freq))) - minF) / (maxF - minF)) * plotW;
        };
        const xToFreq = (x: number) => {
            const minF = Math.log10(20);
            const maxF = Math.log10(20000);
            const norm = Math.max(0, Math.min(1, (x - MARGIN_L) / plotW));
            return Math.pow(10, minF + norm * (maxF - minF));
        };
        const gainToY = (gain: number) => {
            const clamped = Math.max(-24, Math.min(24, gain));
            return VB_H / 2 - (clamped / 24) * (VB_H / 2 - 10);
        };

        /* ── Build smooth EQ curve from enabled bands ── */
        const curvePoints: string[] = [];
        const steps = 200;
        for (let i = 0; i <= steps; i++) {
            const x = MARGIN_L + (i / steps) * plotW;
            const freq = xToFreq(x);
            let totalGain = 0;
            for (const band of bands) {
                if (!band.enabled) continue;
                const octaves = Math.log2(freq / band.freq);
                const bw = 1 / Math.max(0.1, band.q);
                // Shape response based on filter type — proper audio filter curves
                if (band.filterType === 'highpass') {
                    // 2nd-order Butterworth-style HP: continuous rolloff below cutoff
                    if (freq < band.freq) {
                        const ratio = freq / band.freq;
                        const order = Math.max(1, band.q * 2); // Q controls steepness
                        totalGain -= 24 * (1 - Math.pow(ratio, order * 2) / (1 + Math.pow(ratio, order * 2)));
                    }
                } else if (band.filterType === 'lowpass') {
                    // 2nd-order Butterworth-style LP: continuous rolloff above cutoff
                    if (freq > band.freq) {
                        const ratio = band.freq / freq;
                        const order = Math.max(1, band.q * 2);
                        totalGain -= 24 * (1 - Math.pow(ratio, order * 2) / (1 + Math.pow(ratio, order * 2)));
                    }
                } else if (band.filterType === 'lowshelf') {
                    // Low shelf: smooth sigmoid transition, gain below cutoff
                    const transition = 1 / (1 + Math.pow(freq / band.freq, 2 * Math.max(0.5, band.q)));
                    totalGain += band.gain * transition;
                } else if (band.filterType === 'highshelf') {
                    // High shelf: smooth sigmoid transition, gain above cutoff
                    const transition = 1 / (1 + Math.pow(band.freq / freq, 2 * Math.max(0.5, band.q)));
                    totalGain += band.gain * transition;
                } else if (band.filterType === 'notch') {
                    // Notch: narrow rejection band
                    const narrowBw = bw * 0.12;
                    totalGain -= Math.abs(band.gain || 12) * Math.exp(-0.5 * Math.pow(octaves / narrowBw, 2));
                } else {
                    // Peaking (bell): symmetric boost/cut
                    totalGain += band.gain * Math.exp(-0.5 * Math.pow(octaves / (bw * 0.5), 2));
                }
            }
            const y = gainToY(totalGain);
            curvePoints.push(`${x.toFixed(2)},${y.toFixed(2)}`);
        }
        const curvePath = `M ${curvePoints.join(' L ')}`;
        const fillPath = `${curvePath} L ${VB_W - MARGIN_R},${VB_H / 2} L ${MARGIN_L},${VB_H / 2} Z`;

        /* ── Frequency grid labels ── */
        const freqLabels = [
            { freq: 30, label: '30' }, { freq: 50, label: '50' }, { freq: 100, label: '100' },
            { freq: 200, label: '200' }, { freq: 500, label: '500' }, { freq: 1000, label: '1k' },
            { freq: 2000, label: '2k' }, { freq: 5000, label: '5k' }, { freq: 10000, label: '10k' },
            { freq: 20000, label: '20k' },
        ];

        /* ── Resolve knob params for active band ── */
        const bi = activeBandIdx;
        const freqParam = device.params.find((x) => x.name.toLowerCase() === `b${bi}freq`);
        const gainParam = device.params.find((x) => x.name.toLowerCase() === `b${bi}gain`);
        const qParam = device.params.find((x) => x.name.toLowerCase() === `b${bi}q`);
        const outParam = device.params.find((x) => x.name.toLowerCase() === 'out');
        const activeBand = bands[activeBandIdx];
        const enabledBands = bands.filter(b => b.enabled);

        return (
            <div style={{ display: 'flex', gap: 6, height: '100%' }}>
                {/* ── Left sidebar: Knobs + band controls ── */}
                <div style={{
                    width: 110,
                    flexShrink: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    padding: '6px 4px',
                    background: 'var(--color-bg-secondary)',
                    borderRadius: 'var(--plugin-card-radius)',
                    border: '1px solid var(--plugin-card-border)',
                }}>
                    {/* Active band indicator */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 6px',
                        borderRadius: 4,
                        background: activeBand ? `${activeBand.color}18` : 'transparent',
                        border: activeBand ? `1px solid ${activeBand.color}40` : '1px solid transparent',
                    }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: activeBand?.color ?? '#666' }} />
                        <span style={{ fontSize: 10, color: activeBand?.color ?? '#888', fontWeight: 600, fontFamily: 'Inter, sans-serif' }}>
                            {activeBand ? `Band ${activeBandIdx + 1}` : 'No Band'}
                        </span>
                    </div>

                    {/* Filter type selector for active band */}
                    {activeBand && (
                        <select
                            value={activeBand.filterType}
                            onChange={(e) => {
                                setEqBandFilterTypes(prev => {
                                    const next = [...prev];
                                    next[activeBandIdx] = e.target.value;
                                    return next;
                                });
                            }}
                            style={{
                                background: 'var(--color-bg-input, #181c24)',
                                color: activeBand.color,
                                border: '1px solid rgba(90,178,255,0.15)',
                                borderRadius: 4,
                                fontSize: 10,
                                fontWeight: 600,
                                padding: '3px 4px',
                                cursor: 'pointer',
                                fontFamily: 'Inter, sans-serif',
                            }}
                        >
                            {Object.entries(EQ_FILTER_LABELS).map(([type, label]) => (
                                <option key={type} value={type}>{label}</option>
                            ))}
                        </select>
                    )}

                    {/* Knobs */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, justifyContent: 'center' }}>
                        {freqParam && <PluginKnob key={`freq-${bi}`} param={{ ...freqParam, name: 'Freq' }} onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} compact />}
                        {gainParam && <PluginKnob key={`gain-${bi}`} param={{ ...gainParam, name: 'Gain' }} onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} compact />}
                        {qParam && <PluginKnob key={`q-${bi}`} param={{ ...qParam, name: 'Q' }} onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} compact />}
                        {outParam && <PluginKnob key="out" param={outParam} onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} compact />}
                    </div>

                    {/* Active bands count */}
                    <div style={{ fontSize: 9, color: 'rgba(160,190,220,0.4)', textAlign: 'center', fontFamily: 'Inter, sans-serif' }}>
                        {enabledBands.length}/8 bands
                    </div>
                </div>

                {/* ── Right: EQ graph + band strip ── */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{
                        ...pluginPanelCardBaseStyle,
                        background: 'var(--plugin-bg-eq)',
                        overflow: 'visible',
                        padding: 0,
                        position: 'relative',
                        flex: 1,
                    }}>
                        <svg
                            ref={eqSurfaceRef}
                            width="100%"
                            height="100%"
                            viewBox={`0 0 ${VB_W} ${VB_H}`}
                            preserveAspectRatio="none"
                            style={{ cursor: 'crosshair', display: 'block' }}
                            onMouseDown={(e) => {
                                if (e.button === 2) return;
                                const svg = eqSurfaceRef.current;
                                if (!svg) return;
                                const rect = svg.getBoundingClientRect();
                                const svgX = ((e.clientX - rect.left) / rect.width) * VB_W;
                                const svgY = ((e.clientY - rect.top) / rect.height) * VB_H;
                                let nearest: EqBand8 | null = null;
                                let nearestDist = Infinity;
                                for (const band of bands) {
                                    if (!band.enabled) continue;
                                    const bx = freqToX(band.freq);
                                    const by = gainToY(band.gain);
                                    const dist = Math.sqrt((svgX - bx) ** 2 + (svgY - by) ** 2);
                                    if (dist < nearestDist) { nearestDist = dist; nearest = band; }
                                }
                                if (nearest && nearestDist < 25) {
                                    setSelectedEqBand(nearest.idx);
                                    beginEqBandGesture(nearest.idx);
                                    setDragEqBand(nearest.idx);
                                }
                            }}
                            onDoubleClick={(e) => {
                                const svg = eqSurfaceRef.current;
                                if (!svg) return;
                                const rect = svg.getBoundingClientRect();
                                const svgX = ((e.clientX - rect.left) / rect.width) * VB_W;
                                const svgY = ((e.clientY - rect.top) / rect.height) * VB_H;

                                // Check if clicked on existing enabled band → disable it
                                let clickedBand: EqBand8 | null = null;
                                let clickedDist = Infinity;
                                for (const band of bands) {
                                    if (!band.enabled) continue;
                                    const bx = freqToX(band.freq);
                                    const by = gainToY(band.gain);
                                    const dist = Math.sqrt((svgX - bx) ** 2 + (svgY - by) ** 2);
                                    if (dist < clickedDist) { clickedDist = dist; clickedBand = band; }
                                }
                                if (clickedBand && clickedDist < 20) {
                                    onParamChange(`B${clickedBand.idx}En`, 0);
                                    return;
                                }

                                // Create new band at click position
                                const clickFreq = xToFreq(svgX);
                                const clickGain = ((VB_H / 2 - svgY) / (VB_H / 2 - 10)) * 24;
                                const clampedGain = Math.max(-24, Math.min(24, clickGain));
                                const disabledBands = bands.filter(b => !b.enabled);
                                if (disabledBands.length === 0) return;

                                let bestBand = disabledBands[0];
                                let bestDelta = Infinity;
                                for (const db of disabledBands) {
                                    const delta = Math.abs(Math.log2(clickFreq / db.freq));
                                    if (delta < bestDelta) { bestDelta = delta; bestBand = db; }
                                }
                                onParamChange(`B${bestBand.idx}Freq`, Math.round(clickFreq));
                                onParamChange(`B${bestBand.idx}Gain`, Math.round(clampedGain * 10) / 10);
                                onParamChange(`B${bestBand.idx}En`, 1);
                                setSelectedEqBand(bestBand.idx);
                            }}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                const svg = eqSurfaceRef.current;
                                if (!svg) return;
                                const rect = svg.getBoundingClientRect();
                                const svgX = ((e.clientX - rect.left) / rect.width) * VB_W;
                                const svgY = ((e.clientY - rect.top) / rect.height) * VB_H;
                                let nearest: EqBand8 | null = null;
                                let nearestDist = Infinity;
                                for (const band of bands) {
                                    if (!band.enabled) continue;
                                    const bx = freqToX(band.freq);
                                    const by = gainToY(band.gain);
                                    const dist = Math.sqrt((svgX - bx) ** 2 + (svgY - by) ** 2);
                                    if (dist < nearestDist) { nearestDist = dist; nearest = band; }
                                }
                                if (nearest && nearestDist < 30) {
                                    setEqContextMenu({ x: e.clientX, y: e.clientY, bandIdx: nearest.idx });
                                }
                            }}
                        >
                            <defs>
                                <linearGradient id={`eqGrad-${device.id}`} x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor="#5ab2ff" stopOpacity="0.3" />
                                    <stop offset="100%" stopColor="#5ab2ff" stopOpacity="0" />
                                </linearGradient>
                            </defs>
                            {[-18, -12, -6, 0, 6, 12, 18].map((db) => (
                                <line key={`hg-${db}`} x1={MARGIN_L} y1={gainToY(db)} x2={VB_W - MARGIN_R} y2={gainToY(db)}
                                    stroke={db === 0 ? 'rgba(90,178,255,0.25)' : 'rgba(90,178,255,0.06)'} strokeWidth={db === 0 ? 0.8 : 0.4} />
                            ))}
                            {freqLabels.map((fl) => (
                                <g key={`vf-${fl.freq}`}>
                                    <line x1={freqToX(fl.freq)} y1={4} x2={freqToX(fl.freq)} y2={VB_H - 12} stroke="rgba(90,178,255,0.06)" strokeWidth="0.4" />
                                    <text x={freqToX(fl.freq)} y={VB_H - 3} textAnchor="middle" fill="rgba(160,190,220,0.35)" fontSize="7" fontFamily="Inter, sans-serif">{fl.label}</text>
                                </g>
                            ))}
                            {[-12, 0, 12].map((db) => (
                                <text key={`dblabel-${db}`} x={MARGIN_L + 2} y={gainToY(db) - 2} fill="rgba(160,190,220,0.3)" fontSize="6.5" fontFamily="Inter, sans-serif">
                                    {db > 0 ? '+' : ''}{db}dB
                                </text>
                            ))}
                            <path d={fillPath} fill={`url(#eqGrad-${device.id})`} opacity="0.5" />
                            <path d={curvePath} fill="none" stroke="rgba(90,178,255,0.7)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            {/* Band dots — only render enabled bands */}
                            {bands.filter(b => b.enabled).map((band) => {
                                const bx = freqToX(band.freq);
                                const by = gainToY(band.gain);
                                const isActive = dragEqBand === band.idx || selectedEqBand === band.idx;
                                const iconPath = EQ_FILTER_ICONS[band.filterType] ?? EQ_FILTER_ICONS['peaking'];
                                return (
                                    <g key={band.idx} style={{ cursor: 'grab' }}>
                                        {isActive && (
                                            <circle cx={bx} cy={by} r="16" fill="none" stroke={band.color} strokeWidth="0.8" opacity="0.5" />
                                        )}
                                        <circle cx={bx} cy={by} r="9" fill="rgba(0,0,0,0.75)" stroke={band.color} strokeWidth="1.8" />
                                        <g transform={`translate(${bx - 6}, ${by - 6}) scale(1.2)`}>
                                            <path d={iconPath} fill="none" stroke={band.color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                                        </g>
                                        <text x={bx} y={by - 14} textAnchor="middle" fill={band.color} fontSize="6.5" fontFamily="Inter, sans-serif" fontWeight="600" opacity={isActive ? 1 : 0}>
                                            {EQ_FILTER_LABELS[band.filterType] ?? 'Bell'}
                                        </text>
                                    </g>
                                );
                            })}
                            {/* Empty state hint */}
                            {enabledBands.length === 0 && (
                                <text x={VB_W / 2} y={VB_H / 2} textAnchor="middle" fill="rgba(160,190,220,0.25)" fontSize="10" fontFamily="Inter, sans-serif">
                                    Double-click to add EQ point
                                </text>
                            )}
                        </svg>
                        {/* Right-click context menu */}
                        {eqContextMenu && (
                            <div
                                style={{
                                    position: 'fixed',
                                    left: eqContextMenu.x,
                                    top: eqContextMenu.y,
                                    zIndex: 9999,
                                    background: 'var(--color-bg-elevated, #1e2128)',
                                    border: '1px solid rgba(90,178,255,0.2)',
                                    borderRadius: 6,
                                    padding: '4px 0',
                                    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
                                    minWidth: 120,
                                }}
                                onMouseDown={(e) => e.stopPropagation()}
                            >
                                {Object.entries(EQ_FILTER_LABELS).map(([type, label]) => (
                                    <div
                                        key={type}
                                        style={{
                                            padding: '5px 14px',
                                            fontSize: 12,
                                            color: bands[eqContextMenu.bandIdx].filterType === type ? '#5ab2ff' : 'rgba(220,230,240,0.85)',
                                            cursor: 'pointer',
                                            fontWeight: bands[eqContextMenu.bandIdx].filterType === type ? 700 : 400,
                                        }}
                                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(90,178,255,0.12)'; }}
                                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                                        onClick={() => {
                                            setEqBandFilterTypes(prev => {
                                                const next = [...prev];
                                                next[eqContextMenu.bandIdx] = type;
                                                return next;
                                            });
                                            setEqContextMenu(null);
                                        }}
                                    >
                                        {label}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    {/* Band strip */}
                    <div style={{ ...pluginPanelMetaStyle, alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, marginRight: 4, fontSize: 10 }}>{eqTitle}</span>
                        {bands.filter(b => b.enabled).map((band) => (
                            <span
                                key={band.idx}
                                style={{
                                    color: band.color,
                                    cursor: 'pointer',
                                    padding: '1px 5px',
                                    borderRadius: 3,
                                    background: (selectedEqBand === band.idx || dragEqBand === band.idx) ? 'rgba(255,255,255,0.08)' : 'transparent',
                                    fontSize: 10,
                                    fontWeight: (selectedEqBand === band.idx || dragEqBand === band.idx) ? 700 : 400,
                                    transition: 'all 0.15s ease',
                                }}
                                onClick={() => setSelectedEqBand(band.idx)}
                                onDoubleClick={() => onParamChange(`B${band.idx}En`, 0)}
                            >
                                {band.freq >= 1000 ? `${(band.freq / 1000).toFixed(1)}k` : band.freq.toFixed(0)}
                            </span>
                        ))}
                        <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.6 }}>Out {out > 0 ? '+' : ''}{out.toFixed(1)}dB</span>
                    </div>
                </div>
            </div>
        );
    }

    if (device.effectType === 'utility') {
        const utilityTitle = normalizedInternalId === 'internal://effect/tuner'
            ? 'Tuner'
            : normalizedInternalId === 'internal://effect/external-audio-effect'
                ? 'External Audio Effect'
                : normalizedInternalId === 'internal://effect/auto-shift'
                    ? 'Auto Shift'
                    : normalizedInternalId === 'internal://effect/shifter'
                        ? 'Shifter'
                        : 'Utility';
        const isTuner = normalizedInternalId === 'internal://effect/tuner';
        const isExternalFx = normalizedInternalId === 'internal://effect/external-audio-effect';
        const isAutoShift = normalizedInternalId === 'internal://effect/auto-shift';
        const isShifter = normalizedInternalId === 'internal://effect/shifter';
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
                                <div style={{ fontSize: 'var(--font-size-2xs)', color: '#9fa7b5', marginBottom: 4 }}>Pan</div>
                                <div style={{ position: 'relative', height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)' }}>
                                    <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.2)' }} />
                                    <div style={{
                                        position: 'absolute',
                                        top: -3,
                                        left: `calc(${(panPct * 50 + 50).toFixed(3)}% - 5px)`,
                                        width: 10,
                                        height: 14,
                                        borderRadius: 'var(--radius-md)',
                                        background: '#56a7ff',
                                        boxShadow: '0 0 6px rgba(86,167,255,0.45)',
                                    }} />
                                </div>
                            </div>
                            <div>
                                <div style={{ fontSize: 'var(--font-size-2xs)', color: '#9fa7b5', marginBottom: 4 }}>Stereo Width</div>
                                <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
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
                                    style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '3px 8px', cursor: 'pointer' }}
                                >Center</button>
                                <button
                                    type="button"
                                    onClick={() => onApplyUtilityScene?.('mono')}
                                    style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '3px 8px', cursor: 'pointer' }}
                                >Mono</button>
                                <button
                                    type="button"
                                    onClick={() => onApplyUtilityScene?.('wide')}
                                    style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '3px 8px', cursor: 'pointer' }}
                                >Wide</button>
                            </div>
                        </>
                    ) : (
                        <>
                            <div style={{ gridColumn: '1 / span 2', ...pluginPanelTitleStyle, color: '#d9e3f2' }}>{utilityTitle}</div>
                            {isTuner && (
                                <div style={{ gridColumn: '1 / span 2', display: 'grid', gap: 4 }}>
                                    <div style={{ fontSize: 'var(--font-size-3xl)', color: '#a9d2ff', fontFamily: 'var(--font-mono)', textAlign: 'center' }}>A</div>
                                    <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: '#1f2a36', position: 'relative' }}>
                                        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: '#7ab6ff' }} />
                                    </div>
                                </div>
                            )}
                            {(isAutoShift || isShifter) && (
                                <div style={{ gridColumn: '1 / span 2', display: 'grid', gap: 4 }}>
                                    <div style={{ fontSize: 'var(--font-size-xs)', color: '#a5bed8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Shift</div>
                                    <div style={{ fontSize: 'var(--font-size-2xl)', color: '#dce9ff', fontFamily: 'var(--font-mono)' }}>{shiftAmount.toFixed(1)} st</div>
                                </div>
                            )}
                            {isExternalFx && (
                                <div style={{ gridColumn: '1 / span 2', fontSize: 'var(--font-size-xs)', color: '#c2cfdb', lineHeight: 1.4 }}>
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
        const isTransientShaper = normalizedInternalId === 'internal://effect/transient-shaper';
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
                            <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'rgba(18,26,34,0.9)', overflow: 'hidden' }}>
                                <div style={{ width: `${(attackNorm * 100).toFixed(1)}%`, height: '100%', background: 'linear-gradient(90deg, #53b0ff 0%, #8ecfff 100%)' }} />
                            </div>
                            <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'rgba(18,26,34,0.9)', overflow: 'hidden' }}>
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
                    <div style={{ width: 46, height: 72, borderRadius: 'var(--radius-md)', background: '#1c1f24', border: '1px solid #3d434d', padding: 3 }}>
                        <div style={{ width: '100%', height: `${(pseudoGr / 24) * 100}%`, marginTop: `${100 - (pseudoGr / 24) * 100}%`, background: 'linear-gradient(180deg, #66cc33 0%, #ffcc1a 60%, #ff3333 100%)', borderRadius: 2 }} />
                    </div>
                    {!isTransientShaper && (
                        <div style={{ ...pluginPanelMetaStyle, gridColumn: '1 / -1' }}>
                            <span>Thr {thr.toFixed(1)} dB</span>
                            <span>Ratio {ratio.toFixed(1)}:1</span>
                            <span>Atk {atkMs.toFixed(1)} ms</span>
                            <span>Rel {relMs.toFixed(0)} ms</span>
                        </div>
                    )}
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
        const delayTitle = normalizedInternalId === 'internal://effect/echo'
            ? 'Echo'
            : normalizedInternalId === 'internal://effect/beat-repeat'
                ? 'Beat Repeat'
                : normalizedInternalId === 'internal://effect/looper'
                    ? 'Looper'
                    : normalizedInternalId === 'internal://effect/spectral-time'
                        ? 'Spectral Time'
                        : normalizedInternalId === 'internal://effect/grain-delay'
                            ? 'Grain Delay'
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
        const reverbTitle = normalizedInternalId === 'internal://effect/hybrid-reverb'
            ? 'Hybrid Reverb'
            : normalizedInternalId === 'internal://effect/corpus'
                ? 'Corpus'
                : normalizedInternalId === 'internal://effect/resonators'
                    ? 'Resonators'
                    : normalizedInternalId === 'internal://effect/spectral-resonator'
                        ? 'Spectral Resonator'
                        : 'Reverb';
        const decay = device.params.find((p) => p.name.toLowerCase() === 'decay')?.value ?? 45;
        const tone = device.params.find((p) => p.name.toLowerCase() === 'tone')?.value ?? 0;
        const reverbMix = device.params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? 50;
        const reverbSize = device.params.find((p) => p.name.toLowerCase() === 'size')?.value ?? 40;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-reverb)',
                }}>
                    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 'var(--radius-md)', background: 'rgba(10,10,12,0.45)' }}>
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
                        <span>Size {reverbSize.toFixed(0)}%</span>
                        <span>Decay {decay.toFixed(0)}%</span>
                        <span>Tone {tone.toFixed(0)}%</span>
                        <span>Mix {reverbMix.toFixed(0)}%</span>
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
        const chorusMix = device.params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? 50;
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
                        <span>Mix {chorusMix.toFixed(0)}%</span>
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
        const satTitle = normalizedInternalId === 'internal://effect/drum-buss'
            ? 'Drum Buss'
            : normalizedInternalId === 'internal://effect/dynamic-tube'
                ? 'Dynamic Tube'
                : 'Saturator';
        const drive = device.params.find((p) => p.name.toLowerCase() === 'drive')?.value ?? 3;
        const satTone = device.params.find((p) => p.name.toLowerCase() === 'tone')?.value ?? 0;
        const satMix = device.params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? 100;
        const driveClamp = Math.max(0, Math.min(24, drive));
        const knee = Math.max(12, 80 - driveClamp * 2.8);
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-saturator)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(20, 13, 9, 0.7)" />
                        <line x1="12" y1="46" x2="308" y2="6" stroke="rgba(255,172,89,0.18)" strokeWidth="1" strokeDasharray="3,3" />
                        <path d={`M 12 46 C ${knee} 46, ${160 - knee / 2} 6, 160 6 C ${160 + knee / 2} 6, ${320 - knee} 46, 308 46`} fill="none" stroke="#ffac59" strokeWidth={Math.max(2, 2 + driveClamp / 8)} strokeLinecap="round" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{satTitle}</span>
                        <span>Drive {drive.toFixed(1)} dB</span>
                        {satTone !== 0 && <span>Tone {satTone.toFixed(0)}%</span>}
                        <span>Mix {satMix.toFixed(0)}%</span>
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

    if (device.effectType === 'limiter') {
        const thr = device.params.find((p) => p.name.toLowerCase() === 'thr')?.value ?? -0.3;
        const ceil = device.params.find((p) => p.name.toLowerCase() === 'ceil')?.value ?? -0.1;
        const safety = Math.max(0, Math.min(1, 1 - Math.abs(thr - ceil) / 30));
        const limGr = Math.max(0, Math.abs(thr) * 0.8);
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-limiter)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#a4d9d3' }}>Lookahead Limiter</div>
                    <div style={{ height: 10, borderRadius: 'var(--radius-full)', background: '#222d2e', overflow: 'hidden' }}>
                        <div style={{ width: `${(safety * 100).toFixed(1)}%`, height: '100%', background: 'linear-gradient(90deg, #4bc4b2 0%, #89f0de 100%)' }} />
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>Thr {thr.toFixed(1)} dB</span>
                        <span>Ceil {ceil.toFixed(1)} dB</span>
                        <span>GR ~{limGr.toFixed(1)} dB</span>
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
        const gateAtk = device.params.find((p) => p.name.toLowerCase() === 'atk')?.value ?? device.params.find((p) => p.name.toLowerCase().includes('attack'))?.value ?? 0.1;
        const gateRel = device.params.find((p) => p.name.toLowerCase() === 'rel')?.value ?? device.params.find((p) => p.name.toLowerCase().includes('release'))?.value ?? 50;
        const openness = Math.max(0, Math.min(1, (80 + thr) / 80));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-gate)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#b8dfad' }}>Noise Gate</div>
                    <div style={{ height: 34, borderRadius: 'var(--radius-md)', background: '#1b2018', position: 'relative' }}>
                        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(openness * 100).toFixed(1)}%`, background: 'linear-gradient(90deg, #6bc66e 0%, #d2f18b 100%)' }} />
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>Thr {thr.toFixed(1)} dB</span>
                        <span>Range {range.toFixed(1)} dB</span>
                        <span>Atk {gateAtk.toFixed(1)} ms</span>
                        <span>Rel {gateRel.toFixed(0)} ms</span>
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
        const isVocoder = normalizedInternalId === 'internal://effect/vocoder';
        const modRate = params.find((p) => p.name.toLowerCase() === 'rate')?.value ?? 0;
        const modDepth = params.find((p) => p.name.toLowerCase() === 'depth')?.value ?? 0;
        const modMix = params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? params.find((p) => p.name.toLowerCase() === 'amount')?.value ?? 50;
        const modFreq = params.find((p) => p.name.toLowerCase() === 'freq' || p.name.toLowerCase() === 'frequency')?.value ?? 0;
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
                        {modRate > 0 && <span>{modRate.toFixed(2)} Hz</span>}
                        {modDepth > 0 && <span>Depth {modDepth.toFixed(0)}%</span>}
                        {modFreq > 0 && <span>Freq {modFreq.toFixed(0)} Hz</span>}
                        <span>Mix {modMix.toFixed(0)}%</span>
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
            : normalizedInternalId === 'internal://effect/amp'
                ? 'Amp'
                : normalizedInternalId === 'internal://effect/cabinet'
                    ? 'Cabinet'
                    : normalizedInternalId === 'internal://effect/erosion'
                        ? 'Erosion'
                        : normalizedInternalId === 'internal://effect/overdrive'
                            ? 'Overdrive'
                            : normalizedInternalId === 'internal://effect/pedal'
                                ? 'Pedal'
                                : normalizedInternalId === 'internal://effect/roar'
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
                    ? (normalizedInternalId === 'internal://midi-fx/chord' ? 'Chord' : 'MIDI Scale')
                    : device.effectType === 'midiVelocity'
                        ? (normalizedInternalId === 'internal://midi-fx/note-length' ? 'Note Length' : normalizedInternalId === 'internal://midi-fx/cc-control' ? 'CC Control' : normalizedInternalId === 'internal://midi-fx/expression-control' ? 'Expression Control' : 'MIDI Velocity')
                        : (normalizedInternalId === 'internal://midi-fx/arpeggiator' ? 'Arpeggiator' : 'MIDI Random');
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
        const isNoteLength = normalizedInternalId === 'internal://midi-fx/note-length';
        const isCcControl = normalizedInternalId === 'internal://midi-fx/cc-control';
        const isExpressionControl = normalizedInternalId === 'internal://midi-fx/expression-control';
        const isArp = normalizedInternalId === 'internal://midi-fx/arpeggiator';
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
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-3xl)', color: '#95bdff' }}>
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
                                        borderRadius: 'var(--radius-sm)',
                                        border: idx === activeRoot ? '1px solid #8bc27a' : '1px solid rgba(255,255,255,0.14)',
                                        background: idx === activeRoot ? 'rgba(139,194,122,0.22)' : 'rgba(160,180,210,0.1)',
                                        color: idx === activeRoot ? '#d9f3d1' : '#a8b7cd',
                                        fontSize: 'var(--font-size-2xs)',
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
                                    <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: '#1e2430', overflow: 'hidden' }}>
                                        <div style={{ width: `${Math.max(0, Math.min(100, velGain * 50)).toFixed(1)}%`, height: '100%', background: 'linear-gradient(90deg, #7ec8ff 0%, #a0e0ff 100%)' }} />
                                    </div>
                                    <div style={{ fontSize: 'var(--font-size-xs)', color: '#c5d7ea', fontFamily: 'var(--font-mono)' }}>Gate {(velGain * 100).toFixed(0)}%</div>
                                </>
                            ) : (
                                <>
                                    <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: '#1e2430', overflow: 'hidden' }}>
                                        <div style={{ width: `${Math.max(0, Math.min(200, velGain * 100)).toFixed(1)}%`, height: '100%', background: 'linear-gradient(90deg, #7ec8ff 0%, #a0e0ff 100%)' }} />
                                    </div>
                                    <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: '#1e2430', overflow: 'hidden', position: 'relative' }}>
                                        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.2)' }} />
                                        <div style={{
                                            position: 'absolute',
                                            left: `calc(${Math.max(0, Math.min(100, (velOffset + 64) / 128 * 100)).toFixed(1)}% - 5px)`,
                                            top: -2,
                                            width: 10,
                                            height: 12,
                                            borderRadius: 'var(--radius-md)',
                                            background: isCcControl || isExpressionControl ? '#8ecb7c' : '#d9a25c',
                                        }} />
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                    {device.effectType === 'midiRandom' && (
                        <div style={{ display: 'grid', alignItems: 'center', gap: 4, height: 46 }}>
                            <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: '#1d1d2e', overflow: 'hidden' }}>
                                <div style={{ width: `${Math.max(0, Math.min(100, chance * 100)).toFixed(1)}%`, height: '100%', background: 'linear-gradient(90deg, #c58bdd 0%, #ecb4ff 100%)' }} />
                            </div>
                            <div style={{ fontSize: 'var(--font-size-xs)', color: '#cfa4e6', fontFamily: 'var(--font-mono)' }}>
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
                        <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-bold)' as unknown as number, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>
                            External Plugin
                        </span>
                        <span style={{
                            fontSize: 'var(--font-size-xs)',
                            fontWeight: 'var(--font-weight-bold)' as unknown as number,
                            borderRadius: 'var(--radius-full)',
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
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
                        <span>{device.params.length} mapped params</span>
                        <span>
                            {runtimeStatus?.latencyFrames != null
                                ? `Latency ${runtimeStatus.latencyFrames} fr`
                                : (editorSupported === false ? 'Native editor unavailable' : 'Inline editor')}
                        </span>
                    </div>
                    {editorReason && (
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>{editorReason}</div>
                    )}
                    <input
                        value={paramSearch}
                        onChange={(e) => setParamSearch(e.target.value)}
                        placeholder="Find parameter..."
                        style={{
                            height: 24,
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--color-divider)',
                            background: 'var(--color-bg-panel)',
                            color: 'var(--color-text-primary)',
                            fontSize: 'var(--font-size-sm)',
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
                            fontSize: 'var(--font-size-xs)',
                            color: 'var(--color-text-tertiary)',
                            fontWeight: 'var(--font-weight-bold)' as unknown as number,
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
                            borderRadius: 'var(--radius-md)',
                            background: 'var(--color-bg-header)',
                            color: 'var(--color-text-primary)',
                            fontSize: 'var(--font-size-sm)',
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
                        fontSize: 'var(--font-size-xs)',
                        color: 'var(--color-text-tertiary)',
                        fontWeight: 'var(--font-weight-bold)' as unknown as number,
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
                                    borderRadius: 'var(--radius-md)',
                                    background: 'var(--color-bg-header)',
                                    color: 'var(--color-text-secondary)',
                                    fontSize: 'var(--font-size-xs)',
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
                        fontSize: 'var(--font-size-xs)',
                        color: 'var(--color-text-tertiary)',
                        fontWeight: 'var(--font-weight-bold)' as unknown as number,
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                    }}>
                        Performance
                    </span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button
                            type="button"
                            onClick={() => onRandomize?.()}
                            style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '4px 8px', cursor: 'pointer' }}
                        >Random</button>
                        <button
                            type="button"
                            onClick={() => onReset?.()}
                            style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '4px 8px', cursor: 'pointer' }}
                        >Reset</button>
                        <button
                            type="button"
                            onClick={() => onStoreSnapshot?.('A')}
                            style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: snapshotState?.active === 'A' ? 'color-mix(in srgb, var(--color-accent-primary) 25%, var(--color-bg-header))' : 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '4px 8px', cursor: 'pointer' }}
                        >Store A</button>
                        <button
                            type="button"
                            onClick={() => onStoreSnapshot?.('B')}
                            style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: snapshotState?.active === 'B' ? 'color-mix(in srgb, var(--color-accent-primary) 25%, var(--color-bg-header))' : 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '4px 8px', cursor: 'pointer' }}
                        >Store B</button>
                        <button
                            type="button"
                            onClick={() => onRecallSnapshot?.('A')}
                            disabled={!snapshotState?.A}
                            style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '4px 8px', cursor: snapshotState?.A ? 'pointer' : 'not-allowed', opacity: snapshotState?.A ? 1 : 0.55 }}
                        >A</button>
                        <button
                            type="button"
                            onClick={() => onRecallSnapshot?.('B')}
                            disabled={!snapshotState?.B}
                            style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '4px 8px', cursor: snapshotState?.B ? 'pointer' : 'not-allowed', opacity: snapshotState?.B ? 1 : 0.55 }}
                        >B</button>
                        <button
                            type="button"
                            onClick={() => onToggleSnapshot?.()}
                            disabled={!snapshotState?.A || !snapshotState?.B}
                            style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '4px 8px', cursor: snapshotState?.A && snapshotState?.B ? 'pointer' : 'not-allowed', opacity: snapshotState?.A && snapshotState?.B ? 1 : 0.55 }}
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
                        borderRadius: 'var(--radius-md)',
                        background: 'var(--color-bg-header)',
                        color: 'var(--color-text-secondary)',
                        fontSize: 'var(--font-size-sm)',
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
                    borderRadius: 'var(--radius-lg)',
                    padding: '8px 10px',
                    color: 'var(--color-text-secondary)',
                    fontSize: 'var(--font-size-xs)',
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

// MeterBar removed — all meters now use the unified <MeterStrip> from @/shared/ui/MeterStrip.
