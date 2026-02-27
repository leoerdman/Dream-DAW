/* eslint-disable no-restricted-syntax */
// BUG-C08b FIX: Canvas ctx.fillStyle cannot resolve CSS custom properties.
// Use raw hex values (extracted from variable name convention --token-color-hex-XXXXXX).
const TRACK_PALETTE = [
    '#f05c4d', '#ff8a1a', '#ffbf33', '#ffe14d',
    '#a3d94d', '#4dc775', '#4dc7b0', '#4dc7cc',
    '#4da6e3', '#4d7ae3', '#6b5ce3', '#9b59d9',
    '#d94da6', '#e36b96', '#e66673', '#8c949e',
] as const;

export function colorForTrackIndex(index: number): string {
    const safe = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
    return TRACK_PALETTE[safe % TRACK_PALETTE.length] ?? '#667788';
}

export function normalizeTrackType(trackType: string): string {
    const normalized = (trackType || 'audio').trim().toLowerCase();
    if (normalized === 'midi') return 'Midi';
    if (normalized === 'group') return 'Group';
    if (normalized === 'master') return 'Master';
    return 'Audio';
}
