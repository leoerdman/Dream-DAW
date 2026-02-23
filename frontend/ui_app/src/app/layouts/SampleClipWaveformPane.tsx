import { useEffect, useRef, useState } from 'react';
import { ClipRenderer } from '@/widgets/Timeline/ClipRenderer';

type Props = {
    filePath: string;
    durationSamples: number;
    sourceOffset?: number;
    clipDurationBeats: number;
    pxPerBeat: number;
    gridStep: number;
    waveHeightScale: number;
};

export const SampleClipWaveformPane = ({
    filePath,
    durationSamples,
    sourceOffset,
    clipDurationBeats,
    pxPerBeat,
    gridStep,
    waveHeightScale,
}: Props) => {
    const bodyRef = useRef<HTMLDivElement>(null);
    const [bodyHeight, setBodyHeight] = useState(120);

    useEffect(() => {
        const element = bodyRef.current;
        if (!element) return;
        const observer = new ResizeObserver((entries) => {
            const next = entries[0]?.contentRect?.height ?? 120;
            setBodyHeight(Math.max(80, Math.floor(next)));
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const beatsPerBar = 4;
    const waveformWidth = Math.max(420, Math.round(clipDurationBeats * pxPerBeat));
    const gridLineCount = Math.min(512, Math.ceil(clipDurationBeats / gridStep));
    const renderedWaveHeight = Math.max(56, Math.round(bodyHeight * Math.max(0.5, Math.min(2.0, waveHeightScale))));

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
                    <div
                        ref={bodyRef}
                        style={{
                            position: 'absolute',
                            top: 20,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'stretch',
                        }}
                    >
                        <div style={{ width: '100%', height: renderedWaveHeight }}>
                            <ClipRenderer
                                filePath={filePath}
                                width={waveformWidth}
                                height={renderedWaveHeight}
                                durationSamples={durationSamples}
                                sourceOffset={sourceOffset ?? 0}
                                isSelected
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
