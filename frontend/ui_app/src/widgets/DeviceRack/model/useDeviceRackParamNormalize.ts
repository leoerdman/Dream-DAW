import type { DeviceSlot } from './types';

export function normalizeStaticLaneValueForUi(
    effectType: DeviceSlot['effectType'],
    paramName: string,
    value: number,
): number {
    if (!Number.isFinite(value)) return value;
    const key = paramName.toLowerCase();
    const asPct = (v: number) => (Math.abs(v) <= 1.0 ? v * 100 : v);
    const asDb = (v: number, min: number, max: number) => {
        if (v <= 1.0e-5) return min;
        return Math.max(min, Math.min(max, 20 * Math.log10(v)));
    };
    switch (effectType) {
        case 'utility':
            if (key === 'gain') return asDb(value, -60, 24);
            if (key === 'pan') return asPct(value);
            if (key === 'width') return value <= 2.0 ? value * 100 : value;
            if (key === 'mono') return value >= 0.5 ? 1 : 0;
            break;
        case 'reverb':
            if (
                [
                    'size',
                    'damp',
                    'dry/wet',
                    'width',
                    'low damp',
                    'mod depth',
                    'diffusion',
                    'density',
                    'chorus',
                    'chorus amount',
                ].includes(key)
            ) return asPct(value);
            break;
        case 'chorus':
            if (['depth', 'mix', 'spread'].includes(key)) return asPct(value);
            if (key === 'fb') return Math.abs(value) <= 1.0 ? value * 100 : value;
            break;
        case 'saturator':
            if (['tone', 'mix', 'color'].includes(key)) return asPct(value);
            if (key === 'drive') return asDb(value, 0, 36);
            if (key === 'output') return asDb(value, -24, 6);
            break;
        case 'delay':
            if (['fb', 'dry/wet', 'mod depth'].includes(key)) return asPct(value);
            break;
        case 'compressor':
            if (key === 'mix') return asPct(value);
            break;
        case 'autoFilter':
            if (['res', 'depth', 'env', 'mix'].includes(key)) return asPct(value);
            break;
        case 'gate':
            if (key === 'duck') return value >= 0.5 ? 1 : 0;
            break;
        case 'limiter':
            if (key === 'auto rel') return value >= 0.5 ? 1 : 0;
            if (key === 'link') return asPct(value);
            break;
        case 'distortion':
            if (['drive', 'tone', 'mix', 'tight'].includes(key)) return asPct(value);
            if (key === 'output') return asDb(value, -24, 6);
            if (key === 'cab sim') return value >= 0.5 ? 1 : 0;
            if (key === 'bias') return Math.abs(value) <= 1.0 ? value * 100 : value;
            break;
        case 'bitcrusher':
            if (['mix', 'jitter', 'dither'].includes(key)) return asPct(value);
            if (key === 'stereo') return value >= 0.5 ? 1 : 0;
            break;
        case 'phaser':
            if (['depth', 'mix', 'spread'].includes(key)) return asPct(value);
            if (key === 'fb') return Math.abs(value) <= 1.0 ? value * 100 : value;
            break;
        case 'flanger':
            if (['depth', 'mix'].includes(key)) return asPct(value);
            if (key === 'fb') return Math.abs(value) <= 1.0 ? value * 100 : value;
            break;
        case 'autoPan':
            if (['depth', 'mix'].includes(key)) return asPct(value);
            break;
        case 'noiseMachine':
            if (key === 'level') return asDb(value, -60, 0);
            if (key === 'stereo') return asPct(value);
            if (key === 'pan') return asPct(value);
            break;
    }
    return value;
}
