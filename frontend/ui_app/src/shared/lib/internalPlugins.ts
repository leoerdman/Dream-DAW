export type InternalPluginKind = 'instrument' | 'effect';

export interface InternalPluginDefinition {
    id: string;
    name: string;
    kind: InternalPluginKind;
    slotHint: 'instrument' | 'effect';
    tags: string[];
}

export const INTERNAL_INSTRUMENT_PLUGINS: InternalPluginDefinition[] = [
    {
        id: 'internal://instrument/wave-synth',
        name: 'Wave Synth',
        kind: 'instrument',
        slotHint: 'instrument',
        tags: ['internal', 'instrument', 'synth', 'wave'],
    },
    {
        id: 'internal://instrument/sampler',
        name: 'Sampler',
        kind: 'instrument',
        slotHint: 'instrument',
        tags: ['internal', 'instrument', 'sampler'],
    },
];

export const INTERNAL_EFFECT_PLUGINS: InternalPluginDefinition[] = [
    {
        id: 'internal://effect/eq-eight',
        name: 'EQ Eight',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'eq'],
    },
    {
        id: 'internal://effect/compressor',
        name: 'Compressor',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'dynamics'],
    },
    {
        id: 'internal://effect/delay',
        name: 'Delay',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'time'],
    },
    {
        id: 'internal://effect/reverb',
        name: 'Reverb',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'space'],
    },
    {
        id: 'internal://effect/chorus',
        name: 'Chorus',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'modulation'],
    },
    {
        id: 'internal://effect/saturator',
        name: 'Saturator',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'drive'],
    },
    {
        id: 'internal://effect/utility',
        name: 'Utility',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'utility'],
    },
    {
        id: 'internal://effect/limiter',
        name: 'Limiter',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'dynamics', 'mastering'],
    },
    {
        id: 'internal://effect/gate',
        name: 'Gate',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'dynamics'],
    },
    {
        id: 'internal://effect/auto-filter',
        name: 'Auto Filter',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'filter', 'modulation'],
    },
    {
        id: 'internal://effect/auto-pan',
        name: 'Auto Pan',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'modulation', 'stereo'],
    },
    {
        id: 'internal://effect/phaser',
        name: 'Phaser',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'modulation'],
    },
    {
        id: 'internal://effect/flanger',
        name: 'Flanger',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'modulation'],
    },
    {
        id: 'internal://effect/distortion',
        name: 'Distortion',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'drive'],
    },
    {
        id: 'internal://effect/bitcrusher',
        name: 'Bitcrusher',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'lofi'],
    },
    {
        id: 'internal://effect/spectrum',
        name: 'Spectrum',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'analyzer'],
    },
    {
        id: 'internal://midi-fx/pitch',
        name: 'MIDI Pitch',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'midi-fx', 'pitch'],
    },
    {
        id: 'internal://midi-fx/scale',
        name: 'MIDI Scale',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'midi-fx', 'scale'],
    },
    {
        id: 'internal://midi-fx/velocity',
        name: 'MIDI Velocity',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'midi-fx', 'velocity'],
    },
    {
        id: 'internal://midi-fx/random',
        name: 'MIDI Random',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'midi-fx', 'random'],
    },
    {
        id: 'internal://effect/noise-machine',
        name: 'Noise Machine',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'generator', 'noise'],
    },
];

export const INTERNAL_PLUGIN_ALIASES: Record<string, string> = {
    'internal://instrument/simple-sine-synth': 'internal://instrument/wave-synth',
    // Ableton-style aliases (import compatibility)
    'ableton://device/operator': 'internal://instrument/wave-synth',
    'ableton://device/analog': 'internal://instrument/wave-synth',
    'ableton://device/wavetable': 'internal://instrument/wave-synth',
    'operator': 'internal://instrument/wave-synth',
    'analog': 'internal://instrument/wave-synth',
    'wavetable': 'internal://instrument/wave-synth',
    'original simpler': 'internal://instrument/sampler',
    'originalsimpler': 'internal://instrument/sampler',
    'simpler': 'internal://instrument/sampler',
    'eq8': 'internal://effect/eq-eight',
    'eq eight': 'internal://effect/eq-eight',
    'eqeight': 'internal://effect/eq-eight',
    'eq three': 'internal://effect/eq-eight',
    'eq3': 'internal://effect/eq-eight',
    'eqthree': 'internal://effect/eq-eight',
    'channel eq': 'internal://effect/eq-eight',
    'channeleq': 'internal://effect/eq-eight',
    'compressor': 'internal://effect/compressor',
    'compressor2': 'internal://effect/compressor',
    'glue compressor': 'internal://effect/compressor',
    'gluecompressor': 'internal://effect/compressor',
    'multiband dynamics': 'internal://effect/compressor',
    'multibanddynamics': 'internal://effect/compressor',
    'stereogain': 'internal://effect/utility',
    'simple delay': 'internal://effect/delay',
    'simpledelay': 'internal://effect/delay',
    'ping pong delay': 'internal://effect/delay',
    'pingpongdelay': 'internal://effect/delay',
    'echo': 'internal://effect/delay',
    'reverb': 'internal://effect/reverb',
    'hybrid reverb': 'internal://effect/reverb',
    'hybridreverb': 'internal://effect/reverb',
    'chorus-ensemble': 'internal://effect/chorus',
    'chorus ensemble': 'internal://effect/chorus',
    'chorusensemble': 'internal://effect/chorus',
    'chorus2': 'internal://effect/chorus',
    'saturator': 'internal://effect/saturator',
    'overdrive': 'internal://effect/distortion',
    'pedal': 'internal://effect/distortion',
    'amp': 'internal://effect/distortion',
    'cabinet': 'internal://effect/distortion',
    'redux': 'internal://effect/bitcrusher',
    'auto filter': 'internal://effect/auto-filter',
    'autofilter': 'internal://effect/auto-filter',
    'autofilter2': 'internal://effect/auto-filter',
    'auto pan': 'internal://effect/auto-pan',
    'autopan': 'internal://effect/auto-pan',
    'autopan2': 'internal://effect/auto-pan',
    'phaser-flanger': 'internal://effect/phaser',
    'phaserflanger': 'internal://effect/phaser',
    'phasernew': 'internal://effect/phaser',
    'utility': 'internal://effect/utility',
    'gate': 'internal://effect/gate',
    'limiter': 'internal://effect/limiter',
    'noise machine': 'internal://effect/noise-machine',
    'noisemachine': 'internal://effect/noise-machine',
    'spectrum': 'internal://effect/spectrum',
    'midipitcher': 'internal://midi-fx/pitch',
    'midinotelength': 'internal://midi-fx/velocity',
    'mxdevicescale': 'internal://midi-fx/scale',
    'mxdevicevelocity': 'internal://midi-fx/velocity',
    'mxdeviceaudioeffect': 'internal://effect/utility',
    'mxdevicemidieffect': 'internal://effect/utility',
    'mxdevicerandom': 'internal://midi-fx/random',
    'midirandom': 'internal://midi-fx/random',
    'instrumentvector': 'internal://instrument/wave-synth',
    'stringstudio': 'internal://instrument/wave-synth',
    'shifter': 'internal://effect/utility',
    'spectral': 'internal://effect/utility',
    'tuner': 'internal://effect/utility',
    'scale': 'internal://midi-fx/scale',
    'velocity': 'internal://midi-fx/velocity',
    'random': 'internal://midi-fx/random',
};

const byId = new Map<string, InternalPluginDefinition>(
    [...INTERNAL_INSTRUMENT_PLUGINS, ...INTERNAL_EFFECT_PLUGINS].map((plugin) => [plugin.id, plugin]),
);

export const normalizeInternalPluginId = (pluginId: string): string => {
    const normalized = pluginId.trim().toLowerCase();
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
            pluginName: 'Wave Synth',
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
