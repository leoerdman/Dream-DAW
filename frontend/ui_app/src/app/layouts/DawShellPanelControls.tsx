import { useCallback, useRef, useState } from 'react';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { dbToFader, dbToGain, faderToDb, formatDb, gainToDb } from '@/widgets/TrackInspector/model/faderMath';
import { useEngineStore } from '@/shared/stores/useEngineStore';

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const FADER_SCALE_MARKS_DB = [6, 0, -12, -24, -48];

export function SessionIoRow({ label, value }: { label: string; value: string }) {
    return (
        <label style={{ display: 'grid', gap: 2 }}>
            <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)' }}>{label}</span>
            <select
                value={value}
                onChange={() => { /* routing apply follows dedicated inspector pipeline */ }}
                style={{
                    width: '100%',
                    height: 20,
                    borderRadius: 'var(--radius-sm)',
                    border: 'var(--space-px) solid var(--color-overlay-medium)',
                    background: 'var(--color-bg-header)',
                    color: 'var(--color-text-primary)',
                    fontSize: 'var(--font-size-2xs)',
                    padding: '0 var(--space-1)',
                }}
            >
                <option value={value}>{value}</option>
            </select>
        </label>
    );
}

export function SessionStripFader({
    gain,
    pan,
    meterL,
    meterR,
    onGainChange,
    onPanChange,
    panDisabled = false,
}: {
    gain: number;
    pan: number;
    meterL: number;
    meterR: number;
    onGainChange: (gain: number) => void;
    onPanChange: (pan: number) => void;
    panDisabled?: boolean;
}) {
    const faderRef = useRef<HTMLDivElement | null>(null);
    const activePointerId = useRef<number | null>(null);
    const [dragging, setDragging] = useState(false);
    const volumeDb = gainToDb(gain);
    const volNorm = clamp01(dbToFader(volumeDb));

    const applyFromClientY = useCallback((clientY: number) => {
        const el = faderRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const pos = clamp01(1 - (clientY - rect.top) / rect.height);
        onGainChange(dbToGain(faderToDb(pos)));
    }, [onGainChange]);

    const endDrag = useCallback(() => {
        setDragging(false);
        activePointerId.current = null;
        void useEngineStore.getState().flushTrackControlFinals();
    }, []);

    return (
        <div style={{ flex: 1, height: '100%', display: 'grid', gridTemplateRows: '1fr auto auto', gap: 4 }}>
            <div style={{
                minHeight: 92,
                borderRadius: 'var(--radius-xs)',
                border: 'var(--space-px) solid var(--token-color-hex-3d3d3d)',
                background: 'var(--color-bg-canvas)',
                position: 'relative',
                overflow: 'hidden',
                display: 'grid',
                gridTemplateColumns: '10px 1fr',
                gap: 4,
                padding: 4,
            }}>
                <MeterStrip
                    levelL={meterL}
                    levelR={meterR}
                    width={8}
                    style={{ alignSelf: 'stretch' }}
                />
                <div
                    ref={faderRef}
                    onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                        activePointerId.current = e.pointerId;
                        setDragging(true);
                        applyFromClientY(e.clientY);
                    }}
                    onPointerMove={(e) => {
                        if (!dragging) return;
                        if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
                        applyFromClientY(e.clientY);
                    }}
                    onPointerUp={(e) => {
                        if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
                        if ((e.currentTarget as HTMLDivElement).hasPointerCapture(e.pointerId)) {
                            (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
                        }
                        endDrag();
                    }}
                    onPointerCancel={endDrag}
                    onDoubleClick={() => onGainChange(1)}
                    onWheel={(e) => {
                        e.preventDefault();
                        const step = e.shiftKey ? 0.006 : 0.02;
                        const next = Math.max(0, Math.min(2, gain + (e.deltaY < 0 ? step : -step)));
                        onGainChange(next);
                        void useEngineStore.getState().flushTrackControlFinals();
                    }}
                    style={{
                        width: '100%',
                        height: '100%',
                        borderRadius: 'var(--radius-xs)',
                        border: 'var(--space-px) solid color-mix(in srgb, var(--color-timeline-grid-line) 70%, transparent)',
                        background: 'color-mix(in srgb, var(--color-bg-header) 76%, var(--color-bg-elevated))',
                        position: 'relative',
                        cursor: 'ns-resize',
                        touchAction: 'none',
                    }}
                >
                    <div style={{ position: 'absolute', left: 1, right: 1, bottom: `calc(${clamp01(dbToFader(0)) * 100}% + 1px)`, height: 0.5, background: 'color-mix(in srgb, var(--color-status-warning) 72%, transparent)' }} />
                    {FADER_SCALE_MARKS_DB.map((mark) => (
                        <div
                            key={`fader-mark-${mark}`}
                            style={{
                                position: 'absolute',
                                left: 1,
                                right: 1,
                                bottom: `${clamp01(dbToFader(mark)) * 100}%`,
                                height: 0.5,
                                background: mark === 0
                                    ? 'color-mix(in srgb, var(--color-status-warning) 75%, transparent)'
                                    : 'color-mix(in srgb, var(--color-text-secondary) 24%, transparent)',
                            }}
                        />
                    ))}
                    <div style={{ position: 'absolute', left: 2, right: 2, bottom: 2, height: `calc(${volNorm * 100}% - 4px)`, minHeight: volNorm > 0 ? 2 : 0, borderRadius: 'var(--radius-xs)', background: 'linear-gradient(to top, color-mix(in srgb, var(--color-accent-primary) 65%, #2da163), color-mix(in srgb, var(--color-accent-primary) 35%, #b2e36d))', opacity: 0.88, transition: dragging ? 'none' : 'height 70ms linear' }} />
                    <div style={{ position: 'absolute', left: 1, right: 1, bottom: `calc(${volNorm * 100}% - 2px)`, height: 4, borderRadius: 'var(--radius-xs)', background: 'var(--color-text-bright)', boxShadow: '0 0 3px color-mix(in srgb, var(--color-text-bright) 45%, transparent)', transition: dragging ? 'none' : 'bottom 70ms linear' }} />
                </div>
            </div>
            <input
                type="range"
                min={-1}
                max={1}
                step={0.01}
                value={pan}
                onChange={(e) => onPanChange(Number(e.target.value))}
                disabled={panDisabled}
                style={{ width: '100%', accentColor: 'var(--color-accent-primary)', opacity: panDisabled ? 0.35 : 1 }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-role-data)' }}>
                <span>{formatDb(volumeDb)}</span>
                <span>Pan {Math.round(pan * 50)}</span>
            </div>
        </div>
    );
}
