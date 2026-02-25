import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import type { ProjectDelta } from '@/shared/api/projectDelta';
import * as engineApi from '@/shared/api/engine';
import { dbToMeterNorm } from '@/shared/lib/meterManifest';
import { SessionIoRow, SessionStripFader } from './DawShellPanelControls';
import { sessionMixerBtnStyle } from './sessionPanelStyles';
import { SESSION_TRACK_WIDTH } from './sessionWorkspace.constants';

interface SessionWorkspaceMixerTracksProps {
    tracks: ProjectTrack[];
    meters: {
        tracks: Array<[{ peak: number }, { peak: number }] | undefined>;
    };
    applyProjectDeltas: (deltas: ProjectDelta[], reason?: string) => Promise<void>;
    setTrackMute: (trackIndex: number, muted: boolean) => Promise<unknown>;
    setTrackSolo: (trackIndex: number, soloed: boolean) => Promise<unknown>;
    setTrackVolume: (trackIndex: number, volume: number) => Promise<unknown>;
    setTrackPan: (trackIndex: number, pan: number) => Promise<unknown>;
}

export function SessionWorkspaceMixerTracks({
    tracks,
    meters,
    applyProjectDeltas,
    setTrackMute,
    setTrackSolo,
    setTrackVolume,
    setTrackPan,
}: SessionWorkspaceMixerTracksProps) {
    return (
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
                        <SessionIoRow label="Audio From" value={track.input || 'No Input'} />
                        <SessionIoRow label="Audio To" value={track.output || 'Master'} />
                        <SessionIoRow label="Monitor" value={track.is_armed ? 'In' : 'Auto'} />
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
    );
}
