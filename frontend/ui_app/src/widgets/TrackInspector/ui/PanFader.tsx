import { useCallback, useEffect, useRef } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';

export type PanFaderProps = {
    pan: number;
    onPanChange: (pan: number) => void;
    compact?: boolean;
    controlHeight?: number;
};

export const PanFader = ({
    pan,
    onPanChange,
    compact = false,
    controlHeight,
}: PanFaderProps) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const isDraggingRef = useRef(false);
    const activePointerId = useRef<number | null>(null);
    const dragStartRef = useRef<{ x: number; y: number; startNorm: number } | null>(null);
    const panNorm = Math.max(0, Math.min(1, (pan + 1) / 2));

    const endDrag = useCallback(() => {
        isDraggingRef.current = false;
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
            const nextNorm = Math.max(0, Math.min(1, dragStart.startNorm + delta));
            onPanChange(nextNorm * 2 - 1);
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
    }, [compact, endDrag, onPanChange]);

    const panLabel = Math.abs(pan) < 0.02
        ? 'C'
        : `${pan < 0 ? '-' : '+'}${Math.round(Math.abs(pan) * 100)}`;

    const trackHeight = controlHeight ?? (compact ? 18 : 22);
    const trackWidth = compact ? 60 : 88;

    return (
        <div data-testid="track-pan-fader" style={{ display: 'flex', alignItems: 'center', minWidth: trackWidth, flexShrink: 0 }}>
            <div
                ref={trackRef}
                onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                    activePointerId.current = e.pointerId;
                    isDraggingRef.current = true;
                    dragStartRef.current = { x: e.clientX, y: e.clientY, startNorm: panNorm };
                }}
                onPointerUp={(e) => {
                    if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
                    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
                    endDrag();
                }}
                onPointerCancel={endDrag}
                onDoubleClick={(e) => {
                    e.stopPropagation();
                    onPanChange(0);
                    void useEngineStore.getState().flushTrackControlFinals();
                }}
                onWheel={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const step = e.shiftKey ? 0.01 : 0.03;
                    const next = Math.max(-1, Math.min(1, pan + (e.deltaY < 0 ? step : -step)));
                    onPanChange(next);
                    void useEngineStore.getState().flushTrackControlFinals();
                }}
                style={{
                    position: 'relative',
                    width: trackWidth,
                    height: trackHeight,
                    background: 'color-mix(in srgb, var(--surface-elevated) 84%, var(--token-color-hex-000000))',
                    border: 'var(--space-px) solid color-mix(in srgb, var(--text-primary) 14%, transparent)',
                    borderRadius: 'var(--radius-xs)',
                    cursor: 'ew-resize',
                    overflow: 'hidden',
                    touchAction: 'none',
                }}
            >
                <div style={{
                    position: 'absolute',
                    top: 0,
                    left: panNorm <= 0.5 ? `${panNorm * 100}%` : '50%',
                    width: `${Math.abs(panNorm - 0.5) * 100}%`,
                    height: '100%',
                    background: 'color-mix(in srgb, var(--color-status-info) 35%, transparent)',
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
                    {panLabel}
                </span>
            </div>
        </div>
    );
};
