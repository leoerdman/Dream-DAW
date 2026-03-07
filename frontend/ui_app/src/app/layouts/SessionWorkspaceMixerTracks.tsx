import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import type { ProjectDelta } from '@/shared/api/projectDelta';
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
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
        <div style={{ display: 'flex', minHeight: 0, height: '100%', minWidth: 'max-content', alignItems: 'stretch' }}>
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

/**
 * PERF-OPT: Subscription-driven track strip meters for session view.
 * Uses RAF coalescing + value equality to avoid N × 30fps React re-renders.
 */
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
    const meterLRef = useRef(0);
    const meterRRef = useRef(0);
    const rafIdRef = useRef(0);
    const mountedRef = useRef(true);
    const lastRef = useRef({ mL: 0, mR: 0 });
    const [, setTick] = useState(0);
    const forceUpdateRef = useRef<() => void>(() => setTick((t) => (t + 1) & 0x7FFFFFFF));
    forceUpdateRef.current = () => setTick((t) => (t + 1) & 0x7FFFFFFF);

    useEffect(() => {
        mountedRef.current = true;
        const unsub = useEngineStore.subscribe((state) => {
            const meterPair = state.meters.tracks[trackIndex];
            const mL = dbToMeterNorm(meterPair ? meterPair[0].peak : -60);
            const mR = dbToMeterNorm(meterPair ? meterPair[1].peak : -60);
            const last = lastRef.current;
            if (mL === last.mL && mR === last.mR) return;
            meterLRef.current = mL;
            meterRRef.current = mR;
            lastRef.current = { mL, mR };
            if (rafIdRef.current) return;
            rafIdRef.current = requestAnimationFrame(() => {
                rafIdRef.current = 0;
                if (mountedRef.current) forceUpdateRef.current();
            });
        });
        return () => { mountedRef.current = false; unsub(); if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current); };
    }, [trackIndex]);

    const trackColor = track.color || 'var(--color-status-info)';

    return (
        <div key={`mix-${track.id}`} style={{
            width: SESSION_TRACK_WIDTH,
            height: '100%',
            borderRight: 'var(--space-px) solid var(--color-timeline-grid-line)',
            padding: '4px',
            display: 'grid',
            gridTemplateRows: 'auto auto 1fr auto',
            gap: 4,
            background: 'color-mix(in srgb, var(--color-bg-panel) 96%, transparent)',
        }}>
            <SessionIoRow label="Audio From" value={track.input || 'No Input'} />
            <SessionIoRow label="Audio To" value={track.output || 'Master'} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, height: '100%', minHeight: 0 }}>
                <SessionStripFader
                    trackColor={trackColor}
                    gain={track.volume}
                    pan={track.pan}
                    meterL={meterLRef.current}
                    meterR={meterRRef.current}
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
