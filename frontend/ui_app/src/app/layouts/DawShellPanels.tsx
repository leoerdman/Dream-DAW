import { useMemo, useState } from 'react';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import * as engineApi from '@/shared/api/engine';
import { dbToMeterNorm } from '@/shared/lib/meterManifest';
import { getContrastColor } from '@/shared/lib/colorUtils';
import { SessionIoRow, SessionStripFader } from './DawShellPanelControls';
import { sessionClipTransportBtnStyle, sessionMixerBtnStyle } from './sessionPanelStyles';
import { SessionMasterScenes, SessionMasterStrip } from './DawShellPanelMaster';
import {
    SESSION_MASTER_WIDTH,
    SESSION_MIXER_HEIGHT_PX,
    SESSION_SCENE_ROWS,
    SESSION_TRACK_WIDTH,
} from './sessionWorkspace.constants';
export { EmptyClipEditor, SampleClipEditor } from './ClipEditors';

export const SessionWorkspace = ({
    tracks,
    selectedTrackId,
    onSelectTrack,
}: {
    tracks: ProjectTrack[];
    selectedTrackId: string;
    onSelectTrack: (trackId: string) => void;
}) => {
    const meters = useEngineStore((s) => s.meters);
    const setTrackMute = useEngineStore((s) => s.setTrackMute);
    const setTrackSolo = useEngineStore((s) => s.setTrackSolo);
    const setTrackVolume = useEngineStore((s) => s.setTrackVolume);
    const setTrackPan = useEngineStore((s) => s.setTrackPan);
    const applyProjectDeltas = useEngineStore((s) => s.applyProjectDeltas);
    const masterVolume = useEngineStore((s) => s.masterVolume);
    const setMasterVolume = useEngineStore((s) => s.setMasterVolume);
    const togglePlay = useEngineStore((s) => s.togglePlay);
    const isPlaying = useEngineStore((s) => s.transport.is_playing);
    const scenes = useMemo(() => Array.from({ length: SESSION_SCENE_ROWS }, (_, i) => i), []);
    const [sessionClips, setSessionClips] = useState<Record<string, { id: string; name: string; color: string; looped: boolean }>>({});
    const [selectedSessionClipId, setSelectedSessionClipId] = useState<string | null>(null);
    const [playingSessionClipByTrack, setPlayingSessionClipByTrack] = useState<Record<string, string | null>>({});

    const masterMeterL = meters.master_left;
    const masterMeterR = meters.master_right;
    const masterLevelL = dbToMeterNorm(masterMeterL?.peak ?? -60);
    const masterLevelR = dbToMeterNorm(masterMeterR?.peak ?? -60);
    const slotKey = (trackId: string, sceneIndex: number) => `${trackId}:${sceneIndex}`;
    const validTrackIds = useMemo(() => new Set(tracks.map((track) => track.id)), [tracks]);
    const sessionClipsSafe = useMemo(() => {
        const next: typeof sessionClips = {};
        for (const [key, clip] of Object.entries(sessionClips)) {
            const sep = key.indexOf(':');
            const trackId = sep >= 0 ? key.slice(0, sep) : key;
            if (!validTrackIds.has(trackId)) continue;
            next[key] = clip;
        }
        return next;
    }, [sessionClips, validTrackIds]);
    const playingSessionClipByTrackSafe = useMemo(() => {
        const next: typeof playingSessionClipByTrack = {};
        for (const [trackId, clipId] of Object.entries(playingSessionClipByTrack)) {
            if (!validTrackIds.has(trackId)) continue;
            next[trackId] = clipId;
        }
        return next;
    }, [playingSessionClipByTrack, validTrackIds]);

    const selectedSessionClipIdSafe = useMemo(() => {
        if (!selectedSessionClipId) return null;
        const exists = Object.values(sessionClipsSafe).some((clip) => clip.id === selectedSessionClipId);
        return exists ? selectedSessionClipId : null;
    }, [selectedSessionClipId, sessionClipsSafe]);

    const launchScene = (sceneIndex: number) => {
        setPlayingSessionClipByTrack((prev) => {
            const next: Record<string, string | null> = { ...prev };
            for (const track of tracks) {
                const clip = sessionClipsSafe[slotKey(track.id, sceneIndex)];
                next[track.id] = clip?.id ?? null;
            }
            return next;
        });
        if (!isPlaying) void togglePlay();
    };

    const stopScene = (sceneIndex: number) => {
        setPlayingSessionClipByTrack((prev) => {
            const next: Record<string, string | null> = { ...prev };
            for (const track of tracks) {
                const clip = sessionClipsSafe[slotKey(track.id, sceneIndex)];
                if (clip && next[track.id] === clip.id) next[track.id] = null;
            }
            return next;
        });
    };

    const activeScenes = useMemo(() => {
        const next = new Set<number>();
        if (!isPlaying) return next;
        for (let sceneIndex = 0; sceneIndex < SESSION_SCENE_ROWS; sceneIndex++) {
            let hasPlayingClip = false;
            for (const track of tracks) {
                const clip = sessionClipsSafe[slotKey(track.id, sceneIndex)];
                if (!clip) continue;
                if (playingSessionClipByTrackSafe[track.id] === clip.id) {
                    hasPlayingClip = true;
                    break;
                }
            }
            if (hasPlayingClip) next.add(sceneIndex);
        }
        return next;
    }, [isPlaying, playingSessionClipByTrackSafe, sessionClipsSafe, tracks]);

    return (
        <div style={{
            flex: 1,
            display: 'grid',
            gridTemplateRows: `1fr ${SESSION_MIXER_HEIGHT_PX}px`,
            minWidth: 0,
            minHeight: 0,
            background: 'var(--color-timeline-bg)',
            borderLeft: 'var(--space-px) solid var(--color-divider)',
        }}>
            <div style={{ display: 'grid', gridTemplateColumns: `1fr ${SESSION_MASTER_WIDTH}px`, minHeight: 0, overflow: 'hidden' }}>
                <div style={{ overflow: 'auto', minHeight: 0 }}>
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
                                            fontWeight: 'var(--font-weight-bold)' as unknown as number,
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
                                                    const id = `sess_${track.id}_${sceneIndex}_${Date.now()}`;
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
            <div style={{ display: 'grid', gridTemplateColumns: `1fr ${SESSION_MASTER_WIDTH}px`, minHeight: 0, overflow: 'hidden', borderTop: 'var(--space-px) solid var(--color-timeline-grid-line)', background: 'color-mix(in srgb, var(--color-bg-panel) 94%, var(--color-timeline-bg))' }}>
                <div style={{ display: 'flex', minHeight: 0, height: '100%', overflowX: 'auto', alignItems: 'stretch' }}>
                    {tracks.map((track, trackIndex) => {
                        const meterPair = meters.tracks[trackIndex];
                        const peakDbL = meterPair ? meterPair[0].peak : -60;
                        const peakDbR = meterPair ? meterPair[1].peak : -60;
                        const trackMeterL = dbToMeterNorm(peakDbL);
                        const trackMeterR = dbToMeterNorm(peakDbR);
                        const peakDb = Math.max(peakDbL, peakDbR);
                        const peakLabel = `${peakDb >= 0 ? '+' : ''}${peakDb.toFixed(1)} dB`;
                        return (
                            <div key={`mix-${track.id}`} style={{
                                width: SESSION_TRACK_WIDTH,
                                height: '100%',
                                borderRight: 'var(--space-px) solid var(--color-timeline-grid-line)',
                                padding: 'var(--space-2) var(--space-1-5) var(--space-1-5)',
                                display: 'grid',
                                gridTemplateRows: 'auto auto auto auto 1fr auto',
                                gap: 4,
                                background: 'color-mix(in srgb, var(--color-bg-panel) 96%, transparent)',
                            }}>
                                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontWeight: 'var(--font-weight-bold)' as unknown as number, textTransform: 'uppercase' }}>
                                    {track.track_type}
                                </div>
                                <SessionIoRow
                                    label="Audio From"
                                    value={track.input || 'No Input'}
                                />
                                <SessionIoRow
                                    label="Audio To"
                                    value={track.output || 'Master'}
                                />
                                <SessionIoRow
                                    label="Monitor"
                                    value={track.is_armed ? 'In' : 'Auto'}
                                />
                                <div style={{ display: 'flex', alignItems: 'stretch', gap: 6 }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
                                        <button
                                            type="button"
                                            style={sessionMixerBtnStyle(track.is_mute)}
                                            onClick={() => { void setTrackMute(trackIndex, !track.is_mute); }}
                                            title={track.is_mute ? 'Unmute track' : 'Mute track'}
                                        >
                                            <span style={{ width: 8, height: 1, background: 'currentColor', display: 'block' }} />
                                        </button>
                                        <button
                                            type="button"
                                            style={sessionMixerBtnStyle(track.is_solo)}
                                            onClick={() => { void setTrackSolo(trackIndex, !track.is_solo); }}
                                            title="Solo"
                                        >S</button>
                                        <button
                                            type="button"
                                            style={sessionMixerBtnStyle(track.is_armed)}
                                            onClick={() => {
                                                void engineApi
                                                    .armTrackWithDeltas(trackIndex, !track.is_armed)
                                                    .then((response) => applyProjectDeltas(response.deltas, 'session-arm-track'))
                                                    .catch((err) => {
                                                        console.error('[SessionWorkspace] Failed to arm track', err);
                                                    });
                                            }}
                                            title={track.is_armed ? 'Disarm track' : 'Arm track'}
                                        >
                                            R
                                        </button>
                                    </div>
                                    <SessionStripFader
                                        gain={track.volume}
                                        pan={track.pan}
                                        meterL={trackMeterL}
                                        meterR={trackMeterR}
                                        onGainChange={(nextGain) => { void setTrackVolume(trackIndex, nextGain); }}
                                        onPanChange={(nextPan) => { void setTrackPan(trackIndex, nextPan); }}
                                    />
                                </div>
                                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-role-data)' }}>
                                    {peakLabel}
                                </div>
                            </div>
                        );
                    })}
                </div>
                <SessionMasterStrip
                    width={SESSION_MASTER_WIDTH}
                    masterVolume={masterVolume}
                    masterLevelL={masterLevelL}
                    masterLevelR={masterLevelR}
                    setMasterVolume={setMasterVolume}
                />
            </div>
        </div >
    );
};
