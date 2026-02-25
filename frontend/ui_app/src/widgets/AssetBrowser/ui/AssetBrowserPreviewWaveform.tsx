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

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.30)';
        ctx.beginPath();
        ctx.roundRect(0, 0, w, h, 4);
        ctx.fill();

        const mid = h / 2;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(w, mid);
        ctx.stroke();

        const accentRaw = getComputedStyle(container).getPropertyValue('--color-accent-primary').trim();
        const accentColor = accentRaw || '#00bfff';

        const peakCount = peaks.length;
        const barWidth = w / peakCount;
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        const parseColorToRgb = (color: string): [number, number, number] => {
            const tmp = document.createElement('canvas').getContext('2d');
            if (!tmp) return [0, 191, 255];
            tmp.fillStyle = color;
            const parsed = tmp.fillStyle;
            if (parsed.startsWith('#')) {
                const hex = parsed.slice(1);
                return [
                    parseInt(hex.slice(0, 2), 16),
                    parseInt(hex.slice(2, 4), 16),
                    parseInt(hex.slice(4, 6), 16),
                ];
            }
            const m = parsed.match(/(\d+)/g);
            return m ? [+m[0], +m[1], +m[2]] : [0, 191, 255];
        };
        const [ar, ag, ab] = parseColorToRgb(accentColor);
        gradient.addColorStop(0, `rgba(${ar}, ${ag}, ${ab}, 0.90)`);
        gradient.addColorStop(0.45, `rgba(${ar}, ${ag}, ${ab}, 0.60)`);
        gradient.addColorStop(0.55, `rgba(${ar}, ${ag}, ${ab}, 0.60)`);
        gradient.addColorStop(1, `rgba(${ar}, ${ag}, ${ab}, 0.90)`);
        ctx.fillStyle = gradient;

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
    }, [peaks, height, containerWidth]);

    return (
        <div ref={containerRef} style={{ width: '100%', overflow: 'hidden', borderRadius: 'var(--radius-md)' }}>
            <canvas ref={canvasRef} />
        </div>
    );
};
