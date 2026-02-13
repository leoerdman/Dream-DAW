import { useState, useCallback, useRef } from 'react';

/**
 * TrackInspector — Right-side track list + mixer strip.
 *
 * Ported from TrackHeaderView.swift (1337 lines) & MixerView.swift.
 *
 * Each track row shows:
 *   [ColorStripe + Name] [Type] [Routing ▾] [Volume Fader] [S] [#] [VU]
 *
 * Plus a separate Inspector section at top for the selected track.
 */

// ── Types ──────────────────────────────────────────────────

interface TrackData {
    id: string;
    name: string;
    type: 'audio' | 'midi' | 'group' | 'master';
    color: string;
    volume: number;   // dB, -60 to +6
    pan: number;      // -1 to +1
    isMuted: boolean;
    isSoloed: boolean;
    isArmed: boolean;
    vuLevel: number;   // 0-1
    routing: string;
    sends: { name: string; amount: number; color: string }[];
    input?: string;
    output?: string;
}

// ── Demo Data from TrackHeaderView.swift / MixerView.swift ──

const TRACK_COLORS = [
    '#c93c38', '#d97028', '#a2a835', '#38a84f',
    '#2d8fa5', '#4466cc', '#8844aa', '#c850a0',
];

const DEMO_TRACKS: TrackData[] = [
    { id: '1', name: 'DRUMS', type: 'group', color: TRACK_COLORS[0], volume: -1.9, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.6, routing: 'Master', sends: [], input: 'In 1-2', output: 'Master' },
    { id: '2', name: 'Kick', type: 'audio', color: TRACK_COLORS[0], volume: -1.9, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.55, routing: 'DRUMS', sends: [], input: 'In 1-2', output: 'DRUMS' },
    { id: '3', name: 'Snare', type: 'midi', color: TRACK_COLORS[4], volume: -1.9, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.4, routing: 'DRUMS', sends: [], input: 'In 1-2', output: 'DRUMS' },
    { id: '4', name: 'Hihat', type: 'audio', color: TRACK_COLORS[4], volume: -1.9, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.35, routing: 'DRUMS', sends: [], input: 'In 1-2', output: 'DRUMS' },
    { id: '5', name: 'BASS', type: 'group', color: TRACK_COLORS[3], volume: -3.8, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.5, routing: 'Master', sends: [], input: 'In 1-2', output: 'Master' },
    { id: '6', name: 'Bass', type: 'audio', color: TRACK_COLORS[3], volume: -1.9, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.45, routing: 'BASS', sends: [], input: 'In 1-2', output: 'BASS' },
    { id: '7', name: 'MIDI 7', type: 'midi', color: TRACK_COLORS[5], volume: 0, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.3, routing: 'Master', sends: [], input: 'In 1-2', output: 'Master' },
    { id: '8', name: 'MIDI 8', type: 'midi', color: TRACK_COLORS[6], volume: 0, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.25, routing: 'Master', sends: [], input: 'In 1-2', output: 'Master' },
    { id: 'master', name: 'Master', type: 'master', color: '#666', volume: -1.0, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.65, routing: '', sends: [], input: '', output: 'Main' },
];

// ── Component ──────────────────────────────────────────

export const TrackInspector = () => {
    const [tracks, setTracks] = useState(DEMO_TRACKS);
    const [selectedTrackId, setSelectedTrackId] = useState('1');

    const selectedTrack = tracks.find(t => t.id === selectedTrackId) || tracks[0];

    const toggleMute = useCallback((id: string) => {
        setTracks(prev => prev.map(t => t.id === id ? { ...t, isMuted: !t.isMuted } : t));
    }, []);

    const toggleSolo = useCallback((id: string) => {
        setTracks(prev => prev.map(t => t.id === id ? { ...t, isSoloed: !t.isSoloed } : t));
    }, []);

    const toggleArm = useCallback((id: string) => {
        setTracks(prev => prev.map(t => t.id === id ? { ...t, isArmed: !t.isArmed } : t));
    }, []);

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            background: 'var(--color-bg-panel)',
            fontSize: 'var(--font-size-xs)',
        }}>

            {/* ── Inspector Header ── */}
            <div style={{
                padding: '8px 10px 6px',
                borderBottom: '1px solid var(--color-divider)',
                background: 'var(--color-bg-header)',
            }}>
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                }}>
                    <span style={{
                        fontSize: 'var(--font-size-2xs)',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        color: 'var(--color-text-secondary)',
                    }}>
                        INSPECTOR
                    </span>
                </div>

                <div style={{ marginTop: 4 }}>
                    <div style={{
                        fontSize: 'var(--font-size-sm)',
                        fontWeight: 600,
                        color: 'var(--color-text-primary)',
                    }}>
                        {selectedTrack.name}
                    </div>
                    <div style={{
                        fontSize: 'var(--font-size-2xs)',
                        color: 'var(--color-text-tertiary)',
                    }}>
                        {selectedTrack.type === 'audio' ? 'Audio' : selectedTrack.type === 'midi' ? 'MIDI' : selectedTrack.type === 'group' ? 'Group' : 'Master'} · Stereo
                    </div>
                </div>

                {/* Volume + Pan controls for selected track */}
                <div style={{ marginTop: 6 }}>
                    <InspectorRow label="VOLUME" value={`${selectedTrack.volume.toFixed(1)} dB`} />
                    <InspectorRow label="PAN" value={selectedTrack.pan === 0 ? 'C' : selectedTrack.pan > 0 ? `${Math.round(selectedTrack.pan * 50)}R` : `${Math.round(Math.abs(selectedTrack.pan) * 50)}L`} />

                    {/* Sends */}
                    {selectedTrack.sends.length > 0 && (
                        <div style={{ marginTop: 4 }}>
                            <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-tertiary)', textTransform: 'uppercase', fontWeight: 600 }}>
                                SENDS
                            </span>
                            {selectedTrack.sends.map((send, i) => (
                                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 }}>
                                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: send.color }} />
                                    <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-2xs)' }}>{send.name}</span>
                                    <span style={{ marginLeft: 'auto', color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-2xs)', fontFamily: 'var(--font-mono)' }}>
                                        {send.amount.toFixed(1)} dB
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* I/O Routing */}
                    <div style={{ marginTop: 4 }}>
                        <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-tertiary)', textTransform: 'uppercase', fontWeight: 600 }}>
                            I/O ROUTING
                        </span>
                        <InspectorRow label="Input" value={selectedTrack.input || '—'} />
                        <InspectorRow label="Output" value={selectedTrack.output || 'Master'} />
                    </div>
                </div>
            </div>

            {/* ── Track List ── */}
            <div className="scrollbar-hide" style={{
                flex: 1,
                overflowY: 'auto',
            }}>
                {tracks.map((track, index) => (
                    <TrackRow
                        key={track.id}
                        track={track}
                        index={index}
                        isSelected={selectedTrackId === track.id}
                        onClick={() => setSelectedTrackId(track.id)}
                        onToggleMute={() => toggleMute(track.id)}
                        onToggleSolo={() => toggleSolo(track.id)}
                        onToggleArm={() => toggleArm(track.id)}
                    />
                ))}
            </div>
        </div>
    );
};

// ── Sub-components ──────────────────────────────────────

const InspectorRow = ({ label, value }: { label: string; value: string }) => (
    <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '1px 0',
    }}>
        <span style={{
            color: 'var(--color-text-tertiary)',
            fontSize: 'var(--font-size-2xs)',
            fontWeight: 500,
        }}>
            {label}
        </span>
        <span style={{
            color: 'var(--color-text-primary)',
            fontSize: 'var(--font-size-2xs)',
            fontFamily: 'var(--font-mono)',
            fontWeight: 500,
        }}>
            {value}
        </span>
    </div>
);

const TrackRow = ({
    track, index, isSelected, onClick, onToggleMute, onToggleSolo, onToggleArm,
}: {
    track: TrackData;
    index: number;
    isSelected: boolean;
    onClick: () => void;
    onToggleMute: () => void;
    onToggleSolo: () => void;
    onToggleArm: () => void;
}) => {
    const isMaster = track.type === 'master';
    const vuPercent = Math.min(100, Math.max(0, track.vuLevel * 100));
    const vuColor = track.vuLevel > 0.85
        ? 'var(--color-meter-clip)'
        : track.vuLevel > 0.6
            ? 'var(--color-meter-hot)'
            : track.type === 'midi'
                ? 'var(--color-midi-indicator)'
                : 'var(--color-meter-normal)';

    return (
        <div
            onClick={onClick}
            style={{
                display: 'flex',
                alignItems: 'stretch',
                height: isMaster ? 34 : 30,
                borderBottom: '1px solid var(--color-divider)',
                background: isSelected ? 'var(--color-bg-selected)' : 'transparent',
                cursor: 'default',
                opacity: track.isMuted ? 0.45 : 1,
                transition: 'opacity var(--transition-fast)',
            }}
        >
            {/* Color stripe + Name */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 0,
                flexShrink: 0,
                minWidth: 0,
                flex: 1,
                overflow: 'hidden',
            }}>
                {/* Color Strip (3px vertical bar like Ableton) */}
                <div style={{
                    width: 3,
                    height: '100%',
                    background: track.color,
                    flexShrink: 0,
                }} />

                <span style={{
                    padding: '0 6px',
                    fontSize: 'var(--font-size-xs)',
                    fontWeight: track.type === 'group' || track.type === 'master' ? 700 : 400,
                    color: 'var(--color-text-primary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                }}>
                    {track.name}
                </span>
            </div>

            {/* Type badge */}
            {track.type === 'midi' && (
                <span style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 3px',
                    fontSize: 8,
                    fontWeight: 600,
                    color: 'var(--color-midi-indicator)',
                    flexShrink: 0,
                }}>
                    MIDI
                </span>
            )}

            {/* Solo button */}
            {!isMaster && (
                <button
                    onClick={e => { e.stopPropagation(); onToggleSolo(); }}
                    title="Solo"
                    style={{
                        width: 18, height: 18,
                        margin: '6px 2px',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: track.isSoloed ? 'var(--color-btn-solo)' : 'var(--color-control-bg-active)',
                        color: track.isSoloed ? '#fff' : 'var(--color-text-secondary)',
                        border: 'none',
                        borderRadius: 'var(--radius-xs)',
                        fontSize: 9,
                        fontWeight: 700,
                        cursor: 'pointer',
                        flexShrink: 0,
                    }}
                >
                    S
                </button>
            )}

            {/* Enable button (track number) */}
            {!isMaster && (
                <button
                    onClick={e => { e.stopPropagation(); onToggleMute(); }}
                    title={track.isMuted ? 'Unmute' : 'Mute'}
                    style={{
                        width: 18, height: 18,
                        margin: '6px 2px',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: track.isMuted ? 'var(--color-control-bg)' : `color-mix(in srgb, var(--color-status-success) 80%, transparent)`,
                        color: track.isMuted ? 'var(--color-text-tertiary)' : '#fff',
                        border: 'none',
                        borderRadius: 'var(--radius-xs)',
                        fontSize: 9,
                        fontWeight: 700,
                        cursor: 'pointer',
                        flexShrink: 0,
                    }}
                >
                    {index + 1}
                </button>
            )}

            {/* VU Meter bars (stereo, vertical) */}
            <div style={{
                display: 'flex',
                gap: 2,
                padding: '4px 4px 4px 2px',
                alignItems: 'flex-end',
                flexShrink: 0,
            }}>
                <div style={{
                    width: 4, height: '100%',
                    background: 'var(--color-meter-bg)',
                    borderRadius: 1,
                    position: 'relative',
                    overflow: 'hidden',
                }}>
                    <div style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        width: '100%',
                        height: `${vuPercent}%`,
                        background: vuColor,
                        borderRadius: 1,
                        transition: 'height 0.08s linear',
                    }} />
                </div>
                <div style={{
                    width: 4, height: '100%',
                    background: 'var(--color-meter-bg)',
                    borderRadius: 1,
                    position: 'relative',
                    overflow: 'hidden',
                }}>
                    <div style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        width: '100%',
                        height: `${Math.max(0, vuPercent - 5)}%`,
                        background: vuColor,
                        borderRadius: 1,
                        transition: 'height 0.08s linear',
                    }} />
                </div>
            </div>
        </div>
    );
};
