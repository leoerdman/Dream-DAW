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
];

export const INTERNAL_PLUGIN_ALIASES: Record<string, string> = {
    'internal://instrument/simple-sine-synth': 'internal://instrument/wave-synth',
};

const byId = new Map<string, InternalPluginDefinition>(
    [...INTERNAL_INSTRUMENT_PLUGINS, ...INTERNAL_EFFECT_PLUGINS].map((plugin) => [plugin.id, plugin]),
);

export const normalizeInternalPluginId = (pluginId: string): string => {
    const normalized = pluginId.trim().toLowerCase();
    return INTERNAL_PLUGIN_ALIASES[normalized] ?? normalized;
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
