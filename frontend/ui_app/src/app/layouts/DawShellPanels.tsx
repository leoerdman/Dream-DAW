import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ClipRenderer } from '@/widgets/Timeline/ClipRenderer';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import * as engineApi from '@/shared/api/engine';
import { divisionToInterval } from '@/shared/lib/gridSnap';
import { beatDurationToFrames, frameToBeat, resolveSampleRate } from '@/shared/lib/audioMath';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { dbToMeterNorm } from '@/shared/lib/meterManifest';
import { getContrastColor } from '@/shared/lib/colorUtils';
import { isTrackActive } from '@/shared/utils/routing';
import { ClipEditorShell } from '@/widgets/ClipEditor/ClipEditorShell';
import { ClipEditorMetaRow, ClipEditorSection, ClipEditorSidebar } from '@/widgets/ClipEditor/ClipEditorSidebar';

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


export const EmptyClipEditor = () => (
    <div style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'radial-gradient(circle at 50% 20%, color-mix(in srgb, var(--color-bg-panel) 88%, #2a3a55) 0%, var(--color-bg-panel) 66%)',
    }}>
        <div style={{
            textAlign: 'center',
            padding: '18px 26px',
            border: '1px solid color-mix(in srgb, var(--color-accent-primary) 24%, var(--color-divider))',
            borderRadius: 'var(--radius-xl)',
            background: 'color-mix(in srgb, var(--color-bg-header) 86%, #0a111f)',
            boxShadow: '0 10px 24px var(--color-overlay-dark)',
            maxWidth: 520,
        }}>
            <div style={{
                color: 'var(--color-text-primary)',
                fontSize: 'var(--font-size-2xl)',
                fontWeight: 'var(--font-weight-bold)' as unknown as number,
                letterSpacing: '0.03em',
                marginBottom: 6,
            }}>
                No Clip Selected
            </div>
            <div style={{
                color: 'var(--color-text-secondary)',
                fontSize: 'var(--font-size-base)',
                lineHeight: 1.5,
            }}>
                Select a MIDI or audio clip on the timeline to open the editor.
            </div>
            <div style={{
                marginTop: 8,
                fontSize: 'var(--font-size-xs)',
                color: 'var(--color-text-tertiary)',
                fontFamily: 'var(--font-mono)',
            }}>
                Shift+Tab switches Rack/Clip panel
            </div>
        </div>
    </div>
);

export const SampleClipEditor = ({
    clip,
}: {
    clip: TimelineClip;
}) => {
    const sampleRate = useEngineStore((s) => resolveSampleRate(s.projectSampleRate, s.transport.sample_rate));
    const bpm = useEngineStore((s) => s.projectBpm || s.transport.bpm || 120);
    const gridDivision = useGridStore((s) => s.division);
    const gridTriplet = useGridStore((s) => s.triplet);
    const [zoomX, setZoomX] = useState(1);
    const durationSamples = Math.max(0, clip.durationSamples ?? 0);
    const [draftWarpEnabled, setDraftWarpEnabled] = useState<boolean>(Boolean(clip.isWarped));
    const [draftWarpMode, setDraftWarpMode] = useState<number>((clip.warpMode ?? 0) > 0 ? 1 : 0);
    const [draftWarpBaseBpm, setDraftWarpBaseBpm] = useState<number>(Math.max(20, Math.round(clip.warpBaseBpm ?? bpm)));
    const [draftPitch, setDraftPitch] = useState<number>(clip.pitchShiftSemitones ?? 0);
    const [isPreviewing, setIsPreviewing] = useState(false);

    const commitPitch = useCallback(async (val: number) => {
        const nextPitch = Math.max(-48, Math.min(48, val));

        const previousClips = useEngineStore.getState().timelineClips;
        useEngineStore.setState((state) => ({
            timelineClips: state.timelineClips.map((c) => {
                if (c.id !== clip.id) return c;

                let nextDurationBeats = c.durationBeats;
                let nextDurationSamples = c.durationSamples;

                // BUG-P3 FIX: Read isWarped/warpSourceDurationFrames/durationSamples
                // from the live clip `c` in the store instead of the stale outer `clip`
                // closure, which may hold values from a previous render.
                if (!c.isWarped) {
                    const pitchMultiplier = Math.pow(2.0, nextPitch / 12.0);
                    const sourceFrames = Math.max(1, c.warpSourceDurationFrames ?? c.durationSamples ?? 1);
                    nextDurationSamples = Math.max(1, Math.round(sourceFrames / pitchMultiplier));
                    nextDurationBeats = frameToBeat(nextDurationSamples, bpm, sampleRate);
                }

                return {
                    ...c,
                    pitchShiftSemitones: nextPitch,
                    durationSamples: nextDurationSamples,
                    durationBeats: nextDurationBeats,
                };
            }),
        }));

        setDraftPitch(nextPitch);
        try {
            await engineApi.setClipPitch({ clipId: clip.id, pitchShiftSemitones: nextPitch });
        } catch (err) {
            useEngineStore.setState({ timelineClips: previousClips });
            console.error('[SampleClipEditor] setClipPitch failed:', err);
        }
    }, [clip.id, bpm, sampleRate]);

    const togglePreview = useCallback(async () => {
        if (!clip.filePath) return;
        try {
            if (isPreviewing) {
                await engineApi.stopPreview();
                setIsPreviewing(false);
                return;
            }
            await engineApi.previewAudioFile(clip.filePath);
            setIsPreviewing(true);
        } catch (err) {
            console.error('[SampleClipEditor] preview failed:', err);
        }
    }, [clip.filePath, isPreviewing]);

    useEffect(() => () => {
        if (isPreviewing) {
            void engineApi.stopPreview();
        }
    }, [isPreviewing]);

    const commitWarp = useCallback(async (next: {
        enabled: boolean;
        mode: number;
        baseBpm: number;
    }) => {
        const base = Math.max(20, Math.min(300, Math.round(next.baseBpm)));
        const store = useEngineStore.getState();
        const sr = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
        const projectTempo = store.projectBpm || store.transport.bpm || 120;

        // BUG-P8 FIX: Read live clip from the store instead of stale closure.
        // After a pitch change, the outer `clip` still has the old pitchShiftSemitones.
        const liveClip = store.timelineClips.find(c => c.id === clip.id);
        if (!liveClip) return;
        const sourceFrames = Math.max(1, liveClip.warpSourceDurationFrames ?? liveClip.durationSamples ?? 1);
        const pitchMultiplier = Math.pow(2.0, (liveClip.pitchShiftSemitones ?? 0) / 12.0);

        const nextDurationBeats = next.enabled
            ? frameToBeat(sourceFrames, base, sr)
            : frameToBeat(Math.round(sourceFrames / pitchMultiplier), projectTempo, sr);
        const nextDurationSamples = next.enabled
            ? Math.max(1, beatDurationToFrames(nextDurationBeats, projectTempo, sr))
            : Math.max(1, Math.round(sourceFrames / pitchMultiplier));

        const previousClips = useEngineStore.getState().timelineClips;
        useEngineStore.setState((state) => ({
            timelineClips: state.timelineClips.map((c) => {
                if (c.id !== clip.id) return c;
                return {
                    ...c,
                    isWarped: next.enabled,
                    warpMode: next.mode > 0 ? 1 : 0,
                    warpBaseBpm: base,
                    warpSourceDurationFrames: sourceFrames,
                    durationBeats: nextDurationBeats,
                    durationSamples: nextDurationSamples,
                };
            }),
        }));

        setDraftWarpEnabled(next.enabled);
        setDraftWarpMode(next.mode > 0 ? 1 : 0);
        setDraftWarpBaseBpm(base);
        try {
            await engineApi.setClipWarp({
                clipId: clip.id,
                isWarped: next.enabled,
                warpMode: next.mode > 0 ? 1 : 0,
                warpBaseBpm: base,
            });
        } catch (err) {
            useEngineStore.setState({ timelineClips: previousClips });
            console.error('[SampleClipEditor] setClipWarp failed:', err);
        }
    }, [clip.id]);

    const beatsPerBar = 4;
    const clipDurationBeats = Math.max(0.25, clip.durationBeats || frameToBeat(durationSamples, bpm, sampleRate));
    const gridStep = Math.max(0.0625, divisionToInterval(gridDivision, beatsPerBar, gridTriplet));
    const pxPerBeat = 82 * zoomX;
    const waveformWidth = Math.max(420, Math.round(clipDurationBeats * pxPerBeat));
    const gridLineCount = Math.min(512, Math.ceil(clipDurationBeats / gridStep));

    return (
        <div style={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--color-bg-panel)',
        }}>
            <div style={{
                height: 28,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '0 10px',
                borderBottom: '1px solid var(--color-divider)',
                color: 'var(--color-text-secondary)',
                fontSize: 'var(--font-size-xs)',
                fontWeight: 'var(--font-weight-bold)' as unknown as number,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
            }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {clip.name}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>
                    {clipDurationBeats.toFixed(2)} beats
                </span>
            </div>

            <ClipEditorShell
                sidebar={(
                    <ClipEditorSidebar>
                        <ClipEditorSection title="Clip Setup">
                            <ClipEditorMetaRow label="Length" value={`${clipDurationBeats.toFixed(2)} beats`} />
                            <ClipEditorMetaRow label="Source" value={clip.filePath ? 'Linked' : 'Missing'} />
                        </ClipEditorSection>

                        <ClipEditorSection title="Warp">
                            <label style={{ ...editorMetaTextStyle, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                <input
                                    type="checkbox"
                                    checked={draftWarpEnabled}
                                    onChange={(e) => {
                                        void commitWarp({
                                            enabled: e.target.checked,
                                            mode: draftWarpMode,
                                            baseBpm: draftWarpBaseBpm,
                                        });
                                    }}
                                />
                                Enabled
                            </label>
                            <select
                                value={draftWarpMode > 0 ? 'pro' : 'standard'}
                                disabled={!draftWarpEnabled}
                                onChange={(e) => {
                                    const mode = e.target.value === 'pro' ? 1 : 0;
                                    void commitWarp({
                                        enabled: draftWarpEnabled,
                                        mode,
                                        baseBpm: draftWarpBaseBpm,
                                    });
                                }}
                                style={{ ...editorButtonStyle, padding: '3px 6px' }}
                            >
                                <option value="standard">Standard</option>
                                <option value="pro">Pro</option>
                            </select>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <span style={editorMetaTextStyle}>Base BPM</span>
                                <input
                                    type="number"
                                    min={20}
                                    max={300}
                                    value={draftWarpBaseBpm}
                                    disabled={!draftWarpEnabled}
                                    onChange={(e) => setDraftWarpBaseBpm(Number(e.target.value) || 120)}
                                    onBlur={() => {
                                        void commitWarp({
                                            enabled: draftWarpEnabled,
                                            mode: draftWarpMode,
                                            baseBpm: draftWarpBaseBpm,
                                        });
                                    }}
                                    style={{ width: 68, ...editorButtonStyle, padding: '2px 6px' }}
                                />
                            </div>
                        </ClipEditorSection>

                        <ClipEditorSection title="Pitch">
                            <div style={{ display: 'grid', gap: 4 }}>
                                <span style={editorMetaTextStyle}>Transpose (st)</span>
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                    <input
                                        type="range"
                                        min={-48}
                                        max={48}
                                        step={1}
                                        value={draftPitch}
                                        onChange={(e) => setDraftPitch(Number(e.target.value))}
                                        onMouseUp={(e) => void commitPitch(Number(e.currentTarget.value))}
                                        onTouchEnd={(e) => void commitPitch(Number(e.currentTarget.value))}
                                        onKeyUp={(e) => {
                                            if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                                                void commitPitch(draftPitch);
                                            }
                                        }}
                                        style={{ flex: 1 }}
                                    />
                                    <span style={{ ...editorMetaTextStyle, width: '28px', textAlign: 'right' }}>
                                        {draftPitch > 0 ? `+${draftPitch}` : draftPitch}
                                    </span>
                                </div>
                            </div>
                        </ClipEditorSection>

                        <ClipEditorSection title="Performance">
                            <button type="button" onClick={togglePreview} style={{ ...editorButtonStyle, width: '100%' }}>
                                {isPreviewing ? 'Stop Preview' : 'Preview'}
                            </button>
                            <div style={{ display: 'grid', gap: 4 }}>
                                <span style={editorMetaTextStyle}>Zoom</span>
                                <input
                                    type="range"
                                    min={0.6}
                                    max={4}
                                    step={0.1}
                                    value={zoomX}
                                    onChange={(e) => setZoomX(Number(e.target.value))}
                                />
                                <span style={{ ...editorMetaTextStyle }}>{zoomX.toFixed(1)}x</span>
                            </div>
                        </ClipEditorSection>
                    </ClipEditorSidebar>
                )}
            >
                <div style={{
                    flex: 1,
                    padding: 10,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    minHeight: 0,
                }}>
                    {clip.filePath && durationSamples > 0 && !clip.isOffline ? (
                        <div style={{
                            flex: 1,
                            minHeight: 120,
                            border: '1px solid var(--color-divider)',
                            borderRadius: 'var(--radius-md)',
                            overflow: 'hidden',
                            background: 'color-mix(in srgb, var(--color-bg-panel) 82%, transparent)',
                            position: 'relative',
                        }}>
                            <div style={{ overflowX: 'auto', overflowY: 'hidden', height: '100%' }}>
                                <div style={{ width: waveformWidth, height: '100%', position: 'relative' }}>
                                    <div style={{
                                        position: 'absolute',
                                        left: 0,
                                        top: 0,
                                        right: 0,
                                        height: 20,
                                        borderBottom: '1px solid color-mix(in srgb, var(--color-text-primary) 8%, transparent)',
                                        background: 'color-mix(in srgb, var(--color-bg-elevated) 86%, transparent)',
                                    }}>
                                        {Array.from({ length: gridLineCount }).map((_, i) => {
                                            const beat = i * gridStep;
                                            const x = beat * pxPerBeat;
                                            const isBar = Math.abs((beat / beatsPerBar) - Math.round(beat / beatsPerBar)) < 1e-6;
                                            return (
                                                <div key={`audio-ruler-${i}`} style={{ position: 'absolute', left: x, top: 0, bottom: 0, width: 1, background: isBar ? 'color-mix(in srgb, var(--color-accent-primary) 58%, transparent)' : 'color-mix(in srgb, var(--color-text-primary) 15%, transparent)' }}>
                                                    {isBar && (
                                                        <span style={{ position: 'absolute', top: 2, left: 3, fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                                                            {Math.floor(beat / beatsPerBar) + 1}
                                                        </span>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                    <div style={{ position: 'absolute', top: 20, left: 0, right: 0, bottom: 0 }}>
                                        <ClipRenderer
                                            filePath={clip.filePath}
                                            width={waveformWidth}
                                            height={Math.max(90, ((window.innerHeight * 0.18) | 0) - 20)}
                                            durationSamples={durationSamples}
                                            sourceOffset={clip.sourceOffset ?? 0}
                                            isSelected
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div style={{
                            flex: 1,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--color-text-tertiary)',
                            fontSize: 'var(--font-size-base)',
                            border: '1px dashed var(--color-divider)',
                            borderRadius: 'var(--radius-lg)',
                        }}>
                            {clip.isOffline ? 'Media offline — resolve file in timeline (double-click clip).' : 'Audio source unavailable'}
                        </div>
                    )}
                </div>
            </ClipEditorShell>
        </div>
    );
};

const editorButtonStyle = {
    border: '1px solid var(--color-divider)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--color-bg-header)',
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 600,
    padding: '4px 8px',
    cursor: 'pointer',
};

const editorMetaTextStyle: CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text-tertiary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    fontWeight: 'var(--font-weight-bold)' as unknown as number,
};
