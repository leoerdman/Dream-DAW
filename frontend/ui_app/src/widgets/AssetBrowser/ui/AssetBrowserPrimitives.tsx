import { memo, useEffect, useRef, useState } from 'react';
import type { PeakPair } from '@/shared/api/engine';

export type BrowserGlyphName =
    | 'star'
    | 'search'
    | 'folder-tree'
    | 'grid'
    | 'wave'
    | 'wave-bars'
    | 'music'
    | 'drum'
    | 'piano'
    | 'plug'
    | 'sliders'
    | 'clapper'
    | 'sine'
    | 'hard-drive'
    | 'package'
    | 'user'
    | 'file'
    | 'folder'
    | 'folder-plus'
    | 'chevron-right'
    | 'chevron-down'
    | 'arrow-left'
    | 'hourglass'
    | 'triangle-alert'
    | 'headphones'
    | 'settings';

type AssetBrowserItemLike = {
    type: 'audio' | 'instrument' | 'audioEffect' | 'midiEffect' | 'plugin' | 'folder' | 'project' | 'preset' | 'other';
    format?: string;
    meta?: string;
    name: string;
    path?: string;
    pluginSource?: 'internal' | 'vst2' | 'vst3' | 'au' | 'external';
};

const itemTypeToIcon: Record<AssetBrowserItemLike['type'], BrowserGlyphName> = {
    audio: 'wave',
    instrument: 'piano',
    audioEffect: 'sliders',
    midiEffect: 'music',
    plugin: 'plug',
    folder: 'folder',
    project: 'file',
    preset: 'star',
    other: 'grid',
};

// BUG-95 FIX: simplified — all types use primary except 'other'
const itemTypeColor = (type: AssetBrowserItemLike['type']) =>
    type === 'other' ? 'var(--color-text-secondary)' : 'var(--color-text-primary)';

// BUG-94 FIX: use pluginSource from schema (single source of truth) instead of re-detecting
const pluginVersionBadge = (item?: AssetBrowserItemLike): '2' | '3' | null => {
    if (!item || item.type !== 'plugin') return null;
    if (item.pluginSource === 'internal') return null;
    if (item.pluginSource === 'vst3') return '3';
    if (item.pluginSource === 'vst2') return '2';
    return null;
};

// BUG-26 FIX: wrapped in memo to prevent unnecessary re-renders
export const TypeIcon = memo(({ type, item }: { type: AssetBrowserItemLike['type']; item?: AssetBrowserItemLike }) => {
    const badge = pluginVersionBadge(item);
    return (
        <span style={{ position: 'relative', display: 'inline-flex', color: itemTypeColor(type) }}>
            <BrowserGlyph name={itemTypeToIcon[type]} size={11} />
            {badge && (
                <span style={{
                    position: 'absolute',
                    right: -4,
                    bottom: -5,
                    minWidth: 9,
                    height: 9,
                    borderRadius: 'var(--radius-full)',
                    background: 'var(--color-bg-header)',
                    border: 'var(--space-px) solid var(--color-divider)',
                    color: 'var(--color-text-secondary)',
                    fontSize: 'var(--font-size-micro)',
                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
                    lineHeight: 'var(--token-size-px-9)',
                    textAlign: 'center',
                    fontFamily: 'var(--font-role-data)',
                    pointerEvents: 'none',
                }}>
                    {badge}
                </span>
            )}
        </span>
    );
});

// BUG-25 FIX: wrapped in memo to prevent unnecessary re-renders per row
export const BrowserGlyph = memo(function BrowserGlyph({
    name,
    size = 12,
    color = 'currentColor',
    stroke = 1.8,
}: {
    name: BrowserGlyphName;
    size?: number;
    color?: string;
    stroke?: number;
}) {
    const commonProps = {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: color,
        strokeWidth: stroke,
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
    };

    switch (name) {
        case 'star':
            return <svg {...commonProps}><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z" /></svg>;
        case 'search':
            return <svg {...commonProps}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
        case 'folder-tree':
            return <svg {...commonProps}><path d="M3 19h7M3 12h7M3 5h7M10 12h4v7h7" /><path d="M14 19h7" /></svg>;
        case 'grid':
            return <svg {...commonProps}><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>;
        case 'wave':
            return <svg {...commonProps}><path d="M2 12c2.2 0 2.2-6 4.4-6s2.2 12 4.4 12 2.2-12 4.4-12 2.2 6 4.4 6 2.2-6 4.4-6" /></svg>;
        case 'wave-bars':
            return <svg {...commonProps}><path d="M4 18V8M8 20V6M12 16V10M16 19V7M20 14v-4" /></svg>;
        case 'music':
            return <svg {...commonProps}><path d="M9 18V6l10-2v12" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="16" r="2" /></svg>;
        case 'drum':
            return <svg {...commonProps}><ellipse cx="12" cy="8" rx="8" ry="3" /><path d="M4 8v7c0 1.7 3.6 3 8 3s8-1.3 8-3V8" /></svg>;
        case 'piano':
            return <svg {...commonProps}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 4v10M12 4v10M16 4v10" /></svg>;
        case 'plug':
            return <svg {...commonProps}><path d="M7 9h10v4a5 5 0 0 1-5 5 5 5 0 0 1-5-5Z" /><path d="M10 5v4M14 5v4M12 18v3" /></svg>;
        case 'sliders':
            return <svg {...commonProps}><path d="M4 21v-7M4 10V3M12 21v-4M12 13V3M20 21v-9M20 8V3" /><path d="M2 14h4M10 13h4M18 8h4" /></svg>;
        case 'clapper':
            return <svg {...commonProps}><rect x="3" y="8" width="18" height="13" rx="2" /><path d="m3 8 3-5h15v5M8 3l-3 5M13 3l-3 5M18 3l-3 5" /></svg>;
        case 'sine':
            return <svg {...commonProps}><path d="M2 12c2.7 0 2.7-6 5.4-6s2.7 12 5.4 12 2.7-12 5.4-12S21 12 22 12" /></svg>;
        case 'hard-drive':
            return <svg {...commonProps}><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M3 13h18M8 16h.01M12 16h.01" /></svg>;
        case 'package':
            return <svg {...commonProps}><path d="m12 3 8 4-8 4-8-4 8-4Z" /><path d="M4 7v10l8 4 8-4V7" /><path d="M12 11v10" /></svg>;
        case 'user':
            return <svg {...commonProps}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
        case 'file':
            return <svg {...commonProps}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6" /></svg>;
        case 'folder':
            return <svg {...commonProps}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>;
        case 'folder-plus':
            return <svg {...commonProps}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M12 10v6M9 13h6" /></svg>;
        case 'chevron-right':
            return <svg {...commonProps}><path d="m9 6 6 6-6 6" /></svg>;
        case 'chevron-down':
            return <svg {...commonProps}><path d="m6 9 6 6 6-6" /></svg>;
        case 'arrow-left':
            return <svg {...commonProps}><path d="M19 12H5M12 19l-7-7 7-7" /></svg>;
        case 'hourglass':
            return <svg {...commonProps}><path d="M6 3h12M6 21h12M8 3c0 4 8 4 8 9s-8 5-8 9M16 3c0 4-8 4-8 9s8 5 8 9" /></svg>;
        case 'triangle-alert':
            return <svg {...commonProps}><path d="M12 3 2 21h20L12 3Z" /><path d="M12 9v5M12 18h.01" /></svg>;
        case 'headphones':
            return <svg {...commonProps}><path d="M4 12a8 8 0 0 1 16 0v6a2 2 0 0 1-2 2h-2v-6h4M4 14h4v6H6a2 2 0 0 1-2-2z" /></svg>;
        case 'settings':
            return <svg {...commonProps}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 1 1-4 0v-.2a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a2 2 0 1 1 0-4h.2a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2 1 1 0 0 0 .6-.9V4a2 2 0 1 1 4 0v.2a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1 1 1 0 0 0 .9.6h.2a2 2 0 1 1 0 4h-.2a1 1 0 0 0-.9.6Z" /></svg>;
        default:
            return <svg {...commonProps}><circle cx="12" cy="12" r="4" /></svg>;
    }
});

export const FilterPill = ({
    options, value, onChange,
}: {
    options: string[];
    value: number;
    onChange: (v: number) => void;
}) => (
    <button
        onClick={() => onChange((value + 1) % options.length)}
        style={{
            background: value > 0 ? 'var(--color-control-bg-active)' : 'var(--color-control-bg)',
            color: value > 0 ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
            border: 'none',
            borderRadius: 'var(--radius-xs)',
            padding: 'var(--token-size-px-3) var(--space-1-5)',
            fontSize: 'var(--font-size-xs)',
            cursor: 'pointer',
            fontWeight: 'var(--font-weight-semibold)' as unknown as number,
            whiteSpace: 'nowrap',
        }}
    >
        {options[value]}
    </button>
);

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
        ctx.fillStyle = 'color-mix(in srgb, black 30%, transparent)';
        ctx.beginPath();
        ctx.roundRect(0, 0, w, h, 4);
        ctx.fill();

        const mid = h / 2;
        ctx.strokeStyle = 'color-mix(in srgb, white 6%, transparent)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(w, mid);
        ctx.stroke();

        const peakCount = peaks.length;
        const barWidth = w / peakCount;
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, 'color-mix(in srgb, var(--color-accent-primary) 90%, transparent)');
        gradient.addColorStop(0.45, 'color-mix(in srgb, var(--color-accent-primary) 60%, transparent)');
        gradient.addColorStop(0.55, 'color-mix(in srgb, var(--color-accent-primary) 60%, transparent)');
        gradient.addColorStop(1, 'color-mix(in srgb, var(--color-accent-primary) 90%, transparent)');
        ctx.fillStyle = gradient;

        for (let i = 0; i < peakCount; i++) {
            const { min, max } = peaks[i];
            const x = i * barWidth;
            const yMax = mid - max * mid;
            const yMin = mid - min * mid;
            const barH = Math.max(1, yMin - yMax);
            ctx.fillRect(x, yMax, Math.max(0.8, barWidth - 0.3), barH);
        }
    }, [peaks, height, containerWidth]);

    return (
        <div ref={containerRef} style={{ width: '100%', overflow: 'hidden', borderRadius: 'var(--radius-md)' }}>
            <canvas
                ref={canvasRef}
                style={{
                    display: 'block',
                    width: '100%',
                    height,
                }}
            />
        </div>
    );
};
