import { memo, useCallback, useRef } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import * as engineApi from '@/shared/api/engine';
import { MixerChannelStrip } from './MixerChannelStrip';
import { MasterStrip } from './MasterStrip';

interface MixerPanelProps {
    selectedTrackId: string;
    onSelectTrack: (trackId: string) => void;
}

export const MixerPanel = memo(function MixerPanel({ selectedTrackId, onSelectTrack }: MixerPanelProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const tracksEntity = useEngineStore((s) => s.tracks);
    const setTrackVolume = useEngineStore((s) => s.setTrackVolume);
    const setTrackPan = useEngineStore((s) => s.setTrackPan);
    const setTrackDisabled = useEngineStore((s) => s.setTrackDisabled);
    const setTrackSolo = useEngineStore((s) => s.setTrackSolo);

    // Stable callback factories — these return the same function reference
    // as long as the store actions don't change (they never do in zustand).
    const handleVolumeChange = useCallback((index: number, gain: number) => {
        setTrackVolume(index, gain);
    }, [setTrackVolume]);

    const handlePanChange = useCallback((index: number, pan: number) => {
        setTrackPan(index, pan);
    }, [setTrackPan]);

    const handleToggleDisabled = useCallback((index: number, isDisabled: boolean) => {
        setTrackDisabled(index, !isDisabled);
    }, [setTrackDisabled]);

    const handleToggleSolo = useCallback((index: number, isSolo: boolean) => {
        setTrackSolo(index, !isSolo);
    }, [setTrackSolo]);

    const handleToggleArm = useCallback((index: number, isArmed: boolean) => {
        void engineApi
            .armTrackWithDeltas(index, !isArmed)
            .then(res => useEngineStore.getState().applyProjectDeltas(res.deltas, 'mixer:arm'))
            .catch(console.error);
    }, []);

    return (
        <div
            ref={scrollRef}
            style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'row',
                overflowX: 'auto',
                overflowY: 'hidden',
                background: 'var(--color-bg-canvas)',
                gap: 0,
                padding: '0 0px',
                scrollbarWidth: 'thin',
                scrollbarColor: 'color-mix(in srgb, var(--text-primary) 18%, transparent) transparent',
            }}
        >
            {tracksEntity.allIds.map((trackId, index) => {
                const track = tracksEntity.byId[trackId];
                if (!track) return null;
                return (
                    <MixerChannelStrip
                        key={trackId}
                        track={track}
                        trackIndex={index}
                        isSelected={trackId === selectedTrackId}
                        onSelect={() => onSelectTrack(trackId)}
                        onVolumeChange={handleVolumeChange}
                        onPanChange={handlePanChange}
                        onToggleDisabled={handleToggleDisabled}
                        onToggleSolo={handleToggleSolo}
                        onToggleArm={handleToggleArm}
                    />
                );
            })}
            <MasterStrip />
        </div>
    );
});
