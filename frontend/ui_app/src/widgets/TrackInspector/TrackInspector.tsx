import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import * as engineApi from '@/shared/api/engine';

/**
 * TrackInspector — Right-side panel showing all tracks.
 *
 * Ableton-style compact track rows with color stripe, VU meter,
 * Solo/Arm buttons, and a Master track pinned to the bottom edge.
 *
 * Features:
 *   • Master track fixed at bottom (not scrollable)
 *   • Right-click color picker with 16-color Ableton palette
 *   • Real-time VU meter bars from engine MeterBank
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
    index: number,
    meterPair?: [{ peak: number }, { peak: number }],
): TrackData {
    const peakL = meterPair?.[0]?.peak ?? -60;
    const peakR = meterPair?.[1]?.peak ?? -60;
    const peak = Math.max(peakL, peakR);
    return {
        id: pt.id,
        name: pt.name,
        type: pt.track_type as TrackData['type'],
        color: pt.color || TRACK_PALETTE[index % TRACK_PALETTE.length].hex,
        volume: pt.volume,
        pan: pt.pan,
        isMuted: pt.is_mute,
        isSoloed: pt.is_solo,
        isArmed: pt.is_armed ?? false,
        vuLevel: peak,
        routing: pt.output || 'Main',
        sends: [],
        input: pt.input || '',
        output: pt.output || 'Main',
    };
}

// ── VU Meter Helpers ──

/** Normalize a peak dB value (typically -60 to 0+) into 0..1 range for display.
 *  Values come from MeterBank as dB. Silence (-inf) maps to 0, 0 dBFS maps to 1. */
function vuNorm(peakDb: number): number {
    const minDb = -60;
    const maxDb = 0;
    const clamped = Math.max(minDb, Math.min(maxDb, peakDb));
    return (clamped - minDb) / (maxDb - minDb);
}

/** Returns color for the VU meter fill based on level and signal type.
 *  Audio: green → yellow → red   |   MIDI: amber → orange → red
 *  Mirrors Swift `SignalMeterView.colorSegments`. */
function vuColor(peakDb: number, isMidi: boolean): string {
    const n = vuNorm(peakDb);
    if (isMidi) {
        if (n > 0.90) return '#f24033'; // Red (clip)
        if (n > 0.70) return '#f28d26'; // Orange
        return '#f2bf33'; // Amber
    }
    if (n > 0.90) return '#f24033'; // Red (clip)
    if (n > 0.70) return '#f2cc26'; // Yellow
    return '#40cc5a'; // Green
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
    // Live tracks from the engine store
    const projectTracks = useEngineStore((s) => s.projectTracks);
    const engineSetTrackMute = useEngineStore((s) => s.setTrackMute);
    const engineSetTrackSolo = useEngineStore((s) => s.setTrackSolo);
    const addTrack = useEngineStore((s) => s.addTrack);
    const meters = useEngineStore((s) => s.meters);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Sync scroll position from Timeline
    useEffect(() => {
        if (scrollRef.current && externalScrollTop !== undefined) {
            scrollRef.current.scrollTop = externalScrollTop;
        }
    }, [externalScrollTop]);

    // Map ProjectTrack[] → TrackData[] (without Master — Master is separate)
    const liveTracks = useMemo((): TrackData[] => {
        return projectTracks.map((pt, idx) =>
            mapProjectTrack(pt, idx, meters.tracks[idx]),
        );
    }, [projectTracks, meters]);

    // Master track — always pinned to bottom, computed separately
    const masterTrack = useMemo((): TrackData => {
        const masterVu = Math.max(meters.master_left.peak, meters.master_right.peak);
        return {
            id: 'master',
            name: 'Master',
            type: 'master',
            color: '#666',
            volume: 0,
            pan: 0,
            isMuted: false,
            isSoloed: false,
            isArmed: false,
            vuLevel: masterVu,
            routing: '',
            sends: [],
            input: '',
            output: 'Main',
        };
    }, [meters]);

    // Local overrides for arm/mute/solo/color (merged with live data)
    const [localOverrides, setLocalOverrides] = useState<Record<string, Partial<TrackData>>>({});
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

    // Color picker state
    const [colorPickerState, setColorPickerState] = useState<{
        trackId: string;
        x: number;
        y: number;
    } | null>(null);

    // Merge live data with local UI overrides
    const tracks = useMemo(() => {
        return liveTracks.map(t => ({
            ...t,
            ...(localOverrides[t.id] || {}),
        }));
    }, [liveTracks, localOverrides]);

    // Helper: get engine track index from track id
    const getTrackIndex = useCallback((id: string): number => {
        return liveTracks.findIndex(t => t.id === id);
    }, [liveTracks]);

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
                engineApi.armTrack(idx, newArmed).catch(err =>
                    console.error('[TrackInspector] armTrack failed:', err)
                );
            }
            setLocalOverrides(prev => ({ ...prev, [id]: { ...prev[id], isArmed: newArmed } }));
        }
    }, [tracks, getTrackIndex]);

    const toggleGroupCollapse = useCallback((groupId: string) => {
        setCollapsedGroups(prev => {
            const next = new Set(prev);
            if (next.has(groupId)) next.delete(groupId);
            else next.add(groupId);
            return next;
        });
    }, []);

    // Build ancestor collapse check
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

    // Color picker handlers
    const handleContextMenu = useCallback((e: React.MouseEvent, trackId: string) => {
        e.preventDefault();
        e.stopPropagation();
        setColorPickerState({ trackId, x: e.clientX, y: e.clientY });
    }, []);

    const handleColorSelect = useCallback((trackId: string, color: string) => {
        setLocalOverrides(prev => ({ ...prev, [trackId]: { ...prev[trackId], color } }));
        setColorPickerState(null);
    }, []);

    const handleColorPickerDismiss = useCallback(() => {
        setColorPickerState(null);
    }, []);

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
            {/* ── Ruler spacer — aligns track rows below Timeline ruler ── */}
            <div style={{
                height: rulerHeight,
                flexShrink: 0,
                background: 'var(--color-bg-header)',
                borderBottom: '1px solid var(--color-divider)',
                display: 'flex',
                alignItems: 'center',
                paddingLeft: 8,
            }}>
                <span style={{
                    fontSize: 9,
                    fontWeight: 600,
                    color: 'var(--color-text-secondary)',
                    letterSpacing: '0.5px',
                    textTransform: 'uppercase',
                }}>
                    Tracks
                </span>
            </div>

            {/* ── Track List (scrollable, synced with Timeline) ── */}
            <div
                ref={scrollRef}
                className="scrollbar-hide"
                style={{
                    flex: 1,
                    overflowY: 'auto',
                    overflowX: 'hidden',
                }}
            >
                {visibleTracks.map((track) => {
                    const isGroup = track.type === 'group';
                    if (!isGroup) trackNum++;
                    const displayNum = isGroup ? undefined : trackNum;
                    const isCollapsed = isGroup ? collapsedGroups.has(track.id) : false;
                    const depth = getDepth(track);

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
                            onClick={() => onSelectTrack(track.id)}
                            onToggleMute={() => toggleMute(track.id)}
                            onToggleSolo={() => toggleSolo(track.id)}
                            onToggleArm={() => toggleArm(track.id)}
                            onToggleCollapse={isGroup ? () => toggleGroupCollapse(track.id) : undefined}
                            onContextMenu={(e) => handleContextMenu(e, track.id)}
                        />
                    );
                })}

                {/* ── Add Track Button ── */}
                <button
                    onClick={() => addTrack()}
                    style={{
                        width: '100%',
                        height: 32,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 4,
                        background: 'transparent',
                        border: 'none',
                        borderTop: '1px solid var(--color-divider)',
                        color: 'var(--color-text-tertiary)',
                        fontSize: 10,
                        fontWeight: 500,
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
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

            {/* ── Master Track — fixed at bottom (Ableton-style) ── */}
            <TrackRow
                track={masterTrack}
                allTracks={tracks}
                trackHeight={trackHeight}
                isSelected={selectedTrackId === 'master'}
                isCollapsed={false}
                depth={0}
                onClick={() => onSelectTrack('master')}
                onToggleMute={() => { }}
                onToggleSolo={() => { }}
                onToggleArm={() => { }}
                onContextMenu={() => { }}
                isMasterFixed
            />

            {/* ── Color Picker Popup ── */}
            {colorPickerState && (
                <ColorPickerPopup
                    x={colorPickerState.x}
                    y={colorPickerState.y}
                    currentColor={
                        (tracks.find(t => t.id === colorPickerState.trackId)?.color) || '#666'
                    }
                    onSelect={(color) => handleColorSelect(colorPickerState.trackId, color)}
                    onDismiss={handleColorPickerDismiss}
                />
            )}
        </div>
    );
};

// ── TrackRow (Ableton single-row, color-filled) ──────────────────

/** Shared style for routing select dropdowns (Audio To / Audio From). */
const routingSelectStyle: React.CSSProperties = {
    fontSize: 7,
    fontWeight: 500,
    color: 'var(--color-text-primary)',
    background: 'var(--color-control-bg)',
    border: '1px solid var(--color-control-border)',
    borderRadius: 2,
    padding: '0px 2px',
    cursor: 'pointer',
    maxWidth: 62,
    minWidth: 40,
    flexShrink: 0,
    appearance: 'auto' as React.CSSProperties['appearance'],
    lineHeight: '12px',
};

const TrackRow = ({
    track, allTracks, trackHeight, displayNum, isSelected, isCollapsed, depth,
    onClick, onToggleMute: _onToggleMute, onToggleSolo, onToggleArm, onToggleCollapse,
    onContextMenu,
    isMasterFixed,
}: {
    track: TrackData;
    allTracks: TrackData[];
    trackHeight: number;
    displayNum?: number;
    isSelected: boolean;
    isCollapsed: boolean;
    depth: number;
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
    const isChild = depth > 0;
    const [isHovered, setIsHovered] = useState(false);
    const availableRoutingTargets = allTracks.filter(t => t.id !== track.id && t.type !== 'master');
    const outputValue = track.output && (track.output === 'master' || availableRoutingTargets.some(t => t.id === track.output))
        ? track.output
        : 'master';
    const inputValue = track.input && (
        track.input === 'none' ||
        track.input === 'ext-1' ||
        track.input === 'ext-2' ||
        availableRoutingTargets.some(t => t.id === track.input)
    )
        ? track.input
        : 'none';
    const [outputRoute, setOutputRoute] = useState(outputValue);
    const [inputRoute, setInputRoute] = useState(inputValue);

    useEffect(() => {
        setOutputRoute(outputValue);
    }, [outputValue, track.id]);

    useEffect(() => {
        setInputRoute(inputValue);
    }, [inputValue, track.id]);

    // Automation store
    const toggleAutomation = useAutomationStore((s) => s.toggleTrackAutomation);
    const expandedTracks = useAutomationStore((s) => s.expandedTracks);
    const addLane = useAutomationStore((s) => s.addLane);
    const getLanesForTrack = useAutomationStore((s) => s.getLanesForTrack);
    const isAutoExpanded = expandedTracks.has(track.id);

    // Master fixed at bottom — distinct darker styling
    const masterBg = isSelected
        ? '#2a2a2e'
        : isHovered
            ? '#222226'
            : '#1a1a1e';

    // Ableton-style background: tinted with track color
    const bgColor = isMasterFixed
        ? masterBg
        : isSelected
            ? `color-mix(in srgb, ${track.color} 25%, var(--color-bg-panel))`
            : isHovered
                ? `color-mix(in srgb, ${track.color} 18%, var(--color-bg-panel))`
                : isChild || isGroup
                    ? `color-mix(in srgb, ${track.color} 15%, var(--color-bg-panel))`
                    : `color-mix(in srgb, ${track.color} 10%, var(--color-bg-panel))`;

    return (
        <div
            onClick={onClick}
            onContextMenu={onContextMenu}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            style={{
                display: 'flex',
                alignItems: 'center',
                height: trackHeight,
                borderBottom: isMasterFixed ? 'none' : '1px solid var(--color-divider)',
                borderTop: isMasterFixed ? '1px solid var(--color-divider)' : 'none',
                background: bgColor,
                cursor: 'default',
                opacity: track.isMuted ? 0.45 : 1,
                transition: 'background 0.12s ease, opacity 0.12s ease',
                position: 'relative',
                paddingLeft: depth * 10,
                flexShrink: 0,
            }}
        >
            {/* ── Color stripe (3px left edge) ── */}
            <div style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: 3,
                background: isMasterFixed
                    ? '#666'
                    : isSelected
                        ? track.color
                        : `color-mix(in srgb, ${track.color} 80%, transparent)`,
                borderRadius: '0 1px 1px 0',
            }} />

            {/* Content area with gap from stripe */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                flex: 1,
                gap: 3,
                paddingLeft: 6,
                paddingRight: 4,
                minWidth: 0,
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
                            color: isMasterFixed ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)',
                        }}>
                            {isMasterFixed ? '▶' : track.type === 'midi' ? '◉' : track.type === 'audio' ? '◉' : ''}
                        </span>
                    </div>
                )}

                {/* Track Name */}
                <span style={{
                    flex: 1,
                    fontSize: 10,
                    fontWeight: isGroup || isMasterFixed ? 700 : 400,
                    color: isGroup ? track.color : isMasterFixed ? 'var(--color-text-primary)' : 'var(--color-text-primary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    minWidth: 0,
                }}>
                    {track.name}
                </span>

                {/* ── Routing Selectors: Audio To / Audio From ── */}
                {!isMasterFixed && (
                    <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 1,
                        flexShrink: 0,
                    }}>
                        <span style={{ fontSize: 7, color: 'var(--color-text-tertiary)', lineHeight: '10px' }}>Audio To</span>
                        {/* Audio To (output routing) */}
                        <select
                            onClick={e => e.stopPropagation()}
                            value={outputRoute}
                            onChange={(e) => {
                                e.stopPropagation();
                                const targetId = e.target.value;
                                setOutputRoute(targetId);
                                engineApi.setTrackRouting(track.id, targetId).catch(err =>
                                    console.error('[TrackInspector] setTrackRouting failed:', err)
                                );
                            }}
                            title="Audio To"
                            style={routingSelectStyle}
                        >
                            <option value="master">→ Master</option>
                            {availableRoutingTargets.map(t => (
                                    <option key={t.id} value={t.id}>
                                        → {t.name}
                                    </option>
                            ))}
                        </select>
                        <span style={{ fontSize: 7, color: 'var(--color-text-tertiary)', lineHeight: '10px' }}>Audio From</span>
                        {/* Audio From (input routing) */}
                        <select
                            onClick={e => e.stopPropagation()}
                            value={inputRoute}
                            onChange={(e) => {
                                e.stopPropagation();
                                const inputId = e.target.value;
                                setInputRoute(inputId);
                                engineApi.setTrackInput(track.id, inputId).catch(err =>
                                    console.error('[TrackInspector] setTrackInput failed:', err)
                                );
                            }}
                            title="Audio From"
                            style={routingSelectStyle}
                        >
                            <option value="none">← No Input</option>
                            <option value="ext-1">← Ext. In 1</option>
                            <option value="ext-2">← Ext. In 2</option>
                            {availableRoutingTargets.map(t => (
                                    <option key={t.id} value={t.id}>
                                        ← {t.name}
                                    </option>
                            ))}
                        </select>
                    </div>
                )}

                {/* Master: show "Main" label instead of dropdown */}
                {isMasterFixed && (
                    <span style={{
                        fontSize: 8,
                        fontWeight: 600,
                        color: 'var(--color-text-tertiary)',
                        flexShrink: 0,
                    }}>
                        Main
                    </span>
                )}

                {/* VU Meter Bar — vertical signal level indicator */}
                {!isGroup && (
                    <div style={{
                        width: 4,
                        height: trackHeight - 8,
                        borderRadius: 2,
                        background: 'rgba(255,255,255,0.06)',
                        position: 'relative',
                        overflow: 'hidden',
                        flexShrink: 0,
                    }}>
                        {track.vuLevel > -59 && (
                            <div style={{
                                position: 'absolute',
                                bottom: 0,
                                left: 0,
                                right: 0,
                                height: `${Math.min(100, Math.max(0, vuNorm(track.vuLevel) * 100))}%`,
                                background: vuColor(track.vuLevel, track.type === 'midi'),
                                borderRadius: 2,
                                transition: 'height 0.06s linear',
                            }} />
                        )}
                    </div>
                )}

                {/* Track Number */}
                {displayNum !== undefined && (
                    <span style={{
                        width: 18,
                        height: 16,
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

                {/* Automation toggle button */}
                {!isMaster && !isGroup && (
                    <button
                        onClick={e => {
                            e.stopPropagation();
                            const trackId = track.id;
                            // Create default Volume lane if none exist
                            if (getLanesForTrack(trackId).length === 0) {
                                addLane(trackId, 'Volume', 'volume', track.color);
                            }
                            toggleAutomation(trackId);
                        }}
                        title="Toggle Automation"
                        style={{
                            width: 16, height: 16,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: isAutoExpanded ? '#58a6ff22' : 'transparent',
                            color: isAutoExpanded ? '#58a6ff' : 'var(--color-text-tertiary)',
                            border: isAutoExpanded ? '1px solid #58a6ff44' : '1px solid var(--color-control-border)',
                            borderRadius: 2,
                            fontSize: 8,
                            fontWeight: 700,
                            cursor: 'pointer',
                            flexShrink: 0,
                            transition: 'all 0.15s ease',
                        }}
                    >
                        A
                    </button>
                )}

                {/* Solo button */}
                {!isMaster && (
                    <button
                        onClick={e => { e.stopPropagation(); onToggleSolo(); }}
                        style={{
                            width: 16, height: 16,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: track.isSoloed ? 'var(--color-btn-solo)' : 'transparent',
                            color: track.isSoloed ? '#fff' : 'var(--color-text-secondary)',
                            border: 'none',
                            borderRadius: 2,
                            fontSize: 9,
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
                            width: 16, height: 16,
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
                        ●
                    </button>
                )}
            </div>
        </div>
    );
};

// ── Color Picker Popup (16-color grid) ──────────────────

const ColorPickerPopup = ({
    x, y, currentColor, onSelect, onDismiss,
}: {
    x: number;
    y: number;
    currentColor: string;
    onSelect: (color: string) => void;
    onDismiss: () => void;
}) => {
    const ref = useRef<HTMLDivElement>(null);

    // Dismiss on click outside or Escape
    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                onDismiss();
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onDismiss();
        };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [onDismiss]);

    // Clamp popup so it doesn't overflow the viewport
    const popupWidth = 148;
    const popupHeight = 160;
    const clampedX = Math.min(x, window.innerWidth - popupWidth - 8);
    const clampedY = Math.min(y, window.innerHeight - popupHeight - 8);

    return (
        <div
            ref={ref}
            style={{
                position: 'fixed',
                left: clampedX,
                top: clampedY,
                width: popupWidth,
                background: '#1e1e22',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 8,
                padding: 8,
                zIndex: 9999,
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            }}
        >
            {/* Title */}
            <div style={{
                fontSize: 9,
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginBottom: 6,
                textAlign: 'center',
            }}>
                Track Color
            </div>

            {/* 4×4 color grid */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 4,
            }}>
                {TRACK_PALETTE.map((c) => {
                    const isActive = currentColor.toLowerCase() === c.hex.toLowerCase();
                    return (
                        <button
                            key={c.hex}
                            title={c.name}
                            onClick={() => onSelect(c.hex)}
                            style={{
                                width: 28,
                                height: 28,
                                borderRadius: 6,
                                background: c.hex,
                                border: isActive ? '2px solid #fff' : '2px solid transparent',
                                cursor: 'pointer',
                                transition: 'transform 0.1s ease, border-color 0.15s ease',
                                boxShadow: isActive ? `0 0 6px ${c.hex}80` : 'none',
                            }}
                            onMouseEnter={e => {
                                e.currentTarget.style.transform = 'scale(1.15)';
                            }}
                            onMouseLeave={e => {
                                e.currentTarget.style.transform = 'scale(1)';
                            }}
                        />
                    );
                })}
            </div>
        </div>
    );
};
