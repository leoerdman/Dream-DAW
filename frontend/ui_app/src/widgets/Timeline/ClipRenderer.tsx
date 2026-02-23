import { useRef, useEffect, useState, useCallback, memo } from 'react';
import { useViewportStore } from '@/shared/stores/useViewportStore';
import type { WaveformPeaks } from '@/shared/api/engine';
import { drawClipWaveform, loadPeaksCached } from '@/widgets/Timeline/clipWaveform';

export interface ClipRendererProps {
    filePath: string;
    width: number;
    height: number;
    isSelected?: boolean;
    sourceOffset?: number;
    durationSamples: number;
    className?: string;
}

export const ClipRenderer = memo(function ClipRenderer({
    filePath,
    width,
    height,
    isSelected = false,
    sourceOffset = 0,
    durationSamples,
    className,
}: ClipRendererProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [peaks, setPeaks] = useState<WaveformPeaks | null>(null);
    const [error, setError] = useState<string | null>(null);
    const samplesPerPixel = useViewportStore((s) => s.samplesPerPixel);

    useEffect(() => {
        let cancelled = false;
        async function fetchPeaks() {
            try {
                const data = await loadPeaksCached(filePath);
                if (!cancelled) {
                    setPeaks(data);
                    setError(null);
                }
            } catch (err) {
                if (!cancelled) {
                    setError(String(err));
                    console.error('[ClipRenderer] Failed to fetch peaks:', err);
                }
            }
        }
        fetchPeaks();
        return () => {
            cancelled = true;
        };
    }, [filePath]);

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas || !peaks) return;
        drawClipWaveform(
            canvas,
            peaks,
            width,
            height,
            samplesPerPixel,
            isSelected,
            sourceOffset,
            durationSamples,
        );
    }, [peaks, width, height, samplesPerPixel, isSelected, sourceOffset, durationSamples]);

    useEffect(() => {
        draw();
    }, [draw]);

    if (error) {
        return (
            <div
                className={className}
                style={{
                    width,
                    height,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'color-mix(in srgb, var(--color-status-error) 60%, transparent)',
                    fontSize: 'var(--font-size-xs)',
                }}
            >
                ⚠ Peaks unavailable
            </div>
        );
    }

    return (
        <canvas
            ref={canvasRef}
            className={className}
            style={{
                width,
                height,
                display: 'block',
                pointerEvents: 'none',
            }}
        />
    );
});

export default ClipRenderer;

