import { memo, useCallback, useRef, useState } from 'react';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { dbToFader, dbToGain, faderToDb, formatDb, gainToDb } from '@/widgets/TrackInspector/model/faderMath';
import { useEngineStore } from '@/shared/stores/useEngineStore';

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const FADER_SCALE_VALS = [12, 6, 0, -6, -12, -24, -36, -48, -60];
const FADER_SCALE_NODES = FADER_SCALE_VALS.map(val => (
    <div key={val} style={{ position: 'absolute', bottom: `${clamp01(dbToFader(val)) * 100}%`, right: 2, transform: 'translateY(50%)' }}>
        {Math.abs(val)}
    </div>
));

const LABEL_STYLE: React.CSSProperties = { fontSize: '9px', fontWeight: 600, color: '#979797', textTransform: 'uppercase', marginBottom: 2 };
const SELECT_STYLE: React.CSSProperties = {
    width: '100%',
    height: 16,
    borderRadius: 2,
    border: 'none',
    background: '#1c1c1c',
    color: '#d0d0d0',
    fontSize: '9px',
    padding: '0 4px',
    cursor: 'pointer',
    outline: 'none',
    boxShadow: 'inset 0 1px 1px rgba(0,0,0,0.5)',
};

export function SessionIoRow({ label, value }: { label: string; value: string }) {
    return (
        <label style={{ display: 'grid', gap: 0, marginBottom: 2 }}>
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
        <div style={{ display: 'grid', gap: 0, marginBottom: 2 }}>
            <span style={LABEL_STYLE}>Monitor</span>
            <div style={{ display: 'flex', height: 16, borderRadius: 2, overflow: 'hidden', boxShadow: 'inset 0 1px 1px rgba(0,0,0,0.5)', background: '#1c1c1c' }}>
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
                                background: isActive ? '#e08031' : 'transparent',
                                color: isActive ? '#000' : '#8c8c8c',
                                fontSize: '9px',
                                fontWeight: isActive ? 700 : 600,
                                cursor: 'pointer',
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

const BORDER_COLOR = 'var(--token-color-hex-3d3d3d)';

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

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, height: '100%', alignItems: 'center' }}>

            {/* NUMERIC VOLUME TEXT BOXES (TOP OF FADER IN ABLETON) */}
            <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', gap: 2 }}>
                <div style={{ background: '#1c1c1c', border: `1px solid ${BORDER_COLOR}`, color: 'var(--color-text-primary)', fontSize: '9px', fontWeight: 600, textAlign: 'center', flex: 1, padding: '1px 0' }}>
                    {formatDb(volumeDb)}
                </div>
                <div style={{ background: '#1c1c1c', border: `1px solid ${BORDER_COLOR}`, color: 'var(--color-status-success)', fontSize: '9px', textAlign: 'center', flex: 1, padding: '1px 0' }}>
                    {peakText}
                </div>
            </div>

            {/* FADER AND METER SECTION */}
            <div style={{ display: 'flex', flex: 1, width: '100%', gap: 2 }}>

                {/* FADER SCALE LABELS */}
                <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', fontSize: '9px', color: '#666', paddingTop: 1, paddingBottom: 1, position: 'relative', width: 14 }}>
                    {FADER_SCALE_NODES}
                </div>

                {/* STEREO METER */}
                <MeterStrip
                    levelL={meterL}
                    levelR={meterR}
                    width={10}
                    style={{ alignSelf: 'stretch', background: '#111', border: `1px solid #1c1c1c`, borderRadius: 1 }}
                />

                {/* FADER TRACK */}
                <div style={{
                    width: 7,
                    position: 'relative',
                    marginLeft: 1,
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
                        style={{
                            position: 'absolute', inset: 0, cursor: 'ns-resize', touchAction: 'none'
                        }}
                    >
                        {/* 0dB Marker Line */}
                        <div style={{ position: 'absolute', left: -10, right: 0, bottom: `${clamp01(dbToFader(0)) * 100}%`, height: 1, background: 'rgba(255,255,255,0.3)', pointerEvents: 'none' }} />

                        {/* Thumb (Ableton Triangle) */}
                        <div style={{
                            position: 'absolute', left: 0, bottom: `calc(${volNorm * 100}% - 4px)`,
                            width: 0,
                            height: 0,
                            borderTop: '4px solid transparent',
                            borderBottom: '4px solid transparent',
                            borderRight: '6px solid #b0b0b0',
                            pointerEvents: 'none',
                        }} />
                    </div>
                </div>
            </div>

            {/* PAN BOX (ABLETON 11 STYLE) */}
            <div style={{ width: '100%', marginBottom: 2 }}>
                <div style={{ background: '#1c1c1c', border: `1px solid ${BORDER_COLOR}`, color: 'var(--color-text-primary)', fontSize: '9px', fontWeight: 600, textAlign: 'center', padding: '1px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: panDisabled ? 0.4 : 1 }}>
                    <div
                        ref={panRef}
                        onPointerDown={handlePanPointerDown}
                        onPointerMove={handlePanPointerMove}
                        onPointerUp={handlePanPointerUp}
                        onPointerCancel={handlePanPointerUp}
                        onDoubleClick={() => !panDisabled && onPanChange(0)}
                        style={{
                            width: 16, height: 16,
                            borderRadius: '50%',
                            background: '#2c2c2c',
                            border: '1px solid #111',
                            position: 'relative',
                            cursor: panDisabled ? 'default' : 'ns-resize',
                            marginRight: 4,
                            transform: `rotate(${panAngle}deg)`
                        }}
                    >
                        <div style={{ position: 'absolute', top: 1, left: 7, width: 1, height: 6, background: '#eac92b', borderRadius: 1 }} />
                    </div>
                    <span>{Math.abs(pan) < 0.01 ? 'C' : `${Math.round(Math.abs(pan * 50))}${pan < 0 ? 'L' : 'R'}`}</span>
                </div>
            </div>

            {/* ABLETON ACTIVATORS */}
            {setTrackDisabled && setTrackSolo && setTrackArmed && (
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 2, width: '100%', marginTop: 2 }}>
                    <button
                        type="button"
                        onClick={() => setTrackDisabled(!trackDisabled)}
                        style={{
                            height: 16,
                            background: !trackDisabled ? '#eac92b' : '#3d3d3d',
                            color: !trackDisabled ? '#000' : '#8c8c8c',
                            border: `none`,
                            borderRadius: '1px',
                            fontSize: '9px',
                            fontWeight: 800,
                            display: 'flex', alignItems: 'center', justifyContent: 'center'
                        }}
                    >
                        {trackIndex + 1}
                    </button>
                    <div style={{ display: 'flex', gap: 2, height: 18 }}>
                        <button
                            type="button"
                            onClick={() => setTrackSolo(!trackSolo)}
                            style={{
                                flex: 1,
                                height: 16,
                                background: trackSolo ? '#358aff' : '#3d3d3d',
                                color: trackSolo ? '#000' : '#8c8c8c',
                                border: 'none',
                                borderRadius: '1px',
                                fontSize: '9px',
                                fontWeight: 800,
                                cursor: 'pointer',
                            }}
                        >
                            S
                        </button>
                        <button
                            type="button"
                            onClick={() => setTrackArmed(!trackArmed)}
                            style={{
                                flex: 1,
                                height: 16,
                                background: trackArmed ? '#df3f3f' : '#3d3d3d',
                                color: trackArmed ? '#000' : '#8c8c8c',
                                border: 'none',
                                borderRadius: '1px',
                                fontSize: '9px',
                                fontWeight: 800,
                                cursor: 'pointer',
                                display: 'flex', alignItems: 'center', justifyContent: 'center'
                            }}
                        >
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: trackArmed ? '#000' : '#8c8c8c' }} />
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
        prev.trackIndex === next.trackIndex;
});
