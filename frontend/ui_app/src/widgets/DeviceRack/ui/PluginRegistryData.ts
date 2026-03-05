// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Plugin Registry Data
// Pure data — zero React, zero rendering. All 28+ plugin definitions.
// To add a new plugin: add ONE entry here.
// ═══════════════════════════════════════════════════════════════════════════

import { clamp01 } from '@/shared/lib/audioMath';
import { safeParamValue } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';
import type { PluginDefinition } from '@/widgets/DeviceRack/ui/PluginRegistryTypes';

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
        settingsPanel: { params: ['voices', 'spread', 'fb', 'hp freq'] },
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
        settingsPanel: { params: ['phase', 'shape'] },
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
                    const n = 0.3 + depth * 0.55;
                    return i % 2 === 0 ? n : n * 0.6;
                });
            },
        },
        meta: [
            { label: '', paramNames: 'rate', fallback: 0.5, suffix: 'Hz' },
            { label: 'Depth', paramNames: 'depth', fallback: 60, suffix: '%' },
            { label: '', paramNames: 'stages', fallback: 6, suffix: ' stages' },
        ],
        settingsPanel: { params: ['center', 'spread', 'fb'] },
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
        settingsPanel: { params: ['blend', 'stages', 'stereo'] },
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
        settingsPanel: { params: ['delay', 'stereo', 'fb damp'] },
    },

    // ─── TIME EFFECTS (no settings panel per user request) ──────────────
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
        settingsPanel: { params: ['rel', 'lookahead', 'link'] },
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
        settingsPanel: { params: ['atk', 'hold', 'rel', 'range', 'sc hpf', 'hysteresis'] },
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
        settingsPanel: { params: ['res', 'rate', 'depth', 'env', 'type', 'lfo shape'] },
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
        settingsPanel: { params: ['atk', 'rel', 'knee', 'makeup', 'sc hpf'] },
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
        settingsPanel: { params: ['atk', 'rel', 'makeup', 'range', 'soft clip'] },
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
        settingsPanel: { params: ['tone', 'mode', 'output', 'color'] },
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
        settingsPanel: { params: ['mode', 'output', 'bias'] },
    },
    overdrive: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ff965e)',
        viz: { type: 'saturationCurve', satType: 'soft', driveParam: 'drive', driveFallback: 3, driveMax: 24 },
        meta: [
            { label: 'Drive', paramNames: 'drive', fallback: 0, suffix: 'dB' },
            { label: 'Tone', paramNames: 'tone', fallback: 0, suffix: '%' },
        ],
        settingsPanel: { params: ['output', 'bias', 'tight'] },
    },
    amp: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ffb57a)',
        viz: { type: 'saturationCurve', satType: 'tube', driveParam: 'gain', driveFallback: 3, driveMax: 24 },
        meta: [
            { label: 'Gain', paramNames: 'gain', fallback: 0, suffix: 'dB' },
            { label: 'Master', paramNames: 'master', fallback: 0, suffix: 'dB' },
        ],
        settingsPanel: { params: ['bass', 'mid', 'treble', 'presence', 'sag'] },
    },
    cabinet: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ffb57a)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: () => Array.from({ length: 11 }, (_, i) => 0.3 + Math.sin(i * 0.7) * 0.25 + Math.cos(i * 0.5) * 0.15),
        },
        meta: [{ label: 'Mic', paramNames: 'mic pos', fallback: 50, suffix: '%' }],
        settingsPanel: { params: ['type', 'lo cut', 'hi cut', 'resonance', 'output'] },
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
        settingsPanel: { params: ['mode', 'width'] },
    },
    pedal: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ff965e)',
        viz: { type: 'saturationCurve', satType: 'tape', driveParam: 'drive', driveFallback: 3, driveMax: 24 },
        meta: [
            { label: 'Drive', paramNames: 'drive', fallback: 0, suffix: 'dB' },
            { label: 'Tone', paramNames: 'tone', fallback: 0, suffix: '%' },
        ],
        settingsPanel: { params: ['mode', 'level'] },
    },
    roar: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ff965e)',
        viz: { type: 'saturationCurve', satType: 'fold', driveParam: 'intensity', driveFallback: 3, driveMax: 24 },
        meta: [
            { label: 'Intensity', paramNames: 'intensity', fallback: 0, suffix: '%' },
            { label: 'Color', paramNames: 'color', fallback: 0, suffix: '%' },
        ],
        settingsPanel: { params: ['character', 'feedback', 'output'] },
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
            { label: '↓', paramNames: ['down', 'downsample'], fallback: 1, suffix: 'x' },
        ],
        settingsPanel: { params: ['jitter', 'pre freq', 'post freq'] },
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
        settingsPanel: { params: ['stereo', 'lpfreq', 'hpfreq', 'pan'] },
    },

    // ─── UTILITY ────────────────────────────────────────────────────────
    utility: {
        background: 'var(--plugin-bg-utility)',
        accent: 'var(--token-color-hex-7ab6ff)',
        viz: { type: 'none' },
        meta: [],
        isUtility: true,
        buttons: [{ label: 'Mono', paramName: 'mono', scene: 'mono' }],
    },
};
