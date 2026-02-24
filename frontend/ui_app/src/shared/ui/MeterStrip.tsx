// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — MeterStrip (Unified Stereo Meter)
// ═══════════════════════════════════════════════════════════════════════════
//
// Single React component for ALL meter rendering across the application.
//
// Usage (all locations):
//
//   import { MeterStrip } from '@/shared/ui/MeterStrip';
//   import { dbToMeterNorm, linearToMeterNorm } from '@/shared/lib/meterManifest';
//
//   // TrackInspector / DawShell (dB input):
//   <MeterStrip levelL={dbToMeterNorm(peakDbL)} levelR={dbToMeterNorm(peakDbR)} />
//
//   // DeviceRack (linear 0..1 input):
//   <MeterStrip levelL={linearToMeterNorm(linearL)} levelR={linearToMeterNorm(linearR)} />
//
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import type { CSSProperties } from 'react';
import {
    DB_ZERO_NORM,
    METER_GRADIENT_VERTICAL,
    COLOR_METER_BG,
    COLOR_ZERO_DB_LINE,
    COLOR_CHANNEL_DIVIDER,
    COLOR_METER_MIDI,
    METER_DEFAULT_WIDTH,
    METER_CHANNEL_WIDTH,
} from '@/shared/lib/meterManifest';

// ─── Props ───────────────────────────────────────────────────────────────

export interface MeterStripProps {
    /** Left channel level: 0..1 normalised via dbToMeterNorm / linearToMeterNorm. */
    levelL: number;
    /** Right channel level: 0..1 normalised via dbToMeterNorm / linearToMeterNorm. */
    levelR: number;
    /** Show a horizontal 0 dB divider line (default true). */
    show0dBLine?: boolean;
    /** Render as MIDI velocity meter (yellow tint, no gradient). */
    isMidi?: boolean;
    /** Total width excluding external margins (default 8). */
    width?: number;
    /** Additional className on the outer wrapper. */
    className?: string;
    /** Additional inline styles on the outer wrapper. */
    style?: CSSProperties;
}

// ─── Channel Bar Sub-Component ───────────────────────────────────────────

/**
 * Single channel bar with static gradient background.
 *
 * Approach: render a full-height gradient div, then use CSS `clip-path`
 * to reveal only the filled portion from the bottom.  This ensures the
 * gradient colors always correspond to the correct dB positions,
 * regardless of the current level.
 */
const ChannelBar: React.FC<{
    level: number;
    align: 'left' | 'right';
    chWidth: number;
    fillBg: string;
}> = React.memo(({ level, align, chWidth, fillBg }) => {
    // BUG-95 FIX: NaN guard — prevents clip-path: inset(NaN% 0 0 0).
    const safeLevel = Number.isNaN(level) ? 0 : level;
    const scale = Math.max(0, Math.min(1, safeLevel));

    return (
        <div
            style={{
                position: 'absolute',
                bottom: 0,
                [align]: 0,
                width: chWidth,
                // Full height — the gradient spans the entire meter
                height: '100%',
                background: fillBg,
                transformOrigin: 'bottom',
                transform: `scaleY(${scale})`,
                willChange: 'transform',
            }}
        />
    );
});
ChannelBar.displayName = 'ChannelBar';

// ─── Component ───────────────────────────────────────────────────────────

/**
 * Unified stereo peak meter strip.
 *
 * Renders two vertical bars (L + R) with a static gradient fill that
 * is revealed bottom-to-top based on signal level.
 *
 * The gradient is always green→yellow→orange→red (defined in meterManifest.ts).
 * The bars use `clip-path` to reveal the correct portion — colours are
 * always positionally accurate, producing the professional multi-color
 * meter effect seen in Ableton Live, Logic Pro, and FL Studio.
 */
export const MeterStrip: React.FC<MeterStripProps> = React.memo(({
    levelL,
    levelR,
    show0dBLine = true,
    isMidi = false,
    width = METER_DEFAULT_WIDTH,
    className,
    style,
}) => {
    const fillBg = isMidi ? COLOR_METER_MIDI : METER_GRADIENT_VERTICAL;
    const chWidth = METER_CHANNEL_WIDTH;
    const divWidth = Math.max(1, width - chWidth * 2);

    return (
        <div
            className={className}
            style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                flexShrink: 0,
                alignSelf: 'stretch',
                ...style,
            }}
        >
            <div
                style={{
                    width,
                    flex: 1,
                    background: COLOR_METER_BG,
                    borderRadius: 'var(--radius-2xs, var(--space-0-5))',
                    position: 'relative',
                    overflow: 'hidden',
                }}
            >
                {/* ── Left channel ── */}
                <ChannelBar
                    level={levelL}
                    align="left"
                    chWidth={chWidth}
                    fillBg={fillBg}
                />

                {/* ── Center channel divider ── */}
                <div
                    style={{
                        position: 'absolute',
                        left: chWidth,
                        width: divWidth,
                        top: 0,
                        bottom: 0,
                        background: COLOR_CHANNEL_DIVIDER,
                        pointerEvents: 'none',
                    }}
                />

                {/* ── Right channel ── */}
                <ChannelBar
                    level={levelR}
                    align="right"
                    chWidth={chWidth}
                    fillBg={fillBg}
                />

                {/* ── 0 dB divider line ── */}
                {show0dBLine && (
                    <div
                        style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: `${DB_ZERO_NORM * 100}%`,
                            height: 1,
                            background: COLOR_ZERO_DB_LINE,
                            pointerEvents: 'none',
                            zIndex: 1,
                        }}
                    />
                )}
            </div>
        </div>
    );
});

MeterStrip.displayName = 'MeterStrip';
