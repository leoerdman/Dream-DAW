import { useCallback, useRef, useState } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { vuNorm } from '@/shared/lib/audioMath';
import { dbToFader, dbToGain, faderToDb, formatDb, gainToDb } from '@/widgets/TrackInspector/model/faderMath';
import { METER_WIDTH, STRIP_ACCENT_HEIGHT, STRIP_ACCENT_INSET, STRIP_WIDTH } from './MixerPanel.constants';

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
    const meterL = Math.max(0, Math.min(1, vuNorm(peakL)));
    const meterR = Math.max(0, Math.min(1, vuNorm(peakR)));

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

    return (
        <div style={{ display: 'flex', flexDirection: 'column', width: STRIP_WIDTH + 12, minWidth: STRIP_WIDTH + 12, height: '100%', background: 'color-mix(in srgb, var(--color-accent-primary) 5%, var(--surface-1))', borderLeft: '2px solid var(--color-accent-primary)', overflow: 'hidden', position: 'relative' }}>
            <div style={{ height: STRIP_ACCENT_HEIGHT, width: '100%', flexShrink: 0, display: 'flex', alignItems: 'stretch' }}>
                <div
                    style={{
                        marginInline: STRIP_ACCENT_INSET,
                        width: `calc(100% - ${STRIP_ACCENT_INSET * 2}px)`,
                        background: 'var(--color-accent-primary)',
                        borderBottomLeftRadius: 'var(--radius-xs)',
                        borderBottomRightRadius: 'var(--radius-xs)',
                    }}
                />
            </div>
            <div style={{ padding: '3px 4px 2px', fontSize: 10, fontFamily: 'var(--font-role-body)', fontWeight: 700, color: 'var(--color-text-bright)', textAlign: 'center', borderBottom: '1px solid var(--color-divider-light)', flexShrink: 0 }}>
                Main
            </div>
            <div
                ref={faderRef}
                onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId); activePointerId.current = e.pointerId; setIsDragging(true); applyVolume(e.clientY); }}
                onPointerMove={(e) => { if (!isDragging) return; if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return; applyVolume(e.clientY); }}
                onPointerUp={(e) => { if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return; (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); endDrag(); }}
                onPointerCancel={endDrag}
                onDoubleClick={(e) => { e.stopPropagation(); setMasterVolume(1.0); void useEngineStore.getState().flushTrackControlFinals(); }}
                onWheel={(e) => { e.stopPropagation(); const step = e.shiftKey ? 0.006 : 0.018; const next = Math.max(0, Math.min(2, vol + (e.deltaY < 0 ? step : -step))); setMasterVolume(next); void useEngineStore.getState().flushTrackControlFinals(); }}
                style={{ flex: 1, minHeight: 230, display: 'flex', flexDirection: 'row', gap: 2, padding: '6px 4px', cursor: 'ns-resize', touchAction: 'none' }}
            >
                <div style={{ width: METER_WIDTH + 2, position: 'relative', borderRadius: 'var(--radius-xs)', overflow: 'hidden', background: 'var(--surface-elevated)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                    <MeterStrip levelL={meterL} levelR={meterL} isMidi={false} width={METER_WIDTH + 2} show0dBLine style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
                </div>
                <div style={{ flex: 1, position: 'relative', borderRadius: 'var(--radius-xs)', background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)', border: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
                    <div style={{ position: 'absolute', left: 0, right: 0, bottom: `${dbToFader(0) * 100}%`, height: 1, background: 'color-mix(in srgb, var(--color-text-secondary) 40%, transparent)', pointerEvents: 'none' }} />
                    <div style={{ position: 'absolute', left: 2, right: 2, bottom: 0, height: `${volNorm * 100}%`, background: 'linear-gradient(to top, var(--color-meter-green-start) 0%, var(--color-meter-green-end) 100%)', borderRadius: 'var(--radius-xs)', opacity: 0.8, transition: 'none', pointerEvents: 'none' }} />
                    <div style={{ position: 'absolute', left: 0, right: 0, bottom: `calc(${volNorm * 100}% - 2px)`, height: 4, background: 'var(--color-text-bright)', borderRadius: 'var(--radius-xs)', boxShadow: '0 0 4px color-mix(in srgb, var(--color-text-bright) 50%, transparent)', transition: 'none', pointerEvents: 'none' }} />
                </div>
                <div style={{ width: METER_WIDTH + 2, position: 'relative', borderRadius: 'var(--radius-xs)', overflow: 'hidden', background: 'var(--surface-elevated)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                    <MeterStrip levelL={meterR} levelR={meterR} isMidi={false} width={METER_WIDTH + 2} show0dBLine style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
                </div>
            </div>
            <div style={{ textAlign: 'center', fontSize: 9, fontFamily: 'var(--font-role-data)', fontWeight: 600, color: 'var(--color-text-secondary)', padding: '2px 0', flexShrink: 0, borderTop: '1px solid var(--color-divider-light)' }}>
                {formatDb(volumeDb)}
            </div>
            <div style={{ textAlign: 'center', fontSize: 7, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-tertiary)', padding: '0 0 2px', flexShrink: 0 }}>
                L {formatDb(peakL)} / R {formatDb(peakR)}
            </div>
        </div>
    );
}
