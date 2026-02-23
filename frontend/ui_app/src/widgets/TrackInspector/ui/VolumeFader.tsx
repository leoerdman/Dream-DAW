import { useCallback, useEffect, useRef, useState } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { dbToFader, dbToGain, faderToDb, formatDb, gainToDb } from '@/widgets/TrackInspector/model/faderMath';

export type VolumeFaderProps = {
    volumeLinear: number;
    onVolumeChange: (gain: number) => void;
    compact?: boolean;
    showZeroTick?: boolean;
    controlHeight?: number;
};

export const VolumeFader = ({
    volumeLinear,
    onVolumeChange,
    compact = false,
    showZeroTick = true,
    controlHeight,
}: VolumeFaderProps) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const isDraggingRef = useRef(false);
    const activePointerId = useRef<number | null>(null);
    const dragStartRef = useRef<{ x: number; y: number; startPos: number } | null>(null);
    const db = gainToDb(volumeLinear);
    const faderPos = dbToFader(db);

    const beginDrag = useCallback((clientX: number, clientY: number, startPos: number, pointerId?: number) => {
        isDraggingRef.current = true;
        setIsDragging(true);
        if (typeof pointerId === 'number') activePointerId.current = pointerId;
        dragStartRef.current = { x: clientX, y: clientY, startPos };
    }, []);

    const endDrag = useCallback(() => {
        isDraggingRef.current = false;
        setIsDragging(false);
        activePointerId.current = null;
        dragStartRef.current = null;
        void useEngineStore.getState().flushTrackControlFinals();
    }, []);

    useEffect(() => {
        const onPointerMove = (e: PointerEvent) => {
            if (!isDraggingRef.current) return;
            if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
            const dragStart = dragStartRef.current;
            if (!dragStart) return;
            const deltaX = e.clientX - dragStart.x;
            const deltaY = e.clientY - dragStart.y;
            const dragRangePx = compact ? 120 : 144;
            const delta = (deltaX - deltaY) / dragRangePx;
            const nextPos = Math.max(0, Math.min(1, dragStart.startPos + delta));
            const nextDb = faderToDb(nextPos);
            onVolumeChange(dbToGain(nextDb));
        };

        const onPointerUp = (e: PointerEvent) => {
            if (!isDraggingRef.current) return;
            if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
            endDrag();
        };

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
        };
    }, [compact, endDrag, onVolumeChange]);

    const zeroTickPos = dbToFader(0);
    const trackHeight = controlHeight ?? (compact ? 18 : 22);
    const trackWidth = compact ? 60 : 88;

    return (
        <div data-testid="track-volume-fader" style={{ display: 'flex', alignItems: 'center', minWidth: trackWidth, flexShrink: 0 }}>
            <div
                ref={trackRef}
                onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                    beginDrag(e.clientX, e.clientY, faderPos, e.pointerId);
                }}
                onPointerUp={(e) => {
                    if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
                    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
                    endDrag();
                }}
                onPointerCancel={endDrag}
                onDoubleClick={(e) => {
                    e.stopPropagation();
                    onVolumeChange(1.0);
                    void useEngineStore.getState().flushTrackControlFinals();
                }}
                onWheel={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const step = e.shiftKey ? 0.006 : 0.018;
                    const next = Math.max(0, Math.min(2, volumeLinear + (e.deltaY < 0 ? step : -step)));
                    onVolumeChange(next);
                    void useEngineStore.getState().flushTrackControlFinals();
                }}
                style={{
                    position: 'relative',
                    width: trackWidth,
                    height: trackHeight,
                    minWidth: trackWidth,
                    background: 'color-mix(in srgb, var(--surface-elevated) 84%, var(--token-color-hex-000000))',
                    border: '1px solid color-mix(in srgb, var(--text-primary) 14%, transparent)',
                    borderRadius: 'var(--radius-xs)',
                    cursor: 'ew-resize',
                    overflow: 'hidden',
                    touchAction: 'none',
                }}
            >
                {showZeroTick && (
                    <div style={{
                        position: 'absolute', left: `${zeroTickPos * 100}%`, top: 0, bottom: 0,
                        width: 1, background: 'var(--color-divider-light)', zIndex: 'var(--z-local)' as unknown as number,
                    }} />
                )}
                <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: `${faderPos * 100}%`,
                    background: faderPos > zeroTickPos
                        ? 'linear-gradient(to right, var(--color-status-info), var(--color-port-audio))'
                        : 'var(--color-status-info)',
                    borderRadius: 'var(--radius-xs)',
                    transition: isDragging ? 'none' : 'width 60ms linear',
                }} />
                <span style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: compact ? 'var(--font-size-2xs)' : 'var(--font-size-xs)',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
                    color: 'var(--color-text-primary)',
                    textShadow: 'var(--text-shadow-subtle)',
                    pointerEvents: 'none',
                    letterSpacing: '0.01em',
                }}>
                    {compact ? formatDb(db) : `${formatDb(db)} dB`}
                </span>
            </div>
        </div>
    );
};
