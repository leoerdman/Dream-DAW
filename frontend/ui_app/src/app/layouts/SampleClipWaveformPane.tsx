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
    color: string;
};

export const SampleClipWaveformPane = ({
    filePath,
    durationSamples,
    sourceOffset,
    clipDurationBeats,
    pxPerBeat,
    gridStep,
    waveHeightScale,
    color,
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
    // ENTERPRISE FIX: Separate clip-duration render width from container min-width.
    // The waveform canvas and the colored clip-length bar must use the SAME width
    // (`clipWidth`). The container uses `Math.max(420, ...)` for scroll comfort only.
    const clipWidth = Math.max(1, Math.round(clipDurationBeats * pxPerBeat));
    const containerWidth = Math.max(420, clipWidth);
    const gridLineCount = Math.min(512, Math.ceil(clipDurationBeats / gridStep));
    const renderedWaveHeight = Math.max(56, Math.round(bodyHeight * Math.max(0.5, Math.min(2.0, waveHeightScale))));

    // Calculate precise samples per pixel to ensure warped waveforms stretch accurately
    // rather than falling back to the Timeline's unwarped global zoom scaling.
    const samplesPerPixel = durationSamples / Math.max(1, clipWidth);

    return (
        <div style={{
            flex: 1,
            minHeight: 120,
            border: 'var(--space-px) solid var(--color-divider)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
            background: 'color-mix(in srgb, var(--color-bg-panel) 82%, transparent)',
            position: 'relative',
        }}>
            <div style={{ overflowX: 'auto', overflowY: 'hidden', height: '100%' }}>
                <div style={{ width: containerWidth, height: '100%', position: 'relative' }}>
                    <div style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        width: containerWidth,
                        height: 24,
                        background: 'var(--color-bg-tertiary)',
                        borderBottom: 'var(--space-px) solid var(--color-divider)',
                        overflow: 'hidden',
                        zIndex: 'var(--z-sticky)'
                    }}>
                        <div style={{ position: 'absolute', top: 0, left: 0, width: clipDurationBeats * pxPerBeat, height: 3, background: color, opacity: 0.65 }} />
                        {Array.from({ length: gridLineCount }).map((_, i) => {
                            const beat = i * gridStep;
                            const x = beat * pxPerBeat;
                            const barFraction = beat / beatsPerBar;
                            const isBar = Math.abs(barFraction - Math.round(barFraction)) < 1e-6;
                            const isMainBeat = Math.abs(beat - Math.round(beat)) < 1e-6;

                            const showLabel = isBar || (isMainBeat && pxPerBeat > 30);
                            const labelText = isBar
                                ? `${Math.floor(beat / beatsPerBar) + 1}`
                                : `${Math.floor(beat / beatsPerBar) + 1}.${Math.floor(beat % beatsPerBar) + 1}`;

                            return (
                                <div key={`audio-ruler-${i}`}>
                                    {showLabel && (
                                        <span style={{
                                            position: 'absolute',
                                            left: x + 5,
                                            top: 6,
                                            fontSize: 'var(--font-size-2xs)',
                                            color: isBar ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                                            fontWeight: isBar ? 700 : 500,
                                            fontFamily: 'var(--font-role-data)',
                                            pointerEvents: 'none',
                                            userSelect: 'none'
                                        }}>
                                            {labelText}
                                        </span>
                                    )}
                                    <div style={{
                                        position: 'absolute',
                                        left: x,
                                        bottom: 0,
                                        width: 1,
                                        height: isBar ? 10 : 5,
                                        background: isBar ? 'var(--color-grid-line-major)' : 'var(--color-grid-line)'
                                    }} />
                                </div>
                            );
                        })}
                        <div style={{ position: 'absolute', top: 0, left: (clipDurationBeats * pxPerBeat) - 2, width: 2, height: 24, background: color, opacity: 0.85 }} />
                    </div>
                    <div
                        ref={bodyRef}
                        style={{
                            position: 'absolute',
                            top: 24,
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
                                width={clipWidth}
                                height={renderedWaveHeight}
                                durationSamples={durationSamples}
                                sourceOffset={sourceOffset ?? 0}
                                samplesPerPixelOverride={samplesPerPixel}
                                isSelected
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
