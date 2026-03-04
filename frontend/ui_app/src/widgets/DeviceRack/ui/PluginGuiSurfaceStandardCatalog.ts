import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import { EFFECT_PARAM_CATALOG } from '@/widgets/DeviceRack/model/deviceRackCatalog';

export const HIDE_ALL_PARAMS_INTERNAL_IDS = new Set([
    'internal://effect/tuner',
    'internal://effect/auto-shift',
    'internal://effect/shifter',
    'internal://effect/external-audio-effect',
    'internal://effect/looper',
]);

export const HIDDEN_SURFACE_PARAM_NAMES = new Set([
    'bypass', 'is_bypassed', 'enabled', 'active', 'latency', 'latency_frames',
    'lookahead_samples', 'meter', 'meter_l', 'meter_r', 'peak', 'peak_l', 'peak_r',
    'rms', 'rms_l', 'rms_r', 'sidechain', 'sidechain_source', 'sidechain_track',
]);

export const EFFECT_PARAM_WHITELIST: Partial<Record<DeviceSlot['effectType'], Set<string>>> = Object
    .entries(EFFECT_PARAM_CATALOG)
    .reduce((acc, [effectType, params]) => {
        if (!Array.isArray(params) || params.length === 0) return acc;
        acc[effectType as DeviceSlot['effectType']] = new Set(
            params.map((p) => p.name.toLowerCase().trim()),
        );
        return acc;
    }, {} as Partial<Record<DeviceSlot['effectType'], Set<string>>>);

export const EFFECT_PARAM_ORDER: Partial<Record<DeviceSlot['effectType'], Map<string, number>>> = Object
    .entries(EFFECT_PARAM_CATALOG)
    .reduce((acc, [effectType, params]) => {
        if (!Array.isArray(params) || params.length === 0) return acc;
        const order = new Map<string, number>();
        params.forEach((param, idx) => {
            order.set(param.name.toLowerCase().trim(), idx);
        });
        acc[effectType as DeviceSlot['effectType']] = order;
        return acc;
    }, {} as Partial<Record<DeviceSlot['effectType'], Map<string, number>>>);

export const INTERNAL_PLUGIN_PARAM_ALLOWLIST: Record<string, Set<string>> = {
    // ── EQ variants ──────────────────────────────────────────────
    'internal://effect/eq-three': new Set(['lowfreq', 'low', 'lowq', 'midfreq', 'mid', 'midq', 'highfreq', 'high', 'highq', 'out']),
    'internal://effect/channel-eq': new Set(['lowfreq', 'low', 'midfreq', 'mid', 'highfreq', 'high', 'out']),
    // ── Dynamics ──────────────────────────────────────────────────
    'internal://effect/glue-compressor': new Set(['thr', 'ratio', 'atk', 'rel', 'makeup', 'range', 'mix', 'soft clip']),
    'internal://effect/multiband-dynamics': new Set(['xover low', 'xover high', 'lo thr', 'lo ratio', 'lo gain', 'mid thr', 'mid ratio', 'mid gain', 'hi thr', 'hi ratio', 'hi gain', 'output']),
    'internal://effect/transient-shaper': new Set(['attack', 'sustain', 'output', 'speed', 'mix']),
    // ── Delay variants ───────────────────────────────────────────
    'internal://effect/delay': new Set(['fb', 'filter', 'pingpong', 'mod rate', 'mod depth']),
    'internal://effect/simple-delay': new Set(['time l', 'time r', 'fb', 'dry/wet']),
    'internal://effect/filter-delay': new Set(['l delay', 'c delay', 'r delay', 'l filter', 'c filter', 'r filter', 'fb', 'mix']),
    'internal://effect/grain-delay': new Set(['delay', 'grain', 'pitch', 'spray', 'fb', 'mix', 'density']),
    'internal://effect/echo': new Set(['time l', 'time r', 'fb', 'dry/wet']),
    'internal://effect/spectral-time': new Set(['mode', 'amount', 'decay', 'tilt', 'mix']),
    'internal://effect/beat-repeat': new Set(['time l', 'fb', 'dry/wet']),
    // ── Reverb variants ──────────────────────────────────────────
    'internal://effect/hybrid-reverb': new Set(['size', 'decay', 'damp', 'early', 'late', 'predelay', 'mod depth', 'mix', 'width']),
    'internal://effect/corpus': new Set(['tune', 'decay', 'damp', 'type', 'spread', 'mix']),
    'internal://effect/resonators': new Set(['size', 'damp', 'predelay', 'dry/wet', 'width', 'low damp', 'mod depth']),
    'internal://effect/spectral-resonator': new Set(['size', 'damp', 'predelay', 'dry/wet', 'width', 'low damp', 'mod depth']),
    // ── Drive/Distortion variants ────────────────────────────────
    'internal://effect/drum-buss': new Set(['drive', 'crunch', 'boom', 'boom freq', 'transient', 'trim', 'mix']),
    'internal://effect/dynamic-tube': new Set(['drive', 'bias', 'envelope', 'tone', 'mix', 'output']),
    'internal://effect/amp': new Set(['gain', 'bass', 'mid', 'treble', 'presence', 'master', 'sag', 'mix']),
    'internal://effect/cabinet': new Set(['type', 'mic pos', 'lo cut', 'hi cut', 'resonance', 'output', 'mix']),
    'internal://effect/overdrive': new Set(['drive', 'tone', 'mix', 'output', 'bias', 'tight']),
    'internal://effect/pedal': new Set(['mode', 'drive', 'tone', 'level', 'mix']),
    'internal://effect/roar': new Set(['character', 'intensity', 'color', 'feedback', 'output', 'mix']),
    'internal://effect/erosion': new Set(['mode', 'frequency', 'amount', 'width', 'mix']),
    // ── Modulation ───────────────────────────────────────────────
    'internal://effect/phaser-flanger': new Set(['rate', 'depth', 'fb', 'blend', 'stages', 'mix', 'stereo']),
    'internal://effect/vocoder': new Set(['cutoff', 'res', 'mix']),
    // ── Analyzers ────────────────────────────────────────────────
    'internal://effect/spectrum': new Set(['reset']),
    // ── Standard Effects (curated knob sets) ─────────────────────
    'internal://effect/compressor': new Set(['thr', 'ratio', 'atk', 'rel', 'knee', 'makeup', 'mix', 'sc hpf']),
    'internal://effect/limiter': new Set(['thr', 'rel', 'ceil', 'lookahead', 'link']),
    'internal://effect/gate': new Set(['thr', 'atk', 'hold', 'rel', 'range', 'sc hpf', 'hysteresis']),
    'internal://effect/reverb': new Set(['size', 'damp', 'predelay', 'width', 'diffusion', 'lo cut', 'hi cut', 'voicing']),
    'internal://effect/chorus': new Set(['rate', 'depth', 'mix', 'fb', 'voices', 'spread']),
    'internal://effect/saturator': new Set(['drive', 'tone', 'mix', 'mode', 'output', 'color']),
    'internal://effect/distortion': new Set(['drive', 'tone', 'mix', 'mode', 'output', 'bias']),
    'internal://effect/bitcrusher': new Set(['bits', 'down', 'mix', 'jitter', 'pre freq', 'post freq']),
    'internal://effect/noise-machine': new Set(['level', 'type', 'stereo', 'lpfreq', 'hpfreq', 'pan']),
    'internal://effect/auto-filter': new Set(['cutoff', 'res', 'rate', 'depth', 'env', 'type', 'mix', 'lfo shape']),
    'internal://effect/auto-pan': new Set(['rate', 'depth', 'phase', 'shape', 'mix']),
    'internal://effect/phaser': new Set(['rate', 'depth', 'fb', 'stages', 'center', 'mix', 'spread']),
    'internal://effect/flanger': new Set(['rate', 'depth', 'fb', 'delay', 'mix', 'stereo', 'fb damp']),
    'internal://effect/utility': new Set(['gain', 'pan', 'width', 'mono']),
};


export const PLUGIN_TITLE_MAP: Record<string, string> = {
    'internal://effect/eq-eight': 'EQ Eight',
    'internal://effect/channel-eq': 'Channel EQ',
    'internal://effect/eq-three': 'EQ Three',
    'internal://effect/compressor': 'Compressor',
    'internal://effect/glue-compressor': 'Glue Compressor',
    'internal://effect/multiband-dynamics': 'Multiband Dynamics',
    'internal://effect/delay': 'Delay',
    'internal://effect/simple-delay': 'Simple Delay',
    'internal://effect/filter-delay': 'Filter Delay',
    'internal://effect/reverb': 'Reverb',
    'internal://effect/chorus': 'Chorus',
    'internal://effect/saturator': 'Saturator',
    'internal://effect/utility': 'Utility',
    'internal://effect/limiter': 'Limiter',
    'internal://effect/gate': 'Gate',
    'internal://effect/auto-filter': 'Auto Filter',
    'internal://effect/auto-pan': 'Auto Pan',
    'internal://effect/phaser': 'Phaser',
    'internal://effect/phaser-flanger': 'Phaser-Flanger',
    'internal://effect/flanger': 'Flanger',
    'internal://effect/distortion': 'Distortion',
    'internal://effect/bitcrusher': 'Bitcrusher',
    'internal://effect/analyzer': 'Analyzer',
    'internal://effect/noise-machine': 'Noise Machine',
    'internal://effect/amp': 'Amp',
    'internal://effect/cabinet': 'Cabinet',
    'internal://effect/erosion': 'Erosion',
    'internal://effect/overdrive': 'Overdrive',
    'internal://effect/pedal': 'Pedal',
    'internal://effect/roar': 'Roar',
    'internal://effect/echo': 'Echo',
    'internal://effect/beat-repeat': 'Beat Repeat',
    'internal://effect/looper': 'Looper',
    'internal://effect/spectral-time': 'Spectral Time',
    'internal://effect/grain-delay': 'Grain Delay',
    'internal://effect/hybrid-reverb': 'Hybrid Reverb',
    'internal://effect/corpus': 'Corpus',
    'internal://effect/resonators': 'Resonators',
    'internal://effect/spectral-resonator': 'Spectral Resonator',
    'internal://effect/drum-buss': 'Drum Buss',
    'internal://effect/dynamic-tube': 'Dynamic Tube',
    'internal://effect/tuner': 'Tuner',
    'internal://effect/external-audio-effect': 'External Audio Effect',
    'internal://effect/auto-shift': 'Auto Shift',
    'internal://effect/shifter': 'Shifter',
    'internal://effect/transient-shaper': 'Transient Shaper',
    'internal://effect/spectrum': 'Spectrum',
    'internal://midi-fx/pitch': 'Pitch',
    'internal://midi-fx/scale': 'Scale',
    'internal://midi-fx/velocity': 'Velocity',
    'internal://midi-fx/random': 'Random',
    'internal://midi-fx/chord': 'Chord',
    'internal://midi-fx/note-length': 'Note Length',
    'internal://midi-fx/cc-control': 'CC Control',
    'internal://midi-fx/expression-control': 'Expression Control',
    'internal://midi-fx/arpeggiator': 'Arpeggiator',
    'internal://effect/vocoder': 'Vocoder',
};
