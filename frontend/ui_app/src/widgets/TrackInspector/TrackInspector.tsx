import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import * as engineApi from '@/shared/api/engine';


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
    const engineSetTrackVolume = useEngineStore((s) => s.setTrackVolume);
    const engineSetMasterVolume = useEngineStore((s) => s.setMasterVolume);
    const masterVolume = useEngineStore((s) => s.masterVolume);
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
            volume: masterVolume, pan: 0, isMuted: false, isSoloed: false, isArmed: false,
            vuLevel: masterVu, routing: '', sends: [], input: '', output: 'Main',
        };
    }, [meters, masterVolume]);

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
                void engineApi.armTrack(idx, newArmed).catch((err) => {
                    console.error('[TrackInspector] armTrack failed:', err);
                });
            }
            setLocalOverrides(prev => ({ ...prev, [id]: { ...prev[id], isArmed: newArmed } }));
        }
    }, [tracks, getTrackIndex]);

    const setTrackOutput = useCallback(async (trackId: string, targetId: string) => {
        try {
            await engineApi.setTrackRouting(trackId, targetId);
            setLocalOverrides(prev => ({ ...prev, [trackId]: { ...prev[trackId], output: targetId } }));
        } catch (err) {
            console.error('[TrackInspector] setTrackRouting failed:', err);
        }
    }, []);

    const setTrackInput = useCallback(async (trackId: string, inputId: string) => {
        try {
            await engineApi.setTrackInput(trackId, inputId);
            setLocalOverrides(prev => ({ ...prev, [trackId]: { ...prev[trackId], input: inputId } }));
        } catch (err) {
            console.error('[TrackInspector] setTrackInput failed:', err);
        }
    }, []);

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
        <div data-testid="track-inspector" style={{
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
                            onVolumeChange={(gain: number) => {
                                if (trackIndex >= 0) engineSetTrackVolume(trackIndex, gain);
                            }}
                            onOutputChange={(targetId) => { void setTrackOutput(track.id, targetId); }}
                            onInputChange={(inputId) => { void setTrackInput(track.id, inputId); }}
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
                onVolumeChange={(gain: number) => {
                    void engineSetMasterVolume(gain);
                }}
                onOutputChange={() => { }}
                onInputChange={() => { }}
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
            background: 'var(--surface-2)', border: '1px solid var(--color-border-subtle)',
            borderRadius: 8, padding: 4, zIndex: 9999,
            boxShadow: 'var(--shadow-panel)',
        }}>
            <button style={itemStyle} onClick={onRename}
                onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                <span style={{ width: 14, fontSize: 12 }}>✏️</span> Rename
            </button>
            <button style={itemStyle} onClick={onChangeColor}
                onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                <span style={{ width: 14, fontSize: 12 }}>🎨</span> Change Color
            </button>
            <div style={{ height: 1, background: 'var(--color-divider)', margin: '2px 8px' }} />
            <button style={{ ...itemStyle, color: '#ff6b6b' }} onClick={onDelete}
                onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-status-error) 18%, transparent)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                <span style={{ width: 14, fontSize: 12 }}>🗑</span> Delete Track
            </button>
        </div>
    );
};

// ── dB ↔ Linear conversions ──────────────────────────────

/** Linear gain (0..2) → dB. 0 gain → -Infinity. */
function gainToDb(gain: number): number {
    if (gain <= 0) return -Infinity;
    return 20 * Math.log10(gain);
}

/** dB → linear gain. Clamps to [0, ~+6 dB]. */
function dbToGain(db: number): number {
    if (!isFinite(db) || db <= -100) return 0;
    return Math.pow(10, db / 20);
}

/** Format dB for display. */
function formatDb(db: number): string {
    if (!isFinite(db) || db <= -60) return '-∞';
    if (Math.abs(db) < 0.05) return '0';
    return db > 0 ? `+${db.toFixed(1)}` : db.toFixed(1);
}

/** Fader position (0..1) → dB using quasi-log curve. 0 = -inf, ~0.77 = 0dB, 1 = +6dB */
function faderToDb(pos: number): number {
    if (pos <= 0) return -Infinity;
    if (pos >= 1) return 6;
    // Use a log-like curve: map 0..1 to -inf..+6
    // The 0 dB point sits at ~77% of the fader
    const zeroPt = 0.77;
    if (pos <= zeroPt) {
        // Map 0..zeroPt → -60..0 with a power curve
        const t = pos / zeroPt;
        const db = -60 * Math.pow(1 - t, 3);
        return Math.max(-60, db);
    } else {
        // Map zeroPt..1 → 0..+6 linearly
        const t = (pos - zeroPt) / (1 - zeroPt);
        return t * 6;
    }
}

/** dB → fader position (0..1), inverse of faderToDb. */
function dbToFader(db: number): number {
    if (!isFinite(db) || db <= -60) return 0;
    if (db >= 6) return 1;
    const zeroPt = 0.77;
    if (db <= 0) {
        // Inverse of: db = -60 * (1 - t)^3 where t = pos / zeroPt
        const ratio = Math.max(0, db / -60);
        const t = 1 - Math.pow(ratio, 1 / 3);
        return t * zeroPt;
    } else {
        // Inverse of: db = t * 6 where t = (pos - zeroPt) / (1 - zeroPt)
        return zeroPt + (db / 6) * (1 - zeroPt);
    }
}

// ── Volume Fader (horizontal blue slider) ─────────────────

const VolumeFader = ({
    volumeLinear,
    onVolumeChange,
}: {
    volumeLinear: number;
    onVolumeChange: (gain: number) => void;
}) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const activePointerId = useRef<number | null>(null);
    const db = gainToDb(volumeLinear);
    const faderPos = dbToFader(db);

    const applyFromEvent = useCallback((clientX: number) => {
        const el = trackRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const newDb = faderToDb(pos);
        onVolumeChange(dbToGain(newDb));
    }, [onVolumeChange]);

    const beginDrag = useCallback((clientX: number, pointerId?: number) => {
        setIsDragging(true);
        if (typeof pointerId === 'number') activePointerId.current = pointerId;
        applyFromEvent(clientX);
    }, [applyFromEvent]);

    const endDrag = useCallback(() => {
        setIsDragging(false);
        activePointerId.current = null;
        // Force-send final value without throttle.
        void useEngineStore.getState().flushTrackControlFinals();
    }, []);

    // Zero-dB tick position
    const zeroTickPos = dbToFader(0);

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
            <div
                ref={trackRef}
                onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                    beginDrag(e.clientX, e.pointerId);
                }}
                onPointerMove={(e) => {
                    if (!isDragging) return;
                    if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
                    applyFromEvent(e.clientX);
                }}
                onPointerUp={(e) => {
                    if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return;
                    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
                    endDrag();
                }}
                onPointerCancel={endDrag}
                onDoubleClick={(e) => {
                    e.stopPropagation();
                    onVolumeChange(1.0); /* reset to 0 dB */
                    void useEngineStore.getState().flushTrackControlFinals();
                }}
                style={{
                    position: 'relative', flex: 1, height: 6, minWidth: 40,
                    background: 'var(--surface-elevated)', borderRadius: 2, cursor: 'ew-resize',
                    overflow: 'hidden',
                    touchAction: 'none',
                }}
            >
                {/* Zero-dB tick mark */}
                <div style={{
                    position: 'absolute', left: `${zeroTickPos * 100}%`, top: 0, bottom: 0,
                    width: 1, background: 'var(--color-divider-light)', zIndex: 1,
                }} />
                {/* Fill */}
                <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: `${faderPos * 100}%`,
                    background: faderPos > zeroTickPos
                        ? 'linear-gradient(to right, var(--accent), var(--accent-strong))'
                        : 'var(--accent)',
                    borderRadius: 2,
                    transition: isDragging ? 'none' : 'width 60ms linear',
                }} />
                {/* Thumb */}
                <div style={{
                    position: 'absolute',
                    left: `calc(${faderPos * 100}% - 3px)`,
                    top: 0, width: 6, height: '100%',
                    background: 'var(--text-primary)', borderRadius: 1,
                    boxShadow: '0 0 3px color-mix(in srgb, var(--surface-1) 55%, #000)',
                    transition: isDragging ? 'none' : 'left 60ms linear',
                }} />
            </div>
            {/* dB label */}
            <span style={{
                fontSize: 8, fontWeight: 600, fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-secondary)', minWidth: 22, textAlign: 'right',
                flexShrink: 0, whiteSpace: 'nowrap',
            }}>
                {formatDb(db)}
            </span>
        </div>
    );
};

// ── Tri-Color VU Meter (vertical) ──────────────────────────

const TriColorVU = ({ peakDb, isMidi }: { peakDb: number; isMidi: boolean }) => {
    const normalizedLevel = vuNorm(peakDb); // 0..1
    const meterHeight = 32;
    const fillHeight = normalizedLevel * meterHeight;

    // Segment thresholds in normalized space
    const minus2Norm = vuNorm(-2);  // where -2 dB sits
    const zeroNorm = vuNorm(0);     // where 0 dB sits

    return (
        <div style={{
            width: 10, height: meterHeight,
            background: 'var(--surface-elevated)', borderRadius: 2,
            overflow: 'hidden', flexShrink: 0,
            position: 'relative',
            border: '1px solid color-mix(in srgb, var(--text-primary) 10%, transparent)',
            marginLeft: 2,
        }}>
            {/* Green segment: 0 to -2dB zone */}
            <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                height: `${minus2Norm * 100}%`,
                background: '#40cc5a',
                transform: `scaleY(${Math.min(1, fillHeight / (minus2Norm * meterHeight || 1))})`,
                transformOrigin: 'bottom',
                transition: 'transform 80ms linear',
            }} />
            {/* Yellow segment: -2dB to 0dB zone */}
            {normalizedLevel > minus2Norm && (
                <div style={{
                    position: 'absolute', left: 0, right: 0,
                    bottom: `${minus2Norm * 100}%`,
                    height: `${(zeroNorm - minus2Norm) * 100}%`,
                    background: isMidi ? '#ff9500' : '#ffcc00',
                    transform: `scaleY(${Math.min(1, Math.max(0, (fillHeight - minus2Norm * meterHeight) / ((zeroNorm - minus2Norm) * meterHeight || 1)))})`,
                    transformOrigin: 'bottom',
                    transition: 'transform 80ms linear',
                }} />
            )}
            {/* Red segment: above 0dB zone */}
            {normalizedLevel > zeroNorm && (
                <div style={{
                    position: 'absolute', left: 0, right: 0,
                    bottom: `${zeroNorm * 100}%`,
                    height: `${(1 - zeroNorm) * 100}%`,
                    background: '#ff3b30',
                    transform: `scaleY(${Math.min(1, Math.max(0, (fillHeight - zeroNorm * meterHeight) / ((1 - zeroNorm) * meterHeight || 1)))})`,
                    transformOrigin: 'bottom',
                    transition: 'transform 80ms linear',
                }} />
            )}
        </div>
    );
};

// ── TrackRow (3-block Ableton-style layout) ──────────────────────────────

const TrackRow = ({
    track, allTracks, trackHeight, displayNum, isSelected, isCollapsed, depth,
    isRenaming, renameValue, onRenameChange, onRenameCommit, onRenameCancel,
    onClick, onToggleMute, onToggleSolo, onToggleArm, onToggleCollapse,
    onVolumeChange, onOutputChange, onInputChange, onContextMenu, isMasterFixed,
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
    onVolumeChange?: (gain: number) => void;
    onOutputChange?: (targetId: string) => void;
    onInputChange?: (inputId: string) => void;
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

    const showRoutingExpanded = !isMasterFixed && trackHeight >= 48 && (isSelected || isHovered);
    const showRoutingCompact = !isMasterFixed && !showRoutingExpanded;

    // Subdue track visually when disabled (muted)
    const isEnabled = !track.isMuted;

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
                background: isSelected
                    ? 'color-mix(in srgb, var(--surface-2) 88%, #000)'
                    : isHovered
                        ? 'color-mix(in srgb, var(--surface-2) 76%, #000)'
                        : 'var(--surface-1)',
                cursor: 'default',
                opacity: isEnabled ? 1 : 0.45,
                transition: 'background 0.12s ease, opacity 0.12s ease',
                position: 'relative', paddingLeft: depth * 10, flexShrink: 0,
            }}
        >
            {/* ════ BLOCK 1: Track Header (colored) ════ */}
            <div style={{
                display: 'flex', flexDirection: 'column', justifyContent: 'center',
                minWidth: isMasterFixed ? 80 : 90, maxWidth: 120,
                padding: '2px 6px 2px 4px',
                background: `color-mix(in srgb, ${track.color} ${isSelected ? '90%' : isHovered ? '80%' : '70%'}, #1a1a1a)`,
                borderRight: '1px solid rgba(255,255,255,0.08)',
                gap: 1,
                position: 'relative',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    {/* Collapse / Group icon */}
                    {isGroup && onToggleCollapse ? (
                        <button
                            onClick={e => { e.stopPropagation(); onToggleCollapse(); }}
                            style={{
                                width: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: 'none', border: 'none', color: 'var(--text-primary)',
                                fontSize: 8, cursor: 'pointer', flexShrink: 0, padding: 0,
                            }}
                        >
                            {isCollapsed ? '▶' : '▼'}
                        </button>
                    ) : isMasterFixed ? (
                        <span style={{ fontSize: 8, color: 'var(--color-text-secondary)', flexShrink: 0, width: 10 }}>▶</span>
                    ) : null}

                    {/* Track Name */}
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
                                fontSize: 10, fontWeight: 600,
                                background: 'color-mix(in srgb, var(--surface-1) 72%, #000)',
                                border: `1px solid ${track.color}`,
                                borderRadius: 2, color: 'var(--text-primary)',
                                padding: '1px 3px', outline: 'none', minWidth: 0,
                            }}
                        />
                    ) : (
                        <span style={{
                            flex: 1, fontSize: 12,
                            fontWeight: isGroup || isMasterFixed ? 700 : 600,
                            color: 'var(--text-primary)',
                            whiteSpace: 'nowrap', overflow: 'hidden',
                            textOverflow: 'ellipsis', minWidth: 0,
                        }}>
                            {track.name}
                        </span>
                    )}
                </div>

                {/* Master label */}
                {isMasterFixed && (
                    <span style={{ fontSize: 9, color: 'var(--text-muted)', paddingLeft: 10 }}>Main</span>
                )}

                {/* ── Type Icon (absolute top-right) ── */}
                {!isMasterFixed && !isGroup && (
                    <span style={{
                        position: 'absolute',
                        top: 3,
                        right: 4,
                        display: 'inline-flex',
                        alignItems: 'center',
                        opacity: 0.55,
                    }}>
                        {track.type === 'midi' ? (
                            <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                                <rect x="0" y="1" width="3" height="10" rx="0.5" fill="#fff" />
                                <rect x="4.5" y="1" width="3" height="10" rx="0.5" fill="#fff" />
                                <rect x="9" y="1" width="3" height="10" rx="0.5" fill="#fff" />
                                <rect x="2" y="1" width="2" height="6" rx="0.3" fill="#1a1a1a" />
                                <rect x="6.5" y="1" width="2" height="6" rx="0.3" fill="#1a1a1a" />
                            </svg>
                        ) : (
                            <svg width="9" height="9" viewBox="0 0 14 10" fill="none">
                                <path d="M1 5 L2.5 2 L4 7 L5.5 1 L7 9 L8.5 3 L10 6 L11.5 4 L13 5" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        )}
                    </span>
                )}
            </div>

            {/* ════ BLOCK 2: Routing (gray) ════ */}
            {showRoutingExpanded && (
                <div style={{
                    display: 'flex', flexDirection: 'column', justifyContent: 'center',
                    gap: 2, padding: '2px 4px',
                    borderRight: '1px solid rgba(255,255,255,0.06)',
                    minWidth: 80,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <span style={{ fontSize: 6, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>→</span>
                        <select
                            onClick={e => e.stopPropagation()}
                            value={outputValue}
                            onChange={(e) => {
                                e.stopPropagation();
                                onOutputChange?.(e.target.value);
                            }}
                            title="Audio To"
                            style={{
                                fontSize: 10, fontWeight: 500,
                                color: 'var(--color-text-primary)',
                                background: 'var(--color-control-bg)',
                                border: '1px solid var(--color-control-border)',
                                borderRadius: 2, padding: '0px 2px', cursor: 'pointer',
                                maxWidth: 70, minWidth: 40, flexShrink: 0, flex: 1,
                                appearance: 'auto' as React.CSSProperties['appearance'],
                                lineHeight: '13px', height: 13,
                            }}
                        >
                            <option value="master">Master</option>
                            {availableRoutingTargets.map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                        </select>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <span style={{ fontSize: 6, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>←</span>
                        <select
                            onClick={e => e.stopPropagation()}
                            value={inputValue}
                            onChange={(e) => {
                                e.stopPropagation();
                                onInputChange?.(e.target.value);
                            }}
                            title="Audio From"
                            style={{
                                fontSize: 10, fontWeight: 500,
                                color: 'var(--color-text-primary)',
                                background: 'var(--color-control-bg)',
                                border: '1px solid var(--color-control-border)',
                                borderRadius: 2, padding: '0px 2px', cursor: 'pointer',
                                maxWidth: 70, minWidth: 40, flexShrink: 0, flex: 1,
                                appearance: 'auto' as React.CSSProperties['appearance'],
                                lineHeight: '13px', height: 13,
                            }}
                        >
                            <option value="none">No Input</option>
                            <option value="ext-1">Ext. In 1</option>
                            <option value="ext-2">Ext. In 2</option>
                            {availableRoutingTargets.map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                        </select>
                    </div>
                </div>
            )}

            {showRoutingCompact && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 64,
                    maxWidth: 76,
                    borderRight: '1px solid color-mix(in srgb, var(--surface-elevated) 72%, #000)',
                    color: 'var(--text-muted)',
                    fontSize: 9,
                    fontFamily: 'var(--font-mono)',
                }}>
                    {outputValue === 'master' ? '→M' : '→T'} · {inputValue === 'none' ? '←∅' : '←IN'}
                </div>
            )}

            {/* ════ BLOCK 3: Mixer (gray background) ════ */}
            <div style={{
                display: 'flex', alignItems: 'center',
                gap: 4, padding: '2px 8px 2px 4px', flex: 1, minWidth: 0,
                overflow: 'hidden',
                background: 'var(--surface-2)',
            }}>
                {/* Buttons column (vertical stack) */}
                {!isMaster && (
                    <div style={{
                        display: 'flex', flexDirection: 'column',
                        gap: 1, flexShrink: 0,
                    }}>
                        {/* Enable button — green when active, shows track number */}
                        <button
                            onClick={e => { e.stopPropagation(); onToggleMute(); }}
                            title={isEnabled ? 'Disable track' : 'Enable track'}
                            style={{
                                width: 20, height: 14,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: isEnabled ? 'var(--color-status-success)' : 'var(--surface-elevated)',
                                color: isEnabled ? 'var(--text-primary)' : 'var(--text-muted)',
                                border: 'none', borderRadius: 2,
                                fontSize: 8, fontWeight: 700, fontFamily: 'var(--font-mono)',
                                cursor: 'pointer',
                                padding: 0, transition: 'background 0.1s ease',
                            }}
                        >{displayNum ?? '●'}</button>
                        {/* Solo button */}
                        <button
                            onClick={e => { e.stopPropagation(); onToggleSolo(); }}
                            title="Solo"
                            style={{
                                width: 20, height: 14,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: track.isSoloed ? 'var(--color-btn-solo)' : 'var(--surface-elevated)',
                                color: track.isSoloed ? 'var(--text-primary)' : 'var(--text-muted)',
                                border: 'none', borderRadius: 2,
                                fontSize: 8, fontWeight: 700, cursor: 'pointer',
                                padding: 0, transition: 'background 0.1s ease',
                            }}
                        >S</button>
                        {!isGroup && (
                            <button
                                onClick={e => { e.stopPropagation(); onToggleArm(); }}
                                title="Arm for recording"
                                style={{
                                    width: 20, height: 14,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    background: track.isArmed ? 'var(--color-status-error)' : 'var(--surface-elevated)',
                                    color: track.isArmed ? 'var(--text-primary)' : 'var(--text-muted)',
                                    border: 'none', borderRadius: 2,
                                    fontSize: 8, fontWeight: 700, cursor: 'pointer',
                                    padding: 0, transition: 'background 0.1s ease',
                                }}
                            >R</button>
                        )}
                    </div>
                )}

                {/* Volume Fader — horizontal blue slider */}
                {!isGroup && onVolumeChange && (
                    <VolumeFader
                        volumeLinear={track.volume}
                        onVolumeChange={onVolumeChange}
                    />
                )}

                {/* Tri-Color VU Meter */}
                {!isGroup && (
                    <TriColorVU peakDb={track.vuLevel} isMidi={track.type === 'midi'} />
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
            background: '#1e1e1e', border: '1px solid var(--color-border-subtle)',
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
