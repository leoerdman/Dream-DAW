import type { PluginParam } from '@/widgets/DeviceRack/StandardPluginControls';
import type { DeviceSlot, QuickPreset } from './types';

export const QUICK_PRESETS_BY_EFFECT: Partial<Record<DeviceSlot['effectType'], QuickPreset[]>> = {
    eq: [
        { label: 'Flat', values: { low: 0, mid: 0, high: 0, out: 0 } },
        { label: 'Air', values: { low: -1.5, mid: 1.5, high: 4, out: 0 } },
        { label: 'Warm', values: { low: 2.5, mid: -1, high: -1.5, out: -0.5 } },
    ],
    compressor: [
        { label: 'Gentle', values: { thr: -14, ratio: 2.5, atk: 18, rel: 120 } },
        { label: 'Punch', values: { thr: -22, ratio: 5, atk: 6, rel: 70 } },
        { label: 'Glue', values: { thr: -12, ratio: 2, atk: 30, rel: 180 } },
    ],
    delay: [
        { label: 'Slap', values: { 'time l': 95, 'time r': 95, fb: 18, 'dry/wet': 20 } },
        { label: 'Wide', values: { 'time l': 320, 'time r': 480, fb: 42, 'dry/wet': 34 } },
        { label: 'Wash', values: { 'time l': 560, 'time r': 560, fb: 60, 'dry/wet': 48 } },
    ],
    reverb: [
        {
            label: 'Room',
            values: {
                size: 28, damp: 36, 'dry/wet': 16, predelay: 5, width: 90,
                'lo cut': 120, 'hi cut': 12000, diffusion: 58, density: 62, chorus: 10, voicing: 0,
            },
        },
        {
            label: 'Hall',
            values: {
                size: 56, damp: 52, 'dry/wet': 24, predelay: 14, width: 100,
                'lo cut': 80, 'hi cut': 14500, diffusion: 78, density: 82, chorus: 22, voicing: 1,
            },
        },
        {
            label: 'Shimmer',
            values: {
                size: 76, damp: 74, 'dry/wet': 34, predelay: 22, width: 100,
                'lo cut': 140, 'hi cut': 17800, diffusion: 92, density: 90, chorus: 34, voicing: 2,
            },
        },
    ],
    chorus: [
        { label: 'Subtle', values: { rate: 0.8, depth: 24, mix: 18 } },
        { label: 'Wide', values: { rate: 1.2, depth: 44, mix: 35 } },
        { label: 'Vintage', values: { rate: 0.45, depth: 60, mix: 42 } },
    ],
    saturator: [
        { label: 'Soft', values: { drive: 2.4, tone: 42, mix: 80 } },
        { label: 'Warm', values: { drive: 5.5, tone: 34, mix: 88 } },
        { label: 'Hard', values: { drive: 10.5, tone: 68, mix: 92 } },
    ],
    utility: [
        { label: 'Center', values: { gain: 0, pan: 0, width: 100, mono: 0 } },
        { label: 'Mono', values: { gain: 0, pan: 0, width: 0, mono: 1 } },
        { label: 'Wide', values: { gain: 0, pan: 0, width: 150, mono: 0 } },
    ],
    limiter: [
        { label: 'Safety', values: { thr: -2, rel: 120, ceil: -0.8 } },
        { label: 'Loud', values: { thr: -6, rel: 80, ceil: -0.2 } },
        { label: 'Transparent', values: { thr: -1.2, rel: 220, ceil: -0.3 } },
    ],
    gate: [
        { label: 'Clean', values: { thr: -34, atk: 0.3, hold: 22, rel: 80, range: -80 } },
        { label: 'Tight', values: { thr: -26, atk: 0.05, hold: 4, rel: 28, range: -60 } },
        { label: 'Soft', values: { thr: -46, atk: 2.5, hold: 32, rel: 180, range: -48 } },
    ],
    autoFilter: [
        { label: 'Sweep', values: { cutoff: 1800, res: 38, rate: 0.8, depth: 55, mix: 95 } },
        { label: 'Wobble', values: { cutoff: 320, res: 52, rate: 3.2, depth: 80, mix: 100 } },
        { label: 'Subtle', values: { cutoff: 4200, res: 20, rate: 0.3, depth: 22, mix: 68 } },
    ],
    autoPan: [
        { label: 'Slow', values: { rate: 0.35, depth: 45, phase: 180, mix: 85 } },
        { label: 'Wide', values: { rate: 0.9, depth: 80, phase: 180, mix: 100 } },
        { label: 'Chop', values: { rate: 5.8, depth: 100, phase: 0, mix: 100 } },
    ],
    phaser: [
        { label: 'Classic', values: { rate: 0.7, depth: 65, fb: 20, mix: 60 } },
        { label: 'Deep', values: { rate: 0.24, depth: 92, fb: 45, mix: 72 } },
        { label: 'Fast', values: { rate: 2.5, depth: 50, fb: 15, mix: 48 } },
    ],
    flanger: [
        { label: 'Tape', values: { rate: 0.2, depth: 40, fb: 22, mix: 35 } },
        { label: 'Jet', values: { rate: 0.55, depth: 75, fb: 48, mix: 62 } },
        { label: 'Subtle', values: { rate: 0.16, depth: 24, fb: 10, mix: 28 } },
    ],
    distortion: [
        { label: 'Edge', values: { drive: 22, tone: 58, mix: 70 } },
        { label: 'Crunch', values: { drive: 38, tone: 50, mix: 86 } },
        { label: 'Destroy', values: { drive: 64, tone: 68, mix: 100 } },
    ],
    bitcrusher: [
        { label: 'Soft', values: { bits: 10, down: 1.4, mix: 42 } },
        { label: 'Retro', values: { bits: 7, down: 3.2, mix: 64 } },
        { label: 'Crush', values: { bits: 4, down: 8, mix: 90 } },
    ],
    noiseMachine: [
        { label: 'Vinyl', values: { type: 0, level: -30, stereo: 20 } },
        { label: 'Air', values: { type: 1, level: -34, stereo: 65 } },
        { label: 'Storm', values: { type: 2, level: -20, stereo: 75 } },
    ],
    midiPitch: [
        { label: '-12', values: { semitones: -12 } },
        { label: '0', values: { semitones: 0 } },
        { label: '+12', values: { semitones: 12 } },
    ],
    midiScale: [
        { label: 'C', values: { root: 0 } },
        { label: 'D', values: { root: 2 } },
        { label: 'A', values: { root: 9 } },
    ],
    midiVelocity: [
        { label: 'Even', values: { gain: 1, offset: 0 } },
        { label: 'Accent', values: { gain: 1.3, offset: 8 } },
        { label: 'Soft', values: { gain: 0.78, offset: -12 } },
    ],
    midiRandom: [
        { label: 'Tight', values: { semitones: 2, chance: 0.15 } },
        { label: 'Playful', values: { semitones: 7, chance: 0.35 } },
        { label: 'Wild', values: { semitones: 12, chance: 0.7 } },
    ],
    // BUG-68 FIX: Quick presets for new MIDI effect types.
    midiChord: [
        { label: 'Root', values: { root: 0, octaves: 1, inversion: 0 } },
        { label: 'Spread', values: { root: 0, octaves: 2, inversion: 1 } },
        { label: 'Wide', values: { root: 0, octaves: 3, inversion: 2 } },
    ],
    midiNoteLength: [
        { label: 'Short', values: { length: 50, gate: 80 } },
        { label: 'Normal', values: { length: 200, gate: 100 } },
        { label: 'Long', values: { length: 800, gate: 120 } },
    ],
    midiCcControl: [
        { label: 'Mod Wheel', values: { cc: 1, value: 64 } },
        { label: 'Expression', values: { cc: 11, value: 127 } },
        { label: 'Sustain', values: { cc: 64, value: 127 } },
    ],
    midiExpressionControl: [
        { label: 'Soft', values: { cc: 11, value: 48 } },
        { label: 'Normal', values: { cc: 11, value: 96 } },
        { label: 'Full', values: { cc: 11, value: 127 } },
    ],
    midiArpeggiator: [
        { label: 'Classic', values: { rate: 1, pattern: 0, octaves: 1, gate: 80 } },
        { label: 'Wide', values: { rate: 0.5, pattern: 1, octaves: 2, gate: 90 } },
        { label: 'Fast', values: { rate: 2, pattern: 2, octaves: 1, gate: 60 } },
    ],
};

export function resolveQuickPresetParams(
    device: DeviceSlot,
    preset: QuickPreset,
): Array<{ paramName: string; value: number }> {
    const byName = new Map(device.params.map((p) => [p.name.toLowerCase(), p.name]));
    const resolved: Array<{ paramName: string; value: number }> = [];
    const unmatched: string[] = [];
    for (const [rawName, value] of Object.entries(preset.values)) {
        const key = rawName.toLowerCase();
        const canonical =
            byName.get(key)
            ?? byName.get(key.replace(/\s+/g, ''))
            ?? byName.get(key.replace(/\s*\/\s*/g, '/'));
        if (!canonical) {
            unmatched.push(rawName);
            continue;
        }
        resolved.push({ paramName: canonical, value });
    }
    if (unmatched.length > 0 && process.env.NODE_ENV !== 'production') {
        console.warn(`[Dream] Preset "${preset.label}": unmatched keys: ${unmatched.join(', ')}`);
    }
    return resolved;
}

export function clampAndSnapParamValue(param: PluginParam, value: number): number {
    const clamped = Math.max(param.min, Math.min(param.max, value));
    const step = param.step ?? 0;
    if (!Number.isFinite(step) || step <= 0) return clamped;
    const steps = Math.round((clamped - param.min) / step);
    const snapped = param.min + steps * step;
    return Math.max(param.min, Math.min(param.max, snapped));
}

export function defaultParamForReset(param: PluginParam): number {
    if (Number.isFinite(param.defaultValue)) {
        return clampAndSnapParamValue(param, param.defaultValue as number);
    }
    // BUG-C08 FIX: Use the catalog `value` field as a better fallback than heuristic.
    if (Number.isFinite(param.value)) {
        return clampAndSnapParamValue(param, param.value);
    }
    const name = param.name.toLowerCase();
    if (param.min <= 0 && param.max >= 0) return 0;
    if (name.includes('mix') || name.includes('width') || name.includes('amount') || name.includes('depth')) {
        return (param.min + param.max) * 0.5;
    }
    if (name.includes('gain') || name.includes('volume') || name === 'vol') {
        return Math.min(param.max, Math.max(param.min, 0));
    }
    return (param.min + param.max) * 0.5;
}

export function randomParamValue(param: PluginParam): number {
    const range = param.max - param.min;
    if (!Number.isFinite(range) || range <= 0) return param.value;
    const step = param.step && param.step > 0 ? param.step : range / 120;
    const base = param.min + Math.random() * range;
    const snapped = Math.round((base - param.min) / step) * step + param.min;
    return clampAndSnapParamValue(param, snapped);
}
