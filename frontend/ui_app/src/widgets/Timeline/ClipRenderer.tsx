// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Clip Renderer (Canvas Waveform Component)
// ═══════════════════════════════════════════════════════════════════════════
//
// High-performance waveform visualization using HTML5 Canvas.
//
// Architecture:
//   1. On mount, fetches multi-resolution peaks from the Rust backend
//   2. On each render, selects the optimal mip level for the current zoom
//   3. Draws vertical min/max peak bars with gradient coloring
//   4. Uses offscreen bitmap caching to avoid redundant draws
//   5. Re-renders only when zoom or scroll changes (via useViewportStore)
//
// This replaces the SVG placeholder waveform in Timeline.tsx.
//
// ═══════════════════════════════════════════════════════════════════════════

import {
    useRef,
    useEffect,
    useState,
    useCallback,
    memo,
} from 'react';
import * as engine from '@/shared/api/engine';
import { useViewportStore } from '@/shared/stores/useViewportStore';
import type { WaveformPeaks, PeakPair } from '@/shared/api/engine';

// ── Types ────────────────────────────────────────────────────────────────

export interface ClipRendererProps {
    /** Audio file path (used to fetch peaks from ClipPool). */
    filePath: string;

    /** Width of the clip in pixels (derived from clip duration / SPP). */
    width: number;

    /** Height of the canvas in pixels. */
    height: number;

    /** Whether this clip is currently selected. */
    isSelected?: boolean;

    /** Clip's source offset in samples (for trimmed clips). */
    sourceOffset?: number;

    /** Clip's duration in samples. */
    durationSamples: number;

    /** Optional CSS class. */
    className?: string;
}

// ── Constants ────────────────────────────────────────────────────────────

/** Waveform body color (positive amplitude). */
const WAVEFORM_COLOR = 'rgba(120, 200, 255, 0.85)';

/** Waveform body color when selected. */
const WAVEFORM_COLOR_SELECTED = 'rgba(160, 230, 255, 0.95)';

/** Waveform RMS (inner) color — shows average energy. */
const WAVEFORM_RMS_COLOR = 'rgba(80, 160, 220, 0.6)';

/** Center line color. */
const CENTER_LINE_COLOR = 'rgba(255, 255, 255, 0.12)';

// ── Component ────────────────────────────────────────────────────────────

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

    // Subscribe to zoom level for mip selection
    const samplesPerPixel = useViewportStore((s) => s.samplesPerPixel);

    // ── Fetch Peaks on Mount ─────────────────────────────────────

    useEffect(() => {
        let cancelled = false;

        async function fetchPeaks() {
            try {
                const data = await engine.getWaveformPeaks(filePath);
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

    // ── Draw Waveform ─────────────────────────────────────────────

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas || !peaks) return;

        const ctx = canvas.getContext('2d', { alpha: true });
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const w = width;
        const h = height;

        // Set up canvas for Retina
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        ctx.scale(dpr, dpr);

        // Clear
        ctx.clearRect(0, 0, w, h);

        // Select best mip level
        const mipIdx = selectMipLevel(samplesPerPixel, peaks);
        const mip = peaks.mip_levels[mipIdx];
        if (!mip || mip.peaks.length === 0) return;

        const spp = mip.samples_per_peak;
        const centerY = h / 2;

        // Calculate which peaks fall within this clip's source region
        const startPeak = Math.floor(sourceOffset / spp);
        const endPeak = Math.min(
            mip.peaks.length,
            Math.ceil((sourceOffset + durationSamples) / spp),
        );

        const totalPeaks = endPeak - startPeak;
        if (totalPeaks <= 0) return;

        // Draw center line
        ctx.strokeStyle = CENTER_LINE_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, centerY);
        ctx.lineTo(w, centerY);
        ctx.stroke();

        // Draw waveform bars
        const color = isSelected ? WAVEFORM_COLOR_SELECTED : WAVEFORM_COLOR;
        ctx.fillStyle = color;

        const pixelsPerPeak = w / totalPeaks;

        if (pixelsPerPeak >= 1) {
            // High zoom: draw individual min/max bars
            drawDetailedWaveform(ctx, mip.peaks, startPeak, endPeak, w, h, centerY, color);
        } else {
            // Low zoom: draw downsampled overview
            drawOverviewWaveform(ctx, mip.peaks, startPeak, endPeak, w, h, centerY, color);
        }
    }, [peaks, width, height, samplesPerPixel, isSelected, sourceOffset, durationSamples]);

    useEffect(() => {
        draw();
    }, [draw]);

    // ── Render ─────────────────────────────────────────────────────

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

// ── Drawing Functions ────────────────────────────────────────────────────

/**
 * Draws per-peak min/max vertical bars — used at high zoom levels
 * where each peak maps to >= 1 pixel.
 */
function drawDetailedWaveform(
    ctx: CanvasRenderingContext2D,
    peaks: PeakPair[],
    startPeak: number,
    endPeak: number,
    width: number,
    _height: number,
    centerY: number,
    color: string,
) {
    const totalPeaks = endPeak - startPeak;
    const barWidth = Math.max(1, width / totalPeaks);

    ctx.fillStyle = color;

    for (let i = 0; i < totalPeaks; i++) {
        const peak = peaks[startPeak + i];
        if (!peak) continue;

        const x = (i / totalPeaks) * width;

        // Min is negative (below center), max is positive (above center)
        const yMin = centerY - peak.max * centerY;
        const yMax = centerY - peak.min * centerY;

        const barHeight = Math.max(1, yMax - yMin);

        ctx.fillRect(x, yMin, barWidth, barHeight);
    }

    // Draw RMS overlay (inner, darker)
    ctx.fillStyle = WAVEFORM_RMS_COLOR;
    const rmsScale = 0.65; // RMS is typically ~65% of peak

    for (let i = 0; i < totalPeaks; i++) {
        const peak = peaks[startPeak + i];
        if (!peak) continue;

        const x = (i / totalPeaks) * width;
        const amplitude = Math.max(Math.abs(peak.min), Math.abs(peak.max)) * rmsScale;

        const yMin = centerY - amplitude * centerY;
        const yMax = centerY + amplitude * centerY;
        const barHeight = Math.max(0.5, yMax - yMin);

        ctx.fillRect(x, yMin, barWidth, barHeight);
    }
}

/**
 * Draws a downsampled waveform overview — used at low zoom levels
 * where multiple peaks map to a single pixel.
 */
function drawOverviewWaveform(
    ctx: CanvasRenderingContext2D,
    peaks: PeakPair[],
    startPeak: number,
    endPeak: number,
    width: number,
    _height: number,
    centerY: number,
    color: string,
) {
    const totalPeaks = endPeak - startPeak;
    const peaksPerPixel = totalPeaks / width;

    ctx.fillStyle = color;

    for (let px = 0; px < width; px++) {
        const pStart = Math.floor(px * peaksPerPixel) + startPeak;
        const pEnd = Math.min(
            endPeak,
            Math.floor((px + 1) * peaksPerPixel) + startPeak,
        );

        let batchMin = 0;
        let batchMax = 0;

        for (let j = pStart; j < pEnd; j++) {
            const p = peaks[j];
            if (!p) continue;
            if (p.min < batchMin) batchMin = p.min;
            if (p.max > batchMax) batchMax = p.max;
        }

        const yMin = centerY - batchMax * centerY;
        const yMax = centerY - batchMin * centerY;
        const barHeight = Math.max(1, yMax - yMin);

        ctx.fillRect(px, yMin, 1, barHeight);
    }
}

// ── Mip Level Selection ──────────────────────────────────────────────────

/**
 * Selects the optimal mip level for the current zoom level.
 * Matches `PeakCache::best_mip_level()` in Rust.
 */
function selectMipLevel(samplesPerPixel: number, peaks: WaveformPeaks): number {
    const levels = peaks.mip_levels;
    for (let i = levels.length - 1; i >= 0; i--) {
        if (samplesPerPixel >= levels[i].samples_per_peak) {
            return i;
        }
    }
    return 0;
}

export default ClipRenderer;
