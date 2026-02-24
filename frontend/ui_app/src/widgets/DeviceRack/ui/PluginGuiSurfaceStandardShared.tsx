import React from 'react';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';

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

export function readSurfaceParam(
    device: DeviceSlot,
    names: string | string[],
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
    'internal://midi-fx/chord': 'Chord',
    'internal://midi-fx/note-length': 'Note Length',
    'internal://midi-fx/cc-control': 'CC Control',
    'internal://midi-fx/expression-control': 'Expression Control',
    'internal://midi-fx/arpeggiator': 'Arpeggiator',
    // Modulation
    'internal://effect/vocoder': 'Vocoder',
};
