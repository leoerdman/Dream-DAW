import type { InternalPluginDefinition } from './internalPlugins';

export const INTERNAL_INSTRUMENT_PLUGINS: InternalPluginDefinition[] = [
    {
        id: 'internal://instrument/wave-synth',
        name: 'Essence',
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
    {
        id: 'internal://instrument/sample-rack',
        name: 'Sample Rack',
        kind: 'instrument',
        slotHint: 'instrument',
        tags: ['internal', 'instrument', 'sampler', 'rack', 'drum'],
    },
];
