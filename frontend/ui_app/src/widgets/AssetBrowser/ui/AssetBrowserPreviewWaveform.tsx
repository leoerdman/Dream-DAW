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
        ctx.fillStyle = bgColor;
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        ctx.roundRect(0, 0, w, h, 4);
        ctx.fill();
        ctx.globalAlpha = 1;

        const mid = h / 2;
        ctx.strokeStyle = guideColor;
        ctx.globalAlpha = 0.25;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(w, mid);
        ctx.stroke();
        ctx.globalAlpha = 1;

        const peakCount = peaks.length;
        const barWidth = w / peakCount;
        ctx.fillStyle = accentColor;
        ctx.globalAlpha = 0.8;

        for (let i = 0; i < peakCount; i += 1) {
            const p = peaks[i];
            const min = Math.max(-1, Math.min(1, p.min));
            const max = Math.max(-1, Math.min(1, p.max));
            const y1 = mid - max * mid;
            const y2 = mid - min * mid;
            const x = i * barWidth;
            const bh = Math.max(1, y2 - y1);
            ctx.fillRect(x, y1, Math.max(0.8, barWidth - 0.3), bh);
        }
        ctx.globalAlpha = 1;
    }, [peaks, height, containerWidth]);

    return (
        <div ref={containerRef} style={{ width: '100%', overflow: 'hidden', borderRadius: 'var(--radius-md)' }}>
            <canvas ref={canvasRef} />
        </div>
    );
};
