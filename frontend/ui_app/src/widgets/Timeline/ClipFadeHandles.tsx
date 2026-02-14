// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — ClipFadeHandles (Fade Curves + Slip Edit + Resize)
// ═══════════════════════════════════════════════════════════════════════════
//
// LEVIATHAN Epic 3: Renders interactive fade handles on clip edges.
// Overlaid on top of the ClipRenderer waveform.
//
// Features:
//   - Fade-In handle (top-left triangle): drag to set fade-in duration
//   - Fade-Out handle (top-right triangle): drag to set fade-out duration
//   - Fade curve visualization (SVG quadratic Bézier)
//   - Left/Right resize handles (edge dragging)
//   - Slip-edit handle (middle-bottom, moves source offset without clip bounds)
//
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useCallback, useRef, memo } from 'react';

// ── Types ────────────────────────────────────────────────────────────────

interface ClipFadeHandlesProps {
    /** Total width of the clip in pixels. */
    width: number;
    /** Height of the clip in pixels. */
    height: number;
    /** Fade-in duration as fraction of clip width (0..1). */
    fadeIn: number;
    /** Fade-out duration as fraction of clip width (0..1). */
    fadeOut: number;
    /** Called when fade-in changes (fraction 0..1). */
    onFadeInChange?: (fraction: number) => void;
    /** Called when fade-out changes (fraction 0..1). */
    onFadeOutChange?: (fraction: number) => void;
    /** Called when left edge is resized (delta in pixels). */
    onResizeLeft?: (deltaPx: number) => void;
    /** Called when right edge is resized (delta in pixels). */
    onResizeRight?: (deltaPx: number) => void;
    /** Called when slip-editing (delta in pixels). */
    onSlip?: (deltaPx: number) => void;
    /** Whether the clip is selected (enables handles). */
    isSelected?: boolean;
    /** Clip color for styling. */
    color?: string;
}

// ── Constants ────────────────────────────────────────────────────────────

const HANDLE_SIZE = 8;
const EDGE_WIDTH = 5;
const FADE_MIN_PX = 4;

// ── Component ────────────────────────────────────────────────────────────

export const ClipFadeHandles = memo(function ClipFadeHandles({
    width,
    height,
    fadeIn,
    fadeOut,
    onFadeInChange,
    onFadeOutChange,
    onResizeLeft,
    onResizeRight,
    onSlip,
    isSelected = false,
    color = 'var(--color-accent-primary)',
}: ClipFadeHandlesProps) {
    const [hoveredHandle, setHoveredHandle] = useState<string | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const fadeInPx = Math.max(FADE_MIN_PX, fadeIn * width);
    const fadeOutPx = Math.max(FADE_MIN_PX, fadeOut * width);

    // ── Drag Handler Factory ─────────────────────────────────────────

    const startDrag = useCallback(
        (
            e: React.MouseEvent,
            onDelta: (deltaPx: number, totalPx: number) => void,
        ) => {
            e.stopPropagation();
            e.preventDefault();
            const startX = e.clientX;

            const onMove = (ev: MouseEvent) => {
                const delta = ev.clientX - startX;
                onDelta(delta, ev.clientX);
            };

            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };

            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        },
        [],
    );

    // ── Fade-In Drag ─────────────────────────────────────────────────

    const handleFadeInDrag = useCallback(
        (e: React.MouseEvent) => {
            startDrag(e, (delta) => {
                const newPx = Math.max(0, fadeInPx + delta);
                const fraction = Math.min(0.9, newPx / width);
                onFadeInChange?.(fraction);
            });
        },
        [startDrag, fadeInPx, width, onFadeInChange],
    );

    // ── Fade-Out Drag ────────────────────────────────────────────────

    const handleFadeOutDrag = useCallback(
        (e: React.MouseEvent) => {
            startDrag(e, (delta) => {
                const newPx = Math.max(0, fadeOutPx - delta);
                const fraction = Math.min(0.9, newPx / width);
                onFadeOutChange?.(fraction);
            });
        },
        [startDrag, fadeOutPx, width, onFadeOutChange],
    );

    // ── Resize Drags ─────────────────────────────────────────────────

    const handleResizeLeftDrag = useCallback(
        (e: React.MouseEvent) => {
            startDrag(e, (delta) => onResizeLeft?.(delta));
        },
        [startDrag, onResizeLeft],
    );

    const handleResizeRightDrag = useCallback(
        (e: React.MouseEvent) => {
            startDrag(e, (delta) => onResizeRight?.(delta));
        },
        [startDrag, onResizeRight],
    );

    // ── Slip Edit Drag ────────────────────────────────────────────────

    const handleSlipDrag = useCallback(
        (e: React.MouseEvent) => {
            startDrag(e, (delta) => onSlip?.(delta));
        },
        [startDrag, onSlip],
    );

    // ── Build fade SVG paths ─────────────────────────────────────────

    // Fade-In: from top-left (0,0) curve down to (fadeInPx, height)
    const fadeInPath = `M 0 0 Q ${fadeInPx * 0.5} 0, ${fadeInPx} ${height}`;

    // Fade-Out: from top-right (width,0) curve down to (width-fadeOutPx, height)
    const fadeOutPath = `M ${width} 0 Q ${width - fadeOutPx * 0.5} 0, ${width - fadeOutPx} ${height}`;

    // Fade-In fill (area to dim = left triangle)
    const fadeInFill = `M 0 0 L 0 ${height} L ${fadeInPx} ${height} Q ${fadeInPx * 0.5} 0, 0 0 Z`;

    // Fade-Out fill (area to dim = right triangle)
    const fadeOutFill = `M ${width} 0 L ${width} ${height} L ${width - fadeOutPx} ${height} Q ${width - fadeOutPx * 0.5} 0, ${width} 0 Z`;

    const showHandles = isSelected || hoveredHandle !== null;

    return (
        <div
            ref={containerRef}
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width,
                height,
                pointerEvents: 'none',
            }}
        >
            {/* ── SVG Fade Curves ── */}
            <svg
                width={width}
                height={height}
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    pointerEvents: 'none',
                }}
            >
                <defs>
                    <pattern id="fadeHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                        <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.45)" strokeWidth="2" />
                    </pattern>
                </defs>
                {/* Fade-In dim area */}
                {fadeIn > 0 && (
                    <path d={fadeInFill} fill="url(#fadeHatch)" />
                )}

                {/* Fade-Out dim area */}
                {fadeOut > 0 && (
                    <path d={fadeOutFill} fill="url(#fadeHatch)" />
                )}

                {/* Fade-In curve line */}
                {fadeIn > 0 && (
                    <path
                        d={fadeInPath}
                        fill="none"
                        stroke={color}
                        strokeWidth={1.5}
                        opacity={0.8}
                    />
                )}

                {/* Fade-Out curve line */}
                {fadeOut > 0 && (
                    <path
                        d={fadeOutPath}
                        fill="none"
                        stroke={color}
                        strokeWidth={1.5}
                        opacity={0.8}
                    />
                )}
            </svg>

            {/* ── Interactive Handles (visible on select/hover) ── */}

            {/* Fade-In handle triangle (top-left) */}
            <div
                onMouseDown={handleFadeInDrag}
                onMouseEnter={() => setHoveredHandle('fadeIn')}
                onMouseLeave={() => setHoveredHandle(null)}
                style={{
                    position: 'absolute',
                    left: fadeInPx - HANDLE_SIZE / 2,
                    top: 0,
                    width: HANDLE_SIZE,
                    height: HANDLE_SIZE,
                    cursor: 'ew-resize',
                    pointerEvents: 'all',
                    opacity: showHandles ? 1 : 0,
                    transition: 'opacity 0.15s ease',
                }}
            >
                <svg width={HANDLE_SIZE} height={HANDLE_SIZE} viewBox="0 0 8 8">
                    <polygon
                        points="0,0 8,0 4,8"
                        fill={hoveredHandle === 'fadeIn' ? '#fff' : color}
                    />
                </svg>
            </div>

            {/* Fade-Out handle triangle (top-right) */}
            <div
                onMouseDown={handleFadeOutDrag}
                onMouseEnter={() => setHoveredHandle('fadeOut')}
                onMouseLeave={() => setHoveredHandle(null)}
                style={{
                    position: 'absolute',
                    right: fadeOutPx - HANDLE_SIZE / 2,
                    top: 0,
                    width: HANDLE_SIZE,
                    height: HANDLE_SIZE,
                    cursor: 'ew-resize',
                    pointerEvents: 'all',
                    opacity: showHandles ? 1 : 0,
                    transition: 'opacity 0.15s ease',
                }}
            >
                <svg width={HANDLE_SIZE} height={HANDLE_SIZE} viewBox="0 0 8 8">
                    <polygon
                        points="0,0 8,0 4,8"
                        fill={hoveredHandle === 'fadeOut' ? '#fff' : color}
                    />
                </svg>
            </div>

            {/* Left resize edge */}
            <div
                onMouseDown={handleResizeLeftDrag}
                onMouseEnter={() => setHoveredHandle('resizeL')}
                onMouseLeave={() => setHoveredHandle(null)}
                style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: EDGE_WIDTH,
                    height,
                    cursor: 'col-resize',
                    pointerEvents: 'all',
                    background: hoveredHandle === 'resizeL' ? 'rgba(255,255,255,0.2)' : 'transparent',
                    borderLeft: hoveredHandle === 'resizeL' ? `2px solid ${color}` : 'none',
                    transition: 'all 0.1s ease',
                }}
            />

            {/* Right resize edge */}
            <div
                onMouseDown={handleResizeRightDrag}
                onMouseEnter={() => setHoveredHandle('resizeR')}
                onMouseLeave={() => setHoveredHandle(null)}
                style={{
                    position: 'absolute',
                    right: 0,
                    top: 0,
                    width: EDGE_WIDTH,
                    height,
                    cursor: 'col-resize',
                    pointerEvents: 'all',
                    background: hoveredHandle === 'resizeR' ? 'rgba(255,255,255,0.2)' : 'transparent',
                    borderRight: hoveredHandle === 'resizeR' ? `2px solid ${color}` : 'none',
                    transition: 'all 0.1s ease',
                }}
            />

            {/* Slip-edit handle (bottom center bar) */}
            {showHandles && (
                <div
                    onMouseDown={handleSlipDrag}
                    onMouseEnter={() => setHoveredHandle('slip')}
                    onMouseLeave={() => setHoveredHandle(null)}
                    style={{
                        position: 'absolute',
                        left: '50%',
                        bottom: 2,
                        transform: 'translateX(-50%)',
                        width: Math.min(40, width * 0.4),
                        height: 4,
                        borderRadius: 2,
                        background: hoveredHandle === 'slip'
                            ? 'rgba(255,255,255,0.5)'
                            : 'rgba(255,255,255,0.25)',
                        cursor: 'grab',
                        pointerEvents: 'all',
                        transition: 'background 0.1s ease',
                    }}
                    title="Slip Edit — drag to shift source audio"
                />
            )}
        </div>
    );
});

export default ClipFadeHandles;
