import { useCallback, useEffect, useRef, useState } from 'react';
import {
    knobDialStyle,
    knobDragValueBadgeStyle,
    knobLabelStyle,
    knobParamNameStyle,
    knobValueInputStyle,
    knobValueStyle,
    sliderInputStyle,
    sliderLabelStyle,
    sliderTextStyle,
    sliderValueStyle,
} from './StandardPluginControlStyles';
export interface PluginParam {
    name: string;
    value: number;
    min: number;
    max: number;
    suffix: string;
    step?: number;
    defaultValue?: number;
}
const formatPluginParamValue = (param: PluginParam): string => {
    const v = Number.isFinite(param.value) ? param.value : 0;
    const precision = param.step && param.step < 1 ? 2 : 0;
    return `${v.toFixed(precision)}${param.suffix ?? ''}`;
};

const formatPluginParamName = (raw: string): string => {
    const withSpaces = raw
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[._-]+/g, ' ')
        .trim();
    return withSpaces.length > 0 ? withSpaces.toUpperCase() : raw.toUpperCase();
};

const defaultParamValue = (param: PluginParam): number => {
    if (Number.isFinite(param.defaultValue)) {
        return Math.max(param.min, Math.min(param.max, param.defaultValue as number));
    }
    const name = param.name.toLowerCase();
    if (param.min <= 0 && param.max >= 0) return 0;
    if (name.includes('mix') || name.includes('width') || name.includes('amount') || name.includes('depth')) {
        return (param.min + param.max) * 0.5;
    }
    if (name.includes('gain') || name.includes('volume') || name === 'vol') {
        return Math.min(param.max, Math.max(param.min, 0));
    }
    return Math.min(param.max, Math.max(param.min, (param.min + param.max) * 0.5));
};

export const PluginSlider = ({
    param,
    onChange,
}: {
    param: PluginParam;
    onChange: (paramName: string, value: number) => void;
}) => (
    <label style={sliderLabelStyle}>
        <span style={sliderTextStyle}>
            {param.name} <span style={sliderValueStyle}>{formatPluginParamValue(param)}</span>
        </span>
        <input
            type="range"
            min={param.min}
            max={param.max}
            step={param.step ?? (param.max - param.min) / 100}
            value={param.value}
            onChange={(e) => onChange(param.name, Number(e.target.value))}
            style={sliderInputStyle}
        />
    </label>
);

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
    /** Override display name without changing param.name (used as onChange key). */
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
    const safeValue = Number.isFinite(param.value)
        ? param.value
        : (Number.isFinite(param.defaultValue) ? (param.defaultValue as number) : param.min);
    const pct = Math.max(0, Math.min(1, valueToUnit(safeValue)));
    const angle = -135 + pct * 270;
    // const size = compact ? 30 : 38;
    // const markerHeight = compact ? 9 : 12;
    // const markerTopOffset = compact ? '-84%' : '-88%';
    const [isDragging, setIsDragging] = useState(false);
    const [isEditingValue, setIsEditingValue] = useState(false);
    const [editValueText, setEditValueText] = useState('');
    const dragPointerIdRef = useRef<number | null>(null);
    const mouseDragActiveRef = useRef(false);
    const dragStartYRef = useRef(0);
    const dragStartUnitRef = useRef(0);
    const dialRef = useRef<HTMLDivElement | null>(null);

    const quantizeValue = useCallback((raw: number): number => {
        const clamped = Math.max(param.min, Math.min(param.max, raw));
        const step = param.step;
        if (!step || step <= 0) return clamped;
        const snapped = Math.round((clamped - param.min) / step) * step + param.min;
        const precision = Math.max(0, Math.ceil(Math.log10(1 / step)));
        return Number(snapped.toFixed(Math.min(6, precision + 1)));
    }, [param.max, param.min, param.step]);

    const onKnobPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        dragPointerIdRef.current = e.pointerId;
        mouseDragActiveRef.current = false;
        dragStartYRef.current = e.clientY;
        dragStartUnitRef.current = valueToUnit(safeValue);
        try {
            dialRef.current?.setPointerCapture(e.pointerId);
        } catch {
            // Some WebView builds may throw on pointer capture; mouse fallback handles drag.
        }
        setIsDragging(true);
        onGestureStart?.(param.name);
    }, [onGestureStart, param.name, safeValue, valueToUnit]);

    const onKnobPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (dragPointerIdRef.current !== e.pointerId) return;
        e.preventDefault();
        const dy = e.clientY - dragStartYRef.current;
        const dragScalePx = e.shiftKey ? 130 : e.altKey ? 760 : 220;
        const nextUnit = dragStartUnitRef.current + ((-dy) / dragScalePx);
        const nextRaw = unitToValue(nextUnit);
        onChange(param.name, quantizeValue(nextRaw));
    }, [onChange, param.name, quantizeValue, unitToValue]);

    const onKnobWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const valueRange = Math.max(1e-9, param.max - param.min);
        const linearStep = param.step && param.step > 0 ? param.step : valueRange / 160;
        const unitStep = 1 / 160;
        const wheelMul = e.shiftKey ? 4.0 : e.altKey ? 0.2 : 1.0;
        if (useLogScale) {
            const unitDelta = (e.deltaY < 0 ? 1 : -1) * unitStep * wheelMul;
            const nextUnit = valueToUnit(param.value) + unitDelta;
            onChange(param.name, quantizeValue(unitToValue(nextUnit)));
            return;
        }
        const delta = (e.deltaY < 0 ? 1 : -1) * linearStep * wheelMul;
        onChange(param.name, quantizeValue(param.value + delta));
    }, [onChange, param.max, param.min, param.name, param.step, param.value, quantizeValue, unitToValue, useLogScale, valueToUnit]);

    const onKnobDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        onChange(param.name, quantizeValue(defaultParamValue(param)));
    }, [onChange, param, quantizeValue]);

    const endKnobDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (dragPointerIdRef.current !== e.pointerId) return;
        dragPointerIdRef.current = null;
        try {
            dialRef.current?.releasePointerCapture(e.pointerId);
        } catch {
            // Ignore release failures from unsupported pointer capture implementations.
        }
        setIsDragging(false);
        onGestureEnd?.(param.name);
    }, [onGestureEnd, param.name]);

    useEffect(() => {
        const onWindowPointerMove = (e: PointerEvent) => {
            if (dragPointerIdRef.current !== e.pointerId) return;
            const dy = e.clientY - dragStartYRef.current;
            const dragScalePx = e.shiftKey ? 130 : e.altKey ? 760 : 220;
            const nextUnit = dragStartUnitRef.current + ((-dy) / dragScalePx);
            const nextRaw = unitToValue(nextUnit);
            onChange(param.name, quantizeValue(nextRaw));
        };

        const onWindowPointerUp = (e: PointerEvent) => {
            if (dragPointerIdRef.current !== e.pointerId) return;
            dragPointerIdRef.current = null;
            setIsDragging(false);
            onGestureEnd?.(param.name);
        };

        window.addEventListener('pointermove', onWindowPointerMove);
        window.addEventListener('pointerup', onWindowPointerUp);
        window.addEventListener('pointercancel', onWindowPointerUp);
        return () => {
            window.removeEventListener('pointermove', onWindowPointerMove);
            window.removeEventListener('pointerup', onWindowPointerUp);
            window.removeEventListener('pointercancel', onWindowPointerUp);
        };
    }, [onChange, onGestureEnd, param.name, quantizeValue, unitToValue]);

    const beginMouseDrag = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (e.button !== 0 || dragPointerIdRef.current !== null) return;
        e.preventDefault();
        e.stopPropagation();
        mouseDragActiveRef.current = true;
        dragStartYRef.current = e.clientY;
        dragStartUnitRef.current = valueToUnit(safeValue);
        setIsDragging(true);
        onGestureStart?.(param.name);
    }, [onGestureStart, param.name, safeValue, valueToUnit]);

    useEffect(() => {
        const onMouseMove = (e: MouseEvent) => {
            if (!mouseDragActiveRef.current) return;
            e.preventDefault();
            const dy = e.clientY - dragStartYRef.current;
            const dragScalePx = e.shiftKey ? 130 : e.altKey ? 760 : 220;
            const nextUnit = dragStartUnitRef.current + ((-dy) / dragScalePx);
            const nextRaw = unitToValue(nextUnit);
            onChange(param.name, quantizeValue(nextRaw));
        };

        const onMouseUp = () => {
            if (!mouseDragActiveRef.current) return;
            mouseDragActiveRef.current = false;
            setIsDragging(false);
            onGestureEnd?.(param.name);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        return () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
    }, [onChange, onGestureEnd, param.name, quantizeValue, unitToValue]);

    const beginValueEdit = useCallback((e: React.MouseEvent<HTMLSpanElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setEditValueText(String(safeValue));
        setIsEditingValue(true);
    }, [safeValue]);

    const commitValueEdit = useCallback(() => {
        const normalized = editValueText.replace(',', '.').trim();
        const parsed = Number(normalized);
        if (Number.isFinite(parsed)) {
            onChange(param.name, quantizeValue(parsed));
        }
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
    const dashOffset = dashLength * (1 - pct);

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
                    onWheel={onKnobWheel}
                    onDoubleClick={onKnobDoubleClick}
                >
                    <svg width={svgSize} height={svgSize} viewBox="0 0 40 40" style={{ pointerEvents: 'none' }}>
                        {/* Background Arc */}
                        <circle
                            cx="20"
                            cy="20"
                            r={arcRadius}
                            fill="none"
                            stroke="var(--color-bg-elevated)"
                            strokeWidth="4"
                            strokeLinecap="round"
                            strokeDasharray={arcCircumference}
                            strokeDashoffset={arcCircumference - dashLength}
                            transform="rotate(135 20 20)"
                        />
                        {/* Value Arc */}
                        {pct > 0 && (
                            <circle
                                cx="20"
                                cy="20"
                                r={arcRadius}
                                fill="none"
                                stroke="var(--color-accent-primary)"
                                strokeWidth="4"
                                strokeLinecap="round"
                                strokeDasharray={dashLength}
                                strokeDashoffset={dashOffset}
                                transform="rotate(135 20 20)"
                            />
                        )}
                        {/* Marker Line */}
                        <g transform={`rotate(${angle} 20 20)`}>
                            <line
                                x1="20"
                                y1="20"
                                x2="20"
                                y2="6"
                                stroke="var(--color-text-primary)"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                            />
                        </g>
                    </svg>
                </div>
                {isDragging && (
                    <span style={knobDragValueBadgeStyle}>
                        {formatPluginParamValue(param)}
                    </span>
                )}
            </div>
            <span style={knobParamNameStyle}>{formatPluginParamName(label ?? param.name)}</span>
            {isEditingValue ? (
                <input
                    autoFocus
                    value={editValueText}
                    onChange={(e) => setEditValueText(e.target.value)}
                    onBlur={commitValueEdit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            commitValueEdit();
                        } else if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelValueEdit();
                        }
                    }}
                    style={knobValueInputStyle(compact)}
                />
            ) : (
                <span
                    style={knobValueStyle(compact)}
                    onDoubleClick={beginValueEdit}
                    title="Double-click to type value"
                >
                    {formatPluginParamValue(param)}
                </span>
            )}
        </label>
    );
};
