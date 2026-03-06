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
            rateParam: 'rate', rateFallback: 1.0, rateMax: 10,
            depthParam: 'depth', depthFallback: 50, depthMax: 100,
        },
        meta: [
            { label: 'Rate', paramNames: 'rate', fallback: 1.0, suffix: 'Hz' },
            { label: 'Depth', paramNames: 'depth', fallback: 50, suffix: '%' },
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
        // P-AP-01: AutoPan shape enum labels
        settingsPanel: {
            params: ['phase', 'shape', 'mix'],
            enumLabels: { 'shape': ['Sine', 'Triangle', 'Random', 'Square', 'Saw'] },
        },
    },
    phaser: {
        background: 'var(--plugin-bg-mod)',
        accent: 'var(--token-color-hex-998bff)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: (device) => {
                const depth = clamp01(safeParamValue(device, 'depth', 60) / 100);
                const stages = Math.max(2, Math.min(12, Math.round(safeParamValue(device, 'stages', 4))));
                return Array.from({ length: stages }, (_, i) => {
                    const n = 0.3 + depth * 0.55;
                    return i % 2 === 0 ? n : n * 0.6;
                });
            },
        },
        meta: [
            { label: 'Rate', paramNames: 'rate', fallback: 0.5, suffix: 'Hz' },
            { label: 'Depth', paramNames: 'depth', fallback: 60, suffix: '%' },
            { label: 'Stages', paramNames: 'stages', fallback: 4, suffix: ' stages' },
        ],
        settingsPanel: {
            params: ['center', 'spread', 'fb', 'lfo shape', 'range'],
            enumLabels: { 'lfo shape': ['Sine', 'Triangle', 'Saw', 'Square', 'S&H'] },
        },
    },
    phaserFlanger: {
        background: 'var(--plugin-bg-mod)',
        accent: 'var(--token-color-hex-998bff)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: (device) => {
                const depth = clamp01(safeParamValue(device, 'depth', 60) / 100);
                const stages = Math.max(2, Math.min(12, Math.round(safeParamValue(device, 'stages', 4))));
                return Array.from({ length: stages }, (_, i) => {
                    const n = 0.3 + depth * 0.55;
                    return i % 2 === 0 ? n : n * 0.6;
                });
            },
        },
        meta: [
            { label: 'Rate', paramNames: 'rate', fallback: 0.5, suffix: 'Hz' },
            { label: 'Depth', paramNames: 'depth', fallback: 60, suffix: '%' },
        ],
        settingsPanel: { params: ['blend', 'stages', 'fb', 'stereo'] },
    },
    flanger: {
        background: 'var(--plugin-bg-mod)',
        accent: 'var(--token-color-hex-66b3ff)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: (device) => {
                const fb = clamp01(Math.abs(safeParamValue(device, 'fb', 50)) / 100);
                return Array.from({ length: 10 }, (_, i) => 0.24 + fb * 0.6 * Math.pow(0.85, i));
            },
        },
        meta: [
            { label: 'Rate', paramNames: 'rate', fallback: 0.3, suffix: 'Hz' },
            { label: 'Depth', paramNames: 'depth', fallback: 70, suffix: '%' },
            { label: 'FB', paramNames: ['fb', 'feedback'], fallback: 50, suffix: '%' },
        ],
        // P-FLA-03: Flanger TZ mode enum labels and mix
        settingsPanel: {
            params: ['delay', 'stereo', 'fb damp', 'lfo shape', 'tz mode', 'mix'],
            enumLabels: { 'tz mode': ['Off', 'Through-Zero'], 'lfo shape': ['Sine', 'Triangle', 'Saw', 'Square', 'S&H'] },
            toggleParams: ['tz mode'],
        },
    },

    // ─── TIME EFFECTS (no settings panel per user request) ──────────────
    delay: {
        background: 'var(--plugin-bg-delay)',
        accent: 'var(--token-color-hex-7cc4ff)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: (device) => {
                const fb = clamp01(safeParamValue(device, 'fb', 30) / 100);
                // Simulate delay taps fading with feedback
                return Array.from({ length: 8 }, (_, i) => {
                    const tap = Math.pow(fb, i) * 0.9;
                    return Math.max(0.05, tap);
                });
            },
        },
        meta: [
            { label: 'L', paramNames: 'time l', fallback: 250, suffix: 'ms' },
            { label: 'R', paramNames: 'time r', fallback: 375, suffix: 'ms' },
            { label: 'FB', paramNames: 'fb', fallback: 30, suffix: '%' },
        ],
        // Single Ping Pong button + Link (frontend-only state via renderer)
        buttons: [
            { label: 'Ping Pong', paramName: 'pingpong' },
        ],
        // Enterprise Delay: Time/Sync mode as dropdown, note divisions as enums
        // When mode='Sync' (sync l=1, sync r=1): hide time knobs, show note dropdowns
        // When mode='Time' (sync l=0, sync r=0): show time knobs, hide note dropdowns
        settingsPanel: {
            params: ['sync l', 'sync r', 'note l', 'note r', 'pingpong'],
            maxCols: 2,
            toggleParams: ['pingpong'],
            enumLabels: {
                'note l': ['1/32', '1/16T', '1/16', '1/16D', '1/8T', '1/8', '1/8D', '1/4T', '1/4', '1/4D', '1/2T', '1/2', '1/2D', '1 Bar'],
                'note r': ['1/32', '1/16T', '1/16', '1/16D', '1/8T', '1/8', '1/8D', '1/4T', '1/4', '1/4D', '1/2T', '1/2', '1/2D', '1 Bar'],
            },
        },
        // Feature flag: renderer uses this to implement Time↔Note switching + Link
        delaySync: true,
    },
    filterDelay: {
        background: 'var(--plugin-bg-delay)',
        accent: 'var(--token-color-hex-7cc4ff)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: (device) => {
                const lf = clamp01(safeParamValue(device, 'l filter', 2000) / 15000);
                const cf = clamp01(safeParamValue(device, 'c filter', 5000) / 15000);
                const rf = clamp01(safeParamValue(device, 'r filter', 800) / 15000);
                // Mirror L/C/R filters with secondary bars for fullness
                return [lf * 0.6, lf, cf * 0.7, cf, rf * 0.8, rf];
            },
        },
        meta: [
            { label: 'L', paramNames: 'l delay', fallback: 250, suffix: 'ms' },
            { label: 'C', paramNames: 'c delay', fallback: 500, suffix: 'ms' },
            { label: 'R', paramNames: 'r delay', fallback: 375, suffix: 'ms' },
        ],
        settingsPanel: { params: ['l filter', 'c filter', 'r filter', 'fb'] },
    },
    grainDelay: {
        background: 'var(--plugin-bg-delay)',
        accent: 'var(--token-color-hex-7cc4ff)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: (device) => {
                const density = Math.max(1, Math.round(safeParamValue(device, 'density', 3)));
                const spray = clamp01(safeParamValue(device, 'spray', 30) / 100);
                return Array.from({ length: density * 3 }, (_, i) => 0.3 + spray * 0.5 * Math.abs(Math.sin(i * 1.7)));
            },
        },
        meta: [
            { label: 'Delay', paramNames: 'delay', fallback: 250, suffix: 'ms' },
            { label: 'Pitch', paramNames: 'pitch', fallback: 0, suffix: 'st' },
            { label: 'FB', paramNames: 'fb', fallback: 30, suffix: '%' },
        ],
        settingsPanel: { params: ['grain', 'spray', 'density'] },
    },
    spectralTime: {
        background: 'var(--plugin-bg-delay)',
        accent: 'var(--token-color-hex-7cc4ff)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: (device) => {
                const amount = clamp01(safeParamValue(device, 'amount', 50) / 100);
                const tilt = safeParamValue(device, 'tilt', 0) / 100;
                return Array.from({ length: 16 }, (_, i) => {
                    const base = 0.2 + amount * 0.6;
                    const tiltFactor = 1 + tilt * (i / 16 - 0.5);
                    return clamp01(base * tiltFactor * (0.5 + Math.abs(Math.sin(i * 1.3)) * 0.5));
                });
            },
        },
        meta: [
            { label: 'Amount', paramNames: 'amount', fallback: 50, suffix: '%' },
            { label: 'Decay', paramNames: 'decay', fallback: 50, suffix: '%' },
        ],
        // P-ST-01: SpectralTime mode enum labels
        settingsPanel: {
            params: ['mode', 'tilt', 'mix'],
            enumLabels: { 'mode': ['Freeze', 'Spectral Delay', 'Spectral Gate'] },
        },
    },
    reverb: {
        background: 'var(--plugin-bg-reverb)',
        accent: 'var(--token-color-hex-c891ff)',
        viz: {
            type: 'miniFilterEq',
            hpParam: 'lo cut', hpFallback: 20,
            lpParam: 'hi cut', lpFallback: 16000,
        },
        meta: [
            { label: 'Lo Cut', paramNames: 'lo cut', fallback: 20, suffix: 'Hz' },
            { label: 'Hi Cut', paramNames: 'hi cut', fallback: 16000, suffix: 'Hz' },
            { label: 'Size', paramNames: 'size', fallback: 50, suffix: '%' },
        ],
        settingsPanel: {
            params: ['voicing', 'freeze', 'diffusion', 'density', 'low damp', 'mod rate', 'mod depth', 'chorus', 'predelay', 'width', 'damp'],
            maxCols: 3,
            enumLabels: { 'voicing': ['Room', 'Hall', 'Plate'] },
            toggleParams: ['freeze'],
        },
    },
    hybridReverb: {
        background: 'var(--plugin-bg-reverb)',
        accent: 'var(--token-color-hex-c891ff)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: (device) => {
                const early = clamp01(safeParamValue(device, 'early', 60) / 100);
                const late = clamp01(safeParamValue(device, 'late', 80) / 100);
                const decay = clamp01(safeParamValue(device, 'decay', 50) / 100);
                return Array.from({ length: 12 }, (_, i) => {
                    const isEarly = i < 4;
                    return isEarly
                        ? early * (0.8 - i * 0.1) + 0.1
                        : late * decay * (0.6 + Math.sin(i * 0.9) * 0.3);
                });
            },
        },
        meta: [
            { label: 'Size', paramNames: 'size', fallback: 50, suffix: '%' },
            { label: 'Decay', paramNames: 'decay', fallback: 50, suffix: '%' },
        ],
        settingsPanel: { params: ['damp', 'early', 'late', 'predelay', 'mod depth', 'width'], maxCols: 3 },
    },
    corpus: {
        background: 'var(--plugin-bg-reverb)',
        accent: 'var(--token-color-hex-c891ff)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: (device) => {
                const tune = safeParamValue(device, 'tune', 48); // BUG-AUD: Backend default=48(C3)
                const decay = clamp01(safeParamValue(device, 'decay', 50) / 100);
                return Array.from({ length: 8 }, (_, i) => {
                    const harmonic = Math.sin((i + 1) * tune * 0.05);
                    return 0.15 + Math.abs(harmonic) * decay * 0.7;
                });
            },
        },
        meta: [
            // P-COR-01: Show MIDI note name (not raw number)
            { label: 'Tune', paramNames: 'tune', fallback: 60, suffix: '' },
            { label: 'Decay', paramNames: 'decay', fallback: 50, suffix: '%' },
        ],
        settingsPanel: {
            params: ['damp', 'type', 'spread'],
            // P-COR-02: Corpus type labels
            enumLabels: { 'type': ['Pipe', 'Tube', 'Plate', 'Membrane', 'String'] },
        },
    },

    // ─── DYNAMICS ──────────────────────────────────────────────────────
    limiter: {
        background: 'var(--plugin-bg-limiter)',
        accent: 'var(--token-color-hex-56d4c8)',
        viz: { type: 'gainReductionMeter', grOrientation: 'horizontal' },
        meta: [
            { label: 'Thr', paramNames: 'thr', fallback: -0.3, suffix: 'dB' },
            { label: 'Ceil', paramNames: 'ceil', fallback: -0.1, suffix: 'dB' },
            { label: 'Rel', paramNames: 'rel', fallback: 100, suffix: 'ms' },
        ],
        settingsPanel: {
            params: ['rel', 'lookahead', 'link', 'auto rel'],
            toggleParams: ['auto rel'],
        },
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
            { label: 'Range', paramNames: 'range', fallback: -80, suffix: 'dB' },
        ],
        settingsPanel: {
            params: ['atk', 'hold', 'rel', 'range', 'sc hpf', 'hysteresis', 'duck'],
            toggleParams: ['duck'],
        },
    },
    autoFilter: {
        background: 'var(--plugin-bg-mod)',
        accent: 'var(--token-color-hex-4cc9d8)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: (device) => {
                const cutoff = clamp01(safeParamValue(device, 'cutoff', 1000) / 20000);
                const res = clamp01(safeParamValue(device, 'res', 30) / 100);
                return Array.from({ length: 16 }, (_, i) => {
                    const normI = i / 16;
                    const dist = Math.abs(normI - cutoff);
                    const peak = Math.max(0, 1 - dist * 4) * (0.5 + res * 0.5);
                    return 0.08 + peak * 0.8;
                });
            },
        },
        meta: [
            { label: 'Freq', paramNames: ['cutoff', 'freq', 'frequency', 'center'], fallback: 1000, suffix: 'Hz' },
            { label: 'Res', paramNames: 'res', fallback: 30, suffix: '%' },
        ],
        // AutoFilter type enum labels
        settingsPanel: {
            params: ['rate', 'depth', 'env', 'type', 'lfo shape', 'drive', 'env speed', 'mix'],
            enumLabels: { 'type': ['Low Pass', 'High Pass', 'Band Pass', 'Notch'], 'lfo shape': ['Sine', 'Triangle', 'Saw', 'Square', 'S&H'] },
        },
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
        settingsPanel: {
            params: ['atk', 'rel', 'knee', 'makeup', 'sc hpf', 'auto gain', 'rms', 'lookahead'],
            toggleParams: ['auto gain', 'rms'],
        },
    },
    glueCompressor: {
        background: 'var(--plugin-bg-compressor)',
        accent: 'var(--token-color-hex-6ac3ff)',
        viz: {
            type: 'compressionCurve',
            compVariant: 'glue',
            thrParam: 'thr', thrFallback: -18,
            ratioParam: 'ratio', ratioFallback: 2,
        },
        meta: [
            { label: 'Thr', paramNames: 'thr', fallback: -18, suffix: 'dB' },
            { label: 'Ratio', paramNames: 'ratio', fallback: 2, suffix: ':1' },
        ],
        // P-GC-02: soft_clip as toggle (enterprise Glue Compressor behavior)
        settingsPanel: {
            params: ['ratio', 'atk', 'rel', 'makeup', 'range', 'mix', 'soft clip'],
            enumLabels: { 'ratio': ['2', '4', '10'] },
        },
    },
    multibandDynamics: {
        background: 'var(--plugin-bg-compressor)',
        accent: 'var(--token-color-hex-6ac3ff)',
        viz: {
            type: 'compressionCurve',
            compVariant: 'multiband',
            thrParam: 'mid thr', thrFallback: -18,
            ratioParam: 'mid ratio', ratioFallback: 4,
        },
        meta: [
            { label: 'X-Lo', paramNames: 'xover low', fallback: 200, suffix: 'Hz' },
            { label: 'X-Hi', paramNames: 'xover high', fallback: 4000, suffix: 'Hz' },
            { label: 'Out', paramNames: 'output', fallback: 0, suffix: 'dB' },
        ],
        // P-MB-01: maxCols 2→3 for 10 params (was extremely cramped)
        settingsPanel: { params: ['lo thr', 'lo ratio', 'lo gain', 'mid thr', 'mid ratio', 'mid gain', 'hi thr', 'hi ratio', 'hi gain', 'output'], maxCols: 3 },
    },
    transientShaper: {
        background: 'var(--plugin-bg-compressor)',
        accent: 'var(--token-color-hex-53b0ff)',
        viz: {
            type: 'spectrumBars',
            barCount: 2,
            staticDataGenerator: (device) => {
                const atk = clamp01((safeParamValue(device, 'attack', 0) + 100) / 200);
                const sus = clamp01((safeParamValue(device, 'sustain', 0) + 100) / 200);
                return [atk, sus];
            },
        },
        meta: [
            { label: 'Atk', paramNames: 'attack', fallback: 0, suffix: '%' },
            { label: 'Sus', paramNames: 'sustain', fallback: 0, suffix: '%' },
        ],
        // P-TS-01: Added 'mix', speed suffix is implicit via knob rendering
        settingsPanel: { params: ['output', 'speed', 'mix'] },
    },

    // ─── SATURATION / DISTORTION ──────────────────────────────────────
    saturator: {
        background: 'var(--plugin-bg-saturator)',
        accent: 'var(--token-color-hex-ffac59)',
        viz: { type: 'saturationCurve', satType: 'soft', driveParam: 'drive', driveFallback: 30, driveMax: 100 },
        meta: [{ label: 'Drive', paramNames: 'drive', fallback: 30, suffix: '%' }],
        // P-SAT-02: Saturator mode enum labels
        settingsPanel: {
            params: ['mode', 'output', 'color', 'mix'],
            enumLabels: { 'mode': ['Analog', 'Tape', 'Tube', 'Diode', 'Sinefold'] },
        },
    },
    drumBuss: {
        background: 'var(--plugin-bg-saturator)',
        accent: 'var(--token-color-hex-ffac59)',
        viz: {
            type: 'waveformDisplay',
            waveMode: 'bars',
            staticDataGenerator: (device) => {
                const drive = clamp01(safeParamValue(device, 'drive', 30) / 100);
                const boom = clamp01(safeParamValue(device, 'boom', 30) / 100);
                // Low-end boost from boom, overall energy from drive
                return Array.from({ length: 12 }, (_, i) => {
                    const lowBoost = i < 4 ? boom * 0.6 : 0;
                    return Math.min(1, 0.12 + drive * 0.5 * Math.abs(Math.sin(i * 1.3)) + lowBoost);
                });
            },
        },
        meta: [
            { label: 'Boom', paramNames: 'boom', fallback: 30, suffix: '%' },
            { label: 'Drive', paramNames: 'drive', fallback: 30, suffix: '%' },
        ],
        settingsPanel: { params: ['crunch', 'boom freq', 'transient', 'trim'] },
    },
    dynamicTube: {
        background: 'var(--plugin-bg-saturator)',
        accent: 'var(--token-color-hex-ffbc74)',
        viz: { type: 'saturationCurve', satType: 'tube', driveParam: 'drive', driveFallback: 30, driveMax: 100 },
        meta: [
            { label: 'Drive', paramNames: 'drive', fallback: 30, suffix: '%' },
            { label: 'Bias', paramNames: 'bias', fallback: 0, suffix: '%' },
        ],
        // P-DT-02: Added mix to settings
        settingsPanel: { params: ['envelope', 'tone', 'output', 'mix'] },
    },
    distortion: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ff965e)',
        viz: { type: 'saturationCurve', satType: 'hard', driveParam: 'drive', driveFallback: 30, driveMax: 100 },
        meta: [
            { label: 'Drive', paramNames: 'drive', fallback: 30, suffix: '%' },
            { label: 'Tone', paramNames: 'tone', fallback: 50, suffix: '%' },
        ],
        // P-DIST-01: cab_sim as toggle, mode labels
        settingsPanel: {
            params: ['mode', 'output', 'bias', 'cab sim', 'tight'],
            enumLabels: { 'mode': ['Overdrive', 'Distortion', 'Fuzz', 'Bitcrush'] },
            toggleParams: ['cab sim'],
        },
    },
    overdrive: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ff965e)',
        viz: { type: 'saturationCurve', satType: 'soft', driveParam: 'drive', driveFallback: 30, driveMax: 100 },
        meta: [
            { label: 'Drive', paramNames: 'drive', fallback: 30, suffix: '%' },
            { label: 'Tone', paramNames: 'tone', fallback: 50, suffix: '%' },
        ],
        // P-OD-02: Added mix to overdrive settings
        settingsPanel: { params: ['output', 'bias', 'tight', 'mix'] },
    },
    amp: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ffb57a)',
        viz: { type: 'saturationCurve', satType: 'tube', driveParam: 'gain', driveFallback: 50, driveMax: 100 },
        meta: [
            { label: 'Gain', paramNames: 'gain', fallback: 50, suffix: '%' },
            { label: 'Master', paramNames: 'master', fallback: -6, suffix: 'dB' },
        ],
        // P-AMP-01: Bass/mid/treble are in dB but no suffix — adding mix
        settingsPanel: { params: ['bass', 'mid', 'treble', 'presence', 'sag', 'mix'] },
    },
    cabinet: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ffb57a)',
        viz: {
            type: 'miniFilterEq',
            hpParam: 'lo cut', hpFallback: 80,
            lpParam: 'hi cut', lpFallback: 8000,
        },
        meta: [
            { label: 'Lo', paramNames: 'lo cut', fallback: 80, suffix: 'Hz' },
            { label: 'Hi', paramNames: 'hi cut', fallback: 8000, suffix: 'Hz' },
        ],
        // P-CAB-01: Cabinet type enum labels
        settingsPanel: {
            params: ['type', 'mic pos', 'resonance', 'output', 'mix'],
            enumLabels: { 'type': ['1x12', '2x12', '4x12', 'Open', 'Closed'] },
        },
    },
    erosion: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ff965e)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: (device) => {
                const freq = clamp01(safeParamValue(device, 'frequency', 2000) / 20000);
                const amount = clamp01(safeParamValue(device, 'amount', 50) / 100);
                // Noise band centered around target frequency
                return Array.from({ length: 20 }, (_, i) => {
                    const normI = i / 20;
                    const dist = Math.abs(normI - freq);
                    const peak = Math.max(0, 1 - dist * 4) * amount;
                    return 0.06 + peak * 0.8 + Math.abs(Math.sin(i * 2.5)) * amount * 0.15;
                });
            },
        },
        meta: [
            { label: 'Freq', paramNames: 'frequency', fallback: 2000, suffix: 'Hz' },
            { label: 'Amt', paramNames: 'amount', fallback: 50, suffix: '%' },
        ],
        // P-EROS-01: Erosion mode enum labels
        settingsPanel: {
            params: ['mode', 'width', 'mix'],
            enumLabels: { 'mode': ['Noise', 'Filter', 'Short'] },
        },
    },
    pedal: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ff965e)',
        viz: { type: 'saturationCurve', satType: 'tape', driveParam: 'drive', driveFallback: 50, driveMax: 100 },
        meta: [
            { label: 'Drive', paramNames: 'drive', fallback: 50, suffix: '%' },
            { label: 'Tone', paramNames: 'tone', fallback: 50, suffix: '%' },
        ],
        // P-PED-01: Pedal mode enum labels
        settingsPanel: {
            params: ['mode', 'level', 'mix'],
            enumLabels: { 'mode': ['OD1', 'OD2', 'Fuzz', 'Dist'] },
        },
    },
    roar: {
        background: 'var(--plugin-bg-distortion)',
        accent: 'var(--token-color-hex-ff965e)',
        viz: { type: 'saturationCurve', satType: 'fold', driveParam: 'intensity', driveFallback: 50, driveMax: 100 },
        meta: [
            { label: 'Intensity', paramNames: 'intensity', fallback: 50, suffix: '%' },
            { label: 'Color', paramNames: 'color', fallback: 50, suffix: '%' },
        ],
        // P-ROAR-01: Roar character enum labels
        settingsPanel: {
            params: ['character', 'feedback', 'output', 'mix'],
            enumLabels: { 'character': ['Growl', 'Scream', 'Howl', 'Whisper'] },
        },
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
            { label: 'Bits', paramNames: 'bits', fallback: 16, suffix: 'bit' },
            { label: 'Down', paramNames: ['down', 'downsample'], fallback: 1, suffix: 'x' },
        ],
        settingsPanel: { params: ['jitter', 'pre freq', 'post freq', 'stereo', 'dither'], toggleParams: ['stereo'] },
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
            { label: 'Type', paramNames: 'type', fallback: 0, suffix: '' },
            { label: 'Level', paramNames: 'level', fallback: -12, suffix: 'dB' },
        ],
        // P-NM-02: NoiseMachine type enum labels
        settingsPanel: {
            params: ['type', 'stereo', 'lpfreq', 'hpfreq', 'pan'],
            enumLabels: { 'type': ['White', 'Pink', 'Brown', 'Blue', 'Violet', 'Grey'] },
        },
    },

    // ─── UTILITY ────────────────────────────────────────────────────────
    utility: {
        background: 'var(--plugin-bg-utility)',
        accent: 'var(--token-color-hex-7ab6ff)',
        viz: { type: 'none' },
        meta: [],
        isUtility: true,
        // Mono button: toggles 'mono' param 0↔1 (no scene — simple param toggle)
        buttons: [{ label: 'Mono', paramName: 'mono' }],
        // 'mono' in toggleParams ensures it's excluded from the knob grid (no duplicate)
        settingsPanel: { params: ['mono'], toggleParams: ['mono'] },
    },

    // ─── CHANNEL EQ (3-band DJ-style) ─────────────────────────────────
    bandEq: {
        background: 'var(--plugin-bg-utility)',
        accent: 'var(--token-color-hex-7ab6ff)',
        viz: {
            type: 'spectrumBars',
            barCount: 3,
            staticDataGenerator: (device) => {
                const low = clamp01((safeParamValue(device, 'low', 0) + 60) / 66);
                const mid = clamp01((safeParamValue(device, 'mid', 0) + 60) / 66);
                const high = clamp01((safeParamValue(device, 'high', 0) + 60) / 66);
                return [low, mid, high];
            },
        },
        meta: [
            { label: 'Low', paramNames: 'low', fallback: 0, suffix: 'dB' },
            { label: 'Mid', paramNames: 'mid', fallback: 0, suffix: 'dB' },
            { label: 'High', paramNames: 'high', fallback: 0, suffix: 'dB' },
        ],
        settingsPanel: { params: ['lowfreq', 'highfreq', 'lowkill', 'midkill', 'highkill', 'out'], toggleParams: ['lowkill', 'midkill', 'highkill'] },
    },

    // ─── ANALYZER (spectrum display) ───────────────────────────────────
    analyzer: {
        background: 'var(--plugin-bg-utility)',
        accent: 'var(--token-color-hex-56d4c8)',
        viz: {
            type: 'spectrumBars',
            staticDataGenerator: () => Array.from({ length: 20 }, (_, i) =>
                0.1 + Math.abs(Math.sin(i * 0.7)) * 0.6 * Math.pow(0.95, i)
            ),
        },
        meta: [],
        isUtility: true,
    },
};
