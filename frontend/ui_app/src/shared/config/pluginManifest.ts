/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Dream DAW — Plugin Manifest (SSOT)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Centralized manifest for all plugin metadata: type classification,
 * display properties, UI capabilities, and card dimensions.
 *
 * This replaces the scattered inline maps that were previously
 * hardcoded across DeviceRack.tsx.
 */

// ── Types ──

export type PluginFormat = 'INT' | 'VST2' | 'VST3' | 'AU';
export type PluginCategory = 'instrument' | 'effect' | 'midi-fx';

export type DeviceEffectType =
    | 'eq'
    | 'compressor'
    | 'delay'
    | 'reverb'
    | 'chorus'
    | 'utility'
    | 'limiter'
    | 'gate'
    | 'autoFilter'
    | 'autoPan'
    | 'phaser'
    | 'flanger'
    | 'distortion'
    | 'bitcrusher'
    | 'noiseMachine'
    | 'spectrum'
    | 'midiPitch'
    | 'midiScale'
    | 'midiVelocity'
    | 'midiRandom'
    | 'vst'
    | 'instrument'
    | 'sampler'
    | 'saturator'
    | 'waveSynth'
    | 'rack';

export interface PluginManifestEntry {
    /** Internal plugin ID (e.g. 'internal://instrument/sampler') */
    id: string;
    /** Human-readable display name */
    name: string;
    /** High-level category */
    category: PluginCategory;
    /** Effect type for UI routing */
    effectType: DeviceEffectType;
    /** Plugin format label shown in header badge */
    format: PluginFormat;
    /** Whether the plugin has a native editor window (shows "UI" button) */
    hasEditor: boolean;
    /** Default card width in pixels */
    cardWidth: number;
    /** Whether the wrench / settings panel is available */
    supportsSettings: boolean;
    /** Whether the plugin supports sidechain input */
    supportsSidechain: boolean;
}

// ── Internal Plugin Registry ──

const INTERNAL_PLUGINS: PluginManifestEntry[] = [
    // ─── Instruments ───
    {
        id: 'internal://instrument/wave-synth',
        name: 'Wave Synth',
        category: 'instrument',
        effectType: 'waveSynth',
        format: 'INT',
        hasEditor: false,
        cardWidth: 980,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://instrument/sampler',
        name: 'Sampler',
        category: 'instrument',
        effectType: 'sampler',
        format: 'INT',
        hasEditor: false,
        cardWidth: 720,
        supportsSettings: true,
        supportsSidechain: false,
    },

    // ─── EQ ───
    {
        id: 'internal://effect/eq-eight',
        name: 'EQ Eight',
        category: 'effect',
        effectType: 'eq',
        format: 'INT',
        hasEditor: false,
        cardWidth: 860,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/channel-eq',
        name: 'Channel EQ',
        category: 'effect',
        effectType: 'eq',
        format: 'INT',
        hasEditor: false,
        cardWidth: 860,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/eq-three',
        name: 'EQ Three',
        category: 'effect',
        effectType: 'eq',
        format: 'INT',
        hasEditor: false,
        cardWidth: 860,
        supportsSettings: true,
        supportsSidechain: false,
    },

    // ─── Dynamics ───
    {
        id: 'internal://effect/compressor',
        name: 'Compressor',
        category: 'effect',
        effectType: 'compressor',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: true,
    },
    {
        id: 'internal://effect/multiband-dynamics',
        name: 'Multiband Dynamics',
        category: 'effect',
        effectType: 'compressor',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: true,
    },
    {
        id: 'internal://effect/transient-shaper',
        name: 'Transient Shaper',
        category: 'effect',
        effectType: 'compressor',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/limiter',
        name: 'Limiter',
        category: 'effect',
        effectType: 'limiter',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/gate',
        name: 'Gate',
        category: 'effect',
        effectType: 'gate',
        format: 'INT',
        hasEditor: false,
        cardWidth: 340,
        supportsSettings: true,
        supportsSidechain: true,
    },

    // ─── Time-Based ───
    {
        id: 'internal://effect/delay',
        name: 'Delay',
        category: 'effect',
        effectType: 'delay',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/echo',
        name: 'Echo',
        category: 'effect',
        effectType: 'delay',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/grain-delay',
        name: 'Grain Delay',
        category: 'effect',
        effectType: 'delay',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/beat-repeat',
        name: 'Beat Repeat',
        category: 'effect',
        effectType: 'delay',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/looper',
        name: 'Looper',
        category: 'effect',
        effectType: 'delay',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/spectral-time',
        name: 'Spectral Time',
        category: 'effect',
        effectType: 'delay',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },

    // ─── Reverb ───
    {
        id: 'internal://effect/reverb',
        name: 'Reverb',
        category: 'effect',
        effectType: 'reverb',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/hybrid-reverb',
        name: 'Hybrid Reverb',
        category: 'effect',
        effectType: 'reverb',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/corpus',
        name: 'Corpus',
        category: 'effect',
        effectType: 'reverb',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/resonators',
        name: 'Resonators',
        category: 'effect',
        effectType: 'reverb',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/spectral-resonator',
        name: 'Spectral Resonator',
        category: 'effect',
        effectType: 'reverb',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },

    // ─── Modulation ───
    {
        id: 'internal://effect/chorus',
        name: 'Chorus',
        category: 'effect',
        effectType: 'chorus',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/auto-filter',
        name: 'Auto Filter',
        category: 'effect',
        effectType: 'autoFilter',
        format: 'INT',
        hasEditor: false,
        cardWidth: 360,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/vocoder',
        name: 'Vocoder',
        category: 'effect',
        effectType: 'autoFilter',
        format: 'INT',
        hasEditor: false,
        cardWidth: 360,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/auto-pan',
        name: 'Auto Pan',
        category: 'effect',
        effectType: 'autoPan',
        format: 'INT',
        hasEditor: false,
        cardWidth: 360,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/phaser',
        name: 'Phaser',
        category: 'effect',
        effectType: 'phaser',
        format: 'INT',
        hasEditor: false,
        cardWidth: 360,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/flanger',
        name: 'Flanger',
        category: 'effect',
        effectType: 'flanger',
        format: 'INT',
        hasEditor: false,
        cardWidth: 360,
        supportsSettings: true,
        supportsSidechain: false,
    },

    // ─── Saturation / Distortion ───
    {
        id: 'internal://effect/saturator',
        name: 'Saturator',
        category: 'effect',
        effectType: 'saturator',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/drum-buss',
        name: 'Drum Buss',
        category: 'effect',
        effectType: 'saturator',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/dynamic-tube',
        name: 'Dynamic Tube',
        category: 'effect',
        effectType: 'saturator',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/distortion',
        name: 'Distortion',
        category: 'effect',
        effectType: 'distortion',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/amp',
        name: 'Amp',
        category: 'effect',
        effectType: 'distortion',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/cabinet',
        name: 'Cabinet',
        category: 'effect',
        effectType: 'distortion',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/overdrive',
        name: 'Overdrive',
        category: 'effect',
        effectType: 'distortion',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/pedal',
        name: 'Pedal',
        category: 'effect',
        effectType: 'distortion',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/roar',
        name: 'Roar',
        category: 'effect',
        effectType: 'distortion',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/erosion',
        name: 'Erosion',
        category: 'effect',
        effectType: 'distortion',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/bitcrusher',
        name: 'Bitcrusher',
        category: 'effect',
        effectType: 'bitcrusher',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },

    // ─── Utility ───
    {
        id: 'internal://effect/utility',
        name: 'Utility',
        category: 'effect',
        effectType: 'utility',
        format: 'INT',
        hasEditor: false,
        cardWidth: 360,
        supportsSettings: false,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/tuner',
        name: 'Tuner',
        category: 'effect',
        effectType: 'utility',
        format: 'INT',
        hasEditor: false,
        cardWidth: 360,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/auto-shift',
        name: 'Auto Shift',
        category: 'effect',
        effectType: 'utility',
        format: 'INT',
        hasEditor: false,
        cardWidth: 360,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/shifter',
        name: 'Shifter',
        category: 'effect',
        effectType: 'utility',
        format: 'INT',
        hasEditor: false,
        cardWidth: 360,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/external-audio-effect',
        name: 'External Audio Effect',
        category: 'effect',
        effectType: 'utility',
        format: 'INT',
        hasEditor: false,
        cardWidth: 360,
        supportsSettings: true,
        supportsSidechain: false,
    },

    // ─── Analyzers ───
    {
        id: 'internal://effect/noise-machine',
        name: 'Noise Machine',
        category: 'effect',
        effectType: 'noiseMachine',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://effect/spectrum',
        name: 'Spectrum',
        category: 'effect',
        effectType: 'spectrum',
        format: 'INT',
        hasEditor: false,
        cardWidth: 520,
        supportsSettings: true,
        supportsSidechain: false,
    },

    // ─── MIDI FX ───
    {
        id: 'internal://midi-fx/pitch',
        name: 'MIDI Pitch',
        category: 'midi-fx',
        effectType: 'midiPitch',
        format: 'INT',
        hasEditor: false,
        cardWidth: 320,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://midi-fx/scale',
        name: 'MIDI Scale',
        category: 'midi-fx',
        effectType: 'midiScale',
        format: 'INT',
        hasEditor: false,
        cardWidth: 320,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://midi-fx/chord',
        name: 'Chord',
        category: 'midi-fx',
        effectType: 'midiScale',
        format: 'INT',
        hasEditor: false,
        cardWidth: 320,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://midi-fx/velocity',
        name: 'MIDI Velocity',
        category: 'midi-fx',
        effectType: 'midiVelocity',
        format: 'INT',
        hasEditor: false,
        cardWidth: 320,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://midi-fx/note-length',
        name: 'Note Length',
        category: 'midi-fx',
        effectType: 'midiVelocity',
        format: 'INT',
        hasEditor: false,
        cardWidth: 320,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://midi-fx/cc-control',
        name: 'CC Control',
        category: 'midi-fx',
        effectType: 'midiVelocity',
        format: 'INT',
        hasEditor: false,
        cardWidth: 320,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://midi-fx/expression-control',
        name: 'Expression Control',
        category: 'midi-fx',
        effectType: 'midiVelocity',
        format: 'INT',
        hasEditor: false,
        cardWidth: 320,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://midi-fx/random',
        name: 'MIDI Random',
        category: 'midi-fx',
        effectType: 'midiRandom',
        format: 'INT',
        hasEditor: false,
        cardWidth: 320,
        supportsSettings: true,
        supportsSidechain: false,
    },
    {
        id: 'internal://midi-fx/arpeggiator',
        name: 'Arpeggiator',
        category: 'midi-fx',
        effectType: 'midiRandom',
        format: 'INT',
        hasEditor: false,
        cardWidth: 320,
        supportsSettings: true,
        supportsSidechain: false,
    },
];

// ── Lookup Index: pluginId → ManifestEntry ──

const INTERNAL_INDEX = new Map<string, PluginManifestEntry>();
for (const entry of INTERNAL_PLUGINS) {
    INTERNAL_INDEX.set(entry.id, entry);
}

// ── External Plugin Format Detection ──

function detectFormat(pluginId: string): PluginFormat {
    const lower = pluginId.toLowerCase();
    if (lower.includes('.vst3') || lower.includes('vst3')) return 'VST3';
    if (lower.includes('.vst') || lower.includes('vst2')) return 'VST2';
    if (lower.includes('.component') || lower.includes('audiounit')) return 'AU';
    return 'VST3'; // default for unknown external
}

/**
 * Detects the effectType for an external plugin from its name,
 * using heuristic keyword matching.
 */
function detectExternalEffectType(name: string, isInstrument: boolean): DeviceEffectType {
    if (isInstrument) return 'instrument';
    const n = name.toLowerCase();
    if (n.includes('sampler')) return 'sampler';
    if (n.includes('eq') || n.includes('equalizer') || n.includes('pro-q') || n.includes('fabfilter q')) return 'eq';
    if (n.includes('compressor') || n.includes('comp') || n.includes('dynamics') || n.includes('pro-c') || n.includes('opto')) return 'compressor';
    if (n.includes('delay') || n.includes('echo') || n.includes('h-delay') || n.includes('timeless')) return 'delay';
    if (n.includes('reverb') || n.includes('valhalla') || n.includes('room') || n.includes('plate') || n.includes('shimmer')) return 'reverb';
    if (n.includes('chorus')) return 'chorus';
    if (n.includes('saturator') || n.includes('drum buss') || n.includes('dynamic tube')) return 'saturator';
    if (n.includes('limiter') || n.includes('pro-l')) return 'limiter';
    if (n.includes('gate')) return 'gate';
    if (n.includes('auto pan') || n.includes('auto-pan') || n.includes('autopan')) return 'autoPan';
    if (n.includes('auto filter') || n.includes('auto-filter') || n.includes('autofilter') || n.includes('vocoder')) return 'autoFilter';
    if (n.includes('phaser')) return 'phaser';
    if (n.includes('flanger')) return 'flanger';
    if (n.includes('distortion') || n.includes('amp') || n.includes('cabinet') || n.includes('overdrive') || n.includes('pedal') || n.includes('roar')) return 'distortion';
    if (n.includes('bitcrusher') || n.includes('bit-crusher')) return 'bitcrusher';
    if (n.includes('noise-machine') || n.includes('noise machine') || n.includes('noisemachine')) return 'noiseMachine';
    if (n.includes('spectrum')) return 'spectrum';
    if (n.includes('arpeggiator')) return 'midiRandom';
    if (n.includes('chord')) return 'midiScale';
    if (n.includes('note length') || n.includes('cc control') || n.includes('expression control')) return 'midiVelocity';
    return 'vst';
}

// ── Default card widths by effectType (for externals without exact manifest entry) ──

const EFFECT_TYPE_DEFAULT_WIDTHS: Partial<Record<DeviceEffectType, number>> = {
    waveSynth: 560,
    sampler: 520,
    instrument: 420,
    eq: 420,
    compressor: 520,
    delay: 520,
    reverb: 520,
    chorus: 520,
    saturator: 520,
    limiter: 520,
    gate: 340,
    autoFilter: 360,
    autoPan: 360,
    phaser: 360,
    flanger: 360,
    distortion: 520,
    bitcrusher: 520,
    noiseMachine: 520,
    spectrum: 520,
    midiPitch: 320,
    midiScale: 320,
    midiVelocity: 320,
    midiRandom: 320,
    utility: 360,
    vst: 160,
    rack: 720,
};

// ── Public API ──

export interface ResolvedPlugin {
    effectType: DeviceEffectType;
    format: PluginFormat;
    hasEditor: boolean;
    cardWidth: number;
    supportsSettings: boolean;
    supportsSidechain: boolean;
    category: PluginCategory;
    displayName: string;
}

/**
 * Resolves full plugin metadata from a plugin ID and name.
 *
 * For internal plugins, returns the exact manifest entry.
 * For external plugins, infers metadata from the plugin ID and name.
 *
 * @param pluginId   Plugin identifier (e.g. 'internal://effect/eq-eight' or '/Library/.../Serum.vst3')
 * @param name       Display name of the plugin
 * @param source     'internal' | 'vst' | 'unknown'
 * @param isInstrumentSlot  Whether the slot is in the instrument position on the track
 */
export function resolvePlugin(
    pluginId: string,
    name: string,
    source: 'internal' | 'vst' | 'unknown',
    isInstrumentSlot = false,
): ResolvedPlugin {
    // 1. Try exact internal lookup
    const internal = INTERNAL_INDEX.get(pluginId);
    if (internal) {
        return {
            effectType: internal.effectType,
            format: internal.format,
            hasEditor: internal.hasEditor,
            cardWidth: internal.cardWidth,
            supportsSettings: internal.supportsSettings,
            supportsSidechain: internal.supportsSidechain,
            category: internal.category,
            displayName: internal.name,
        };
    }

    // 2. External plugin — infer from ID and name
    const format = source === 'internal' ? 'INT' as PluginFormat : detectFormat(pluginId);
    const isVstFormat = format === 'VST2' || format === 'VST3' || format === 'AU';
    const effectType = detectExternalEffectType(name, isInstrumentSlot);
    const category: PluginCategory = isInstrumentSlot ? 'instrument' : 'effect';
    const cardWidth = EFFECT_TYPE_DEFAULT_WIDTHS[effectType] ?? 160;

    return {
        effectType,
        format,
        hasEditor: isVstFormat, // All external VSTs have native editors
        cardWidth,
        supportsSettings: true, // All plugins support settings panel
        supportsSidechain: effectType === 'compressor' || effectType === 'gate',
        category,
        displayName: name,
    };
}

/**
 * Returns the effectType to pluginId mapping (legacy compatibility).
 * Use `resolvePlugin()` for new code.
 */
export function getEffectTypeByPluginId(pluginId: string): DeviceEffectType | undefined {
    return INTERNAL_INDEX.get(pluginId)?.effectType;
}

/**
 * Format badge color for the header.
 */
export function formatBadgeColor(format: PluginFormat): string {
    switch (format) {
        case 'VST3': return '#2ecc71';
        case 'VST2': return '#ffb36a';
        case 'AU': return '#5dade2';
        case 'INT': return 'var(--color-text-tertiary)';
    }
}
