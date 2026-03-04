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
    'internal://instrument/sample-rack': 'sample_rack',
    'internal://effect/eq-eight': 'eq',
    'internal://effect/channel-eq': 'bandEq',
    'internal://effect/eq-three': 'bandEq',
    'internal://effect/compressor': 'compressor',
    'internal://effect/glue-compressor': 'glueCompressor',
    'internal://effect/multiband-dynamics': 'multibandDynamics',
    'internal://effect/transient-shaper': 'transientShaper',
    'internal://effect/delay': 'delay',
    'internal://effect/echo': 'delay',
    'internal://effect/simple-delay': 'delay',
    'internal://effect/filter-delay': 'filterDelay',
    'internal://effect/grain-delay': 'grainDelay',
    'internal://effect/beat-repeat': 'delay',
    'internal://effect/looper': 'delay',
    'internal://effect/spectral-time': 'spectralTime',
    'internal://effect/reverb': 'reverb',
    'internal://effect/hybrid-reverb': 'hybridReverb',
    'internal://effect/corpus': 'corpus',
    'internal://effect/resonators': 'reverb',
    'internal://effect/spectral-resonator': 'reverb',
    'internal://effect/chorus': 'chorus',
    'internal://effect/saturator': 'saturator',
    'internal://effect/drum-buss': 'drumBuss',
    'internal://effect/dynamic-tube': 'dynamicTube',
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
    'internal://effect/phaser-flanger': 'phaserFlanger',
    'internal://effect/flanger': 'flanger',

    'internal://effect/distortion': 'distortion',
    'internal://effect/amp': 'amp',
    'internal://effect/cabinet': 'cabinet',
    'internal://effect/overdrive': 'overdrive',
    'internal://effect/pedal': 'pedal',
    'internal://effect/roar': 'roar',
    'internal://effect/erosion': 'erosion',
    'internal://effect/bitcrusher': 'bitcrusher',

    'internal://effect/noise-machine': 'noiseMachine',
    'internal://effect/spectrum': 'spectrum',
    'internal://effect/analyzer': 'analyzer',

    'internal://midi-fx/pitch': 'midiPitch',
    'internal://midi-fx/scale': 'midiScale',
    // BUG-33 FIX: Chord has its own type — not Scale.
    'internal://midi-fx/chord': 'midiChord',
    'internal://midi-fx/velocity': 'midiVelocity',
    // BUG-34/35/36 FIX: Note Length, CC Control, Expression Control have own types.
    'internal://midi-fx/note-length': 'midiNoteLength',
    'internal://midi-fx/cc-control': 'midiCcControl',
    'internal://midi-fx/expression-control': 'midiExpressionControl',
    'internal://midi-fx/random': 'midiRandom',
    // BUG-37 FIX: Arpeggiator has its own type with rate/pattern/octaves — not Random.
    'internal://midi-fx/arpeggiator': 'midiArpeggiator',
    // ENTERPRISE: Rack plugin IDs from trackAdapter rack flattening.
    'internal://rack/instrument': 'rack',
    'internal://rack/audioeffect': 'rack',
    'internal://rack/drumrack': 'rack',
    'internal://rack/midieffect': 'rack',
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
    bandEq: {
        // Backend ChannelEqProcessor: 3-band EQ with LR4 crossovers
        // Indices 0-2: low/mid/high gain, 3-4: xover freqs, 5-7: kills, 8: output
        low: 0, mid: 1, high: 2,
        lowfreq: 3, highfreq: 4,
        lowkill: 5, midkill: 6, highkill: 7,
        out: 8,
    },
    utility: { gain: 0, pan: 1, width: 2, mono: 3 },
    compressor: {
        thr: 0, ratio: 1, atk: 2, rel: 3,
        knee: 4, makeup: 5, mix: 6, 'sc hpf': 7, 'auto gain': 8, rms: 9,
        lookahead: 10,
    },
    delay: {
        'time l': 0, 'time r': 1, fb: 2, 'dry/wet': 3, mix: 3,  // BUG-P02 FIX
        filter: 4, pingpong: 5, 'mod rate': 6, 'mod depth': 7,
        'sync l': 8, 'sync r': 9, 'note l': 10, 'note r': 11,
        time: 0,    // Legacy alias
    },
    reverb: {
        size: 0, damp: 1, 'dry/wet': 2, mix: 2,
        predelay: 3, width: 4, 'low damp': 5, 'mod rate': 6, 'mod depth': 7, freeze: 8,
        'lo cut': 9, 'low cut': 9, locut: 9,
        'hi cut': 10, 'high cut': 10, hicut: 10,
        diffusion: 11, density: 12, chorus: 13, 'chorus amount': 13,
        voicing: 14, mode: 14, character: 14,
        decay: 0,   // Legacy alias → room_size
        tone: 1,    // Legacy alias → damping
    },
    chorus: { rate: 0, depth: 1, mix: 2, fb: 3, voices: 4, spread: 5, 'hp freq': 6 },
    saturator: { drive: 0, tone: 1, mix: 2, mode: 3, output: 4, color: 5 },
    limiter: { thr: 0, rel: 1, ceil: 2, lookahead: 3, 'auto rel': 4, link: 5 },
    gate: { thr: 0, atk: 1, hold: 2, rel: 3, range: 4, 'sc hpf': 5, hysteresis: 6, duck: 7 },
    autoFilter: {
        cutoff: 0, res: 1, rate: 2, depth: 3, env: 4, type: 5, mix: 6,
        'lfo shape': 7, drive: 8, 'env speed': 9,
    },
    autoPan: { rate: 0, depth: 1, phase: 2, shape: 3, mix: 4 },
    phaser: {
        rate: 0, depth: 1, fb: 2, stages: 3, center: 4, mix: 5,
        spread: 6, 'lfo shape': 7, range: 8,
    },
    flanger: {
        rate: 0, depth: 1, fb: 2, delay: 3, mix: 4,
        stereo: 5, 'lfo shape': 6, 'fb damp': 7, 'tz mode': 8,
    },
    distortion: { drive: 0, tone: 1, mix: 2, mode: 3, output: 4, 'cab sim': 5, tight: 6, bias: 7 },
    bitcrusher: {
        bits: 0, down: 1, mix: 2, jitter: 3,
        'pre freq': 4, 'post freq': 5, stereo: 6, dither: 7,
    },
    noiseMachine: { level: 0, type: 1, stereo: 2, lpfreq: 3, hpfreq: 4, pan: 5 },   // BUG-P01 FIX: level=0, type=1
    analyzer: { reset: 0 },
    spectrum: { reset: 0 },
    midiPitch: { semitones: 0 },
    midiScale: { root: 0, mask: 1 },
    midiVelocity: { gain: 0, offset: 1 },
    midiRandom: { semitones: 0, chance: 1 },
    // BUG-33/34/35/36/37 FIX: New MIDI effect runtime indices.
    midiChord: { root: 0, octaves: 1, inversion: 2 },
    midiNoteLength: { length: 0, gate: 1 },
    midiCcControl: { cc: 0, value: 1 },
    midiExpressionControl: { cc: 0, value: 1 },
    midiArpeggiator: { rate: 0, pattern: 1, octaves: 2, gate: 3 },
    // ── Wave 3: runtime param indices (matching backend set_param) ──
    overdrive: { drive: 0, tone: 1, mix: 2, output: 3, bias: 4, tight: 5 },
    transientShaper: { attack: 0, sustain: 1, output: 2, speed: 3, mix: 4 },
    drumBuss: { drive: 0, crunch: 1, boom: 2, 'boom freq': 3, transient: 4, trim: 5, mix: 6 },
    dynamicTube: { drive: 0, bias: 1, envelope: 2, tone: 3, mix: 4, output: 5 },
    phaserFlanger: { rate: 0, depth: 1, fb: 2, blend: 3, stages: 4, mix: 5, stereo: 6 },
    amp: { gain: 0, bass: 1, mid: 2, treble: 3, presence: 4, master: 5, sag: 6, mix: 7 },
    cabinet: { type: 0, 'mic pos': 1, 'lo cut': 2, 'hi cut': 3, resonance: 4, output: 5, mix: 6 },
    hybridReverb: { size: 0, decay: 1, damp: 2, early: 3, late: 4, predelay: 5, 'mod depth': 6, mix: 7, width: 8 },
    erosion: { mode: 0, frequency: 1, amount: 2, width: 3, mix: 4 },
    pedal: { mode: 0, drive: 1, tone: 2, level: 3, mix: 4 },
    roar: { character: 0, intensity: 1, color: 2, feedback: 3, output: 4, mix: 5 },
    multibandDynamics: {
        'xover low': 0, 'xover high': 1,
        'lo thr': 2, 'lo ratio': 3, 'lo gain': 4,
        'mid thr': 5, 'mid ratio': 6, 'mid gain': 7,
        'hi thr': 8, 'hi ratio': 9, 'hi gain': 10,
        output: 11,
    },
    grainDelay: { delay: 0, grain: 1, pitch: 2, spray: 3, fb: 4, mix: 5, density: 6 },
    corpus: { tune: 0, decay: 1, damp: 2, type: 3, spread: 4, mix: 5 },
    spectralTime: { mode: 0, amount: 1, decay: 2, tilt: 3, mix: 4 },
    glueCompressor: { thr: 0, ratio: 1, atk: 2, rel: 3, makeup: 4, range: 5, mix: 6, 'soft clip': 7 },
    filterDelay: { 'l delay': 0, 'c delay': 1, 'r delay': 2, 'l filter': 3, 'c filter': 4, 'r filter': 5, fb: 6, mix: 7 },
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
        } catch (err) {
            console.warn('[Dream] normalizePickedPath URL parse fallback:', err);
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
        if (normalizedName === 'vol' || normalizedName === 'gain') return 'sampler.volume';
        if (normalizedName === 'attack' || normalizedName === 'atk') return 'sampler.attack';
        if (normalizedName === 'decay' || normalizedName === 'dec') return 'sampler.decay';
        if (normalizedName === 'sustain' || normalizedName === 'sus') return 'sampler.sustain';
        if (normalizedName === 'release' || normalizedName === 'rel') return 'sampler.release';
        if (normalizedName === 'root') return 'sampler.rootNote';
        return `sampler.${normalizedName}`;
    }
    return `${effectType}.${normalizedName}`;
}
