/** Linear gain (0..2) -> dB. 0 gain -> -Infinity. */
export function gainToDb(gain: number): number {
    if (gain <= 0) return -Infinity;
    return 20 * Math.log10(gain);
}

/** dB -> linear gain. Clamps to [0, ~+6 dB]. */
export function dbToGain(db: number): number {
    if (!Number.isFinite(db) || db <= -100) return 0;
    return Math.pow(10, db / 20);
}

/** Format dB for display. */
export function formatDb(db: number): string {
    if (!Number.isFinite(db) || db <= -60) return '-∞';
    if (Math.abs(db) < 0.05) return '0';
    return db > 0 ? `+${db.toFixed(1)}` : db.toFixed(1);
}

/** Fader position (0..1) -> dB. 0 = -inf, ~0.77 = 0dB, 1 = +6dB. */
export function faderToDb(pos: number): number {
    if (pos <= 0) return -Infinity;
    if (pos >= 1) return 6;
    const zeroPt = 0.77;
    if (pos <= zeroPt) {
        const t = pos / zeroPt;
        const db = -60 * Math.pow(1 - t, 3);
        return Math.max(-60, db);
    }
    const t = (pos - zeroPt) / (1 - zeroPt);
    return t * 6;
}

/** dB -> fader position (0..1), inverse of faderToDb. */
export function dbToFader(db: number): number {
    if (!Number.isFinite(db) || db <= -60) return 0;
    if (db >= 6) return 1;
    const zeroPt = 0.77;
    if (db <= 0) {
        const ratio = Math.max(0, db / -60);
        const t = 1 - Math.pow(ratio, 1 / 3);
        return t * zeroPt;
    }
    return zeroPt + (db / 6) * (1 - zeroPt);
}
