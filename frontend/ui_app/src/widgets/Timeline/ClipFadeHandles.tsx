import { useState, useCallback, useRef, useEffect, memo } from 'react';

interface ClipFadeHandlesProps {
    width: number;
    height: number;
    fadeIn: number;
    fadeOut: number;
    onFadeInChange?: (fraction: number) => void;
    onFadeOutChange?: (fraction: number) => void;
    onSlip?: (deltaPx: number) => void;
    isSelected?: boolean;
    color?: string;
}

const HANDLE_SIZE = 8;
const FADE_MIN_PX = 4;
/** Slip handle layout constants. */
const SLIP_BOTTOM_OFFSET = 2;
const SLIP_HEIGHT = 4;
const SLIP_MAX_WIDTH = 40;
const SLIP_WIDTH_FRACTION = 0.4;


export const ClipFadeHandles = memo(function ClipFadeHandles({
    width,
    height,
    fadeIn,
    fadeOut,
    onFadeInChange,
    onFadeOutChange,
    onSlip,
    isSelected = false,
    color = 'var(--color-accent-primary)',
}: ClipFadeHandlesProps) {
    const [hoveredHandle, setHoveredHandle] = useState<string | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const fadeInPx = Math.max(FADE_MIN_PX, fadeIn * width);
    const fadeOutPx = Math.max(FADE_MIN_PX, fadeOut * width);

    // ENTERPRISE FIX (BUG-W5-002): Cleanup ref for active drag listeners.
    const dragCleanupRef = useRef<(() => void) | null>(null);

    useEffect(() => () => {
        dragCleanupRef.current?.();
        dragCleanupRef.current = null;
    }, []);

    const startDrag = useCallback(
        (
            e: React.PointerEvent,
            onDelta: (deltaPx: number, totalPx: number) => void,
        ) => {
            e.stopPropagation();
            e.preventDefault();
            const startX = e.clientX;

            // ENTERPRISE FIX (Phase 33): Pointer events for interrupt safety.
            const onMove = (ev: PointerEvent) => {
                const delta = ev.clientX - startX;
                onDelta(delta, ev.clientX);
            };

            const cleanup = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
                dragCleanupRef.current = null;
            };
            const onUp = () => { cleanup(); };

            dragCleanupRef.current?.();
            dragCleanupRef.current = cleanup;

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
        },
        [],
    );

    const handleFadeInDrag = useCallback(
        (e: React.PointerEvent) => {
            startDrag(e, (delta) => {
                const newPx = Math.max(0, fadeInPx + delta);
                const fraction = Math.min(0.9, newPx / width);
                onFadeInChange?.(fraction);
            });
        },
        [startDrag, fadeInPx, width, onFadeInChange],
    );

    const handleFadeOutDrag = useCallback(
        (e: React.PointerEvent) => {
            startDrag(e, (delta) => {
                const newPx = Math.max(0, fadeOutPx - delta);
                const fraction = Math.min(0.9, newPx / width);
                onFadeOutChange?.(fraction);
            });
        },
        [startDrag, fadeOutPx, width, onFadeOutChange],
    );

    const handleSlipDrag = useCallback(
        (e: React.PointerEvent) => {
            startDrag(e, (delta) => onSlip?.(delta));
        },
        [startDrag, onSlip],
    );

    const fadeInPath = `M 0 0 Q ${fadeInPx * 0.5} 0, ${fadeInPx} ${height}`;
    const fadeOutPath = `M ${width} 0 Q ${width - fadeOutPx * 0.5} 0, ${width - fadeOutPx} ${height}`;
    const fadeInFill = `M 0 0 L 0 ${height} L ${fadeInPx} ${height} Q ${fadeInPx * 0.5} 0, 0 0 Z`;
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
                        <line x1="0" y1="0" x2="0" y2="6" stroke="var(--token-color-rgba-255-255-255-0d45)" strokeWidth="2" />
                    </pattern>
                </defs>
                {fadeIn > 0 && (
                    <path d={fadeInFill} fill="url(#fadeHatch)" />
                )}
                {fadeOut > 0 && (
                    <path d={fadeOutFill} fill="url(#fadeHatch)" />
                )}
                {fadeIn > 0 && (
                    <path
                        d={fadeInPath}
                        fill="none"
                        stroke={color}
                        strokeWidth={1.5}
                        opacity={0.8}
                    />
                )}

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

            <div
                onPointerDown={handleFadeInDrag}
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
                    transition: `opacity var(--transition-fast)`,
                }}
            >
                <svg width={HANDLE_SIZE} height={HANDLE_SIZE} viewBox="0 0 8 8">
                    <polygon
                        points="0,0 8,0 4,8"
                        fill={hoveredHandle === 'fadeIn' ? 'var(--token-color-hex-ffffff)' : color}
                    />
                </svg>
            </div>

            <div
                onPointerDown={handleFadeOutDrag}
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
                    transition: `opacity var(--transition-fast)`,
                }}
            >
                <svg width={HANDLE_SIZE} height={HANDLE_SIZE} viewBox="0 0 8 8">
                    <polygon
                        points="0,0 8,0 4,8"
                        fill={hoveredHandle === 'fadeOut' ? 'var(--token-color-hex-ffffff)' : color}
                    />
                </svg>
            </div>



            {showHandles && onSlip && (
                <div
                    onPointerDown={handleSlipDrag}
                    onMouseEnter={() => setHoveredHandle('slip')}
                    onMouseLeave={() => setHoveredHandle(null)}
                    style={{
                        position: 'absolute',
                        left: '50%',
                        bottom: SLIP_BOTTOM_OFFSET,
                        transform: 'translateX(-50%)',
                        width: Math.min(SLIP_MAX_WIDTH, width * SLIP_WIDTH_FRACTION),
                        height: SLIP_HEIGHT,
                        borderRadius: 'var(--radius-xs)',
                        background: hoveredHandle === 'slip'
                            ? 'color-mix(in srgb, var(--color-text-bright) 50%, transparent)'
                            : 'color-mix(in srgb, var(--color-text-bright) 25%, transparent)',
                        cursor: 'grab',
                        pointerEvents: 'all',
                        transition: `background var(--transition-micro)`,
                    }}
                />
            )}
        </div>
    );
});

export default ClipFadeHandles;
