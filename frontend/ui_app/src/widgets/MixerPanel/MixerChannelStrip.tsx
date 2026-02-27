import { memo, useCallback, useRef, useState } from 'react';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { dbToFader, dbToGain, faderToDb, formatDb, gainToDb } from '@/widgets/TrackInspector/model/faderMath';
import { METER_WIDTH, STRIP_GAP, STRIP_WIDTH } from './MixerPanel.constants';
import { MixerChannelMeters } from './MixerChannelMeters';

interface ChannelStripProps {
    track: ProjectTrack;
    trackIndex: number;
    isSelected: boolean;
    onSelect: () => void;
    onVolumeChange: (index: number, gain: number) => void;
    onPanChange: (index: number, pan: number) => void;
    onToggleDisabled: (index: number, isDisabled: boolean) => void;
    onToggleSolo: (index: number, isSolo: boolean) => void;
    onToggleArm: (index: number, isArmed: boolean) => void;
}

export const MixerChannelStrip = memo(function MixerChannelStrip({
    track,
    trackIndex,
    isSelected,
    onSelect,
    onVolumeChange,
    onPanChange,
    onToggleDisabled,
    onToggleSolo,
    onToggleArm,
}: ChannelStripProps) {
    const faderRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const activePointerId = useRef<number | null>(null);
    const wheelFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const volumeDb = gainToDb(track.volume ?? 1);
    const volNorm = Math.max(0, Math.min(1, dbToFader(volumeDb)));
    const panVal = track.pan ?? 0;

    const trackColor = track.color || 'var(--color-accent-primary)';
    const isDisabled = track.is_disabled;
    const isSoloed = track.is_solo;
    const isArmed = track.is_armed;
    const isMidi = track.track_type === 'midi';

    const applyVolume = useCallback((clientY: number) => {
        const el = faderRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const pos = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
        onVolumeChange(trackIndex, dbToGain(faderToDb(pos)));
    }, [onVolumeChange, trackIndex]);

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
        <div
            onClick={onSelect}
            style={{
                display: 'flex',
                flexDirection: 'column',
                position: 'relative',
                overflow: 'hidden',
                width: STRIP_WIDTH, minWidth: STRIP_WIDTH, maxWidth: STRIP_WIDTH, height: '100%',
                background: isSelected ? 'var(--color-bg-panel)' : 'var(--surface-1)',
                borderRight: `${STRIP_GAP}px solid var(--color-divider)`,
                cursor: 'pointer',
            }}
        >
            {/* ── Pan Slider ── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 6px 4px', flexShrink: 0, borderBottom: '1px solid var(--color-divider)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{ position: 'relative', width: '100%', height: 14, borderRadius: 2, background: 'var(--surface-elevated)', border: '1px solid color-mix(in srgb, var(--text-primary) 15%, transparent)', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.3)' }}>
                        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--color-divider-light)' }} />
                        <div style={{ position: 'absolute', top: 1, left: `calc(${((panVal + 1) / 2) * 100}% - 4px)`, width: 8, height: 8, borderRadius: 1, background: 'var(--color-accent-primary)' }} />
                        <input
                            type="range" min={-1} max={1} step={0.01} value={panVal}
                            onChange={(e) => { e.stopPropagation(); onPanChange(trackIndex, Number(e.target.value)); }}
                            onDoubleClick={(e) => { e.stopPropagation(); onPanChange(trackIndex, 0); }}
                            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'ew-resize' }}
                        />
                    </div>
                    <span style={{ fontSize: 9, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                        {Math.abs(panVal) < 0.02 ? 'C' : (panVal < 0 ? `L${Math.round(Math.abs(panVal) * 100)}` : `R${Math.round(panVal * 100)}`)}
                    </span>
                </div>
            </div>

            {/* ── Volume Fader & Meters (fills remaining height) ── */}
            <div style={{ display: 'flex', flexDirection: 'row', padding: '4px 6px', gap: 4, flex: 1, minHeight: 80 }}>
                {/* Fader track */}
                <div
                    ref={faderRef}
                    onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId); activePointerId.current = e.pointerId; setIsDragging(true); applyVolume(e.clientY); }}
                    onPointerMove={(e) => { if (!isDragging) return; if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return; applyVolume(e.clientY); }}
                    onPointerUp={(e) => { if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return; (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); endDrag(); }}
                    onPointerCancel={endDrag}
                    onDoubleClick={(e) => { e.stopPropagation(); onVolumeChange(trackIndex, 1.0); void useEngineStore.getState().flushTrackControlFinals(); }}
                    onWheel={(e) => { e.stopPropagation(); const step = e.shiftKey ? 0.006 : 0.018; const next = Math.max(0, Math.min(2, (track.volume ?? 1) + (e.deltaY < 0 ? step : -step))); onVolumeChange(trackIndex, next); debouncedFlush(); }}
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
                        <div style={{ width: '70%', height: 2, background: 'rgba(255,255,255,0.7)', borderRadius: 1 }} />
                    </div>
                </div>

                {/* Stereo Meters */}
                <div style={{ display: 'flex', flexDirection: 'row', gap: 1 }}>
                    <MixerChannelMeters trackIndex={trackIndex} isMidi={isMidi} meterWidth={METER_WIDTH} />
                </div>
            </div>

            {/* ── dB Label ── */}
            <div style={{ display: 'flex', justifyContent: 'center', padding: '2px 4px', flexShrink: 0, borderTop: '1px solid var(--color-divider)', borderBottom: '1px solid var(--color-divider)' }}>
                <div style={{ fontSize: 9, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-primary)' }}>
                    {formatDb(volumeDb)}
                </div>
            </div>

            {/* ── Track Controls (Activator, Solo, Arm) ── */}
            <div style={{ display: 'flex', flexDirection: 'row', gap: 3, padding: '4px 6px', flexShrink: 0, justifyContent: 'center' }}>
                <button
                    onClick={(e) => { e.stopPropagation(); onToggleDisabled(trackIndex, isDisabled); }}
                    title={isDisabled ? 'Track Off' : 'Track On'}
                    style={{
                        flex: 1, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-role-data)', border: 'none', borderRadius: 2, cursor: 'pointer', padding: 0,
                        background: !isDisabled ? 'var(--color-status-warning)' : 'var(--surface-elevated)',
                        color: !isDisabled ? 'var(--token-color-hex-000000)' : 'var(--color-text-tertiary)',
                        boxShadow: !isDisabled ? 'inset 0 -1px 0 rgba(0,0,0,0.2), 0 0 4px rgba(255,180,0,0.4)' : 'inset 0 1px 2px rgba(0,0,0,0.3)',
                    }}>
                    {trackIndex + 1}
                </button>
                <button
                    onClick={(e) => { e.stopPropagation(); onToggleSolo(trackIndex, isSoloed); }}
                    title="Solo"
                    style={{
                        width: 24, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-role-data)', border: 'none', borderRadius: 2, cursor: 'pointer', padding: 0,
                        background: isSoloed ? 'var(--color-status-solo)' : 'var(--surface-elevated)',
                        color: isSoloed ? 'var(--token-color-hex-000000)' : 'var(--color-text-tertiary)',
                        boxShadow: isSoloed ? 'inset 0 -1px 0 rgba(0,0,0,0.2), 0 0 4px rgba(0,180,255,0.4)' : 'inset 0 1px 2px rgba(0,0,0,0.3)',
                    }}>
                    S
                </button>
                <button
                    onClick={(e) => { e.stopPropagation(); onToggleArm(trackIndex, isArmed); }}
                    title="Arm for recording"
                    style={{
                        width: 24, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: isArmed ? 'color-mix(in srgb, var(--color-status-record) 80%, black)' : 'var(--surface-elevated)',
                        border: 'none', borderRadius: 2, cursor: 'pointer', padding: 0,
                        boxShadow: isArmed ? 'inset 0 -1px 0 rgba(0,0,0,0.3), 0 0 6px rgba(255,59,48,0.5)' : 'inset 0 1px 2px rgba(0,0,0,0.3)',
                    }}>
                    <span style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: isArmed ? 'var(--color-status-record)' : 'color-mix(in srgb, var(--color-control-tint) 38%, transparent)',
                        boxShadow: isArmed ? '0 0 3px rgba(255,255,255,0.8)' : 'none'
                    }} />
                </button>
            </div>
        </div>
    );
});
