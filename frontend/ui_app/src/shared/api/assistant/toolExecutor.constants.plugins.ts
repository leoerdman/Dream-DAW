import * as engineApi from '@/shared/api/engine';

export interface PluginEntry {
    pluginId: string;
    displayName: string;
}

export const INSTRUMENT_PRESETS: Record<string, PluginEntry> = {
    essence: { pluginId: 'internal://instrument/wave-synth', displayName: 'Essence' },
    sampler: { pluginId: 'internal://instrument/sampler', displayName: 'Sampler' },
};

const EFFECT_BY_ID: Record<number, PluginEntry> = {
    [engineApi.BuiltinEffectType.Eq]: { pluginId: 'internal://effect/eq', displayName: 'EQ' },
    [engineApi.BuiltinEffectType.Compressor]: { pluginId: 'internal://effect/compressor', displayName: 'Compressor' },
    [engineApi.BuiltinEffectType.Delay]: { pluginId: 'internal://effect/delay', displayName: 'Delay' },
    [engineApi.BuiltinEffectType.Reverb]: { pluginId: 'internal://effect/reverb', displayName: 'Reverb' },
    [engineApi.BuiltinEffectType.Chorus]: { pluginId: 'internal://effect/chorus', displayName: 'Chorus' },
    [engineApi.BuiltinEffectType.Utility]: { pluginId: 'internal://effect/utility', displayName: 'Utility' },
    [engineApi.BuiltinEffectType.Saturator]: { pluginId: 'internal://effect/saturator', displayName: 'Saturator' },
    [engineApi.BuiltinEffectType.Limiter]: { pluginId: 'internal://effect/limiter', displayName: 'Limiter' },
    [engineApi.BuiltinEffectType.Gate]: { pluginId: 'internal://effect/gate', displayName: 'Gate' },
    [engineApi.BuiltinEffectType.AutoFilter]: { pluginId: 'internal://effect/auto-filter', displayName: 'Auto Filter' },
    [engineApi.BuiltinEffectType.Phaser]: { pluginId: 'internal://effect/phaser', displayName: 'Phaser' },
    [engineApi.BuiltinEffectType.Flanger]: { pluginId: 'internal://effect/flanger', displayName: 'Flanger' },
    [engineApi.BuiltinEffectType.Distortion]: { pluginId: 'internal://effect/distortion', displayName: 'Distortion' },
    [engineApi.BuiltinEffectType.Bitcrusher]: { pluginId: 'internal://effect/bitcrusher', displayName: 'Bitcrusher' },
    [engineApi.BuiltinEffectType.NoiseMachine]: { pluginId: 'internal://effect/noise-machine', displayName: 'Noise Machine' },
    [engineApi.BuiltinEffectType.AutoPan]: { pluginId: 'internal://effect/auto-pan', displayName: 'Auto Pan' },
};

const EFFECT_BY_NAME: Record<string, PluginEntry> = {
    eq: EFFECT_BY_ID[engineApi.BuiltinEffectType.Eq],
    compressor: EFFECT_BY_ID[engineApi.BuiltinEffectType.Compressor],
    delay: EFFECT_BY_ID[engineApi.BuiltinEffectType.Delay],
    reverb: EFFECT_BY_ID[engineApi.BuiltinEffectType.Reverb],
    chorus: EFFECT_BY_ID[engineApi.BuiltinEffectType.Chorus],
    utility: EFFECT_BY_ID[engineApi.BuiltinEffectType.Utility],
    saturator: EFFECT_BY_ID[engineApi.BuiltinEffectType.Saturator],
    limiter: EFFECT_BY_ID[engineApi.BuiltinEffectType.Limiter],
    gate: EFFECT_BY_ID[engineApi.BuiltinEffectType.Gate],
    autofilter: EFFECT_BY_ID[engineApi.BuiltinEffectType.AutoFilter],
    'auto-filter': EFFECT_BY_ID[engineApi.BuiltinEffectType.AutoFilter],
    phaser: EFFECT_BY_ID[engineApi.BuiltinEffectType.Phaser],
    flanger: EFFECT_BY_ID[engineApi.BuiltinEffectType.Flanger],
    distortion: EFFECT_BY_ID[engineApi.BuiltinEffectType.Distortion],
    bitcrusher: EFFECT_BY_ID[engineApi.BuiltinEffectType.Bitcrusher],
    noisemachine: EFFECT_BY_ID[engineApi.BuiltinEffectType.NoiseMachine],
    'noise-machine': EFFECT_BY_ID[engineApi.BuiltinEffectType.NoiseMachine],
    autopan: EFFECT_BY_ID[engineApi.BuiltinEffectType.AutoPan],
    'auto-pan': EFFECT_BY_ID[engineApi.BuiltinEffectType.AutoPan],
};

export function resolveEffectEntry(effectArg: number | string): PluginEntry | undefined {
    return typeof effectArg === 'number'
        ? EFFECT_BY_ID[effectArg]
        : EFFECT_BY_NAME[String(effectArg).trim().toLowerCase()];
}
