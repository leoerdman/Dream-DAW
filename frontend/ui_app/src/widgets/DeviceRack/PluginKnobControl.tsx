import { useCallback, useEffect, useRef, useState } from 'react';
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

export const PluginKnob = ({
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
        const clampedUnit = Math.max(0, Math.min(1, unit));
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
    const pct = rawPct <= 1e-4 ? 0 : rawPct >= 1 - 1e-4 ? 1 : Math.max(0, Math.min(1, rawPct));
    const angle = -135 + pct * 270;
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
        return () => node.removeEventListener('wheel', handleWheel);
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

    const arcRadius = 14;
    const svgSize = compact ? 30 : 38;
    const arcCircumference = 2 * Math.PI * arcRadius;
    const dashLength = (270 / 360) * arcCircumference;
    const dashOffset = Math.max(0, Math.min(dashLength, dashLength * (1 - pct)));

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
                    <svg width={svgSize} height={svgSize} viewBox="0 0 40 40" style={{ pointerEvents: 'none' }}>
                        <circle cx="20" cy="20" r={arcRadius} fill="none" stroke="var(--color-bg-elevated)" strokeWidth="4" strokeLinecap="round" strokeDasharray={arcCircumference} strokeDashoffset={arcCircumference - dashLength} transform="rotate(135 20 20)" />
                        {pct > 0 && (
                            <circle cx="20" cy="20" r={arcRadius} fill="none" stroke="var(--color-accent-primary)" strokeWidth="4" strokeLinecap="round" strokeDasharray={dashLength} strokeDashoffset={dashOffset} transform="rotate(135 20 20)" />
                        )}
                        <g transform={`rotate(${angle} 20 20)`}>
                            <line x1="20" y1="20" x2="20" y2="6" stroke="var(--color-text-primary)" strokeWidth="2.5" strokeLinecap="round" />
                        </g>
                    </svg>
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
};
