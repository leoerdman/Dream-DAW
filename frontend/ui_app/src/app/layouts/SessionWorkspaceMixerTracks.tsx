import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import type { ProjectDelta } from '@/shared/api/projectDelta';
import * as React from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import * as engineApi from '@/shared/api/engine';
import { dbToMeterNorm } from '@/shared/lib/meterManifest';
import { SessionIoRow, SessionStripFader } from './DawShellPanelControls';
import { SESSION_TRACK_WIDTH } from './sessionWorkspace.constants';

interface SessionWorkspaceMixerTracksProps {
    tracks: ProjectTrack[];
    applyProjectDeltas: (deltas: ProjectDelta[], reason?: string) => Promise<void>;
    setTrackDisabled: (trackIndex: number, disabled: boolean) => Promise<unknown>;
    setTrackSolo: (trackIndex: number, soloed: boolean) => Promise<unknown>;
    setTrackVolume: (trackIndex: number, volume: number) => Promise<unknown>;
    setTrackPan: (trackIndex: number, pan: number) => Promise<unknown>;
}
export function SessionWorkspaceMixerTracks({
    tracks,
    applyProjectDeltas,
    setTrackDisabled,
    setTrackSolo,
    setTrackVolume,
    setTrackPan,
}: SessionWorkspaceMixerTracksProps) {
    return (
        <div style={{ display: 'flex', minHeight: 0, height: '100%', overflowX: 'auto', alignItems: 'stretch' }}>
            {tracks.map((track, trackIndex) => (
                <SessionWorkspaceMixerTrackStrip
                    key={`mix-${track.id}`}
                    track={track}
                    trackIndex={trackIndex}
                    applyProjectDeltas={applyProjectDeltas}
                    setTrackDisabled={setTrackDisabled}
                    setTrackSolo={setTrackSolo}
                    setTrackVolume={setTrackVolume}
                    setTrackPan={setTrackPan}
                />
            ))}
        </div>
    );
}

const SessionWorkspaceMixerTrackStrip = React.memo(({
    track,
    trackIndex,
    applyProjectDeltas,
    setTrackDisabled,
    setTrackSolo,
    setTrackVolume,
    setTrackPan,
}: {
    track: ProjectTrack;
    trackIndex: number;
    applyProjectDeltas: SessionWorkspaceMixerTracksProps['applyProjectDeltas'];
    setTrackDisabled: SessionWorkspaceMixerTracksProps['setTrackDisabled'];
    setTrackSolo: SessionWorkspaceMixerTracksProps['setTrackSolo'];
    setTrackVolume: SessionWorkspaceMixerTracksProps['setTrackVolume'];
    setTrackPan: SessionWorkspaceMixerTracksProps['setTrackPan'];
}) => {
    const meterPair = useEngineStore((s) => s.meters.tracks[trackIndex]);
    const peakDbL = meterPair ? meterPair[0].peak : -60;
    const peakDbR = meterPair ? meterPair[1].peak : -60;
    const trackMeterL = dbToMeterNorm(peakDbL);
    const trackMeterR = dbToMeterNorm(peakDbR);
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
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontWeight: 'var(--font-weight-bold)', textTransform: 'uppercase' }}>
                {track.track_type}
            </div>
            <SessionIoRow label="Audio From" value={track.input || 'No Input'} />
            <SessionIoRow label="Audio To" value={track.output || 'Master'} />
            <SessionIoRow label="Monitor" value={track.is_armed ? 'In' : 'Auto'} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, height: '100%', minHeight: 0 }}>
                <SessionStripFader
                    gain={track.volume}
                    pan={track.pan}
                    meterL={trackMeterL}
                    meterR={trackMeterR}
                    onGainChange={(nextGain) => { void setTrackVolume(trackIndex, nextGain); }}
                    onPanChange={(nextPan) => { void setTrackPan(trackIndex, nextPan); }}
                    trackIndex={trackIndex}
                    trackDisabled={track.is_disabled}
                    trackSolo={track.is_solo}
                    trackArmed={track.is_armed}
                    setTrackDisabled={() => { void setTrackDisabled(trackIndex, !track.is_disabled); }}
                    setTrackSolo={() => { void setTrackSolo(trackIndex, !track.is_solo); }}
                    setTrackArmed={() => {
                        void engineApi
                            .armTrackWithDeltas(trackIndex, !track.is_armed)
                            .then((response) => applyProjectDeltas(response.deltas, 'session-arm-track'))
                            .catch((err) => {
                                console.error('[SessionWorkspace] Failed to arm track', err);
                            });
                    }}
                />
            </div>
        </div>
    );
});
