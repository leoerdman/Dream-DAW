import { memo, useCallback, useRef, useState } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { vuNorm } from '@/shared/lib/audioMath';
import { dbToFader, dbToGain, faderToDb, formatDb, gainToDb } from '@/widgets/TrackInspector/model/faderMath';
import { METER_WIDTH, STRIP_WIDTH } from './MixerPanel.constants';

// ── Isolated meter component: re-renders ONLY when master meter values change ──
const MasterMeterPair = memo(function MasterMeterPair({ meterWidth }: { meterWidth: number }) {
    const masterLeft = useEngineStore((s) => s.meters.master_left);
    const masterRight = useEngineStore((s) => s.meters.master_right);
    const peakL = masterLeft?.peak ?? -60;
    const peakR = masterRight?.peak ?? -60;
    const rmsL = masterLeft?.rms ?? -60;
    const rmsR = masterRight?.rms ?? -60;
    const meterL = Math.max(0, Math.min(1, vuNorm((peakL * 0.7) + (rmsL * 0.3))));
    const meterR = Math.max(0, Math.min(1, vuNorm((peakR * 0.7) + (rmsR * 0.3))));

    return (
        <div style={{ display: 'flex', flexDirection: 'row', gap: 1 }}>
            <div style={{ width: meterWidth, position: 'relative', borderRadius: 2, overflow: 'hidden', background: 'var(--surface-elevated)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                <MeterStrip levelL={meterL} levelR={meterL} isMidi={false} width={meterWidth} show0dBLine style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
            </div>
            <div style={{ width: meterWidth, position: 'relative', borderRadius: 2, overflow: 'hidden', background: 'var(--surface-elevated)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                <MeterStrip levelL={meterR} levelR={meterR} isMidi={false} width={meterWidth} show0dBLine style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
            </div>
        </div>
    );
});

// ── Isolated peak label: re-renders ONLY when master peak values change ──
const MasterPeakLabels = memo(function MasterPeakLabels() {
    const masterLeft = useEngineStore((s) => s.meters.master_left);
    const masterRight = useEngineStore((s) => s.meters.master_right);
    const peakL = masterLeft?.peak ?? -60;
    const peakR = masterRight?.peak ?? -60;

    return (
        <div style={{ display: 'flex', gap: 3, justifyContent: 'center', fontSize: 8, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-tertiary)', padding: '1px 0 0', flexShrink: 0 }}>
            <div style={{ width: 28, background: 'var(--surface-elevated)', borderRadius: 1, padding: '1px 0', textAlign: 'center', border: '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>
                {Number.isFinite(peakL) && peakL > -90 ? formatDb(peakL) : '-∞'}
            </div>
            <div style={{ width: 28, background: 'var(--surface-elevated)', borderRadius: 1, padding: '1px 0', textAlign: 'center', border: '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>
                {Number.isFinite(peakR) && peakR > -90 ? formatDb(peakR) : '-∞'}
            </div>
        </div>
    );
});

export const MasterStrip = memo(function MasterStrip() {
    const masterVolume = useEngineStore((s) => s.masterVolume);
    const setMasterVolume = useEngineStore((s) => s.setMasterVolume);
    const faderRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const activePointerId = useRef<number | null>(null);
    const wheelFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const vol = masterVolume ?? 1;
    const volumeDb = gainToDb(vol);
    const volNorm = Math.max(0, Math.min(1, dbToFader(volumeDb)));

    const masterWidth = STRIP_WIDTH;
    const masterMeterW = METER_WIDTH + 2;
    const trackColor = 'var(--text-primary)';

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

    const debouncedFlush = useCallback(() => {
        if (wheelFlushTimer.current) clearTimeout(wheelFlushTimer.current);
        wheelFlushTimer.current = setTimeout(() => {
            void useEngineStore.getState().flushTrackControlFinals();
            wheelFlushTimer.current = null;
        }, 150);
    }, []);

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', width: masterWidth, minWidth: masterWidth, maxWidth: masterWidth, height: '100%',
            background: 'color-mix(in srgb, var(--surface-1) 80%, black)',
            borderLeft: '2px solid var(--color-divider)', overflow: 'hidden', position: 'relative'
        }}>
            {/* ── Master Label ── */}
            <div style={{
                height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-role-data)',
                color: 'var(--color-text-secondary)', flexShrink: 0,
                borderBottom: '1px solid var(--color-divider)',
                background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)',
                letterSpacing: '0.05em', textTransform: 'uppercase',
            }}>
                Master
            </div>

            {/* ── Volume Fader & Meters (fills remaining height) ── */}
            <div style={{ display: 'flex', flexDirection: 'row', padding: '4px 6px', gap: 4, flex: 1, minHeight: 80 }}>
                <div
                    ref={faderRef}
                    onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId); activePointerId.current = e.pointerId; setIsDragging(true); applyVolume(e.clientY); }}
                    onPointerMove={(e) => { if (!isDragging) return; if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return; applyVolume(e.clientY); }}
                    onPointerUp={(e) => { if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return; (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); endDrag(); }}
                    onPointerCancel={endDrag}
                    onDoubleClick={(e) => { e.stopPropagation(); setMasterVolume(1.0); void useEngineStore.getState().flushTrackControlFinals(); }}
                    onWheel={(e) => { e.stopPropagation(); const step = e.shiftKey ? 0.006 : 0.018; const next = Math.max(0, Math.min(2, vol + (e.deltaY < 0 ? step : -step))); setMasterVolume(next); debouncedFlush(); }}
                    style={{ flex: 1, position: 'relative', cursor: 'ns-resize', touchAction: 'none' }}
                >
                    {/* Fader Groove */}
                    <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: 0, bottom: 0, width: 6, background: 'color-mix(in srgb, var(--surface-2) 60%, black)', border: '1px solid color-mix(in srgb, var(--color-divider) 80%, black)', borderRadius: 3, boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.5)' }} />

                    {/* Fader Handle */}
                    <div style={{
                        position: 'absolute', left: 4, right: 4, bottom: `calc(${volNorm * 100}% - 6px)`, height: 12,
                        background: trackColor, borderRadius: 2, border: '1px solid rgba(0,0,0,0.7)',
                        boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.4), 0 2px 4px rgba(0,0,0,0.5)', pointerEvents: 'none',
                        display: 'flex', alignItems: 'center', justifyContent: 'center'
                    }}>
                        <div style={{ width: '70%', height: 2, background: 'color-mix(in srgb, var(--color-text-on-accent) 70%, transparent)', borderRadius: 1 }} />
                    </div>
                </div>

                {/* Master Stereo Meters — isolated from fader re-renders */}
                <MasterMeterPair meterWidth={masterMeterW} />
            </div>

            {/* ── dB & Peak Labels ── */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '2px 4px 6px', flexShrink: 0, borderTop: '1px solid var(--color-divider)' }}>
                <div style={{ fontSize: 10, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-primary)', fontWeight: 600 }}>
                    {formatDb(volumeDb)}
                </div>
                <MasterPeakLabels />
            </div>
        </div>
    );
});
