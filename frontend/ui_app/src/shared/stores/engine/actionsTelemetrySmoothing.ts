import type { MeteringSnapshot } from '@/shared/api/engine';

const METER_FLOOR_DB = -160;
const DEFAULT_METER_DELTA_SEC = 1 / 30;
// DAW-like meter ballistics (enterprise reference: Ableton Live / Logic Pro):
// - Peak attack: fast enough to show transients (~25ms)
// - Peak release: slow enough that bars don't collapse instantly when audio stops.
//   Enterprise DAWs use 1.5–2.0s. Previous value of 0.42s caused bars to drop
//   to floor within ~1 second — the #1 user complaint about meters.
// - RMS attack/release: slightly slower for smooth energy display.
const PEAK_ATTACK_TAU_SEC = 0.020;
const PEAK_RELEASE_TAU_SEC = 1.7;
const RMS_ATTACK_TAU_SEC = 0.10;
const RMS_RELEASE_TAU_SEC = 0.80;

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

// ── PERF FIX: Meter reading type for in-place mutation ──────────────
type MeterReading = MeteringSnapshot['master_left'];

/**
 * PERF FIX: Smooth a single meter reading **in-place** into the `target` object.
 * Previously created a new object per call (~N×2 + 2 master objects per tick = O(N) alloc).
 * Now mutates the target directly — zero allocation on the hot path.
 */
function smoothMeterReadingInto(
    target: MeterReading,
    prev: MeterReading | undefined,
    next: MeterReading,
    dtSec: number,
    nowMs: number,
): void {
    const prevRms = prev?.rms ?? METER_FLOOR_DB;
    const prevPeak = prev?.peak ?? METER_FLOOR_DB;
    const peakAttack = alphaFromTau(dtSec, PEAK_ATTACK_TAU_SEC);
    const peakRelease = alphaFromTau(dtSec, PEAK_RELEASE_TAU_SEC);
    const rmsAttack = alphaFromTau(dtSec, RMS_ATTACK_TAU_SEC);
    const rmsRelease = alphaFromTau(dtSec, RMS_RELEASE_TAU_SEC);

    target.rms = smoothDb(next.rms, prevRms, rmsAttack, rmsRelease);
    target.peak = smoothDb(next.peak, prevPeak, peakAttack, peakRelease);
    target.clipping = next.clipping;

    // ── Peak Hold ───────────────────────────────────────────────────────
    const rawPeak = Number.isFinite(next.peak) ? next.peak : METER_FLOOR_DB;

    let peakHold = prev?.peak_hold ?? METER_FLOOR_DB;
    let peakHoldTs = prev?.peak_hold_ts ?? nowMs;

    // Support manual UI reset (peak_hold_ts === 0 means user clicked reset)
    if (prev?.peak_hold_ts === 0) {
        peakHold = rawPeak;
        peakHoldTs = nowMs;
    }
    // If the raw peak is higher or equal, latch it and restart the timer
    else if (rawPeak >= peakHold) {
        peakHold = rawPeak;
        peakHoldTs = nowMs;
    }
    // If 4 seconds elapsed without a new high, drop to current raw peak
    else if (nowMs - peakHoldTs > 4000) {
        peakHold = rawPeak;
        peakHoldTs = nowMs;
    }

    target.peak_hold = peakHold;
    target.peak_hold_ts = peakHoldTs;
}

// ── PERF FIX: Pre-allocated reusable snapshot ───────────────────────
// Instead of creating a new MeteringSnapshot + N×2 track arrays every tick,
// we maintain a single persistent snapshot object and mutate it in-place.
// Zustand detects changes via the object reference on the top-level `meters`
// key — we swap between two snapshot buffers (double-buffering) so that
// the store sees a new reference while we reuse the old buffer next tick.
let _snapshotA: MeteringSnapshot | null = null;
let _snapshotB: MeteringSnapshot | null = null;
let _useA = true;

function ensureSnapshotCapacity(snapshot: MeteringSnapshot, trackCount: number): void {
    // Grow track arrays if needed (no shrink to avoid re-alloc churn)
    while (snapshot.tracks.length < trackCount) {
        snapshot.tracks.push([
            { rms: METER_FLOOR_DB, peak: METER_FLOOR_DB, clipping: false },
            { rms: METER_FLOOR_DB, peak: METER_FLOOR_DB, clipping: false },
        ]);
    }
}

function createEmptySnapshot(): MeteringSnapshot {
    return {
        tracks: [],
        track_plugin_metrics: [],
        master_left: { rms: METER_FLOOR_DB, peak: METER_FLOOR_DB, clipping: false },
        master_right: { rms: METER_FLOOR_DB, peak: METER_FLOOR_DB, clipping: false },
        master_plugin_metrics: new Array(16).fill(0),
    };
}

/**
 * PERF FIX: Double-buffered in-place meter smoothing.
 *
 * Previous implementation used `next.tracks.map()` → new array + N×2 new objects
 * per tick = O(N) GC pressure at 30fps. With 53 tracks that's 106 objects/tick × 30 = 3,180 objects/sec.
 *
 * This version:
 * 1. Maintains two pre-allocated snapshot buffers (A/B double-buffering).
 * 2. Writes smoothed values in-place into the "inactive" buffer.
 * 3. Swaps active buffer — Zustand sees a new reference (triggers re-render).
 * 4. Zero allocation on the hot path after initial warmup.
 */
export function smoothMeterSnapshot(
    prev: MeteringSnapshot | null,
    next: MeteringSnapshot,
    nowMs: number,
    lastMeterTickMs: number,
): { snapshot: MeteringSnapshot; nextTickMs: number } {
    const dtSec = lastMeterTickMs > 0
        ? Math.max(1 / 240, Math.min(0.25, (nowMs - lastMeterTickMs) / 1000))
        : DEFAULT_METER_DELTA_SEC;

    // Lazy-init double buffers
    if (!_snapshotA) _snapshotA = createEmptySnapshot();
    if (!_snapshotB) _snapshotB = createEmptySnapshot();

    // Pick the inactive buffer as the write target, swap after
    const target = _useA ? _snapshotA : _snapshotB;
    _useA = !_useA;

    const trackCount = next.tracks.length;
    ensureSnapshotCapacity(target, trackCount);

    // Smooth each track in-place
    for (let i = 0; i < trackCount; i++) {
        const prevTrack = prev?.tracks[i];
        const nextTrack = next.tracks[i];
        smoothMeterReadingInto(target.tracks[i][0], prevTrack?.[0], nextTrack[0], dtSec, nowMs);
        smoothMeterReadingInto(target.tracks[i][1], prevTrack?.[1], nextTrack[1], dtSec, nowMs);
    }

    // Reuse plugin_metrics arrays directly from decoded data (no copy needed —
    // the decoder already allocated fresh arrays, and we just swap references).
    target.track_plugin_metrics = next.track_plugin_metrics;

    // Smooth master channels in-place
    smoothMeterReadingInto(target.master_left, prev?.master_left, next.master_left, dtSec, nowMs);
    smoothMeterReadingInto(target.master_right, prev?.master_right, next.master_right, dtSec, nowMs);
    target.master_plugin_metrics = next.master_plugin_metrics;

    return {
        snapshot: target,
        nextTickMs: nowMs,
    };
}
