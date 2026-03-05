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
    fontSize: 'var(--font-size-sm)',
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

// Hoisted to module level — avoids new Set() allocation on every render (Bug #2)
const NON_MIX_DEVICE_TYPES: ReadonlySet<DeviceSlot['effectType']> = new Set([
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

export function shouldShowDryWet(device: DeviceSlot): boolean {
    if (NON_MIX_DEVICE_TYPES.has(device.effectType)) return false;
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
    const normalizedInternalId = getDevicePluginKey(device);
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
// Cached instances to avoid new object creation on every render
const _panelWithDryWetActive: React.CSSProperties = {
    ...panelWithDryWetStyle,
    gridTemplateColumns: '1fr auto',
};
const _panelWithDryWetInactive: React.CSSProperties = {
    ...panelWithDryWetStyle,
    gridTemplateColumns: '1fr',
};
export const panelWithOptionalDryWetStyle = (showDryWet: boolean): React.CSSProperties =>
    showDryWet ? _panelWithDryWetActive : _panelWithDryWetInactive;

/* ── Phase B: Shared helpers to eliminate 12x duplication ── */

/**
 * Compute the normalized internal plugin key for a device — used by ALL surfaces.
 * Eliminates the identical `normalizeInternalPluginId(device.pluginId || ...)` pattern
 * that was copy-pasted into every surface render function.
 */
export function getDevicePluginKey(device: DeviceSlot): string {
    return normalizeInternalPluginId(
        device.pluginId || (device.guiMode || '').toLowerCase() || device.name.toLowerCase(),
    );
}

/* ── Phase C: Shared rendering components ── */

import { PluginKnob } from '@/widgets/DeviceRack/StandardPluginControls';
import { pluginPanelKnobGrid } from '@/widgets/DeviceRack/ui/styles';
import { DryWetKnob } from '@/widgets/DeviceRack/ui/DryWetKnob';

/**
 * Shared knob parameter grid — renders a row of PluginKnobs from pre-filtered params.
 * Eliminates the identical `{knobParams.length > 0 && <div style={pluginPanelKnobGrid(...)}>...map...</div>}`
 * pattern that was duplicated in 12 surfaces.
 */
export const KnobParamGrid = React.memo(({
    params,
    handlers,
    maxCols = 8,
    minCols = 3,
}: {
    params: DeviceSlot['params'];
    handlers: SurfaceHandlers;
    maxCols?: number;
    minCols?: number;
}) => {
    if (params.length === 0) return null;
    const cols = Math.min(maxCols, Math.max(minCols, params.length));
    return (
        <div style={{
            ...pluginPanelCardBaseStyle,
            padding: 'var(--space-1) var(--space-1)',
            height: 'fit-content',
            display: 'block',
        }}>
            <div style={pluginPanelKnobGrid(`repeat(${cols}, minmax(0, 1fr))`)}>
                {params.map((p) => (
                    <PluginKnob
                        key={p.name}
                        param={p}
                        onChange={handlers.onParamChange}
                        onGestureStart={handlers.onParamGestureStart}
                        onGestureEnd={handlers.onParamGestureEnd}
                        onContextMenu={handlers.onParamContextMenu}
                        compact
                    />
                ))}
            </div>
        </div>
    );
});
KnobParamGrid.displayName = 'KnobParamGrid';

/**
 * Memoized version of KnobParamGrid that computes buildSurfaceKnobParams internally.
 * BUG-R04 FIX: Caches the O(N) param filtering so it doesn't run every frame.
 */
export const KnobParamGridMemo = React.memo(({
    device,
    handlers,
    options = {},
    maxCols,
    minCols,
}: {
    device: DeviceSlot;
    handlers: SurfaceHandlers;
    options?: SurfaceParamFilterOptions;
    maxCols?: number;
    minCols?: number;
}) => {
    // Memoize the expensive param filtering based on device.params reference
    const params = React.useMemo(
        () => buildSurfaceKnobParams(device, options),
        [device.params, options],
    );
    return <KnobParamGrid params={params} handlers={handlers} maxCols={maxCols} minCols={minCols} />;
});
KnobParamGridMemo.displayName = 'KnobParamGridMemo';

/**
 * Shared DryWet knob section — conditionally renders the DryWet knob.
 * Eliminates the identical `{showDryWet && <DryWetKnob .../>}` pattern
 * that was duplicated in 12 surfaces.
 */
export const DryWetSection = React.memo(({
    device,
    handlers,
    accent,
    show,
}: {
    device: DeviceSlot;
    handlers: SurfaceHandlers;
    accent: string;
    show: boolean;
}) => {
    if (!show) return null;
    return (
        <DryWetKnob
            device={device}
            onChange={handlers.onParamChange}
            onGestureStart={handlers.onParamGestureStart}
            onGestureEnd={handlers.onParamGestureEnd}
            onContextMenu={handlers.onParamContextMenu}
            accent={accent}
        />
    );
});
DryWetSection.displayName = 'DryWetSection';

/* ── Phase D: Fader param grid (horizontal mini-faders) ── */

import { PluginFader } from '@/widgets/DeviceRack/StandardPluginControls';

/**
 * Shared fader parameter grid — renders a stack of horizontal PluginFaders.
 * For parameters that don't fit as knobs within the fixed plugin height.
 */
export const FaderParamGrid = React.memo(({
    params,
    handlers,
}: {
    params: DeviceSlot['params'];
    handlers: SurfaceHandlers;
}) => {
    if (params.length === 0) return null;
    return (
        <div style={{
            background: 'color-mix(in srgb, var(--color-bg-panel) 90%, var(--color-bg-header) 10%)',
            borderRadius: 'var(--plugin-card-radius)',
            border: 'var(--space-px) solid color-mix(in srgb, var(--color-text-primary) 14%, transparent)',
            padding: 'var(--space-1) var(--space-1-5)',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
        }}>
            {params.map((p) => (
                <PluginFader
                    key={p.name}
                    param={p}
                    onChange={handlers.onParamChange}
                    onGestureStart={handlers.onParamGestureStart}
                    onGestureEnd={handlers.onParamGestureEnd}
                    onContextMenu={handlers.onParamContextMenu}
                />
            ))}
        </div>
    );
});
FaderParamGrid.displayName = 'FaderParamGrid';
