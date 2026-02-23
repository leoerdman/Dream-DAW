import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import { DEVICE_PARAM_PRESETS } from './deviceParamPresets';
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
