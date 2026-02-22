import { useMemo, useState, type CSSProperties } from 'react';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { dbToMeterNorm } from '@/shared/lib/meterManifest';
import { getContrastColor } from '@/shared/lib/colorUtils';
import { isTrackActive } from '@/shared/utils/routing';
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
    const togglePlay = useEngineStore((s) => s.togglePlay);
    const isPlaying = useEngineStore((s) => s.transport.is_playing);
    const SESSION_TRACK_WIDTH = 116;
    const SESSION_MASTER_WIDTH = 104;
    const SESSION_SCENE_ROWS = 3;
    const scenes = useMemo(() => Array.from({ length: SESSION_SCENE_ROWS }, (_, i) => i), []);
    const [sessionClips, setSessionClips] = useState<Record<string, { id: string; name: string; color: string; looped: boolean }>>({});
    const [selectedSessionClipId, setSelectedSessionClipId] = useState<string | null>(null);
    const [playingSessionClipId, setPlayingSessionClipId] = useState<string | null>(null);

    const masterMeterL = meters.master_left;
    const masterMeterR = meters.master_right;
    const masterLevelL = dbToMeterNorm(masterMeterL?.peak ?? -60);
    const masterLevelR = dbToMeterNorm(masterMeterR?.peak ?? -60);

    return (
        <div style={{
            flex: 1,
            display: 'grid',
            gridTemplateRows: '1fr 170px',
            minWidth: 0,
            minHeight: 0,
            background: 'var(--color-bg-canvas)',
            borderLeft: '1px solid var(--color-divider)',
        }}>
            <div style={{ display: 'grid', gridTemplateColumns: `1fr ${SESSION_MASTER_WIDTH}px`, minHeight: 0, overflow: 'hidden' }}>
                <div style={{ overflow: 'auto', minHeight: 0 }}>
                    <div style={{ display: 'flex', minWidth: 'max-content', minHeight: '100%' }}>
                        {tracks.map((track) => {
                            const slotKey = (sceneIndex: number) => `${track.id}:${sceneIndex}`;
                            const contrast = getContrastColor(track.color) === 'black'
                                ? 'var(--color-text-primary)'
                                : 'var(--color-bg-panel)';
                            const isSelectedTrack = selectedTrackId === track.id;
                            return (
                                <div key={track.id} style={{ width: SESSION_TRACK_WIDTH, borderRight: '1px solid var(--color-divider)', display: 'flex', flexDirection: 'column' }}>
                                    <button
                                        onClick={() => onSelectTrack(track.id)}
                                        style={{
                                            height: 28,
                                            border: 'none',
                                            borderBottom: '1px solid var(--color-overlay-medium)',
                                            background: track.color,
                                            color: contrast,
                                            fontSize: 'var(--font-size-sm)',
                                            fontWeight: 'var(--font-weight-bold)' as unknown as number,
                                            textAlign: 'left',
                                            padding: '0 8px',
                                            boxShadow: isSelectedTrack ? 'inset 0 0 0 2px color-mix(in srgb, var(--color-accent-primary) 64%, transparent)' : 'none',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        {track.name}
                                    </button>
                                    {scenes.map((sceneIndex) => {
                                        const clip = sessionClips[slotKey(sceneIndex)] ?? null;
                                        const isSelected = clip ? selectedSessionClipId === clip.id : false;
                                        const clipText = clip
                                            ? (getContrastColor(clip.color) === 'black' ? 'var(--color-text-primary)' : 'var(--color-bg-panel)')
                                            : 'var(--color-text-tertiary)';
                                        const isPlayingClip = clip ? playingSessionClipId === clip.id && isPlaying : false;
                                        return (
                                            <div
                                                key={`${track.id}:${sceneIndex}`}
                                                onClick={() => onSelectTrack(track.id)}
                                                onDoubleClick={() => {
                                                    if (clip) return;
                                                    const id = `sess_${track.id}_${sceneIndex}_${Date.now()}`;
                                                    setSessionClips((prev) => ({
                                                        ...prev,
                                                        [slotKey(sceneIndex)]: {
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
                                                    borderBottom: '1px solid #2a2a2a',
                                                    borderRight: '1px solid #262626',
                                                    background: clip
                                                        ? clip.color
                                                        : 'color-mix(in srgb, var(--color-bg-panel) 90%, #131313)',
                                                    color: clipText,
                                                    fontSize: 'var(--font-size-xs)',
                                                    fontWeight: clip ? 600 : 500,
                                                    textAlign: 'left',
                                                    padding: clip ? '0 6px' : '0 8px',
                                                    cursor: 'pointer',
                                                    boxShadow: isSelected ? 'inset 0 0 0 2px color-mix(in srgb, var(--color-accent-primary) 70%, transparent)' : 'none',
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
                                                                    setPlayingSessionClipId(clip.id);
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
                                                                    setPlayingSessionClipId(null);
                                                                    if (isPlaying) togglePlay();
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
                <div style={{ width: SESSION_MASTER_WIDTH, borderLeft: '1px solid var(--color-divider)', background: 'var(--color-bg-panel)' }}>
                    <div style={{
                        height: 28,
                        borderBottom: '1px solid var(--color-overlay-medium)',
                        background: 'var(--color-bg-header)',
                        color: 'var(--color-text-primary)',
                        fontSize: 'var(--font-size-sm)',
                        fontWeight: 800,
                        display: 'flex',
                        alignItems: 'center',
                        padding: '0 8px',
                    }}>
                        Master
                    </div>
                    {scenes.map((_, i) => (
                        <div key={`master-scene-${i}`} style={{ height: 26, borderBottom: '1px solid #2a2a2a' }} />
                    ))}
                </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `1fr ${SESSION_MASTER_WIDTH}px`, minHeight: 0, overflow: 'hidden', borderTop: '1px solid var(--color-divider)', background: 'color-mix(in srgb, var(--color-bg-panel) 92%, #0e0e0e)' }}>
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
                                width: SESSION_TRACK_WIDTH, borderRight: '1px solid #2d2d2d', padding: '8px 8px 6px', display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 6,
                                opacity: isActive ? 1 : 0.35,
                                filter: isActive ? 'none' : 'grayscale(0.9)',
                                transition: 'opacity 0.15s ease, filter 0.15s ease',
                            }}>
                                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontWeight: 'var(--font-weight-bold)' as unknown as number, textTransform: 'uppercase' }}>
                                    {track.track_type}
                                </div>
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
                                    <div style={{
                                        flex: 1,
                                        minHeight: 82,
                                        borderRadius: 'var(--radius-xs)',
                                        border: '1px solid #3d3d3d',
                                        background: 'var(--color-bg-canvas)',
                                        position: 'relative',
                                        overflow: 'hidden',
                                    }}>
                                        {/* Stereo meter: unified MeterStrip */}
                                        <MeterStrip
                                            levelL={trackMeterL}
                                            levelR={trackMeterR}
                                            width={8}
                                            style={{ position: 'absolute', inset: 4 }}
                                        />
                                    </div>
                                </div>
                                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                                    {peakLabel}
                                </div>
                            </div>
                        );
                    })}
                </div>
                <div style={{ width: SESSION_MASTER_WIDTH, padding: '8px 8px 6px', borderLeft: '1px solid #3b3b3b', display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 6 }}>
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontWeight: 700 }}>MASTER</div>
                    <div style={{ position: 'relative', border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-base)' }}>
                        {/* Stereo master: unified MeterStrip */}
                        <MeterStrip
                            levelL={masterLevelL}
                            levelR={masterLevelR}
                            width={8}
                            style={{ position: 'absolute', inset: 2 }}
                        />
                    </div>
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>Out</div>
                </div>
            </div>
        </div >
    );
};

const sessionMixerBtnStyle = (active: boolean): CSSProperties => ({
    minWidth: 24,
    height: 18,
    borderRadius: 'var(--radius-sm)',
    border: active ? '1px solid color-mix(in srgb, var(--color-accent-primary) 55%, transparent)' : '1px solid #4b4b4b',
    background: active ? 'var(--color-accent-primary-dim)' : 'var(--color-bg-header)',
    color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 'var(--font-weight-bold)' as unknown as number,
    cursor: 'default',
});

const sessionClipTransportBtnStyle = (active: boolean): CSSProperties => ({
    minWidth: 16,
    height: 14,
    borderRadius: 'var(--radius-sm)',
    border: active ? '1px solid color-mix(in srgb, var(--color-accent-primary) 50%, transparent)' : '1px solid var(--color-overlay-medium)',
    background: active ? 'color-mix(in srgb, var(--color-text-bright) 25%, transparent)' : 'var(--color-overlay-dark)',
    color: active ? 'var(--color-text-bright)' : 'color-mix(in srgb, var(--color-text-bright) 90%, transparent)',
    fontSize: 'var(--font-size-2xs)',
    fontWeight: 'var(--font-weight-bold)' as unknown as number,
    lineHeight: 1,
    padding: 0,
    cursor: 'pointer',
});
