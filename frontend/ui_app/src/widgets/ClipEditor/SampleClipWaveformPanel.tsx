import { ClipRenderer } from '@/widgets/Timeline/ClipRenderer';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';

interface SampleClipWaveformPanelProps {
    clip: TimelineClip;
    durationSamples: number;
    waveformWidth: number;
    gridLineCount: number;
    gridStep: number;
    beatsPerBar: number;
    pxPerBeat: number;
}

export function SampleClipWaveformPanel({
    clip,
    durationSamples,
    waveformWidth,
    gridLineCount,
    gridStep,
    beatsPerBar,
    pxPerBeat,
}: SampleClipWaveformPanelProps) {
    if (!(clip.filePath && durationSamples > 0 && !clip.isOffline)) {
        return (
            <div style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-text-tertiary)',
                fontSize: 'var(--font-size-base)',
                border: '1px dashed var(--color-divider)',
                borderRadius: 'var(--radius-lg)',
            }}>
                {clip.isOffline ? 'Media offline — resolve file in timeline (double-click clip).' : 'Audio source unavailable'}
            </div>
        );
    }

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
                                <div
                                    key={`audio-ruler-${i}`}
                                    style={{
                                        position: 'absolute',
                                        left: x,
                                        top: 0,
                                        bottom: 0,
                                        width: 1,
                                        background: isBar
                                            ? 'color-mix(in srgb, var(--color-accent-primary) 58%, transparent)'
                                            : 'color-mix(in srgb, var(--color-text-primary) 15%, transparent)',
                                    }}
                                >
                                    {isBar && (
                                        <span style={{
                                            position: 'absolute',
                                            top: 2,
                                            left: 3,
                                            fontSize: 'var(--font-size-2xs)',
                                            color: 'var(--color-text-secondary)',
                                            fontFamily: 'var(--font-mono)',
                                        }}>
                                            {Math.floor(beat / beatsPerBar) + 1}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    <div style={{ position: 'absolute', top: 20, left: 0, right: 0, bottom: 0 }}>
                        <ClipRenderer
                            filePath={clip.filePath}
                            width={waveformWidth}
                            height={Math.max(90, ((window.innerHeight * 0.18) | 0) - 20)}
                            durationSamples={durationSamples}
                            sourceOffset={clip.sourceOffset ?? 0}
                            isSelected
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
