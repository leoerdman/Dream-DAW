import * as engine from '@/shared/api/engine';
import type { PeakPair, WaveformPeaks } from '@/shared/api/engine';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';

const CLIP_PEAK_CACHE = new Map<string, WaveformPeaks>();
const CLIP_PEAK_INFLIGHT = new Map<string, Promise<WaveformPeaks>>();
// BUG-037 FIX: Cap peak cache to prevent unbounded memory growth across sessions.
const MAX_PEAK_CACHE_SIZE = 200;

const WAVEFORM_COLOR = 'var(--token-color-rgba-120-200-255-0d85)';
const WAVEFORM_COLOR_SELECTED = 'var(--token-color-rgba-160-230-255-0d95)';
const WAVEFORM_RMS_COLOR = 'var(--token-color-rgba-80-160-220-0d6)';
const CENTER_LINE_COLOR = 'var(--token-color-rgba-255-255-255-0d12)';

export async function loadPeaksCached(filePath: string): Promise<WaveformPeaks> {
    const cached = CLIP_PEAK_CACHE.get(filePath);
    if (cached) return cached;

    const inflight = CLIP_PEAK_INFLIGHT.get(filePath);
    if (inflight) return inflight;

    const request = engine.getWaveformPeaksBinary(filePath)
        .then((data) => {
            CLIP_PEAK_CACHE.set(filePath, data);
            CLIP_PEAK_INFLIGHT.delete(filePath);
            // BUG-037 FIX: Evict oldest entries when cache exceeds max size.
            if (CLIP_PEAK_CACHE.size > MAX_PEAK_CACHE_SIZE) {
                const keysIter = CLIP_PEAK_CACHE.keys();
                for (let i = 0; i < 50; i++) {
                    const oldest = keysIter.next();
                    if (oldest.done) break;
                    CLIP_PEAK_CACHE.delete(oldest.value);
                }
            }
            return data;
        })
        .catch((err) => {
            CLIP_PEAK_INFLIGHT.delete(filePath);
            throw err;
        });

    CLIP_PEAK_INFLIGHT.set(filePath, request);
    return request;
}

export function drawClipWaveform(
    canvas: HTMLCanvasElement,
    peaks: WaveformPeaks,
    width: number,
    height: number,
    samplesPerPixel: number,
    isSelected: boolean,
    sourceOffset: number,
    durationSamples: number,
) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const mipIdx = selectMipLevel(samplesPerPixel, peaks);
    const mip = peaks.mip_levels[mipIdx];
    if (!mip || mip.peaks.length === 0) return;

    const spp = mip.samples_per_peak;
    const centerY = height / 2;
    const startPeak = Math.floor(sourceOffset / spp);
    const endPeak = Math.min(mip.peaks.length, Math.ceil((sourceOffset + durationSamples) / spp));
    const totalPeaks = endPeak - startPeak;
    if (totalPeaks <= 0) return;

    ctx.strokeStyle = CENTER_LINE_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();

    const waveformStyle = useSettingsStore.getState().settings.waveformStyle;
    const isClassic = waveformStyle === 'classic';
    const color = isSelected
        ? (isClassic ? 'var(--token-color-rgba-0-0-0-0d85)' : WAVEFORM_COLOR_SELECTED)
        : (isClassic ? 'var(--token-color-rgba-0-0-0-0d65)' : WAVEFORM_COLOR);
    const rmsColor = isClassic ? 'var(--token-color-rgba-0-0-0-0d6)' : WAVEFORM_RMS_COLOR;

    const pixelsPerPeak = width / totalPeaks;
    if (pixelsPerPeak >= 1) {
        drawDetailedWaveform(ctx, mip.peaks, startPeak, endPeak, width, centerY, color, rmsColor);
    } else {
        drawOverviewWaveform(ctx, mip.peaks, startPeak, endPeak, width, centerY, color);
    }
}

function drawDetailedWaveform(
    ctx: CanvasRenderingContext2D,
    peaks: PeakPair[],
    startPeak: number,
    endPeak: number,
    width: number,
    centerY: number,
    color: string,
    rmsColor: string,
) {
    const totalPeaks = endPeak - startPeak;
    const barWidth = Math.max(1, width / totalPeaks);
    ctx.fillStyle = color;

    for (let i = 0; i < totalPeaks; i += 1) {
        const peak = peaks[startPeak + i];
        if (!peak) continue;
        const x = (i / totalPeaks) * width;
        const yMin = centerY - peak.max * centerY;
        const yMax = centerY - peak.min * centerY;
        const barHeight = Math.max(1, yMax - yMin);
        ctx.fillRect(x, yMin, barWidth, barHeight);
    }

    ctx.fillStyle = rmsColor;
    const rmsScale = 0.65;
    for (let i = 0; i < totalPeaks; i += 1) {
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

function drawOverviewWaveform(
    ctx: CanvasRenderingContext2D,
    peaks: PeakPair[],
    startPeak: number,
    endPeak: number,
    width: number,
    centerY: number,
    color: string,
) {
    const totalPeaks = endPeak - startPeak;
    const peaksPerPixel = totalPeaks / width;
    ctx.fillStyle = color;

    for (let px = 0; px < width; px += 1) {
        const pStart = Math.floor(px * peaksPerPixel) + startPeak;
        const pEnd = Math.min(endPeak, Math.floor((px + 1) * peaksPerPixel) + startPeak);
        let batchMin = 0;
        let batchMax = 0;

        for (let j = pStart; j < pEnd; j += 1) {
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

function selectMipLevel(samplesPerPixel: number, peaks: WaveformPeaks): number {
    const levels = peaks.mip_levels;
    for (let i = levels.length - 1; i >= 0; i -= 1) {
        if (samplesPerPixel >= levels[i].samples_per_peak) return i;
    }
    return 0;
}

