import { useCallback, useRef, useState } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { vuNorm } from '@/shared/lib/audioMath';
import { dbToFader, dbToGain, faderToDb, formatDb, gainToDb } from '@/widgets/TrackInspector/model/faderMath';
import { METER_WIDTH, STRIP_WIDTH } from './MixerPanel.constants';

export function MasterStrip() {
    const masterVolume = useEngineStore((s) => s.masterVolume);
    const setMasterVolume = useEngineStore((s) => s.setMasterVolume);
    const meters = useEngineStore((s) => s.meters);
    const faderRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const activePointerId = useRef<number | null>(null);

    const vol = masterVolume ?? 1;
    const volumeDb = gainToDb(vol);
    const volNorm = Math.max(0, Math.min(1, dbToFader(volumeDb)));
    const peakL = meters.master_left?.peak ?? -60;
    const peakR = meters.master_right?.peak ?? -60;
    const rmsL = meters.master_left?.rms ?? -60;
    const rmsR = meters.master_right?.rms ?? -60;
    const meterL = Math.max(0, Math.min(1, vuNorm((peakL * 0.7) + (rmsL * 0.3))));
    const meterR = Math.max(0, Math.min(1, vuNorm((peakR * 0.7) + (rmsR * 0.3))));

    const applyVolume = useCallback((clientY: number) => {
        const el = faderRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const pos = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
        setMasterVolume(dbToGain(faderToDb(pos)));
    }, [setMasterVolume]);

    const endDrag = useCallback(() => {
        setIsDragging(false);
        activePointerId.current = null;
        void useEngineStore.getState().flushTrackControlFinals();
    }, []);

    // Master strip is slightly wider
    const masterWidth = STRIP_WIDTH + 14;
    const trackColor = 'var(--text-primary)';

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', width: masterWidth, minWidth: masterWidth, maxWidth: masterWidth, height: '100%',
            background: 'color-mix(in srgb, var(--surface-1) 80%, black)',
            borderLeft: '1px solid var(--color-divider)', overflow: 'hidden', position: 'relative'
        }}>
            {/* 1. Ableton Title Bar */}
            <div
                style={{
                    height: 20,
                    padding: '2px 4px',
                    fontSize: 10,
                    fontFamily: 'var(--font-role-body)',
                    fontWeight: 600,
                    color: 'var(--color-bg-panel)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    textAlign: 'center',
                    flexShrink: 0,
                    background: trackColor,
                    borderBottom: '1px solid color-mix(in srgb, var(--color-divider) 50%, transparent)',
                }}
            >
                Master
            </div>

            {/* 2. Empty Session Slots Area */}
            <div style={{ flex: 1, minHeight: 40, borderBottom: '1px solid var(--color-divider)' }} />

            {/* 3. I/O Routing Section */}
            <div style={{ padding: '4px 3px', flexShrink: 0, borderBottom: '1px solid var(--color-divider)', background: 'color-mix(in srgb, var(--surface-2) 40%, transparent)' }}>
                <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    fontSize: 8.5, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-primary)',
                    background: 'var(--surface-elevated)', borderRadius: 2, padding: '2px 4px', marginBottom: 2,
                    border: '1px solid color-mix(in srgb, var(--text-primary) 12%, transparent)', cursor: 'pointer',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 1px 1px rgba(0,0,0,0.1)'
                }}>
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>All Ins</span>
                    <span style={{ fontSize: 7, color: 'var(--color-text-tertiary)' }}>▼</span>
                </div>
                <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    fontSize: 8.5, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-primary)',
                    background: 'var(--surface-elevated)', borderRadius: 2, padding: '2px 4px',
                    border: '1px solid color-mix(in srgb, var(--text-primary) 12%, transparent)', cursor: 'pointer',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 1px 1px rgba(0,0,0,0.1)'
                }}>
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Ext. Out</span>
                    <span style={{ fontSize: 7, color: 'var(--color-text-tertiary)' }}>▼</span>
                </div>
            </div>

            {/* 4. Mixer Section (Empty for Master except for alignment) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 4px 4px', height: 44, flexShrink: 0, background: 'color-mix(in srgb, var(--surface-1) 30%, transparent)' }}>
                {/* Empty space matching Pan & Buttons */}
            </div>

            {/* 5. Volume Fader & Meters */}
            <div style={{ display: 'flex', flexDirection: 'row', padding: '0px 4px 4px', gap: 4, height: 160, flexShrink: 0, justifyContent: 'center' }}>
                <div
                    ref={faderRef}
                    onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId); activePointerId.current = e.pointerId; setIsDragging(true); applyVolume(e.clientY); }}
                    onPointerMove={(e) => { if (!isDragging) return; if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return; applyVolume(e.clientY); }}
                    onPointerUp={(e) => { if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return; (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); endDrag(); }}
                    onPointerCancel={endDrag}
                    onDoubleClick={(e) => { e.stopPropagation(); setMasterVolume(1.0); void useEngineStore.getState().flushTrackControlFinals(); }}
                    onWheel={(e) => { e.stopPropagation(); const step = e.shiftKey ? 0.006 : 0.018; const next = Math.max(0, Math.min(2, vol + (e.deltaY < 0 ? step : -step))); setMasterVolume(next); void useEngineStore.getState().flushTrackControlFinals(); }}
                    style={{ flex: 1, position: 'relative', cursor: 'ns-resize', touchAction: 'none' }}
                >
                    {/* Fader Groove */}
                    <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: 0, bottom: 0, width: 6, background: 'color-mix(in srgb, var(--surface-2) 60%, black)', border: '1px solid color-mix(in srgb, var(--color-divider) 80%, black)', borderRadius: 3, boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.5)' }} />

                    {/* Fader Handle */}
                    <div style={{
                        position: 'absolute', left: 0, right: 0, bottom: `calc(${volNorm * 100}% - 5px)`, height: 10,
                        background: trackColor, borderRadius: 2, border: '1px solid rgba(0,0,0,0.7)',
                        boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.4), 0 2px 4px rgba(0,0,0,0.5)', pointerEvents: 'none',
                        display: 'flex', alignItems: 'center', justifyContent: 'center'
                    }}>
                        {/* Thumb indicator line */}
                        <div style={{ width: '80%', height: 2, background: 'rgba(255,255,255,0.7)', borderRadius: 1 }} />
                    </div>
                </div>

                {/* Master Stereo Meters (thicker than normal track meters) */}
                <div style={{ display: 'flex', flexDirection: 'row', gap: 1 }}>
                    <div style={{ width: METER_WIDTH + 3, position: 'relative', borderRadius: 2, overflow: 'hidden', background: 'var(--surface-elevated)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                        <MeterStrip levelL={meterL} levelR={meterL} isMidi={false} width={METER_WIDTH + 3} show0dBLine style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
                    </div>
                    <div style={{ width: METER_WIDTH + 3, position: 'relative', borderRadius: 2, overflow: 'hidden', background: 'var(--surface-elevated)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                        <MeterStrip levelL={meterR} levelR={meterR} isMidi={false} width={METER_WIDTH + 3} show0dBLine style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
                    </div>
                </div>
            </div>

            {/* 6. dB and Peak Labels */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 0 6px', flexShrink: 0 }}>
                <div style={{ fontSize: 9, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-primary)' }}>
                    {formatDb(volumeDb)}
                </div>
                <div style={{ display: 'flex', gap: 2, justifyContent: 'center', fontSize: 8, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-tertiary)', padding: '1px 0 2px', flexShrink: 0 }}>
                    <div style={{ width: 22, background: 'var(--surface-elevated)', borderRadius: 1, padding: '1px 0', textAlign: 'center', border: '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>
                        {Number.isFinite(peakL) && peakL > -90 ? formatDb(peakL) : '-∞'}
                    </div>
                    <div style={{ width: 22, background: 'var(--surface-elevated)', borderRadius: 1, padding: '1px 0', textAlign: 'center', border: '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>
                        {Number.isFinite(peakR) && peakR > -90 ? formatDb(peakR) : '-∞'}
                    </div>
                </div>
            </div>
        </div>
    );
}
