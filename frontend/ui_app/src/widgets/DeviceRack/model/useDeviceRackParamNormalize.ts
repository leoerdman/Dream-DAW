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
        // ── Wave 3: param normalization ───────────────────────────
        case 'overdrive':
            if (['drive', 'tone', 'mix', 'tight'].includes(key)) return asPct(value);
            if (key === 'bias') return Math.abs(value) <= 1.0 ? value * 100 : value;
            break;
        case 'transientShaper':
            if (['attack', 'sustain'].includes(key)) return Math.abs(value) <= 1.0 ? value * 100 : value;
            if (['speed', 'mix'].includes(key)) return asPct(value);
            break;
        case 'drumBuss':
            if (['drive', 'crunch', 'boom', 'transient', 'mix'].includes(key)) return asPct(value);
            break;
        case 'dynamicTube':
            if (['drive', 'envelope', 'tone', 'mix'].includes(key)) return asPct(value);
            if (key === 'bias') return Math.abs(value) <= 1.0 ? value * 100 : value;
            break;
        case 'phaserFlanger':
            if (['depth', 'blend', 'mix'].includes(key)) return asPct(value);
            if (key === 'fb') return Math.abs(value) <= 1.0 ? value * 100 : value;
            break;
        case 'amp':
            if (['gain', 'presence', 'sag', 'mix'].includes(key)) return asPct(value);
            break;
        case 'cabinet':
            if (['mic pos', 'resonance', 'mix'].includes(key)) return asPct(value);
            break;
        case 'hybridReverb':
            if (['size', 'decay', 'damp', 'early', 'late', 'mod depth', 'mix', 'width'].includes(key)) return asPct(value);
            break;
        case 'erosion':
            if (['amount', 'width', 'mix'].includes(key)) return asPct(value);
            break;
        case 'pedal':
            if (['drive', 'tone', 'mix'].includes(key)) return asPct(value);
            break;
        case 'roar':
            if (['intensity', 'color', 'feedback', 'mix'].includes(key)) return asPct(value);
            break;
        case 'grainDelay':
            if (['spray', 'fb', 'mix'].includes(key)) return asPct(value);
            break;
        case 'corpus':
            if (['decay', 'damp', 'spread', 'mix'].includes(key)) return asPct(value);
            break;
        case 'spectralTime':
            if (['amount', 'decay', 'mix'].includes(key)) return asPct(value);
            if (key === 'tilt') return Math.abs(value) <= 1.0 ? value * 100 : value;
            break;
        case 'glueCompressor':
            if (key === 'mix') return asPct(value);
            if (key === 'soft clip') return asPct(value);
            break;
        case 'filterDelay':
            if (['fb', 'mix'].includes(key)) return asPct(value);
            break;
        case 'multibandDynamics':
            // All params are in native dB/Hz ranges — no normalization needed
            break;
    }
    return value;
}
