// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Dry/Wet Knob (Enterprise)
// ═══════════════════════════════════════════════════════════════════════════
// Standalone, premium Dry/Wet knob designed to sit on the right side
// of every effect plugin panel. Larger than standard knobs for quick access.
// Uses the same usePluginKnobDrag hook for consistent gesture handling.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useRef } from 'react';
import { usePluginKnobDrag } from '@/widgets/DeviceRack/usePluginKnobDrag';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import { resolveMixParam } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

export interface DryWetKnobProps {
    device: DeviceSlot;
    onChange: (paramName: string, value: number) => void;
    onGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onGestureEnd?: (paramName: string) => void;
    /** Override accent color (CSS variable or hex). Default: --color-accent-primary */
    accent?: string;
}

const SIZE = 34;
const ARC_R = 13;
const ARC_CIRC = 2 * Math.PI * ARC_R;
const ARC_LEN = (270 / 360) * ARC_CIRC;

export const DryWetKnob = React.memo(function DryWetKnob({
    device,
    onChange,
    onGestureStart,
    onGestureEnd,
    accent,
}: DryWetKnobProps) {
    const param = resolveMixParam(device);
    const hasMixParam = Boolean(param);
    const resolvedParam: DeviceSlot['params'][number] = param ?? {
        name: '__dry_wet_placeholder__',
        value: 0,
        min: 0,
        max: 1,
        step: 0.01,
        suffix: '%',
    };

    const accentColor = accent ?? 'var(--color-accent-primary)';

    const quantize = useCallback((raw: number) => {
        const clamped = Math.max(resolvedParam.min, Math.min(resolvedParam.max, raw));
        const step = resolvedParam.step;
        if (!step || step <= 0) return clamped;
        return Math.round((clamped - resolvedParam.min) / step) * step + resolvedParam.min;
    }, [resolvedParam.max, resolvedParam.min, resolvedParam.step]);
    const safeValue = Number.isFinite(resolvedParam.value) ? resolvedParam.value : resolvedParam.min;
    const step = resolvedParam.step;
    const displayPrecision = step && step > 0 && step < 1
        ? Math.max(0, Math.min(6, Math.ceil(Math.abs(Math.log10(step)))))
        : 0;
    const displayFactor = 10 ** displayPrecision;
    const displayRoundedValue = Math.round(safeValue * displayFactor) / displayFactor;
    const visualValue = quantize(displayRoundedValue);
    const rawPct = (visualValue - resolvedParam.min) / Math.max(1e-9, resolvedParam.max - resolvedParam.min);
    const pct = rawPct <= 1e-4 ? 0 : rawPct >= 1 - 1e-4 ? 1 : Math.max(0, Math.min(1, rawPct));
    const angle = -135 + pct * 270;
    const dashOffset = Math.max(0, Math.min(ARC_LEN, ARC_LEN * (1 - pct)));

    const valueToUnit = useCallback((v: number) =>
        (v - resolvedParam.min) / Math.max(1e-9, resolvedParam.max - resolvedParam.min),
        [resolvedParam.max, resolvedParam.min]);

    const unitToValue = useCallback((u: number) =>
        resolvedParam.min + Math.max(0, Math.min(1, u)) * (resolvedParam.max - resolvedParam.min),
        [resolvedParam.max, resolvedParam.min]);

    const { isDragging, dialRef, onKnobPointerDown, onKnobPointerMove, endKnobDrag, beginMouseDrag } =
        usePluginKnobDrag({
            paramName: resolvedParam.name,
            value: safeValue,
            quantizeValue: quantize,
            valueToUnit,
            unitToValue,
            onChange,
            onGestureStart,
            onGestureEnd,
        });

    const wheelGestureActive = useRef(false);
    const wheelGestureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Wheel support
    const handleWheel = useCallback((e: WheelEvent) => {
        if (!hasMixParam || !param) return;
        e.preventDefault();
        e.stopPropagation();
        if (!wheelGestureActive.current) {
            wheelGestureActive.current = true;
            onGestureStart?.(param.name);
        }
        if (wheelGestureTimer.current) clearTimeout(wheelGestureTimer.current);
        wheelGestureTimer.current = setTimeout(() => {
            wheelGestureActive.current = false;
            onGestureEnd?.(param.name);
        }, 300);
        const step = param.step && param.step > 0 ? param.step : (param.max - param.min) / 160;
        const mul = e.shiftKey ? 4 : e.altKey ? 0.2 : 1;
        const delta = (e.deltaY < 0 ? 1 : -1) * step * mul;
        onChange(param.name, quantize(safeValue + delta));
    }, [hasMixParam, onChange, onGestureEnd, onGestureStart, param, safeValue, quantize]);

    useEffect(() => {
        const node = dialRef.current;
        if (!node) return;
        node.addEventListener('wheel', handleWheel, { passive: false });
        return () => {
            node.removeEventListener('wheel', handleWheel);
            if (wheelGestureTimer.current) {
                clearTimeout(wheelGestureTimer.current);
                wheelGestureTimer.current = null;
            }
            wheelGestureActive.current = false;
        };
    }, [handleWheel, dialRef]);

    // Double-click to reset to 50% (or default)
    const onDoubleClick = useCallback((e: React.MouseEvent) => {
        if (!hasMixParam || !param) return;
        e.preventDefault();
        const def = Number.isFinite(param.defaultValue)
            ? param.defaultValue as number
            : (param.min + param.max) * 0.5;
        onChange(param.name, quantize(def));
    }, [hasMixParam, onChange, param, quantize]);

    // Display value
    const displayPct = Math.round(pct * 100);
    // Ensure unique filter id per knob instance (device + param), otherwise
    // SVG filter references can collide across multiple plugin slots.
    const filterId = `drywet-glow-${device.id.replace(/[^a-zA-Z0-9]/g, '_')}-${resolvedParam.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (!hasMixParam) return null;

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 1,
                minWidth: 52,
                minHeight: 60,
                alignSelf: 'center',
                padding: '0 2px',
                boxSizing: 'border-box',
            }}
        >
            <div style={{ position: 'relative', width: SIZE, height: SIZE }}>
                <div
                    ref={dialRef}
                    style={{
                        width: '100%',
                        height: '100%',
                        cursor: isDragging ? 'grabbing' : 'ns-resize',
                        touchAction: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                    onPointerDown={onKnobPointerDown}
                    onPointerMove={onKnobPointerMove}
                    onPointerUp={endKnobDrag}
                    onPointerCancel={endKnobDrag}
                    onMouseDown={beginMouseDrag}
                    onDoubleClick={onDoubleClick}
                >
                    <svg width={SIZE} height={SIZE} viewBox="0 0 48 48" style={{ pointerEvents: 'none', overflow: 'visible' }}>
                        {/* Glow filter */}
                        <defs>
                            <filter id={filterId} x="-120%" y="-120%" width="340%" height="340%">
                                <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" />
                            </filter>
                        </defs>
                        {/* Background arc */}
                        <circle
                            cx="24" cy="24" r={ARC_R}
                            fill="none"
                            stroke="var(--color-bg-elevated)"
                            strokeWidth="4"
                            strokeLinecap="round"
                            strokeDasharray={ARC_CIRC}
                            strokeDashoffset={ARC_CIRC - ARC_LEN}
                            transform="rotate(135 24 24)"
                        />
                        {/* Glow layer */}
                        {pct > 0 && (
                            <circle
                                cx="24" cy="24" r={ARC_R}
                                fill="none"
                                stroke={accentColor}
                                strokeWidth="5"
                                strokeLinecap="round"
                                strokeDasharray={ARC_LEN}
                                strokeDashoffset={dashOffset}
                                transform="rotate(135 24 24)"
                                filter={`url(#${filterId})`}
                                opacity="0.45"
                            />
                        )}
                        {/* Active arc */}
                        {pct > 0 && (
                            <circle
                                cx="24" cy="24" r={ARC_R}
                                fill="none"
                                stroke={accentColor}
                                strokeWidth="4"
                                strokeLinecap="round"
                                strokeDasharray={ARC_LEN}
                                strokeDashoffset={dashOffset}
                                transform="rotate(135 24 24)"
                            />
                        )}
                        {/* Pointer line */}
                        <g transform={`rotate(${angle} 24 24)`}>
                            <line x1="24" y1="24" x2="24" y2="7" stroke="var(--color-text-primary)" strokeWidth="2.5" strokeLinecap="round" />
                        </g>
                    </svg>
                </div>
            </div>
            {/* Label */}
            <span style={{
                fontSize: '10px',
                color: 'var(--color-text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                fontWeight: 600,
                lineHeight: 1,
            }}>
                DRY/WET
            </span>
            {/* Value */}
            <span style={{
                fontSize: 'var(--font-size-2xs)',
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-primary)',
                lineHeight: 1,
            }}>
                {displayPct}%
            </span>
        </div>
    );
});
