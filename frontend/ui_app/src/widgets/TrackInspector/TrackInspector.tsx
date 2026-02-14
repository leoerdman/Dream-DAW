import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';


/**
 * TrackInspector — Ableton-style track header panel.
 *
 * Layout per track (two rows):
 *   Row 1:  [icon] [Name]         [#] [M/S] [●] |VU|
 *   Row 2:        [→ Master ◊]  [← No Inp ◊]
 *
 *   • Color stripe (4px) on the left edge
 *   • Vibrant color-mixed backgrounds (30-50% saturation)
 *   • M (Mute) and S (Solo) stacked vertically
 *   • Right-click → context menu: Rename / Change Color / Delete
 *   • Cmd+R → inline rename
 *   • Add Track button at bottom of scrollable list
 */

// ── Types ──────────────────────────────────────────────────
interface TrackData {
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

// ── Live Track Mapping ──

/** Convert a ProjectTrack from the engine store to the UI TrackData shape. */
function mapProjectTrack(
    pt: ProjectTrack,
    _index: number,
    meterPair?: [{ peak: number }, { peak: number }],
): TrackData {
    const vuLevel = meterPair
        ? Math.max(meterPair[0].peak, meterPair[1].peak)
        : -Infinity;
    const typeMap: Record<string, TrackData['type']> = {
        audio: 'audio', Audio: 'audio',
        midi: 'midi', Midi: 'midi',
        group: 'group', Group: 'group',
        master: 'master', Master: 'master',
    };
    return {
        id: pt.id,
        name: pt.name,
        type: typeMap[pt.track_type] || 'audio',
        color: pt.color,
        volume: pt.volume,
        pan: pt.pan,
        isMuted: pt.is_mute,
        isSoloed: pt.is_solo,
        isArmed: pt.is_armed,
        vuLevel,
        routing: pt.output || 'master',
        sends: [],
        input: pt.input || 'none',
        output: pt.output || 'master',
    };
}

// ── VU Meter Helpers ──

/** Normalize a peak dB value (typically -60 to 0+) into 0..1 range for display. */
function vuNorm(peakDb: number): number {
    if (!isFinite(peakDb) || peakDb < -60) return 0;
    const clamped = Math.min(peakDb, 6);
    return (clamped + 60) / 66;
}

/** Returns color for the VU meter fill based on level and signal type. */
function vuColor(peakDb: number, isMidi: boolean): string {
    if (!isFinite(peakDb) || peakDb < -60) return 'transparent';
    if (peakDb > -3) return '#ff3b30';
    if (peakDb > -12) return isMidi ? '#ff9500' : '#ffcc00';
    return '#40cc5a';
}

// ── 16-Color Ableton Palette (from Swift TrackColor enum) ──

const TRACK_PALETTE = [
    { name: 'Coral', hex: '#f05c4d' },
    { name: 'Orange', hex: '#ff8a1a' },
    { name: 'Gold', hex: '#f5ba30' },
    { name: 'Yellow', hex: '#f2e640' },
    { name: 'Lime', hex: '#8cd93b' },
    { name: 'Green', hex: '#38c759' },
    { name: 'Teal', hex: '#29b8a1' },
    { name: 'Cyan', hex: '#1fbfd9' },
    { name: 'Sky', hex: '#3399eb' },
    { name: 'Blue', hex: '#406be0' },
    { name: 'Indigo', hex: '#6b52d9' },
    { name: 'Purple', hex: '#9e4dd9' },
    { name: 'Magenta', hex: '#d140b8' },
    { name: 'Pink', hex: '#eb598c' },
    { name: 'Rose', hex: '#e66673' },
    { name: 'Slate', hex: '#8c949e' },
] as const;

// ── Component ──────────────────────────────────────────

interface TrackInspectorProps {
    selectedTrackId: string;
    onSelectTrack: (id: string) => void;
    trackHeight?: number;
    rulerHeight?: number;
    scrollTop?: number;
}

export const TrackInspector = ({
    selectedTrackId,
    onSelectTrack,
    trackHeight = 48,
    rulerHeight = 24,
    scrollTop: externalScrollTop,
}: TrackInspectorProps) => {
    const projectTracks = useEngineStore((s) => s.projectTracks);
    const engineSetTrackMute = useEngineStore((s) => s.setTrackMute);
    const engineSetTrackSolo = useEngineStore((s) => s.setTrackSolo);
    const addTrack = useEngineStore((s) => s.addTrack);
    const deleteTrack = useEngineStore((s) => s.deleteTrack);
    const renameTrackAction = useEngineStore((s) => s.renameTrack);
    const meters = useEngineStore((s) => s.meters);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (scrollRef.current && externalScrollTop !== undefined) {
            scrollRef.current.scrollTop = externalScrollTop;
        }
    }, [externalScrollTop]);

    const liveTracks = useMemo((): TrackData[] => {
        return projectTracks.map((pt, idx) =>
            mapProjectTrack(pt, idx, meters.tracks[idx]),
        );
    }, [projectTracks, meters]);

    const masterTrack = useMemo((): TrackData => {
        const masterVu = Math.max(meters.master_left.peak, meters.master_right.peak);
        return {
            id: 'master', name: 'Master', type: 'master', color: '#666',
            volume: 0, pan: 0, isMuted: false, isSoloed: false, isArmed: false,
            vuLevel: masterVu, routing: '', sends: [], input: '', output: 'Main',
        };
    }, [meters]);

    // Local overrides
    const [localOverrides, setLocalOverrides] = useState<Record<string, Partial<TrackData>>>({});
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

    // Context menu
    const [contextMenu, setContextMenu] = useState<{
        trackId: string; trackIndex: number; x: number; y: number;
    } | null>(null);

    // Color picker (opened from context menu)
    const [colorPickerState, setColorPickerState] = useState<{
        trackId: string; x: number; y: number;
    } | null>(null);

    // Inline rename
    const [renamingTrackId, setRenamingTrackId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');

    const tracks = useMemo(() => {
        return liveTracks.map(t => ({ ...t, ...(localOverrides[t.id] || {}) }));
    }, [liveTracks, localOverrides]);

    const getTrackIndex = useCallback((id: string) => liveTracks.findIndex(t => t.id === id), [liveTracks]);

    const toggleMute = useCallback((id: string) => {
        const track = tracks.find(t => t.id === id);
        if (track) {
            const idx = getTrackIndex(id);
            const newMuted = !track.isMuted;
            if (idx >= 0) engineSetTrackMute(idx, newMuted);
            setLocalOverrides(prev => ({ ...prev, [id]: { ...prev[id], isMuted: newMuted } }));
        }
    }, [tracks, getTrackIndex, engineSetTrackMute]);

    const toggleSolo = useCallback((id: string) => {
        const track = tracks.find(t => t.id === id);
        if (track) {
            const idx = getTrackIndex(id);
            const newSoloed = !track.isSoloed;
            if (idx >= 0) engineSetTrackSolo(idx, newSoloed);
            setLocalOverrides(prev => ({ ...prev, [id]: { ...prev[id], isSoloed: newSoloed } }));
        }
    }, [tracks, getTrackIndex, engineSetTrackSolo]);

    const toggleArm = useCallback((id: string) => {
        const track = tracks.find(t => t.id === id);
        if (track) {
            const idx = getTrackIndex(id);
            const newArmed = !track.isArmed;
            if (idx >= 0) {
                // TODO: Backend arm_track command not yet implemented
                console.warn('[TrackInspector] armTrack: backend not implemented yet, index=', idx);
            }
            setLocalOverrides(prev => ({ ...prev, [id]: { ...prev[id], isArmed: newArmed } }));
        }
    }, [tracks, getTrackIndex]);

    const toggleGroupCollapse = useCallback((groupId: string) => {
        setCollapsedGroups(prev => {
            const next = new Set(prev);
            if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
            return next;
        });
    }, []);

    const isAncestorCollapsed = useCallback((track: TrackData): boolean => {
        if (!track.groupId) return false;
        if (collapsedGroups.has(track.groupId)) return true;
        const parentGroup = tracks.find(t => t.id === track.groupId);
        if (parentGroup) return isAncestorCollapsed(parentGroup);
        return false;
    }, [tracks, collapsedGroups]);

    const visibleTracks = useMemo(() => tracks.filter(t => !isAncestorCollapsed(t)), [tracks, isAncestorCollapsed]);

    const getDepth = useCallback((track: TrackData): number => {
        if (!track.groupId) return 0;
        const parent = tracks.find(t => t.id === track.groupId);
        if (parent) return 1 + getDepth(parent);
        return 1;
    }, [tracks]);

    // ── Context Menu handlers ──
    const handleContextMenu = useCallback((e: React.MouseEvent, trackId: string, trackIndex: number) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ trackId, trackIndex, x: e.clientX, y: e.clientY });
    }, []);

    const handleRenameStart = useCallback((trackId: string) => {
        const track = tracks.find(t => t.id === trackId);
        if (track) {
            setRenamingTrackId(trackId);
            setRenameValue(track.name);
        }
        setContextMenu(null);
    }, [tracks]);

    const handleRenameCommit = useCallback(() => {
        if (renamingTrackId && renameValue.trim()) {
            const idx = getTrackIndex(renamingTrackId);
            if (idx >= 0) renameTrackAction(idx, renameValue.trim());
        }
        setRenamingTrackId(null);
        setRenameValue('');
    }, [renamingTrackId, renameValue, getTrackIndex, renameTrackAction]);

    const handleRenameCancel = useCallback(() => {
        setRenamingTrackId(null);
        setRenameValue('');
    }, []);

    const handleDeleteTrack = useCallback((trackId: string) => {
        const idx = getTrackIndex(trackId);
        if (idx >= 0) deleteTrack(idx);
        setContextMenu(null);
    }, [getTrackIndex, deleteTrack]);

    const handleOpenColorPicker = useCallback((trackId: string, x: number, y: number) => {
        setColorPickerState({ trackId, x, y });
        setContextMenu(null);
    }, []);

    const handleColorSelect = useCallback((trackId: string, color: string) => {
        setLocalOverrides(prev => ({ ...prev, [trackId]: { ...prev[trackId], color } }));
        setColorPickerState(null);
    }, []);

    // ── Cmd+R keyboard shortcut for rename ──
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'r' && selectedTrackId && selectedTrackId !== 'master') {
                e.preventDefault();
                handleRenameStart(selectedTrackId);
            }
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [selectedTrackId, handleRenameStart]);

    let trackNum = 0;

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', height: '100%',
            background: 'var(--color-bg-panel)', fontSize: 10,
        }}>
            {/* Ruler spacer */}
            <div style={{
                height: rulerHeight, flexShrink: 0,
                background: 'var(--color-bg-header)',
                borderBottom: '1px solid var(--color-divider)',
                display: 'flex', alignItems: 'center', paddingLeft: 8,
            }}>
                <span style={{
                    fontSize: 9, fontWeight: 600,
                    color: 'var(--color-text-secondary)',
                    letterSpacing: '0.5px', textTransform: 'uppercase',
                }}>Tracks</span>
            </div>

            {/* Track List */}
            <div ref={scrollRef} className="scrollbar-hide"
                style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
                {visibleTracks.map((track) => {
                    const isGroup = track.type === 'group';
                    if (!isGroup) trackNum++;
                    const displayNum = isGroup ? undefined : trackNum;
                    const isCollapsed = isGroup ? collapsedGroups.has(track.id) : false;
                    const depth = getDepth(track);
                    const trackIndex = getTrackIndex(track.id);

                    return (
                        <TrackRow
                            key={track.id}
                            track={track}
                            allTracks={tracks}
                            trackHeight={trackHeight}
                            displayNum={displayNum}
                            isSelected={selectedTrackId === track.id}
                            isCollapsed={isCollapsed}
                            depth={depth}
                            isRenaming={renamingTrackId === track.id}
                            renameValue={renameValue}
                            onRenameChange={setRenameValue}
                            onRenameCommit={handleRenameCommit}
                            onRenameCancel={handleRenameCancel}
                            onClick={() => onSelectTrack(track.id)}
                            onToggleMute={() => toggleMute(track.id)}
                            onToggleSolo={() => toggleSolo(track.id)}
                            onToggleArm={() => toggleArm(track.id)}
                            onToggleCollapse={isGroup ? () => toggleGroupCollapse(track.id) : undefined}
                            onContextMenu={(e) => handleContextMenu(e, track.id, trackIndex)}
                        />
                    );
                })}

                {/* Add Track Button */}
                <button
                    onClick={() => addTrack()}
                    style={{
                        width: '100%', height: 32,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                        background: 'transparent', border: 'none',
                        borderTop: '1px solid var(--color-divider)',
                        color: 'var(--color-text-tertiary)', fontSize: 10, fontWeight: 500,
                        cursor: 'pointer', transition: 'all 0.15s ease',
                    }}
                    onMouseEnter={e => {
                        e.currentTarget.style.background = 'color-mix(in srgb, var(--color-accent-primary) 10%, transparent)';
                        e.currentTarget.style.color = 'var(--color-accent-primary)';
                    }}
                    onMouseLeave={e => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.color = 'var(--color-text-tertiary)';
                    }}
                >
                    <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
                    Add Track
                </button>
            </div>

            {/* Master Track — fixed at bottom */}
            <TrackRow
                track={masterTrack}
                allTracks={tracks}
                trackHeight={trackHeight}
                isSelected={selectedTrackId === 'master'}
                isCollapsed={false}
                depth={0}
                isRenaming={false}
                renameValue=""
                onRenameChange={() => { }}
                onRenameCommit={() => { }}
                onRenameCancel={() => { }}
                onClick={() => onSelectTrack('master')}
                onToggleMute={() => { }}
                onToggleSolo={() => { }}
                onToggleArm={() => { }}
                onContextMenu={() => { }}
                isMasterFixed
            />

            {/* Context Menu */}
            {contextMenu && (
                <ContextMenuPopup
                    x={contextMenu.x}
                    y={contextMenu.y}
                    onRename={() => handleRenameStart(contextMenu.trackId)}
                    onDelete={() => handleDeleteTrack(contextMenu.trackId)}
                    onChangeColor={() => handleOpenColorPicker(contextMenu.trackId, contextMenu.x, contextMenu.y)}
                    onDismiss={() => setContextMenu(null)}
                />
            )}

            {/* Color Picker */}
            {colorPickerState && (
                <ColorPickerPopup
                    x={colorPickerState.x}
                    y={colorPickerState.y}
                    currentColor={(tracks.find(t => t.id === colorPickerState.trackId)?.color) || '#666'}
                    onSelect={(color) => handleColorSelect(colorPickerState.trackId, color)}
                    onDismiss={() => setColorPickerState(null)}
                />
            )}
        </div>
    );
};

// ── Context Menu Popup ──────────────────────────────────────────

const ContextMenuPopup = ({
    x, y, onRename, onDelete, onChangeColor, onDismiss,
}: {
    x: number; y: number;
    onRename: () => void; onDelete: () => void;
    onChangeColor: () => void; onDismiss: () => void;
}) => {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
        };
        const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [onDismiss]);

    const clampedX = Math.min(x, window.innerWidth - 168);
    const clampedY = Math.min(y, window.innerHeight - 120);

    const itemStyle: React.CSSProperties = {
        width: '100%', padding: '6px 12px',
        background: 'none', border: 'none',
        color: 'var(--color-text-primary)', fontSize: 11, fontWeight: 400,
        textAlign: 'left', cursor: 'pointer', borderRadius: 4,
        display: 'flex', alignItems: 'center', gap: 8,
    };

    return (
        <div ref={ref} style={{
            position: 'fixed', left: clampedX, top: clampedY, width: 160,
            background: '#1e1e22', border: '1px solid var(--color-border-subtle)',
            borderRadius: 8, padding: 4, zIndex: 9999,
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}>
            <button style={itemStyle} onClick={onRename}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                <span style={{ width: 14, fontSize: 12 }}>✏️</span> Rename
            </button>
            <button style={itemStyle} onClick={onChangeColor}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                <span style={{ width: 14, fontSize: 12 }}>🎨</span> Change Color
            </button>
            <div style={{ height: 1, background: 'var(--color-divider)', margin: '2px 8px' }} />
            <button style={{ ...itemStyle, color: '#ff6b6b' }} onClick={onDelete}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,107,107,0.12)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                <span style={{ width: 14, fontSize: 12 }}>🗑</span> Delete Track
            </button>
        </div>
    );
};

// ── TrackRow (two-row Ableton-style layout) ──────────────────────────────

const routingSelectStyle: React.CSSProperties = {
    fontSize: 8, fontWeight: 500,
    color: 'var(--color-text-primary)',
    background: 'var(--color-control-bg)',
    border: '1px solid var(--color-control-border)',
    borderRadius: 2, padding: '0px 4px', cursor: 'pointer',
    maxWidth: 72, minWidth: 44, flexShrink: 0,
    appearance: 'auto' as React.CSSProperties['appearance'],
    lineHeight: '14px', height: 14,
};

const TrackRow = ({
    track, allTracks, trackHeight, displayNum, isSelected, isCollapsed, depth,
    isRenaming, renameValue, onRenameChange, onRenameCommit, onRenameCancel,
    onClick, onToggleMute, onToggleSolo, onToggleArm, onToggleCollapse,
    onContextMenu, isMasterFixed,
}: {
    track: TrackData;
    allTracks: TrackData[];
    trackHeight: number;
    displayNum?: number;
    isSelected: boolean;
    isCollapsed: boolean;
    depth: number;
    isRenaming: boolean;
    renameValue: string;
    onRenameChange: (v: string) => void;
    onRenameCommit: () => void;
    onRenameCancel: () => void;
    onClick: () => void;
    onToggleMute: () => void;
    onToggleSolo: () => void;
    onToggleArm: () => void;
    onToggleCollapse?: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
    isMasterFixed?: boolean;
}) => {
    const isMaster = track.type === 'master';
    const isGroup = track.type === 'group';
    const [isHovered, setIsHovered] = useState(false);
    const renameInputRef = useRef<HTMLInputElement>(null);

    const availableRoutingTargets = allTracks.filter(t => t.id !== track.id && t.type !== 'master');
    const outputValue = track.output && (track.output === 'master' || availableRoutingTargets.some(t => t.id === track.output))
        ? track.output : 'master';
    const inputValue = track.input && (
        track.input === 'none' || track.input === 'ext-1' || track.input === 'ext-2' ||
        availableRoutingTargets.some(t => t.id === track.input)
    ) ? track.input : 'none';

    // Focus rename input
    useEffect(() => {
        if (isRenaming && renameInputRef.current) {
            renameInputRef.current.focus();
            renameInputRef.current.select();
        }
    }, [isRenaming]);

    const showRouting = !isMasterFixed && trackHeight >= 48;

    // Master styling
    const masterBg = isSelected ? '#2a2a2e' : isHovered ? '#222226' : '#1a1a1e';

    // Vibrant color-mixed backgrounds
    const bgColor = isMasterFixed
        ? masterBg
        : isSelected
            ? `color-mix(in srgb, ${track.color} 40%, var(--color-bg-panel))`
            : isHovered
                ? `color-mix(in srgb, ${track.color} 32%, var(--color-bg-panel))`
                : `color-mix(in srgb, ${track.color} 22%, var(--color-bg-panel))`;

    return (
        <div
            onClick={onClick}
            onContextMenu={onContextMenu}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            style={{
                display: 'flex', alignItems: 'stretch', height: trackHeight,
                borderBottom: isMasterFixed ? 'none' : '1px solid var(--color-divider)',
                borderTop: isMasterFixed ? '1px solid var(--color-divider)' : 'none',
                background: bgColor, cursor: 'default',
                opacity: track.isMuted ? 0.45 : 1,
                transition: 'background 0.12s ease, opacity 0.12s ease',
                position: 'relative', paddingLeft: depth * 10, flexShrink: 0,
            }}
        >
            {/* Color stripe (4px) */}
            <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0, width: 4,
                background: isMasterFixed ? '#666' : track.color,
                borderRadius: '0 1px 1px 0',
            }} />

            {/* Main content (two rows) */}
            <div style={{
                display: 'flex', flexDirection: 'column', flex: 1,
                paddingLeft: 8, paddingRight: 4,
                justifyContent: 'center', gap: 1, minWidth: 0,
            }}>
                {/* ── Row 1: Name + Controls ── */}
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 4, minHeight: 18,
                }}>
                    {/* Icon / Collapse */}
                    {isGroup && onToggleCollapse ? (
                        <button
                            onClick={e => { e.stopPropagation(); onToggleCollapse(); }}
                            style={{
                                width: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: 'none', border: 'none', color: 'var(--color-text-secondary)',
                                fontSize: 8, cursor: 'pointer', flexShrink: 0, padding: 0,
                            }}
                        >
                            {isCollapsed ? '⊕' : '⊖'}
                        </button>
                    ) : !isMasterFixed ? (
                        <div style={{ width: 14, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <span style={{ fontSize: 7, color: track.color, opacity: 0.8 }}>
                                {track.type === 'midi' ? '♪' : '◉'}
                            </span>
                        </div>
                    ) : (
                        <div style={{ width: 14, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <span style={{ fontSize: 8, color: 'var(--color-text-secondary)' }}>▶</span>
                        </div>
                    )}

                    {/* Track Name / Rename Input */}
                    {isRenaming ? (
                        <input
                            ref={renameInputRef}
                            value={renameValue}
                            onChange={e => onRenameChange(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter') onRenameCommit();
                                if (e.key === 'Escape') onRenameCancel();
                            }}
                            onBlur={onRenameCommit}
                            onClick={e => e.stopPropagation()}
                            style={{
                                flex: 1, fontSize: 10, fontWeight: 500,
                                background: 'rgba(0,0,0,0.3)',
                                border: `1px solid ${track.color}`,
                                borderRadius: 3, color: '#fff',
                                padding: '1px 4px', outline: 'none', minWidth: 0,
                            }}
                        />
                    ) : (
                        <span style={{
                            flex: 1, fontSize: 10,
                            fontWeight: isGroup || isMasterFixed ? 700 : 500,
                            color: 'var(--color-text-primary)',
                            whiteSpace: 'nowrap', overflow: 'hidden',
                            textOverflow: 'ellipsis', minWidth: 0,
                        }}>
                            {track.name}
                        </span>
                    )}

                    {/* Track Number Badge */}
                    {displayNum !== undefined && (
                        <span style={{
                            width: 16, height: 14,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: track.color, color: '#fff',
                            borderRadius: 2, fontSize: 8, fontWeight: 700, flexShrink: 0,
                        }}>
                            {displayNum}
                        </span>
                    )}

                    {/* Stacked M / S buttons */}
                    {!isMaster && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
                            <button
                                onClick={e => { e.stopPropagation(); onToggleMute(); }}
                                title="Mute"
                                style={{
                                    width: 16, height: 12,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    background: track.isMuted ? '#e05050' : 'rgba(255,255,255,0.06)',
                                    color: track.isMuted ? '#fff' : 'var(--color-text-tertiary)',
                                    border: 'none', borderRadius: 2,
                                    fontSize: 7, fontWeight: 700, cursor: 'pointer', padding: 0,
                                }}
                            >M</button>
                            <button
                                onClick={e => { e.stopPropagation(); onToggleSolo(); }}
                                title="Solo"
                                style={{
                                    width: 16, height: 12,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    background: track.isSoloed ? 'var(--color-btn-solo)' : 'rgba(255,255,255,0.06)',
                                    color: track.isSoloed ? '#fff' : 'var(--color-text-tertiary)',
                                    border: 'none', borderRadius: 2,
                                    fontSize: 7, fontWeight: 700, cursor: 'pointer', padding: 0,
                                }}
                            >S</button>
                        </div>
                    )}

                    {/* Arm button */}
                    {!isMaster && !isGroup && (
                        <button
                            onClick={e => { e.stopPropagation(); onToggleArm(); }}
                            title="Arm for recording"
                            style={{
                                width: 14, height: 14,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: track.isArmed ? 'var(--color-btn-arm)' : 'transparent',
                                color: track.isArmed ? '#fff' : 'var(--color-text-tertiary)',
                                border: track.isArmed ? 'none' : '1px solid var(--color-control-border)',
                                borderRadius: '50%', fontSize: 7,
                                cursor: 'pointer', flexShrink: 0, padding: 0,
                            }}
                        >●</button>
                    )}

                    {/* VU Meter */}
                    {!isGroup && (
                        <div style={{
                            width: 4, height: 18,
                            background: 'rgba(255,255,255,0.06)',
                            borderRadius: 2, overflow: 'hidden',
                            flexShrink: 0, position: 'relative',
                        }}>
                            <div style={{
                                position: 'absolute', bottom: 0, left: 0, right: 0,
                                height: '100%',
                                background: vuColor(track.vuLevel, track.type === 'midi'),
                                transform: `scaleY(${vuNorm(track.vuLevel)})`,
                                transformOrigin: 'bottom',
                                transition: 'transform 80ms linear, background-color 120ms ease',
                                borderRadius: 2, willChange: 'transform',
                            }} />
                        </div>
                    )}

                    {/* Master label */}
                    {isMasterFixed && (
                        <span style={{
                            fontSize: 8, fontWeight: 600,
                            color: 'var(--color-text-tertiary)', flexShrink: 0,
                        }}>Main</span>
                    )}
                </div>

                {/* ── Row 2: Routing ── */}
                {showRouting && (
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: 4, paddingLeft: 14,
                    }}>
                        <span style={{ fontSize: 7, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>→</span>
                        <select
                            onClick={e => e.stopPropagation()}
                            value={outputValue}
                            onChange={(e) => {
                                e.stopPropagation();
                                // TODO: Backend set_track_routing command not yet implemented
                                console.warn('[TrackInspector] setTrackRouting: backend not implemented yet, track=', track.id, 'target=', e.target.value);
                            }}
                            title="Audio To"
                            style={routingSelectStyle}
                        >
                            <option value="master">Master</option>
                            {availableRoutingTargets.map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                        </select>
                        <span style={{ fontSize: 7, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>←</span>
                        <select
                            onClick={e => e.stopPropagation()}
                            value={inputValue}
                            onChange={(e) => {
                                e.stopPropagation();
                                // TODO: Backend set_track_input command not yet implemented
                                console.warn('[TrackInspector] setTrackInput: backend not implemented yet, track=', track.id, 'input=', e.target.value);
                            }}
                            title="Audio From"
                            style={routingSelectStyle}
                        >
                            <option value="none">No Input</option>
                            <option value="ext-1">Ext. In 1</option>
                            <option value="ext-2">Ext. In 2</option>
                            {availableRoutingTargets.map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                        </select>
                    </div>
                )}
            </div>
        </div>
    );
};

// ── Color Picker Popup (16-color grid) ──────────────────

const ColorPickerPopup = ({
    x, y, currentColor, onSelect, onDismiss,
}: {
    x: number; y: number;
    currentColor: string;
    onSelect: (color: string) => void;
    onDismiss: () => void;
}) => {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
        };
        const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [onDismiss]);

    const popupWidth = 148;
    const popupHeight = 160;
    const clampedX = Math.min(x, window.innerWidth - popupWidth - 8);
    const clampedY = Math.min(y, window.innerHeight - popupHeight - 8);

    return (
        <div ref={ref} style={{
            position: 'fixed', left: clampedX, top: clampedY, width: popupWidth,
            background: '#1e1e22', border: '1px solid var(--color-border-subtle)',
            borderRadius: 8, padding: 8, zIndex: 9999,
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}>
            <div style={{
                fontSize: 9, fontWeight: 600,
                color: 'var(--color-text-secondary)',
                textTransform: 'uppercase', letterSpacing: '0.05em',
                marginBottom: 6, textAlign: 'center',
            }}>Track Color</div>

            <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4,
            }}>
                {TRACK_PALETTE.map((c) => {
                    const isActive = currentColor.toLowerCase() === c.hex.toLowerCase();
                    return (
                        <button
                            key={c.hex}
                            title={c.name}
                            onClick={() => onSelect(c.hex)}
                            style={{
                                width: 28, height: 28, borderRadius: 6,
                                background: c.hex,
                                border: isActive ? '2px solid #fff' : '2px solid transparent',
                                cursor: 'pointer',
                                transition: 'transform 0.1s ease, border-color 0.15s ease',
                                boxShadow: isActive ? `0 0 6px ${c.hex}80` : 'none',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.1)'; }}
                            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
                        />
                    );
                })}
            </div>
        </div>
    );
};
