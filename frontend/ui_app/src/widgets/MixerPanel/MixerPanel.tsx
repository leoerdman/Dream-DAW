import { useRef } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { MixerChannelStrip } from './MixerChannelStrip';
import { MasterStrip } from './MasterStrip';
import { STRIP_GAP } from './MixerPanel.constants';

interface MixerPanelProps {
    selectedTrackId: string;
    onSelectTrack: (trackId: string) => void;
}

export function MixerPanel({ selectedTrackId, onSelectTrack }: MixerPanelProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const tracksEntity = useEngineStore((s) => s.tracks);
    const setTrackVolume = useEngineStore((s) => s.setTrackVolume);
    const setTrackPan = useEngineStore((s) => s.setTrackPan);
    const setTrackMute = useEngineStore((s) => s.setTrackMute);
    const setTrackSolo = useEngineStore((s) => s.setTrackSolo);

    return (
        <div
            ref={scrollRef}
            style={{
                display: 'flex',
                flexDirection: 'row',
                height: '100%',
                overflowX: 'auto',
                overflowY: 'hidden',
                background: 'var(--bg-app)',
                gap: STRIP_GAP,
                padding: '0 2px',
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
                        onToggleMute={() => setTrackMute(index, !track.is_mute)}
                        onToggleSolo={() => setTrackSolo(index, !track.is_solo)}
                    />
                );
            })}
            <MasterStrip />
        </div>
    );
}
