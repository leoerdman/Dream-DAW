import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { resolvePlugin, formatBadgeColor } from '@/shared/config/pluginManifest';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useDragStore } from '@/shared/stores/useDragStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import * as engineApi from '@/shared/api/engine';
import { useShallow } from 'zustand/react/shallow';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { linearToMeterNorm, dbToMeterNorm } from '@/shared/lib/meterManifest';
import type { PluginParam } from '@/widgets/DeviceRack/StandardPluginControls';
import type { DeviceSlot, QuickPreset } from '@/widgets/DeviceRack/model/types';
import {
    QUICK_PRESETS_BY_EFFECT,
    resolveQuickPresetParams,
    defaultParamForReset,
    clampAndSnapParamValue,
    randomParamValue,
} from '@/widgets/DeviceRack/model/presets';
import { PluginSettingsPanel } from '@/widgets/DeviceRack/ui/PluginSettingsPanel';
import { PluginGuiSurface } from '@/widgets/DeviceRack/ui/PluginGuiSurface';
import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';
import { canDropInZone } from '@/shared/lib/dndMatrix';
import {
    getInternalPluginById,
    normalizeInternalPluginId,
    waveformIndexFromSamplePath,
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
    'internal://effect/spectrum': 'analyzer',
    'internal://effect/analyzer': 'analyzer',

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
        // Filter type per band (0=HP, 1=LP, 2=LowShelf, 3=HighShelf, 4=Peaking, 5=Notch)
        b0type: 33, b1type: 34, b2type: 35, b3type: 36,
        b4type: 37, b5type: 38, b6type: 39, b7type: 40,
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
    analyzer: { reset: 0 },
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
    analyzer: [
        { name: 'Reset', value: 0, min: 0, max: 1, suffix: '', step: 1 },
    ],
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
    sample_rack: [],
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
    const {
        openEditorsByTrack,
        togglePluginEditor,
        projectTracks,
        meters,
        fetchProject,
    } = useEngineStore(useShallow((s) => ({
        openEditorsByTrack: s.openEditorsByTrack,
        togglePluginEditor: s.togglePluginEditor,
        projectTracks: s.projectTracks,
        meters: s.meters,
        fetchProject: s.fetchProject,
    })));
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
        const lanes = selectedTrack?.automation_lanes ?? [];
        for (const lane of lanes) {
            const paramId = (lane.param_id ?? '').trim();
            if (!paramId) continue;
            const points = lane.points ?? [];
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

    // ── SSOT: Clear ephemeral UI state on track switch ──────────────
    // `localParams` and `localBypass` are short-lived caches for in-flight
    // gestures.  They must NOT survive a track switch, because the backend
    // automation_lanes are the Single Source of Truth for persisted values.
    // Keeping stale localParams would override any backend changes made
    // while the user was on another track (automation, undo, fetchProject).
    useEffect(() => {
        setLocalParams({});
        setLocalBypass({});
        // Cancel in-flight throttled sends — they target the OLD track.
        for (const sender of throttledParamSendsRef.current.values()) sender.cancel();
        throttledParamSendsRef.current.clear();
        for (const sender of throttledExternalParamSendsRef.current.values()) sender.cancel();
        throttledExternalParamSendsRef.current.clear();
        pendingGestureCommitsRef.current.clear();
        activeParamGesturesRef.current.clear();
        pushedUndoForGestureRef.current.clear();
        gestureGroupByParamKeyRef.current.clear();
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
            ...(selectedTrack.sample_rack ? [{
                id: `sample-rack-${selectedTrack.id}`,
                name: 'Sample Rack',
                type: 'SampleRack',
                plugin_id: 'internal://instrument/sample-rack',
                is_bypassed: false,
                source: 'internal',
                sampleRackConfig: selectedTrack.sample_rack,
            } as {
                id: string;
                name: string;
                type: string;
                plugin_id: string;
                is_bypassed: boolean;
                source: 'internal';
                sampleRackConfig: unknown;
            }] : []),
            ...(!selectedTrack.sample_rack && selectedTrack.instrument ? [selectedTrack.instrument] : []),
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
            sampleRackConfig?: unknown;
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
            if (mappedInternalType) {
                effectType = mappedInternalType;
            } else if (pluginIdLower === 'internal://instrument/sample-rack') {
                effectType = 'sample_rack' as DeviceSlot['effectType'];
            } else if (!isVst) {
                if (normalized.includes('sampler')) effectType = 'sampler';
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
                else if (selectedTrack.instrument?.id === id) effectType = 'instrument';
            }

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
                sampleRackConfig: slot.sampleRackConfig,
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

            // BUG-R1 FIX: Master track is NOT in projectTracks — findIndex returns -1,
            // causing ALL master EQ param updates to be silently dropped.
            // Use MASTER_TRACK_INDEX (65535) sentinel matching driver.rs MASTER_TRACK_INDEX.
            const MASTER_TRACK_INDEX = 65535;
            const trackIdx = isMaster
                ? MASTER_TRACK_INDEX
                : projectTracks.findIndex((t) => t.id === selectedTrack.id);
            const effectSlotIdx = selectedTrack.effects.findIndex((fx) => fx.id === device.id);
            const pushPluginParam = (paramIndex: number, paramValue: number) => {
                if ((!isMaster && trackIdx < 0) || effectSlotIdx < 0) return;
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
            const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable) return;
            if (!selectedTrack) return;

            // ── Cmd+C: Copy selected device to clipboard ──
            if ((e.metaKey || e.ctrlKey) && e.key === 'c' && selectedDeviceIds.length > 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                try {
                    const deviceName = await engineApi.copyDeviceFromTrack(
                        selectedTrack.id,
                        selectedDeviceIds[0],
                    );
                    statusClear();
                    console.log(`[DeviceRack] Copied device: ${deviceName}`);
                } catch (err) {
                    console.error('[DeviceRack] copyDeviceFromTrack failed:', err);
                    statusError('Failed to copy device.');
                }
                return;
            }

            // ── Cmd+V: Paste device to current track ──
            if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
                e.preventDefault();
                e.stopImmediatePropagation();
                try {
                    await engineApi.pasteDeviceToTrack(selectedTrack.id, 'auto');
                    await fetchProject();
                    statusClear();
                    console.log('[DeviceRack] Pasted device to track:', selectedTrack.id);
                } catch (err) {
                    console.error('[DeviceRack] pasteDeviceToTrack failed:', err);
                    statusError(String(err));
                }
                return;
            }

            // ── Delete / Backspace: Remove selected devices ──
            if ((e.key !== 'Delete' && e.key !== 'Backspace') || selectedDeviceIds.length === 0) return;
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
    const quickPresets = device.source === 'internal'
        ? (QUICK_PRESETS_BY_EFFECT[device.effectType] ?? [])
        : [];

    return (
        <div
            className="device-node"
            data-effect={device.effectType}
            style={{
                minWidth: rackWidth,
                width: rackWidth,
                display: 'flex',
                flexDirection: 'row',
                background: '#3a3a3a',
                borderRadius: 'var(--radius-sm)',
                border: isSelected ? '1px solid rgba(255,255,255,0.7)' : '1px solid #3a3a3a',
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
            {/* ── Vertical Left Header Strip (Bitwig-style) ── */}
            <div
                draggable
                onDragStart={(e) => {
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
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 6,
                    padding: '8px 0',
                    borderRight: '1px solid var(--color-divider)',
                    background: 'var(--surface-tab-inactive)',
                    cursor: 'grab',
                    width: 32,
                    minWidth: 32,
                    flexShrink: 0,
                }}
                onClick={(e) => { e.stopPropagation(); onSelect(e); }}
            >
                {/* ● Bypass — round power dot */}
                <button
                    draggable={false}
                    onClick={onToggle}
                    title={device.isEnabled ? 'Disable' : 'Enable'}
                    style={{
                        width: 14, height: 14,
                        borderRadius: '50%',
                        background: device.isEnabled ? 'var(--color-accent-primary)' : 'transparent',
                        border: device.isEnabled ? 'none' : '1px solid var(--color-overlay-light)',
                        cursor: 'pointer',
                        padding: 0,
                        margin: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                    }}
                />
                {/* 👁 UI button — green round with eye icon */}
                {showUiButton && (
                    <button
                        draggable={false}
                        onClick={(e) => { e.stopPropagation(); onOpenGUI?.(); }}
                        title={editorSupported === false
                            ? (editorReason ?? 'Native plugin editor is unavailable; opening inline controls')
                            : 'Open Native Plugin UI'}
                        style={{
                            width: 16, height: 16,
                            borderRadius: 'var(--radius-sm)',
                            background: (showSettings || nativeEditorOpen) ? '#48d282' : 'transparent',
                            border: (showSettings || nativeEditorOpen) ? 'none' : '1px solid var(--color-overlay-light)',
                            cursor: 'pointer',
                            flexShrink: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            padding: 0, margin: 0,
                            transition: 'var(--transition-fast)',
                        }}
                    >
                        <svg width="8" height="8" viewBox="0 0 16 16" fill="none">
                            <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"
                                stroke={(showSettings || nativeEditorOpen) ? 'var(--color-bg-primary)' : '#48d282'}
                                strokeWidth="2" fill="none" />
                            <circle cx="8" cy="8" r="2.5"
                                fill={(showSettings || nativeEditorOpen) ? 'var(--color-bg-primary)' : '#48d282'} />
                        </svg>
                    </button>
                )}
                {/* Fix button — only when plugin runtime is dead */}
                {showRecoverAction && (
                    <button
                        draggable={false}
                        onClick={(e) => { e.stopPropagation(); onEnsureActive?.(); }}
                        title="Recover plugin runtime"
                        style={{
                            width: 14, height: 14,
                            borderRadius: '50%',
                            background: 'rgba(255, 100, 100, 0.25)',
                            border: '1px solid rgba(255, 100, 100, 0.5)',
                            cursor: 'pointer',
                            flexShrink: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            padding: 0,
                            fontSize: 8, fontWeight: 800, color: '#ff6464',
                            transition: 'all 0.15s',
                        }}
                    >
                        !
                    </button>
                )}
                {/* 🔧 Wrench — settings SVG */}
                {supportsSettingsToggle && (
                    <button
                        draggable={false}
                        onClick={(e) => { e.stopPropagation(); onOpenSettings(); }}
                        title="Plugin Settings / Automatable Params"
                        style={{
                            width: 16, height: 16,
                            borderRadius: 'var(--radius-sm)',
                            background: showSettings ? 'var(--color-text-secondary)' : 'transparent',
                            border: showSettings ? 'none' : '1px solid var(--color-overlay-light)',
                            cursor: 'pointer',
                            flexShrink: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            padding: 0, margin: 0,
                            transition: 'var(--transition-fast)',
                        }}
                    >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                            <path d="M10.5 2a3.5 3.5 0 00-3.22 4.87L2.5 11.65a1.2 1.2 0 001.7 1.7l4.78-4.78A3.5 3.5 0 0010.5 2z"
                                stroke={showSettings ? 'var(--color-bg-primary)' : 'var(--color-text-secondary)'}
                                strokeWidth="1.5" fill="none" strokeLinecap="round" />
                        </svg>
                    </button>
                )}
                {/* Rotated device name — fills remaining vertical space */}
                <span style={{
                    writingMode: 'vertical-lr',
                    transform: 'rotate(180deg)',
                    fontSize: 'var(--font-size-micro)',
                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
                    color: '#808080',
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    lineHeight: 1,
                }}>
                    {device.name}
                </span>
                {/* Format badge at bottom */}
                <span style={{
                    fontSize: 6,
                    color: formatBadgeColor(pluginFormat),
                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
                    flexShrink: 0,
                    opacity: 0.6,
                }}>
                    {pluginFormat}
                </span>
            </div>

            {/* ── Body — fills remaining horizontal space ── */}
            {device.source === 'internal' ? (
                <div
                    style={{
                        padding: 4,
                        flex: 1,
                        minWidth: 0,
                        minHeight: 0,
                        display: 'grid',
                        gridTemplateRows: showSettings && supportsSettingsToggle ? '1fr auto' : '1fr',
                        gap: 4,
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
                                border: '1px solid rgba(255,255,255,0.04)',
                                borderRadius: 'var(--radius-sm)',
                                background: 'rgba(0,0,0,0.15)',
                                padding: 6,
                            }}
                        >
                            <PluginSettingsPanel
                                device={device}
                                quickPresets={quickPresets}
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
                <div style={{ padding: 6, flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
                    <PluginSettingsPanel
                        device={device}
                        quickPresets={quickPresets}
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
                    minWidth: 0,
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
                                    background: '#2a2a2a',
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


// MeterBar removed — all meters now use the unified <MeterStrip> from @/shared/ui/MeterStrip.
