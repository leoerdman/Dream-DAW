const TRACK_PALETTE = [
    'var(--token-color-hex-f05c4d)', 'var(--token-color-hex-ff8a1a)', 'var(--token-color-hex-ffbf33)', 'var(--token-color-hex-ffe14d)',
    'var(--token-color-hex-a3d94d)', 'var(--token-color-hex-4dc775)', 'var(--token-color-hex-4dc7b0)', 'var(--token-color-hex-4dc7cc)',
    'var(--token-color-hex-4da6e3)', 'var(--token-color-hex-4d7ae3)', 'var(--token-color-hex-6b5ce3)', 'var(--token-color-hex-9b59d9)',
    'var(--token-color-hex-d94da6)', 'var(--token-color-hex-e36b96)', 'var(--token-color-hex-e66673)', 'var(--token-color-hex-8c949e)',
] as const;

export function colorForTrackIndex(index: number): string {
    const safe = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
    return TRACK_PALETTE[safe % TRACK_PALETTE.length] ?? 'var(--token-color-hex-667788)';
}

export function normalizeTrackType(trackType: string): string {
    const normalized = (trackType || 'audio').trim().toLowerCase();
    if (normalized === 'midi') return 'Midi';
    if (normalized === 'group') return 'Group';
    if (normalized === 'master') return 'Master';
    return 'Audio';
}
