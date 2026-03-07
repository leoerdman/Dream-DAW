import React, { useCallback, useEffect, useRef, useState } from 'react';
import { clamp01 } from '@/shared/lib/audioMath';
import {
    knobParamNameStyle,
    knobValueStyle,
    knobValueInputStyle,
    knobDragValueBadgeStyle,
} from './StandardPluginControlStyles';
import {
    defaultParamValue,
    formatPluginParamName,
    formatPluginParamValue,
    roundPluginParamForDisplay,
} from './StandardPluginControlUtils';
import type { PluginParam } from './StandardPluginControlTypes';

/* ─────────────────────────────────────────────────────────────────────────────
   PluginFader — Compact HORIZONTAL fader for dense plugin parameter layouts.
   Same style as the blue volume slider in arrangement view track headers.
   Full width, 18px tall track, with name on left and value on right.
   ───────────────────────────────────────────────────────────────────────────── */

const TRACK_H = 6;
const THUMB_W = 4;
const THUMB_H = 12;

export const PluginFader = React.memo(({
    param,
    label,
    onChange,
    onContextMenu,
    onGestureStart,
    onGestureEnd,
}: {
    param: PluginParam;
    label?: string;
    onChange: (paramName: string, value: number) => void;
    onContextMenu?: (e: React.MouseEvent, paramName: string) => void;
    onGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onGestureEnd?: (paramName: string) => void;
}) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [isEditingValue, setIsEditingValue] = useState(false);
    const [editValueText, setEditValueText] = useState('');
    const gestureActiveRef = useRef(false);

    const safeValue = Number.isFinite(param.value)
        ? param.value
        : (Number.isFinite(param.defaultValue) ? (param.defaultValue as number) : param.min);
    const displayRoundedValue = roundPluginParamForDisplay(param, safeValue);
    const pct = clamp01((displayRoundedValue - param.min) / Math.max(1e-9, param.max - param.min));

    const quantizeValue = useCallback((raw: number): number => {
        const clamped = Math.max(param.min, Math.min(param.max, raw));
        const step = param.step;
        if (!step || step <= 0) return clamped;
        const snapped = Math.round((clamped - param.min) / step) * step + param.min;
        const precision = Math.max(0, Math.ceil(Math.log10(1 / step)));
        return Number(snapped.toFixed(Math.min(6, precision + 1)));
    }, [param.max, param.min, param.step]);

    const pctToValue = useCallback((p: number): number => {
        return param.min + clamp01(p) * (param.max - param.min);
    }, [param.min, param.max]);

    // ── Pointer drag ────────────────────────────────────────────────
    const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const track = trackRef.current;
        if (!track) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setIsDragging(true);
        if (!gestureActiveRef.current) {
            gestureActiveRef.current = true;
            onGestureStart?.(param.name);
        }
        const rect = track.getBoundingClientRect();
        const p = clamp01((e.clientX - rect.left) / Math.max(1, rect.width));
        onChange(param.name, quantizeValue(pctToValue(p)));
    }, [onChange, onGestureStart, param.name, pctToValue, quantizeValue]);

    const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!isDragging) return;
        const track = trackRef.current;
        if (!track) return;
        const rect = track.getBoundingClientRect();
        const p = clamp01((e.clientX - rect.left) / Math.max(1, rect.width));
        onChange(param.name, quantizeValue(pctToValue(p)));
    }, [isDragging, onChange, param.name, pctToValue, quantizeValue]);

    const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        setIsDragging(false);
        if (gestureActiveRef.current) {
            gestureActiveRef.current = false;
            onGestureEnd?.(param.name);
        }
    }, [onGestureEnd, param.name]);

    // ── Wheel ───────────────────────────────────────────────────────
    const wheelGestureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const handleWheel = useCallback((e: WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!gestureActiveRef.current) {
            gestureActiveRef.current = true;
            onGestureStart?.(param.name);
        }
        if (wheelGestureTimer.current) clearTimeout(wheelGestureTimer.current);
        wheelGestureTimer.current = setTimeout(() => {
            gestureActiveRef.current = false;
            onGestureEnd?.(param.name);
        }, 300);
        const range = param.max - param.min;
        const step = param.step && param.step > 0 ? param.step : range / 100;
        // ENTERPRISE: Shift = 10x finer, Alt = 4x coarser (industry-standard DAW convention).
        const mul = e.shiftKey ? 0.1 : e.altKey ? 4 : 1;
        // Horizontal: left = decrease, right = increase; vertical wheel: up = increase
        const delta = (e.deltaY < 0 || e.deltaX > 0 ? 1 : -1) * step * mul;
        onChange(param.name, quantizeValue(safeValue + delta));
    }, [onChange, onGestureStart, onGestureEnd, param.max, param.min, param.name, param.step, quantizeValue, safeValue]);

    useEffect(() => {
        const node = trackRef.current;
        if (!node) return;
        node.addEventListener('wheel', handleWheel, { passive: false });
        return () => {
            node.removeEventListener('wheel', handleWheel);
            if (wheelGestureTimer.current) clearTimeout(wheelGestureTimer.current);
        };
    }, [handleWheel]);

    // ── Double-click reset ──────────────────────────────────────────
    const onDoubleClick = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onChange(param.name, quantizeValue(defaultParamValue(param)));
    }, [onChange, param, quantizeValue]);

    // ── Inline value edit ───────────────────────────────────────────
    const beginValueEdit = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setEditValueText(String(safeValue));
        setIsEditingValue(true);
    }, [safeValue]);

    const commitValueEdit = useCallback(() => {
        const parsed = Number(editValueText.replace(',', '.').trim());
        if (Number.isFinite(parsed)) onChange(param.name, quantizeValue(parsed));
        setIsEditingValue(false);
    }, [editValueText, onChange, param.name, quantizeValue]);

    const cancelValueEdit = useCallback(() => {
        setIsEditingValue(false);
        setEditValueText(String(safeValue));
    }, [safeValue]);

    return (
        <div
            data-no-drag
            style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr auto',
                alignItems: 'center',
                gap: 6,
                minHeight: 18,
            }}
            onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, param.name); } : undefined}
        >
            {/* Param name — left */}
            <span style={{
                ...knobParamNameStyle,
                maxWidth: 52,
                fontSize: 'var(--font-size-2xs)',
            }}>
                {formatPluginParamName(label ?? param.name)}
            </span>

            {/* Horizontal track */}
            <div
                ref={trackRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onDoubleClick={onDoubleClick}
                style={{
                    position: 'relative',
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
                    background: 'var(--color-bg-tertiary)',
                    border: 'var(--space-px) solid var(--color-divider)',
                }} />

                {/* Blue fill from left */}
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
                    borderRadius: 'var(--radius-2xs)',
                    background: isDragging
                        ? 'var(--color-accent-primary)'
                        : 'color-mix(in srgb, var(--color-text-primary) 85%, transparent)',
                    border: 'var(--space-px) solid var(--color-divider)',
                    boxShadow: isDragging ? '0 0 6px color-mix(in srgb, var(--color-accent-primary) 50%, transparent)' : 'none',
                    transition: isDragging ? 'none' : 'left 60ms linear',
                }} />

                {/* Drag badge */}
                {isDragging && (
                    <span style={{
                        ...knobDragValueBadgeStyle,
                        left: `${pct * 100}%`,
                        top: -18,
                    }}>
                        {formatPluginParamValue(param)}
                    </span>
                )}
            </div>

            {/* Value — right */}
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
                    style={{ ...knobValueInputStyle(true), width: 44 }}
                />
            ) : (
                <span style={{ ...knobValueStyle(true), fontSize: 'var(--font-size-2xs)' }} onDoubleClick={beginValueEdit} title="Double-click to type value">
                    {formatPluginParamValue(param)}
                </span>
            )}
        </div>
    );
});
PluginFader.displayName = 'PluginFader';
