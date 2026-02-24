/**
 * MixerPanel — Ableton-style full mixer view (Shift+Tab toggle).
 *
 * Shows all tracks as vertical channel strips in a horizontal scroll container.
 * Each channel strip includes:
 *   • Track color bar + name
 *   • I/O routing labels
 *   • Pan knob
 *   • Tall vertical fader with VU meters  
 *   • Solo / Mute buttons
 *   • dB readout
 *
 * Mirrors Ableton Live's mixer shown at the bottom of the Session View.
 */
import { useCallback, useRef, useState, memo } from 'react';
import { useEngineStore, type ProjectTrack } from '@/shared/stores/useEngineStore';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { vuNorm } from '@/shared/lib/audioMath';
import { dbToFader, dbToGain, faderToDb, formatDb, gainToDb } from '@/widgets/TrackInspector/model/faderMath';

// ── Constants ──────────────────────────────────────────────────────────

const STRIP_WIDTH = 72;
const STRIP_GAP = 1;
const METER_WIDTH = 14;

// ── Types ──────────────────────────────────────────────────────────────

interface MixerPanelProps {
    selectedTrackId: string;
    onSelectTrack: (trackId: string) => void;
}

// ── Main Component ─────────────────────────────────────────────────────

export function MixerPanel({ selectedTrackId, onSelectTrack }: MixerPanelProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const tracksEntity = useEngineStore(s => s.tracks);
    const setTrackVolume = useEngineStore(s => s.setTrackVolume);
    const setTrackPan = useEngineStore(s => s.setTrackPan);
    const setTrackMute = useEngineStore(s => s.setTrackMute);
    const setTrackSolo = useEngineStore(s => s.setTrackSolo);
    const meters = useEngineStore(s => s.meters);

    return (
        <div
            ref={scrollRef}
            style={{
                display: 'flex',
                flexDirection: 'row',
                height: '100%',
                overflowX: 'auto',
                overflowY: 'hidden',
                background: 'var(--bg-app)',
                gap: STRIP_GAP,
                padding: '0 2px',
                scrollbarWidth: 'thin',
                scrollbarColor: 'color-mix(in srgb, var(--text-primary) 18%, transparent) transparent',
            }}
        >
            {tracksEntity.allIds.map((trackId, index) => {
                const track = tracksEntity.byId[trackId];
                if (!track) return null;
                const trackMeter = meters.tracks[index];
                const peakL = trackMeter?.[0]?.peak ?? -60;
                const peakR = trackMeter?.[1]?.peak ?? -60;
                return (
                    <MixerChannelStrip
                        key={trackId}
                        track={track}
                        trackIndex={index}
                        isSelected={trackId === selectedTrackId}
                        peakDbL={peakL}
                        peakDbR={peakR}
                        onSelect={() => onSelectTrack(trackId)}
                        onVolumeChange={(gain) => setTrackVolume(index, gain)}
                        onPanChange={(pan) => setTrackPan(index, pan)}
                        onToggleMute={() => setTrackMute(index, !track.is_mute)}
                        onToggleSolo={() => setTrackSolo(index, !track.is_solo)}
                    />
                );
            })}
            {/* Master channel strip */}
            <MasterStrip />
        </div>
    );
}

// ── Channel Strip ──────────────────────────────────────────────────────

interface ChannelStripProps {
    track: ProjectTrack;
    trackIndex: number;
    isSelected: boolean;
    peakDbL: number;
    peakDbR: number;
    onSelect: () => void;
    onVolumeChange: (gain: number) => void;
    onPanChange: (pan: number) => void;
    onToggleMute: () => void;
    onToggleSolo: () => void;
}

const MixerChannelStrip = memo(function MixerChannelStrip({
    track,
    trackIndex,
    isSelected,
    peakDbL,
    peakDbR,
    onSelect,
    onVolumeChange,
    onPanChange,
    onToggleMute,
    onToggleSolo,
}: ChannelStripProps) {
    const faderRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const activePointerId = useRef<number | null>(null);

    const volumeDb = gainToDb(track.volume ?? 1);
    const volNorm = Math.max(0, Math.min(1, dbToFader(volumeDb)));
    const meterL = Math.max(0, Math.min(1, vuNorm(peakDbL)));
    const meterR = Math.max(0, Math.min(1, vuNorm(peakDbR)));
    const panVal = track.pan ?? 0;
    const trackColor = track.color || 'var(--color-accent-primary)';
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
                display: 'flex',
                flexDirection: 'column',
                width: STRIP_WIDTH,
                minWidth: STRIP_WIDTH,
                maxWidth: STRIP_WIDTH,
                height: '100%',
                background: isSelected
                    ? 'color-mix(in srgb, var(--color-accent-primary) 8%, var(--surface-1))'
                    : 'var(--surface-1)',
                borderRight: `${STRIP_GAP}px solid var(--color-divider)`,
                cursor: 'pointer',
                overflow: 'hidden',
                position: 'relative',
                transition: 'background 80ms ease',
            }}
        >
            {/* ── Color bar ── */}
            <div style={{
                height: 3,
                width: '100%',
                background: trackColor,
                flexShrink: 0,
            }} />

            {/* ── Track name ── */}
            <div style={{
                padding: '3px 4px 2px',
                fontSize: 9,
                fontFamily: 'var(--font-sans)',
                fontWeight: 600,
                color: isSelected ? 'var(--color-text-bright)' : 'var(--color-text-primary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                textAlign: 'center',
                borderBottom: '1px solid var(--color-divider-light)',
                flexShrink: 0,
            }}>
                {track.name || `Track ${trackIndex + 1}`}
            </div>

            {/* ── Track type + number ── */}
            <div style={{
                padding: '1px 4px',
                fontSize: 8,
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-tertiary)',
                textAlign: 'center',
                flexShrink: 0,
            }}>
                {trackIndex + 1} {isMidi ? 'MIDI' : 'Audio'}
            </div>

            {/* ── I/O Routing ── */}
            <div style={{
                padding: '2px 3px',
                flexShrink: 0,
                borderBottom: '1px solid var(--color-divider-light)',
            }}>
                <div style={{
                    fontSize: 7.5,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text-tertiary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    marginBottom: 1,
                }}>
                    {track.input ? `In: ${track.input}` : (isMidi ? 'All Ch' : 'Ext. In')}
                </div>
                <div style={{
                    fontSize: 7.5,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text-tertiary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                }}>
                    {track.output ? `Out: ${track.output}` : 'Master'}
                </div>
            </div>

            {/* ── Pan knob ── */}
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                padding: '3px 0',
                flexShrink: 0,
                borderBottom: '1px solid var(--color-divider-light)',
            }}>
                <div style={{
                    position: 'relative',
                    width: 36,
                    height: 10,
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--surface-elevated)',
                    border: '1px solid color-mix(in srgb, var(--text-primary) 12%, transparent)',
                }}>
                    <div style={{
                        position: 'absolute', left: '50%', top: 0, bottom: 0,
                        width: 1, background: 'var(--color-divider-light)',
                    }} />
                    <div style={{
                        position: 'absolute', top: 0,
                        left: `calc(${((panVal + 1) / 2) * 100}% - 3px)`,
                        width: 6, height: '100%',
                        borderRadius: 'var(--radius-xs)',
                        background: 'var(--text-primary)',
                    }} />
                    <input
                        type="range" min={-1} max={1} step={0.01} value={panVal}
                        onChange={(e) => { e.stopPropagation(); onPanChange(Number(e.target.value)); }}
                        onDoubleClick={(e) => { e.stopPropagation(); onPanChange(0); }}
                        style={{
                            position: 'absolute', inset: 0, width: '100%',
                            height: '100%', opacity: 0, cursor: 'ew-resize',
                        }}
                    />
                </div>
                <span style={{
                    fontSize: 7, fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text-tertiary)', marginTop: 1,
                }}>
                    {Math.abs(panVal) < 0.02 ? 'C' : (panVal < 0 ? `L${Math.round(Math.abs(panVal) * 100)}` : `R${Math.round(panVal * 100)}`)}
                </span>
            </div>

            {/* ── Fader + Meters ── */}
            <div
                ref={faderRef}
                onPointerDown={(e) => {
                    e.stopPropagation(); e.preventDefault();
                    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                    activePointerId.current = e.pointerId;
                    setIsDragging(true);
                    applyVolume(e.clientY);
                }}
                onPointerMove={(e) => {
                    if (!isDragging) return;
                    if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
                    applyVolume(e.clientY);
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
                onWheel={(e) => {
                    e.stopPropagation();
                    const step = e.shiftKey ? 0.006 : 0.018;
                    const next = Math.max(0, Math.min(2, (track.volume ?? 1) + (e.deltaY < 0 ? step : -step)));
                    onVolumeChange(next);
                    void useEngineStore.getState().flushTrackControlFinals();
                }}
                style={{
                    flex: 1, minHeight: 80,
                    display: 'flex', flexDirection: 'row', alignItems: 'stretch',
                    gap: 2, padding: '4px 6px',
                    cursor: 'ns-resize', touchAction: 'none', position: 'relative',
                }}
            >
                {/* L meter */}
                <div style={{
                    width: METER_WIDTH, position: 'relative',
                    borderRadius: 'var(--radius-xs)', overflow: 'hidden',
                    background: 'var(--surface-elevated)',
                    border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)',
                }}>
                    <MeterStrip levelL={meterL} levelR={meterL} isMidi={isMidi}
                        width={METER_WIDTH} show0dBLine
                        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
                    />
                </div>

                {/* Fader track */}
                <div style={{
                    flex: 1, position: 'relative',
                    borderRadius: 'var(--radius-xs)',
                    background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)',
                }}>
                    {/* 0dB line */}
                    <div style={{
                        position: 'absolute', left: 0, right: 0,
                        bottom: `${dbToFader(0) * 100}%`, height: 1,
                        background: 'color-mix(in srgb, var(--color-text-secondary) 40%, transparent)',
                        pointerEvents: 'none',
                    }} />
                    {/* Fill */}
                    <div style={{
                        position: 'absolute', left: 2, right: 2, bottom: 0,
                        height: `${volNorm * 100}%`,
                        background: `linear-gradient(to top, color-mix(in srgb, ${trackColor} 50%, var(--color-meter-green-start)) 0%, color-mix(in srgb, ${trackColor} 30%, var(--color-meter-green-end)) 100%)`,
                        borderRadius: 'var(--radius-xs)', opacity: 0.7,
                        transition: isDragging ? 'none' : 'height 60ms linear',
                        pointerEvents: 'none',
                    }} />
                    {/* Handle */}
                    <div style={{
                        position: 'absolute', left: 0, right: 0,
                        bottom: `calc(${volNorm * 100}% - 2px)`, height: 4,
                        background: 'var(--color-text-bright)',
                        borderRadius: 'var(--radius-xs)',
                        boxShadow: '0 0 4px color-mix(in srgb, var(--color-text-bright) 50%, transparent)',
                        transition: isDragging ? 'none' : 'bottom 60ms linear',
                        pointerEvents: 'none',
                    }} />
                </div>

                {/* R meter */}
                <div style={{
                    width: METER_WIDTH, position: 'relative',
                    borderRadius: 'var(--radius-xs)', overflow: 'hidden',
                    background: 'var(--surface-elevated)',
                    border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)',
                }}>
                    <MeterStrip levelL={meterR} levelR={meterR} isMidi={isMidi}
                        width={METER_WIDTH} show0dBLine
                        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
                    />
                </div>
            </div>

            {/* ── dB readout ── */}
            <div style={{
                textAlign: 'center', fontSize: 8, fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-secondary)', padding: '1px 0',
                flexShrink: 0, borderTop: '1px solid var(--color-divider-light)',
            }}>
                {formatDb(volumeDb)}
            </div>

            {/* ── Solo / Mute buttons ── */}
            <div style={{
                display: 'flex', flexDirection: 'row', gap: 2,
                padding: '3px 4px', justifyContent: 'center',
                flexShrink: 0, borderTop: '1px solid var(--color-divider-light)',
            }}>
                <button
                    onClick={(e) => { e.stopPropagation(); onToggleSolo(); }}
                    title="Solo"
                    style={{
                        width: 22, height: 18,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 8, fontWeight: 700, fontFamily: 'var(--font-mono)',
                        border: 'none', borderRadius: 'var(--radius-xs)', cursor: 'pointer', padding: 0,
                        background: isSoloed ? 'var(--color-accent-primary)' : 'var(--surface-elevated)',
                        color: isSoloed ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
                        transition: 'background 80ms ease',
                    }}
                >
                    S
                </button>
                <button
                    onClick={(e) => { e.stopPropagation(); onToggleMute(); }}
                    title={isMuted ? 'Unmute' : 'Mute'}
                    style={{
                        width: 22, height: 18,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 7, fontWeight: 700, fontFamily: 'var(--font-mono)',
                        border: 'none', borderRadius: 'var(--radius-xs)', cursor: 'pointer', padding: 0,
                        background: !isMuted ? 'var(--color-status-success)' : 'color-mix(in srgb, var(--color-warning) 45%, var(--surface-elevated))',
                        color: !isMuted ? 'var(--color-text-on-color)' : 'var(--color-text-bright)',
                        transition: 'background 80ms ease',
                    }}
                >
                    {!isMuted ? trackIndex + 1 : 'M'}
                </button>
            </div>
        </div>
    );
});

// ── Master Strip ───────────────────────────────────────────────────────

function MasterStrip() {
    const masterVolume = useEngineStore(s => s.masterVolume);
    const setMasterVolume = useEngineStore(s => s.setMasterVolume);
    const meters = useEngineStore(s => s.meters);
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
        <div style={{
            display: 'flex', flexDirection: 'column',
            width: STRIP_WIDTH + 12, minWidth: STRIP_WIDTH + 12,
            height: '100%',
            background: 'color-mix(in srgb, var(--color-accent-primary) 5%, var(--surface-1))',
            borderLeft: '2px solid var(--color-accent-primary)',
            overflow: 'hidden', position: 'relative',
        }}>
            <div style={{ height: 3, width: '100%', background: 'var(--color-accent-primary)', flexShrink: 0 }} />
            <div style={{
                padding: '3px 4px 2px', fontSize: 10, fontFamily: 'var(--font-sans)',
                fontWeight: 700, color: 'var(--color-text-bright)',
                textAlign: 'center', borderBottom: '1px solid var(--color-divider-light)', flexShrink: 0,
            }}>
                Main
            </div>

            <div
                ref={faderRef}
                onPointerDown={(e) => {
                    e.stopPropagation(); e.preventDefault();
                    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                    activePointerId.current = e.pointerId;
                    setIsDragging(true);
                    applyVolume(e.clientY);
                }}
                onPointerMove={(e) => {
                    if (!isDragging) return;
                    if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
                    applyVolume(e.clientY);
                }}
                onPointerUp={(e) => {
                    if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
                    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
                    endDrag();
                }}
                onPointerCancel={endDrag}
                onDoubleClick={(e) => {
                    e.stopPropagation();
                    setMasterVolume(1.0);
                    void useEngineStore.getState().flushTrackControlFinals();
                }}
                onWheel={(e) => {
                    e.stopPropagation();
                    const step = e.shiftKey ? 0.006 : 0.018;
                    const next = Math.max(0, Math.min(2, vol + (e.deltaY < 0 ? step : -step)));
                    setMasterVolume(next);
                    void useEngineStore.getState().flushTrackControlFinals();
                }}
                style={{
                    flex: 1, minHeight: 100,
                    display: 'flex', flexDirection: 'row', gap: 2,
                    padding: '6px 8px', cursor: 'ns-resize', touchAction: 'none',
                }}
            >
                <div style={{
                    width: METER_WIDTH + 2, position: 'relative',
                    borderRadius: 'var(--radius-xs)', overflow: 'hidden',
                    background: 'var(--surface-elevated)',
                    border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)',
                }}>
                    <MeterStrip levelL={meterL} levelR={meterL} isMidi={false}
                        width={METER_WIDTH + 2} show0dBLine
                        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
                    />
                </div>
                <div style={{
                    flex: 1, position: 'relative', borderRadius: 'var(--radius-xs)',
                    background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)',
                }}>
                    <div style={{
                        position: 'absolute', left: 0, right: 0,
                        bottom: `${dbToFader(0) * 100}%`, height: 1,
                        background: 'color-mix(in srgb, var(--color-text-secondary) 40%, transparent)',
                        pointerEvents: 'none',
                    }} />
                    <div style={{
                        position: 'absolute', left: 2, right: 2, bottom: 0,
                        height: `${volNorm * 100}%`,
                        background: 'linear-gradient(to top, var(--color-meter-green-start) 0%, var(--color-meter-green-end) 100%)',
                        borderRadius: 'var(--radius-xs)', opacity: 0.8,
                        transition: isDragging ? 'none' : 'height 60ms linear',
                        pointerEvents: 'none',
                    }} />
                    <div style={{
                        position: 'absolute', left: 0, right: 0,
                        bottom: `calc(${volNorm * 100}% - 2px)`, height: 4,
                        background: 'var(--color-text-bright)',
                        borderRadius: 'var(--radius-xs)',
                        boxShadow: '0 0 4px color-mix(in srgb, var(--color-text-bright) 50%, transparent)',
                        transition: isDragging ? 'none' : 'bottom 60ms linear',
                        pointerEvents: 'none',
                    }} />
                </div>
                <div style={{
                    width: METER_WIDTH + 2, position: 'relative',
                    borderRadius: 'var(--radius-xs)', overflow: 'hidden',
                    background: 'var(--surface-elevated)',
                    border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)',
                }}>
                    <MeterStrip levelL={meterR} levelR={meterR} isMidi={false}
                        width={METER_WIDTH + 2} show0dBLine
                        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
                    />
                </div>
            </div>

            <div style={{
                textAlign: 'center', fontSize: 9, fontFamily: 'var(--font-mono)',
                fontWeight: 600, color: 'var(--color-text-secondary)', padding: '2px 0',
                flexShrink: 0, borderTop: '1px solid var(--color-divider-light)',
            }}>
                {formatDb(volumeDb)}
            </div>
        </div>
    );
}
