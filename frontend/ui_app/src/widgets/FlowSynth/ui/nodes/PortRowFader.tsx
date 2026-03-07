import React, { useCallback, useRef, useState } from 'react';
import type { PortFaderConfig } from '../../model/portRegistry';
import { useAutomationStore } from '../../../../shared/stores/useAutomationStore';
import { useEngineStore } from '../../../../shared/stores/useEngineStore';
import { stableNodeNumericId, useFlowSynthStore } from '../../model/useFlowSynthStore';

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
/** Gap between fader track and value display. */
const FADER_GAP = 4;
/** Extra padding above/below the thumb for pointer target area. */
const THUMB_PADDING = 4;
/** Thumb corner radius. */
const THUMB_RADIUS = 2;
/** Inline edit input dimensions. */
const FADER_EDIT_INPUT_W = 36;
const FADER_EDIT_PADDING = '0 2px';
/** Minimum width for the value display label. */
const VALUE_DISPLAY_MIN_W = 28;

interface Props {
    nodeId: string;
    portId: string;
    value: number;
    config: PortFaderConfig;
    onChange: (value: number) => void;
}

export const PortRowFader = React.memo(function PortRowFader({ nodeId, portId, value, config, onChange }: Props) {
    const trackRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editText, setEditText] = useState('');

    const { min, max, step, unit } = config;

    // ENTERPRISE FIX: Smooth dragging using local state
    const [localValue, setLocalValue] = useState(value);
    const inPropRef = useRef(value);
    if (value !== inPropRef.current) {
        inPropRef.current = value;
        if (!isDragging && !isEditing) setLocalValue(value);
    }

    const safeValue = Number.isFinite(localValue) ? Math.min(max, Math.max(min, localValue)) : min;
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
        const v = quantize(pctToValue(p));
        setLocalValue(v);
        onChange(v);
    }, [onChange, pctToValue, quantize]);

    const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!isDragging) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const p = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)));
        const v = quantize(pctToValue(p));
        setLocalValue(v);
        onChange(v);
    }, [isDragging, onChange, pctToValue, quantize]);

    const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        setIsDragging(false);
    }, []);

    // ENTERPRISE BUG-13 FIX: Store safeValue in a ref to prevent
    // re-subscribing the wheel event listener on every value change.
    // This prevents stale closure issues and avoids continuous teardown/recreation.
    const safeValueRef = useRef(safeValue);
    safeValueRef.current = safeValue;

    React.useEffect(() => {
        const node = trackRef.current;
        if (!node) return;
        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const delta = -e.deltaY * (max - min) * 0.002;
            onChange(quantize(safeValueRef.current + delta));
        };
        node.addEventListener('wheel', handleWheel, { passive: false });
        return () => node.removeEventListener('wheel', handleWheel);
    }, [min, max, onChange, quantize]);

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

    // ── Context Menu (Automation Integration) ─────────────────────────
    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        const activeTrackId = useFlowSynthStore.getState().activeTrackId;
        if (!activeTrackId) return;

        // Ensure track is loaded in Engine to attach automation lanes
        const engineState = useEngineStore.getState();
        const track = engineState.tracks.byId[activeTrackId];
        if (!track) return;

        const addLane = useAutomationStore.getState().addLane;
        const numericId = stableNodeNumericId(nodeId);
        const automationKey = `flow:${numericId}:${portId}`;
        const paramLabel = `FlowSynth: ${portId}`;

        // Add automation lane with backend-consumable Flow target hash
        addLane(activeTrackId, paramLabel, automationKey, 'var(--color-accent-primary)');
    }, [nodeId, portId]);

    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: FADER_GAP,
                height: FADER_HEIGHT,
                flex: 1,
                minWidth: 0,
            }}
            onContextMenu={handleContextMenu}
        >
            {/* Track + Thumb */}
            <div
                ref={trackRef}
                onContextMenu={handleContextMenu}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                    position: 'relative',
                    flex: 1,
                    height: THUMB_H + THUMB_PADDING,
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
                    borderRadius: THUMB_RADIUS,
                    background: isDragging
                        ? 'color-mix(in srgb, var(--color-accent-primary) 85%, white 15%)'
                        : 'var(--color-text-secondary)',
                    transition: isDragging ? 'none' : 'background var(--transition-fast)',
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
                        width: FADER_EDIT_INPUT_W,
                        fontSize: 'var(--font-size-2xs)',
                        fontFamily: 'var(--font-role-data)',
                        color: 'var(--color-text-primary)',
                        background: 'color-mix(in srgb, var(--color-accent-primary) 15%, transparent)',
                        border: '1px solid var(--color-accent-primary)',
                        borderRadius: 'var(--radius-sm)',
                        textAlign: 'right',
                        outline: 'none',
                        padding: FADER_EDIT_PADDING,
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
                        minWidth: VALUE_DISPLAY_MIN_W,
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
