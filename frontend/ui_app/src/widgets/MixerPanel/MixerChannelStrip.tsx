import { memo, useCallback, useRef, useState } from 'react';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { getContrastColor } from '@/shared/lib/colorUtils';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { vuNorm } from '@/shared/lib/audioMath';
import { dbToFader, dbToGain, faderToDb, formatDb, gainToDb } from '@/widgets/TrackInspector/model/faderMath';
import { METER_WIDTH, STRIP_ACCENT_HEIGHT, STRIP_ACCENT_INSET, STRIP_GAP, STRIP_WIDTH } from './MixerPanel.constants';

interface ChannelStripProps {
    track: ProjectTrack;
    trackIndex: number;
    isSelected: boolean;
    onSelect: () => void;
    onVolumeChange: (gain: number) => void;
    onPanChange: (pan: number) => void;
    onToggleMute: () => void;
    onToggleSolo: () => void;
}

export const MixerChannelStrip = memo(function MixerChannelStrip({
    track,
    trackIndex,
    isSelected,
    onSelect,
    onVolumeChange,
    onPanChange,
    onToggleMute,
    onToggleSolo,
}: ChannelStripProps) {
    const faderRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const activePointerId = useRef<number | null>(null);
    const meterPair = useEngineStore((s) => s.meters.tracks[trackIndex]);
    const peakDbL = meterPair?.[0]?.peak ?? -96;
    const peakDbR = meterPair?.[1]?.peak ?? -96;

    const volumeDb = gainToDb(track.volume ?? 1);
    const volNorm = Math.max(0, Math.min(1, dbToFader(volumeDb)));
    const meterL = Math.max(0, Math.min(1, vuNorm(peakDbL)));
    const meterR = Math.max(0, Math.min(1, vuNorm(peakDbR)));
    const panVal = track.pan ?? 0;
    const trackColor = track.color || 'var(--color-accent-primary)';
    const headerTextColor = getContrastColor(trackColor) === 'black'
        ? 'var(--token-color-hex-0b0b0b)'
        : 'var(--color-text-bright)';
    const isMuted = track.is_mute;
    const isSoloed = track.is_solo;
    const isMidi = track.track_type === 'midi';

    const applyVolume = useCallback((clientY: number) => {
        const el = faderRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const pos = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
        onVolumeChange(dbToGain(faderToDb(pos)));
    }, [onVolumeChange]);

    const endDrag = useCallback(() => {
        setIsDragging(false);
        activePointerId.current = null;
        void useEngineStore.getState().flushTrackControlFinals();
    }, []);

    return (
        <div
            onClick={onSelect}
            style={{
                display: 'flex', flexDirection: 'column', width: STRIP_WIDTH, minWidth: STRIP_WIDTH, maxWidth: STRIP_WIDTH, height: '100%',
                background: isSelected ? 'color-mix(in srgb, var(--color-accent-primary) 8%, var(--surface-1))' : 'var(--surface-1)',
                borderRight: `${STRIP_GAP}px solid var(--color-divider)`,
                cursor: 'pointer',
                overflow: 'hidden',
                position: 'relative',
                transition: 'background 80ms ease',
            }}
        >
            <div style={{ height: STRIP_ACCENT_HEIGHT, width: '100%', flexShrink: 0, display: 'flex', alignItems: 'stretch' }}>
                <div
                    style={{
                        marginInline: STRIP_ACCENT_INSET,
                        width: `calc(100% - ${STRIP_ACCENT_INSET * 2}px)`,
                        background: trackColor,
                        borderBottomLeftRadius: 'var(--radius-xs)',
                        borderBottomRightRadius: 'var(--radius-xs)',
                    }}
                />
            </div>
            <div
                style={{
                    padding: '3px 4px 2px',
                    fontSize: 9,
                    fontFamily: 'var(--font-role-body)',
                    fontWeight: 700,
                    color: headerTextColor,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    textAlign: 'center',
                    borderBottom: '1px solid color-mix(in srgb, var(--color-divider-light) 70%, transparent)',
                    flexShrink: 0,
                    background: trackColor,
                }}
            >
                {track.name || `Track ${trackIndex + 1}`}
            </div>
            <div style={{ padding: '1px 4px', fontSize: 8, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-tertiary)', textAlign: 'center', flexShrink: 0 }}>
                {trackIndex + 1} {isMidi ? 'MIDI' : 'Audio'}
            </div>
            <div style={{ padding: '2px 3px', flexShrink: 0, borderBottom: '1px solid var(--color-divider-light)' }}>
                <div style={{ fontSize: 7.5, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 1 }}>
                    {track.input ? `In: ${track.input}` : (isMidi ? 'All Ch' : 'Ext. In')}
                </div>
                <div style={{ fontSize: 7.5, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {track.output ? `Out: ${track.output}` : 'Master'}
                </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '3px 0', flexShrink: 0, borderBottom: '1px solid var(--color-divider-light)' }}>
                <div style={{ position: 'relative', width: 36, height: 10, borderRadius: 'var(--radius-sm)', background: 'var(--surface-elevated)', border: '1px solid color-mix(in srgb, var(--text-primary) 12%, transparent)' }}>
                    <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--color-divider-light)' }} />
                    <div style={{ position: 'absolute', top: 0, left: `calc(${((panVal + 1) / 2) * 100}% - 3px)`, width: 6, height: '100%', borderRadius: 'var(--radius-xs)', background: 'var(--text-primary)' }} />
                    <input
                        type="range" min={-1} max={1} step={0.01} value={panVal}
                        onChange={(e) => { e.stopPropagation(); onPanChange(Number(e.target.value)); }}
                        onDoubleClick={(e) => { e.stopPropagation(); onPanChange(0); }}
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'ew-resize' }}
                    />
                </div>
                <span style={{ fontSize: 7, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-tertiary)', marginTop: 1 }}>
                    {Math.abs(panVal) < 0.02 ? 'C' : (panVal < 0 ? `L${Math.round(Math.abs(panVal) * 100)}` : `R${Math.round(panVal * 100)}`)}
                </span>
            </div>
            <div
                ref={faderRef}
                onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId); activePointerId.current = e.pointerId; setIsDragging(true); applyVolume(e.clientY); }}
                onPointerMove={(e) => { if (!isDragging) return; if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return; applyVolume(e.clientY); }}
                onPointerUp={(e) => { if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return; (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); endDrag(); }}
                onPointerCancel={endDrag}
                onDoubleClick={(e) => { e.stopPropagation(); onVolumeChange(1.0); void useEngineStore.getState().flushTrackControlFinals(); }}
                onWheel={(e) => { e.stopPropagation(); const step = e.shiftKey ? 0.006 : 0.018; const next = Math.max(0, Math.min(2, (track.volume ?? 1) + (e.deltaY < 0 ? step : -step))); onVolumeChange(next); void useEngineStore.getState().flushTrackControlFinals(); }}
                style={{ flex: 1, minHeight: 190, display: 'flex', flexDirection: 'row', alignItems: 'stretch', gap: 2, padding: '4px 3px', cursor: 'ns-resize', touchAction: 'none', position: 'relative' }}
            >
                <div style={{ width: METER_WIDTH, position: 'relative', borderRadius: 'var(--radius-xs)', overflow: 'hidden', background: 'var(--surface-elevated)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                    <MeterStrip levelL={meterL} levelR={meterL} isMidi={isMidi} width={METER_WIDTH} show0dBLine style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
                </div>
                <div style={{ flex: 1, position: 'relative', borderRadius: 'var(--radius-xs)', background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)', border: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
                    <div style={{ position: 'absolute', left: 0, right: 0, bottom: `${dbToFader(0) * 100}%`, height: 1, background: 'color-mix(in srgb, var(--color-text-secondary) 40%, transparent)', pointerEvents: 'none' }} />
                    <div style={{ position: 'absolute', left: 2, right: 2, bottom: 1, height: `calc(${volNorm * 100}% - 2px)`, background: `linear-gradient(to top, color-mix(in srgb, ${trackColor} 50%, var(--color-meter-green-start)) 0%, color-mix(in srgb, ${trackColor} 30%, var(--color-meter-green-end)) 100%)`, borderRadius: 'var(--radius-xs)', opacity: 0.7, transition: 'none', pointerEvents: 'none' }} />
                    <div style={{ position: 'absolute', left: 0, right: 0, bottom: `calc(${volNorm * 100}% - 1px)`, height: 2, background: 'color-mix(in srgb, var(--color-text-bright) 94%, transparent)', borderRadius: 'var(--radius-2xs)', boxShadow: '0 0 2px color-mix(in srgb, var(--color-text-bright) 35%, transparent)', transition: 'none', pointerEvents: 'none' }} />
                </div>
                <div style={{ width: METER_WIDTH, position: 'relative', borderRadius: 'var(--radius-xs)', overflow: 'hidden', background: 'var(--surface-elevated)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                    <MeterStrip levelL={meterR} levelR={meterR} isMidi={isMidi} width={METER_WIDTH} show0dBLine style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
                </div>
            </div>
            <div style={{ textAlign: 'center', fontSize: 8, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-secondary)', padding: '1px 0', flexShrink: 0, borderTop: '1px solid var(--color-divider-light)' }}>
                {formatDb(volumeDb)}
            </div>
            <div style={{ textAlign: 'center', fontSize: 7, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-tertiary)', padding: '0 0 2px', flexShrink: 0 }}>
                L {Number.isFinite(peakDbL) ? formatDb(peakDbL) : '-inf'} / R {Number.isFinite(peakDbR) ? formatDb(peakDbR) : '-inf'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'row', gap: 2, padding: '3px 4px', justifyContent: 'center', flexShrink: 0, borderTop: '1px solid var(--color-divider-light)' }}>
                <button onClick={(e) => { e.stopPropagation(); onToggleSolo(); }} title="Solo" style={{ width: 22, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 700, fontFamily: 'var(--font-role-data)', border: 'none', borderRadius: 'var(--radius-xs)', cursor: 'pointer', padding: 0, background: isSoloed ? 'var(--color-accent-primary)' : 'var(--surface-elevated)', color: isSoloed ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)', transition: 'background 80ms ease' }}>S</button>
                <button onClick={(e) => { e.stopPropagation(); onToggleMute(); }} title={isMuted ? 'Unmute' : 'Mute'} style={{ width: 22, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7, fontWeight: 700, fontFamily: 'var(--font-role-data)', border: 'none', borderRadius: 'var(--radius-xs)', cursor: 'pointer', padding: 0, background: !isMuted ? 'var(--color-status-success)' : 'color-mix(in srgb, var(--color-warning) 45%, var(--surface-elevated))', color: !isMuted ? 'var(--color-text-on-color)' : 'var(--color-text-bright)', transition: 'background 80ms ease' }}>
                    {!isMuted ? trackIndex + 1 : 'M'}
                </button>
            </div>
        </div>
    );
});
