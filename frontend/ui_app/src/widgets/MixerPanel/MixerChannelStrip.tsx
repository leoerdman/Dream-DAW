import { memo, useCallback, useRef, useState } from 'react';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { getContrastColor } from '@/shared/lib/colorUtils';
import { dbToFader, dbToGain, faderToDb, formatDb, gainToDb } from '@/widgets/TrackInspector/model/faderMath';
import { METER_WIDTH, STRIP_GAP, STRIP_WIDTH } from './MixerPanel.constants';
import { MixerChannelMeters, MixerChannelPeakLabel } from './MixerChannelMeters';

interface ChannelStripProps {
    track: ProjectTrack;
    trackIndex: number;
    isSelected: boolean;
    onSelect: () => void;
    onVolumeChange: (gain: number) => void;
    onPanChange: (pan: number) => void;
    onToggleDisabled: () => void;
    onToggleSolo: () => void;
    onToggleArm: () => void;
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
    const volumeDb = gainToDb(track.volume ?? 1);
    const volNorm = Math.max(0, Math.min(1, dbToFader(volumeDb)));
    const panVal = track.pan ?? 0;

    // Ableton 11 styling constants
    const trackColor = track.color || 'var(--color-accent-primary)';
    const headerTextColor = getContrastColor(trackColor) === 'black'
        ? 'var(--token-color-hex-000000)'
        : 'var(--color-text-bright)';

    const isDisabled = track.is_disabled;
    const isSoloed = track.is_solo;
    const isArmed = track.is_armed;
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
            className="flex flex-col relative overflow-hidden transition-colors duration-75 ease-out"
            style={{
                width: STRIP_WIDTH, minWidth: STRIP_WIDTH, maxWidth: STRIP_WIDTH, height: '100%',
                background: isSelected ? 'var(--color-bg-panel)' : 'var(--surface-1)',
                borderRight: `${STRIP_GAP}px solid var(--color-divider)`,
                cursor: 'pointer',
            }}
        >
            {/* 1. Ableton Title Bar */}
            <div
                style={{
                    height: 20,
                    padding: '2px 4px',
                    fontSize: 10,
                    fontFamily: 'var(--font-role-body)',
                    fontWeight: 600,
                    color: headerTextColor,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    textAlign: 'center',
                    flexShrink: 0,
                    background: trackColor,
                    borderBottom: '1px solid color-mix(in srgb, var(--color-divider) 50%, transparent)',
                }}
            >
                {track.name || `Track ${trackIndex + 1}`}
            </div>

            {/* 2. Empty Session Slots Area (Pushes I/O and Mixer to Bottom) */}
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
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.input ? track.input : (isMidi ? 'All Ins' : 'Ext. In')}</span>
                    <span style={{ fontSize: 7, color: 'var(--color-text-tertiary)' }}>▼</span>
                </div>
                <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    fontSize: 8.5, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-primary)',
                    background: 'var(--surface-elevated)', borderRadius: 2, padding: '2px 4px',
                    border: '1px solid color-mix(in srgb, var(--text-primary) 12%, transparent)', cursor: 'pointer',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 1px 1px rgba(0,0,0,0.1)'
                }}>
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.output ? track.output : 'Master'}</span>
                    <span style={{ fontSize: 7, color: 'var(--color-text-tertiary)' }}>▼</span>
                </div>
            </div>

            {/* 4. Mixer Section (Pan, Activator, Solo) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 4px 4px', flexShrink: 0, background: 'color-mix(in srgb, var(--surface-1) 30%, transparent)' }}>

                {/* Pan Dial */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{ position: 'relative', width: 42, height: 14, borderRadius: 2, background: 'var(--surface-elevated)', border: '1px solid color-mix(in srgb, var(--text-primary) 15%, transparent)', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.3)' }}>
                        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--color-divider-light)' }} />
                        <div style={{ position: 'absolute', top: 1, left: `calc(${((panVal + 1) / 2) * 100}% - 3px)`, width: 6, height: 8, borderRadius: 1, background: 'var(--color-accent-primary)' }} />
                        <input
                            type="range" min={-1} max={1} step={0.01} value={panVal}
                            onChange={(e) => { e.stopPropagation(); onPanChange(Number(e.target.value)); }}
                            onDoubleClick={(e) => { e.stopPropagation(); onPanChange(0); }}
                            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'ew-resize' }}
                        />
                    </div>
                    <span style={{ fontSize: 9, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                        {Math.abs(panVal) < 0.02 ? 'C' : (panVal < 0 ? `L${Math.round(Math.abs(panVal) * 100)}` : `R${Math.round(panVal * 100)}`)}
                    </span>
                </div>

                {/* Track Activator & Solo */}
                <div style={{ display: 'flex', flexDirection: 'row', gap: 3, justifyContent: 'center', marginTop: 2 }}>
                    <button
                        onClick={(e) => { e.stopPropagation(); onToggleDisabled(); }}
                        title={isDisabled ? 'Track Off' : 'Track On'}
                        style={{
                            flex: 1, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-role-data)', border: 'none', borderRadius: 2, cursor: 'pointer', padding: 0,
                            background: !isDisabled ? 'var(--color-status-warning)' : 'var(--surface-elevated)',
                            color: !isDisabled ? 'var(--token-color-hex-000000)' : 'var(--color-text-tertiary)',
                            boxShadow: !isDisabled ? 'inset 0 -1px 0 rgba(0,0,0,0.2), 0 0 4px rgba(255,180,0,0.4)' : 'inset 0 1px 2px rgba(0,0,0,0.3)',
                        }}>
                        {trackIndex + 1}
                    </button>
                    <button
                        onClick={(e) => { e.stopPropagation(); onToggleSolo(); }}
                        title="Solo"
                        style={{
                            width: 20, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-role-data)', border: 'none', borderRadius: 2, cursor: 'pointer', padding: 0,
                            background: isSoloed ? 'var(--color-status-solo)' : 'var(--surface-elevated)',
                            color: isSoloed ? 'var(--token-color-hex-000000)' : 'var(--color-text-tertiary)',
                            boxShadow: isSoloed ? 'inset 0 -1px 0 rgba(0,0,0,0.2), 0 0 4px rgba(0,180,255,0.4)' : 'inset 0 1px 2px rgba(0,0,0,0.3)',
                        }}>
                        S
                    </button>
                </div>

                {/* Record Arm */}
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: 1 }}>
                    <button
                        onClick={(e) => { e.stopPropagation(); onToggleArm(); }}
                        title="Arm for recording"
                        style={{
                            width: '100%', height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center',
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

            {/* 5. Volume Fader & Meters */}
            <div style={{ display: 'flex', flexDirection: 'row', padding: '0px 4px 4px', gap: 4, height: 160, flexShrink: 0 }}>
                {/* Meter pair on the right in Ableton, fader track on the left */}
                <div
                    ref={faderRef}
                    onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId); activePointerId.current = e.pointerId; setIsDragging(true); applyVolume(e.clientY); }}
                    onPointerMove={(e) => { if (!isDragging) return; if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return; applyVolume(e.clientY); }}
                    onPointerUp={(e) => { if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return; (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); endDrag(); }}
                    onPointerCancel={endDrag}
                    onDoubleClick={(e) => { e.stopPropagation(); onVolumeChange(1.0); void useEngineStore.getState().flushTrackControlFinals(); }}
                    onWheel={(e) => { e.stopPropagation(); const step = e.shiftKey ? 0.006 : 0.018; const next = Math.max(0, Math.min(2, (track.volume ?? 1) + (e.deltaY < 0 ? step : -step))); onVolumeChange(next); void useEngineStore.getState().flushTrackControlFinals(); }}
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

                <div style={{ display: 'flex', flexDirection: 'row', gap: 1 }}>
                    <MixerChannelMeters trackIndex={trackIndex} isMidi={isMidi} meterWidth={METER_WIDTH} />
                </div>
            </div>

            {/* 6. dB and Peak Labels */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 0 6px', flexShrink: 0 }}>
                <div style={{ fontSize: 9, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-primary)' }}>
                    {formatDb(volumeDb)}
                </div>
                <MixerChannelPeakLabel trackIndex={trackIndex} />
            </div>
        </div>
    );
});
