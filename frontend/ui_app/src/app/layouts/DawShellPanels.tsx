import { useMemo, useState } from 'react';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { dbToMeterNorm } from '@/shared/lib/meterManifest';
import { getContrastColor } from '@/shared/lib/colorUtils';
import { isTrackActive } from '@/shared/utils/routing';
import { SessionIoRow, SessionSendRow, SessionStripFader, sessionClipTransportBtnStyle, sessionMixerBtnStyle } from './DawShellPanelControls';
import { SessionMasterScenes, SessionMasterStrip } from './DawShellPanelMaster';
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
    const setTrackSendLevel = useEngineStore((s) => s.setTrackSendLevel);
    const masterVolume = useEngineStore((s) => s.masterVolume);
    const setMasterVolume = useEngineStore((s) => s.setMasterVolume);
    const togglePlay = useEngineStore((s) => s.togglePlay);
    const isPlaying = useEngineStore((s) => s.transport.is_playing);
    const SESSION_TRACK_WIDTH = 120;
    const SESSION_MASTER_WIDTH = 110;
    const SESSION_SCENE_ROWS = 6;
    const scenes = useMemo(() => Array.from({ length: SESSION_SCENE_ROWS }, (_, i) => i), []);
    const [sessionClips, setSessionClips] = useState<Record<string, { id: string; name: string; color: string; looped: boolean }>>({});
    const [selectedSessionClipId, setSelectedSessionClipId] = useState<string | null>(null);
    const [playingSessionClipByTrack, setPlayingSessionClipByTrack] = useState<Record<string, string | null>>({});
    const [activeSceneIndex, setActiveSceneIndex] = useState<number | null>(null);

    const masterMeterL = meters.master_left;
    const masterMeterR = meters.master_right;
    const masterLevelL = dbToMeterNorm(masterMeterL?.peak ?? -60);
    const masterLevelR = dbToMeterNorm(masterMeterR?.peak ?? -60);
    const slotKey = (trackId: string, sceneIndex: number) => `${trackId}:${sceneIndex}`;

    const launchScene = (sceneIndex: number) => {
        setActiveSceneIndex(sceneIndex);
        setPlayingSessionClipByTrack((prev) => {
            const next: Record<string, string | null> = { ...prev };
            for (const track of tracks) {
                const clip = sessionClips[slotKey(track.id, sceneIndex)];
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
                const clip = sessionClips[slotKey(track.id, sceneIndex)];
                if (clip && next[track.id] === clip.id) next[track.id] = null;
            }
            return next;
        });
        setActiveSceneIndex((current) => (current === sceneIndex ? null : current));
    };

    return (
        <div style={{
            flex: 1,
            display: 'grid',
            gridTemplateRows: '1fr var(--token-size-px-170)',
            minWidth: 0,
            minHeight: 0,
            background: 'var(--color-bg-canvas)',
            borderLeft: 'var(--space-px) solid var(--color-divider)',
        }}>
            <div style={{ display: 'grid', gridTemplateColumns: `1fr ${SESSION_MASTER_WIDTH}px`, minHeight: 0, overflow: 'hidden' }}>
                <div style={{ overflow: 'auto', minHeight: 0 }}>
                    <div style={{ display: 'flex', minWidth: 'max-content', minHeight: '100%' }}>
                        {tracks.map((track) => {
                            const contrast = getContrastColor(track.color) === 'black'
                                ? 'var(--color-text-primary)'
                                : 'var(--color-bg-panel)';
                            const isSelectedTrack = selectedTrackId === track.id;
                            return (
                                <div key={track.id} style={{ width: SESSION_TRACK_WIDTH, borderRight: 'var(--space-px) solid var(--color-divider)', display: 'flex', flexDirection: 'column' }}>
                                    <button
                                        onClick={() => onSelectTrack(track.id)}
                                        style={{
                                            height: 28,
                                            border: 'none',
                                            borderBottom: 'var(--space-px) solid var(--color-overlay-medium)',
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
                                        const clip = sessionClips[slotKey(track.id, sceneIndex)] ?? null;
                                        const isSelected = clip ? selectedSessionClipId === clip.id : false;
                                        const clipText = clip
                                            ? (getContrastColor(clip.color) === 'black' ? 'var(--color-text-primary)' : 'var(--color-bg-panel)')
                                            : 'var(--color-text-tertiary)';
                                        const isPlayingClip = clip ? (playingSessionClipByTrack[track.id] === clip.id && isPlaying) : false;
                                        return (
                                            <div
                                                key={`${track.id}:${sceneIndex}`}
                                                onClick={() => onSelectTrack(track.id)}
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
                                                    borderBottom: 'var(--space-px) solid var(--token-color-hex-2a2a2a)',
                                                    borderRight: 'var(--space-px) solid var(--token-color-hex-262626)',
                                                    background: clip
                                                        ? clip.color
                                                        : 'color-mix(in srgb, var(--color-bg-panel) 90%, var(--token-color-hex-131313))',
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
                                                                    setActiveSceneIndex(sceneIndex);
                                                                    setPlayingSessionClipByTrack((prev) => ({
                                                                        ...prev,
                                                                        [track.id]: clip.id,
                                                                    }));
                                                                    if (!isPlaying) togglePlay();
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
                    activeSceneIndex={activeSceneIndex}
                    isPlaying={isPlaying}
                    launchScene={launchScene}
                    stopScene={stopScene}
                />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `1fr ${SESSION_MASTER_WIDTH}px`, minHeight: 0, overflow: 'hidden', borderTop: 'var(--space-px) solid var(--color-divider)', background: 'color-mix(in srgb, var(--color-bg-panel) 92%, var(--token-color-hex-0e0e0e))' }}>
                <div style={{ display: 'flex', minHeight: 0, overflowX: 'auto' }}>
                    {tracks.map((track, trackIndex) => {
                        const meterPair = meters.tracks[trackIndex];
                        const peakDbL = meterPair ? meterPair[0].peak : -60;
                        const peakDbR = meterPair ? meterPair[1].peak : -60;
                        const trackMeterL = dbToMeterNorm(peakDbL);
                        const trackMeterR = dbToMeterNorm(peakDbR);
                        const peakDb = Math.max(peakDbL, peakDbR);
                        const peakLabel = `${peakDb >= 0 ? '+' : ''}${peakDb.toFixed(1)} dB`;
                        const isActive = isTrackActive(trackIndex, tracks);
                        return (
                            <div key={`mix-${track.id}`} style={{
                                width: SESSION_TRACK_WIDTH,
                                borderRight: 'var(--space-px) solid var(--token-color-hex-2d2d2d)',
                                padding: 'var(--space-2) var(--space-1-5) var(--space-1-5)',
                                display: 'grid',
                                gridTemplateRows: 'auto auto auto auto auto 1fr auto',
                                gap: 4,
                                opacity: isActive ? 1 : 0.35,
                                filter: isActive ? 'none' : 'grayscale(0.9)',
                                transition: 'opacity 0.15s ease, filter 0.15s ease',
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
                                <SessionSendRow
                                    sendA={track.send_a ?? 0}
                                    sendB={track.send_b ?? 0}
                                    onChangeA={(next) => { void setTrackSendLevel(trackIndex, 'A', next); }}
                                    onChangeB={(next) => { void setTrackSendLevel(trackIndex, 'B', next); }}
                                />
                                <div style={{ display: 'flex', alignItems: 'stretch', gap: 6 }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
                                        <button
                                            style={sessionMixerBtnStyle(track.is_mute)}
                                            onClick={() => { void setTrackMute(trackIndex, !track.is_mute); }}
                                            title={track.is_mute ? 'Unmute track' : 'Mute track'}
                                        >
                                            <span style={{ width: 8, height: 1, background: 'currentColor', display: 'block' }} />
                                        </button>
                                        <button
                                            style={sessionMixerBtnStyle(track.is_solo)}
                                            onClick={() => { void setTrackSolo(trackIndex, !track.is_solo); }}
                                            title="Solo"
                                        >S</button>
                                        <button style={sessionMixerBtnStyle(track.is_armed)}>R</button>
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
                                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
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
