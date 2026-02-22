// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — EQ DSP Math (Pure Functions)
// ═══════════════════════════════════════════════════════════════════════════
//
// Biquad coefficient computation and magnitude response evaluation.
// Mirrors the Rust implementation in core/dream_dsp/src/eq.rs.
//
// All functions are pure — no React state, no side effects.
// Extracted from PluginGuiSurface.tsx to enable reuse and testing.
//
// ═══════════════════════════════════════════════════════════════════════════

// ── Types ────────────────────────────────────────────────────────────────

export interface BiquadCoeffs {
    b0: number;
    b1: number;
    b2: number;
    a1: number;
    a2: number;
}

export interface EqBand8 {
    idx: number;
    freq: number;
    gain: number;
    q: number;
    enabled: boolean;
    filterType: string;
    color: string;
}

// ── Constants ────────────────────────────────────────────────────────────

/**  EQ viewBox dimensions */
export const VB_W = 480;
export const VB_H = 200;
export const MARGIN_L = 8;
export const MARGIN_R = 8;
export const PLOT_W = VB_W - MARGIN_L - MARGIN_R;

/** Default 8-band color palette (matches Dream EQ GUI) */
export const EQ_BAND_COLORS = [
    '#e06cf5', '#5ab2ff', '#5cf5e0', '#d9a625',
    '#ff8b5b', '#7ceb8a', '#ff5c5c', '#f0c430',
] as const;

/** Default EQ band center frequencies (Hz) */
export const DEFAULT_BAND_FREQS = [30, 100, 250, 800, 2500, 6000, 12000, 18000] as const;

/** Filter type display labels */
export const EQ_FILTER_LABELS: Readonly<Record<string, string>> = {
    highpass: 'HP', lowshelf: 'L.Shelf', peaking: 'Bell',
    highshelf: 'H.Shelf', lowpass: 'LP', notch: 'Notch',
};

/** Filter type SVG icon paths — 12×12 mini-icons */
export const EQ_FILTER_ICONS: Readonly<Record<string, string>> = {
    highpass: 'M1 11 C2 11 3 10 4 8 C5 5 6 3 7 3 L11 3',
    lowpass: 'M1 3 L5 3 C6 3 7 5 8 8 C9 10 10 11 11 11',
    lowshelf: 'M1 9 C2 9 3 8 4 7 C5 5 5 3 6 3 L11 3',
    highshelf: 'M1 3 L6 3 C7 3 7 5 8 7 C9 8 10 9 11 9',
    peaking: 'M1 8 C3 8 4 3 6 3 C8 3 9 8 11 8',
    notch: 'M1 3 C3 3 4 3 5 9 C5.5 11 6.5 11 7 9 C8 3 9 3 11 3',
};

/** Frequency grid labels for EQ */
export const FREQ_LABELS = [
    { freq: 20, label: '20' }, { freq: 30, label: '30' }, { freq: 50, label: '50' },
    { freq: 100, label: '100' }, { freq: 200, label: '200' }, { freq: 500, label: '500' },
    { freq: 1000, label: '1k' }, { freq: 2000, label: '2k' }, { freq: 5000, label: '5k' },
    { freq: 10000, label: '10k' }, { freq: 20000, label: '20k' },
] as const;

/** Sub-gridline frequencies */
export const FREQ_SUB_LINES = [
    40, 60, 80, 150, 300, 400, 700, 800, 1500, 3000, 4000, 7000, 8000, 15000,
] as const;

// ── Coordinate Helpers ──────────────────────────────────────────────────

const MIN_F = Math.log10(20);
const MAX_F = Math.log10(20000);

/** Map frequency (Hz) → SVG X coordinate */
export function freqToX(freq: number): number {
    return MARGIN_L + ((Math.log10(Math.max(20, Math.min(20000, freq))) - MIN_F) / (MAX_F - MIN_F)) * PLOT_W;
}

/** Map SVG X coordinate → frequency (Hz) */
export function xToFreq(x: number): number {
    const norm = Math.max(0, Math.min(1, (x - MARGIN_L) / PLOT_W));
    return Math.pow(10, MIN_F + norm * (MAX_F - MIN_F));
}

/** Map gain (dB) → SVG Y coordinate */
export function gainToY(gain: number): number {
    const clamped = Math.max(-24, Math.min(24, gain));
    return VB_H / 2 - (clamped / 24) * (VB_H / 2 - 10);
}

/** Filter-only types: dot Y controls Q (resonance), not gain */
export function isFilterOnlyType(ft: string): boolean {
    return ft === 'lowpass' || ft === 'highpass' || ft === 'notch';
}

/** Map Q [0.1 → 18.0] to viewBox Y. High Q = top, low Q = bottom */
export function qToY(q: number): number {
    const clamped = Math.max(0.1, Math.min(18, q));
    // Log scale: 0.1 → bottom (VB_H - 10), 18 → top (10)
    const norm = (Math.log(clamped) - Math.log(0.1)) / (Math.log(18) - Math.log(0.1));
    return (VB_H - 10) - norm * (VB_H - 20);
}

/** Get dot Y position: Q for filter-only types, gain for peaking/shelf */
export function bandDotY(band: EqBand8): number {
    return isFilterOnlyType(band.filterType) ? qToY(band.q) : gainToY(band.gain);
}

// ── Biquad Coefficient Computation ──────────────────────────────────────

/**
 * Compute biquad filter coefficients.
 * Mirrors Rust BiquadCoeffs::new() from core/dream_dsp/src/eq.rs.
 *
 * SSOT: clamp ranges must match Rust eq.rs set_param():
 *   freq → clamp(20.0, 20000.0)
 *   gain → clamp(-24.0, 24.0)
 *   Q    → clamp(0.1, 18.0)
 */
export function computeBiquadCoeffs(
    filterType: string, freq: number, q: number, gainDb: number, sr: number,
): BiquadCoeffs {
    const clampedFreq = Math.max(20, Math.min(20000, freq));
    const clampedQ = Math.max(0.1, Math.min(18, q));
    const clampedGain = Math.max(-24, Math.min(24, gainDb));
    const omega = 2 * Math.PI * clampedFreq / sr;
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

/**
 * Exact biquad magnitude response at a given frequency in dB.
 * Evaluates H(z) = (b0 + b1·z⁻¹ + b2·z⁻²) / (1 + a1·z⁻¹ + a2·z⁻²)
 */
export function biquadMagnitudeDb(c: BiquadCoeffs, freq: number, sr: number): number {
    const w = 2 * Math.PI * freq / sr;
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
    // Floor to prevent -Infinity from log10(≈0) at deep notch points
    if (ratio < 1e-20) return -200;
    return 10 * Math.log10(ratio);
}

// ── EQ Curve Builder ────────────────────────────────────────────────────

/**
 * Build smooth EQ curve SVG path using exact biquad magnitude response.
 * Returns { curvePath, fillPath } ready for SVG rendering.
 */
export function buildEqCurvePaths(
    bands: EqBand8[],
    sampleRate: number,
    steps = 200,
): { curvePath: string; fillPath: string } {
    // Pre-compute coefficients for all enabled bands
    const bandCoeffs: (BiquadCoeffs | null)[] = bands.map((band) =>
        band.enabled
            ? computeBiquadCoeffs(band.filterType, band.freq, band.q, band.gain, sampleRate)
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
            totalGainDb += biquadMagnitudeDb(c, freq, sampleRate);
        }
        const y = gainToY(totalGainDb);
        curvePoints.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }

    const curvePath = `M ${curvePoints.join(' L ')}`;
    const fillPath = `${curvePath} L ${VB_W - MARGIN_R},${VB_H / 2} L ${MARGIN_L},${VB_H / 2} Z`;
    return { curvePath, fillPath };
}

/**
 * Build spectrum analyzer SVG path from FFT magnitude data.
 * Returns empty string if no spectrum data.
 */
export function buildSpectrumPath(spectrumData: Float32Array | number[] | null): string {
    if (!spectrumData || spectrumData.length === 0) return '';

    const specBins = spectrumData.length;
    const specPoints: string[] = [];

    for (let i = 0; i < specBins; i++) {
        // Frequency for this bin — logarithmic mapping matching EQ grid
        const t = i / (specBins - 1);
        const freq = Math.pow(10, Math.log10(20) + t * (Math.log10(20000) - Math.log10(20)));
        const x = MARGIN_L + ((Math.log10(freq) - MIN_F) / (MAX_F - MIN_F)) * PLOT_W;
        // Map dB to viewBox Y: -80dB = bottom, +6dB = top-ish
        const dbValue = spectrumData[i];
        const clampedDb = Math.max(-80, Math.min(6, dbValue));
        const normDb = (clampedDb + 80) / 86; // 0..1 from -80dB to +6dB
        const y = VB_H - normDb * (VB_H - 10);
        specPoints.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }

    return `M ${specPoints[0]} L ${specPoints.slice(1).join(' L ')} L ${VB_W - MARGIN_R},${VB_H} L ${MARGIN_L},${VB_H} Z`;
}

/**
 * Parse 8 EQ bands from device param array.
 */
export function parseBandsFromParams(
    params: Array<{ name: string; value: number }>,
    eqBandFilterTypes: string[],
): EqBand8[] {
    const bands: EqBand8[] = [];
    for (let i = 0; i < 8; i++) {
        const freq = params.find((p) => p.name.toLowerCase() === `b${i}freq`)?.value ?? DEFAULT_BAND_FREQS[i];
        const gain = params.find((p) => p.name.toLowerCase() === `b${i}gain`)?.value ?? 0;
        const q = params.find((p) => p.name.toLowerCase() === `b${i}q`)?.value ?? 0.71;
        const en = params.find((p) => p.name.toLowerCase() === `b${i}en`)?.value ?? 0;
        bands.push({
            idx: i,
            freq,
            gain,
            q,
            enabled: en > 0.5,
            filterType: eqBandFilterTypes[i] ?? 'peaking',
            color: EQ_BAND_COLORS[i],
        });
    }
    return bands;
}
