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
import { KnobArcSvg } from '@/shared/ui/KnobArcSvg';
import { clamp01 } from '@/shared/lib/audioMath';

export interface DryWetKnobProps {
    device: DeviceSlot;
    onChange: (paramName: string, value: number) => void;
    onGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onGestureEnd?: (paramName: string) => void;
    onContextMenu?: (e: React.MouseEvent, paramName: string) => void;
    /** Override accent color (CSS variable or hex). Default: --color-accent-primary */
    accent?: string;
}

const SIZE = 34;

export const DryWetKnob = React.memo(function DryWetKnob({
    device,
    onChange,
    onGestureStart,
    onGestureEnd,
    onContextMenu,
    accent,
}: DryWetKnobProps) {
    const param = resolveMixParam(device);
    const hasParam = !!param;
    const resolvedParam: DeviceSlot['params'][number] = param ?? {
        name: 'mix',
        value: 0.5,
        min: 0,
        max: 1,
        step: 0.01,
        suffix: '',
        defaultValue: 0.5,
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
    const pct = rawPct <= 1e-4 ? 0 : rawPct >= 1 - 1e-4 ? 1 : clamp01(rawPct);

    const valueToUnit = useCallback((v: number) =>
        (v - resolvedParam.min) / Math.max(1e-9, resolvedParam.max - resolvedParam.min),
        [resolvedParam.max, resolvedParam.min]);

    const unitToValue = useCallback((u: number) =>
        resolvedParam.min + clamp01(u) * (resolvedParam.max - resolvedParam.min),
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
        e.preventDefault();
        e.stopPropagation();
        if (!wheelGestureActive.current) {
            wheelGestureActive.current = true;
            onGestureStart?.(resolvedParam.name);
        }
        if (wheelGestureTimer.current) clearTimeout(wheelGestureTimer.current);
        wheelGestureTimer.current = setTimeout(() => {
            wheelGestureActive.current = false;
            onGestureEnd?.(resolvedParam.name);
        }, 300);
        const step = resolvedParam.step && resolvedParam.step > 0
            ? resolvedParam.step
            : (resolvedParam.max - resolvedParam.min) / 160;
        const mul = e.shiftKey ? 4 : e.altKey ? 0.2 : 1;
        const delta = (e.deltaY < 0 ? 1 : -1) * step * mul;
        onChange(resolvedParam.name, quantize(safeValue + delta));
    }, [onChange, onGestureEnd, onGestureStart, resolvedParam.max, resolvedParam.min, resolvedParam.name, resolvedParam.step, safeValue, quantize]);

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
        e.preventDefault();
        const def = Number.isFinite(resolvedParam.defaultValue)
            ? resolvedParam.defaultValue as number
            : (resolvedParam.min + resolvedParam.max) * 0.5;
        onChange(resolvedParam.name, quantize(def));
    }, [onChange, resolvedParam.defaultValue, resolvedParam.max, resolvedParam.min, resolvedParam.name, quantize]);

    // Display value
    const displayPct = Math.round(pct * 100);
    // Ensure unique filter id per knob instance (device + param), otherwise
    // SVG filter references can collide across multiple plugin slots.
    const filterId = `drywet-glow-${device.id.replace(/[^a-zA-Z0-9]/g, '_')}-${resolvedParam.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (!hasParam) return null;
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
                    onContextMenu={(e) => onContextMenu?.(e, resolvedParam.name)}
                >
                    <KnobArcSvg
                        pct={pct}
                        size={SIZE}
                        viewBox={48}
                        center={24}
                        radius={13}
                        strokeWidth={4}
                        accent={accentColor}
                        glow
                        glowFilterId={filterId}
                    />
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
                fontFamily: 'var(--font-role-data)',
                color: 'var(--color-text-primary)',
                lineHeight: 1,
            }}>
                {displayPct}%
            </span>
        </div>
    );
});
