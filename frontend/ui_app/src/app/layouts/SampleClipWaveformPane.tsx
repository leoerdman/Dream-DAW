import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipRenderer } from '@/widgets/Timeline/ClipRenderer';
import { ClipEditorRuler, CLIP_EDITOR_RULER_HEIGHT } from '@/widgets/ClipEditor/ClipEditorRuler';

type Props = {
    filePath: string;
    durationSamples: number;
    sourceOffset?: number;
    clipDurationBeats: number;
    pxPerBeat: number;
    gridStep: number;
    waveHeightScale: number;
    color: string;
    beatsPerBar?: number;
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
    beatsPerBar: beatsPerBarProp = 4,
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

    const beatsPerBar = Math.max(1, beatsPerBarProp);
    // ENTERPRISE FIX: Separate clip-duration render width from container min-width.
    // The waveform canvas and the colored clip-length bar must use the SAME width
    // (`clipWidth`). The container uses `Math.max(420, ...)` for scroll comfort only.
    const clipWidth = Math.max(1, Math.round(clipDurationBeats * pxPerBeat));
    const containerWidth = Math.max(420, clipWidth);
    const renderedWaveHeight = Math.max(56, Math.round(bodyHeight * Math.max(0.5, Math.min(2.0, waveHeightScale))));

    // Calculate precise samples per pixel to ensure warped waveforms stretch accurately
    // rather than falling back to the Timeline's unwarped global zoom scaling.
    const samplesPerPixel = durationSamples / Math.max(1, clipWidth);

    // ── Vertical Grid Lines (extending full height from ruler into waveform body) ──
    // Generates grid lines matching the ruler grid, rendered as full-height dividers
    // so the user can visually correlate time positions with waveform features.
    const verticalGridLines = useMemo(() => {
        const lines: { x: number; isBar: boolean }[] = [];
        const epsilon = 1e-6;
        const visualStep = gridStep > 0 ? gridStep : 0.25;
        const totalSteps = Math.ceil(clipDurationBeats / visualStep);
        for (let i = 0; i <= totalSteps; i++) {
            const beat = i * visualStep;
            if (beat > clipDurationBeats + epsilon) break;
            const isBar = Math.abs((beat / beatsPerBar) - Math.round(beat / beatsPerBar)) < epsilon;
            lines.push({ x: beat * pxPerBeat, isBar });
        }
        return lines;
    }, [clipDurationBeats, pxPerBeat, gridStep, beatsPerBar]);

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
                    <ClipEditorRuler
                        width={containerWidth}
                        clipBeats={clipDurationBeats}
                        pixelsPerBeat={pxPerBeat}
                        color={color}
                        gridStep={gridStep}
                        beatsPerBar={beatsPerBar}
                    />

                    {/* ── Vertical grid lines extending through the entire waveform body ── */}
                    {verticalGridLines.map((gl) => (
                        <div
                            key={`body-grid-${Math.round(gl.x)}`}
                            style={{
                                position: 'absolute',
                                left: gl.x,
                                top: CLIP_EDITOR_RULER_HEIGHT,
                                bottom: 0,
                                width: 1,
                                background: gl.isBar
                                    ? 'var(--color-grid-line-major)'
                                    : 'var(--color-grid-line)',
                                opacity: gl.isBar ? 0.5 : 0.25,
                                pointerEvents: 'none',
                            }}
                        />
                    ))}

                    <div
                        ref={bodyRef}
                        style={{
                            position: 'absolute',
                            top: CLIP_EDITOR_RULER_HEIGHT,
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
