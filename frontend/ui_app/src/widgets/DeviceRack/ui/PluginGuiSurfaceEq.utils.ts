import { EQ_BAND_COLORS, EQ_RANDOM_POINT_COLORS, MARGIN_L, PLOT_W, freqToX } from '@/widgets/DeviceRack/lib/eqMath';

const EQ_BAND_COLOR_CACHE = new Map<string, string[]>();
const EQ_BAND_COUNT = 8;
const EQ_PRIMARY_ACCENT = 'var(--color-accent-primary)';
export { EQ_PRIMARY_ACCENT };

type EqGradientStop = { offsetPct: number; color: string };

function pickRandomBandColor(exclude?: string): string {
    const colorPool: readonly string[] = EQ_RANDOM_POINT_COLORS;
    const poolSize = colorPool.length;
    if (poolSize <= 0) return 'var(--color-effect-eq)';
    if (poolSize === 1) return colorPool[0] ?? 'var(--color-effect-eq)';
    let next = colorPool[Math.floor(Math.random() * poolSize)] ?? 'var(--color-effect-eq)';
    if (exclude && next === exclude) {
        next = colorPool[(Math.floor(Math.random() * (poolSize - 1)) + 1) % poolSize] ?? next;
    }
    return next;
}

export function buildInitialEqBandColors(deviceId: string): string[] {
    const cached = EQ_BAND_COLOR_CACHE.get(deviceId);
    if (cached && cached.length === EQ_BAND_COUNT) return [...cached];
    const seeded: string[] = [];
    for (let i = 0; i < EQ_BAND_COUNT; i++) {
        seeded.push(pickRandomBandColor(seeded[i - 1]));
    }
    EQ_BAND_COLOR_CACHE.set(deviceId, seeded);
    return seeded;
}

export function assignNextEqBandColor(deviceId: string, bandIdx: number, prev: string[]): string[] {
    const next = [...prev];
    next[bandIdx] = pickRandomBandColor(prev[bandIdx] ?? EQ_BAND_COLORS[bandIdx]);
    EQ_BAND_COLOR_CACHE.set(deviceId, next);
    return next;
}

export function buildEqGradientStops(
    enabledBands: Array<{ freq: number; color: string }>,
): EqGradientStop[] {
    if (enabledBands.length === 0) {
        return [{ offsetPct: 0, color: EQ_PRIMARY_ACCENT }, { offsetPct: 100, color: EQ_PRIMARY_ACCENT }];
    }
    const sorted = [...enabledBands].sort((a, b) => a.freq - b.freq);
    if (sorted.length === 1) {
        const only = sorted[0];
        return [{ offsetPct: 0, color: only.color }, { offsetPct: 100, color: only.color }];
    }
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const stops: EqGradientStop[] = [{ offsetPct: 0, color: first.color }];
    for (const band of sorted) {
        const px = freqToX(band.freq);
        const normalized = (px - MARGIN_L) / PLOT_W;
        const offsetPct = Math.max(0, Math.min(100, normalized * 100));
        stops.push({ offsetPct, color: band.color });
    }
    stops.push({ offsetPct: 100, color: last.color });
    return stops;
}
