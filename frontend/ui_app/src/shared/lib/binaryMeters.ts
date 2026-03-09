// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Binary Meter Decoder (PERF-optimized)
// ═══════════════════════════════════════════════════════════════════════════
//
// PERF FIX: Uses a pre-allocated reusable MeteringSnapshot with pooled
// track arrays. Previously allocated N×2 meter objects + N `new Array(16)`
// for plugin_metrics on every tick (~30fps). With 53 tracks that's
// 53×2 + 53×16 + 4 master = 1,062 allocations/tick × 30 = 31,860 objects/sec.
//
// Now reuses a single growable snapshot. Only allocates when track count grows.
// ═══════════════════════════════════════════════════════════════════════════

import type { MeteringSnapshot } from '@/shared/api/engine';

const METER_FLOOR_DB = -160;

// ── PERF: Pre-allocated reusable decode target ──────────────────────
let _decoderSnapshot: MeteringSnapshot | null = null;

function ensureDecoderCapacity(trackCount: number): MeteringSnapshot {
    if (!_decoderSnapshot) {
        _decoderSnapshot = {
            tracks: [],
            track_plugin_metrics: [],
            master_left: { rms: METER_FLOOR_DB, peak: METER_FLOOR_DB, clipping: false, peak_hold: METER_FLOOR_DB, peak_hold_ts: 0 },
            master_right: { rms: METER_FLOOR_DB, peak: METER_FLOOR_DB, clipping: false, peak_hold: METER_FLOOR_DB, peak_hold_ts: 0 },
            master_plugin_metrics: new Array(16).fill(0),
        };
    }
    // Grow track arrays if needed (never shrink to avoid re-alloc churn)
    while (_decoderSnapshot.tracks.length < trackCount) {
        _decoderSnapshot.tracks.push([
            { rms: METER_FLOOR_DB, peak: METER_FLOOR_DB, clipping: false, peak_hold: METER_FLOOR_DB, peak_hold_ts: 0 },
            { rms: METER_FLOOR_DB, peak: METER_FLOOR_DB, clipping: false, peak_hold: METER_FLOOR_DB, peak_hold_ts: 0 },
        ]);
    }
    while (_decoderSnapshot.track_plugin_metrics.length < trackCount) {
        _decoderSnapshot.track_plugin_metrics.push(new Array(16).fill(0));
    }
    return _decoderSnapshot;
}

/**
 * PERF FIX: Decode float array into the pre-allocated snapshot — zero allocation.
 * Mutates `target` in-place instead of creating new objects.
 */
function decodeFromFloatArrayInto(target: MeteringSnapshot, floats: Float32Array, trackCount: number): void {
    let cursor = 0;

    // Each track uses 22 floats (L: rms, peak, clip + R: rms, peak, clip + 16 plugin_metrics).
    // Master uses 22 floats too. Prevent reading past the buffer.
    const maxTracks = Math.max(0, Math.floor((floats.length - 22) / 22));
    const safeTrackCount = Math.min(trackCount, maxTracks);

    for (let i = 0; i < safeTrackCount; i++) {
        const left = target.tracks[i][0];
        left.rms = floats[cursor++] ?? METER_FLOOR_DB;
        left.peak = floats[cursor++] ?? METER_FLOOR_DB;
        left.clipping = (floats[cursor++] ?? 0) >= 0.5;

        const right = target.tracks[i][1];
        right.rms = floats[cursor++] ?? METER_FLOOR_DB;
        right.peak = floats[cursor++] ?? METER_FLOOR_DB;
        right.clipping = (floats[cursor++] ?? 0) >= 0.5;

        const metrics = target.track_plugin_metrics[i];
        for (let j = 0; j < 16; j++) metrics[j] = floats[cursor++] ?? 0;
    }

    const ml = target.master_left;
    ml.rms = floats[cursor++] ?? METER_FLOOR_DB;
    ml.peak = floats[cursor++] ?? METER_FLOOR_DB;
    ml.clipping = (floats[cursor++] ?? 0) >= 0.5;

    const mr = target.master_right;
    mr.rms = floats[cursor++] ?? METER_FLOOR_DB;
    mr.peak = floats[cursor++] ?? METER_FLOOR_DB;
    mr.clipping = (floats[cursor++] ?? 0) >= 0.5;

    const masterMetrics = target.master_plugin_metrics;
    for (let j = 0; j < 16; j++) masterMetrics[j] = floats[cursor++] ?? 0;
}

/**
 * Decode packet returned by `get_meters_binary`:
 * - first 4 bytes: u32 little-endian track_count
 * - remaining bytes: f32 triplets [rms, peak, clipping01]
 *
 * PERF FIX: Returns a reference to a pre-allocated snapshot that is mutated
 * in-place. The caller MUST NOT hold references across ticks — the data
 * will be overwritten on the next call.
 */
export function decodeMetersBinaryPacket(packet: Uint8Array): MeteringSnapshot {
    if (packet.byteLength < 4) {
        return ensureDecoderCapacity(0);
    }

    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const trackCount = view.getUint32(0, true);
    const target = ensureDecoderCapacity(trackCount);

    // BUG-068 FIX: Check alignment of the actual data start, not just packet start.
    const dataByteOffset = packet.byteOffset + 4;
    if (dataByteOffset % 4 === 0) {
        const floats = new Float32Array(
            packet.buffer,
            dataByteOffset,
            Math.floor((packet.byteLength - 4) / 4),
        );
        decodeFromFloatArrayInto(target, floats, trackCount);
    } else {
        // Fallback: guarantee 4-byte alignment when packet is a subarray.
        const body = packet.subarray(4);
        const aligned = body.slice();
        const floats = new Float32Array(
            aligned.buffer,
            aligned.byteOffset,
            Math.floor(aligned.byteLength / 4),
        );
        decodeFromFloatArrayInto(target, floats, trackCount);
    }

    return target;
}
