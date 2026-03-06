import React, { useCallback, useRef, useState } from 'react';
import type { PortFaderConfig } from '../../model/portRegistry';

/**
 * PortRowFader — compact inline fader for Flow node port rows (Bitwig Grid attenuator).
 *
 * Designed for FLOW_PORT_ROW_HEIGHT = 32px rows.
 * Layout: [──fill──|thumb] [value]
 * No label (port label is rendered separately by PortLabel).
 *
 * ENTERPRISE: Uses pointer capture for robust cross-element dragging.
 * Supports mouse wheel with smooth linear interpolation.
 * Double-click on value display opens inline edit input.
 */

const TRACK_H = 4;
const THUMB_W = 6;
const THUMB_H = 14;
const FADER_HEIGHT = 20;

interface Props {
    value: number;
    config: PortFaderConfig;
    onChange: (value: number) => void;
}

export const PortRowFader = React.memo(function PortRowFader({ value, config, onChange }: Props) {
    const trackRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editText, setEditText] = useState('');

    const { min, max, step, unit } = config;

    const safeValue = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
    const pct = (safeValue - min) / (max - min);

    const quantize = useCallback((v: number): number => {
        const q = Math.round(v / step) * step;
        return Math.min(max, Math.max(min, q));
    }, [min, max, step]);

    const pctToValue = useCallback((p: number): number => {
        const clamped = Math.min(1, Math.max(0, p));
        return min + clamped * (max - min);
    }, [min, max]);

    const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.stopPropagation();
        e.preventDefault();
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        setIsDragging(true);

        const rect = target.getBoundingClientRect();
        const p = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)));
        onChange(quantize(pctToValue(p)));
    }, [onChange, pctToValue, quantize]);

    const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!isDragging) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const p = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)));
        onChange(quantize(pctToValue(p)));
    }, [isDragging, onChange, pctToValue, quantize]);

    const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        setIsDragging(false);
    }, []);

    // Mouse wheel support
    React.useEffect(() => {
        const node = trackRef.current;
        if (!node) return;
        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const delta = -e.deltaY * (max - min) * 0.002;
            onChange(quantize(safeValue + delta));
        };
        node.addEventListener('wheel', handleWheel, { passive: false });
        return () => node.removeEventListener('wheel', handleWheel);
    }, [safeValue, min, max, onChange, quantize]);

    // ── Double-click-to-edit on value display ──────────────────────────
    const handleValueDoubleClick = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        const display = step >= 1 ? Math.round(safeValue).toString() : safeValue.toFixed(2);
        setEditText(display);
        setIsEditing(true);
        requestAnimationFrame(() => inputRef.current?.select());
    }, [safeValue, step]);

    const commitEdit = useCallback(() => {
        setIsEditing(false);
        const parsed = Number(editText);
        if (Number.isFinite(parsed)) {
            onChange(quantize(parsed));
        }
    }, [editText, onChange, quantize]);

    const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter') commitEdit();
        if (e.key === 'Escape') setIsEditing(false);
    }, [commitEdit]);

    // Format display value
    const displayValue = step >= 1 ? Math.round(safeValue).toString() : safeValue.toFixed(2);

    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                height: FADER_HEIGHT,
                flex: 1,
                minWidth: 0,
            }}
        >
            {/* Track + Thumb */}
            <div
                ref={trackRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                style={{
                    position: 'relative',
                    flex: 1,
                    height: THUMB_H + 4,
                    cursor: isDragging ? 'grabbing' : 'ew-resize',
                    touchAction: 'none',
                    display: 'flex',
                    alignItems: 'center',
                }}
            >
                {/* Rail */}
                <div style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: '50%',
                    height: TRACK_H,
                    transform: 'translateY(-50%)',
                    borderRadius: TRACK_H / 2,
                    background: 'color-mix(in srgb, var(--color-text-primary) 10%, transparent)',
                }} />
                {/* Fill */}
                <div style={{
                    position: 'absolute',
                    left: 0,
                    top: '50%',
                    height: TRACK_H,
                    width: `${pct * 100}%`,
                    transform: 'translateY(-50%)',
                    borderRadius: TRACK_H / 2,
                    background: 'var(--color-accent-primary)',
                    opacity: 0.72,
                    transition: isDragging ? 'none' : 'width 60ms linear',
                }} />
                {/* Thumb */}
                <div style={{
                    position: 'absolute',
                    top: '50%',
                    left: `calc(${pct * 100}% - ${THUMB_W / 2}px)`,
                    width: THUMB_W,
                    height: THUMB_H,
                    transform: 'translateY(-50%)',
                    borderRadius: 2,
                    background: isDragging
                        ? 'color-mix(in srgb, var(--color-accent-primary) 85%, white 15%)'
                        : 'var(--color-text-secondary)',
                    transition: isDragging ? 'none' : 'background 0.15s',
                    boxShadow: isDragging ? '0 0 6px var(--color-accent-primary)' : 'none',
                }} />
            </div>
            {/* Value — double-click to edit */}
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
                        width: 36,
                        fontSize: 'var(--font-size-2xs)',
                        fontFamily: 'var(--font-role-data)',
                        color: 'var(--color-text-primary)',
                        background: 'color-mix(in srgb, var(--color-accent-primary) 15%, transparent)',
                        border: '1px solid var(--color-accent-primary)',
                        borderRadius: 'var(--radius-sm)',
                        textAlign: 'right',
                        outline: 'none',
                        padding: '0 2px',
                        flexShrink: 0,
                    }}
                />
            ) : (
                <span
                    onDoubleClick={handleValueDoubleClick}
                    style={{
                        fontSize: 'var(--font-size-2xs)',
                        fontFamily: 'var(--font-role-data)',
                        color: 'var(--color-text-tertiary)',
                        fontVariantNumeric: 'tabular-nums',
                        flexShrink: 0,
                        minWidth: 28,
                        textAlign: 'right',
                        cursor: 'text',
                    }}
                >
                    {displayValue}{unit ? <span style={{ opacity: 0.6 }}>{unit}</span> : null}
                </span>
            )}
        </div>
    );
});
PortRowFader.displayName = 'PortRowFader';
