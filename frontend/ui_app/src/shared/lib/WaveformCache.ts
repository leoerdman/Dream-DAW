// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — WaveformCache
// ═══════════════════════════════════════════════════════════════════════════
//
// Client-side LRU cache for waveform peak data fetched from Rust IPC.
//
// Architecture:
//   1. Lazy-loads peaks when a clip first enters the viewport
//   2. Stores the full WaveformPeaks response (multi-mip-level)
//   3. Provides mip-level selection matching Rust PeakCache::best_mip_level()
//   4. LRU eviction when memory budget is exceeded
//   5. Returns pre-computed Float32Array for canvas drawing
//
// ═══════════════════════════════════════════════════════════════════════════

import { getWaveformPeaksBinary, type WaveformPeaks, type PeakMipLevel, type PeakPair } from '@/shared/api/engine';

// ── Configuration ─────────────────────────────────────────────────────────

/** Maximum number of cached waveforms before LRU eviction. */
const MAX_CACHE_ENTRIES = 128;

// ── Types ─────────────────────────────────────────────────────────────────

export interface WaveformDrawData {
    /** Pre-computed min/max peak arrays for efficient canvas drawing. */
    mins: Float32Array;
    maxs: Float32Array;
    /** Samples per peak at this mip level. */
    samplesPerPeak: number;
}

interface CacheEntry {
    data: WaveformPeaks;
    lastAccessed: number;
}

// ── Class ─────────────────────────────────────────────────────────────────

export class WaveformCache {
    private readonly _cache = new Map<string, CacheEntry>();
    private readonly _pending = new Map<string, Promise<WaveformPeaks | null>>();

    // ── Public API ────────────────────────────────────────────────────

    /**
     * Get waveform draw data for a clip at a given zoom level.
     * Returns null if data is not yet available (will be fetched async).
     *
     * @param filePath   - Absolute path to the audio file
     * @param samplesPerPixel - Current zoom level in samples per pixel
     * @param sourceOffset - Start offset in samples (for trimmed clips)
     * @param durationSamples - Duration in samples
     */
    getDrawData(
        filePath: string,
        samplesPerPixel: number,
        sourceOffset: number,
        durationSamples: number,
    ): WaveformDrawData | null {
        const entry = this._cache.get(filePath);
        if (!entry) {
            this._fetchAsync(filePath);
            return null;
        }

        // Touch LRU timestamp
        entry.lastAccessed = performance.now();

        const mipIdx = this._selectMipLevel(samplesPerPixel, entry.data);
        const mip = entry.data.mip_levels[mipIdx];
        if (!mip || mip.peaks.length === 0) return null;

        return this._extractDrawData(mip, entry.data, sourceOffset, durationSamples);
    }

    /**
     * Force-prefetch waveform data for a set of file paths.
     * Useful when clips are about to enter the viewport.
     */
    prefetch(filePaths: string[]): void {
        for (const fp of filePaths) {
            if (!this._cache.has(fp) && !this._pending.has(fp)) {
                this._fetchAsync(fp);
            }
        }
    }

    /** Check if waveform data is cached for a file. */
    has(filePath: string): boolean {
        return this._cache.has(filePath);
    }

    /** Clear all cached data. */
    clear(): void {
        this._cache.clear();
        this._pending.clear();
    }

    /** Number of cached entries. */
    get size(): number {
        return this._cache.size;
    }

    // ── Private ───────────────────────────────────────────────────────

    private _fetchAsync(filePath: string): void {
        if (this._pending.has(filePath)) return;

        const promise = getWaveformPeaksBinary(filePath)
            .then((data: WaveformPeaks | null) => {
                this._pending.delete(filePath);
                if (data && data.mip_levels && data.mip_levels.length > 0) {
                    this._cache.set(filePath, {
                        data,
                        lastAccessed: performance.now(),
                    });
                    this._evictIfNeeded();
                }
                return data;
            })
            .catch((err) => {
                this._pending.delete(filePath);
                console.warn(`[WaveformCache] Failed to load peaks for ${filePath}:`, err);
                return null;
            });

        this._pending.set(filePath, promise);
    }

    /**
     * Select optimal mip level for the current zoom.
     * Matches Rust PeakCache::best_mip_level() logic.
     */
    private _selectMipLevel(samplesPerPixel: number, peaks: WaveformPeaks): number {
        const levels = peaks.mip_levels;
        if (levels.length === 0) return 0;

        // Walk from finest to coarsest — find the first level where
        // each pixel covers at least one peak
        for (let i = 0; i < levels.length; i++) {
            if (levels[i].samples_per_peak >= samplesPerPixel) {
                return i;
            }
        }
        return levels.length - 1;
    }

    /**
     * Extract aligned draw data (Float32Arrays) from a mip level.
     */
    private _extractDrawData(
        mip: PeakMipLevel,
        _waveformMeta: WaveformPeaks,
        sourceOffset: number,
        durationSamples: number,
    ): WaveformDrawData {
        const spp = mip.samples_per_peak;
        const totalPeaks = mip.peaks.length;

        // Calculate peak range for this clip's source region
        const startPeak = Math.max(0, Math.floor(sourceOffset / spp));
        const endPeak = Math.min(
            totalPeaks,
            Math.ceil((sourceOffset + durationSamples) / spp),
        );
        const count = Math.max(0, endPeak - startPeak);

        const mins = new Float32Array(count);
        const maxs = new Float32Array(count);

        for (let i = 0; i < count; i++) {
            const peak: PeakPair = mip.peaks[startPeak + i];
            mins[i] = peak.min;
            maxs[i] = peak.max;
        }

        return { mins, maxs, samplesPerPeak: spp };
    }

    /** Evict least-recently-used entries when cache exceeds budget. */
    private _evictIfNeeded(): void {
        while (this._cache.size > MAX_CACHE_ENTRIES) {
            let oldestKey: string | null = null;
            let oldestTime = Infinity;

            for (const [key, entry] of this._cache) {
                if (entry.lastAccessed < oldestTime) {
                    oldestTime = entry.lastAccessed;
                    oldestKey = key;
                }
            }

            if (oldestKey) {
                this._cache.delete(oldestKey);
            } else {
                break;
            }
        }
    }
}
