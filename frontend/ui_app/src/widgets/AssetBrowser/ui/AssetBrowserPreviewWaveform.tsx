import { useEffect, useRef, useState } from 'react';
import type { PeakPair } from '@/shared/api/engine';

export const PreviewWaveform = ({ peaks, height = 48 }: { peaks: PeakPair[]; height?: number }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState(0);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) {
                setContainerWidth(Math.floor(entry.contentRect.width));
            }
        });
        ro.observe(container);
        setContainerWidth(Math.floor(container.getBoundingClientRect().width));
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container || peaks.length === 0 || containerWidth <= 0) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const w = containerWidth;
        const h = height;

        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        ctx.scale(dpr, dpr);

        const style = getComputedStyle(container);
        const bgColor = style.getPropertyValue('--color-bg-elevated').trim() || 'var(--color-bg-elevated)';
        const accentColor = style.getPropertyValue('--color-accent-primary').trim() || 'var(--color-accent-primary)';
        const guideColor = style.getPropertyValue('--color-text-secondary').trim() || 'var(--color-text-secondary)';

        ctx.clearRect(0, 0, w, h);

        // ── Background ──
        ctx.fillStyle = bgColor || '#1a1a2e';
        ctx.globalAlpha = 0.25;
        ctx.beginPath();
        ctx.roundRect(0, 0, w, h, 4);
        ctx.fill();
        ctx.globalAlpha = 1;

        const mid = h / 2;

        // ── Center line ──
        ctx.strokeStyle = guideColor || '#888';
        ctx.globalAlpha = 0.18;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(w, mid);
        ctx.stroke();
        ctx.globalAlpha = 1;

        // ── Waveform gradient ──
        const baseColor = accentColor || '#58a6ff';
        // Canvas gradients can't use color-mix(). Use a simple alpha-adjusted approach.
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, baseColor);
        gradient.addColorStop(0.5, baseColor);
        gradient.addColorStop(1, baseColor);

        const peakCount = peaks.length;
        const step = w / peakCount;

        // ── Draw filled waveform path ──
        ctx.fillStyle = gradient;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(0, mid);
        for (let i = 0; i < peakCount; i++) {
            const p = peaks[i];
            const maxVal = Math.max(-1, Math.min(1, p.max));
            const x = i * step + step * 0.5;
            ctx.lineTo(x, mid - maxVal * mid);
        }
        for (let i = peakCount - 1; i >= 0; i--) {
            const p = peaks[i];
            const minVal = Math.max(-1, Math.min(1, p.min));
            const x = i * step + step * 0.5;
            ctx.lineTo(x, mid - minVal * mid);
        }
        ctx.closePath();
        ctx.fill();

        // ── Bright center stroke for crisp edges ──
        ctx.strokeStyle = baseColor;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 0.8;
        // Top edge
        ctx.beginPath();
        for (let i = 0; i < peakCount; i++) {
            const p = peaks[i];
            const maxVal = Math.max(-1, Math.min(1, p.max));
            const x = i * step + step * 0.5;
            if (i === 0) ctx.moveTo(x, mid - maxVal * mid);
            else ctx.lineTo(x, mid - maxVal * mid);
        }
        ctx.stroke();
        // Bottom edge
        ctx.beginPath();
        for (let i = 0; i < peakCount; i++) {
            const p = peaks[i];
            const minVal = Math.max(-1, Math.min(1, p.min));
            const x = i * step + step * 0.5;
            if (i === 0) ctx.moveTo(x, mid - minVal * mid);
            else ctx.lineTo(x, mid - minVal * mid);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
    }, [peaks, height, containerWidth]);

    return (
        <div ref={containerRef} style={{ width: '100%', overflow: 'hidden', borderRadius: 'var(--radius-md)' }}>
            <canvas ref={canvasRef} />
        </div>
    );
};
