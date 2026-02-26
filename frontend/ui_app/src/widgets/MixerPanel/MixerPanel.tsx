import { useRef } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { MixerChannelStrip } from './MixerChannelStrip';
import { MasterStrip } from './MasterStrip';

interface MixerPanelProps {
    selectedTrackId: string;
    onSelectTrack: (trackId: string) => void;
}

export function MixerPanel({ selectedTrackId, onSelectTrack }: MixerPanelProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const tracksEntity = useEngineStore((s) => s.tracks);
    const setTrackVolume = useEngineStore((s) => s.setTrackVolume);
    const setTrackPan = useEngineStore((s) => s.setTrackPan);
    const setTrackDisabled = useEngineStore((s) => s.setTrackDisabled);
    const setTrackSolo = useEngineStore((s) => s.setTrackSolo);

    return (
        <div
            ref={scrollRef}
            className="w-full h-full flex flex-row overflow-x-auto overflow-y-hidden"
            style={{
                background: 'var(--color-bg-canvas)',
                gap: 0, // Using border right on strips
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
                        onVolumeChange={(gain) => setTrackVolume(index, gain)}
                        onPanChange={(pan) => setTrackPan(index, pan)}
                        onToggleDisabled={() => setTrackDisabled(index, !track.is_disabled)}
                        onToggleSolo={() => setTrackSolo(index, !track.is_solo)}
                    />
                );
            })}
            <MasterStrip />
        </div>
    );
}
