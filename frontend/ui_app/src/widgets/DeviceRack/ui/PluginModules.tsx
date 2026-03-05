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
            <div style={{
                ...pluginPanelCardBaseStyle,
                padding: 'var(--space-1)',
                display: 'block',
                height: 'fit-content',
            }}>
                <KnobParamGrid
                    params={params}
                    handlers={handlers}
                    maxCols={maxCols}
                    minCols={minCols}
                />
            </div>
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
// Transfer function shape changes by saturation type.

export type SaturationCurveType = 'soft' | 'hard' | 'tape' | 'tube' | 'fold' | 'digital';

export interface SaturationCurveProps {
    /** Drive amount 0–1. */
    drive: number;
    /** Saturation algorithm type. */
    type?: SaturationCurveType;
    accent?: string;
}

export const SaturationCurve = React.memo(function SaturationCurve({
    drive,
    type = 'soft',
    accent = 'var(--token-color-hex-ff965e)',
}: SaturationCurveProps) {
    const M = 14;
    const d = clamp01(drive);
    const k = Math.max(8, 60 - d * 48); // knee softness

    const curveByType: Record<SaturationCurveType, string> = {
        soft: `M ${M} ${VB_H - M} C ${M + k} ${VB_H - M}, ${VB_W - M - k} ${M}, ${VB_W - M} ${M}`,
        hard: `M ${M} ${VB_H - M} L ${M + 40} ${VB_H - M} L ${VB_W / 2} ${M + 10} L ${VB_W - M - 40} ${M + 10} L ${VB_W - M} ${M + 10}`,
        tape: `M ${M} ${VB_H - M} C ${M + k * 0.6} ${VB_H - M - 20}, ${VB_W / 2 - 10} ${M + 20}, ${VB_W / 2 + 20} ${M + 12} Q ${VB_W - M - 20} ${M + 8}, ${VB_W - M} ${M + 14}`,
        tube: `M ${M} ${VB_H - M} Q ${M + 30} ${VB_H * 0.3}, ${VB_W / 2} ${VB_H * 0.35} Q ${VB_W - M - 30} ${VB_H * 0.4}, ${VB_W - M} ${M + 6}`,
        fold: `M ${M} ${VB_H - M} L ${VB_W * 0.3} ${M + 8} L ${VB_W * 0.45} ${VB_H * 0.55} L ${VB_W * 0.6} ${M + 12} L ${VB_W * 0.75} ${VB_H * 0.48} L ${VB_W - M} ${M + 6}`,
        digital: `M ${M} ${VB_H - M} L ${M} ${M + 6} L ${VB_W - M} ${M + 6}`,
    };

    return (
        <VizSvg bgFill="var(--token-color-rgba-20-13-9-0d65)">
            {/* Diagonal reference line */}
            <line x1={M} y1={VB_H - M} x2={VB_W - M} y2={M} stroke="var(--plugin-viz-grid-color)" strokeWidth="0.8" strokeDasharray="4,3" />
            {/* Transfer function curve */}
            <path d={curveByType[type]} fill="none" stroke={accent} strokeWidth="2.4" strokeLinecap="round" />
            {/* Origin dot */}
            <circle cx={M} cy={VB_H - M} r="3" fill={accent} opacity="0.7" />
        </VizSvg>
    );
});

// ─── Mini Filter EQ ──────────────────────────────────────────────────────
// 2-handle HP/LP filter visualization (like Delay/Reverb surfaces).

export interface MiniFilterEqProps {
    /** HP frequency, normalized 0–1 (log scale 20–20000). */
    hpFreqNorm: number;
    /** LP frequency, normalized 0–1 (log scale 20–20000). */
    lpFreqNorm: number;
    /** Optional Q for HP. Default 0.5 */
    hpQ?: number;
    /** Optional Q for LP. Default 0.5 */
    lpQ?: number;
    accentHp?: string;
    accentLp?: string;
}

export const MiniFilterEq = React.memo(function MiniFilterEq({
    hpFreqNorm,
    lpFreqNorm,
    hpQ: _hpQ = 0.5,
    lpQ: _lpQ = 0.5,
    accentHp = 'var(--token-color-hex-ffac59)',
    accentLp = 'var(--token-color-hex-7ab6ff)',
}: MiniFilterEqProps) {
    const M = 14;
    const hpX = M + clamp01(hpFreqNorm) * (VB_W - 2 * M);
    const lpX = M + clamp01(lpFreqNorm) * (VB_W - 2 * M);
    const midY = VB_H * 0.4;   // flat line at 40% height (pass band)
    const botY = VB_H - M;     // bottom of rolloff

    return (
        <VizSvg bgFill="var(--token-color-rgba-8-10-14-0d65)">
            {/* Frequency grid */}
            <line x1={M} y1={midY} x2={VB_W - M} y2={midY} stroke="var(--plugin-viz-grid-color)" strokeWidth="0.6" />
            {/* HP curve (left rolloff) */}
            <path d={`M ${M} ${botY} Q ${hpX - 20} ${botY}, ${hpX} ${midY} L ${VB_W - M} ${midY}`} fill="none" stroke={accentHp} strokeWidth="2" strokeLinecap="round" />
            {/* LP curve (right rolloff) */}
            <path d={`M ${M} ${midY} L ${lpX} ${midY} Q ${lpX + 20} ${midY}, ${VB_W - M} ${botY}`} fill="none" stroke={accentLp} strokeWidth="2" strokeLinecap="round" />
            {/* Handle dots */}
            <circle cx={hpX} cy={midY} r="5" fill={accentHp} stroke="white" strokeWidth="1.2" />
            <circle cx={lpX} cy={midY} r="5" fill={accentLp} stroke="white" strokeWidth="1.2" />
        </VizSvg>
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
// Input/Output transfer function with threshold, ratio, and optional knee.

export interface CompressionCurveProps {
    /** Threshold 0–1 normalized (0=max compression, 1=no compression). */
    thresholdNorm: number;
    /** Ratio 0–1 where 0=1:1, 1=∞:1. */
    ratioNorm: number;
    /** Knee softness 0–1. Default: 0.2 */
    kneeNorm?: number;
    /** GR for integrated meter, in dB. */
    grDb?: number;
    accent?: string;
    /** Variant styling. */
    variant?: 'standard' | 'glue' | 'multiband';
}

export const CompressionCurve = React.memo(function CompressionCurve({
    thresholdNorm,
    ratioNorm,
    kneeNorm: _knee = 0.2,
    grDb = 0,
    accent = 'var(--token-color-hex-6ac3ff)',
    variant = 'standard',
}: CompressionCurveProps) {
    const M = 20;
    const W = VB_W - 2 * M;
    const H = VB_H - 2 * M;
    const thrX = M + clamp01(thresholdNorm) * W;
    const thrY = VB_H - M - clamp01(thresholdNorm) * H;
    // Above threshold, output grows slower by ratio
    const slopeAbove = 1 - clamp01(ratioNorm) * 0.9; // 1=unity, 0.1=∞:1
    const endY = thrY - (VB_W - M - thrX) * slopeAbove * (H / W);

    const grBarH = clamp01(Math.abs(grDb) / 24) * (VB_H - 2 * M);
    const grColor = Math.abs(grDb) > 12 ? 'var(--color-error)' : Math.abs(grDb) > 4 ? 'var(--color-warning)' : 'var(--color-success)';

    return (
        <VizSvg bgFill="var(--token-color-rgba-22-24-30-0d65)">
            {/* Axes */}
            <line x1={M} y1={M} x2={M} y2={VB_H - M} stroke="var(--token-color-rgba-255-255-255-0d2)" />
            <line x1={M} y1={VB_H - M} x2={VB_W - M} y2={VB_H - M} stroke="var(--token-color-rgba-255-255-255-0d2)" />

            {variant === 'multiband' && (
                <>
                    <line x1={M + W * 0.33} y1={M} x2={M + W * 0.33} y2={VB_H - M} stroke="var(--token-color-rgba-142-197-255-0d32)" strokeWidth="1" strokeDasharray="3,3" />
                    <line x1={M + W * 0.66} y1={M} x2={M + W * 0.66} y2={VB_H - M} stroke="var(--token-color-rgba-142-197-255-0d32)" strokeWidth="1" strokeDasharray="3,3" />
                </>
            )}

            {/* Compression curve */}
            {variant === 'glue' ? (
                <path d={`M ${M} ${VB_H - M} L ${thrX * 0.8} ${thrY + (VB_H - M - thrY) * 0.2} Q ${thrX} ${thrY}, ${(thrX + VB_W - M) / 2} ${(thrY + endY) / 2} L ${VB_W - M} ${Math.max(M, endY)}`} fill="none" stroke={accent} strokeWidth="3" strokeLinecap="round" />
            ) : (
                <path d={`M ${M} ${VB_H - M} L ${thrX} ${thrY} L ${VB_W - M} ${Math.max(M, endY)}`} fill="none" stroke={accent} strokeWidth="3" strokeLinecap="round" />
            )}

            {/* GR meter bar (right edge) */}
            {grDb > 0 && (
                <rect x={VB_W - M - 6} y={VB_H - M - grBarH} width="10" height={grBarH} rx="2" fill={grColor} opacity="0.85" />
            )}
        </VizSvg>
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
