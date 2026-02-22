import type { PluginParam } from '@/widgets/DeviceRack/StandardPluginControls';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
export {
    clampAndSnapParamValue,
    defaultParamForReset,
    randomParamValue,
    resolveQuickPresetParams,
} from './presets';

export const INTERNAL_EFFECT_TYPE_BY_PLUGIN_ID: Partial<Record<string, DeviceSlot['effectType']>> = {
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

export const RUNTIME_PARAM_INDEX_BY_EFFECT: Partial<Record<
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

export const DEVICE_PARAM_PRESETS: Record<
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

export const EFFECT_PARAM_CATALOG = DEVICE_PARAM_PRESETS;

// vuNorm imported from '@/shared/lib/audioMath'

export function normalizePickedPath(picked: unknown): string | null {
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

export function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
        const maybeMessage = (err as { message?: unknown }).message;
        if (typeof maybeMessage === 'string') return maybeMessage;
    }
    return 'Unknown error';
}

export function internalParamIdForControl(effectType: DeviceSlot['effectType'], controlName: string): string {
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
