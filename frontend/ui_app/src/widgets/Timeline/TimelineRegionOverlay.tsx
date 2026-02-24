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
    return (
        <>
            {regionALineX != null && (
                <>
                    {regionAEndLineX != null && <div style={{ position: 'absolute', top: 0, bottom: 0, left: regionAEndLineX, width: 1, background: 'var(--color-status-info)', opacity: 0.65, pointerEvents: 'none' }} />}
                    <div style={{ position: 'absolute', top: 0, bottom: 0, left: regionALineX, width: 1, background: 'var(--color-status-info)', opacity: 0.95, pointerEvents: 'none' }} />
                    <button onMouseDown={(e) => beginRegionDrag('A', 'move', e)} style={{ position: 'absolute', left: regionALineX - 10, top: 2, width: 20, height: 14, borderRadius: 3, border: '1px solid color-mix(in srgb, var(--color-status-info) 75%, #000)', background: 'color-mix(in srgb, var(--color-status-info) 22%, var(--color-bg-elevated))', color: 'var(--color-text-primary)', fontSize: 10, lineHeight: '12px', cursor: 'ew-resize', pointerEvents: 'all' }} title="Drag Region A">A</button>
                    <button onMouseDown={(e) => beginRegionDrag('A', 'resize-start', e)} style={{ position: 'absolute', left: regionALineX - 3, top: trackHeight - 13, width: 6, height: 10, borderRadius: 2, border: 'none', background: 'var(--color-status-info)', opacity: 0.9, cursor: 'ew-resize', pointerEvents: 'all' }} title="Resize Region A start" />
                    {regionAEndLineX != null && <button onMouseDown={(e) => beginRegionDrag('A', 'resize-end', e)} style={{ position: 'absolute', left: regionAEndLineX - 3, top: trackHeight - 13, width: 6, height: 10, borderRadius: 2, border: 'none', background: 'var(--color-status-info)', opacity: 0.9, cursor: 'ew-resize', pointerEvents: 'all' }} title="Resize Region A end" />}
                </>
            )}
            {regionBLineX != null && (
                <>
                    {regionBEndLineX != null && <div style={{ position: 'absolute', top: 0, bottom: 0, left: regionBEndLineX, width: 1, background: 'var(--color-status-warning)', opacity: 0.65, pointerEvents: 'none' }} />}
                    <div style={{ position: 'absolute', top: 0, bottom: 0, left: regionBLineX, width: 1, background: 'var(--color-status-warning)', opacity: 0.95, pointerEvents: 'none' }} />
                    <button onMouseDown={(e) => beginRegionDrag('B', 'move', e)} style={{ position: 'absolute', left: regionBLineX - 10, top: 18, width: 20, height: 14, borderRadius: 3, border: '1px solid color-mix(in srgb, var(--color-status-warning) 75%, #000)', background: 'color-mix(in srgb, var(--color-status-warning) 24%, var(--color-bg-elevated))', color: 'var(--color-text-primary)', fontSize: 10, lineHeight: '12px', cursor: 'ew-resize', pointerEvents: 'all' }} title="Drag Region B">B</button>
                    <button onMouseDown={(e) => beginRegionDrag('B', 'resize-start', e)} style={{ position: 'absolute', left: regionBLineX - 3, top: trackHeight - 25, width: 6, height: 10, borderRadius: 2, border: 'none', background: 'var(--color-status-warning)', opacity: 0.9, cursor: 'ew-resize', pointerEvents: 'all' }} title="Resize Region B start" />
                    {regionBEndLineX != null && <button onMouseDown={(e) => beginRegionDrag('B', 'resize-end', e)} style={{ position: 'absolute', left: regionBEndLineX - 3, top: trackHeight - 25, width: 6, height: 10, borderRadius: 2, border: 'none', background: 'var(--color-status-warning)', opacity: 0.9, cursor: 'ew-resize', pointerEvents: 'all' }} title="Resize Region B end" />}
                </>
            )}
        </>
    );
}
