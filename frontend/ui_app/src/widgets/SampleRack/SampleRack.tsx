import { memo, useState } from 'react';
import type { SampleRackConfig } from '@/shared/types/SampleRackConfig';
import * as engineApi from '@/shared/api/engine';
import { useDragStore } from '@/shared/stores/useDragStore';
import { canDropInZone } from '@/shared/lib/dndMatrix';

interface SampleRackProps {
    trackId: string;
    rackConfig: SampleRackConfig;
    onParamChange?: (paramName: string, value: number) => void;
}

const PAD_NAMES = [
    'Kick', 'Snare/Clap', 'Clap/Perc', 'Sub/Tom',
    'Tom Lo', 'Tom Mid', 'Closed Hat', 'Tom Hi',
    'Pedal Hat', 'Open Hat', 'Ride', 'Crash',
    'Crash 2', 'Ride Bell', 'Perc 1', 'Perc 2'
];

export const SampleRack = memo(function SampleRack({ trackId, rackConfig }: SampleRackProps) {
    const [selectedPad, setSelectedPad] = useState<number>(0);
    const setSampleRackPadSample = engineApi.setSampleRackPadSample;

    const handleDropSample = async (padIndex: number, samplePath: string) => {
        try {
            await setSampleRackPadSample(trackId, padIndex, samplePath);
        } catch (err) {
            console.error('[SampleRack] Failed to set pad sample:', err);
        }
    };

    const handleVolumeChange = (vol: number) => {
        engineApi.setSampleRackPadVolumeCmd?.(trackId, selectedPad, vol).catch(console.error);
    };

    const pad = rackConfig.pads[selectedPad];

    return (
        <div style={{
            display: 'flex',
            height: '100%',
            gap: 16,
            padding: 12,
            background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-3) 84%, #2f4058) 0%, color-mix(in srgb, var(--surface-2) 88%, #1c2735) 100%)',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            minWidth: 480
        }}>
            {/* 4x4 Grid */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gridTemplateRows: 'repeat(4, 1fr)',
                gap: 8,
                flex: 1,
                aspectRatio: '1/1',
                maxHeight: 240
            }}>
                {Array.from({ length: 16 }).map((_, rIdx) => {
                    // Render bottom to top (typical drum machine layout)
                    const row = 3 - Math.floor(rIdx / 4);
                    const col = rIdx % 4;
                    const i = row * 4 + col;

                    const p = rackConfig.pads[i];
                    const isSelected = selectedPad === i;
                    const hasSample = !!p?.sample_path;
                    const fileName = p?.sample_path?.split('/').pop() || '';

                    return (
                        <div
                            key={i}
                            onClick={() => setSelectedPad(i)}
                            onMouseUp={() => {
                                const dragging = useDragStore.getState().draggingItem;
                                const acceptance = dragging ? canDropInZone(dragging, 'sampler-surface') : { allowed: false };
                                if (dragging?.path && acceptance.allowed) {
                                    handleDropSample(i, dragging.path);
                                    useDragStore.getState().endDrag();
                                }
                            }}
                            style={{
                                border: isSelected ? '2px solid #5ce0a6' : '1px solid rgba(255, 255, 255, 0.15)',
                                borderRadius: 'var(--radius-md)',
                                background: hasSample ? 'rgba(92, 224, 166, 0.15)' : 'rgba(0, 0, 0, 0.2)',
                                cursor: 'pointer',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                position: 'relative',
                                overflow: 'hidden',
                                transition: 'all 0.1s',
                            }}
                        >
                            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', position: 'absolute', top: 4, left: 4 }}>
                                {i + 1}
                            </span>
                            <span style={{ fontSize: 11, fontWeight: 600, color: hasSample ? '#fff' : 'rgba(255,255,255,0.5)', textAlign: 'center', padding: '0 4px', wordBreak: 'break-word', lineHeight: 1.1 }}>
                                {hasSample ? fileName : PAD_NAMES[i]}
                            </span>
                        </div>
                    );
                })}
            </div>

            {/* Pad Settings Panel */}
            <div style={{
                width: 220,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                background: 'rgba(0, 0, 0, 0.2)',
                borderRadius: 'var(--radius-md)',
                padding: 12,
                border: '1px solid rgba(255, 255, 255, 0.05)'
            }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#fff', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: 8 }}>
                    Pad {selectedPad + 1} Settings
                </div>

                {pad ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div style={{ fontSize: 11, color: '#8fd6b4', opacity: pad.sample_path ? 1 : 0.5, wordBreak: 'break-all' }}>
                            {pad.sample_path ? pad.sample_path.split('/').pop() : 'No Sample Loaded'}
                        </div>

                        {/* Fake knobs, just mapping to sliders for now since PluginKnob usually expects formal DeviceParams */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <label style={{ fontSize: 10, color: '#ccc' }}>Volume</label>
                            <input
                                type="range" min="0" max="2" step="0.01"
                                value={pad.volume ?? 1}
                                onChange={(e) => {
                                    handleVolumeChange(parseFloat(e.target.value));
                                }}
                                style={{ width: '100%' }}
                            />
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                            <button
                                onClick={() => engineApi.setSampleRackPadMuteCmd?.(trackId, selectedPad, !pad.is_muted)}
                                style={{
                                    padding: '4px', background: pad.is_muted ? '#ff5c5c' : '#333', color: '#fff',
                                    border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer'
                                }}
                            >
                                {pad.is_muted ? 'Muted' : 'Mute'}
                            </button>
                            <button
                                onClick={() => engineApi.setSampleRackPadSoloCmd?.(trackId, selectedPad, !pad.is_soloed)}
                                style={{
                                    padding: '4px', background: pad.is_soloed ? '#f0c430' : '#333', color: pad.is_soloed ? '#000' : '#fff',
                                    border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer'
                                }}
                            >
                                {pad.is_soloed ? 'Soloed' : 'Solo'}
                            </button>
                        </div>
                    </div>
                ) : (
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', textAlign: 'center', marginTop: 20 }}>
                        Select a pad
                    </div>
                )}
            </div>
        </div>
    );
});
