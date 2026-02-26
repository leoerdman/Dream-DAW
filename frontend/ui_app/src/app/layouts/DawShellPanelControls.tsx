import { memo, useCallback, useRef, useState } from 'react';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { dbToFader, dbToGain, faderToDb, formatDb, gainToDb } from '@/widgets/TrackInspector/model/faderMath';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { getContrastColor } from '@/shared/lib/colorUtils';

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const FADER_SCALE_VALS = [12, 6, 0, -6, -12, -24, -36, -48, -60];
const FADER_SCALE_NODES = FADER_SCALE_VALS.map(val => (
    <div key={val} style={{ position: 'absolute', bottom: `${clamp01(dbToFader(val)) * 100}%`, right: 2, transform: 'translateY(50%)' }}>
        {Math.abs(val)}
    </div>
));

const LABEL_STYLE: React.CSSProperties = { fontSize: '9px', fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', marginBottom: 2 };

const SELECT_STYLE: React.CSSProperties = {
    width: '100%',
    height: 18,
    borderRadius: 'var(--radius-xs)',
    border: '1px solid var(--color-divider-light)',
    background: 'var(--surface-elevated)',
    color: 'var(--color-text-secondary)',
    fontSize: '10px',
    fontFamily: 'var(--font-role-body)',
    padding: '0 4px',
    cursor: 'pointer',
    outline: 'none',
    boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.15)',
};

export function SessionIoRow({ label, value }: { label: string; value: string }) {
    return (
        <label style={{ display: 'grid', gap: 0, marginBottom: 4 }}>
            <span style={LABEL_STYLE}>{label}</span>
            <select
                value={value}
                onChange={() => { /* routing apply follows dedicated inspector pipeline */ }}
                style={SELECT_STYLE}
            >
                <option value={value}>{value}</option>
            </select>
        </label>
    );
}

export function SessionMonitorRow({ value, onChange }: { value: 'In' | 'Auto' | 'Off'; onChange?: (v: 'In' | 'Auto' | 'Off') => void }) {
    return (
        <div style={{ display: 'grid', gap: 0, marginBottom: 4 }}>
            <span style={LABEL_STYLE}>Monitor</span>
            <div style={{ display: 'flex', height: 18, borderRadius: 'var(--radius-xs)', overflow: 'hidden', border: '1px solid var(--color-divider-light)', background: 'var(--surface-elevated)' }}>
                {(['In', 'Auto', 'Off'] as const).map(mode => {
                    const isActive = value === mode;
                    return (
                        <button
                            key={mode}
                            type="button"
                            onClick={() => onChange?.(mode)}
                            style={{
                                flex: 1,
                                height: '100%',
                                border: 'none',
                                background: isActive ? 'var(--color-status-warning)' : 'transparent',
                                color: isActive ? '#000' : 'var(--color-text-secondary)',
                                fontSize: '10px',
                                fontFamily: 'var(--font-role-body)',
                                fontWeight: isActive ? 700 : 500,
                                cursor: 'pointer',
                                transition: 'background 100ms ease, color 100ms ease',
                            }}
                        >
                            {mode}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function SessionStripFaderInner({
    gain,
    pan,
    meterL,
    meterR,
    onGainChange,
    onPanChange,
    panDisabled = false,
    trackIndex,
    trackDisabled,
    trackSolo,
    trackArmed,
    setTrackDisabled,
    setTrackSolo,
    setTrackArmed,
    trackColor,
}: {
    gain: number;
    pan: number;
    meterL: number;
    meterR: number;
    onGainChange: (gain: number) => void;
    onPanChange: (pan: number) => void;
    panDisabled?: boolean;
    trackIndex: number;
    trackDisabled?: boolean;
    trackSolo?: boolean;
    trackArmed?: boolean;
    setTrackDisabled?: (disabled: boolean) => void;
    setTrackSolo?: (solo: boolean) => void;
    setTrackArmed?: (armed: boolean) => void;
    trackColor?: string;
}) {
    const faderRef = useRef<HTMLDivElement | null>(null);
    const panRef = useRef<HTMLDivElement | null>(null);
    const activePointerId = useRef<number | null>(null);
    const activePanPointer = useRef<number | null>(null);
    const [dragging, setDragging] = useState(false);

    const volumeDb = gainToDb(gain);
    const volNorm = clamp01(dbToFader(volumeDb));

    const panDragRef = useRef<{ startY: number; startPan: number } | null>(null);

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

    const applyPanFromClientY = useCallback((clientY: number, startY: number, startPan: number) => {
        const deltaY = startY - clientY;
        const deltaPan = deltaY / 50;
        onPanChange(Math.max(-1, Math.min(1, startPan + deltaPan)));
    }, [onPanChange]);

    const handlePanPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (panDisabled) return;
        e.preventDefault();
        e.stopPropagation();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        activePanPointer.current = e.pointerId;
        panDragRef.current = { startY: e.clientY, startPan: pan };
    }, [panDisabled, pan]);

    const handlePanPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (activePanPointer.current !== e.pointerId) return;
        if (!panDragRef.current) return;
        applyPanFromClientY(e.clientY, panDragRef.current.startY, panDragRef.current.startPan);
    }, [applyPanFromClientY]);

    const handlePanPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (activePanPointer.current !== e.pointerId) return;
        const el = e.currentTarget;
        if (el.hasPointerCapture(e.pointerId)) {
            el.releasePointerCapture(e.pointerId);
        }
        activePanPointer.current = null;
        panDragRef.current = null;
        void useEngineStore.getState().flushTrackControlFinals();
    }, []);

    // Calculate Pan visually: -1 to 1 maps to -135deg to +135deg (for arc)
    const panAngle = pan * 135;

    // Meter max peak (for numeric display)
    const maxDbLabel = Math.max(faderToDb(meterL), faderToDb(meterR));
    const peakText = isFinite(maxDbLabel) && maxDbLabel > -60 ? `${maxDbLabel > 0 ? '+' : ''}${maxDbLabel.toFixed(1)}` : '-inf';
    const hasClipped = maxDbLabel >= 0;

    const actualTrackColor = trackColor || 'var(--color-status-warning)';

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, height: '100%', alignItems: 'center', fontFamily: 'var(--font-role-data)' }}>

            {/* NUMERIC VOLUME TEXT BOXES (TOP OF FADER IN ABLETON) */}
            <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', gap: 4 }}>
                <div style={{ background: 'var(--surface-elevated)', border: `1px solid var(--color-divider-light)`, borderRadius: 'var(--radius-xs)', color: 'var(--color-text-secondary)', fontSize: '10px', textAlign: 'center', flex: 1, padding: '2px 0', userSelect: 'none' }}>
                    {formatDb(volumeDb)}
                </div>
                <div style={{ background: hasClipped ? 'var(--color-status-error)' : 'var(--surface-elevated)', border: `1px solid var(--color-divider-light)`, borderRadius: 'var(--radius-xs)', color: hasClipped ? '#fff' : 'var(--color-status-success)', fontSize: '10px', textAlign: 'center', flex: 1, padding: '2px 0', userSelect: 'none', transition: 'background 0.2s, color 0.2s' }}>
                    {peakText}
                </div>
            </div>

            {/* FADER AND METER SECTION */}
            <div style={{ display: 'flex', flex: 1, width: '100%', gap: 4, position: 'relative' }}>

                {/* FADER SCALE LABELS */}
                <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', fontSize: '9px', color: 'var(--color-text-tertiary)', paddingTop: 1, paddingBottom: 1, position: 'relative', width: 14 }}>
                    {FADER_SCALE_NODES}
                </div>

                {/* 0dB Marker Line */}
                <div style={{ position: 'absolute', left: 20, right: 0, bottom: `${clamp01(dbToFader(0)) * 100}%`, height: 1, background: 'color-mix(in srgb, var(--color-text-secondary) 30%, transparent)', pointerEvents: 'none', zIndex: 0 }} />

                {/* STEREO METER */}
                <div style={{ position: 'relative', flex: 1, maxWidth: 14, borderRadius: 'var(--radius-xs)', overflow: 'hidden', background: 'var(--surface-elevated)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                    <MeterStrip
                        levelL={meterL}
                        levelR={meterR}
                        width={14}
                        show0dBLine={false}
                        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
                    />
                </div>

                {/* FADER TRACK */}
                <div style={{
                    flex: 1,
                    maxWidth: 16,
                    position: 'relative',
                }}>
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
                        onWheel={(e) => { e.stopPropagation(); const step = e.shiftKey ? 0.006 : 0.018; onGainChange(Math.max(0, Math.min(2, gain + (e.deltaY < 0 ? step : -step)))); void useEngineStore.getState().flushTrackControlFinals(); }}
                        style={{
                            position: 'absolute', inset: 0, cursor: 'ns-resize', touchAction: 'none'
                        }}
                    >
                        {/* The Rail */}
                        <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: 0, bottom: 0, width: 2, background: 'var(--color-divider)', borderRadius: 1 }} />

                        {/* Thumb (Premium Glassy Handle) */}
                        <div style={{
                            position: 'absolute', left: 0, right: 0, bottom: `calc(${volNorm * 100}% - 7px)`,
                            height: 14,
                            borderRadius: 'var(--radius-xs)',
                            background: dragging ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)',
                            border: '1px solid var(--surface-1)',
                            boxShadow: '0 2px 4px rgba(0,0,0,0.3), inset 0 1px 1px rgba(255,255,255,0.2)',
                            pointerEvents: 'none',
                            transition: 'background 0.1s',
                            display: 'flex', alignItems: 'center', justifyContent: 'center'
                        }}>
                            <div style={{ width: '80%', height: 2, background: 'var(--surface-elevated)', borderRadius: 1 }} />
                        </div>
                    </div>
                </div>
            </div>

            {/* PAN KNOB */}
            <div style={{ width: '100%', marginBottom: 4 }}>
                <div style={{ background: 'var(--surface-elevated)', border: `1px solid var(--color-divider-light)`, borderRadius: 'var(--radius-xs)', color: 'var(--color-text-secondary)', fontSize: '10px', textAlign: 'center', padding: '4px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: panDisabled ? 0.4 : 1, userSelect: 'none' }}>
                    <div
                        ref={panRef}
                        onPointerDown={handlePanPointerDown}
                        onPointerMove={handlePanPointerMove}
                        onPointerUp={handlePanPointerUp}
                        onPointerCancel={handlePanPointerUp}
                        onDoubleClick={() => !panDisabled && onPanChange(0)}
                        style={{
                            width: 18, height: 18,
                            borderRadius: '50%',
                            background: 'var(--surface-elevated)',
                            border: '1px solid color-mix(in srgb, var(--color-text-secondary) 20%, transparent)',
                            boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.2), 0 1px 2px rgba(0,0,0,0.4)',
                            position: 'relative',
                            cursor: panDisabled ? 'default' : 'ns-resize',
                            marginRight: 6,
                            transform: `rotate(${panAngle}deg)`
                        }}
                    >
                        <div style={{ position: 'absolute', top: 2, left: 8, width: 2, height: 6, background: actualTrackColor, borderRadius: 1 }} />
                    </div>
                    <span>{Math.abs(pan) < 0.01 ? 'C' : `${Math.round(Math.abs(pan * 50))}${pan < 0 ? 'L' : 'R'}`}</span>
                </div>
            </div>

            {/* ABLETON ACTIVATORS */}
            {setTrackDisabled && setTrackSolo && setTrackArmed && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 4, width: '100%', marginTop: 2 }}>

                    {/* MUTE / ACTIVATOR BUTTON */}
                    <button
                        type="button"
                        onClick={() => setTrackDisabled(!trackDisabled)}
                        style={{
                            height: 20,
                            background: !trackDisabled ? actualTrackColor : 'var(--surface-elevated)',
                            color: !trackDisabled ? (getContrastColor(actualTrackColor) === 'black' ? '#000' : '#fff') : 'var(--color-text-tertiary)',
                            border: `1px solid var(--color-divider-light)`,
                            borderRadius: 'var(--radius-xs)',
                            fontSize: '10px',
                            fontWeight: 800,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer',
                            transition: 'background 0.1s, color 0.1s',
                        }}
                    >
                        {trackIndex + 1}
                    </button>

                    {/* SOLO & ARM */}
                    <div style={{ display: 'flex', gap: 4, height: 20 }}>
                        <button
                            type="button"
                            onClick={() => setTrackSolo(!trackSolo)}
                            style={{
                                flex: 1,
                                background: trackSolo ? 'var(--color-status-info)' : 'var(--surface-elevated)',
                                color: trackSolo ? '#fff' : 'var(--color-text-tertiary)',
                                border: '1px solid var(--color-divider-light)',
                                borderRadius: 'var(--radius-xs)',
                                fontSize: '10px',
                                fontWeight: 800,
                                cursor: 'pointer',
                                transition: 'background 0.1s, color 0.1s',
                            }}
                        >
                            S
                        </button>
                        <button
                            type="button"
                            onClick={() => setTrackArmed(!trackArmed)}
                            style={{
                                flex: 1,
                                background: trackArmed ? 'var(--color-status-error)' : 'var(--surface-elevated)',
                                color: trackArmed ? '#fff' : 'var(--color-text-tertiary)',
                                border: '1px solid var(--color-divider-light)',
                                borderRadius: 'var(--radius-xs)',
                                fontSize: '10px',
                                fontWeight: 800,
                                cursor: 'pointer',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                transition: 'background 0.1s',
                            }}
                        >
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: trackArmed ? '#fff' : 'var(--color-text-tertiary)' }} />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

export const SessionStripFader = memo(SessionStripFaderInner, (prev, next) => {
    return prev.gain === next.gain &&
        prev.pan === next.pan &&
        prev.meterL === next.meterL &&
        prev.meterR === next.meterR &&
        prev.trackDisabled === next.trackDisabled &&
        prev.trackSolo === next.trackSolo &&
        prev.trackArmed === next.trackArmed &&
        prev.panDisabled === next.panDisabled &&
        prev.trackIndex === next.trackIndex &&
        prev.trackColor === next.trackColor;
});
