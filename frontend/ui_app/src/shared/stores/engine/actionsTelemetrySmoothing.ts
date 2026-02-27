import type { MeteringSnapshot } from '@/shared/api/engine';

const METER_FLOOR_DB = -160;
const DEFAULT_METER_DELTA_SEC = 1 / 30;
// DAW-like meter ballistics:
// fast enough on attacks to stay responsive, slower release to avoid flicker.
const PEAK_ATTACK_TAU_SEC = 0.025;
const PEAK_RELEASE_TAU_SEC = 0.42;
const RMS_ATTACK_TAU_SEC = 0.12;
const RMS_RELEASE_TAU_SEC = 0.55;

function alphaFromTau(dtSec: number, tauSec: number): number {
    if (!Number.isFinite(dtSec) || dtSec <= 0) return 1;
    if (!Number.isFinite(tauSec) || tauSec <= 0) return 1;
    return 1 - Math.exp(-dtSec / tauSec);
}

function smoothDb(nextDb: number, prevDb: number, attackAlpha: number, releaseAlpha: number): number {
    if (!Number.isFinite(nextDb)) return prevDb;
    if (!Number.isFinite(prevDb)) return nextDb;
    const alpha = nextDb >= prevDb ? attackAlpha : releaseAlpha;
    const smoothed = prevDb + (nextDb - prevDb) * alpha;
    if (!Number.isFinite(smoothed)) return nextDb;
    return Math.max(METER_FLOOR_DB, smoothed);
}

function smoothMeterReading(
    prev: MeteringSnapshot['master_left'] | undefined,
    next: MeteringSnapshot['master_left'],
    dtSec: number,
    nowMs: number,
): MeteringSnapshot['master_left'] {
    const prevRms = prev?.rms ?? METER_FLOOR_DB;
    const prevPeak = prev?.peak ?? METER_FLOOR_DB;
    const peakAttack = alphaFromTau(dtSec, PEAK_ATTACK_TAU_SEC);
    const peakRelease = alphaFromTau(dtSec, PEAK_RELEASE_TAU_SEC);
    const rmsAttack = alphaFromTau(dtSec, RMS_ATTACK_TAU_SEC);
    const rmsRelease = alphaFromTau(dtSec, RMS_RELEASE_TAU_SEC);

    const smoothedRms = smoothDb(next.rms, prevRms, rmsAttack, rmsRelease);
    const smoothedPeak = smoothDb(next.peak, prevPeak, peakAttack, peakRelease);

    let peakHold = prev?.peak_hold ?? METER_FLOOR_DB;
    let peakHoldTs = prev?.peak_hold_ts ?? nowMs;

    // Maintain absolute maximum over a 4-second window
    if (smoothedPeak >= peakHold) {
        peakHold = smoothedPeak;
        peakHoldTs = nowMs;
    } else if (nowMs - peakHoldTs > 4000) {
        // 4000ms elapsed without a new high; drop to current smoothed peak
        peakHold = smoothedPeak;
        peakHoldTs = nowMs;
    }

    // Support manual UI reset (set to 0)
    if (prev?.peak_hold_ts === 0) {
        peakHold = smoothedPeak;
        peakHoldTs = nowMs;
    }

    return {
        rms: smoothedRms,
        peak: smoothedPeak,
        clipping: next.clipping,
        peak_hold: peakHold,
        peak_hold_ts: peakHoldTs,
    };
}

export function smoothMeterSnapshot(
    prev: MeteringSnapshot | null,
    next: MeteringSnapshot,
    nowMs: number,
    lastMeterTickMs: number,
): { snapshot: MeteringSnapshot; nextTickMs: number } {
    const dtSec = lastMeterTickMs > 0
        ? Math.max(1 / 240, Math.min(0.25, (nowMs - lastMeterTickMs) / 1000))
        : DEFAULT_METER_DELTA_SEC;
    const tracks: MeteringSnapshot['tracks'] = next.tracks.map((track, i) => {
        const prevTrack = prev?.tracks[i];
        return [
            smoothMeterReading(prevTrack?.[0], track[0], dtSec, nowMs),
            smoothMeterReading(prevTrack?.[1], track[1], dtSec, nowMs),
        ];
    });
    return {
        snapshot: {
            tracks,
            master_left: smoothMeterReading(prev?.master_left, next.master_left, dtSec, nowMs),
            master_right: smoothMeterReading(prev?.master_right, next.master_right, dtSec, nowMs),
        },
        nextTickMs: nowMs,
    };
}
