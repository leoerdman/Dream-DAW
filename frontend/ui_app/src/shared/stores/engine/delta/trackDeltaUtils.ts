const TRACK_PALETTE = [
    '#F05C4D', '#FF8A1A', '#FFBF33', '#FFE14D',
    '#A3D94D', '#4DC775', '#4DC7B0', '#4DC7CC',
    '#4DA6E3', '#4D7AE3', '#6B5CE3', '#9B59D9',
    '#D94DA6', '#E36B96', '#E66673', '#8C949E',
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
