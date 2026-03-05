// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Modular Plugin Design System
// ═══════════════════════════════════════════════════════════════════════════
// Unified library of reusable modules at three hierarchy tiers:
//   L3 — Layout containers  (PluginSurfaceLayout, ControlPanel, VizCard, ...)
//   L2 — Mini visualizations (ADSR, Filter EQ, Saturation, GR Meter, ...)
//   L1 — Atomic controls    (re-exported from existing: Knob, Fader, DryWet)
//
// Every plugin surface should be assembled from these building blocks.
// All visual values are driven by design tokens — zero hardcoded colors/sizes.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useCallback, useRef } from 'react';
import { clamp01 } from '@/shared/lib/audioMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    buildSurfaceKnobParams,
    DryWetSection,
    KnobParamGrid,
    pluginPanelCardBaseStyle,
    pluginPanelMetaStyle,
    shouldShowDryWet,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

// ─── Re-export L1 atomics for single-import convenience ──────────────────
export { KnobParamGrid, DryWetSection } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';
export { PluginKnob } from '@/widgets/DeviceRack/StandardPluginControls';
export { PluginFader } from '@/widgets/DeviceRack/StandardPluginControls';
export { DryWetKnob } from '@/widgets/DeviceRack/ui/DryWetKnob';

// ═══════════════════════════════════════════════════════════════════════════
// L3 — LAYOUT CONTAINERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Top-level flex container for all EQ-style plugin surfaces.
 * Children order: ControlPanel | VizCard | DryWetSection.
 */
export const PluginSurfaceLayout = React.memo(({
    children,
    gap,
}: {
    children: React.ReactNode;
    /** Override default gap (defaults to --plugin-surface-gap = 6px). */
    gap?: string;
}) => (
    <div
        data-no-drag
        style={{
            display: 'flex',
            gap: gap ?? 'var(--plugin-surface-gap)',
            height: '100%',
        }}
    >
        {children}
    </div>
));
PluginSurfaceLayout.displayName = 'PluginSurfaceLayout';

/**
 * Left control panel — fixed width, wraps KnobParamGrid with card styling.
 * Automatically applies pluginPanelCardBaseStyle and 2×2 grid.
 */
export const ControlPanel = React.memo(({
    params,
    handlers,
    maxCols = 2,
    minCols = 2,
    width,
    children,
}: {
    params?: DeviceSlot['params'];
    handlers?: SurfaceHandlers;
    maxCols?: number;
    minCols?: number;
    /** Override panel width (defaults to --plugin-control-panel-width = 130px). */
    width?: number | string;
    /** Additional elements below the knob grid. */
    children?: React.ReactNode;
}) => (
    <div style={{
        width: width ?? 'var(--plugin-control-panel-width)',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--plugin-meta-gap)',
    }}>
        {params && params.length > 0 && handlers && (
            <KnobParamGrid
                params={params}
                handlers={handlers}
                maxCols={maxCols}
                minCols={minCols}
            />
        )}
        {children}
    </div>
));
ControlPanel.displayName = 'ControlPanel';

/**
 * Build control panel params helper — thin wrapper for common pattern.
 */
export function useControlPanelParams(
    device: DeviceSlot,
    showDryWet: boolean,
): DeviceSlot['params'] {
    return buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
}

/**
 * Visualization card — right-side container with themed background and overflow clip.
 * SVG or any visualization component goes inside.
 */
export const VizCard = React.memo(({
    background,
    children,
    style,
}: {
    /** CSS background, e.g. var(--plugin-bg-chorus). */
    background?: string;
    children: React.ReactNode;
    /** Additional style overrides. */
    style?: React.CSSProperties;
}) => (
    <div style={{
        ...pluginPanelCardBaseStyle,
        background: background ?? 'var(--plugin-card-bg-main)',
        overflow: 'hidden',
        padding: 0,
        flex: 1,
        position: 'relative',
        ...style,
    }}>
        {children}
    </div>
));
VizCard.displayName = 'VizCard';

/**
 * Column wrapper for VizCard + MetaReadout, forming the center of the layout.
 */
export const VizColumn = React.memo(({
    children,
}: {
    children: React.ReactNode;
}) => (
    <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--plugin-meta-gap)',
    }}>
        {children}
    </div>
));
VizColumn.displayName = 'VizColumn';

/**
 * Meta readout row — displays key parameter values beneath the visualization.
 */
export const MetaReadout = React.memo(({
    children,
}: {
    children: React.ReactNode;
}) => (
    <div style={{
        ...pluginPanelMetaStyle,
        padding: '0 var(--space-1)',
    }}>
        {children}
    </div>
));
MetaReadout.displayName = 'MetaReadout';

/**
 * Horizontal button strip — row of small toggle/action buttons.
 */
export const ButtonStrip = React.memo(({
    children,
    justify = 'center',
}: {
    children: React.ReactNode;
    justify?: 'center' | 'flex-start' | 'flex-end' | 'space-between';
}) => (
    <div style={{
        display: 'flex',
        gap: 6,
        justifyContent: justify,
    }}>
        {children}
    </div>
));
ButtonStrip.displayName = 'ButtonStrip';

/**
 * Single toggle button for ButtonStrip.
 */
export const ToggleButton = React.memo(({
    label,
    active,
    onClick,
}: {
    label: string;
    active: boolean;
    onClick: () => void;
}) => (
    <button
        type="button"
        onClick={onClick}
        style={{
            padding: '3px 14px',
            borderRadius: 'var(--radius-md)',
            border: 'var(--space-px) solid var(--color-divider)',
            background: active ? 'var(--color-accent-primary)' : 'var(--color-bg-elevated)',
            color: active ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
            fontSize: 'var(--font-size-2xs)',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'background 0.15s ease, color 0.15s ease',
        }}
    >
        {label}
    </button>
));
ToggleButton.displayName = 'ToggleButton';

/**
 * Quick-build helper: assembles a full EQ-style surface from minimal inputs.
 * Use this when you don't need per-section customization.
 */
export function usePluginSurfaceProps(device: DeviceSlot) {
    const showDryWet = shouldShowDryWet(device);
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
    return { showDryWet, knobParams };
}

/**
 * SettingsPanel — collapsible secondary knob grid for overflow parameters.
 * Toggled via small gear icon at the bottom of the ControlPanel.
 */
export const SettingsPanel = React.memo(function SettingsPanel({
    params,
    handlers,
    maxCols = 3,
    accent,
}: {
    /** Pre-filtered secondary params to show. */
    params: DeviceSlot['params'];
    handlers: SurfaceHandlers;
    maxCols?: number;
    accent?: string;
}) {
    const [expanded, setExpanded] = React.useState(false);

    if (params.length === 0) return null;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {/* ─── Toggle button ─── */}
            <button
                type="button"
                onClick={() => setExpanded(prev => !prev)}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-sm)',
                    border: 'var(--space-px) solid var(--color-divider)',
                    background: expanded
                        ? 'color-mix(in srgb, var(--color-accent-primary) 20%, transparent)'
                        : 'var(--color-bg-elevated)',
                    color: expanded
                        ? (accent ?? 'var(--color-accent-primary)')
                        : 'var(--color-text-tertiary)',
                    fontSize: 'var(--font-size-2xs)',
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'background 0.15s ease, color 0.15s ease',
                    width: '100%',
                }}
            >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 4.754a3.246 3.246 0 100 6.492 3.246 3.246 0 000-6.492zM5.754 8a2.246 2.246 0 114.492 0 2.246 2.246 0 01-4.492 0z" />
                    <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0a1.845 1.845 0 01-2.75 1.042c-1.556-.936-3.35.858-2.414 2.414.552.919.142 2.112-.843 2.455-1.79.527-1.79 3.065 0 3.592a1.845 1.845 0 011.042 2.75c-.936 1.556.858 3.35 2.414 2.414a1.845 1.845 0 012.455.843c.527 1.79 3.065 1.79 3.592 0a1.846 1.846 0 012.75-1.042c1.556.936 3.35-.858 2.414-2.414a1.845 1.845 0 01.843-2.455c1.79-.527 1.79-3.065 0-3.592a1.845 1.845 0 01-1.042-2.75c.936-1.556-.858-3.35-2.414-2.414a1.845 1.845 0 01-2.455-.843z" />
                </svg>
                {expanded ? '▴' : '▾'}
            </button>

            {/* ─── Expandable knob grid ─── */}
            {expanded && (
                <KnobParamGrid
                    params={params}
                    handlers={handlers}
                    maxCols={maxCols}
                    minCols={2}
                />
            )}
        </div>
    );
});
SettingsPanel.displayName = 'SettingsPanel';

// ═══════════════════════════════════════════════════════════════════════════
// L2 — MINI VISUALIZATION COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════
//
// All L2 components render inside VizCard. They fill 100% width/height
// and use a standardized viewBox of 300×120 for consistency.

const VB_W = 300;
const VB_H = 120;

/** Shared SVG wrapper for all L2 viz components. */
function VizSvg({
    children,
    bgFill,
    viewBox,
}: {
    children: React.ReactNode;
    bgFill?: string;
    viewBox?: string;
}) {
    return (
        <svg
            width="100%"
            height="100%"
            viewBox={viewBox ?? `0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="xMidYMid slice"
            style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)' }}
        >
            {bgFill && <rect x="0" y="0" width={VB_W} height={VB_H} fill={bgFill} />}
            {children}
        </svg>
    );
}

// ─── ADSR Curve ──────────────────────────────────────────────────────────
// Interactive Attack/Decay/Sustain/Release envelope with 4 draggable handles.

export interface AdsrCurveProps {
    /** Attack time 0–1 normalized. */
    attack: number;
    /** Decay time 0–1 normalized. */
    decay: number;
    /** Sustain level 0–1 normalized. */
    sustain: number;
    /** Release time 0–1 normalized. */
    release: number;
    /** Callback: (paramName, normalizedValue) */
    onParamChange?: (name: string, value: number) => void;
    onGestureStart?: (name: string) => void;
    onGestureEnd?: (name: string) => void;
    /** Base accent color. Default: cyan */
    accent?: string;
}

export const AdsrCurve = React.memo(function AdsrCurve({
    attack,
    decay,
    sustain,
    release,
    onParamChange,
    onGestureStart,
    onGestureEnd,
    accent = 'var(--token-color-hex-53b0ff)',
}: AdsrCurveProps) {
    const svgRef = useRef<SVGSVGElement | null>(null);
    const dragRef = useRef<{ param: string; startX: number; startY: number; startVal: number } | null>(null);

    // ── Geometry ──
    const M = 14;       // horizontal margin
    const W = VB_W - 2 * M;   // usable width
    const TOP = 10;     // top margin
    const BOT = 108;    // bottom Y
    const H = BOT - TOP;

    const segA = Math.max(0.02, attack) * 0.28;    // Attack segment fraction of W
    const segD = Math.max(0.02, decay) * 0.22;     // Decay segment
    const segS = 0.3;                                // Sustain hold (fixed fraction)
    const segR = Math.max(0.02, release) * 0.2;    // Release segment

    const totalSeg = segA + segD + segS + segR;
    const scaleX = W / totalSeg;

    const xA = M;                         // Start
    const xB = M + segA * scaleX;         // Attack peak
    const xC = xB + segD * scaleX;        // Decay end / sustain start
    const xD = xC + segS * scaleX;        // Sustain end / release start
    const xE = xD + segR * scaleX;        // Release end

    const susY = BOT - sustain * H;       // Sustain level Y

    const curvePath = [
        `M ${xA} ${BOT}`,                 // Start at bottom-left
        `L ${xB} ${TOP}`,                 // Attack to peak
        `L ${xC} ${susY}`,                // Decay to sustain level
        `L ${xD} ${susY}`,                // Sustain hold
        `L ${xE} ${BOT}`,                 // Release to zero
    ].join(' ');

    const fillPath = `${curvePath} L ${xE} ${BOT} L ${xA} ${BOT} Z`;

    // ── Handle positions ──
    const handles = [
        { param: 'attack', cx: xB, cy: TOP, color: 'var(--token-color-hex-53b0ff)' },
        { param: 'decay', cx: xC, cy: susY, color: 'var(--token-color-hex-7ab6ff)' },
        { param: 'sustain', cx: (xC + xD) / 2, cy: susY, color: 'var(--token-color-hex-78d6ad)' },
        { param: 'release', cx: xE, cy: BOT, color: 'var(--token-color-hex-ffac59)' },
    ];

    // ── Drag interaction ──
    const svgPoint = useCallback((clientX: number, clientY: number) => {
        const svg = svgRef.current;
        if (!svg) return { x: 0, y: 0 };
        const rect = svg.getBoundingClientRect();
        const x = ((clientX - rect.left) / rect.width) * VB_W;
        const y = ((clientY - rect.top) / rect.height) * VB_H;
        return { x, y };
    }, []);

    const onHandlePointerDown = useCallback((e: React.PointerEvent, param: string) => {
        e.preventDefault();
        e.stopPropagation();
        (e.target as SVGElement).setPointerCapture(e.pointerId);
        const pt = svgPoint(e.clientX, e.clientY);
        const startVal = param === 'attack' ? attack : param === 'decay' ? decay : param === 'sustain' ? sustain : release;
        dragRef.current = { param, startX: pt.x, startY: pt.y, startVal };
        onGestureStart?.(param);
    }, [attack, decay, sustain, release, svgPoint, onGestureStart]);

    const onHandlePointerMove = useCallback((e: React.PointerEvent) => {
        if (!dragRef.current) return;
        const { param } = dragRef.current;
        const pt = svgPoint(e.clientX, e.clientY);

        if (param === 'sustain') {
            // Sustain: vertical drag controls level
            const val = clamp01(1 - (pt.y - TOP) / H);
            onParamChange?.(param, val);
        } else {
            // Attack/Decay/Release: horizontal drag controls time
            const delta = (pt.x - dragRef.current.startX) / W;
            const val = clamp01(dragRef.current.startVal + delta * 2);
            onParamChange?.(param, val);
            dragRef.current.startX = pt.x;
            dragRef.current.startVal = val;
        }
    }, [svgPoint, onParamChange, H, W]);

    const onHandlePointerUp = useCallback((e: React.PointerEvent) => {
        if (!dragRef.current) return;
        (e.target as SVGElement).releasePointerCapture(e.pointerId);
        onGestureEnd?.(dragRef.current.param);
        dragRef.current = null;
    }, [onGestureEnd]);

    return (
        <svg
            ref={svgRef}
            width="100%"
            height="100%"
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="xMidYMid slice"
            style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)', cursor: 'default' }}
        >
            <rect x="0" y="0" width={VB_W} height={VB_H} fill="var(--token-color-rgba-8-10-14-0d65)" />

            {/* Grid lines */}
            <line x1={M} y1={BOT} x2={VB_W - M} y2={BOT} stroke="var(--plugin-viz-grid-color)" strokeWidth="0.6" />
            <line x1={M} y1={TOP} x2={VB_W - M} y2={TOP} stroke="var(--plugin-viz-grid-minor)" strokeWidth="0.4" />
            <line x1={M} y1={(TOP + BOT) / 2} x2={VB_W - M} y2={(TOP + BOT) / 2} stroke="var(--plugin-viz-grid-minor)" strokeWidth="0.4" />

            {/* Fill below curve */}
            <path d={fillPath} fill={accent} opacity="0.1" />

            {/* Envelope curve */}
            <path d={curvePath} fill="none" stroke={accent} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />

            {/* Segment labels */}
            <text x={xB} y={BOT + 2} textAnchor="middle" fill="var(--token-color-rgba-255-255-255-0d35)" fontSize="7" fontFamily="var(--font-role-data)">A</text>
            <text x={xC} y={BOT + 2} textAnchor="middle" fill="var(--token-color-rgba-255-255-255-0d35)" fontSize="7" fontFamily="var(--font-role-data)">D</text>
            <text x={(xC + xD) / 2} y={BOT + 2} textAnchor="middle" fill="var(--token-color-rgba-255-255-255-0d35)" fontSize="7" fontFamily="var(--font-role-data)">S</text>
            <text x={xE} y={BOT + 2} textAnchor="middle" fill="var(--token-color-rgba-255-255-255-0d35)" fontSize="7" fontFamily="var(--font-role-data)">R</text>

            {/* Draggable handles */}
            {handles.map((h) => (
                <circle
                    key={h.param}
                    cx={h.cx}
                    cy={h.cy}
                    r={5}
                    fill={h.color}
                    stroke="white"
                    strokeWidth="1.2"
                    style={{ cursor: h.param === 'sustain' ? 'ns-resize' : 'ew-resize', touchAction: 'none' }}
                    onPointerDown={(e) => onHandlePointerDown(e, h.param)}
                    onPointerMove={onHandlePointerMove}
                    onPointerUp={onHandlePointerUp}
                    onPointerCancel={onHandlePointerUp}
                />
            ))}
        </svg>
    );
});

// ─── Saturation Curve ────────────────────────────────────────────────────
// Interactive transfer function — drag the curve to adjust drive.

export type SaturationCurveType = 'soft' | 'hard' | 'tape' | 'tube' | 'fold' | 'digital';

export interface SaturationCurveProps {
    /** Drive amount 0–1. */
    drive: number;
    /** Saturation algorithm type. */
    type?: SaturationCurveType;
    accent?: string;
    /** Interactive: fires when user drags the drive handle. */
    onDriveChange?: (normalizedDrive: number) => void;
    onGestureStart?: () => void;
    onGestureEnd?: () => void;
}

export const SaturationCurve = React.memo(function SaturationCurve({
    drive,
    type = 'soft',
    accent = 'var(--token-color-hex-ff965e)',
    onDriveChange,
    onGestureStart,
    onGestureEnd,
}: SaturationCurveProps) {
    const svgRef = useRef<SVGSVGElement | null>(null);
    const dragRef = useRef<boolean>(false);
    const M = 14;
    const d = clamp01(drive);
    const k = Math.max(8, 60 - d * 48);

    // Curve path per type
    const curveByType: Record<SaturationCurveType, string> = {
        soft: `M ${M} ${VB_H - M} C ${M + k} ${VB_H - M}, ${VB_W - M - k} ${M}, ${VB_W - M} ${M}`,
        hard: `M ${M} ${VB_H - M} L ${M + 40} ${VB_H - M} L ${VB_W / 2} ${M + 10} L ${VB_W - M - 40} ${M + 10} L ${VB_W - M} ${M + 10}`,
        tape: `M ${M} ${VB_H - M} C ${M + k * 0.6} ${VB_H - M - 20}, ${VB_W / 2 - 10} ${M + 20}, ${VB_W / 2 + 20} ${M + 12} Q ${VB_W - M - 20} ${M + 8}, ${VB_W - M} ${M + 14}`,
        tube: `M ${M} ${VB_H - M} Q ${M + 30} ${VB_H * 0.3}, ${VB_W / 2} ${VB_H * 0.35} Q ${VB_W - M - 30} ${VB_H * 0.4}, ${VB_W - M} ${M + 6}`,
        fold: `M ${M} ${VB_H - M} L ${VB_W * 0.3} ${M + 8} L ${VB_W * 0.45} ${VB_H * 0.55} L ${VB_W * 0.6} ${M + 12} L ${VB_W * 0.75} ${VB_H * 0.48} L ${VB_W - M} ${M + 6}`,
        digital: `M ${M} ${VB_H - M} L ${M} ${M + 6} L ${VB_W - M} ${M + 6}`,
    };

    // Fill path (close to bottom)
    const fillPath = `${curveByType[type]} L ${VB_W - M} ${VB_H - M} L ${M} ${VB_H - M} Z`;

    // Draggable drive handle position — midpoint of curve
    const handleX = M + (VB_W - 2 * M) * 0.5;
    const handleY = M + (VB_H - 2 * M) * (1 - d) * 0.45 + M;

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        if (!onDriveChange) return;
        e.preventDefault();
        e.stopPropagation();
        (e.target as SVGElement).setPointerCapture(e.pointerId);
        dragRef.current = true;
        onGestureStart?.();
    }, [onDriveChange, onGestureStart]);

    const onPointerMove = useCallback((e: React.PointerEvent) => {
        if (!dragRef.current || !onDriveChange) return;
        const svg = svgRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const normY = 1 - ((e.clientY - rect.top) / rect.height);
        onDriveChange(clamp01(normY));
    }, [onDriveChange]);

    const onPointerUp = useCallback((e: React.PointerEvent) => {
        if (!dragRef.current) return;
        (e.target as SVGElement).releasePointerCapture(e.pointerId);
        dragRef.current = false;
        onGestureEnd?.();
    }, [onGestureEnd]);

    // Drive % label
    const driveLabel = `${Math.round(d * 100)}%`;

    return (
        <svg
            ref={svgRef}
            width="100%"
            height="100%"
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="xMidYMid slice"
            style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)', cursor: onDriveChange ? 'default' : undefined }}
        >
            <defs>
                <filter id="sat-glow" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
                <linearGradient id="sat-fill-grad" x1="0" y1="1" x2="0" y2="0">
                    <stop offset="0%" stopColor={accent} stopOpacity="0.02" />
                    <stop offset="100%" stopColor={accent} stopOpacity="0.18" />
                </linearGradient>
            </defs>
            <rect x="0" y="0" width={VB_W} height={VB_H} fill="var(--token-color-rgba-20-13-9-0d65)" />
            {/* Grid */}
            <line x1={M} y1={VB_H / 2} x2={VB_W - M} y2={VB_H / 2} stroke="var(--plugin-viz-grid-minor)" strokeWidth="0.4" />
            <line x1={VB_W / 2} y1={M} x2={VB_W / 2} y2={VB_H - M} stroke="var(--plugin-viz-grid-minor)" strokeWidth="0.4" />
            {/* Diagonal reference */}
            <line x1={M} y1={VB_H - M} x2={VB_W - M} y2={M} stroke="var(--plugin-viz-grid-color)" strokeWidth="0.8" strokeDasharray="4,3" />
            {/* Gradient fill under curve */}
            <path d={fillPath} fill="url(#sat-fill-grad)" />
            {/* Transfer function curve */}
            <path d={curveByType[type]} fill="none" stroke={accent} strokeWidth="2.4" strokeLinecap="round" />
            {/* Origin dot */}
            <circle cx={M} cy={VB_H - M} r="3" fill={accent} opacity="0.7" />
            {/* Axis labels */}
            <text x={M + 2} y={VB_H - M + 10} fill="var(--token-color-rgba-255-255-255-0d3)" fontSize="7" fontFamily="var(--font-role-data)">In</text>
            <text x={M - 10} y={M + 4} fill="var(--token-color-rgba-255-255-255-0d3)" fontSize="7" fontFamily="var(--font-role-data)">Out</text>
            {/* Drive handle (interactive) */}
            {onDriveChange && (
                <circle
                    cx={handleX}
                    cy={handleY}
                    r={6}
                    fill={accent}
                    stroke="white"
                    strokeWidth="1.5"
                    filter="url(#sat-glow)"
                    style={{ cursor: 'ns-resize', touchAction: 'none' }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                />
            )}
            {/* Drive value readout */}
            <text x={VB_W - M - 4} y={M + 10} textAnchor="end" fill={accent} fontSize="9" fontFamily="var(--font-role-data)" opacity="0.8">{driveLabel}</text>
        </svg>
    );
});

// ─── Mini Filter EQ ──────────────────────────────────────────────────────
// Interactive 2-handle HP/LP filter — drag handles to change frequency.

export interface MiniFilterEqProps {
    /** HP frequency, normalized 0–1 (log scale 20–20000). */
    hpFreqNorm: number;
    /** LP frequency, normalized 0–1 (log scale 20–20000). */
    lpFreqNorm: number;
    hpQ?: number;
    lpQ?: number;
    accentHp?: string;
    accentLp?: string;
    /** Interactive: fires on HP/LP handle drag. paramName = 'hp' or 'lp'. */
    onFreqChange?: (paramName: string, normalizedFreq: number) => void;
    onGestureStart?: (paramName: string) => void;
    onGestureEnd?: (paramName: string) => void;
}

export const MiniFilterEq = React.memo(function MiniFilterEq({
    hpFreqNorm,
    lpFreqNorm,
    hpQ: _hpQ = 0.5,
    lpQ: _lpQ = 0.5,
    accentHp = 'var(--token-color-hex-ffac59)',
    accentLp = 'var(--token-color-hex-7ab6ff)',
    onFreqChange,
    onGestureStart,
    onGestureEnd,
}: MiniFilterEqProps) {
    const svgRef = useRef<SVGSVGElement | null>(null);
    const dragRef = useRef<{ handle: 'hp' | 'lp' } | null>(null);
    const M = 14;
    const W = VB_W - 2 * M;
    const hpX = M + clamp01(hpFreqNorm) * W;
    const lpX = M + clamp01(lpFreqNorm) * W;
    const midY = VB_H * 0.4;
    const botY = VB_H - M;

    // Passband fill path (between HP and LP)
    const passbandFill = `M ${hpX} ${midY} L ${lpX} ${midY} Q ${lpX + 20} ${midY}, ${VB_W - M} ${botY} L ${VB_W - M} ${botY} L ${M} ${botY} Q ${hpX - 20} ${botY}, ${hpX} ${midY} Z`;

    // Frequency label helpers
    const normToHz = (n: number) => {
        const hz = 20 * Math.pow(1000, n);
        return hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${Math.round(hz)}Hz`;
    };

    const onHandleDown = useCallback((e: React.PointerEvent, handle: 'hp' | 'lp') => {
        if (!onFreqChange) return;
        e.preventDefault();
        e.stopPropagation();
        (e.target as SVGElement).setPointerCapture(e.pointerId);
        dragRef.current = { handle };
        onGestureStart?.(handle);
    }, [onFreqChange, onGestureStart]);

    const onHandleMove = useCallback((e: React.PointerEvent) => {
        if (!dragRef.current || !onFreqChange) return;
        const svg = svgRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const normX = clamp01(((e.clientX - rect.left) / rect.width * VB_W - M) / W);
        onFreqChange(dragRef.current.handle, normX);
    }, [onFreqChange, W]);

    const onHandleUp = useCallback((e: React.PointerEvent) => {
        if (!dragRef.current) return;
        (e.target as SVGElement).releasePointerCapture(e.pointerId);
        onGestureEnd?.(dragRef.current.handle);
        dragRef.current = null;
    }, [onGestureEnd]);

    const isInteractive = !!onFreqChange;

    return (
        <svg
            ref={svgRef}
            width="100%"
            height="100%"
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="xMidYMid slice"
            style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)' }}
        >
            <defs>
                <filter id="eq-glow" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="2.5" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
                <linearGradient id="eq-passband-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={accentHp} stopOpacity="0.14" />
                    <stop offset="100%" stopColor={accentHp} stopOpacity="0.02" />
                </linearGradient>
            </defs>
            <rect x="0" y="0" width={VB_W} height={VB_H} fill="var(--token-color-rgba-8-10-14-0d65)" />
            {/* Frequency grid lines */}
            {[0.1, 0.3, 0.5, 0.7, 0.9].map(n => (
                <line key={n} x1={M + n * W} y1={M} x2={M + n * W} y2={botY} stroke="var(--plugin-viz-grid-minor)" strokeWidth="0.3" />
            ))}
            <line x1={M} y1={midY} x2={VB_W - M} y2={midY} stroke="var(--plugin-viz-grid-color)" strokeWidth="0.6" />
            {/* Passband fill */}
            <path d={passbandFill} fill="url(#eq-passband-grad)" />
            {/* HP curve */}
            <path d={`M ${M} ${botY} Q ${hpX - 20} ${botY}, ${hpX} ${midY} L ${VB_W - M} ${midY}`} fill="none" stroke={accentHp} strokeWidth="2.2" strokeLinecap="round" />
            {/* LP curve */}
            <path d={`M ${M} ${midY} L ${lpX} ${midY} Q ${lpX + 20} ${midY}, ${VB_W - M} ${botY}`} fill="none" stroke={accentLp} strokeWidth="2.2" strokeLinecap="round" />
            {/* Axis labels */}
            <text x={M + 2} y={botY + 10} fill="var(--token-color-rgba-255-255-255-0d35)" fontSize="7" fontFamily="var(--font-role-data)">20Hz</text>
            <text x={VB_W - M - 28} y={botY + 10} fill="var(--token-color-rgba-255-255-255-0d35)" fontSize="7" fontFamily="var(--font-role-data)">20kHz</text>
            {/* HP handle freq label */}
            <text x={hpX} y={midY - 10} textAnchor="middle" fill={accentHp} fontSize="8" fontFamily="var(--font-role-data)" opacity="0.85">{normToHz(hpFreqNorm)}</text>
            {/* LP handle freq label */}
            <text x={lpX} y={midY - 10} textAnchor="middle" fill={accentLp} fontSize="8" fontFamily="var(--font-role-data)" opacity="0.85">{normToHz(lpFreqNorm)}</text>
            {/* HP handle */}
            <circle
                cx={hpX} cy={midY} r={isInteractive ? 6 : 5}
                fill={accentHp} stroke="white" strokeWidth="1.3"
                filter={isInteractive ? 'url(#eq-glow)' : undefined}
                style={isInteractive ? { cursor: 'ew-resize', touchAction: 'none' } : undefined}
                onPointerDown={isInteractive ? (e) => onHandleDown(e, 'hp') : undefined}
                onPointerMove={isInteractive ? onHandleMove : undefined}
                onPointerUp={isInteractive ? onHandleUp : undefined}
                onPointerCancel={isInteractive ? onHandleUp : undefined}
            />
            {/* LP handle */}
            <circle
                cx={lpX} cy={midY} r={isInteractive ? 6 : 5}
                fill={accentLp} stroke="white" strokeWidth="1.3"
                filter={isInteractive ? 'url(#eq-glow)' : undefined}
                style={isInteractive ? { cursor: 'ew-resize', touchAction: 'none' } : undefined}
                onPointerDown={isInteractive ? (e) => onHandleDown(e, 'lp') : undefined}
                onPointerMove={isInteractive ? onHandleMove : undefined}
                onPointerUp={isInteractive ? onHandleUp : undefined}
                onPointerCancel={isInteractive ? onHandleUp : undefined}
            />
        </svg>
    );
});

// ─── Gain Reduction Meter ────────────────────────────────────────────────
// Vertical GR bar with traffic-light color zones.

export interface GainReductionMeterProps {
    /** Current GR in dB (positive = more reduction). */
    grDb: number;
    /** Max displayable GR. Default: 24 */
    maxDb?: number;
    /** Orientation. Default: vertical */
    orientation?: 'vertical' | 'horizontal';
}

export const GainReductionMeter = React.memo(function GainReductionMeter({
    grDb,
    maxDb = 24,
    orientation = 'vertical',
}: GainReductionMeterProps) {
    const normalizedGr = clamp01(Math.abs(grDb) / maxDb);
    const color = Math.abs(grDb) > 12
        ? 'var(--color-error)'
        : Math.abs(grDb) > 4
            ? 'var(--color-warning)'
            : 'var(--color-success)';

    if (orientation === 'horizontal') {
        return (
            <div style={{
                height: 8,
                borderRadius: 'var(--radius-full)',
                background: 'var(--color-bg-tertiary)',
                overflow: 'hidden',
                border: 'var(--space-px) solid var(--color-divider)',
            }}>
                <div style={{
                    width: `${normalizedGr * 100}%`,
                    height: '100%',
                    background: color,
                    borderRadius: 'var(--radius-full)',
                    transition: 'width 60ms linear',
                }} />
            </div>
        );
    }

    return (
        <div style={{
            width: 14,
            height: '100%',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-tertiary)',
            border: 'var(--space-px) solid var(--color-divider)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            overflow: 'hidden',
        }}>
            <div style={{
                width: '100%',
                height: `${normalizedGr * 100}%`,
                background: color,
                borderRadius: 2,
                transition: 'height 60ms linear',
            }} />
        </div>
    );
});

// ─── Compression Curve ───────────────────────────────────────────────────
// Interactive input/output transfer function — drag threshold knee point.

export interface CompressionCurveProps {
    /** Threshold 0–1 normalized (0=max compression, 1=no compression). */
    thresholdNorm: number;
    /** Ratio 0–1 where 0=1:1, 1=∞:1. */
    ratioNorm: number;
    kneeNorm?: number;
    grDb?: number;
    accent?: string;
    variant?: 'standard' | 'glue' | 'multiband';
    /** Interactive: fires on threshold handle drag. */
    onThresholdChange?: (normalizedThr: number) => void;
    onGestureStart?: () => void;
    onGestureEnd?: () => void;
}

export const CompressionCurve = React.memo(function CompressionCurve({
    thresholdNorm,
    ratioNorm,
    kneeNorm: _knee = 0.2,
    grDb = 0,
    accent = 'var(--token-color-hex-6ac3ff)',
    variant = 'standard',
    onThresholdChange,
    onGestureStart,
    onGestureEnd,
}: CompressionCurveProps) {
    const svgRef = useRef<SVGSVGElement | null>(null);
    const dragRef = useRef<boolean>(false);
    const M = 20;
    const W = VB_W - 2 * M;
    const H = VB_H - 2 * M;
    const thrX = M + clamp01(thresholdNorm) * W;
    const thrY = VB_H - M - clamp01(thresholdNorm) * H;
    const slopeAbove = 1 - clamp01(ratioNorm) * 0.9;
    const endY = thrY - (VB_W - M - thrX) * slopeAbove * (H / W);

    const grBarH = clamp01(Math.abs(grDb) / 24) * H;
    const grColor = Math.abs(grDb) > 12 ? 'var(--color-error)' : Math.abs(grDb) > 4 ? 'var(--color-warning)' : 'var(--color-success)';

    // Curve path
    const curvePath = variant === 'glue'
        ? `M ${M} ${VB_H - M} L ${thrX * 0.8} ${thrY + (VB_H - M - thrY) * 0.2} Q ${thrX} ${thrY}, ${(thrX + VB_W - M) / 2} ${(thrY + endY) / 2} L ${VB_W - M} ${Math.max(M, endY)}`
        : `M ${M} ${VB_H - M} L ${thrX} ${thrY} L ${VB_W - M} ${Math.max(M, endY)}`;

    // Fill under curve
    const fillPath = `${curvePath} L ${VB_W - M} ${VB_H - M} L ${M} ${VB_H - M} Z`;

    // Drag handlers
    const onHandleDown = useCallback((e: React.PointerEvent) => {
        if (!onThresholdChange) return;
        e.preventDefault();
        e.stopPropagation();
        (e.target as SVGElement).setPointerCapture(e.pointerId);
        dragRef.current = true;
        onGestureStart?.();
    }, [onThresholdChange, onGestureStart]);

    const onHandleMove = useCallback((e: React.PointerEvent) => {
        if (!dragRef.current || !onThresholdChange) return;
        const svg = svgRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const normX = clamp01(((e.clientX - rect.left) / rect.width * VB_W - M) / W);
        onThresholdChange(normX);
    }, [onThresholdChange, W]);

    const onHandleUp = useCallback((e: React.PointerEvent) => {
        if (!dragRef.current) return;
        (e.target as SVGElement).releasePointerCapture(e.pointerId);
        dragRef.current = false;
        onGestureEnd?.();
    }, [onGestureEnd]);

    const isInteractive = !!onThresholdChange;

    // Threshold dB label
    const thrDb = Math.round((thresholdNorm * 60) - 60);

    return (
        <svg
            ref={svgRef}
            width="100%"
            height="100%"
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="xMidYMid slice"
            style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)' }}
        >
            <defs>
                <filter id="comp-glow" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
                <linearGradient id="comp-fill-grad" x1="0" y1="1" x2="0" y2="0">
                    <stop offset="0%" stopColor={accent} stopOpacity="0.02" />
                    <stop offset="100%" stopColor={accent} stopOpacity="0.12" />
                </linearGradient>
            </defs>
            <rect x="0" y="0" width={VB_W} height={VB_H} fill="var(--token-color-rgba-22-24-30-0d65)" />
            {/* Axes */}
            <line x1={M} y1={M} x2={M} y2={VB_H - M} stroke="var(--token-color-rgba-255-255-255-0d2)" />
            <line x1={M} y1={VB_H - M} x2={VB_W - M} y2={VB_H - M} stroke="var(--token-color-rgba-255-255-255-0d2)" />
            {/* dB grid labels */}
            <text x={M - 2} y={M + 4} textAnchor="end" fill="var(--token-color-rgba-255-255-255-0d3)" fontSize="6" fontFamily="var(--font-role-data)">0</text>
            <text x={M - 2} y={VB_H - M + 3} textAnchor="end" fill="var(--token-color-rgba-255-255-255-0d3)" fontSize="6" fontFamily="var(--font-role-data)">-60</text>
            <text x={M - 2} y={M + H / 2 + 3} textAnchor="end" fill="var(--token-color-rgba-255-255-255-0d25)" fontSize="6" fontFamily="var(--font-role-data)">-30</text>
            {/* Axis titles */}
            <text x={VB_W / 2} y={VB_H - M + 12} textAnchor="middle" fill="var(--token-color-rgba-255-255-255-0d3)" fontSize="7" fontFamily="var(--font-role-data)">Input</text>

            {variant === 'multiband' && (
                <>
                    <line x1={M + W * 0.33} y1={M} x2={M + W * 0.33} y2={VB_H - M} stroke="var(--token-color-rgba-142-197-255-0d32)" strokeWidth="1" strokeDasharray="3,3" />
                    <line x1={M + W * 0.66} y1={M} x2={M + W * 0.66} y2={VB_H - M} stroke="var(--token-color-rgba-142-197-255-0d32)" strokeWidth="1" strokeDasharray="3,3" />
                </>
            )}

            {/* Unity reference line */}
            <line x1={M} y1={VB_H - M} x2={VB_W - M} y2={M} stroke="var(--plugin-viz-grid-color)" strokeWidth="0.6" strokeDasharray="4,3" />
            {/* Fill under curve */}
            <path d={fillPath} fill="url(#comp-fill-grad)" />
            {/* Compression curve */}
            <path d={curvePath} fill="none" stroke={accent} strokeWidth="3" strokeLinecap="round" />
            {/* Threshold knee handle */}
            <circle
                cx={thrX}
                cy={thrY}
                r={isInteractive ? 7 : 5}
                fill={accent}
                stroke="white"
                strokeWidth="1.5"
                filter={isInteractive ? 'url(#comp-glow)' : undefined}
                style={isInteractive ? { cursor: 'ew-resize', touchAction: 'none' } : undefined}
                onPointerDown={isInteractive ? onHandleDown : undefined}
                onPointerMove={isInteractive ? onHandleMove : undefined}
                onPointerUp={isInteractive ? onHandleUp : undefined}
                onPointerCancel={isInteractive ? onHandleUp : undefined}
            />
            {/* Threshold dB readout */}
            <text x={thrX} y={thrY - 12} textAnchor="middle" fill={accent} fontSize="9" fontFamily="var(--font-role-data)" opacity="0.9">{thrDb} dB</text>
            {/* GR meter bar */}
            {grDb > 0 && (
                <rect x={VB_W - M - 6} y={VB_H - M - grBarH} width="10" height={Math.max(1, grBarH)} rx="2" fill={grColor} opacity="0.85" />
            )}
        </svg>
    );
});

// ─── Modulation Wave ─────────────────────────────────────────────────────
// Renders sine/triangle/saw/square modulation waveform.

export type ModulationWaveShape = 'sine' | 'triangle' | 'saw' | 'square';

export interface ModulationWaveProps {
    /** Modulation rate 0–1 (controls number of visible cycles). */
    rate: number;
    /** Modulation depth 0–1. */
    depth: number;
    /** Waveform shape. Default: sine */
    shape?: ModulationWaveShape;
    accent?: string;
}

export const ModulationWave = React.memo(function ModulationWave({
    rate,
    depth,
    shape = 'sine',
    accent = 'var(--token-color-hex-4cc9d8)',
}: ModulationWaveProps) {
    const M = 14;
    const midY = VB_H / 2;
    const amp = clamp01(depth) * (VB_H / 2 - M);
    const cycles = 1 + clamp01(rate) * 4;   // 1–5 visible cycles
    const W = VB_W - 2 * M;
    const steps = 200;

    const points: string[] = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = M + t * W;
        let y: number;
        const phase = t * cycles * Math.PI * 2;

        switch (shape) {
            case 'triangle': {
                const triangleVal = 2 * Math.abs(2 * ((t * cycles) % 1) - 1) - 1;
                y = midY - triangleVal * amp;
                break;
            }
            case 'saw': {
                const sawVal = 2 * ((t * cycles) % 1) - 1;
                y = midY - sawVal * amp;
                break;
            }
            case 'square': {
                const squareVal = Math.sin(phase) >= 0 ? 1 : -1;
                y = midY - squareVal * amp;
                break;
            }
            default: // sine
                y = midY - Math.sin(phase) * amp;
        }
        points.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`);
    }

    return (
        <VizSvg bgFill="var(--token-color-rgba-8-10-14-0d65)">
            <line x1={M} y1={midY} x2={VB_W - M} y2={midY} stroke="var(--plugin-viz-grid-color)" strokeWidth="0.6" />
            <path d={points.join(' ')} fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" />
        </VizSvg>
    );
});

// ─── Waveform Display ────────────────────────────────────────────────────
// Bar or line-based waveform visualization from data array.

export interface WaveformDisplayProps {
    /** Normalized amplitude data (0–1 per bar). */
    data: number[];
    accent?: string;
    /** Style: 'bars' or 'line'. Default: 'bars' */
    mode?: 'bars' | 'line';
}

export const WaveformDisplay = React.memo(function WaveformDisplay({
    data,
    accent = 'var(--token-color-hex-72d68a)',
    mode = 'bars',
}: WaveformDisplayProps) {
    const M = 10;
    const count = data.length || 1;
    const barWidth = (VB_W - 2 * M) / count;
    const maxH = VB_H - 2 * M;

    if (mode === 'line') {
        const path = data.map((v, i) => {
            const x = M + (i / Math.max(1, count - 1)) * (VB_W - 2 * M);
            const y = VB_H - M - clamp01(v) * maxH;
            return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
        }).join(' ');

        return (
            <VizSvg bgFill="var(--token-color-rgba-12-18-12-0d65)">
                <path d={path} fill="none" stroke={accent} strokeWidth="1.8" strokeLinecap="round" />
            </VizSvg>
        );
    }

    return (
        <VizSvg bgFill="var(--token-color-rgba-12-18-12-0d65)">
            {data.map((v, i) => {
                const h = Math.max(2, clamp01(v) * maxH);
                return (
                    <rect
                        key={i}
                        x={M + i * barWidth + 1}
                        y={VB_H - M - h}
                        width={Math.max(2, barWidth - 2)}
                        height={h}
                        rx="1.5"
                        fill={accent}
                        opacity="0.85"
                    />
                );
            })}
        </VizSvg>
    );
});

// ─── Spectrum Bars ───────────────────────────────────────────────────────
// Vertical bar spectrum analyzer.

export interface SpectrumBarsProps {
    /** Number of bars. Default: 16. Data not required (decorative). */
    barCount?: number;
    /** Optional data array (0–1 per bar). Random seeded if not provided. */
    data?: number[];
    accent?: string;
}

export const SpectrumBars = React.memo(function SpectrumBars({
    barCount = 16,
    data,
    accent = 'var(--token-color-hex-4cc9d8)',
}: SpectrumBarsProps) {
    const M = 10;
    const count = data?.length ?? barCount;
    const barWidth = (VB_W - 2 * M) / count;
    const maxH = VB_H - 2 * M;

    return (
        <VizSvg bgFill="var(--token-color-rgba-8-10-14-0d65)">
            {Array.from({ length: count }).map((_, i) => {
                const v = data ? clamp01(data[i] ?? 0) : (0.2 + Math.abs(Math.sin((i + 1) * 0.95)) * 0.7);
                const h = Math.max(2, v * maxH);
                return (
                    <rect
                        key={i}
                        x={M + i * barWidth + 1}
                        y={VB_H - M - h}
                        width={Math.max(2, barWidth - 2)}
                        height={h}
                        rx="1.5"
                        fill={accent}
                        opacity="0.85"
                    />
                );
            })}
        </VizSvg>
    );
});
