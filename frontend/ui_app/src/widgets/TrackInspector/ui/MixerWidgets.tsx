import { useCallback, useEffect, useRef, useState } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { vuNorm } from '@/shared/lib/audioMath';
import { dbToFader, dbToGain, faderToDb, formatDb, gainToDb } from '@/widgets/TrackInspector/model/faderMath';
export { TriColorVU, type TriColorVUProps } from './TriColorVU';

export type VerticalMixerStripProps = {
    volumeLinear: number;
    pan: number;
    peakDb: number;
    peakDbL?: number;
    peakDbR?: number;
    isMidi: boolean;
    onVolumeChange: (gain: number) => void;
    onPanChange: (pan: number) => void;
};

export const VerticalMixerStrip = ({
    volumeLinear,
    pan,
    peakDb,
    peakDbL,
    peakDbR,
    isMidi,
    onVolumeChange,
    onPanChange,
}: VerticalMixerStripProps) => {
    const stripRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const activePointerId = useRef<number | null>(null);

    const volNorm = Math.max(0, Math.min(1, dbToFader(gainToDb(volumeLinear))));
    const meterNormL = Math.max(0, Math.min(1, vuNorm(peakDbL ?? peakDb)));
    const meterNormR = Math.max(0, Math.min(1, vuNorm(peakDbR ?? peakDb)));
    const panNorm = Math.max(0, Math.min(1, (pan + 1) / 2));
    const [peakHoldNorm, setPeakHoldNorm] = useState(0);
    const [clipLatched, setClipLatched] = useState(false);
    const holdTimerRef = useRef<number | null>(null);

    useEffect(() => {
        let rafId: number | null = null;
        let clipLatchTimer: number | null = null;
        const meterNorm = Math.max(meterNormL, meterNormR);
        if (meterNorm > peakHoldNorm) {
            rafId = window.requestAnimationFrame(() => {
                setPeakHoldNorm(meterNorm);
            });
        }
        if (peakDb >= 0) {
            clipLatchTimer = window.setTimeout(() => setClipLatched(true), 0);
        }
        if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = window.setTimeout(() => {
            setPeakHoldNorm(meterNorm);
        }, 650);
        return () => {
            if (rafId !== null) window.cancelAnimationFrame(rafId);
            if (clipLatchTimer !== null) window.clearTimeout(clipLatchTimer);
            if (holdTimerRef.current !== null) {
                window.clearTimeout(holdTimerRef.current);
                holdTimerRef.current = null;
            }
        };
    }, [meterNormL, meterNormR, peakDb, peakHoldNorm]);

    const applyVolumeFromY = useCallback((clientY: number) => {
        const el = stripRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const pos = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
        const nextDb = faderToDb(pos);
        onVolumeChange(dbToGain(nextDb));
    }, [onVolumeChange]);

    const endDrag = useCallback(() => {
        setIsDragging(false);
        activePointerId.current = null;
        void useEngineStore.getState().flushTrackControlFinals();
    }, []);

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 86,
            flexShrink: 0,
        }}>
            <div
                ref={stripRef}
                onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                    activePointerId.current = e.pointerId;
                    setIsDragging(true);
                    applyVolumeFromY(e.clientY);
                }}
                onPointerMove={(e) => {
                    if (!isDragging) return;
                    if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
                    applyVolumeFromY(e.clientY);
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
                onClick={(e) => {
                    e.stopPropagation();
                    setClipLatched(false);
                    setPeakHoldNorm(Math.max(meterNormL, meterNormR));
                }}
                onWheel={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const step = e.shiftKey ? 0.006 : 0.018;
                    const next = Math.max(0, Math.min(2, volumeLinear + (e.deltaY < 0 ? step : -step)));
                    onVolumeChange(next);
                    void useEngineStore.getState().flushTrackControlFinals();
                }}
                title="Volume"
                style={{
                    position: 'relative',
                    width: 16,
                    height: 62,
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-elevated)',
                    border: '1px solid color-mix(in srgb, var(--text-primary) 12%, transparent)',
                    overflow: 'hidden',
                    cursor: 'ns-resize',
                    touchAction: 'none',
                }}
            >
                <MeterStrip
                    levelL={meterNormL}
                    levelR={meterNormR}
                    isMidi={isMidi}
                    width={16}
                    show0dBLine={true}
                    style={{
                        position: 'absolute',
                        inset: 0,
                        pointerEvents: 'none',
                    }}
                />
                <div style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: `${peakHoldNorm * 100}%`,
                    height: 1,
                    background: 'color-mix(in srgb, var(--color-text-bright) 95%, transparent)',
                    boxShadow: '0 0 2px color-mix(in srgb, var(--color-text-bright) 70%, transparent)',
                    pointerEvents: 'none',
                }} />
                <div style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: `${volNorm * 100}%`,
                    background: 'linear-gradient(to top, var(--color-meter-green-start) 0%, var(--color-meter-green-end) 100%)',
                    opacity: 0.9,
                    pointerEvents: 'none',
                }} />
                <div style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: `calc(${volNorm * 100}% - 1px)`,
                    height: 2,
                    background: 'color-mix(in srgb, var(--color-text-bright) 90%, transparent)',
                    boxShadow: '0 0 4px color-mix(in srgb, var(--color-text-bright) 45%, transparent)',
                    transition: isDragging ? 'none' : 'bottom 60ms linear',
                    pointerEvents: 'none',
                }} />
                {clipLatched && (
                    <div style={{
                        position: 'absolute',
                        top: 1,
                        left: '50%',
                        width: 4,
                        height: 4,
                        marginLeft: -2,
                        borderRadius: '50%',
                        background: 'var(--color-status-record)',
                        boxShadow: '0 0 4px color-mix(in srgb, var(--color-status-record) 85%, transparent)',
                        pointerEvents: 'none',
                    }} />
                )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 54 }}>
                <span style={{
                    fontSize: 'var(--font-size-micro)',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text-secondary)',
                    textAlign: 'right',
                }}>
                    {formatDb(gainToDb(volumeLinear))}
                </span>
                <div
                    onWheel={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        const step = e.shiftKey ? 0.01 : 0.03;
                        const next = Math.max(-1, Math.min(1, pan + (e.deltaY < 0 ? step : -step)));
                        onPanChange(next);
                        void useEngineStore.getState().flushTrackControlFinals();
                    }}
                    title="Pan"
                    style={{
                        position: 'relative',
                        width: 54,
                        height: 8,
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--surface-elevated)',
                        border: '1px solid color-mix(in srgb, var(--text-primary) 10%, transparent)',
                    }}
                >
                    <div style={{
                        position: 'absolute',
                        left: '50%',
                        top: 0,
                        bottom: 0,
                        width: 1,
                        background: 'var(--color-divider-light)',
                    }} />
                    <div style={{
                        position: 'absolute',
                        top: 0,
                        left: `calc(${panNorm * 100}% - 3px)`,
                        width: 6,
                        height: '100%',
                        borderRadius: 'var(--radius-xs)',
                        background: 'var(--text-primary)',
                    }} />
                    <input
                        type="range"
                        min={-1}
                        max={1}
                        step={0.01}
                        value={pan}
                        onChange={(e) => onPanChange(Number(e.target.value))}
                        onDoubleClick={(e) => {
                            e.stopPropagation();
                            onPanChange(0);
                        }}
                        style={{
                            position: 'absolute',
                            inset: 0,
                            width: '100%',
                            height: '100%',
                            opacity: 0,
                            cursor: 'ew-resize',
                        }}
                    />
                </div>
                <span style={{
                    fontSize: 'var(--font-size-micro)',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text-secondary)',
                    textAlign: 'right',
                }}>
                    {Math.abs(pan) < 0.02 ? 'C' : (pan < 0 ? `L${Math.round(Math.abs(pan) * 100)}` : `R${Math.round(Math.abs(pan) * 100)}`)}
                </span>
            </div>
        </div>
    );
};
