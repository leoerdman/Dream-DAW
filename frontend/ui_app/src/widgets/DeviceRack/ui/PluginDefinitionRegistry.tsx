// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Enterprise Plugin Definition Registry v1.0
// ═══════════════════════════════════════════════════════════════════════════
//
// ARCHITECTURE: Every plugin is defined as a PURE DATA configuration object.
// A single UniversalPluginRenderer reads the config and assembles modules.
//
// This eliminates all imperative routing (if/else chains, switch statements)
// and all inline SVG from surface files. Adding a new plugin requires ONLY
// adding a new entry to PLUGIN_REGISTRY — zero component code needed.
//
// Registry entry structure:
//   effectType → {
//     viz:     Which L2 visualization module to render
//     bg:      CSS variable for background
//     accent:  CSS variable for accent color
//     meta:    Array of param descriptors for MetaReadout
//     ... type-specific config
//   }
//
// ═══════════════════════════════════════════════════════════════════════════

import React, { useMemo } from 'react';
import { clamp01 } from '@/shared/lib/audioMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    buildSurfaceKnobParams,
    DryWetSection,
    formatSurfaceParam,
    getDevicePluginKey,
    getParamValue,
    PLUGIN_TITLE_MAP,
    readSurfaceParam,
    safeParamValue,
    shouldShowDryWet,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';
import {
    ButtonStrip,
    CompressionCurve,
    type CompressionCurveProps,
    ControlPanel,
    GainReductionMeter,
    KnobParamGrid,
    MetaReadout,
    MiniFilterEq,
    type MiniFilterEqProps,
    ModulationWave,
    type ModulationWaveProps,
    type ModulationWaveShape,
    PluginSurfaceLayout,
    SaturationCurve,
    type SaturationCurveProps,
    type SaturationCurveType,
    SpectrumBars,
    type SpectrumBarsProps,
    ToggleButton,
    VizCard,
    VizColumn,
    WaveformDisplay,
    type WaveformDisplayProps,
} from '@/widgets/DeviceRack/ui/PluginModules';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES — Declarative Plugin Definition Schema
// ═══════════════════════════════════════════════════════════════════════════

/** Parameter source descriptor — tells the renderer how to extract a value. */
export interface MetaParamDescriptor {
    /** Display label (e.g. "Thr", "Rate", "Drive"). */
    label: string;
    /** Param name(s) to read from device. */
    paramNames: string | string[];
    /** Fallback value if param not found. */
    fallback: number;
    /** Display suffix (e.g. "Hz", "dB", "%"). */
    suffix: string;
}

/** Visualization types available in the registry. */
export type VizType =
    | 'modulationWave'
    | 'saturationCurve'
    | 'miniFilterEq'
    | 'gainReductionMeter'
    | 'compressionCurve'
    | 'spectrumBars'
    | 'waveformDisplay'
    | 'none';

/** Config for each viz type. Computed fields are resolved at render time. */
export interface VizConfig {
    type: VizType;
    /** For modulationWave: waveform shape. */
    waveShape?: ModulationWaveShape;
    /** For saturationCurve: saturation algorithm type. */
    satType?: SaturationCurveType;
    /** For waveformDisplay: render mode. */
    waveMode?: 'bars' | 'line';
    /** For compressionCurve: variant. */
    compVariant?: 'standard' | 'glue' | 'multiband';
    /** For spectrumBars: bar count when no data. */
    barCount?: number;
    /** Static data generator for spectrumBars/waveform. */
    staticDataGenerator?: (device: DeviceSlot) => number[];
    /** Param-dependent depth source (used by modulationWave, saturationCurve). */
    depthParam?: string | string[];
    depthFallback?: number;
    depthMax?: number;
    /** Param-dependent rate source (used by modulationWave). */
    rateParam?: string | string[];
    rateFallback?: number;
    rateMax?: number;
    /** Param-dependent drive source (used by saturationCurve). */
    driveParam?: string | string[];
    driveFallback?: number;
    driveMax?: number;
    /** For miniFilterEq: HP/LP param sources. */
    hpParam?: string | string[];
    hpFallback?: number;
    lpParam?: string | string[];
    lpFallback?: number;
    /** For compressionCurve: threshold/ratio sources. */
    thrParam?: string | string[];
    thrFallback?: number;
    ratioParam?: string | string[];
    ratioFallback?: number;
    /** For gainReductionMeter: orientation. */
    grOrientation?: 'vertical' | 'horizontal';
}

/** Full plugin definition — everything needed to render a plugin surface. */
export interface PluginDefinition {
    /** CSS variable for VizCard background (e.g. "var(--plugin-bg-chorus)"). */
    background: string;
    /** CSS variable or hex for accent color. */
    accent: string;
    /** DryWet accent override (defaults to accent). */
    dryWetAccent?: string;
    /** Visualization configuration. */
    viz: VizConfig;
    /** Meta readout param descriptors. */
    meta: MetaParamDescriptor[];
    /** Whether this is a utility-type plugin (uses vertical layout, no viz card). */
    isUtility?: boolean;
    /** Custom buttons (like Mono for Utility). */
    buttons?: Array<{
        label: string;
        /** Param name to check for active state. */
        paramName: string;
        /** Threshold for "active" state. Default: 0.5. */
        threshold?: number;
        /** Scene name for onApplyUtilityScene. */
        scene?: 'center' | 'mono' | 'wide';
    }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE REGISTRY — Every plugin defined as pure data
// ═══════════════════════════════════════════════════════════════════════════

export const PLUGIN_REGISTRY: Record<string, PluginDefinition> = {
    // ─── MODULATION & SPATIAL ──────────────────────────────────────────
    chorus: {
        background: 'var(--plugin-bg-chorus)',
        accent: 'var(--token-color-hex-c867ff)',
        viz: {
            type: 'modulationWave',
            waveShape: 'sine',
            rateParam: 'rate', rateFallback: 1.2, rateMax: 10,
            depthParam: 'depth', depthFallback: 40, depthMax: 100,
        },
        meta: [
            { label: '', paramNames: 'rate', fallback: 1.2, suffix: 'Hz' },
            { label: 'Depth', paramNames: 'depth', fallback: 40, suffix: '%' },
        ],
    },
    autoPan: {
        background: 'var(--plugin-bg-mod)',
        accent: 'var(--token-color-hex-6db3ff)',
        viz: {
            type: 'modulationWave',
            waveShape: 'sine',
            rateParam: 'rate', rateFallback: 1, rateMax: 10,
            depthParam: 'depth', depthFallback: 50, depthMax: 100,
        },
        meta: [
            { label: 'Rate', paramNames: 'rate', fallback: 1, suffix: 'Hz' },
            { label: 'Depth', paramNames: 'depth', fallback: 50, suffix: '%' },
        ],
    },
    phaser: {
        background: 'var(--plugin-bg-mod)',
        accent: 'var(--token-color-hex-998bff)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: (device) => {
                const depth = clamp01(safeParamValue(device, 'depth', 60) / 100);
                const stages = Math.max(2, Math.min(12, Math.round(safeParamValue(device, 'stages', 6))));
                return Array.from({ length: stages }, (_, i) => {
                    const notchNorm = 0.3 + depth * 0.55;
                    return i % 2 === 0 ? notchNorm : notchNorm * 0.6;
                });
            },
        },
        meta: [
            { label: '', paramNames: 'rate', fallback: 0.5, suffix: 'Hz' },
            { label: 'Depth', paramNames: 'depth', fallback: 60, suffix: '%' },
            { label: '', paramNames: 'stages', fallback: 6, suffix: ' stages' },
        ],
    },
    phaserFlanger: {
        background: 'var(--plugin-bg-mod)',
        accent: 'var(--token-color-hex-998bff)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: (device) => {
                const depth = clamp01(safeParamValue(device, 'depth', 60) / 100);
                const stages = Math.max(2, Math.min(12, Math.round(safeParamValue(device, 'stages', 6))));
                return Array.from({ length: stages }, (_, i) => {
                    const n = 0.3 + depth * 0.55;
                    return i % 2 === 0 ? n : n * 0.6;
                });
            },
        },
        meta: [
            { label: '', paramNames: 'rate', fallback: 0.5, suffix: 'Hz' },
            { label: 'Depth', paramNames: 'depth', fallback: 60, suffix: '%' },
        ],
    },
    flanger: {
        background: 'var(--plugin-bg-mod)',
        accent: 'var(--token-color-hex-66b3ff)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: (device) => {
                const fb = clamp01(Math.abs(safeParamValue(device, 'fb', 40)) / 100);
                return Array.from({ length: 10 }, (_, i) => 0.24 + fb * 0.6 * Math.pow(0.85, i));
            },
        },
        meta: [
            { label: '', paramNames: 'rate', fallback: 0.3, suffix: 'Hz' },
            { label: 'Depth', paramNames: 'depth', fallback: 50, suffix: '%' },
            { label: 'FB', paramNames: ['fb', 'feedback'], fallback: 40, suffix: '%' },
        ],
    },

    // ─── TIME EFFECTS (Delay / Reverb) ──────────────────────────────────
    delay: {
        background: 'var(--plugin-bg-delay)',
        accent: 'var(--token-color-hex-7cc4ff)',
        viz: {
            type: 'miniFilterEq',
            hpParam: ['filter', 'cutoff', 'hp freq'], hpFallback: 200,
            lpParam: ['lp', 'lp freq', 'hi cut'], lpFallback: 8000,
        },
        meta: [
            { label: 'HP', paramNames: ['filter', 'cutoff', 'hp freq'], fallback: 200, suffix: 'Hz' },
            { label: 'LP', paramNames: ['lp', 'lp freq', 'hi cut'], fallback: 8000, suffix: 'Hz' },
            { label: 'FB', paramNames: 'fb', fallback: 30, suffix: '%' },
        ],
    },
    filterDelay: {
        background: 'var(--plugin-bg-delay)',
        accent: 'var(--token-color-hex-7cc4ff)',
        viz: {
            type: 'miniFilterEq',
            hpParam: ['filter', 'cutoff', 'hp freq'], hpFallback: 200,
            lpParam: ['lp', 'lp freq', 'hi cut'], lpFallback: 8000,
        },
        meta: [
            { label: 'HP', paramNames: ['filter', 'cutoff', 'hp freq'], fallback: 200, suffix: 'Hz' },
            { label: 'LP', paramNames: ['lp', 'lp freq', 'hi cut'], fallback: 8000, suffix: 'Hz' },
            { label: 'FB', paramNames: 'fb', fallback: 30, suffix: '%' },
        ],
    },
    grainDelay: {
        background: 'var(--plugin-bg-delay)',
        accent: 'var(--token-color-hex-7cc4ff)',
        viz: {
            type: 'miniFilterEq',
            hpParam: ['filter', 'cutoff', 'hp freq'], hpFallback: 200,
            lpParam: ['lp', 'lp freq', 'hi cut'], lpFallback: 8000,
        },
        meta: [
            { label: 'HP', paramNames: ['filter', 'cutoff', 'hp freq'], fallback: 200, suffix: 'Hz' },
            { label: 'LP', paramNames: ['lp', 'lp freq', 'hi cut'], fallback: 8000, suffix: 'Hz' },
        ],
    },
    spectralTime: {
        background: 'var(--plugin-bg-delay)',
        accent: 'var(--token-color-hex-7cc4ff)',
        viz: {
            type: 'miniFilterEq',
            hpParam: ['filter', 'cutoff', 'hp freq'], hpFallback: 200,
            lpParam: ['lp', 'lp freq', 'hi cut'], lpFallback: 8000,
        },
        meta: [
            { label: 'HP', paramNames: ['filter', 'cutoff', 'hp freq'], fallback: 200, suffix: 'Hz' },
            { label: 'LP', paramNames: ['lp', 'lp freq', 'hi cut'], fallback: 8000, suffix: 'Hz' },
        ],
    },
    reverb: {
        background: 'var(--plugin-bg-reverb)',
        accent: 'var(--token-color-hex-c891ff)',
        viz: {
            type: 'miniFilterEq',
            hpParam: ['lo cut', 'lp', 'lp freq'], hpFallback: 80,
            lpParam: ['hi cut', 'cutoff', 'filter', 'damp'], lpFallback: 4000,
        },
        meta: [
            { label: 'HP', paramNames: ['lo cut', 'lp', 'lp freq'], fallback: 80, suffix: 'Hz' },
            { label: 'LP', paramNames: ['hi cut', 'cutoff', 'filter', 'damp'], fallback: 4000, suffix: 'Hz' },
            { label: 'Size', paramNames: ['size', 'decay'], fallback: 50, suffix: '%' },
        ],
    },
    hybridReverb: {
        background: 'var(--plugin-bg-reverb)',
        accent: 'var(--token-color-hex-c891ff)',
        viz: {
            type: 'miniFilterEq',
            hpParam: ['lo cut', 'lp', 'lp freq'], hpFallback: 80,
            lpParam: ['hi cut', 'cutoff', 'filter', 'damp'], lpFallback: 4000,
        },
        meta: [
            { label: 'HP', paramNames: ['lo cut', 'lp', 'lp freq'], fallback: 80, suffix: 'Hz' },
            { label: 'LP', paramNames: ['hi cut', 'cutoff', 'filter', 'damp'], fallback: 4000, suffix: 'Hz' },
            { label: 'Size', paramNames: ['size', 'decay'], fallback: 50, suffix: '%' },
        ],
    },
    corpus: {
        background: 'var(--plugin-bg-reverb)',
        accent: 'var(--token-color-hex-c891ff)',
        viz: {
            type: 'miniFilterEq',
            hpParam: ['lo cut', 'lp', 'lp freq'], hpFallback: 80,
            lpParam: ['hi cut', 'cutoff', 'filter', 'damp'], lpFallback: 4000,
        },
        meta: [
            { label: 'HP', paramNames: ['lo cut', 'lp', 'lp freq'], fallback: 80, suffix: 'Hz' },
            { label: 'LP', paramNames: ['hi cut', 'cutoff', 'filter', 'damp'], fallback: 4000, suffix: 'Hz' },
        ],
    },

    // ─── DYNAMICS ──────────────────────────────────────────────────────
    limiter: {
        background: 'var(--plugin-bg-limiter)',
        accent: 'var(--token-color-hex-56d4c8)',
        viz: { type: 'gainReductionMeter', grOrientation: 'horizontal' },
        meta: [
            { label: 'Thr', paramNames: 'thr', fallback: -0.3, suffix: 'dB' },
            { label: 'Ceil', paramNames: 'ceil', fallback: -0.1, suffix: 'dB' },
        ],
    },
    gate: {
        background: 'var(--plugin-bg-gate)',
        accent: 'var(--token-color-hex-8ecb7c)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: (device) => {
                const thrNorm = clamp01((safeParamValue(device, 'thr', -40) + 60) / 60);
                return Array.from({ length: 14 }, (_, i) => {
                    const raw = Math.abs(Math.sin((i + 1) * 0.95));
                    return raw > thrNorm * 0.8 ? 0.12 + raw * 0.7 : 0.05;
                });
            },
        },
        meta: [
            { label: 'Thr', paramNames: 'thr', fallback: -40, suffix: 'dB' },
        ],
    },
    autoFilter: {
        background: 'var(--plugin-bg-mod)',
        accent: 'var(--token-color-hex-4cc9d8)',
        viz: {
            type: 'miniFilterEq',
            hpParam: ['freq', 'frequency', 'cutoff', 'center'], hpFallback: 1000,
            lpParam: ['freq', 'frequency', 'cutoff', 'center'], lpFallback: 1000,
        },
        meta: [
            { label: 'Freq', paramNames: ['freq', 'frequency', 'cutoff', 'center'], fallback: 1000, suffix: 'Hz' },
        ],
    },

    // ─── COMPRESSORS ──────────────────────────────────────────────────
    compressor: {
        background: 'var(--plugin-bg-compressor)',
        accent: 'var(--token-color-hex-6ac3ff)',
        viz: {
            type: 'compressionCurve',
            compVariant: 'standard',
            thrParam: 'thr', thrFallback: -18,
            ratioParam: 'ratio', ratioFallback: 4,
        },
        meta: [
            { label: 'Thr', paramNames: 'thr', fallback: -18, suffix: 'dB' },
            { label: 'Ratio', paramNames: 'ratio', fallback: 4, suffix: ':1' },
        ],
    },
    glueCompressor: {
        background: 'var(--plugin-bg-compressor)',
        accent: 'var(--token-color-hex-6ac3ff)',
        viz: {
            type: 'compressionCurve',
            compVariant: 'glue',
            thrParam: 'thr', thrFallback: -18,
            ratioParam: 'ratio', ratioFallback: 4,
        },
        meta: [
            { label: 'Thr', paramNames: 'thr', fallback: -18, suffix: 'dB' },
            { label: 'Ratio', paramNames: 'ratio', fallback: 4, suffix: ':1' },
        ],
    },
    multibandDynamics: {
        background: 'var(--plugin-bg-compressor)',
        accent: 'var(--token-color-hex-6ac3ff)',
        viz: {
            type: 'compressionCurve',
            compVariant: 'multiband',
            thrParam: 'thr', thrFallback: -18,
            ratioParam: 'ratio', ratioFallback: 4,
        },
        meta: [
            { label: 'Lo', paramNames: 'xover low', fallback: 200, suffix: 'Hz' },
            { label: 'Hi', paramNames: 'xover high', fallback: 4000, suffix: 'Hz' },
        ],
    },
    transientShaper: {
        background: 'var(--plugin-bg-compressor)',
        accent: 'var(--token-color-hex-53b0ff)',
        viz: {
            type: 'spectrumBars',
            barCount: 2,
            staticDataGenerator: (device) => {
                const atk = clamp01(safeParamValue(device, 'attack', 50) / 100);
                const sus = clamp01((safeParamValue(device, 'sustain', 0) + 100) / 200);
                return [atk, sus];
            },
        },
        meta: [
            { label: 'Atk', paramNames: 'attack', fallback: 50, suffix: '%' },
            { label: 'Sus', paramNames: 'sustain', fallback: 0, suffix: '%' },
        ],
    },

    // ─── SATURATION / DISTORTION ──────────────────────────────────────
    saturator: {
        background: 'var(--plugin-bg-saturator)',
        accent: 'var(--token-color-hex-ffac59)',
        viz: { type: 'saturationCurve', satType: 'soft', driveParam: 'drive', driveFallback: 3, driveMax: 24 },
        meta: [{ label: 'Drive', paramNames: 'drive', fallback: 3, suffix: 'dB' }],
    },
    drumBuss: {
        background: 'var(--plugin-bg-saturator)',
        accent: 'var(--token-color-hex-ffac59)',
        viz: {
            type: 'waveformDisplay',
            waveMode: 'bars',
            staticDataGenerator: () => Array.from({ length: 12 }, (_, i) => 0.2 + ((i * 7) % 52) / 80),
        },
        meta: [
            { label: 'Boom', paramNames: 'boom', fallback: 40, suffix: '%' },
            { label: 'Drive', paramNames: 'drive', fallback: 30, suffix: '%' },
        ],
    },
    dynamicTube: {
        background: 'var(--plugin-bg-saturator)',
        accent: 'var(--token-color-hex-ffbc74)',
        viz: { type: 'saturationCurve', satType: 'tube', driveParam: 'drive', driveFallback: 3, driveMax: 24 },
        meta: [
            { label: 'Drive', paramNames: 'drive', fallback: 40, suffix: '%' },
            { label: 'Bias', paramNames: 'bias', fallback: 20, suffix: '%' },
        ],
    },
    distortion: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ff965e)',
        viz: { type: 'saturationCurve', satType: 'hard', driveParam: 'drive', driveFallback: 3, driveMax: 24 },
        meta: [
            { label: 'Drive', paramNames: 'drive', fallback: 0, suffix: 'dB' },
            { label: 'Tone', paramNames: 'tone', fallback: 0, suffix: '%' },
        ],
    },
    overdrive: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ff965e)',
        viz: { type: 'saturationCurve', satType: 'soft', driveParam: 'drive', driveFallback: 3, driveMax: 24 },
        meta: [
            { label: 'Drive', paramNames: 'drive', fallback: 0, suffix: 'dB' },
            { label: 'Tone', paramNames: 'tone', fallback: 0, suffix: '%' },
        ],
    },
    amp: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ffb57a)',
        viz: { type: 'saturationCurve', satType: 'tube', driveParam: 'drive', driveFallback: 3, driveMax: 24 },
        meta: [
            { label: 'Gain', paramNames: 'gain', fallback: 0, suffix: 'dB' },
            { label: 'Master', paramNames: 'master', fallback: 0, suffix: 'dB' },
        ],
    },
    cabinet: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ffb57a)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: () => Array.from({ length: 11 }, (_, i) => 0.3 + Math.sin(i * 0.7) * 0.25 + Math.cos(i * 0.5) * 0.15),
        },
        meta: [{ label: 'Mic', paramNames: 'mic pos', fallback: 50, suffix: '%' }],
    },
    erosion: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ff965e)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: () => Array.from({ length: 20 }, (_, i) => 0.16 + ((i * 19) % 60) / 80),
        },
        meta: [
            { label: 'Freq', paramNames: 'frequency', fallback: 2000, suffix: 'Hz' },
            { label: 'Amt', paramNames: 'amount', fallback: 0, suffix: '%' },
        ],
    },
    pedal: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ff965e)',
        viz: { type: 'saturationCurve', satType: 'tape', driveParam: 'drive', driveFallback: 3, driveMax: 24 },
        meta: [
            { label: 'Drive', paramNames: 'drive', fallback: 0, suffix: 'dB' },
            { label: 'Tone', paramNames: 'tone', fallback: 0, suffix: '%' },
        ],
    },
    roar: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ff965e)',
        viz: { type: 'saturationCurve', satType: 'fold', driveParam: 'drive', driveFallback: 3, driveMax: 24 },
        meta: [
            { label: 'Drive', paramNames: 'drive', fallback: 0, suffix: 'dB' },
            { label: 'Tone', paramNames: 'tone', fallback: 0, suffix: '%' },
        ],
    },
    bitcrusher: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-f2de72)',
        dryWetAccent: 'var(--token-color-hex-f2de72)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: () => Array.from({ length: 14 }, (_, i) => i % 2 === 0 || i % 5 === 0 ? 0.75 : 0.35),
        },
        meta: [
            { label: 'Bits', paramNames: 'bits', fallback: 16, suffix: '' },
            { label: '↓', paramNames: 'downsample', fallback: 1, suffix: 'x' },
        ],
    },

    // ─── NOISE ──────────────────────────────────────────────────────────
    noiseMachine: {
        background: 'var(--plugin-bg-noise)',
        accent: 'var(--token-color-hex-72d68a)',
        viz: {
            type: 'waveformDisplay',
            waveMode: 'line',
            staticDataGenerator: (device) => {
                const type = Math.round(safeParamValue(device, 'type', 0));
                return Array.from({ length: 40 }, (_, i) =>
                    0.15 + Math.abs(Math.sin(i * 3.77 + type * 1.3) * 0.6 + Math.cos(i * 2.13) * 0.25)
                );
            },
        },
        meta: [
            { label: '', paramNames: 'type', fallback: 0, suffix: '' },
            { label: 'Level', paramNames: 'level', fallback: -30, suffix: 'dB' },
        ],
    },

    // ─── UTILITY ────────────────────────────────────────────────────────
    utility: {
        background: 'var(--plugin-bg-utility)',
        accent: 'var(--token-color-hex-7ab6ff)',
        viz: { type: 'none' },
        meta: [],
        isUtility: true,
        buttons: [
            { label: 'Mono', paramName: 'mono', scene: 'mono' },
        ],
    },
};

// ═══════════════════════════════════════════════════════════════════════════
// UNIVERSAL PLUGIN RENDERER
// ═══════════════════════════════════════════════════════════════════════════
// Single component that reads a PluginDefinition and assembles modules.
// This replaces ALL imperative surface files + routing waterfall.

function freqToNorm(hz: number): number {
    return clamp01((Math.log2(Math.max(20, hz) / 20)) / (Math.log2(20000 / 20)));
}

/** Resolve a VizConfig into a React element. */
function resolveViz(
    viz: VizConfig,
    device: DeviceSlot,
    accent: string,
): React.ReactNode {
    switch (viz.type) {
        case 'modulationWave': {
            const rateRaw = safeParamValue(device, viz.rateParam ?? 'rate', viz.rateFallback ?? 1);
            const depthRaw = safeParamValue(device, viz.depthParam ?? 'depth', viz.depthFallback ?? 50);
            const rateNorm = clamp01(Math.min(rateRaw, viz.rateMax ?? 10) / (viz.rateMax ?? 10));
            const depthNorm = clamp01(depthRaw / (viz.depthMax ?? 100));
            return <ModulationWave rate={rateNorm} depth={depthNorm} shape={viz.waveShape ?? 'sine'} accent={accent} />;
        }
        case 'saturationCurve': {
            const driveRaw = safeParamValue(device, viz.driveParam ?? 'drive', viz.driveFallback ?? 3);
            const driveNorm = clamp01(Math.max(0, driveRaw) / (viz.driveMax ?? 24));
            return <SaturationCurve drive={driveNorm} type={viz.satType ?? 'soft'} accent={accent} />;
        }
        case 'miniFilterEq': {
            const hpHz = safeParamValue(device, viz.hpParam ?? 'hp', viz.hpFallback ?? 200);
            const lpHz = safeParamValue(device, viz.lpParam ?? 'lp', viz.lpFallback ?? 8000);
            return <MiniFilterEq hpFreqNorm={freqToNorm(hpHz)} lpFreqNorm={freqToNorm(lpHz)} accentHp={accent} accentLp={accent} />;
        }
        case 'gainReductionMeter': {
            const thrDb = Math.abs(safeParamValue(device, 'thr', -0.3));
            const grDb = Math.max(0, thrDb * 0.8);
            return (
                <div style={{ display: 'flex', height: '100%', gap: 6, padding: 6 }}>
                    <div style={{ flex: 1 }}><GainReductionMeter grDb={grDb} maxDb={24} orientation={viz.grOrientation ?? 'horizontal'} /></div>
                </div>
            );
        }
        case 'compressionCurve': {
            const thr = safeParamValue(device, viz.thrParam ?? 'thr', viz.thrFallback ?? -18);
            const ratio = safeParamValue(device, viz.ratioParam ?? 'ratio', viz.ratioFallback ?? 4);
            const rawGr = Number.isFinite(device.vuLevel) ? Math.abs(device.vuLevel!) : 0;
            const pseudoGr = rawGr > 0 ? Math.max(0, Math.min(24, rawGr)) : Math.max(0, Math.min(24, ((-thr) / 60) * ratio * 2.4));
            const thrNorm = clamp01((thr + 60) / 60);
            const ratioNorm = clamp01(Math.min(ratio, 20) / 20);
            return <CompressionCurve thresholdNorm={thrNorm} ratioNorm={ratioNorm} grDb={pseudoGr} accent={accent} variant={viz.compVariant ?? 'standard'} />;
        }
        case 'spectrumBars': {
            const data = viz.staticDataGenerator?.(device);
            return <SpectrumBars data={data} barCount={viz.barCount ?? data?.length ?? 16} accent={accent} />;
        }
        case 'waveformDisplay': {
            const data = viz.staticDataGenerator?.(device) ?? [];
            return <WaveformDisplay data={data} accent={accent} mode={viz.waveMode ?? 'bars'} />;
        }
        default:
            return null;
    }
}

/** Resolve meta descriptors into formatted readout spans. */
function resolveMeta(
    metaDescs: MetaParamDescriptor[],
    device: DeviceSlot,
): React.ReactNode[] {
    return metaDescs.map((desc, i) => {
        // Special case: noise type label
        if (device.effectType === 'noiseMachine' && desc.paramNames === 'type') {
            const type = Math.round(safeParamValue(device, 'type', 0));
            const LABELS = ['White', 'Pink', 'Brown', 'Blue', 'Violet', 'Grey'];
            return <span key={i}>{LABELS[Math.min(type, 5)] ?? 'White'}</span>;
        }
        // Special case: stages suffix
        if (desc.suffix === ' stages') {
            const val = Math.round(safeParamValue(device, desc.paramNames, desc.fallback));
            return <span key={i}>{val}{desc.suffix}</span>;
        }
        const param = readSurfaceParam(device, desc.paramNames, desc.fallback, desc.suffix);
        return <span key={i}>{desc.label ? `${desc.label} ` : ''}{formatSurfaceParam(param)}</span>;
    });
}

/**
 * UniversalPluginRenderer — THE enterprise-grade single renderer.
 * Reads a PluginDefinition and assembles the UI from modular blocks.
 *
 * To add a new plugin type: add ONE entry to PLUGIN_REGISTRY. Done.
 */
export const UniversalPluginRenderer = React.memo(function UniversalPluginRenderer({
    device,
    handlers,
    definition,
}: {
    device: DeviceSlot;
    handlers: SurfaceHandlers;
    definition: PluginDefinition;
}) {
    const showDryWet = shouldShowDryWet(device);
    const knobParams = useMemo(
        () => buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet }),
        [device, showDryWet],
    );
    const accent = definition.accent;
    const dryWetAccent = definition.dryWetAccent ?? accent;

    // ─── Utility layout (vertical, no viz card) ──────────────────────
    if (definition.isUtility) {
        return (
            <div data-no-drag style={{
                display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', height: '100%', padding: 'var(--space-1)',
            }}>
                <KnobParamGrid params={knobParams} handlers={handlers} maxCols={2} minCols={2} />
                {definition.buttons && definition.buttons.length > 0 && (
                    <ButtonStrip>
                        {definition.buttons.map((btn) => {
                            const active = getParamValue(device, [btn.paramName], 0) > (btn.threshold ?? 0.5);
                            return (
                                <ToggleButton
                                    key={btn.paramName}
                                    label={btn.label}
                                    active={active}
                                    onClick={() => btn.scene && handlers.onApplyUtilityScene?.(btn.scene)}
                                />
                            );
                        })}
                    </ButtonStrip>
                )}
                {showDryWet && <DryWetSection device={device} handlers={handlers} accent={dryWetAccent} show={showDryWet} />}
            </div>
        );
    }

    // ─── Standard EQ-style layout ────────────────────────────────────
    const vizElement = resolveViz(definition.viz, device, accent);
    const metaSpans = resolveMeta(definition.meta, device);

    return (
        <PluginSurfaceLayout>
            <ControlPanel params={knobParams} handlers={handlers} />
            <VizColumn>
                <VizCard background={definition.background}>
                    {vizElement}
                </VizCard>
                {metaSpans.length > 0 && (
                    <MetaReadout>
                        {metaSpans}
                    </MetaReadout>
                )}
            </VizColumn>
            <DryWetSection device={device} handlers={handlers} accent={dryWetAccent} show={showDryWet} />
        </PluginSurfaceLayout>
    );
});

/**
 * Lookup helper: resolve effectType → PluginDefinition.
 * Returns null if no definition exists (fallback to hand-crafted surface).
 */
export function lookupPluginDefinition(device: DeviceSlot): PluginDefinition | null {
    if (!device.effectType) return null;
    return PLUGIN_REGISTRY[device.effectType] ?? null;
}
