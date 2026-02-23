export function buildTrackOffsets(trackCount: number, trackHeight: number, trackHeights: number[] | null): number[] {
    const offsets: number[] = new Array(trackCount + 1);
    offsets[0] = 0;
    for (let i = 0; i < trackCount; i++) {
        const h = trackHeights ? (trackHeights[i] ?? trackHeight) : trackHeight;
        offsets[i + 1] = offsets[i] + Math.max(0, Math.round(h));
    }
    return offsets;
}

export function trackIndexAtOffsetY(
    offsetY: number,
    trackCount: number,
    canvasContentHeight: number,
    offsets: number[],
    fallbackTrackHeight: number,
): number {
    if (trackCount <= 0) return 0;
    const y = Math.max(0, Math.min(canvasContentHeight - 0.0001, offsetY));
    if (offsets.length !== trackCount + 1) {
        return Math.max(0, Math.min(trackCount - 1, Math.floor(y / fallbackTrackHeight)));
    }

    let lo = 0;
    let hi = trackCount;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((offsets[mid + 1] ?? 0) <= y) lo = mid + 1;
        else hi = mid;
    }
    return Math.max(0, Math.min(trackCount - 1, lo));
}
