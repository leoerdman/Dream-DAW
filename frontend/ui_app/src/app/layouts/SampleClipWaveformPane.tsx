import { ClipRenderer } from '@/widgets/Timeline/ClipRenderer';

type Props = {
    filePath: string;
    durationSamples: number;
    sourceOffset?: number;
    clipDurationBeats: number;
    pxPerBeat: number;
    gridStep: number;
};

export const SampleClipWaveformPane = ({
    filePath,
    durationSamples,
    sourceOffset,
    clipDurationBeats,
    pxPerBeat,
    gridStep,
}: Props) => {
    const beatsPerBar = 4;
    const waveformWidth = Math.max(420, Math.round(clipDurationBeats * pxPerBeat));
    const gridLineCount = Math.min(512, Math.ceil(clipDurationBeats / gridStep));

    return (
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
                            filePath={filePath}
                            width={waveformWidth}
                            height={Math.max(90, ((window.innerHeight * 0.18) | 0) - 20)}
                            durationSamples={durationSamples}
                            sourceOffset={sourceOffset ?? 0}
                            isSelected
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};
