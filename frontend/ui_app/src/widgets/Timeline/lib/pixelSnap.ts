export function snapTimelineX(rawX: number, lineWidthPx = 1): number {
    if (!Number.isFinite(rawX)) return rawX;
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    const deviceX = rawX * dpr;
    const deviceWidth = Math.max(1, lineWidthPx * dpr);
    const alignedDeviceCenter = Math.round(deviceX - deviceWidth / 2) + deviceWidth / 2;
    return alignedDeviceCenter / dpr;
}
