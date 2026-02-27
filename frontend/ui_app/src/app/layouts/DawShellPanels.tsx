import { useState, useRef, useCallback, useEffect } from 'react';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { getContrastColor } from '@/shared/lib/colorUtils';
import { sessionClipTransportBtnStyle } from './sessionPanelStyles';
import { SessionMasterScenes, SessionMasterStrip } from './DawShellPanelMaster';
import { SessionWorkspaceMixerTracks } from './SessionWorkspaceMixerTracks';
import {
    SESSION_MASTER_WIDTH,
    SESSION_MIXER_HEIGHT_PX,
    SESSION_TRACK_WIDTH,
} from './sessionWorkspace.constants';
import { useSessionWorkspaceState } from './model/useSessionWorkspaceState';
export { EmptyClipEditor, SampleClipEditor } from './ClipEditors';

function makeSessionClipId(trackId: string, sceneIndex: number): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `sess_${trackId}_${sceneIndex}_${crypto.randomUUID()}`;
    }
    return `sess_${trackId}_${sceneIndex}_${Date.now()}`;
}

export const SessionWorkspace = ({
    tracks,
    selectedTrackId,
    onSelectTrack,
}: {
    tracks: ProjectTrack[];
    selectedTrackId: string;
    onSelectTrack: (trackId: string) => void;
}) => {
    const setTrackDisabled = useEngineStore((s) => s.setTrackDisabled);
    const setTrackSolo = useEngineStore((s) => s.setTrackSolo);
    const setTrackVolume = useEngineStore((s) => s.setTrackVolume);
    const setTrackPan = useEngineStore((s) => s.setTrackPan);
    const applyProjectDeltas = useEngineStore((s) => s.applyProjectDeltas);
    const masterVolume = useEngineStore((s) => s.masterVolume);
    const setMasterVolume = useEngineStore((s) => s.setMasterVolume);
    const togglePlay = useEngineStore((s) => s.togglePlay);
    const isPlaying = useEngineStore((s) => s.transport.is_playing);
    const {
        scenes,
        slotKey,
        sessionClipsSafe,
        selectedSessionClipIdSafe,
        playingSessionClipByTrackSafe,
        setSessionClips,
        setSelectedSessionClipId,
        setPlayingSessionClipByTrack,
        launchScene,
        stopScene,
        activeScenes,
    } = useSessionWorkspaceState(tracks, isPlaying, togglePlay);

    const [mixerHeight, setMixerHeight] = useState(() => {
        const saved = localStorage.getItem('dream_daw_session_mixer_height');
        return saved ? parseInt(saved, 10) : SESSION_MIXER_HEIGHT_PX;
    });
    const resizeRef = useRef<{ startY: number; startH: number } | null>(null);
    const [draggingMixerEdge, setDraggingMixerEdge] = useState(false);

    // ── Horizontal scroll synchronization ──
    // Session clips (top) and mixer tracks (bottom) must scroll as one unit.
    const sessionScrollRef = useRef<HTMLDivElement>(null);
    const mixerScrollRef = useRef<HTMLDivElement>(null);
    const isSyncingRef = useRef(false);

    const syncScroll = useCallback((source: 'session' | 'mixer') => {
        if (isSyncingRef.current) return;
        isSyncingRef.current = true;
        const from = source === 'session' ? sessionScrollRef.current : mixerScrollRef.current;
        const to = source === 'session' ? mixerScrollRef.current : sessionScrollRef.current;
        if (from && to) {
            to.scrollLeft = from.scrollLeft;
        }
        // Use rAF to break the re-entrant scroll event cycle
        requestAnimationFrame(() => { isSyncingRef.current = false; });
    }, []);

    const onSessionScroll = useCallback(() => syncScroll('session'), [syncScroll]);
    const onMixerScroll = useCallback(() => syncScroll('mixer'), [syncScroll]);

    // Attach scroll listeners
    useEffect(() => {
        const sessionEl = sessionScrollRef.current;
        const mixerEl = mixerScrollRef.current;
        if (sessionEl) sessionEl.addEventListener('scroll', onSessionScroll, { passive: true });
        if (mixerEl) mixerEl.addEventListener('scroll', onMixerScroll, { passive: true });
        return () => {
            if (sessionEl) sessionEl.removeEventListener('scroll', onSessionScroll);
            if (mixerEl) mixerEl.removeEventListener('scroll', onMixerScroll);
        };
    }, [onSessionScroll, onMixerScroll]);

    return (
        <div style={{
            flex: 1,
            display: 'grid',
            gridTemplateRows: `1fr ${mixerHeight}px`,
            minWidth: 0,
            minHeight: 0,
            background: 'var(--color-timeline-bg)',
            borderLeft: 'var(--space-px) solid var(--color-divider)',
        }}>
            <div style={{ display: 'grid', gridTemplateColumns: `1fr ${SESSION_MASTER_WIDTH}px`, minHeight: 0, overflow: 'hidden' }}>
                <div ref={sessionScrollRef} style={{ overflow: 'auto', minHeight: 0 }}>
                    <div style={{ display: 'flex', minWidth: 'max-content', minHeight: '100%' }}>
                        {tracks.map((track) => {
                            const contrast = getContrastColor(track.color) === 'black'
                                ? 'color-mix(in srgb, var(--color-text-primary) 92%, transparent)'
                                : 'color-mix(in srgb, var(--color-text-on-accent) 96%, transparent)';
                            const isSelectedTrack = selectedTrackId === track.id;
                            return (
                                <div key={track.id} style={{ width: SESSION_TRACK_WIDTH, borderRight: 'var(--space-px) solid var(--color-timeline-grid-line)', display: 'flex', flexDirection: 'column' }}>
                                    <button
                                        type="button"
                                        onClick={() => onSelectTrack(track.id)}
                                        style={{
                                            height: 28,
                                            border: 'none',
                                            borderBottom: 'var(--space-px) solid var(--color-timeline-grid-bar)',
                                            background: track.color,
                                            color: contrast,
                                            fontSize: 'var(--font-size-sm)',
                                            fontWeight: 'var(--font-weight-bold)',
                                            textAlign: 'left',
                                            padding: '0 var(--space-2)',
                                            boxShadow: isSelectedTrack ? 'inset 0 0 0 var(--space-0-5) color-mix(in srgb, var(--color-accent-primary) 64%, transparent)' : 'none',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        {track.name}
                                    </button>
                                    {scenes.map((sceneIndex) => {
                                        const clip = sessionClipsSafe[slotKey(track.id, sceneIndex)] ?? null;
                                        const isSelected = clip ? selectedSessionClipIdSafe === clip.id : false;
                                        const clipText = clip
                                            ? (getContrastColor(clip.color) === 'black'
                                                ? 'color-mix(in srgb, var(--color-text-primary) 92%, transparent)'
                                                : 'color-mix(in srgb, var(--color-text-on-accent) 96%, transparent)')
                                            : 'var(--color-text-tertiary)';
                                        const isPlayingClip = clip ? (playingSessionClipByTrackSafe[track.id] === clip.id && isPlaying) : false;
                                        return (
                                            <div
                                                key={`${track.id}:${sceneIndex}`}
                                                onClick={() => {
                                                    onSelectTrack(track.id);
                                                    if (clip) setSelectedSessionClipId(clip.id);
                                                }}
                                                onDoubleClick={() => {
                                                    if (clip) return;
                                                    const id = makeSessionClipId(track.id, sceneIndex);
                                                    setSessionClips((prev) => ({
                                                        ...prev,
                                                        [slotKey(track.id, sceneIndex)]: {
                                                            id,
                                                            name: 'MIDI Loop',
                                                            color: track.color,
                                                            looped: true,
                                                        },
                                                    }));
                                                    setSelectedSessionClipId(id);
                                                }}
                                                style={{
                                                    height: 26,
                                                    border: 'none',
                                                    borderBottom: 'var(--space-px) solid var(--color-timeline-grid-line)',
                                                    borderRight: 'var(--space-px) solid var(--color-timeline-grid-line)',
                                                    background: clip
                                                        ? clip.color
                                                        : 'color-mix(in srgb, var(--color-timeline-track-default) 92%, var(--color-timeline-bg))',
                                                    color: clipText,
                                                    fontSize: 'var(--font-size-xs)',
                                                    fontWeight: clip ? 600 : 500,
                                                    textAlign: 'left',
                                                    padding: clip ? '0 var(--space-1-5)' : '0 var(--space-2)',
                                                    cursor: 'pointer',
                                                    boxShadow: isSelected ? 'inset 0 0 0 var(--space-0-5) color-mix(in srgb, var(--color-accent-primary) 70%, transparent)' : 'none',
                                                    opacity: clip ? 1 : 0.72,
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'space-between',
                                                    transition: 'background 90ms linear, box-shadow 90ms linear, opacity 90ms linear',
                                                }}
                                            >
                                                {clip ? (
                                                    <>
                                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 70 }}>
                                                            {clip.name}
                                                        </span>
                                                        <div style={{ display: 'flex', gap: 4 }}>
                                                            <button
                                                                type="button"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    setSelectedSessionClipId(clip.id);
                                                                    setPlayingSessionClipByTrack((prev) => ({
                                                                        ...prev,
                                                                        [track.id]: clip.id,
                                                                    }));
                                                                    if (!isPlaying) void togglePlay();
                                                                }}
                                                                style={sessionClipTransportBtnStyle(isPlayingClip)}
                                                                title="Play Clip"
                                                            >
                                                                ▶
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    setSelectedSessionClipId(clip.id);
                                                                    setPlayingSessionClipByTrack((prev) => ({
                                                                        ...prev,
                                                                        [track.id]: null,
                                                                    }));
                                                                }}
                                                                style={sessionClipTransportBtnStyle(false)}
                                                                title="Stop Clip"
                                                            >
                                                                ■
                                                            </button>
                                                        </div>
                                                    </>
                                                ) : null}
                                            </div>
                                        );
                                    })}
                                </div>
                            );
                        })}
                    </div>
                </div>
                <SessionMasterScenes
                    width={SESSION_MASTER_WIDTH}
                    scenes={scenes}
                    activeScenes={activeScenes}
                    isPlaying={isPlaying}
                    launchScene={launchScene}
                    stopScene={stopScene}
                />
            </div>
            <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: `1fr ${SESSION_MASTER_WIDTH}px`, minHeight: 0, overflow: 'hidden', borderTop: 'var(--space-px) solid var(--color-timeline-grid-line)', background: 'color-mix(in srgb, var(--color-bg-panel) 94%, var(--color-timeline-bg))' }}>
                <div
                    onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        resizeRef.current = { startY: e.clientY, startH: mixerHeight };
                        setDraggingMixerEdge(true);
                    }}
                    onPointerMove={(e) => {
                        if (!draggingMixerEdge || !resizeRef.current) return;
                        const deltaY = resizeRef.current.startY - e.clientY;
                        let newH = resizeRef.current.startH + deltaY;
                        newH = Math.max(150, Math.min(newH, window.innerHeight - 150));
                        setMixerHeight(newH);
                    }}
                    onPointerUp={(e) => {
                        if (!draggingMixerEdge) return;
                        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                            e.currentTarget.releasePointerCapture(e.pointerId);
                        }
                        if (resizeRef.current) {
                            const deltaY = resizeRef.current.startY - e.clientY;
                            let newH = resizeRef.current.startH + deltaY;
                            newH = Math.max(150, Math.min(newH, window.innerHeight - 150));
                            localStorage.setItem('dream_daw_session_mixer_height', newH.toString());
                        }
                        resizeRef.current = null;
                        setDraggingMixerEdge(false);
                    }}
                    onPointerCancel={(e) => {
                        if (!draggingMixerEdge) return;
                        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                            e.currentTarget.releasePointerCapture(e.pointerId);
                        }
                        resizeRef.current = null;
                        setDraggingMixerEdge(false);
                    }}
                    style={{
                        position: 'absolute',
                        top: -3,
                        left: 0,
                        right: 0,
                        height: 6,
                        cursor: 'ns-resize',
                        zIndex: 10,
                        background: draggingMixerEdge ? 'var(--color-accent-primary)' : 'transparent',
                        transition: 'background 0.1s linear',
                    }}
                />
                <div ref={mixerScrollRef} style={{ overflow: 'auto', minHeight: 0 }}>
                    <SessionWorkspaceMixerTracks
                        tracks={tracks}
                        applyProjectDeltas={applyProjectDeltas}
                        setTrackDisabled={setTrackDisabled}
                        setTrackSolo={setTrackSolo}
                        setTrackVolume={setTrackVolume}
                        setTrackPan={setTrackPan}
                    />
                </div>
                <SessionMasterStrip
                    width={SESSION_MASTER_WIDTH}
                    masterVolume={masterVolume}
                    setMasterVolume={setMasterVolume}
                />
            </div>
        </div >
    );
};
