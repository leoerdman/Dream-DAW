// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — WaveformCache (zero-copy IPC)
// ═══════════════════════════════════════════════════════════════════════════
//
// Client-side LRU cache for waveform peak data fetched from Rust IPC.
// Uses the O(1) enterprise contract `getPeaks(clipId, lod)`.
//
// ═══════════════════════════════════════════════════════════════════════════

import { getPeaks } from '@/shared/api/engine';

// ── Configuration ─────────────────────────────────────────────────────────

/** Maximum number of cached LOD levels before LRU eviction. */
const MAX_CACHE_ENTRIES = 512;
/** Per-key warn throttle interval to prevent log storms on missing assets. */
const WARN_THROTTLE_MS = 30_000;

/** Samples-per-peak at each mip level (Matches PeakCache.rs) */
const MIP_FACTORS = [256, 1024, 4096, 16384];

// ── Types ─────────────────────────────────────────────────────────────────

export interface WaveformDrawData {
    /** Pre-computed min/max peak arrays for efficient canvas drawing. */
    mins: Float32Array;
    maxs: Float32Array;
    /** Samples per peak at this mip level. */
    samplesPerPeak: number;
}

interface CacheEntry {
    lodLevel: number;
    /** Raw interleaved floats [min0, max0, min1, max1, ...] */
    floats: Float32Array;
    lastAccessed: number;
    /** Cached sliced draw data to avoid per-frame Float32Array allocation. */
    lastDrawData?: { key: string; data: WaveformDrawData };
}

// ── Class ─────────────────────────────────────────────────────────────────

export class WaveformCache {
    private readonly _cache = new Map<string, CacheEntry>();
    private readonly _pending = new Map<string, Promise<Float32Array | null>>();
    private readonly _lastWarnAtByKey = new Map<string, number>();

    /**
     * Called when async peak data arrives and is cached.
     * Allows the TimelineEngine to schedule a redraw so waveforms appear.
     */
    public onDataReady: (() => void) | null = null;

    // ── Public API ────────────────────────────────────────────────────

    /**
     * Get waveform draw data for a clip at a given zoom level.
     * Returns null if data is not yet available (will be fetched async).
     *
     * @param clipId   - Clip ID (uuid)
     * @param samplesPerPixel - Current zoom level in samples per pixel
     * @param sourceOffset - Start offset in samples (for trimmed clips)
     * @param durationSamples - Duration in samples
     */
    getDrawData(
        clipId: string,
        samplesPerPixel: number,
        sourceOffset: number,
        durationSamples: number,
    ): WaveformDrawData | null {
        const lodLevel = this._selectLodLevel(samplesPerPixel);
        const cacheKey = `${clipId}:${lodLevel}`;

        const entry = this._cache.get(cacheKey);
        if (!entry) {
            this._fetchAsync(clipId, lodLevel, cacheKey);
            return null;
        }

        // Touch LRU
        entry.lastAccessed = performance.now();

        return this._extractDrawData(sourceOffset, durationSamples, entry);
    }

    /** Force-prefetch waveform data for a set of clips. */
    prefetch(clipIds: string[], samplesPerPixel: number): void {
        const lodLevel = this._selectLodLevel(samplesPerPixel);
        for (const cid of clipIds) {
            const cacheKey = `${cid}:${lodLevel}`;
            if (!this._cache.has(cacheKey) && !this._pending.has(cacheKey)) {
                this._fetchAsync(cid, lodLevel, cacheKey);
            }
        }
    }

    clear(): void {
        this._cache.clear();
        this._pending.clear();
        this._lastWarnAtByKey.clear();
    }

    get size(): number {
        return this._cache.size;
    }

    // ── Private ───────────────────────────────────────────────────────

    private _fetchAsync(clipId: string, lodLevel: number, cacheKey: string): void {
        if (this._pending.has(cacheKey)) return;

        const promise = getPeaks(clipId, lodLevel)
            .then((bytes: Uint8Array) => {
                this._pending.delete(cacheKey);
                // Zero-copy view into the returned byte buffer
                const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
                if (floats.length > 0) {
                    this._cache.set(cacheKey, {
                        lodLevel,
                        floats,
                        lastAccessed: performance.now(),
                    });
                    this._evictIfNeeded();
                    // Notify engine that new waveform data is available for drawing
                    this.onDataReady?.();
                }
                return floats;
            })
            .catch((err) => {
                this._pending.delete(cacheKey);
                const now = Date.now();
                const lastWarnAt = this._lastWarnAtByKey.get(cacheKey) ?? 0;
                if (now - lastWarnAt >= WARN_THROTTLE_MS) {
                    this._lastWarnAtByKey.set(cacheKey, now);
                    console.warn(`[WaveformCache] Failed to load peaks for clip ${clipId} lod ${lodLevel}:`, err);
                }
                return null;
            });

        this._pending.set(cacheKey, promise);
    }

    /**
     * Select optimal LOD level for the current zoom.
     * Matches Rust PeakCache::best_mip_level() logic.
     */
    private _selectLodLevel(samplesPerPixel: number): number {
        for (let i = MIP_FACTORS.length - 1; i >= 0; i--) {
            if (samplesPerPixel >= MIP_FACTORS[i]) {
                return i;
            }
        }
        return 0; // Finest level
    }

    /** Extract aligned draw data (Float32Arrays) from the raw floats. */
    private _extractDrawData(
        sourceOffset: number,
        durationSamples: number,
        entry: CacheEntry,
    ): WaveformDrawData {
        const spp = MIP_FACTORS[entry.lodLevel];
        const totalPeaks = entry.floats.length / 2;

        // Calculate peak range for this clip's source region
        const startPeak = Math.max(0, Math.floor(sourceOffset / spp));
        const endPeak = Math.min(
            totalPeaks,
            Math.ceil((sourceOffset + durationSamples) / spp),
        );
        const count = Math.max(0, endPeak - startPeak);

        const cacheKey = `${startPeak}:${endPeak}`;
        if (entry.lastDrawData?.key === cacheKey) {
            return entry.lastDrawData.data;
        }

        const mins = new Float32Array(count);
        const maxs = new Float32Array(count);

        for (let i = 0; i < count; i++) {
            const idx = (startPeak + i) * 2;
            mins[i] = entry.floats[idx];
            maxs[i] = entry.floats[idx + 1];
        }

        const drawData: WaveformDrawData = { mins, maxs, samplesPerPeak: spp };
        entry.lastDrawData = { key: cacheKey, data: drawData };
        return drawData;
    }

    /** Evict LRU */
    private _evictIfNeeded(): void {
        if (this._cache.size <= MAX_CACHE_ENTRIES) return;

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
        }
    }
}
