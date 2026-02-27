export type InternalPluginKind = 'instrument' | 'effect';
import { INTERNAL_INSTRUMENT_PLUGINS } from './internalInstrumentPlugins';
import { INTERNAL_EFFECT_PLUGINS } from './internalEffectPlugins';
export interface InternalPluginDefinition {
    id: string;
    name: string;
    kind: InternalPluginKind;
    slotHint: 'instrument' | 'effect';
    tags: string[];
}
export { INTERNAL_INSTRUMENT_PLUGINS };
export const HIDDEN_INTERNAL_EFFECT_IDS_IN_BROWSER = new Set<string>([
    'internal://effect/channel-eq',
    'internal://effect/eq-three',
    'internal://effect/glue-compressor',
    'internal://effect/multiband-dynamics',
    'internal://effect/transient-shaper',
    'internal://effect/echo',
    'internal://effect/simple-delay',
    'internal://effect/filter-delay',
    'internal://effect/grain-delay',
    'internal://effect/beat-repeat',
    'internal://effect/looper',
    'internal://effect/spectral-time',
    'internal://effect/hybrid-reverb',
    'internal://effect/corpus',
    'internal://effect/resonators',
    'internal://effect/spectral-resonator',
    'internal://effect/drum-buss',
    'internal://effect/dynamic-tube',
    'internal://effect/phaser-flanger',
    'internal://effect/amp',
    'internal://effect/cabinet',
    'internal://effect/overdrive',
    'internal://effect/pedal',
    'internal://effect/roar',
    'internal://effect/erosion',
    'internal://effect/tuner',
    'internal://effect/external-audio-effect',
    'internal://effect/auto-shift',
    'internal://effect/shifter',
    'internal://effect/vocoder',
    'internal://effect/spectrum',
]);
export const INTERNAL_EFFECT_PLUGINS_BROWSER: InternalPluginDefinition[] =
    INTERNAL_EFFECT_PLUGINS.filter((plugin) => !HIDDEN_INTERNAL_EFFECT_IDS_IN_BROWSER.has(plugin.id));
export const INTERNAL_PLUGIN_ALIASES: Record<string, string> = {
    'internal://instrument/simple-sine-synth': 'internal://instrument/wave-synth',
    'internal://instrument/sample-rack': 'internal://instrument/sample-rack',
    'ableton://device/operator': 'internal://instrument/wave-synth',
    'ableton://device/analog': 'internal://instrument/wave-synth',
    'ableton://device/wavetable': 'internal://instrument/wave-synth',
    'operator': 'internal://instrument/wave-synth',
    'analog': 'internal://instrument/wave-synth',
    'wavetable': 'internal://instrument/wave-synth',
    'original simpler': 'internal://instrument/sampler',
    'originalsimpler': 'internal://instrument/sampler',
    'simpler': 'internal://instrument/sampler',
    'eq': 'internal://effect/eq-eight',
    'internal://effect/eq': 'internal://effect/eq-eight',
    'internal://effect/eq8': 'internal://effect/eq-eight',
    'eq8': 'internal://effect/eq-eight',
    'eq eight': 'internal://effect/eq-eight',
    'eqeight': 'internal://effect/eq-eight',
    'eq three': 'internal://effect/eq-three',
    'band eq': 'internal://effect/eq-three',
    'eq3': 'internal://effect/eq-three',
    'eqthree': 'internal://effect/eq-three',
    'channel eq': 'internal://effect/channel-eq',
    'channeleq': 'internal://effect/channel-eq',
    'compressor': 'internal://effect/compressor',
    'compressor2': 'internal://effect/compressor',
    'glue compressor': 'internal://effect/glue-compressor',
    'gluecompressor': 'internal://effect/glue-compressor',
    'multiband dynamics': 'internal://effect/multiband-dynamics',
    'multibanddynamics': 'internal://effect/multiband-dynamics',
    'stereogain': 'internal://effect/utility',
    'simple delay': 'internal://effect/simple-delay',
    'simpledelay': 'internal://effect/simple-delay',
    'ping pong delay': 'internal://effect/delay',
    'pingpongdelay': 'internal://effect/delay',
    'echo': 'internal://effect/echo',
    'reverb': 'internal://effect/reverb',
    'hybrid reverb': 'internal://effect/hybrid-reverb',
    'hybridreverb': 'internal://effect/hybrid-reverb',
    'chorus-ensemble': 'internal://effect/chorus',
    'chorus ensemble': 'internal://effect/chorus',
    'chorusensemble': 'internal://effect/chorus',
    'chorus2': 'internal://effect/chorus',
    'saturator': 'internal://effect/saturator',
    'overdrive': 'internal://effect/overdrive',
    'pedal': 'internal://effect/pedal',
    'amp': 'internal://effect/amp',
    'cabinet': 'internal://effect/cabinet',
    'redux': 'internal://effect/bitcrusher',
    'auto filter': 'internal://effect/auto-filter',
    'autofilter': 'internal://effect/auto-filter',
    'autofilter2': 'internal://effect/auto-filter',
    'auto pan': 'internal://effect/auto-pan',
    'autopan': 'internal://effect/auto-pan',
    'autopan2': 'internal://effect/auto-pan',
    'phaser-flanger': 'internal://effect/phaser-flanger',
    'phaserflanger': 'internal://effect/phaser-flanger',
    'phasernew': 'internal://effect/phaser',
    'utility': 'internal://effect/utility',
    'gate': 'internal://effect/gate',
    'limiter': 'internal://effect/limiter',
    'noise machine': 'internal://effect/noise-machine',
    'noisemachine': 'internal://effect/noise-machine',
    'spectrum': 'internal://effect/spectrum',
    'midipitcher': 'internal://midi-fx/pitch',
    'midiarpeggiator': 'internal://midi-fx/arpeggiator',
    'midichord': 'internal://midi-fx/chord',
    'midinotelength': 'internal://midi-fx/note-length',
    'midivelocity': 'internal://midi-fx/velocity',
    'mxdevicescale': 'internal://midi-fx/scale',
    'mxdeviceinstrument': 'internal://instrument/wave-synth',
    'flow': 'internal://instrument/flow',
    'flow synth': 'internal://instrument/flow',
    'flow modular synth': 'internal://instrument/flow',
    'mxdevicevelocity': 'internal://midi-fx/velocity',
    'mxdeviceaudioeffect': 'internal://effect/utility',
    'mxdevicemidieffect': 'internal://effect/utility',
    'mxdevicerandom': 'internal://midi-fx/random',
    'midirandom': 'internal://midi-fx/random',
    'instrumentvector': 'internal://instrument/wave-synth',
    'instrumentmeld': 'internal://instrument/wave-synth',
    'stringstudio': 'internal://instrument/wave-synth',
    'loungelizard': 'internal://instrument/wave-synth',
    'drumcell': 'internal://instrument/sampler',
    'autoshift': 'internal://effect/auto-shift',
    'spectrumanalyzer': 'internal://effect/spectrum',
    'transmute': 'internal://effect/distortion',
    'shifter': 'internal://effect/shifter',
    'spectral': 'internal://effect/spectral-time',
    'tuner': 'internal://effect/tuner',
    'beat repeat': 'internal://effect/beat-repeat',
    'beatrepeat': 'internal://effect/beat-repeat',
    'filter delay': 'internal://effect/filter-delay',
    'filterdelay': 'internal://effect/filter-delay',
    'grain delay': 'internal://effect/grain-delay',
    'graindelay': 'internal://effect/grain-delay',
    'drum buss': 'internal://effect/drum-buss',
    'drumbuss': 'internal://effect/drum-buss',
    'dynamic tube': 'internal://effect/dynamic-tube',
    'dynamictube': 'internal://effect/dynamic-tube',
    'corpus': 'internal://effect/corpus',
    'resonators': 'internal://effect/resonators',
    'vocoder': 'internal://effect/vocoder',
    'looper': 'internal://effect/looper',
    'external audio effect': 'internal://effect/external-audio-effect',
    'spectral resonator': 'internal://effect/spectral-resonator',
    'spectral time': 'internal://effect/spectral-time',
    'roar': 'internal://effect/roar',
    'arpeggiator': 'internal://midi-fx/arpeggiator',
    'chord': 'internal://midi-fx/chord',
    'note length': 'internal://midi-fx/note-length',
    'cc control': 'internal://midi-fx/cc-control',
    'expression control': 'internal://midi-fx/expression-control',
    'transient shaper': 'internal://effect/transient-shaper',
    'transientshaper': 'internal://effect/transient-shaper',
    'scale': 'internal://midi-fx/scale',
    'velocity': 'internal://midi-fx/velocity',
    'random': 'internal://midi-fx/random',
};
const byId = new Map<string, InternalPluginDefinition>(
    [...INTERNAL_INSTRUMENT_PLUGINS, ...INTERNAL_EFFECT_PLUGINS].map((plugin) => [plugin.id, plugin]),
);
export const normalizeInternalPluginId = (pluginId: string): string => {
    const normalized = pluginId.trim().toLowerCase();
    if (normalized.startsWith('internal://')) {
        if (byId.has(normalized)) return normalized;
    }
    const compact = normalized.replace(/[^a-z0-9]+/g, '');
    return INTERNAL_PLUGIN_ALIASES[normalized] ?? INTERNAL_PLUGIN_ALIASES[compact] ?? normalized;
};
export const getInternalPluginById = (pluginId: string): InternalPluginDefinition | null => {
    const normalized = normalizeInternalPluginId(pluginId);
    return byId.get(normalized) ?? null;
};
export const isInternalPlugin = (pluginId: string): boolean =>
    getInternalPluginById(pluginId) !== null;
export const defaultInternalPluginForTrack = (
    trackType: string,
    hasInstrument: boolean,
): { pluginId: string; pluginName: string; slot: 'instrument' | 'effect' } => {
    const addInstrument = trackType === 'Midi' && !hasInstrument;
    if (addInstrument) {
        return {
            pluginId: 'internal://instrument/wave-synth',
            pluginName: 'Essence',
            slot: 'instrument',
        };
    }
    return {
        pluginId: 'internal://effect/utility',
        pluginName: 'Utility',
        slot: 'effect',
    };
};
export const waveformLabel = (index: number): string => {
    switch (Math.round(index)) {
        case 1:
            return 'Triangle';
        case 2:
            return 'Saw';
        case 3:
            return 'Square';
        default:
            return 'Sine';
    }
};
export const waveformIndexFromSamplePath = (samplePath?: string | null): number => {
    const normalized = (samplePath ?? '').trim().toLowerCase();
    if (!normalized.startsWith('internal://waveform/')) return 0;
    if (normalized.includes('triangle') || normalized.endsWith('/tri')) return 1;
    if (normalized.includes('saw')) return 2;
    if (normalized.includes('square') || normalized.endsWith('/pulse')) return 3;
    return 0;
};
