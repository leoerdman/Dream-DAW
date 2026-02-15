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
        name: 'Essense',
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
        name: 'EQ',
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
        id: 'internal://effect/channel-eq',
        name: 'Channel EQ',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'eq'],
    },
    {
        id: 'internal://effect/eq-three',
        name: 'Band EQ',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'eq', 'dj'],
    },
    {
        id: 'internal://effect/multiband-dynamics',
        name: 'Multiband Dynamics',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'dynamics', 'multiband'],
    },
    {
        id: 'internal://effect/echo',
        name: 'Echo',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'delay'],
    },
    {
        id: 'internal://effect/grain-delay',
        name: 'Grain Delay',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'delay', 'granular'],
    },
    {
        id: 'internal://effect/hybrid-reverb',
        name: 'Hybrid Reverb',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'reverb'],
    },
    {
        id: 'internal://effect/amp',
        name: 'Amp',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'drive', 'amp'],
    },
    {
        id: 'internal://effect/cabinet',
        name: 'Cabinet',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'amp'],
    },
    {
        id: 'internal://effect/overdrive',
        name: 'Overdrive',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'drive'],
    },
    {
        id: 'internal://effect/pedal',
        name: 'Pedal',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'drive'],
    },
    {
        id: 'internal://effect/drum-buss',
        name: 'Drum Buss',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'drums', 'drive'],
    },
    {
        id: 'internal://effect/dynamic-tube',
        name: 'Dynamic Tube',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'drive', 'tube'],
    },
    {
        id: 'internal://effect/erosion',
        name: 'Erosion',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'noise'],
    },
    {
        id: 'internal://effect/transient-shaper',
        name: 'Transient Shaper',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'dynamics', 'transient'],
    },
    {
        id: 'internal://effect/beat-repeat',
        name: 'Beat Repeat',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'rhythm', 'delay'],
    },
    {
        id: 'internal://effect/tuner',
        name: 'Tuner',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'utility', 'analyzer'],
    },
    {
        id: 'internal://effect/looper',
        name: 'Looper',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'performance'],
    },
    {
        id: 'internal://effect/auto-shift',
        name: 'Auto Shift',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'pitch'],
    },
    {
        id: 'internal://effect/shifter',
        name: 'Shifter',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'pitch'],
    },
    {
        id: 'internal://effect/vocoder',
        name: 'Vocoder',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'vocal'],
    },
    {
        id: 'internal://effect/corpus',
        name: 'Corpus',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'resonator'],
    },
    {
        id: 'internal://effect/resonators',
        name: 'Resonators',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'resonator'],
    },
    {
        id: 'internal://effect/spectral-resonator',
        name: 'Spectral Resonator',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'spectral'],
    },
    {
        id: 'internal://effect/spectral-time',
        name: 'Spectral Time',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'spectral', 'delay'],
    },
    {
        id: 'internal://effect/roar',
        name: 'Roar',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'drive', 'distortion'],
    },
    {
        id: 'internal://effect/external-audio-effect',
        name: 'External Audio Effect',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'effect', 'routing', 'external'],
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
        id: 'internal://midi-fx/arpeggiator',
        name: 'Arpeggiator',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'midi-fx', 'arp'],
    },
    {
        id: 'internal://midi-fx/chord',
        name: 'Chord',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'midi-fx', 'chord'],
    },
    {
        id: 'internal://midi-fx/note-length',
        name: 'Note Length',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'midi-fx', 'length'],
    },
    {
        id: 'internal://midi-fx/cc-control',
        name: 'CC Control',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'midi-fx', 'cc'],
    },
    {
        id: 'internal://midi-fx/expression-control',
        name: 'Expression Control',
        kind: 'effect',
        slotHint: 'effect',
        tags: ['internal', 'midi-fx', 'modulation'],
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
    'eq three': 'internal://effect/eq-three',
    'band eq': 'internal://effect/eq-three',
    'eq3': 'internal://effect/eq-three',
    'eqthree': 'internal://effect/eq-three',
    'channel eq': 'internal://effect/channel-eq',
    'channeleq': 'internal://effect/channel-eq',
    'compressor': 'internal://effect/compressor',
    'compressor2': 'internal://effect/compressor',
    'glue compressor': 'internal://effect/compressor',
    'gluecompressor': 'internal://effect/compressor',
    'multiband dynamics': 'internal://effect/multiband-dynamics',
    'multibanddynamics': 'internal://effect/multiband-dynamics',
    'stereogain': 'internal://effect/utility',
    'simple delay': 'internal://effect/delay',
    'simpledelay': 'internal://effect/delay',
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
    'midiarpeggiator': 'internal://midi-fx/arpeggiator',
    'midichord': 'internal://midi-fx/chord',
    'midinotelength': 'internal://midi-fx/note-length',
    'midivelocity': 'internal://midi-fx/velocity',
    'mxdevicescale': 'internal://midi-fx/scale',
    'mxdeviceinstrument': 'internal://instrument/wave-synth',
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
    'filter delay': 'internal://effect/delay',
    'filterdelay': 'internal://effect/delay',
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
            pluginName: 'Essense',
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
