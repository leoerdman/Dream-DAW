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

        // O(1) LRU Touch: Move to end of insertion order
        this._cache.delete(cacheKey);
        this._cache.set(cacheKey, entry);
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
                    // O(1) Eviction if full
                    if (this._cache.size >= MAX_CACHE_ENTRIES) {
                        const firstKey = this._cache.keys().next().value;
                        if (firstKey !== undefined) {
                            this._cache.delete(firstKey);
                            this._lastWarnAtByKey.delete(firstKey);
                        }
                    }

                    this._cache.set(cacheKey, {
                        lodLevel,
                        floats,
                        lastAccessed: performance.now(),
                    });
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

    // ── Buffer Pooling ───────────────────────────────────────────────
    private static _pool64: Float32Array[] = [];
    private static _pool128: Float32Array[] = [];
    private static _pool256: Float32Array[] = [];
    private static _pool512: Float32Array[] = [];
    private static _pool1024: Float32Array[] = [];

    private _getBufferFromPool(size: number): Float32Array {
        let pool: Float32Array[] | null = null;
        if (size <= 64) pool = WaveformCache._pool64;
        else if (size <= 128) pool = WaveformCache._pool128;
        else if (size <= 256) pool = WaveformCache._pool256;
        else if (size <= 512) pool = WaveformCache._pool512;
        else if (size <= 1024) pool = WaveformCache._pool1024;

        if (pool && pool.length > 0) return pool.pop()!.subarray(0, size);
        return new Float32Array(size);
    }

    private _releaseBufferToPool(arr: Float32Array): void {
        // BUG-N01 FIX: Use arr.length (logical element count) instead of
        // buffer.byteLength/4 which reads the parent ArrayBuffer size —
        // subarrays share their parent buffer, making byteLength unreliable.
        const size = arr.length;
        if (size === 64) WaveformCache._pool64.push(arr);
        else if (size === 128) WaveformCache._pool128.push(arr);
        else if (size === 256) WaveformCache._pool256.push(arr);
        else if (size === 512) WaveformCache._pool512.push(arr);
        else if (size === 1024) WaveformCache._pool1024.push(arr);
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

        // Release old draw data buffers back to pool
        if (entry.lastDrawData) {
            this._releaseBufferToPool(entry.lastDrawData.data.mins);
            this._releaseBufferToPool(entry.lastDrawData.data.maxs);
        }

        const mins = this._getBufferFromPool(count);
        const maxs = this._getBufferFromPool(count);

        for (let i = 0; i < count; i++) {
            const idx = (startPeak + i) * 2;
            mins[i] = entry.floats[idx];
            maxs[i] = entry.floats[idx + 1];
        }

        const drawData: WaveformDrawData = { mins, maxs, samplesPerPeak: spp };
        entry.lastDrawData = { key: cacheKey, data: drawData };
        return drawData;
    }

    // BUG-055: _evictIfNeeded removed in favor of O(1) next().value in _fetchAsync.
}
