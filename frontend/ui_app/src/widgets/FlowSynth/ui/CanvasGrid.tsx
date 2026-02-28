import { memo, useRef, useEffect } from 'react';
import { viewportProxy } from '../lib/ViewportProxy';

interface CanvasGridProps {
    showOrigin?: boolean;
}

const SNAP_GRID = 20;

/**
 * CanvasGrid — ENTERPRISE: CSS radial-gradient dot pattern
 *
 * Uses a single radial-gradient for clean dot rendering with minimal GPU memory.
 * Matches the UDS reference implementation exactly.
 */
export const CanvasGrid = memo(({ showOrigin = true }: CanvasGridProps) => {
    const gridRef = useRef<HTMLDivElement>(null);
    const originRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        return viewportProxy.subscribe((vp) => {
            if (!gridRef.current) return;

            const scaledSize = SNAP_GRID * vp.zoom;
            const halfSize = scaledSize / 2;
            // Align so a dot is exactly at origin (0,0)
            const offsetX = (((vp.x - halfSize) % scaledSize) + scaledSize) % scaledSize;
            const offsetY = (((vp.y - halfSize) % scaledSize) + scaledSize) % scaledSize;

            gridRef.current.style.backgroundPosition = `${offsetX}px ${offsetY}px`;
            gridRef.current.style.backgroundSize = `${scaledSize}px ${scaledSize}px`;

            // Fade out at low zoom
            const baseOpacity = 0.22;
            const fadeStart = 0.6;
            const fadeEnd = 0.1;
            let opacity = baseOpacity;
            if (vp.zoom < fadeStart) {
                const fadeProgress = Math.min(1, (fadeStart - vp.zoom) / (fadeStart - fadeEnd));
                opacity = baseOpacity * (1 - fadeProgress);
            }
            gridRef.current.style.opacity = String(opacity);

            if (originRef.current) {
                originRef.current.style.transform =
                    `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
            }
        });
    }, []);

    const initial = viewportProxy.getViewport();
    const initialScaledSize = SNAP_GRID * initial.zoom;
    const initialHalfSize = initialScaledSize / 2;
    const initialOffsetX = (((initial.x - initialHalfSize) % initialScaledSize) + initialScaledSize) % initialScaledSize;
    const initialOffsetY = (((initial.y - initialHalfSize) % initialScaledSize) + initialScaledSize) % initialScaledSize;

    return (
        <>
            <div
                ref={gridRef}
                style={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    zIndex: 0,
                    backgroundImage: `radial-gradient(circle, var(--color-text-secondary) 1px, transparent 1px)`,
                    backgroundSize: `${initialScaledSize}px ${initialScaledSize}px`,
                    backgroundPosition: `${initialOffsetX}px ${initialOffsetY}px`,
                    opacity: 0.22,
                }}
            />

            {showOrigin && (
                <div
                    ref={originRef}
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: 0,
                        height: 0,
                        pointerEvents: 'none',
                        zIndex: 0,
                        transformOrigin: '0 0',
                        transform: `translate(${initial.x}px, ${initial.y}px) scale(${initial.zoom})`,
                    }}
                >
                    <div style={{
                        position: 'absolute',
                        left: -15,
                        top: -1,
                        width: 30,
                        height: 2,
                        background: 'var(--color-accent-tertiary)',
                        borderRadius: 1,
                    }} />
                    <div style={{
                        position: 'absolute',
                        left: -1,
                        top: -15,
                        width: 2,
                        height: 30,
                        background: 'var(--color-accent-tertiary)',
                        borderRadius: 1,
                    }} />
                    <div style={{
                        position: 'absolute',
                        left: -3,
                        top: -3,
                        width: 6,
                        height: 6,
                        background: 'var(--color-accent-tertiary)',
                        borderRadius: '50%',
                    }} />
                </div>
            )}
        </>
    );
});
