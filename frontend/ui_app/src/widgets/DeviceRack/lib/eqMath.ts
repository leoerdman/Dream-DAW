
export {
    DEFAULT_BAND_FREQS,
    EQ_BAND_COLORS,
    EQ_RANDOM_POINT_COLORS,
    EQ_FILTER_ICONS,
    EQ_FILTER_LABELS,
    EQ_FILTER_TYPE_TO_INDEX,
    DEFAULT_EQ_FILTER_TYPE_INDEX,
    FREQ_LABELS,
    FREQ_SUB_LINES,
    eqFilterTypeFromIndex,
} from './eqConstants';
import { DEFAULT_BAND_FREQS, EQ_BAND_COLORS, eqFilterTypeFromIndex } from './eqConstants';
import { clampEqGainDb, clamp01, DEFAULT_SAMPLE_RATE } from '@/shared/lib/audioMath';

export interface BiquadCoeffs { b0: number; b1: number; b2: number; a1: number; a2: number; }

export interface EqBand8 {
    idx: number;
    freq: number;
    gain: number;
    q: number;
    enabled: boolean;
    filterType: string;
    color: string;
}

export const VB_W = 480;
export const VB_H = 200;
export const MARGIN_L = 8;
export const MARGIN_R = 8;
export const PLOT_W = VB_W - MARGIN_L - MARGIN_R;

export function deriveEqBandFilterTypes(
    params: Array<{ name: string; value: number }>,
    fallback: string[],
): string[] {
    const next: string[] = [];
    for (let i = 0; i < 8; i++) {
        const fallbackType = fallback[i] ?? 'peaking';
        const typeRaw = params.find((p) => p.name.toLowerCase() === `b${i}type`)?.value;
        next.push(eqFilterTypeFromIndex(typeRaw, fallbackType));
    }
    return next;
}

const MIN_F = Math.log10(20);
const MAX_F = Math.log10(20000);

export function freqToX(freq: number): number {
    return MARGIN_L + ((Math.log10(Math.max(20, Math.min(20000, freq))) - MIN_F) / (MAX_F - MIN_F)) * PLOT_W;
}

export function xToFreq(x: number): number {
    const norm = clamp01((x - MARGIN_L) / PLOT_W);
    return Math.pow(10, MIN_F + norm * (MAX_F - MIN_F));
}

export function gainToY(gain: number): number {
    // CURVE FIX: Allow curves to extend beyond ±24dB for natural HP/LP rolloff
    // visualization. Old code hard-clamped at -24dB causing curves to "drag
    // along the floor". The SVG viewport clips anything below the viewBox
    // boundary, giving a clean visual roll-off effect.
    // Soft-limit at -96dB prevents rendering artefacts from extreme values.
    const softGain = Math.max(-96, Math.min(24, gain));
    return VB_H / 2 - (softGain / 24) * (VB_H / 2 - 10);
}

export function isFilterOnlyType(ft: string): boolean {
    return ft === 'lowpass' || ft === 'highpass' || ft === 'notch';
}

export function qToY(q: number): number {
    const clamped = Math.max(0.1, Math.min(18, q));
    const norm = (Math.log(clamped) - Math.log(0.1)) / (Math.log(18) - Math.log(0.1));
    return (VB_H - 10) - norm * (VB_H - 20);
}

export function bandDotY(band: EqBand8): number {
    return isFilterOnlyType(band.filterType) ? qToY(band.q) : gainToY(band.gain);
}
export function computeBiquadCoeffs(
    filterType: string, freq: number, q: number, gainDb: number, sr: number,
): BiquadCoeffs {
    const safeSampleRate = Number.isFinite(sr) ? Math.max(8000, sr) : DEFAULT_SAMPLE_RATE;
    const nyquist = safeSampleRate * 0.5;
    const maxFreq = Math.max(40, Math.min(20000, nyquist * 0.98));
    const clampedFreq = Math.max(20, Math.min(maxFreq, freq));
    const clampedQ = Math.max(0.1, Math.min(18, q));
    const clampedGain = clampEqGainDb(gainDb);
    const omega = 2 * Math.PI * clampedFreq / safeSampleRate;
    const cosW = Math.cos(omega);
    const sinW = Math.sin(omega);
    const alpha = sinW / (2 * clampedQ);
    const A = Math.pow(10, clampedGain / 40); // sqrt of linear gain
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
    let b0: number, b1: number, b2: number, a0: number, a1n: number, a2n: number;

    switch (filterType) {
        case 'lowpass': {
            b1 = 1 - cosW; b0 = b1 / 2; b2 = b0;
            a0 = 1 + alpha; a1n = -2 * cosW; a2n = 1 - alpha;
            break;
        }
        case 'highpass': {
            b1 = -(1 + cosW); b0 = (1 + cosW) / 2; b2 = b0;
            a0 = 1 + alpha; a1n = -2 * cosW; a2n = 1 - alpha;
            break;
        }
        case 'notch': {
            b0 = 1; b1 = -2 * cosW; b2 = 1;
            a0 = 1 + alpha; a1n = -2 * cosW; a2n = 1 - alpha;
            break;
        }
        case 'lowshelf': {
            b0 = A * ((A + 1) - (A - 1) * cosW + twoSqrtAAlpha);
            b1 = 2 * A * ((A - 1) - (A + 1) * cosW);
            b2 = A * ((A + 1) - (A - 1) * cosW - twoSqrtAAlpha);
            a0 = (A + 1) + (A - 1) * cosW + twoSqrtAAlpha;
            a1n = -2 * ((A - 1) + (A + 1) * cosW);
            a2n = (A + 1) + (A - 1) * cosW - twoSqrtAAlpha;
            break;
        }
        case 'highshelf': {
            b0 = A * ((A + 1) + (A - 1) * cosW + twoSqrtAAlpha);
            b1 = -2 * A * ((A - 1) + (A + 1) * cosW);
            b2 = A * ((A + 1) + (A - 1) * cosW - twoSqrtAAlpha);
            a0 = (A + 1) - (A - 1) * cosW + twoSqrtAAlpha;
            a1n = 2 * ((A - 1) - (A + 1) * cosW);
            a2n = (A + 1) - (A - 1) * cosW - twoSqrtAAlpha;
            break;
        }
        default: { // peaking (bell)
            b0 = 1 + alpha * A; b1 = -2 * cosW; b2 = 1 - alpha * A;
            a0 = 1 + alpha / A; a1n = -2 * cosW; a2n = 1 - alpha / A;
            break;
        }
    }
    const inv = 1 / a0;
    return { b0: b0 * inv, b1: b1 * inv, b2: b2 * inv, a1: a1n * inv, a2: a2n * inv };
}

export function biquadMagnitudeDb(c: BiquadCoeffs, freq: number, sr: number): number {
    const safeSampleRate = Number.isFinite(sr) ? Math.max(8000, sr) : DEFAULT_SAMPLE_RATE;
    const nyquist = safeSampleRate * 0.5;
    const clampedFreq = Math.max(20, Math.min(Math.max(40, nyquist * 0.98), freq));
    const w = 2 * Math.PI * clampedFreq / safeSampleRate;
    const cosW = Math.cos(w);
    const cos2W = Math.cos(2 * w);
    const sinW = Math.sin(w);
    const sin2W = Math.sin(2 * w);
    const numRe = c.b0 + c.b1 * cosW + c.b2 * cos2W;
    const numIm = -(c.b1 * sinW + c.b2 * sin2W);
    const denRe = 1 + c.a1 * cosW + c.a2 * cos2W;
    const denIm = -(c.a1 * sinW + c.a2 * sin2W);
    const num2 = numRe * numRe + numIm * numIm;
    const den2 = denRe * denRe + denIm * denIm;
    if (den2 < 1e-30) return 0;
    const ratio = num2 / den2;
    if (ratio < 1e-20) return -200;
    return 10 * Math.log10(ratio);
}

export function buildEqCurvePaths(
    bands: EqBand8[],
    sampleRate: number,
    steps = 200,
): { curvePath: string; fillPath: string } {
    const safeSampleRate = Number.isFinite(sampleRate) ? Math.max(8000, sampleRate) : DEFAULT_SAMPLE_RATE;
    const bandCoeffs: (BiquadCoeffs | null)[] = bands.map((band) =>
        band.enabled
            ? computeBiquadCoeffs(band.filterType, band.freq, band.q, band.gain, safeSampleRate)
            : null,
    );

    const curvePoints: string[] = [];
    for (let i = 0; i <= steps; i++) {
        const x = MARGIN_L + (i / steps) * PLOT_W;
        const freq = xToFreq(x);
        let totalGainDb = 0;
        for (let bi = 0; bi < bands.length; bi++) {
            const c = bandCoeffs[bi];
            if (!c) continue;
            totalGainDb += biquadMagnitudeDb(c, freq, safeSampleRate);
        }
        const y = gainToY(totalGainDb);
        curvePoints.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }

    const curvePath = `M ${curvePoints.join(' L ')}`;
    const fillPath = `${curvePath} L ${VB_W - MARGIN_R},${VB_H / 2} L ${MARGIN_L},${VB_H / 2} Z`;
    return { curvePath, fillPath };
}

export function buildSpectrumPath(spectrumData: Float32Array | number[] | null): string {
    if (!spectrumData || spectrumData.length === 0) return '';

    const specBins = spectrumData.length;
    if (specBins === 1) {
        const clampedDb = Math.max(-80, Math.min(24, spectrumData[0] ?? -80));
        const normDb = (clampedDb + 80) / 104;
        const rawY = VB_H - normDb * (VB_H - 10);
        const y = Math.max(2, Math.min(VB_H - 2, rawY));
        return `M ${MARGIN_L.toFixed(1)},${y.toFixed(1)} L ${(VB_W - MARGIN_R).toFixed(1)},${y.toFixed(1)} L ${VB_W - MARGIN_R},${VB_H} L ${MARGIN_L},${VB_H} Z`;
    }
    const specPoints: string[] = [];

    const DB_FLOOR = -80;
    const DB_CEIL = 24;
    const DB_RANGE = DB_CEIL - DB_FLOOR; // 104

    for (let i = 0; i < specBins; i++) {
        const t = i / (specBins - 1);
        const freq = Math.pow(10, Math.log10(20) + t * (Math.log10(20000) - Math.log10(20)));
        const x = MARGIN_L + ((Math.log10(freq) - MIN_F) / (MAX_F - MIN_F)) * PLOT_W;
        const dbValue = spectrumData[i];
        const clampedDb = Math.max(DB_FLOOR, Math.min(DB_CEIL, dbValue));
        const normDb = (clampedDb - DB_FLOOR) / DB_RANGE; // 0..1
        const rawY = VB_H - normDb * (VB_H - 10);
        const y = Math.max(2, Math.min(VB_H - 2, rawY));
        specPoints.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }

    return `M ${specPoints[0]} L ${specPoints.slice(1).join(' L ')} L ${VB_W - MARGIN_R},${VB_H} L ${MARGIN_L},${VB_H} Z`;
}

export function parseBandsFromParams(
    params: Array<{ name: string; value: number }>,
    eqBandFilterTypes: string[],
    bandColors?: readonly string[],
): EqBand8[] {
    const DEFAULT_BAND_ENABLED = [1, 0, 0, 0, 0, 0, 0, 1] as const;
    const resolvedTypes = deriveEqBandFilterTypes(params, eqBandFilterTypes);
    const bands: EqBand8[] = [];
    for (let i = 0; i < 8; i++) {
        const rawFreq = params.find((p) => p.name.toLowerCase() === `b${i}freq`)?.value;
        const rawGain = params.find((p) => p.name.toLowerCase() === `b${i}gain`)?.value;
        const rawQ = params.find((p) => p.name.toLowerCase() === `b${i}q`)?.value;
        const rawEn = params.find((p) => p.name.toLowerCase() === `b${i}en`)?.value;
        const freq = Number.isFinite(rawFreq) ? Math.max(20, Math.min(20000, rawFreq as number)) : DEFAULT_BAND_FREQS[i];
        const gain = Number.isFinite(rawGain) ? clampEqGainDb(rawGain as number) : 0;
        const q = Number.isFinite(rawQ) ? Math.max(0.1, Math.min(18, rawQ as number)) : 0.71;
        const en = Number.isFinite(rawEn) ? (rawEn as number) : DEFAULT_BAND_ENABLED[i];
        bands.push({
            idx: i,
            freq,
            gain,
            q,
            enabled: en > 0.5,
            filterType: resolvedTypes[i] ?? 'peaking',
            color: bandColors?.[i] ?? EQ_BAND_COLORS[i],
        });
    }
    return bands;
}
