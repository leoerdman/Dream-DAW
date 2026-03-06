import React, { useCallback, useRef, useState } from 'react';

interface RotaryKnobProps {
    value: number;
    min: number;
    max: number;
    step?: number;
    label: string;
    unit?: string;
    color?: string;
    onChange: (value: number) => void;
}

const KNOB_SIZE = 44;
const STROKE_WIDTH = 3;
const RADIUS = (KNOB_SIZE - STROKE_WIDTH) / 2;
const CENTER = KNOB_SIZE / 2;
const START_ANGLE = 135;  // degrees from top
const END_ANGLE = 405;    // full sweep = 270°
const SWEEP = END_ANGLE - START_ANGLE;

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
    const start = polarToCartesian(cx, cy, r, endAngle);
    const end = polarToCartesian(cx, cy, r, startAngle);
    const largeArc = endAngle - startAngle > 180 ? 1 : 0;
    return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

export function RotaryKnob({
    value,
    min,
    max,
    step = 0.5,
    label,
    unit = '',
    color = 'var(--color-accent-primary)',
    onChange,
}: RotaryKnobProps) {
    const dragRef = useRef<{ startY: number; startValue: number } | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editText, setEditText] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    const normalized = Math.max(0, Math.min(1, (value - min) / (max - min)));
    const valueAngle = START_ANGLE + normalized * SWEEP;

    // Indicator line
    const indicator = polarToCartesian(CENTER, CENTER, RADIUS - 6, valueAngle);
    const indicatorInner = polarToCartesian(CENTER, CENTER, RADIUS - 14, valueAngle);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        e.stopPropagation();
        e.preventDefault();
        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);
        dragRef.current = { startY: e.clientY, startValue: value };
        setIsDragging(true);

        const onMove = (me: PointerEvent) => {
            if (!dragRef.current) return;
            const dy = dragRef.current.startY - me.clientY;
            const range = max - min;
            const sensitivity = me.shiftKey ? 600 : 200;
            let newValue = dragRef.current.startValue + (dy / sensitivity) * range;
            newValue = Math.round(newValue / step) * step;
            newValue = Math.max(min, Math.min(max, newValue));
            onChange(newValue);
        };

        const onUp = () => {
            dragRef.current = null;
            setIsDragging(false);
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
        };

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
    }, [value, min, max, step, onChange]);

    const handleDoubleClick = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        // Reset to center (0 for bipolar knobs)
        const center = (min + max) / 2;
        onChange(Math.round(center / step) * step);
    }, [min, max, step, onChange]);

    // ── Double-click-to-edit on value display ──────────────────────────
    const handleValueDoubleClick = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        const displayValue = Number.isInteger(value) ? String(value) : value.toFixed(1);
        setEditText(displayValue);
        setIsEditing(true);
        // Focus input after React renders it
        requestAnimationFrame(() => inputRef.current?.select());
    }, [value]);

    const commitEdit = useCallback(() => {
        setIsEditing(false);
        const parsed = Number(editText);
        if (Number.isFinite(parsed)) {
            const quantized = Math.round(parsed / step) * step;
            const clamped = Math.max(min, Math.min(max, quantized));
            onChange(clamped);
        }
    }, [editText, min, max, step, onChange]);

    const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter') commitEdit();
        if (e.key === 'Escape') setIsEditing(false);
    }, [commitEdit]);

    // Arc paths
    const bgArc = describeArc(CENTER, CENTER, RADIUS, START_ANGLE, END_ANGLE);
    const valueArc = normalized > 0.005
        ? describeArc(CENTER, CENTER, RADIUS, START_ANGLE, valueAngle)
        : '';

    // For bipolar knobs (min < 0 < max), draw from center
    const isBipolar = min < 0 && max > 0;
    const centerAngle = START_ANGLE + ((-min) / (max - min)) * SWEEP;
    const bipolarArc = isBipolar && Math.abs(value) > 0.01
        ? (value > 0
            ? describeArc(CENTER, CENTER, RADIUS, centerAngle, valueAngle)
            : describeArc(CENTER, CENTER, RADIUS, valueAngle, centerAngle))
        : '';

    const displayValue = Number.isInteger(value) ? String(value) : value.toFixed(1);

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 'var(--space-0-5)',
                userSelect: 'none',
            }}
        >
            <div style={{
                fontSize: 'var(--font-size-2xs)',
                color: 'var(--color-text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                fontFamily: 'var(--font-role-data)',
                fontWeight: 'var(--font-weight-semibold)',
            }}>
                {label}
            </div>
            <svg
                width={KNOB_SIZE}
                height={KNOB_SIZE}
                onPointerDown={handlePointerDown}
                onDoubleClick={handleDoubleClick}
                style={{
                    cursor: isDragging ? 'ns-resize' : 'pointer',
                    touchAction: 'none',
                    filter: isDragging ? `drop-shadow(0 0 6px ${color})` : 'none',
                    transition: 'filter 0.15s',
                }}
            >
                {/* Background track */}
                <path
                    d={bgArc}
                    fill="none"
                    stroke="color-mix(in srgb, var(--color-text-primary) 12%, transparent)"
                    strokeWidth={STROKE_WIDTH}
                    strokeLinecap="round"
                />
                {/* Value arc */}
                {isBipolar ? (
                    bipolarArc && (
                        <path
                            d={bipolarArc}
                            fill="none"
                            stroke={color}
                            strokeWidth={STROKE_WIDTH}
                            strokeLinecap="round"
                        />
                    )
                ) : (
                    valueArc && (
                        <path
                            d={valueArc}
                            fill="none"
                            stroke={color}
                            strokeWidth={STROKE_WIDTH}
                            strokeLinecap="round"
                        />
                    )
                )}
                {/* Indicator line */}
                <line
                    x1={indicatorInner.x}
                    y1={indicatorInner.y}
                    x2={indicator.x}
                    y2={indicator.y}
                    stroke="var(--color-text-primary)"
                    strokeWidth={2}
                    strokeLinecap="round"
                />
                {/* Center dot */}
                <circle
                    cx={CENTER}
                    cy={CENTER}
                    r={4}
                    fill="color-mix(in srgb, var(--color-text-primary) 15%, transparent)"
                />
            </svg>
            {/* Value display — double-click to edit */}
            {isEditing ? (
                <input
                    ref={inputRef}
                    type="text"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={handleEditKeyDown}
                    onPointerDown={(e) => e.stopPropagation()}
                    autoFocus
                    style={{
                        width: 40,
                        fontSize: 'var(--font-size-2xs)',
                        fontFamily: 'var(--font-role-data)',
                        color: 'var(--color-text-primary)',
                        background: 'color-mix(in srgb, var(--color-accent-primary) 15%, transparent)',
                        border: '1px solid var(--color-accent-primary)',
                        borderRadius: 'var(--radius-sm)',
                        textAlign: 'center',
                        outline: 'none',
                        padding: '0 2px',
                        lineHeight: 1.2,
                    }}
                />
            ) : (
                <span
                    onDoubleClick={handleValueDoubleClick}
                    style={{
                        fontSize: 'var(--font-size-2xs)',
                        fontFamily: 'var(--font-role-data)',
                        color: 'var(--color-text-secondary)',
                        fontVariantNumeric: 'tabular-nums',
                        lineHeight: 1,
                        cursor: 'text',
                    }}
                >
                    {displayValue}{unit && <span style={{ color: 'var(--color-text-tertiary)', marginLeft: 'var(--space-0-5)' }}>{unit}</span>}
                </span>
            )}
        </div>
    );
}
