interface TimelineRegionOverlayProps {
    trackHeight: number;
    regionA: { startBeat: number; endBeat: number } | null;
    regionB: { startBeat: number; endBeat: number } | null;
    regionALineX: number | null;
    regionBLineX: number | null;
    regionAEndLineX: number | null;
    regionBEndLineX: number | null;
    regionALengthBeats: number;
    regionBLengthBeats: number;
    regionsSwapCompatible: boolean;
    beginRegionDrag: (which: 'A' | 'B', mode: 'move' | 'resize-start' | 'resize-end', e: React.MouseEvent) => void;
    setRegionFromMarquee: (which: 'A' | 'B') => void;
    runDuplicateRegion: () => Promise<void>;
    runMoveRegion: (direction: -1 | 1) => Promise<void>;
    runSwapRegions: () => Promise<void>;
    clearRegions: () => void;
}

export function TimelineRegionOverlay({
    trackHeight,
    regionALineX,
    regionBLineX,
    regionAEndLineX,
    regionBEndLineX,
    beginRegionDrag,
}: TimelineRegionOverlayProps) {
    const lineColorA = 'color-mix(in srgb, var(--color-timeline-playhead) 78%, transparent)';
    const lineColorB = 'color-mix(in srgb, var(--color-timeline-playhead) 56%, transparent)';
    return (
        <>
            {regionALineX != null && (
                <>
                    {regionAEndLineX != null && <div style={{ position: 'absolute', top: 0, bottom: 0, left: regionAEndLineX, width: 1, background: lineColorA, opacity: 0.7, pointerEvents: 'none' }} />}
                    <div style={{ position: 'absolute', top: 0, bottom: 0, left: regionALineX, width: 1, background: lineColorA, opacity: 0.96, pointerEvents: 'none' }} />
                    <button onMouseDown={(e) => beginRegionDrag('A', 'move', e)} style={{ position: 'absolute', left: regionALineX - 7, top: 2, width: 14, height: 12, borderRadius: 2, border: 'var(--space-px) solid color-mix(in srgb, var(--color-border-subtle) 84%, transparent)', background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)', cursor: 'ew-resize', pointerEvents: 'all' }} title="Drag Region" />
                    <button onMouseDown={(e) => beginRegionDrag('A', 'resize-start', e)} style={{ position: 'absolute', left: regionALineX - 2, top: trackHeight - 12, width: 4, height: 10, borderRadius: 1, border: 'none', background: lineColorA, opacity: 0.95, cursor: 'ew-resize', pointerEvents: 'all' }} title="Resize Region start" />
                    {regionAEndLineX != null && <button onMouseDown={(e) => beginRegionDrag('A', 'resize-end', e)} style={{ position: 'absolute', left: regionAEndLineX - 2, top: trackHeight - 12, width: 4, height: 10, borderRadius: 1, border: 'none', background: lineColorA, opacity: 0.95, cursor: 'ew-resize', pointerEvents: 'all' }} title="Resize Region end" />}
                </>
            )}
            {regionBLineX != null && (
                <>
                    {regionBEndLineX != null && <div style={{ position: 'absolute', top: 0, bottom: 0, left: regionBEndLineX, width: 1, background: lineColorB, opacity: 0.65, pointerEvents: 'none' }} />}
                    <div style={{ position: 'absolute', top: 0, bottom: 0, left: regionBLineX, width: 1, background: lineColorB, opacity: 0.92, pointerEvents: 'none' }} />
                    <button onMouseDown={(e) => beginRegionDrag('B', 'move', e)} style={{ position: 'absolute', left: regionBLineX - 7, top: 18, width: 14, height: 12, borderRadius: 2, border: 'var(--space-px) solid color-mix(in srgb, var(--color-border-subtle) 84%, transparent)', background: 'color-mix(in srgb, var(--color-bg-elevated) 88%, transparent)', cursor: 'ew-resize', pointerEvents: 'all' }} title="Drag Region" />
                    <button onMouseDown={(e) => beginRegionDrag('B', 'resize-start', e)} style={{ position: 'absolute', left: regionBLineX - 2, top: trackHeight - 24, width: 4, height: 10, borderRadius: 1, border: 'none', background: lineColorB, opacity: 0.92, cursor: 'ew-resize', pointerEvents: 'all' }} title="Resize Region start" />
                    {regionBEndLineX != null && <button onMouseDown={(e) => beginRegionDrag('B', 'resize-end', e)} style={{ position: 'absolute', left: regionBEndLineX - 2, top: trackHeight - 24, width: 4, height: 10, borderRadius: 1, border: 'none', background: lineColorB, opacity: 0.92, cursor: 'ew-resize', pointerEvents: 'all' }} title="Resize Region end" />}
                </>
            )}
        </>
    );
}
