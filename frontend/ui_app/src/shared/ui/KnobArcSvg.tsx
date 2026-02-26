// ═══════════════════════════════════════════════════════════════════════════
// KnobArcSvg — Single-source-of-truth for all knob arc rendering.
//
// Every knob in Dream DAW (PluginKnob, DryWetKnob, MacroKnob, etc.) MUST use
// this component instead of inline SVG.  Changes here propagate everywhere.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';

// ── Arc geometry constants ────────────────────────────────────────────────
// 270° sweep, starting at 135° (7:30 on a clock) ending at 45° (1:30).
const ARC_SWEEP_DEG = 270;
const ARC_START_DEG = 135;

export interface KnobArcSvgProps {
    /**
     * Normalised value in [0, 1] — 0 = fully CCW, 1 = fully CW.
     * The filled arc is drawn from the start up to this percentage.
     */
    pct: number;
    /** Pixel size of the outer `<svg>` element. Default: 40 */
    size?: number;
    /** SVG viewBox dimension (square). Default: 40 */
    viewBox?: number;
    /** Arc center x/y within the viewBox. Default: half of viewBox */
    center?: number;
    /** Arc radius. Default: 14 */
    radius?: number;
    /** Stroke width of the filled arc. Default: 4 */
    strokeWidth?: number;
    /** Accent colour for the filled arc. Default: var(--color-accent-primary) */
    accent?: string;
    /** Track colour (unfilled background arc). Default: var(--color-bg-elevated) */
    trackColor?: string;
    /** Pointer line colour. Default: var(--color-text-primary) */
    pointerColor?: string;
    /** Pointer line stroke width. Default: 2.5 */
    pointerWidth?: number;
    /** Whether to render a glow layer beneath the filled arc. Default: false */
    glow?: boolean;
    /** Unique filter ID for the glow (must be unique per SVG document). */
    glowFilterId?: string;
    /** Glow blur sigma. Default: 2.5 */
    glowSigma?: number;
    /** Glow opacity. Default: 0.45 */
    glowOpacity?: number;
    /** Show pointer line. Default: true */
    showPointer?: boolean;
}

/**
 * Pure presentational SVG knob arc.
 *
 * Renders three layers:
 * 1. Background track (dim 270° arc)
 * 2. Filled value arc (accent colour, from start to `pct`)
 *    — optionally with a glow underlay
 * 3. Pointer line (rotated to current angle)
 */
export const KnobArcSvg: React.FC<KnobArcSvgProps> = React.memo(function KnobArcSvg({
    pct,
    size = 40,
    viewBox: vb = 40,
    center: cx,
    radius: r = 14,
    strokeWidth: sw = 4,
    accent = 'var(--color-accent-primary)',
    trackColor = 'color-mix(in srgb, var(--color-text-primary) 12%, transparent)',
    pointerColor = 'var(--color-text-primary)',
    pointerWidth = 2.5,
    glow = false,
    glowFilterId = 'knob-glow',
    glowSigma = 2.5,
    glowOpacity = 0.45,
    showPointer = true,
}) {
    const c = cx ?? vb / 2;
    const circumference = 2 * Math.PI * r;
    const arcLength = (ARC_SWEEP_DEG / 360) * circumference;

    // ── Background track arc ──────────────────────────────────────────
    // The SVG circle starts at 3 o'clock. We apply strokeDasharray = circumference
    // (one full-circle dash) and shift it back by (circumference - arcLength) so
    // only the 270° portion is visible.  Then rotate(135) moves the visible start
    // to the 7:30 position (bottom-left).
    const trackDashArray = circumference;
    const trackDashOffset = circumference - arcLength;

    // ── Filled value arc ──────────────────────────────────────────────
    // Same technique: one full-circle dash, offset to show only the filled portion.
    //
    //   visible = arcLength × pct
    //   offset  = circumference − visible
    //
    // IMPORTANT: offset is relative to the FULL circumference, NOT arcLength.
    // Using (arcLength − visible) would give a much smaller offset, making the
    // arc overshoot its intended end-point.
    const filledLength = arcLength * pct;
    const filledDashOffset = circumference - filledLength;

    // Minimum visible threshold: ~5° of arc prevents round linecap bleed.
    const showArc = pct > 0.018;

    // ── Pointer angle ─────────────────────────────────────────────────
    const angle = -135 + pct * 270;
    const pointerTip = c - r + 2; // 2px gap from arc edge

    return (
        <svg
            width={size}
            height={size}
            viewBox={`0 0 ${vb} ${vb}`}
            style={{ pointerEvents: 'none', overflow: 'visible' }}
        >
            {/* Glow filter definition (only if glow enabled) */}
            {glow && (
                <defs>
                    <filter id={glowFilterId} x="-120%" y="-120%" width="340%" height="340%">
                        <feGaussianBlur in="SourceGraphic" stdDeviation={glowSigma} />
                    </filter>
                </defs>
            )}

            {/* 1. Background track arc */}
            <circle
                cx={c}
                cy={c}
                r={r}
                fill="none"
                stroke={trackColor}
                strokeWidth={sw}
                strokeLinecap="round"
                strokeDasharray={trackDashArray}
                strokeDashoffset={trackDashOffset}
                transform={`rotate(${ARC_START_DEG} ${c} ${c})`}
            />

            {/* 2a. Glow underlay */}
            {glow && showArc && (
                <circle
                    cx={c}
                    cy={c}
                    r={r}
                    fill="none"
                    stroke={accent}
                    strokeWidth={sw + 1}
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={filledDashOffset}
                    transform={`rotate(${ARC_START_DEG} ${c} ${c})`}
                    filter={`url(#${glowFilterId})`}
                    opacity={glowOpacity}
                />
            )}

            {/* 2b. Filled value arc */}
            {showArc && (
                <circle
                    cx={c}
                    cy={c}
                    r={r}
                    fill="none"
                    stroke={accent}
                    strokeWidth={sw}
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={filledDashOffset}
                    transform={`rotate(${ARC_START_DEG} ${c} ${c})`}
                />
            )}

            {/* 3. Pointer line */}
            {showPointer && (
                <g transform={`rotate(${angle} ${c} ${c})`}>
                    <line
                        x1={c}
                        y1={c}
                        x2={c}
                        y2={pointerTip}
                        stroke={pointerColor}
                        strokeWidth={pointerWidth}
                        strokeLinecap="round"
                    />
                </g>
            )}
        </svg>
    );
});
