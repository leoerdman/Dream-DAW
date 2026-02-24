/* eslint-disable react-refresh/only-export-components */
import React from 'react';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import { normalizeInternalPluginId } from '@/shared/lib/internalPlugins';
import { EFFECT_PARAM_CATALOG } from '@/widgets/DeviceRack/model/deviceRackCatalog';

export const pluginPanelLayoutStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateRows: 'var(--token-size-px-90) auto',
    gap: 'var(--plugin-grid-gap)',
    height: '100%',
};

export const pluginPanelCardBaseStyle: React.CSSProperties = {
    border: 'var(--space-px) solid var(--plugin-card-border)',
    borderRadius: 'var(--plugin-card-radius)',
    padding: 'var(--plugin-card-pad-y) var(--plugin-card-pad-x)',
    display: 'grid',
    gridTemplateRows: '1fr auto',
    gap: 'var(--plugin-card-gap)',
    background: 'var(--plugin-card-bg-main)',
};

export const pluginPanelTitleStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--plugin-title-color)',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    fontWeight: 'var(--font-weight-bold)' as unknown as number,
};

export const pluginPanelMetaStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--plugin-meta-color)',
    fontFamily: 'var(--font-mono)',
};

export type SurfaceHandlers = {
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
    onApplyUtilityScene?: (scene: 'center' | 'mono' | 'wide') => void;
};

export function getParamValue(
    device: DeviceSlot,
    aliases: string[],
    fallback: number,
): number {
    const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
    const found = device.params.find((param) => normalizedAliases.includes(param.name.toLowerCase()));
    return found?.value ?? fallback;
}

/**
 * NaN-safe param value reader. Unlike `?.value ?? fallback`, this guards
 * against NaN (which passes the `??` null-coalescing check).
 */
export function safeParamValue(
    device: DeviceSlot,
    names: string | string[],
    fallback: number,
): number {
    const aliases = Array.isArray(names) ? names : [names];
    for (const alias of aliases) {
        const param = device.params.find((p) => p.name.toLowerCase() === alias.toLowerCase());
        if (param && Number.isFinite(param.value)) return param.value;
    }
    return fallback;
}

export type SurfaceParamRead = {
    value: number;
    suffix: string;
};

export const MIX_PARAM_ALIASES = [
    'dry/wet',
    'drywet',
    'dry_wet',
    'wet/dry',
    'mix',
    'blend',
    'wet',
    'wet level',
    'mix level',
    'amount',
] as const;

export function readSurfaceParam(
    device: DeviceSlot,
    names: string | readonly string[],
    fallback: number,
    fallbackSuffix = '',
): SurfaceParamRead {
    const aliases = Array.isArray(names) ? names : [names];
    for (const alias of aliases) {
        const param = device.params.find((p) => p.name.toLowerCase() === alias.toLowerCase());
        if (param && Number.isFinite(param.value)) {
            return {
                value: param.value,
                suffix: param.suffix ?? '',
            };
        }
    }
    return { value: fallback, suffix: fallbackSuffix };
}

export function resolveSurfaceParam(
    device: DeviceSlot,
    names: string | readonly string[],
): DeviceSlot['params'][number] | null {
    const aliases = Array.isArray(names) ? names : [names];
    for (const alias of aliases) {
        const found = device.params.find((p) => p.name.toLowerCase() === alias.toLowerCase());
        if (found) return found;
    }
    return null;
}

export function hasSurfaceParam(device: DeviceSlot, names: string | readonly string[]): boolean {
    const aliases = Array.isArray(names) ? names : [names];
    return aliases.some((alias) =>
        device.params.some((p) => p.name.toLowerCase() === alias.toLowerCase()),
    );
}

export function hasMixParam(device: DeviceSlot): boolean {
    return hasSurfaceParam(device, MIX_PARAM_ALIASES);
}

export function readMixSurfaceParam(device: DeviceSlot, fallback: number): SurfaceParamRead {
    return readSurfaceParam(device, MIX_PARAM_ALIASES, fallback, '%');
}

export function resolveMixParam(device: DeviceSlot): DeviceSlot['params'][number] | null {
    return resolveSurfaceParam(device, MIX_PARAM_ALIASES);
}

export function shouldShowDryWet(device: DeviceSlot): boolean {
    return resolveMixParam(device) != null;
}

type SurfaceParamFilterOptions = {
    omitMixWhenDryWet?: boolean;
};

const HIDE_ALL_PARAMS_INTERNAL_IDS = new Set([
    'internal://effect/tuner',
    'internal://effect/auto-shift',
    'internal://effect/shifter',
]);

const HIDDEN_SURFACE_PARAM_NAMES = new Set([
    'bypass',
    'is_bypassed',
    'enabled',
    'active',
    'latency',
    'latency_frames',
    'lookahead_samples',
    'meter',
    'meter_l',
    'meter_r',
    'peak',
    'peak_l',
    'peak_r',
    'rms',
    'rms_l',
    'rms_r',
    'sidechain',
    'sidechain_source',
    'sidechain_track',
]);

function semanticParamKey(name: string): string {
    const normalized = name.toLowerCase();
    if (MIX_PARAM_ALIASES.includes(normalized as (typeof MIX_PARAM_ALIASES)[number])) {
        return 'mix';
    }
    return normalized;
}

const EFFECT_PARAM_WHITELIST: Partial<Record<DeviceSlot['effectType'], Set<string>>> = Object
    .entries(EFFECT_PARAM_CATALOG)
    .reduce((acc, [effectType, params]) => {
        if (!Array.isArray(params) || params.length === 0) return acc;
        acc[effectType as DeviceSlot['effectType']] = new Set(
            params.map((p) => p.name.toLowerCase().trim()),
        );
        return acc;
    }, {} as Partial<Record<DeviceSlot['effectType'], Set<string>>>);

export function buildSurfaceKnobParams(
    device: DeviceSlot,
    options: SurfaceParamFilterOptions = {},
): DeviceSlot['params'] {
    const { omitMixWhenDryWet = false } = options;
    const isInternal = device.source === 'internal';
    const normalizedInternalId = normalizeInternalPluginId(
        device.pluginId || (device.guiMode || '').toLowerCase() || device.name.toLowerCase(),
    );
    if (isInternal && HIDE_ALL_PARAMS_INTERNAL_IDS.has(normalizedInternalId)) {
        return [];
    }
    const allowedParamsForEffect = EFFECT_PARAM_WHITELIST[device.effectType];
    const useEffectWhitelist = isInternal && !!allowedParamsForEffect && allowedParamsForEffect.size > 0;
    const bySemantic = new Map<string, DeviceSlot['params'][number]>();
    for (const param of device.params) {
        const normalized = param.name.toLowerCase().trim();
        if (!normalized) continue;
        if (normalized.startsWith('_')) continue;
        if (isInternal && HIDDEN_SURFACE_PARAM_NAMES.has(normalized)) continue;
        if (useEffectWhitelist && !allowedParamsForEffect?.has(normalized)) continue;
        if (
            omitMixWhenDryWet &&
            MIX_PARAM_ALIASES.includes(normalized as (typeof MIX_PARAM_ALIASES)[number])
        ) {
            continue;
        }
        const semantic = semanticParamKey(normalized);
        const existing = bySemantic.get(semantic);
        if (!existing) {
            bySemantic.set(semantic, param);
            continue;
        }
        if (semantic === 'mix') {
            const existingIdx = MIX_PARAM_ALIASES.indexOf(existing.name.toLowerCase() as (typeof MIX_PARAM_ALIASES)[number]);
            const nextIdx = MIX_PARAM_ALIASES.indexOf(normalized as (typeof MIX_PARAM_ALIASES)[number]);
            if ((nextIdx >= 0 && existingIdx < 0) || (nextIdx >= 0 && nextIdx < existingIdx)) {
                bySemantic.set(semantic, param);
            }
        }
    }
    return Array.from(bySemantic.values());
}

export function formatSurfaceParam(
    param: SurfaceParamRead,
    decimals?: number,
): string {
    let value = param.value;
    const suffix = (param.suffix ?? '').trim();
    // Normalize 0..1 percentages for UI cards where runtime reports normalized values.
    if (suffix === '%' && Math.abs(value) <= 1.0) {
        value *= 100;
    }
    const precision = typeof decimals === 'number'
        ? decimals
        : (suffix === 'dB' || suffix === 'Hz' || suffix === 'ms' ? 1 : 0);
    const valueText = Number.isFinite(value) ? value.toFixed(precision) : '0';
    if (!suffix) return valueText;
    if (suffix === '%' || suffix === '°' || suffix === 'x') return `${valueText}${suffix}`;
    return `${valueText} ${suffix}`;
}

/**
 * Enterprise title lookup map for internal plugin IDs.
 * Replaces deeply nested ternary chains across all surface files.
 */
export const PLUGIN_TITLE_MAP: Record<string, string> = {
    // Core FX (SSOT coverage)
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

    // Distortion
    'internal://effect/amp': 'Amp',
    'internal://effect/cabinet': 'Cabinet',
    'internal://effect/erosion': 'Erosion',
    'internal://effect/overdrive': 'Overdrive',
    'internal://effect/pedal': 'Pedal',
    'internal://effect/roar': 'Roar',
    // Delay / Time
    'internal://effect/echo': 'Echo',
    'internal://effect/beat-repeat': 'Beat Repeat',
    'internal://effect/looper': 'Looper',
    'internal://effect/spectral-time': 'Spectral Time',
    'internal://effect/grain-delay': 'Grain Delay',
    // Reverb
    'internal://effect/hybrid-reverb': 'Hybrid Reverb',
    'internal://effect/corpus': 'Corpus',
    'internal://effect/resonators': 'Resonators',
    'internal://effect/spectral-resonator': 'Spectral Resonator',
    // Saturator
    'internal://effect/drum-buss': 'Drum Buss',
    'internal://effect/dynamic-tube': 'Dynamic Tube',
    // Utility
    'internal://effect/tuner': 'Tuner',
    'internal://effect/external-audio-effect': 'External Audio Effect',
    'internal://effect/auto-shift': 'Auto Shift',
    'internal://effect/shifter': 'Shifter',
    // Compressor
    'internal://effect/transient-shaper': 'Transient Shaper',
    // Analyzer / Spectrum
    'internal://effect/spectrum': 'Spectrum',
    // MIDI FX
    'internal://midi-fx/pitch': 'Pitch',
    'internal://midi-fx/scale': 'Scale',
    'internal://midi-fx/velocity': 'Velocity',
    'internal://midi-fx/random': 'Random',
    'internal://midi-fx/chord': 'Chord',
    'internal://midi-fx/note-length': 'Note Length',
    'internal://midi-fx/cc-control': 'CC Control',
    'internal://midi-fx/expression-control': 'Expression Control',
    'internal://midi-fx/arpeggiator': 'Arpeggiator',
    // Modulation
    'internal://effect/vocoder': 'Vocoder',
};
