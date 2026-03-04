import { normalizeInternalPluginId } from '@/shared/lib/internalPlugins';
import { INTERNAL_PLUGINS_PART_1 } from '@/shared/config/pluginManifest.internal.part1';
import { INTERNAL_PLUGINS_PART_2 } from '@/shared/config/pluginManifest.internal.part2';
import { INTERNAL_PLUGINS_PART_3 } from '@/shared/config/pluginManifest.internal.part3';
import type {
    DeviceEffectType,
    PluginCategory,
    PluginFormat,
    PluginManifestEntry,
    ResolvedPlugin,
} from '@/shared/config/pluginManifest.types';

export type {
    DeviceEffectType,
    PluginCategory,
    PluginFormat,
    PluginManifestEntry,
    ResolvedPlugin,
} from '@/shared/config/pluginManifest.types';

const INTERNAL_PLUGINS: PluginManifestEntry[] = [
    ...INTERNAL_PLUGINS_PART_1,
    ...INTERNAL_PLUGINS_PART_2,
    ...INTERNAL_PLUGINS_PART_3,
];

const INTERNAL_INDEX = new Map<string, PluginManifestEntry>();
for (const entry of INTERNAL_PLUGINS) {
    INTERNAL_INDEX.set(entry.id, entry);
}

function detectFormat(pluginId: string): PluginFormat {
    const lower = pluginId.toLowerCase();
    if (lower.includes('.vst3') || lower.includes('vst3')) return 'VST3';
    if (lower.includes('.vst') || lower.includes('vst2')) return 'VST2';
    if (lower.includes('.component') || lower.includes('audiounit')) return 'AU';
    return 'VST3';
}

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
    if (n.includes('arpeggiator')) return 'midiArpeggiator';
    if (n.includes('chord')) return 'midiChord';
    if (n.includes('note length')) return 'midiNoteLength';
    if (n.includes('cc control')) return 'midiCcControl';
    if (n.includes('expression control')) return 'midiExpressionControl';
    return 'vst';
}

const EFFECT_TYPE_DEFAULT_WIDTHS: Partial<Record<DeviceEffectType, number>> = {
    waveSynth: 560,
    sampler: 520,
    sample_rack: 520,
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
    midiChord: 320,
    midiNoteLength: 320,
    midiCcControl: 320,
    midiExpressionControl: 320,
    midiArpeggiator: 320,
    midiVelocity: 320,
    midiRandom: 320,
    utility: 360,
    vst: 160,
    rack: 720,
};

export function resolvePlugin(
    pluginId: string,
    name: string,
    source: 'internal' | 'vst' | 'missing' | 'unknown',
    isInstrumentSlot = false,
): ResolvedPlugin {
    const normalizedInternalId = normalizeInternalPluginId(pluginId);
    const internal = INTERNAL_INDEX.get(normalizedInternalId) ?? INTERNAL_INDEX.get(pluginId);
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

    // ENTERPRISE: Rack plugin IDs from trackAdapter (e.g. 'internal://rack/instrument').
    if (pluginId.startsWith('internal://rack/')) {
        const effectType = 'rack' as DeviceEffectType;
        return {
            effectType,
            format: 'INT' as PluginFormat,
            hasEditor: false,
            cardWidth: EFFECT_TYPE_DEFAULT_WIDTHS[effectType] ?? 720,
            supportsSettings: false,
            supportsSidechain: false,
            category: isInstrumentSlot ? 'instrument' as PluginCategory : 'effect' as PluginCategory,
            displayName: name,
        };
    }

    const format = source === 'internal' ? 'INT' as PluginFormat : detectFormat(pluginId);
    const isVstFormat = format === 'VST2' || format === 'VST3' || format === 'AU';
    const effectType = detectExternalEffectType(name, isInstrumentSlot);
    const category: PluginCategory = isInstrumentSlot ? 'instrument' : 'effect';
    const cardWidth = isVstFormat ? 200 : (EFFECT_TYPE_DEFAULT_WIDTHS[effectType] ?? 200);

    return {
        effectType,
        format,
        hasEditor: isVstFormat,
        cardWidth,
        supportsSettings: true,
        supportsSidechain: effectType === 'compressor' || effectType === 'gate',
        category,
        displayName: name,
    };
}

export function getEffectTypeByPluginId(pluginId: string): DeviceEffectType | undefined {
    const normalizedInternalId = normalizeInternalPluginId(pluginId);
    return INTERNAL_INDEX.get(normalizedInternalId)?.effectType ?? INTERNAL_INDEX.get(pluginId)?.effectType;
}

export function formatBadgeColor(format: PluginFormat): string {
    switch (format) {
        case 'VST3': return 'var(--color-plugin-vst3)';
        case 'VST2': return 'var(--color-plugin-vst2)';
        case 'AU': return 'var(--color-plugin-au)';
        case 'INT': return 'var(--color-plugin-internal)';
    }
}
