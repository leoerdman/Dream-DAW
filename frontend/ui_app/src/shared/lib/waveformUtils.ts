// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Waveform Utilities (SSOT)
// ═══════════════════════════════════════════════════════════════════════════
//
// Shared waveform processing utilities used by PluginGuiSurface,
// PadWaveform, AssetBrowser, and any other component that renders
// waveform peak data.
//
// ═══════════════════════════════════════════════════════════════════════════

import type { PeakPair } from '@/shared/api/engine';

/**
 * Downsamples an array of peak pairs to a target number of buckets.
 *
 * For each bucket, the minimum of all `min` values and the maximum
 * of all `max` values within the bucket range are preserved — this
 * ensures visual accuracy (no peaks are visually clipped).
 *
 * If `peaks.length <= targetCount`, the array is returned as-is.
 *
 * @param peaks      - Source peak data from the engine.
 * @param targetCount - Desired number of output samples.
 * @returns Downsampled peak pairs.
 */
export function downsamplePeaks(
    peaks: PeakPair[],
    targetCount: number,
): PeakPair[] {
    if (peaks.length <= targetCount) return peaks;
    if (targetCount <= 0) return [];

    const reduced: PeakPair[] = [];
    const bucket = peaks.length / targetCount;

    for (let i = 0; i < targetCount; i++) {
        const start = Math.floor(i * bucket);
        const end = Math.min(peaks.length, Math.max(start + 1, Math.floor((i + 1) * bucket)));
        let min = 1;
        let max = -1;
        for (let j = start; j < end; j++) {
            if (peaks[j].min < min) min = peaks[j].min;
            if (peaks[j].max > max) max = peaks[j].max;
        }
        reduced.push({ min, max });
    }
    return reduced;
}

/**
 * Selects the best mip level from waveform peak data.
 * Prefers the first (finest) mip level, falling back to the last.
 */
export function selectFinestMipLevel(
    mipLevels: Array<{ peaks: PeakPair[] }>,
): PeakPair[] {
    const level = mipLevels[0] ?? mipLevels[mipLevels.length - 1];
    return level?.peaks ?? [];
}
