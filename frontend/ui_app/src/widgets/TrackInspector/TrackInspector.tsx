import { useState, useCallback, useMemo } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';

/**
 * TrackInspector — Right-side track list following Ableton Live layout exactly.
 *
 * TWO-ROW layout per track (matches Ableton reference screenshot):
 *   Row 1: [fold?] [icon] [Name]       [Routing ▼]  [#]  [S]  [Arm]
 *   Row 2:         [volume slider]      [vol dB]     [pan value]
 *
 * Group tracks:
 *   - Collapsible (▼/▸ toggle)
 *   - Children inherit group background color (tinted)
 *   - Sub-groups supported (Percussion inside DRUMS)
 */

// ── Types ──────────────────────────────────────────────────

export interface TrackData {
    id: string;
    name: string;
    type: 'audio' | 'midi' | 'group' | 'master';
    color: string;
    volume: number;
    pan: number;
    isMuted: boolean;
    isSoloed: boolean;
    isArmed: boolean;
    vuLevel: number;
    routing: string;
    groupId?: string;
    sends: { name: string; amount: number; color: string }[];
    input?: string;
    output?: string;
}

// ── Demo Data ──

export const DEMO_TRACKS: TrackData[] = [
    // DRUMS group
    { id: 'g-drums', name: 'DRUMS', type: 'group', color: '#d4a843', volume: 0, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.6, routing: 'Main', sends: [], input: '', output: 'Main' },
    { id: 't-kick', name: 'Kick', type: 'audio', color: '#d4a843', volume: 0, pan: 0, isMuted: false, isSoloed: false, isArmed: true, vuLevel: 0.55, routing: 'DRUMS', groupId: 'g-drums', sends: [], input: 'In 1-2', output: 'DRUMS' },
    { id: 't-snare', name: 'Snare', type: 'audio', color: '#d4a843', volume: -2.0, pan: 0, isMuted: false, isSoloed: false, isArmed: true, vuLevel: 0.4, routing: 'DRUMS', groupId: 'g-drums', sends: [], input: 'In 1-2', output: 'DRUMS' },
    { id: 't-ch', name: 'CH', type: 'audio', color: '#d4a843', volume: 0, pan: 0, isMuted: false, isSoloed: false, isArmed: true, vuLevel: 0.35, routing: 'DRUMS', groupId: 'g-drums', sends: [], input: 'In 1-2', output: 'DRUMS' },
    { id: 't-broken', name: 'Broken Item', type: 'audio', color: '#d4a843', volume: 0, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.3, routing: 'DRUMS', groupId: 'g-drums', sends: [], input: 'In 3-4', output: 'DRUMS' },
    { id: 't-foley', name: '6 Foley Small M', type: 'audio', color: '#d4a843', volume: 0, pan: 0, isMuted: false, isSoloed: false, isArmed: true, vuLevel: 0.25, routing: 'DRUMS', groupId: 'g-drums', sends: [], input: 'In 1-2', output: 'DRUMS' },
    { id: 't-cymatics', name: '7 Cymatics - Ta', type: 'audio', color: '#d4a843', volume: -21.7, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.2, routing: 'DRUMS', groupId: 'g-drums', sends: [], input: 'In 1-2', output: 'DRUMS' },

    // Percussion sub-group inside DRUMS
    { id: 'g-percussion', name: 'Percussion', type: 'group', color: '#d4a843', volume: 0, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.4, routing: 'DRUMS', groupId: 'g-drums', sends: [], input: '', output: 'DRUMS' },
    { id: 't-clap808', name: '9 Clap 808 Ligh', type: 'audio', color: '#e09050', volume: -5.7, pan: 0, isMuted: false, isSoloed: false, isArmed: true, vuLevel: 0.3, routing: 'Percussion', groupId: 'g-percussion', sends: [], input: 'In 1-2', output: 'Percussion' },
    { id: 't-bongo', name: '10 LE - Bongo', type: 'audio', color: '#e09050', volume: -13.4, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.2, routing: 'Percussion', groupId: 'g-percussion', sends: [], input: 'In 1-2', output: 'Percussion' },

    { id: 't-audio11', name: '11 Audio', type: 'audio', color: '#d4a843', volume: 0, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.15, routing: 'DRUMS', groupId: 'g-drums', sends: [], input: 'In 1-2', output: 'DRUMS' },

    // Standalone audio
    { id: 't-audio12', name: '12 Audio', type: 'audio', color: '#4488bb', volume: -15.1, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.3, routing: 'Main', sends: [], input: 'In 1-2', output: 'Main' },

    // Vocal group
    { id: 'g-vocal', name: 'Vocal', type: 'group', color: '#8866cc', volume: 0, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.5, routing: 'Main', sends: [], input: '', output: 'Main' },
    { id: 't-ds14', name: '14 DS_MDH_12', type: 'audio', color: '#8866cc', volume: -9.3, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.35, routing: 'Vocal', groupId: 'g-vocal', sends: [], input: 'In 1-2', output: 'Vocal' },
    { id: 't-ds15', name: '15 DS_MDH_12', type: 'audio', color: '#8866cc', volume: -6.0, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.3, routing: 'Vocal', groupId: 'g-vocal', sends: [], input: 'In 1-2', output: 'Vocal' },

    // Master
    { id: 'master', name: 'Main', type: 'master', color: '#666', volume: -6.0, pan: 0, isMuted: false, isSoloed: false, isArmed: false, vuLevel: 0.65, routing: '', sends: [], input: '', output: 'Main' },
];

// ── Component ──────────────────────────────────────────

interface TrackInspectorProps {
    selectedTrackId: string;
    onSelectTrack: (id: string) => void;
}

export const TrackInspector = ({ selectedTrackId, onSelectTrack }: TrackInspectorProps) => {
    const [tracks, setTracks] = useState(DEMO_TRACKS);
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

    // Engine store actions for real IPC
    const engineSetTrackMute = useEngineStore((s) => s.setTrackMute);
    const engineSetTrackSolo = useEngineStore((s) => s.setTrackSolo);
    const engineSetTrackVolume = useEngineStore((s) => s.setTrackVolume);
    const meterTracks = useEngineStore((s) => s.meters.tracks);

    // Helper: get engine track index from track id
    const getTrackIndex = useCallback((id: string): number => {
        return DEMO_TRACKS.findIndex(t => t.id === id);
    }, []);

    const toggleMute = useCallback((id: string) => {
        setTracks(prev => {
            const track = prev.find(t => t.id === id);
            if (track) {
                const idx = getTrackIndex(id);
                if (idx >= 0) engineSetTrackMute(idx, !track.isMuted);
            }
            return prev.map(t => t.id === id ? { ...t, isMuted: !t.isMuted } : t);
        });
    }, [getTrackIndex, engineSetTrackMute]);

    const toggleSolo = useCallback((id: string) => {
        setTracks(prev => {
            const track = prev.find(t => t.id === id);
            if (track) {
                const idx = getTrackIndex(id);
                if (idx >= 0) engineSetTrackSolo(idx, !track.isSoloed);
            }
            return prev.map(t => t.id === id ? { ...t, isSoloed: !t.isSoloed } : t);
        });
    }, [getTrackIndex, engineSetTrackSolo]);

    const handleVolumeChange = useCallback((id: string, volume: number) => {
        setTracks(prev => prev.map(t => t.id === id ? { ...t, volume } : t));
        const idx = getTrackIndex(id);
        // Convert dB to linear gain for the engine: gain = 10^(dB/20)
        if (idx >= 0) {
            const linearGain = Math.pow(10, volume / 20);
            engineSetTrackVolume(idx, linearGain);
        }
    }, [getTrackIndex, engineSetTrackVolume]);

    const toggleArm = useCallback((id: string) => {
        setTracks(prev => prev.map(t => t.id === id ? { ...t, isArmed: !t.isArmed } : t));
    }, []);

    const toggleGroupCollapse = useCallback((groupId: string) => {
        setCollapsedGroups(prev => {
            const next = new Set(prev);
            if (next.has(groupId)) next.delete(groupId);
            else next.add(groupId);
            return next;
        });
    }, []);

    // Build ancestor collapse check — a track is hidden if ANY of its ancestor groups is collapsed
    const isAncestorCollapsed = useCallback((track: TrackData): boolean => {
        if (!track.groupId) return false;
        if (collapsedGroups.has(track.groupId)) return true;
        const parentGroup = tracks.find(t => t.id === track.groupId);
        if (parentGroup) return isAncestorCollapsed(parentGroup);
        return false;
    }, [tracks, collapsedGroups]);

    const visibleTracks = useMemo(() => {
        return tracks.filter(t => !isAncestorCollapsed(t));
    }, [tracks, isAncestorCollapsed]);

    // Compute nesting depth for indentation
    const getDepth = useCallback((track: TrackData): number => {
        if (!track.groupId) return 0;
        const parent = tracks.find(t => t.id === track.groupId);
        if (parent) return 1 + getDepth(parent);
        return 1;
    }, [tracks]);

    // Track number counter (excluding groups)
    let trackNum = 0;

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            background: 'var(--color-bg-panel)',
            fontSize: 10,
        }}>
            {/* ── Track List (scrollable) ── */}
            <div className="scrollbar-hide" style={{
                flex: 1,
                overflowY: 'auto',
            }}>
                {visibleTracks.map((track) => {
                    const isGroup = track.type === 'group';
                    const isMaster = track.type === 'master';
                    if (!isGroup && !isMaster) trackNum++;
                    const displayNum = isGroup ? undefined : isMaster ? undefined : trackNum;
                    const isCollapsed = isGroup ? collapsedGroups.has(track.id) : false;
                    const depth = getDepth(track);

                    return (
                        <TrackRow
                            key={track.id}
                            track={track}
                            displayNum={displayNum}
                            isSelected={selectedTrackId === track.id}
                            isCollapsed={isCollapsed}
                            depth={depth}
                            onClick={() => onSelectTrack(track.id)}
                            onToggleMute={() => toggleMute(track.id)}
                            onToggleSolo={() => toggleSolo(track.id)}
                            onToggleArm={() => toggleArm(track.id)}
                            onToggleCollapse={isGroup ? () => toggleGroupCollapse(track.id) : undefined}
                        />
                    );
                })}
            </div>
        </div>
    );
};

// ── TrackRow (Ableton two-row layout) ──────────────────

const TrackRow = ({
    track, displayNum, isSelected, isCollapsed, depth,
    onClick, onToggleMute, onToggleSolo, onToggleArm, onToggleCollapse,
}: {
    track: TrackData;
    displayNum?: number;
    isSelected: boolean;
    isCollapsed: boolean;
    depth: number;
    onClick: () => void;
    onToggleMute: () => void;
    onToggleSolo: () => void;
    onToggleArm: () => void;
    onToggleCollapse?: () => void;
}) => {
    const isMaster = track.type === 'master';
    const isGroup = track.type === 'group';
    const isChild = depth > 0;

    // Group tinted background (like Ableton's yellow/purple tint for children)
    const groupTint = isChild || isGroup
        ? `color-mix(in srgb, ${track.color} 15%, transparent)`
        : 'transparent';

    // Volume bar width (0-100%)
    const volRange = 66; // -60..+6 dB range
    const volNorm = Math.min(1, Math.max(0, (track.volume + 60) / volRange));

    return (
        <div
            onClick={onClick}
            style={{
                display: 'flex',
                flexDirection: 'column',
                borderBottom: '1px solid var(--color-divider)',
                background: isSelected
                    ? 'var(--color-bg-selected)'
                    : groupTint,
                cursor: 'default',
                opacity: track.isMuted ? 0.45 : 1,
                transition: 'opacity var(--transition-fast)',
                paddingLeft: depth * 10,
            }}
        >
            {/* ─── ROW 1: Name + Routing + Buttons ─── */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                height: 22,
                gap: 2,
            }}>
                {/* Collapse arrow for groups */}
                {isGroup && onToggleCollapse ? (
                    <button
                        onClick={e => { e.stopPropagation(); onToggleCollapse(); }}
                        style={{
                            width: 16,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: 'none',
                            border: 'none',
                            color: 'var(--color-text-secondary)',
                            fontSize: 8,
                            cursor: 'pointer',
                            flexShrink: 0,
                        }}
                    >
                        {isCollapsed ? '⊕' : '⊖'}
                    </button>
                ) : (
                    <div style={{ width: 16, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <span style={{
                            fontSize: 8,
                            color: 'var(--color-text-tertiary)',
                        }}>
                            {track.type === 'midi' ? '◉' : track.type === 'audio' ? '◉' : isMaster ? '▶' : ''}
                        </span>
                    </div>
                )}

                {/* Track Name */}
                <span style={{
                    flex: 1,
                    fontSize: isGroup ? 10 : 10,
                    fontWeight: isGroup || isMaster ? 700 : 400,
                    color: isGroup ? '#1a1a1a' : 'var(--color-text-primary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    minWidth: 0,
                }}>
                    {track.name}
                </span>

                {/* Routing Dropdown */}
                <select
                    onClick={e => e.stopPropagation()}
                    value={track.routing}
                    onChange={() => {/* read-only demo */ }}
                    style={{
                        fontSize: 8,
                        fontWeight: 500,
                        color: 'var(--color-text-primary)',
                        background: 'var(--color-control-bg)',
                        border: '1px solid var(--color-control-border)',
                        borderRadius: 2,
                        padding: '1px 2px',
                        cursor: 'pointer',
                        maxWidth: 65,
                        minWidth: 40,
                        flexShrink: 0,
                        appearance: 'auto' as React.CSSProperties['appearance'],
                    }}
                >
                    <option>{track.routing || 'Main'}</option>
                    <option>Main</option>
                    <option>DRUMS</option>
                    <option>BASS</option>
                    <option>Vocal</option>
                    <option>Percussion</option>
                </select>

                {/* Track Number */}
                {displayNum !== undefined && (
                    <span style={{
                        width: 18,
                        height: 14,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: track.color,
                        color: '#fff',
                        borderRadius: 2,
                        fontSize: 8,
                        fontWeight: 700,
                        flexShrink: 0,
                    }}>
                        {displayNum}
                    </span>
                )}

                {/* Solo button */}
                {!isMaster && (
                    <button
                        onClick={e => { e.stopPropagation(); onToggleSolo(); }}
                        style={{
                            width: 14, height: 14,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: track.isSoloed ? 'var(--color-btn-solo)' : 'transparent',
                            color: track.isSoloed ? '#fff' : 'var(--color-text-secondary)',
                            border: 'none',
                            borderRadius: 2,
                            fontSize: 8,
                            fontWeight: 700,
                            cursor: 'pointer',
                            flexShrink: 0,
                        }}
                    >
                        S
                    </button>
                )}

                {/* Arm button */}
                {!isMaster && !isGroup && (
                    <button
                        onClick={e => { e.stopPropagation(); onToggleArm(); }}
                        style={{
                            width: 14, height: 14,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: track.isArmed ? 'var(--color-btn-arm)' : 'transparent',
                            color: track.isArmed ? '#fff' : 'var(--color-text-tertiary)',
                            border: track.isArmed ? 'none' : '1px solid var(--color-control-border)',
                            borderRadius: '50%',
                            fontSize: 7,
                            cursor: 'pointer',
                            flexShrink: 0,
                        }}
                    >
                        {track.isArmed ? '●' : '●'}
                    </button>
                )}
            </div>

            {/* ─── ROW 2: Volume bar + dB value + Pan ─── */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                height: 18,
                gap: 4,
                paddingLeft: 16,
                paddingRight: 4,
            }}>
                {/* Volume slider track */}
                <div style={{
                    flex: 1,
                    height: 4,
                    background: 'var(--color-meter-bg)',
                    borderRadius: 2,
                    position: 'relative',
                    overflow: 'hidden',
                }}>
                    <div style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        height: '100%',
                        width: `${volNorm * 100}%`,
                        background: `color-mix(in srgb, ${track.color} 70%, var(--color-meter-normal))`,
                        borderRadius: 2,
                        transition: 'width 0.1s linear',
                    }} />
                </div>

                {/* Volume dB value */}
                <span style={{
                    fontSize: 8,
                    fontFamily: 'var(--font-mono)',
                    color: track.volume !== 0
                        ? (track.volume > 0 ? '#4caf50' : '#e09050')
                        : 'var(--color-text-tertiary)',
                    fontWeight: 500,
                    minWidth: 28,
                    textAlign: 'right',
                    flexShrink: 0,
                }}>
                    {track.volume.toFixed(1)}
                </span>

                {/* Pan */}
                <span style={{
                    fontSize: 8,
                    color: 'var(--color-text-tertiary)',
                    fontWeight: 500,
                    minWidth: 12,
                    textAlign: 'center',
                    flexShrink: 0,
                }}>
                    {track.pan === 0 ? 'C' : track.pan > 0 ? `${Math.round(track.pan * 50)}R` : `${Math.round(Math.abs(track.pan) * 50)}L`}
                </span>
            </div>
        </div>
    );
};
