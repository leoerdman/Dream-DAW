import React, { useCallback, useEffect, useRef, useState } from 'react';
import { clamp01 } from '@/shared/lib/audioMath';
import {
    knobDialStyle,
    knobDragValueBadgeStyle,
    knobLabelStyle,
    knobParamNameStyle,
    knobValueInputStyle,
    knobValueStyle,
} from './StandardPluginControlStyles';
import {
    defaultParamValue,
    formatPluginParamName,
    formatPluginParamValue,
    roundPluginParamForDisplay,
} from './StandardPluginControlUtils';
import { usePluginKnobDrag } from './usePluginKnobDrag';
import type { PluginParam } from './StandardPluginControlTypes';
import { KnobArcSvg } from '@/shared/ui/KnobArcSvg';

export const PluginKnob = React.memo(({
    param,
    compact = false,
    label,
    onChange,
    onContextMenu,
    onGestureStart,
    onGestureEnd,
    scale = 'linear',
}: {
    param: PluginParam;
    compact?: boolean;
    label?: string;
    onChange: (paramName: string, value: number) => void;
    onContextMenu?: (e: React.MouseEvent, paramName: string) => void;
    onGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onGestureEnd?: (paramName: string) => void;
    scale?: 'linear' | 'log';
}) => {
    const useLogScale = scale === 'log' && param.min > 0 && param.max > param.min;
    const valueToUnit = useCallback((value: number): number => {
        if (!useLogScale) return (value - param.min) / Math.max(1e-9, param.max - param.min);
        const lo = Math.log(param.min);
        const hi = Math.log(param.max);
        return (Math.log(Math.max(param.min, Math.min(param.max, value))) - lo) / Math.max(1e-9, hi - lo);
    }, [param.max, param.min, useLogScale]);
    const unitToValue = useCallback((unit: number): number => {
        const clampedUnit = clamp01(unit);
        if (!useLogScale) return param.min + clampedUnit * (param.max - param.min);
        const ratio = Math.log(param.max / param.min);
        return param.min * Math.exp(clampedUnit * ratio);
    }, [param.max, param.min, useLogScale]);
    const quantizeValue = useCallback((raw: number): number => {
        const clamped = Math.max(param.min, Math.min(param.max, raw));
        const step = param.step;
        if (!step || step <= 0) return clamped;
        const snapped = Math.round((clamped - param.min) / step) * step + param.min;
        const precision = Math.max(0, Math.ceil(Math.log10(1 / step)));
        return Number(snapped.toFixed(Math.min(6, precision + 1)));
    }, [param.max, param.min, param.step]);
    const safeValue = Number.isFinite(param.value)
        ? param.value
        : (Number.isFinite(param.defaultValue) ? (param.defaultValue as number) : param.min);
    const displayRoundedValue = roundPluginParamForDisplay(param, safeValue);
    const visualValue = quantizeValue(displayRoundedValue);
    const rawPct = valueToUnit(visualValue);
    const pct = rawPct <= 1e-4 ? 0 : rawPct >= 1 - 1e-4 ? 1 : clamp01(rawPct);
    const [isEditingValue, setIsEditingValue] = useState(false);
    const [editValueText, setEditValueText] = useState('');

    const {
        isDragging,
        dialRef,
        onKnobPointerDown,
        onKnobPointerMove,
        endKnobDrag,
        beginMouseDrag,
    } = usePluginKnobDrag({
        paramName: param.name,
        value: safeValue,
        quantizeValue,
        valueToUnit,
        unitToValue,
        onChange,
        onGestureStart,
        onGestureEnd,
    });

    // BUG-H15 FIX: Wheel changes now fire gesture start/end so undo history
    // groups consecutive wheel ticks into a single entry.
    const wheelGestureActive = useRef(false);
    const wheelGestureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleWheel = useCallback((e: WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();

        // Start gesture on first wheel tick.
        if (!wheelGestureActive.current) {
            wheelGestureActive.current = true;
            onGestureStart?.(param.name);
        }
        // Debounce gesture end — 300ms after last wheel tick.
        if (wheelGestureTimer.current) clearTimeout(wheelGestureTimer.current);
        wheelGestureTimer.current = setTimeout(() => {
            wheelGestureActive.current = false;
            onGestureEnd?.(param.name);
        }, 300);

        const valueRange = Math.max(1e-9, param.max - param.min);
        const linearStep = param.step && param.step > 0 ? param.step : valueRange / 160;
        const unitStep = 1 / 160;
        const wheelMul = e.shiftKey ? 4.0 : e.altKey ? 0.2 : 1.0;
        if (useLogScale) {
            const unitDelta = (e.deltaY < 0 ? 1 : -1) * unitStep * wheelMul;
            const nextUnit = valueToUnit(safeValue) + unitDelta;
            onChange(param.name, quantizeValue(unitToValue(nextUnit)));
            return;
        }
        const delta = (e.deltaY < 0 ? 1 : -1) * linearStep * wheelMul;
        onChange(param.name, quantizeValue(safeValue + delta));
    }, [onChange, onGestureStart, onGestureEnd, param.max, param.min, param.name, param.step, quantizeValue, safeValue, unitToValue, useLogScale, valueToUnit]);

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

    const onKnobDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        onChange(param.name, quantizeValue(defaultParamValue(param)));
    }, [onChange, param, quantizeValue]);
    const beginValueEdit = useCallback((e: React.MouseEvent<HTMLSpanElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setEditValueText(String(safeValue));
        setIsEditingValue(true);
    }, [safeValue]);
    const commitValueEdit = useCallback(() => {
        const normalized = editValueText.replace(',', '.').trim();
        const parsed = Number(normalized);
        if (Number.isFinite(parsed)) onChange(param.name, quantizeValue(parsed));
        setIsEditingValue(false);
    }, [editValueText, onChange, param.name, quantizeValue]);
    const cancelValueEdit = useCallback(() => {
        setIsEditingValue(false);
        setEditValueText(String(safeValue));
    }, [safeValue]);

    const svgSize = compact ? 30 : 38;

    return (
        <label
            style={knobLabelStyle(compact)}
            onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, param.name); } : undefined}
        >
            <div style={{ position: 'relative', width: svgSize, height: svgSize }}>
                <div
                    ref={dialRef}
                    style={knobDialStyle(isDragging)}
                    onPointerDown={onKnobPointerDown}
                    onPointerMove={onKnobPointerMove}
                    onPointerUp={endKnobDrag}
                    onPointerCancel={endKnobDrag}
                    onMouseDown={beginMouseDrag}
                    onDoubleClick={onKnobDoubleClick}
                >
                    <KnobArcSvg
                        pct={pct}
                        size={svgSize}
                        viewBox={40}
                        radius={14}
                        strokeWidth={4}
                        glow={isDragging || pct > 0.02}
                        glowFilterId={`knob-glow-${param.name.replace(/\W/g, '_')}`}
                    />
                </div>
                {isDragging && <span style={knobDragValueBadgeStyle}>{formatPluginParamValue(param)}</span>}
            </div>
            <span style={knobParamNameStyle}>{formatPluginParamName(label ?? param.name)}</span>
            {isEditingValue ? (
                <input
                    autoFocus
                    value={editValueText}
                    onChange={(e) => setEditValueText(e.target.value)}
                    onBlur={commitValueEdit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitValueEdit(); }
                        else if (e.key === 'Escape') { e.preventDefault(); cancelValueEdit(); }
                    }}
                    style={knobValueInputStyle(compact)}
                />
            ) : (
                <span style={knobValueStyle(compact)} onDoubleClick={beginValueEdit} title="Double-click to type value">
                    {formatPluginParamValue(param)}
                </span>
            )}
        </label>
    );
});
PluginKnob.displayName = 'PluginKnob';
