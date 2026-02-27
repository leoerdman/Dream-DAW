import React from 'react';

const REGION_OVERLAY_LINE_STYLE: React.CSSProperties = { position: 'absolute', top: 0, bottom: 0, width: 1, pointerEvents: 'none' };
const REGION_OVERLAY_DRAG_STYLE: React.CSSProperties = { position: 'absolute', top: 2, width: 14, height: 12, borderRadius: 2, border: 'var(--space-px) solid color-mix(in srgb, var(--color-border-subtle) 84%, transparent)', cursor: 'ew-resize', pointerEvents: 'all' };
const REGION_OVERLAY_RESIZE_STYLE: React.CSSProperties = { position: 'absolute', width: 4, height: 10, borderRadius: 1, border: 'none', cursor: 'ew-resize', pointerEvents: 'all' };

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
                    {regionAEndLineX != null && <div style={{ ...REGION_OVERLAY_LINE_STYLE, left: regionAEndLineX, background: lineColorA, opacity: 0.7 }} />}
                    <div style={{ ...REGION_OVERLAY_LINE_STYLE, left: regionALineX, background: lineColorA, opacity: 0.96 }} />
                    <button onMouseDown={(e) => beginRegionDrag('A', 'move', e)} style={{ ...REGION_OVERLAY_DRAG_STYLE, left: regionALineX - 7, background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)' }} title="Drag Region" />
                    <button onMouseDown={(e) => beginRegionDrag('A', 'resize-start', e)} style={{ ...REGION_OVERLAY_RESIZE_STYLE, left: regionALineX - 2, top: trackHeight - 12, background: lineColorA, opacity: 0.95 }} title="Resize Region start" />
                    {regionAEndLineX != null && <button onMouseDown={(e) => beginRegionDrag('A', 'resize-end', e)} style={{ ...REGION_OVERLAY_RESIZE_STYLE, left: regionAEndLineX - 2, top: trackHeight - 12, background: lineColorA, opacity: 0.95 }} title="Resize Region end" />}
                </>
            )}
            {regionBLineX != null && (
                <>
                    {regionBEndLineX != null && <div style={{ ...REGION_OVERLAY_LINE_STYLE, left: regionBEndLineX, background: lineColorB, opacity: 0.65 }} />}
                    <div style={{ ...REGION_OVERLAY_LINE_STYLE, left: regionBLineX, background: lineColorB, opacity: 0.92 }} />
                    <button onMouseDown={(e) => beginRegionDrag('B', 'move', e)} style={{ ...REGION_OVERLAY_DRAG_STYLE, left: regionBLineX - 7, top: 18, background: 'color-mix(in srgb, var(--color-bg-elevated) 88%, transparent)' }} title="Drag Region" />
                    <button onMouseDown={(e) => beginRegionDrag('B', 'resize-start', e)} style={{ ...REGION_OVERLAY_RESIZE_STYLE, left: regionBLineX - 2, top: trackHeight - 24, background: lineColorB, opacity: 0.92 }} title="Resize Region start" />
                    {regionBEndLineX != null && <button onMouseDown={(e) => beginRegionDrag('B', 'resize-end', e)} style={{ ...REGION_OVERLAY_RESIZE_STYLE, left: regionBEndLineX - 2, top: trackHeight - 24, background: lineColorB, opacity: 0.92 }} title="Resize Region end" />}
                </>
            )}
        </>
    );
}
