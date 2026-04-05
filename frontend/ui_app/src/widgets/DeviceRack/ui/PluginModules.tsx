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

import React, { useCallback, useId, useRef } from 'react';
import { clamp01 } from '@/shared/lib/audioMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    buildSurfaceKnobParams,
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
 * Wraparound Layout — specialized flex-row layout for Reverb and Delay.
 * Distributes controls flexibly around a central or larger VizCard.
 */
export const WraparoundLayout = React.memo(({
    children,
    gap,
}: {
    children: React.ReactNode;
    gap?: number | string;
}) => (
    <div
        className="plugin-wraparound-layout"
        style={{
            display: 'flex',
            gap: gap ?? 'var(--plugin-surface-gap)',
            height: '100%',
        }}
    >
        {children}
    </div>
));
WraparoundLayout.displayName = 'WraparoundLayout';

/**
 * Left control panel — fixed width, wraps KnobParamGrid with card styling.
 * Automatically applies pluginPanelCardBaseStyle and 2×2 grid.
 */
export const ControlPanel = React.memo(({
    params,
    handlers,
    maxCols = 3,
    minCols = 2,
    width,
    children,
}: {
    params?: DeviceSlot['params'];
    handlers?: SurfaceHandlers;
    maxCols?: number;
    minCols?: number;
    /** Override panel width. When omitted, panel uses flex:1 to fill available space. */
    width?: number | string;
    /** Additional elements below the knob grid. */
    children?: React.ReactNode;
}) => (
    <div style={{
        ...(width ? { width, flexShrink: 0 } : { flex: 1, minWidth: 0 }),
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
        flex: '0 0 43%',
        maxWidth: '43%',
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
        height: '100%',
        minHeight: 0,
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
            border: `var(--space-px) solid ${active ? 'var(--color-accent-primary)' : 'var(--color-divider)'}`,
            background: active ? 'var(--color-accent-primary)' : 'var(--color-bg-elevated)',
            color: 'var(--color-text-on-accent)',
            fontSize: 'var(--font-size-2xs)',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
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
    enumLabels,
    toggleParams,
}: {
    /** Pre-filtered secondary params to show. */
    params: DeviceSlot['params'];
    handlers: SurfaceHandlers;
    maxCols?: number;
    accent?: string;
    /** Human-readable labels for discrete/enum params. Keys: param name, Values: label array. */
    enumLabels?: Record<string, string[]>;
    /** Param names that should render as toggle switches instead of knobs. */
    toggleParams?: string[];
}) {
    const [expanded, setExpanded] = React.useState(false);

    if (params.length === 0) return null;

    // Separate params into enum dropdowns, toggles, and regular knobs
    const enumParamSet = new Set(Object.keys(enumLabels ?? {}).map(k => k.toLowerCase()));
    const toggleParamSet = new Set((toggleParams ?? []).map(k => k.toLowerCase()));

    const enumParams = params.filter(p => enumParamSet.has(p.name.toLowerCase()) && !toggleParamSet.has(p.name.toLowerCase()));
    const toggleParamsFiltered = params.filter(p => toggleParamSet.has(p.name.toLowerCase()));
    const knobParams = params.filter(p =>
        !enumParamSet.has(p.name.toLowerCase()) && !toggleParamSet.has(p.name.toLowerCase())
    );

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

            {/* ─── Animated expandable content ─── */}
            <div
                style={{
                    maxHeight: expanded ? 400 : 0,
                    overflow: 'hidden',
                    transition: 'max-height 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                }}
            >
                {expanded && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {/* ── Enum dropdowns ── */}
                        {enumParams.length > 0 && (
                            <div style={{ display: 'grid', gap: 4 }}>
                                {enumParams.map((p) => {
                                    const labels = enumLabels?.[p.name] ?? enumLabels?.[p.name.toLowerCase()] ?? [];
                                    const currentValue = Math.round(p.value ?? 0);
                                    return (
                                        <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                            <span style={{
                                                fontSize: 'var(--font-size-2xs)',
                                                color: 'var(--color-text-tertiary)',
                                                fontWeight: 600,
                                                minWidth: 36,
                                                textTransform: 'capitalize',
                                            }}>
                                                {p.name}
                                            </span>
                                            <select
                                                value={currentValue}
                                                onChange={(e) => {
                                                    handlers.onParamGestureStart?.(p.name);
                                                    handlers.onParamChange(p.name, Number(e.target.value));
                                                    handlers.onParamGestureEnd?.(p.name);
                                                }}
                                                style={{
                                                    flex: 1,
                                                    border: 'var(--space-px) solid var(--color-divider)',
                                                    borderRadius: 'var(--radius-md)',
                                                    background: 'var(--color-bg-header)',
                                                    color: 'var(--color-text-primary)',
                                                    fontSize: 'var(--font-size-2xs)',
                                                    padding: '3px 6px',
                                                    outline: 'none',
                                                    cursor: 'pointer',
                                                }}
                                            >
                                                {labels.map((label, idx) => (
                                                    <option key={idx} value={idx}>{label}</option>
                                                ))}
                                            </select>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* ── Toggle params ── */}
                        {toggleParamsFiltered.length > 0 && (
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                {toggleParamsFiltered.map((p) => {
                                    const active = (p.value ?? 0) > 0.5;
                                    return (
                                        <button
                                            key={p.name}
                                            type="button"
                                            onClick={() => {
                                                handlers.onParamGestureStart?.(p.name);
                                                handlers.onParamChange(p.name, active ? 0 : 1);
                                                handlers.onParamGestureEnd?.(p.name);
                                            }}
                                            style={{
                                                padding: '3px 10px',
                                                borderRadius: 'var(--radius-md)',
                                                border: 'var(--space-px) solid var(--color-divider)',
                                                background: active
                                                    ? `color-mix(in srgb, ${accent ?? 'var(--color-accent-primary)'} 30%, var(--color-bg-elevated))`
                                                    : 'var(--color-bg-elevated)',
                                                color: active
                                                    ? (accent ?? 'var(--color-accent-primary)')
                                                    : 'var(--color-text-tertiary)',
                                                fontSize: 'var(--font-size-2xs)',
                                                fontWeight: 600,
                                                cursor: 'pointer',
                                                transition: 'background 0.15s ease, color 0.15s ease',
                                                textTransform: 'capitalize',
                                            }}
                                        >
                                            {p.name}
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        {/* ── Regular knob params ── */}
                        {knobParams.length > 0 && (
                            <KnobParamGrid
                                params={knobParams}
                                handlers={handlers}
                                maxCols={maxCols}
                                minCols={2}
                            />
                        )}
                    </div>
                )}
            </div>
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
    /** If true, hides background rect, grid, and text. Useful for overlays. */
    transparent?: boolean;
}

export const AdsrCurve = React.memo(function AdsrCurve({
    attack,
    decay,
    sustain,
    release,
    onParamChange,
    onGestureStart,
    onGestureEnd,
    accent = 'var(--token-color-hex-4a9eff)',
    transparent = false,
}: AdsrCurveProps) {
    const svgRef = useRef<SVGSVGElement | null>(null);
    const dragRef = useRef<{ param: string; startX: number; startY: number; startVal: number } | null>(null);

    // ── Geometry — Proportional segment widths (true ADSR visual) ──
    const M = 4;        // minimal horizontal margin
    const W = VB_W - 2 * M;   // usable width
    const TOP = 10;     // top margin
    const BOT = 108;    // bottom Y
    const H = BOT - TOP;

    const baseSustain = 0.5; // Visual weight for the sustain hold segment
    const A = Math.max(0, attack);
    const D = Math.max(0, decay);
    const R = Math.max(0, release);

    // Total sum = A + D + R + base_sustain
    const totalTime = A + D + baseSustain + R;

    const xA = M;
    const attackPeakX = xA + (A / totalTime) * W;
    const decayMidX = attackPeakX + (D / totalTime) * W;
    const xD = decayMidX + (baseSustain / totalTime) * W;
    const releaseEndX = xD + (R / totalTime) * W;

    const susY = BOT - sustain * H;                  // Sustain level Y

    const curvePath = [
        `M ${xA} ${BOT}`,                 // Start at bottom-left
        `L ${attackPeakX} ${TOP}`,         // Attack to peak
        `L ${decayMidX} ${susY}`,          // Decay to sustain level
        `L ${xD} ${susY}`,                // Sustain hold
        `L ${releaseEndX} ${BOT}`,         // Release to zero
    ].join(' ');

    const fillPath = `${curvePath} L ${releaseEndX} ${BOT} L ${xA} ${BOT} Z`;

    // ── Handle positions ──
    const handles = [
        { param: 'attack', cx: attackPeakX, cy: TOP, color: 'var(--token-color-hex-4a9eff)' },
        { param: 'decay', cx: decayMidX, cy: susY, color: 'var(--token-color-hex-6db3ff)' },
        { param: 'sustain', cx: (decayMidX + xD) / 2, cy: susY, color: 'var(--token-color-hex-78d6ad)' },
        { param: 'release', cx: releaseEndX, cy: BOT, color: 'var(--token-color-hex-7ab6ff)' },
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
            const val = clamp01(dragRef.current.startVal + delta);
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
            preserveAspectRatio={transparent ? 'none' : 'xMidYMid slice'}
            style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)', cursor: 'default' }}
        >
            {/* Background */}
            {!transparent && <rect x="0" y="0" width={VB_W} height={VB_H} fill="var(--token-color-rgba-8-10-14-0d65)" />}

            {/* Grid lines */}
            {!transparent && (
                <>
                    <line x1={M} y1={BOT} x2={VB_W - M} y2={BOT} stroke="var(--plugin-viz-grid-color)" strokeWidth="0.6" />
                    <line x1={M} y1={TOP} x2={VB_W - M} y2={TOP} stroke="var(--plugin-viz-grid-minor)" strokeWidth="0.4" />
                    <line x1={M} y1={(TOP + BOT) / 2} x2={VB_W - M} y2={(TOP + BOT) / 2} stroke="var(--plugin-viz-grid-minor)" strokeWidth="0.4" />
                </>
            )}

            {/* Fill below curve */}
            <path d={fillPath} fill={accent} opacity={transparent ? "0.2" : "0.08"} />

            {/* Envelope curve — standardized 2px stroke with Non-Scaling Vector Effect to resist ViewBox Stretch */}
            <path d={curvePath} fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />

            {/* Segment labels */}
            {!transparent && (
                <>
                    {attack > 0.01 && <text x={(xA + attackPeakX) / 2} y={BOT + 2} textAnchor="middle" fill="var(--token-color-rgba-255-255-255-0d35)" fontSize="7" fontFamily="var(--font-role-data)">A</text>}
                    {decay > 0.01 && <text x={(attackPeakX + decayMidX) / 2} y={BOT + 2} textAnchor="middle" fill="var(--token-color-rgba-255-255-255-0d35)" fontSize="7" fontFamily="var(--font-role-data)">D</text>}
                    <text x={(decayMidX + xD) / 2} y={BOT + 2} textAnchor="middle" fill="var(--token-color-rgba-255-255-255-0d35)" fontSize="7" fontFamily="var(--font-role-data)">S</text>
                    {release > 0.01 && <text x={(xD + releaseEndX) / 2} y={BOT + 2} textAnchor="middle" fill="var(--token-color-rgba-255-255-255-0d35)" fontSize="7" fontFamily="var(--font-role-data)">R</text>}
                </>
            )}

            {/* Draggable handles — hidden in transparent overlay mode (avoids mystery dots on waveform) */}
            {!transparent && handles.map((h) => (
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
    const uid = useId();
    const glowId = `sat-glow-${uid}`;
    const fillGradId = `sat-fill-grad-${uid}`;
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
                <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
                <linearGradient id={fillGradId} x1="0" y1="1" x2="0" y2="0">
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
            <path d={fillPath} fill={`url(#${fillGradId})`} />
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
                    filter={`url(#${glowId})`}
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
    const uid = useId();
    const glowId = `eq-glow-${uid}`;
    const gradId = `eq-passband-grad-${uid}`;
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
                <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="2.5" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
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
            <path d={passbandFill} fill={`url(#${gradId})`} />
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
                filter={isInteractive ? `url(#${glowId})` : undefined}
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
                filter={isInteractive ? `url(#${glowId})` : undefined}
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
// Premium segmented LED-style meter with color zones.

export interface GainReductionMeterProps {
    /** Current GR in dB (positive = more reduction). */
    grDb: number;
    /** Max displayable GR. Default: 24 */
    maxDb?: number;
    /** Orientation. Default: vertical */
    orientation?: 'vertical' | 'horizontal';
}

const GR_SEGMENTS = 12;

export const GainReductionMeter = React.memo(function GainReductionMeter({
    grDb,
    maxDb = 24,
    orientation = 'vertical',
}: GainReductionMeterProps) {
    const normalizedGr = clamp01(Math.abs(grDb) / maxDb);
    const activeSegments = Math.round(normalizedGr * GR_SEGMENTS);

    const segmentColor = (idx: number) => {
        const segNorm = idx / GR_SEGMENTS;
        if (segNorm > 0.75) return 'var(--color-error)';
        if (segNorm > 0.45) return 'var(--color-warning)';
        return 'var(--color-success)';
    };

    if (orientation === 'horizontal') {
        return (
            <div style={{
                display: 'flex',
                gap: 1,
                height: 10,
                alignItems: 'stretch',
                padding: '1px 0',
            }}>
                {Array.from({ length: GR_SEGMENTS }).map((_, i) => (
                    <div
                        key={i}
                        style={{
                            flex: 1,
                            borderRadius: 'var(--radius-2xs)',
                            background: i < activeSegments
                                ? segmentColor(i)
                                : 'var(--color-bg-tertiary)',
                            opacity: i < activeSegments ? 0.9 : 0.25,
                            transition: 'background 60ms linear, opacity 60ms linear',
                        }}
                    />
                ))}
            </div>
        );
    }

    return (
        <div style={{
            width: 14,
            height: '100%',
            display: 'flex',
            flexDirection: 'column-reverse',
            gap: 1,
            padding: '1px 0',
        }}>
            {Array.from({ length: GR_SEGMENTS }).map((_, i) => (
                <div
                    key={i}
                    style={{
                        flex: 1,
                        borderRadius: 'var(--radius-2xs)',
                        background: i < activeSegments
                            ? segmentColor(i)
                            : 'var(--color-bg-tertiary)',
                        opacity: i < activeSegments ? 0.9 : 0.25,
                        transition: 'background 60ms linear, opacity 60ms linear',
                    }}
                />
            ))}
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
    const uid = useId();
    const glowId = `comp-glow-${uid}`;
    const gradId = `comp-fill-grad-${uid}`;
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
                <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
                <linearGradient id={gradId} x1="0" y1="1" x2="0" y2="0">
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
            <path d={fillPath} fill={`url(#${gradId})`} />
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
                filter={isInteractive ? `url(#${glowId})` : undefined}
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
// Premium waveform visualization with gradient fill, rate/depth readouts.

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
    const uid = useId();
    const gradId = `mod-wave-fill-${uid}`;
    const M = 14;
    const midY = VB_H / 2;
    const amp = clamp01(depth) * (VB_H / 2 - M);
    const cycles = 1 + clamp01(rate) * 4;
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
            default:
                y = midY - Math.sin(phase) * amp;
        }
        points.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`);
    }

    const wavePath = points.join(' ');
    // Close path for fill: continue to bottom-right, bottom-left, back to start
    const fillPath = `${wavePath} L ${M + W} ${VB_H - M} L ${M} ${VB_H - M} Z`;

    // Rate/depth readout labels
    const rateHz = (rate * 10).toFixed(1);
    const depthPct = Math.round(depth * 100);

    return (
        <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="xMidYMid slice"
            style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)' }}
        >
            <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={accent} stopOpacity="0.18" />
                    <stop offset="100%" stopColor={accent} stopOpacity="0.02" />
                </linearGradient>
            </defs>
            <rect x="0" y="0" width={VB_W} height={VB_H} fill="var(--token-color-rgba-8-10-14-0d65)" />
            {/* Grid */}
            <line x1={M} y1={midY} x2={VB_W - M} y2={midY} stroke="var(--plugin-viz-grid-color)" strokeWidth="0.6" />
            <line x1={M} y1={M + (midY - M) / 2} x2={VB_W - M} y2={M + (midY - M) / 2} stroke="var(--plugin-viz-grid-minor)" strokeWidth="0.3" />
            <line x1={M} y1={midY + (VB_H - M - midY) / 2} x2={VB_W - M} y2={midY + (VB_H - M - midY) / 2} stroke="var(--plugin-viz-grid-minor)" strokeWidth="0.3" />
            {/* Gradient fill under waveform */}
            <path d={fillPath} fill={`url(#${gradId})`} />
            {/* Waveform line */}
            <path d={wavePath} fill="none" stroke={accent} strokeWidth="2.2" strokeLinecap="round" />
            {/* Readout labels */}
            <text x={VB_W - M - 2} y={M + 8} textAnchor="end" fill={accent} fontSize="8" fontFamily="var(--font-role-data)" opacity="0.75">{rateHz} Hz</text>
            <text x={VB_W - M - 2} y={M + 18} textAnchor="end" fill="var(--token-color-rgba-255-255-255-0d4)" fontSize="7" fontFamily="var(--font-role-data)">{depthPct}%</text>
        </svg>
    );
});

// ─── Waveform Display ────────────────────────────────────────────────────
// Premium bar or line-based waveform with gradient fills.

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
    const uid = useId();
    const lineGradId = `wf-line-fill-${uid}`;
    const M = 10;
    const count = Math.max(1, data.length);
    const barWidth = (VB_W - 2 * M) / count;
    const maxH = VB_H - 2 * M;

    if (mode === 'line') {
        const linePath = data.map((v, i) => {
            const x = M + (i / Math.max(1, count - 1)) * (VB_W - 2 * M);
            const y = VB_H - M - clamp01(v) * maxH;
            return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
        }).join(' ');
        const fillPath = `${linePath} L ${M + (VB_W - 2 * M)} ${VB_H - M} L ${M} ${VB_H - M} Z`;

        return (
            <svg
                width="100%" height="100%"
                viewBox={`0 0 ${VB_W} ${VB_H}`}
                preserveAspectRatio="xMidYMid slice"
                style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)' }}
            >
                <defs>
                    <linearGradient id={lineGradId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={accent} stopOpacity="0.2" />
                        <stop offset="100%" stopColor={accent} stopOpacity="0.02" />
                    </linearGradient>
                </defs>
                <rect x="0" y="0" width={VB_W} height={VB_H} fill="var(--token-color-rgba-12-18-12-0d65)" />
                {/* Grid */}
                <line x1={M} y1={VB_H - M} x2={VB_W - M} y2={VB_H - M} stroke="var(--plugin-viz-grid-minor)" strokeWidth="0.4" />
                <line x1={M} y1={VB_H / 2} x2={VB_W - M} y2={VB_H / 2} stroke="var(--plugin-viz-grid-minor)" strokeWidth="0.3" />
                {/* Fill under curve */}
                <path d={fillPath} fill={`url(#${lineGradId})`} />
                {/* Waveform line */}
                <path d={linePath} fill="none" stroke={accent} strokeWidth="1.8" strokeLinecap="round" />
            </svg>
        );
    }

    return (
        <VizSvg bgFill="var(--token-color-rgba-12-18-12-0d65)">
            {/* Grid baseline */}
            <line x1={M} y1={VB_H - M} x2={VB_W - M} y2={VB_H - M} stroke="var(--plugin-viz-grid-minor)" strokeWidth="0.4" />
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
                        opacity={0.5 + clamp01(v) * 0.45}
                    />
                );
            })}
        </VizSvg>
    );
});

// ─── Spectrum Bars ───────────────────────────────────────────────────────
// Premium vertical bar spectrum with gradient-tipped bars and grid.

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
    const uid = useId();
    const gradId = `spectrum-bar-grad-${uid}`;
    const M = 10;
    const count = Math.max(1, data?.length ?? barCount);
    const barWidth = (VB_W - 2 * M) / count;
    const maxH = VB_H - 2 * M;

    return (
        <svg
            width="100%" height="100%"
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="xMidYMid slice"
            style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)' }}
        >
            <defs>
                <linearGradient id={gradId} x1="0" y1="1" x2="0" y2="0">
                    <stop offset="0%" stopColor={accent} stopOpacity="0.5" />
                    <stop offset="100%" stopColor={accent} stopOpacity="1" />
                </linearGradient>
            </defs>
            <rect x="0" y="0" width={VB_W} height={VB_H} fill="var(--token-color-rgba-8-10-14-0d65)" />
            {/* Horizontal grid */}
            <line x1={M} y1={VB_H - M} x2={VB_W - M} y2={VB_H - M} stroke="var(--plugin-viz-grid-minor)" strokeWidth="0.4" />
            <line x1={M} y1={VB_H / 2} x2={VB_W - M} y2={VB_H / 2} stroke="var(--plugin-viz-grid-minor)" strokeWidth="0.25" />
            <line x1={M} y1={M + (VB_H / 2 - M) / 2} x2={VB_W - M} y2={M + (VB_H / 2 - M) / 2} stroke="var(--plugin-viz-grid-minor)" strokeWidth="0.2" />
            {/* Bars */}
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
                        fill={`url(#${gradId})`}
                        opacity={0.55 + v * 0.4}
                    />
                );
            })}
        </svg>
    );
});
