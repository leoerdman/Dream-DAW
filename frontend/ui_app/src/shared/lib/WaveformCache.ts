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
/**
 * ENTERPRISE FIX: Negative cache TTL for missing/failed assets (ms).
 * Prevents IPC retry storms: without this, every render frame re-triggers
 * an IPC call for each missing clip (50+ clips × 4 LODs = 200+ IPC/s).
 */
const NEGATIVE_CACHE_TTL_MS = 60_000;

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
     * ENTERPRISE FIX: Negative cache — tracks keys that failed to load,
     * preventing repeated IPC calls for missing files.
     * Maps cacheKey → timestamp of failure.
     */
    private readonly _failedKeys = new Map<string, number>();

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
            // ENTERPRISE FIX: Skip IPC if this key is in the negative cache.
            if (this._isNegCached(cacheKey)) return null;
            this._fetchAsync(clipId, lodLevel, cacheKey);
            return null;
        }

        // O(1) LRU Touch: Move to end of insertion order
        this._cache.delete(cacheKey);
        this._cache.set(cacheKey, entry);
        entry.lastAccessed = performance.now();

        return this._extractDrawData(sourceOffset, durationSamples, entry);
    }

    /**
     * ENTERPRISE: Get blended draw data from two adjacent mip levels for smooth
     * zoom transitions (Ableton-style). Returns fine + coarse levels with a
     * blend factor [0..1] where 0 = fully fine, 1 = fully coarse.
     *
     * When zoom is between two mip level boundaries, the waveform smoothly
     * transitions between them instead of popping abruptly.
     */
    getBlendedDrawData(
        clipId: string,
        samplesPerPixel: number,
        sourceOffset: number,
        durationSamples: number,
    ): { fine: WaveformDrawData; coarse: WaveformDrawData | null; blendFactor: number } | null {
        const fineLevel = this._selectLodLevel(samplesPerPixel);
        const coarseLevel = Math.min(fineLevel + 1, MIP_FACTORS.length - 1);

        const fineCacheKey = `${clipId}:${fineLevel}`;
        const fineEntry = this._cache.get(fineCacheKey);
        if (!fineEntry) {
            // ENTERPRISE FIX: Skip IPC if this key is in the negative cache.
            if (!this._isNegCached(fineCacheKey)) {
                this._fetchAsync(clipId, fineLevel, fineCacheKey);
            }
            return null;
        }

        // LRU touch
        this._cache.delete(fineCacheKey);
        this._cache.set(fineCacheKey, fineEntry);
        fineEntry.lastAccessed = performance.now();

        const fineData = this._extractDrawData(sourceOffset, durationSamples, fineEntry);

        // If fine===coarse (at max zoom out), no blending needed
        if (fineLevel === coarseLevel) {
            return { fine: fineData, coarse: null, blendFactor: 0 };
        }

        // Calculate blend factor: how far are we between the two mip boundaries?
        // At MIP_FACTORS[fineLevel] → blendFactor = 0 (fully fine)
        // At MIP_FACTORS[coarseLevel] → blendFactor = 1 (fully coarse)
        const fineSpp = MIP_FACTORS[fineLevel];
        const coarseSpp = MIP_FACTORS[coarseLevel];
        // Use logarithmic interpolation for perceptually linear zoom transition
        const logFine = Math.log2(fineSpp);
        const logCoarse = Math.log2(coarseSpp);
        const logCurrent = Math.log2(Math.max(1, samplesPerPixel));
        const blendFactor = Math.max(0, Math.min(1, (logCurrent - logFine) / (logCoarse - logFine)));

        // Prefetch coarse level for seamless transition
        const coarseCacheKey = `${clipId}:${coarseLevel}`;
        const coarseEntry = this._cache.get(coarseCacheKey);
        if (!coarseEntry) {
            if (!this._isNegCached(coarseCacheKey)) {
                this._fetchAsync(clipId, coarseLevel, coarseCacheKey);
            }
            // Return fine-only until coarse loads
            return { fine: fineData, coarse: null, blendFactor: 0 };
        }

        // LRU touch
        this._cache.delete(coarseCacheKey);
        this._cache.set(coarseCacheKey, coarseEntry);
        coarseEntry.lastAccessed = performance.now();

        const coarseData = this._extractDrawData(sourceOffset, durationSamples, coarseEntry);
        return { fine: fineData, coarse: coarseData, blendFactor };
    }

    /** Force-prefetch waveform data for a set of clips. */
    prefetch(clipIds: string[], samplesPerPixel: number): void {
        const lodLevel = this._selectLodLevel(samplesPerPixel);
        for (const cid of clipIds) {
            const cacheKey = `${cid}:${lodLevel}`;
            if (!this._cache.has(cacheKey) && !this._pending.has(cacheKey) && !this._isNegCached(cacheKey)) {
                this._fetchAsync(cid, lodLevel, cacheKey);
            }
        }
    }

    clear(): void {
        this._cache.clear();
        this._pending.clear();
        this._lastWarnAtByKey.clear();
        this._failedKeys.clear();
    }

    get size(): number {
        return this._cache.size;
    }

    // ── Private ───────────────────────────────────────────────────────

    private _fetchAsync(clipId: string, lodLevel: number, cacheKey: string): void {
        if (this._pending.has(cacheKey)) return;
        // Double-check negative cache inside _fetchAsync for safety.
        if (this._isNegCached(cacheKey)) return;

        const promise = getPeaks(clipId, lodLevel)
            .then((bytes: Uint8Array) => {
                this._pending.delete(cacheKey);
                // BUG-003 FIX: Ensure 4-byte alignment for Float32Array by slicing a fresh copy.
                // Tauri IPC may return sub-buffer views where byteOffset is not 4-byte aligned,
                // which causes Float32Array constructor to throw RangeError.
                const alignedBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                const floats = new Float32Array(alignedBuffer);
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
                // ENTERPRISE FIX: Record failure in negative cache to prevent
                // re-triggering the IPC call on every render frame.
                this._failedKeys.set(cacheKey, Date.now());
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
     * ENTERPRISE FIX: Check if a cache key is in the negative cache.
     * Returns true if the key failed recently (within TTL), meaning we should
     * NOT retry the IPC call. Returns false (and clears the entry) if the
     * TTL has expired — allowing re-fetch so reconnected files load correctly.
     */
    private _isNegCached(cacheKey: string): boolean {
        const failedAt = this._failedKeys.get(cacheKey);
        if (failedAt === undefined) return false;
        if (Date.now() - failedAt >= NEGATIVE_CACHE_TTL_MS) {
            // TTL expired — allow retry (files may have been reconnected)
            this._failedKeys.delete(cacheKey);
            this._lastWarnAtByKey.delete(cacheKey);
            return false;
        }
        return true;
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
    // BUG-030 FIX: Pool now uses exact-size buckets. Previous implementation
    // used .subarray() which creates views SHARING the same ArrayBuffer —
    // two concurrent consumers could overwrite each other's waveform data.
    private static _pool64: Float32Array[] = [];
    private static _pool128: Float32Array[] = [];
    private static _pool256: Float32Array[] = [];
    private static _pool512: Float32Array[] = [];
    private static _pool1024: Float32Array[] = [];
    private static readonly MAX_POOL_SIZE = 16;

    private _getBufferFromPool(size: number): Float32Array {
        // BUG-023 FIX: Use .slice() instead of .subarray() to prevent shared-memory corruption.
        // .subarray() returns a VIEW into the same ArrayBuffer — two callers would share memory.
        let pool: Float32Array[] | null = null;
        if (size <= 64) pool = WaveformCache._pool64;
        else if (size <= 128) pool = WaveformCache._pool128;
        else if (size <= 256) pool = WaveformCache._pool256;
        else if (size <= 512) pool = WaveformCache._pool512;
        else if (size <= 1024) pool = WaveformCache._pool1024;

        if (pool && pool.length > 0) {
            const buf = pool.pop()!;
            // Return a correctly-sized copy — never a shared view.
            if (buf.length === size) return buf;
            return buf.slice(0, size);
        }
        return new Float32Array(size);
    }

    private _releaseBufferToPool(arr: Float32Array): void {
        // BUG-012 FIX: Use arr.length (typed array element count) not
        // arr.buffer.byteLength / 4 (underlying buffer size after slice).
        const size = arr.length;
        let pool: Float32Array[] | null = null;
        if (size === 64) pool = WaveformCache._pool64;
        else if (size === 128) pool = WaveformCache._pool128;
        else if (size === 256) pool = WaveformCache._pool256;
        else if (size === 512) pool = WaveformCache._pool512;
        else if (size === 1024) pool = WaveformCache._pool1024;

        // BUG-084 FIX: Cap pool at MAX_POOL_SIZE to prevent unbounded growth.
        if (pool && pool.length < WaveformCache.MAX_POOL_SIZE) {
            pool.push(arr);
        }
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
