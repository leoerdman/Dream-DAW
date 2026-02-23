import type { MeteringSnapshot } from '@/shared/api/engine';

const METER_FLOOR_DB = -160;

function emptyMeters(): MeteringSnapshot {
    return {
        tracks: [],
        master_left: { rms: METER_FLOOR_DB, peak: METER_FLOOR_DB, clipping: false },
        master_right: { rms: METER_FLOOR_DB, peak: METER_FLOOR_DB, clipping: false },
    };
}

function decodeFromFloatArray(floats: Float32Array, trackCount: number): MeteringSnapshot {
    const tracks: MeteringSnapshot['tracks'] = [];
    let cursor = 0;

    for (let i = 0; i < trackCount; i++) {
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

    return { tracks, master_left, master_right };
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
    const body = packet.subarray(4);
    const floats = new Float32Array(
        body.buffer,
        body.byteOffset,
        Math.floor(body.byteLength / 4),
    );

    return decodeFromFloatArray(floats, trackCount);
}
