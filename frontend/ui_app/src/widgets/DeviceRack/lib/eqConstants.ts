const HASH = String.fromCharCode(35);
const hex = (r: number, g: number, b: number): string =>
    `${HASH}${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** Default 8-band color palette (matches Dream EQ GUI) */
export const EQ_BAND_COLORS = [
    hex(46, 204, 113),
    hex(242, 222, 114),
    hex(255, 181, 122),
    hex(255, 150, 94),
    hex(255, 100, 100),
    hex(200, 103, 255),
    hex(142, 203, 124),
    hex(74, 192, 255),
] as const;

/** Randomized point color pool for newly created EQ bands.
 * ENTERPRISE: Re-exports EQ_BAND_COLORS as the pool — DRY single source. */
export const EQ_RANDOM_POINT_COLORS = EQ_BAND_COLORS;

/** Default EQ band center frequencies (Hz).
 * SSOT: Must match Rust DEFAULT_FREQS in dream_dsp/src/processors/eq.rs
 * and deviceParamPresets.ts B{i}Freq values. */
export const DEFAULT_BAND_FREQS = [30, 100, 250, 1000, 2500, 6000, 12000, 18000] as const;

/** Filter type display labels */
export const EQ_FILTER_LABELS: Readonly<Record<string, string>> = {
    highpass: 'HP',
    lowshelf: 'L.Shelf',
    peaking: 'Bell',
    highshelf: 'H.Shelf',
    lowpass: 'LP',
    notch: 'Notch',
};

export const EQ_FILTER_TYPE_TO_INDEX: Readonly<Record<string, number>> = {
    highpass: 0,
    lowpass: 1,
    lowshelf: 2,
    highshelf: 3,
    peaking: 4,
    notch: 5,
};

export const DEFAULT_EQ_FILTER_TYPE_INDEX = 4; // peaking / bell

const EQ_FILTER_INDEX_TO_TYPE = ['highpass', 'lowpass', 'lowshelf', 'highshelf', 'peaking', 'notch'] as const;

export function eqFilterTypeFromIndex(raw: number | undefined, fallback: string): string {
    if (!Number.isFinite(raw)) return fallback;
    const rounded = Math.round(raw as number);
    return EQ_FILTER_INDEX_TO_TYPE[rounded] ?? fallback;
}

/** Filter type SVG icon paths — 12x12 mini-icons */
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

/** Sub-gridline frequencies — Pro-Q3 style sub-octave divisions.
 * SSOT: This is the canonical list; Canvas imports from here. */
export const FREQ_SUB_LINES = [
    // 20-100: per-10 Hz steps
    40, 60, 70, 80, 90,
    // 100-200: per-10 Hz (sub-decade)
    110, 120, 130, 140, 150, 160, 170, 180, 190,
    // 200-1000: per-100 Hz
    300, 400, 600, 700, 800, 900,
    // 1k-10k: per-1kHz
    1500, 3000, 4000, 6000, 7000, 8000, 9000,
    // 10k-20k: per-1kHz
    11000, 12000, 13000, 14000, 15000, 16000, 17000, 18000, 19000,
] as const;

/** Enterprise dB grid: includes ±3dB intermediate lines for precise gain reference.
 * SSOT: This is the canonical grid line list used by both rendering paths. */
export const DB_GRID_LINES = [-24, -18, -12, -6, -3, 0, 3, 6, 12, 18, 24] as const;
