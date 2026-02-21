import { useCallback, useRef, useState, type CSSProperties } from 'react';

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
    const precision = param.step && param.step < 1 ? 2 : 0;
    return `${param.value.toFixed(precision)}${param.suffix}`;
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
}: {
    param: PluginParam;
    compact?: boolean;
    /** Override display name without changing param.name (used as onChange key). */
    label?: string;
    onChange: (paramName: string, value: number) => void;
    onContextMenu?: (e: React.MouseEvent, paramName: string) => void;
    onGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onGestureEnd?: (paramName: string) => void;
}) => {
    const pct = Math.max(0, Math.min(1, (param.value - param.min) / Math.max(1e-9, param.max - param.min)));
    const angle = -135 + pct * 270;
    const size = compact ? 30 : 38;
    const markerHeight = compact ? 9 : 12;
    const markerTopOffset = compact ? '-84%' : '-88%';
    const [isDragging, setIsDragging] = useState(false);
    const [isEditingValue, setIsEditingValue] = useState(false);
    const [editValueText, setEditValueText] = useState('');
    const dragPointerIdRef = useRef<number | null>(null);
    const dragStartYRef = useRef(0);
    const dragStartValueRef = useRef(0);
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
        dragStartYRef.current = e.clientY;
        dragStartValueRef.current = param.value;
        dialRef.current?.setPointerCapture(e.pointerId);
        setIsDragging(true);
        onGestureStart?.(param.name);
    }, [onGestureStart, param.name, param.value]);

    const onKnobPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (dragPointerIdRef.current !== e.pointerId) return;
        e.preventDefault();
        const valueRange = Math.max(1e-9, param.max - param.min);
        const dy = e.clientY - dragStartYRef.current;
        const dragScalePx = e.shiftKey ? 130 : e.altKey ? 760 : 220;
        const nextRaw = dragStartValueRef.current + (((-dy) / dragScalePx) * valueRange);
        onChange(param.name, quantizeValue(nextRaw));
    }, [onChange, param.max, param.min, param.name, quantizeValue]);

    const onKnobWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const valueRange = Math.max(1e-9, param.max - param.min);
        const step = param.step && param.step > 0 ? param.step : valueRange / 160;
        const wheelMul = e.shiftKey ? 4.0 : e.altKey ? 0.2 : 1.0;
        const delta = (e.deltaY < 0 ? 1 : -1) * step * wheelMul;
        onChange(param.name, quantizeValue(param.value + delta));
    }, [onChange, param.max, param.min, param.name, param.step, param.value, quantizeValue]);

    const onKnobDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        onChange(param.name, quantizeValue(defaultParamValue(param)));
    }, [onChange, param, quantizeValue]);

    const endKnobDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (dragPointerIdRef.current !== e.pointerId) return;
        dragPointerIdRef.current = null;
        dialRef.current?.releasePointerCapture(e.pointerId);
        setIsDragging(false);
        onGestureEnd?.(param.name);
    }, [onGestureEnd, param.name]);

    const beginValueEdit = useCallback((e: React.MouseEvent<HTMLSpanElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setEditValueText(String(param.value));
        setIsEditingValue(true);
    }, [param.value]);

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
        setEditValueText(String(param.value));
    }, [param.value]);

    return (
        <label
            style={knobLabelStyle(compact)}
            onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, param.name); } : undefined}
        >
            <div style={{ position: 'relative', width: size, height: size }}>
                <div
                    style={{
                        position: 'absolute',
                        inset: -2,
                        borderRadius: '50%',
                        background: `conic-gradient(from -135deg, var(--knob-arc-gradient-end) ${Math.max(2, pct * 270)}deg, rgba(255,255,255,0.08) ${Math.max(2, pct * 270)}deg 270deg, transparent 270deg 360deg)`,
                        opacity: 0.95,
                        pointerEvents: 'none',
                    }}
                />
                <div
                    ref={dialRef}
                    style={knobDialStyle(isDragging)}
                    onPointerDown={onKnobPointerDown}
                    onPointerMove={onKnobPointerMove}
                    onPointerUp={endKnobDrag}
                    onPointerCancel={endKnobDrag}
                    onWheel={onKnobWheel}
                    onDoubleClick={onKnobDoubleClick}
                >
                    <div
                        style={{
                            ...knobMarkerStyle,
                            height: markerHeight,
                            transform: `translate(-50%, ${markerTopOffset}) rotate(${angle}deg)`,
                        }}
                    />
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

const sliderLabelStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
    minWidth: 110,
};

const sliderTextStyle: CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text-secondary)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 'var(--space-2)',
};

const sliderValueStyle: CSSProperties = {
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-mono)',
};

const sliderInputStyle: CSSProperties = {
    width: '100%',
    accentColor: 'var(--color-accent-primary)',
    cursor: 'ew-resize',
    height: 'var(--space-3-5)',
    borderRadius: 'var(--radius-full)',
    background: 'transparent',
};

const knobLabelStyle = (compact: boolean): CSSProperties => ({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: compact ? 'var(--space-0-5)' : 'var(--space-1)',
    minWidth: compact ? 48 : 76,
});

const knobParamNameStyle: CSSProperties = {
    fontSize: 'var(--font-size-2xs)',
    color: 'var(--color-text-secondary)',
    textAlign: 'center',
    lineHeight: 1.1,
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    maxWidth: 74,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
};

const knobDialStyle = (dragging: boolean): CSSProperties => ({
    width: '100%',
    height: '100%',
    borderRadius: '50%',
    background: 'var(--knob-dial-gradient)',
    border: 'var(--knob-dial-border)',
    boxShadow: dragging
        ? 'var(--knob-dial-shadow-active)'
        : 'var(--knob-dial-shadow)',
    position: 'relative',
    cursor: 'ns-resize',
    touchAction: 'none',
});

const knobMarkerStyle: CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 'var(--space-0-5)',
    background: 'var(--color-accent-primary)',
    transformOrigin: '50% 90%',
    borderRadius: 'var(--radius-full)' as unknown as number,
    boxShadow: 'var(--knob-marker-glow)',
};

const knobValueStyle = (compact: boolean): CSSProperties => ({
    fontSize: compact ? 'var(--font-size-2xs)' : 'var(--font-size-xs)',
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-mono)',
    opacity: 0.92,
    cursor: 'text',
    userSelect: 'none',
});

const knobValueInputStyle = (compact: boolean): CSSProperties => ({
    width: compact ? 52 : 62,
    height: compact ? 16 : 18,
    border: 'var(--border-width-1) solid color-mix(in srgb, var(--color-accent-primary) 55%, rgba(255,255,255,0.2))',
    borderRadius: 'var(--radius-xs)',
    background: 'color-mix(in srgb, var(--surface-2) 88%, black)',
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-mono)',
    fontSize: compact ? 'var(--font-size-2xs)' : 'var(--font-size-xs)',
    textAlign: 'center',
    padding: '0 var(--space-1)',
    outline: 'none',
});

const knobDragValueBadgeStyle: CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: -16,
    transform: 'translateX(-50%)',
    fontSize: 'var(--font-size-2xs)',
    fontFamily: 'var(--font-mono)',
    color: 'var(--badge-color)',
    background: 'var(--badge-bg)',
    border: 'var(--badge-border)',
    borderRadius: 'var(--radius-md)',
    padding: 'var(--space-px) var(--space-1)',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
};
