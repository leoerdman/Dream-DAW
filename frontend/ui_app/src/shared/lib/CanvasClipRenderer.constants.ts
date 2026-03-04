import { clamp01 } from '@/shared/lib/audioMath';
export const HEADER_HEIGHT = 22; // SSOT: Must match CLIP_HEADER_HEIGHT_PX in TimelineEngine.types.ts
export const CLIP_RADIUS = 0;
export const FADE_HANDLE_SIZE = 5; // SSOT: Square handle side length (px), used in renderer + engine hit test

export const rgba = (r: number, g: number, b: number, a: number): string => `rgba(${r}, ${g}, ${b}, ${a})`;
export const hex = (r: number, g: number, b: number): string =>
    `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

export const SELECTION_HIGHLIGHT_COLOR = rgba(100, 160, 255, 0.32);
export const DROP_TARGET_COLOR = rgba(255, 255, 255, 0.2);
export const DROP_TARGET_BORDER = rgba(255, 255, 255, 0.6);
export const GHOST_CLIP_ALPHA = 0.45;
export const OFFLINE_STRIPE_COLOR = rgba(255, 80, 80, 0.3);
export const CLIP_LABEL_FONT = '10px Inter, -apple-system, sans-serif';

export const snapCanvasLineX = (rawX: number, lineWidthCssPx: number): number => {
    if (!Number.isFinite(rawX)) return rawX;
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    const deviceX = rawX * dpr;
    const deviceWidth = Math.max(1, lineWidthCssPx * dpr);
    const alignedDeviceCenter = Math.round(deviceX - deviceWidth / 2) + deviceWidth / 2;
    return alignedDeviceCenter / dpr;
};

export function applyAlphaMultiplier(color: string, multiplier: number): string {
    const m = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (!m) return color;
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    const baseA = m[4] != null ? Number(m[4]) : 1;
    const a = clamp01(baseA * multiplier);
    return rgba(r, g, b, a);
}
