import { useCallback, useRef, useState, type CSSProperties } from 'react';

export interface PluginParam {
    name: string;
    value: number;
    min: number;
    max: number;
    suffix: string;
    step?: number;
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
    onChange,
    onContextMenu,
}: {
    param: PluginParam;
    compact?: boolean;
    onChange: (paramName: string, value: number) => void;
    onContextMenu?: (e: React.MouseEvent, paramName: string) => void;
}) => {
    const pct = Math.max(0, Math.min(1, (param.value - param.min) / Math.max(1e-9, param.max - param.min)));
    const angle = -135 + pct * 270;
    const size = compact ? 34 : 42;
    const markerHeight = compact ? 11 : 14;
    const markerTopOffset = compact ? '-84%' : '-88%';
    const [isDragging, setIsDragging] = useState(false);
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
    }, [param.value]);

    const onKnobPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (dragPointerIdRef.current !== e.pointerId) return;
        e.preventDefault();
        const valueRange = Math.max(1e-9, param.max - param.min);
        const dy = e.clientY - dragStartYRef.current;
        const dragScalePx = e.shiftKey ? 420 : 240;
        const nextRaw = dragStartValueRef.current + ((-dy / dragScalePx) * valueRange);
        onChange(param.name, quantizeValue(nextRaw));
    }, [onChange, param.max, param.min, param.name, quantizeValue]);

    const endKnobDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (dragPointerIdRef.current !== e.pointerId) return;
        dragPointerIdRef.current = null;
        dialRef.current?.releasePointerCapture(e.pointerId);
        setIsDragging(false);
    }, []);

    return (
        <label
            style={knobLabelStyle(compact)}
            onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, param.name); } : undefined}
        >
            <div style={{ position: 'relative', width: size, height: size }}>
                <div
                    ref={dialRef}
                    style={knobDialStyle(isDragging)}
                    onPointerDown={onKnobPointerDown}
                    onPointerMove={onKnobPointerMove}
                    onPointerUp={endKnobDrag}
                    onPointerCancel={endKnobDrag}
                >
                    <div
                        style={{
                            ...knobMarkerStyle,
                            height: markerHeight,
                            transform: `translate(-50%, ${markerTopOffset}) rotate(${angle}deg)`,
                        }}
                    />
                </div>
            </div>
            <span style={knobParamNameStyle}>{formatPluginParamName(param.name)}</span>
            <span style={knobValueStyle(compact)}>{formatPluginParamValue(param)}</span>
        </label>
    );
};

const sliderLabelStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 110,
};

const sliderTextStyle: CSSProperties = {
    fontSize: 10,
    color: 'var(--color-text-secondary)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
};

const sliderValueStyle: CSSProperties = {
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-mono)',
};

const sliderInputStyle: CSSProperties = {
    width: '100%',
    accentColor: 'var(--color-accent-primary)',
    cursor: 'ew-resize',
    height: 14,
    borderRadius: 999,
    background: 'transparent',
};

const knobLabelStyle = (compact: boolean): CSSProperties => ({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: compact ? 2 : 4,
    minWidth: compact ? 56 : 86,
});

const knobParamNameStyle: CSSProperties = {
    fontSize: 9,
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
    background: 'radial-gradient(circle at 35% 28%, #3a3f47 0%, #232831 54%, #13171d 100%)',
    border: '1px solid color-mix(in srgb, var(--color-accent-primary) 24%, rgba(255,255,255,0.2))',
    boxShadow: dragging
        ? 'inset 0 1px 2px rgba(255,255,255,0.11), inset 0 -2px 6px rgba(0,0,0,0.64), 0 0 0 1px rgba(10,14,18,0.72), 0 0 0 2px color-mix(in srgb, var(--color-accent-primary) 40%, transparent)'
        : 'inset 0 1px 2px rgba(255,255,255,0.09), inset 0 -2px 5px rgba(0,0,0,0.58), 0 0 0 1px rgba(10,14,18,0.6)',
    position: 'relative',
    cursor: 'ns-resize',
    touchAction: 'none',
});

const knobMarkerStyle: CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 2,
    background: 'var(--color-accent-primary)',
    transformOrigin: '50% 90%',
    borderRadius: 999,
    boxShadow: '0 0 5px color-mix(in srgb, var(--color-accent-primary) 68%, transparent)',
};

const knobValueStyle = (compact: boolean): CSSProperties => ({
    fontSize: compact ? 9 : 10,
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-mono)',
    opacity: 0.92,
});
