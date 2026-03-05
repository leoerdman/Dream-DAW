import type { MeteringSnapshot } from '@/shared/api/engine';

const METER_FLOOR_DB = -160;

function emptyMeters(): MeteringSnapshot {
    return {
        tracks: [],
        track_plugin_metrics: [],
        master_left: { rms: METER_FLOOR_DB, peak: METER_FLOOR_DB, clipping: false },
        master_right: { rms: METER_FLOOR_DB, peak: METER_FLOOR_DB, clipping: false },
        master_plugin_metrics: new Array(16).fill(0),
    };
}

function decodeFromFloatArray(floats: Float32Array, trackCount: number): MeteringSnapshot {
    const tracks: MeteringSnapshot['tracks'] = [];
    const track_plugin_metrics: number[][] = [];
    let cursor = 0;

    // Each track uses 22 floats (L: rms, peak, clip  +  R: rms, peak, clip + 16 plugin_metrics).
    // Master uses 22 floats too. Prevent reading past the buffer.
    const maxTracks = Math.max(0, Math.floor((floats.length - 22) / 22));
    const safeTrackCount = Math.min(trackCount, maxTracks);

    for (let i = 0; i < safeTrackCount; i++) {
        const left = {
            rms: floats[cursor++] ?? METER_FLOOR_DB,
            peak: floats[cursor++] ?? METER_FLOOR_DB,
            clipping: (floats[cursor++] ?? 0) >= 0.5,
        };
        const right = {
            rms: floats[cursor++] ?? METER_FLOOR_DB,
            peak: floats[cursor++] ?? METER_FLOOR_DB,
            clipping: (floats[cursor++] ?? 0) >= 0.5,
        };
        tracks.push([left, right]);

        const metrics = new Array(16);
        for (let j = 0; j < 16; j++) metrics[j] = floats[cursor++] ?? 0;
        track_plugin_metrics.push(metrics);
    }

    const master_left = {
        rms: floats[cursor++] ?? METER_FLOOR_DB,
        peak: floats[cursor++] ?? METER_FLOOR_DB,
        clipping: (floats[cursor++] ?? 0) >= 0.5,
    };
    const master_right = {
        rms: floats[cursor++] ?? METER_FLOOR_DB,
        peak: floats[cursor++] ?? METER_FLOOR_DB,
        clipping: (floats[cursor++] ?? 0) >= 0.5,
    };

    const master_plugin_metrics = new Array(16);
    for (let j = 0; j < 16; j++) master_plugin_metrics[j] = floats[cursor++] ?? 0;

    return { tracks, track_plugin_metrics, master_left, master_right, master_plugin_metrics };
}

/**
 * Decode packet returned by `get_meters_binary`:
 * - first 4 bytes: u32 little-endian track_count
 * - remaining bytes: f32 triplets [rms, peak, clipping01]
 */
export function decodeMetersBinaryPacket(packet: Uint8Array): MeteringSnapshot {
    if (packet.byteLength < 4) return emptyMeters();

    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const trackCount = view.getUint32(0, true);
    // BUG-068 FIX: Check alignment of the actual data start, not just packet start.
    const dataByteOffset = packet.byteOffset + 4;
    if (dataByteOffset % 4 === 0) {
        const floats = new Float32Array(
            packet.buffer,
            dataByteOffset,
            Math.floor((packet.byteLength - 4) / 4),
        );
        return decodeFromFloatArray(floats, trackCount);
    }

    // Fallback: guarantee 4-byte alignment when packet is a subarray.
    const body = packet.subarray(4);
    const aligned = body.slice();
    const floats = new Float32Array(
        aligned.buffer,
        aligned.byteOffset,
        Math.floor(aligned.byteLength / 4),
    );

    return decodeFromFloatArray(floats, trackCount);
}
