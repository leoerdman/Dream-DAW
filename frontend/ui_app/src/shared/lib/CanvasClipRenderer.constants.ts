import { clamp01 } from '@/shared/lib/audioMath';
export type WaveformStyle = 'default' | 'classic' | 'colored';
export const HEADER_HEIGHT = 22; // SSOT: Must match CLIP_HEADER_HEIGHT_PX in TimelineEngine.types.ts
export const CLIP_RADIUS = 0;
export const FADE_HANDLE_SIZE = 5; // SSOT: Square handle side length (px), used in renderer + engine hit test
export const FADE_HANDLE_EDGE_PAD = 4; // SSOT: Min px from clip edge for fade handle positioning
export const FADE_CURVE_CLAMP_MIN = 0.05; // SSOT: Minimum fade curve value (avoids linear degenerate cases)
export const FADE_CURVE_CLAMP_MAX = 0.95; // SSOT: Maximum fade curve value
export const CLIP_BODY_COLOR_MULTIPLIER = 0.60; // SSOT: Body color = header color × this
export const CLIP_DIVIDER_COLOR_MULTIPLIER = 0.50; // SSOT: Divider color = header color × this

// ── Clip alpha values ──
export const CLIP_HEADER_ALPHA = 0.95;
export const CLIP_BODY_ALPHA = 0.85;
export const CLIP_DIVIDER_ALPHA = 0.80;
export const CLIP_DISABLED_ALPHA = 0.25;
export const CLIP_MUTED_ALPHA = 0.50;
export const AUTOMATION_DIM_ALPHA = 0.55; // SSOT: Alpha when clips are dimmed for automation view or non-selected track
export const MUTED_WAVEFORM_FILL_ALPHA = 0.55; // SSOT: Waveform fill alpha when clip is muted

// ── Rendering thresholds (px) ──
export const SMALL_CLIP_THRESHOLD_PX = 4; // Clips narrower than this get simplified rendering
export const MIN_WAVEFORM_BODY_PX = 8; // Minimum body height to render waveform/MIDI
export const MIN_FADE_UI_WIDTH_PX = 14; // Minimum clip width to show fade handles
export const MIN_FADE_UI_BODY_PX = 10; // Minimum body height to show fade handles
export const MIN_FADE_WIDTH_PX = 8; // SSOT: Minimum rendered fade width in px (engine hit test + renderer)
export const MIN_FADE_BODY_HEIGHT_PX = 6; // SSOT: Minimum body height for fade curve calculations
export const CLIP_BODY_INSET = 2; // Inset px between body and clip edge (bottom/header gap)

// ── Muted gray (reused across waveform, outline, MIDI) ──
export const MUTED_GRAY_R = 120;
export const MUTED_GRAY_G = 120;
export const MUTED_GRAY_B = 120;

export const rgba = (r: number, g: number, b: number, a: number): string => `rgba(${r}, ${g}, ${b}, ${a})`;
export const hex = (r: number, g: number, b: number): string =>
    `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

export const SELECTION_HIGHLIGHT_COLOR = rgba(255, 255, 255, 0.2); // SSOT: One white color for marquee and clip body highlight
export const FADE_CURVE_HANDLE_FILL = rgba(255, 196, 96, 0.98);
export const FADE_CURVE_HANDLE_STROKE = rgba(0, 0, 0, 0.75);

// ── Default waveform/MIDI note gray (non-colored mode) ──
export const DEFAULT_WAVEFORM_GRAY_R = 162;
export const DEFAULT_WAVEFORM_GRAY_G = 168;
export const DEFAULT_WAVEFORM_GRAY_B = 178;
export const DROP_TARGET_COLOR = rgba(255, 255, 255, 0.2);
export const DROP_TARGET_BORDER = rgba(255, 255, 255, 0.6);
export const GHOST_CLIP_ALPHA = 0.45;
export const OFFLINE_STRIPE_COLOR = rgba(255, 80, 80, 0.3);
export const CLIP_LABEL_FONT = '10px Inter, -apple-system, sans-serif';
export const FADE_CURVE_POINT_RADIUS = 3.2; // SSOT: Radius of fade curve control points (px)
export const DEFAULT_FADE_CURVE = 0.5; // SSOT: Default fade curve when none specified

// ── MIDI rendering ──
export const MIDI_MAX_VALUE = 127; // MIDI standard max pitch/velocity
export const MIDI_VELOCITY_MIN_ALPHA = 0.3; // SSOT: Minimum alpha for MIDI note velocity rendering
export const MIDI_VELOCITY_ALPHA_RANGE = 0.7; // SSOT: Alpha range for velocity (min + range × (vel/127) = alpha)

// ── Muted clip body ──
export const MUTED_BODY_COLOR = rgba(80, 85, 95, 0.45);

export const FADE_CURVE_HANDLE_RADIUS_PX = 3; // SSOT: Radius for Bezier curve handle (used in renderer + hit test)
export const FADE_CURVE_PRESETS = [0.05, 0.25, 0.5, 0.75, 0.95]; // Range of standard curve shapes
export const FADE_HANDLE_HOTSPOT_PX = 6; // SSOT: Hit test tolerance for fade handles

export const DRAW_AUTOMATION_BACKGROUNDS = false;

// ── Engine edge resize padding ──
export const EDGE_RESIZE_PAD_PX = 2; // Extra px tolerance for edge resize hit detection

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
