/* eslint-disable react-refresh/only-export-components */
import React from 'react';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import { normalizeInternalPluginId } from '@/shared/lib/internalPlugins';
import {
    EFFECT_PARAM_ORDER,
    EFFECT_PARAM_WHITELIST,
    HIDDEN_SURFACE_PARAM_NAMES,
    HIDE_ALL_PARAMS_INTERNAL_IDS,
    INTERNAL_PLUGIN_PARAM_ALLOWLIST,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardCatalog';
export { PLUGIN_TITLE_MAP } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardCatalog';

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
    fontWeight: 'var(--font-weight-bold)',
};

export const pluginPanelMetaStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--plugin-meta-color)',
    fontFamily: 'var(--font-role-data)',
};

export type SurfaceHandlers = {
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
    onParamContextMenu?: (e: React.MouseEvent, paramName: string) => void;
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
    const nonMixDeviceTypes: ReadonlySet<DeviceSlot['effectType']> = new Set([
        'instrument',
        'sampler',
        'sample_rack',
        'waveSynth',
        'midiPitch',
        'midiScale',
        'midiVelocity',
        'midiRandom',
        'midiChord',
        'midiNoteLength',
        'midiCcControl',
        'midiExpressionControl',
        'midiArpeggiator',
    ]);
    if (nonMixDeviceTypes.has(device.effectType)) return false;
    return resolveMixParam(device) != null;
}

type SurfaceParamFilterOptions = {
    omitMixWhenDryWet?: boolean;
};

function semanticParamKey(name: string): string {
    const normalized = name.toLowerCase();
    if (MIX_PARAM_ALIASES.includes(normalized as (typeof MIX_PARAM_ALIASES)[number])) {
        return 'mix';
    }
    return normalized;
}


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
    const pluginAllowlist = isInternal
        ? INTERNAL_PLUGIN_PARAM_ALLOWLIST[normalizedInternalId]
        : undefined;
    const allowedParamsForEffect = EFFECT_PARAM_WHITELIST[device.effectType];
    const useEffectWhitelist = isInternal && !!allowedParamsForEffect && allowedParamsForEffect.size > 0;
    const bySemantic = new Map<string, DeviceSlot['params'][number]>();
    for (const param of device.params) {
        const normalized = param.name.toLowerCase().trim();
        if (!normalized) continue;
        if (normalized.startsWith('_')) continue;
        if (isInternal && HIDDEN_SURFACE_PARAM_NAMES.has(normalized)) continue;
        if (pluginAllowlist && !pluginAllowlist.has(normalized)) continue;
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
    const out = Array.from(bySemantic.values());
    if (!isInternal) return out;

    const effectOrder = EFFECT_PARAM_ORDER[device.effectType];
    if (!effectOrder || effectOrder.size === 0) return out;

    out.sort((a, b) => {
        const aKey = a.name.toLowerCase().trim();
        const bKey = b.name.toLowerCase().trim();
        const aIdx = effectOrder.get(aKey);
        const bIdx = effectOrder.get(bKey);
        if (typeof aIdx === 'number' && typeof bIdx === 'number') return aIdx - bIdx;
        if (typeof aIdx === 'number') return -1;
        if (typeof bIdx === 'number') return 1;
        return aKey.localeCompare(bKey);
    });
    return out;
}

export function formatSurfaceParam(
    param: SurfaceParamRead,
    decimals?: number,
): string {
    let value = param.value;
    const suffix = (param.suffix ?? '').trim();
    // H01 FIX: Only normalize 0..1 → 0..100 when suffix is '%' AND value
    // is strictly in normalized range. Some DSP params already use 0..100
    // natively (e.g. noise machine stereo), so only scale if value ≤ 1.01.
    if (suffix === '%' && value >= 0.0 && value <= 1.01) {
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

/* ── Shared surface layout style helpers (L04/L05) ── */

/** Layout for plugin surface with DryWet knob on the right side. */
export const panelWithDryWetStyle: React.CSSProperties = {
    ...pluginPanelCardBaseStyle,
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: 'var(--space-2-5)',
    alignItems: 'center',
};

/** Dynamic layout: show grid split only when DryWet knob is visible. */
export const panelWithOptionalDryWetStyle = (showDryWet: boolean): React.CSSProperties => ({
    ...panelWithDryWetStyle,
    gridTemplateColumns: showDryWet ? '1fr auto' : '1fr',
});
